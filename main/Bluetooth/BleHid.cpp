#include "BleHid.h"

#if CONFIG_CELEROS_BLE_HID

#include <stdio.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs.h"

#include "CelerLink.h"

#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_hs_adv.h"
#include "host/ble_hs_mbuf.h"
#include "host/ble_sm.h"
#include "host/ble_store.h"
#include "host/ble_uuid.h"
#include "sdkconfig.h"
extern "C" void ble_store_config_init(void);

// Gamepad Bluetooth LE HID (API 57): host HOGP cru. O parsing do HID
// descriptor e a decodificacao de reports vivem na dep JS celeros.gamepad —
// aqui so transporte: scan filtrado por HID, conexao + SMP Just Works com
// bond no NVS, descoberta do servico 0x1812 (Report Map cru, Report
// Reference por char), CCCD dos reports de entrada e write para o de saida.
//
// Mesmo desenho do CelerLink: os procedimentos (scan/connect) rodam na task
// do app passo a passo, sincronizados por bits de um event group; os
// callbacks so copiam resultados e sinalizam. Durante scan/connect o
// CelerLink::setExternalBusy(true) faz a malha CelerNet pausar o scanner
// dela (mesmo contrato do scan do app). O enlace do pad coexiste com o do
// Celer Link/Phone Link (MAX_CONNECTIONS >= 2 no board).
//
// Pareamento: SMP Just Works (pad nao tem teclado/display) com bond
// persistente. Sobrescreve o ble_hs_cfg.sm_* do Phone Link quando ambos
// existem (watch): o bond do celular JA GRAVADO continua valendo; so um
// re-pareamento do celular (apos factory reset) perde o codigo exibido.

