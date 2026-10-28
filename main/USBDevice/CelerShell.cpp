#include "CelerShell.h"
#include "sdkconfig.h"
#if CONFIG_CELEROS_BLUETOOTH
#include "../Bluetooth/CelerNet.h"
#include "../Bluetooth/NetKeys.h"
#include "../Pack/Resources.h"
#include "../Pack/Provision.h"
#include "../Pack/Reflex.h"
#endif
#include "FileSystem/FileSystem.h"
#include "JsDebugger.h"
#include "Launcher/LauncherUI.h"
#include "Display/Backlight.h"
#include "Boards/Board.h"
#include "Display/Theme.h"
#include "Kernel/DeviceStats.h"
#include "NetworkManager.h"
#include "DebugBridge.h"
#include "HostFrame.h"
#include "Kernel/TimeManager.h"
#include "WebManager/WebManager.h"
#include "CommonErrorCodes.h"
#include "Utils/AppGrants.h"
#include "Utils/AppPerms.h"
#include "Utils/AppPackage.h"
#include "Kernel/AppServices.h"
#include "Utils/ShellLogic.h"
#include "../Utils/CelerSettings.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <stdarg.h>
#include <dirent.h>
#include <sys/stat.h>

#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_idf_version.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"
#if CONFIG_IDF_TARGET_ESP32S3
#include "soc/gdma_struct.h"
#include "esp_intr_alloc.h"
#endif
#if CONFIG_CELEROS_PHONE_LINK
#include "Bluetooth/PhoneLink.h"
#endif
#if CONFIG_CELEROS_USB_HOST
#include "../USBHost/UsbHost.h"
#include <usb/usb_host.h>
#endif

#if !defined(CELEROS_VERSION)
#define CELEROS_VERSION "?"
#endif
#if !defined(CELEROS_API_LEVEL)
#define CELEROS_API_LEVEL 0
#endif
// CONFIG_IDF_TARGET vem sem aspas do build ("esp32s3") — stringify em duas
// etapas expande o valor antes de virar string
#define CELER_STR_(v) #v
#define CELER_STR(v) CELER_STR_(v)

namespace {

const char* boardName() {
    return Board::profile().name;
}

// Decimos de (n5 >> shift) com arredondamento HALF-EVEN — exatamente o que
// o %.1f do snprintf faz com esses quocientes exatos por potencia de 2 (a
// divisao de um inteiro por 2^k nao erra em double). Integer math em vez de
// float no printf: o caminho %f puxa o conversor de doubles da libc (~KBs
// de flash no CYD, que nao usa float em mais nada).
// n5 = bytes*5 (o x10 ja aplicado); divisor = 2^shift.
static unsigned tenthsHalfEven(uint64_t n5, unsigned shift) {
    const uint64_t q = n5 >> shift;
    const uint64_t r = n5 & ((1ULL << shift) - 1);
    const uint64_t half = 1ULL << (shift - 1);
    if (r > half || (r == half && (q & 1))) return (unsigned)(q + 1);
    return (unsigned)q;
}

std::string humanSize(uint64_t bytes) {
    char buf[32];
    if (bytes >= 1024ULL * 1024 * 1024) {
        const unsigned t = tenthsHalfEven(bytes * 5, 29);  // G = bytes/2^30
        snprintf(buf, sizeof(buf), "%u.%uG", t / 10, t % 10);
    } else if (bytes >= 1024 * 1024) {
        const unsigned t = tenthsHalfEven(bytes * 5, 19);  // M = bytes/2^20
        snprintf(buf, sizeof(buf), "%u.%uM", t / 10, t % 10);
    } else if (bytes >= 1024) {
        const unsigned t = tenthsHalfEven(bytes * 5, 9);   // K = bytes/2^10
        snprintf(buf, sizeof(buf), "%u.%uK", t / 10, t % 10);
    } else {
        snprintf(buf, sizeof(buf), "%uB", (unsigned)bytes);
    }
    return buf;
}

bool ipOf(char* out, size_t outLen) {
    esp_netif_t* netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif == nullptr) return false;
    esp_netif_ip_info_t ip;
    if (esp_netif_get_ip_info(netif, &ip) != ESP_OK || ip.ip.addr == 0) return false;
    snprintf(out, outLen, IPSTR, IP2STR(&ip.ip));
    return true;
}

// ------------------------------------------------------------ estado do shell

// Diretorio corrente (cd/pwd): buffer fixo lido/escrito em secao critica
// curta — o EXEC do HostLink e os consoles (CDC/UART) rodam em tasks
// diferentes e podem disparar da mesma vez; std::string compartilhada
// sem guarda corromperia o heap.
static char s_cwd[96] = "/";
static portMUX_TYPE s_cwdMux = portMUX_INITIALIZER_UNLOCKED;

static void setCwd(const char* path) {
    taskENTER_CRITICAL(&s_cwdMux);
    strncpy(s_cwd, path, sizeof(s_cwd) - 1);
    s_cwd[sizeof(s_cwd) - 1] = '\0';
    taskEXIT_CRITICAL(&s_cwdMux);
}

static std::string getCwd() {
    char buf[96];
    taskENTER_CRITICAL(&s_cwdMux);
    memcpy(buf, s_cwd, sizeof(buf));
    taskEXIT_CRITICAL(&s_cwdMux);
    buf[sizeof(buf) - 1] = '\0';
    return std::string(buf);
}

// Resolve um argumento DE CAMINHO contra o cwd e normaliza ('.', '..',
// '//'). Argumentos que nao sao caminhos (nome de app, padrao do grep,
// linha do gb) nao passam por aqui: cada comando resolve so o que espera
// ser arquivo/diretorio — senao "run Meu App" viraria "<cwd>/Meu App".
// (Algoritmo puro no Utils/ShellLogic.h, testado no host.)
static std::string resolvePath(const char* arg) {
    return shl::resolvePath(getCwd(), arg);
}

static const char* baseName(const char* path) {
    const char* s = strrchr(path, '/');
    return (s != nullptr) ? s + 1 : path;
}

// mkdir -p implicito do alvo (mesmo padrao do handleMkdir do HostLink):
// cria cada pai que falta no caminho.
static void makeParentDirs(const std::string& path) {
    char tmp[192];
    snprintf(tmp, sizeof(tmp), "%s", path.c_str());
    for (char* slash = strchr(tmp + 1, '/'); slash != nullptr; slash = strchr(slash + 1, '/')) {
        *slash = '\0';
        if (!FileSystem::exists(tmp)) FileSystem::mkdir(tmp);
        *slash = '/';
    }
}

// Mount do caminho ('l' = /local, 's' = /sd, 0 = fora da jail) — usado
// pelo mv para explicar que rename atravessando montagem nao existe.
static char mountOf(const std::string& path) {
    if (path.compare(0, 6, "/local") == 0 && (path.size() == 6 || path[6] == '/')) return 'l';
    if (path.compare(0, 3, "/sd") == 0 && (path.size() == 3 || path[3] == '/')) return 's';
    return 0;
}

// Orcamento de entradas dos caminhadores (find/du): para em vez de varrer
// um cartao inteiro por engano e avisa que truncou.
struct WalkBudget {
    int left = 4096;
    bool clipped = false;
};

// ------------------------------------------------------- variaveis do shell

// $VAR/$?: tabela pequena e lazy — malloc(16 slots) na primeira
// atribuicao; shell parado nao paga RAM nenhuma. Valores curtos: script
// de device nao precisa de string longa.
struct ShVar {
    char name[16];
    char val[64];
};
static constexpr int kMaxVars = 16;
static ShVar* s_vars = nullptr;
static int s_varCount = 0;
static int s_lastRc = 0;  // $?: ultimo codigo devolvido por um comando
// O console CDC/UART e o EXEC do HostLink rodam em tasks diferentes e podem
// disparar da mesma vez: sem a guarda, set/unset concorrentes corrompiam a
// contagem (duplicata, leitura de slot parcial). Mesmo padrao do s_cwd.
static portMUX_TYPE s_varMux = portMUX_INITIALIZER_UNLOCKED;

static const char* shVarGet(const char* name) {
    const char* found = nullptr;
    taskENTER_CRITICAL(&s_varMux);
    for (int i = 0; i < s_varCount; i++) {
        if (strcmp(s_vars[i].name, name) == 0) {
            found = s_vars[i].val;  // ponteiro estavel (buf fixo); valor pode
            break;                  // mudar em seguida, igual ao shell real
        }
    }
    taskEXIT_CRITICAL(&s_varMux);
    return found;
}

static bool shVarSet(const char* name, const char* val) {
    if (s_vars == nullptr) {
        // malloc FORA da secao critica (pode demorar); dupla checagem dentro
        ShVar* t = (ShVar*)malloc(sizeof(ShVar) * kMaxVars);
        if (t == nullptr) return false;
        taskENTER_CRITICAL(&s_varMux);
        if (s_vars == nullptr) {
            s_vars = t;
            t = nullptr;
        }
        taskEXIT_CRITICAL(&s_varMux);
        if (t != nullptr) free(t);  // outra task alocou antes
    }
    taskENTER_CRITICAL(&s_varMux);
    for (int i = 0; i < s_varCount; i++) {
        if (strcmp(s_vars[i].name, name) == 0) {
            snprintf(s_vars[i].val, sizeof(ShVar::val), "%s", val);
            taskEXIT_CRITICAL(&s_varMux);
            return true;
        }
    }
    bool ok = false;
    if (s_varCount < kMaxVars) {
        snprintf(s_vars[s_varCount].name, sizeof(ShVar::name), "%s", name);
        snprintf(s_vars[s_varCount].val, sizeof(ShVar::val), "%s", val);
        s_varCount++;
        ok = true;
    }
    taskEXIT_CRITICAL(&s_varMux);
    return ok;
}

static void shVarUnset(const char* name) {
    taskENTER_CRITICAL(&s_varMux);
    for (int i = 0; i < s_varCount; i++) {
        if (strcmp(s_vars[i].name, name) == 0) {
            memmove(&s_vars[i], &s_vars[i + 1], (s_varCount - i - 1) * sizeof(ShVar));
            s_varCount--;
            break;
        }
    }
    taskEXIT_CRITICAL(&s_varMux);
}

// Expande $NOME, ${NOME} e $? (algoritmo puro no Utils/ShellLogic.h).
static const char* shellVarLookup(void* ctx, const char* name) {
    (void) ctx;
    return shVarGet(name);
}

// ------------------------------------------------------------------ comandos

int cmdHelp(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv;
    print(ctx,
        "CelerOS shell " CELEROS_VERSION "\r\n"
        "arquivos:\r\n"
        "  ls [dir]                lista diretorio (default: dir corrente)\r\n"
        "  cd [dir] / pwd          muda/consulta o diretorio corrente\r\n"
        "  cat <arq...>            mostra conteudo\r\n"
        "  head|tail [-n N] <arq>  primeiras/ultimas N linhas (default 10)\r\n"
        "  cp [-r] <de> <para>     copia arquivo (pasta inteira com -r)\r\n"
        "  mv <de> <para>          renomeia/move (nao atravessa /local x /sd)\r\n"
        "  rm [-r] <arq...>        apaga arquivo, dir vazio (ou inteiro com -r)\r\n"
        "  mkdir <dir> / rmdir <dir> / touch <arq...>\r\n"
        "  echo [-n] txt           imprime texto (bem util com > arq)\r\n"
        "  wc [-l|-w|-c] <arq...>  conta linhas/palavras/bytes\r\n"
        "  grep [-inv] <padrao> <arq...>  busca texto (i=caixa, n=linha, v=inverte)\r\n"
        "  find [dir] [-name pad] [-type f|d]  busca por nome (glob * e ?)\r\n"
        "  du [dir]                tamanho recursivo por entrada\r\n"
        "  stat <arq>              tamanho + crc32 + mtime do arquivo\r\n"
        "  xxd <arq> [n]           dump hexadecimal (default 1024 bytes)\r\n"
        "  md5sum <arq...>         md5 do arquivo lido agora no device\r\n"
        "  df                      espaco em /local e /sd\r\n"
        "  sd [format]             cartao SD; format = formata em FAT32 (APAGA)\r\n"
        "sistema:\r\n"
        "  free / ps / top [ms] / uptime / date / uname / info / reboot\r\n"
#if CONFIG_CELEROS_BLUETOOTH
        "  mesh                    malha CelerNet: rede, contadores, nos ouvidos\r\n"
        "  res                     recursos da matilha: ESP-NOW, sessoes, cache\r\n"
#endif
        "  dmesg [n]               ultimas linhas do log do kernel (default 30)\r\n"
        "  clear                   limpa o terminal\r\n"
#if CONFIG_CELEROS_USB_HOST
        "  usb [power|resume]      USB Host: devices/root port (power = power-cycle)\r\n"
#endif
#if CONFIG_IDF_TARGET_ESP32S3
        "  lcddma [ms]             saude do DMA do painel RGB (underflow = imagem embaralha)\r\n"
#endif
        "apps e rede:\r\n"
        "  apps                    lista apps com origem (local/sd) e caminho\r\n"
        "  run <app>               abre um app (pasta, nome ou pacote)\r\n"
        "  exit                    encerra o app em execucao\r\n"
        "  grant <app>             concede as permissoes declaradas (consentimento headless)\r\n"
        "  rescan                  reler lista de apps do launcher\r\n"
        "  wifi                    lista as redes WiFi salvas\r\n"
        "  wifi <ssid> <senha>     salva a rede no NVS e conecta (ssid sem espacos)\r\n"
        "  wifi off|on             desliga (persistente) / religa o WiFi\r\n"
        "  lasterror               ultimo erro de app gravado (/local/lastcrash.txt)\r\n"
        "  crash [n]               resumo do ultimo crash + ultimas n linhas do apps.log\r\n"
        "  svc list                servicos de app em 2o plano: estado por servico\r\n"
        "  svc info <pkg>          detalhe do servico (estado, reinicios, pump)\r\n"
        "  svc stop|start|setup <pkg>  para / religa / roda o install.sh de novo\r\n"
        "  debug on|off            arma o debugger Duktape (a sessao e do celerctl debug)\r\n"
#if CONFIG_CELEROS_DEBUG_BRIDGE
        "  bridge                  estado/token do Celer Debug Bridge (WiFi)\r\n"
#endif
#if CONFIG_CELEROS_PHONE_LINK
        "  gb <linha>              injeta linha do Gadgetbridge (teste do protocolo)\r\n"
#endif
        "shell:\r\n"
        "  sh [-e] [-x] <arq>     roda script: uma linha = um comando (# comenta;\r\n"
        "                         -e para no 1o erro, -x ecoa a linha antes de rodar)\r\n"
        "                         blocos: if COND / else / end, while COND / end com\r\n"
        "                         break/continue; COND e comando rodado calado (0=V)\r\n"
        "                         e o while tem teto de 65535 voltas\r\n"
        "  set VAR=valor | set    variaveis: $VAR ${VAR} $? (ultimo rc) expandem em\r\n"
        "                         qualquer linha; valor inteiro 'N + 1' e calculado\r\n"
        "  [ a = b ] / test       condicao: = !=  -eq..-ge (int)  -f -d -e arq  -z -n\r\n"
        "  cmd1; cmd2              encadeia comandos (codigo = o do ultimo)\r\n"
        "  cmd > arq / >> arq      redireciona a saida para arquivo (>> anexa)\r\n"
        "  (sem aspas: ';' '>' '>>' so valem como palavra isolada)\r\n");
    return 0;
}

