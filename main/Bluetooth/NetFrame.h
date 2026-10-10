#ifndef CELEROS_BT_NET_FRAME_H
#define CELEROS_BT_NET_FRAME_H

// CelerNet: quadro da malha por flood de advertising (API 26; v2 na 27).
//
// Cada no da malha anuncia pacotes ADV_NONCONN de 31 bytes e escuta o ar;
// quem ouve um quadro novo repete com ttl-1 — a area e coberta por saltos,
// sem nenhuma conexao GATT (o Celer Link par-a-par segue intocado). E o
// mecanismo-nucleo do BLE Mesh (flood gerenciado), aqui em 31 bytes crus:
// o quadro vai direto no advertising data, sem estrutura AD — o proprio
// advertising bearer do BLE Mesh e cru (magic 'C''N' no byte 0 decide o que
// e nosso; scanners de fora ignoram payload desconhecido).
//
// Layout v2 (15 bytes de cabecalho + dados, total <= 31):
//   'C''N' | ver(1) | tipo(1) | netId(2) | src(2) | dst(2) | seq(2) | ttl(1)
//         | hops(1) | dlen(1) | dados(dlen)
//
//   ver    = 2 (v1 nao tinha dst; a v2 nasceu antes do primeiro push da v1)
//   tipo   = BEAT (presenca: [caps(1)][nome NUL]) | DATA (mensagem inteira,
//          |   <= 16 B) | FRAG (fragmento: [idx(1)][total(1)][chunk(<= 14 B)];
//          |   mensagem de ate 434 B = 31 fragmentos com o MESMO (src, seq)
//   netId  = FNV-1a 16 bits do nome da rede: so entra na malha quem tem o
//            mesmo ID (v1 aberta; criptografia fica para uma v3)
//   src    = 2 ultimos bytes da MAC BT (identidade do no, zero config)
//   dst    = destino do UNICAST; 0xFFFF = broadcast (todos entregam). O
//            repetidor NAO filtra por dst: o quadro segue o flood do mesmo
//            jeito — so a ENTREGA e do destinatario.
//   seq    = contador u16 por no; dedup por (src, seq, idx)
//   ttl    = saltos restantes (repetidor decrementa); max 8
//   hops   = saltos ja dados (repetidor incrementa; e o que o app mostra)
//
// caps do BEAT (byte 0 dos dados): o que o no oferece a matilha.
//
// Header-only puro, sem um tipo do ESP/NimBLE: compila no host e os testes
// C++ (test/cpp) exercitam round-trip, dedup e remontagem.

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace netframe {

constexpr uint8_t MAGIC[2] = {'C', 'N'};
constexpr uint8_t VERSION = 2;
constexpr size_t HDR = 15;             // cabecalho inteiro (ate dlen)
constexpr size_t ADV_MAX = 31;         // payload do ADV_NONCONN legado
constexpr size_t DATA_MAX = ADV_MAX - HDR;  // 16 bytes de dados
constexpr uint16_t DST_BROADCAST = 0xFFFF;
constexpr uint8_t TYPE_BEAT = 0;       // presenca: [caps(1)][nome NUL]
constexpr uint8_t TYPE_DATA = 1;       // mensagem que cabe inteira (<= 16 B)
constexpr uint8_t TYPE_FRAG = 2;       // fragmento de mensagem maior
constexpr size_t FRAG_IDX = 1;         // posicao do idx nos dados do FRAG
constexpr size_t FRAG_TOTAL = 1;       // posicao do total
constexpr size_t CHUNK_MAX = DATA_MAX - FRAG_IDX - FRAG_TOTAL;  // 14
constexpr uint8_t MAX_FRAGS = 31;      // 31 x 14 = 434 (teto da mensagem)
// Byte idx do FRAG: bits 0-4 = indice (0..30), bits 5-6 = numero da COPIA
// (unicast com copies). As copias de uma mensagem dividem o MESMO seq: o
// dedup ve (src, seq, idx-com-copia) distintos — repetidores levam todas —
// e o remontador junta fragmentos de qualquer copia. Firmware sem isso
// descarta as copias >= 1 (idx >= total) e segue com a copia 0.
constexpr uint8_t FRAG_IDX_MASK = 0x1F;
constexpr uint8_t FRAG_COPY_SHIFT = 5;
constexpr size_t MSG_MAX = 434;        // envelope de musica cabe inteiro
constexpr uint8_t TTL_MAX = 8;
constexpr uint8_t TTL_DEFAULT = 4;

// caps do BEAT: papel do no na matilha (bitmask nos dados do BEAT).
constexpr uint8_t CAPS_SPEAKER = 0x01;  // tem alto-falante (recebe musica)
constexpr uint8_t CAPS_MIC = 0x02;      // tem microfone
constexpr uint8_t CAPS_DISPLAY = 0x04;  // tem tela (matilha mostra nele)
constexpr uint8_t CAPS_MOTORS = 0x08;   // se move (patas/motores)
constexpr uint8_t CAPS_LEDS = 0x10;     // matriz/fitas de LED
constexpr uint8_t CAPS_HUB = 0x20;      // rede configurada (alcaca o hub)
constexpr uint8_t CAPS_CAMERA = 0x40;    // sensor de camera (le QR/fotos)

struct Frame {
    uint8_t type = TYPE_DATA;
    uint16_t netId = 0;
    uint16_t src = 0;
    uint16_t dst = DST_BROADCAST;
    uint16_t seq = 0;
    uint8_t ttl = TTL_DEFAULT;
    uint8_t hops = 0;
    const uint8_t* data = nullptr;  // aponta para os dados (nao copia)
    uint8_t dlen = 0;
};

// FNV-1a truncado para 16 bits (netId do nome da rede).
inline uint16_t fnv16(const char* s) {
    uint32_t h = 2166136261u;
    for (const char* p = s; *p != '\0'; p++) {
        h ^= (uint8_t)*p;
        h *= 16777619u;
    }
    return (uint16_t)(h ^ (h >> 16));
}

// Serializa; devolve o tamanho total (0 = dados nao cabem).
inline size_t encode(const Frame& f, uint8_t* out, size_t cap) {
    if (f.dlen > DATA_MAX || f.ttl == 0 || f.ttl > TTL_MAX || f.data == nullptr) return 0;
    size_t len = HDR + f.dlen;
    if (len > cap) return 0;
    out[0] = MAGIC[0];
    out[1] = MAGIC[1];
    out[2] = VERSION;
    out[3] = f.type;
    out[4] = (uint8_t)(f.netId >> 8);
    out[5] = (uint8_t)f.netId;
    out[6] = (uint8_t)(f.src >> 8);
    out[7] = (uint8_t)f.src;
    out[8] = (uint8_t)(f.dst >> 8);
    out[9] = (uint8_t)f.dst;
    out[10] = (uint8_t)(f.seq >> 8);
    out[11] = (uint8_t)f.seq;
    out[12] = f.ttl;
    out[13] = f.hops;
    out[14] = f.dlen;
    memcpy(out + HDR, f.data, f.dlen);
    return len;
}

// Reconhece e decodifica um quadro nosso (magic + versao + tamanhos).
// Frame.data aponta DENTRO de buf; valido enquanto buf viver.
inline bool decode(const uint8_t* buf, size_t len, Frame* out) {
    if (len < HDR || len > ADV_MAX) return false;
    if (buf[0] != MAGIC[0] || buf[1] != MAGIC[1] || buf[2] != VERSION) return false;
    uint8_t dlen = buf[14];
    if ((size_t)dlen + HDR != len) return false;
    out->type = buf[3];
    out->netId = (uint16_t)((buf[4] << 8) | buf[5]);
    out->src = (uint16_t)((buf[6] << 8) | buf[7]);
    out->dst = (uint16_t)((buf[8] << 8) | buf[9]);
    out->seq = (uint16_t)((buf[10] << 8) | buf[11]);
    out->ttl = buf[12];
    out->hops = buf[13];
    out->dlen = dlen;
    out->data = buf + HDR;
    if (out->ttl == 0 || out->ttl > TTL_MAX) return false;
    return true;
}

// ------------------------------------------------------------------ dedup

// Chave de dedup: (src, seq, idx). DATA/BEAT usam idx 0; FRAG usa o proprio
// idx do fragmento. Ring de N entradas: visto de novo = true.
struct DedupKey {
    uint16_t src;
    uint16_t seq;
    uint8_t idx;
    uint8_t used;
};

template <int N>
class DedupRing {
    static_assert(N > 0 && (N & (N - 1)) == 0, "N deve ser potencia de 2");
public:
    bool seen(uint16_t src, uint16_t seq, uint8_t idx) {
        for (int i = 0; i < N; i++) {
            if (m_e[i].used && m_e[i].src == src && m_e[i].seq == seq && m_e[i].idx == idx) {
                return true;
            }
        }
        m_e[m_pos] = DedupKey{src, seq, idx, 1};
        m_pos = (m_pos + 1) & (N - 1);
        return false;
    }

    void clear() {
        memset(m_e, 0, sizeof(m_e));
        m_pos = 0;
    }

private:
    DedupKey m_e[N] = {};
    uint32_t m_pos = 0;
};

// ------------------------------------------------------------- remontagem

// Coleta os fragmentos de UMA mensagem (mesmos src/seq) e devolve a
// mensagem completa quando o ultimo chega. Slots parados ha mais que o
// prazo viram livres (fragmento perdido nao trava o proximo).

// alimenta um fragmento; true = mensagem completa em *outMsg/outLen.
// ageMs/pruneNow mantem o relogio do chamador (millis no firmware, contagem
// no teste).
class Reassembler {
public:
    // Descarta slots parados ha mais que timeoutMs (chamar antes de alimentar).
    void prune(uint32_t nowMs, uint32_t timeoutMs) {
        for (int i = 0; i < SLOTS; i++) {
            if (m_s[i].active && nowMs - m_s[i].lastMs > timeoutMs) m_s[i].active = false;
        }
    }

    bool feed(uint16_t src, uint16_t seq, uint8_t idxByte, uint8_t total,
              const uint8_t* chunk, uint8_t chunkLen, uint32_t nowMs,
              uint8_t* outMsg, size_t cap, size_t* outLen) {
        const uint8_t idx = idxByte & FRAG_IDX_MASK;  // copia nao importa aqui
        if (total == 0 || total > MAX_FRAGS || idx >= total || chunkLen > CHUNK_MAX) return false;
        // ja entregue (a outra copia terminou antes): nao remonta de novo
        for (int i = 0; i < DONE; i++) {
            if (m_done[i].used && m_done[i].src == src && m_done[i].seq == seq) return false;
        }
        Slot* s = nullptr;
        for (int i = 0; i < SLOTS; i++) {
            if (m_s[i].active && m_s[i].src == src && m_s[i].seq == seq) {
                if (m_s[i].total != total) return false;  // colisao de seq: descarta
                s = &m_s[i];
                break;
            }
        }
        if (s == nullptr) {
            for (int i = 0; i < SLOTS; i++) {
                if (!m_s[i].active) {
                    s = &m_s[i];
                    break;
                }
            }
            if (s == nullptr) return false;  // sem slot: 4 mensagens grandes em voo
            memset(s->buf, 0, sizeof(s->buf));
            s->src = src;
            s->seq = seq;
            s->total = total;
            s->gotMask = 0;
            s->len = 0;
            s->active = true;
        }
        s->lastMs = nowMs;
        if (s->gotMask & (1u << idx)) return false;  // repetido
        if ((size_t)(idx * CHUNK_MAX + chunkLen) > MSG_MAX) return false;
        if (idx + 1 < total && chunkLen != CHUNK_MAX) return false;  // so o ultimo pode ser curto
        memcpy(s->buf + idx * CHUNK_MAX, chunk, chunkLen);
        s->gotMask |= (uint32_t)(1u << idx);
        if ((size_t)(idx * CHUNK_MAX + chunkLen) > s->len) s->len = (uint16_t)(idx * CHUNK_MAX + chunkLen);
        if (s->gotMask != totalMask(s->total)) return false;
        size_t n = s->len < cap ? s->len : cap;
        memcpy(outMsg, s->buf, n);
        *outLen = s->len;
        s->active = false;
        m_done[m_donePos] = Done{src, seq, true};
        m_donePos = (uint8_t)((m_donePos + 1) % DONE);
        return true;
    }

    void reset() {
        for (int i = 0; i < SLOTS; i++) m_s[i].active = false;
        for (int i = 0; i < DONE; i++) m_done[i].used = false;
    }

private:
    static constexpr int SLOTS = 4;
    struct Slot {
        uint16_t src = 0, seq = 0;
        bool active = false;
        uint8_t total = 0;
        uint32_t gotMask = 0;  // bit i = fragmento i em maos (ate 31)
        uint16_t len = 0;
        uint32_t lastMs = 0;
        uint8_t buf[MSG_MAX] = {};
    };
    Slot m_s[SLOTS];
    // mensagens remontadas ha pouco: os frags da copia seguinte nao abrem slot
    static constexpr int DONE = 8;
    struct Done {
        uint16_t src = 0, seq = 0;
        bool used = false;
    };
    Done m_done[DONE];
    uint8_t m_donePos = 0;

    static uint32_t totalMask(uint8_t total) {
        return (uint32_t)((1u << total) - 1);  // total <= 31
    }
};

}  // namespace netframe

#endif  // CELEROS_BT_NET_FRAME_H
