#include "CelerNet.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_coexist.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "sdkconfig.h"

#include "nimble/nimble_port.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"

#include "../Utils/CelerSettings.h"
#include "CelerLink.h"
#include "NetFrame.h"
#include "NetKeys.h"

// No da malha CelerNet (flood de advertising; ver NetFrame.h e CelerNet.h).
//
// Pecas:
//   task do host NimBLE -> onAdvReport(): testa o magic e enfileira o quadro
//     cru (s_raw). Nada mais roda la.
//   tick() (servico ALWAYS, tasks celerLoop e app): drena s_raw, decifra
//     (NetKeys: so quadro que AUTENTICA entra), anti-replay (RPL), presenca, remontagem, agenda repeticoes com jitter e conduz os bursts
//     de TX — tudo sob mutex.
//   meshGapCb(): callback do scanner e dos bursts (ADV_COMPLETE = pacote
//     no ar); os reports seguem para o mesmo onAdvReport().
//
// O burst de TX toma o advertising LEGADO emprestado (so existe 1): para o
// adv do Celer Link/Phone Link, empurra o quadro da malha (ADV_NONCONN,
// 20 ms x 3) e devolve o ar pelo CelerLink::refreshAdvertising(). O
// advRestart do CelerLink ja respeita "adv ativo" (nao atropela o burst);
// as pausas do adv conectavel sao de ~60 ms por pacote, limitadas por
// token bucket (8 pacotes/s).

