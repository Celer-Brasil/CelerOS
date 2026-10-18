#include "LauncherUI.h"
#include <algorithm>
#include <new>
#include "../Utils/AppPerms.h"  // parsePermissions/PERM_* (testavel no host)
#include "../Utils/AppGrants.h"
#include "../USBDevice/LogSink.h"
#include "../Runtime/JSBindings.h"
#include "../Kernel/AppRunner.h"
#include "../Kernel/AppServices.h"
#include "../Kernel/Core/CelerKernel.h"
#include "../FileSystem/FileSystem.h"
#include "../Display/Layout.h"
#include "../Display/Theme.h"
#include "../UI/Kui.h"
#include "../Display/Icon.h"
#include "../Boards/Board.h"
#include "../Utils/StrUtils.h"
#include "../Utils/CelerSettings.h"
#include "../Display/Backlight.h"
#include "../Kernel/Alarms.h"

CelerDisplay *LauncherUI::tftInstance = nullptr;
std::vector<LauncherUI::AppEntry> LauncherUI::apps;
int LauncherUI::appCount = 0;
bool LauncherUI::needsRescan = true;
bool LauncherUI::svcDirty = true;  // svchost redescobre no 1o giro


void LauncherUI::requestRescan() {
    needsRescan = true;
}

namespace {
portMUX_TYPE s_launchMux = portMUX_INITIALIZER_UNLOCKED;
std::string s_launchReq;   // protegido por s_launchMux
volatile bool s_launchPending = false;
}  // namespace

void LauncherUI::requestLaunch(const std::string& pathOrName) {
    std::string copy = pathOrName;  // aloca fora da secao critica
    portENTER_CRITICAL(&s_launchMux);
    s_launchReq.swap(copy);
    s_launchPending = true;
    portEXIT_CRITICAL(&s_launchMux);
}

bool LauncherUI::takeLaunchRequest(std::string& out) {
    if (!s_launchPending) return false;
    std::string got;
    portENTER_CRITICAL(&s_launchMux);
    got.swap(s_launchReq);
    s_launchPending = false;
    portEXIT_CRITICAL(&s_launchMux);
    out.swap(got);
    return true;
}

namespace {
portMUX_TYPE s_appExitMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool s_appExitPending = false;   // protegido por s_appExitMux
volatile uint32_t s_appExitAt = 0;        // tick do pedido (expira sozinho)
volatile bool s_appExitForApp = false;    // pedido feito COM app em execucao
volatile bool s_appRunning = false;       // entre a entrada e a saida do runFile
}  // namespace

void LauncherUI::requestAppExit() {
    portENTER_CRITICAL(&s_appExitMux);
    s_appExitPending = true;
    s_appExitAt = xTaskGetTickCount();
    s_appExitForApp = s_appRunning;
    portEXIT_CRITICAL(&s_appExitMux);
}

bool LauncherUI::appRunning() { return s_appRunning; }

bool LauncherUI::consumeAppExitRequest() {
    bool out = false;
    portENTER_CRITICAL(&s_appExitMux);
    if (s_appExitPending) {
        s_appExitPending = false;
        // Pedido sem app em execucao nao pode sobreviver e matar o PROXIMO
        // app na primeira chamada de delay/getTouch: expira em 2s. Com app
        // rodando vale ate ele ceder — um app preso 9 s numa chamada de IA
        // (Dog Face ouvindo voz) deixava o "celerctl shell exit" vencer
        // antes do yield e o "run" seguinte esperava para sempre.
        out = s_appExitForApp || (xTaskGetTickCount() - s_appExitAt) < pdMS_TO_TICKS(2000);
    }
    portEXIT_CRITICAL(&s_appExitMux);
    return out;
}

void LauncherUI::dropIdleExitRequest() {
    portENTER_CRITICAL(&s_appExitMux);
    if (s_appExitPending && !s_appExitForApp) s_appExitPending = false;
    portEXIT_CRITICAL(&s_appExitMux);
}