int cmdLs(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    std::string dir = (argc > 1) ? resolvePath(argv[1]) : getCwd();
    if (!CelerShell::pathAllowed(dir) && dir != "/") {
        print(ctx, "ls: caminho invalido (use /local ou /sd)\n");
        return 1;
    }
    if (dir != "/" && !FileSystem::isDirectory(dir.c_str())) {
        print(ctx, "ls: %s nao e diretorio\n", dir.c_str());
        return 1;
    }

    FileEntry entries[32];
    int n = FileSystem::listDirectory(dir.c_str(), entries, 32);
    if (n < 0) {
        print(ctx, "ls: erro ao abrir %s\n", dir.c_str());
        return 1;
    }
    for (int i = 0; i < n; i++) {
        std::string full = entries[i].path;
        struct stat st;
        memset(&st, 0, sizeof(st));
        size_t size = 0;
        time_t mtime = 0;
        if (stat(full.c_str(), &st) == 0) {
            size = (size_t)st.st_size;
            mtime = st.st_mtime;
        }
        struct tm tminfo;
        memset(&tminfo, 0, sizeof(tminfo));
        char when[24] = "--------------------";
        if (mtime > 0 && localtime_r(&mtime, &tminfo) != nullptr) {
            strftime(when, sizeof(when), "%Y-%m-%d %H:%M", &tminfo);
        }
        print(ctx, "%c %10s  %s  %s\r\n", entries[i].isDir ? 'd' : '-',
              humanSize(size).c_str(), when, entries[i].name.c_str());
    }
    return 0;
}

int cmdCat(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: cat <arquivo...>\n");
        return 1;
    }
    int rc = 0;
    for (int a = 1; a < argc; a++) {
        std::string path = resolvePath(argv[a]);
        if (!CelerShell::pathAllowed(path)) {
            print(ctx, "cat: caminho invalido (use /local ou /sd)\n");
            rc = 1;
            continue;
        }
        FILE* f = fopen(path.c_str(), "rb");
        if (f == nullptr) {
            print(ctx, "cat: nao consegui abrir %s\n", path.c_str());
            rc = 1;
            continue;
        }
        char buf[256];
        size_t n;
        while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
            print(ctx, "%.*s", (int)n, buf);
        }
        if (ferror(f)) {
            // erro de leitura (cartao puxado no meio) nao e EOF: saida parcial
            // com exit 0 enganava o script que encadeava no cat
            print(ctx, "cat: erro lendo %s\n", path.c_str());
            rc = 1;
        }
        fclose(f);
    }
    print(ctx, "\r\n");
    return rc;
}

int cmdRm(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    bool rec = false;
    int first = 1;
    if (argc > 1 && strcmp(argv[1], "-r") == 0) {
        rec = true;
        first = 2;
    }
    if (argc < first + 1) {
        print(ctx, "uso: rm [-r] <arquivo|diretorio...>\n");
        return 1;
    }
    int rc = 0;
    for (int a = first; a < argc; a++) {
        std::string path = resolvePath(argv[a]);
        if (!CelerShell::pathAllowed(path)) {
            print(ctx, "rm: caminho invalido (use /local ou /sd)\n");
            rc = 1;
            continue;
        }
        // -r apaga a arvore toda (mesmo caminho do uninstall do launcher)
        if (rec && FileSystem::isDirectory(path.c_str())) {
            if (!FileSystem::removeTree(path.c_str())) {
                print(ctx, "rm: falhou em %s\n", path.c_str());
                rc = 1;
            }
            continue;
        }
        if (!FileSystem::deleteFile(path.c_str()) &&
            !(FileSystem::isDirectory(path.c_str()) && FileSystem::rmdir(path.c_str()))) {
            print(ctx, "rm: falhou em %s\n", path.c_str());
            rc = 1;
        }
    }
    return rc;
}

int cmdMv(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 3) {
        print(ctx, "uso: mv <de> <para>\n");
        return 1;
    }
    std::string from = resolvePath(argv[1]);
    std::string to = resolvePath(argv[2]);
    if (!CelerShell::pathAllowed(from) || !CelerShell::pathAllowed(to)) {
        print(ctx, "mv: caminho invalido (use /local ou /sd)\n");
        return 1;
    }
    // rename(2) nao atravessa montagem: o VFS devolve EXDEV e a saida era
    // um seco "falhou" — aponta o par que resolve (cp -r + rm -r)
    const char mFrom = mountOf(from), mTo = mountOf(to);
    if (mFrom != 0 && mTo != 0 && mFrom != mTo) {
        print(ctx, "mv: mover entre /local e /sd nao e suportado (use cp -r + rm -r)\n");
        return 1;
    }
    // destino existindo como diretorio, move PARA DENTRO (semantica unix)
    if (FileSystem::isDirectory(to.c_str())) {
        to += '/';
        to += baseName(from.c_str());
    }
    makeParentDirs(to);
    if (!FileSystem::renameFile(from.c_str(), to.c_str())) {
        print(ctx, "mv: falhou\n");
        return 1;
    }
    return 0;
}

int cmdMkdir(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: mkdir <dir>\n");
        return 1;
    }
    std::string path = resolvePath(argv[1]);
    if (!CelerShell::pathAllowed(path)) {
        print(ctx, "mkdir: caminho invalido (use /local ou /sd)\n");
        return 1;
    }
    if (!FileSystem::mkdir(path.c_str())) {
        print(ctx, "mkdir: falhou em %s\n", path.c_str());
        return 1;
    }
    return 0;
}

int cmdDf(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    struct {
        const char* path;
        const char* label;
    } drives[] = {
        {"/local", "littlefs"},
        {"/sd", "sdcard"},
    };
    for (auto& d : drives) {
        if (!FileSystem::exists(d.path)) {
            print(ctx, "%-8s %-9s (ausente)\r\n", d.path, d.label);
            continue;
        }
        uint64_t total = FileSystem::getTotalSpace(d.path);
        uint64_t used = FileSystem::getUsedSpace(d.path);
        print(ctx, "%-8s %-9s total %-7s usado %-7s livre %s\r\n", d.path, d.label,
              humanSize(total).c_str(), humanSize(used).c_str(), humanSize(total - used).c_str());
    }
    return 0;
}

// sd [format] — estado do cartao e formatacao explicita em FAT32.
// O mount normal NUNCA formata (cartao do usuario pode ter dados no PC:
// exFAT le de la), entao o formato existe so como comando explicito.
int cmdSd(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc >= 2 && strcmp(argv[1], "format") == 0) {
        if (!FileSystem::formatSD()) {
            print(ctx, "SD: nao gravou o pedido de formato\r\n");
            return 1;
        }
        print(ctx, "SD: formato agendado — o aparelho vai REINICIAR e "
                   "formatar o cartao em FAT32 no boot (APAGA TUDO)...\r\n");
        vTaskDelay(pdMS_TO_TICKS(600));   // descarrega a resposta antes de cair
        CelerShell::requestRestart();
    }
    if (argc >= 2 && strcmp(argv[1], "apps") == 0) {
        // cria /sd/apps no cartao ja formatado (o store do celular escaneia)
        if (FileSystem::exists("/sd/apps")) {
            print(ctx, "SD: /sd/apps existe\r\n");
            return 0;
        }
        if (FileSystem::mkdir("/sd/apps")) {
            print(ctx, "SD: /sd/apps criado\r\n");
            return 0;
        }
        print(ctx, "SD: falhou ao criar /sd/apps (cartao montado?)\r\n");
        return 1;
    }
    if (!FileSystem::sdMounted()) {
        print(ctx, "SD: nao montado. Cartao exFAT/virgem formata com `sd format`"
                   " (APAGA TUDO); cartao ausente = contato/cartao\r\n");
        return 1;
    }
    uint64_t total = FileSystem::getTotalSpace("/sd");
    uint64_t used = FileSystem::getUsedSpace("/sd");
    print(ctx, "SD: FAT32 total %s usado %s livre %s (%s)\r\n",
          humanSize(total).c_str(), humanSize(used).c_str(),
          humanSize(total - used).c_str(),
          FileSystem::exists("/sd/apps") ? "/sd/apps ok" : "sem /sd/apps");
    return 0;
}

int cmdFree(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    print(ctx,
        "heap livre     : %s\r\n"
        "heap minimo    : %s\r\n"
        "maior bloco 8b : %s\r\n"
        "PSRAM livre    : %s (min %s, maior bloco %s)\r\n"
        "interna livre  : %s (min %s, maior bloco %s)\r\n",
        humanSize(esp_get_free_heap_size()).c_str(),
        humanSize(esp_get_minimum_free_heap_size()).c_str(),
        humanSize(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)).c_str(),
        humanSize(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)).c_str(),
        humanSize(heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM)).c_str(),
        humanSize(heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM)).c_str(),
        humanSize(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)).c_str(),
        humanSize(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL)).c_str(),
        humanSize(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL)).c_str());
    return 0;
}

int cmdPs(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    // tabela so durante o comando (4KB estaticos eram RAM fixa tirada dos apps)
    char* table = (char*)malloc(4096);
    if (table == nullptr) {
        print(ctx, "sem memoria\r\n");
        return 1;
    }
    vTaskList(table);
    print(ctx, "task            estado  prio  stack\r\n");
    print(ctx, "%s", table);
    free(table);
    return 0;
}

// top [ms]: CPU% por task numa janela (default 300 ms) + resumo de heap e do
// app aberto. Duas fotos do DeviceStats — a taxa e o delta de runtime por
// task, a mesma conta que o celerctl top faz no host (la o device nao bloqueia).
#if CONFIG_IDF_TARGET_ESP32S3
// lcddma [ms]: saude do DMA do painel RGB (SmartDisplay). O LCD_CAM le o
// framebuffer da PSRAM pelo GDMA; quando a PSRAM nao entrega a tempo o FIFO
// do canal SECA (underflow) e a linha escorrega — o "embaralhamento" que a
// captura de tela nao mostra (ela le o framebuffer pela CPU). Amostra os
// flags latched do canal do LCD a cada 5 ms e conta as janelas com falha.
int cmdLcdDma(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    int ms = argc > 1 ? atoi(argv[1]) : 3000;
    if (ms < 100) ms = 100;
    if (ms > 30000) ms = 30000;
    int ch = -1;
    for (int i = 0; i < 5; i++) {
        if (GDMA.channel[i].out.peri_sel.sel == 5) { ch = i; break; }  // 5 = LCD_CAM
    }
    if (ch < 0) {
        print(ctx, "lcddma: nenhum canal GDMA ligado ao LCD_CAM\r\n");
        return 1;
    }
    auto& o = GDMA.channel[ch].out;
    o.int_clr.val = o.int_raw.val;
    int janelas = 0, l1 = 0, l3 = 0, eof = 0;
    const int64_t fim = esp_timer_get_time() + (int64_t)ms * 1000;
    while (esp_timer_get_time() < fim) {
        vTaskDelay(pdMS_TO_TICKS(5));
        const uint32_t raw = o.int_raw.val;
        const bool u1 = o.int_raw.outfifo_udf_l1, u3 = o.int_raw.outfifo_udf_l3;
        if (o.int_raw.out_eof) eof++;
        if (u1 || u3) janelas++;
        if (u1) l1++;
        if (u3) l3++;
        o.int_clr.val = raw;
    }
    print(ctx, "lcddma: canal %d, %d ms: underflow em %d janelas de 5 ms (L1 %d, L3 %d), eof %d\r\n",
          ch, ms, janelas, l1, l3, eof);
    if (argc > 2 && strcmp(argv[2], "isr") == 0) {
        // tabela de interrupcoes por nucleo: confere em qual CPU esta a ISR
        // do LCD_CAM (fonte LCD_CAM; o reinicio do quadro nao pode disputar
        // o nucleo do Duktape)
        char* buf = nullptr;
        size_t len = 0;
        FILE* f = open_memstream(&buf, &len);
        if (f) {
            esp_intr_dump(f);
            fclose(f);
            for (char* line = strtok(buf, "\n"); line; line = strtok(nullptr, "\n")) {
                if (strstr(line, "CPU") || strstr(line, "LCD") || strstr(line, "Used")) print(ctx, "%s\r\n", line);
            }
            free(buf);
        }
    }
    return 0;
}
#endif

