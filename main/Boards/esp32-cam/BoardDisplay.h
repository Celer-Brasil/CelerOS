#ifndef CELER_BOARDS_ESP32_CAM_DISPLAY_H
#define CELER_BOARDS_ESP32_CAM_DISPLAY_H

// ESP32-CAM (AI-Thinker, modulo ESP32-S): SEM display — o vidro da placa
// e o sensor OV2640. A PSRAM de 4MB fica inteira para o runtime JS, os
// buffers TLS e, na rodada da camera, os framebuffers JPEG.
// Painel stub compartilhado das placas headless: Boards/HeadlessDisplay.h.

#include "../HeadlessDisplay.h"

#endif  // CELER_BOARDS_ESP32_CAM_DISPLAY_H