namespace {

const char* TAG = "celer.net";

// Quadro cru ouvindo no ar (task do host -> tick).
struct RawReport {
    uint8_t len;
    int8_t rssi;
    uint8_t data[netframe::ADV_MAX];
};
constexpr int RAW_DEPTH = 16;

// Quadro esperando o radio: nosso (broadcast/beat/unicast) ou repeticao de
// outro. prio 1 (handoff) fura a fila dos normais no maybeBurst. O quadro
// ja vai CIFRADO: tipo/src/seq/saltos ficam ao lado em claro para a
// supressao e o adiamento de relay nao decifrarem a fila inteira.
struct Pending {
    bool used;
    bool ours;          // conta no txQueued
    uint8_t prio;       // 0 normal, 1 urgente (handoff)
    uint8_t len;
    uint8_t type;       // TYPE_*
    uint8_t hops;       // saltos que o quadro leva no ar
    uint16_t src;
    uint32_t seq;
    uint32_t seqZero;   // FRAG: a mensagem (ver NetFrame.h); demais = seq
    uint32_t dueMs;     // jitter da repeticao (nosso = ja valido)
    uint8_t frame[netframe::ADV_MAX];
};
// Uma mensagem cheia com as 2 copias do unicast (62 quadros) + repeticoes de
// vizinhos. Com 40, os relays pendentes nunca deixavam 31 vagas livres: na
// bancada 2026-10-07 TODO broadcast de 434 B foi recusado (10/10) e o handoff
// de musica (~413 B) caia no mesmo buraco. Vive na PSRAM (~3,6 KB).
constexpr int PENDING_DEPTH = 96;

struct NodeEntry {
    bool used;
    uint16_t id;
    char name[CelerNet::MAX_NAME + 1];
    uint8_t caps;
    uint8_t flags;      // BFLAG_* do BEAT
    int8_t rssi;
    uint8_t hops;
    uint32_t lastMs;
};

// TUDO que e grande vive na PSRAM (fila RX, remontador, fila de TX/relay,
// presenca e dedup): o .bss da malha e ~0 e o boot das placas apertadas
// (watch: o BLE do Phone Link falhava por 881 B com os statics no .bss)
// nem percebe a CelerNet antes dela ser ligada.
struct NetHeap {
    uint8_t head, count;  // ring simples: head + count (tail derivado)
    uint8_t pad[2];
    CelerNet::Msg slots[CelerNet::RX_DEPTH];
    netframe::Reassembler reasm;
    Pending pending[PENDING_DEPTH];
    NodeEntry nodes[CelerNet::NODES_MAX];
    // Anti-replay E dedup numa peca so: janela de 64 seqs por (rede, origem).
    // O seq e unico por quadro (frags e copias inclusos), entao o quadro
    // repetido por um vizinho e o quadro capturado e reinjetado caem no
    // mesmo REPLAY. 32 origens: o dobro da tabela de presenca.
    netframe::Rpl<32> rpl;
};

QueueHandle_t s_raw = nullptr;      // adv reports (host -> tick)
NetHeap* s_heap = nullptr;          // PSRAM (ou interna, se falhar)

bool s_active = false;
bool s_relay = true;
uint16_t s_node = 0;               // 2 ultimos bytes da MAC BT
char s_name[CelerNet::MAX_NAME + 1] = {0};
char s_net[16] = "celer";          // nome da rede primaria (NetKeys)

uint32_t s_txDropped = 0;
uint32_t s_rxDropped = 0;
uint32_t s_relayed = 0;
uint32_t s_relaySuppressed = 0;  // repeticoes canceladas (outro ja repetiu)
uint32_t s_relayDropped = 0;     // repeticoes perdidas: anel de TX cheio
// Pendencias em uso na fila de TX: a fila mora na PSRAM e o tick (~60x/s)
// a varria INTEIRA duas vezes so para saber se estava vazia — com falha de
// cache a cada linha, o relogio gastava ~15 ms a cada 3 s nisso (bancada
// 2026-10-08). Com o contador a fila vazia custa um if.
int s_pendingUsed = 0;
// Telemetria de RX (bench): separa "nao chegou no ar" de "chegou e se perdeu
// no caminho" — reports com o magic aceitos na fila crua, descartados por
// fila cheia, e quadros da NOSSA rede que o tick processou (inclui dups)
uint32_t s_rxRaw = 0;         // escrito so pela task do host
uint32_t s_rxRawDropped = 0;
uint32_t s_rxFrames = 0;
uint32_t s_rxAuthFail = 0;    // quadro v3 que nao autenticou (outra rede/forjado)
uint32_t s_rxReplay = 0;      // seq ja visto (dup de relay ou replay)
uint32_t s_rxOther = 0;       // autenticou na rede SECUNDARIA (aberta)
// ultimo quadro autenticado da rede primaria (bancada: "mesh replay" o
// reinjeta e o RPL tem que descarta-lo)
RawReport s_lastRaw = {};
// Custo do tick (bench): por janela de BEAT (3 s), zerado a cada log
uint32_t s_tickCalls = 0;
uint64_t s_tickUs = 0;
uint32_t s_tickMaxUs = 0;
uint32_t s_telemBeats = 0;        // BEATs desde a ultima linha de telemetria
uint32_t s_telemFail = 0, s_telemRawDrop = 0;  // valores na ultima linha

// Ajuste de bancada (A/B sem recompilar): /local/celernet_tune.txt lido no
// start, "adv=<ms> defer=<0|1> suppress=<0|1>". Sem o arquivo = padroes.
uint32_t s_advMs = 160;      // duracao do adv de cada quadro (ms)
bool s_fragDefer = true;     // relay de FRAG espera a rajada silenciar
bool s_suppress = true;      // cancela relay ja feito por vizinho
// Coexistencia WiFi x BLE: bits de "malha BLE" do agendador do coex (os do
// ESP-BLE-MESH). 0 = nada (WiFi leva o radio quando quer), 1 = STANDBY (a
// malha ganha janelas de scan periodicas), 2 = TRAFFIC (mais radio para o
// BLE enquanto a malha esta ligada).
uint8_t s_coexMode = 1;
uint32_t s_coexBits = 0;

void coexApply(bool on) {
    const uint32_t want = !on ? 0
        : s_coexMode == 2 ? ESP_COEX_BLE_ST_MESH_TRAFFIC
        : s_coexMode == 1 ? ESP_COEX_BLE_ST_MESH_STANDBY : 0;
    if (want == s_coexBits) return;
    if (s_coexBits) esp_coex_status_bit_clear(ESP_COEX_ST_TYPE_BLE, s_coexBits);
    if (want) esp_coex_status_bit_set(ESP_COEX_ST_TYPE_BLE, want);
    s_coexBits = want;
}

void loadTune() {
    // padroes a cada start: apagar o arquivo desfaz o ajuste sem reboot
    s_advMs = 160;
    s_fragDefer = true;
    s_suppress = true;
    s_coexMode = 1;
    FILE* f = fopen("/local/celernet_tune.txt", "r");
    if (f == nullptr) return;
    char line[96] = {0};
    if (fgets(line, sizeof(line), f) != nullptr) {
        const char* p;
        if ((p = strstr(line, "adv=")) != nullptr) {
            int v = atoi(p + 4);
            if (v >= 20 && v <= 400) s_advMs = (uint32_t)v;
        }
        if ((p = strstr(line, "defer=")) != nullptr) s_fragDefer = p[6] == '1';
        if ((p = strstr(line, "suppress=")) != nullptr) s_suppress = p[9] == '1';
        if ((p = strstr(line, "coex=")) != nullptr && p[5] >= '0' && p[5] <= '2') s_coexMode = (uint8_t)(p[5] - '0');
    }
    fclose(f);
    ESP_LOGW("celer.net", "tune de bancada: adv=%u defer=%d suppress=%d coex=%d", (unsigned)s_advMs,
             (int)s_fragDefer, (int)s_suppress, (int)s_coexMode);
}

// Adia as repeticoes pendentes dos FRAGs de (src, seq): enquanto a rajada
// daquela mensagem ainda chega, repetir um frag liga o NOSSO adv (scanner
// desligado ~185 ms) bem em cima do frag seguinte. O jitter fixo (0,7-1,6 s)
// nao bastava: 8 frags levam ~1,5 s no ar e 31 levam ~5,7 s — na bancada
// 100 B chegava 3-4 vezes em 10. Cada frag novo empurra o relay da rajada
// para depois do silencio.
void deferFragRelays(uint16_t src, uint32_t seqZero, uint32_t dueMs) {
    if (s_heap == nullptr || s_pendingUsed == 0) return;
    for (int i = 0; i < PENDING_DEPTH; i++) {
        Pending* p = &s_heap->pending[i];
        if (!p->used || p->ours || (int32_t)(p->dueMs - dueMs) >= 0) continue;
        if (p->type == netframe::TYPE_FRAG && p->src == src && p->seqZero == seqZero) p->dueMs = dueMs;
    }
}
// Telemetria de TX (bench): bursts que SAIram no ar vs tentativas — a
// diferenca entre "enqueue ok" e "adv_start ok" e invisivel sem isso.
uint32_t s_txStarted = 0;   // adv_start devolveu 0 (quadro foi pro ar)
uint32_t s_txFail = 0;      // adv_start/adv_set_data falhou
uint32_t s_txNoToken = 0;   // fila devida esperando ficha do bucket

// Papel do no na matilha (CAPS_* do NetFrame.h) e assinaturas do kernel
// (servico Pack): presenca e mensagens sem passar pelo JS.
uint8_t s_caps = 0;
CelerNet::MemberEvent s_memberCb = nullptr;
CelerNet::MsgHandler s_msgHandler = nullptr;
uint32_t s_lastSweepMs = 0;  // varredura de expiracao (eventos de saida)

// Burst de TX (radio do advertising emprestado).
bool s_advBusy = false;       // adv da malha no ar (ate o ADV_COMPLETE)
volatile bool s_burstDone = false;
bool s_restoreAdv = false;    // paramos o adv do Link: devolver ao final
uint32_t s_nextSlotMs = 0;
uint32_t s_advStartMs = 0;    // quando o burst atual subiu (watchdog)
// Token bucket: 16 de rajada, 8/s — limita o roubo do advertising conectavel.
uint32_t s_tokens = 16;
uint32_t s_lastRefillMs = 0;
uint32_t s_lastBeatMs = 0;

// Auto-start pelo setting (boot): espera o WiFi/Phone Link acomodarem e
// re-tenta; se falhar por RAM, nao insiste a cada tick.
uint32_t s_lastAutoTryMs = 0;

constexpr uint32_t K_BEAT_MS = 3000;        // presenca a cada 3 s
constexpr uint32_t K_NODE_TTL_MS = 15000;   // no some apos 15 s sem BEAT
constexpr uint32_t K_REASM_TTL_MS = 6000;   // fragmento perdido: slot vence
// (era 2 s: com o relay espalhando os frags no tempo — jitter por salto +
// fila do repetidor — o slot expirava ANTES do ultimo frag chegar e a
// mensagem nunca remontava; bancada 2026-10-07)
constexpr uint32_t K_TOKEN_REFILL_PER_S = 8;
constexpr uint32_t K_TOKEN_MAX = 16;
// RAM interna de folga para os restos da malha: so a fila raw (~600 B)
// e state pequeno ficam na interna (RX/remontador/presenca/dedup na PSRAM)
// — o controlador e que respira na interna.
constexpr size_t K_NET_MIN_INTERNAL = 4 * 1024;

// No vencido (TTL sem ouvir BEAT)? Com a fila de TX/repeticao pendente o
// proprio no esta SURDO — cada quadro devido desliga o scanner para o burst
// e, sob trafego sustentado (relay fragmentado + BEATs dos vizinhos), ele
// perde BEATs inteiros: nao e o vizinho que foi embora. A expiracao e
// adiada enquanto transmitimos, com teto duro: sem ouvir NADA por 4x TTL,
// o no sai mesmo sob trafego (foi embora de verdade). Usado pela varredura
// do tick (evento de saida) E pelo nodes() — lista e eventos coerentes.
bool nodeExpired(uint32_t lastMs, uint32_t nowMs) {
    const uint32_t age = nowMs - lastMs;
    if (age <= K_NODE_TTL_MS) return false;
    return s_pendingUsed == 0 || age > 4 * K_NODE_TTL_MS;
}

SemaphoreHandle_t lock() {
    // init thread-safe (C++11): a 1a chamada cria, as demais devolvem
    static SemaphoreHandle_t s = xSemaphoreCreateRecursiveMutex();
    return s;
}

// ------------------------------------------------------------------ fila TX

// Metadados em claro do quadro na fila (ver Pending)
struct Meta {
    uint8_t type;
    uint8_t hops;
    uint16_t src;
    uint32_t seq;
    uint32_t seqZero;
};

bool pendingPush(const uint8_t* frame, uint8_t len, bool ours, uint32_t dueMs, const Meta& m,
                 uint8_t prio = 0) {
    if (s_heap == nullptr) return false;
    for (int i = 0; i < PENDING_DEPTH; i++) {
        if (!s_heap->pending[i].used) {
            Pending* p = &s_heap->pending[i];
            p->used = true;
            s_pendingUsed++;
            p->ours = ours;
            p->prio = prio;
            p->len = len;
            p->type = m.type;
            p->hops = m.hops;
            p->src = m.src;
            p->seq = m.seq;
            p->seqZero = m.seqZero;
            p->dueMs = dueMs;
            memcpy(p->frame, frame, len);
            return true;
        }
    }
    return false;
}

int pendingFree() {
    if (s_heap == nullptr) return 0;
    return PENDING_DEPTH - s_pendingUsed;
}

size_t framesFor(size_t len) {
    return len <= netframe::DATA_MAX ? 1 : (len + netframe::CHUNK_MAX - 1) / netframe::CHUNK_MAX;
}

// Supressao de repeticao: ouvimos o MESMO quadro repetido por outro no do
// nosso nivel antes da nossa vez — a nossa copia so gastaria ar (e nos
// deixaria surdos ~185 ms). Numa area densa (todos se ouvem) cada quadro era
// repetido por TODOS: na bancada de 3 placas cada no transmitia ~1 quadro/s
// so de presenca. BEAT (estado mole, o proximo sai em 3 s) suprime sempre;
// DATA/FRAG so quando o repetidor ouvido esta FORTE (perto de nos: quem nos
// ouve, provavelmente ouviu ele) — o fraco pode estar cobrindo outro lado.
constexpr int8_t K_SUPPRESS_RSSI = -60;

void cancelRelay(uint16_t src, uint32_t seq, uint8_t type, uint8_t hopsHeard, int8_t rssi) {
    if (s_heap == nullptr || s_pendingUsed == 0) return;
    if (type != netframe::TYPE_BEAT && rssi < K_SUPPRESS_RSSI) return;
    for (int i = 0; i < PENDING_DEPTH; i++) {
        Pending* p = &s_heap->pending[i];
        if (!p->used || p->ours) continue;
        if (p->type != type || p->src != src || p->seq != seq) continue;
        // a nossa repeticao levaria hops = h; uma copia ja ouvida com hops
        // >= h e de um repetidor do mesmo nivel (a 2a emissao do ORIGINAL
        // chega com hops menor e nao conta)
        if (hopsHeard >= p->hops) {
            p->used = false;
            s_pendingUsed--;
            s_relaySuppressed++;
        }
    }
}

// Cifra o quadro proprio na rede primaria e poe na fila.
bool pushOurs(netframe::Frame& f, uint32_t dueMs, uint8_t prio, uint32_t seqZero) {
    const NetKeys::Net* n = NetKeys::primary();
    if (n == nullptr) return false;
    const netframe::Cipher c = NetKeys::cipherOf(n);
    f.nid = n->nid;
    f.src = s_node;
    f.hops = 0;
    uint8_t frame[netframe::ADV_MAX];
    const size_t len = netframe::encode(f, c, frame, sizeof(frame));
    if (len == 0) return false;
    const Meta m = {f.type, 0, s_node, f.seq, seqZero};
    return pendingPush(frame, (uint8_t)len, true, dueMs, m, prio);
}

// Mensagem -> quadros (DATA unico ou FRAGs) na fila. Cada quadro tem seq
// proprio (o nonce do CCM nao repete): DATA pega um novo; a mensagem
// fragmentada usa total seqs consecutivos a partir de seqZero + copy*total
// (o chamador reserva copies*total; seqZero 0 = reserva so esta copia).
bool enqueueMessage(uint16_t dst, const uint8_t* data, size_t len, uint8_t ttl, uint8_t prio,
                    uint32_t dueDelayMs = 0, uint32_t seqZero = 0, uint8_t copy = 0) {
    if (len == 0 || len > CelerNet::MAX_MSG || ttl == 0) return false;
    // tudo ou nada: frags pela metade na fila so gastam ar (o destino nunca
    // remonta) e o app recebia false com a mensagem meio enviada
    if ((int)framesFor(len) > pendingFree()) return false;
    const uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    netframe::Frame f;
    f.dst = dst;
    f.ttl = ttl;
    if (len <= netframe::DATA_MAX) {
        f.type = netframe::TYPE_DATA;
        f.seq = NetKeys::nextSeqMesh();
        f.dlen = (uint8_t)len;
        f.data = data;
        return pushOurs(f, now + dueDelayMs, prio, f.seq);
    }
    const uint8_t total = (uint8_t)((len + netframe::CHUNK_MAX - 1) / netframe::CHUNK_MAX);
    if (total > netframe::MAX_FRAGS) return false;
    if (seqZero == 0) {
        seqZero = NetKeys::reserveSeqMesh(total);
        copy = 0;
    }
    f.type = netframe::TYPE_FRAG;
    uint8_t chunk[netframe::DATA_MAX];
    for (uint8_t i = 0; i < total; i++) {
        size_t off = (size_t)i * netframe::CHUNK_MAX;
        size_t n = len - off;
        if (n > netframe::CHUNK_MAX) n = netframe::CHUNK_MAX;
        chunk[0] = (uint8_t)(i | ((copy & 3) << netframe::FRAG_COPY_SHIFT));
        chunk[1] = total;
        memcpy(chunk + 2, (const uint8_t*)data + off, n);
        // dlen REAL (idx + total + n): o ultimo frag e curto. Com dlen fixo
        // em 16 o ultimo levava o resto do frag ANTERIOR (o chunk e
        // reaproveitado) e o destino remontava a mensagem arredondada para
        // multiplo de 14 B com lixo no fim — JSON.parse falhava e o envelope
        // de musica do handoff chegava corrompido (o "handler calado")
        f.dlen = (uint8_t)(2 + n);
        f.data = chunk;
        f.seq = seqZero + (uint32_t)copy * total + i;
        if (!pushOurs(f, now + dueDelayMs, prio, seqZero)) return false;
    }
    return true;
}

// --------------------------------------------------------------------- RX

void rxPush(uint16_t from, const char* fromName, uint16_t dst, const uint8_t* data, size_t len,
            uint8_t hops, int8_t rssi) {
    if (s_heap == nullptr || len > CelerNet::MAX_MSG) return;
    // Assinatura do kernel primeiro (o servico Pack): consumir aqui tira a
    // mensagem da fila do JS (envelopes tipados sao do OS).
    if (s_msgHandler != nullptr) {
        CelerNet::Msg m;
        memset(&m, 0, sizeof(m));
        m.from = from;
        if (fromName != nullptr) snprintf(m.fromName, sizeof(m.fromName), "%s", fromName);
        m.dst = dst;
        m.hops = hops;
        m.rssi = rssi;
        m.len = (uint16_t)len;
        memcpy(m.data, data, len);
        if (s_msgHandler(m)) return;  // consumida
    }
    if (s_heap->count >= CelerNet::RX_DEPTH) {
        // Descarta a MAIS ANTIGA (comando novo vale mais que o velho)
        s_heap->head = (uint8_t)((s_heap->head + 1) % CelerNet::RX_DEPTH);
        s_heap->count--;
        s_rxDropped++;
    }
    CelerNet::Msg* m = &s_heap->slots[(s_heap->head + s_heap->count) % CelerNet::RX_DEPTH];
    memset(m, 0, sizeof(*m));
    m->from = from;
    if (fromName != nullptr && fromName[0] != '\0') {
        snprintf(m->fromName, sizeof(m->fromName), "%s", fromName);
    }
    m->dst = dst;
    m->hops = hops;
    m->rssi = rssi;
    m->len = (uint16_t)len;
    memcpy(m->data, data, len);
    s_heap->count++;
}

const char* nodeName(uint16_t id) {
    if (s_heap == nullptr) return "";
    for (int i = 0; i < CelerNet::NODES_MAX; i++) {
        if (s_heap->nodes[i].used && s_heap->nodes[i].id == id) return s_heap->nodes[i].name;
    }
    return "";
}

void nodeTouch(uint16_t id, const char* name, uint8_t caps, uint8_t flags, int8_t rssi, uint8_t hops,
               uint32_t nowMs) {
    if (s_heap == nullptr) return;
    NodeEntry* e = nullptr;
    for (int i = 0; i < CelerNet::NODES_MAX; i++) {
        if (s_heap->nodes[i].used && s_heap->nodes[i].id == id) {
            e = &s_heap->nodes[i];
            break;
        }
    }
    if (e == nullptr && name == nullptr) return;  // sem BEAT: nao inventa no
    bool joined = false;
    if (e == nullptr) {
        for (int i = 0; i < CelerNet::NODES_MAX; i++) {
            if (!s_heap->nodes[i].used) {
                e = &s_heap->nodes[i];
                memset(e, 0, sizeof(*e));
                e->id = id;
                break;
            }
        }
        if (e == nullptr) return;  // tabela cheia: no novo fica de fora
        char idS[8];
        snprintf(idS, sizeof(idS), "%04X", id);
        ESP_LOGI(TAG, "no ouvido: %04X \"%s\" (rssi %d)", id, name != nullptr ? name : "", rssi);
        joined = true;
    }
    if (name != nullptr && name[0] != '\0') snprintf(e->name, sizeof(e->name), "%s", name);
    e->used = true;
    // caps so vem do BEAT (name != nullptr): DATA/FRAG chegavam com caps 0 e
    // apagavam o papel do no ate o proximo BEAT — o handoffMusic logo apos
    // uma mensagem do vizinho nao achava alto-falante
    if (name != nullptr) {
        e->caps = caps;
        e->flags = flags;
    }
    // Caminho mais curto fresco vence: o BEAT REPETIDO por outro no (hops
    // maior, rssi do repetidor) chegava quando o direto se perdia e a
    // presenca oscilava 1<->2 saltos com o sinal do vizinho errado
    const bool fresh = !joined && nowMs - e->lastMs < 2 * K_BEAT_MS;
    if (!fresh || hops <= e->hops) {
        e->rssi = rssi;
        e->hops = hops;
    }
    e->lastMs = nowMs;
    if (joined && s_memberCb != nullptr) s_memberCb(id, e->name, caps, true);
}

// Quadro que AUTENTICOU na rede primaria: anti-replay, entrega, presenca e
// (talvez) repeticao. raw = o quadro como chegou (o relay o repete identico,
// so com o byte de ttl/saltos trocado — sem recifrar).
void handleFrame(const netframe::Frame& f, int net, const uint8_t* raw, uint8_t rawLen, int8_t rssi,
                 uint32_t nowMs) {
    if (f.src == s_node) return;  // eco do nosso proprio quadro
    // Unicast: so o DESTINATARIO entrega (presenca inclusa); o repetidor
    // segue flooding do mesmo jeito — o filtro nao corta o relay abaixo.
    const bool mine = f.dst == netframe::DST_BROADCAST || f.dst == s_node;
    // saltos DADOS ate aqui: o quadro original sai com hops 0 e cada
    // repetidor soma 1 — o vizinho direto e 1 salto (a doc e os apps contam
    // assim; o firmware entregava 0 e o exemplo "hops: 2" virava 1)
    const uint8_t hops = (uint8_t)(f.hops + 1);
    // RPL depois do MIC: so quadro autentico avanca a janela (um forjado
    // com seq alto nao consegue calar a origem verdadeira)
    if (s_heap->rpl.check((uint8_t)net, f.src, f.seq) != decltype(s_heap->rpl)::NEW) {
        s_rxReplay++;
        if (s_relay && s_suppress) cancelRelay(f.src, f.seq, f.type, f.hops, rssi);
        return;
    }
    s_heap->rpl.commit((uint8_t)net, f.src, f.seq, nowMs);

    switch (f.type) {
        case netframe::TYPE_BEAT: {
            // v3: [caps(1)][flags(1)][nome sem NUL]
            if (f.dlen < 2) return;
            const uint8_t caps = f.data[0], flags = f.data[1];
            size_t n = f.dlen - 2;
            char name[CelerNet::MAX_NAME + 1];
            if (n > CelerNet::MAX_NAME) n = CelerNet::MAX_NAME;
            memcpy(name, f.data + 2, n);
            name[n] = '\0';
            nodeTouch(f.src, name, caps, flags, rssi, hops, nowMs);
            break;
        }
        case netframe::TYPE_DATA:
            if (!mine) break;
            nodeTouch(f.src, nullptr, 0, 0, rssi, hops, nowMs);
            rxPush(f.src, nodeName(f.src), f.dst, f.data, f.dlen, hops, rssi);
            break;
        case netframe::TYPE_FRAG: {
            if (f.dlen < 2) return;
            if (!mine) break;
            nodeTouch(f.src, nullptr, 0, 0, rssi, hops, nowMs);
            uint8_t msg[CelerNet::MAX_MSG];
            size_t len = 0;
            // Debug (LOGD): um log por frag no tick custava caro — ~5 ms de
            // UART por linha no quadro e, no cao (USB-JTAG), escrita que
            // BLOQUEIA quando ninguem le o console: o tick parava, a fila
            // crua enchia e os frags seguintes sumiam (bancada 2026-10-07).
            // Os contadores rxCru/rxQuadros da linha do BEAT ficam no lugar.
            ESP_LOGD(TAG, "frag rx %04X seq=%u %u/%u (%u B)",
                     f.src, (unsigned)f.seq, (f.data[0] & netframe::FRAG_IDX_MASK) + 1, f.data[1],
                     (unsigned)(f.dlen - 2));
            const uint32_t z = netframe::fragSeqZero(f.seq, f.data[0], f.data[1]);
            if (s_heap->reasm.feed(f.src, z, f.data[0], f.data[1], f.data + 2,
                                   (uint8_t)(f.dlen - 2), nowMs, msg, sizeof(msg), &len)) {
                ESP_LOGD(TAG, "frag remontou %04X seq0=%u (%u B)", f.src, (unsigned)z,
                         (unsigned)len);
                rxPush(f.src, nodeName(f.src), f.dst, msg, len, hops, rssi);
            }
            break;
        }
        default:
            return;
    }

    // Repeticao (flood): ttl-1/hops+1, jitter escalando com o ttl restante.
    // FRAG ganha jitter LARGO: repetir frag logo apos ouvi-lo coloca o
    // proprio repetidor no ar (scanner desligado) exatamente quando o FRAG
    // SEGUINTE da mesma rajada esta chegando — o no se auto-atolava e perdia
    // o frag do meio (bancada 2026-10-07: 1/3 de cada tripla sumia). O
    // repetidor sai da frente e repete a rajada DEPOIS de ouvi-la inteira.
    if (s_relay && f.ttl > 1) {
        uint8_t frame[netframe::ADV_MAX];
        memcpy(frame, raw, rawLen);
        if (netframe::relayPatch(frame, rawLen)) {
            uint32_t jitter = 40 + (uint32_t)f.ttl * 40 + (esp_random() % 200);
            Meta m = {f.type, (uint8_t)(f.hops + 1), f.src, f.seq, f.seq};
            if (f.type == netframe::TYPE_FRAG) {
                m.seqZero = netframe::fragSeqZero(f.seq, f.data[0], f.data[1]);
                // depois do ULTIMO frag ouvido da rajada (este), com folga de
                // ~2 quadros no ar; os relays ja pendentes da mesma mensagem
                // andam junto (saem em ordem, depois do silencio)
                if (s_fragDefer) {
                    jitter += 400 + (esp_random() % 300);
                    deferFragRelays(f.src, m.seqZero, nowMs + jitter);
                } else {
                    jitter += 700 + (esp_random() % 900);  // comportamento antigo
                }
            }
            if (pendingPush(frame, rawLen, false, nowMs + jitter, m)) {
                s_relayed++;
            } else {
                // anel cheio: o vizinho reenvia (redundancia do flood), mas o
                // descarte fica visivel no info() — relay perdido em serie e
                // sintoma de fila atolada
                s_relayDropped++;
            }
        }
    }
}

// ------------------------------------------------------------------ radio

// cache do estado do scanner (ver scanStart); o callback do host escreve
volatile bool s_scanOn = false;
uint32_t s_scanCheckMs = 0;
bool s_appWasBusy = false;
// Perfil do scanner no ar: 0 = continuo (10/10 ms), 1 = duty-cycle com
// enlace GATT de pe (30 ms a cada 100 ms). O scan 100% do tempo competia
// com os eventos de conexao do Celer Link (intervalo 15..30 ms, supervisao
// 2 s): sob trafego da malha o controle remoto caia. Com 30% o enlace tem
// folga e a malha ainda ouve o adv de 100 ms dos vizinhos (a janela de
// 30 ms pega um evento a cada ~3).
uint8_t s_scanProfile = 0;

int meshGapCb(ble_gap_event* event, void* arg) {
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_DISC:
            CelerNet::onAdvReport(event->disc.data, event->disc.length_data, event->disc.rssi);
            return 0;
        case BLE_GAP_EVENT_ADV_COMPLETE:
            s_burstDone = true;
            return 0;
        case BLE_GAP_EVENT_DISC_COMPLETE:
            s_scanOn = false;  // o host encerrou o nosso scan (reset etc.)
            return 0;
        default:
            return 0;
    }
}