int cmdTop(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    uint32_t windowMs = 300;
    if (argc > 1) {
        windowMs = (uint32_t)atoi(argv[1]);
        if (windowMs < 50) windowMs = 50;
        if (windowMs > 10000) windowMs = 10000;
    }
    // fotos no heap (~1.4KB cada): este comando roda na task do canal
    DeviceStats::Snapshot* a =
        (DeviceStats::Snapshot*)malloc(sizeof(DeviceStats::Snapshot));
    DeviceStats::Snapshot* b =
        (DeviceStats::Snapshot*)malloc(sizeof(DeviceStats::Snapshot));
    if (a == nullptr || b == nullptr || !DeviceStats::take(*a)) {
        free(a);
        free(b);
        print(ctx, "sem memoria\r\n");
        return 1;
    }
    vTaskDelay(pdMS_TO_TICKS(windowMs));
    if (!DeviceStats::take(*b)) {  // sem a 2a foto o delta seria lixo
        free(a);
        free(b);
        print(ctx, "sem memoria\r\n");
        return 1;
    }

    const uint64_t dTotalRt = b->totalRunTimeUs - a->totalRunTimeUs;
    const uint32_t secs = (uint32_t)(b->uptimeUs / 1000000ULL);
    print(ctx, "up %uh%um%us  CPU %u MHz  janela %ums%s\r\n",
          secs / 3600, (secs / 60) % 60, secs % 60, b->cpuFreqMHz, windowMs,
          b->truncated ? "  (lista truncada)" : "");
    print(ctx, "heap %s (min %s, maior %s)  interna %s (min %s)\r\n",
          humanSize(b->heapFree).c_str(), humanSize(b->heapMin).c_str(),
          humanSize(b->heapLargest).c_str(), humanSize(b->intFree).c_str(),
          humanSize(b->intMin).c_str());
    if (b->psramTotal > 0) {
        print(ctx, "PSRAM %s de %s (min %s, maior %s)\r\n",
              humanSize(b->psramFree).c_str(), humanSize(b->psramTotal).c_str(),
              humanSize(b->psramMin).c_str(), humanSize(b->psramLargest).c_str());
    }
    if (b->jsActive) {
        print(ctx, "app: heap %s (livre no lancamento %s)  aloc JS %u (pico %u)\r\n",
              humanSize(b->jsLaunchFree > b->jsNowFree ? b->jsLaunchFree - b->jsNowFree : 0).c_str(),
              humanSize(b->jsLaunchFree).c_str(), b->jsAllocs, b->jsAllocsPeak);
    }
    const uint64_t dLoopBusy = b->loopBusyUs - a->loopBusyUs;
    const uint64_t dLoopTotal = b->loopTotalUs - a->loopTotalUs;
    if (dLoopTotal > 0) {
        print(ctx, "loop OS: %u.%u%% busy\r\n", (unsigned)(dLoopBusy * 100 / dLoopTotal),
              (unsigned)((dLoopBusy * 10000 / dLoopTotal) % 100));
    } else {
        print(ctx, "loop OS: parado (app aberto bombeia pelo present)\r\n");
    }
    const uint64_t dFrames = b->uiFrames - a->uiFrames;
    const uint64_t dPresents = b->uiPresents - a->uiPresents;
    if (dPresents > 0) {
        print(ctx, "present: %u fps  medio %uus (pico %uus)\r\n",
              (unsigned)(dFrames * 1000ULL / windowMs),
              (unsigned)((b->uiFrameUs - a->uiFrameUs) / dPresents),
              (unsigned)b->uiFrameUsMax);
    }
    // Quadro da UI nativa (launcher/paineis/teclado): quantos quadros na
    // janela e quanto custou compor x empurrar. No 4848 (RGB/PSRAM) o push e
    // a copia do framebuffer e domina o quadro; na CYD o push e por faixa.
    const uint64_t dKui = b->kuiPresents - a->kuiPresents;
    if (dKui > 0) {
        print(ctx, "launcher: %u fps  compor %uus  push %uus  (pico %uus, %u parciais/%u cheios)\r\n",
              (unsigned)(dKui * 1000ULL / windowMs),
              (unsigned)((b->kuiComposeUs - a->kuiComposeUs) / dKui),
              (unsigned)((b->kuiPushUs - a->kuiPushUs) / dKui),
              (unsigned)b->kuiMaxUs,
              (unsigned)(b->kuiPartial - a->kuiPartial),
              (unsigned)(b->kuiFull - a->kuiFull));
        const uint64_t dPar = b->kuiPartial - a->kuiPartial;
        if (dPar > 0) {
            print(ctx, "  parciais: compor %uus  push %uus\r\n",
                  (unsigned)((b->kuiPartComposeUs - a->kuiPartComposeUs) / dPar),
                  (unsigned)((b->kuiPartPushUs - a->kuiPartPushUs) / dPar));
        }
    }

    // svchost de servicos (API 42): foto do AppServices + delta dos contadores
    // do pump (DeviceStats, incrementados pelo AppServices::tick) na janela.
    // Contadores sao cumulativos desde o boot: "pior" e o maximo historico.
    {
        AppServices::Info svc = AppServices::info();
        if (svc.found == 0) {
            print(ctx, "svchost: sem servicos declarados\r\n");
        } else {
            const uint32_t dSvcTicks = b->svcTicks - a->svcTicks;
            const uint32_t dSvcOvr = b->svcOverruns - a->svcOverruns;
            const uint32_t dSvcSum = b->svcBusyMsSum - a->svcBusyMsSum;
            print(ctx, "svchost: %d/%d no ar, heap %s%s, pump ha %ums",
                  svc.running, svc.found,
                  svc.heapAlive ? "vivo" : "fora",
                  svc.suspended ? " (suspenso)" : "",
                  (unsigned)AppServices::lastTickAgoMs());
            if (dSvcTicks > 0) {
                const unsigned avgTenth = (unsigned)(dSvcSum * 10 / dSvcTicks);
                print(ctx, ", %u giro(s) na janela (media %u.%ums, %u overrun, pior do boot %ums)",
                      (unsigned)dSvcTicks, avgTenth / 10, avgTenth % 10,
                      (unsigned)dSvcOvr, (unsigned)b->svcBusyMsMax);
            }
            print(ctx, "\r\n");
        }
    }

    // delta de runtime por task (pareada pelo nome) + ordenacao por CPU desc
    uint32_t idx[DeviceStats::kMaxTasks];
    uint64_t dRt[DeviceStats::kMaxTasks];
    uint32_t n = 0;
    for (uint32_t i = 0; i < b->taskCount; i++) {
        uint64_t base = 0;
        for (uint32_t j = 0; j < a->taskCount; j++) {
            if (strcmp(a->tasks[j].name, b->tasks[i].name) == 0) {
                base = a->tasks[j].runTimeUs;
                a->tasks[j].name[0] = '\0';  // nomes iguais: parea 1 a 1
                break;
            }
        }
        dRt[n] = b->tasks[i].runTimeUs - base;
        idx[n] = i;
        n++;
    }
    for (uint32_t i = 1; i < n; i++) {  // insertion sort: n <= 32
        const uint64_t key = dRt[i];
        const uint32_t ki = idx[i];
        uint32_t j = i;
        while (j > 0 && dRt[j - 1] < key) {
            dRt[j] = dRt[j - 1];
            idx[j] = idx[j - 1];
            j--;
        }
        dRt[j] = key;
        idx[j] = ki;
    }

    print(ctx, "task              est  prio  stack  cpu\r\n");
    for (uint32_t i = 0; i < n; i++) {
        const DeviceStats::TaskInfo& t = b->tasks[idx[i]];
        const unsigned centi =
            dTotalRt > 0 ? (unsigned)(dRt[i] * 10000ULL / dTotalRt) : 0;
        print(ctx, "%-16s  %c   %3u  %5u  %2u.%02u\r\n",
              t.name, t.state, t.prio, t.stackFree, centi / 100, centi % 100);
    }
    free(a);
    free(b);
    return 0;
}

int cmdUptime(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    uint64_t us = esp_timer_get_time();
    uint32_t secs = (uint32_t)(us / 1000000ULL);
    print(ctx, "up %uh %um %us (%llu s)\r\n", secs / 3600, (secs / 60) % 60, secs % 60,
          (unsigned long long)(us / 1000000ULL));
    return 0;
}

int cmdInfo(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    char ip[16] = "";
    bool hasIp = ipOf(ip, sizeof(ip));
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);

    char fsLocal[64] = "", fsSd[64] = "";
    if (FileSystem::exists("/local")) {
        snprintf(fsLocal, sizeof(fsLocal), "%s/%s livres", humanSize(FileSystem::getTotalSpace("/local")).c_str(),
                 humanSize(FileSystem::getFreeSpace("/local")).c_str());
    }
    if (FileSystem::exists("/sd")) {
        snprintf(fsSd, sizeof(fsSd), "%s/%s livres", humanSize(FileSystem::getTotalSpace("/sd")).c_str(),
                 humanSize(FileSystem::getFreeSpace("/sd")).c_str());
    }

    print(ctx,
        "CelerOS  : %s (API level %d)\r\n"
        "board    : %s\r\n"
        "SDK      : %s\r\n"
        "uptime   : %llus\r\n"
        "heap     : %s livres / min %s\r\n"
        "ip       : %s\r\n"
        "mac      : %02X:%02X:%02X:%02X:%02X:%02X\r\n"
        "/local   : %s\r\n"
        "/sd      : %s\r\n",
        CELEROS_VERSION, CELEROS_API_LEVEL, boardName(), esp_get_idf_version(),
        (unsigned long long)(esp_timer_get_time() / 1000000ULL),
        humanSize(esp_get_free_heap_size()).c_str(),
        humanSize(esp_get_minimum_free_heap_size()).c_str(),
        hasIp ? ip : "(desconectado)", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
        fsLocal[0] ? fsLocal : "(ausente)", fsSd[0] ? fsSd : "(ausente)");
    return 0;
}

// Diagnostico de cor: desenha, le de volta e imprime o conteudo do fb
int cmdColorBars(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    CelerDisplay& tft = Board::display();
    char line[96];
    snprintf(line, sizeof(line), "depth=%u rot=%u w=%u h=%u\r\n",
             (unsigned)tft.getColorDepth(), (unsigned)tft.getRotation(),
             (unsigned)tft.width(), (unsigned)tft.height());
    print(ctx, line);

    const uint32_t bars[6] = {0xFF0000, 0x00FF00, 0x0000FF, 0xFFFFFF, 0xFFFF00, 0x00FFFF};
    const uint16_t exp565[6] = {0xF800, 0x07E0, 0x001F, 0xFFFF, 0xFFE0, 0x07FF};
    const char* nm[6] = {"RED", "GRN", "BLU", "WHT", "YEL", "CYN"};
    int bw = tft.width() / 6;
    uint16_t got;
    for (int i = 0; i < 6; i++) {
        tft.fillRect(i * bw, 0, bw, tft.height(), bars[i]);
        tft.readRect(i * bw + bw / 2, tft.height() / 2, 1, 1, &got);
        snprintf(line, sizeof(line), "%s exp=%04X got=%04X\r\n", nm[i], exp565[i], got);
        print(ctx, line);
    }
    // tema: fill + readback direto
    const uint32_t theme[3] = {THEME_BG, THEME_CARD, THEME_ACCENT};
    const uint16_t themeExp[3] = {0x0882, 0x10E4, 0x269D};
    const char* tn[3] = {"BG  ", "CARD", "ACNT"};
    for (int i = 0; i < 3; i++) {
        tft.fillRect(0, 0, 100, 100, theme[i]);
        tft.readRect(50, 50, 1, 1, &got);
        snprintf(line, sizeof(line), "%s exp=%04X got=%04X\r\n", tn[i], themeExp[i], got);
        print(ctx, line);
    }
    // pushImage de 565 puro (vermelho) e readback
    uint16_t raw[4] = {0xF800, 0xF800, 0x07E0, 0x07E0};
    tft.pushImage(0, 0, 2, 2, raw);
    tft.readRect(0, 0, 1, 1, &got);
    snprintf(line, sizeof(line), "PUSH exp=F800 got=%04X\r\n", got);
    print(ctx, line);
    print(ctx, "feito\r\n");
    return 0;
}

int cmdRescan(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv;
    LauncherUI::requestRescan();
    print(ctx, "launcher rescaneando apps\r\n");
    return 0;
}

// installzip <zip> <nomeDaPasta>: pacote unico do app pela bancada (o par
// do System.installZip na loja). O zip sobe com `celerctl apps installzip`
// (push + este comando); extracao valida tetos, extrai em <dest>.new e
// troca com rollback — o app antigo fica intacto se algo falhar.
int cmdInstallZip(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 3) {
        print(ctx, "uso: installzip <zip> <nomeDaPasta>\r\n");
        return 1;
    }
    std::string zip = resolvePath(argv[1]);
    if (!CelerShell::pathAllowed(zip)) {
        print(ctx, "installzip: caminho invalido (use /local ou /sd)\r\n");
        return 1;
    }
    const char* nome = argv[2];
    // junta argumentos (nomes com espaco: installzip pacote.zip Meu App)
    std::string nomeJoin = argv[2];
    for (int i = 3; i < argc; i++) nomeJoin += std::string(" ") + argv[i];
    nome = nomeJoin.c_str();
    size_t len = strlen(nome);
    if (len == 0 || len > 40 || strchr(nome, '/') != nullptr ||
        strchr(nome, '\\') != nullptr || strstr(nome, "..") != nullptr) {
        print(ctx, "installzip: nome de pasta invalido\r\n");
        return 1;
    }
    std::string dest = std::string("/local/apps/") + nome;
    celer::apppkg::Result r;
    if (!celer::apppkg::installZip(zip.c_str(), dest.c_str(), &r)) {
        print(ctx, "installzip: pacote recusado (teto, zip invalido ou entry ausente)\r\n");
        return 1;
    }
    LauncherUI::requestRescan();
    print(ctx, "ok: %d arquivos, %u bytes em %s\r\n", r.files, (unsigned)r.bytes, dest.c_str());
    return 0;
}

#if CONFIG_CELEROS_APP_SERVICES
// Estado legivel de um servico (svc list/info). A ordem importa: parado e
// backoff vencem os outros (um giro com crash deixa running=false e o
// dispatch reabre; suspenso so existe sem PSRAM com app em foreground).
static const char* svcEstado(const AppServices::SvcState& s) {
    if (s.stopped) return "parado";
    if (s.backingOff) return "backoff";
    if (s.suspended) return "suspenso";
    if (s.running) return "no ar";
    return "aguardando";
}
#endif

// svc <list|info|stop|start|setup> [pkg]: servicos em segundo plano de apps
// (API 42). stop mata os timers do servico e o deixa parado ate `svc start`
// ou reboot; list/info sao a janela de debugging do svchost.
int cmdSvc(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc >= 2 && strcmp(argv[1], "list") == 0) {
        AppServices::Info in = AppServices::info();
        const uint32_t ago = AppServices::lastTickAgoMs();
        print(ctx, "svchost: heap %s, %d servico(s), %d no ar%s, pump ha %ums\r\n",
              in.heapAlive ? "vivo" : "fora", in.found, in.running,
              in.suspended ? " [suspenso: app em foreground]" : "",
              (unsigned)ago);
#if CONFIG_CELEROS_APP_SERVICES
        for (const AppServices::SvcState& s : in.apps) {
            print(ctx, "  %-18s %-10s %d reinicio(s)%s%s\r\n",
                  s.name.c_str(), svcEstado(s), s.restarts,
                  s.lastErr[0] != '\0' ? " | " : "",
                  s.lastErr[0] != '\0' ? s.lastErr : "");
        }
#endif
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "info") == 0) {
        const std::string pkg = argv[2];
#if CONFIG_CELEROS_APP_SERVICES
        AppServices::Info in = AppServices::info();
        for (const AppServices::SvcState& s : in.apps) {
            if (s.pkg != pkg) continue;
            print(ctx, "servico %s (%s)\r\n", s.name.c_str(), s.pkg.c_str());
            print(ctx, "  estado    : %s\r\n", svcEstado(s));
            if (s.backoffRemainMs > 0) {
                print(ctx, "  backoff   : %ums restantes\r\n", (unsigned)s.backoffRemainMs);
            }
            print(ctx, "  reinicios : %d\r\n", s.restarts);
            if (s.lastErr[0] != '\0') {
                print(ctx, "  ult. erro : %s\r\n", s.lastErr);
            }
            print(ctx, "  svchost   : heap %s%s\r\n",
                  in.heapAlive ? "vivo" : "fora",
                  in.suspended ? " (suspenso: app em foreground)" : "");
            print(ctx, "  pump      : ultimo giro ha %ums\r\n",
                  (unsigned)AppServices::lastTickAgoMs());
            return 0;
        }
#endif
        print(ctx, "info: servico %s nao encontrado\r\n", pkg.c_str());
        return 1;
    }
    if (argc >= 3 && (strcmp(argv[1], "stop") == 0 || strcmp(argv[1], "start") == 0)) {
        bool ok = strcmp(argv[1], "stop") == 0 ? AppServices::stopService(argv[2])
                                               : AppServices::startService(argv[2]);
        print(ctx, "%s: %s\r\n", argv[1], ok ? "ok" : "servico nao encontrado");
        return ok ? 0 : 1;
    }
    if (argc >= 3 && strcmp(argv[1], "setup") == 0) {
        bool ok = AppServices::rerunSetup(argv[2]);
        print(ctx, "setup: %s (roda no proximo giro)\r\n", ok ? "reagendado" : "svc ausente");
        return ok ? 0 : 1;
    }
