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
// sintetico (packid::pcNodeOf do gateway, faixa 0xFF00..0xFFFE — API 41;
// era 0xFFFE fixo): o gateway renova os leases dele (auto-KEEP) enquanto
// a sessao HostLink viver; caiu o cabo (idle de 8 s na UART, desconexao
// CDC), a sessao morre e os leases vencem — o auto-off do rele e o mesmo
// de sempre. Policy: master res_share_usb (default "0") + as regras por
// tipo de sempre (gpio exige matilha privada etc.).
//
// No virtual (API 41): com a sessao viva e res_share_usb=1 o PC e MEMBRO da
// matilha — o gateway anuncia um BEAT proxy com o id dele (pc-XXXX, flag
// BFLAG_PROXY), entrega ao PC os envelopes enderecados a ele e manda os
// do PC (SUB_SEND); o PC abre recursos de OUTROS nos com o gateway como
// cliente por procuracao (SUB_OPEN_AT). Tudo que chega sem pedido sai como
// EVENTO no KL_RES_DATA com sid 0 (nunca e uma sessao — 0 e o "livre"):
//   [0x0000][seq u16][ev u8][corpo]
//     EV_MSG   [from u16][nn u8][fromName][raw u8][payload]   (raw=1: sem
//              envelope Pack — CelerNet.send cru de um app)
//     EV_STATE [h u8][state u8][reason u8][node u16]           (Resources::State)
//     EV_DATA  [h u8][bytes]                                    (DATA do dono)
//
// Header-only puro (compila no host; test/cpp exercita o codec).

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "../Pack/ResProto.h"