// Scanner continuo (passivo) da malha. O CelerLink::scan do app cancela e
// reassume o radio; o tick religa o nosso quando o app solta.
//
// Estado do scanner em CACHE: o tick roda ~60x/s nos dois pumps e cada
// ble_gap_disc_active() toma o lock do host NimBLE — no relogio (DFS com
// clock baixo) a verificacao custava ~90 us por chamada, duas por tick
// (bancada 2026-10-08: 26 ms a cada 3 s so verificando). Confirma com o
// host a cada 250 ms, ou na hora quando o app acaba de soltar o radio (o
// scan/connect do Celer Link cancela o nosso sem avisar).

void scanStart() {
    if (CelerLink::appBusy()) {
        s_appWasBusy = true;
        return;
    }
    const uint32_t now = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    const uint8_t want = CelerLink::linkActive() ? 1 : 0;
    if (s_scanOn && !s_appWasBusy && want == s_scanProfile && now - s_scanCheckMs < 250) return;
    s_appWasBusy = false;
    s_scanCheckMs = now;
    if (ble_gap_disc_active()) {
        if (want == s_scanProfile) {
            s_scanOn = true;
            return;
        }
        ble_gap_disc_cancel();  // perfil mudou (enlace subiu/caiu): reconfigura
    }
    struct ble_gap_disc_params p;
    memset(&p, 0, sizeof(p));
    p.passive = 1;   // nao pede scan response: quadro cru chega inteiro
    if (want == 1) {
        p.itvl = 160;   // 100 ms
        p.window = 48;  // 30 ms: folga para os eventos de conexao
    } else {
        p.itvl = 16;    // 10 ms / 10 ms = janela continua (coex arbitra o WiFi)
        p.window = 16;
    }
    int rc = ble_gap_disc(BLE_OWN_ADDR_PUBLIC, BLE_HS_FOREVER, &p, meshGapCb, nullptr);
    s_scanOn = rc == 0 || rc == BLE_HS_EALREADY;
    if (s_scanOn && want != s_scanProfile) {
        ESP_LOGI(TAG, "scanner: %s", want ? "duty-cycle (enlace GATT de pe)" : "continuo");
    }
    if (s_scanOn) s_scanProfile = want;
    if (!s_scanOn) ESP_LOGW(TAG, "scanner: ble_gap_disc rc=%d", rc);
}