#if CONFIG_CELEROS_BLUETOOTH
    // reflexos nativos (API 47): "se sensor X > Y entao atuador Z" no NVS
    if (argc >= 2 && strcmp(argv[1], "reflex") == 0) {
        return reflex::cmd(argc - 2, argv + 2, print, ctx);
    }
#endif
    print(ctx, "uso: svc list | svc info <pkg> | svc stop|start|setup <pkg> | svc reflex ...\r\n");
    return 1;
}

// Lista os apps que o launcher enxerga, COM a origem: /local e /sd
// deduplicam pelo packageName e a copia local vence — sem a origem na
// listagem o dev edita a copia do cartao, da run e a mudanca "nao pega"
// (bancada 2026-10-09: Supernova editado em /local rodava a copia velha).
int cmdApps(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv;
    int n = LauncherUI::appEntryCount();
    if (n <= 0) {
        // boot recente (ou lista zerada): o rescan roda no onTick do
        // launcher — espera curta, padrao do cmdGrant
        LauncherUI::requestRescan();
        for (int t = 0; t < 20 && LauncherUI::appEntryCount() <= 0; t++) {
            vTaskDelay(pdMS_TO_TICKS(150));
        }
        n = LauncherUI::appEntryCount();
    }
    if (n <= 0) {
        print(ctx, "nenhum app na lista do launcher (rescan pendente?)\r\n");
        return 1;
    }
    for (int i = 0; i < n; i++) {
        const std::string& p = LauncherUI::appEntryPath(i);
        const std::string& pkg = LauncherUI::appEntryPkg(i);
        const char* mount = p.compare(0, 4, "/sd/") == 0 ? "sd" : "local";
        print(ctx, "%-6s %-18s %-24s %s%s\r\n", mount,
              LauncherUI::appEntryName(i).c_str(),
              pkg.empty() ? "-" : pkg.c_str(), p.c_str(),
              LauncherUI::appEntryIsSystem(i) ? " [sistema]" : "");
    }
    return 0;
}

// Diagnostico de arquivo no PROPRIO device: tamanho/mtime + CRC32 do
// conteudo lido agora. O par do `push --verify` da ferramenta: quando o
// filesystem serve um conteudo velho (ls mostra tamanho novo, cat devolve
// antigo — bancada 2026-10-09), o crc aqui prova sem puxar o arquivo.
int cmdStat(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: stat <arquivo|diretorio>\r\n");
        return 1;
    }
    std::string path = resolvePath(argv[1]);
    if (!CelerShell::pathAllowed(path)) {
        print(ctx, "stat: caminho invalido (use /local ou /sd)\r\n");
        return 1;
    }
    struct stat st;
    memset(&st, 0, sizeof(st));
    if (stat(path.c_str(), &st) != 0) {
        print(ctx, "stat: %s nao existe\r\n", path.c_str());
        return 1;
    }
    char when[24] = "--------------------";
    struct tm tmv;
    if (st.st_mtime > 0 && localtime_r(&st.st_mtime, &tmv) != nullptr) {
        strftime(when, sizeof(when), "%Y-%m-%d %H:%M:%S", &tmv);
    }
    if (S_ISDIR(st.st_mode)) {
        print(ctx, "dir      %s\r\n mtime %s\r\n", path.c_str(), when);
        return 0;
    }
    uint32_t crc = 0;
    FILE* f = fopen(path.c_str(), "rb");
    if (f == nullptr) {
        print(ctx, "stat: nao consegui abrir %s\r\n", path.c_str());
        return 1;
    }
    uint8_t buf[512];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) crc = hostframe::crc32(buf, n, crc);
    fclose(f);
    print(ctx, "arquivo  %s\r\n tamanho %u  crc32 %08X  mtime %s\r\n",
          path.c_str(), (unsigned)st.st_size, crc, when);
    return 0;
}

// Ultimo erro de app registrado: /local/lastcrash.txt e gravado pelo kernel
// em todo erro de app (inclusive OOM) e no boot apos um fatal do runtime —
// a stack nao morre mais com o reboot ou com o ring de logs (2KB) rolando.
int cmdLastError(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv;
    const char* path = "/local/lastcrash.txt";
    struct stat st;
    if (stat(path, &st) != 0 || st.st_size == 0) {
        print(ctx, "nenhum erro de app registrado\r\n");
        return 0;
    }
    char when[24] = "--------------------";
    struct tm tmv;
    if (st.st_mtime > 0 && localtime_r(&st.st_mtime, &tmv) != nullptr) {
        strftime(when, sizeof(when), "%Y-%m-%d %H:%M", &tmv);
    }
    print(ctx, "ultimo erro (%s, %u B, gravado %s):\r\n", path, (unsigned)st.st_size, when);
    FILE* f = fopen(path, "rb");
    if (f == nullptr) {
        print(ctx, "lasterror: nao consegui abrir %s\r\n", path);
        return 1;
    }
    char buf[256];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
        print(ctx, "%.*s", (int)n, buf);
    }
    fclose(f);
    print(ctx, "\r\n");
    return 0;
}

// crash [n]: triagem rapida do ultimo erro de app — o header do
// /local/lastcrash.txt (versao, hora, app/pacote e o tipo do erro, gravado
// pelo CelerKernel::recordCrash) + as ultimas n linhas do apps.log (prints
// dos apps, com o pacote na frente). O `lasterror` segue com a stack inteira;
// este aqui responde "quem crashou e o que ele disse antes" numa vez so.
static int printTail(const std::string& path, long n, CelerShell::PrintFn print, void* ctx);
int cmdCrash(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    long n = (argc > 1) ? atol(argv[1]) : 20;
    if (n < 1) n = 1;
    if (n > 200) n = 200;
    const char* path = "/local/lastcrash.txt";
    struct stat st;
    if (stat(path, &st) != 0 || st.st_size == 0) {
        print(ctx, "nenhum crash registrado (%s ausente)\r\n", path);
        return 0;
    }
    char when[24] = "--------------------";
    struct tm tmv;
    if (st.st_mtime > 0 && localtime_r(&st.st_mtime, &tmv) != nullptr) {
        strftime(when, sizeof(when), "%Y-%m-%d %H:%M", &tmv);
    }
    FILE* f = fopen(path, "rb");
    if (f == nullptr) {
        print(ctx, "crash: nao consegui abrir %s\r\n", path);
        return 1;
    }
    // as 2 primeiras linhas carregam o contexto: "CelerOS x | hora | uptime |
    // app: Titulo (pkg)" e o tipo do erro; a stack fica para o lasterror
    char line[256];
    print(ctx, "ultimo crash (arquivo de %s):\r\n", when);
    for (int i = 0; i < 2 && fgets(line, sizeof(line), f) != nullptr; i++) {
        print(ctx, "  %s", line);  // fgets preserva o \n
    }
    fclose(f);
    // tail do apps.log na mesma casa do LogPersist (SD quando montado; sem
    // log la — cartao tirado/trocado — cai para a littlefs)
    std::string applog = FileSystem::sdMounted() ? std::string("/sd/log/apps.log")
                                                 : std::string("/local/log/apps.log");
    if (stat(applog.c_str(), &st) != 0 && FileSystem::sdMounted()) {
        applog = "/local/log/apps.log";
    }
    if (stat(applog.c_str(), &st) == 0 && st.st_size > 0) {
        print(ctx, "ultimas %ld linhas de %s:\r\n", n, applog.c_str());
        if (printTail(applog, n, print, ctx) != 0) {
            print(ctx, "crash: nao consegui abrir %s\r\n", applog.c_str());
            return 1;
        }
        print(ctx, "\r\n");
    } else {
        print(ctx, "sem %s (logs de app persistentes ausentes neste build/boot)\r\n",
              applog.c_str());
    }
    return 0;
}

// acha a entrada na lista do launcher esperando o rescan pedido antes
// (lista nova leva ate ~3 s pra ficar pronta; com app aberto o onTick do
// launcher nao roda e a resposta vem da lista atual — o cmdGrant espera igual)
static int waitEntry(const std::string& target) {
    for (int t = 0;; t++) {
        int idx = LauncherUI::findEntry(target);
        if (idx >= 0) return idx;
        if (t >= 20) return -1;
        vTaskDelay(pdMS_TO_TICKS(150));
    }
}

int cmdRun(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: run <pasta|nome|pacote do app>\r\n");
        return 1;
    }
    // junta argumentos (nomes com espaco: run App Store)
    std::string target = argv[1];
    for (int i = 2; i < argc; i++) target += std::string(" ") + argv[i];
    // launch remoto com a tela apagada: o light-sleep do PowerPolicy quase
    // para o tick do launcher (quem consome o requestLaunch) — acordar a
    // tela devolve o ritmo e o app abre em segundos, nao em minutos
    Backlight::noteActivity();
    LauncherUI::requestRescan();  // app recem-instalado entra na lista
    // Acha a entrada ANTES de pedir o launch: um alvo inexistente falhava
    // calado ("abrindo X" que nunca abria — bancada 2026-10-08) e a resposta
    // agora diz DE ONDE o app abre (o dedup do launcher faz a copia local
    // vencer a do cartao; sem isso o dev edita /sd, da run e "nada muda").
    const int idx = waitEntry(target);
    if (idx < 0) {
        print(ctx, "run: '%s' nao esta na lista do launcher (veja 'apps'); nada aberto\r\n",
              target.c_str());
        return 1;
    }
    // "exit" de antes do run com o launcher ocioso (o celerctl apps run manda
    // exit+run): sem app para fechar, o pedido ficava 2 s pendente e matava o
    // app que este run abre no primeiro delay — no 4848 (sem tela inicial)
    // todo `apps run` morria com "app exit" (bancada 2026-10-11)
    LauncherUI::dropIdleExitRequest();
    LauncherUI::requestLaunch(target);
    // E fecha o app atual: em placa com tela inicial (cao/relogio) o "exit"
    // seguido de "run" perdia a corrida — o launcher reabria a casa entre os
    // dois e o run ficava esperando ela sair para sempre. O pedido de launch
    // ja esta pendente, entao a saida cai nele (e nao na casa). So com app
    // aberto: no launcher ocioso o app pedido abre em < 2 s e uma saida
    // pedida "por garantia" o fecharia logo ao nascer.
    if (LauncherUI::appRunning()) LauncherUI::requestAppExit();
    const std::string& path = LauncherUI::appEntryPath(idx);
    print(ctx, "abrindo %s -> %s (%s)\r\n", LauncherUI::appEntryName(idx).c_str(),
          path.c_str(), path.compare(0, 4, "/sd/") == 0 ? "sd" : "local");
    // Sem consentimento o launcher abre o dialogo "Permitir?" na tela — num
    // relogio de tela apagada (ou no cao, sem toque) ninguem responde e o
    // idle-home volta para a casa: o run "sumia" sem aviso (bancada 2026-10-08)
    const uint32_t missing = LauncherUI::appEntryMissingPerms(idx);
    if (missing != 0) {
        print(ctx, "aviso: falta consentimento (%s) — vai pedir na tela; sem toque: grant %s\r\n",
              AppGrants::describe(missing).c_str(), target.c_str());
    }
    return 0;
}

int cmdExit(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv;
    // Pede o encerramento do app em execucao: os pontos de espera do runtime
    // (delay/getTouch/keypadPoll) transformam o pedido na mesma saida limpa do
    // X da topbar. Com app rodando o pedido vale ate ele ceder (mesmo preso
    // segundos numa chamada nativa); sem app, expira em 2 s e nao derruba o
    // proximo (dev loop usa exit+run em sequencia).
    LauncherUI::requestAppExit();
    print(ctx, "encerrando app atual (se houver)\r\n");
    return 0;
}

// Consentimento pelo console — o caminho headless: o dialogo de permissoes
// do launcher e touch (Permitir/Cancelar), que o cao robotico (so pad
// capacitivo) e o devkit sem vidro nao conseguem responder. Concede
// EXATAMENTE o que o app declara no app.json (mesma mascara do grantEntry
// do launcher), entao o `run` seguinte nao pergunta nada.
int cmdGrant(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: grant <pasta|nome|pacote do app>\r\n");
        return 1;
    }
    std::string target = argv[1];
    for (int i = 2; i < argc; i++) target += std::string(" ") + argv[i];
    LauncherUI::requestRescan();  // app recem-instalado entra na lista
    // O rescan roda no onTick do launcher: com um app aberto (o cao vive no
    // Dog Face) a lista demora — da um tempo antes de desistir dela
    int idx = -1;
    for (int t = 0; t < 20 && idx < 0; t++) {
        idx = LauncherUI::findEntry(target);
        if (idx < 0) vTaskDelay(pdMS_TO_TICKS(150));
    }
    if (idx >= 0) {
        LauncherUI::grantEntry(idx);
        print(ctx, "permissoes concedidas a %s (as declaradas no app.json)\r\n",
              LauncherUI::appEntryName(idx).c_str());
        return 0;
    }
    // Fallback pelo FS (forma "pasta"): grant direto com o mesmo par
    // (pacote, caminho) que o scan do launcher usa — a lista pode estar
    // parada atras de um app aberto, o arquivo ja esta no lugar
    for (const char* base : {"/local/apps/", "/sd/apps/"}) {
        std::string dir = std::string(base) + target;
        std::string json = FileSystem::readTextFile((dir + "/app.json").c_str());
        if (json.empty()) continue;
        size_t k = json.find("\"packageName\"");
        // O ':' tem que ser procurado DEPOIS da chave: npos+1 dava 0 e o q1
        // caia na primeira aspas do app.json — grant saia para o pacote lixo
        size_t colon = k == std::string::npos ? std::string::npos : json.find(':', k);
        size_t q1 = colon == std::string::npos ? colon : json.find('"', colon + 1);
        size_t q2 = q1 == std::string::npos ? q1 : json.find('"', q1 + 1);
        if (q1 == std::string::npos || q2 == std::string::npos) continue;
        std::string pkg = json.substr(q1 + 1, q2 - q1 - 1);
        uint32_t mask = celer::parsePermissions(json) &
                        (celer::PERM_FS | celer::PERM_NET | celer::PERM_GPIO |
                         celer::PERM_SYSTEM | celer::PERM_MIC | celer::PERM_CAMERA |
                         celer::PERM_USB | celer::PERM_INPUT);
        AppGrants::grant(pkg, dir, mask);
        print(ctx, "permissoes concedidas a %s (%s)\r\n", pkg.c_str(), dir.c_str());
        return 0;
    }
    print(ctx, "app nao encontrado: %s\r\n", target.c_str());
    return 1;
}

