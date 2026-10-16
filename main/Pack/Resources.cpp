#include "Resources.h"

#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <stdlib.h>
#include <unistd.h>
#include <string>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "sdkconfig.h"

#include "../Bluetooth/CelerNet.h"
#include "../Bluetooth/NetKeys.h"
#include "../Kernel/Notifications.h"
#include "../Boards/Board.h"
#include "../Hardware/BoardIO.h"
#include "../Utils/CelerSettings.h"
#include "AudioRes.h"
#include "CamRes.h"
#include "GpioRes.h"
#include "SensorRes.h"
#include "../Runtime/CameraCore.h"
#include "DataLink.h"
#include "../Utils/TaskCaps.h"
#include "Pack.h"
#include "PackId.h"
#include "Provision.h"
#include "../USBDevice/UsbRes.h"

// Recursos da matilha (ver Resources.h / ResProto.h).
//
// Dois locks, de proposito: o handler do CelerNet chega com o mutex DA MALHA
// tomado e o tick daqui chama Pack::send (que toma o mutex da malha). Se o
// handler tomasse o lock principal, seria ABBA. Entao o handler so usa
// s_inLock (caixa de entrada; nunca segurado junto com a malha do lado de
// ca) e o resto usa s_lock.

namespace Resources {
namespace {

const char* TAG = "celer.res";

using namespace resproto;

constexpr uint32_t K_LEASE_MS = LEASE_DS_DEFAULT * 100u;
constexpr uint32_t K_OPEN_RETRY_MS = 2500;
constexpr uint8_t K_OPEN_TRIES = 5;  // 12,5 s: a malha sob stream de audio atrasa o ACCEPT
constexpr uint32_t K_CACHE_FRESH_MS = 30000;   // LIST vale 30 s
constexpr uint32_t K_DESCRIBE_GAP_MS = 5000;   // DESCRIBE por no, no maximo 1 a cada 5 s
// Gateway USB (Onda B): o PC com node id sintetico e o master switch dele
// id do PC nas tabelas: o no virtual derivado do gateway (packid, API 41)
uint16_t usbNode() {
    return PackId::pcNode();
}
bool s_usbSession = false;   // sessao HostLink viva (HELLO...endSession)
bool s_usbAllowed = false;   // cache do res_share_usb (refreshSettings, 2 s)
bool (*s_usbSend)(uint16_t sid, uint16_t seq, const uint8_t* d, size_t n) = nullptr;
uint16_t s_evSeq = 0;        // seq dos eventos (sid 0) para o PC
constexpr int K_USB_HANDLES = 2;  // handles por procuracao do PC (o resto e dos apps)
// Captura do OPEN do PC: o handleOpen manda ACCEPT/REFUSE pelo sendEnv;
// para o PC a resposta volta no proprio CTL (usbCtl), nao no radio
uint8_t* s_capture = nullptr;
size_t s_captureCap = 0;
int s_captureLen = 0;

constexpr int INBOX_DEPTH = 6;
constexpr int RX_DEPTH = 6;
constexpr int WR_DEPTH = 4;
constexpr int CACHE_NODES = 8;
constexpr int LEASES = 8;
// Teto de um DATA: com PSRAM o plano ESP-NOW leva ate 1458 B por quadro; a
// malha (fallback) segue em MAX_DATA. Sem PSRAM (CYD) nao ha ESP-NOW.
#if CONFIG_SPIRAM
constexpr size_t DATA_CAP = DataLink::PAYLOAD_MAX;
#else
constexpr size_t DATA_CAP = MAX_DATA;
#endif

// ------------------------------------------------------------ estado

struct InMsg {
    uint16_t from;
    char fromName[16];
    uint16_t len;          // 0 = evento "vizinho saiu"
    uint8_t data[ENV_PAYLOAD];
};

struct RxMsg {
    int8_t handle;
    uint16_t len;
    uint8_t data[DATA_CAP];
};

struct WrMsg {
    char res[RES_NAME_MAX + 1];
    uint16_t from;
    char fromName[16];
    uint16_t len;
    uint8_t data[DATA_CAP];
};

struct CacheNode {
    bool used;
    uint16_t id;
    char name[16];
    uint32_t fetchedMs;    // 0 = nunca respondeu
    uint32_t askedMs;      // ultimo DESCRIBE enviado
    uint8_t n;
    uint8_t asks;          // DESCRIBE_META sem resposta (servidor velho apos 2)
    bool legacy;           // so fala DESCRIBE/LIST simples (firmware <= 37)
    Entry e[LIST_MAX];
    Meta m[LIST_MAX];
};

struct Local {
    bool used;
    bool app;              // canal do app corrente (sai no appReset)
    uint8_t type;
    bool shared;
    bool ready;            // provedor existe neste firmware
    const char* policyKey; // setting do dono (nativos); nullptr = sem politica
    bool allowed;          // cache do policyKey (refreshSettings)
    bool autoOff;          // TYPE_GPIO: params {"off":1} — fim do lease desliga
    Meta m;                // metadados do LIST_META (API 38)
    char name[RES_NAME_MAX + 1];
};

struct Handle {
    State state;
    uint8_t reason;
    uint8_t gen;           // vai no req: resposta velha de outro uso do slot nao casa
    uint8_t tries;
    uint16_t node;
    uint16_t sid;
    uint16_t txSeq;
    uint32_t sentMs;       // ultimo OPEN/KEEP
    // plano de dados (do ACCEPT)
    uint8_t transport;
    uint8_t chan;          // canal da sessao ESP-NOW (mudou = renegocia)
    uint8_t mac[6];        // MAC ESP-NOW do servidor
    uint32_t token;
    bool held;             // segura o canal do radio (DataLink::hold)
    uint8_t mode;          // Mode (Resources.h): o que fazer com o stream
    bool local;            // ponta local de audio de pe (tocar/gravar/falar)
    uint32_t maxMs;        // MODE_REC: teto da gravacao
    char path[64];         // MODE_SNAP: arquivo da foto
    char name[RES_NAME_MAX + 1];
    uint8_t plen;
    uint8_t params[PARAMS_MAX];
    bool usb;              // aberto PELO PC no cabo (procuracao, API 41)
    uint8_t usbSeen;       // ultimo State avisado ao PC (EV_STATE)
};

// Tudo que e grande mora num bloco so, alocado no 1o uso (PSRAM primeiro):
// placa sem malha ligada nao paga nada.
struct Heap {
    InMsg inbox[INBOX_DEPTH];
    uint8_t inHead, inCount;
    RxMsg rx[RX_DEPTH];
    uint8_t rxHead, rxCount;
    WrMsg wr[WR_DEPTH];
    uint8_t wrHead, wrCount;
    CacheNode cache[CACHE_NODES];
    // catalogo do gateway USB (usbCtl SUB_MESH): remotes() + encode em bloco
    Remote rs[16];
    usbres::MeshEntry me[16];
    DataLink::Rx dlRx;  // quadro ESP-NOW sendo despachado (tick, sob s_lock)
    uint8_t usbEv[2 + 1460];  // EV_DATA da procuracao do PC (fora da RAM interna fixa)
    InMsg ctrl;         // controle em banda vindo do ESP-NOW
};

Heap* s_heap = nullptr;
SemaphoreHandle_t s_lock = nullptr;
SemaphoreHandle_t s_inLock = nullptr;
bool s_inited = false;

Local s_local[LIST_MAX];
LeaseTable<LEASES> s_leases;
Handle s_h[HANDLES_MAX];

uint32_t nowMs() {
    return (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
}

struct Guard {
    Guard() { xSemaphoreTakeRecursive(s_lock, portMAX_DELAY); }
    ~Guard() { xSemaphoreGiveRecursive(s_lock); }
};

bool heapEnsure() {
    if (s_heap != nullptr) return true;
    Heap* h = (Heap*)heap_caps_calloc(1, sizeof(Heap), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (h == nullptr) h = (Heap*)heap_caps_calloc(1, sizeof(Heap), MALLOC_CAP_8BIT);
    if (h == nullptr) {
        ESP_LOGW(TAG, "sem RAM para os recursos (%u B)", (unsigned)sizeof(Heap));
        return false;
    }
    s_heap = h;
    return true;
}

// Sessoes ESP-NOW abertas (servidor + cliente): prendem o canal do radio
int s_espnowSessions = 0;
TaskHandle_t s_rxTask = nullptr;  // res_rx: drena o ESP-NOW e roda os temporizadores
void rxTaskEnsure();               // abaixo

void holdRadio(bool on) {
    DataLink::hold(on);
    s_espnowSessions += on ? 1 : -1;
    if (s_espnowSessions < 0) s_espnowSessions = 0;
}

int establishedEspnow();  // abaixo (precisa de s_h/s_leases)

// Nosso enlace ESP-NOW para o OPEN (cliente) ou a decisao (servidor). Sobe o
// ESP-NOW no 1o uso (aloca e inicia o driver WiFi: fora de callbacks).
// "Preso" = STA no AP ou sessao ESP-NOW JA ESTABELECIDA — o hold de uma
// negociacao em curso nao conta (anunciar preso no proprio OPEN fazia o
// servidor, preso no AP em outro canal, cair para a malha).
Link ownLink(bool allowWifiInit = true) {
    Link l;
    if (!DataLink::ensure(allowWifiInit)) return l;
    rxTaskEnsure();
    DataLink::Self me;
    DataLink::self(&me);
    l.flags = LINK_UP | ((me.sta || establishedEspnow() > 0) ? LINK_LOCKED : 0);
    l.chan = me.chan;
    memcpy(l.mac, me.mac, 6);
    return l;
}

void providerStop(const LeaseTable<LEASES>::Lease& l);  // abaixo (precisa de s_local)

// Aviso de uso (privacidade): mic/camera/gpio aberto por outro no aparece
// na central de notificacoes do dono e some no fim da sessao. A notificacao
// grava na flash: so o tick (pilha interna) mexe nela — o fim da sessao pode
// vir da res_rx (lease vencido), que so marca o pedido.
constexpr uint32_t K_NOTE_BASE = 0x52455300;  // 'RES' + tipo
struct UseNote {
    bool show = false, hide = false;
    char who[16] = {0};
    char what[20] = {0};   // "Microfone em uso" / nome do recurso (gpio)
};
UseNote s_note[6];  // por TYPE_* (1..5)

void noteUse(uint8_t type, const char* who, bool on, const char* what) {
    if (type != TYPE_MIC && type != TYPE_CAMERA && type != TYPE_GPIO) return;
    UseNote& n = s_note[type];
    if (on) {
        n.show = true;
        n.hide = false;
        snprintf(n.who, sizeof(n.who), "%s", who != nullptr ? who : "");
        if (what == nullptr) {
            what = type == TYPE_MIC ? "Microfone em uso" : "Câmera em uso";
        }
        snprintf(n.what, sizeof(n.what), "%s", what);
    } else {
        n.show = false;
        n.hide = true;
    }
}

// Lease saindo (CLOSE, vencido, revogado): para o provedor nativo e devolve o
// canal se era ESP-NOW
void leaseGone(const LeaseTable<LEASES>::Lease& l) {
    providerStop(l);
    if (l.transport == TRANSPORT_ESPNOW) holdRadio(false);
}

// MAC ESP-NOW dos vizinhos (aprendido no OPEN/ACCEPT): o CONTROLE das
// sessoes vai tambem por ali. Sob dados pesados o coex tira o radio do BLE e
// o OPEN/ACCEPT/KEEP pela malha chegava dezenas de segundos depois (bancada
// 2026-10-11: sessao do 4848 abriu 40 s depois sob 65 KB/s). Os ops de
// controle sao idempotentes, entao o caminho duplo so custa um quadro.
struct PeerMac {
    uint16_t node;
    uint8_t mac[6];
};
constexpr int PEERS = 8;
PeerMac s_peers[PEERS];

// Presenca pelo ESP-NOW (OP_HELLO): soma-se a da malha no remotes()
struct HelloNode {
    uint16_t id;
    uint8_t caps;
    char name[RES_NAME_MAX + 1];
    uint32_t lastMs;
};
constexpr int HELLOS = 8;
constexpr uint32_t K_HELLO_MS = 5000, K_HELLO_TTL_MS = 15000;
constexpr uint16_t TOKEN_ALL = 0xFFFF;  // CTRL broadcast para todos (HELLO)
HelloNode s_hello[HELLOS];
// diagnostico do controle em banda (shell "res")
uint32_t s_ctrlRx = 0, s_ctrlNotUs = 0, s_ctrlFrom0 = 0, s_helloOk = 0;
uint8_t s_peerPos = 0;

void learnPeer(uint16_t node, const uint8_t mac[6]) {
    static const uint8_t zero[6] = {0};
    if (node == 0 || memcmp(mac, zero, 6) == 0) return;
    for (int i = 0; i < PEERS; i++) {
        if (s_peers[i].node == node) {
            memcpy(s_peers[i].mac, mac, 6);
            return;
        }
    }
    s_peers[s_peerPos].node = node;
    memcpy(s_peers[s_peerPos].mac, mac, 6);
    s_peerPos = (uint8_t)((s_peerPos + 1) % PEERS);
}

const uint8_t* peerMac(uint16_t node) {
    for (int i = 0; i < PEERS; i++) {
        if (s_peers[i].node == node && node != 0) return s_peers[i].mac;
    }
    return nullptr;
}

// Id do no = PackId (2 ultimos bytes da MAC BT), lido direto: com a malha
// ainda desligada o CelerNet::info dava 0 e o HELLO/controle da esp32-cam
// saia com remetente 0 — os vizinhos descartavam tudo (bancada 2026-10-11).
// Os recursos andam pelo ESP-NOW sem a malha BLE.
uint16_t ourNode() {
    return PackId::nodeId();
}

// Nome anunciado no HELLO: o da identidade unica (cache na RAM do PackId —
// a task res_rx, pilha na PSRAM, NAO pode ler o NVS; o tick recarrega)
void ourName(char* out, size_t cap) {
    PackId::name(out, cap);
}

// Recursos no ar: malha BLE ligada OU o plano ESP-NOW de pe
bool linkAlive() {
    return CelerNet::active() || DataLink::up();
}

bool sendEnv(uint16_t to, const uint8_t* p, size_t n, bool urgent) {
    if (n == 0) return false;
    // gateway USB: o controle do OPEN do PC nao vai ao radio — captura
    if (s_capture != nullptr) {
        const size_t c = n < s_captureCap ? n : s_captureCap;
        memcpy(s_capture, p, c);
        s_captureLen = (int)c;
        return true;
    }
    // controle (tudo menos DATA) tambem pelo ESP-NOW quando o par e conhecido
    bool viaNow = false;
    // o sid do quadro CTRL leva o NOSSO id de no: o par aprende (id, MAC) ja
    // no 1o controle (depois de um reboot o ACCEPT rapido chegava de MAC
    // desconhecido e era jogado fora — sobrava a copia lenta da malha)
    if (p[0] != OP_DATA && DataLink::up()) {
        const uint8_t* mac = peerMac(to);
        if (mac != nullptr) {
            viaNow = DataLink::send(mac, DataLink::KIND_CTRL, ourNode(), 0, 0, p, n);
        } else {
            // par ainda sem MAC: broadcast ESP-NOW com o destino no token (quem
            // nao e o destino ignora). Nos no mesmo canal (o caso comum: todos
            // no mesmo AP) se acham sem depender da malha BLE — na esp32-cam com
            // o WiFi conectado o coex deixa a malha a ~0,3 quadro/s e a fila
            // cheia RECUSAVA o LIST de 15 B (bancada 2026-10-11)
            static const uint8_t kBcast[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
            viaNow = DataLink::send(kBcast, DataLink::KIND_CTRL, ourNode(), to, 0, p, n);
        }
    }
    const bool viaMesh = Pack::send(to, Pack::KIND_RES, p, n, urgent);
    return viaMesh || viaNow;
}

// ------------------------------------------------------------ servidor

int localFind(const char* name) {
    for (int i = 0; i < LIST_MAX; i++) {
        if (s_local[i].used && strcasecmp(s_local[i].name, name) == 0) return i;
    }
    return -1;
}

const char* policyDefault(const char* key);  // abaixo (junto da politica)

int localAdd(const char* name, uint8_t type, bool shared, bool ready, bool app,
             const char* policyKey, const Meta* meta = nullptr) {
    if (localFind(name) >= 0) return -1;
    for (int i = 0; i < LIST_MAX; i++) {
        if (!s_local[i].used) {
            Local* l = &s_local[i];
            memset(l, 0, sizeof(*l));
            l->used = true;
            l->app = app;
            l->type = type;
            l->shared = shared;
            l->ready = ready;
            l->policyKey = policyKey;
            l->allowed = policyKey == nullptr || CelerSettings::get(policyKey, policyDefault(policyKey)) == "1";
            if (meta != nullptr) l->m = *meta;
            snprintf(l->name, sizeof(l->name), "%s", name);
            return i;
        }
    }
    return -1;
}

// Default do interruptor do dono: leitura (mic/speaker/camera/sensor) nasce
// compartilhada; ATUADOR (gpio/relé) nasce DESLIGADO — acionar fisica
// remota e diferente de expor um mic, o dono decide de proposito
const char* policyDefault(const char* key) {
    if (key == nullptr) return "1";
    // atuador e a porta USB do PC nascem DESLIGADOS; leitura nasce "1"
    return (strcmp(key, "res_share_gpio") == 0 || strcmp(key, "res_share_usb") == 0) ? "0" : "1";
}

bool policyAllows(const Local& l) {
    // CelerNet v3: mic e camera so na matilha PRIVADA — na "celer" aberta
    // qualquer vizinho entraria (a chave dela e publica). O gpio idem: na
    // aberta qualquer vizinho acenderia o rele
    if ((l.type == TYPE_MIC || l.type == TYPE_CAMERA || l.type == TYPE_GPIO) &&
        !NetKeys::provisioned()) {
        return false;
    }
    return l.policyKey == nullptr || l.allowed;
}

// So de pilha interna (tick do servico, init): le o NVS
void refreshSettings() {
    PackId::init();  // nome (o "cfg celernet_name" grava direto no NVS)
    s_usbAllowed = CelerSettings::get("res_share_usb", policyDefault("res_share_usb")) == "1";
    for (int i = 0; i < LIST_MAX; i++) {
        Local& l = s_local[i];
        if (l.used && l.policyKey != nullptr) {
            l.allowed = CelerSettings::get(l.policyKey, policyDefault(l.policyKey)) == "1";
        }
    }
}

// Derruba todas as sessoes de um recurso local avisando os clientes.
void revokeRid(int rid, uint8_t reason) {
    for (int i = 0; i < LEASES; i++) {
        LeaseTable<LEASES>::Lease* l = s_leases.at(i);
        if (l == nullptr || l->rid != rid) continue;
        uint8_t b[8];
        sendEnv(l->client, b, encodeRevoke(l->sid, reason, b, sizeof(b)), true);
        leaseGone(*l);
        s_leases.close(l->client, l->sid);
    }
}

// Ponta nativa do recurso aberto (servidor). OPEN repetido da mesma sessao
// (ACCEPT perdido) chega aqui de novo: as pontas sao idempotentes por sid.
// "fps":3 / "q":12 no JSON de params do OPEN (sem parser: o cliente monta)
int paramInt(const uint8_t* params, size_t plen, const char* key, int def) {
    char k[16];
    snprintf(k, sizeof(k), "\"%s\":", key);
    const size_t kl = strlen(k);
    for (size_t i = 0; i + kl < plen; i++) {
        if (memcmp(params + i, k, kl) == 0) return atoi((const char*)params + i + kl);
    }
    return def;
}

bool providerStart(const LeaseTable<LEASES>::Lease& l, const uint8_t* params, size_t plen) {
    switch (s_local[l.rid].type) {
        case TYPE_CAMERA: {
            // OPEN repetido da mesma sessao (ACCEPT perdido): a task ja serve
            const int fps = paramInt(params, plen, "fps", 0);
            const int q = paramInt(params, plen, "q", 12);
            if (CamRes::serving(l.sid)) return true;  // OPEN repetido: a task ja serve
            return CamRes::serveStart(l.mac, l.sid, l.token, q, fps);
        }
        case TYPE_MIC:
            if (AudioRes::sourceActive()) return true;  // a desta sessao (exclusivo)
            return AudioRes::sourceStart(l.mac, l.sid, l.token);
        case TYPE_SPEAKER:
            if (AudioRes::playActive()) return true;
            return AudioRes::playStart(l.sid);
        case TYPE_GPIO: {
            if (GpioRes::busy(l.sid)) return true;  // OPEN repetido
            // auto-off: o fim do lease (CLOSE, vencido, revogado) devolve o
            // pino ao nivel baixo — a sessao inteira pode morrer que o
            // atuador desliga (o dono local sempre pode de volta, e ganha)
            s_local[l.rid].autoOff = paramInt(params, plen, "off", 0) != 0;
            return GpioRes::serveStart(l.sid, s_local[l.rid].name, params, plen);
        }
        case TYPE_SENSOR: {
            if (SensorRes::busy(l.sid)) return true;
            const int idx = SensorRes::indexOf(s_local[l.rid].name);
            const int rate = paramInt(params, plen, "rate", 0);
            return SensorRes::serveStart(l.sid, l.mac, l.token, idx, rate);
        }
        default:
            return true;  // canal de dados: nada nativo
    }
}

void providerStop(const LeaseTable<LEASES>::Lease& l) {
    if (!s_local[l.rid].used) return;
    noteUse(s_local[l.rid].type, nullptr, false, nullptr);
    switch (s_local[l.rid].type) {
        case TYPE_MIC: AudioRes::sourceStop(l.sid); break;
        case TYPE_SPEAKER: AudioRes::playStop(l.sid); break;
        case TYPE_CAMERA: CamRes::serveStop(l.sid); break;
        case TYPE_GPIO:
            GpioRes::serveStop(l.sid, s_local[l.rid].autoOff);
            s_local[l.rid].autoOff = false;
            break;
        case TYPE_SENSOR: SensorRes::serveStop(l.sid); break;
        default: break;
    }
}

void handleDescribe(uint16_t from) {
    Entry list[LIST_MAX];
    int n = 0;
    for (int i = 0; i < LIST_MAX && n < LIST_MAX; i++) {
        const Local& l = s_local[i];
        if (!l.used) continue;
        Entry& e = list[n++];
        e.type = l.type;
        e.flags = (uint8_t)((l.shared ? FLAG_SHARED : 0) | (l.ready ? FLAG_READY : 0) |
                            (!l.shared && s_leases.countRid((uint8_t)i) > 0 ? FLAG_BUSY : 0));
        snprintf(e.name, sizeof(e.name), "%s", l.name);
    }
    uint8_t b[ENV_PAYLOAD];
    sendEnv(from, b, encodeList(list, n, b, sizeof(b)), true);  // controle: fura a fila de dados
}

// Pedido do cliente moderno (API 38): o mesmo catalogo COM metadados. Se os
// TLVs nao couberem no envelope, cai para o LIST simples (cliente aceita os
// dois; ele perde so a unidade/faixa)
void handleDescribeMeta(uint16_t from) {
    Entry list[LIST_MAX];
    Meta metas[LIST_MAX];
    int n = 0;
    for (int i = 0; i < LIST_MAX && n < LIST_MAX; i++) {
        const Local& l = s_local[i];
        if (!l.used) continue;
        Entry& e = list[n];
        e.type = l.type;
        e.flags = (uint8_t)((l.shared ? FLAG_SHARED : 0) | (l.ready ? FLAG_READY : 0) |
                            (!l.shared && s_leases.countRid((uint8_t)i) > 0 ? FLAG_BUSY : 0));
        snprintf(e.name, sizeof(e.name), "%s", l.name);
        metas[n] = l.m;
        n++;
    }
    uint8_t b[ENV_PAYLOAD];
    size_t len = encodeListMeta(list, metas, n, b, sizeof(b));
    if (len == 0) len = encodeList(list, n, b, sizeof(b));
    sendEnv(from, b, len, true);
}

void handleOpen(uint16_t from, const uint8_t* body, size_t len, bool usb) {
    OpenReq rq;
    if (!decodeOpen(body, len, &rq)) return;
    if (!usb && (rq.link.flags & LINK_UP)) learnPeer(from, rq.link.mac);
    uint8_t b[32];
    const int rid = localFind(rq.name);
    uint8_t reason = 0;
    if (rid < 0) {
        reason = REASON_NOT_FOUND;
    } else if (usb && !s_usbAllowed) {
        reason = REASON_POLICY;  // master res_share_usb (default "0")
    } else if (!policyAllows(s_local[rid])) {
        reason = REASON_POLICY;
    } else if (!s_local[rid].ready) {
        reason = REASON_UNSUPPORTED;
    } else if (!s_local[rid].shared) {
        // exclusivo: so o MESMO cliente reabre (OPEN repetido pela perda do ACCEPT)
        for (int i = 0; i < LEASES; i++) {
            LeaseTable<LEASES>::Lease* l = s_leases.at(i);
            if (l != nullptr && l->rid == rid && l->client != from) reason = REASON_BUSY;
        }
    }
    if (reason == 0) {
        LeaseTable<LEASES>::Lease* l = s_leases.open(from, (uint8_t)rid, nowMs(), K_LEASE_MS);
        if (l == nullptr) {
            reason = REASON_FULL;
        } else {
            Accept ac;
            ac.req = rq.req;
            ac.sid = l->sid;
            ac.leaseDs = LEASE_DS_DEFAULT;
            if (usb) {
                // o cabo e o transporte (doc §8): sem radio, sem hold; a
                // MAC/token do lease nao sao usados no ar
                l->transport = TRANSPORT_USB;
                ac.transport = TRANSPORT_USB;
            } else if (l->transport == TRANSPORT_ESPNOW) {
                // OPEN repetido (ACCEPT perdido): mesma decisao, mesmo token
                DataLink::Self me;
                DataLink::self(&me);
                ac.transport = TRANSPORT_ESPNOW;
                ac.chan = me.chan;
                memcpy(ac.mac, me.mac, 6);
                ac.token = l->token;
            } else {
                // plano de dados: ESP-NOW se os dois tem e cabem num canal
                const Link mine = ownLink();
                uint8_t chan = 0;
                if (chooseTransport(mine, rq.link, &chan) == TRANSPORT_ESPNOW &&
                    DataLink::setChannel(chan)) {
                    l->transport = TRANSPORT_ESPNOW;
                    memcpy(l->mac, rq.link.mac, 6);
                    l->token = esp_random();
                    holdRadio(true);
                    ac.transport = TRANSPORT_ESPNOW;
                    ac.chan = chan;
                    memcpy(ac.mac, mine.mac, 6);
                    ac.token = l->token;
                }
            }
            // recursos de stream: so com ESP-NOW, e com a ponta nativa de pe.
            // Exceto o sensor POR PEDIDO ({"rate":0}), que cabe no DATA da
            // propria malha. Pelo cabo (TRANSPORT_USB) a onda B.1 leva data/
            // gpio/sensor — mic/speaker/camera em stream ficam para a B.2
            const uint8_t type = s_local[rid].type;
            uint8_t fail = 0;
            if (ac.transport == TRANSPORT_USB) {
                if (!(type == TYPE_DATA || type == TYPE_GPIO || type == TYPE_SENSOR)) {
                    fail = REASON_NO_LINK;
                }
            } else if (type != TYPE_DATA && ac.transport != TRANSPORT_ESPNOW &&
                       !(type == TYPE_SENSOR && paramInt(rq.params, rq.plen, "rate", 0) == 0)) {
                fail = REASON_NO_LINK;
            }
            if (fail == 0 && !providerStart(*l, rq.params, rq.plen)) {
                fail = REASON_BUSY;  // mic/speaker em uso aqui (app local, outra fala)
            }
            if (fail != 0) {
                LeaseTable<LEASES>::Lease dead = *l;
                if (dead.transport == TRANSPORT_ESPNOW) holdRadio(false);
                s_leases.close(from, l->sid);
                (void)dead;
                ESP_LOGI(TAG, "%04X pediu \"%s\": %s", from, rq.name, reasonName(fail));
                sendEnv(from, b, encodeRefuse(rq.req, fail, b, sizeof(b)), true);
                return;
            }
            char who[16];
            snprintf(who, sizeof(who), usb ? "PC" : "%04X", from);
            if (!usb) {
                Pack::Member ms[CelerNet::NODES_MAX];
                const int nm = Pack::members(ms, CelerNet::NODES_MAX);
                for (int i = 0; i < nm; i++) {
                    if (ms[i].id == from && ms[i].name[0] != '\0') {
                        snprintf(who, sizeof(who), "%s", ms[i].name);
                    }
                }
            }
            noteUse(type, who, true, type == TYPE_GPIO ? s_local[rid].name : nullptr);
            if (ac.transport == TRANSPORT_USB) {
                ESP_LOGI(TAG, "sessao %u: %s abriu \"%s\" via cabo", (unsigned)l->sid, who, rq.name);
            } else if (ac.transport == TRANSPORT_ESPNOW) {
                ESP_LOGI(TAG, "sessao %u: %s abriu \"%s\" via ESP-NOW (canal %u)", (unsigned)l->sid,
                         who, rq.name, ac.chan);
            } else {
                ESP_LOGI(TAG, "sessao %u: %s abriu \"%s\" via malha", (unsigned)l->sid, who, rq.name);
            }
            sendEnv(from, b, encodeAccept(ac, b, sizeof(b)), true);
            return;
        }
    }
    ESP_LOGI(TAG, "%04X pediu \"%s\": %s", from, rq.name, reasonName(reason));
    sendEnv(from, b, encodeRefuse(rq.req, reason, b, sizeof(b)), true);
}

void handleKeep(uint16_t from, uint16_t sid) {
    if (s_leases.keep(from, sid, nowMs())) return;
    // sessao que nao conhecemos (reboot do servidor, lease vencido): avisa
    // para o cliente reabrir em vez de seguir renovando no vazio
    uint8_t b[8];
    sendEnv(from, b, encodeRevoke(sid, REASON_EXPIRED, b, sizeof(b)), true);
}

void pushWrite(const Local& l, uint16_t from, const char* fromName, const uint8_t* d, size_t n) {
    if (s_heap->wrCount >= WR_DEPTH) {  // cheia: descarta a mais antiga
        s_heap->wrHead = (uint8_t)((s_heap->wrHead + 1) % WR_DEPTH);
        s_heap->wrCount--;
    }
    WrMsg* w = &s_heap->wr[(s_heap->wrHead + s_heap->wrCount) % WR_DEPTH];
    snprintf(w->res, sizeof(w->res), "%s", l.name);
    w->from = from;
    snprintf(w->fromName, sizeof(w->fromName), "%s", fromName);
    w->len = (uint16_t)n;
    memcpy(w->data, d, n);
    s_heap->wrCount++;
}

// Amostras do SensorRes (registrada no init): o transporte vem do LEASE —
// DataLink para a sessao ESP-NOW, cabo (KL_RES_DATA) para a do PC
void sensorSend(uint16_t sid, const uint8_t mac[6], uint32_t token, const uint8_t* d, size_t n) {
    static uint16_t s_sensorSeq = 0;
    s_sensorSeq++;
    LeaseTable<LEASES>::Lease* l = s_leases.find(sid);
    if (l != nullptr && l->transport == TRANSPORT_USB) {
        if (s_usbSend != nullptr) s_usbSend(sid, s_sensorSeq, d, n);
        return;
    }
    DataLink::send(mac, DataLink::KIND_DATA, sid, token, s_sensorSeq, d, n);
}

// Servidor -> cliente num lease (resposta do gpio/sensor). O caminho e o
// mesmo do publish: ESP-NOW quando o lease tem, senao o DATA do envelope.
void serverSendData(const LeaseTable<LEASES>::Lease& l, const uint8_t* d, size_t n) {
    static uint16_t s_seq = 0;
    s_seq++;
    if (l.transport == TRANSPORT_USB) {
        // o cabo: sai como KL_RES_DATA (sendResFrame registrada pelo HostLink)
        if (s_usbSend != nullptr) s_usbSend(l.sid, s_seq, d, n);
        return;
    }
    if (l.transport == TRANSPORT_ESPNOW) {
        DataLink::send(l.mac, DataLink::KIND_DATA, l.sid, l.token, s_seq, d, n);
        return;
    }
    if (n > MAX_DATA) return;
    uint8_t b[ENV_PAYLOAD];
    sendEnv(l.client, b, encodeData(l.sid, s_seq, d, n, b, sizeof(b)), false);
}

// DATA do cliente chegando num NOSSO lease: gpio/sensor falam com o provedor
// nativo (atuacao NA HORA, resposta de volta); canal de app vai a fila do
// JS (pollWrite). O lease ja veio renovado pelo chamador.
void serverDataIn(const LeaseTable<LEASES>::Lease& l, uint16_t from, const char* fromName,
                  const uint8_t* d, size_t n) {
    const Local& loc = s_local[l.rid];
    if (!loc.used) return;
    uint8_t reply[8];
    size_t rlen = 0;
    if (loc.type == TYPE_GPIO) {
        if (GpioRes::data(l.sid, d, n, reply, &rlen) && rlen > 0) serverSendData(l, reply, rlen);
        return;
    }
    if (loc.type == TYPE_SENSOR) {
        if (n >= 1 && d[0] == 2) {  // pedido de leitura (o caso {"rate":0})
            rlen = (size_t)SensorRes::sampleOnce(SensorRes::indexOf(loc.name), reply);
            if (rlen > 0) serverSendData(l, reply, rlen);
        }
        return;  // stream periodico so sai do servidor; escrita nao se aplica
    }
    pushWrite(loc, from, fromName, d, n);
}

// ------------------------------------------------------------- cliente

int handleBySid(uint16_t node, uint16_t sid) {
    for (int i = 0; i < HANDLES_MAX; i++) {
        if ((s_h[i].state == ST_OPEN || s_h[i].state == ST_OPENING) && s_h[i].node == node &&
            s_h[i].sid == sid && sid != 0) {
            return i;
        }
    }
    return -1;
}

int establishedEspnow() {
    int n = 0;
    for (int i = 0; i < HANDLES_MAX; i++) {
        if (s_h[i].state == ST_OPEN && s_h[i].transport == TRANSPORT_ESPNOW) n++;
    }
    for (int i = 0; i < LEASES; i++) {
        LeaseTable<LEASES>::Lease* l = s_leases.at(i);
        if (l != nullptr && l->transport == TRANSPORT_ESPNOW) n++;
    }
    return n;
}

// Handle saindo do ar (fechado/revogado/perdido): para a ponta local de
// audio (a gravacao fica para o Mic.stop colher) e solta o canal
void handleRelease(Handle& x) {
    if (x.local) {
        x.local = false;
        if (x.mode == MODE_SNAP || x.mode == MODE_VIEW) CamRes::clientEnd((int)(&x - s_h));
        if (x.mode == MODE_PLAY) AudioRes::playStop(x.sid);
        else if (x.mode == MODE_SPEAK) AudioRes::sourceStop(x.sid);
        // MODE_REC: o buffer fica (o app colhe com Mic.stop)
    }
    if (x.held) {
        x.held = false;
        holdRadio(false);
    }
}

// req = indice do slot (3 bits) + geracao (5 bits)
uint8_t reqOf(int h) {
    return (uint8_t)((h & 7) | ((s_h[h].gen & 0x1F) << 3));
}

int handleByReq(uint16_t node, uint8_t req) {
    const int h = req & 7;
    if (h >= HANDLES_MAX) return -1;
    if (s_h[h].state != ST_OPENING || s_h[h].node != node || reqOf(h) != req) return -1;
    return h;
}

void sendOpen(int h) {
    Handle& x = s_h[h];
    uint8_t b[ENV_PAYLOAD];
    const Link mine = ownLink();
    // segura o canal JA na negociacao: um scan de fundo entre o OPEN e o
    // ACCEPT fazia a troca de canal falhar ("canal indisponivel")
    if ((mine.flags & LINK_UP) && !x.held) {
        x.held = true;
        holdRadio(true);
    }
    size_t n = encodeOpen(reqOf(h), x.name, x.params, x.plen, mine, b, sizeof(b));
    x.sentMs = nowMs();
    x.tries++;
    sendEnv(x.node, b, n, true);
}

CacheNode* cacheFor(uint16_t id, bool create) {
    CacheNode* free_ = nullptr;
    CacheNode* oldest = nullptr;
    for (int i = 0; i < CACHE_NODES; i++) {
        CacheNode* c = &s_heap->cache[i];
        if (c->used && c->id == id) return c;
        if (!c->used && free_ == nullptr) free_ = c;
        if (c->used && (oldest == nullptr || (int32_t)(c->askedMs - oldest->askedMs) < 0)) oldest = c;
    }
    if (!create) return nullptr;
    CacheNode* c = free_ != nullptr ? free_ : oldest;
    memset(c, 0, sizeof(*c));
    c->used = true;
    c->id = id;
    return c;
}

bool usbEventLocked(const uint8_t* d, size_t n) {
    if (!s_usbSession || s_usbSend == nullptr) return false;
    return s_usbSend(usbres::EVENT_SID, s_evSeq++, d, n);
}

void rxPushData(int h, const uint8_t* d, size_t n) {
    if (s_h[h].usb) {
        // procuracao do PC: o DATA do dono segue direto pelo cabo
        const size_t m = usbres::encodeEvData((uint8_t)h, d, n, s_heap->usbEv, sizeof(s_heap->usbEv));
        if (m > 0) usbEventLocked(s_heap->usbEv, m);
        return;
    }
    if (s_heap->rxCount >= RX_DEPTH) {  // cheia: descarta a mais antiga (dado novo vale mais)
        s_heap->rxHead = (uint8_t)((s_heap->rxHead + 1) % RX_DEPTH);
        s_heap->rxCount--;
    }
    RxMsg* m = &s_heap->rx[(s_heap->rxHead + s_heap->rxCount) % RX_DEPTH];
    m->handle = (int8_t)h;
    m->len = (uint16_t)n;
    memcpy(m->data, d, n);
    s_heap->rxCount++;
}

// ------------------------------------------------------------ despacho

void dispatch(const InMsg& m) {
    if (m.len == 0) {  // evento: vizinho saiu
        // so da malha: um no que segue mandando HELLO pelo ESP-NOW esta vivo —
        // a presenca BLE da esp32-cam oscila (coex) e o "saiu" matava a foto
        // no meio da transferencia (bancada 2026-10-11)
        const uint32_t now = nowMs();
        for (int h = 0; h < HELLOS; h++) {
            if (s_hello[h].id == m.from && now - s_hello[h].lastMs <= K_HELLO_TTL_MS) return;
        }
        for (int i = 0; i < HANDLES_MAX; i++) {
            if ((s_h[i].state == ST_OPEN || s_h[i].state == ST_OPENING) && s_h[i].node == m.from) {
                s_h[i].state = ST_LOST;
                handleRelease(s_h[i]);
                ESP_LOGI(TAG, "handle %d: %04X saiu da malha", i, m.from);
            }
        }
        return;
    }
    const uint8_t op = m.data[0];
    Reader r(m.data + 1, m.len - 1);
    switch (op) {
        case OP_DESCRIBE:
            handleDescribe(m.from);
            return;
        case OP_DESCRIBE_META:
            handleDescribeMeta(m.from);
            return;
        case OP_LIST: {
            CacheNode* c = cacheFor(m.from, true);
            int n = decodeList(m.data + 1, m.len - 1, c->e, LIST_MAX);
            if (n < 0) return;
            c->n = (uint8_t)n;
            c->fetchedMs = nowMs();
            if (c->fetchedMs == 0) c->fetchedMs = 1;
            snprintf(c->name, sizeof(c->name), "%s", m.fromName);
            return;
        }
        case OP_LIST_META: {  // catalogo com metadados (API 38)
            CacheNode* c = cacheFor(m.from, true);
            int n = decodeListMeta(m.data + 1, m.len - 1, c->e, c->m, LIST_MAX);
            if (n < 0) return;
            c->n = (uint8_t)n;
            c->asks = 0;
            c->fetchedMs = nowMs();
            if (c->fetchedMs == 0) c->fetchedMs = 1;
            snprintf(c->name, sizeof(c->name), "%s", m.fromName);
            return;
        }
        case OP_OPEN:
            handleOpen(m.from, m.data + 1, m.len - 1, false);
            return;
        case OP_ACCEPT: {
            Accept ac;
            if (!decodeAccept(m.data + 1, m.len - 1, &ac)) return;
            if (ac.transport == TRANSPORT_ESPNOW) learnPeer(m.from, ac.mac);
            int h = handleByReq(m.from, ac.req);
            if (h < 0 && handleBySid(m.from, ac.sid) >= 0) return;  // copia (ESP-NOW + malha)
            if (h < 0) {
                // ACCEPT de um OPEN que ja desistimos: fecha la para nao
                // prender o recurso exclusivo ate o lease vencer
                uint8_t b[8];
                sendEnv(m.from, b, encodeSid(OP_CLOSE, ac.sid, b, sizeof(b)), false);
                return;
            }
            Handle& x = s_h[h];
            x.state = ST_OPEN;
            x.sid = ac.sid;
            x.sentMs = nowMs();
            x.transport = TRANSPORT_MESH;
            if (ac.transport == TRANSPORT_ESPNOW) {
                // o servidor escolheu o canal com o nosso enlace do OPEN: se
                // estamos livres, vamos para ele (falhar aqui = dados perdidos;
                // fica na malha, que o servidor nao usa — reabre pela malha)
                if (DataLink::up() && DataLink::setChannel(ac.chan)) {
                    x.transport = TRANSPORT_ESPNOW;
                    x.chan = ac.chan;
                    memcpy(x.mac, ac.mac, 6);
                    x.token = ac.token;
                    if (!x.held) {
                        x.held = true;
                        holdRadio(true);
                    }
                } else {
                    ESP_LOGW(TAG, "handle %d: canal %u indisponivel para o ESP-NOW", h, ac.chan);
                }
            }
            // ponta local de audio do modo pedido (sobe so com ESP-NOW)
            if (x.mode != MODE_DATA) {
                bool ok = x.transport == TRANSPORT_ESPNOW;
                if (ok && x.mode == MODE_PLAY) ok = AudioRes::playStart(x.sid);
                else if (ok && x.mode == MODE_SPEAK) ok = AudioRes::sourceStart(x.mac, x.sid, x.token);
                else if (ok && x.mode == MODE_REC) ok = AudioRes::recStart(x.sid, x.maxMs);
                else if (ok && (x.mode == MODE_SNAP || x.mode == MODE_VIEW)) {
                    CamRes::clientBegin(h, x.mode == MODE_VIEW);
                }
                if (!ok) {
                    // sem ESP-NOW ou o hardware local ocupado: desfaz a sessao
                    uint8_t b[8];
                    sendEnv(m.from, b, encodeSid(OP_CLOSE, x.sid, b, sizeof(b)), false);
                    handleRelease(x);
                    x.state = ST_REFUSED;
                    x.reason = x.transport == TRANSPORT_ESPNOW ? REASON_BUSY : REASON_NO_LINK;
                    ESP_LOGI(TAG, "handle %d: ponta local de audio indisponivel (%s)", h, reasonName(x.reason));
                    return;
                }
                x.local = true;
            }
            // sessao pela malha nao precisa do canal: solta o hold da negociacao
            if (x.transport != TRANSPORT_ESPNOW) handleRelease(x);
            ESP_LOGI(TAG, "handle %d: \"%s\" em %04X aberto (sessao %u, %s)", h, x.name, m.from,
                     (unsigned)ac.sid, x.transport == TRANSPORT_ESPNOW ? "ESP-NOW" : "malha");
            return;
        }
        case OP_REFUSE: {
            uint8_t req, reason;
            if (!r.u8(&req) || !r.u8(&reason)) return;
            int h = handleByReq(m.from, req);
            if (h < 0) return;
            s_h[h].state = ST_REFUSED;
            s_h[h].reason = reason;
            return;
        }
        case OP_KEEP: {
            uint16_t sid;
            if (r.u16(&sid)) handleKeep(m.from, sid);
            return;
        }
        case OP_CLOSE: {
            uint16_t sid;
            if (!r.u16(&sid)) return;
            LeaseTable<LEASES>::Lease* cl = s_leases.find(sid);
            if (cl != nullptr && cl->client == m.from) leaseGone(*cl);
            // CLOSE e so cliente -> servidor (o servidor usa REVOKE): os sids sao
            // de cada servidor, e um CLOSE repetido (ESP-NOW + malha) nao pode
            // casar um handle NOSSO que por acaso tenha o mesmo numero
            if (s_leases.close(m.from, sid)) {
                ESP_LOGI(TAG, "sessao %u: %04X fechou", (unsigned)sid, m.from);
            }
            return;
        }
        case OP_REVOKE: {
            uint16_t sid;
            uint8_t reason = REASON_GONE;
            if (!r.u16(&sid)) return;
            r.u8(&reason);
            int h = handleBySid(m.from, sid);
            if (h >= 0 && reason == REASON_EXPIRED) {
                // o servidor esqueceu a sessao (lease venceu na perda dos
                // KEEPs, reboot): o app ainda quer o recurso — reabre com o
                // MESMO handle, sem o app ver o buraco
                ESP_LOGI(TAG, "handle %d: sessao expirou em %04X, reabrindo", h, m.from);
                handleRelease(s_h[h]);
                s_h[h].state = ST_OPENING;
                s_h[h].sid = 0;
                s_h[h].tries = 0;
                s_h[h].gen++;
                sendOpen(h);
            } else if (h >= 0) {
                s_h[h].state = ST_REVOKED;
                s_h[h].reason = reason;
                handleRelease(s_h[h]);
                ESP_LOGI(TAG, "handle %d: revogado por %04X (%s)", h, m.from, reasonName(reason));
            }
            return;
        }
        case OP_HELLO: {
            uint8_t caps = 0;
            char name[RES_NAME_MAX + 1];
            if (!decodeHello(m.data + 1, m.len - 1, &caps, name)) return;
            const uint32_t now = nowMs();
            HelloNode* slot = nullptr;
            for (int i = 0; i < HELLOS; i++) {
                if (s_hello[i].id == m.from) slot = &s_hello[i];
            }
            for (int i = 0; i < HELLOS && slot == nullptr; i++) {
                if (s_hello[i].id == 0 || now - s_hello[i].lastMs > K_HELLO_TTL_MS) slot = &s_hello[i];
            }
            if (slot == nullptr) return;
            slot->id = m.from;
            slot->caps = caps;
            snprintf(slot->name, sizeof(slot->name), "%s", name);
            slot->lastMs = now;
            s_helloOk++;
            return;
        }
        case OP_DATA: {
            uint16_t sid, seq;
            if (!r.u16(&sid) || !r.u16(&seq)) return;
            (void)seq;
            const size_t n = r.left();
            if (n == 0) return;
            int h = handleBySid(m.from, sid);
            if (h >= 0) {  // servidor -> nos (cliente)
                rxPushData(h, r.rest(), n);
                return;
            }
            LeaseTable<LEASES>::Lease* l = s_leases.find(sid);
            if (l != nullptr && l->client == m.from && s_local[l->rid].used) {
                l->expiresMs = nowMs() + l->leaseMs;  // escrita tambem renova
                serverDataIn(*l, m.from, m.fromName, r.rest(), n);
            }
            return;
        }
        default:
            return;  // op do futuro: ignora
    }
}

bool inboxPop(InMsg* out) {
    bool got = false;
    xSemaphoreTake(s_inLock, portMAX_DELAY);
    if (s_heap != nullptr && s_heap->inCount > 0) {
        *out = s_heap->inbox[s_heap->inHead];
        s_heap->inHead = (uint8_t)((s_heap->inHead + 1) % INBOX_DEPTH);
        s_heap->inCount--;
        got = true;
    }
    xSemaphoreGive(s_inLock);
    return got;
}

void inboxPush(uint16_t from, const char* fromName, const uint8_t* p, size_t len) {
    if (!s_inited || s_heap == nullptr || len > ENV_PAYLOAD) return;
    xSemaphoreTake(s_inLock, portMAX_DELAY);
    if (s_heap->inCount >= INBOX_DEPTH) {
        s_heap->inHead = (uint8_t)((s_heap->inHead + 1) % INBOX_DEPTH);
        s_heap->inCount--;
    }
    InMsg* m = &s_heap->inbox[(s_heap->inHead + s_heap->inCount) % INBOX_DEPTH];
    m->from = from;
    snprintf(m->fromName, sizeof(m->fromName), "%s", fromName != nullptr ? fromName : "");
    m->len = (uint16_t)len;
    if (len > 0) memcpy(m->data, p, len);
    s_heap->inCount++;
    xSemaphoreGive(s_inLock);
}

// Metadados fixos dos nativos (vao para a flash, o Local copia)
Meta relayMeta() {
    Meta m;
    snprintf(m.schema, sizeof(m.schema), "{\"off\":0|1}");
    m.ver = 1;
    return m;
}

Meta percentMeta() {
    Meta m;
    snprintf(m.unit, sizeof(m.unit), "%%");
    m.rangeMin = 0.0f;
    m.rangeMax = 100.0f;
    m.hasRange = true;
    m.ver = 1;
    return m;
}

void registerNatives() {
    const BoardProfile& bp = Board::profile();
    // Provedores nativos (exclusivos: um mic, um speaker). Audio pronto (R3)
    // onde o hardware toca/le PCM; o buzzer LEDC (speakerPin) aparece sem
    // FLAG_READY. A camera chega depois.
    if (bp.mic.ws >= 0) localAdd("mic", TYPE_MIC, false, AudioRes::micAvailable(), false, "res_share_mic");
    if (bp.speakerPin >= 0 || bp.i2s.dout >= 0) {
        localAdd("speaker", TYPE_SPEAKER, false, AudioRes::speakerAvailable(), false, "res_share_spk");
    }
#if CONFIG_CELEROS_JS_CAMERA
    if (bp.camera.present()) localAdd("camera", TYPE_CAMERA, false, CamRes::available(), false, "res_share_cam");
#endif
    // GPIO/atuador (API 38): cada rele do perfil vira recurso exclusivo
    // ("rele1"..). O interruptor res_share_gpio nasce DESLIGADO (o dono
    // liga de proposito) e o acesso so existe na matilha privada.
    const Meta rm = relayMeta();
    if (GpioRes::available()) {
        for (int i = 0; i < bp.relay.count && i < 3; i++) {
            char nm[RES_NAME_MAX + 1];
            snprintf(nm, sizeof(nm), "rele%d", i + 1);
            localAdd(nm, TYPE_GPIO, false, true, false, "res_share_gpio", &rm);
        }
    }
    // Sensores de placa (API 38): leitura passiva, compartilhada
    const Meta pm = percentMeta();
    if (BoardIO::hasLightSensor()) localAdd("lum", TYPE_SENSOR, true, true, false, "res_share_sens", &pm);
    if (bp.batteryPin >= 0) localAdd("bat", TYPE_SENSOR, true, true, false, "res_share_sens", &pm);
}

}  // namespace

// ================================================================ publico

void init() {
    if (s_inited) return;
    s_lock = xSemaphoreCreateRecursiveMutex();
    s_inLock = xSemaphoreCreateMutex();
    if (s_lock == nullptr || s_inLock == nullptr) return;
    s_leases.seed((uint16_t)(esp_random() & 0xFFFF));
    SensorRes::setSendHook(sensorSend);
    registerNatives();
    s_inited = true;
    // Ordem de boot da RAM interna (esp32-cam: depois do WiFi sobram ~74 KB e
    // o NimBLE leva ~38): 1o o ESP-NOW e a res_rx (o driver WiFi ja subiu no
    // boot), depois o worker e o driver da camera. Com a camera primeiro o
    // esp_now_init nao achava RAM e a cam ficava fora do plano de dados
    {
        Guard g;
        ownLink(false);
    }
    CamRes::init();
    CameraCore::warmup();
}

void onEnvelope(uint16_t from, const char* fromName, const uint8_t* payload, size_t len) {
    if (len == 0) return;
    inboxPush(from, fromName, payload, len);
}

void onMemberLeft(uint16_t id) {
    inboxPush(id, "", nullptr, 0);
}

// Parte temporizada (sob s_lock): leases vencidos, renegociacao de canal,
// retry do OPEN e KEEP. Roda no tick E na task res_rx — um app parado num
// System.delay longo nao bombeia os servicos, e sem isto o lease vencia e o
// stream de audio morria no meio
namespace {  // plano de dados (task res_rx) e temporizadores

void tickTimers();
void handleDataRx(const DataLink::Rx& dr);

// Task do plano de dados: o quadro e tratado ao chegar (o stream de audio nao
// espera o proximo present do app) e os temporizadores rodam a cada 100 ms.
// Pilha na PSRAM: nada aqui toca a flash — o controle em banda (o OPEN le a
// politica no NVS) vai para a caixa de entrada, que o tick normal despacha.
void rxTask(void*) {
    DataLink::Rx* rx = (DataLink::Rx*)heap_caps_malloc(sizeof(DataLink::Rx),
                                                       MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    uint32_t lastTimers = 0;
    for (;;) {
        if (rx != nullptr && DataLink::pollWait(rx, 50)) {
            if (rx->kind == DataLink::KIND_CTRL) {
                s_ctrlRx++;
                const uint16_t from = rx->sid;  // id do no remetente (ver sendEnv)
                // broadcast: o token leva o destino (0 = unicast, ja e nosso)
                const bool forUs = rx->token == 0 || rx->token == ourNode() || rx->token == TOKEN_ALL;
                if (!forUs) s_ctrlNotUs++;
                if (from == 0) s_ctrlFrom0++;
                if (forUs && from != 0 && from != ourNode() && rx->len > 0) {
                    {
                        Guard g;
                        learnPeer(from, rx->mac);
                    }
                    inboxPush(from, "", rx->data, rx->len);
                }
            } else {
                Guard g;
                handleDataRx(*rx);
            }
        }
        const uint32_t now = nowMs();
        if (now - lastTimers >= 100) {
            lastTimers = now;
            Guard g;
            tickTimers();
        }
    }
}

void rxTaskEnsure() {
    if (s_rxTask != nullptr) return;
    // 6 KB na PSRAM (S3) / 4 KB internos (ESP32 classico, ver TaskCaps.h)
    if (celerTaskCreate(rxTask, "res_rx", 6144, 4096, nullptr, 6, &s_rxTask) != pdPASS) {
        s_rxTask = nullptr;  // o tick segue drenando (mais devagar)
        ESP_LOGW(TAG, "task res_rx nao subiu: o tick drena o ESP-NOW");
    }
}

void tickTimers() {
    // HELLO pelo ESP-NOW (broadcast, todos): presenca redundante com a malha
    static uint32_t s_helloMs = 0;
    if (DataLink::up() && nowMs() - s_helloMs >= K_HELLO_MS) {
        s_helloMs = nowMs();
        char nm[RES_NAME_MAX + 1];
        ourName(nm, sizeof(nm));
        uint8_t b[24];
        static const uint8_t kAll[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
        const size_t n = encodeHello(Pack::myCaps(), nm, b, sizeof(b));
        if (n > 0) DataLink::send(kAll, DataLink::KIND_CTRL, ourNode(), TOKEN_ALL, 0, b, n);
    }
    const uint32_t now = nowMs();
    // sensores em stream (rate > 0): amostra as sessoes vencidas e empurra
    SensorRes::tick();
    // leases do PC (gateway USB): renovados enquanto a sessao do cabo vive —
    // a queda (idle 8 s na UART, desconexao CDC) derruba a sessao
    // (usbSession(false)) e dai o lease vence como o de qualquer cliente
    if (s_usbSession) {
        for (int i = 0; i < LEASES; i++) {
            LeaseTable<LEASES>::Lease* l = s_leases.at(i);
            if (l != nullptr && l->client == usbNode()) l->expiresMs = nowMs() + l->leaseMs;
        }
    }
    // leases vencidos (cliente sumiu sem CLOSE)
    LeaseTable<LEASES>::Lease dead;
    while (s_leases.expireOne(now, &dead)) {
        leaseGone(dead);
        ESP_LOGI(TAG, "sessao %u: lease de %04X venceu (\"%s\")", (unsigned)dead.sid, dead.client,
                 s_local[dead.rid].used ? s_local[dead.rid].name : "?");
    }
    // canal do radio mudou com sessao ESP-NOW aberta (reconectou num AP em
    // outro canal): o par nao nos ouve mais — renegocia (o OPEN leva o canal novo)
    static uint32_t s_chanCheckMs = 0;
    if (s_espnowSessions > 0 && now - s_chanCheckMs >= 1000) {
        s_chanCheckMs = now;
        DataLink::Self me;
        DataLink::self(&me);
        for (int i = 0; i < HANDLES_MAX; i++) {
            Handle& x = s_h[i];
            if (x.state == ST_OPEN && x.transport == TRANSPORT_ESPNOW && x.chan != me.chan) {
                ESP_LOGI(TAG, "handle %d: canal %u -> %u, renegociando", i, x.chan, me.chan);
                uint8_t b[8];
                sendEnv(x.node, b, encodeSid(OP_CLOSE, x.sid, b, sizeof(b)), false);
                x.state = ST_OPENING;
                x.transport = TRANSPORT_MESH;
                x.sid = 0;
                x.tries = 0;
                x.gen++;
                sendOpen(i);
            }
        }
    }
    // cliente: bitmap da foto em curso (rajada parada / completou)
    for (int i = 0; i < HANDLES_MAX; i++) {
        const Handle& x = s_h[i];
        if (x.state == ST_OPEN && x.local && x.mode == MODE_SNAP) CamRes::clientTimers(i, x.mac, x.sid, x.token);
    }
    // cliente: retry do OPEN e KEEP periodico
    for (int i = 0; i < HANDLES_MAX; i++) {
        Handle& x = s_h[i];
        if (x.state == ST_OPENING && now - x.sentMs >= K_OPEN_RETRY_MS) {
            if (x.tries >= K_OPEN_TRIES) {
                x.state = ST_LOST;
                handleRelease(x);
                ESP_LOGI(TAG, "handle %d: %04X nao respondeu ao OPEN de \"%s\"", i, x.node, x.name);
            } else {
                sendOpen(i);
            }
        } else if (x.state == ST_OPEN && now - x.sentMs >= K_LEASE_MS / 4) {
            // urgente: 1 quadro que fura a fila (atras dos fragmentos de
            // dados ele chegava depois do lease vencer)
            uint8_t b[8];
            x.sentMs = now;
            sendEnv(x.node, b, encodeSid(OP_KEEP, x.sid, b, sizeof(b)), true);
        }
    }
}

// Um quadro ESP-NOW recebido (sob s_lock): controle em banda, stream de
// audio ou DATA de sessao — casa por (MAC, sid, token)
void handleDataRx(const DataLink::Rx& dr) {
    if (dr.kind == DataLink::KIND_CTRL && dr.len > 0 && dr.len <= ENV_PAYLOAD) {
        // controle em banda: o sid do quadro e o id do no remetente; broadcast
        // leva o destino no token
        const uint16_t from = dr.sid;
        if (from == 0 || from == ourNode() ||
            (dr.token != 0 && dr.token != ourNode() && dr.token != TOKEN_ALL)) {
            return;
        }
        learnPeer(from, dr.mac);
        InMsg& cm = s_heap->ctrl;
        cm.from = from;
        cm.fromName[0] = '\0';
        cm.len = dr.len;
        memcpy(cm.data, dr.data, dr.len);
        dispatch(cm);
        return;
    }
    if (dr.kind == DataLink::KIND_STREAM && dr.len > 0) {
        bool used = false;
        for (int i = 0; i < HANDLES_MAX && !used; i++) {  // servidor -> nos (mic remoto)
            const Handle& x = s_h[i];
            if (x.state == ST_OPEN && x.local && x.sid == dr.sid && x.token == dr.token &&
                memcmp(x.mac, dr.mac, 6) == 0) {
                if (x.mode == MODE_PLAY) AudioRes::playFeed(x.sid, dr.data, dr.len);
                else if (x.mode == MODE_REC) AudioRes::recFeed(x.sid, dr.data, dr.len);
                used = true;
            }
        }
        if (used) return;
        LeaseTable<LEASES>::Lease* l = s_leases.find(dr.sid);  // cliente -> nos (nosso speaker)
        if (l != nullptr && l->transport == TRANSPORT_ESPNOW && l->token == dr.token &&
            memcmp(l->mac, dr.mac, 6) == 0 && s_local[l->rid].type == TYPE_SPEAKER) {
            l->expiresMs = nowMs() + l->leaseMs;
            AudioRes::playFeed(l->sid, dr.data, dr.len);
        }
        return;
    }
    if (dr.kind == DataLink::KIND_BULK || dr.kind == DataLink::KIND_BULK_ACK) {
        if (dr.kind == DataLink::KIND_BULK) {  // servidor -> nos (foto/video)
            for (int i = 0; i < HANDLES_MAX; i++) {
                const Handle& x = s_h[i];
                if (x.state == ST_OPEN && x.local && (x.mode == MODE_SNAP || x.mode == MODE_VIEW) &&
                    x.sid == dr.sid && x.token == dr.token && memcmp(x.mac, dr.mac, 6) == 0) {
                    CamRes::clientChunk(i, dr.data, dr.len);
                    return;
                }
            }
            return;
        }
        LeaseTable<LEASES>::Lease* l = s_leases.find(dr.sid);  // cliente -> nos (bitmap)
        if (l != nullptr && l->transport == TRANSPORT_ESPNOW && l->token == dr.token &&
            memcmp(l->mac, dr.mac, 6) == 0) {
            l->expiresMs = nowMs() + l->leaseMs;
            CamRes::onAck(l->sid, dr.data, dr.len);
        }
        return;
    }
    if (dr.kind != DataLink::KIND_DATA || dr.len == 0) return;
    bool done = false;
    for (int i = 0; i < HANDLES_MAX && !done; i++) {  // servidor -> nos (cliente)
        const Handle& x = s_h[i];
        if (x.state == ST_OPEN && x.transport == TRANSPORT_ESPNOW && x.sid == dr.sid &&
            x.token == dr.token && memcmp(x.mac, dr.mac, 6) == 0) {
            rxPushData(i, dr.data, dr.len);
            done = true;
        }
    }
    if (done) return;
    LeaseTable<LEASES>::Lease* l = s_leases.find(dr.sid);  // cliente -> nos (servidor)
    if (l != nullptr && l->transport == TRANSPORT_ESPNOW && l->token == dr.token &&
        memcmp(l->mac, dr.mac, 6) == 0 && s_local[l->rid].used) {
        l->expiresMs = nowMs() + l->leaseMs;
        Pack::Member who[CelerNet::NODES_MAX];
        const int nm = Pack::members(who, CelerNet::NODES_MAX);
        const char* nmName = "";
        for (int j = 0; j < nm; j++) {
            if (who[j].id == l->client) nmName = who[j].name;
        }
        serverDataIn(*l, l->client, nmName, dr.data, dr.len);
    }
}

}  // namespace

void tick() {
    if (!s_inited) return;
    // A caixa so existe depois do 1o uso; o handler da malha precisa dela
    // para nao perder o 1o DESCRIBE/OPEN que chega: aloca com a malha no ar.
    // ESP-NOW de pe onde o driver WiFi ja roda (STA no AP ou buscando rede):
    // o controle em broadcast acha os vizinhos do mesmo canal sem esperar a
    // malha. Sem o driver (WiFi desligado), so na 1a sessao — subir o WiFi so
    // por isso custa a RAM interna das placas justas
    static uint32_t s_setMs = 0;
    if (nowMs() - s_setMs > 2000) {
        s_setMs = nowMs();
        Guard g;
        refreshSettings();
    }
    // no virtual (PC no cabo, API 41): membro da matilha enquanto o cabo
    // vive com o res_share_usb ligado (o BEAT proxy sai pela CelerNet)
    {
        const bool want = s_usbSession && s_usbAllowed && CelerNet::active();
        const bool on = CelerNet::proxyNode() != 0;
        if (want && !on) {
            char nm[CelerNet::MAX_NAME + 1];
            packid::pcName(PackId::nodeId(), nm, sizeof(nm));
            CelerNet::setProxy(usbNode(), nm, netframe::CAPS_HUB);
        } else if (!want && on) {
            CelerNet::setProxy(0, nullptr, 0);
        }
    }
    // procuracoes do PC: estado novo vira EV_STATE; terminal libera o slot
    {
        Guard g;
        for (int i = 0; i < HANDLES_MAX; i++) {
            Handle& x = s_h[i];
            if (!x.usb || x.state == x.usbSeen) continue;
            uint8_t ev[8];
            const size_t n = usbres::encodeEvState((uint8_t)i, x.state, x.reason, x.node, ev, sizeof(ev));
            if (n > 0) usbEventLocked(ev, n);
            x.usbSeen = x.state;
            if (x.state != ST_OPENING && x.state != ST_OPEN) {
                handleRelease(x);
                x.usb = false;
                x.state = ST_FREE;
            }
        }
    }
    static uint32_t s_dlTryMs = 0;
    if (!DataLink::up() && nowMs() - s_dlTryMs > 10000) {
        s_dlTryMs = nowMs();
        Guard g;
        ownLink(false);  // so se o driver ja roda (nunca inicia o WiFi aqui)
    }
    if (s_heap == nullptr) {
        if (!linkAlive()) return;
        Guard g;
        if (!heapEnsure()) return;
    }
    Guard g;
    InMsg m;
    for (int i = 0; i < INBOX_DEPTH && inboxPop(&m); i++) dispatch(m);

    // avisos de uso pendentes (flash: so aqui, pilha interna)
    for (uint8_t t = TYPE_MIC; t <= TYPE_SENSOR; t++) {
        UseNote& n = s_note[t];
        if (n.show) {
            n.show = false;
            Notifications::push(n.what, std::string("por ") + n.who + " (matilha)", "matilha", K_NOTE_BASE + t);
        } else if (n.hide) {
            n.hide = false;
            Notifications::removeById(K_NOTE_BASE + t);
        }
    }

    // foto completa: grava AQUI (task do servico, pilha interna) — a res_rx
    // tem pilha na PSRAM e nao pode escrever na flash
    for (int i = 0; i < HANDLES_MAX; i++) {
        Handle& x = s_h[i];
        uint8_t* img = nullptr;
        size_t len = 0;
        if (x.state != ST_OPEN || x.mode != MODE_SNAP || !CamRes::clientTakeImage(i, &img, &len)) continue;
        const bool atomic = strncmp(x.path, "/local/", 7) == 0;
        char tmp[72];
        snprintf(tmp, sizeof(tmp), "%s%s", x.path, atomic ? ".tmp" : "");
        FILE* f = fopen(tmp, "wb");
        bool ok = f != nullptr && fwrite(img, 1, len, f) == len;
        if (f != nullptr) ok = fclose(f) == 0 && ok;
        if (atomic && (!ok || rename(tmp, x.path) != 0)) {
            unlink(tmp);
            ok = false;
        }
        free(img);
        ESP_LOGI(TAG, "handle %d: foto de %04X (%u B) -> %s: %s", i, x.node, (unsigned)len, x.path,
                 ok ? "ok" : "falhou");
        // o ACK cheio sai no proximo temporizador; a sessao fecha logo depois
        CamRes::clientTimers(i, x.mac, x.sid, x.token);
        uint8_t b[8];
        sendEnv(x.node, b, encodeSid(OP_CLOSE, x.sid, b, sizeof(b)), false);
        handleRelease(x);
        x.state = ok ? ST_DONE : ST_REFUSED;
        x.reason = ok ? 0 : REASON_FULL;
    }

    // plano de dados ESP-NOW: a task res_rx drena na hora; sem ela (placa
    // que nao subiu a task) o tick drena o que houver
    if (s_rxTask == nullptr) {
        DataLink::Rx& dr = s_heap->dlRx;  // 1,5 KB na PSRAM (sob s_lock)
        for (int k = 0; k < 16 && DataLink::poll(&dr); k++) handleDataRx(dr);
    }

    tickTimers();

}

int remotes(Remote* out, int max) {
    if (!s_inited || !linkAlive()) return 0;
    Guard g;
    if (!heapEnsure()) return 0;
    const uint32_t now = nowMs();
    // candidatos: membros da malha + nos ouvidos pelo HELLO do ESP-NOW
    Pack::Member ms[CelerNet::NODES_MAX + HELLOS];
    int nm = Pack::members(ms, CelerNet::NODES_MAX);
    for (int h = 0; h < HELLOS; h++) {
        const HelloNode& hn = s_hello[h];
        if (hn.id == 0 || now - hn.lastMs > K_HELLO_TTL_MS) continue;
        bool dup = false;
        for (int i = 0; i < nm && !dup; i++) dup = ms[i].id == hn.id;
        if (dup) continue;
        Pack::Member& x = ms[nm++];
        memset(&x, 0, sizeof(x));
        x.id = hn.id;
        x.caps = hn.caps;
        snprintf(x.name, sizeof(x.name), "%s", hn.name);
    }
    int n = 0;
    for (int i = 0; i < nm; i++) {
        CacheNode* c = cacheFor(ms[i].id, false);
        const bool fresh = c != nullptr && c->fetchedMs != 0 && now - c->fetchedMs < K_CACHE_FRESH_MS;
        if (!fresh && (c == nullptr || now - c->askedMs >= K_DESCRIBE_GAP_MS || c->askedMs == 0)) {
            c = cacheFor(ms[i].id, true);
            // moderno primeiro (DESCRIBE_META, com metadados): um servidor
            // velho ignora o op e nao responde — apos 2 tentativas sem
            // resposta o no vira legacy e segue com o DESCRIBE de sempre
            if (!c->legacy) {
                c->asks++;
                if (c->asks >= 2) c->legacy = true;
            }
            c->askedMs = now;
            uint8_t b[4];
            if (c->legacy) {
                sendEnv(ms[i].id, b, encodeDescribe(b, sizeof(b)), true);
            } else {
                sendEnv(ms[i].id, b, encodeDescribeMeta(b, sizeof(b)), true);
            }
        }
        if (c == nullptr || c->fetchedMs == 0) continue;
        for (int k = 0; k < c->n && n < max; k++) {
            out[n].node = c->id;
            snprintf(out[n].nodeName, sizeof(out[n].nodeName), "%s", ms[i].name[0] ? ms[i].name : c->name);
            out[n].e = c->e[k];
            out[n].m = c->m[k];
            n++;
        }
    }
    return n;
}

int open(uint16_t node, const char* name, const uint8_t* params, size_t plen, Mode mode,
         uint32_t maxMs) {
    if (!s_inited || !linkAlive() || name == nullptr || name[0] == '\0') return -1;
    if (strlen(name) > RES_NAME_MAX || plen > PARAMS_MAX) return -1;
    Guard g;
    if (!heapEnsure()) return -1;
    // slot livre: FREE primeiro; senao um terminal (REFUSED/LOST/...) que o
    // app ja nao consulta — o mais antigo
    int h = -1;
    for (int i = 0; i < HANDLES_MAX && h < 0; i++) {
        if (s_h[i].state == ST_FREE) h = i;
    }
    for (int i = 0; i < HANDLES_MAX && h < 0; i++) {
        // procuracao do PC com estado terminal ainda nao avisado: nao e do app
        if (s_h[i].state != ST_OPEN && s_h[i].state != ST_OPENING && !s_h[i].usb) h = i;
    }
    if (h < 0) return -1;
    Handle& x = s_h[h];
    const uint8_t gen = (uint8_t)(x.gen + 1);
    memset(&x, 0, sizeof(x));
    x.gen = gen;
    x.state = ST_OPENING;
    x.node = node;
    snprintf(x.name, sizeof(x.name), "%s", name);
    x.plen = (uint8_t)plen;
    if (plen > 0) memcpy(x.params, params, plen);
    x.mode = (uint8_t)mode;
    x.maxMs = maxMs;
    sendOpen(h);
    return h;
}

int openCamera(uint16_t node, bool video, int fps, int quality, const char* path) {
    char params[48];
    snprintf(params, sizeof(params), "{\"fps\":%d,\"q\":%d}", video ? fps : 0, quality);
    const int h = open(node, "camera", (const uint8_t*)params, strlen(params), video ? MODE_VIEW : MODE_SNAP, 0);
    if (h >= 0 && path != nullptr) {
        Guard g;
        snprintf(s_h[h].path, sizeof(s_h[h].path), "%s", path);
    }
    return h;
}

bool takeFrame(int h, uint8_t** buf, size_t* len) {
    if (h < 0 || h >= HANDLES_MAX || !s_inited) return false;
    Guard g;
    if (s_h[h].state != ST_OPEN || s_h[h].mode != MODE_VIEW) return false;
    return CamRes::clientLatest(h, buf, len);
}

bool recording(int h) {
    if (h < 0 || h >= HANDLES_MAX || !s_inited) return false;
    Guard g;
    const Handle& x = s_h[h];
    if (x.mode != MODE_REC) return false;
    // abrindo ainda conta (o app ve "gravando" desde o start)
    return x.state == ST_OPENING || (x.state == ST_OPEN && AudioRes::recActive(x.sid));
}

int recLevel() {
    return AudioRes::recLevel();
}

char* recStop(int h, bool base64, size_t* lenOut, uint32_t* msOut) {
    if (h < 0 || h >= HANDLES_MAX || !s_inited) return nullptr;
    Guard g;
    if (s_h[h].mode != MODE_REC) return nullptr;
    close(h);  // para o mic remoto antes de colher
    return AudioRes::recStop(base64, lenOut, msOut);
}

void localClaim(uint8_t type) {
    if (!s_inited) return;
    Guard g;
    for (int i = 0; i < LIST_MAX; i++) {
        if (s_local[i].used && !s_local[i].app && s_local[i].type == type && s_leases.countRid((uint8_t)i) > 0) {
            ESP_LOGI(TAG, "app local pediu \"%s\": sessoes remotas revogadas", s_local[i].name);
            revokeRid(i, REASON_LOCAL);
        }
    }
}

bool resolve(const char* to, uint16_t* out) {
    if (CelerNet::resolveDest(to, out)) return true;  // "A1B2" ou nome da malha
    if (!s_inited || to == nullptr) return false;
    Guard g;
    const uint32_t now = nowMs();
    for (int h = 0; h < HELLOS; h++) {
        if (s_hello[h].id != 0 && now - s_hello[h].lastMs <= K_HELLO_TTL_MS &&
            strcasecmp(s_hello[h].name, to) == 0) {
            *out = s_hello[h].id;
            return true;
        }
    }
    return false;
}

size_t dataCap() {
    return DATA_CAP;
}

bool info(int h, HandleInfo* out) {
    if (h < 0 || h >= HANDLES_MAX || !s_inited) return false;
    Guard g;
    out->state = s_h[h].state;
    out->reason = s_h[h].reason;
    out->node = s_h[h].node;
    out->espnow = s_h[h].state == ST_OPEN && s_h[h].transport == TRANSPORT_ESPNOW;
    out->bytes = out->total = out->frames = 0;
    if (s_h[h].mode == MODE_SNAP || s_h[h].mode == MODE_VIEW) {
        CamRes::clientProgress(h, &out->bytes, &out->total, &out->frames);
    }
    snprintf(out->name, sizeof(out->name), "%s", s_h[h].name);
    return s_h[h].state != ST_FREE;
}

bool read(int h, uint8_t* buf, size_t cap, size_t* len) {
    if (h < 0 || h >= HANDLES_MAX || !s_inited || s_heap == nullptr) return false;
    Guard g;
    for (int k = 0; k < s_heap->rxCount; k++) {
        const int idx = (s_heap->rxHead + k) % RX_DEPTH;
        if (s_heap->rx[idx].handle != h) continue;
        const RxMsg& m = s_heap->rx[idx];
        const size_t n = m.len < cap ? m.len : cap;
        memcpy(buf, m.data, n);
        *len = n;
        // tira do anel preservando a ordem dos demais
        for (int j = k; j + 1 < s_heap->rxCount; j++) {
            s_heap->rx[(s_heap->rxHead + j) % RX_DEPTH] = s_heap->rx[(s_heap->rxHead + j + 1) % RX_DEPTH];
        }
        s_heap->rxCount--;
        return true;
    }
    return false;
}

bool write(int h, const void* data, size_t len) {
    if (h < 0 || h >= HANDLES_MAX || !s_inited || len == 0 || len > DATA_CAP) return false;
    Guard g;
    Handle& x = s_h[h];
    if (x.state != ST_OPEN) return false;
    ++x.txSeq;
    if (x.transport == TRANSPORT_ESPNOW) {
        return DataLink::send(x.mac, DataLink::KIND_DATA, x.sid, x.token, x.txSeq, data, len);
    }
    if (len > MAX_DATA) return false;  // a malha nao leva mais que isso
    uint8_t b[ENV_PAYLOAD];
    return sendEnv(x.node, b, encodeData(x.sid, x.txSeq, data, len, b, sizeof(b)), false);
}

void close(int h) {
    if (h < 0 || h >= HANDLES_MAX || !s_inited) return;
    Guard g;
    Handle& x = s_h[h];
    if (x.state == ST_OPEN) {
        uint8_t b[8];
        sendEnv(x.node, b, encodeSid(OP_CLOSE, x.sid, b, sizeof(b)), false);
    }
    handleRelease(x);
    if (x.state != ST_FREE) x.state = ST_CLOSED;
    // mensagens pendentes do handle morrem com ele
    if (s_heap != nullptr) {
        uint8_t buf[1];
        size_t n;
        while (read(h, buf, sizeof(buf), &n)) {
        }
    }
}

bool expose(const char* name, bool shared, const resproto::Meta* meta) {
    if (!s_inited || name == nullptr || name[0] == '\0' || strlen(name) > RES_NAME_MAX) return false;
    Guard g;
    return localAdd(name, TYPE_DATA, shared, true, true, nullptr, meta) >= 0;
}

bool unexpose(const char* name) {
    if (!s_inited || name == nullptr) return false;
    Guard g;
    const int rid = localFind(name);
    if (rid < 0 || !s_local[rid].app) return false;
    revokeRid(rid, REASON_GONE);
    s_local[rid].used = false;
    return true;
}

int publish(const char* name, const void* data, size_t len) {
    if (!s_inited || name == nullptr || len == 0 || len > DATA_CAP) return -1;
    Guard g;
    const int rid = localFind(name);
    if (rid < 0 || !s_local[rid].app) return -1;
    static uint16_t s_seq = 0;
    s_seq++;
    int sent = 0;
    uint8_t b[ENV_PAYLOAD];
    for (int i = 0; i < LEASES; i++) {
        LeaseTable<LEASES>::Lease* l = s_leases.at(i);
        if (l == nullptr || l->rid != rid) continue;
        if (l->transport == TRANSPORT_ESPNOW) {
            if (DataLink::send(l->mac, DataLink::KIND_DATA, l->sid, l->token, s_seq, data, len)) sent++;
        } else if (len <= MAX_DATA &&
                   sendEnv(l->client, b, encodeData(l->sid, s_seq, data, len, b, sizeof(b)), false)) {
            sent++;
        }
    }
    return sent;
}

int sessions(const char* name) {
    if (!s_inited || name == nullptr) return -1;
    Guard g;
    const int rid = localFind(name);
    return rid < 0 ? -1 : s_leases.countRid((uint8_t)rid);
}

bool pollWrite(char* res, size_t resCap, uint16_t* from, char* fromName, size_t nameCap,
               uint8_t* data, size_t* len) {
    if (!s_inited || s_heap == nullptr) return false;
    Guard g;
    if (s_heap->wrCount == 0) return false;
    const WrMsg& w = s_heap->wr[s_heap->wrHead];
    snprintf(res, resCap, "%s", w.res);
    *from = w.from;
    snprintf(fromName, nameCap, "%s", w.fromName);
    const size_t n = w.len < *len ? w.len : *len;
    memcpy(data, w.data, n);
    *len = n;
    s_heap->wrHead = (uint8_t)((s_heap->wrHead + 1) % WR_DEPTH);
    s_heap->wrCount--;
    return true;
}

void dump(PrintFn pr, void* ctx) {
    if (!s_inited) {
        pr(ctx, "recursos: servico ainda nao iniciado\r\n");
        return;
    }
    Guard g;
    DataLink::Self me;
    DataLink::self(&me);
    DataLink::Stats ds;
    DataLink::stats(&ds);
    pr(ctx, "ESP-NOW: %s  canal %u%s  mac %02X:%02X:%02X:%02X:%02X:%02X  sessoes %d  res_rx %s\r\n",
       me.up ? "no ar" : "parado", me.chan, me.sta ? " (preso ao AP)" : "", me.mac[0], me.mac[1],
       me.mac[2], me.mac[3], me.mac[4], me.mac[5], s_espnowSessions, s_rxTask ? "sim" : "nao");
    pr(ctx, "  tx %u  falha %u  fila cheia %u | rx %u  descartados %u  alheios %u  sem chave %u  replay %u\r\n",
       (unsigned)ds.tx, (unsigned)ds.txFail, (unsigned)ds.txNoMem, (unsigned)ds.rx, (unsigned)ds.rxDropped,
       (unsigned)ds.rxForeign, (unsigned)ds.rxAuthFail, (unsigned)ds.rxReplay);
    pr(ctx, "locais:\r\n");
    for (int i = 0; i < LIST_MAX; i++) {
        const Local& l = s_local[i];
        if (!l.used) continue;
        pr(ctx, "  %-15s %-8s %s%s%s%s%s%s sessoes %d\r\n", l.name, typeName(l.type),
           l.ready ? "pronto" : "sem provedor", l.shared ? " compartilhado" : "",
           l.app ? " (app)" : "", l.m.unit[0] ? " unidade " : "", l.m.unit[0] ? l.m.unit : "",
           l.autoOff ? " auto-off" : "", s_leases.countRid((uint8_t)i));
    }
    pr(ctx, "leases (servidor):\r\n");
    const uint32_t now = nowMs();
    for (int i = 0; i < LEASES; i++) {
        LeaseTable<LEASES>::Lease* l = s_leases.at(i);
        if (l == nullptr) continue;
        pr(ctx, "  sid %5u  cliente %04X  %-15s %s  vence em %d ms\r\n", (unsigned)l->sid, l->client,
           s_local[l->rid].name, l->transport == TRANSPORT_ESPNOW ? "ESP-NOW" : "malha",
           (int)(l->expiresMs - now));
    }
    static const char* kModes[] = {"dados", "tocar", "gravar", "falar", "foto", "video"};
    static const char* kStates[] = {"livre", "abrindo", "aberto", "recusado", "revogado", "perdido", "fechado", "feito"};
    pr(ctx, "handles (cliente):\r\n");
    for (int i = 0; i < HANDLES_MAX; i++) {
        const Handle& x = s_h[i];
        if (x.state == ST_FREE) continue;
        pr(ctx, "  h%d  %04X/%-15s %-8s %-6s %s%s%s\r\n", i, x.node, x.name, kStates[x.state % 8],
           kModes[x.mode % 6], x.state == ST_OPEN ? (x.transport == TRANSPORT_ESPNOW ? "ESP-NOW" : "malha") : "",
           x.reason ? " motivo " : "", x.reason ? reasonName(x.reason) : "");
    }
    if (s_heap != nullptr) {
        pr(ctx, "cache dos vizinhos:\r\n");
        for (int i = 0; i < CACHE_NODES; i++) {
            const CacheNode& c = s_heap->cache[i];
            if (!c.used) continue;
            pr(ctx, "  %04X %-15s %s", c.id, c.name, c.fetchedMs ? "" : "(sem LIST ainda)");
            for (int k = 0; k < c.n; k++) pr(ctx, " %s%s", c.e[k].name, (c.e[k].flags & FLAG_READY) ? "" : "*");
            pr(ctx, "  (LIST ha %d s, DESCRIBE ha %d s)\r\n", c.fetchedMs ? (int)((now - c.fetchedMs) / 1000) : -1,
               c.askedMs ? (int)((now - c.askedMs) / 1000) : -1);
        }
    }
    pr(ctx, "controle ESP-NOW: rx %u  nao-nosso %u  remetente-0 %u  HELLO ok %u  (nosso id %04X)\r\n",
       (unsigned)s_ctrlRx, (unsigned)s_ctrlNotUs, (unsigned)s_ctrlFrom0, (unsigned)s_helloOk, ourNode());
    pr(ctx, "HELLO (presenca pelo ESP-NOW):\r\n");
    for (int h = 0; h < HELLOS; h++) {
        const HelloNode& hn = s_hello[h];
        if (hn.id == 0) continue;
        pr(ctx, "  %04X %-15s caps 0x%02X  ha %d s\r\n", hn.id, hn.name, hn.caps, (int)((now - hn.lastMs) / 1000));
    }
    pr(ctx, "pares ESP-NOW conhecidos:");
    for (int i = 0; i < PEERS; i++) {
        if (s_peers[i].node != 0) pr(ctx, " %04X", s_peers[i].node);
    }
    pr(ctx, "\r\n");
    AudioRes::Stats as;
    AudioRes::stats(&as);
    pr(ctx, "audio: mic->par %u blocos (%u sem fila)  tocados %u  gravados %u\r\n", (unsigned)as.srcFrames,
       (unsigned)as.srcFail, (unsigned)as.playFrames, (unsigned)as.recFrames);
}

// ================================================================ gateway USB

bool usbEvent(const uint8_t* d, size_t n) {
    if (!s_inited) return false;
    Guard g;
    return usbEventLocked(d, n);
}

void usbSetSend(bool (*fn)(uint16_t sid, uint16_t seq, const uint8_t* d, size_t n)) {
    // O HELLO do HostLink chega a qualquer hora — inclusive no boot, antes do
    // Pack::init criar o mutex (o celerctl reconecta logo apos o reboot do
    // OTA): Guard com s_lock nulo era assert e o OTA voltava no rollback
    // (bancada 2026-10-16). Sem init, ninguem le o ponteiro ainda.
    if (!s_inited) {
        s_usbSend = fn;
        return;
    }
    Guard g;
    s_usbSend = fn;
}

// HELLO do HostLink = PC na porta; endSession (idle de 8 s, cabo) = fora.
// Sem sessao os leases do PC morrem AGORA (auto-off no atuador de sempre).
void usbSession(bool on) {
    if (!s_inited) {
        s_usbSession = on;  // malha nem no ar: so anota
        return;
    }
    Guard g;
    if (s_usbSession == on) return;
    s_usbSession = on;
    if (on) return;
    // procuracoes do PC fecham com o cabo (o dono aplica o auto-off)
    for (int i = 0; i < HANDLES_MAX; i++) {
        if (!s_h[i].usb) continue;
        close(i);
        s_h[i].usb = false;
        s_h[i].state = ST_FREE;
    }
    for (int i = 0; i < LEASES; i++) {
        LeaseTable<LEASES>::Lease* l = s_leases.at(i);
        if (l == nullptr || l->client != usbNode()) continue;
        ESP_LOGI(TAG, "gateway USB: sessao %u morreu com o cabo (\"%s\")", (unsigned)l->sid,
                 s_local[l->rid].used ? s_local[l->rid].name : "?");
        leaseGone(*l);
        s_leases.close(l->client, l->sid);
    }
}

int usbCtl(uint8_t subop, const uint8_t* body, size_t len, uint8_t* out, size_t cap) {
    if (!s_inited) return -1;
    // Entrar na matilha (API 40): fora do Guard — o Provision chama o
    // netChanged daqui, que trava o mesmo mutex
    switch (subop) {
        case usbres::SUB_JOIN: {
            char name[usbres::JOIN_NAME_MAX + 1];
            char pass[usbres::JOIN_PASS_MAX + 1];
            if (!usbres::decodeJoin(body, len, name, pass)) return -1;
            const bool ok = Provision::joinPassword(name, pass);  // PBKDF2 ~0,3 s
            memset(pass, 0, sizeof(pass));
            ESP_LOGI(TAG, "gateway USB: matilha \"%s\" pelo cabo: %s", name, ok ? "ok" : "falhou");
            return ok ? 0 : -1;
        }
        case usbres::SUB_LEAVE:
            Provision::leave();
            ESP_LOGI(TAG, "gateway USB: saiu da matilha pelo cabo");
            return 0;
        case usbres::SUB_SEND: {
            // envelope custom DO PC (no virtual) para um membro — ou o gateway
            if (!s_usbSession || !s_usbAllowed || CelerNet::proxyNode() == 0) return -1;
            if (len < 3 || len - 2 > Pack::MAX_PAYLOAD) return -1;
            const uint16_t to = (uint16_t)((body[0] << 8) | body[1]);
            return Pack::sendAs(usbNode(), to, Pack::KIND_CUSTOM, body + 2, len - 2, false) ? 0 : -1;
        }
        case usbres::SUB_OPEN_AT: {
            // recurso de OUTRO no: o gateway e o cliente por procuracao (o
            // mesmo caminho dos apps: retry, KEEP, reabertura); a resposta e
            // o handle, o resultado chega em EV_STATE
            usbres::OpenAt oa;
            if (!s_usbSession || !s_usbAllowed || !usbres::decodeOpenAt(body, len, &oa)) return -1;
            if (oa.node == ourNode() || oa.node == usbNode()) return -1;  // os locais: SUB_OPEN
            {
                Guard g;
                int busy = 0;
                for (int i = 0; i < HANDLES_MAX; i++) busy += s_h[i].usb ? 1 : 0;
                if (busy >= K_USB_HANDLES) return -1;
            }
            const int h = open(oa.node, oa.name, oa.params, oa.plen, MODE_DATA, 0);
            if (h < 0) return -1;
            Guard g;
            s_h[h].usb = true;
            s_h[h].usbSeen = ST_FREE;  // o 1o tick avisa o OPENING
            if (cap < 1) return -1;
            out[0] = (uint8_t)h;
            ESP_LOGI(TAG, "gateway USB: PC abre \"%s\" em %04X (handle %d)", oa.name, oa.node, h);
            return 1;
        }
        case usbres::SUB_HWRITE: {
            if (len < 2 || body[0] >= HANDLES_MAX) return -1;
            const int h = body[0];
            {
                Guard g;
                if (!s_h[h].usb) return -1;
            }
            return write(h, body + 1, len - 1) ? 0 : -1;
        }
        case usbres::SUB_HCLOSE: {
            if (len < 1 || body[0] >= HANDLES_MAX) return -1;
            const int h = body[0];
            Guard g;
            if (!s_h[h].usb) return -1;
            close(h);  // CLOSE ao dono (auto-off se o OPEN pediu)
            s_h[h].usb = false;
            s_h[h].state = ST_FREE;
            return 0;
        }
        case usbres::SUB_NET: {
            NetKeys::init();
            const NetKeys::Net* n = NetKeys::primary();
            char nm[CelerNet::MAX_NAME + 1];
            ourName(nm, sizeof(nm));
            snprintf((char*)out, cap,
                     "{\"net\":\"%s\",\"prov\":%d,\"node\":\"%04X\",\"name\":\"%s\",\"pc\":\"%04X\"}",
                     n != nullptr ? n->name : "", NetKeys::provisioned() ? 1 : 0, ourNode(), nm,
                     PackId::pcNode());
            return (int)strlen((char*)out);
        }
        default:
            break;
    }
    Guard g;
    switch (subop) {
        case usbres::SUB_DESCRIBE: {
            // identidade do gateway (JSON curto, como o KL_INFO)
            CelerNet::Info st;
            CelerNet::info(&st);
            char j[176];
            snprintf(j, sizeof(j),
                     "{\"id\":\"%04X\",\"name\":\"%s\",\"board\":\"%s\",\"api\":%d,"
                     "\"prov\":%d,\"usb\":%d,\"relay\":%d}",
                     st.node, st.name[0] != '\0' ? st.name : "Celer", Board::profile().id,
                     CELEROS_API_LEVEL, NetKeys::provisioned() ? 1 : 0, s_usbAllowed ? 1 : 0,
                     Board::profile().relay.count);
            snprintf((char*)out, cap, "%s", j);
            return (int)strlen((char*)out);
        }
        case usbres::SUB_LIST: {
            // o mesmo fio do DESCRIBE_META, direto na resposta
            Entry list[LIST_MAX];
            Meta metas[LIST_MAX];
            int n = 0;
            for (int i = 0; i < LIST_MAX && n < LIST_MAX; i++) {
                const Local& l = s_local[i];
                if (!l.used) continue;
                Entry& e = list[n];
                e.type = l.type;
                e.flags = (uint8_t)((l.shared ? FLAG_SHARED : 0) | (l.ready ? FLAG_READY : 0) |
                                    (!l.shared && s_leases.countRid((uint8_t)i) > 0 ? FLAG_BUSY : 0));
                snprintf(e.name, sizeof(e.name), "%s", l.name);
                metas[n] = l.m;
                n++;
            }
            size_t r = encodeListMeta(list, metas, n, out, cap);
            if (r == 0) r = encodeList(list, n, out, cap);
            if (r == 0) return -1;
            // o encode inclui o byte de op (OP_LIST_META/OP_LIST) — no tunel
            // o corpo ja diz qual subop e: strip para o PC ler [n] direto
            memmove(out, out + 1, r - 1);
            return (int)(r - 1);
        }
        case usbres::SUB_MESH: {
            // catalogo dos vizinhos (cache do cliente; a 1a chamada dispara
            // DESCRIBE_META e volta vazia — o PC reconsulta, como os apps)
            if (!heapEnsure()) return -1;
            const int n = remotes(s_heap->rs, 16);
            for (int i = 0; i < n; i++) {
                usbres::MeshEntry& m = s_heap->me[i];
                const Remote& r = s_heap->rs[i];
                m.node = r.node;
                memcpy(m.nodeName, r.nodeName, sizeof(m.nodeName));  // char[16] p/ char[16]
                m.e = s_heap->rs[i].e;
                m.m = s_heap->rs[i].m;
            }
            const size_t r = usbres::encodeMeshList(s_heap->me, n, out, cap);
            // estouro do buffer = erro, nunca "catalogo vazio"
            return r > 0 ? (int)r : -1;
        }
        case usbres::SUB_OPEN: {
            // OPEN integral do ResProto; o ACCEPT/REFUSE que o handleOpen
            // mandaria pelo radio e capturado no sendEnv e vira resposta
            if (!heapEnsure()) return -1;
            s_capture = out;
            s_captureCap = cap;
            s_captureLen = 0;
            handleOpen(usbNode(), body, len, true);
            s_capture = nullptr;
            return s_captureLen;
        }
        case usbres::SUB_KEEP: {
            if (len < 2) return -1;
            const uint16_t sid = (uint16_t)((body[0] << 8) | body[1]);
            LeaseTable<LEASES>::Lease* l = s_leases.find(sid);
            if (l != nullptr && l->client == usbNode()) {
                l->expiresMs = nowMs() + l->leaseMs;
                if (cap > 0) out[0] = 1;  // renovada
                return 1;
            }
            // sessao desconhecida (lease venceu na queda do cabo, reboot):
            // REVOKE expired — o cliente reabre, como os apps
            return (int)encodeRevoke(sid, REASON_EXPIRED, out, cap);
        }
        case usbres::SUB_CLOSE: {
            if (len < 2) return -1;
            const uint16_t sid = (uint16_t)((body[0] << 8) | body[1]);
            LeaseTable<LEASES>::Lease* l = s_leases.find(sid);
            if (l != nullptr && l->client == usbNode()) {
                leaseGone(*l);  // auto-off se o OPEN pediu
                s_leases.close(l->client, l->sid);
                ESP_LOGI(TAG, "sessao %u: PC fechou (\"%s\")", (unsigned)sid,
                         s_local[l->rid].used ? s_local[l->rid].name : "?");
            }
            return 0;
        }
        case usbres::SUB_WRITE: {
            // DATA do PC: roteia igual ao radio (gpio ops, leitura de sensor
            // por pedido, canal de app); a resposta sai como KL_RES_DATA
            usbres::DataHdr dh;
            if (!usbres::decodeDataFrame(body, len, &dh)) return -1;
            LeaseTable<LEASES>::Lease* l = s_leases.find(dh.sid);
            if (l == nullptr || l->client != usbNode()) return -1;
            l->expiresMs = nowMs() + l->leaseMs;  // escrita tambem renova
            serverDataIn(*l, usbNode(), "PC", dh.data, dh.len);
            return 0;
        }
        default:
            return -1;
    }
}

void appReset() {
    if (!s_inited) return;
    Guard g;
    for (int i = 0; i < LIST_MAX; i++) {
        if (s_local[i].used && s_local[i].app) {
            revokeRid(i, REASON_GONE);
            s_local[i].used = false;
        }
    }
    // handles do PC (procuracao) nao sao do app: sobrevivem a troca
    for (int i = 0; i < HANDLES_MAX; i++) {
        if (!s_h[i].usb) close(i);
    }
    for (int i = 0; i < HANDLES_MAX; i++) {
        if (s_h[i].usb) continue;
        const uint8_t gen = s_h[i].gen;
        memset(&s_h[i], 0, sizeof(s_h[i]));
        s_h[i].gen = gen;
    }
    if (s_heap != nullptr) {
        s_heap->wrHead = s_heap->wrCount = 0;
        s_heap->rxHead = s_heap->rxCount = 0;
    }
}

void netChanged() {
    DataLink::netChanged();
    if (!s_inited) return;
    Guard g;
    // sessoes da rede velha: os pares nao decifram mais nada nosso
    for (int i = 0; i < LEASES; i++) {
        LeaseTable<LEASES>::Lease* l = s_leases.at(i);
        if (l == nullptr) continue;
        leaseGone(*l);
        s_leases.close(l->client, l->sid);
    }
    for (int i = 0; i < HANDLES_MAX; i++) close(i);
    memset(s_hello, 0, sizeof(s_hello));
    memset(s_peers, 0, sizeof(s_peers));
}

}  // namespace Resources