void scanStop() {
    if (ble_gap_disc_active()) ble_gap_disc_cancel();
    s_scanOn = false;
}

// Empurra o proximo quadro devido no advertising (tomado por 60 ms).
void maybeBurst(uint32_t nowMs) {
    if (s_advBusy) {
        if (!s_burstDone) {
            // Watchdog do burst: o ADV_COMPLETE pode SE PERDER (o
            // refreshAdvertising do Celer Link/Phone Link e a conexao GATT
            // do celular disputam o radio; bancada 2026-10-07: o TX do
            // watch morria na 1a disputa e a fila crescia para sempre —
            // noAr parado com fila subindo). Preso ha >1 s: considera
            // perdido, derruba o que sobrou do adv e segue a fila.
            if (nowMs - s_advStartMs < 1000) return;
            s_txFail++;
            if (ble_gap_adv_active()) ble_gap_adv_stop();
            // o adv no ar podia ser o do Link/Phone Link (re-armado pelo
            // refreshAdvertising durante a disputa): o stop acima o derrubou,
            // entao a devolucao no fim da fila e OBRIGATORIA — zerar aqui
            // deixava o Gadgetbridge sem reconectar ate outro advRestart
            s_restoreAdv = true;
        }
        s_advBusy = false;
        s_burstDone = false;
        s_nextSlotMs = nowMs + 25;  // respiro entre pacotes
    }
    if (nowMs < s_nextSlotMs) return;

    if (s_heap == nullptr) return;
    // Devidos: urgente (handoff) primeiro, depois o mais antigo (FIFO ~due).
    Pending* best = nullptr;
    for (int i = 0; i < PENDING_DEPTH && s_pendingUsed > 0; i++) {
        Pending* p = &s_heap->pending[i];
        if (!p->used || (int32_t)(nowMs - p->dueMs) < 0) continue;
        if (best == nullptr || p->prio > best->prio ||
            (p->prio == best->prio && (int32_t)(p->dueMs - best->dueMs) < 0)) {
            best = p;
        }
    }
    if (best == nullptr) {
        // Fila seca: devolve o advertising ao Celer Link/Phone Link e
        // religa o scanner — o scanner NAO pode religar a cada tick: cada
        // burst cancela o scan, e o ciclo religa/cancela por pacote
        // derrubava a vazao a ~1 burst/s (bancada 2026-10-07: noAr=520 em
        // 10 min com fila cheia e drops). Com a fila seca o scan fica no
        // ar ate o proximo burst.
        scanStart();
        if (s_restoreAdv) {
            s_restoreAdv = false;
            CelerLink::refreshAdvertising();
        }
        return;
    }
    if (s_tokens < 1) {  // rajada de muitos pacotes: espera refill
        s_txNoToken++;
        return;
    }
    // App escaneando/conectando pelo Celer Link: segura o TX. O cancel do
    // scanner logo abaixo derrubava o scan DO APP (o NimBLE nao entrega
    // DISC_COMPLETE no cancel): o CelerLink.scan() voltava so com o 1o
    // segundo de cache — na bancada 2026-10-07, 3 scans seguidos vazios com
    // o periferico a 30 cm. Os quadros esperam na fila (scan dura ~3 s).
    if (CelerLink::appBusy()) return;

    // Scanner e burst NUNCA juntos: scan continuo + reconfiguracao de adv
    // nao-conectavel correm contra o lld_init do controlador (IWDT no
    // btController, coredump do 4848 na bancada 2026-10-06). O tick religa
    // o scanner no ciclo seguinte ao fim da fila.
    scanStop();
    if (ble_gap_adv_active()) {
        s_restoreAdv = true;
        ble_gap_adv_stop();
    }
    int rc = ble_gap_adv_set_data(best->frame, best->len);
    if (rc == 0) {
        struct ble_gap_adv_params p;
        memset(&p, 0, sizeof(p));
        p.conn_mode = BLE_GAP_CONN_MODE_NON;  // ADV_NONCONN: ninguem conecta
        p.disc_mode = BLE_GAP_DISC_MODE_GEN;
        // 100 ms e o piso da ESPECIFICACAO para ADV_NONCONN (o host aceita
        // 20 ms, o controlador nao: TX silenciosa e, na rajada, IWDT no
        // btController — bancada 2026-10-06 no 4848). Um evento ja cobre os
        // 3 canais de advertising; 160 ms de duration puxam o COMPLETE
        // (1 evento + folga) — 250 ms deixava o ciclo em ~1 burst/s.
        p.itvl_min = 160;  // 100 ms em unidades de 0,625 ms
        p.itvl_max = 160;
        rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, nullptr, (int32_t)s_advMs, &p, meshGapCb, nullptr);
    }
    if (rc == 0) {
        best->used = false;
        s_pendingUsed--;
        s_tokens--;
        s_advBusy = true;
        s_advStartMs = nowMs;
        s_txStarted++;
        return;
    }
    // EALREADY/EBUSY: radio ocupado agora — o proximo tick tenta de novo
    s_txFail++;
    if (rc != BLE_HS_EALREADY) ESP_LOGW(TAG, "burst: rc=%d", rc);
    if (s_restoreAdv && !ble_gap_adv_active()) {
        s_restoreAdv = false;
        CelerLink::refreshAdvertising();
    }
}