// Arma/desarma o debugger Duktape do PROXIMO app lancado (a sessao em si e
// do celerctl debug, que faz o proxy TCP do protocolo dmsg).
int cmdDebug(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    bool on;
    if (argc > 1 && strcmp(argv[1], "on") == 0) on = true;
    else if (argc > 1 && strcmp(argv[1], "off") == 0) on = false;
    else {
        print(ctx, "uso: debug on|off (debugger do proximo app; celerctl debug abre a sessao)\r\n");
        return 1;
    }
    JsDebugger::setRequested(on);
    if (on && !JsDebugger::requested()) {
        print(ctx, "debugger JS: suporte NAO compilado neste firmware\r\n"
              "(Kconfig CELEROS_JS_DEBUGGER; padrao so nas placas S3)\r\n");
        return 1;
    }
    print(ctx, "debugger JS %s\r\n", on ? "armado (attacha quando o celerctl debug conectar um cliente)"
                                         : "desarmado");
    return 0;
}

int cmdReboot(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc > 1 && strcmp(argv[1], "panic") == 0) {
        // Bancada da forense de crash: abort() real passa pelo wrap do
        // esp_panic_handler (Kernel/CrashRecord) -> reboot -> crash.txt e,
        // nas placas com vidro, tela de crash com QR no boot seguinte.
        print(ctx, "reboot panic: abort() em 3s (registro RTC + tela no boot seguinte)\r\n");
        vTaskDelay(pdMS_TO_TICKS(3000));
        abort();
    }
    if (argc > 1 && strcmp(argv[1], "msc") == 0) {
#if CONFIG_CELEROS_USB_MSC
        // Flag one-shot consumida no boot (main.cpp/usbMscMode): o proximo
        // boot desanexa o /sd e expoe o cartao ao PC ate o reboot.
        FileSystem::usbMscFlagSet(true);
        print(ctx, "reiniciando em modo pen drive (SD exposto ao PC)...\r\n");
        vTaskDelay(pdMS_TO_TICKS(300));
        CelerShell::requestRestart();
#else
        print(ctx, "reboot msc: sem suporte nesta placa (CELEROS_USB_MSC)\r\n");
        return 1;  // sem isto o fluxo caia no reboot geral logo abaixo
#endif
    }
    print(ctx, "reiniciando...\r\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    CelerShell::requestRestart();
    return 0;
}

// Provisioning WiFi pelo console — o caminho headless (devkit barebone): sem
// vidro nao ha tela de setup nem captive portal utilizavel, e o celerctl
// pela UART funciona sem rede. Salva no credential store (NVS, mesma origem
// do portal) e conecta em segundo plano; `info` mostra o IP quando subir.
// O shell nao trata aspas: ssid sem espacos; a senha pode ter espacos.
int cmdWifi(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    NetworkManager& nm = NetworkManager::instance();
    if (argc < 2) {
        auto nets = nm.getKnownNetworks();
        if (nets.empty()) {
            print(ctx, "nenhuma rede salva (use: wifi <ssid> <senha>)\r\n");
            return 0;
        }
        for (auto& n : nets) print(ctx, "%s (prioridade %d)\r\n", n.ssid, n.priority);
        return 0;
    }
    // wifi off|on: o mesmo liga/desliga persistente do painel do relogio —
    // bancada de coexistencia BLE x WiFi (o off derruba a ponte WiFi do
    // celerctl; o USB segue). "on" desfaz.
    if (argc == 2 && strcmp(argv[1], "off") == 0) {
        WebManager::disablePersist();
        print(ctx, "WiFi desligado (persistente; 'wifi on' religa)\r\n");
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "on") == 0) {
        WebManager::enableAsync();
        print(ctx, "WiFi religando em segundo plano\r\n");
        return 0;
    }
    std::string ssid = argv[1];
    std::string pass;
    for (int i = 2; i < argc; i++) pass += std::string(i > 2 ? " " : "") + argv[i];
    if (ssid.size() > 32) {
        print(ctx, "wifi: ssid acima de 32 caracteres\r\n");
        return 1;
    }
    KnownNetwork net(ssid.c_str(), pass.c_str());
    if (nm.addNetwork(net) != CommonErrorCodes::None) {
        print(ctx, "wifi: falha ao salvar no NVS\r\n");
        return 1;
    }
    nm.connect(ssid, pass, false);  // credencial ja salva; conecta agora
    print(ctx, "rede '%s' salva; conectando em segundo plano (info mostra o IP)\r\n", ssid.c_str());
    return 0;
}

#include "sdkconfig.h"
#if CONFIG_CELEROS_DEBUG_BRIDGE
// Estado do Celer Debug Bridge (celerctl por TCP/WiFi) e o token de
// pareamento — e daqui que a bancada le o token na 1a conexao sem cabo.
int cmdBridge(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc >= 2 && strcmp(argv[1], "reset") == 0) {
        DebugBridge::tokenReset();
        print(ctx, "token novo: %s\r\n", DebugBridge::token());
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "set") == 0) {
        // caminho de automacao do "celerctl provision": token escolhido
        if (!DebugBridge::tokenSet(argv[2])) {
            print(ctx, "bridge set: token invalido (6..31 chars, sem espacos)\r\n");
            return 1;
        }
        print(ctx, "token gravado: %s\r\n", DebugBridge::token());
        return 0;
    }
    char ip[16] = "";
    bool hasIp = ipOf(ip, sizeof(ip));
    print(ctx,
          "bridge  : %s (%s)\r\n"
          "ip      : %s\r\n"
          "porta   : %u (TCP celerctl + UDP sonda)\r\n"
          "cliente : %s\r\n"
          "token   : %s (celerctl pair / --token; \"bridge reset\" troca)\r\n",
          DebugBridge::listening() ? "escutando" : "aguardando WiFi",
          DebugBridge::sessionActive() ? "sessao ativa" : "livre",
          hasIp ? ip : "(desconectado)", (unsigned)DebugBridge::port(),
          DebugBridge::sessionActive() ? "conectado" : "nenhum", DebugBridge::token());
    return 0;
}
#endif

#if CONFIG_CELEROS_PHONE_LINK
// Injeta uma linha do protocolo do Gadgetbridge na mesma fila do RX do BLE
// (teste do protocolo sem o Android). O shell nao trata aspas: mande a linha
// compacta e sem espacos, ex.: gb GB({"t":"weather","temp":299.15,...})
int cmdGb(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: gb <linha do protocolo, compacta e sem espacos>\r\n");
        return 1;
    }
    std::string line = argv[1];
    for (int i = 2; i < argc; i++) line += std::string(" ") + argv[i];
    PhoneLink::injectLine(line);
    print(ctx, "linha injetada (processada no proximo tick)\r\n");
    return 0;
}
#endif

// ------------------------------------------------------------- unix basicos

int cmdEcho(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    int i = 1;
    bool newline = true;
    if (i < argc && strcmp(argv[i], "-n") == 0) {
        newline = false;
        i++;
    }
    for (; i < argc; i++) print(ctx, "%s%s", argv[i], (i + 1 < argc) ? " " : "");
    if (newline) print(ctx, "\r\n");
    return 0;
}

// Saida de condicao (if/while): descartada — a condicao roda calada, o
// codigo de retorno e o que decide. va_start/va_end vazios pelo ABI de
// varargs.
static void devNullPrint(void* ctx, const char* fmt, ...) {
    (void) ctx; (void) fmt;
    va_list ap;
    va_start(ap, fmt);
    va_end(ap);
}

// set VAR=valor | set (lista) | unset VAR. O valor junta os argumentos
// (set MSG=oi tudo -> "oi tudo") e, DEPOIS da expansao de $, o que casa
// INTEIRO com "[-]N OP [-]N" (OP em + - * / %) e calculado — e o jeito
// curto de incrementar contador num sh sem expr(1). O %n do sscanf
// exige o fim da string: "2026-10-10" (data) nao vira conta.
int cmdSet(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        for (int i = 0; i < s_varCount; i++) {
            print(ctx, "%s=%s\r\n", s_vars[i].name, s_vars[i].val);
        }
        return 0;
    }
    std::string a = argv[1];
    for (int i = 2; i < argc; i++) a += std::string(" ") + argv[i];
    const size_t eq = a.find('=');
    if (eq == std::string::npos || eq == 0 || eq > 15) {
        print(ctx, "uso: set VAR=valor (nome ate 15 chars, com letra ou _)\r\n");
        return 1;
    }
    for (size_t i = 0; i < eq; i++) {
        const char c = a[i];
        const bool ok = (i == 0) ? (isalpha((unsigned char)c) || c == '_')
                                 : (isalnum((unsigned char)c) || c == '_');
        if (!ok) {
            print(ctx, "set: nome de variavel invalido\r\n");
            return 1;
        }
    }
    std::string val = a.substr(eq + 1);
    if (val.size() > 63) {
        print(ctx, "set: valor acima de 63 caracteres\r\n");
        return 1;
    }
    // aritmetica de inteiros (algoritmo puro no Utils/ShellLogic.h): e o
    // contador do sh — "set I=$I + 1" depois da expansao vira "5 + 1"
    long r = 0;
    switch (shl::arithEval(val.c_str(), &r)) {
        case shl::Arith::Ok: {
            char nb[24];
            snprintf(nb, sizeof(nb), "%ld", r);
            if (!shVarSet(a.substr(0, eq).c_str(), nb)) {
                print(ctx, "set: tabela cheia (%d variaveis)\r\n", kMaxVars);
                return 1;
            }
            return 0;
        }
        case shl::Arith::DivZero:
            print(ctx, "set: divisao por zero\r\n");
            return 1;
        case shl::Arith::None:
            break;  // nao era conta: grava literal
    }
    if (!shVarSet(a.substr(0, eq).c_str(), val.c_str())) {
        print(ctx, "set: tabela cheia (%d variaveis)\r\n", kMaxVars);
        return 1;
    }
    return 0;
}

int cmdUnset(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: unset VAR\r\n");
        return 1;
    }
    shVarUnset(argv[1]);
    return 0;
}

// test / [ — a condicao de if/while no estilo do test(1): 0 = verdadeiro.
//   [ a = b ]  [ a != b ]                    strings
//   [ 1 -lt 2 ]  -eq -ne -lt -le -gt -ge     inteiros (atol)
//   [ -e arq ]  [ -f arq ]  [ -d dir ]       filesystem (jail /local /sd)
//   [ -z str ]  [ -n str ]                   vazio / nao-vazio
int cmdTest(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (strcmp(argv[0], "[") == 0) {
        if (argc < 2 || strcmp(argv[argc - 1], "]") != 0) {
            print(ctx, "uso: [ a = b ] | [ -f arq ] | [ 1 -lt 2 ]\r\n");
            return 2;
        }
        argc--;  // tira o ']' do fim
    }
    if (argc == 4) {
        const char* a = argv[1];
        const char* op = argv[2];
        const char* b = argv[3];
        if (strcmp(op, "=") == 0) return (strcmp(a, b) == 0) ? 0 : 1;
        if (strcmp(op, "!=") == 0) return (strcmp(a, b) != 0) ? 0 : 1;
        const long x = atol(a), y = atol(b);
        if (strcmp(op, "-eq") == 0) return (x == y) ? 0 : 1;
        if (strcmp(op, "-ne") == 0) return (x != y) ? 0 : 1;
        if (strcmp(op, "-lt") == 0) return (x < y) ? 0 : 1;
        if (strcmp(op, "-le") == 0) return (x <= y) ? 0 : 1;
        if (strcmp(op, "-gt") == 0) return (x > y) ? 0 : 1;
        if (strcmp(op, "-ge") == 0) return (x >= y) ? 0 : 1;
    } else if (argc == 3) {
        const char* op = argv[1];
        const char* a = argv[2];
        if (strcmp(op, "-z") == 0) return (a[0] == '\0') ? 0 : 1;
        if (strcmp(op, "-n") == 0) return (a[0] != '\0') ? 0 : 1;
        if (strcmp(op, "-e") == 0 || strcmp(op, "-f") == 0 || strcmp(op, "-d") == 0) {
            std::string path = resolvePath(a);
            if (!CelerShell::pathAllowed(path)) return 1;
            if (op[1] == 'e') return FileSystem::exists(path.c_str()) ? 0 : 1;
            if (op[1] == 'f') return FileSystem::isFile(path.c_str()) ? 0 : 1;
            return FileSystem::isDirectory(path.c_str()) ? 0 : 1;
        }
    }
    print(ctx, "uso: [ a = b ] | [ 1 -lt 2 ] | [ -e|-f|-d arq ] | [ -z|-n str ]\r\n");
    return 2;
}

int cmdCd(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    std::string target = (argc > 1) ? resolvePath(argv[1]) : std::string("/");
    if (target != "/" && !CelerShell::pathAllowed(target)) {
        print(ctx, "cd: caminho invalido (use /local ou /sd)\r\n");
        return 1;
    }
    if (target != "/" && !FileSystem::isDirectory(target.c_str())) {
        print(ctx, "cd: %s nao e diretorio\r\n", target.c_str());
        return 1;
    }
    if (target.size() >= sizeof(s_cwd)) {
        print(ctx, "cd: caminho muito longo\r\n");
        return 1;
    }
    setCwd(target.c_str());
    return 0;
}

int cmdPwd(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv;
    print(ctx, "%s\r\n", getCwd().c_str());
    return 0;
}

int cmdTrue(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv; (void) print; (void) ctx;
    return 0;
}

int cmdFalse(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv; (void) print; (void) ctx;
    return 1;
}

// ANSI: limpa a tela e volta pro canto (no celerctl EXEC so emite os
// bytes, inofensivo)
int cmdClear(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv;
    print(ctx, "\x1b[2J\x1b[H");
    return 0;
}

int cmdDate(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    (void) argc; (void) argv;
    const time_t now = time(nullptr);
    if (!TimeManager::isTimeValid()) {
        print(ctx, "relogio nao sincronizado (aguardando NTP)\r\n");
    }
    struct tm tmv;
    if (localtime_r(&now, &tmv) == nullptr) return 1;
    char buf[40];
    strftime(buf, sizeof(buf), "%a %d %b %Y %H:%M:%S", &tmv);
    print(ctx, "%s (epoch %lld)\r\n", buf, (long long)now);
    return 0;
}

