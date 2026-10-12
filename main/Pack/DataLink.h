#ifndef CELEROS_PACK_DATA_LINK_H
#define CELEROS_PACK_DATA_LINK_H

#include <stddef.h>
#include <stdint.h>

// Plano de dados dos recursos da matilha (API 36, R2): ESP-NOW v2 direto no
// radio WiFi, quadros de ate 1470 B entre dois nos SEM roteador. A malha BLE
// (31 B por quadro, ~8 quadros/s) segue fazendo descoberta e controle; o
// que pesa (audio, imagem, dados em taxa alta) passa por aqui.
//
// Convive com o WiFi normal: o ESP-NOW usa o canal em que o radio ja esta.
// No conectado ao roteador fica preso ao canal do AP (internet segue no ar);
// no sem STA muda para o canal do par. A sessao (Resources) negocia o canal
// e segura o radio nele (NetworkManager::holdChannel: sem scans de fundo).
//
// Quadro v2 (CelerNet v3, API 37), dentro do payload ESP-NOW:
//   em claro:  'C''D' | ver=2 | nid | seq32
//   cifrado:   tipo | sid u16 | token u32 | seq u16 | dados   + MIC(4)
// AES-CCM com a encKey da rede (NetKeys); nonce = 0x01 | MAC de origem |
// seq32 | 0 0 (a MAC entra no nonce: trocar a origem quebra o MIC); AAD =
// os 8 bytes em claro. RPL por (rede, MAC): quadro repetido ou reinjetado
// cai. sid/token vem do ACCEPT da sessao: quem nao tem a sessao nao casa.
// Cifra e decifra fora do callback do WiFi (send na task de quem envia,
// pollWait na task res_rx).
//
// Concorrencia: o callback de RX roda na task do WiFi e so copia para um
// ringbuffer (PSRAM); poll() drena da task do servico.
namespace DataLink {

static constexpr size_t FRAME_MAX = 1470;     // ESP_NOW_MAX_DATA_LEN_V2
static constexpr size_t CLEAR_HDR = 8;      // 'C''D' ver nid seq32
static constexpr size_t INNER_HDR = 9;      // tipo sid token seq (cifrados)
static constexpr size_t MIC = 4;
static constexpr size_t HDR = CLEAR_HDR + INNER_HDR + MIC;
static constexpr size_t PAYLOAD_MAX = FRAME_MAX - HDR;  // 1449

enum Kind : uint8_t {
    KIND_DATA = 1,     // mensagem de canal de dados (publish/write)
    KIND_STREAM = 2,   // bloco de stream (audio) — R3
    KIND_BULK = 3,     // bloco de transferencia confiavel (foto) — R3
    KIND_BULK_ACK = 4, // bitmask de blocos recebidos — R3
    KIND_CTRL = 5,     // op de controle dos recursos (ResProto) em banda
};

struct Self {
    bool up;          // ESP-NOW iniciado
    bool sta;         // conectado a um AP (canal preso)
    uint8_t chan;     // canal primario atual
    uint8_t mac[6];   // MAC da interface STA (endereco ESP-NOW)
};

struct Rx {
    uint8_t mac[6];
    uint8_t kind;
    uint16_t sid;
    uint32_t token;
    uint16_t seq;
    int8_t rssi;
    uint8_t net;      // indice NetKeys da rede que autenticou (0 = primaria)
    uint16_t len;
    uint8_t data[PAYLOAD_MAX];
};

struct Stats {
    uint32_t tx, txFail, txNoMem, rx, rxDropped, rxForeign;
    uint32_t rxAuthFail;  // nao autenticou (outra rede/forjado)
    uint32_t rxReplay;    // seq32 ja visto (replay)
};

// Sobe o ESP-NOW (e, com allowWifiInit, o driver WiFi em STA sem conectar).
// Idempotente; false = sem RAM / driver parado ou ainda nao iniciado (o
// esp_now_init exige o WiFi iniciado). Chamar fora de callbacks.
bool ensure(bool allowWifiInit = true);
bool up();
void self(Self* out);
// Troca o canal (so sem STA conectado). true = ja estava ou trocou.
bool setChannel(uint8_t ch);
// Sessao ESP-NOW viva: segura o canal (sem scans de fundo). Contador.
void hold(bool on);

// Cifra na rede primaria e envia.
bool send(const uint8_t mac[6], uint8_t kind, uint16_t sid, uint32_t token, uint16_t seq,
          const void* data, size_t len);
// Rede mudou (mesh join/leave): zera o RPL.
void netChanged();
bool poll(Rx* out);
// Espera ate ms por um quadro (task res_rx dos recursos)
bool pollWait(Rx* out, uint32_t ms);
void stats(Stats* out);

}  // namespace DataLink

#endif  // CELEROS_PACK_DATA_LINK_H
