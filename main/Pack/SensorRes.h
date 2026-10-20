#ifndef CELEROS_PACK_SENSOR_RES_H
#define CELEROS_PACK_SENSOR_RES_H

#include <stddef.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Sensores dos recursos da matilha (API 38): as leituras que o firmware ja
// tem viram recursos TYPE_SENSOR — leitura PASSIVA, recurso compartilhado
// (N assinantes nao brigam). Catalogo (API 47): "lum" (LDR do perfil),
// "bat" (bateria), "temp" (die do IMU, onde ha) e "adc" (pino livre por
// params {"pin":N} no OPEN).
//
//   serveStart  — liga a sessao ao sensor. {"rate":ms} no params do OPEN:
//     > 0 o servidor AMOSTRA sozinho e empurra DATA [ts u32][f32 LE] pelo
//     ESP-NOW (sessao de stream: o handleOpen recusa rate>0 sem canal
//     comum, como o mic); 0 = sob demanda, o cliente manda DATA [2] e o
//     Resources responde sampleOnce (esse caminho anda pela malha tambem).
//     API 47: {"gt":x} / {"lt":x} (+ histerese {"h":d}) fazem a sessao
//     avaliar o limiar a cada 1 s (ou no rate) e EMPURRAR um DATA de evento
//     ([0xE0][ts][f32][dir], 10 B) na transicao — sem stream continuo e com
//     a malha BLE (multi-hop) quando nao ha ESP-NOW. O cooldown de 1 s por
//     sessao segura o ruido no limiar.
//   tick        — temporizador do Resources (tickTimers, sob o mutex):
//     envia as amostras vencidas e avalia os limiares.
//   serveStop   — fim do lease: a amostragem para sozinha (lease, de novo).
//
// O valor vai no fio como f32 LE na UNIDADE do TAG_UNIT do catalogo
// ("%" para lum/bat, "C" para temp, bruto 0..4095 no adc). Chamado sob o
// mutex do Resources.
namespace SensorRes {

// Saida das amostras, registrada pelo Resources no init: o hook decide o
// transporte por lease (DataLink para sessao ESP-NOW, KL_RES_DATA para a
// sessao do PC no gateway USB — so o Resources sabe o lease de cada sid)
typedef void (*SendHook)(uint16_t sid, const uint8_t mac[6], uint32_t token,
                         const uint8_t* d, size_t n);
void setSendHook(SendHook h);

bool serveStart(uint16_t sid, const uint8_t mac[6], uint32_t token, int sensorIdx, int rateMs,
                const uint8_t* params = nullptr, size_t plen = 0);
void serveStop(uint16_t sid);
bool busy(uint16_t sid);

// Amostra agora (caminho "por pedido" e o bits do tick): 8 B em out
// ([ts u32][f32 LE]) ou 0 sem leitura.
int sampleOnce(int sensorIdx, uint8_t out[8]);
// Amostra pela SESSAO (sabe o pino do adc); 0 sem sessao/leitura.
int sampleOnceSid(uint16_t sid, uint8_t out[8]);

// Temporizador (tickTimers do Resources): amostra as sessoes vencidas.
void tick();

// Catalogo de sensores do perfil (indices para serveStart/sampleOnce)
int count();
const char* name(int idx);
bool available(int idx);
int indexOf(const char* name);  // -1 = desconhecido

}  // namespace SensorRes

#endif  // CELEROS_PACK_SENSOR_RES_H
