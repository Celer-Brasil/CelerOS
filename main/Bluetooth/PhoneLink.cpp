#include "PhoneLink.h"
#include "CelerLink.h"

#include "../Boards/Board.h"
#include "../Display/Backlight.h"
#include "../Display/ScreenPower.h"
#include "../Display/Theme.h"
#include "../FileSystem/FileSystem.h"
#include "../Hardware/BoardIO.h"
#include "../Kernel/Notifications.h"
#include "../Kernel/TimeManager.h"
#include "../UI/Kui.h"
#include "../Utils/CelerSettings.h"
#include "../Utils/Settings.h"
#include "../Utils/GbProto.h"
#include "../Launcher/LauncherUI.h"

// packageName do app JS corrente (JSBindings.cpp)
extern std::string s_appPkg;

#include <ArduinoJson.h>
#include <Arduino.h>
#include <deque>
#include <mutex>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_sm.h"
#include "host/ble_store.h"
#include "host/ble_uuid.h"

namespace {

const char* TAG = "celer.phone";

// Nordic UART Service (o "Bangle.js" do Gadgetbridge)
//   servico 6e400001-b5a3-f393-e0a9-e50e24dcca9e
//   RX      6e400002-...  (celular escreve)
//   TX      6e400003-...  (relogio notifica)
const ble_uuid128_t kNusSvc = BLE_UUID128_INIT(0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
                                               0x93, 0xf3, 0xa3, 0xb5, 0x01, 0x00, 0x40, 0x6e);
const ble_uuid128_t kNusRx = BLE_UUID128_INIT(0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
                                              0x93, 0xf3, 0xa3, 0xb5, 0x02, 0x00, 0x40, 0x6e);
const ble_uuid128_t kNusTx = BLE_UUID128_INIT(0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0,
                                              0x93, 0xf3, 0xa3, 0xb5, 0x03, 0x00, 0x40, 0x6e);

constexpr size_t kMaxLine = 1024;
constexpr size_t kMaxQueued = 16;
constexpr uint32_t kStatusEveryMs = 600000;  // bateria/passos a cada 10 min
constexpr uint32_t kFindMs = 30000;          // "encontrar relogio" toca ate 30 s

uint16_t s_rxHandle = 0;
uint16_t s_txHandle = 0;

volatile bool s_enabled = false;
volatile bool s_conn = false;
volatile uint16_t s_connHandle = 0;
volatile bool s_encrypted = false;
volatile bool s_subscribed = false;
volatile uint16_t s_mtu = 23;
volatile uint32_t s_passkey = 0;
volatile bool s_greet = false;  // conexao pronta: manda o status inicial

// Backoff do advertising: o Gadgetbridge reconecta em laco depois de uma
// queda (bond velho, pareamento recusado). Re-anunciar na hora alimenta a
// tempestade; uma espera crescente da tempo do Android limpar o bond e
// evita um CONNECT/DISCONNECT (com eventos de SM) por centenas de ms.
volatile uint32_t s_connAtMs = 0;      // inicio da conexao corrente
volatile uint32_t s_advHoldUntil = 0;  // 0/passado = pode anunciar
volatile uint8_t s_rapidDrops = 0;     // quedas com < 3 s de conexao
volatile uint32_t s_secRetryAt = 0;    // re-tenta security_initiate no tick
volatile uint8_t s_secRetries = 0;
volatile uint32_t s_passkeyAt = 0;     // quando o codigo apareceu

char s_advName[24] = {0};

std::mutex s_mux;  // fila de linhas + estado de musica/clima
std::deque<std::string> s_lines;
celer::gb::LineAssembler s_asm(kMaxLine);
PhoneLink::Music s_music;
bool s_hasMusic = false;
PhoneLink::Weather s_weather;
bool s_hasWeather = false;

uint32_t s_findUntil = 0;
uint32_t s_findBeepAt = 0;
uint32_t s_findActivity = 0;
uint32_t s_statusAt = 0;
int32_t s_lastSteps = -1;
int s_lastPct = -1;          // bateria do ultimo status enviado
int s_lastChg = -1;
volatile bool s_actNow = false;  // celular pediu passos agora ("act")

// Chamada recebida (CallScreen): preenchido no tick, lido pela UI
bool s_callActive = false;
std::string s_callName, s_callNumber;
// Dispensas feitas no relogio, enviadas no tick (callback vem da UI)
std::deque<uint32_t> s_dismiss;
bool s_dismissAll = false;

// ------------------------------------------------------------- GATT (host) --

int onRxAccess(uint16_t conn, uint16_t attr, ble_gatt_access_ctxt* ctxt, void* arg) {
    (void)conn;
    (void)attr;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    uint8_t buf[256];
    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    if (len > sizeof(buf)) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    uint16_t got = 0;
    if (ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &got) != 0) return BLE_ATT_ERR_UNLIKELY;
    std::lock_guard<std::mutex> lock(s_mux);
    s_asm.feed(buf, got, [](const std::string& line) {
        if (s_lines.size() >= kMaxQueued) s_lines.pop_front();  // mais nova vale mais
        s_lines.push_back(line);
    });
    return 0;
}

