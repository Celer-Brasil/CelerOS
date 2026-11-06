// TU unico do Atari 2600 como blob CLRN v2 (app "Atari 2600").
//
// Mesma ABI do Anemoia (tools/native/common/emu_core.h): o app fala por
// System.native* e le a scratch pelos offsets devolvidos por core_ctl. O
// estado quente (A2600: CPU/TIA/cart/RIOT/linha/paleta) vai de CLRN_FAST para
// a RAM interna; os buffers grandes (PCM/FB/escalado/state/ROM) ficam na
// scratch em PSRAM.
//
// Layout da scratch:
//   PCM 8K | FB 160x192 (60K) | ESCALADO 480x480 (450K) | STATE 40K |
//   CARIMBOS 640K | ROM
//
// Video: FRAME_SCREEN (API 60, common/emu_screen.h) compoe o quadro escalado
// + carimbos do overlay direto no vidro, a partir da LINHA da TIA (RAM
// interna) — sem o framebuffer 160x192 na PSRAM — e so reescreve as linhas
// que mudaram. O alvo pode ser a tela inteira: o quadro fica centrado e as
// faixas saem pretas daqui. Os grabs dos carimbos usam a area do ESCALADO
// (so o caminho antigo FRAME + SET_SCALE + nativeDraw a usa).
//
// Extensoes do console (20+):
//   20 SET_SWITCHES  bits: 2 cor, 3 dif A P0, 4 dif A P1
//   21 SET_PADDLE    arg = paddle0 | paddle1 << 8
//   22 MAPPER        arg >= 0 define o override do proximo LOAD; arg -1 le o
//                    mapper detectado (CartA2600::k2K..kUA)

#define EMU_BLOB 1
// O cartucho do 2600 nao aloca em heap (RAM fixa no objeto): a arena do
// runtime so existe para fechar o contrato do loader.
#define CORE_ARENA_BYTES (1u * 1024u)

#include "../runtime.c"
#include "../runtime_new.hpp"

#include "../common/emu_core.h"
#include "../common/emu_screen.h"
#include "A2600Core.cpp"

namespace {

inline uint32_t ccount()
{
#if defined(__XTENSA__)
    uint32_t c;
    __asm__ volatile("rsr.ccount %0" : "=a"(c));
    return c;
#else
    return 0;
#endif
}

constexpr uint32_t kPcmOff = 0;
constexpr uint32_t kPcmCap = 8 * 1024;
constexpr uint32_t kFbOff = kPcmOff + kPcmCap;
constexpr uint32_t kFbCap = 160u * 192u * 2u;
constexpr uint32_t kScaledOff = kFbOff + kFbCap;
constexpr uint32_t kScaledCap = 480u * 480u * 2u;
constexpr uint32_t kStateOff = kScaledOff + kScaledCap;
constexpr uint32_t kStateCap = 40 * 1024;
constexpr uint32_t kStampOff = kStateOff + kStateCap;
constexpr uint32_t kStampCap = 640 * 1024;  // carimbos do overlay em runs
constexpr uint32_t kGrabCap = kScaledCap / 2;
constexpr uint32_t kRomOff = kStampOff + kStampCap;
constexpr uint32_t kRomMax = 512 * 1024;

// Construtor do A2600 nao roda sozinho no blob (sem .init_array): o INIT
// constroi uma vez com placement-new.
alignas(emu::a2600::A2600) static uint8_t s_emu_mem[sizeof(emu::a2600::A2600)] CLRN_FAST;
static emu::a2600::A2600* s_emu = nullptr;

static uint8_t* s_rom = nullptr;
static uint32_t s_romCap = 0;
static uint16_t* s_fb = nullptr;
static uint16_t* s_scaled = nullptr;
static uint8_t* s_pcm = nullptr;
static uint8_t* s_state = nullptr;
static uint32_t s_pcmLen = 0;
static emu::Scaler s_scaler CLRN_FAST;
static uint8_t s_switches = 0;
static uint8_t s_paddles[4] = {0, 0, 0, 0};
static int s_mapperOverride = -1;
static bool s_audioOn = true;
static uint32_t s_perfEmu = 0;
static uint32_t s_perfScale = 0;

// composicao direta: linhas montadas na RAM interna (caminho quente)
static emu::ScreenComposer s_screen;
static uint16_t s_lineBase[emu::ScreenComposer::kMaxW] CLRN_FAST;
static uint16_t s_lineMix[emu::ScreenComposer::kMaxW] CLRN_FAST;
static uint16_t s_col[emu::ScreenComposer::kMaxSrcW + 1] CLRN_FAST;
static uint32_t s_sinkCycles = 0;

static void screenSink(void*, int y, const uint16_t* line)
{
    const uint32_t c0 = ccount();
    s_screen.row(y, line);
    s_sinkCycles += ccount() - c0;
}

}  // namespace