void heapInit() {
    if (s_heap != nullptr) return;
    s_heap = (NetHeap*)heap_caps_malloc(sizeof(NetHeap), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_heap == nullptr) {
        s_heap = (NetHeap*)heap_caps_malloc(sizeof(NetHeap), MALLOC_CAP_8BIT);
    }
    if (s_heap != nullptr) memset(s_heap, 0, sizeof(NetHeap));
}

bool tryStart(const char* name, const char* net, bool relay, bool persist) {
    // O pedido (setting) entra ANTES dos gates: com a RAM interna apertada
    // (app aberto numa placa sem BLE no ar) o start() do JS e ACEITO e o
    // tick do servico sobe o no sozinho quando a interna voltar (10 s).
    if (persist) CelerSettings::set("celernet", "1");
    // sem latch: falha de RAM agora nao trava o BLE/Phone Link ate o reboot
    if (!CelerLink::ensureStarted(false)) {  // gate de RAM interna (BLE off)
        s_lastAutoTryMs = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        return false;
    }
    const size_t freeInt = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    if (freeInt < K_NET_MIN_INTERNAL) {
        static uint8_t s_ramFails = 0;
        if (++s_ramFails >= 6) {  // tick tenta a cada 10 s: loga 1x por minuto
            s_ramFails = 0;
            ESP_LOGW(TAG, "malha aguarda RAM interna (%u < %u)", (unsigned)freeInt,
                     (unsigned)K_NET_MIN_INTERNAL);
        }
        s_lastAutoTryMs = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        return false;
    }

    // Alocacoes e estado sob mutex: start pode chegar do tick (auto) e do
    // JS ao mesmo tempo — sem isso, duas filas nasceriam e uma vazaria.
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    if (s_raw == nullptr) {
        s_raw = xQueueCreate(RAW_DEPTH, sizeof(RawReport));
    }
    heapInit();
    if (s_raw == nullptr || s_heap == nullptr) {
        xSemaphoreGiveRecursive(lock());
        return false;
    }

    // Start idempotente: malha ja no ar com o mesmo nome/rede/papel volta
    // sem zerar nada. Antes todo app que chamava CelerNet.start() ao abrir
    // apagava a tabela de membros e o dedup — trocar Matilha -> Bilheteria
    // deixava a lista vazia ate o proximo BEAT do vizinho, e num enlace
    // fraco (-93 dBm, esp32-cam) ele "nunca aparecia" (bancada 2026-10-10).
    // v3: a rede NAO vem mais do app — e a matilha do NetKeys (mesh join /
    // provisionamento) ou a aberta "celer". O net do start() so avisa.
    if (net != nullptr && net[0] != '\0' && strcmp(net, s_net) != 0 && strcmp(net, NetKeys::OPEN_NAME) != 0) {
        ESP_LOGW(TAG, "start(net=\"%s\") ignorado: a rede e a matilha (mesh join)", net);
    }
    if (s_active && relay == s_relay) {
        const bool sameName = name == nullptr || name[0] == '\0' ||
                              strncmp(name, s_name, CelerNet::MAX_NAME) == 0;
        if (sameName) {
            xSemaphoreGiveRecursive(lock());
            return true;
        }
    }
    if (!NetKeys::init()) {
        xSemaphoreGiveRecursive(lock());
        ESP_LOGE(TAG, "chaves da rede nao subiram (PSA)");
        return false;
    }

    if (name != nullptr && name[0] != '\0') {
        snprintf(s_name, sizeof(s_name), "%.*s", (int)CelerNet::MAX_NAME, name);
        CelerSettings::set("celernet_name", s_name);
    } else {
        std::string cur = CelerSettings::get("celernet_name", "");
        if (!cur.empty()) snprintf(s_name, sizeof(s_name), "%.*s", (int)CelerNet::MAX_NAME, cur.c_str());
    }
    snprintf(s_net, sizeof(s_net), "%s", NetKeys::primary()->name);
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_BT);
    s_node = (uint16_t)((mac[4] << 8) | mac[5]);
    if (s_name[0] == '\0') snprintf(s_name, sizeof(s_name), "Celer-%04X", s_node);
    s_relay = relay;
    loadTune();

    s_heap->rpl.clear();
    s_heap->head = 0;
    s_heap->count = 0;
    s_heap->reasm.reset();
    for (int i = 0; i < PENDING_DEPTH; i++) s_heap->pending[i].used = false;
    s_pendingUsed = 0;
    for (int i = 0; i < CelerNet::NODES_MAX; i++) s_heap->nodes[i].used = false;
    xQueueReset(s_raw);
    s_txDropped = s_rxDropped = s_relayed = 0;
    s_txStarted = s_txFail = s_txNoToken = 0;
    s_relaySuppressed = 0;
    s_relayDropped = 0;
    s_rxRaw = s_rxRawDropped = 0;
    s_rxFrames = 0;
    s_rxAuthFail = s_rxReplay = s_rxOther = 0;
    s_tokens = K_TOKEN_MAX;
    s_lastRefillMs = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    s_lastBeatMs = 0;  // BEAT imediato: presenca aparece logo nos vizinhos
    // Estado de burst NAO pode atravessar um re-start: um ADV_COMPLETE
    // perdido antes do start deixaria s_advBusy preso e o TX morto
    // (bancada 2026-10-07 — era assim que o enlace do watch morria).
    if (s_advBusy && ble_gap_adv_active()) ble_gap_adv_stop();
    s_advBusy = false;
    s_burstDone = false;
    s_restoreAdv = false;
    s_nextSlotMs = 0;
    s_advStartMs = 0;
    s_active = true;
    coexApply(true);
    xSemaphoreGiveRecursive(lock());

    scanStart();
    ESP_LOGI(TAG, "malha ligada: \"%s\" (%04X) rede \"%s\" nid %02X %s%s (interna %u)", s_name, s_node,
             s_net, NetKeys::primary()->nid, NetKeys::provisioned() ? "privada" : "aberta",
             s_relay ? ", repetidor" : ", so escuta", (unsigned)freeInt);
    return true;
}

}  // namespace