int LauncherUI::findEntry(const std::string& pathOrName) {
    std::string want = pathOrName;
    while (want.size() > 1 && want.back() == '/') want.pop_back();
    for (int i = 0; i < appCount; i++) {
        std::string p = apps[i].path;
        while (p.size() > 1 && p.back() == '/') p.pop_back();
        if (p == want || apps[i].name == want || apps[i].pkg == want) return i;
    }
    // nome da PASTA (o que o celerctl apps run/dev mandam): app cujo nome de
    // exibicao difere da pasta ("Arrasa!" em /local/apps/Arrasa) nao abria.
    // Depois dos casamentos exatos; /local vem antes do /sd na lista
    for (int i = 0; i < appCount; i++) {
        std::string p = apps[i].path;
        while (p.size() > 1 && p.back() == '/') p.pop_back();
        size_t cut = p.rfind('/');
        if (cut != std::string::npos && p.compare(cut + 1, std::string::npos, want) == 0) return i;
    }
    return -1;
}

void LauncherUI::init(CelerDisplay *tft) {
    tftInstance = tft;
}

// ---------------------------------------------------------------------------
// Geometria do grid
// ---------------------------------------------------------------------------
int LauncherUI::totalEntries() {
    return appCount;  // telas de sistema viraram apps JS ("system": true)
}

int LauncherUI::cols() {
    // 4 colunas a partir de 300px (SmartDisplay 480 e CYD landscape 320,
    // celula de 80px com icone de 48); retrato estreito fica com 3
    return (UI::W >= 300) ? 4 : 3;
}

int LauncherUI::rows() {
    int labelH = UI::big ? 26 : 14;
    int cellH = Icon::SIZE + labelH + (UI::big ? 18 : 10);
    int areaH = UI::H - UI::sy(56) - UI::sy(10) - UI::sy(28);
    int r = areaH / cellH;
    return (r < 1) ? 1 : r;
}

int LauncherUI::cellsPerPage() {
    return cols() * rows();
}

int LauncherUI::totalPages() {
    int tp = (totalEntries() + cellsPerPage() - 1) / cellsPerPage();
    return (tp < 1) ? 1 : tp;
}

// ---------------------------------------------------------------------------
// Scan de apps (LittleFS + SD)
// ---------------------------------------------------------------------------

std::string LauncherUI::homeTarget() {
    // Precedencia: /local/autostart.txt (qualquer placa) > profile.homeApp
    // (a casa nativa da placa — ex.: a cara do cao robotico, o watchface).
    std::string who;
    if (FileSystem::exists("/local/autostart.txt")) {
        who = FileSystem::readTextFile("/local/autostart.txt");
        while (!who.empty() && (who.back() == '\n' || who.back() == '\r' || who.back() == ' '))
            who.pop_back();
    } else if (Board::profile().homeApp) {
        who = Board::profile().homeApp;
    }
    return who;
}

bool LauncherUI::launchHome() {
    // Um launch ja pedido (celerctl run/dev/debug, r do debugger) vence a
    // volta automatica para a casa: o pedido tem uma vaga so e a casa o
    // sobrescrevia — no cao/watch o `run` abria a casa de novo
    if (s_launchPending) return true;
    const std::string who = homeTarget();
    if (who.empty()) return false;
    if (findEntry(who) < 0) return false;  // app sumiu: fica no launcher
    requestLaunch(who);
    return true;
}

void LauncherUI::applyAutostart() {
    launchHome();
}

void LauncherUI::idleHomeTick() {
#if CONFIG_CELEROS_UI
    // So placas com casa nativa (watch, cao): o launcher ocioso volta para
    // ela — no watch e o que mantem o AOD (so existe com o watchface aberto).
    if (Board::profile().homeApp == nullptr) return;
    static uint32_t s_checkAt = 0;
    static int s_idleS = -1;
    const uint32_t now = millis();
    if (now - s_checkAt < 1000) return;
    s_checkAt = now;
    if (s_idleS < 0 || (now / 1000) % 30 == 0) {  // releitura barata do ajuste
        s_idleS = atoi(CelerSettings::get("home_idle_s", "30").c_str());
    }
    if (s_idleS <= 0) return;  // 0 = desligado
    if (Alarms::ringing()) return;  // a AlarmScreen fica por cima ate parar
    // telas que travam o voltar (alarme, codigo de pareamento, chamada)
    kui::Screen* top = kui::Navigator::top();
    if (top != nullptr && !top->allowsBackGesture()) return;
    if (now - Backlight::lastActivity() < (uint32_t)s_idleS * 1000UL) return;
    if (!launchHome()) return;
    kui::Navigator::home();  // o app volta para a raiz do launcher ao sair
#else
    // Sem vidro o launcher nao existe: voltar a casa e lancar de novo (o
    // celerctl/shell faz o restart quando precisar).
#endif
}

