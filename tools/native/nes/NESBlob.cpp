// TU unico do emulador NES como blob nativo CLRN v2 (app Anemoia).
//
// Este arquivo e o FONTE do blob (celer.js native / build_core.py): inclui o
// runtime freestanding, o nucleo Anemoia (unity) e a fachada Nes, e expoe a
// UNICA entrada do blob: core_ctl(scratch, cmd, args).
//
// Layout: TODO o estado do emulador (objeto Nes ~21KB, framebuffer 120KB,
// buffer de PCM, savestate, arena de malloc) vive no .bss do blob, que o
// loader zera e situa na regiao de scratch. O app nao precisa saber offsets:
// core_ctl(CORE_ROM_OFF/CORE_PCM_OFF/CORE_FB_OFF/CORE_STATE_OFF) devolve a
// posicao RELATIVA ao ponteiro de scratch que o loader passa — e os bindings
// nativeLoadFile/nativeAudio/nativeDraw/nativeSaveFile usam esses offsets.
//
// Comandos (core_ctl(scratch, cmd, arg)):
//   0 INIT         (re)inicializa arena e estado; devolve 1
//   1 ROM_OFF      -> offset do buffer de ROM (nativeLoadFile)
//   2 PCM_OFF      -> offset do buffer de PCM (nativeAudio)
//   3 FB_OFF       -> offset do framebuffer 256x240 RGB565 swap (nativeDraw)
//   4 STATE_OFF    -> offset do buffer de savestate (nativeSaveFile)
//   5 STATE_SIZE   -> capacidade do savestate em bytes
//   6 LOAD         arg = tamanho da ROM ja copiada em ROM_OFF; 1/0
//   7 RESET        reset quente do jogo; 1
//   8 FRAME        arg = buttons | (render << 8); devolve 1 se rodou
//   9 SAVE_STATE   serializa em STATE_OFF; devolve bytes escritos
//  10 LOAD_STATE   arg = bytes validos em STATE_OFF; 1/0
//  11 PCM_LEN      devolve bytes de PCM gerados no ultimo FRAME
//
// A APU ticka INLINE no frame (o blob nao tem task): o sink grava no buffer
// de PCM do .bss e o app drena por nativeAudio a cada quadro.

#define NES_BLOB 1

#include "../runtime.c"
#include "../runtime_new.hpp"

#include "NesCore.cpp"
#include "Nes.cpp"

namespace {

// --- memoria do emulador no .bss do blob (o loader zera o .bss no load) ---
// O construtor de Nes (e os de Cpu6502/Bus/Ppu por dentro) NAO roda sozinho
// no blob: sem crt/.init_array ninguem chama os construtores estaticos. O
// buffer e construido UMA vez pelo core_ctl(INIT) com placement-new.
alignas(nes::Nes) static uint8_t s_nes_mem[sizeof(nes::Nes)];
static nes::Nes* s_nes;
// Layout FIXO da SCRATCH (PSRAM, bloco do app): a imagem+bss do blob vivem
// na RAM INTERNA (executavel; o S3 nao busca instrucao de PSRAM) e a RAM
// interna nao comporta 1,3MB de buffers. Os comandos core_ctl devolvem
// exatamente estes offsets; o app usa os valores devolvidos, nunca numeros.
//   ROM (1MB) | PCM (8KB) | FB (120KB) | STATE (40KB) | ARENA (64KB)
// Total ~1,23MB — o app pede scratch >= 1280KB no nativeLoad.
constexpr uint32_t kRomOff = 0;
constexpr uint32_t kRomCap = nes::MAX_ROM_SIZE;      // 1 MB
constexpr uint32_t kPcmOff = kRomOff + kRomCap;
constexpr uint32_t kPcmCap = 8 * 1024;               // ~5 quadros de PCM
constexpr uint32_t kFbOff = kPcmOff + kPcmCap;
constexpr uint32_t kFbCap = nes::SCREEN_W * nes::SCREEN_H * 2;
constexpr uint32_t kStateOff = kFbOff + kFbCap;
constexpr uint32_t kStateCap = 40 * 1024;            // savestate ~6-20KB
constexpr uint32_t kArenaOff = kStateOff + kStateCap;
constexpr uint32_t kArenaCap = 64 * 1024;            // cart+mappers (carga)

uint16_t* s_fb;
uint8_t* s_rom;
uint8_t* s_state;
uint8_t* s_pcm;
uint32_t s_pcm_len;

void pcmSink(const uint8_t* data, uint32_t bytes)
{
    if (s_pcm == nullptr || s_pcm_len + bytes > kPcmCap) return;  // nao drenou: corta
    memcpy(s_pcm + s_pcm_len, data, bytes);
    s_pcm_len += bytes;
}

}  // namespace