int cmdUname(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    const char* what = (argc > 1) ? argv[1] : "-s";
    if (strcmp(what, "-a") == 0) {
        print(ctx, "CelerOS %s %s " CELER_STR(CONFIG_IDF_TARGET) " SDK %s API %d\r\n",
              CELEROS_VERSION, boardName(), esp_get_idf_version(), (int)CELEROS_API_LEVEL);
    } else if (strcmp(what, "-r") == 0) {
        print(ctx, "%s\r\n", CELEROS_VERSION);
    } else if (strcmp(what, "-m") == 0) {
        print(ctx, CELER_STR(CONFIG_IDF_TARGET) "\r\n");
    } else if (strcmp(what, "-s") == 0) {
        print(ctx, "CelerOS\r\n");
    } else {
        print(ctx, "uso: uname [-a|-r|-m|-s]\r\n");
        return 1;
    }
    return 0;
}

// Cria o arquivo se nao existe ("ab": nao trunca um existente). Atualizar
// mtime exigiria utime(2), que o LittleFS so honra com timestamp ligado
// no build — deixa quieto.
int cmdTouch(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: touch <arquivo...>\r\n");
        return 1;
    }
    int rc = 0;
    for (int a = 1; a < argc; a++) {
        std::string path = resolvePath(argv[a]);
        if (!CelerShell::pathAllowed(path)) {
            print(ctx, "touch: caminho invalido (use /local ou /sd)\r\n");
            rc = 1;
            continue;
        }
        if (FileSystem::exists(path.c_str())) continue;
        FILE* f = fopen(path.c_str(), "ab");
        if (f == nullptr) {
            print(ctx, "touch: falhou em %s\r\n", path.c_str());
            rc = 1;
            continue;
        }
        fclose(f);
    }
    return rc;
}

int cmdRmdir(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: rmdir <diretorio>\r\n");
        return 1;
    }
    std::string path = resolvePath(argv[1]);
    if (!CelerShell::pathAllowed(path)) {
        print(ctx, "rmdir: caminho invalido (use /local ou /sd)\r\n");
        return 1;
    }
    if (!FileSystem::isDirectory(path.c_str())) {
        print(ctx, "rmdir: %s nao e diretorio\r\n", path.c_str());
        return 1;
    }
    if (!FileSystem::rmdir(path.c_str())) {
        print(ctx, "rmdir: %s nao vazio? (rm -r apaga a arvore)\r\n", path.c_str());
        return 1;
    }
    return 0;
}

int cmdCp(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    bool rec = false;
    int first = 1;
    if (argc > 1 && strcmp(argv[1], "-r") == 0) {
        rec = true;
        first = 2;
    }
    if (argc < first + 2) {
        print(ctx, "uso: cp [-r] <de> <para>\r\n");
        return 1;
    }
    std::string src = resolvePath(argv[first]);
    std::string dst = resolvePath(argv[first + 1]);
    if (!CelerShell::pathAllowed(src) || !CelerShell::pathAllowed(dst)) {
        print(ctx, "cp: caminho invalido (use /local ou /sd)\r\n");
        return 1;
    }
    if (!FileSystem::exists(src.c_str())) {
        print(ctx, "cp: %s nao existe\r\n", src.c_str());
        return 1;
    }
    // destino existindo como diretorio, copia PARA DENTRO (semantica unix)
    if (FileSystem::isDirectory(dst.c_str())) {
        dst += '/';
        dst += baseName(src.c_str());
    }
    makeParentDirs(dst);
    if (FileSystem::isDirectory(src.c_str())) {
        if (!rec) {
            print(ctx, "cp: %s e diretorio (use cp -r)\r\n", src.c_str());
            return 1;
        }
        if (!FileSystem::copyDirectory(src.c_str(), dst.c_str())) {
            print(ctx, "cp: falhou copiando %s -> %s\r\n", src.c_str(), dst.c_str());
            return 1;
        }
        return 0;
    }
    if (!FileSystem::copyFile(src.c_str(), dst.c_str())) {
        print(ctx, "cp: falhou copiando %s -> %s\r\n", src.c_str(), dst.c_str());
        return 1;
    }
    return 0;
}

// ------------------------------------------- leitores de N linhas (head/tail)

// Imprime as primeiras n linhas. Linha mais longa que o buffer sai em
// pedacos: a contagem sobe no '\n' que fecha a linha, os pedacos no meio
// nao contam duas vezes.
static int printHead(const std::string& path, long n, CelerShell::PrintFn print, void* ctx) {
    FILE* f = fopen(path.c_str(), "rb");
    if (f == nullptr) return -1;
    long shown = 0;
    char buf[256];
    while (shown < n && fgets(buf, sizeof(buf), f) != nullptr) {
        print(ctx, "%s", buf);
        for (char* p = buf; *p != '\0'; p++) {
            if (*p == '\n') shown++;
        }
    }
    fclose(f);
    return 0;
}

// Imprime as ultimas n linhas: shl::tailStart acha onde comecam (varredura
// de tras pra frente, sem carregar o arquivo na RAM) e dali em diante
// copia direto.
static int printTail(const std::string& path, long n, CelerShell::PrintFn print, void* ctx) {
    FILE* f = fopen(path.c_str(), "rb");
    if (f == nullptr) return -1;
    if (shl::tailStart(f, n) < 0) {
        fclose(f);
        return -1;
    }
    char out[256];
    size_t got;
    while ((got = fread(out, 1, sizeof(out), f)) > 0) {
        print(ctx, "%.*s", (int)got, out);
    }
    fclose(f);
    return 0;
}

static long parseLineOpt(int argc, char** argv, int* first) {
    long n = 10;
    *first = 1;
    if (argc > 2 && strcmp(argv[1], "-n") == 0) {
        n = atol(argv[2]);
        *first = 3;
    }
    if (n < 1) n = 1;
    if (n > 2000) n = 2000;
    return n;
}

int cmdHead(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    int first;
    const long n = parseLineOpt(argc, argv, &first);
    if (argc < first + 1) {
        print(ctx, "uso: head [-n N] <arquivo...>\r\n");
        return 1;
    }
    int rc = 0;
    for (int a = first; a < argc; a++) {
        std::string path = resolvePath(argv[a]);
        if (!CelerShell::pathAllowed(path)) {
            print(ctx, "head: caminho invalido (use /local ou /sd)\r\n");
            rc = 1;
            continue;
        }
        if (argc > first + 1) print(ctx, "==> %s <==\r\n", path.c_str());
        if (printHead(path, n, print, ctx) != 0) {
            print(ctx, "head: nao consegui abrir %s\r\n", path.c_str());
            rc = 1;
        }
    }
    return rc;
}

int cmdTail(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    int first;
    const long n = parseLineOpt(argc, argv, &first);
    if (argc < first + 1) {
        print(ctx, "uso: tail [-n N] <arquivo...>\r\n");
        return 1;
    }
    int rc = 0;
    for (int a = first; a < argc; a++) {
        std::string path = resolvePath(argv[a]);
        if (!CelerShell::pathAllowed(path)) {
            print(ctx, "tail: caminho invalido (use /local ou /sd)\r\n");
            rc = 1;
            continue;
        }
        if (argc > first + 1) print(ctx, "==> %s <==\r\n", path.c_str());
        if (printTail(path, n, print, ctx) != 0) {
            print(ctx, "tail: nao consegui abrir %s\r\n", path.c_str());
            rc = 1;
        }
    }
    return rc;
}

int cmdWc(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    bool wantL = false, wantW = false, wantC = false;
    int first = 1;
    for (; first < argc && argv[first][0] == '-' && argv[first][1] != '\0'; first++) {
        for (const char* p = argv[first] + 1; *p != '\0'; p++) {
            if (*p == 'l') wantL = true;
            else if (*p == 'w') wantW = true;
            else if (*p == 'c') wantC = true;
            else {
                print(ctx, "uso: wc [-l|-w|-c] <arquivo...>\r\n");
                return 1;
            }
        }
    }
    if (!wantL && !wantW && !wantC) wantL = wantW = wantC = true;
    if (argc < first + 1) {
        print(ctx, "uso: wc [-l|-w|-c] <arquivo...>\r\n");
        return 1;
    }
    int rc = 0;
    for (int a = first; a < argc; a++) {
        std::string path = resolvePath(argv[a]);
        if (!CelerShell::pathAllowed(path)) {
            print(ctx, "wc: caminho invalido (use /local ou /sd)\r\n");
            rc = 1;
            continue;
        }
        FILE* f = fopen(path.c_str(), "rb");
        if (f == nullptr) {
            print(ctx, "wc: nao consegui abrir %s\r\n", path.c_str());
            rc = 1;
            continue;
        }
        unsigned long lines = 0, words = 0, bytes = 0;
        bool inWord = false;
        char buf[512];
        size_t got;
        while ((got = fread(buf, 1, sizeof(buf), f)) > 0) {
            bytes += (unsigned long)got;
            for (size_t i = 0; i < got; i++) {
                const char c = buf[i];
                if (c == '\n') lines++;
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') inWord = false;
                else if (!inWord) {
                    inWord = true;
                    words++;
                }
            }
        }
        fclose(f);
        if (wantL) print(ctx, "%lu ", lines);
        if (wantW) print(ctx, "%lu ", words);
        if (wantC) print(ctx, "%lu ", bytes);
        print(ctx, "%s\r\n", path.c_str());
    }
    return rc;
}

// Substring simples (sem regex). Como o grep(1), cala quando nao acha
// nada e devolve 1 — util para encadear com ';'.
int cmdGrep(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    bool ci = false, showNum = false, invert = false;
    int first = 1;
    for (; first < argc && argv[first][0] == '-' && argv[first][1] != '\0'; first++) {
        for (const char* p = argv[first] + 1; *p != '\0'; p++) {
            if (*p == 'i') ci = true;
            else if (*p == 'n') showNum = true;
            else if (*p == 'v') invert = true;
            else {
                print(ctx, "uso: grep [-inv] <padrao> <arquivo...> (linhas >255B sao divididas)\r\n");
                return 1;
            }
        }
    }
    if (argc < first + 2) {
        print(ctx, "uso: grep [-inv] <padrao> <arquivo...>\r\n");
        return 1;
    }
    const char* pat = argv[first];
    const int nFiles = argc - first - 1;
    int matches = 0, rc = 0;
    for (int a = first + 1; a < argc; a++) {
        std::string path = resolvePath(argv[a]);
        if (!CelerShell::pathAllowed(path)) {
            print(ctx, "grep: caminho invalido (use /local ou /sd)\r\n");
            rc = 1;
            continue;
        }
        FILE* f = fopen(path.c_str(), "rb");
        if (f == nullptr) {
            print(ctx, "grep: nao consegui abrir %s\r\n", path.c_str());
            rc = 1;
            continue;
        }
        long lineno = 0;
        char line[256];
        while (fgets(line, sizeof(line), f) != nullptr) {
            lineno++;
            const bool has = ci ? shl::containsCI(line, pat) : (strstr(line, pat) != nullptr);
            if (has == invert) continue;
            matches++;
            if (nFiles > 1) print(ctx, "%s:", path.c_str());
            if (showNum) print(ctx, "%ld:", lineno);
            print(ctx, "%s", line);
        }
        fclose(f);
    }
    return (matches == 0) ? 1 : rc;
}

static void findWalk(const std::string& dir, int depth, WalkBudget* b, const char* namePat,
                     int typeFilter, CelerShell::PrintFn print, void* ctx) {
    if (depth > 8) return;
    DIR* d = opendir(dir.c_str());
    if (d == nullptr) return;
    struct dirent* ent;
    while ((ent = readdir(d)) != nullptr) {
        if (b->left-- <= 0) {
            b->clipped = true;
            break;
        }
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        std::string full = dir + ((dir == "/") ? "" : "/") + ent->d_name;
        bool isDir = ent->d_type == DT_DIR;
        if (ent->d_type == DT_UNKNOWN) {
            struct stat st;
            isDir = (stat(full.c_str(), &st) == 0 && S_ISDIR(st.st_mode));
        }
        if (!CelerShell::pathAllowed(full)) continue;  // raiz pode listar fora da jail
        const bool nameOk = (namePat == nullptr) || shl::wildMatch(namePat, ent->d_name);
        const bool typeOk = (typeFilter == 0) || (typeFilter == 1 ? !isDir : isDir);
        if (nameOk && typeOk) print(ctx, "%s\r\n", full.c_str());
        if (isDir) findWalk(full, depth + 1, b, namePat, typeFilter, print, ctx);
    }
    closedir(d);
}

int cmdFind(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    const char* namePat = nullptr;
    int typeFilter = 0;
    int i = 1;
    std::string root = getCwd();
    if (argc > 1 && argv[1][0] != '-') {
        root = resolvePath(argv[1]);
        i = 2;
    }
    for (; i < argc; i++) {
        if (strcmp(argv[i], "-name") == 0 && i + 1 < argc) {
            namePat = argv[++i];
        } else if (strcmp(argv[i], "-type") == 0 && i + 1 < argc) {
            const char t = argv[++i][0];
            typeFilter = (t == 'f') ? 1 : (t == 'd') ? 2 : 0;
        } else {
            print(ctx, "uso: find [dir] [-name padrao] [-type f|d]\r\n");
            return 1;
        }
    }
    if (root != "/" && !CelerShell::pathAllowed(root)) {
        print(ctx, "find: caminho invalido (use /local ou /sd)\r\n");
        return 1;
    }
    if (root != "/" && !FileSystem::isDirectory(root.c_str())) {
        print(ctx, "find: %s nao e diretorio\r\n", root.c_str());
        return 1;
    }
    WalkBudget b;
    findWalk(root, 0, &b, namePat, typeFilter, print, ctx);
    if (b.clipped) print(ctx, "find: varredura truncada (muitas entradas)\r\n");
    return 0;
}

static uint64_t treeSize(const std::string& dir, int depth, WalkBudget* b) {
    if (depth > 8) return 0;
    DIR* d = opendir(dir.c_str());
    if (d == nullptr) return 0;
    uint64_t total = 0;
    struct dirent* ent;
    while ((ent = readdir(d)) != nullptr) {
        if (b->left-- <= 0) {
            b->clipped = true;
            break;
        }
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        std::string full = dir + ((dir == "/") ? "" : "/") + ent->d_name;
        struct stat st;
        if (stat(full.c_str(), &st) != 0) continue;
        if (!CelerShell::pathAllowed(full)) continue;
        if (S_ISDIR(st.st_mode)) total += treeSize(full, depth + 1, b);
        else total += (uint64_t)st.st_size;
    }
    closedir(d);
    return total;
}

