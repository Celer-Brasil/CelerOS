// TU unico do emulador NES como blob nativo CLRN v2 (app Anemoia).
//
// Este arquivo e o FONTE do blob (celer.js native / build_core.py): inclui o
// runtime freestanding, o nucleo Anemoia (unity) e a fachada Nes, e expoe a
// UNICA entrada do blob: core_ctl(scratch, cmd, args).
//
// Layout: o estado QUENTE (objeto Nes, linhas de composicao, tabelas da
// escala) fica no .bss em CLRN_FAST (RAM interna quando o loader tem folga);
// os buffers grandes (ROM, PCM, framebuffer, savestate, arena, carimbos) na
// SCRATCH, com os offsets devolvidos por core_ctl — o app nunca hardcoda.
//
// Vidro (API 60): FRAME_SCREEN compoe o quadro escalado + overlay DIRETO no
// framebuffer do painel, linha a linha a partir do bloco de scanlines da
// PPU, e so reescreve as linhas que mudaram (hash por linha NES + assinatura
// dos carimbos). Compositor comum em common/emu_screen.h: o alvo pode ser o
// vidro inteiro (quadro centrado, faixas pretas, carimbos fora do quadro). Bancada 4848 (SMB, 480x450, audio ligado): 16 fps com o
// caminho FRAME + nativeDraw + overlay em JS -> 52-60 fps.
//
// Comandos (core_ctl(scratch, cmd, arg)):
//   0 INIT         arg = tamanho da scratch em KB; (re)inicializa arena e
//                  estado; devolve a capacidade de ROM em bytes (0 = a
//                  scratch nem cobre o layout fixo)
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
//  13 SET_AUDIO    arg != 0 liga a APU (default); 0 tira o tick dela do laco
//  12 SET_SCALE    arg = (dstW << 16) | dstH (0 desliga): o FRAME tambem
//                  ESCALA o framebuffer 256x240 por nearest para
//                  SCALED_OFF, na resolucao pedida (teto 512x512) e
//                  devolve o offset. O app desenha por nativeDraw 1:1 na
//                  tela cheia — escalar em C++ custa ~1/8 do drawSprite
//                  com zoom (pushRotateZoom por pixel).
//  14 PERF         arg 0 = ciclos de CPU (ccount) da emulacao do ultimo
//                  FRAME, 1 = da escala; diagnostico de bancada.
//  15 FRAME_SCREEN via System.nativeScreen (API 60): arg = NativeScreen*
//                  (pixel do alvo, stride, w, h, arg = buttons|render<<8).
//                  Roda o quadro e, se render, ESCALA + compoe os carimbos
//                  do overlay linha a linha num buffer interno e escreve
//                  cada linha UMA vez no alvo (framebuffer do painel ou
//                  quadro do app) — uma passada de PSRAM em vez de tres.
//  16 GRAB_OFF     arg 0/1 -> offset do grab sobre PRETO/BRANCO (nativeGrab)
//  17 STAMP_MAKE   arg = id | w << 5 | h << 15: monta o carimbo `id` dos
//                  dois grabs (w x h): alpha sai da diferenca preto/branco,
//                  a cor pre-multiplicada do grab sobre preto. 1/0
//  18 STAMP_PLACE  arg = slot | id << 4 | (x+256) << 10 | (y+256) << 20,
//                  x/y relativos ao retangulo do FRAME_SCREEN; id 63 = slot
//                  vazio. Ate 8 slots, compostos em ordem de slot.
//  19 STAMP_RESET  esvazia slots e carimbos
//
// A APU roda INLINE no frame (o blob nao tem task), em lote (Apu2A03::clockN):
// o sink grava no buffer de PCM da scratch e o app drena por nativeAudio.

#define NES_BLOB 1
// common/emu_screen.h (compositor) usa o shim freestanding dos cores
#define EMU_BLOB 1
// a arena real e a da SCRATCH (nes_arena_use no INIT): o fallback estatico
// so ocuparia .bss
#define CORE_ARENA_BYTES (1u * 1024u)

