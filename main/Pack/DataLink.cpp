#include "DataLink.h"

#include <new>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_now.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/ringbuf.h"
#include "freertos/semphr.h"

#include "NetworkManager.h"
#include "../Bluetooth/NetFrame.h"
#include "../Bluetooth/NetKeys.h"
#include "WifiConnection.h"
#include "../USBDevice/LogSink.h"

// Plano de dados ESP-NOW (ver DataLink.h).

namespace DataLink {
namespace {

const char* TAG = "celer.dlink";

constexpr uint8_t MAGIC0 = 'C', MAGIC1 = 'D', VER = 2;
// RX: 24 KB na PSRAM = ~16 quadros cheios ou centenas de curtos; cheio
// descarta o novo (o stream e tempo real: atraso pior que perda)
constexpr size_t RX_RING = 24 * 1024;

bool s_up = false;
bool s_failed = false;
RingbufHandle_t s_rx = nullptr;
StaticRingbuffer_t* s_rxStruct = nullptr;
uint8_t* s_rxBuf = nullptr;
// contadores de bancada (escritos pela task do WiFi e pela do servico: perder
// uma contagem numa corrida nao importa)
uint32_t s_tx = 0, s_txFail = 0, s_txNoMem = 0, s_rxN = 0, s_rxDropped = 0, s_rxForeign = 0;
uint32_t s_rxAuthFail = 0, s_rxReplay = 0;
int s_holds = 0;
// Enviadores: o tick dos recursos e a task da fonte de audio (mic) — o
// quadro de montagem e a tabela de pares sao compartilhados
SemaphoreHandle_t s_txLock = nullptr;
uint8_t* s_txFrame = nullptr;  // quadro de montagem (PSRAM: fora do .bss interno)
uint8_t* s_txPlain = nullptr;  // texto claro do quadro (cifrado para s_txFrame)
uint8_t s_myMac[6] = {0};      // origem no nonce (MAC STA)
// RX: decifra em pollWait (task res_rx / servico) sob s_rxLock
SemaphoreHandle_t s_rxLock = nullptr;
uint8_t* s_rxPlain = nullptr;
// anti-replay por (rede, MAC); 16 pares (PSRAM)
netframe::Rpl<16, uint64_t>* s_rpl = nullptr;

uint64_t macKey(const uint8_t m[6]) {
    uint64_t k = 0;
    for (int i = 0; i < 6; i++) k = (k << 8) | m[i];
    return k;
}

void nonceFor(const uint8_t mac[6], uint32_t seq, uint8_t n[13]) {
    n[0] = 0x01;  // 0x00 e o quadro da malha BLE (NetFrame): espacos disjuntos
    memcpy(n + 1, mac, 6);
    n[7] = (uint8_t)(seq >> 24);
    n[8] = (uint8_t)(seq >> 16);
    n[9] = (uint8_t)(seq >> 8);
    n[10] = (uint8_t)seq;
    n[11] = 0;
    n[12] = 0;
}

// item no ring: cabecalho fixo + dados
struct RxHead {
    uint8_t mac[6];
    int8_t rssi;
    uint8_t pad;
    uint16_t len;  // do quadro inteiro (com HDR)
};

void onRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
    if (info == nullptr || data == nullptr || len < (int)HDR || len > (int)FRAME_MAX) return;
    if (data[0] != MAGIC0 || data[1] != MAGIC1 || data[2] != VER) {
        // inclui o DataLink v1 (firmware anterior a CelerNet v3)
        s_rxForeign++;  // ESP-NOW de outra aplicacao no mesmo canal
        return;
    }
    if (s_rx == nullptr) return;
    uint8_t* item = nullptr;
    // reserva + copia: um memcpy so (sem quadro temporario na pilha do WiFi)
    if (xRingbufferSendAcquire(s_rx, (void**)&item, sizeof(RxHead) + len, 0) != pdTRUE) {
        s_rxDropped++;
        return;
    }
    RxHead h;
    memcpy(h.mac, info->src_addr, 6);
    h.rssi = info->rx_ctrl != nullptr ? (int8_t)info->rx_ctrl->rssi : 0;
    h.pad = 0;
    h.len = (uint16_t)len;
    memcpy(item, &h, sizeof(h));
    memcpy(item + sizeof(h), data, len);
    xRingbufferSendComplete(s_rx, item);
    s_rxN++;
}

// ---- taxa adaptativa por par -------------------------------------------
// 24 Mbps OFDM e otimo com sinal forte (4848 <-> relogio: ~65 KB/s por
// sentido, 99%+), mas a esp32-cam (antena de PCB, ~-85 dBm do relogio)
// perdia a maioria dos blocos de 1,4 KB: a foto de 51 KB nao fechava nem com
// 147 reenvios (bancada 2026-10-11). Cada par desce 24 -> 12 -> 6 -> 2 -> 1
// Mbps quando mais de 25% dos envios ficam sem ACK do MAC, e sobe de volta
// com o enlace limpo (< 5%). Broadcast (sem ACK) sai sempre a 1 Mbps: e
// pouco (HELLO, controle) e precisa do maior alcance.
struct RateStep {
    wifi_phy_mode_t mode;
    wifi_phy_rate_t rate;
    const char* name;
};
const RateStep kRates[] = {
    {WIFI_PHY_MODE_11G, WIFI_PHY_RATE_24M, "24M"}, {WIFI_PHY_MODE_11G, WIFI_PHY_RATE_12M, "12M"},
    {WIFI_PHY_MODE_11G, WIFI_PHY_RATE_6M, "6M"},   {WIFI_PHY_MODE_11B, WIFI_PHY_RATE_2M_L, "2M"},
    {WIFI_PHY_MODE_11B, WIFI_PHY_RATE_1M_L, "1M"},
};
constexpr int kRateN = sizeof(kRates) / sizeof(kRates[0]);
constexpr uint16_t K_RATE_WINDOW = 24;  // envios por avaliacao

struct PeerRate {
    bool used;
    uint8_t mac[6];
    uint8_t idx;
    uint16_t sent, fail;  // sob s_rateMux (callback do WiFi x task que envia)
};
constexpr int PEER_RATES = 8;
PeerRate s_rates[PEER_RATES];
portMUX_TYPE s_rateMux = portMUX_INITIALIZER_UNLOCKED;

bool isBroadcast(const uint8_t mac[6]) {
    return (mac[0] & mac[1] & mac[2] & mac[3] & mac[4] & mac[5]) == 0xFF;
}

void applyRate(const uint8_t mac[6], int idx) {
    esp_now_rate_config_t rc;
    memset(&rc, 0, sizeof(rc));
    rc.phymode = kRates[idx].mode;
    rc.rate = kRates[idx].rate;
    esp_now_set_peer_rate_config(mac, &rc);
}

PeerRate* rateFor(const uint8_t mac[6], bool create) {
    for (int i = 0; i < PEER_RATES; i++) {
        if (s_rates[i].used && memcmp(s_rates[i].mac, mac, 6) == 0) return &s_rates[i];
    }
    if (!create) return nullptr;
    for (int i = 0; i < PEER_RATES; i++) {
        if (!s_rates[i].used) {
            PeerRate* r = &s_rates[i];
            r->used = true;
            memcpy(r->mac, mac, 6);
            r->idx = 0;
            r->sent = r->fail = 0;
            return r;
        }
    }
    s_rates[0] = PeerRate{true, {0}, 0, 0, 0};  // cheia: recicla
    memcpy(s_rates[0].mac, mac, 6);
    return &s_rates[0];
}

// Reavalia a taxa do par depois de uma janela de envios (task de quem envia)
void rateTick(const uint8_t mac[6]) {
    PeerRate* r = rateFor(mac, false);
    if (r == nullptr || r->sent < K_RATE_WINDOW) return;
    portENTER_CRITICAL(&s_rateMux);
    const uint32_t sent = r->sent, fail = r->fail;
    r->sent = r->fail = 0;
    portEXIT_CRITICAL(&s_rateMux);
    int idx = r->idx;
    if (fail * 4 > sent && idx < kRateN - 1) idx++;
    else if (fail * 20 < sent && idx > 0) idx--;
    if (idx == r->idx) return;
    ESP_LOGI(TAG, "par %02X:%02X:%02X: %s -> %s (%u/%u sem ACK)", mac[3], mac[4], mac[5], kRates[r->idx].name,
             kRates[idx].name, (unsigned)fail, (unsigned)sent);
    r->idx = (uint8_t)idx;
    applyRate(mac, idx);
}

void onSent(const esp_now_send_info_t* info, esp_now_send_status_t status) {
    if (status != ESP_NOW_SEND_SUCCESS) s_txFail++;  // sem ACK do MAC do par
    if (info == nullptr || info->des_addr == nullptr) return;
    portENTER_CRITICAL(&s_rateMux);
    PeerRate* r = rateFor(info->des_addr, false);
    if (r != nullptr) {
        r->sent++;
        if (status != ESP_NOW_SEND_SUCCESS) r->fail++;
    }
    portEXIT_CRITICAL(&s_rateMux);
}

bool ensurePeer(const uint8_t mac[6]) {
    if (esp_now_is_peer_exist(mac)) return true;
    esp_now_peer_info_t p;
    memset(&p, 0, sizeof(p));
    memcpy(p.peer_addr, mac, 6);
    p.channel = 0;          // canal corrente do radio (a sessao ja o negociou)
    p.ifidx = WIFI_IF_STA;
    p.encrypt = false;
    esp_err_t err = esp_now_add_peer(&p);
    if (err == ESP_ERR_ESPNOW_FULL) {
        // tabela cheia (20): recomeca — pares ativos voltam no proximo envio
        esp_now_peer_info_t it;
        while (esp_now_fetch_peer(true, &it) == ESP_OK) esp_now_del_peer(it.peer_addr);
        err = esp_now_add_peer(&p);
    }
    if (err != ESP_OK) return false;
    // Taxa: o padrao do ESP-NOW e 1 Mbps (DSSS) — um quadro de 650 B ocupa
    // ~5 ms de ar e 25 quadros/s tomavam o radio do coex: o BLE do no que
    // transmitia ficava surdo e o controle da sessao (malha) se perdia
    // (bancada 2026-10-11, relogio -> 4848). Unicast comeca em 24 Mbps e se
    // adapta ao enlace (rateTick); broadcast fica no 1 Mbps (alcance).
    if (isBroadcast(mac)) {
        applyRate(mac, kRateN - 1);
    } else {
        portENTER_CRITICAL(&s_rateMux);
        PeerRate* r = rateFor(mac, true);
        const int idx = r->idx;
        portEXIT_CRITICAL(&s_rateMux);
        applyRate(mac, idx);
    }
    return true;
}

}  // namespace

