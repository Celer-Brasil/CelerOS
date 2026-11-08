// TU unico do SNES como blob CLRN v2 (app "SNES").
//
// Mesma ABI dos outros consoles (tools/native/common/emu_core.h). Base do
// core: LakeSnes (MIT, tools/native/snes/core) com o renderizador de linha,
// o escalonador por eventos e o relogio inteiro da APU do CelerOS.
//
// Layout da scratch (PSRAM; o 4848 com firmware API 62 tem ~3,6 MB de bloco
// livre com o app aberto — o Mario All-Stars (2,5 MB) precisa caber):
//   PCM 8K | UNIAO 288K | CARIMBOS 80K | ARENA 304K | ROM   (~680 KB fixos)
// A UNIAO serve a usos que nunca coexistem: os 2 grabs dos carimbos (so na
// abertura da ROM), o save state (entre SAVE/LOAD e o nativeSaveFile) e,
// DURANTE o quadro, a fila da renderizacao adiada (fim da uniao, ~41 KB; a
// fila esvazia no vblank/fim do quadro) e o caminho antigo FRAME + nativeDraw
// (FB 256x224 + quadro escalado no que sobra antes da fila). O SNES exige API
// 62, que tem FRAME_SCREEN: o caminho antigo so roda se o vidro recusar o
// alvo. A fila e o save state podem se sobrepor (nunca coexistem). CARIMBOS:
// o overlay do SNES (losango + ombros) usa ~70 KB. ARENA: structs do core
// (WRAM 128K, VRAM 64K, ARAM 64K, ~271 KB) + SRAM.
// Bancada 4848 (API 62, casca aberta): maior bloco de PSRAM ~3,4 MB e a
// imagem do blob sai dele antes da scratch; o Mario All-Stars (2,5 MB) pede
// ~3,26 MB.
// A ROM NAO e copiada nem expandida: o cart le direto da scratch e espelha
// por tabela (2,5 MB do Mario All-Stars custam 2,5 MB, nao 4).
//
// Video: FRAME_SCREEN (common/emu_screen.h) recebe cada linha da PPU (256 px,
// RAM interna) e compoe escala + carimbos direto no vidro. Quadro pulado
// (render = 0) nao desenha nada: a PPU so roda os registradores.
//
// Botoes: os 12 do SNES na ordem do registrador do controle (bit 0 B, 1 Y,
// 2 Select, 3 Start, 4-7 cima/baixo/esq/dir, 8 A, 9 X, 10 L, 11 R). O FRAME
// leva os 8 baixos em arg & 0xFF (como os outros cores) e os 4 altos em
// (arg >> 16) & 0xF — cascas antigas mandam 0 ali.
//
// Extensoes (20+):
//   20 SRAM_OFF    offset da SRAM do cartucho na scratch (0 = sem SRAM)
//   21 SRAM_SIZE   bytes da SRAM (bateria); o app salva/carrega o arquivo .srm
//   22 INFO        bit0 PAL, bits 8-15 tipo (1 LoROM, 2 HiROM, 3 ExHiROM)
//   23 PERF_PART   ciclos do ultimo quadro: 0 PPU, 1 APU, 2 sprites, 3 ciclos
//                  de SPC, 4 composicao da linha (bancada)
//   24 STAMP_USED  bytes ja usados da area de carimbos
//   25 SRAM_SUM    checksum FNV da SRAM (a casca regrava o .srm quando muda)

#define EMU_BLOB 1
#define CORE_ARENA_BYTES (1u * 1024u)  // a arena de verdade e apontada para a scratch

#include "../runtime.c"
#include "../runtime_new.hpp"

#include "../common/emu_core.h"
#include "../common/emu_screen.h"
#include "../common/emu_state.h"
#include "../common/emu_video.h"

#define SNES_FAST CLRN_FAST
#if defined(__XTENSA__)
static inline uint32_t snes_ccount()
{
    uint32_t c;
    __asm__ volatile("rsr.ccount %0" : "=a"(c));
    return c;
}
#define SNES_PROF_NOW() snes_ccount()
uint32_t snes_prof[4] CLRN_FAST;
#endif
#include "SnesCore.cpp"