// O loader aponta o framebuffer antes do LOAD (Nes::openScreen usa o
// nes::g_blob_fb declarado em Nes.cpp).
namespace nes {
uint16_t* g_blob_fb = nullptr;  // apontado no core_ctl(INIT) para a scratch
}  // namespace nes

namespace {
enum {
    CORE_INIT = 0,
    CORE_ROM_OFF,
    CORE_PCM_OFF,
    CORE_FB_OFF,
    CORE_STATE_OFF,
    CORE_STATE_SIZE,
    CORE_LOAD,
    CORE_RESET,
    CORE_FRAME,
    CORE_SAVE_STATE,
    CORE_LOAD_STATE,
    CORE_PCM_LEN,
};
}  // namespace

extern "C" uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg)
{
    switch (cmd) {
    case CORE_INIT: {
        uint8_t* sc = (uint8_t*)scratch;
        if (sc == nullptr) return 0;
        s_rom = sc + kRomOff;
        s_pcm = sc + kPcmOff;
        s_fb = (uint16_t*)(sc + kFbOff);
        s_state = sc + kStateOff;
        nes_arena_use(sc + kArenaOff, kArenaCap);  // cart/mappers na PSRAM (carga)
        if (s_nes == nullptr) s_nes = ::new (static_cast<void*>(s_nes_mem)) nes::Nes();
        nes::g_blob_fb = s_fb;  // Nes::openScreen usa este ponteiro
        s_nes->setAudioSink(&pcmSink);  // PCM -> s_pcm (drenado pelo app)
        s_pcm_len = 0;
        return 1;
    }
    case CORE_ROM_OFF:
        return kRomOff;
    case CORE_PCM_OFF:
        return kPcmOff;
    case CORE_FB_OFF:
        return kFbOff;
    case CORE_STATE_OFF:
        return kStateOff;
    case CORE_STATE_SIZE:
        return kStateCap;
    case CORE_LOAD: {
        uint32_t sz = (uint32_t)(arg > 0 ? arg : 0);
        if (sz == 0 || sz > kRomCap) return 0;
        if (s_rom == nullptr) return 0;
        s_pcm_len = 0;
        const char* err = nullptr;
        if (!s_nes->load(s_rom, sz, nullptr, nullptr, &err)) return 0;
        if (!s_nes->openScreen()) return 0;
        s_nes->reset();
        return 1;
    }
    case CORE_RESET:
        s_pcm_len = 0;
        s_nes->reset();
        return 1;
    case CORE_FRAME: {
        uint8_t buttons = (uint8_t)((uint32_t)arg & 0xFFu);
        bool render = ((uint32_t)arg >> 8) != 0;
        s_pcm_len = 0;  // o app drena o que este quadro gerar
        s_nes->frame(buttons, render);
        return 1;
    }
    case CORE_SAVE_STATE: {
        nes::File out;
        if (s_state == nullptr) return 0;
        out.setWriteBuf(s_state, kStateCap);
        if (!s_nes->saveState(out)) return 0;
        return (uint32_t)out.size();
    }
    case CORE_LOAD_STATE: {
        uint32_t len = (uint32_t)(arg > 0 ? arg : 0);
        if (len == 0 || len > kStateCap) return 0;
        if (s_state == nullptr) return 0;
        nes::File in(s_state, len);
        return s_nes->loadState(in) ? 1u : 0u;
    }
    case CORE_PCM_LEN:
        return s_pcm_len;
    default:
        return 0;
    }
}