int cmdDu(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    std::string target = (argc > 1) ? resolvePath(argv[1]) : getCwd();
    if (target != "/" && !CelerShell::pathAllowed(target)) {
        print(ctx, "du: caminho invalido (use /local ou /sd)\r\n");
        return 1;
    }
    struct stat st;
    if (target != "/" && stat(target.c_str(), &st) != 0) {
        print(ctx, "du: %s nao existe\r\n", target.c_str());
        return 1;
    }
    if (target != "/" && !S_ISDIR(st.st_mode)) {
        print(ctx, "%10s  %s\r\n", humanSize((uint64_t)st.st_size).c_str(), target.c_str());
        return 0;
    }
    WalkBudget b;
    uint64_t total = 0;
    DIR* d = opendir(target.c_str());
    if (d == nullptr) {
        print(ctx, "du: nao consegui abrir %s\r\n", target.c_str());
        return 1;
    }
    struct dirent* ent;
    while ((ent = readdir(d)) != nullptr) {
        if (b.left-- <= 0) {
            b.clipped = true;
            break;
        }
        if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
        std::string full = target + ((target == "/") ? "" : "/") + ent->d_name;
        if (!CelerShell::pathAllowed(full)) continue;
        struct stat est;
        if (stat(full.c_str(), &est) != 0) continue;
        const uint64_t sz = S_ISDIR(est.st_mode) ? treeSize(full, 1, &b) : (uint64_t)est.st_size;
        total += sz;
        print(ctx, "%10s  %s\r\n", humanSize(sz).c_str(), full.c_str());
    }
    closedir(d);
    print(ctx, "%10s  total%s\r\n", humanSize(total).c_str(), b.clipped ? " (varredura truncada)" : "");
    return 0;
}

// Dump hexadecimal no formato do xxd(1) (offset, hex, ASCII). Teto no
// numero de bytes: saida grande demais estoura o buffer do EXEC (32KB)
// e nao serve pra nada no terminal serial.
int cmdXxd(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: xxd <arquivo> [bytes] (default 1024, max 8192)\r\n");
        return 1;
    }
    std::string path = resolvePath(argv[1]);
    if (!CelerShell::pathAllowed(path)) {
        print(ctx, "xxd: caminho invalido (use /local ou /sd)\r\n");
        return 1;
    }
    FILE* f = fopen(path.c_str(), "rb");
    if (f == nullptr) {
        print(ctx, "xxd: nao consegui abrir %s\r\n", path.c_str());
        return 1;
    }
    fseek(f, 0, SEEK_END);
    const long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    long limit = (argc > 2) ? atol(argv[2]) : 1024;
    if (limit < 16) limit = 16;
    if (limit > 8192) limit = 8192;
    if (limit > size) limit = size;
    long off = 0;
    uint8_t buf[16];
    char row[96];
    while (off < limit) {
        const size_t n = fread(buf, 1, sizeof(buf), f);
        if (n == 0) break;
        int p = snprintf(row, sizeof(row), "%08lx: ", (unsigned long)off);
        for (size_t i = 0; i < n; i++) p += snprintf(row + p, sizeof(row) - p, "%02x ", buf[i]);
        for (size_t i = n; i < sizeof(buf); i++) p += snprintf(row + p, sizeof(row) - p, "   ");
        p += snprintf(row + p, sizeof(row) - p, " ");
        for (size_t i = 0; i < n; i++) {
            row[p++] = (buf[i] >= 0x20 && buf[i] < 0x7F) ? (char)buf[i] : '.';
        }
        row[p] = '\0';
        print(ctx, "%s\r\n", row);
        off += (long)n;
    }
    fclose(f);
    if (size > limit) {
        print(ctx, "(%ld de %ld bytes; xxd %s N para mais)\r\n", limit, size, argv[1]);
    }
    return 0;
}

// Par de bancada do `push --verify` do celerctl: o MD5 do que o FS serve
// AGORA, calculado na ROM do chip (mesmo caminho do System.getFileMD5).
int cmdMd5Sum(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: md5sum <arquivo...>\r\n");
        return 1;
    }
    int rc = 0;
    for (int a = 1; a < argc; a++) {
        std::string path = resolvePath(argv[a]);
        if (!CelerShell::pathAllowed(path)) {
            print(ctx, "md5sum: caminho invalido (use /local ou /sd)\r\n");
            rc = 1;
            continue;
        }
        std::string md = FileSystem::getFileMD5(path.c_str());
        if (md.empty()) {
            print(ctx, "md5sum: nao consegui ler %s\r\n", path.c_str());
            rc = 1;
            continue;
        }
        print(ctx, "%s  %s\r\n", md.c_str(), path.c_str());
    }
    return rc;
}

// Espelho do dmesg do app Terminal: tail do log persistente do kernel.
// LogPersist grava na casa do SD quando montado (/sd/log/kern.log) e cai
// para /local/log/kern.log na littlefs — o mesmo recorte que o `crash` usa
// para o apps.log.
int cmdDmesg(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    long n = (argc > 1) ? atol(argv[1]) : 30;
    if (n < 1) n = 1;
    if (n > 200) n = 200;
    // casa do SD primeiro (LogPersist); sem log la, tenta a littlefs —
    // kern.log de boot anterior sem cartao continua legivel
    std::string path = FileSystem::sdMounted() ? std::string("/sd/log/kern.log")
                                               : std::string("/local/log/kern.log");
    struct stat st;
    if ((stat(path.c_str(), &st) != 0 || st.st_size == 0) && FileSystem::sdMounted()) {
        path = "/local/log/kern.log";
    }
    if (stat(path.c_str(), &st) != 0 || st.st_size == 0) {
        print(ctx, "sem %s neste build/firmware\r\n", path.c_str());
        return 1;
    }
    if (printTail(path, n, print, ctx) != 0) {
        print(ctx, "dmesg: nao consegui abrir %s\r\n", path.c_str());
        return 1;
    }
    print(ctx, "\r\n");
    return 0;
}

// ------------------------------------------------------------------ sh reduzido

// Profundidade de scripts abertos (sh chamando sh): sem a guarda, um
// script que se chama entra em loop e derruba a stack. int comum — duas
// tasks aninhando ao mesmo tempo so gastam stack, nada corrompe.
static int s_shDepth = 0;

// Linha de script: saida visivel no canal que chamou o sh.
struct ShellRun {
    CelerShell::PrintFn print;
    void* ctx;
};

static int shellLineExec(void* vctx, const char* line) {
    ShellRun* r = (ShellRun*)vctx;
    return CelerShell::execute(line, r->print, r->ctx);
}

// Condicao de if/while: roda calada (devNullPrint) — o codigo decide.
static int shellCondExec(void* vctx, const char* line) {
    (void) vctx;
    return CelerShell::execute(line, devNullPrint, nullptr);
}

// sh [-e] [-x] <arquivo>: script reduzido, uma linha = um comando.
// Blocos if/else/end, while/end, break/continue, variaveis $VAR/${VAR}/$?
// e condicao silenciosa (0 = verdadeiro) — o interpretador inteiro vive
// no Utils/ShellLogic.h (shl::runScript, testado no host); aqui ficam so
// a politica de device: jail do caminho, guarda de aninhamento e para
// onde vai a saida. -e para no 1o erro, -x ecoa a linha antes de rodar.
int cmdSh(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    bool stopErr = false, trace = false;
    int first = 1;
    for (; first < argc && argv[first][0] == '-' && argv[first][1] != '\0'; first++) {
        for (const char* p = argv[first] + 1; *p != '\0'; p++) {
            if (*p == 'e') stopErr = true;
            else if (*p == 'x') trace = true;
            else {
                print(ctx, "uso: sh [-e] [-x] <arquivo>\r\n");
                return 1;
            }
        }
    }
    if (argc < first + 1) {
        print(ctx, "uso: sh [-e] [-x] <arquivo>\r\n");
        return 1;
    }
    std::string path = resolvePath(argv[first]);
    if (!CelerShell::pathAllowed(path)) {
        print(ctx, "sh: caminho invalido (use /local ou /sd)\r\n");
        return 1;
    }
    if (s_shDepth >= 3) {
        print(ctx, "sh: aninhamento maximo (3) de scripts\r\n");
        return 1;
    }
    FILE* f = fopen(path.c_str(), "rb");
    if (f == nullptr) {
        print(ctx, "sh: nao consegui abrir %s\r\n", path.c_str());
        return 1;
    }
    s_shDepth++;
    ShellRun run = {print, ctx};
    shl::ScriptOpts opts;
    opts.stopErr = stopErr;
    opts.trace = trace;
    const int rc = shl::runScript(f, opts, shellLineExec, shellCondExec, &run, print, ctx);
    fclose(f);
    s_shDepth--;
    return rc;
}

#if CONFIG_CELEROS_BLUETOOTH
// mesh: estado da malha CelerNet (rede, papel, contadores) e nos ouvidos
//   mesh join <nome> <senha>  entra (ou cria) a matilha privada
//   mesh leave                volta para a "celer" aberta
//   mesh selftest             vetores dos RFCs (CCM/HKDF/PBKDF2) + quadro v3
//   mesh accept [off]         abre a janela de convite (aparelho novo, 10 min)
//   mesh invite <alvo>        membro conecta no novo pelo CelerLink
//   mesh code <6 digitos>     membro digita o codigo e manda a chave selada
//   mesh replay               reinjeta o ultimo quadro ouvido (RPL descarta)
int cmdMesh(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc >= 2 && strcmp(argv[1], "selftest") == 0) {
        const bool ok = NetKeys::selftest(print, ctx);
        print(ctx, "selftest: %s\r\n", ok ? "ok" : "FALHOU");
        return ok ? 0 : 1;
    }
    if (argc >= 2 && strcmp(argv[1], "replay") == 0) {
        CelerNet::Info a, b;
        CelerNet::info(&a);
        if (!CelerNet::replayLast()) {
            print(ctx, "nada para reinjetar (malha desligada ou nada ouvido)\r\n");
            return 1;
        }
        vTaskDelay(pdMS_TO_TICKS(300));  // o tick drena a fila crua
        CelerNet::info(&b);
        const bool ok = b.rxReplay > a.rxReplay;
        print(ctx, "replay: %s (repetidos %u -> %u)\r\n", ok ? "descartado pelo RPL" : "NAO descartado",
              (unsigned)a.rxReplay, (unsigned)b.rxReplay);
        return ok ? 0 : 1;
    }
    // convite sem tela (API 41): o novo abre a janela e mostra o codigo aqui;
    // o membro conecta (invite) e digita (code) — os 2 passos da UI
    if (argc >= 2 && strcmp(argv[1], "accept") == 0) {
        const bool on = !(argc >= 3 && strcmp(argv[2], "off") == 0);
        if (!Provision::acceptInvite(on)) {
            print(ctx, "falhou (Bluetooth indisponivel?)\r\n");
            return 1;
        }
        print(ctx, on ? "janela de convite aberta (10 min); o codigo aparece em \"mesh\" quando o membro conectar\r\n"
                      : "janela de convite fechada\r\n");
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "invite") == 0) {
        bool done = false;
        const bool ok = Provision::inviteConnect(argv[2], &done);
        if (ok && done) {
            print(ctx, "convite: %s ja era pareado (bond) e entrou na matilha\r\n", argv[2]);
            return 0;
        }
        print(ctx, ok ? "conectado a %s: leia o codigo no novo e rode \"mesh code <6 digitos>\"\r\n"
                      : "nao conectou em %s (janela aberta la? matilha privada aqui?)\r\n", argv[2]);
        return ok ? 0 : 1;
    }
    if (argc >= 3 && strcmp(argv[1], "code") == 0) {
        const bool ok = Provision::inviteCode(argv[2]);
        print(ctx, "convite: %s\r\n", ok ? "o novo entrou na matilha" : "falhou (codigo errado ou sem resposta)");
        return ok ? 0 : 1;
    }
    if (argc >= 2 && (strcmp(argv[1], "join") == 0 || strcmp(argv[1], "leave") == 0)) {
        const bool join = argv[1][0] == 'j';
        if (join && (argc < 4 || strlen(argv[2]) == 0 || strlen(argv[2]) > 15 || strlen(argv[3]) < 8)) {
            print(ctx, "uso: mesh join <nome 1..15> <senha >= 8>\r\n");
            return 1;
        }
        // a mesma porta do Pack.join e do cabo (Provision): chave + netChanged
        bool ok = true;
        if (join) {
            ok = Provision::joinPassword(argv[2], argv[3]);
        } else {
            Provision::leave();
        }
        if (!ok) {
            print(ctx, "falhou (PSA/NVS)\r\n");
            return 1;
        }
        const NetKeys::Net* n = NetKeys::primary();
        print(ctx, "rede \"%s\" nid %02X (%s)\r\n", n->name, n->nid, n->open ? "aberta" : "privada");
        return 0;
    }
    // convite em curso (API 41): o codigo aparece aqui num aparelho sem tela
    const Provision::State pst = Provision::state();
    if (pst != Provision::IDLE) {
        char code[7];
        Provision::pendingCode(code);
        print(ctx, "convite: %s%s%s\r\n", Provision::stateName(pst), code[0] ? "  codigo " : "", code);
    }
    CelerNet::Info st;
    CelerNet::info(&st);
    if (!st.active) {
        print(ctx, "malha desligada (setting celernet=%s)\r\n", CelerNet::enabledSetting() ? "1" : "0");
        return 0;
    }
    print(ctx, "malha: \"%s\" (%04X) rede \"%s\" nid %02X %s %s\r\n", st.name, st.node, st.net, st.nid,
          st.secure ? "privada" : "aberta", st.relay ? "repetidor" : "so escuta");
    print(ctx, "  rx sem chave %u  repetidos %u  rede secundaria %u\r\n", (unsigned)st.rxAuthFail,
          (unsigned)st.rxReplay, (unsigned)st.rxOther);
    print(ctx, "  tx no ar %u  falha %u  sem ficha %u  fila %u  recusados %u | relay %u (perdidos %u)  rx perdidos %u\r\n",
          (unsigned)st.txStarted, (unsigned)st.txFail, (unsigned)st.txNoToken, (unsigned)st.txQueued,
          (unsigned)st.txDropped, (unsigned)st.relayed, (unsigned)st.relayDropped, (unsigned)st.rxDropped);
    CelerNet::Node nodes[CelerNet::NODES_MAX];
    const int n = CelerNet::nodes(nodes, CelerNet::NODES_MAX);
    print(ctx, "nos ouvidos: %d\r\n", n);
    for (int i = 0; i < n; i++) {
        print(ctx, "  %04X %-15s caps 0x%02X%s  rssi %d  saltos %u  ha %u s\r\n", nodes[i].id, nodes[i].name,
              nodes[i].caps,
              (nodes[i].flags & netframe::BFLAG_PROXY)    ? " pc-no-cabo"
              : (nodes[i].flags & netframe::BFLAG_UNPROV) ? " nao-configurado"
                                                           : "",
              nodes[i].rssi, nodes[i].hops, (unsigned)(nodes[i].lastSeenMs / 1000));
    }
    return 0;
}