namespace {

const char* TAG = "celer.pad";

constexpr uint8_t K_CONN_TERM = 0x13;  // HCI: Remote User Terminated

constexpr uint16_t K_ITVL_MIN = 12;      // x 1.25 ms (gamepad quer 15-30 ms)
constexpr uint16_t K_ITVL_MAX = 24;
constexpr uint16_t K_SUPERVISION = 200;  // x 10 ms

constexpr uint32_t K_SCAN_MIN_MS = 400;
constexpr uint32_t K_SCAN_MAX_MS = 15000;
constexpr uint32_t K_CONNECT_MS = 10000;  // prazo TOTAL do connect()

// UUIDs HOGP (16 bits)
constexpr uint16_t K_SVC_HID = 0x1812;
constexpr uint16_t K_CHR_REPORT_MAP = 0x2A4B;
constexpr uint16_t K_CHR_REPORT = 0x2A4D;
constexpr uint16_t K_CHR_PROTO_MODE = 0x2A4E;
constexpr uint16_t K_DSC_REPORT_REF = 0x2908;
constexpr uint16_t K_DSC_CCCD = 0x2902;
constexpr uint16_t K_SVC_BATTERY = 0x180F;
constexpr uint16_t K_CHR_BATTERY = 0x2A19;

// appearance HID no adv: 0x03C4 = gamepad; janela 0x03C0..0x03CF = familia
constexpr uint16_t K_APP_HID_LO = 0x03C0;
constexpr uint16_t K_APP_HID_HI = 0x03CF;

constexpr int K_MAX_CHARS = 16;
constexpr int K_MAX_BONDS = 8;

const char* K_PHASE_OFF = "off";
const char* K_PHASE_IDLE = "idle";
const char* K_PHASE_SCAN = "scanning";
const char* K_PHASE_CONN = "connecting";
const char* K_PHASE_READY = "ready";
const char* K_PHASE_ERROR = "error";

const char* K_NVS_NS = "celer";
const char* K_NVS_LAST_MAC = "bt_pad_mac";
const char* K_NVS_LAST_TYPE = "bt_pad_type";
const char* K_NVS_LAST_NAME = "bt_pad_name";

// Bits do event group dos procedimentos.
constexpr EventBits_t EV_CONN = 1 << 0;    // enlace estabelecido
constexpr EventBits_t EV_FAIL = 1 << 1;    // passo falhou
constexpr EventBits_t EV_ENC = 1 << 2;     // SMP terminou (status em s_encSt)
constexpr EventBits_t EV_SVC = 1 << 3;     // descoberta do servico terminou
constexpr EventBits_t EV_CHR = 1 << 4;     // descoberta das chars terminou
constexpr EventBits_t EV_DSC = 1 << 5;     // descoberta dos descritores terminou
constexpr EventBits_t EV_VAL = 1 << 6;     // leitura do Report Reference ok
constexpr EventBits_t EV_MAP = 1 << 7;     // Report Map lido (EDONE)
constexpr EventBits_t EV_WR = 1 << 8;      // write confirmado
constexpr EventBits_t EV_DISC = 1 << 9;    // conexao caiu
constexpr EventBits_t EV_SCANDONE = 1 << 10;  // scan terminou
constexpr EventBits_t EV_BATR = 1 << 12;   // nivel de bateria lido

// ------------------------------------------------------------ estado ----

bool s_started = false;      // host pronto (config HID aplicada)
bool s_hadFail = false;      // ensure() falhou antes (latch do app)
EventGroupHandle_t s_evt = nullptr;

volatile const char* s_phase = K_PHASE_OFF;
volatile bool s_scanning = false;
volatile bool s_connecting = false;
volatile uint16_t s_conn = 0;
volatile bool s_ready = false;
volatile uint16_t s_mtu = 0;
volatile int s_encSt = -1;
char s_err[48] = {0};

uint8_t s_peerAddr[6] = {0};
uint8_t s_peerAddrType = BLE_ADDR_PUBLIC;
char s_peerName[BleHid::MAX_NAME + 1] = {0};
int8_t s_peerRssi = 0;
volatile int s_battery = -1;

// cache do scan (merge por endereco; ordenado por RSSI na saida)
struct PeerCache {
    uint8_t addr[6];
    uint8_t addrType;
    char name[BleHid::MAX_NAME + 1];
    int8_t rssi;
    uint16_t appearance;
};
PeerCache s_scanCache[BleHid::MAX_PEERS];
volatile int s_scanCount = 0;

// chars do servico HID do pad
struct CharInfo {
    uint16_t uuid16;
    uint16_t val;
    uint8_t props;
};
CharInfo s_chars[K_MAX_CHARS];
int s_nChars = 0;
uint16_t s_svcStart = 0, s_svcEnd = 0;
uint16_t s_mapVal = 0;     // Report Map (0x2A4B)
uint16_t s_protoVal = 0;   // Protocol Mode (0x2A4E)

BleHid::ReportInfo s_reports[BleHid::MAX_REPORTS];
int s_nReports = 0;
int s_curReport = -1;      // char sob descoberta de descritores
// handles dos descritores da char corrente (Report Reference e CCCD);
// 0 = ausente (a CCCD cai para handle+1, layout padrao do GATT)
uint16_t s_rrefDsc[BleHid::MAX_REPORTS];
uint16_t s_cccdDsc[BleHid::MAX_REPORTS];

uint8_t s_mapBuf[BleHid::MAX_MAP];
size_t s_mapLen = 0;
bool s_usesIds = false;    // reports com report id (0 = payload cru)

// fila de reports de entrada (ring, drop-oldest — comando novo vale mais)
struct RptSlot {
    uint8_t id;
    uint16_t len;
    uint8_t data[BleHid::MAX_REPORT];
};
RptSlot s_ring[BleHid::RX_DEPTH];
volatile int s_ringHead = 0, s_ringTail = 0;
volatile uint32_t s_dropped = 0;
portMUX_TYPE s_ringMux = portMUX_INITIALIZER_UNLOCKED;

uint16_t s_batVal = 0;     // handle da Battery Level (0 = sem servico)

// ---------------------------------------------------------------- varios

void formatAddr(const uint8_t val[6], char* out) {
    snprintf(out, 18, "%02X:%02X:%02X:%02X:%02X:%02X", val[5], val[4], val[3],
             val[2], val[1], val[0]);
}

bool parseMac(const char* s, uint8_t out[6]) {
    if (strlen(s) != 17) return false;
    for (int i = 0; i < 6; i++) {
        if (i < 5 && s[i * 3 + 2] != ':') return false;
        char hex[3] = {s[i * 3], s[i * 3 + 1], '\0'};
        char* end = nullptr;
        long v = strtol(hex, &end, 16);
        if (end != hex + 2) return false;
        out[5 - i] = (uint8_t)v;  // exibido big-endian, ble_addr little-endian
    }
    return true;
}

EventBits_t waitBits(EventBits_t bits, TickType_t deadline) {
    for (;;) {
        esp_task_wdt_reset();
        TickType_t now = xTaskGetTickCount();
        if ((int32_t)(deadline - now) <= 0) return 0;
        TickType_t slice = deadline - now;
        if (slice > pdMS_TO_TICKS(250)) slice = pdMS_TO_TICKS(250);
        EventBits_t got = xEventGroupWaitBits(s_evt, bits, pdTRUE, pdFALSE, slice);
        if ((got & bits) != 0) return got & bits;
    }
}

TickType_t deadlineIn(uint32_t ms) {
    return xTaskGetTickCount() + pdMS_TO_TICKS(ms) + 1;
}

bool retryable(int rc) {
    return rc == BLE_HS_ENOMEM || rc == BLE_HS_EBUSY || rc == BLE_HS_EAGAIN;
}

void setErr(const char* msg) {
    snprintf(s_err, sizeof(s_err), "%s", msg);
    s_phase = K_PHASE_ERROR;
}

// ----------------------------------------------------------- ultima vez --
// Slot "ultimo pad" no NVS: reconexao sem scan (o NimBLE nao expoe o tipo
// do endereco do bond por nome; o dep propoe o endereco pronto).

void lastSave(const uint8_t mac[6], uint8_t type, const char* name) {
    nvs_handle_t h;
    if (nvs_open(K_NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_blob(h, K_NVS_LAST_MAC, mac, 6);
    nvs_set_u8(h, K_NVS_LAST_TYPE, type);
    if (name != nullptr) nvs_set_str(h, K_NVS_LAST_NAME, name);
    nvs_commit(h);
    nvs_close(h);
}

bool lastLoad(uint8_t mac[6], uint8_t* type) {
    nvs_handle_t h;
    if (nvs_open(K_NVS_NS, NVS_READONLY, &h) != ESP_OK) return false;
    size_t len = 6;
    bool ok = nvs_get_blob(h, K_NVS_LAST_MAC, mac, &len) == ESP_OK && len == 6 &&
              nvs_get_u8(h, K_NVS_LAST_TYPE, type) == ESP_OK;
    nvs_close(h);
    return ok;
}

void lastClear() {
    nvs_handle_t h;
    if (nvs_open(K_NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_erase_key(h, K_NVS_LAST_MAC);
    nvs_erase_key(h, K_NVS_LAST_TYPE);
    nvs_erase_key(h, K_NVS_LAST_NAME);
    nvs_commit(h);
    nvs_close(h);
}

// tipo do endereco: cache do scan > ultimo pad > bond > publico
uint8_t resolveAddrType(const uint8_t mac[6]) {
    for (int i = 0; i < s_scanCount; i++) {
        if (memcmp(s_scanCache[i].addr, mac, 6) == 0) return s_scanCache[i].addrType;
    }
    uint8_t lm[6], lt = BLE_ADDR_PUBLIC;
    if (lastLoad(lm, &lt) && memcmp(lm, mac, 6) == 0) return lt;
    ble_addr_t bonds[K_MAX_BONDS];
    int n = 0;
    if (s_started && ble_store_util_bonded_peers(bonds, &n, K_MAX_BONDS) == 0) {
        for (int i = 0; i < n; i++) {
            if (memcmp(bonds[i].val, mac, 6) == 0) return bonds[i].type;
        }
    }
    return BLE_ADDR_PUBLIC;
}

// ------------------------------------------------------------- fila RX --

// Roda so na task do host. Fila cheia descarta o MAIS ANTIGO.
void pushReport(uint8_t id, const uint8_t* data, uint16_t len) {
    if (len > BleHid::MAX_REPORT) len = BleHid::MAX_REPORT;
    portENTER_CRITICAL(&s_ringMux);
    int head = s_ringHead;
    int next = (head + 1) % BleHid::RX_DEPTH;
    if (next == s_ringTail) {
        s_ringTail = (s_ringTail + 1) % BleHid::RX_DEPTH;  // descarta o velho
        s_dropped = s_dropped + 1;
    }
    RptSlot* s = &s_ring[head];
    s->id = id;
    s->len = len;
    memcpy(s->data, data, len);
    s_ringHead = next;
    portEXIT_CRITICAL(&s_ringMux);
}

// ------------------------------------------------------------ callbacks --

int onChrDisc(uint16_t conn, const struct ble_gatt_error* err,
              const struct ble_gatt_chr* chr, void* arg) {
    (void)conn;
    (void)arg;
    if (err->status == 0 && chr != nullptr) {
        if (chr->uuid.u.type == BLE_UUID_TYPE_16 && s_nChars < K_MAX_CHARS) {
            CharInfo* c = &s_chars[s_nChars++];
            c->uuid16 = chr->uuid.u16.value;
            c->val = chr->val_handle;
            c->props = chr->properties;
        }
    } else if (err->status == BLE_HS_EDONE) {
        xEventGroupSetBits(s_evt, EV_CHR);
    } else {
        xEventGroupSetBits(s_evt, EV_FAIL);
    }
    return 0;
}

int onSvcDisc(uint16_t conn, const struct ble_gatt_error* err,
              const struct ble_gatt_svc* svc, void* arg) {
    (void)conn;
    (void)arg;
    if (err->status == 0 && svc != nullptr) {
        s_svcStart = svc->start_handle;
        s_svcEnd = svc->end_handle;
    } else if (err->status == BLE_HS_EDONE) {
        xEventGroupSetBits(s_evt, EV_SVC);
    } else {
        xEventGroupSetBits(s_evt, EV_FAIL);
    }
    return 0;
}

int onDscDisc(uint16_t conn, const struct ble_gatt_error* err,
              uint16_t chrVal, const struct ble_gatt_dsc* dsc, void* arg) {
    (void)conn;
    (void)chrVal;
    (void)arg;
    if (err->status == 0 && dsc != nullptr) {
        if (dsc->uuid.u.type == BLE_UUID_TYPE_16 && s_curReport >= 0 &&
            s_curReport < BleHid::MAX_REPORTS) {
            if (dsc->uuid.u16.value == K_DSC_REPORT_REF) {
                s_rrefDsc[s_curReport] = dsc->handle;
            } else if (dsc->uuid.u16.value == K_DSC_CCCD) {
                s_cccdDsc[s_curReport] = dsc->handle;
            }
        }
    } else if (err->status == BLE_HS_EDONE) {
        xEventGroupSetBits(s_evt, EV_DSC);
    } else {
        xEventGroupSetBits(s_evt, EV_FAIL | EV_DSC);
    }
    return 0;
}

int onReadVal(uint16_t conn, const struct ble_gatt_error* err,
              struct ble_gatt_attr* attr, void* arg) {
    (void)conn;
    (void)arg;
    if (err->status == 0 && attr != nullptr && OS_MBUF_PKTLEN(attr->om) >= 2) {
        uint8_t buf[2];
        uint16_t got = 0;
        if (ble_hs_mbuf_to_flat(attr->om, buf, sizeof(buf), &got) == 0 && got >= 2 &&
            s_curReport >= 0 && s_curReport < BleHid::MAX_REPORTS) {
            s_reports[s_curReport].id = buf[0];
            s_reports[s_curReport].type = buf[1];
        }
        xEventGroupSetBits(s_evt, EV_VAL);
    } else if (err->status != BLE_HS_EDONE) {
        xEventGroupSetBits(s_evt, EV_FAIL | EV_VAL);
        return 0;
    }
    return 0;
}

int onReadLong(uint16_t conn, const struct ble_gatt_error* err,
               struct ble_gatt_attr* attr, void* arg) {
    (void)conn;
    (void)arg;
    if (err->status == 0 && attr != nullptr) {
        uint16_t len = OS_MBUF_PKTLEN(attr->om);
        uint16_t off = attr->offset;
        if (off + len > BleHid::MAX_MAP) len = BleHid::MAX_MAP - off;
        if (len > 0) {
            uint16_t got = 0;
            if (ble_hs_mbuf_to_flat(attr->om, s_mapBuf + off, len, &got) == 0) {
                if (off + got > s_mapLen) s_mapLen = off + got;
            }
        }
    } else if (err->status == BLE_HS_EDONE) {
        xEventGroupSetBits(s_evt, EV_MAP);
    } else {
        xEventGroupSetBits(s_evt, EV_FAIL | EV_MAP);
    }
    return 0;
}

int onWrite(uint16_t conn, const struct ble_gatt_error* err,
            struct ble_gatt_attr* attr, void* arg) {
    (void)conn;
    (void)attr;
    (void)arg;
    xEventGroupSetBits(s_evt, err->status == 0 ? EV_WR : (EV_WR | EV_FAIL));
    return 0;
}

int onBatRead(uint16_t conn, const struct ble_gatt_error* err,
              struct ble_gatt_attr* attr, void* arg) {
    (void)conn;
    (void)arg;
    if (err->status == 0 && attr != nullptr && OS_MBUF_PKTLEN(attr->om) >= 1) {
        uint8_t v = 0;
        uint16_t got = 0;
        if (ble_hs_mbuf_to_flat(attr->om, &v, 1, &got) == 0 && got >= 1) {
            s_battery = v > 100 ? 100 : v;
        }
        xEventGroupSetBits(s_evt, EV_BATR);
    } else if (err->status != BLE_HS_EDONE) {
        xEventGroupSetBits(s_evt, EV_BATR);  // best effort: falha nao mata
    }
    return 0;
}

void clearConnState() {
    s_conn = 0;
    s_ready = false;
    s_mtu = 0;
    s_nChars = 0;
    s_nReports = 0;
    s_curReport = -1;
    s_mapVal = 0;
    s_protoVal = 0;
    s_svcStart = s_svcEnd = 0;
    s_mapLen = 0;
    s_batVal = 0;
    s_battery = -1;
    s_peerName[0] = '\0';
    portENTER_CRITICAL(&s_ringMux);
    s_ringHead = 0;
    s_ringTail = 0;
    portEXIT_CRITICAL(&s_ringMux);
}

int onHidGapEvent(struct ble_gap_event* event, void* arg) {
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status != 0) {
                if (s_connecting) xEventGroupSetBits(s_evt, EV_FAIL);
                return 0;
            }
            s_conn = event->connect.conn_handle;
            s_encSt = -1;
            {
                struct ble_gap_conn_desc d;
                if (ble_gap_conn_find(s_conn, &d) == 0) {
                    memcpy(s_peerAddr, d.peer_ota_addr.val, 6);
                    s_peerAddrType = d.peer_ota_addr.type;
                }
            }
            xEventGroupSetBits(s_evt, EV_CONN);
            return 0;
        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGI(TAG, "pad desconectado (reason=0x%x)", event->disconnect.reason);
            clearConnState();
            if (!s_connecting) s_phase = K_PHASE_IDLE;
            xEventGroupSetBits(s_evt, EV_DISC | EV_FAIL);
            CelerLink::refreshAdvertising();
            return 0;
        case BLE_GAP_EVENT_MTU:
            s_mtu = event->mtu.value;
            return 0;
        case BLE_GAP_EVENT_DISC: {
            // scan de HID: so entrada com appearance da familia HID (0x03C0
            // ..0x03CF; 0x03C4 = gamepad) ou o servico 0x1812 no adv. O nome
            // costuma vir na resposta de scan: merge por endereco (igual ao
            // CelerLink).
            struct ble_hs_adv_fields f;
            if (ble_hs_adv_parse_fields(&f, event->disc.data,
                                        event->disc.length_data) != 0) return 0;
            bool hid = false;
            uint16_t appearance = 0;
            if (f.appearance_is_present) {
                appearance = f.appearance;
                if (appearance >= K_APP_HID_LO && appearance <= K_APP_HID_HI) hid = true;
            }
            if (!hid) {
                for (int i = 0; i < f.num_uuids16; i++) {
                    if (f.uuids16[i].value == K_SVC_HID) { hid = true; break; }
                }
            }
            if (!hid) return 0;
            PeerCache* e = nullptr;
            for (int i = 0; i < s_scanCount; i++) {
                if (s_scanCache[i].addrType == event->disc.addr.type &&
                    memcmp(s_scanCache[i].addr, event->disc.addr.val, 6) == 0) {
                    e = &s_scanCache[i];
                    break;
                }
            }
            if (e == nullptr) {
                if (s_scanCount >= BleHid::MAX_PEERS) return 0;
                e = &s_scanCache[s_scanCount];
                memset(e, 0, sizeof(*e));
                e->addrType = event->disc.addr.type;
                memcpy(e->addr, event->disc.addr.val, 6);
                s_scanCount = s_scanCount + 1;
            }
            e->rssi = event->disc.rssi;
            e->appearance = appearance;
            if (f.name != nullptr && f.name_len > 0) {
                size_t n = f.name_len < sizeof(e->name) - 1 ? f.name_len
                                                            : sizeof(e->name) - 1;
                memcpy(e->name, f.name, n);
                e->name[n] = '\0';
            }
            return 0;
        }
        case BLE_GAP_EVENT_DISC_COMPLETE:
            xEventGroupSetBits(s_evt, EV_SCANDONE);
            return 0;
        case BLE_GAP_EVENT_NOTIFY_RX: {
            const uint16_t h = event->notify_rx.attr_handle;
            if (h == s_batVal && s_batVal != 0) {
                uint8_t v = 0;
                uint16_t got = 0;
                if (ble_hs_mbuf_to_flat(event->notify_rx.om, &v, 1, &got) == 0 &&
                    got >= 1) {
                    s_battery = v > 100 ? 100 : v;
                }
                return 0;
            }
            for (int i = 0; i < s_nReports; i++) {
                if (s_reports[i].type != 1 || s_reports[i].handle != h) continue;
                uint16_t len = OS_MBUF_PKTLEN(event->notify_rx.om);
                if (len == 0) return 0;
                uint8_t buf[BleHid::MAX_REPORT];
                if (len > sizeof(buf)) len = sizeof(buf);
                if (ble_hs_mbuf_to_flat(event->notify_rx.om, buf, len, &len) != 0) return 0;
                // payload cru da char Report: COM o byte de id quando o pad
                // usa ids (o dep decide pelo reportMap); id=0 caso contrario.
                pushReport(s_usesIds ? buf[0] : 0, buf, len);
                return 0;
            }
            return 0;
        }
        case BLE_GAP_EVENT_PASSKEY_ACTION:
            // Just Works: sem teclado/display dos dois lados, o NimBLE
            // completa sozinho (aqui nada a responder).
            return 0;
        case BLE_GAP_EVENT_ENC_CHANGE:
            s_encSt = event->enc_change.status;
            xEventGroupSetBits(s_evt, EV_ENC);
            return 0;
        case BLE_GAP_EVENT_REPEAT_PAIRING: {
            // pad pareado com outro host antes (um host por pad): apaga o
            // bond velho e aceita parear de novo.
            struct ble_gap_conn_desc d;
            if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &d) == 0) {
                ble_store_util_delete_peer(&d.peer_id_addr);
            }
            return BLE_GAP_REPEAT_PAIRING_RETRY;
        }
        default:
            return 0;
    }
}

// id "AA:BB:..." -> endereco (tipo resolvido pelo cache/bond/NVS)
bool resolveTarget(const char* id, ble_addr_t* out) {
    uint8_t mac[6];
    if (!parseMac(id, mac)) return false;
    out->type = resolveAddrType(mac);
    memcpy(out->val, mac, 6);
    return true;
}

}  // namespace