int onTxAccess(uint16_t, uint16_t, ble_gatt_access_ctxt*, void*) { return BLE_ATT_ERR_UNLIKELY; }

// RX/TX exigem enlace criptografado e autenticado (MITM): o Android pede o
// pareamento sozinho na primeira escrita e o usuario digita o codigo que o
// relogio mostra. Ordem posicional de ble_gatt_chr_def (ver CelerLink.cpp).
const struct ble_gatt_chr_def kChrDefs[] = {
    {&kNusRx.u, onRxAccess, nullptr, nullptr,
     BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_WRITE_ENC |
         BLE_GATT_CHR_F_WRITE_AUTHEN,
     0, &s_rxHandle, nullptr},
    {&kNusTx.u, onTxAccess, nullptr, nullptr, BLE_GATT_CHR_F_NOTIFY, 0, &s_txHandle, nullptr},
    {},
};

const struct ble_gatt_svc_def kSvcDefs[] = {
    {BLE_GATT_SVC_TYPE_PRIMARY, &kNusSvc.u, nullptr, kChrDefs},
    {},
};

// ------------------------------------------------------------- envio ---------

bool sendRaw(const std::string& line) {
    if (!s_conn || !s_encrypted || !s_subscribed) return false;
    const size_t chunk = s_mtu > 3 ? (size_t)(s_mtu - 3) : 20;
    size_t off = 0;
    while (off < line.size()) {
        size_t n = line.size() - off < chunk ? line.size() - off : chunk;
        int rc = BLE_HS_ENOMEM;
        // Orcamento de 20 ms por chunk: send() roda no pump (UI/app) e a
        // espera antiga (20 x 5 ms por chunk) congelava a tela por ate 5 s
        // numa linha de 1 KB com o MTU default. Sem buffer, melhor perder a
        // linha (o proximo status re-sincroniza) do que travar o loop.
        const uint32_t until = millis() + 20;
        for (int tries = 0; tries < 20; tries++) {
            struct os_mbuf* om = ble_hs_mbuf_from_flat(line.data() + off, (uint16_t)n);
            rc = om == nullptr ? BLE_HS_ENOMEM : ble_gatts_notify_custom(s_connHandle, s_txHandle, om);
            if (rc == 0 || (rc != BLE_HS_ENOMEM && rc != BLE_HS_EBUSY)) break;
            if ((int32_t)(millis() - until) >= 0) break;
            vTaskDelay(pdMS_TO_TICKS(2));
        }
        if (rc != 0) {
            ESP_LOGW(TAG, "notify rc=%d", rc);
            // Ressincroniza o montador de linhas do celular: os chunks ja no
            // ar ficaram SEM o '\n' final e o fragmento orfao grudaria na
            // proxima mensagem (as duas se perdiam). Um '\n' solto encerra a
            // linha mutilada; melhor esforco — se tambem falhar, nao ha mais
            // o que fazer por aqui.
            struct os_mbuf* om = ble_hs_mbuf_from_flat("\n", 1);
            if (om != nullptr) ble_gatts_notify_custom(s_connHandle, s_txHandle, om);
            return false;
        }
        off += n;
    }
    return true;
}