// Aviso da licenca MIT do LakeSnes: viaja DENTRO do blob (o pacote do hub
// nao leva .txt); o texto completo esta em tools/native/snes/core/.
extern "C" __attribute__((used)) const char snes_core_license[] =
    "SNES core: LakeSnes, Copyright (c) 2021-2023 angelo_wf and contributors. "
    "MIT License: Permission is hereby granted, free of charge, to any person obtaining a copy "
    "of this software and associated documentation files (the \"Software\"), to deal in the "
    "Software without restriction, including without limitation the rights to use, copy, modify, "
    "merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit "
    "persons to whom the Software is furnished to do so, subject to the following conditions: "
    "The above copyright notice and this permission notice shall be included in all copies or "
    "substantial portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY "
    "OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF "
    "MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE "
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN "
    "AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE "
    "SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.";

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
constexpr uint32_t kUnionOff = kPcmOff + kPcmCap;
constexpr uint32_t kUnionCap = 288 * 1024;
constexpr uint32_t kStateOff = kUnionOff;
constexpr uint32_t kStateCap = kUnionCap;
constexpr uint32_t kGrabOff = kUnionOff;
constexpr uint32_t kGrabCap = kUnionCap / 2;
constexpr uint32_t kFbOff = kUnionOff;
constexpr uint32_t kFbCap = 256u * 239u * 2u;
constexpr uint32_t kScaledOff = (kFbOff + kFbCap + 63u) & ~63u;
constexpr uint32_t kSnapCap = 44 * 1024;  // >= ppu_snapQueueBytes() (conferido no INIT)
constexpr uint32_t kSnapOff = kUnionOff + kUnionCap - kSnapCap;
constexpr uint32_t kScaledCap = kSnapOff - kScaledOff;
constexpr uint32_t kStampOff = kUnionOff + kUnionCap;
constexpr uint32_t kStampCap = 80 * 1024;
constexpr uint32_t kArenaOff = kStampOff + kStampCap;
constexpr uint32_t kArenaCap = 304 * 1024;
constexpr uint32_t kRomOff = kArenaOff + kArenaCap;
constexpr uint32_t kRomMax = 8u * 1024u * 1024u;

constexpr int kSrcW = 256;
constexpr int kSrcH = 224;
constexpr int kOutRate = 44100;

static Snes* s_snes = nullptr;
static uint8_t* s_scratch = nullptr;
static uint8_t* s_rom = nullptr;
static uint32_t s_romCap = 0;
static uint16_t* s_fb = nullptr;
static uint8_t* s_state = nullptr;
static int16_t* s_pcm = nullptr;
static uint32_t s_pcmLen = 0;
static uint32_t s_romCrc = 0;
static bool s_loaded = false;
static bool s_audioOn = true;
static uint32_t s_perfEmu = 0;
static uint32_t s_perfScale = 0;
static uint32_t s_perfPpu = 0;
static uint32_t s_perfApu = 0;
static emu::Scaler s_scaler CLRN_FAST;

// audio: ultimo sampleOffset lido do DSP + fase do interpolador 32 kHz -> 44,1
static uint16_t s_dspRead = 0;
static uint32_t s_phase = 0;  // 16.16 entre o sample anterior e o atual
static int32_t s_prevSample = 0;

static emu::ScreenComposer s_screen;
static uint16_t s_lineBase[emu::ScreenComposer::kMaxW] CLRN_FAST;
static uint16_t s_lineMix[emu::ScreenComposer::kMaxW] CLRN_FAST;
static uint16_t s_col[emu::ScreenComposer::kMaxSrcW + 1] CLRN_FAST;
static uint32_t s_sinkCycles = 0;

// CRC32 por tabela (o emu_crc32 bit a bit levava 700 ms nos 2,5 MB do Mario)
static uint32_t s_crcTab[256];
static uint32_t romCrc32(const uint8_t* p, uint32_t n)
{
    if (s_crcTab[1] == 0) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (uint32_t)(-(int32_t)(c & 1u)));
            s_crcTab[i] = c;
        }
    }
    uint32_t crc = 0xFFFFFFFFu;
    while (n--) crc = s_crcTab[(crc ^ *p++) & 0xFFu] ^ (crc >> 8);
    return ~crc;
}

static void screenSink(void*, int y, const uint16_t* line)
{
    const uint32_t c0 = ccount();
    if (y < kSrcH) s_screen.row(y, line);
    s_sinkCycles += ccount() - c0;
}