// ------------------------------------------------------------------ API

bool BleHid::ensure() {
    if (s_started) return true;
    // SEM latch: false aqui e "ainda nao" (RAM apertada, ou o init do host
    // em curso em OUTRO task — CelerLink::ensureStarted virou one-shot
    // protegido e devolve false para quem chega no meio). O backoff do
    // driver segura o ritmo das re-tentativas.
    if (!CelerLink::ensureStarted(false)) return false;
    if (s_evt == nullptr) s_evt = xEventGroupCreate();
    if (s_evt == nullptr) return false;
    // SMP Just Works + bond no NVS do NimBLE. No watch isto sobrescreve o
    // bloco do Phone Link (ver cabecalho): bonds ja gravados seguem valendo.
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.store_status_cb = ble_store_util_status_rr;
    ble_store_config_init();
    s_started = true;
    s_phase = K_PHASE_IDLE;
    return true;
}

bool BleHid::started() { return s_started; }

bool BleHid::scan(uint32_t ms) {
    if (!ensure()) return false;
    if (s_ready || s_connecting) {
        setErr("pad ja conectado: disconnect antes de escanear");
        return false;
    }
    if (ms < K_SCAN_MIN_MS) ms = K_SCAN_MIN_MS;
    if (ms > K_SCAN_MAX_MS) ms = K_SCAN_MAX_MS;

    s_scanCount = 0;
    memset(s_scanCache, 0, sizeof(s_scanCache));
    s_phase = K_PHASE_SCAN;
    s_scanning = true;
    CelerLink::setExternalBusy(true);  // ANTES do cancel: a malha solta o ar
    if (ble_gap_disc_active()) ble_gap_disc_cancel();

    struct ble_gap_disc_params p;
    memset(&p, 0, sizeof(p));
    p.passive = 0;             // ativo: resposta de scan traz o nome
    p.filter_duplicates = 1;
    p.itvl = 16;               // 10 ms / 10 ms: scan rapido
    p.window = 16;
    xEventGroupClearBits(s_evt, EV_SCANDONE);
    int rc = ble_gap_disc(BLE_OWN_ADDR_PUBLIC, (int32_t)ms, &p, onHidGapEvent, nullptr);
    if (rc != 0) {
        ESP_LOGW(TAG, "scan: ble_gap_disc rc=%d", rc);
        snprintf(s_err, sizeof(s_err), "scan: ble_gap_disc rc=%d", rc);
        s_scanning = false;
        CelerLink::setExternalBusy(false);
        s_phase = K_PHASE_IDLE;
        return false;
    }
    if (waitBits(EV_SCANDONE, deadlineIn(ms + 1000)) == 0) {
        ble_gap_disc_cancel();
        waitBits(EV_SCANDONE, deadlineIn(200));
    }

    // RSSI mais forte primeiro (insertion sort, <= 16 itens)
    int n = s_scanCount;
    for (int i = 1; i < n; i++) {
        PeerCache t = s_scanCache[i];
        int j = i - 1;
        while (j >= 0 && s_scanCache[j].rssi < t.rssi) {
            s_scanCache[j + 1] = s_scanCache[j];
            j--;
        }
        s_scanCache[j + 1] = t;
    }
    s_scanning = false;
    CelerLink::setExternalBusy(false);
    s_phase = K_PHASE_IDLE;
    return true;
}

