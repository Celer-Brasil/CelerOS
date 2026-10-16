#ifndef CELEROS_USB_USB_RES_H
#define CELEROS_USB_USB_RES_H

// Tunel ResProto pelo cabo (Onda B, doc de design §8): o computador fala o
// MESMO protocolo de recursos da matilha, transportado por 2 opcodes novos
// do HostLink (valores em HostLink.h, fonte unica extraida pelo celerctl):
//
//   KL_RES_CTL  (host->device, pedido/resposta, roda na task do canal):
//     req  [subop u8][reqId u8][len u16][corpo]
//     resp [status u8][reqId u8][len u16][corpo]     (status 0 = OK; len em
//          big-endian, o mesmo fio do ResProto)
//   KL_RES_DATA (device->host, NAO-solicitado, cai na push_queue do
//   celerctl como os logs):
//     [sid u16][seq u16][bytes]                      (u16 big-endian; DATA
//          de sessao do ResProto: resposta de READ do gpio, amostra de
//          sensor, publish de canal; chunks grandes seguem com seq++)
//
// O PC e um CLIENTE do servidor de recursos do gateway com node id
// sintetico USB_NODE: o gateway renova os leases dele (auto-KEEP) enquanto
// a sessao HostLink viver; caiu o cabo (idle de 8 s na UART, desconexao
// CDC), a sessao morre e os leases vencem — o auto-off do rele e o mesmo
// de sempre. Policy: master res_share_usb (default "0") + as regras por
// tipo de sempre (gpio exige matilha privada etc.).
//
// Header-only puro (compila no host; test/cpp exercita o codec).

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "../Pack/ResProto.h"

