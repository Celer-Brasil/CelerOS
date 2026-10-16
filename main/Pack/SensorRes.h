#ifndef CELEROS_PACK_SENSOR_RES_H
#define CELEROS_PACK_SENSOR_RES_H

#include <stddef.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Sensores dos recursos da matilha (API 38): as leituras que o firmware ja
// tem (LDR do perfil e bateria) viram recursos TYPE_SENSOR — leitura
// PASSIVA, recurso compartilhado (N assinantes nao brigam).
//
//   serveStart  — liga a sessao ao sensor. {"rate":ms} no params do OPEN:
//     > 0 o servidor AMOSTRA sozinho e empurra DATA [ts u32][f32 LE] pelo
//     ESP-NOW (sessao de stream: o handleOpen recusa rate>0 sem canal
//     comum, como o mic); 0 = sob demanda, o cliente manda DATA [2] e o
//     Resources responde sampleOnce (esse caminho anda pela malha tambem).
//   tick        — temporizador do Resources (tickTimers, sob o mutex):
//     envia as amostras vencidas.
//   serveStop   — fim do lease: a amostragem para sozinha (lease, de novo).
//
// O valor vai no fio como f32 LE na UNIDADE do TAG_UNIT do catalogo
// ("%" para lum/bat). Chamado sob o mutex do Resources.
namespace SensorRes {

bool serveStart(uint16_t sid, const uint8_t mac[6], uint32_t token, int sensorIdx, int rateMs);
void serveStop(uint16_t sid);
bool busy(uint16_t sid);

// Amostra agora (caminho "por pedido" e o bits do tick): 8 B em out
// ([ts u32][f32 LE]) ou 0 sem leitura.
int sampleOnce(int sensorIdx, uint8_t out[8]);

// Temporizador (tickTimers do Resources): amostra as sessoes vencidas.
void tick();

// Catalogo de sensores do perfil (indices para serveStart/sampleOnce)
int count();
const char* name(int idx);
bool available(int idx);
int indexOf(const char* name);  // -1 = desconhecido

}  // namespace SensorRes

#endif  // CELEROS_PACK_SENSOR_RES_H