bool ensure(bool allowWifiInit) {
    if (s_up) return true;
    if (s_failed) return false;
    if (s_txLock == nullptr) s_txLock = xSemaphoreCreateMutex();
    if (s_txFrame == nullptr) {
        s_txFrame = (uint8_t*)heap_caps_malloc(FRAME_MAX, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    if (s_txPlain == nullptr) {
        s_txPlain = (uint8_t*)heap_caps_malloc(FRAME_MAX, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    if (s_rxLock == nullptr) s_rxLock = xSemaphoreCreateMutex();
    if (s_rxPlain == nullptr) {
        s_rxPlain = (uint8_t*)heap_caps_malloc(FRAME_MAX, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    if (s_rpl == nullptr) {
        void* m = heap_caps_malloc(sizeof(*s_rpl), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (m != nullptr) s_rpl = new (m) netframe::Rpl<16, uint64_t>();
    }
    if (s_txLock == nullptr || s_txFrame == nullptr || s_txPlain == nullptr || s_rxLock == nullptr ||
        s_rxPlain == nullptr || s_rpl == nullptr) {
        return false;
    }
    if (!NetKeys::init()) return false;
    if (s_rx == nullptr) {
        s_rxBuf = (uint8_t*)heap_caps_malloc(RX_RING, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        // INTERNAL | 8BIT: so MALLOC_CAP_INTERNAL pode cair na IRAM das placas com
        // IRAM_AS_8BIT (esp32-cam), onde o S32C1I do spinlock da LoadStoreError
        s_rxStruct = (StaticRingbuffer_t*)heap_caps_malloc(sizeof(StaticRingbuffer_t),
                                                           MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (s_rxBuf == nullptr || s_rxStruct == nullptr) {
            // sem PSRAM (CYD): o plano de dados fica so na malha
            ESP_LOGW(TAG, "sem PSRAM para o RX do ESP-NOW: recursos seguem pela malha");
            heap_caps_free(s_rxBuf);
            heap_caps_free(s_rxStruct);
            s_rxBuf = nullptr;
            s_rxStruct = nullptr;
            s_failed = true;
            return false;
        }
        s_rx = xRingbufferCreateStatic(RX_RING, RINGBUF_TYPE_NOSPLIT, s_rxBuf, s_rxStruct);
        if (s_rx == nullptr) {
            s_failed = true;
            return false;
        }
    }
    // O WiFi pode estar parado (sem rede salva, "nowifi"): o driver sobe em
    // STA sem conectar — o NetworkManager continua dono do radio
    wifi_mode_t mode;
    if (esp_wifi_get_mode(&mode) != ESP_OK) {
        // driver parado: so sobe por pedido de sessao. O caminho antecipado
        // (allowWifiInit=false) nunca chama o init — um 2o init concorrente
        // com o do WebManager ainda em curso travava o driver
        if (!allowWifiInit) return false;
        WifiConnection* wc = NetworkManager::instance().getWifiConnection();
        if (wc == nullptr || wc->init() != CommonErrorCodes::None) {
            ESP_LOGW(TAG, "WiFi nao subiu: recursos seguem pela malha");
            return false;  // tenta de novo no proximo pedido (RAM pode voltar)
        }
    }
    esp_err_t err = esp_now_init();
    if (err != ESP_OK && err != ESP_ERR_ESPNOW_EXIST) {
        // celer_log: visivel tambem nas placas com ESP_LOG em ERROR (esp32-cam)
        celer_log_printf("[dlink] esp_now_init: %s (interna %u)\n", esp_err_to_name(err),
                         (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        return false;
    }
    esp_read_mac(s_myMac, ESP_MAC_WIFI_STA);
    esp_now_register_recv_cb(onRecv);
    esp_now_register_send_cb(onSent);
    uint32_t ver = 0;
    esp_now_get_version(&ver);
    s_up = true;
    Self me;
    self(&me);
    ESP_LOGI(TAG, "ESP-NOW v%u no ar: %02X:%02X:%02X:%02X:%02X:%02X canal %u%s", (unsigned)ver,
             me.mac[0], me.mac[1], me.mac[2], me.mac[3], me.mac[4], me.mac[5], me.chan,
             me.sta ? " (preso ao AP)" : "");
    return true;
}

bool up() {
    return s_up;
}

void self(Self* out) {
    memset(out, 0, sizeof(*out));
    out->up = s_up;
    out->sta = NetworkManager::instance().isConnected();
    uint8_t primary = 0;
    wifi_second_chan_t second;
    if (esp_wifi_get_channel(&primary, &second) == ESP_OK) out->chan = primary;
    esp_read_mac(out->mac, ESP_MAC_WIFI_STA);
}

bool setChannel(uint8_t ch, bool log) {
    if (ch < 1 || ch > 14) return false;
    Self me;
    self(&me);
    if (me.chan == ch) return true;
    if (me.sta) return false;  // preso ao AP: quem troca e o par
    esp_err_t err = esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
    if (err != ESP_OK) {
        if (log) ESP_LOGW(TAG, "canal %u: %s", ch, esp_err_to_name(err));
        return false;
    }
    if (log) ESP_LOGI(TAG, "canal %u -> %u (sessao ESP-NOW)", me.chan, ch);
    return true;
}

void hold(bool on) {
    if (on) {
        if (s_holds++ == 0) NetworkManager::instance().holdChannel(true);
    } else if (s_holds > 0) {
        if (--s_holds == 0) NetworkManager::instance().holdChannel(false);
    }
}

bool send(const uint8_t mac[6], uint8_t kind, uint16_t sid, uint32_t token, uint16_t seq,
          const void* data, size_t len) {
    if (!s_up || len > PAYLOAD_MAX) return false;
    xSemaphoreTake(s_txLock, portMAX_DELAY);
    if (!ensurePeer(mac)) {
        s_txFail++;
        xSemaphoreGive(s_txLock);
        return false;
    }
    if (!isBroadcast(mac)) rateTick(mac);
    const NetKeys::Net* net = NetKeys::primary();
    if (net == nullptr) {
        s_txFail++;
        xSemaphoreGive(s_txLock);
        return false;
    }
    // seq sob s_txLock: a ordem no ar segue a do seq (a janela do RPL agradece)
    const uint32_t nseq = NetKeys::nextSeqNow();
    uint8_t* f = s_txFrame;  // sob s_txLock
    f[0] = MAGIC0;
    f[1] = MAGIC1;
    f[2] = VER;
    f[3] = net->nid;
    f[4] = (uint8_t)(nseq >> 24);
    f[5] = (uint8_t)(nseq >> 16);
    f[6] = (uint8_t)(nseq >> 8);
    f[7] = (uint8_t)nseq;
    uint8_t* p = s_txPlain;
    p[0] = kind;
    p[1] = (uint8_t)(sid >> 8);
    p[2] = (uint8_t)sid;
    p[3] = (uint8_t)(token >> 24);
    p[4] = (uint8_t)(token >> 16);
    p[5] = (uint8_t)(token >> 8);
    p[6] = (uint8_t)token;
    p[7] = (uint8_t)(seq >> 8);
    p[8] = (uint8_t)seq;
    if (len > 0) memcpy(p + INNER_HDR, data, len);
    uint8_t nonce[13];
    nonceFor(s_myMac, nseq, nonce);
    if (!NetKeys::seal(net, nonce, f, CLEAR_HDR, p, INNER_HDR + len, f + CLEAR_HDR)) {
        s_txFail++;
        xSemaphoreGive(s_txLock);
        return false;
    }
    esp_err_t err = esp_now_send(mac, f, HDR + len);  // copia para a fila do driver
    xSemaphoreGive(s_txLock);
    if (err == ESP_OK) {
        s_tx++;
        return true;
    }
    if (err == ESP_ERR_ESPNOW_NO_MEM) s_txNoMem++;  // fila do driver cheia: o chamador decide
    else s_txFail++;
    return false;
}

bool poll(Rx* out) {
    return pollWait(out, 0);
}

bool pollWait(Rx* out, uint32_t ms) {
    if (s_rx == nullptr) {
        if (ms > 0) vTaskDelay(pdMS_TO_TICKS(ms));
        return false;
    }
    const TickType_t t0 = xTaskGetTickCount();
    const TickType_t budget = pdMS_TO_TICKS(ms);
    for (;;) {
        const TickType_t spent = xTaskGetTickCount() - t0;
        const TickType_t wait = spent >= budget ? 0 : budget - spent;
        size_t n = 0;
        uint8_t* item = (uint8_t*)xRingbufferReceive(s_rx, &n, wait);
        if (item == nullptr) return false;
        bool ok = false;
        if (n >= sizeof(RxHead) + HDR) {
            RxHead h;
            memcpy(&h, item, sizeof(h));
            const uint8_t* f = item + sizeof(h);
            const size_t encLen = h.len - CLEAR_HDR - MIC;  // inner + dados
            const uint32_t nseq = ((uint32_t)f[4] << 24) | ((uint32_t)f[5] << 16) | ((uint32_t)f[6] << 8) | f[7];
            int netIdx = -1;
            const NetKeys::Net* net = nullptr;
            for (int i = 0; i < NetKeys::NETS_MAX; i++) {
                const NetKeys::Net* c = NetKeys::net(i);
                if (c != nullptr && c->nid == f[3]) {
                    net = c;
                    netIdx = i;
                    break;
                }
            }
            const uint64_t key = macKey(h.mac);
            xSemaphoreTake(s_rxLock, portMAX_DELAY);
            uint8_t nonce[13];
            nonceFor(h.mac, nseq, nonce);
            if (net == nullptr || !NetKeys::open(net, nonce, f, CLEAR_HDR, f + CLEAR_HDR, encLen, s_rxPlain)) {
                s_rxAuthFail++;
            } else if (s_rpl->check((uint8_t)netIdx, key, nseq) != netframe::Rpl<16, uint64_t>::NEW) {
                s_rxReplay++;
            } else {
                s_rpl->commit((uint8_t)netIdx, key, nseq, (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS));
                const uint8_t* p = s_rxPlain;
                memcpy(out->mac, h.mac, 6);
                out->rssi = h.rssi;
                out->net = (uint8_t)netIdx;
                out->kind = p[0];
                out->sid = (uint16_t)((p[1] << 8) | p[2]);
                out->token = ((uint32_t)p[3] << 24) | ((uint32_t)p[4] << 16) | ((uint32_t)p[5] << 8) | p[6];
                out->seq = (uint16_t)((p[7] << 8) | p[8]);
                out->len = (uint16_t)(encLen - INNER_HDR);
                memcpy(out->data, p + INNER_HDR, out->len);
                ok = true;
            }
            xSemaphoreGive(s_rxLock);
        }
        vRingbufferReturnItem(s_rx, item);
        if (ok) return true;
        // quadro rejeitado: segue drenando dentro do prazo pedido
    }
}

void netChanged() {
    if (s_rxLock == nullptr || s_rpl == nullptr) return;
    xSemaphoreTake(s_rxLock, portMAX_DELAY);
    s_rpl->clear();
    xSemaphoreGive(s_rxLock);
}

void stats(Stats* out) {
    out->tx = s_tx;
    out->txFail = s_txFail;
    out->txNoMem = s_txNoMem;
    out->rx = s_rxN;
    out->rxDropped = s_rxDropped;
    out->rxForeign = s_rxForeign;
    out->rxAuthFail = s_rxAuthFail;
    out->rxReplay = s_rxReplay;
}

}  // namespace DataLink