int BleHid::scanResults(Peer* out, int max) {
    int n = s_scanCount;
    if (n > max) n = max;
    for (int i = 0; i < n; i++) {
        formatAddr(s_scanCache[i].addr, out[i].id);
        snprintf(out[i].name, sizeof(out[i].name), "%s", s_scanCache[i].name);
        out[i].rssi = s_scanCache[i].rssi;
        out[i].addrType = s_scanCache[i].addrType;
        out[i].appearance = s_scanCache[i].appearance;
    }
    return n;
}

bool BleHid::connect(const char* id, uint32_t ms) {
    if (!ensure()) return false;
    if (s_connecting) return false;
    if (ms == 0 || ms > K_CONNECT_MS) ms = K_CONNECT_MS;
    if (id == nullptr || id[0] == '\0') return false;

    ble_addr_t addr;
    if (!resolveTarget(id, &addr)) {
        setErr("endereco invalido");
        return false;
    }

    const TickType_t deadline = deadlineIn(ms);
    if (s_ready) disconnect();
    if (ble_gap_disc_active()) ble_gap_disc_cancel();

    s_phase = K_PHASE_CONN;
    s_connecting = true;
    s_err[0] = '\0';
    s_encSt = -1;
    s_nChars = 0;
    s_nReports = 0;
    s_curReport = -1;
    s_mapLen = 0;
    s_mapVal = 0;
    s_protoVal = 0;
    s_battery = -1;
    s_batVal = 0;
    s_usesIds = false;
    CelerLink::setExternalBusy(true);
    xEventGroupClearBits(s_evt, EV_CONN | EV_FAIL | EV_ENC | EV_SVC | EV_CHR |
                                    EV_DSC | EV_VAL | EV_MAP | EV_WR | EV_DISC |
                                    EV_BATR);

    struct ble_gap_conn_params cp;
    memset(&cp, 0, sizeof(cp));
    cp.scan_itvl = 0x0010;
    cp.scan_window = 0x0010;
    cp.itvl_min = K_ITVL_MIN;
    cp.itvl_max = K_ITVL_MAX;
    cp.latency = 0;
    cp.supervision_timeout = K_SUPERVISION;

    const char* step = "gap_connect";
    int rc = ble_gap_connect(BLE_OWN_ADDR_PUBLIC, &addr, (int32_t)ms, &cp,
                             onHidGapEvent, nullptr);
    if (rc != 0) {
        snprintf(s_err, sizeof(s_err), "ble_gap_connect rc=%d", rc);
        goto fail;
    }
    step = "conexao";
    if (!(waitBits(EV_CONN | EV_FAIL, deadline) & EV_CONN)) {
        if (!s_conn && ble_gap_conn_cancel() == 0) {
            waitBits(EV_CONN | EV_FAIL, deadlineIn(300));
        }
        snprintf(s_err, sizeof(s_err), "sem conexao no prazo");
        goto fail;
    }

    // SMP Just Works: o pad exige criptografia antes de aceitar CCCD/write;
    // bond ja gravado = crypto volta direto; REPEAT_PAIRING re-pareia.
    step = "pareamento";
    if (ble_gap_security_initiate(s_conn) == 0) {
        EventBits_t got = waitBits(EV_ENC | EV_FAIL | EV_DISC, deadline);
        if (!(got & EV_ENC)) {
            snprintf(s_err, sizeof(s_err), "pareamento sem resposta");
            goto fail;
        }
        if (s_encSt != 0) {
            snprintf(s_err, sizeof(s_err), "pareamento recusado (st=%d)", s_encSt);
            goto fail;
        }
    }

    // servico HID 0x1812
    step = "descoberta";
    {
        static const ble_uuid16_t hidUuid = BLE_UUID16_INIT(K_SVC_HID);
        if (ble_gattc_disc_svc_by_uuid(s_conn, &hidUuid.u, onSvcDisc, nullptr) != 0) {
            snprintf(s_err, sizeof(s_err), "disc_svcs falhou");
            goto fail;
        }
        if (!(waitBits(EV_SVC | EV_FAIL, deadline) & EV_SVC) || s_svcStart == 0) {
            snprintf(s_err, sizeof(s_err), "servico HID ausente");
            goto fail;
        }
    }

    // chars dentro do servico (Report Map, Report(s), Protocol Mode)
    step = "chars";
    if (ble_gattc_disc_all_chrs(s_conn, s_svcStart, s_svcEnd, onChrDisc, nullptr) != 0) {
        snprintf(s_err, sizeof(s_err), "disc_all_chrs falhou");
        goto fail;
    }
    if (!(waitBits(EV_CHR | EV_FAIL, deadline) & EV_CHR)) {
        snprintf(s_err, sizeof(s_err), "chars do HID ausentes");
        goto fail;
    }
    for (int i = 0; i < s_nChars; i++) {
        if (s_chars[i].uuid16 == K_CHR_REPORT_MAP) s_mapVal = s_chars[i].val;
        else if (s_chars[i].uuid16 == K_CHR_PROTO_MODE) s_protoVal = s_chars[i].val;
    }
    if (s_mapVal == 0) {
        snprintf(s_err, sizeof(s_err), "pad sem Report Map");
        goto fail;
    }

    // para cada char Report (0x2A4D): Report Reference (id+tipo) e CCCD.
    // Chars sem Report Reference legivel sao descartadas (vendor genérico).
    step = "reports";
    for (int i = 0; i < s_nChars && s_nReports < BleHid::MAX_REPORTS; i++) {
        if (s_chars[i].uuid16 != K_CHR_REPORT) continue;
        s_curReport = s_nReports;
        BleHid::ReportInfo* r = &s_reports[s_nReports];
        memset(r, 0, sizeof(*r));
        r->handle = s_chars[i].val;
        s_rrefDsc[s_nReports] = 0;
        s_cccdDsc[s_nReports] = 0;

        uint16_t dscEnd = s_svcEnd;
        for (int j = i + 1; j < s_nChars; j++) {
            if (s_chars[j].val > r->handle && s_chars[j].val - 1 < dscEnd) {
                dscEnd = s_chars[j].val - 1;
            }
        }
        if (ble_gattc_disc_all_dscs(s_conn, r->handle + 1, dscEnd, onDscDisc, nullptr) != 0) {
            snprintf(s_err, sizeof(s_err), "disc_all_dscs falhou");
            goto fail;
        }
        if (!(waitBits(EV_DSC | EV_FAIL, deadline) & EV_DSC)) {
            snprintf(s_err, sizeof(s_err), "descritores ausentes");
            goto fail;
        }
        if (s_rrefDsc[s_nReports] == 0) {
            // sem Report Reference: char de vendor fora do contrato HOGP —
            // descarta (o slot ainda nao foi contabilizado, so sobrescreve)
            s_curReport = -1;
            xEventGroupClearBits(s_evt, EV_FAIL);
            continue;
        }
        s_nReports++;
        if (ble_gattc_read(s_conn, s_rrefDsc[s_nReports - 1], onReadVal, nullptr) != 0) {
            snprintf(s_err, sizeof(s_err), "read Report Reference falhou");
            goto fail;
        }
        if (!(waitBits(EV_VAL | EV_FAIL, deadline) & EV_VAL)) {
            snprintf(s_err, sizeof(s_err), "Report Reference sem resposta");
            goto fail;
        }
        if (s_reports[s_nReports - 1].type == 0) {
            // leitura falhou: descarta a char (o callback setou FAIL)
            s_nReports--;
            xEventGroupClearBits(s_evt, EV_FAIL);
            continue;
        }
        if (s_reports[s_nReports - 1].id != 0) s_usesIds = true;
    }
    s_curReport = -1;
    if (s_nReports == 0) {
        snprintf(s_err, sizeof(s_err), "pad sem chars de report");
        goto fail;
    }

    // Report Map cru (read long: mapa pode passar do MTU)
    step = "report map";
    if (ble_gattc_read_long(s_conn, s_mapVal, 0, onReadLong, nullptr) != 0) {
        snprintf(s_err, sizeof(s_err), "read_long falhou");
        goto fail;
    }
    if (!(waitBits(EV_MAP | EV_FAIL, deadline) & EV_MAP) || s_mapLen == 0) {
        snprintf(s_err, sizeof(s_err), "Report Map vazio");
        goto fail;
    }

    // Protocol Mode = Report (0x01); opcional — pad sem a char segue
    if (s_protoVal != 0) {
        const uint8_t reportMode = 0x01;
        if (ble_gattc_write_flat(s_conn, s_protoVal, &reportMode, 1, onWrite, nullptr) == 0) {
            waitBits(EV_WR | EV_FAIL, deadlineIn(1500));
            xEventGroupClearBits(s_evt, EV_FAIL);  // falha aqui nao e fatal
        }
    }

    // inscreve os reports de entrada (CCCD 0x0001 = notify)
    step = "inscricao";
    for (int i = 0; i < s_nReports; i++) {
        if (s_reports[i].type != 1) continue;
        uint16_t cccd = s_cccdDsc[i] != 0 ? s_cccdDsc[i] : s_reports[i].handle + 1;
        const uint16_t enable = 0x0001;
        if (ble_gattc_write_flat(s_conn, cccd, &enable, 2, onWrite, nullptr) != 0) {
            snprintf(s_err, sizeof(s_err), "CCCD falhou");
            goto fail;
        }
        if (!(waitBits(EV_WR | EV_FAIL, deadline) & EV_WR)) {
            snprintf(s_err, sizeof(s_err), "CCCD recusado");
            goto fail;
        }
    }

    // bateria (best effort: pad sem Battery Service segue de pe; o range
    // s_svcStart/End é reusado — o do HID ja foi consumido a esta altura)
    step = "bateria";
    {
        static const ble_uuid16_t batSvc = BLE_UUID16_INIT(K_SVC_BATTERY);
        s_batVal = 0;
        if (ble_gattc_disc_svc_by_uuid(s_conn, &batSvc.u, onSvcDisc, nullptr) == 0 &&
            (waitBits(EV_SVC, deadlineIn(2000)) & EV_SVC)) {
            if (ble_gattc_disc_all_chrs(s_conn, s_svcStart, s_svcEnd, onChrDisc, nullptr) == 0 &&
                (waitBits(EV_CHR, deadlineIn(2000)) & EV_CHR)) {
                for (int i = 0; i < s_nChars; i++) {
                    if (s_chars[i].uuid16 == K_CHR_BATTERY) s_batVal = s_chars[i].val;
                }
                if (s_batVal != 0 &&
                    ble_gattc_read(s_conn, s_batVal, onBatRead, nullptr) == 0) {
                    waitBits(EV_BATR, deadlineIn(2000));
                }
            }
        }
    }

    s_ready = true;
    s_connecting = false;
    s_phase = K_PHASE_READY;
    snprintf(s_peerName, sizeof(s_peerName), "%s", "");
    for (int i = 0; i < s_scanCount; i++) {
        if (memcmp(s_scanCache[i].addr, addr.val, 6) == 0) {
            snprintf(s_peerName, sizeof(s_peerName), "%s", s_scanCache[i].name);
            s_peerRssi = s_scanCache[i].rssi;
            break;
        }
    }
    lastSave(addr.val, addr.type, s_peerName);
    CelerLink::setExternalBusy(false);
    CelerLink::refreshAdvertising();
    ESP_LOGI(TAG, "pad pronto (%s, %d reports, mapa %u B%s)", id, s_nReports,
             (unsigned)s_mapLen, s_usesIds ? ", com ids" : "");
    return true;

fail:
    ESP_LOGW(TAG, "connect \"%s\" falhou na etapa %s: %s", id, step, s_err);
    if (s_conn) {
        xEventGroupClearBits(s_evt, EV_DISC);
        if (ble_gap_terminate(s_conn, K_CONN_TERM) == 0) {
            waitBits(EV_DISC, deadlineIn(1500));
        }
    }
    clearConnState();
    s_connecting = false;
    s_phase = K_PHASE_IDLE;
    CelerLink::setExternalBusy(false);
    CelerLink::refreshAdvertising();
    return false;
}