// ------------------------------------------------------------------- API

void CelerNet::onAdvReport(const uint8_t* data, size_t len, int8_t rssi) {
    if (!s_active || s_raw == nullptr) return;
    if (!netframe::looksLike(data, len)) return;  // quase tudo para aqui
    RawReport r;
    r.len = (uint8_t)len;
    r.rssi = rssi;
    memcpy(r.data, data, len);
    if (xQueueSend(s_raw, &r, 0) != pdTRUE) {
        // cheio: relays vizinhos reenviam, perder um report nao e tragico
        s_rxRawDropped++;
    } else {
        s_rxRaw++;
    }
}

bool CelerNet::start(const char* name, const char* net, bool relay) {
    if (tryStart(name, net, relay, true)) return true;
    // PEDIDO ACEITO mesmo com o radio adiado: o setting ja vale e o tick
    // sobe o no assim que a RAM interna permitir (status().active confirma)
    return enabledSetting();
}

bool CelerNet::stop() {
    CelerSettings::set("celernet", "0");
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    bool wasActive = s_active;
    s_active = false;
    // Radio so com o no NO AR: antes do auto-start (carencia do boot) ou com a
    // RAM adiando o start, o NimBLE pode nem estar inicializado — o
    // ble_gap_disc_active() abaixo dava LoadProhibited e reiniciava a placa
    // (bancada 2026-10-07: CelerNet.stop() no inicio de um app, 40 s apos o boot)
    if (wasActive) {
        if (s_advBusy && ble_gap_adv_active()) {
            ble_gap_adv_stop();
            s_advBusy = false;
            s_burstDone = false;
        }
        // o nosso scanner (o do app no Celer Link fica)
        if (!CelerLink::appBusy()) scanStop();
        if (s_restoreAdv) {
            s_restoreAdv = false;
            CelerLink::refreshAdvertising();
        }
    }
    if (s_heap != nullptr) {
        for (int i = 0; i < PENDING_DEPTH; i++) s_heap->pending[i].used = false;
        s_pendingUsed = 0;
        // Presenca sai junto: o tick ja nao roda (sweep morto) e a tabela
        // ficaria CONGELADA — nodes() listando membros fantasmas para sempre
        // e o Pack (Resources::onMemberLeft) sem ver a saida de ninguem.
        // Eventos de saida aqui, sob o mutex, como no sweep.
        for (int i = 0; i < CelerNet::NODES_MAX; i++) {
            if (s_heap->nodes[i].used) {
                s_heap->nodes[i].used = false;
                if (s_memberCb != nullptr) {
                    s_memberCb(s_heap->nodes[i].id, s_heap->nodes[i].name,
                               s_heap->nodes[i].caps, false);
                }
            }
        }
    }
    xSemaphoreGiveRecursive(lock());
    if (wasActive) coexApply(false);
    if (wasActive) ESP_LOGI(TAG, "malha desligada");
    return true;
}

void CelerNet::netChanged() {
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    if (const NetKeys::Net* n = NetKeys::primary()) snprintf(s_net, sizeof(s_net), "%s", n->name);
    if (s_heap != nullptr) {
        s_heap->rpl.clear();
        s_heap->reasm.reset();
        s_heap->head = 0;
        s_heap->count = 0;
        for (int i = 0; i < PENDING_DEPTH; i++) s_heap->pending[i].used = false;
        s_pendingUsed = 0;
        for (int i = 0; i < NODES_MAX; i++) {
            if (!s_heap->nodes[i].used) continue;
            s_heap->nodes[i].used = false;
            if (s_memberCb != nullptr) {
                s_memberCb(s_heap->nodes[i].id, s_heap->nodes[i].name, s_heap->nodes[i].caps, false);
            }
        }
    }
    s_lastBeatMs = 0;  // BEAT ja na rede nova
    xSemaphoreGiveRecursive(lock());
    ESP_LOGI(TAG, "rede agora \"%s\" (%s)", s_net, NetKeys::provisioned() ? "privada" : "aberta");
}

bool CelerNet::replayLast() {
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    const bool ok = s_active && s_raw != nullptr && s_lastRaw.len > 0 &&
                    xQueueSend(s_raw, &s_lastRaw, 0) == pdTRUE;
    xSemaphoreGiveRecursive(lock());
    return ok;
}

bool CelerNet::active() {
    return s_active;
}