namespace usbres {

// node id sintetico do PC nas tabelas do servidor (doc §8.1: faixa
// 0xFF00..0xFFFE; ids reais derivam da MAC BT)
constexpr uint16_t USB_NODE = 0xFFFE;
// link sintetico do lease do PC (o gateway sobrescreve o que vier no OPEN)
constexpr uint8_t USB_LINK_FLAGS = resproto::LINK_UP | resproto::LINK_LOCKED;
constexpr uint8_t USB_MAC[6] = {0x02, 'U', 'S', 'B', 0x00, 0x00};

constexpr uint8_t SUB_DESCRIBE = 1;  // -> JSON de identidade do gateway
constexpr uint8_t SUB_LIST = 2;      // -> LIST_META dos recursos LOCAIS
constexpr uint8_t SUB_MESH = 3;      // -> catalogo da MALHA (cache; ve remotes())
constexpr uint8_t SUB_OPEN = 4;      // corpo = OPEN do ResProto integral
constexpr uint8_t SUB_KEEP = 5;      // [sid u16] (o gateway tambem auto-renova)
constexpr uint8_t SUB_CLOSE = 6;     // [sid u16] (fim pedido; auto-off no dono)
constexpr uint8_t SUB_WRITE = 7;     // [sid u16][seq u16][bytes] — ops do gpio/sensor
// Entrar na matilha pelo cabo (API 40): a porta da senha do Provision — o
// mesmo caminho do "mesh join" e do Pack.join. Ato de dono (cabo na mao),
// nao depende do res_share_usb. A chave nunca volta ao PC.
constexpr uint8_t SUB_JOIN = 8;      // [nlen u8][nome 1..15][plen u8][senha 8..64]
constexpr uint8_t SUB_LEAVE = 9;     // vazio -> volta a rede aberta "celer"
constexpr uint8_t SUB_NET = 10;      // -> JSON {net, prov, node, name, pc}

constexpr size_t JOIN_NAME_MAX = 15;
constexpr size_t JOIN_PASS_MIN = 8;
constexpr size_t JOIN_PASS_MAX = 64;

// ---------------------------------------------------------- envelope CTL

inline size_t encodeReq(uint8_t subop, uint8_t reqId, const void* body, size_t len,
                        uint8_t* out, size_t cap) {
    if (len > 0xFFFF || 4 + len > cap) return 0;
    out[0] = subop;
    out[1] = reqId;
    out[2] = (uint8_t)(len >> 8);  // big-endian, o fio do ResProto
    out[3] = (uint8_t)len;
    if (len > 0) memcpy(out + 4, body, len);
    return 4 + len;
}

inline size_t encodeResp(uint8_t status, uint8_t reqId, const void* body, size_t len,
                         uint8_t* out, size_t cap) {
    if (len > 0xFFFF || 4 + len > cap) return 0;
    out[0] = status;
    out[1] = reqId;
    out[2] = (uint8_t)(len >> 8);  // big-endian, o fio do ResProto
    out[3] = (uint8_t)len;
    if (len > 0) memcpy(out + 4, body, len);
    return 4 + len;
}

struct Req {
    uint8_t subop = 0;
    uint8_t reqId = 0;
    const uint8_t* body = nullptr;
    uint16_t len = 0;
};

inline bool decodeReq(const uint8_t* p, size_t n, Req* out) {
    if (p == nullptr || n < 4) return false;
    out->subop = p[0];
    out->reqId = p[1];
    out->len = (uint16_t)((p[2] << 8) | p[3]);
    if (4 + (size_t)out->len > n) return false;
    out->body = p + 4;
    return true;
}

// ------------------------------------------------------- SUB_JOIN (matilha)

inline size_t encodeJoin(const char* name, const char* pass, uint8_t* out, size_t cap) {
    const size_t nl = strnlen(name, JOIN_NAME_MAX + 1);
    const size_t pl = strnlen(pass, JOIN_PASS_MAX + 1);
    if (nl == 0 || nl > JOIN_NAME_MAX || pl < JOIN_PASS_MIN || pl > JOIN_PASS_MAX) return 0;
    if (2 + nl + pl > cap) return 0;
    out[0] = (uint8_t)nl;
    memcpy(out + 1, name, nl);
    out[1 + nl] = (uint8_t)pl;
    memcpy(out + 2 + nl, pass, pl);
    return 2 + nl + pl;
}

// Strings saem com NUL (o corpo nao tem); false = fora das regras do join
inline bool decodeJoin(const uint8_t* p, size_t n, char name[JOIN_NAME_MAX + 1],
                       char pass[JOIN_PASS_MAX + 1]) {
    if (p == nullptr || n < 1) return false;
    const size_t nl = p[0];
    if (nl == 0 || nl > JOIN_NAME_MAX || n < 2 + nl) return false;
    const size_t pl = p[1 + nl];
    if (pl < JOIN_PASS_MIN || pl > JOIN_PASS_MAX || n != 2 + nl + pl) return false;
    memcpy(name, p + 1, nl);
    name[nl] = '\0';
    memcpy(pass, p + 2 + nl, pl);
    pass[pl] = '\0';
    // NUL no meio cortaria a string: o nome/senha seriam outros
    return strlen(name) == nl && strlen(pass) == pl;
}

// corpo do SUB_WRITE (e o formato do KL_RES_DATA): [sid u16][seq u16][bytes]
struct DataHdr {
    uint16_t sid = 0;
    uint16_t seq = 0;
    const uint8_t* data = nullptr;
    uint16_t len = 0;  // bytes depois do cabecalho
};

inline size_t encodeDataFrame(uint16_t sid, uint16_t seq, const void* data, size_t len,
                         uint8_t* out, size_t cap) {
    if (len > 0xFFFF || 4 + len > cap) return 0;
    out[0] = (uint8_t)(sid >> 8);
    out[1] = (uint8_t)sid;
    out[2] = (uint8_t)(seq >> 8);
    out[3] = (uint8_t)seq;
    if (len > 0) memcpy(out + 4, data, len);
    return 4 + len;
}

inline bool decodeDataFrame(const uint8_t* p, size_t n, DataHdr* out) {
    if (p == nullptr || n < 4) return false;
    out->sid = (uint16_t)((p[0] << 8) | p[1]);
    out->seq = (uint16_t)((p[2] << 8) | p[3]);
    out->len = (uint16_t)(n - 4);
    out->data = p + 4;
    return true;
}

// ----------------------------------------------- catalogo da malha (SUB_MESH)

// O LIST_META do ResProto nao tem cabeca de no: o PC precisa saber DE QUEM
// e cada recurso. Formato da resposta do SUB_MESH:
//   [n u8] n x [node u16][nn u8][nodeName][type][flags][nlen u8][nome]
//              [mlen u8][tlvs]
struct MeshEntry {
    uint16_t node = 0;
    char nodeName[resproto::RES_NAME_MAX + 1] = {0};
    resproto::Entry e;
    resproto::Meta m;
};

inline size_t encodeMeshList(const MeshEntry* e, int n, uint8_t* out, size_t cap) {
    if (n < 0 || n > 255) return 0;
    resproto::Writer w(out, cap);
    w.u8((uint8_t)n);
    for (int i = 0; i < n; i++) {
        const size_t nl = strnlen(e[i].e.name, resproto::RES_NAME_MAX);
        const size_t nn = strnlen(e[i].nodeName, resproto::RES_NAME_MAX);
        const size_t ml = resproto::metaTlvsLen(&e[i].m);
        w.u16(e[i].node);
        w.u8((uint8_t)nn);
        w.bytes(e[i].nodeName, nn);
        w.u8(e[i].e.type);
        w.u8(e[i].e.flags);
        w.u8((uint8_t)nl);
        w.bytes(e[i].e.name, nl);
        w.u8((uint8_t)ml);
        if (!resproto::writeMetaTlvs(w, &e[i].m)) return 0;
    }
    return w.size();
}

inline int decodeMeshList(const uint8_t* body, size_t len, MeshEntry* out, int max) {
    resproto::Reader r(body, len);
    uint8_t n;
    if (!r.u8(&n)) return -1;
    int got = 0;
    for (int i = 0; i < n; i++) {
        MeshEntry m;
        uint8_t nn, nl, ml;
        const uint8_t* p;
        if (!r.u16(&m.node) || !r.u8(&nn) || nn > resproto::RES_NAME_MAX ||
            !r.bytes(&p, nn)) {
            return -1;
        }
        memcpy(m.nodeName, p, nn);
        m.nodeName[nn] = '\0';
        if (!r.u8(&m.e.type) || !r.u8(&m.e.flags) || !r.u8(&nl) ||
            nl > resproto::RES_NAME_MAX || !r.bytes(&p, nl)) {
            return -1;
        }
        memcpy(m.e.name, p, nl);
        m.e.name[nl] = '\0';
        if (!r.u8(&ml)) return -1;
        size_t left = ml;
        while (left > 0) {
            uint8_t tag, tl;
            if (!r.u8(&tag) || !r.u8(&tl) || (size_t)tl + 2 > left) return -1;
            switch (tag) {
                case resproto::TAG_UNIT: {
                    if (!r.bytes(&p, tl)) return -1;
                    const size_t c = tl < sizeof(m.m.unit) - 1 ? tl : sizeof(m.m.unit) - 1;
                    memcpy(m.m.unit, p, c);
                    m.m.unit[c] = '\0';
                    break;
                }
                case resproto::TAG_RANGE:
                    if (tl != 8 || !resproto::getF32(r, &m.m.rangeMin) ||
                        !resproto::getF32(r, &m.m.rangeMax)) {
                        return -1;
                    }
                    m.m.hasRange = true;
                    break;
                case resproto::TAG_SCHEMA: {
                    if (!r.bytes(&p, tl)) return -1;
                    const size_t c = tl < sizeof(m.m.schema) - 1 ? tl : sizeof(m.m.schema) - 1;
                    memcpy(m.m.schema, p, c);
                    m.m.schema[c] = '\0';
                    break;
                }
                case resproto::TAG_VER:
                    if (tl != 1 || !r.u8(&m.m.ver)) return -1;
                    break;
                default:
                    if (!r.skip(tl)) return -1;
            }
            left -= 2 + tl;
        }
        if (got < max) out[got++] = m;
    }
    return got;
}

}  // namespace usbres

#endif  // CELEROS_USB_USB_RES_H