bool BleHid::disconnect() {
    if (!s_started || !s_ready) return false;
    uint16_t c = s_conn;
    xEventGroupClearBits(s_evt, EV_DISC);
    if (ble_gap_terminate(c, K_CONN_TERM) == 0) {
        waitBits(EV_DISC, deadlineIn(1500));
    }
    clearConnState();
    s_phase = K_PHASE_IDLE;
    return true;
}

bool BleHid::connected() { return s_ready; }

int BleHid::paired(Peer* out, int max) {
    if (!s_started) return 0;
    ble_addr_t bonds[K_MAX_BONDS];
    int n = 0;
    if (ble_store_util_bonded_peers(bonds, &n, K_MAX_BONDS) != 0) return 0;
    int outN = n < max ? n : max;
    for (int i = 0; i < outN; i++) {
        formatAddr(bonds[i].val, out[i].id);
        out[i].name[0] = '\0';
        out[i].rssi = 0;
        out[i].addrType = bonds[i].type;
        out[i].appearance = 0;
    }
    return outN;
}

bool BleHid::forget(const char* id) {
    if (!s_started) return false;
    bool ok = false;
    if (id == nullptr || id[0] == '\0') {
        ok = ble_store_clear() == 0;
    } else {
        uint8_t mac[6];
        if (!parseMac(id, mac)) return false;
        ble_addr_t bonds[K_MAX_BONDS];
        int n = 0;
        if (ble_store_util_bonded_peers(bonds, &n, K_MAX_BONDS) != 0) return false;
        for (int i = 0; i < n; i++) {
            if (memcmp(bonds[i].val, mac, 6) != 0) continue;
            ok = ble_store_util_delete_peer(&bonds[i]) == 0 || ok;
        }
    }
    lastClear();
    return ok;
}

