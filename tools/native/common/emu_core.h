#pragma once
// Contrato canonico dos cores de emulador nativos (blob CLRN) do CelerOS.
//
// O app JS fala SO por System.nativeCall(handle, 0, cmd, arg) e le/escreve a
// scratch pelos offsets que o core devolve. Os comandos 0-19 sao os mesmos do
// Anemoia (NES) para a casca poder ser compartilhada; cada console usa 20+ para
// extensoes proprias.
//
//  0 INIT        arg = tamanho da scratch em KB; (re)inicializa e devolve a
//                capacidade da ROM em bytes (0 = scratch menor que o layout)
//  1 ROM_OFF     -> offset da ROM (nativeLoadFile)
//  2 PCM_OFF     -> offset do PCM (nativeAudio)
//  3 FB_OFF      -> offset do framebuffer nativo (nativeDraw)
//  4 STATE_OFF   -> offset do save state (nativeSaveFile)
//  5 STATE_SIZE  -> capacidade do save state
//  6 LOAD        arg = bytes de ROM ja copiados em ROM_OFF; 1/0
//  7 RESET       reset quente; 1
//  8 FRAME       arg = buttons | (render << 8); 1
//  9 SAVE_STATE  serializa em STATE_OFF; devolve bytes (0 = falhou)
// 10 LOAD_STATE  arg = bytes validos; 1/0
// 11 PCM_LEN     bytes de PCM gerados no ultimo FRAME
// 12 SET_SCALE   arg = (dstW << 16) | dstH; devolve o offset do buffer
//                escalado (0 = desligado/geometria invalida)
// 13 SET_AUDIO   arg != 0 liga a geracao de PCM
// 14 PERF        arg 0 = ciclos do ultimo FRAME; 1 = da escala
// 15 FRAME_SCREEN (API 60) — cores que nao compoem direto devolvem
//                0xFFFFFFFF para o app cair no caminho FRAME + nativeDraw
// 16..19        GRAB_OFF/STAMP_MAKE/STAMP_PLACE/STAMP_RESET (idem)
// 20+           extensoes do console (documentadas no README do core)

#include "emu_compat.h"

namespace emu {

enum {
    kCtlInit = 0,
    kCtlRomOff,
    kCtlPcmOff,
    kCtlFbOff,
    kCtlStateOff,
    kCtlStateSize,
    kCtlLoad,
    kCtlReset,
    kCtlFrame,
    kCtlSaveState,
    kCtlLoadState,
    kCtlPcmLen,
    kCtlSetScale,
    kCtlSetAudio,
    kCtlPerf,
    kCtlFrameScreen,
    kCtlGrabOff,
    kCtlStampMake,
    kCtlStampPlace,
    kCtlStampReset,
    kCtlExtBase = 20,
};

// Retorno de FRAME_SCREEN quando o core nao implementa a composicao direta.
constexpr uint32_t kNoTarget = 0xFFFFFFFFu;

static inline int32_t emuFrameArg(uint32_t buttons, bool render)
{
    return (int32_t)((buttons & 0xFFu) | (render ? 0x100u : 0u));
}
static inline uint8_t emuFrameButtons(int32_t arg) { return (uint8_t)((uint32_t)arg & 0xFFu); }
static inline bool emuFrameRender(int32_t arg) { return (((uint32_t)arg >> 8) & 1u) != 0; }

}  // namespace emu