#include "../runtime.c"
#include "../runtime_new.hpp"

#include "../common/emu_core.h"
#include "../common/emu_screen.h"
#include "NesCore.cpp"
#include "Nes.cpp"

// Gate da APU (cpu6502.h): fora do namespace anonimo — o header declara
// `extern bool` e o linker precisa do mesmo (linkage externo).
bool g_blob_apu_on = true;

namespace {

// --- memoria do emulador no .bss do blob (o loader zera o .bss no load) ---
// O construtor de Nes (e os de Cpu6502/Bus/Ppu por dentro) NAO roda sozinho
// no blob: sem crt/.init_array ninguem chama os construtores estaticos. O
// buffer e construido UMA vez pelo core_ctl(INIT) com placement-new.
// CLRN_FAST: o objeto Nes (CPU/PPU/APU/RAM do console, bloco de scanlines)
// e o estado mais acessado do blob — o loader API 60 o poe na RAM interna.
alignas(nes::Nes) static uint8_t s_nes_mem[sizeof(nes::Nes)] CLRN_FAST;
static nes::Nes* s_nes;
// Layout da SCRATCH (PSRAM, bloco do app). Os comandos core_ctl devolvem
// os offsets; o app usa os valores devolvidos, nunca numeros.
//   PCM 8K | FB 120K | ESCALADO 450K | STATE 40K | ARENA 64K |
//   CARIMBOS 640K | ROM (o resto)
// A ROM vem por ULTIMO e ocupa o que sobrar: o app pede a scratch do
// tamanho da ROM dele (INIT recebe o tamanho em KB e devolve a capacidade
// de ROM) — um teto fixo de 1 MB fazia o bloco de ~2,4 MB nao caber na
// PSRAM fragmentada depois de alguns jogos.
constexpr uint32_t kPcmOff = 0;
constexpr uint32_t kPcmCap = 8 * 1024;               // ~5 quadros de PCM
constexpr uint32_t kFbOff = kPcmOff + kPcmCap;
constexpr uint32_t kFbCap = nes::SCREEN_W * nes::SCREEN_H * 2;
constexpr uint32_t kScaledOff = kFbOff + kFbCap;
constexpr uint32_t kScaledCap = 480 * 480 * 2;       // maior vidro: 4848 480x480
constexpr uint32_t kStateOff = kScaledOff + kScaledCap;
constexpr uint32_t kStateCap = 40 * 1024;            // savestate ~6-20KB
constexpr uint32_t kArenaOff = kStateOff + kStateCap;
constexpr uint32_t kArenaCap = 64 * 1024;            // cart+mappers (carga)
// Carimbos do overlay (FRAME_SCREEN): u32 por pixel + spans por linha. Os
// grabs preto/branco usam a area do ESCALADO (so o caminho antigo a usa e
// a captura acontece antes do jogo rodar).
constexpr uint32_t kStampOff = kArenaOff + kArenaCap;
constexpr uint32_t kStampCap = 640 * 1024;           // ~15 carimbos do Anemoia: ~470 KB
constexpr uint32_t kGrabCap = kScaledCap / 2;        // 240x240 por grab
constexpr uint32_t kRomOff = kStampOff + kStampCap;  // ~1,3 MB fixos antes da ROM
uint32_t s_romCap = 0;                               // definido no INIT

uint16_t* s_fb;
uint8_t* s_rom;
uint8_t* s_state;
uint8_t* s_pcm;
uint32_t s_pcm_len;
uint16_t* s_scaled;          // framebuffer ESCALADO (saida para o vidro)
int s_scaleW = 0, s_scaleH = 0;
// limite de coluna por pixel de origem: a divisao inteira do nearest fica
// FORA do laco quente (no Xtensa a divisao e software, ~dezenas de ciclos —
// 256 por linha custavam ~20 ms por quadro)
uint16_t s_colStart[nes::SCREEN_W + 1];

// Nearest-neighbor por RUNS: le cada pixel da origem uma vez e escreve a
// faixa de destino correspondente (escrita sequencial). 480x450 saiu de
// ~25 ms (pushRotateZoom no JS) para ~3 ms aqui.
void scaleFrame()
{
    if (s_scaled == nullptr || s_scaleW <= 0 || s_scaleH <= 0) return;
    const int sw = nes::SCREEN_W, sh = nes::SCREEN_H;
    for (int y = 0; y < s_scaleH; y++) {
        const int sy = (y * sh) / s_scaleH;
        const uint16_t* src = s_fb + (size_t)sy * sw;
        uint16_t* dst = s_scaled + (size_t)y * s_scaleW;
        int x = 0;
        for (int sx = 0; sx < sw; sx++) {
            const int next = s_colStart[sx + 1];
            const uint16_t px = src[sx];
            while (x < next) dst[x++] = px;
        }
        while (x < s_scaleW) dst[x++] = src[sw - 1];
    }
}

uint32_t s_perfEmu, s_perfScale;
inline uint32_t ccount()
{
    uint32_t c;
    __asm__ volatile("rsr.ccount %0" : "=a"(c));
    return c;
}

// ---- FRAME_SCREEN: escala + overlay por linha ----------------------------
// Compositor comum (common/emu_screen.h, o mesmo do Atari): o alvo pode ser
// o VIDRO INTEIRO — o quadro escalado fica centrado, as faixas saem pretas
// daqui e os carimbos do overlay podem ficar fora do retangulo do jogo.
// Linhas montadas na RAM interna; linha que nao mudou nao e reescrita.
// o objeto inteiro (hash/assinatura por linha) na RAM interna: no NES toda
// linha muda quando a tela rola e esse estado e lido por linha do alvo
emu::ScreenComposer s_screen CLRN_FAST;
uint16_t s_lineBase[emu::ScreenComposer::kMaxW] CLRN_FAST;  // linha escalada
uint16_t s_lineMix[emu::ScreenComposer::kMaxW] CLRN_FAST;   // + carimbos
uint16_t s_scrCol[emu::ScreenComposer::kMaxSrcW + 1] CLRN_FAST;
uint32_t s_sinkCycles;

// Sink da PPU no FRAME_SCREEN: o bloco de scanlines (RAM do objeto Nes)
// vai direto ao alvo — sem o framebuffer 256x240 intermediario na PSRAM.
void screenSink(void*, const uint16_t* rows, int y, int nrows)
{
    const uint32_t c0 = ccount();
    for (int i = 0; i < nrows; i++) s_screen.row(y + i, rows + (size_t)i * nes::SCREEN_W);
    s_sinkCycles += ccount() - c0;
}

// Sink do FRAME classico: blocos -> framebuffer 256x240 da scratch.
void fbSinkBlob(void*, const uint16_t* rows, int y, int nrows)
{
    if (s_fb == nullptr || y < 0 || nrows <= 0) return;
    if (y + nrows > nes::SCREEN_H) nrows = nes::SCREEN_H - y;
    memcpy(s_fb + (size_t)y * nes::SCREEN_W, rows, (size_t)nrows * nes::SCREEN_W * 2);
}

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
    CORE_SET_SCALE,
    CORE_SET_AUDIO,
    CORE_PERF,
    CORE_FRAME_SCREEN,
    CORE_GRAB_OFF,
    CORE_STAMP_MAKE,
    CORE_STAMP_PLACE,
    CORE_STAMP_RESET,
};
}  // namespace

