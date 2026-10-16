#ifndef CELEROS_PACK_PROV_PROTO_H
#define CELEROS_PACK_PROV_PROTO_H

// Convite da matilha pelo CelerLink (API 40) — o pilar de CONFIANCA
// entregando a chave ao pilar da MALHA.
//
// Quem ja esta na matilha (convidador, central) pareia por codigo com o
// aparelho novo (convidado, peripheral com a janela de convite aberta) e
// manda o INVITE pelo canal SELADO do bond (AES-GCM, CelerLink::
// sendSealed): nome + netKey + adminKey. O convidado entra com
// NetKeys::joinWithKeys (a senha nunca viaja nem precisa ser conhecida) e
// devolve o ACK selado.
//
//   INVITE  'C''N''J' ver | op=0x01 | nlen u8 | nome (1..15) | netKey 16 | adminKey 16
//   ACK     'C''N''J' ver | op=0x80 | status u8 (0 = entrou)
//
// Header-only puro (compila no host; test/cpp exercita o codec).

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace provproto {

constexpr uint8_t MAGIC[3] = {'C', 'N', 'J'};
constexpr uint8_t VERSION = 1;
constexpr uint8_t OP_INVITE = 0x01;
constexpr uint8_t OP_ACK = 0x80;
constexpr size_t KEY_LEN = 16;
constexpr size_t NAME_MAX_LEN = 15;
constexpr size_t HDR = 5;  // magic(3) + ver + op
constexpr size_t INVITE_MAX = HDR + 1 + NAME_MAX_LEN + 2 * KEY_LEN;  // 53 B
constexpr size_t ACK_LEN = HDR + 1;

constexpr uint8_t ACK_OK = 0;
constexpr uint8_t ACK_FAIL = 1;     // PSA/NVS
constexpr uint8_t ACK_CLOSED = 2;   // janela de convite fechada

struct Invite {
    char name[NAME_MAX_LEN + 1];
    uint8_t netKey[KEY_LEN];
    uint8_t adminKey[KEY_LEN];
};

// Quadro do convite? (so olha o cabecalho: o tap do CelerLink desvia por aqui)
inline bool isProv(const uint8_t* p, size_t len) {
    return p != nullptr && len >= HDR && memcmp(p, MAGIC, 3) == 0 && p[3] == VERSION;
}

inline size_t encodeInvite(const Invite& iv, uint8_t* out, size_t cap) {
    const size_t nlen = strnlen(iv.name, NAME_MAX_LEN + 1);
    if (nlen == 0 || nlen > NAME_MAX_LEN) return 0;
    const size_t n = HDR + 1 + nlen + 2 * KEY_LEN;
    if (out == nullptr || cap < n) return 0;
    memcpy(out, MAGIC, 3);
    out[3] = VERSION;
    out[4] = OP_INVITE;
    out[5] = (uint8_t)nlen;
    memcpy(out + 6, iv.name, nlen);
    memcpy(out + 6 + nlen, iv.netKey, KEY_LEN);
    memcpy(out + 6 + nlen + KEY_LEN, iv.adminKey, KEY_LEN);
    return n;
}

inline bool decodeInvite(const uint8_t* p, size_t len, Invite* out) {
    if (!isProv(p, len) || len < HDR + 1 || p[4] != OP_INVITE) return false;
    const size_t nlen = p[5];
    if (nlen == 0 || nlen > NAME_MAX_LEN || len != HDR + 1 + nlen + 2 * KEY_LEN) return false;
    memcpy(out->name, p + 6, nlen);
    out->name[nlen] = '\0';
    if (strlen(out->name) != nlen) return false;  // NUL no meio do nome
    memcpy(out->netKey, p + 6 + nlen, KEY_LEN);
    memcpy(out->adminKey, p + 6 + nlen + KEY_LEN, KEY_LEN);
    return true;
}

inline size_t encodeAck(uint8_t status, uint8_t* out, size_t cap) {
    if (out == nullptr || cap < ACK_LEN) return 0;
    memcpy(out, MAGIC, 3);
    out[3] = VERSION;
    out[4] = OP_ACK;
    out[5] = status;
    return ACK_LEN;
}

inline bool decodeAck(const uint8_t* p, size_t len, uint8_t* status) {
    if (!isProv(p, len) || len != ACK_LEN || p[4] != OP_ACK) return false;
    *status = p[5];
    return true;
}

}  // namespace provproto

#endif  // CELEROS_PACK_PROV_PROTO_H
