#ifndef CELEROS_BT_NET_FRAME_H
#define CELEROS_BT_NET_FRAME_H

// CelerNet v3 (API 37): quadro SEGURO da malha por flood de advertising.
//
// Cada no anuncia pacotes ADV_NONCONN de 31 bytes e escuta o ar; quem ouve
// um quadro novo QUE AUTENTICA na sua rede entrega ao app e repete com
// ttl-1. Inspirado na camada de rede do Bluetooth Mesh SIG:
//
//   [0]  'C'                magic
//   [1]  ver(4) | tipo(4)   ver = 3
//   [2]  nid                8 bits da chave da rede (escolhe a chave no RX)
//   [3]  ttl(4) | saltos(4) EM CLARO e fora do MIC: o repetidor so troca
//                           este byte, sem recifrar (o SIG idem com CTL/TTL)
//   [4..6]  seq24           -+ OFUSCADOS (XOR com AES-ECB(privKey, iv ||
//   [7..8]  src              |  7 primeiros bytes cifrados), como no SIG
//   [9..10] dst             -+
//   [11..]  dados cifrados (AES-CCM, encKey) + MIC de 4 bytes
//
// Nonce do CCM (13 B) = 0x00 | tipo | seq24 | src | dst | iv32 — seq UNICO
// por quadro (fragmentos e copias ganham seqs proprios: ver FRAG abaixo).
// AAD = bytes 1..2 (ver/tipo e nid). Dados uteis: 31 - 11 - 4 = 16 B.
//
// tipo = BEAT (presenca: [caps][flags][nome]) | DATA (mensagem inteira,
//        <= 16 B) | FRAG ([idx|copia][total][chunk <= 14 B]). A mensagem
//        fragmentada usa seqs CONSECUTIVOS: o fragmento i da copia c tem
//        seq = seqZero + c*total + i — o remontador junta fragmentos de
//        qualquer copia pela chave (src, seqZero).
//
// Header-only puro: a cifra entra por interface (Cipher) — o firmware liga
// o PSA (NetKeys), os testes do host ligam uma cifra falsa deterministica.

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace netframe {

constexpr uint8_t MAGIC = 'C';
constexpr uint8_t VERSION = 3;
constexpr size_t HDR = 11;
constexpr size_t MIC = 4;
constexpr size_t ADV_MAX = 31;
constexpr size_t DATA_MAX = ADV_MAX - HDR - MIC;  // 16
constexpr uint16_t DST_BROADCAST = 0xFFFF;
constexpr uint8_t TYPE_BEAT = 0;
constexpr uint8_t TYPE_DATA = 1;
constexpr uint8_t TYPE_FRAG = 2;
constexpr size_t CHUNK_MAX = DATA_MAX - 2;  // [idx|copia][total] + 14
constexpr uint8_t MAX_FRAGS = 31;
constexpr uint8_t FRAG_IDX_MASK = 0x1F;
constexpr uint8_t FRAG_COPY_SHIFT = 5;
constexpr size_t MSG_MAX = 434;              // 31 x 14
constexpr uint8_t TTL_MAX = 8;
constexpr uint8_t TTL_DEFAULT = 4;
constexpr uint32_t SEQ_MAX = 0xFFFFFF;       // 24 bits

// caps do BEAT: papel do no na matilha (bitmask, 1o byte dos dados)
constexpr uint8_t CAPS_SPEAKER = 0x01;
constexpr uint8_t CAPS_MIC = 0x02;
constexpr uint8_t CAPS_DISPLAY = 0x04;
constexpr uint8_t CAPS_MOTORS = 0x08;
constexpr uint8_t CAPS_LEDS = 0x10;
constexpr uint8_t CAPS_HUB = 0x20;
constexpr uint8_t CAPS_CAMERA = 0x40;
// API 47: o no publica recursos da matilha (rele/sensor/mic/camera/canais) —
// discovery sem esperar resposta do DESCRIBE. Bits novos sao aditivos: nos
// velhos ignoram.
constexpr uint8_t CAPS_RES = 0x80;

// flags do BEAT (2o byte): estado de provisionamento
constexpr uint8_t BFLAG_UNPROV = 0x01;  // na rede aberta, aceitando matilha
constexpr uint8_t BFLAG_ADMIN = 0x02;   // tem a chave de admin da matilha
constexpr uint8_t BFLAG_PROXY = 0x04;   // no virtual anunciado por um gateway (PC no cabo, API 41)

struct Frame {
    uint8_t type = TYPE_DATA;
    uint8_t nid = 0;
    uint8_t ttl = TTL_DEFAULT;
    uint8_t hops = 0;
    uint32_t seq = 0;  // 24 bits
    uint16_t src = 0;
    uint16_t dst = DST_BROADCAST;
    const uint8_t* data = nullptr;  // texto claro (encode) / buffer do chamador (decode)
    uint8_t dlen = 0;
};

// Cifra de UMA rede. seal: out = cifrado(len) || MIC(4). open: in tem len
// bytes cifrados seguidos do MIC; out recebe len bytes claros. ecb: 1 bloco
// AES com a privKey (ofuscacao do cabecalho).
struct Cipher {
    void* ctx = nullptr;
    uint8_t nid = 0;
    uint32_t iv = 0;
    bool (*seal)(void* ctx, const uint8_t nonce[13], const uint8_t* aad, size_t aadLen,
                 const uint8_t* in, size_t len, uint8_t* out) = nullptr;
    bool (*open)(void* ctx, const uint8_t nonce[13], const uint8_t* aad, size_t aadLen,
                 const uint8_t* in, size_t len, uint8_t* out) = nullptr;
    void (*ecb)(void* ctx, const uint8_t in[16], uint8_t out[16]) = nullptr;
};

inline void nonceOf(uint8_t type, uint32_t seq, uint16_t src, uint16_t dst, uint32_t iv, uint8_t n[13]) {
    n[0] = 0x00;
    n[1] = type;
    n[2] = (uint8_t)(seq >> 16);
    n[3] = (uint8_t)(seq >> 8);
    n[4] = (uint8_t)seq;
    n[5] = (uint8_t)(src >> 8);
    n[6] = (uint8_t)src;
    n[7] = (uint8_t)(dst >> 8);
    n[8] = (uint8_t)dst;
    n[9] = (uint8_t)(iv >> 24);
    n[10] = (uint8_t)(iv >> 16);
    n[11] = (uint8_t)(iv >> 8);
    n[12] = (uint8_t)iv;
}

// Mascara de 7 bytes do cabecalho ofuscado (seq|src|dst), funcao dos bytes
// cifrados (que o relay nao muda) e do iv
inline void privacyMask(const Cipher& c, const uint8_t* enc, size_t encLen, uint8_t mask[7]) {
    uint8_t in[16] = {0};
    in[0] = (uint8_t)(c.iv >> 24);
    in[1] = (uint8_t)(c.iv >> 16);
    in[2] = (uint8_t)(c.iv >> 8);
    in[3] = (uint8_t)c.iv;
    memcpy(in + 4, enc, encLen < 7 ? encLen : 7);
    uint8_t out[16];
    c.ecb(c.ctx, in, out);
    memcpy(mask, out, 7);
}

// Serializa e cifra; devolve o tamanho total (0 = invalido / cifra falhou).
inline size_t encode(const Frame& f, const Cipher& c, uint8_t* out, size_t cap) {
    if (f.dlen > DATA_MAX || f.ttl == 0 || f.ttl > TTL_MAX || f.hops > 15 || f.seq > SEQ_MAX) return 0;
    if (f.dlen > 0 && f.data == nullptr) return 0;
    const size_t len = HDR + f.dlen + MIC;
    if (len > cap || c.seal == nullptr || c.ecb == nullptr) return 0;
    out[0] = MAGIC;
    out[1] = (uint8_t)((VERSION << 4) | (f.type & 0x0F));
    out[2] = c.nid;
    out[3] = (uint8_t)((f.ttl << 4) | (f.hops & 0x0F));
    uint8_t nonce[13];
    nonceOf(f.type, f.seq, f.src, f.dst, c.iv, nonce);
    if (!c.seal(c.ctx, nonce, out + 1, 2, f.data, f.dlen, out + HDR)) return 0;
    uint8_t mask[7];
    privacyMask(c, out + HDR, f.dlen + MIC, mask);
    const uint8_t clear[7] = {(uint8_t)(f.seq >> 16), (uint8_t)(f.seq >> 8), (uint8_t)f.seq,
                              (uint8_t)(f.src >> 8),  (uint8_t)f.src,       (uint8_t)(f.dst >> 8),
                              (uint8_t)f.dst};
    for (int i = 0; i < 7; i++) out[4 + i] = clear[i] ^ mask[i];
    return len;
}

// Reconhece o formato (magic/versao/tamanho) sem chave: o RX descarta o
// resto do ar no 1o if, antes de gastar AES.
inline bool looksLike(const uint8_t* buf, size_t len) {
    return len >= HDR + MIC && len <= ADV_MAX && buf[0] == MAGIC && (buf[1] >> 4) == VERSION;
}

// Decifra com a rede de nid igual (ciphers[0..n)); plain recebe ate
// DATA_MAX bytes e out->data aponta para ele. *net = indice da rede que
// autenticou. false = formato invalido, nenhuma rede casa ou MIC falhou.
inline bool decode(const uint8_t* buf, size_t len, const Cipher* ciphers, int n, Frame* out,
                   uint8_t* plain, int* net) {
    if (!looksLike(buf, len)) return false;
    const uint8_t nid = buf[2];
    const size_t encLen = len - HDR;  // dados + MIC
    const uint8_t dlen = (uint8_t)(encLen - MIC);
    for (int k = 0; k < n; k++) {
        const Cipher& c = ciphers[k];
        if (c.nid != nid || c.open == nullptr || c.ecb == nullptr) continue;
        uint8_t mask[7];
        privacyMask(c, buf + HDR, encLen, mask);
        uint8_t h[7];
        for (int i = 0; i < 7; i++) h[i] = buf[4 + i] ^ mask[i];
        const uint32_t seq = ((uint32_t)h[0] << 16) | ((uint32_t)h[1] << 8) | h[2];
        const uint16_t src = (uint16_t)((h[3] << 8) | h[4]);
        const uint16_t dst = (uint16_t)((h[5] << 8) | h[6]);
        const uint8_t type = buf[1] & 0x0F;
        uint8_t nonce[13];
        nonceOf(type, seq, src, dst, c.iv, nonce);
        if (!c.open(c.ctx, nonce, buf + 1, 2, buf + HDR, dlen, plain)) continue;
        out->type = type;
        out->nid = nid;
        out->ttl = (uint8_t)(buf[3] >> 4);
        out->hops = (uint8_t)(buf[3] & 0x0F);
        out->seq = seq;
        out->src = src;
        out->dst = dst;
        out->data = plain;
        out->dlen = dlen;
        if (net != nullptr) *net = k;
        if (out->ttl == 0 || out->ttl > TTL_MAX) return false;
        return true;
    }
    return false;
}

// Relay: o quadro segue IDENTICO, so o byte de ttl/saltos muda (fora do MIC)
inline bool relayPatch(uint8_t* buf, size_t len) {
    if (!looksLike(buf, len)) return false;
    const uint8_t ttl = (uint8_t)(buf[3] >> 4), hops = (uint8_t)(buf[3] & 0x0F);
    if (ttl <= 1) return false;
    buf[3] = (uint8_t)(((ttl - 1) << 4) | (hops < 15 ? hops + 1 : 15));
    return true;
}

// ------------------------------------------------------------- replay

// Janela deslizante por origem (anti-replay do IPsec): aceita seq ainda nao
// visto dentro de [max-63, max] e qualquer um acima do max. O relay troca a
// ordem dos quadros (jitter por salto), por isso nao vale "so maior que".
// check() nao grava; commit() grava depois que o MIC autenticou. Src = id do
// no na malha (16 bits) ou a MAC no ESP-NOW (uint64_t).
template <int N, typename Src = uint16_t>
class Rpl {
public:
    enum Verdict { NEW, REPLAY, FULL };

    Verdict check(uint8_t net, Src src, uint32_t seq) const {
        const Entry* e = find(net, src);
        if (e == nullptr) return NEW;
        if (seq > e->max) return NEW;
        const uint32_t back = e->max - seq;
        if (back >= 64) return REPLAY;  // velho demais para a janela
        return (e->bits >> back) & 1 ? REPLAY : NEW;
    }

    void commit(uint8_t net, Src src, uint32_t seq, uint32_t nowMs) {
        Entry* e = find(net, src);
        if (e == nullptr) {
            e = slotFor(nowMs);
            e->used = true;
            e->net = net;
            e->src = src;
            e->max = seq;
            e->bits = 1;
            e->lastMs = nowMs;
            return;
        }
        e->lastMs = nowMs;
        if (seq > e->max) {
            const uint32_t shift = seq - e->max;
            e->bits = shift >= 64 ? 0 : e->bits << shift;
            e->bits |= 1;
            e->max = seq;
        } else {
            e->bits |= (uint64_t)1 << (e->max - seq);
        }
    }

    void clear() {
        for (int i = 0; i < N; i++) m_e[i].used = false;
    }

private:
    struct Entry {
        bool used = false;
        uint8_t net = 0;
        Src src = 0;
        uint32_t max = 0;
        uint64_t bits = 0;  // bit i = (max - i) ja visto
        uint32_t lastMs = 0;
    };
    Entry m_e[N];

    const Entry* find(uint8_t net, Src src) const {
        for (int i = 0; i < N; i++) {
            if (m_e[i].used && m_e[i].net == net && m_e[i].src == src) return &m_e[i];
        }
        return nullptr;
    }
    Entry* find(uint8_t net, Src src) {
        return const_cast<Entry*>(static_cast<const Rpl*>(this)->find(net, src));
    }
    // livre ou o menos recente (no que sumiu ha mais tempo)
    Entry* slotFor(uint32_t nowMs) {
        Entry* old = &m_e[0];
        for (int i = 0; i < N; i++) {
            if (!m_e[i].used) return &m_e[i];
            if (nowMs - m_e[i].lastMs > nowMs - old->lastMs) old = &m_e[i];
        }
        return old;
    }
};

// ------------------------------------------------------------------ dedup

// Quadro ja tratado (entregue/repetido)? Chave (src, seq): o seq e unico por
// quadro na v3. Ring de N entradas: visto de novo = true.
template <int N>
class DedupRing {
    static_assert(N > 0 && (N & (N - 1)) == 0, "N deve ser potencia de 2");
public:
    bool seen(uint16_t src, uint32_t seq) {
        for (int i = 0; i < N; i++) {
            if (m_e[i].used && m_e[i].src == src && m_e[i].seq == seq) return true;
        }
        m_e[m_pos] = Key{src, seq, 1};
        m_pos = (m_pos + 1) & (N - 1);
        return false;
    }

    void clear() {
        memset(m_e, 0, sizeof(m_e));
        m_pos = 0;
    }

private:
    struct Key {
        uint16_t src;
        uint32_t seq;
        uint8_t used;
    };
    Key m_e[N] = {};
    uint32_t m_pos = 0;
};

// ------------------------------------------------------------- remontagem

// seqZero do fragmento: seq - (copia*total + idx)
inline uint32_t fragSeqZero(uint32_t seq, uint8_t idxByte, uint8_t total) {
    const uint32_t idx = idxByte & FRAG_IDX_MASK;
    const uint32_t copy = (uint32_t)(idxByte >> FRAG_COPY_SHIFT) & 3;
    return seq - (copy * total + idx);
}

// Junta os fragmentos de UMA mensagem (src, seqZero) e devolve a mensagem
// completa no ultimo. Slots parados ha mais que o prazo viram livres.
class Reassembler {
public:
    void prune(uint32_t nowMs, uint32_t timeoutMs) {
        for (int i = 0; i < SLOTS; i++) {
            if (m_s[i].active && nowMs - m_s[i].lastMs > timeoutMs) m_s[i].active = false;
        }
    }

    bool feed(uint16_t src, uint32_t seqZero, uint8_t idxByte, uint8_t total, const uint8_t* chunk,
              uint8_t chunkLen, uint32_t nowMs, uint8_t* outMsg, size_t cap, size_t* outLen) {
        const uint8_t idx = idxByte & FRAG_IDX_MASK;
        if (total == 0 || total > MAX_FRAGS || idx >= total || chunkLen > CHUNK_MAX) return false;
        for (int i = 0; i < DONE; i++) {
            if (m_done[i].used && m_done[i].src == src && m_done[i].seqZero == seqZero) return false;
        }
        Slot* s = nullptr;
        for (int i = 0; i < SLOTS; i++) {
            if (m_s[i].active && m_s[i].src == src && m_s[i].seqZero == seqZero) {
                if (m_s[i].total != total) return false;
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
            if (s == nullptr) return false;
            memset(s->buf, 0, sizeof(s->buf));
            s->src = src;
            s->seqZero = seqZero;
            s->total = total;
            s->gotMask = 0;
            s->len = 0;
            s->active = true;
        }
        s->lastMs = nowMs;
        if (s->gotMask & (1u << idx)) return false;
        if ((size_t)(idx * CHUNK_MAX + chunkLen) > MSG_MAX) return false;
        if (idx + 1 < total && chunkLen != CHUNK_MAX) return false;
        memcpy(s->buf + idx * CHUNK_MAX, chunk, chunkLen);
        s->gotMask |= (uint32_t)(1u << idx);
        if ((size_t)(idx * CHUNK_MAX + chunkLen) > s->len) s->len = (uint16_t)(idx * CHUNK_MAX + chunkLen);
        if (s->gotMask != (uint32_t)((1u << s->total) - 1)) return false;
        if (s->len > cap) {
            // Destino menor que a mensagem: antes copiava cap bytes e devolvia
            // *outLen = s->len (o chamador lia alem do buffer). Recusa a
            // entrega, mas encerra o slot (e registra em done) para nao
            // prende-lo ate o prune — a mensagem nao vai caber nunca.
            s->active = false;
            m_done[m_donePos] = Done{src, seqZero, true};
            m_donePos = (uint8_t)((m_donePos + 1) % DONE);
            return false;
        }
        memcpy(outMsg, s->buf, s->len);
        *outLen = s->len;
        s->active = false;
        m_done[m_donePos] = Done{src, seqZero, true};
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
        uint16_t src = 0;
        uint32_t seqZero = 0;
        bool active = false;
        uint8_t total = 0;
        uint32_t gotMask = 0;
        uint16_t len = 0;
        uint32_t lastMs = 0;
        uint8_t buf[MSG_MAX] = {};
    };
    Slot m_s[SLOTS];
    static constexpr int DONE = 8;
    struct Done {
        uint16_t src = 0;
        uint32_t seqZero = 0;
        bool used = false;
    };
    Done m_done[DONE];
    uint8_t m_donePos = 0;
};

}  // namespace netframe

#endif  // CELEROS_BT_NET_FRAME_H