extern "C" uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg)
{
    switch (cmd) {
    case CORE_INIT: {
        uint8_t* sc = (uint8_t*)scratch;
        if (sc == nullptr) return 0;
        const uint32_t total = (uint32_t)(arg > 0 ? arg : 0) * 1024u;
        if (total <= kRomOff) return 0;
        s_romCap = total - kRomOff;
        if (s_romCap > nes::MAX_ROM_SIZE) s_romCap = nes::MAX_ROM_SIZE;
        s_rom = sc + kRomOff;
        s_pcm = sc + kPcmOff;
        s_fb = (uint16_t*)(sc + kFbOff);
        s_state = sc + kStateOff;
        s_scaled = (uint16_t*)(sc + kScaledOff);
        s_scaleW = s_scaleH = 0;
        s_screen.init(sc, kScaledOff, kGrabCap, kStampOff, kStampCap, s_lineBase, s_lineMix,
                      s_scrCol);
        nes_arena_use(sc + kArenaOff, kArenaCap);  // cart/mappers na PSRAM (carga)
        if (s_nes == nullptr) s_nes = ::new (static_cast<void*>(s_nes_mem)) nes::Nes();
        nes::g_blob_fb = s_fb;  // Nes::openScreen usa este ponteiro
        s_nes->setAudioSink(&pcmSink);  // PCM -> s_pcm (drenado pelo app)
        s_pcm_len = 0;
        return s_romCap;
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
        if (sz == 0 || sz > s_romCap) return 0;
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
        s_nes->setChunkSink(&fbSinkBlob, nullptr);
        s_screen.invalidate();  // o vidro vai receber o caminho antigo
        const uint32_t c0 = ccount();
        s_nes->frame(buttons, render);
        const uint32_t c1 = ccount();
        if (render) scaleFrame();  // o app desenha o buffer escalado
        s_perfEmu = c1 - c0;
        s_perfScale = ccount() - c1;
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
    case CORE_SET_AUDIO:
        g_blob_apu_on = arg != 0;
        return 1;
    case CORE_SET_SCALE: {
        uint32_t w = ((uint32_t)arg >> 16) & 0xFFFFu;
        uint32_t h = (uint32_t)arg & 0xFFFFu;
        if (w == 0 || h == 0) { s_scaleW = s_scaleH = 0; return 0; }
        if (w > 512 || h > 512) return 0;
        if ((size_t)w * h * 2 > kScaledCap) return 0;
        s_scaleW = (int)w;
        s_scaleH = (int)h;
        for (int sx = 0; sx <= nes::SCREEN_W; sx++)
            s_colStart[sx] = (uint16_t)(((uint32_t)sx * w) / nes::SCREEN_W);
        s_screen.setScale(nes::SCREEN_W, nes::SCREEN_H, (int)w, (int)h);
        return kScaledOff;
    }
    case CORE_FRAME_SCREEN: {
        // arg = NativeScreen* (pixel do alvo, stride, w, h, arg do app)
        const emu::NativeScreen* scr = (const emu::NativeScreen*)(uintptr_t)(uint32_t)arg;
        if (scr == nullptr) return emu::kNoTarget;
        uint8_t buttons = (uint8_t)((uint32_t)scr->arg & 0xFFu);
        bool render = (((uint32_t)scr->arg >> 8) & 1u) != 0;
        // alvo/geometria invalidos: o app cai no FRAME + nativeDraw
        if (render && !s_screen.begin(scr)) return emu::kNoTarget;
        s_pcm_len = 0;
        s_sinkCycles = 0;
        s_nes->setChunkSink(&screenSink, nullptr);
        const uint32_t c0 = ccount();
        s_nes->frame(buttons, render);
        const uint32_t c1 = ccount();
        if (render) s_screen.end();
        s_perfEmu = c1 - c0 - s_sinkCycles;
        s_perfScale = s_sinkCycles + (ccount() - c1);
        return 1;
    }
    case CORE_GRAB_OFF:
        return s_screen.grabOff(arg);
    case CORE_STAMP_MAKE:
        return s_screen.stampMake(arg & 31, (arg >> 5) & 1023, (arg >> 15) & 1023) ? 1u : 0u;
    case CORE_STAMP_PLACE:
        return s_screen.stampPlace(arg) ? 1u : 0u;
    case CORE_STAMP_RESET:
        s_screen.stampReset();
        return 1;
    case CORE_PERF:
        return arg == 0 ? s_perfEmu : s_perfScale;
    default:
        return 0;
    }
}
