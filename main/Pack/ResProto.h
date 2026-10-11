#ifndef CELEROS_PACK_RES_PROTO_H
#define CELEROS_PACK_RES_PROTO_H

// Recursos da matilha (API 36): o protocolo de CONTROLE, header-only puro
// (compila no host; test/cpp exercita codec e leases).
//
// Cada no expoe recursos (mic, speaker, camera, canais de dados de apps) e
// qualquer membro pode abri-los. O controle viaja em envelopes do Pack
// (KIND_RES, unicast com dedup por msgId); o payload do envelope e:
//
//   [op u8][corpo]
//
//   DESCRIBE  cli->srv  []                       lista o que o no expoe
//   LIST      srv->cli  [n u8] n x [type u8][flags u8][nlen u8][nome]
//   OPEN      cli->srv  [req u8][nlen u8][nome][plen u8][params(plen)][link 8]
//   ACCEPT    srv->cli  [req u8][sid u16][leaseDs u16][transp u8][chan u8][mac 6][token u32]
//   link do cliente = [flags u8][chan u8][mac 6]: LINK_UP (ESP-NOW de pe),
//   LINK_LOCKED (canal preso: STA no AP ou sessoes ESP-NOW abertas)
//   REFUSE    srv->cli  [req u8][motivo u8]              (REASON_*)
//   KEEP      cli->srv  [sid u16]                         renova o lease
//   CLOSE     cli->srv  [sid u16]                         fim pedido (o servidor usa REVOKE)
//   REVOKE    srv->cli  [sid u16][motivo u8]              o dono tomou de volta
//   DATA      ambos     [sid u16][seq u16][bytes]         canal de dados
//
// Sessao = lease: o servidor devolve o recurso sozinho quando o cliente
// some (sem KEEP por leaseDs). O cliente renova a cada lease/4. A sessao e
// identificada por (no servidor, sid) — sid unico por servidor. KEEP de
// sessao desconhecida volta como REVOKE "expired" e o cliente reabre. O OPEN vai
// pelo NOME ("mic", "speaker", "camera" ou o canal do app): o cliente nao
// precisa do LIST antes de abrir.
//
// PLANO DE DADOS: o servidor escolhe o transporte da sessao com os enlaces
// dos dois lados (chooseTransport): ESP-NOW (DataLink.h, ate 1458 B por
// quadro, sem roteador) quando os dois o tem e cabem num canal comum; senao
// a propria malha (DATA no envelope, ate MAX_DATA bytes, taxa baixa).

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace resproto {

constexpr uint8_t OP_DESCRIBE = 1;
constexpr uint8_t OP_LIST = 2;
constexpr uint8_t OP_OPEN = 3;
constexpr uint8_t OP_ACCEPT = 4;
constexpr uint8_t OP_REFUSE = 5;
constexpr uint8_t OP_KEEP = 6;
constexpr uint8_t OP_CLOSE = 7;
constexpr uint8_t OP_REVOKE = 8;
constexpr uint8_t OP_DATA = 9;
// HELLO (so pelo ESP-NOW, broadcast a cada 5 s): [caps u8][nlen u8][nome].
// Presenca redundante com a malha: um no que mal transmite no BLE (esp32-cam
// com WiFi conectado: coex deixa ~0,3 quadro/s) ainda e achado por quem
// divide o canal com ele
constexpr uint8_t OP_HELLO = 10;

// Tipos de recurso (o que o JS ve em type)
constexpr uint8_t TYPE_DATA = 0;
constexpr uint8_t TYPE_MIC = 1;
constexpr uint8_t TYPE_SPEAKER = 2;
constexpr uint8_t TYPE_CAMERA = 3;

// flags do LIST
constexpr uint8_t FLAG_BUSY = 0x01;    // ja ha sessao aberta (exclusivo)
constexpr uint8_t FLAG_SHARED = 0x02;  // varias sessoes ao mesmo tempo (dados)
constexpr uint8_t FLAG_READY = 0x04;   // o provedor existe neste firmware

// motivos de REFUSE/REVOKE
constexpr uint8_t REASON_NOT_FOUND = 1;    // nome desconhecido
constexpr uint8_t REASON_BUSY = 2;         // exclusivo e ocupado
constexpr uint8_t REASON_POLICY = 3;       // dono desligou o compartilhamento
constexpr uint8_t REASON_UNSUPPORTED = 4;  // provedor ainda nao existe aqui
constexpr uint8_t REASON_FULL = 5;         // tabela de sessoes cheia
constexpr uint8_t REASON_LOCAL = 6;        // o app local tomou o recurso
constexpr uint8_t REASON_GONE = 7;         // recurso retirado (app saiu)
// sessao desconhecida no servidor (lease venceu sem KEEP, reboot): o
// cliente que ainda quer o recurso REABRE sozinho com o mesmo handle
constexpr uint8_t REASON_EXPIRED = 8;
// recurso de stream (mic/speaker/camera) sem canal ESP-NOW comum: a malha
// BLE (~100 B/s) nao leva audio nem imagem
constexpr uint8_t REASON_NO_LINK = 9;

constexpr size_t RES_NAME_MAX = 15;
constexpr size_t PARAMS_MAX = 48;
constexpr int LIST_MAX = 12;               // recursos por no
// Envelope do Pack: 430 B de payload; DATA = op + sid + seq = 5 B
constexpr size_t ENV_PAYLOAD = 430;
constexpr size_t MAX_DATA = ENV_PAYLOAD - 5;
// 20 s: na bancada (4848 + relogio, 2026-10-11) o lease de 10 s vencia a
// cada ~20 s — o KEEP esperava na fila do TX atras dos fragmentos de
// dados e chegava tarde. O KEEP sai a cada lease/4 e e urgente.
constexpr uint16_t LEASE_DS_DEFAULT = 200;

inline const char* typeName(uint8_t t) {
    switch (t) {
        case TYPE_MIC: return "mic";
        case TYPE_SPEAKER: return "speaker";
        case TYPE_CAMERA: return "camera";
        default: return "data";
    }
}

inline const char* reasonName(uint8_t r) {
    switch (r) {
        case REASON_NOT_FOUND: return "notFound";
        case REASON_BUSY: return "busy";
        case REASON_POLICY: return "denied";
        case REASON_UNSUPPORTED: return "unsupported";
        case REASON_FULL: return "full";
        case REASON_LOCAL: return "local";
        case REASON_GONE: return "gone";
        case REASON_EXPIRED: return "expired";
        case REASON_NO_LINK: return "noLink";
        default: return "unknown";
    }
}

// Enlace ESP-NOW de um no (vai no OPEN; o servidor tem o seu)
constexpr uint8_t LINK_UP = 0x01;
constexpr uint8_t LINK_LOCKED = 0x02;
constexpr size_t LINK_LEN = 8;
struct Link {
    uint8_t flags = 0;
    uint8_t chan = 0;
    uint8_t mac[6] = {0};
};

constexpr uint8_t TRANSPORT_MESH = 0;
constexpr uint8_t TRANSPORT_ESPNOW = 1;

// Decisao do servidor: ESP-NOW se os dois tem e existe um canal comum. Canal
// preso (AP/sessoes) manda; os dois presos em canais diferentes = malha.
// *chan = canal da sessao (o lado livre troca para ele).
inline uint8_t chooseTransport(const Link& srv, const Link& cli, uint8_t* chan) {
    *chan = 0;
    if (!(srv.flags & LINK_UP) || !(cli.flags & LINK_UP) || srv.chan == 0 || cli.chan == 0) {
        return TRANSPORT_MESH;
    }
    const bool sl = (srv.flags & LINK_LOCKED) != 0, cl = (cli.flags & LINK_LOCKED) != 0;
    if (sl && cl && srv.chan != cli.chan) return TRANSPORT_MESH;
    *chan = sl ? srv.chan : (cl ? cli.chan : srv.chan);
    return TRANSPORT_ESPNOW;
}

struct Entry {
    uint8_t type = TYPE_DATA;
    uint8_t flags = 0;
    char name[RES_NAME_MAX + 1] = {0};
};

// --------------------------------------------------------------- escrita

class Writer {
public:
    Writer(uint8_t* buf, size_t cap) : m_b(buf), m_cap(cap) {}
    bool u8(uint8_t v) {
        if (m_n + 1 > m_cap) return fail();
        m_b[m_n++] = v;
        return true;
    }
    bool u16(uint16_t v) { return u8((uint8_t)(v >> 8)) && u8((uint8_t)v); }
    bool bytes(const void* p, size_t n) {
        if (m_n + n > m_cap) return fail();
        if (n > 0) memcpy(m_b + m_n, p, n);
        m_n += n;
        return true;
    }
    size_t size() const { return m_ok ? m_n : 0; }
    bool ok() const { return m_ok; }

private:
    bool fail() {
        m_ok = false;
        return false;
    }
    uint8_t* m_b;
    size_t m_cap;
    size_t m_n = 0;
    bool m_ok = true;
};

class Reader {
public:
    Reader(const uint8_t* buf, size_t len) : m_b(buf), m_len(len) {}
    bool u8(uint8_t* v) {
        if (m_pos + 1 > m_len) return false;
        *v = m_b[m_pos++];
        return true;
    }
    bool u16(uint16_t* v) {
        uint8_t h, l;
        if (!u8(&h) || !u8(&l)) return false;
        *v = (uint16_t)((h << 8) | l);
        return true;
    }
    bool bytes(const uint8_t** p, size_t n) {
        if (m_pos + n > m_len) return false;
        *p = m_b + m_pos;
        m_pos += n;
        return true;
    }
    size_t left() const { return m_len - m_pos; }
    const uint8_t* rest() const { return m_b + m_pos; }

private:
    const uint8_t* m_b;
    size_t m_len;
    size_t m_pos = 0;
};

// ----------------------------------------------------------- mensagens

inline size_t encodeHello(uint8_t caps, const char* name, uint8_t* out, size_t cap) {
    const size_t nl = strnlen(name, RES_NAME_MAX);
    Writer w(out, cap);
    w.u8(OP_HELLO);
    w.u8(caps);
    w.u8((uint8_t)nl);
    w.bytes(name, nl);
    return w.size();
}

// corpo depois do op; name com RES_NAME_MAX+1
inline bool decodeHello(const uint8_t* body, size_t len, uint8_t* caps, char* name) {
    Reader r(body, len);
    uint8_t nl;
    const uint8_t* nm;
    if (!r.u8(caps) || !r.u8(&nl) || nl > RES_NAME_MAX || !r.bytes(&nm, nl)) return false;
    memcpy(name, nm, nl);
    name[nl] = '\0';
    return true;
}

inline size_t encodeDescribe(uint8_t* out, size_t cap) {
    Writer w(out, cap);
    w.u8(OP_DESCRIBE);
    return w.size();
}

inline size_t encodeList(const Entry* e, int n, uint8_t* out, size_t cap) {
    if (n < 0 || n > LIST_MAX) return 0;
    Writer w(out, cap);
    w.u8(OP_LIST);
    w.u8((uint8_t)n);
    for (int i = 0; i < n; i++) {
        size_t nl = strnlen(e[i].name, RES_NAME_MAX);
        w.u8(e[i].type);
        w.u8(e[i].flags);
        w.u8((uint8_t)nl);
        w.bytes(e[i].name, nl);
    }
    return w.size();
}

// corpo depois do op; devolve quantas entradas (-1 = malformado)
inline int decodeList(const uint8_t* body, size_t len, Entry* out, int max) {
    Reader r(body, len);
    uint8_t n;
    if (!r.u8(&n) || n > LIST_MAX) return -1;
    int got = 0;
    for (int i = 0; i < n; i++) {
        Entry e;
        uint8_t nl;
        const uint8_t* nm;
        if (!r.u8(&e.type) || !r.u8(&e.flags) || !r.u8(&nl)) return -1;
        if (nl > RES_NAME_MAX || !r.bytes(&nm, nl)) return -1;
        memcpy(e.name, nm, nl);
        e.name[nl] = '\0';
        if (got < max) out[got++] = e;
    }
    return got;
}

inline size_t encodeOpen(uint8_t req, const char* name, const uint8_t* params, size_t plen,
                         const Link& link, uint8_t* out, size_t cap) {
    const size_t nl = strnlen(name, RES_NAME_MAX + 1);
    if (plen > PARAMS_MAX || nl == 0 || nl > RES_NAME_MAX) return 0;
    Writer w(out, cap);
    w.u8(OP_OPEN);
    w.u8(req);
    w.u8((uint8_t)nl);
    w.bytes(name, nl);
    w.u8((uint8_t)plen);
    w.bytes(params, plen);
    w.u8(link.flags);
    w.u8(link.chan);
    w.bytes(link.mac, 6);
    return w.size();
}

struct OpenReq {
    uint8_t req = 0;
    char name[RES_NAME_MAX + 1] = {0};
    const uint8_t* params = nullptr;
    uint8_t plen = 0;
    Link link;
};

// corpo depois do op
inline bool decodeOpen(const uint8_t* body, size_t len, OpenReq* out) {
    Reader r(body, len);
    uint8_t nl;
    const uint8_t* nm;
    if (!r.u8(&out->req) || !r.u8(&nl) || nl == 0 || nl > RES_NAME_MAX || !r.bytes(&nm, nl)) return false;
    memcpy(out->name, nm, nl);
    out->name[nl] = '\0';
    if (!r.u8(&out->plen) || out->plen > PARAMS_MAX || !r.bytes(&out->params, out->plen)) return false;
    const uint8_t* mac;
    if (!r.u8(&out->link.flags) || !r.u8(&out->link.chan) || !r.bytes(&mac, 6)) return false;
    memcpy(out->link.mac, mac, 6);
    return r.left() == 0;
}

struct Accept {
    uint8_t req = 0;
    uint16_t sid = 0;
    uint16_t leaseDs = 0;
    uint8_t transport = TRANSPORT_MESH;
    uint8_t chan = 0;
    uint8_t mac[6] = {0};   // MAC ESP-NOW do servidor
    uint32_t token = 0;     // vai em todo quadro ESP-NOW da sessao
};

inline size_t encodeAccept(const Accept& a, uint8_t* out, size_t cap) {
    Writer w(out, cap);
    w.u8(OP_ACCEPT);
    w.u8(a.req);
    w.u16(a.sid);
    w.u16(a.leaseDs);
    w.u8(a.transport);
    w.u8(a.chan);
    w.bytes(a.mac, 6);
    w.u16((uint16_t)(a.token >> 16));
    w.u16((uint16_t)a.token);
    return w.size();
}

// corpo depois do op
inline bool decodeAccept(const uint8_t* body, size_t len, Accept* out) {
    Reader r(body, len);
    const uint8_t* mac;
    uint16_t th, tl;
    if (!r.u8(&out->req) || !r.u16(&out->sid) || !r.u16(&out->leaseDs) || !r.u8(&out->transport) ||
        !r.u8(&out->chan) || !r.bytes(&mac, 6) || !r.u16(&th) || !r.u16(&tl)) {
        return false;
    }
    memcpy(out->mac, mac, 6);
    out->token = ((uint32_t)th << 16) | tl;
    return true;
}

inline size_t encodeRefuse(uint8_t req, uint8_t reason, uint8_t* out, size_t cap) {
    Writer w(out, cap);
    w.u8(OP_REFUSE);
    w.u8(req);
    w.u8(reason);
    return w.size();
}

// KEEP / CLOSE: [op][sid]; REVOKE: [op][sid][motivo]
inline size_t encodeSid(uint8_t op, uint16_t sid, uint8_t* out, size_t cap) {
    Writer w(out, cap);
    w.u8(op);
    w.u16(sid);
    return w.size();
}

inline size_t encodeRevoke(uint16_t sid, uint8_t reason, uint8_t* out, size_t cap) {
    Writer w(out, cap);
    w.u8(OP_REVOKE);
    w.u16(sid);
    w.u8(reason);
    return w.size();
}

inline size_t encodeData(uint16_t sid, uint16_t seq, const void* data, size_t len, uint8_t* out,
                         size_t cap) {
    if (len > MAX_DATA) return 0;
    Writer w(out, cap);
    w.u8(OP_DATA);
    w.u16(sid);
    w.u16(seq);
    w.bytes(data, len);
    return w.size();
}

// --------------------------------------------------------------- leases

// Tabela de sessoes do lado SERVIDOR: (cliente, rid) -> sid com prazo
// (rid = indice LOCAL do recurso no registro do servidor; nao viaja).
// Relogio do chamador (millis no firmware, contagem no teste).
template <int N>
class LeaseTable {
public:
    struct Lease {
        bool used = false;
        uint16_t sid = 0;
        uint16_t client = 0;
        uint8_t rid = 0;
        uint32_t expiresMs = 0;
        uint32_t leaseMs = 0;
        // plano de dados (o servidor preenche apos o open)
        uint8_t transport = TRANSPORT_MESH;
        uint8_t mac[6] = {0};   // MAC ESP-NOW do cliente
        uint32_t token = 0;
    };

    // Abre (ou reaproveita a do mesmo cliente+rid: OPEN repetido pela perda
    // do ACCEPT nao pode gastar 2 slots). nullptr = cheia.
    Lease* open(uint16_t client, uint8_t rid, uint32_t nowMs, uint32_t leaseMs) {
        for (int i = 0; i < N; i++) {
            if (m_l[i].used && m_l[i].client == client && m_l[i].rid == rid) {
                m_l[i].expiresMs = nowMs + leaseMs;
                return &m_l[i];
            }
        }
        for (int i = 0; i < N; i++) {
            if (!m_l[i].used) {
                m_l[i] = Lease{};  // plano de dados da sessao anterior nao vaza
                m_l[i].used = true;
                m_l[i].client = client;
                m_l[i].rid = rid;
                m_l[i].leaseMs = leaseMs;
                m_l[i].expiresMs = nowMs + leaseMs;
                if (++m_nextSid == 0) m_nextSid = 1;
                m_l[i].sid = m_nextSid;
                return &m_l[i];
            }
        }
        return nullptr;
    }

    // KEEP do dono da sessao (outro cliente com o mesmo sid nao renova)
    bool keep(uint16_t client, uint16_t sid, uint32_t nowMs) {
        Lease* l = find(sid);
        if (l == nullptr || l->client != client) return false;
        l->expiresMs = nowMs + l->leaseMs;
        return true;
    }

    bool close(uint16_t client, uint16_t sid) {
        Lease* l = find(sid);
        if (l == nullptr || l->client != client) return false;
        l->used = false;
        return true;
    }

    Lease* find(uint16_t sid) {
        for (int i = 0; i < N; i++) {
            if (m_l[i].used && m_l[i].sid == sid) return &m_l[i];
        }
        return nullptr;
    }

    int countRid(uint8_t rid) const {
        int n = 0;
        for (int i = 0; i < N; i++) {
            if (m_l[i].used && m_l[i].rid == rid) n++;
        }
        return n;
    }

    // Vencidas saem; devolve a proxima vencida (uma por chamada) para o
    // chamador logar/avisar. nullptr = nenhuma.
    bool expireOne(uint32_t nowMs, Lease* out) {
        for (int i = 0; i < N; i++) {
            if (m_l[i].used && (int32_t)(nowMs - m_l[i].expiresMs) > 0) {
                *out = m_l[i];
                m_l[i].used = false;
                return true;
            }
        }
        return false;
    }

    Lease* at(int i) { return (i >= 0 && i < N && m_l[i].used) ? &m_l[i] : nullptr; }
    static constexpr int size() { return N; }

    void clear() {
        for (int i = 0; i < N; i++) m_l[i].used = false;
    }

    // sid inicial aleatorio (reboot do servidor nao reaproveita sids que um
    // cliente antigo ainda renovaria)
    void seed(uint16_t s) { m_nextSid = s; }

private:
    Lease m_l[N];
    uint16_t m_nextSid = 0;
};

}  // namespace resproto

#endif  // CELEROS_PACK_RES_PROTO_H