void LauncherUI::scanLocalApps() {
    appCount = 0;
    apps.clear();
    svcDirty = true;  // svchost (API 42): quem declara "service" pode ter mudado
#if CONFIG_CELEROS_UI
    Icon::invalidateFileIcons();  // app reinstalado pode ter trocado a arte
#endif

    const char* appDirs[] = { "/local/apps/", "/sd/apps/" };

    for (int d = 0; d < 2; d++) {
        if (!FileSystem::exists(appDirs[d])) continue;

        FileEntry entries[50];
        int count = FileSystem::listDirectory(appDirs[d], entries, 50);
        if (count >= 50) {
            // listDirectory para em 50: o resto da pasta nao aparece
            celer_log_printf("[launcher] %s tem 50+ entradas: as excedentes nao aparecem\n", appDirs[d]);
        }

        for (int i = 0; i < count && appCount < 50; i++) {
#if CONFIG_CELEROS_UI
            if (tftInstance) {
                tftInstance->fillRect(UI::sx(20), UI::sy(200), (i * UI::sx(200)) / count, UI::sy(10), THEME_ACCENT);
            }
#endif

            std::string name, pkg, icon;
            bool isFolder = false, system = false, topbar = false;
            int order = 100;
            uint32_t appEntryPerms = 0xFFFFFFFFu;  // .js avulso: sem app.json = tudo

            if (entries[i].isDir) {
                std::string appJsonPath = entries[i].path;
                if (!kstr::endsWith(appJsonPath, "/")) appJsonPath += "/";
                appJsonPath += "app.json";

                if (!FileSystem::exists(appJsonPath.c_str())) continue;

                std::string jsonContent = FileSystem::readTextFile(appJsonPath.c_str());
                appEntryPerms = celer::parsePermissions(jsonContent);
                name = FileSystem::parseJsonValue(jsonContent, "name");
                if (name.length() == 0) continue;

                pkg    = FileSystem::parseJsonValue(jsonContent, "packageName");
                // packageName vira caminho (/local/data/<pkg>) e identidade
                // (Storage, concessoes): so [A-Za-z0-9._-], sem "..", ate 64.
                // Invalido = ignorado (dedup/identidade pelo nome).
                {
                    bool okPkg = pkg.size() <= 64 && pkg.find("..") == std::string::npos;
                    for (char ch : pkg) {
                        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
                              ch == '.' || ch == '_' || ch == '-')) {
                            okPkg = false;
                        }
                    }
                    if (!okPkg) {
                        celer_log_printf("[launcher] packageName invalido ignorado: %s\n", pkg.c_str());
                        pkg.clear();
                    }
                }
                icon   = FileSystem::parseJsonValue(jsonContent, "icon");
                system = (FileSystem::parseJsonValue(jsonContent, "system") == "true");
                topbar = (FileSystem::parseJsonValue(jsonContent, "topbar") == "true");
                order  = atoi(FileSystem::parseJsonValue(jsonContent, "order").c_str());
                if (order <= 0) order = 100;
                isFolder = true;

                // icone do pacote na pasta do app tem preferencia: cada app
                // carrega a propria arte onde for instalado (icon.png; o
                // .bin v1/v2 segue como legado)
                std::string pkgDir = appJsonPath.substr(0, appJsonPath.length() - strlen("app.json"));
                std::string pkgIcon = pkgDir + "icon.png";
                if (!FileSystem::exists(pkgIcon.c_str())) pkgIcon = pkgDir + "icon.bin";
                if (FileSystem::exists(pkgIcon.c_str())) icon = pkgIcon;
            } else {
                std::string fname = entries[i].name;
                if (!kstr::endsWith(fname, ".js")) continue;
                name = fname;
                pkg = fname;  // apps .js avulsos deduplicam pelo nome do arquivo
            }

            // Dedup por packageName (fallback nome). /local e varrido antes
            // de /sd, entao a copia local nao e sombreada pela do cartao.
            const std::string key = pkg.length() > 0 ? pkg : name;
            bool duplicate = false;
            for (int j = 0; j < appCount; j++) {
                const std::string& kOther = apps[j].pkg.length() > 0 ? apps[j].pkg : apps[j].name;
                if (kOther == key) { duplicate = true; break; }
            }
            if (duplicate) continue;

            // tela pequena: icone reduzido fica pronto no cache em flash
            // (o scan do boot roda com o heap cheio, antes do WiFi)
#if CONFIG_CELEROS_UI
            Icon::prewarm(icon.c_str());
#else
            (void)icon;
#endif

            AppEntry e;
            e.path = entries[i].path;
            e.name = name;
            e.pkg = pkg;
            e.icon = icon;
            e.perms = appEntryPerms;
            e.order = order;
            e.isFolder = isFolder;
            e.isSystem = system;
            e.topbar = topbar;
            apps.push_back(std::move(e));
            appCount++;
        }
    }

    if (appCount >= 50) {
#if CONFIG_CELEROS_UI
        celer_log_println("[launcher] limite de 50 apps atingido: apps excedentes ocultos");
        kui::Navigator::toast("Limite de 50 apps: alguns ficaram ocultos", THEME_WARN);
#else
        celer_log_println("[launcher] limite de 50 apps atingido: apps excedentes ocultos");
#endif
    }

    // Consentimento chegou com este firmware: o que ja estava instalado no
    // primeiro scan (apps de fabrica + os que o usuario ja usava) leva o que
    // declara — so app NOVO passa pelo dialogo. SD ausente agora = os apps
    // de la pedem consentimento quando aparecerem (lado seguro).
    if (!AppGrants::migrated()) {
        for (int i = 0; i < appCount; i++) {
            const std::string& id = apps[i].pkg.length() > 0 ? apps[i].pkg : apps[i].path;
            AppGrants::grant(id, apps[i].path, apps[i].perms);
        }
        AppGrants::setMigrated();
        celer_log_printf("[perm] migracao: %d apps instalados concedidos\n", appCount);
    }

    // "system": true no app.json ordena o app a frente e o protege da
    // remocao pelo launcher — so vale com a capability "system" CONCEDIDA
    // (antes qualquer app da loja se declarava de sistema e ficava
    // impossivel de remover pelo grid)
    for (int i = 0; i < appCount; i++) {
        if (!apps[i].isSystem) continue;
        uint32_t granted = 0;
        const std::string& id = apps[i].pkg.length() > 0 ? apps[i].pkg : apps[i].path;
        if (!AppGrants::lookup(id, apps[i].path, &granted) || !(granted & celer::PERM_SYSTEM)) {
            apps[i].isSystem = false;
        }
    }

    // Ordem do grid: apps de sistema primeiro pelo campo "order" do
    // app.json; apps comuns depois, na ordem de descobertura (ordenacao
    // estavel: empates mantem a ordem do scan).
    auto sortKey = [](const AppEntry& e) { return e.isSystem ? e.order : 1000; };
    std::stable_sort(apps.begin(), apps.end(),
                     [&](const AppEntry& x, const AppEntry& y) { return sortKey(x) < sortKey(y); });
    apps.shrink_to_fit();  // sem folga do crescimento: a lista vive o boot inteiro

    gcSharedModules();
}

