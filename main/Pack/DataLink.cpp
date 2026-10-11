#include "DataLink.h"

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
#include "WifiConnection.h"

// Plano de dados ESP-NOW (ver DataLink.h).

namespace DataLink {
namespace {

const char* TAG = "celer.dlink";

constexpr uint8_t MAGIC0 = 'C', MAGIC1 = 'D', VER = 1;
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
int s_holds = 0;
// Enviadores: o tick dos recursos e a task da fonte de audio (mic) — o
// quadro de montagem e a tabela de pares sao compartilhados
SemaphoreHandle_t s_txLock = nullptr;
uint8_t* s_txFrame = nullptr;  // quadro de montagem (PSRAM: fora do .bss interno)

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

void onSent(const esp_now_send_info_t* info, esp_now_send_status_t status) {
    (void)info;
    if (status != ESP_NOW_SEND_SUCCESS) s_txFail++;  // sem ACK do MAC do par
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
    // (bancada 2026-10-11, relogio -> 4848). 11g 24 Mbps: ~0,25 ms por
    // quadro, OFDM robusto o bastante para uma sala.
    esp_now_rate_config_t rc;
    memset(&rc, 0, sizeof(rc));
    rc.phymode = WIFI_PHY_MODE_11G;
    rc.rate = WIFI_PHY_RATE_24M;
    if (esp_now_set_peer_rate_config(mac, &rc) != ESP_OK) {
        ESP_LOGW(TAG, "taxa 24M recusada para o par: segue no padrao (1 Mbps)");
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
    if (s_txLock == nullptr || s_txFrame == nullptr) return false;
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
        ESP_LOGW(TAG, "esp_now_init: %s", esp_err_to_name(err));
        return false;
    }
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

bool setChannel(uint8_t ch) {
    if (ch < 1 || ch > 14) return false;
    Self me;
    self(&me);
    if (me.chan == ch) return true;
    if (me.sta) return false;  // preso ao AP: quem troca e o par
    esp_err_t err = esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "canal %u: %s", ch, esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "canal %u -> %u (sessao ESP-NOW)", me.chan, ch);
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
    uint8_t* f = s_txFrame;  // sob s_txLock
    f[0] = MAGIC0;
    f[1] = MAGIC1;
    f[2] = VER;
    f[3] = kind;
    f[4] = (uint8_t)(sid >> 8);
    f[5] = (uint8_t)sid;
    f[6] = (uint8_t)(token >> 24);
    f[7] = (uint8_t)(token >> 16);
    f[8] = (uint8_t)(token >> 8);
    f[9] = (uint8_t)token;
    f[10] = (uint8_t)(seq >> 8);
    f[11] = (uint8_t)seq;
    if (len > 0) memcpy(f + HDR, data, len);
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
    size_t n = 0;
    uint8_t* item = (uint8_t*)xRingbufferReceive(s_rx, &n, pdMS_TO_TICKS(ms));
    if (item == nullptr) return false;
    bool ok = false;
    if (n >= sizeof(RxHead) + HDR) {
        RxHead h;
        memcpy(&h, item, sizeof(h));
        const uint8_t* f = item + sizeof(h);
        memcpy(out->mac, h.mac, 6);
        out->rssi = h.rssi;
        out->kind = f[3];
        out->sid = (uint16_t)((f[4] << 8) | f[5]);
        out->token = ((uint32_t)f[6] << 24) | ((uint32_t)f[7] << 16) | ((uint32_t)f[8] << 8) | f[9];
        out->seq = (uint16_t)((f[10] << 8) | f[11]);
        out->len = (uint16_t)(h.len - HDR);
        memcpy(out->data, f + HDR, out->len);
        ok = true;
    }
    vRingbufferReturnItem(s_rx, item);
    return ok;
}

void stats(Stats* out) {
    out->tx = s_tx;
    out->txFail = s_txFail;
    out->txNoMem = s_txNoMem;
    out->rx = s_rxN;
    out->rxDropped = s_rxDropped;
    out->rxForeign = s_rxForeign;
}

}  // namespace DataLink