bool BleHid::poll(uint8_t* id, void* buf, size_t cap, size_t* len) {
    portENTER_CRITICAL(&s_ringMux);
    if (s_ringHead == s_ringTail) {
        portEXIT_CRITICAL(&s_ringMux);
        return false;
    }
    RptSlot* s = &s_ring[s_ringTail];
    s_ringTail = (s_ringTail + 1) % BleHid::RX_DEPTH;
    portEXIT_CRITICAL(&s_ringMux);
    size_t n = s->len < cap ? s->len : cap;
    memcpy(buf, s->data, n);
    *id = s->id;
    *len = n;
    return true;
}

bool BleHid::write(const void* data, size_t len) {
    if (!s_started || !s_ready || data == nullptr || len == 0 ||
        len > BleHid::MAX_REPORT) return false;
    // char de output = primeiro report com type 2
    int outIdx = -1;
    for (int i = 0; i < s_nReports; i++) {
        if (s_reports[i].type == 2) { outIdx = i; break; }
    }
    if (outIdx < 0) return false;
    const TickType_t deadline = deadlineIn(1000);
    xEventGroupClearBits(s_evt, EV_WR | EV_FAIL);
    int rc = ble_gattc_write_flat(s_conn, s_reports[outIdx].handle, data,
                                  (uint16_t)len, onWrite, nullptr);
    for (int i = 0; i < 24 && retryable(rc); i++) {
        vTaskDelay(pdMS_TO_TICKS(5));
        rc = ble_gattc_write_flat(s_conn, s_reports[outIdx].handle, data,
                                  (uint16_t)len, onWrite, nullptr);
    }
    if (rc != 0) return false;
    // EV_FAIL cobre erro do write e queda do link
    return (waitBits(EV_WR | EV_FAIL, deadline) & EV_WR) != 0;
}