void LauncherUI::gcSharedModules() {
    // Versoes de /local/modules sem nenhum app referenciando no deps.json
    // saem do disco: desinstalar o ultimo jogo que usava a engine libera os
    // ~53KB dela. Referencias = deps.json de TODAS as pastas de apps (local
    // e SD — app do cartao usa o cache do /local). Dezenas de arquivos no
    // pior caso: custa menos que um icone do prewarm acima.
    if (!FileSystem::exists("/local/modules")) return;

    std::vector<std::string> refs;  // "nome/versao" referenciados
    const char* appDirs[] = { "/local/apps/", "/sd/apps/" };
    for (int d = 0; d < 2; d++) {
        if (!FileSystem::exists(appDirs[d])) continue;
        FileEntry entries[50];
        int count = FileSystem::listDirectory(appDirs[d], entries, 50);
        for (int i = 0; i < count; i++) {
            if (!entries[i].isDir) continue;
            std::string depsJson = entries[i].path;
            if (!kstr::endsWith(depsJson, "/")) depsJson += "/";
            depsJson += "deps.json";
            if (!FileSystem::exists(depsJson.c_str())) continue;
            std::string json = FileSystem::readTextFile(depsJson.c_str());
            // mesmo teto do runtime (JsModules, API 44: 32 — o deps.json e o
            // FECHO transitivo). Ate a API 43 o GC lia so 8 pares e APAGAVA
            // o resto do fecho de um app instalado. Pares no heap; sem
            // memoria ou lista cheia (talvez cortada) o GC desiste: na
            // duvida, nada sai do disco
            const int kMaxRefs = 32;
            JsonStringPair* pairs = new (std::nothrow) JsonStringPair[kMaxRefs];
            if (!pairs) return;
            int n = FileSystem::parseJsonStringMap(json, pairs, kMaxRefs);
            if (n >= kMaxRefs) {
                delete[] pairs;
                celer_log_printf("[launcher] gc modules: %s com %d+ deps, GC adiado\n",
                                 depsJson.c_str(), kMaxRefs);
                return;
            }
            for (int p = 0; p < n; p++) {
                std::string ref = pairs[p].key + "/" + pairs[p].value;
                bool dup = false;
                for (const std::string& r : refs) {
                    if (r == ref) { dup = true; break; }
                }
                if (!dup) refs.push_back(std::move(ref));
            }
            delete[] pairs;
        }
    }

    FileEntry names[16];
    int nameCount = FileSystem::listDirectory("/local/modules", names, 16);
    for (int i = 0; i < nameCount; i++) {
        if (!names[i].isDir) continue;
        FileEntry versions[12];
        int verCount = FileSystem::listDirectory(names[i].path.c_str(), versions, 12);
        int left = 0;
        for (int v = 0; v < verCount; v++) {
            if (!versions[v].isDir) continue;
            std::string ref = names[i].name + "/" + versions[v].name;
            bool needed = false;
            for (const std::string& r : refs) {
                if (r == ref) { needed = true; break; }
            }
            if (needed) {
                left++;
                continue;
            }
            if (FileSystem::removeTree(versions[v].path.c_str()))
                celer_log_printf("[launcher] gc modules: %s sem referencias\n", ref.c_str());
        }
        if (left == 0 && verCount > 0) FileSystem::rmdir(names[i].path.c_str());
    }
}

