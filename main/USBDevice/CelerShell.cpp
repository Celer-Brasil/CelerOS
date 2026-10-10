#include "CelerShell.h"
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
#include "WebManager/WebManager.h"
#include "CommonErrorCodes.h"
#include "Utils/AppGrants.h"
#include "Utils/AppPerms.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
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

#if !defined(CELEROS_VERSION)
#define CELEROS_VERSION "?"
#endif
#if !defined(CELEROS_API_LEVEL)
#define CELEROS_API_LEVEL 0
#endif

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

// ------------------------------------------------------------------ comandos

int cmdHelp(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    print(ctx,
        "CelerOS shell " CELEROS_VERSION "\n"
        "comandos:\n"
        "  help            esta ajuda\n"
        "  ls [dir]        lista diretorio (default /)\n"
        "  cat <arq>       mostra conteudo\n"
        "  rm <arq>        apaga arquivo\n"
        "  mv <de> <para>  renomeia/move\n"
        "  mkdir <dir>     cria diretorio\n"
        "  df              espaco em /local e /sd\n"
        "  free            heap livre\n"
        "  ps              tarefas FreeRTOS\n"
        "  top [ms]        profiling: CPU%% por task + heap/app (janela ms)\n"
#if CONFIG_IDF_TARGET_ESP32S3
        "  lcddma [ms]     saude do DMA do painel RGB (underflow = imagem embaralha)\n"
#endif
        "  uptime          tempo ligado\n"
        "  info            versao/board/rede\n"
        "  reboot          reinicia o sistema\n"
        "  rescan          reler lista de apps do launcher\n"
        "  apps            lista apps com origem (local/sd) e caminho\n"
        "  run <app>       abre um app (pasta, nome ou pacote)\n"
        "  stat <arq>      tamanho + crc32 + mtime do arquivo\n"
        "  grant <app>     concede as permissoes declaradas (consentimento headless)\n"
        "  lasterror       ultimo erro de app gravado (/local/lastcrash.txt)\n"
        "  debug on|off    arma o debugger Duktape (a sessao e do celerctl debug)\n"
        "  exit            encerra o app em execucao\n"
        "  wifi            lista as redes WiFi salvas\n"
        "  wifi <ssid> <senha> salva a rede no NVS e conecta (ssid sem espacos)\n"
        "  wifi off|on     desliga (persistente) / religa o WiFi\n"
#if CONFIG_CELEROS_PHONE_LINK
        "  gb <linha>      injeta linha do Gadgetbridge (teste do protocolo)\n"
#endif
        );
    return 0;
}

int cmdLs(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    std::string dir = (argc > 1) ? argv[1] : "/";
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
        print(ctx, "uso: cat <arquivo>\n");
        return 1;
    }
    std::string path = argv[1];
    if (!CelerShell::pathAllowed(path)) {
        print(ctx, "cat: caminho invalido (use /local ou /sd)\n");
        return 1;
    }
    FILE* f = fopen(path.c_str(), "rb");
    if (f == nullptr) {
        print(ctx, "cat: nao consegui abrir %s\n", path.c_str());
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

int cmdRm(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 2) {
        print(ctx, "uso: rm <arquivo|diretorio vazio>\n");
        return 1;
    }
    if (!CelerShell::pathAllowed(argv[1])) {
        print(ctx, "rm: caminho invalido (use /local ou /sd)\n");
        return 1;
    }
    if (!FileSystem::deleteFile(argv[1]) &&
        !(FileSystem::isDirectory(argv[1]) && FileSystem::rmdir(argv[1]))) {
        print(ctx, "rm: falhou em %s\n", argv[1]);
        return 1;
    }
    return 0;
}