void sendBattery() {
    const int pct = BoardIO::batteryPct();
    const int st = BoardIO::chargeState();
    const int mv = BoardIO::batteryMv();
    const int chg = (st > 0 && (st & 1)) ? 1 : 0;
    char b[80];
    snprintf(b, sizeof(b), "{\"t\":\"status\",\"bat\":%d,\"volt\":%d.%02d,\"chg\":%d}",
             pct < 0 ? 0 : pct, mv > 0 ? mv / 1000 : 0, mv > 0 ? (mv % 1000) / 10 : 0, chg);
    if (PhoneLink::send(b)) {
        s_lastPct = pct;
        s_lastChg = chg;
    }
}

// Firmware/hardware para a tela do dispositivo no Gadgetbridge
void sendVersion() {
    std::string j = "{\"t\":\"ver\",\"fw\":";
    j += celer::gb::jsonStr(std::string("CelerOS ") + CELEROS_VERSION);
    j += ",\"hw\":";
    j += celer::gb::jsonStr(Board::profile().id);
    j += "}";
    PhoneLink::send(j);
}

void sendSteps() {
    const BoardProfile& bp = Board::profile();
    if (bp.imuSteps) {
        // Gadgetbridge soma: manda o delta desde o ultimo envio
        int32_t now = bp.imuSteps();
        int32_t delta = (s_lastSteps < 0 || now < s_lastSteps) ? now : now - s_lastSteps;
        s_lastSteps = now;
        char b[48];
        snprintf(b, sizeof(b), "{\"t\":\"act\",\"stp\":%ld}", (long)delta);
        PhoneLink::send(b);
    }
}

void sendStatus() {
    sendBattery();
    sendSteps();
}

// ------------------------------------------------------------- recepcao ------

std::string str(JsonVariantConst v) {
    const char* s = v.as<const char*>();
    return s ? std::string(s) : std::string();
}

void saveWeather() {
    char b[160];
    snprintf(b, sizeof(b), "%.1f|%d|%lld|%s|%s", s_weather.tempC, s_weather.hum,
             (long long)s_weather.at, s_weather.txt.substr(0, 40).c_str(),
             s_weather.loc.substr(0, 40).c_str());
    FileSystem::writeTextFile("/local/weather.txt", b);
}

void loadWeather() {
    std::string w = FileSystem::readTextFile("/local/weather.txt");
    if (w.empty()) return;
    float t = 0;
    int hum = -1;
    long long at = 0;
    if (sscanf(w.c_str(), "%f|%d|%lld|", &t, &hum, &at) != 3) return;
    size_t p = 0;
    for (int i = 0; i < 3 && p != std::string::npos; i++) p = w.find('|', p + 1);
    if (p == std::string::npos) return;
    size_t q = w.find('|', p + 1);
    s_weather.tempC = t;
    s_weather.hum = hum;
    s_weather.at = at;
    s_weather.txt = w.substr(p + 1, q == std::string::npos ? std::string::npos : q - p - 1);
    s_weather.loc = q == std::string::npos ? "" : w.substr(q + 1);
    s_hasWeather = true;
}

