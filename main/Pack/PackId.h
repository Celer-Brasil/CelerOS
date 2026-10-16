#ifndef CELEROS_PACK_PACK_ID_H
#define CELEROS_PACK_PACK_ID_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

// Identidade unica do no na matilha — a MESMA para os tres pilares:
//   CelerLink (confianca: pareamento/bond, nome no advertising),
//   CelerNet + Recursos (malha: id no quadro, nome no BEAT/HELLO),
//   HostLink (gateway: o PC vira no virtual com id derivado do gateway).
//
// id do no = 2 ultimos bytes da MAC BT (zero config). Nome persistente no
// setting "celernet_name" (<= NAME_LEN), default "Celer-XXXX".
//
// A parte pura (packid::) compila no host e o test/cpp exercita.

namespace packid {

constexpr size_t NAME_LEN = 14;  // cabe no BEAT ([caps][flags][nome<=14])

// Faixa reservada aos nos virtuais (PC pelo cabo): ids reais derivam da MAC
// BT e cair aqui e improvavel; 0xFFFF e o broadcast da malha.
constexpr uint16_t VIRTUAL_BASE = 0xFF00;

inline uint16_t nodeFromMac(const uint8_t mac[6]) {
    return (uint16_t)((mac[4] << 8) | mac[5]);
}

// Id do no a partir do id de peer do CelerLink ("AA:BB:CC:DD:EE:FF", MAC
// publica do BLE em ordem MSB): e o elo bond <-> no da malha. 0 = invalido.
inline uint16_t nodeFromLinkId(const char* id) {
    if (id == nullptr) return 0;
    for (int i = 0; i < 17; i++) {
        if (id[i] == '\0') return 0;
    }
    if (id[17] != '\0' || id[14] != ':') return 0;
    uint16_t v = 0;
    const int pos[4] = {12, 13, 15, 16};
    for (int k = 0; k < 4; k++) {
        const char c = id[pos[k]];
        int d;
        if (c >= '0' && c <= '9') d = c - '0';
        else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
        else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
        else return 0;
        v = (uint16_t)((v << 4) | d);
    }
    return v;
}

// Id do PC ligado no gateway `node`: 0xFF00 | byte baixo do gateway
// (0xFFFF e o broadcast -> 0xFFFE). Dois gateways na mesma matilha so
// colidem se os bytes baixos coincidirem.
inline uint16_t pcNodeOf(uint16_t node) {
    uint16_t id = (uint16_t)(VIRTUAL_BASE | (node & 0xFF));
    return id == 0xFFFF ? (uint16_t)0xFFFE : id;
}

inline bool isVirtual(uint16_t node) {
    return node >= VIRTUAL_BASE && node != 0xFFFF;
}

inline void defaultName(uint16_t node, char* out, size_t cap) {
    snprintf(out, cap, "Celer-%04X", node);
}

// Nome do PC no gateway: "pc-XXXX" (XXXX = id do gateway)
inline void pcName(uint16_t gatewayNode, char* out, size_t cap) {
    snprintf(out, cap, "pc-%04X", gatewayNode);
}

}  // namespace packid

namespace PackId {

// Le MAC/nome do NVS (de novo a cada chamada: o "cfg celernet_name" do
// shell grava direto no NVS). So de pilha interna (tick de servico, init): tasks com
// pilha na PSRAM (res_rx, mic) nao podem tocar a flash. Idempotente.
void init();

uint16_t nodeId();                 // 2 ultimos bytes da MAC BT
void btMac(uint8_t out[6]);
void staMac(uint8_t out[6]);       // ESP-NOW (DataLink) enderaca por esta
uint16_t pcNode();                 // id do PC ligado neste gateway

// Nome em cache na RAM (seguro de qualquer task); antes do init devolve o
// default "Celer-XXXX".
void name(char* out, size_t cap);
// Grava no NVS e no cache (pilha interna). nullptr/"" volta ao default.
bool setName(const char* name);

}  // namespace PackId

#endif  // CELEROS_PACK_PACK_ID_H
