#pragma once

// Cola ESP do System.playMusic (API 25): task dorminte que mistura as
// trilhas do MusicEngine e escreve no alto-falante I2S, com a MESMA guarda
// de posse exclusiva do playWav/tom/TTS (AudioPlayer::acquireOutput). O
// motor puro (compilacao e renderizacao) vive em MusicEngine.h — este
// header so existe para o runtime JS.
#include "sdkconfig.h"  // CONFIG_CELEROS_AUDIO: o #if abaixo nao pode depender
                        // da ordem de includes do chamador
#if CONFIG_CELEROS_AUDIO
#include "MusicEngine.h"

namespace MusicSynth {

// Compila a musica e acorda a task (nao bloqueia). false = alto-falante
// ocupado (fala/tom/playWav em curso), sem audio na placa ou musica vazia.
// startMs pula para o meio da musica (handoff da matilha: retoma de onde
// parou no vizinho; alem do total a task encerra na hora, posMs final).
bool play(const MusicEngine::Song& song, uint32_t startMs = 0);

// Efeito curto (System.sfx, API 32) misturado por cima da trilha — nao
// bloqueia; sem trilha a task abre uma sessao so para ele. Substitui o
// efeito em curso. Devolve os tons aceitos (0 = alto-falante ocupado por
// fala/tom/playWav, sem audio na placa ou lista vazia).
int sfx(const MusicEngine::SfxTone* tones, int n);

// Corta a trilha no proximo bloco (~6 ms); um efeito em curso termina.
// Idempotente.
void stop();

// true enquanto a trilha toca (ate acabarem os loops ou chegar um stop()).
bool playing();

// Posicao em ms desde o inicio do audio, ou -1 se parado.
int32_t posMs();

// Copia a musica em curso (handoff da matilha). false = nada tocando.
bool currentSong(MusicEngine::Song* out);

}  // namespace MusicSynth

#else  // !CONFIG_CELEROS_AUDIO: perfil sem audio digital (CYD/cyd-vspi/
// devkit/esp32-cam). Stubs inline com o MESMO contrato documentado acima:
// play/sfx devolvem false/0 ("sem audio na placa"), posMs -1, playing false.
// MusicEngine.h segue incluido porque os TIPOS Song/SfxTone aparecem nas
// assinaturas (Pack da matilha compila com BT em placa sem audio —
// esp32-cam); as funcoes do motor so sao emitidas por quem as chama, e a
// implementacao (MusicSynth.cpp) sai do binario.
#include "MusicEngine.h"

namespace MusicSynth {

inline bool play(const MusicEngine::Song&, uint32_t = 0) { return false; }
inline int sfx(const MusicEngine::SfxTone*, int) { return 0; }
inline void stop() {}
inline bool playing() { return false; }
inline int32_t posMs() { return -1; }
inline bool currentSong(MusicEngine::Song*) { return false; }

}  // namespace MusicSynth
#endif
