#ifndef CELEROS_PACK_AUDIO_RES_H
#define CELEROS_PACK_AUDIO_RES_H

#include <stddef.h>
#include <stdint.h>

// Audio dos recursos da matilha (API 36, R3): as pontas nativas do stream
// que o Resources liga a uma sessao ESP-NOW. Formato fixo no ar: PCM16 mono
// 16 kHz LE (32 KB/s — o plano ESP-NOW leva ~65 KB/s por sentido), blocos de
// 16 ms (512 B) como saem do micReadMonoLocked.
//
//   fonte  — o microfone DESTE no vira stream para um par (task propria:
//            le o canal I2S do mic sob o lock por chunk, como o wake word)
//   tocar  — stream recebido vai ao alto-falante DESTE no (PcmFeed: reserva
//            de 160 ms, pausa unica na falta de dado em vez de cliques)
//   gravar — stream recebido acumula na PSRAM e sai como WAV (Mic.start com
//            {node}: o mesmo WAV do gravador local)
//
// Uma ponta de cada tipo por vez (o hardware so tem um mic e um speaker).
// Chamado sob o mutex do Resources; o feed e chamado do tick dele.
namespace AudioRes {

static constexpr uint32_t RATE = 16000;

bool micAvailable();       // placa com microfone (mic.ws >= 0)
bool speakerAvailable();   // placa com I2S de saida (PcmFeed)

// ---- fonte: mic local -> par (mac, sid, token) ----
bool sourceStart(const uint8_t mac[6], uint16_t sid, uint32_t token);
// Fonte de BUFFER (API 41, o PC tocando no alto-falante de outro no pelo
// cabo): PCM16 mono 16 kHz ja carregado; sai no ritmo do tempo real (16 ms
// por bloco) e a task encerra sozinha no fim (sourceActive() vira false).
// O buffer e do chamador e precisa viver ate sourceActive() == false.
bool sourceStartBuffer(const uint8_t mac[6], uint16_t sid, uint32_t token, const int16_t* pcm, size_t n);
void sourceStop(uint16_t sid);   // so para se for a fonte desta sessao
bool sourceActive();

// ---- tocar: stream -> speaker local ----
bool playStart(uint16_t sid);
void playFeed(uint16_t sid, const uint8_t* pcm, size_t len);
void playStop(uint16_t sid);
bool playActive();

// ---- gravar: stream -> WAV (PSRAM) ----
bool recStart(uint16_t sid, uint32_t maxMs);
void recFeed(uint16_t sid, const uint8_t* pcm, size_t len);
bool recActive(uint16_t sid);   // true ate encher o teto (ou parar)
int recLevel();                 // RMS 0..100 do ultimo bloco (-1 = parado)
// Encerra e devolve o WAV (ou base64) em buffer malloc do chamador.
char* recStop(bool base64, size_t* lenOut, uint32_t* msOut);

// telemetria de bancada (log a cada fim de sessao)
struct Stats {
    uint32_t srcFrames, srcFail, playFrames, playStarves, recFrames;
};
void stats(Stats* out);

}  // namespace AudioRes

#endif  // CELEROS_PACK_AUDIO_RES_H