// Interpola o que o DSP produziu desde o ultimo quadro (32040 Hz estereo)
// para PCM16 mono a 44,1 kHz, linear. Passo 16.16 = 32040/44100.
static void pullAudio()
{
    Dsp* dsp = s_snes->apu->dsp;
    uint16_t now = dsp->sampleOffset;
    uint16_t n = (uint16_t)(now - s_dspRead);
    if (n > 0x3ff) {  // atraso maior que o anel: descarta o excesso
        s_dspRead = (uint16_t)(now - 0x3ff);
        n = 0x3ff;
    }
    s_pcmLen = 0;
    if (!s_audioOn) {
        s_dspRead = now;
        return;
    }
    constexpr uint32_t kStep = (uint32_t)((32040ull << 16) / kOutRate);
    const uint32_t cap = kPcmCap / 2;
    uint32_t out = 0;
    for (uint16_t i = 0; i < n; i++) {
        const int16_t* sp = &dsp->sampleBuffer[((s_dspRead + i) & 0x3ff) * 2];
        const int32_t cur = ((int32_t)sp[0] + (int32_t)sp[1]) >> 1;
        // emite os samples de saida que caem entre prev e cur
        while (s_phase < 0x10000u && out < cap) {
            const int32_t v = s_prevSample + (((cur - s_prevSample) * (int32_t)(s_phase >> 4)) >> 12);
            s_pcm[out++] = (int16_t)v;
            s_phase += kStep;
        }
        s_phase -= 0x10000u;
        s_prevSample = cur;
    }
    s_dspRead = now;
    s_pcmLen = out * 2u;
}

static void setButtons(int32_t arg)
{
    const uint32_t bits = ((uint32_t)arg & 0xFFu) | ((((uint32_t)arg >> 16) & 0xFu) << 8);
    s_snes->input1->currentState = (uint16_t)bits;
}

#if defined(__XTENSA__)
static uint32_t s_prof[4];
#endif

static uint32_t runFrame(int32_t arg, bool render)
{
    setButtons(arg);
#if defined(__XTENSA__)
    snes_prof[0] = snes_prof[1] = snes_prof[2] = snes_prof[3] = 0;
#endif
    s_snes->ppu->renderOn = render;
    const uint32_t a0 = s_snes->apu->cycles;
    const uint32_t c0 = ccount();
    snes_runFrame(s_snes);
    const uint32_t c1 = ccount();
    s_perfApu = s_snes->apu->cycles - a0;
#if defined(__XTENSA__)
    for (int i = 0; i < 4; i++) s_prof[i] = snes_prof[i];
#endif
    pullAudio();
    return c1 - c0;
}

// Quadro DESENHADO no caminho direto. As linhas de trabalho ficam na
// estatica (PSRAM, cache quente): na pilha da task (RAM interna) a bancada
// nao mediu ganho nenhum — o custo e instrucao, nao escrita — e ~9 KB a
// mais na pilha da task main derrubava o aparelho com a casca aberta.
static uint32_t frameScreenRendered(const emu::NativeScreen* scr)
{
    if (!s_screen.begin(scr)) return emu::kNoTarget;
    s_sinkCycles = 0;
    s_snes->ppu->outFb = nullptr;
    s_snes->ppu->lineSink = &screenSink;
    s_snes->ppu->lineCtx = nullptr;
    const uint32_t emuCycles = runFrame(scr->arg, true);
    const uint32_t c1 = ccount();
    s_snes->ppu->lineSink = nullptr;
    s_screen.end();
    s_perfEmu = emuCycles - s_sinkCycles;
    s_perfScale = s_sinkCycles + (ccount() - c1);
    return 1;
}

}  // namespace

