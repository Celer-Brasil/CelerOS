#include "AppServices.h"

#include "Services.h"
#include "../FileSystem/FileSystem.h"
#include "../Launcher/LauncherUI.h"
#include "../Kernel/Notifications.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../Runtime/JSBindings.h"
#include "../Utils/AppGrants.h"
#include "../Utils/AppPerms.h"
#include "../USBDevice/LogSink.h"
#include "../USBDevice/CelerShell.h"
#include "../Utils/InstallMarker.h"
#include "../Utils/CelerSettings.h"
#include "../Boards/Board.h"
#include <duktape.h>
#include <esp_heap_caps.h>
#include <vector>
#include <string>

#if CONFIG_CELEROS_APP_SERVICES

// =====================================================
// svchost: um heap Duktape, uma thread por servico (API 42)
// =====================================================
//
// Ciclo: init() lista os apps com "service" no app.json (o consentimento
// herdado e o das permissoes do app — o servico so faz o que o app ja
// pode); o 1o tick cria o heap (PSRAM-first, mesmas reservas do app via
// CelerKernel::heapAlloc) e compila cada service.js como PROGRAMA na thread
// dele; cada giro drena os timers do host de servicos com orcamento de ms
// (round-robin: o que nao couber continua no proximo tick) e aplica as
// paradas pedidas (Service.stop(), shell svc stop, erro de callback).
//
// Erro em callback NAO derruba os outros servicos: o ofensor para (log +
// notificacao de sistema); app "system" ganha 1 reinicio com 60 s de
// backoff (protege as cadencias migradas do firmware — o fallback nativo
// do TimeManager e o cinto de seguranca final).