void handleGb(const std::string& json) {
    JsonDocument doc;
    if (deserializeJson(doc, json) != DeserializationError::Ok) return;
    const std::string t = str(doc["t"]);
    if (t == "notify") {
        std::string title = str(doc["title"]);
        if (title.empty()) title = str(doc["sender"]);
        if (title.empty()) title = str(doc["src"]);
        std::string body = str(doc["body"]);
        const std::string subj = str(doc["subject"]);
        if (body.empty()) body = subj;
        else if (!subj.empty() && subj != title) body = subj + ": " + body;  // e-mail
        // id do Android e int (pode ser negativo): os 32 bits viram a chave
        Notifications::push(title.empty() ? "Celular" : title, body, "phone:" + str(doc["src"]),
                            (uint32_t)doc["id"].as<int64_t>());
    } else if (t == "notify-") {
        Notifications::removeById((uint32_t)doc["id"].as<int64_t>());
    } else if (t == "call") {
        const std::string cmd = str(doc["cmd"]);
        if (cmd == "incoming") {
            s_callName = celer::gb::latin1Safe(str(doc["name"]), 48);
            s_callNumber = celer::gb::latin1Safe(str(doc["number"]), 24);
            s_callActive = true;  // CallScreen toca e oferece atender/recusar
            Notifications::push("Chamada", s_callName.empty() ? s_callNumber : s_callName, "phone:call", 0);
        } else {
            s_callActive = false;  // end/accept/reject/outgoing/start
        }
    } else if (t == "musicinfo") {
        std::lock_guard<std::mutex> lock(s_mux);
        s_music.artist = celer::gb::latin1Safe(str(doc["artist"]), 64);
        s_music.track = celer::gb::latin1Safe(str(doc["track"]), 64);
        s_music.album = celer::gb::latin1Safe(str(doc["album"]), 64);
        s_hasMusic = true;
    } else if (t == "musicstate") {
        std::lock_guard<std::mutex> lock(s_mux);
        s_music.state = str(doc["state"]);
        s_hasMusic = true;
    } else if (t == "weather") {
        {
            std::lock_guard<std::mutex> lock(s_mux);
            const float k = doc["temp"].as<float>();
            s_weather.tempC = k > 150 ? k - 273.15f : k;  // Gadgetbridge manda Kelvin
            s_weather.hum = doc["hum"] | -1;
            s_weather.txt = celer::gb::latin1Safe(str(doc["txt"]), 40);
            s_weather.loc = celer::gb::latin1Safe(str(doc["loc"]), 40);
            time_t now;
            time(&now);
            s_weather.at = now;
            s_hasWeather = true;
        }
        saveWeather();
    } else if (t == "act") {
        s_actNow = true;  // Gadgetbridge pediu passos agora (tempo real)
    } else if (t == "vibrate") {
        // sem motor: bipes no lugar do padrao de vibracao (fora do tick:
        // tone() bloqueante congelava o pump por ~280 ms)
        for (int i = 0; i < 2; i++) BoardIO::toneAsync(1800, 80, 60);
    } else if (t == "find") {
        if (doc["n"].as<bool>()) {
            s_findUntil = millis() + kFindMs;
            s_findActivity = Backlight::lastActivity();
            ScreenPower::requestGlance(false);
        } else {
            s_findUntil = 0;
        }
    }
}

void handleLine(const std::string& line) {
    const celer::gb::Line l = celer::gb::classify(line);
    if (l.kind == celer::gb::Kind::Gb) {
        handleGb(l.json);
    } else if (l.kind == celer::gb::Kind::SetTime) {
        if (l.hasTz) TimeManager::setTimezone(celer::gb::tzPosix(l.tzHours));
        TimeManager::setEpoch((time_t)l.epoch);
        ESP_LOGI(TAG, "hora do celular: %lld (fuso %s%.1f)", (long long)l.epoch,
                 l.hasTz ? "" : "sem ", l.hasTz ? l.tzHours : 0.0f);
    }
}

// Notifications::setOnDismiss: enfileira (o envio sai no tick)
void onDismiss(uint32_t id, bool all) {
    std::lock_guard<std::mutex> lock(s_mux);
    if (all) {
        s_dismissAll = true;
        s_dismiss.clear();
    } else if (s_dismiss.size() < 16) {
        s_dismiss.push_back(id);
    }
}

void defaultName() {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_BT);
    // "Bangle.js" no prefixo: e assim que o Gadgetbridge reconhece o tipo
    snprintf(s_advName, sizeof(s_advName), "Bangle.js %02x%02x", mac[4], mac[5]);
}

}  // namespace