namespace usbres {

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
constexpr uint8_t SUB_NET = 10;      // -> JSON {net, prov, node, name, pc, invite, code}
// No virtual (API 41): exigem a sessao do cabo e o res_share_usb
constexpr uint8_t SUB_SEND = 11;     // [to u16][payload 1..430] envelope custom DO PC
constexpr uint8_t SUB_OPEN_AT = 12;  // [node u16][nlen][nome][plen][params] -> [h u8]
constexpr uint8_t SUB_HWRITE = 13;   // [h u8][bytes] DATA no recurso remoto
constexpr uint8_t SUB_HCLOSE = 14;   // [h u8]
// Convite sem tela pelo cabo (API 41): os 2 passos da UI (o codigo so nasce
// na conexao). Ato de dono, como o SUB_JOIN: nao depende do res_share_usb.
constexpr uint8_t SUB_ACCEPT = 15;       // [on u8] janela de convite (novo); codigo sai no SUB_NET
constexpr uint8_t SUB_INVITE = 16;       // [tlen][alvo] membro conecta no novo -> [done u8] (1 = bond, ja entrou)
constexpr uint8_t SUB_INVITE_CODE = 17;  // [codigo 6 ASCII] digita, manda a chave, espera o ACK
// Midia de OUTRO no pelo cabo (API 41), no padrao do celerctl: por ARQUIVO
// no gateway, que o PC baixa/envia pelo READ/WRITE de sempre. O gateway e o
// cliente por procuracao (handle do SUB_OPEN_AT); o fim chega em EV_STATE
// (done = arquivo pronto / tocou ate o fim). Exigem res_share_usb.
constexpr uint8_t SUB_SNAP_AT = 18;  // [node u16][q u8 5..63] foto -> PC_SNAP_PATH
constexpr uint8_t SUB_REC_AT = 19;   // [node u16][s u8 1..10] mic -> WAV em PC_REC_PATH
constexpr uint8_t SUB_PLAY_AT = 20;  // [node u16] PCM16 16 kHz mono de PC_PLAY_PATH no speaker dele

constexpr const char* PC_SNAP_PATH = "/local/.pc_snap.jpg";
constexpr const char* PC_REC_PATH = "/local/.pc_rec.wav";
constexpr const char* PC_PLAY_PATH = "/local/.pc_play.pcm";
constexpr size_t PC_PLAY_MAX = 30u * 16000u * 2u;  // 30 s de PCM16 16 kHz

inline size_t encodeMediaAt(uint16_t node, int arg, uint8_t* out, size_t cap) {
    const size_t n = arg >= 0 ? 3 : 2;
    if (cap < n) return 0;
    out[0] = (uint8_t)(node >> 8);
    out[1] = (uint8_t)node;
    if (arg >= 0) out[2] = (uint8_t)arg;
    return n;
}

// arg = -1 quando o subop nao leva argumento (SUB_PLAY_AT)
inline bool decodeMediaAt(const uint8_t* p, size_t n, bool withArg, uint16_t* node, uint8_t* arg) {
    if (p == nullptr || n != (withArg ? 3u : 2u)) return false;
    *node = (uint16_t)((p[0] << 8) | p[1]);
    if (withArg) *arg = p[2];
    return *node != 0 && *node != 0xFFFF;
}

constexpr uint16_t EVENT_SID = 0;    // sid dos eventos no KL_RES_DATA
constexpr uint8_t EV_MSG = 1;
constexpr uint8_t EV_STATE = 2;
constexpr uint8_t EV_DATA = 3;

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

// ------------------------------------------------- no virtual (API 41)

inline size_t encodeEvMsg(uint16_t from, const char* fromName, bool raw, const void* payload,
                          size_t len, uint8_t* out, size_t cap) {
    const size_t nn = fromName != nullptr ? strnlen(fromName, resproto::RES_NAME_MAX) : 0;
    const size_t n = 1 + 2 + 1 + nn + 1 + len;
    if (n > cap) return 0;
    out[0] = EV_MSG;
    out[1] = (uint8_t)(from >> 8);
    out[2] = (uint8_t)from;
    out[3] = (uint8_t)nn;
    if (nn > 0) memcpy(out + 4, fromName, nn);
    out[4 + nn] = raw ? 1 : 0;
    if (len > 0) memcpy(out + 5 + nn, payload, len);
    return n;
}

inline size_t encodeEvState(uint8_t h, uint8_t state, uint8_t reason, uint16_t node, uint8_t* out,
                            size_t cap) {
    if (cap < 6) return 0;
    out[0] = EV_STATE;
    out[1] = h;
    out[2] = state;
    out[3] = reason;
    out[4] = (uint8_t)(node >> 8);
    out[5] = (uint8_t)node;
    return 6;
}

inline size_t encodeEvData(uint8_t h, const void* d, size_t len, uint8_t* out, size_t cap) {
    if (2 + len > cap) return 0;
    out[0] = EV_DATA;
    out[1] = h;
    if (len > 0) memcpy(out + 2, d, len);
    return 2 + len;
}

// SUB_OPEN_AT: [node u16][nlen][nome 1..15][plen][params <= 48]
struct OpenAt {
    uint16_t node = 0;
    char name[resproto::RES_NAME_MAX + 1] = {0};
    const uint8_t* params = nullptr;
    uint8_t plen = 0;
};

inline size_t encodeOpenAt(uint16_t node, const char* name, const void* params, size_t plen,
                           uint8_t* out, size_t cap) {
    const size_t nl = strnlen(name, resproto::RES_NAME_MAX + 1);
    if (nl == 0 || nl > resproto::RES_NAME_MAX || plen > resproto::PARAMS_MAX) return 0;
    if (4 + nl + plen > cap) return 0;
    out[0] = (uint8_t)(node >> 8);
    out[1] = (uint8_t)node;
    out[2] = (uint8_t)nl;
    memcpy(out + 3, name, nl);
    out[3 + nl] = (uint8_t)plen;
    if (plen > 0) memcpy(out + 4 + nl, params, plen);
    return 4 + nl + plen;
}

inline bool decodeOpenAt(const uint8_t* p, size_t n, OpenAt* out) {
    if (p == nullptr || n < 4) return false;
    out->node = (uint16_t)((p[0] << 8) | p[1]);
    const size_t nl = p[2];
    if (nl == 0 || nl > resproto::RES_NAME_MAX || n < 4 + nl) return false;
    memcpy(out->name, p + 3, nl);
    out->name[nl] = '\0';
    if (strlen(out->name) != nl) return false;
    out->plen = p[3 + nl];
    if (out->plen > resproto::PARAMS_MAX || n != 4 + nl + out->plen) return false;
    out->params = p + 4 + nl;
    return out->node != 0 && out->node != 0xFFFF;
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
