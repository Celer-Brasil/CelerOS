#ifndef CELEROS_BT_PHONE_LINK_H
#define CELEROS_BT_PHONE_LINK_H

// Phone Link (API 15, CONFIG_CELEROS_PHONE_LINK): o relogio fala com o
// Gadgetbridge (Android) se passando por um Bangle.js — servico Nordic UART
// (NUS) no MESMO host NimBLE do Celer Link, linhas de texto nos dois
// sentidos (protocolo em Utils/GbProto.h).
//
//   celular -> relogio: notificacoes (e remocao), hora + fuso, musica,
//                       clima, "encontrar relogio", chamada recebida;
//   relogio -> celular: bateria, passos, controle de musica, "encontrar
//                       celular".
//
// Seguranca: as caracteristicas exigem enlace criptografado com MITM — o
// celular pareia digitando o codigo de 6 digitos que aparece no relogio
// (bond guardado pelo NimBLE no NVS). Sem bond nada passa.
//
// Radio: CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1. Um app que chama
// CelerLink.start/connect tem prioridade (o celular reconecta depois); sem
// app usando o Celer Link, o advertising do relogio e o do Phone Link.
//
// Concorrencia: os callbacks BLE (task do host NimBLE) so enfileiram linhas;
// tick() — loop da UI e present() dos apps — aplica tudo (notificacoes,
// hora, arquivos, bipes).

#include <stdint.h>
#include <string>

struct ble_gatt_svc_def;
struct ble_gap_event;

namespace PhoneLink {

// ---- lado UI ----
void init();   // boot: le "phone_on" (padrao 1) e sobe o BLE se ligado
// barato; aplica as linhas recebidas. inApp (present): chamada tocando ou
// codigo de pareamento pedem a saida do app para a tela nativa aparecer
void tick(bool inApp = false);

bool enabled();
void setEnabled(bool on);  // persiste "phone_on"
bool connected();          // enlace com o celular e criptografado
uint32_t passkey();        // codigo de pareamento na tela (0 = nenhum)

// Envia uma linha JSON ao Gadgetbridge (sem o \n). false sem conexao.
bool send(const std::string& json);
bool sendMusic(const char* cmd);  // play|pause|playpause|next|previous|volumeup|volumedown
bool findPhone(bool on);

// Linha "recebida do celular" injetada localmente (shell "gb", para testar o
// protocolo sem o Android): entra na mesma fila do RX do NUS e sai no tick.
void injectLine(const std::string& line);

// Chamada recebida em curso (CallScreen); false sem chamada.
bool callInfo(std::string& name, std::string& number);
// 0 = recusar, 1 = atender, 2 = ignorar (so silencia no celular)
void callAnswer(int action);

// Apaga os bonds do NimBLE e derruba o celular (pareamento novo). Derruba o
// enlace mesmo que ele nunca tenha criptografado (ENC_CHANGE falho) e
// garante o advertising conectavel de volta. Com o NimBLE ainda fora do ar,
// a limpeza fica pendente e e aplicada antes do proximo anuncio.
void forget();

struct Music {
    std::string artist, track, album, state;  // state: play|pause|stop|""
};
bool music(Music& out);

struct Weather {
    float tempC = 0;
    int hum = -1;
    std::string txt, loc;
    int64_t at = 0;   // epoch da leitura
};
bool weather(Weather& out);

// ---- lado BLE (chamado pelo CelerLink, task do host) ----
const ble_gatt_svc_def* gattServices();
const char* advName();
const void* advUuid128();   // ble_uuid128_t* do servico NUS
// Pode anunciar agora (ligado, sem conexao e fora do backoff de quedas
// rapidas — o Gadgetbridge em laco de reconexao).
bool wantAdvertise();
void onConnect(uint16_t conn);
void onDisconnect();
void onSubscribe(uint16_t attr, bool notify);
void onMtu(uint16_t mtu);
// PASSKEY_ACTION / ENC_CHANGE / REPEAT_PAIRING; devolve o rc do evento
int onGapSecurity(ble_gap_event* event);

}  // namespace PhoneLink

#endif  // CELEROS_BT_PHONE_LINK_H