extern "C" uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg)
{
    switch (cmd) {
    case emu::kCtlInit: {
        uint8_t* sc = (uint8_t*)scratch;
        if (sc == nullptr) return 0;
        const uint32_t total = (uint32_t)(arg > 0 ? arg : 0) * 1024u;
        if (total <= kRomOff + 0x8000u) return 0;
        s_scratch = sc;
        s_romCap = total - kRomOff;
        if (s_romCap > kRomMax) s_romCap = kRomMax;
        s_pcm = (int16_t*)(sc + kPcmOff);
        s_fb = (uint16_t*)(sc + kFbOff);
        s_state = sc + kStateOff;
        s_rom = sc + kRomOff;
        s_pcmLen = 0;
        s_loaded = false;
        s_audioOn = true;
        s_scaler = emu::Scaler();
        s_perfEmu = s_perfScale = s_perfPpu = s_perfApu = 0;
        s_screen.init(sc, kGrabOff, kGrabCap, kStampOff, kStampCap, s_lineBase, s_lineMix, s_col);
        // structs do core (WRAM 128K, VRAM 64K, ARAM 64K...) na arena da
        // scratch; INIT de novo recria tudo do zero
        nes_arena_use(sc + kArenaOff, kArenaCap);
        s_snes = snes_init();
        if (s_snes == nullptr) return 0;
        s_snes->ppu->outFb = nullptr;
        if ((uint32_t)ppu_snapQueueBytes() <= kSnapCap) ppu_setSnapBuffer(s_snes->ppu, sc + kSnapOff);
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
        if (s_snes == nullptr || s_rom == nullptr) return 0;
        const uint32_t sz = (uint32_t)(arg > 0 ? arg : 0);
        if (sz < 0x8000u || sz > s_romCap) return 0;
        s_pcmLen = 0;
        s_romCrc = romCrc32(s_rom, sz);
        s_loaded = snes_loadRom(s_snes, s_rom, (int)sz);
        s_dspRead = s_snes->apu->dsp->sampleOffset;
        s_phase = 0;
        s_prevSample = 0;
        return s_loaded ? 1u : 0u;
    }
    case emu::kCtlReset:
        if (!s_loaded) return 0;
        s_pcmLen = 0;
        snes_reset(s_snes, false);
        return 1;
    case emu::kCtlFrame: {
        if (!s_loaded) return 0;
        const bool render = emu::emuFrameRender(arg);
        s_snes->ppu->outFb = render ? s_fb : nullptr;
        s_snes->ppu->lineSink = nullptr;
        s_screen.invalidate();  // o vidro vai receber o caminho antigo
        s_perfEmu = runFrame(arg, render);
        const uint32_t c1 = ccount();
        if (render && s_scaler.ready()) s_scaler.scale(s_fb, kSrcW);
        s_perfScale = ccount() - c1;
        return 1;
    }
    case emu::kCtlSaveState: {
        if (!s_loaded || s_state == nullptr) return 0;
        // container CEMU (console + CRC da ROM) com o estado do LakeSnes numa
        // secao: u32 tamanho + bytes, serializados direto no buffer
        emu::StateWriter w(s_state, kStateCap, emu::kConsoleSnes, s_romCrc);
        w.begin(emu::kTagBus);
        uint8_t* p = w.cursor();
        const uint32_t room = w.room();
        if (p == nullptr || room < 8) return 0;
        const int n = snes_saveStateTo(s_snes, p + 4, (int)(room - 4));
        if (n <= 0) return 0;
        emu_wr32(p, (uint32_t)n);
        w.advance(4u + (uint32_t)n);
        w.end();
        return w.finish();
    }
    case emu::kCtlLoadState: {
        if (!s_loaded || s_state == nullptr) return 0;
        const uint32_t len = (uint32_t)(arg > 0 ? arg : 0);
        if (len == 0 || len > kStateCap) return 0;
        emu::StateReader r(s_state, len, emu::kConsoleSnes, s_romCrc);
        if (!r.ok() || !r.find(emu::kTagBus)) return 0;
        const uint32_t n = r.u32();
        const uint8_t* p = r.ptr(n);
        if (!r.ok() || p == nullptr) return 0;
        return snes_loadState(s_snes, (uint8_t*)p, (int)n) ? 1u : 0u;
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
        // o compositor direto aceita qualquer tamanho; o buffer do caminho
        // antigo so existe se couber no resto da uniao
        s_screen.setScale(kSrcW, kSrcH, (int)w, (int)h);
        if (w * h * 2u > kScaledCap ||
            !s_scaler.configure(kSrcW, kSrcH, (int)w, (int)h, (uint16_t*)(s_scratch + kScaledOff))) {
            s_scaler = emu::Scaler();
            return 0;
        }
        return kScaledOff;
    }
    case emu::kCtlSetAudio:
        s_audioOn = arg != 0;
        return 1;
    case emu::kCtlPerf:
        return arg == 0 ? s_perfEmu : s_perfScale;
    case emu::kCtlFrameScreen: {
        const emu::NativeScreen* scr = (const emu::NativeScreen*)(uintptr_t)(uint32_t)arg;
        if (!s_loaded || scr == nullptr) return emu::kNoTarget;
        const bool render = emu::emuFrameRender(scr->arg);
        if (!render) {
            s_snes->ppu->lineSink = nullptr;
            s_perfEmu = runFrame(scr->arg, false);
            s_perfScale = 0;
            return 1;
        }
        return frameScreenRendered(scr);
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
    case 20:  // SRAM_OFF
        if (!s_loaded || s_snes->cart->ram == nullptr) return 0;
        return (uint32_t)(s_snes->cart->ram - s_scratch);
    case 21:  // SRAM_SIZE
        return s_loaded ? s_snes->cart->ramSize : 0;
    case 22:  // INFO
        return s_loaded ? ((s_snes->palTiming ? 1u : 0u) | ((uint32_t)s_snes->cart->type << 8)) : 0;
    case 25: {  // SRAM_SUM: checksum barato da SRAM (a casca grava o .srm quando muda)
        if (!s_loaded || s_snes->cart->ram == nullptr) return 0;
        const uint8_t* p = s_snes->cart->ram;
        uint32_t h = 2166136261u;
        for (uint32_t i = 0; i < s_snes->cart->ramSize; i++) h = (h ^ p[i]) * 16777619u;
        return h;
    }
    case 24:  // STAMP_USED (bytes da area de carimbos; dimensiona o layout)
        return s_screen.stampUsed();
    case 26: {  // DIAG (bancada): 0 = endereco da pilha; 1 = escrita 1 KB x64 na
                //   pilha; 2 = idem na regiao fast; 3 = leitura 64 KB da VRAM;
                //   4 = endereco da regiao fast; 5 = endereco da VRAM
        volatile uint32_t local[256];
        if (arg == 0) return (uint32_t)(uintptr_t)&local[0];
        if (arg == 4) return (uint32_t)(uintptr_t)&s_lineBase[0];
        if (arg == 5) return s_snes ? (uint32_t)(uintptr_t)&s_snes->ppu->vram[0] : 0;
        if ((arg == 6 || arg == 7 || arg == 8) && s_loaded) {
            // 6: ciclos da 1a execucao da linha 100; 7: media das 9 seguintes
            // (cache quente); 8: idem so com o laco de composicao (prof 3)
            void (*sink)(void*, int, const uint16_t*) = s_snes->ppu->lineSink;
            s_snes->ppu->lineSink = nullptr;
            uint32_t first = 0, rest = 0, comp = 0;
            for (int k = 0; k < 10; k++) {
                snes_prof[3] = 0;
                const uint32_t t0 = ccount();
                ppu_runLineImpl(s_snes->ppu, 100);
                const uint32_t d = ccount() - t0;
                if (k == 0) first = d; else { rest += d; comp += snes_prof[3]; }
            }
            s_snes->ppu->lineSink = sink;
            return arg == 6 ? first : arg == 7 ? rest / 9 : comp / 9;
        }
        if (arg == 9) {
            // laco aritmetico puro: 100k iteracoes (ciclos/iter = CPI do blob)
            uint32_t a = 1, b = 3;
            const uint32_t t0 = ccount();
            for (int i = 0; i < 100000; i++) {
                a = a * 1664525u + b;
                b ^= a >> 7;
                __asm__ volatile("" : "+r"(a), "+r"(b));
            }
            local[0] = a + b;
            return ccount() - t0;
        }
        const uint32_t c0 = ccount();
        if (arg == 1) {
            for (int r = 0; r < 64; r++)
                for (int i = 0; i < 256; i++) local[i] = (uint32_t)(i + r);
        } else if (arg == 2) {
            volatile uint32_t* f = (volatile uint32_t*)s_lineBase;
            for (int r = 0; r < 64; r++)
                for (int i = 0; i < 256; i++) f[i] = (uint32_t)(i + r);
        } else if (arg == 3 && s_snes) {
            volatile const uint16_t* v = s_snes->ppu->vram;
            uint32_t acc = 0;
            for (int i = 0; i < 0x8000; i += 1) acc += v[(i * 97) & 0x7fff];
            local[0] = acc;
        }
        return ccount() - c0;
    }
    case 23:  // PERF_PART: 0 ppu, 1 apu, 2 dma (ciclos do ultimo quadro), 3 ciclos SPC
#if defined(__XTENSA__)
        if (arg >= 0 && arg < 3) return s_prof[arg];
        if (arg == 4) return s_prof[3];
#endif
        return arg == 3 ? s_perfApu : 0;
    default:
        return 0;
    }
}