// ---- Acesso para o LauncherScreen (Kui) ------------------------------------
int LauncherUI::appEntryCount() { return appCount; }
const std::string& LauncherUI::appEntryPath(int i) { return apps[i].path; }
const std::string& LauncherUI::appEntryName(int i) { return apps[i].name; }
const std::string& LauncherUI::appEntryIcon(int i) { return apps[i].icon; }
bool LauncherUI::appEntryIsSystem(int i) { return apps[i].isSystem; }
bool LauncherUI::appEntryTopbar(int i) { return apps[i].topbar; }
bool LauncherUI::appEntryIsFolder(int i) { return apps[i].isFolder; }
uint32_t LauncherUI::appEntryPerms(int i) { return apps[i].perms; }
const std::string& LauncherUI::appEntryPkg(int i) { return apps[i].pkg; }
// Bits que o consentimento conhece (PERM_ALL do app.json sem o campo vira
// estes cinco)
static constexpr uint32_t kKnownPerms =
    celer::PERM_FS | celer::PERM_NET | celer::PERM_GPIO | celer::PERM_SYSTEM |
    celer::PERM_MIC | celer::PERM_CAMERA;

static const std::string& grantId(const std::string& pkg, const std::string& path) {
    return pkg.length() > 0 ? pkg : path;
}

// Efetivas = declaradas & concedidas: um app que pulou o dialogo (caminho
// novo de lancamento, concessao revogada) roda SEM o que falta
static uint32_t effectivePerms(const std::string& pkg, const std::string& path, uint32_t declared) {
    uint32_t granted = 0;
    if (!AppGrants::lookup(grantId(pkg, path), path, &granted)) granted = 0;
    return declared & granted & kKnownPerms;
}

uint32_t LauncherUI::appEntryMissingPerms(int i) {
    if (i < 0 || i >= appCount) return 0;
    uint32_t granted = 0;
    if (!AppGrants::lookup(grantId(apps[i].pkg, apps[i].path), apps[i].path, &granted)) granted = 0;
    return apps[i].perms & ~granted & kKnownPerms;
}

void LauncherUI::grantEntry(int i) {
    if (i < 0 || i >= appCount) return;
    // Permissoes RELIDAS do app.json: a lista so e reescaneada no tick do
    // launcher, e com um app aberto (o cao vive na Dog Face) ela guarda a
    // versao anterior — o `grant` de um app reinstalado concedia as
    // permissoes velhas e o novo parava no dialogo (sem toque no cao)
    if (apps[i].isFolder) {
        const std::string json = FileSystem::readTextFile((apps[i].path + "/app.json").c_str());
        if (!json.empty()) apps[i].perms = celer::parsePermissions(json);
    }
    AppGrants::grant(grantId(apps[i].pkg, apps[i].path), apps[i].path, apps[i].perms & kKnownPerms);
}

