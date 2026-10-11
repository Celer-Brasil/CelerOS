#include "DebugBridge.h"

#if CONFIG_CELEROS_DEBUG_BRIDGE

#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "nvs.h"

#include "../Boards/Board.h"
#include "HostLink.h"
#include "NetworkManager.h"

#if !defined(CELEROS_VERSION)
#define CELEROS_VERSION "?"
#endif
#if !defined(CELEROS_API_LEVEL)
#define CELEROS_API_LEVEL 0
#endif

namespace {

const char* TAG = "celer.bridge";

constexpr uint16_t kPort = CONFIG_CELEROS_DEBUG_BRIDGE_PORT;
// Chunks em voo anunciados no HELLO (como a USJ): o TCP ainda tem o controle
// de fluxo do lwip (janela de recepcao) segurando o host enquanto o handler
// grava na flash — nada e descartado por excesso de janela.
constexpr uint8_t kWindow = 4;
constexpr int64_t K_AUTH_TIMEOUT_US = 15000000LL;  // 15 s para o AUTH
constexpr uint8_t K_AUTH_MAX_FAILS = 3;

// Handler do evento de rede (task sys_evt) e o service tick so setam flags:
// TODOS os sockets pertencem a task dbg_bridge — nenhum fd e fechado sob o
// select de outra task.
volatile bool s_netUp = false;
volatile bool s_clientOn = false;
TaskHandle_t s_task = nullptr;
HostLink* s_link = nullptr;  // instancia do canal (parser proprio, como UART/CDC)
bool s_roamPaused = false;   // roaming suspenso enquanto ha cliente (radio dedicado)

int s_listenFd = -1;
int s_udpFd = -1;
int s_clientFd = -1;
bool s_authOk = false;
int64_t s_authDeadline = 0;
uint8_t s_authFails = 0;
char s_authLine[96];
size_t s_authLen = 0;

SemaphoreHandle_t s_writeMutex = nullptr;

// ------------------------------------------------ token (NVS celer/*)
// Mesmo formato do WebAuth: 8 chars do alfabeto sem ambiguos (0/O, 1/l/I).
// Carregado no begin() (boot, single-threaded): shell/info/auth so leem.
char s_token[16] = "";
constexpr const char* kAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";
constexpr size_t kTokenLen = 8;

void tokenGenerate() {
    for (size_t i = 0; i < kTokenLen; i++) {
        s_token[i] = kAlphabet[esp_random() % (sizeof(kAlphabet) - 1)];
    }
    s_token[kTokenLen] = '\0';
}

bool tokenPersist() {
    nvs_handle_t h;
    if (nvs_open("celer", NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_str(h, "bridge_token", s_token) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

void tokenLoad() {
    nvs_handle_t h;
    if (nvs_open("celer", NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(s_token);
        bool ok = nvs_get_str(h, "bridge_token", s_token, &len) == ESP_OK && len > 1;
        nvs_close(h);
        if (ok) return;
    }
    tokenGenerate();  // 1a leitura: gera e persiste (NVS fora = vale ate reboot)
    if (!tokenPersist()) ESP_LOGW(TAG, "NVS rejeitou o token (vale ate reiniciar)");
}

// Comparacao em bloco fixo (mesma ideia do MD5 do WebAuth): nao entrega
// timing nem comprimento do segredo.
bool tokenEq(const char* attempt, size_t alen) {
    uint8_t d = 0;
    for (size_t i = 0; i < 32; i++) {
        uint8_t a = i < alen ? (uint8_t)attempt[i] : 0;
        uint8_t b = i < sizeof(s_token) ? (uint8_t)s_token[i] : 0;
        d |= (uint8_t)(a ^ b);
    }
    return d == 0;
}

// --------------------------------------------- escrita TCP (WriteFn)
// Frames de resposta (dispatch na task do bridge) e de logcat/debugger
// (tasks arbitarias via HostLink::sendLogFrame/sendDebugFrame) nunca se
// intercalam: 1 mutex + send() continuo por frame. O SO_SNDTIMEO do socket
// garante que um host parado nao segura a task (nem o mutex) para sempre.
bool tcpWrite(const uint8_t* data, size_t len) {
    int fd = s_clientFd;
    if (fd < 0 || !s_authOk) return false;
    if (s_writeMutex != nullptr && xSemaphoreTake(s_writeMutex, pdMS_TO_TICKS(1000)) != pdTRUE) {
        return false;
    }
    size_t off = 0;
    bool ok = true;
    while (off < len) {
        int n = send(fd, data + off, len - off, 0);
        if (n <= 0) {
            ok = false;
            break;
        }
        off += (size_t)n;
    }
    if (s_writeMutex != nullptr) xSemaphoreGive(s_writeMutex);
    return ok;
}

// ------------------------------------------------------- ciclo de vida

void closeClient() {
    if (s_clientFd >= 0) {
        close(s_clientFd);
        s_clientFd = -1;
    }
    if (s_roamPaused) {
        // radio de volta ao dono normal (scan de roaming da task de fundo)
        NetworkManager::instance().setRoamingEnabled(true);
        s_roamPaused = false;
    }
    if (s_link != nullptr) s_link->endSession();  // devolve a sessao p/ UART/CDC
    s_authOk = false;
    s_authFails = 0;
    s_authLen = 0;
    s_authLine[0] = '\0';
    s_clientOn = false;
}

void closeListener() {
    closeClient();
    if (s_listenFd >= 0) {
        close(s_listenFd);
        s_listenFd = -1;
    }
    if (s_udpFd >= 0) {
        close(s_udpFd);
        s_udpFd = -1;
    }
}

bool ipNow(char* out, size_t cap) {
    esp_netif_t* netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif == nullptr) return false;
    esp_netif_ip_info_t info;
    if (esp_netif_get_ip_info(netif, &info) != ESP_OK || info.ip.addr == 0) return false;
    snprintf(out, cap, IPSTR, IP2STR(&info.ip));
    return true;
}

// Identidade estavel do node (MAC STA em 12 hex): viaja NO BANNER e na sonda
// UDP, antes do AUTH. O celerctl casa o token do cache por ela — o DHCP pode
// mudar o IP a vontade que o pareamento sobrevive (bancada 2026-10-11: duas
// placas trocaram de IP e o cache por IP virou lockout com recuperacao so
// por USB). Firmware antigo (sem o campo) apenas nao participa do casamento.
void macId(char* out, size_t cap) {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(out, cap, "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

bool startListener() {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(kPort);

    s_udpFd = socket(AF_INET, SOCK_DGRAM, 0);
    bool ok = s_udpFd >= 0 && bind(s_udpFd, (struct sockaddr*)&addr, sizeof(addr)) == 0;
    if (ok) {
        s_listenFd = socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        setsockopt(s_listenFd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        ok = s_listenFd >= 0 && bind(s_listenFd, (struct sockaddr*)&addr, sizeof(addr)) == 0 &&
             listen(s_listenFd, 1) == 0;
    }
    if (!ok) {
        ESP_LOGE(TAG, "falha ao abrir o listener na porta %u", (unsigned)kPort);
        closeListener();
        return false;
    }
    char ip[16] = "";
    ipNow(ip, sizeof(ip));
    ESP_LOGI(TAG, "bridge no ar em %s:%u (TCP celerctl + UDP sonda)", ip[0] ? ip : "?",
             (unsigned)kPort);
    return true;
}

// Sonda "CELERPROBE1" do celerctl devices: resposta unicast no mesmo formato
// do HELLO — o IP do device e o endereco de origem do proprio datagrama.
// O "|id" no fim e a identidade do node (ver macId): o celerctl re-casa o
// token do cache quando o IP mudou.
void handleProbe() {
    char buf[32];
    struct sockaddr_in from;
    socklen_t flen = sizeof(from);
    int n = recvfrom(s_udpFd, buf, sizeof(buf) - 1, 0, (struct sockaddr*)&from, &flen);
    if (n < (int)11 || memcmp(buf, "CELERPROBE1", 11) != 0) return;
    char id[13];
    macId(id, sizeof(id));
    char out[112];
    int m = snprintf(out, sizeof(out), "CELEROS %s|%s|api %d|proto 2|tcp %u|id %s", CELEROS_VERSION,
                     Board::profile().id, CELEROS_API_LEVEL, (unsigned)kPort, id);
    sendto(s_udpFd, out, (size_t)m, 0, (struct sockaddr*)&from, flen);
}

void handleAccept() {
    struct sockaddr_in peer;
    socklen_t alen = sizeof(peer);
    int fd = accept(s_listenFd, (struct sockaddr*)&peer, &alen);
    if (fd < 0) return;
    if (s_clientFd >= 0) {  // sessao unica: o 2o cliente sabe na hora
        send(fd, "busy\n", 5, 0);
        close(fd);
        return;
    }
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));  // shell/debug sem Nagle
    int tv = 2000;  // ms: TX preso nao segura a task (nem o mutex de escrita)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    char ip[16] = "";
    ipNow(ip, sizeof(ip));
    char id[13];
    macId(id, sizeof(id));
    char banner[128];
    // 5o campo = identidade (macId): pre-AUTH, para o celerctl casar o token
    // do cache mesmo com o IP mudado
    int m = snprintf(banner, sizeof(banner), "CELERBRIDGE 1 %s %s %u %s\n", Board::profile().id,
                     ip[0] ? ip : "?", (unsigned)kPort, id);
    if (send(fd, banner, (size_t)m, 0) != m) {
        close(fd);
        return;
    }

    s_clientFd = fd;
    s_authOk = false;
    s_authFails = 0;
    s_authLen = 0;
    s_authLine[0] = '\0';
    s_authDeadline = esp_timer_get_time() + K_AUTH_TIMEOUT_US;
}

// Linha acumulada ate o \n: "AUTH <token>". NO = tenta de novo (ate 3),
// ERR = 3 erros seguidos, close.
void handleAuthLine() {
    while (s_authLen > 0 && (s_authLine[s_authLen - 1] == '\r')) {
        s_authLine[--s_authLen] = '\0';
    }
    if (s_authLen > 5 && strncmp(s_authLine, "AUTH ", 5) == 0 &&
        tokenEq(s_authLine + 5, s_authLen - 5)) {
        s_authOk = true;
        s_clientOn = true;
        // Cliente com sessao = radio dedicado ao bridge: o scan de roaming da
        // task de fundo tira o radio do canal por ~3,5 s a cada ~30 s e o
        // ota push rastejava nos ACKs (SmartDisplay, bancada 2026-10-05).
        // RAM-only no NetworkManager: restaura no closeClient.
        if (NetworkManager::instance().getConfig().enableRoaming) {
            NetworkManager::instance().setRoamingEnabled(false);
            s_roamPaused = true;
        }
        send(s_clientFd, "OK\n", 3, 0);
        ESP_LOGI(TAG, "cliente bridge autenticado");
        return;
    }
    if (++s_authFails >= K_AUTH_MAX_FAILS) {
        send(s_clientFd, "ERR\n", 4, 0);
        closeClient();
        return;
    }
    send(s_clientFd, "NO\n", 3, 0);
}

void handleClientRx() {
    if (!s_authOk) {
        char buf[64];
        int n = recv(s_clientFd, buf, sizeof(buf), 0);
        if (n <= 0) {
            closeClient();
            return;
        }
        for (int i = 0; i < n; i++) {
            char c = buf[i];
            if (c == '\n') {
                handleAuthLine();
                if (s_clientFd < 0) return;
                s_authLen = 0;
                s_authLine[0] = '\0';
            } else if (s_authLen + 1 < sizeof(s_authLine)) {
                s_authLine[s_authLen++] = c;
                s_authLine[s_authLen] = '\0';
            }
        }
        return;
    }
    uint8_t buf[1024];
    int n = recv(s_clientFd, buf, sizeof(buf), 0);
    if (n <= 0) {
        closeClient();
        return;
    }
    // Maquina byte a byte (mesma alimentacao da UART): o dispatch roda aqui,
    // serializado pelo mutex global do HostLink com os canais UART/CDC.
    for (int i = 0; i < n; i++) s_link->feed(buf[i]);
}

void bridgeTask(void*) {
    // silenceUs=0: o resync por silencio do parser e curativo de UART (ruido
    // cortando frame no meio). Em TCP ele e veneno: uma perda de segmento
    // WiFi volta apos o RTO (300ms+), o parser descartava o frame parcial e
    // os bytes retransmitidos viravam lixo ("payload grande demais" no meio
    // do ota push, bancada 2026-10-05). Integridade vem do CRC32 do proto 2;
    // disconnect limpa o parser via endSession.
    EXT_RAM_BSS_ATTR static HostLink link(&tcpWrite, nullptr, kWindow, 0);
    s_link = &link;
    TickType_t lastTry = 0;

    for (;;) {
        if (s_netUp && s_listenFd < 0) {
            TickType_t now = xTaskGetTickCount();
            if (lastTry == 0 || now - lastTry >= pdMS_TO_TICKS(5000)) {
                lastTry = now;
                startListener();  // falha (porta ocupada?) = retry com folga
            }
        } else if (!s_netUp && s_listenFd >= 0) {
            closeListener();  // caiu o WiFi: mata sessao e sockets; renasce so
        }
        if (s_listenFd < 0) {
            vTaskDelay(pdMS_TO_TICKS(250));
            continue;
        }

        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(s_listenFd, &rfds);
        FD_SET(s_udpFd, &rfds);
        int maxFd = s_udpFd > s_listenFd ? s_udpFd : s_listenFd;
        if (s_clientFd >= 0) {
            FD_SET(s_clientFd, &rfds);
            if (s_clientFd > maxFd) maxFd = s_clientFd;
        }
        struct timeval tv = {0, 200000};  // 200 ms
        if (select(maxFd + 1, &rfds, nullptr, nullptr, &tv) > 0) {
            if (FD_ISSET(s_udpFd, &rfds)) handleProbe();
            if (s_listenFd >= 0 && FD_ISSET(s_listenFd, &rfds)) handleAccept();
            if (s_clientFd >= 0 && FD_ISSET(s_clientFd, &rfds)) {
                handleClientRx();
                // O TCP chega na velocidade do WiFi: sem esta pausa a task
                // (prio 4) processa lote apos lote sem nunca bloquear e
                // inania a main task (prio 1, inscrita no TWDT) — o push de
                // 2,5 MB reiniciava o device no meio pelo watchdog (bancada
                // 2026-10-05). 1 ms por lote de ~1 KB: teto ~1 MB/s, muito
                // acima do que a gravacao na flash acompanha. O lado TX se
                // auto-limita pelo buffer do socket (SO_SNDTIMEO).
                vTaskDelay(1);
            }
        }
        // AUTH que nunca chega = cliente morto segurando o slot unico
        if (s_clientFd >= 0 && !s_authOk && esp_timer_get_time() > s_authDeadline) {
            closeClient();
        }
    }
}

}  // namespace

// ------------------------------------------------------------------- API

void DebugBridge::begin() {
    tokenLoad();  // boot, single-threaded: sem corrida na geracao
    s_writeMutex = xSemaphoreCreateMutex();
    static bool bound = false;
    if (!bound) {
        bound = true;
        NetworkManager::instance().onStateChanged.addHandler(
            [](NetworkState, NetworkState n) { s_netUp = (n == NetworkState::Connected); });
    }
    s_netUp = NetworkManager::instance().isConnected();
}

void DebugBridge::tick(bool) {
    if (!s_netUp || s_task != nullptr) return;
    // Nasce na 1a rede de verdade: placa sem WiFi nunca paga a stack da task.
    // (Com CELEROS_APP_TASK os dois pumps podem chamar tick juntos — a flag
    // estreita a janela e o create duplicado e inofensivo: so uma vence.)
    static volatile bool creating = false;
    static TickType_t failAt = 0;
    if (creating) return;
    TickType_t now = xTaskGetTickCount();
    if (failAt != 0 && now - failAt < pdMS_TO_TICKS(5000)) return;
    creating = true;
    // Stack em RAM INTERNA, sem excecao: o dispatch roda na propria task e
    // os handlers tocam flash (esp_ota_*, LittleFS) — na janela de cache
    // desativado da operacao SPI, stack na PSRAM derruba o device (bancada
    // 2026-10-05: o OTA_BEGIN por WiFi reiniciava o cao). 6144 cobre o pico
    // medido do dispatch (~3,4 KB, watermark do dbg_link); 5120 e o plano B
    // para o heap interno apertado do cao com wakeword (~8 KB livres).
    TaskHandle_t h = nullptr;
    BaseType_t ok = xTaskCreate(bridgeTask, "dbg_bridge", 6144, nullptr, 4, &h);
    if (ok != pdPASS) {
        ok = xTaskCreate(bridgeTask, "dbg_bridge", 5120, nullptr, 4, &h);
    }
    if (ok == pdPASS) {
        s_task = h;
    } else {
        failAt = now;
        ESP_LOGE(TAG, "sem RAM interna para a task do bridge (tento em 5s)");
    }
    creating = false;
}

bool DebugBridge::sessionActive() { return s_clientOn; }

const char* DebugBridge::token() { return s_token; }

bool DebugBridge::tokenSet(const char* t) {
    if (t == nullptr) return false;
    size_t len = strlen(t);
    if (len < 6 || len >= sizeof(s_token)) return false;
    for (size_t i = 0; i < len; i++) {
        char c = t[i];
        if (c <= ' ' || c >= 0x7F) return false;  // sem espacos/controle
    }
    snprintf(s_token, sizeof(s_token), "%s", t);
    if (!tokenPersist()) {
        ESP_LOGW(TAG, "NVS rejeitou o token novo (vale ate reiniciar)");
    }
    return true;  // validacao e persistencia independentes: sessao nova funciona
}

void DebugBridge::tokenReset() {
    // Shell chama (main/app task) fora do caminho do auth: a janela de troca
    // e uma comparacao NO no pior caso — cliente reautentica e passa.
    tokenGenerate();
    if (!tokenPersist()) ESP_LOGW(TAG, "NVS rejeitou o token novo (vale ate reiniciar)");
}

uint16_t DebugBridge::port() { return kPort; }

bool DebugBridge::listening() { return s_listenFd >= 0; }

#else  // CONFIG_CELEROS_DEBUG_BRIDGE

void DebugBridge::begin() {}
void DebugBridge::tick(bool) {}
bool DebugBridge::sessionActive() { return false; }
const char* DebugBridge::token() { return ""; }
bool DebugBridge::tokenSet(const char*) { return false; }
void DebugBridge::tokenReset() {}
uint16_t DebugBridge::port() { return 0; }
bool DebugBridge::listening() { return false; }

#endif  // CONFIG_CELEROS_DEBUG_BRIDGE