namespace {

constexpr int kMaxServices = 12;
constexpr uint32_t kTickBudgetMs = 8;    // por giro do pump (ALWAYS roda barato)
constexpr uint32_t kSvcSliceMs = 250;    // janela do exec-timeout do servico
constexpr uint32_t kAppSliceMs = 1000;   // janela normal do app (restaurar)
constexpr uint32_t kBackoffMs = 60u * 1000u;
// Sem PSRAM: so cria o heap se a sobra total deixar o piso do app (kDukBase
// + folga do CelerKernel) ainda caber depois — o app em foreground manda.
constexpr size_t kNoPsramMinFree = 44 * 1024;

struct SvcApp {
    std::string dir;      // /local/apps/<Nome>
    std::string pkg;
    std::string name;     // display
    std::string file;     // service.js (campo "service" do app.json)
    uint32_t perms = 0;
    bool isSystem = false;
    bool running = false;      // thread viva no heap
    bool needsLoad = true;     // a carregar no proximo giro com orcamento
    bool stopped = false;      // shell svc stop / erro (ate start/boot)
    uint32_t backoffAt = 0;    // reinicio automatico adiado (system)
    int restarts = 0;
    duk_context* thr = nullptr;
    duk_size_t stashIdx = 0;   // posicao da thread no stash "svcs" (para soltar)
};

std::vector<SvcApp> s_apps;
duk_context* s_heap = nullptr;
bool s_suspended = false;
uint32_t s_lastTickMs = 0;

// install.sh pendente (UMA versao, um script por giro do pump)
struct InstallJob {
    std::string dir;
    std::string pkg;
    std::string name;
    std::string version;
};
std::vector<InstallJob> s_installs;

// chave NVS curta (teto de 15 chars do namespace): "su_" + FNV1a do pkg
std::string setupKey(const std::string& pkg) {
    uint32_t h = 2166136261u;
    for (char c : pkg) {
        h ^= (uint8_t)c;
        h *= 16777619u;
    }
    char buf[16];
    snprintf(buf, sizeof(buf), "su_%08lx", (unsigned long)h);
    return buf;
}

void logPrint(void*, const char* fmt, ...) {
    char buf[192];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    celer_log_println(buf);
}

// ---------------- descoberta (boot e rescan) ----------------

void discover() {
    s_apps.clear();
    s_installs.clear();
    const int n = LauncherUI::appEntryCount();
    for (int i = 0; i < n; i++) {
        if (!LauncherUI::appEntryIsFolder(i)) continue;  // .js avulso nao tem servico
        const std::string& path = LauncherUI::appEntryPath(i);
        std::string json = FileSystem::readTextFile((path + "/app.json").c_str());
        if (json.empty()) continue;
        // install.sh (API 42): roda 1x por versao, restrito a propria pasta
        // e ao proprio /local/data/<pkg> (o shell ja tem if/while/vars,
        // redirecao ">" e comandos de arquivo — nada de JS para isto)
        if (FileSystem::exists((path + "/install.sh").c_str()) &&
            FileSystem::getFileSize((path + "/install.sh").c_str()) <= 16 * 1024) {
            std::string ver = FileSystem::parseJsonValue(json, "version");
            std::string pkg = LauncherUI::appEntryPkg(i);
            if (celer::setup::due(ver, CelerSettings::get(setupKey(pkg).c_str(), ""))) {
                InstallJob j;
                j.dir = path;
                j.pkg = pkg;
                j.name = LauncherUI::appEntryName(i);
                j.version = ver;
                s_installs.push_back(j);
            }
        }
        if ((int)s_apps.size() >= kMaxServices) continue;
        std::string svcFile = FileSystem::parseJsonValue(json, "service");
        if (svcFile.empty() || svcFile == "true") continue;
        // nome simples e seguro (mesma regra do "main": sem barra/..)
        if (svcFile.find('/') != std::string::npos ||
            svcFile.find("..") != std::string::npos || svcFile.length() > 40) continue;
        SvcApp a;
        a.dir = path;
        a.pkg = LauncherUI::appEntryPkg(i);
        a.name = LauncherUI::appEntryName(i);
        a.file = svcFile;
        a.isSystem = LauncherUI::appEntryIsSystem(i);
        // O servico herda o consentimento do app: DECLARADAS & CONCEDIDAS
        // (mesmo masking do launch — sem grant o servico nem comeca; o 1o
        // consentimento acontece no 1o launch do app pelo launcher).
        uint32_t granted = 0;
        if (AppGrants::lookup(a.pkg, a.dir, &granted)) {
            a.perms = LauncherUI::appEntryPerms(i) & granted;
        }
        s_apps.push_back(a);
    }
}

void noteCrash(SvcApp& a, const char* err) {
    celer_log_printf("[svc] %s: erro: %s\n", a.name.c_str(), err ? err : "?");
    if (a.isSystem && a.restarts == 0) {
        // servico de app system: 1 reinicio com backoff (as cadencias
        // migradas do firmware moram aqui)
        a.restarts++;
        a.backoffAt = millis() + kBackoffMs;
        a.needsLoad = true;
        a.running = false;
        celer_log_printf("[svc] %s: reinicio agendado (60 s)\n", a.name.c_str());
    } else {
        a.running = false;
        a.stopped = true;
        Notifications::push("Servico parado", (a.name + ": " + (err ? err : "erro")).c_str(), "svc");
    }
}

// ---------------- heap + threads ----------------

// Fatal do heap de servicos: sem recuperacao segura dentro do Duktape —
// registra, nomeia e reinicia (a mesma semantica do app; o my_fatal dele
// tem a tela propria e ja cobre o caso do app em foreground).
void svcFatal(void* udata, const char* msg) {
    (void)udata;
    celer_log_printf("[svc] fatal do heap: %s\n", msg ? msg : "sem mensagem");
    CelerKernel::recordCrash("Fatal do svchost", msg ? msg : "sem mensagem");
    delay(1500);
    ESP.restart();
}

bool ensureHeap() {
    if (s_heap != nullptr) return true;
    if (!Board::profile().hasPsram) {
        size_t freeB = heap_caps_get_free_size(MALLOC_CAP_8BIT) +
                       heap_caps_get_free_size(MALLOC_CAP_IRAM_8BIT);
        if (freeB < kNoPsramMinFree) {
            static uint32_t lastLog = 0;
            if (millis() - lastLog > 60000) {
                lastLog = millis();
                celer_log_printf("[svc] heap adiado (livre %u KB < %u KB)\n",
                                 (unsigned)(freeB / 1024), (unsigned)(kNoPsramMinFree / 1024));
            }
            return false;
        }
    }
    s_heap = duk_create_heap(CelerKernel::heapAlloc, CelerKernel::heapRealloc,
                             CelerKernel::heapFree, nullptr, svcFatal);
    if (s_heap == nullptr) return false;
    JSBindings::timersResetSvc();
    celer_log_println("[svc] heap criado");
    return true;
}

void destroyHeap() {
    if (s_heap != nullptr) {
        duk_destroy_heap(s_heap);
        s_heap = nullptr;
    }
    for (auto& a : s_apps) {
        a.thr = nullptr;
        a.running = false;
        a.needsLoad = !a.stopped;
    }
    JSBindings::timersResetSvc();
}

// Carrega o service.js do servico como PROGRAMA na thread dele. A referencia
// da thread vive no heap stash ("svcs") — thread solta viraria GC.
void loadService(SvcApp& a) {
    if (s_heap == nullptr || a.thr != nullptr) return;

    // tamanho com teto antes de ler (std::string de arquivo gigante com
    // -fno-exceptions pode abortar o aparelho)
    size_t sz = FileSystem::getFileSize((a.dir + "/" + a.file).c_str());
    if (sz == 0 || sz > 64 * 1024) {
        celer_log_printf("[svc] %s: service.js ausente ou acima de 64 KB\n", a.name.c_str());
        a.stopped = true;
        return;
    }

    duk_push_heap_stash(s_heap);                 // [stash]
    duk_get_prop_string(s_heap, -1, "svcs");     // [stash, arr?]
    if (!duk_is_array(s_heap, -1)) {
        duk_pop(s_heap);                         // [stash]
        duk_push_array(s_heap);                  // [stash, arr]
        duk_dup(s_heap, -1);                     // [stash, arr, arr]
        duk_put_prop_string(s_heap, -3, "svcs"); // [stash, arr]
    }
    const duk_size_t idx = duk_get_length(s_heap, -1);
    a.stashIdx = idx;

    duk_push_thread_new_globalenv(s_heap);       // [stash, arr, thr]
    a.thr = duk_require_context(s_heap, -1);
    duk_put_prop_index(s_heap, -2, idx);         // [stash, arr] (stash e o dono)
    duk_pop_2(s_heap);                           // []

    // superficie + identidade do servico durante o compile
    JSBindings::timersUseSvcHost(true);
    SvcApi::install(a.thr, a.pkg.c_str(), a.perms, a.dir.c_str());
    JSBindings::timersUseSvcHost(false);

    std::string src = FileSystem::readTextFile((a.dir + "/" + a.file).c_str());
    duk_push_string(a.thr, (a.dir + "/" + a.file).c_str());
    duk_int_t rc = duk_pcompile_lstring_filename(a.thr, 0, src.c_str(), (duk_size_t)src.length());
    if (rc == DUK_EXEC_SUCCESS) {
        CelerKernel::noteAppYield();  // janela fresca para o top-level
        CelerKernel::setExecSliceMs(kSvcSliceMs);
        rc = duk_pcall(a.thr, 0);
        CelerKernel::setExecSliceMs(kAppSliceMs);
    }
    if (rc != DUK_EXEC_SUCCESS) {
        const char* err = duk_safe_to_string(a.thr, -1);
        noteCrash(a, err);
        JSBindings::timersClearCtx(a.thr);  // timers do morto nao refirem
        duk_pop(a.thr);                     // o erro
        // solta a referencia da thread no stash (o GC a recolhe)
        duk_push_heap_stash(s_heap);                 // [stash]
        duk_get_prop_string(s_heap, -1, "svcs");     // [stash, arr?]
        if (duk_is_array(s_heap, -1)) {
            duk_push_undefined(s_heap);              // [stash, arr, und]
            duk_put_prop_index(s_heap, -2, (duk_uarridx_t)a.stashIdx);  // [stash, arr]
        }
        duk_pop_2(s_heap);                           // []
        a.thr = nullptr;
        return;
    }
    duk_pop(a.thr);  // resultado do top-level
    a.running = true;
    a.needsLoad = false;
    celer_log_printf("[svc] %s: no ar (%s)\n", a.name.c_str(), a.file.c_str());
}

// Drena os timers do host de servicos (JsTimers: slots com ctx por servico)
void drainTimers() {
    JSBindings::timersUseSvcHost(true);
    // o timersTick dispara no ctx de CADA slot; o ctx passado so cobre slots
    // antigos sem ctx (nunca ocorre: timerStart sempre grava)
    duk_context* any = nullptr;
    for (auto& a : s_apps) {
        if (a.running && a.thr != nullptr) { any = a.thr; break; }
    }
    if (any != nullptr) JSBindings::timersTick(any);
    JSBindings::timersUseSvcHost(false);
}

}  // namespace