void BleHid::info(Info* out) {
    memset(out, 0, sizeof(*out));
    out->phase = const_cast<const char*>(s_phase);
    formatAddr(s_peerAddr, out->addr);
    if (!s_ready) out->addr[0] = '\0';
    snprintf(out->name, sizeof(out->name), "%s", s_peerName);
    out->rssi = s_peerRssi;
    out->battery = s_battery;
    out->mtu = s_mtu;
    out->nReports = s_nReports;
    for (int i = 0; i < s_nReports && i < MAX_REPORTS; i++) {
        out->reports[i] = s_reports[i];
    }
    portENTER_CRITICAL(&s_ringMux);
    int head = s_ringHead, tail = s_ringTail;
    portEXIT_CRITICAL(&s_ringMux);
    out->queued = (uint16_t)((head - tail + BleHid::RX_DEPTH) % BleHid::RX_DEPTH);
    out->dropped = s_dropped;
    snprintf(out->err, sizeof(out->err), "%s", s_err);
}

size_t BleHid::reportMap(uint8_t* out, size_t cap) {
    if (!s_ready) return 0;
    size_t n = s_mapLen < cap ? s_mapLen : cap;
    memcpy(out, s_mapBuf, n);
    return n;
}

void BleHid::appReset() {
    portENTER_CRITICAL(&s_ringMux);
    s_ringHead = 0;
    s_ringTail = 0;
    portEXIT_CRITICAL(&s_ringMux);
    s_scanCount = 0;
    s_dropped = 0;
    s_err[0] = '\0';
    if (s_phase == K_PHASE_ERROR) s_phase = K_PHASE_IDLE;
}

void BleHid::tick() {
    // connect() sem resposta nenhuma por 20 s (evento perdido): solta o
    // estado local — sem isto o phase "connecting" fica preso e o busy da
    // malha tambem (o scanner nunca voltaria).
    static uint32_t s_connAt = 0;
    if (s_connecting) {
        uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        if (s_connAt == 0) {
            s_connAt = now;
        } else if (now - s_connAt > 20000) {
            s_connAt = 0;
            if (s_conn) ble_gap_terminate(s_conn, K_CONN_TERM);
            clearConnState();
            s_connecting = false;
            s_phase = K_PHASE_IDLE;
            CelerLink::setExternalBusy(false);
        }
        return;
    }
    s_connAt = 0;
}

bool BleHid::busy() { return s_scanning || s_connecting; }

#endif  // CONFIG_CELEROS_BLE_HID
