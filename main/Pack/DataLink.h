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
// Quadro (dentro do payload ESP-NOW):
//   'C''D' | ver(1) | tipo(1) | sid u16 | token u32 | seq u16 | dados
// sid/token vem do ACCEPT da sessao: quem nao tem a sessao nao casa quadro.
// v1 sem criptografia: o sigilo chega com a chave da rede (CelerNet v3).
//
// Concorrencia: o callback de RX roda na task do WiFi e so copia para um
// ringbuffer (PSRAM); poll() drena da task do servico.
namespace DataLink {

static constexpr size_t FRAME_MAX = 1470;     // ESP_NOW_MAX_DATA_LEN_V2
static constexpr size_t HDR = 12;
static constexpr size_t PAYLOAD_MAX = FRAME_MAX - HDR;  // 1458

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
    uint16_t len;
    uint8_t data[PAYLOAD_MAX];
};

struct Stats {
    uint32_t tx, txFail, txNoMem, rx, rxDropped, rxForeign;
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

bool send(const uint8_t mac[6], uint8_t kind, uint16_t sid, uint32_t token, uint16_t seq,
          const void* data, size_t len);
bool poll(Rx* out);
// Espera ate ms por um quadro (task res_rx dos recursos)
bool pollWait(Rx* out, uint32_t ms);
void stats(Stats* out);

}  // namespace DataLink

#endif  // CELEROS_PACK_DATA_LINK_H
