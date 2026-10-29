#pragma once

// Wake word on-device "Hi Celer" (microWakeWord V2, modelo proprio int8 em
// Assets/Wake/HiCelerModel.h; frontend C++ + TFLite Micro, API 20). A task
// propria le o canal I2S do microfone (o mesmo do gravador: lock por chunk
// em BoardIO::micChanLock) e roda a inference a cada slice. Enquanto uma
// gravacao esta em curso (micRecActive) OU o alto-falante toca, a task
// descansa — o comando falado apos o wake e capturado pelo Mic.*, o
// detector so reativa quando o canal e o falante voltam a ficar livres.
//
// So existe no build com CONFIG_CELEROS_WAKE_WORD (hoje o cao).

namespace WakeWord {

// Sobe o modelo e a task (idempotente). Devolve false sem microfone, sem
// RAM p/ o modelo ou se o modelo embutido for placeholder vazio.
bool start();
// Encerra a task e destroi o modelo (join: <= ~200 ms).
void stop();
bool running();
// true = "Hi Celer" detectado (consome o evento; deteccoes multiplas entre
// polls colapsam numa so — o app polha a cada volta do loop).
bool poll();
// RMS 0..100 do ultimo chunk lido (mesma escala do micLevel); -1 parado.
int level();

}  // namespace WakeWord
