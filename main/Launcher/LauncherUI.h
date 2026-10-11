#ifndef LAUNCHER_UI_H
#define LAUNCHER_UI_H

#include "../Boards/Board.h"
#include <Arduino.h>
#include <string>
#include <vector>
#include <cstdint>

class LauncherUI {
public:
    static void init(CelerDisplay *tft);
    static void requestRescan();
    // Pedido de abrir app vindo de outra task (shell "run"): consumido pelo
    // LauncherScreen no loop da UI. Aceita caminho da pasta/arquivo ou nome.
    static void requestLaunch(const std::string& pathOrName);
    static bool takeLaunchRequest(std::string& out);
    // Pedido de encerrar o app em execucao (shell "exit" / dev loop do SDK):
    // consumido pelos pontos de espera do runtime JS (delay/getTouch/keypadPoll)
    // via throwAppExit — mesma saida limpa do X da topbar.
    static void requestAppExit();
    static bool consumeAppExitRequest();
    // Descarta um pedido de saida feito SEM app em execucao (o "exit" que o
    // celerctl manda antes do "run"): o app que o run abre nao pode morrer
    // no primeiro delay por ele.
    static void dropIdleExitRequest();
    static bool appRunning();  // um app JS esta em execucao agora
    static int findEntry(const std::string& pathOrName);  // -1 se nao achar
    static void scanLocalApps();
    // GC de deps compartilhadas (API 30): versoes em /local/modules que
    // nenhum app referencia no deps.json saem do disco. Roda no fim do
    // scanLocalApps — boot, install (rescan) e uninstall (que rescaneia).
    static void gcSharedModules();
    // Abre sozinho apos o boot o app cujo pacote/caminho esta em
    // /local/autostart.txt (ex.: a cara do cao robotico). Sem o arquivo,
    // nada acontece. O launcher continua acessivel pelo voltar do topbar.
    static void applyAutostart();
    // Casa da placa: /local/autostart.txt > profile.homeApp ("" = nenhuma).
    static std::string homeTarget();
    // Pede o lancamento da casa; false = sem casa ou app ausente.
    static bool launchHome();
    // Chamar no loop da UI: launcher ocioso por home_idle_s (NVS, padrao
    // 30 s; 0 desliga) volta para a casa. No-op sem profile.homeApp.
    static void idleHomeTick();
    static bool needsRescan;

    // Acesso para o LauncherScreen (Kui) e telas novas. Telas de sistema
    // convertidas em JS (Settings, App Store...) sao apps normais com
    // "system": true no app.json — ordenados a frente do grid.
    static int appEntryCount();
    static const std::string& appEntryPath(int i);
    static const std::string& appEntryName(int i);
    static const std::string& appEntryIcon(int i);   // nome em /local/icons ("" = tile)
    static bool appEntryIsSystem(int i);
    static bool appEntryTopbar(int i);
    static bool appEntryIsFolder(int i);
    static uint32_t appEntryPerms(int i);      // DECLARADAS no app.json
    static const std::string& appEntryPkg(int i);
    // Consentimento (AppGrants): declaradas que o usuario ainda nao
    // concedeu (0 = pode abrir direto) e a concessao das declaradas
    static uint32_t appEntryMissingPerms(int i);
    static void grantEntry(int i);
    // Desinstalacao completa: pasta/arquivo + Storage (NVS) + appData +
    // concessao. true = o app saiu do disco.
    static bool uninstallEntry(int i);
    static void launchApp(int index);          // executa app (sincrono)
    // F3 (CELEROS_APP_TASK): inicia na task propria; false = use launchApp
    static bool launchAppAsync(int index);
    static int gridCols();
    static int gridRows();
    static int gridTotalEntries();
    static int gridTotalPages();

private:
    static CelerDisplay *tftInstance;
    static void runApp(CelerDisplay *tft, const std::string& path, bool isFolder, bool topbarFixed,
                       const std::string& appPkg, uint32_t perms);
    static void resolveApp(const std::string& path, bool isFolder,
                           std::string& filePath, std::string& title);

    // Um registro por app do grid (eram 9 arrays paralelos de 50 posicoes:
    // ~5,4KB de RAM interna fixos, cheios ou nao — a lista tem o tamanho
    // dos apps instalados)
    struct AppEntry {
        std::string path;   // pasta do app ou .js avulso
        std::string name;   // nome exibido (app.json ou arquivo)
        std::string pkg;    // packageName do app.json (dedup)
        std::string icon;   // icone ("" = sem)
        uint32_t perms;     // capabilities declaradas (F4)
        int order;          // "order" do app.json (sistema primeiro)
        bool isFolder;      // pasta com app.json (false = .js legado)
        bool isSystem;      // "system": true (e concedido)
        bool topbar;        // "topbar": true (faixa fixa; ausente = retratil)
    };
    static std::vector<AppEntry> apps;
    static int appCount;

    static int totalEntries();    // = appCount (sistema agora sao apps JS)
    static int cols();
    static int rows();
    static int cellsPerPage();
    static int totalPages();
};

#endif // LAUNCHER_UI_H