// Destino do unicast: id "A1B2" (4 hex) ou NOME do no ouvido (match
// case-insensitive; nomes duplicados pegam o vizinho MAIS FORTE — a tabela
// bruta e ordem de insercao, o nodes() e que ordena por RSSI na copia, e o
// comentario antigo prometia o que o codigo nao fazia).
bool CelerNet::resolveDest(const char* to, uint16_t* out) {
    if (to == nullptr) return false;
    bool hex = strlen(to) == 4;
    uint16_t id = 0;
    for (int i = 0; hex && i < 4; i++) {
        char c = to[i];
        uint8_t v;
        if (c >= '0' && c <= '9') v = (uint8_t)(c - '0');
        else if (c >= 'a' && c <= 'f') v = (uint8_t)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v = (uint8_t)(c - 'A' + 10);
        else hex = false;
        if (hex) id = (uint16_t)((id << 4) | v);
    }
    if (hex) {
        *out = id;
        return true;
    }
    if (s_heap == nullptr) return false;
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    NodeEntry* e = nullptr;
    for (int i = 0; i < NODES_MAX; i++) {
        if (s_heap->nodes[i].used && s_heap->nodes[i].name[0] != '\0' &&
            strcasecmp(s_heap->nodes[i].name, to) == 0) {
            if (e == nullptr || s_heap->nodes[i].rssi > e->rssi) e = &s_heap->nodes[i];
        }
    }
    // copia sob lock (o chamador usa depois)
    if (e != nullptr) *out = e->id;
    xSemaphoreGiveRecursive(lock());
    return e != nullptr;
}

void CelerNet::onMemberEvent(MemberEvent cb) {
    s_memberCb = cb;
}

void CelerNet::subscribe(MsgHandler h) {
    s_msgHandler = h;
}

void CelerNet::setCaps(uint8_t caps) {
    s_caps = caps;  // viaja no proximo BEAT (3 s)
}

uint8_t CelerNet::ourCaps() {
    return s_caps;
}

bool CelerNet::broadcast(const void* data, size_t len, uint8_t ttl) {
    if (!s_active || data == nullptr) return false;
    if (ttl == 0) ttl = TTL_DEFAULT;
    if (ttl > netframe::TTL_MAX) ttl = netframe::TTL_MAX;
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    bool ok = enqueueMessage(netframe::DST_BROADCAST, (const uint8_t*)data, len, ttl, 0);
    xSemaphoreGiveRecursive(lock());
    if (!ok) {
        s_txDropped++;
        ESP_LOGW(TAG, "broadcast recusado (%u bytes; fila cheia?)", (unsigned)len);
    }
    return ok;
}

bool CelerNet::sendTo(uint16_t dst, const void* data, size_t len, uint8_t ttl, bool urgent,
                      uint8_t copies) {
    if (!s_active || data == nullptr || dst == 0 || dst == s_node) return false;
    if (ttl == 0) ttl = TTL_DEFAULT;
    if (ttl > netframe::TTL_MAX) ttl = netframe::TTL_MAX;
    if (copies < 1) copies = 1;
    if (copies > 3) copies = 3;
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    // todas as copias cabem ou nenhuma sai: a 1a copia na fila com false para
    // o app fazia o handoff de musica tocar nos DOIS aparelhos (o Pack so
    // para a musica local quando o envio da true)
    bool ok = (int)(framesFor(len) * copies) <= pendingFree();
    const bool frag = len > netframe::DATA_MAX;
    // frags de TODAS as copias em seqs consecutivos (ver NetFrame.h)
    const uint32_t seqZero = ok && frag ? NetKeys::reserveSeqMesh((uint32_t)framesFor(len) * copies) : 0;
    for (uint8_t c = 0; c < copies && ok; c++) {
        // Cada copia leva seq NOVO: o dedup do vizinho nao pode come-la (a
        // redundancia e a "retransmissao" do unicast sem ACK — a entrega
        // pode duplicar; o consumidor resolve idempotencia por msgId).
        // E as copias saem ESPACADAS (~1,5 s): consecutivas morriam na
        // MESMA janela de colisao — o receptor relaya no meio da rajada
        // (relay = burst = scanner desligado ~300 ms) e perde o frag que
        // esta chegando; copias no mesmo instante nao sao redundancia.
        // Mensagem fragmentada: as copias DIVIDEM o seqZero (copia no idx)
        // e o destino junta fragmentos de qualquer uma — antes cada copia
        // tinha que chegar INTEIRA (8 frags a ~75% cada: ~10% por copia;
        // bancada 2026-10-07). Quadro unico segue com seq novo por copia.
        ok = enqueueMessage(dst, (const uint8_t*)data, len, ttl, urgent ? 1 : 0, (uint32_t)c * 1500,
                            seqZero, frag ? c : 0);
    }
    xSemaphoreGiveRecursive(lock());
    if (!ok) {
        s_txDropped++;
        ESP_LOGW(TAG, "unicast %04X recusado (%u bytes; fila cheia?)", dst, (unsigned)len);
    }
    return ok;
}

bool CelerNet::poll(Msg* out) {
    if (s_heap == nullptr) return false;
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    bool got = false;
    if (s_heap->count > 0) {
        memcpy(out, &s_heap->slots[s_heap->head], sizeof(*out));
        s_heap->head = (uint8_t)((s_heap->head + 1) % RX_DEPTH);
        s_heap->count--;
        got = true;
    }
    xSemaphoreGiveRecursive(lock());
    return got;
}

int CelerNet::nodes(Node* out, int max) {
    const uint32_t nowMs = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
    if (s_heap == nullptr) return 0;
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    int n = 0;
    for (int i = 0; i < NODES_MAX && n < max; i++) {
        if (!s_heap->nodes[i].used) continue;
        // vencido: fica de fora, mas QUEM libera e o sweep do tick (que dispara
        // o evento de saida) — liberar aqui engolia o "saiu" do Pack e a volta
        // do no virava um segundo "entrou". Mesmo criterio do sweep
        // (nodeExpired): a lista nao esconde um no que o sweep ainda mantem
        if (nodeExpired(s_heap->nodes[i].lastMs, nowMs)) continue;
        out[n].id = s_heap->nodes[i].id;
        snprintf(out[n].name, sizeof(out[n].name), "%s", s_heap->nodes[i].name);
        out[n].caps = s_heap->nodes[i].caps;
        out[n].flags = s_heap->nodes[i].flags;
        out[n].rssi = s_heap->nodes[i].rssi;
        out[n].hops = s_heap->nodes[i].hops;
        out[n].lastSeenMs = nowMs - s_heap->nodes[i].lastMs;
        n++;
    }
    xSemaphoreGiveRecursive(lock());
    for (int i = 1; i < n; i++) {  // mais forte primeiro
        Node t = out[i];
        int j = i - 1;
        while (j >= 0 && out[j].rssi < t.rssi) {
            out[j + 1] = out[j];
            j--;
        }
        out[j + 1] = t;
    }
    return n;
}

void CelerNet::info(Info* out) {
    memset(out, 0, sizeof(*out));
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    out->active = s_active;
    out->relay = s_relay;
    out->node = s_node;
    if (const NetKeys::Net* n = NetKeys::primary()) {
        out->nid = n->nid;
        out->secure = !n->open;
    }
    snprintf(out->name, sizeof(out->name), "%s", s_name);
    snprintf(out->net, sizeof(out->net), "%s", s_net);
    if (s_heap != nullptr) {
        for (int i = 0; i < PENDING_DEPTH; i++) {
            if (s_heap->pending[i].used && s_heap->pending[i].ours) out->txQueued++;
        }
        for (int i = 0; i < NODES_MAX; i++) {
            if (s_heap->nodes[i].used) out->heard++;
        }
    }
    out->txDropped = s_txDropped;
    out->txStarted = s_txStarted;
    out->txFail = s_txFail;
    out->txNoToken = s_txNoToken;
    out->rxDropped = s_rxDropped;
    out->relayed = s_relayed;
    out->relayDropped = s_relayDropped;
    out->rxAuthFail = s_rxAuthFail;
    out->rxReplay = s_rxReplay;
    out->rxOther = s_rxOther;
    xSemaphoreGiveRecursive(lock());
}

bool CelerNet::enabledSetting() {
    return CelerSettings::get("celernet", "0") == "1";
}