namespace PhoneLink {

// ---- lado UI ----------------------------------------------------------------

void init() {
    defaultName();
    loadWeather();
    s_enabled = Settings::getBool("phone_on", true);
    Notifications::setOnDismiss(onDismiss);
    // O BLE sobe no tick, ~8 s depois do boot: o WiFi (startAsync) pega a
    // RAM interna primeiro e, se o NimBLE falhar, o USB/logcat ja esta no ar
}

namespace {
bool s_bleUp = false;
uint32_t s_bleNextTryMs = 0;
volatile bool s_forgetPending = false;  // forget pedido antes do NimBLE subir
}

static void bringUpBle() {
    if (s_bleUp || !s_enabled) return;
    const uint32_t now = millis();
    if (now < 8000 || now < s_bleNextTryMs) return;
    // Sem latch: o gate de RAM interna e barato de reconferir a cada 10 s —
    // quando o WiFi soltar a interna o BLE sobe. No boot apertado do watch
    // (WiFi comecando) a tentativa unica perdia por <1 KB e o BLE morria
    // pela sessao inteira (bancada 2026-10-06: 38,0 K livres x 38,9 K).
    if (CelerLink::ensureStarted(false)) {
        s_bleUp = true;
        // forget com o host ainda fora do ar (RAM apertada no boot, Phone
        // desligado): apaga agora que o store existe, ANTES de anunciar.
        if (s_forgetPending) {
            s_forgetPending = false;
            ble_store_clear();
            ESP_LOGI(TAG, "forget pendente aplicado (bonds apagados)");
        }
        CelerLink::refreshAdvertising();
        ESP_LOGI(TAG, "Phone Link no ar (\"%s\", Gadgetbridge: Bangle.js)", s_advName);
    } else {
        ESP_LOGW(TAG, "Phone Link sem BLE ainda (RAM interna); tenta de novo em 10 s");
        s_bleNextTryMs = now + 10000;
    }
}

void tick(bool inApp) {
    bringUpBle();
    if (inApp && (s_callActive || (s_passkey != 0 && s_appPkg != "celeros.celular"))) {
        LauncherUI::requestAppExit();  // CallScreen/PairScreen no launcher
    }
    // linhas recebidas (no maximo algumas por chamada: present() e quente)
    for (int i = 0; i < 4; i++) {
        std::string line;
        {
            std::lock_guard<std::mutex> lock(s_mux);
            if (s_lines.empty()) break;
            line.swap(s_lines.front());
            s_lines.pop_front();
        }
        handleLine(line);
    }
    const uint32_t now = millis();
    // Enlace de pe mas sem criptografia: re-tenta o security request. Se o
    // primeiro pedido se perdeu (EBUSY na conexao, celular ainda subindo o
    // perfil), o link ficava mudo para sempre — conectado, sem canal, e o
    // anuncio parado (o Gadgetbridge acha que esta tudo bem). Teto de 5
    // tentativas para nao virar enxurrada de eventos de SM.
    if (s_conn && !s_encrypted && s_passkey == 0 && s_secRetryAt != 0 &&
        (int32_t)(now - s_secRetryAt) >= 0) {
        s_secRetryAt = 0;
        // 60 s de enlace sem criptografia e sem codigo na tela: nem o
        // pareamento mais lento leva isso. O enlace mudo nao serve para
        // nada e segura o unico slot (o anuncio fica parado e o
        // Gadgetbridge "acha" que esta conectado).
        const bool tooLong = s_connAtMs != 0 && now - s_connAtMs > 60000;
        if (tooLong || s_secRetries >= 5) {
            ESP_LOGW(TAG, "enlace sem criptografia (%s): derrubando",
                     tooLong ? "60 s" : "5 pedidos");
            // Mesmo caminho do forget: derruba e, se o handle ja sumiu,
            // limpa o estado do CelerLink (senao o anuncio nao volta).
            CelerLink::dropPhone();
        } else {
            int rc = ble_gap_security_initiate(s_connHandle);
            if (rc == BLE_HS_EALREADY) {
                // Ja existe procedimento SM em andamento (inclusive o
                // passkey na tela): nao conta tentativa, so confere depois.
                s_secRetryAt = now + 5000;
            } else {
                s_secRetries = s_secRetries + 1;
                // Mesmo com rc=0 o pedido pode ter sido ignorado pelo
                // celular: confere de novo em 3 s (ENC_CHANGE cancela).
                s_secRetryAt = now + (rc == 0 ? 3000 : 1500);
                if (rc != 0) ESP_LOGD(TAG, "security_initiate rc=%d (tenta de novo)", rc);
            }
        }
    }
    // Codigo de pareamento orfao (o SM desistiu sem ENC_CHANGE): a PairScreen
    // ficaria presa na tela para sempre.
    if (s_passkey != 0 && now - s_passkeyAt > 120000) s_passkey = 0;
    if (s_greet) {
        s_greet = false;
        s_statusAt = now;
        sendVersion();
        sendStatus();
    } else if (connected()) {
        if (now - s_statusAt >= kStatusEveryMs) {
            s_statusAt = now;
            sendStatus();
        } else if (now - s_statusAt >= 30000) {
            // bateria mudou de verdade (5% ou plugou/desplugou): avisa antes
            const int pct = BoardIO::batteryPct();
            const int st = BoardIO::chargeState();
            const int chg = (st > 0 && (st & 1)) ? 1 : 0;
            if (chg != s_lastChg || (pct >= 0 && abs(pct - s_lastPct) >= 5)) {
                s_statusAt = now;
                sendBattery();
            }
        }
        if (s_actNow) {
            s_actNow = false;
            sendSteps();
        }
        // dispensas feitas no relogio somem no Android tambem
        std::deque<uint32_t> ids;
        bool all = false;
        {
            std::lock_guard<std::mutex> lock(s_mux);
            ids.swap(s_dismiss);
            all = s_dismissAll;
            s_dismissAll = false;
        }
        if (all) send("{\"t\":\"notify\",\"id\":0,\"n\":\"DISMISS_ALL\"}");
        for (uint32_t id : ids) {
            char b[64];
            snprintf(b, sizeof(b), "{\"t\":\"notify\",\"id\":%ld,\"n\":\"DISMISS\"}", (long)(int32_t)id);
            send(b);
        }
    }
    if (!s_conn) s_callActive = false;  // caiu o link: nao fica tocando
    // Rede de seguranca do advertising: o re-anuncio e dirigido por eventos
    // (DISCONNECT, ADV_COMPLETE do burst da malha, onSync) e um pedido pode
    // se perder na disputa pelo radio. Com o link ocioso e NADA no ar,
    // re-pede o ar (no maximo 1x/s); ble_gap_adv_active() e leitura atomica.
    if (s_bleUp && s_enabled && !s_conn && !CelerLink::listening() && !CelerLink::linkActive()) {
        static uint32_t s_advHealMs = 0;
        if ((int32_t)(now - s_advHoldUntil) >= 0 && !ble_gap_adv_active() &&
            now - s_advHealMs >= 1000) {
            s_advHealMs = now;
            CelerLink::refreshAdvertising();
        }
    }
    // "encontrar relogio" / chamada: bipa ate o prazo ou um toque
    if (s_findUntil != 0) {
        if ((int32_t)(now - s_findUntil) >= 0 || Backlight::lastActivity() != s_findActivity) {
            s_findUntil = 0;
        } else if (now - s_findBeepAt >= 1000) {
            s_findBeepAt = now;
            BoardIO::toneAsync(2200, 150);
        }
    }
}

bool enabled() { return s_enabled; }

void setEnabled(bool on) {
    s_enabled = on;
    // "0" explicito, nao o setBool do Settings: ele APAGA a chave em false,
    // e phone_on tem default true — apagada, a leitura volta true e o Phone
    // Link "ressuscitava" a cada boot depois de o usuario desligar.
    // (parseBool do Settings le "0" como false; o leitor antigo == "1" idem.)
    CelerSettings::set("phone_on", on ? "1" : "0");
    if (on) {
        s_bleUp = false;  // o proximo tick sobe/re-anuncia
        s_advHoldUntil = 0;
        s_rapidDrops = 0;
    } else {
        CelerLink::dropPhone();
    }
}

bool connected() { return s_conn && s_encrypted; }

uint32_t passkey() { return s_passkey; }

bool send(const std::string& json) { return sendRaw(json + "\n"); }

bool sendMusic(const char* cmd) {
    return send(std::string("{\"t\":\"music\",\"n\":") + celer::gb::jsonStr(cmd) + "}");
}

bool findPhone(bool on) {
    return send(std::string("{\"t\":\"findPhone\",\"n\":") + (on ? "true" : "false") + "}");
}

void injectLine(const std::string& line) {
    // mesma protecao do LineAssembler: linha maior que o limite e cortada
    std::string l = line.size() > kMaxLine ? line.substr(0, kMaxLine) : line;
    std::lock_guard<std::mutex> lock(s_mux);
    if (s_lines.size() >= kMaxQueued) s_lines.pop_front();
    s_lines.push_back(l);
}

bool callInfo(std::string& name, std::string& number) {
    if (!s_callActive) return false;
    name = s_callName;
    number = s_callNumber;
    return true;
}

void callAnswer(int action) {
    static const char* const kN[] = {"REJECT", "ACCEPT", "IGNORE"};
    if (action < 0 || action > 2) return;
    send(std::string("{\"t\":\"call\",\"n\":\"") + kN[action] + "\"}");
    s_callActive = false;
}

void forget() {
    // Ordem importa: para o anuncio do celular (o Android nao reconecta
    // enquanto ele nao estiver no ar), derruba o enlace e so entao apaga a
    // seguranca. Sem o terminate, um enlace que nunca chegou a criptografar
    // (ENC_CHANGE falho) continuava de pe segurando o unico slot: o
    // advertising conectavel nao voltava e o Gadgetbridge ficava num laco de
    // reconexao surda.
    CelerLink::dropPhone();
    // dropPhone pode ter deixado o estado local preso se o terminate nao
    // encontrou o handle (ver CelerLink::dropPhone); este terminate direto
    // cobre a divergencia entre os dois lados.
    if (s_conn && ble_gap_terminate(s_connHandle, BLE_ERR_REM_USER_CONN_TERM) == 0) {
        ESP_LOGI(TAG, "enlace do celular derrubado no forget");
    }
    s_rapidDrops = 0;
    s_advHoldUntil = 0;
    s_passkey = 0;
    s_greet = false;
    if (CelerLink::started()) {
        ble_store_clear();  // bonds/CCCDs do NimBLE (o celular tambem precisa esquecer)
        // Se nao havia conexao (ou o DISCONNECT ja chegou), recoloca o
        // anuncio agora; com o enlace ainda de pe o DISCONNECT faz isso.
        CelerLink::refreshAdvertising();
    } else {
        // NimBLE ainda nao subiu: o store nao existe. Aplica no bringUpBle,
        // ANTES de o advertising comecar (senao o bond velho voltaria).
        s_forgetPending = true;
    }
    s_bleUp = false;  // o proximo tick re-anuncia (ou sobe o host)
    ESP_LOGI(TAG, "pareamento com o celular apagado");
}

bool music(Music& out) {
    std::lock_guard<std::mutex> lock(s_mux);
    if (!s_hasMusic) return false;
    out = s_music;
    return true;
}

bool weather(Weather& out) {
    std::lock_guard<std::mutex> lock(s_mux);
    if (!s_hasWeather) return false;
    out = s_weather;
    return true;
}

// ---- lado BLE (task do host) ------------------------------------------------

const ble_gatt_svc_def* gattServices() { return kSvcDefs; }

const char* advName() {
    if (s_advName[0] == '\0') defaultName();
    return s_advName;
}

const void* advUuid128() { return &kNusSvc; }

bool wantAdvertise() {
    if (!s_enabled || s_conn) return false;
    return (int32_t)(millis() - s_advHoldUntil) >= 0;
}

void onConnect(uint16_t conn) {
    s_conn = true;
    s_connHandle = conn;
    s_encrypted = false;
    s_subscribed = false;
    s_mtu = 23;
    s_connAtMs = millis();
    s_secRetries = 0;
    s_secRetryAt = 0;
    {
        std::lock_guard<std::mutex> lock(s_mux);
        s_asm.reset();
    }
    // bond existente: pede a criptografia ja (sem esperar a 1a escrita).
    // Se o pedido falhar (EBUSY enquanto a conexao assenta) ou for ignorado,
    // o tick re-tenta e, apos 5 tentativas sem ENC_CHANGE, derruba o enlace
    // mudo — sem isso ele ficava de pe segurando o unico slot para sempre.
    int rc = ble_gap_security_initiate(conn);
    s_secRetryAt = s_connAtMs + (rc == 0 ? 3000 : 300);
    if (rc != 0) ESP_LOGW(TAG, "security_initiate rc=%d (re-tenta no tick)", rc);
    ESP_LOGI(TAG, "celular conectou (conn=%u)", conn);
}

void onDisconnect() {
    const uint32_t now = millis();
    const uint32_t lived = now - s_connAtMs;
    s_conn = false;
    s_encrypted = false;
    s_subscribed = false;
    s_passkey = 0;
    s_greet = false;
    s_secRetryAt = 0;
    s_secRetries = 0;
    // Backoff: conexao que morre em < 3 s e retry storm (bond velho no
    // Android, pareamento recusado). A 1a queda ainda re-anuncia na hora (o
    // caso comum e o celular ter se afastado); da 2a em diante espera
    // 1, 2, 4... ate 8 s, dando tempo do Android limpar o bond.
    if (s_connAtMs != 0 && lived < 3000) {
        if (s_rapidDrops < 6) s_rapidDrops = s_rapidDrops + 1;
    } else {
        s_rapidDrops = 0;
    }
    if (s_rapidDrops > 1) {
        uint32_t hold = 1000u << (s_rapidDrops - 2);
        if (hold > 8000) hold = 8000;
        s_advHoldUntil = now + hold;
        ESP_LOGW(TAG, "quedas rapidas seguidas (%u): re-anuncia em %u ms", s_rapidDrops,
                 (unsigned)hold);
    }
    s_connAtMs = 0;
    ESP_LOGI(TAG, "celular desconectou");
}

void onSubscribe(uint16_t attr, bool notify) {
    if (attr != s_txHandle) return;
    s_subscribed = notify;
    if (notify && s_encrypted) s_greet = true;
}

void onMtu(uint16_t mtu) { s_mtu = mtu; }

int onGapSecurity(ble_gap_event* event) {
    // So o enlace do celular: um evento de seguranca de link de app (nao
    // roteado para ca, mas defensivo) nao pode acender s_encrypted nem
    // derrubar a conexao errada.
    const uint16_t evConn =
        event->type == BLE_GAP_EVENT_PASSKEY_ACTION ? event->passkey.conn_handle :
        event->type == BLE_GAP_EVENT_ENC_CHANGE    ? event->enc_change.conn_handle :
        event->type == BLE_GAP_EVENT_REPEAT_PAIRING ? event->repeat_pairing.conn_handle : 0;
    if (!s_conn || evConn != s_connHandle) return 0;

    switch (event->type) {
        case BLE_GAP_EVENT_PASSKEY_ACTION: {
            if (event->passkey.params.action != BLE_SM_IOACT_DISP) return 0;
            struct ble_sm_io pk;
            memset(&pk, 0, sizeof(pk));
            pk.action = BLE_SM_IOACT_DISP;
            pk.passkey = 100000 + esp_random() % 900000;
            s_passkey = pk.passkey;
            s_passkeyAt = millis();
            ble_sm_inject_io(event->passkey.conn_handle, &pk);
            // So os digitos: o toast e estreito no watch e cortava o codigo
            // o codigo aparece GRANDE na PairScreen (PhoneScreens::service)
            ScreenPower::requestGlance(true);
            ESP_LOGI(TAG, "pareamento: codigo exibido na tela");
            return 0;
        }
        case BLE_GAP_EVENT_ENC_CHANGE:
            s_passkey = 0;
            s_secRetryAt = 0;
            s_secRetries = 0;
            if (event->enc_change.status == 0) {
                s_encrypted = true;
                if (s_subscribed) s_greet = true;
                ESP_LOGI(TAG, "enlace criptografado");
            } else {
                s_encrypted = false;
                ESP_LOGW(TAG, "criptografia falhou (status=%d)", event->enc_change.status);
                // Derruba a conexao MUDA: mantida aberta, o Gadgetbridge nao
                // refaz o pareamento (o enlace existe, so nao criptografa) e
                // fica num laco de reconexao surdo. O DISCONNECT limpa o
                // estado e re-anuncia; o backoff do onDisconnect evita a
                // tempestade de reconexao imediata.
                ble_gap_terminate(event->enc_change.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
            }
            return 0;
        case BLE_GAP_EVENT_REPEAT_PAIRING: {
            // celular esqueceu o bond e quer parear de novo: apaga o antigo
            struct ble_gap_conn_desc desc;
            if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc) == 0) {
                ble_store_util_delete_peer(&desc.peer_id_addr);
            }
            return BLE_GAP_REPEAT_PAIRING_RETRY;
        }
        default:
            return 0;
    }
}

}  // namespace PhoneLink