namespace AppServices {

void init() {
    discover();
    // o heap nasce LAZY no primeiro tick — o boot critico nao paga por ele
    celer_log_printf("[svc] %u servico(s) declarado(s)\n", (unsigned)s_apps.size());
}

void tick(bool inApp) {
    (void)inApp;
    s_lastTickMs = millis();
    if (s_suspended) return;  // resumeAfterApp reativa
    if (LauncherUI::svcDirty) {
        LauncherUI::svcDirty = false;  // apps mudaram: redescobre (install/remocao)
        discover();
    }

    // install.sh pendente: UM por giro (script roda restrito, fora do heap
    // Duktape — o shell de arquivo basta). Falha nao grava o marcador: o
    // proximo boot tenta de novo.
    if (!s_installs.empty()) {
        InstallJob j = s_installs.front();
        s_installs.erase(s_installs.begin());
        celer_log_printf("[setup] %s: install.sh v%s\n", j.name.c_str(), j.version.c_str());
        const std::string dataDir = "/local/data/" + j.pkg;
        FileSystem::mkdir(dataDir.c_str());
        CelerShell::setRestrictedRoots(j.dir.c_str(), dataDir.c_str());
        CelerShell::execute(("cd " + j.dir).c_str(), logPrint, nullptr);
        int rc = CelerShell::execute("sh -e install.sh", logPrint, nullptr);
        CelerShell::execute("cd /", logPrint, nullptr);
        CelerShell::setRestrictedRoots(nullptr, nullptr);
        if (rc == 0) {
            CelerSettings::set(setupKey(j.pkg).c_str(), j.version.c_str());
            celer_log_printf("[setup] %s: ok\n", j.name.c_str());
        } else {
            celer_log_printf("[setup] %s: FALHOU (rc=%d); tenta no proximo boot\n",
                             j.name.c_str(), rc);
            Notifications::push("install.sh falhou", (j.name + " (rc=" + std::to_string(rc) + ")").c_str(), "setup");
        }
        return;  // um por giro: script pode ser pesado (rm/arquivo)
    }

    if (!ensureHeap()) return;

    uint32_t t0 = millis();
    for (auto& a : s_apps) {
        if (a.stopped) continue;
        if (a.backoffAt != 0) {
            if ((int32_t)(millis() - a.backoffAt) < 0) continue;
            a.backoffAt = 0;
        }
        if (a.needsLoad) {
            loadService(a);
            if (millis() - t0 > kTickBudgetMs) return;  // round-robin
            continue;
        }
    }
    drainTimers();
}

void suspendForApp() {
    if (Board::profile().hasPsram) return;  // PSRAM: servico segue com app aberto
    if (s_suspended) return;
    destroyHeap();
    s_suspended = true;
    celer_log_println("[svc] suspenso (app em foreground, sem PSRAM)");
}

void resumeAfterApp() {
    if (!s_suspended) return;
    s_suspended = false;
    celer_log_println("[svc] volta do suspension");
}

bool stopService(const std::string& pkg) {
    for (auto& a : s_apps) {
        if (a.pkg != pkg) continue;
        if (a.thr != nullptr) JSBindings::timersClearCtx(a.thr);
        a.stopped = true;
        a.running = false;
        a.thr = nullptr;  // referencia solta no stash: morre no GC/rebuild
        return true;
    }
    return false;
}

// svc setup <pkg>: esquece o marcador e roda o install.sh de novo no
// proximo giro (bench: mudou o script, testa sem reinstalar)
bool rerunSetup(const std::string& pkg) {
    CelerSettings::set(setupKey(pkg).c_str(), "");
    LauncherUI::svcDirty = true;
    return true;
}

bool startService(const std::string& pkg) {
    for (auto& a : s_apps) {
        if (a.pkg != pkg) continue;
        a.stopped = false;
        a.needsLoad = true;
        a.backoffAt = 0;
        a.restarts = 0;
        return true;
    }
    return false;
}

Info info() {
    Info in;
    in.found = (int)s_apps.size();
    for (auto& a : s_apps) {
        if (a.running && !a.stopped) in.running++;
    }
    in.heapAlive = s_heap != nullptr;
    in.suspended = s_suspended;
    return in;
}

uint32_t lastTickAgoMs() { return millis() - s_lastTickMs; }

}  // namespace AppServices

#endif  // CONFIG_CELEROS_APP_SERVICES