bool LauncherUI::uninstallEntry(int i) {
    if (i < 0 || i >= appCount) return false;
    const std::string path = apps[i].path;
    const std::string pkg = apps[i].pkg;
    bool ok = apps[i].isFolder ? FileSystem::removeTree(path.c_str()) : FileSystem::deleteFile(path.c_str());
    if (ok) {
        // "Apaga o app e os dados": antes so a pasta saia — o Storage (NVS)
        // e a pasta privada /local/data/<pkg> ficavam para tras
        if (apps[i].isFolder && pkg.length() > 0) {
            JSBindings::storageClearPackage(pkg);
            std::string dataDir = "/local/data/" + pkg;
            if (FileSystem::isDirectory(dataDir.c_str())) FileSystem::removeTree(dataDir.c_str());
        }
        AppGrants::revoke(grantId(pkg, path));
    }
    return ok;
}

void LauncherUI::launchApp(int index) {
    if (index < 0 || index >= appCount) return;
    runApp(tftInstance, apps[index].path, apps[index].isFolder, apps[index].topbar,
           apps[index].pkg, effectivePerms(apps[index].pkg, apps[index].path, apps[index].perms));
}

bool LauncherUI::launchAppAsync(int index) {
    // Caminho F3 (CELEROS_APP_TASK): resolve o app igual ao launchApp e
    // inicia na task propria. Retorna false se o build e sincrono ou a task
    // nao foi criada — o chamador cai no caminho classico.
#ifdef CELEROS_APP_TASK
    if (index < 0 || index >= appCount) return false;
    std::string filePath;
    std::string title;
    resolveApp(apps[index].path, apps[index].isFolder, filePath, title);
    return AppRunner::start(filePath, title, apps[index].topbar,
                            apps[index].pkg, effectivePerms(apps[index].pkg, apps[index].path, apps[index].perms));
#else
    (void)index;
    return false;
#endif
}
int LauncherUI::gridCols() { return cols(); }
int LauncherUI::gridRows() { return rows(); }
int LauncherUI::gridTotalEntries() { return totalEntries(); }
int LauncherUI::gridTotalPages() { return totalPages(); }

// ---------------------------------------------------------------------------
// Execucao de app JS
// ---------------------------------------------------------------------------
void LauncherUI::resolveApp(const std::string& path, bool isFolder,
                            std::string& filePath, std::string& title) {
    if (isFolder) {
        filePath = path;
        if (!kstr::endsWith(filePath, "/")) filePath += "/";
        filePath += "main.js";
    } else {
        filePath = path;
    }

    // Titulo para a topbar do sistema: nome da pasta do app (ou do .js avulso)
    title = path;
    while (title.size() > 1 && title.back() == '/') title.pop_back();
    size_t slash = title.find_last_of('/');
    title = (slash == std::string::npos) ? title : title.substr(slash + 1);
    if (!isFolder && kstr::endsWith(title, ".js")) title.resize(title.size() - 3);
}

void LauncherUI::runApp(CelerDisplay* tft, const std::string& path, bool isFolder, bool topbarFixed,
                        const std::string& appPkg, uint32_t perms) {
    tft->fillScreen(TFT_BLACK);
    tft->setTextDatum(TL_DATUM);

    std::string filePath, title;
    resolveApp(path, isFolder, filePath, title);

    // "topbar": true no app.json fixa a faixa (canvas abaixo dela); ausente
    // deixa a faixa retratil com o app em tela cheia
    // svchost (API 42): sem PSRAM o app e dono da RAM — servicos suspensos
    // ate a saida; com PSRAM seguem rodando
    AppServices::suspendForApp();
    s_appRunning = true;
    CelerKernel::runFile(filePath.c_str(), title.c_str(), topbarFixed,
                         appPkg.c_str(), perms);
    s_appRunning = false;
    AppServices::resumeAfterApp();
    // pedido de saida que o app nao chegou a consumir (saiu sozinho) morre
    // aqui: nao pode derrubar o proximo app
    portENTER_CRITICAL(&s_appExitMux);
    s_appExitPending = false;
    s_appExitForApp = false;
    portEXIT_CRITICAL(&s_appExitMux);
    // Lancamento SEM toque (shell run, autostart, launch remoto/CelerNet): o
    // launchEntry volta direto ao onTick do launcher e NINGUEM marca repaint —
    // o vidro ficava no ultimo quadro do app ("congelou") ate o proximo toque.
    // O caminho por toque (icone) repinta no proprio dispatchTouch.
    kui::Navigator::repaint();
}
