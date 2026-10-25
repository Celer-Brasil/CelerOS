#ifndef CELEROS_OTA_MANAGER_H
#define CELEROS_OTA_MANAGER_H

#include <Arduino.h>
#include <string>

// Resultado de checkForUpdates(). "available" compara version com
// CELEROS_VERSION; "hasFirmware" indica se o canal publica firmware_url
// (update.json v2) — sem ele a UI cai no fluxo legado do guia manual.
// "apiVersion" e o nivel de API do firmware ofertado (campo api_version
// do manifest, obrigatorio desde a validacao de 2026-10).
struct OtaUpdateInfo {
    bool fetchFailed = false;
    bool available = false;
    bool hasFirmware = false;
    int apiVersion = 0;
    std::string version;
    std::string firmwareUrl;
    // SHA-256 do firmware ofertado (update.json v2). O runUpdate confere o
    // hash do stream antes de marcar o boot; hash ausente/curto e recusado
    // quando o manifesto vem por HTTPS (hub).
    std::string firmwareSha256;
    std::string changelog;
    std::string guide;
    std::string type;
};

class OtaManager {
public:
    // Preenchido por checkForUpdates(); lido pela UI do updater.
    static OtaUpdateInfo info;

    // Ultimo erro reportado por performUpdate().
    static std::string lastError;

    // URL do update.json do canal da placa. Ordem de precedencia:
    //   1. /local/ota_url.txt (dev: servidor local; se nao terminar em
    //      ".json", "/update.json" e anexado)
    //   2. Hub: https://os.celer.tec.br/updates/<canal>/update.json, onde
    //      canal vem do perfil da placa (Boards/<placa>/Board.cpp)
    static std::string getUpdateJsonUrl();

    // Baixa e interpreta o update.json. Retorna true se ha atualizacao
    // disponivel (resultado completo em "info").
    static bool checkForUpdates();

    // Flashea o firmware da URL no slot OTA inativo com validacao de
    // checksum (esp_ota_end) antes de ativa-lo. onProgress recebe
    // percentuais 0-100. Retorna false e preenche lastError em caso de
    // falha — nesse caso o slot atual permanece intacto.
    static bool performUpdate(const std::string& firmwareUrl,
                              void (*onProgress)(int percent) = nullptr);

    // Encerra o app JS aberto antes de gravar o slot OTA pelos caminhos que
    // rodam COM app na frente (celerctl ota push, upload web /update): o app
    // pesado disputa flash/PSRAM/CPU com as gravacoes e o enlace UART perde
    // bytes no meio do flash (bancada 2026-10-10: push com Supernova aberto
    // caia 100% em "payload grande demais"; no launcher, limpo). Pede a
    // saida limpa do runtime (mesma porta do "celerctl shell exit") e espera
    // ele ceder; o caminho do hub (System.otaStart) NAO chama — o updater
    // e o app da vez e precisa vivo para desenhar o progresso.
    static void evictRunningApp();

    // Gate para a politica do servico JS (API 42): true com check manual ou
    // task do fetch em curso — o servico nao dispara check em cima de check.
    static bool checkBusy();

private:
    // Corpos de checkForUpdates/performUpdate (a guarda s_busy mora no .cpp)
    static bool runCheck();
    static bool runUpdate(const std::string& firmwareUrl, void (*onProgress)(int percent));
};

#endif // CELEROS_OTA_MANAGER_H
