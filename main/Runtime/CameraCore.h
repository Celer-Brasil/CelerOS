#ifndef CELEROS_RUNTIME_CAMERA_CORE_H
#define CELEROS_RUNTIME_CAMERA_CORE_H

#include <stddef.h>
#include <stdint.h>

#include "sdkconfig.h"

// Nucleo nativo da camera (API 36): o MESMO driver do objeto Camera do JS
// (JsCamera.cpp), exposto ao provedor "camera" dos recursos da matilha. Um
// mutex compartilhado serializa o JS (setup/capture/scanQR) e o provedor.
//
// O JPEG sai do modo VIGENTE: modo foto JPEG = o quadro direto; modo QR
// (grayscale do QrNode) = conversao por software (frame2jpg). Trocar de modo
// a cada foto nao e opcao: o driver nao aguenta ciclos deinit+init repetidos
// (o 3o init caia em "camera not supported", bancada 2026-10-10).
namespace CameraCore {

#if CONFIG_CELEROS_JS_CAMERA
bool available();
// Sobe o driver no boot (RAM interna inteira) no modo QR VGA e o deixa no ar.
void warmup();
// JPEG do quadro atual em buffer malloc do chamador (free). quality 5..63
// (menor = melhor). false = sem camera / init falhou / quadro nao veio.
bool snapJpeg(int quality, uint8_t** out, size_t* len, int* w, int* h);
#else
inline bool available() { return false; }
inline void warmup() {}
inline bool snapJpeg(int, uint8_t**, size_t*, int*, int*) { return false; }
#endif

}  // namespace CameraCore

#endif  // CELEROS_RUNTIME_CAMERA_CORE_H