void CelerNet::tick() {
    if (!s_active) {
        // Protecao de ciclo: boot apos crash/watchdog NAO auto-inicia a
        // malha (o usuario liga pelo app quando quiser). Sem isso um no
        // instavel derruba o device a cada boot+10 s (4848, bancada
        // 2026-10-06: BT controller em IWDT com o churn da malha).
        static bool s_bootChecked = false;
        static bool s_skipAuto = false;
        if (!s_bootChecked) {
            s_bootChecked = true;
            const esp_reset_reason_t r = esp_reset_reason();
            s_skipAuto = r == ESP_RST_PANIC || r == ESP_RST_INT_WDT || r == ESP_RST_TASK_WDT ||
                         r == ESP_RST_WDT;
            if (s_skipAuto && enabledSetting()) {
                ESP_LOGW(TAG, "malha NAO auto-inicia: boot apos crash (protecao de ciclo)");
            }
        }
        if (s_skipAuto) return;
        // Auto-start pelo setting: so DEPOIS do WiFi/Phone Link acomodarem
        // (o ensureStarted lacha o init em falha — nao pode disparar cedo
        // demais e matar o Phone Link do watch com ele).
        const uint32_t nowMs = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);
        // Graca no boot (WiFi primeiro): ~60 s no watch (o BLE do Phone
        // Link la depende dela), 10 s nas demais — o 4848 deep-sleepa antes
        // dos 60 s de idle e a malha nunca subiria. Depois que o pedido
        // existiu, o tick tenta a cada 10 s ate a RAM permitir.
#if CONFIG_CELEROS_PHONE_LINK
        constexpr uint32_t kBootGraceMs = 45000;
#else
        constexpr uint32_t kBootGraceMs = 10000;
#endif
        if (enabledSetting() && nowMs > kBootGraceMs &&
            nowMs - s_lastAutoTryMs > (s_lastAutoTryMs == 0 ? 60000 : 10000)) {
            s_lastAutoTryMs = nowMs;
            tryStart(nullptr, nullptr, true, false);  // nao regrava o setting
        }
        return;
    }

    const int64_t t0 = esp_timer_get_time();
    tickBody();
    const uint32_t dt = (uint32_t)(esp_timer_get_time() - t0);
    s_tickCalls++;
    s_tickUs += dt;
    if (dt > s_tickMaxUs) s_tickMaxUs = dt;
}

void CelerNet::tickBody() {
    xSemaphoreTakeRecursive(lock(), portMAX_DELAY);
    const uint32_t nowMs = (uint32_t)(xTaskGetTickCount() * portTICK_PERIOD_MS);

    // O scanner e o bem mais importante da malha: religa SE a fila do TX
    // esta vazia (com fila, o maybeBurst religa ao esvaziar — scan no ar
    // durante a rajada so serve para o proprio burst cancelar). O scan do
    // app ou um reset do host podem ter derrubado o nosso.
    if (s_heap == nullptr || s_advBusy) {
        scanStart();
    } else {
        if (s_pendingUsed == 0) scanStart();
    }

    // Fichas do token bucket (limita o roubo do advertising conectavel).
    uint32_t add = (nowMs - s_lastRefillMs) / (1000 / K_TOKEN_REFILL_PER_S);
    if (add > 0) {
        s_lastRefillMs += add * (1000 / K_TOKEN_REFILL_PER_S);
        s_tokens = s_tokens + add > K_TOKEN_MAX ? K_TOKEN_MAX : s_tokens + add;
    }

    // Presenca: BEAT proprio na fila (sequindo as fichas do bucket). v3:
    // [caps][flags][nome] — o papel do no e o estado (nao configurado)
    // viajam junto.
    if (nowMs - s_lastBeatMs >= K_BEAT_MS) {
        s_lastBeatMs = nowMs;
        uint8_t beat[netframe::DATA_MAX];
        beat[0] = s_caps;
        beat[1] = NetKeys::provisioned() ? 0 : netframe::BFLAG_UNPROV;
        size_t nameLen = strlen(s_name);
        if (nameLen > CelerNet::MAX_NAME) nameLen = CelerNet::MAX_NAME;
        memcpy(beat + 2, s_name, nameLen);
        netframe::Frame f;
        f.type = netframe::TYPE_BEAT;
        f.dst = netframe::DST_BROADCAST;
        f.ttl = CelerNet::TTL_DEFAULT;
        f.seq = NetKeys::nextSeqMesh();
        f.dlen = (uint8_t)(2 + nameLen);
        f.data = beat;
        // fila cheia: o proximo BEAT (3 s) tenta de novo
        pushOurs(f, nowMs, 0, f.seq);
        // reserva de seq no NVS: daqui (pilha interna do servico), nunca das
        // tasks com pilha na PSRAM
        NetKeys::persistTick();
        // Telemetria (bench): 1 linha a cada 10 BEATs (30 s) com os
        // contadores da janela inteira, ou NA HORA quando aparece falha de TX
        // ou descarte na fila crua. Era 1 linha a cada 3 s: ~9 ms de log por
        // janela no relogio e o kern.log persistente (8 KB nas placas sem SD)
        // so com isso — expulsava os logs uteis em minutos.
        const bool anomalia = s_txFail != s_telemFail || s_rxRawDropped != s_telemRawDrop;
        if (++s_telemBeats >= 10 || anomalia) {
            ESP_LOGI(TAG, "telemetria %us: noAr=%u fail=%u noTok=%u fila=%d relay=%u suprimidos=%u "
                     "rxCru=%u rxCruPerdido=%u rxQuadros=%u semChave=%u repetidos=%u tick=%u/%uus max=%uus",
                     (unsigned)(s_telemBeats * K_BEAT_MS / 1000), (unsigned)s_txStarted,
                     (unsigned)s_txFail, (unsigned)s_txNoToken, s_pendingUsed, (unsigned)s_relayed,
                     (unsigned)s_relaySuppressed, (unsigned)s_rxRaw, (unsigned)s_rxRawDropped,
                     (unsigned)s_rxFrames, (unsigned)s_rxAuthFail, (unsigned)s_rxReplay,
                     (unsigned)s_tickCalls, (unsigned)s_tickUs, (unsigned)s_tickMaxUs);
            s_telemBeats = 0;
            s_telemFail = s_txFail;
            s_telemRawDrop = s_rxRawDropped;
            s_tickCalls = 0;
            s_tickUs = 0;
            s_tickMaxUs = 0;
        }
    }

    // Varredura de expiracao (~1x/s): no que passou 15 s sem BEAT sai da
    // tabela — e o evento de SAIDA (o de entrada sai do nodeTouch) e para
    // o servico Pack, que nao precisa varrer por conta propria. O criterio
    // e o nodeExpired (histerese enquanto o nosso TX esta pendente).
    if (nowMs - s_lastSweepMs >= 1000) {
        s_lastSweepMs = nowMs;
        for (int i = 0; i < CelerNet::NODES_MAX; i++) {
            if (s_heap->nodes[i].used && nodeExpired(s_heap->nodes[i].lastMs, nowMs)) {
                s_heap->nodes[i].used = false;
                if (s_memberCb != nullptr) {
                    s_memberCb(s_heap->nodes[i].id, s_heap->nodes[i].name,
                               s_heap->nodes[i].caps, false);
                }
            }
        }
    }

    // Drena os reports do ar (task do host so enfileirou).
    // Cada quadro custa 1 ECB + 1 CCM por rede de nid igual (AES por hw).
    RawReport r;
    netframe::Cipher ciphers[NetKeys::NETS_MAX];
    const int nc = NetKeys::ciphers(ciphers, NetKeys::NETS_MAX);
    for (int i = 0; i < 8 && xQueueReceive(s_raw, &r, 0) == pdTRUE; i++) {
        netframe::Frame f;
        uint8_t plain[netframe::DATA_MAX];
        int net = -1;
        if (!netframe::decode(r.data, r.len, ciphers, nc, &f, plain, &net)) {
            s_rxAuthFail++;  // outra rede por perto (ou forjado)
            continue;
        }
        s_rxFrames++;
        if (net != 0) {
            // rede secundaria (a aberta, na caca do provisionador): fica
            // fora da presenca/entrega da matilha — V2 (Provision) assina
            s_rxOther++;
            continue;
        }
        s_lastRaw = r;
        handleFrame(f, net, r.data, r.len, r.rssi, nowMs);
    }

    s_heap->reasm.prune(nowMs, K_REASM_TTL_MS);
    maybeBurst(nowMs);
    xSemaphoreGiveRecursive(lock());
}