extern "C" uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg)
{
    switch (cmd) {
    case emu::kCtlInit: {
        uint8_t* sc = (uint8_t*)scratch;
        if (sc == nullptr) return 0;
        const uint32_t total = (uint32_t)(arg > 0 ? arg : 0) * 1024u;
        if (total <= kRomOff) return 0;
        s_romCap = total - kRomOff;
        if (s_romCap > kRomMax) s_romCap = kRomMax;
        s_pcm = sc + kPcmOff;
        s_fb = (uint16_t*)(sc + kFbOff);
        s_scaled = (uint16_t*)(sc + kScaledOff);
        s_state = sc + kStateOff;
        s_rom = sc + kRomOff;
        s_pcmLen = 0;
        s_switches = 0;
        s_paddles[0] = s_paddles[1] = s_paddles[2] = s_paddles[3] = 0;
        s_mapperOverride = -1;
        s_audioOn = true;
        s_scaler = emu::Scaler();
        s_perfEmu = s_perfScale = 0;
        s_screen.init(sc, kScaledOff, kGrabCap, kStampOff, kStampCap, s_lineBase, s_lineMix,
                      s_col);
        if (s_emu == nullptr) s_emu = ::new (static_cast<void*>(s_emu_mem)) emu::a2600::A2600();
        s_emu->setFramebuffer(s_fb);
        // o downsampler conta SAMPLES (int16), nao bytes
        s_emu->setPcm((int16_t*)s_pcm, kPcmCap / 2);
        return s_romCap;
    }
    case emu::kCtlRomOff:
        return kRomOff;
    case emu::kCtlPcmOff:
        return kPcmOff;
    case emu::kCtlFbOff:
        return kFbOff;
    case emu::kCtlStateOff:
        return kStateOff;
    case emu::kCtlStateSize:
        return kStateCap;
    case emu::kCtlLoad: {
        if (s_emu == nullptr || s_rom == nullptr) return 0;
        const uint32_t sz = (uint32_t)(arg > 0 ? arg : 0);
        if (sz == 0 || sz > s_romCap) return 0;
        s_pcmLen = 0;
        return s_emu->load(s_rom, sz, s_mapperOverride) ? 1u : 0u;
    }
    case emu::kCtlReset:
        if (s_emu == nullptr) return 0;
        s_pcmLen = 0;
        s_emu->reset();
        return 1;
    case emu::kCtlFrame: {
        if (s_emu == nullptr) return 0;
        const uint8_t buttons = emu::emuFrameButtons(arg);
        const bool render = emu::emuFrameRender(arg);
        s_pcmLen = 0;
        // quadro pulado nao escreve o framebuffer (60 KB de PSRAM a menos)
        s_emu->setVideoOut(render ? s_fb : nullptr, nullptr, nullptr);
        s_screen.invalidate();  // o vidro vai receber o caminho antigo
        const uint32_t c0 = ccount();
        s_emu->frame(buttons, s_switches, s_paddles);
        const uint32_t c1 = ccount();
        if (render && s_scaler.ready()) s_scaler.scale(s_emu->frameBuffer(), 160);
        s_perfEmu = c1 - c0;
        s_perfScale = ccount() - c1;
        s_pcmLen = s_emu->pcmLen();
        return 1;
    }
    case emu::kCtlSaveState: {
        if (s_emu == nullptr || s_state == nullptr) return 0;
        emu::StateWriter w(s_state, kStateCap, emu::kConsoleA2600, s_emu->romCrc());
        s_emu->save(w);
        return w.finish();
    }
    case emu::kCtlLoadState: {
        if (s_emu == nullptr || s_state == nullptr) return 0;
        const uint32_t len = (uint32_t)(arg > 0 ? arg : 0);
        if (len == 0 || len > kStateCap) return 0;
        emu::StateReader r(s_state, len, emu::kConsoleA2600, s_emu->romCrc());
        return s_emu->loadState(r) ? 1u : 0u;
    }
    case emu::kCtlPcmLen:
        return s_pcmLen;
    case emu::kCtlSetScale: {
        const uint32_t w = ((uint32_t)arg >> 16) & 0xFFFFu;
        const uint32_t h = (uint32_t)arg & 0xFFFFu;
        if (w == 0 || h == 0) {
            s_scaler = emu::Scaler();
            return 0;
        }
        if (!s_scaler.configure(160, 192, (int)w, (int)h, s_scaled)) return 0;
        s_screen.setScale(160, 192, (int)w, (int)h);
        return kScaledOff;
    }
    case emu::kCtlSetAudio:
        s_audioOn = arg != 0;
        if (s_emu != nullptr) s_emu->setPcm(s_audioOn ? (int16_t*)s_pcm : nullptr, kPcmCap / 2);
        return 1;
    case emu::kCtlPerf:
        return arg == 0 ? s_perfEmu : s_perfScale;
    case emu::kCtlFrameScreen: {
        // arg = NativeScreen* (pixel do alvo, stride, w, h, arg do app)
        const emu::NativeScreen* scr = (const emu::NativeScreen*)(uintptr_t)(uint32_t)arg;
        if (s_emu == nullptr || scr == nullptr) return emu::kNoTarget;
        const uint8_t buttons = emu::emuFrameButtons(scr->arg);
        const bool render = emu::emuFrameRender(scr->arg);
        // alvo/geometria invalidos: o app cai no FRAME + nativeDraw
        if (render && !s_screen.begin(scr)) return emu::kNoTarget;
        s_pcmLen = 0;
        s_sinkCycles = 0;
        s_emu->setVideoOut(nullptr, render ? &screenSink : nullptr, nullptr);
        const uint32_t c0 = ccount();
        s_emu->frame(buttons, s_switches, s_paddles);
        const uint32_t c1 = ccount();
        s_emu->setVideoOut(s_fb, nullptr, nullptr);
        if (render) s_screen.end();
        s_perfEmu = c1 - c0 - s_sinkCycles;
        s_perfScale = s_sinkCycles + (ccount() - c1);
        s_pcmLen = s_emu->pcmLen();
        return 1;
    }
    case emu::kCtlGrabOff:
        return s_screen.grabOff(arg);
    case emu::kCtlStampMake:
        return s_screen.stampMake(arg & 31, (arg >> 5) & 1023, (arg >> 15) & 1023) ? 1u : 0u;
    case emu::kCtlStampPlace:
        return s_screen.stampPlace(arg) ? 1u : 0u;
    case emu::kCtlStampReset:
        s_screen.stampReset();
        return 1;
    case 20:  // SET_SWITCHES
        s_switches = (uint8_t)((uint32_t)arg & 0xFFu);
        return 1;
    case 21:  // SET_PADDLE
        s_paddles[0] = (uint8_t)((uint32_t)arg & 0xFFu);
        s_paddles[1] = (uint8_t)(((uint32_t)arg >> 8) & 0xFFu);
        s_paddles[2] = s_paddles[3] = 0;
        return 1;
    case 22:  // MAPPER
        if (arg >= 0) {
            if (arg <= (int)emu::a2600::CartA2600::kUA) s_mapperOverride = arg;
            return (uint32_t)s_mapperOverride;
        }
        return s_emu != nullptr ? (uint32_t)s_emu->mapper() : 0;
    default:
        return 0;
    }
}
