#ifndef CELEROS_BT_NET_KEYS_H
#define CELEROS_BT_NET_KEYS_H

#include <stddef.h>
#include <stdint.h>

#include "NetFrame.h"

// CelerNet v3 (API 37): chaves das redes e a cifra (PSA) — a malha BLE
// (NetFrame) e o plano ESP-NOW (DataLink) cifram com elas.
//
// Rede = nome + senha:
//   netKey   = PBKDF2-HMAC-SHA256(senha, "celernet:" + nome, 4096) -> 16 B
//              (deterministico: um 2o aparelho com tela entra como admin
//              digitando nome e senha — nada para sincronizar)
//   encKey   = HKDF(netKey, "enc")   AES-CCM, MIC de 4 bytes
//   privKey  = HKDF(netKey, "priv")  AES-ECB da ofuscacao do cabecalho
//   adminKey = HKDF(netKey, "admin") MIC dos comandos de configuracao
//   nid      = HKDF(netKey, "nid")   8 bits (escolhe a chave no RX)
// A rede ABERTA "celer" (aparelhos ainda nao configurados) tem chave
// publica fixa: integridade sem sigilo, e o trafego aberto nao se mistura
// com o das matilhas.
//
// Ate 2 redes ativas: a primaria (matilha provisionada, ou a aberta) e a
// aberta como secundaria (no nao configurado e o provisionador na caca).
// As chaves PSA sao importadas UMA vez por rede (ids volateis).
namespace NetKeys {

static constexpr int NETS_MAX = 2;
static constexpr size_t KEY_LEN = 16;
static constexpr const char* OPEN_NAME = "celer";

struct Net {
    bool used;
    bool open;                 // rede aberta (chave publica)
    char name[16];
    uint8_t nid;
    uint32_t iv;               // IV index (fixo em 0 nesta versao)
    uint8_t netKey[KEY_LEN];
    uint8_t adminKey[KEY_LEN];
    uint32_t encId, privId;    // psa_key_id_t
};

// Sobe as redes do NVS (matilha provisionada) ou so a aberta. Idempotente.
bool init();

// Deriva (PBKDF2 ~0,3 s) e grava a matilha como primaria. senha vazia ou
// nome "celer" = volta para a aberta.
bool join(const char* name, const char* password);
// Mesma coisa a partir de chaves prontas (provisionamento: o nó nao sabe a senha)
bool joinWithKeys(const char* name, const uint8_t netKey[KEY_LEN], const uint8_t adminKey[KEY_LEN]);
// Esquece a matilha (volta a "celer" aberta).
void leave();
// Liga/desliga a aberta como secundaria (caca do provisionador).
void setOpenSecondary(bool on);

bool provisioned();                 // primaria e uma matilha privada
const Net* primary();
const Net* net(int i);              // 0..NETS_MAX-1 (nullptr = slot vazio)
// Cifras ativas (primaria primeiro) para o NetFrame::decode.
int ciphers(netframe::Cipher* out, int max);
netframe::Cipher cipherOf(const Net* n);

// AEAD bruto com a encKey da rede (o DataLink usa no ESP-NOW): out =
// cifrado(len) || MIC(4) / open: in = cifrado(len) || MIC(4).
bool seal(const Net* n, const uint8_t nonce[13], const uint8_t* aad, size_t aadLen,
          const uint8_t* in, size_t len, uint8_t* out);
bool open(const Net* n, const uint8_t nonce[13], const uint8_t* aad, size_t aadLen,
          const uint8_t* in, size_t len, uint8_t* out);
// Rede pelo nid (nullptr = nenhuma ativa)
const Net* byNid(uint8_t nid);

// Seqs dos quadros proprios: 24 bits na malha BLE, 32 bits no ESP-NOW
// (audio a 25 quadros/s viraria 24 bits em 7 dias). Reservados em blocos no
// NVS: um reboot nunca repete seq — o nonce do CCM nao pode repetir. Os
// next* NAO gravam (sao chamados de tasks com pilha na PSRAM, que nao podem
// tocar a flash): persistTick() grava a reserva seguinte, do tick do servico.
uint32_t nextSeqMesh();
// n seqs CONSECUTIVOS (fragmentos e copias de uma mensagem): devolve o 1o
uint32_t reserveSeqMesh(uint32_t n);
// 0 = seq 32-bit esgotado (nunca e alocado legitimo): o chamador recusa o
// envio em vez de reusar o nonce do CCM (mesmo contrato do reserveSeqMesh)
uint32_t nextSeqNow();
void persistTick();

// Vetores dos RFCs (CCM 3610, HKDF 5869, PBKDF2-SHA256): shell "mesh selftest"
typedef void (*PrintFn)(void* ctx, const char* fmt, ...);
bool selftest(PrintFn print, void* ctx);

}  // namespace NetKeys

#endif  // CELEROS_BT_NET_KEYS_H