int cmdMv(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    if (argc < 3) {
        print(ctx, "uso: mv <de> <para>\n");
        return 1;
    }
    if (!CelerShell::pathAllowed(argv[1]) || !CelerShell::pathAllowed(argv[2])) {
        print(ctx, "mv: caminho invalido (use /local ou /sd)\n");
        return 1;
    }
    if (!FileSystem::renameFile(argv[1], argv[2])) {
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
    if (!CelerShell::pathAllowed(argv[1])) {
        print(ctx, "mkdir: caminho invalido (use /local ou /sd)\n");
        return 1;
    }
    if (!FileSystem::mkdir(argv[1])) {
        print(ctx, "mkdir: falhou em %s\n", argv[1]);
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

int cmdFree(int argc, char** argv, CelerShell::PrintFn print, void* ctx) {
    print(ctx,
        "heap livre     : %s\r\n"
        "heap minimo    : %s\r\n"
        "maior bloco 8b : %s\r\n"
        "PSRAM livre    : %s\r\n"
        "interna livre  : %s (min %s, maior bloco %s)\r\n",
        humanSize(esp_get_free_heap_size()).c_str(),
        humanSize(esp_get_minimum_free_heap_size()).c_str(),
        humanSize(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)).c_str(),
        humanSize(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)).c_str(),
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
    DeviceStats::take(*b);

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
    std::string path = argv[1];
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
        size_t q1 = k == std::string::npos ? k : json.find('"', json.find(':', k) + 1);
        size_t q2 = q1 == std::string::npos ? q1 : json.find('"', q1 + 1);
        if (q1 == std::string::npos || q2 == std::string::npos) continue;
        std::string pkg = json.substr(q1 + 1, q2 - q1 - 1);
        uint32_t mask = celer::parsePermissions(json) &
                        (celer::PERM_FS | celer::PERM_NET | celer::PERM_GPIO |
                         celer::PERM_SYSTEM | celer::PERM_MIC | celer::PERM_CAMERA);
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
    print(ctx, "reiniciando...\r\n");
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
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

struct ShellCmd {
    const char* name;
    int (*fn)(int argc, char** argv, CelerShell::PrintFn print, void* ctx);
};

const ShellCmd kCommands[] = {
    {"help", cmdHelp},   {"ls", cmdLs},     {"cat", cmdCat},       {"rm", cmdRm},
    {"mv", cmdMv},       {"mkdir", cmdMkdir}, {"df", cmdDf},      {"free", cmdFree},
    {"ps", cmdPs},       {"uptime", cmdUptime}, {"info", cmdInfo}, {"reboot", cmdReboot},
    {"top", cmdTop},
#if CONFIG_IDF_TARGET_ESP32S3
    {"lcddma", cmdLcdDma},
#endif
    {"rescan", cmdRescan}, {"apps", cmdApps}, {"stat", cmdStat},
    {"run", cmdRun}, {"exit", cmdExit},
    {"grant", cmdGrant},
    {"lasterror", cmdLastError},
    {"debug", cmdDebug},
    {"wifi", cmdWifi},
#if CONFIG_CELEROS_DEBUG_BRIDGE
    {"bridge", cmdBridge},
#endif
#if CONFIG_CELEROS_PHONE_LINK
    {"gb", cmdGb},
#endif
    {"colorbars", cmdColorBars},
};

}  // namespace

bool CelerShell::pathAllowed(const std::string& path) {
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

int CelerShell::execute(const char* line, PrintFn print, void* ctx) {
    // copia para tokenizar
    char buf[MAX_LINE];
    strncpy(buf, line, MAX_LINE - 1);
    buf[MAX_LINE - 1] = '\0';

    // separa em argc/argv por espacos
    char* argv[16];
    int argc = 0;
    char* save = nullptr;
    for (char* tok = strtok_r(buf, " \t", &save); tok != nullptr && argc < 16;
         tok = strtok_r(nullptr, " \t", &save)) {
        argv[argc++] = tok;
    }
    if (argc == 0) return 0;

    for (const ShellCmd& c : kCommands) {
        if (strcmp(argv[0], c.name) == 0) {
            return c.fn(argc, argv, print, ctx);
        }
    }
    print(ctx, "%s: comando nao encontrado (help para lista)\r\n", argv[0]);
    return -1;
}