// res: recursos da matilha (ESP-NOW, locais, leases, handles, cache) +
// "res acl ..." (API 47): a lista do dono de quem pode abrir cada recurso
int cmdRes(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc >= 2 && strcmp(argv[1], "acl") == 0) {
        return Resources::aclCmd(argc - 2, argv + 2, print, ctx);
    }
    Resources::dump(print, ctx);
    return 0;
}
#endif

// cfg — settings persistentes do aparelho (NVS ns "settings", CelerSettings):
// o interruptor do dono dos recursos da matilha (res_share_gpio/mic/cam/spk/
// sens), o nome do no (celernet_name) e afins — sem app e sem UI. `cfg chave`
// le; `cfg chave valor` grava (valor vazio apaga). Teto de chave do NVS: 15
// chars — e por isso res_share_sens e nao res_share_sensor.
int cmdCfg(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: cfg <chave> [valor]  (chave ate 15 chars)\r\n");
        return 1;
    }
    if (strlen(argv[1]) > 15) {
        print(ctx, "cfg: chave acima de 15 chars (teto do NVS)\r\n");
        return 1;
    }
    if (argc >= 3) {
        std::string v = argv[2];
        for (int i = 3; i < argc; i++) v += std::string(" ") + argv[i];
        if (!CelerSettings::set(argv[1], v.c_str())) {
            print(ctx, "cfg: falhou ao gravar\r\n");
            return 1;
        }
    }
    print(ctx, "%s=%s\r\n", argv[1], CelerSettings::get(argv[1], "").c_str());
    return 0;
}

struct ShellCmd {
    const char* name;
    int (*fn)(int argc, char** argv, CelerShell::PrintFn print, void* ctx);
};

#if CONFIG_CELEROS_USB_HOST
// Diagnostico do USB Host (API 48): o pendrive nao enumera? "usb" mostra o
// root port e o registry; "usb power" faz power-cycle; "usb resume" tira o
// root port da suspensao.
int cmdUsb(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    const char* sub = argc > 1 ? argv[1] : "status";
    if (strcmp(sub, "power") == 0) {
        usb_host_lib_set_root_port_power(false);
        vTaskDelay(pdMS_TO_TICKS(300));
        esp_err_t e = usb_host_lib_set_root_port_power(true);
        print(ctx, "usb: power-cycle rc=%d\r\n", (int)e);
        return 0;
    }
    if (strcmp(sub, "resume") == 0) {
        esp_err_t e = usb_host_lib_root_port_resume();
        print(ctx, "usb: resume rc=%d\r\n", (int)e);
        return 0;
    }
    usb_host_lib_info_t info = {};
    esp_err_t e = usb_host_lib_info(&info);
    if (e == ESP_OK) {
        print(ctx, "usb: host=%d devices=%d clients=%d suspended=%d\r\n",
              (int)UsbHost::available(), info.num_devices, info.num_clients,
              (int)info.root_port_suspended);
    } else {
        print(ctx, "usb: lib ausente (rc=%d)\r\n", (int)e);
    }
    const int n = UsbHost::deviceCount();
    print(ctx, "usb: registry %d device(s)\r\n", n);
    for (int i = 0; i < n; i++) {
        UsbHost::DeviceInfo d;
        if (!UsbHost::deviceAt(i, d)) continue;
        print(ctx, "  addr %u  vid %04x pid %04x  class %u  ifs %u  claimed %u\r\n",
              d.addr, d.vid, d.pid, d.cls, d.desc.nIfs, d.nClaims);
    }
    return 0;
}
#endif

const ShellCmd kCommands[] = {
    {"help", cmdHelp},   {"ls", cmdLs},     {"cat", cmdCat},       {"rm", cmdRm},
    {"mv", cmdMv},       {"mkdir", cmdMkdir}, {"df", cmdDf},      {"free", cmdFree},
    {"sd", cmdSd},
    {"ps", cmdPs},       {"uptime", cmdUptime}, {"info", cmdInfo}, {"reboot", cmdReboot},
    {"top", cmdTop},
#if CONFIG_IDF_TARGET_ESP32S3
    {"lcddma", cmdLcdDma},
#endif
    {"rescan", cmdRescan}, {"apps", cmdApps}, {"stat", cmdStat},
    {"installzip", cmdInstallZip}, {"svc", cmdSvc},
    {"run", cmdRun}, {"exit", cmdExit},
    {"grant", cmdGrant},
    {"lasterror", cmdLastError},
    {"crash", cmdCrash},
    {"debug", cmdDebug},
    {"wifi", cmdWifi},
#if CONFIG_CELEROS_DEBUG_BRIDGE
    {"bridge", cmdBridge},
#endif
#if CONFIG_CELEROS_USB_HOST
    {"usb", cmdUsb},
#endif
#if CONFIG_CELEROS_PHONE_LINK
    {"gb", cmdGb},
#endif
#if CONFIG_CELEROS_BLUETOOTH
    {"mesh", cmdMesh},  {"res", cmdRes},
#endif
    {"colorbars", cmdColorBars},
    // unix basicos (mesma tabela: valem no console CDC/UART e no EXEC)
    {"echo", cmdEcho},     {"cd", cmdCd},         {"pwd", cmdPwd},
    {"cp", cmdCp},         {"touch", cmdTouch},   {"rmdir", cmdRmdir},
    {"head", cmdHead},     {"tail", cmdTail},     {"wc", cmdWc},
    {"grep", cmdGrep},     {"find", cmdFind},     {"du", cmdDu},
    {"xxd", cmdXxd},       {"hexdump", cmdXxd},   {"md5sum", cmdMd5Sum},
    {"date", cmdDate},     {"clear", cmdClear},   {"uname", cmdUname},
    {"dmesg", cmdDmesg},   {"true", cmdTrue},     {"false", cmdFalse},
    {"sh", cmdSh},         {"set", cmdSet},       {"unset", cmdUnset},
    {"cfg", cmdCfg},
    {"[", cmdTest},        {"test", cmdTest},
};

}  // namespace

// Raizes do modo restrito (install.sh): nullptr = livre
static char s_rRootA[96] = {0};
static char s_rRootB[96] = {0};

// Reinicio armado por "reboot"/"sd format" (ver CelerShell.h): o comando
// arma em vez de chamar esp_restart dentro do execute() — o KL_EXEC do
// HostLink precisa responder ANTES de o aparelho cair (o celerctl pendurava
// ate o timeout: DEFERRED antigo "EXEC reboot nunca responde").
static volatile bool s_restartArmed = false;

void CelerShell::requestRestart() { s_restartArmed = true; }

void CelerShell::pumpRestart() {
    if (!s_restartArmed) return;
    vTaskDelay(pdMS_TO_TICKS(20));  // ultimo print drena no canal
    esp_restart();
}

void CelerShell::setRestrictedRoots(const char* a, const char* b) {
    if (a != nullptr) {
        strncpy(s_rRootA, a, sizeof(s_rRootA) - 1);
        s_rRootA[sizeof(s_rRootA) - 1] = 0;
    } else {
        s_rRootA[0] = 0;
    }
    if (b != nullptr) {
        strncpy(s_rRootB, b, sizeof(s_rRootB) - 1);
        s_rRootB[sizeof(s_rRootB) - 1] = 0;
    } else {
        s_rRootB[0] = 0;
    }
}

bool CelerShell::pathAllowed(const std::string& path) {
    // Modo restrito: o script de instalacao so toca a PROPRIA pasta (le o
    // pacote) e o proprio /local/data/<pkg> (dados do app)
    if (s_rRootA[0] != 0) {
        auto under = [&path](const char* root) {
            size_t n = strlen(root);
            return path.compare(0, n, root) == 0 && (path.size() == n || path[n] == '/');
        };
        return under(s_rRootA) || (s_rRootB[0] != 0 && under(s_rRootB));
    }
    // Segmento inteiro (mesma correcao do WebManager::pathAllowed): o
    // prefixo cru aceitava "/localfoo"/"/sdcard" e o caminho ia direto
    // ao fopen/stat/remove dos comandos
    auto under = [&path](const char* mount) {
        size_t n = strlen(mount);
        return path.compare(0, n, mount) == 0 && (path.size() == n || path[n] == '/');
    };
    return under("/local") || under("/sd");
}

bool LineEditor::feed(uint8_t byte, char* line, size_t maxLen) {
    if (byte == '\r' || byte == '\n') {
        size_t n = (m_len < maxLen - 1) ? m_len : maxLen - 1;
        memcpy(line, m_buf, n);
        line[n] = '\0';
        m_len = 0;
        return true;
    }
    if (byte == 0x08 || byte == 0x7F) {  // backspace
        if (m_len > 0) {
            m_len--;
            m_echo(m_ctx, "\b \b");
        }
    } else if (byte >= 0x20 && byte < 0x7F && m_len < sizeof(m_buf) - 1) {
        m_buf[m_len++] = (char)byte;
        char echo = (char)byte;
        m_echo(m_ctx, "%c", echo);
    }
    return false;
}

// Saida de comando redirecionada para arquivo (cmd > arq / cmd >> arq):
// formata no stack, tira o '\r' dos "\r\n" (o arquivo fica Unix, sem ^M
// no cat de volta) e grava. Sem alocacao — roda na task do canal.
static void filePrint(void* vctx, const char* fmt, ...) {
    FILE* f = (FILE*)vctx;
    va_list ap;
    va_start(ap, fmt);
    char buf[512];
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n <= 0) return;
    if (n > (int)sizeof(buf) - 1) n = (int)sizeof(buf) - 1;
    int j = 0;
    for (int i = 0; i < n; i++) {
        if (buf[i] != '\r') buf[j++] = buf[i];
    }
    fwrite(buf, 1, (size_t)j, f);
}

// Um comando (sem o encadeamento): tokeniza, trata o redirecionamento e
// despacha na tabela.
static int runSegment(char* seg, CelerShell::PrintFn print, void* ctx) {
    char* argv[16];
    int argc = 0;
    char* save = nullptr;
    for (char* tok = strtok_r(seg, " \t", &save); tok != nullptr && argc < 16;
         tok = strtok_r(nullptr, " \t", &save)) {
        argv[argc++] = tok;
    }
    if (argc == 0) return 0;

    // palavras de bloco nao existem fora de script — a dica evita o
    // "comando nao encontrado" seco no console
    static const char* const kBlockWords[] = {"if", "while", "else", "end", "break", "continue"};
    for (const char* w : kBlockWords) {
        if (strcmp(argv[0], w) == 0) {
            print(ctx, "%s: palavra de bloco — so dentro de script (sh <arquivo>)\r\n", w);
            return 1;
        }
    }

    // Modo restrito (install.sh de app, API 42): o script roda com os
    // poderes do shell (root de FS) — a allowlist impede reboot/wifi/
    // grant/mesh/ota de um pacote publicado por terceiro.
    if (s_rRootA[0] != 0) {
        static const char* const kAllowed[] = {
            "ls", "cat", "rm", "rmdir", "mkdir", "mv", "cp", "echo", "set",
            "test", "sh", "head", "tail", "grep", "find", "stat", "df",
            "true", "false", "cd", "pwd", "date", "rescan",
        };
        bool okCmd = false;
        for (const char* w : kAllowed) {
            if (strcmp(argv[0], w) == 0) { okCmd = true; break; }
        }
        if (!okCmd) {
            print(ctx, "%s: comando indisponivel no install.sh (restrito)\r\n", argv[0]);
            taskENTER_CRITICAL(&s_varMux);
            s_lastRc = 126;
            taskEXIT_CRITICAL(&s_varMux);
            return 1;
        }
    }

    // "cmd ... > arq" trunca, ">>" anexa: token isolado, alvo no token
    // seguinte (sem aspas no shell, '>' colado num argumento e literal —
    // mesmo papel do sh sem aspas)
    int redirAt = -1;
    bool append = false;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], ">") == 0) {
            redirAt = i;
            break;
        }
        if (strcmp(argv[i], ">>") == 0) {
            redirAt = i;
            append = true;
            break;
        }
    }
    FILE* redir = nullptr;
    CelerShell::PrintFn out = print;
    void* outCtx = ctx;
    if (redirAt >= 0) {
        if (redirAt + 1 >= argc) {
            print(ctx, "uso: <comando> > <arquivo> (ou >> para anexar)\r\n");
            return 1;
        }
        std::string target = resolvePath(argv[redirAt + 1]);
        if (!CelerShell::pathAllowed(target)) {
            print(ctx, "%s: caminho invalido (use /local ou /sd)\r\n", argv[0]);
            return 1;
        }
        makeParentDirs(target);
        redir = fopen(target.c_str(), append ? "a" : "w");
        if (redir == nullptr) {
            print(ctx, "%s: nao consegui abrir %s para escrita\r\n", argv[0], target.c_str());
            return 1;
        }
        argc = redirAt;  // o comando nao ve o redirecionamento nem o alvo
        out = filePrint;
        outCtx = redir;
    }

    int code = -1;
    for (const ShellCmd& c : kCommands) {
        if (strcmp(argv[0], c.name) == 0) {
            code = c.fn(argc, argv, out, outCtx);
            break;
        }
    }
    if (code < 0) {
        print(ctx, "%s: comando nao encontrado (help para lista)\r\n", argv[0]);
    }
    taskENTER_CRITICAL(&s_varMux);
    s_lastRc = (code >= 0) ? code : 127;  // $?: 127 = nao encontrado, como no sh
    taskEXIT_CRITICAL(&s_varMux);
    if (redir != nullptr) fclose(redir);
    return code;
}

int CelerShell::execute(const char* line, PrintFn print, void* ctx) {
    // expande $VAR/${VAR}/$? ANTES de tokenizar: sem aspas no shell, o
    // dollar vale em qualquer posicao. 2x MAX_LINE da folga para a
    // expansao (valores sao curtos, teto de 63 chars cada)
    char buf[MAX_LINE * 2];
    taskENTER_CRITICAL(&s_varMux);
    const int lastRc = s_lastRc;
    taskEXIT_CRITICAL(&s_varMux);
    shl::expandVars(line, buf, sizeof(buf), shellVarLookup, nullptr, lastRc);

    // ';' encadeia comandos (a saida do anterior NAO alimenta o proximo —
    // nao ha pipes); o codigo devolvido e o do ultimo
    int rc = 0;
    char* save = nullptr;
    for (char* seg = strtok_r(buf, ";", &save); seg != nullptr;
         seg = strtok_r(nullptr, ";", &save)) {
        rc = runSegment(seg, print, ctx);
    }
    return rc;
}
