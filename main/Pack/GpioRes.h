#ifndef CELEROS_PACK_GPIO_RES_H
#define CELEROS_PACK_GPIO_RES_H

#include <stddef.h>
#include <stdint.h>

// GPIO dos recursos da matilha (API 38): as saidas DE POWER do no (reles
// L1..L3 do perfil e o gpio generico de pino livre) viram recursos TYPE_GPIO.
// Protocolo de controle/lease e do Resources; aqui e so a ponta de hardware:
//
//   serveStart  — liga a sessao ao rele/pino (params do OPEN: {"pin":N} no
//     gpio generico; o rele NAO precisa). Idempotente por sid (OPEN
//     repetido da perda do ACCEPT).
//   data        — DATA do cliente: [1][0|1] escreve; [2] le (responde
//     [2][0|1]; a resposta quem envia e o Resources). Ops de onda futura
//     (pulso/PWM) respondem [0xFF].
//   serveStop   — fim do lease (CLOSE, vencido, revogado): com auto-off o
//     pino/rele volta ao nivel BAIXO sozinho — a matilha inteira pode cair
//     que o atuador desliga (o mesmo contrato que devolve a camera).
//
// Segurança herdada da arbitragem do Resources: recurso EXCLUSIVO, so
// matilha privada, interruptor do dono res_share_gpio (default "0") e o uso
// LOCAL sempre ganha (System.relay revoga a sessao remota). O pino generico
// passa pelas MESMAS guardas do System.gpio (pino valido de saida, nao
// reservado pelo boot, fora do gpioDeniedMask da PSRAM) — um rele remoto
// nunca toca linha de flash/PSRAM.
// Chamado sob o mutex do Resources (handleOpen/leaseGone/handleDataRx).
namespace GpioRes {

bool available();  // a placa tem reles (ou o gpio generico faz sentido)

bool serveStart(uint16_t sid, const char* name, const uint8_t* params, size_t plen);
void serveStop(uint16_t sid, bool autoOff);
bool busy(uint16_t sid);  // esta sessao ja esta servida (OPEN repetido)

// DATA do cliente (servidor roteia pelo tipo): escreve/le e monta a
// resposta; *replyLen = 0 quando nao ha resposta (WRITE).
bool data(uint16_t sid, const uint8_t* d, size_t n, uint8_t* reply, size_t* replyLen);

}  // namespace GpioRes

#endif  // CELEROS_PACK_GPIO_RES_H
