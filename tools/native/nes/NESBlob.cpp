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
// dos carimbos). Bancada 4848 (SMB, 480x450, audio ligado): 16 fps com o
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
// a arena real e a da SCRATCH (nes_arena_use no INIT): o fallback estatico
// so ocuparia .bss
#define CORE_ARENA_BYTES (1u * 1024u)

#include "../runtime.c"
#include "../runtime_new.hpp"

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
struct NativeScreen {  // espelho do JsNative.cpp (API 60)
    uint16_t* px;
    int32_t stride;
    int32_t w;
    int32_t h;
    int32_t arg;
    int32_t flags;
    // linha pronta para o firmware (GDMA no painel); nullptr = memcpy aqui
    void (*put)(void* ctx, int32_t y, const uint16_t* src);
    void* putCtx;
};
struct Stamp {
    uint32_t off;  // na scratch: indice u32[h+1] (1o run de cada linha) + runs
    uint16_t w, h;
};
// Carimbo em RUNS de pixels iguais: os controles sao preenchimentos lisos,
// aneis e texto — poucos runs por linha. Pixel a pixel (4 B cada, ~50 mil
// por quadro) a composicao lia ~200 KB de PSRAM em cache misses; em runs le
// poucos KB e o run opaco vira preenchimento.
struct Run {
    uint16_t x, len;
    uint32_t v;  // cor pre-multiplicada espalhada | ia << 27 (0 = transparente)
};
struct Slot {
    int8_t id;  // -1 = vazio
    int16_t x, y;
};
constexpr int kMaxStamps = 32;
constexpr int kMaxSlots = 8;
uint8_t* s_scratch;
Stamp s_stamps[kMaxStamps] CLRN_FAST;
Slot s_slots[kMaxSlots] CLRN_FAST;
uint32_t s_stampTop;
int s_scrW = 0, s_scrH = 0;
uint16_t s_scrCol[nes::SCREEN_W + 1] CLRN_FAST;  // limite de coluna no alvo
uint16_t s_scrY0[nes::SCREEN_H + 1] CLRN_FAST;   // 1a linha do alvo por linha NES
uint16_t s_lineBase[512] CLRN_FAST;              // linha escalada
uint16_t s_lineMix[512] CLRN_FAST;               // + carimbos
// Linhas que nao mudaram nao sao reescritas no alvo: hash da linha NES do
// quadro anterior e assinatura dos carimbos que cobriram cada linha do alvo
// (carimbo que entra, sai, troca ou anda muda a assinatura). O ceu do SMB e
// igual quadro a quadro mesmo rolando a tela.
uint32_t s_rowHash[nes::SCREEN_H] CLRN_FAST;
uint32_t s_rowSig[512] CLRN_FAST;
const NativeScreen* s_curScr;  // alvo do FRAME_SCREEN em curso
bool s_force = true;           // proximo quadro reescreve tudo
int s_lastTarget = -1;         // flags&1 do ultimo FRAME_SCREEN
uint32_t s_sinkCycles;

inline uint32_t spread565(uint32_t c) { return (c | (c << 16)) & 0x07E0F81Fu; }

// Mistura um run (u32: cor pre-multiplicada espalhada | ia << 27) numa
// linha em bytes TROCADOS: out = pm + d * ia / 32; ia 0 = opaco (fill).
void blendRun(uint16_t* line, uint32_t v, int n)
{
    const uint32_t ia = v >> 27;
    const uint32_t pm = v & 0x07E0F81Fu;
    if (ia == 0) {
        const uint16_t c = (uint16_t)__builtin_bswap16((uint16_t)(pm | (pm >> 16)));
        for (int i = 0; i < n; i++) line[i] = c;
        return;
    }
    for (int i = 0; i < n; i++) {
        const uint32_t d = __builtin_bswap16(line[i]);
        uint32_t r = pm + (((spread565(d) * ia) >> 5) & 0x07E0F81Fu);
        r &= 0x07E0F81Fu;
        line[i] = (uint16_t)__builtin_bswap16((uint16_t)(r | (r >> 16)));
    }
}

void screenGeom(int w, int h)
{
    if (w == s_scrW && h == s_scrH) return;
    s_scrW = w;
    s_scrH = h;
    for (int sx = 0; sx <= nes::SCREEN_W; sx++)
        s_scrCol[sx] = (uint16_t)(((uint32_t)sx * w) / nes::SCREEN_W);
    // linha do alvo y mostra a linha NES y*240/h: a faixa de sy comeca no
    // menor y com y*240/h >= sy
    for (int sy = 0; sy <= nes::SCREEN_H; sy++)
        s_scrY0[sy] = (uint16_t)(((uint32_t)sy * h + nes::SCREEN_H - 1) / nes::SCREEN_H);
    s_force = true;
}

inline uint32_t rowHash(const uint16_t* src)
{
    const uint32_t* p = (const uint32_t*)src;
    uint32_t h = 2166136261u;
    for (int i = 0; i < nes::SCREEN_W / 2; i++) h = (h ^ p[i]) * 16777619u;
    return h;
}

// Uma linha NES -> as linhas do alvo que a mostram (480x450: ~2). Cada
// linha do alvo e montada na RAM interna (escala + carimbos) e escrita UMA
// vez — ou nenhuma, se nada mudou nela.
void composeRow(int sy, const uint16_t* src)
{
    const NativeScreen* scr = s_curScr;
    const int w = scr->w;
    const uint32_t hsh = rowHash(src);
    const bool changed = s_force || hsh != s_rowHash[sy];
    s_rowHash[sy] = hsh;
    bool built = false;
    for (int y = s_scrY0[sy], ye = s_scrY0[sy + 1]; y < ye; y++) {
        uint32_t sig = 0;
        for (int k = 0; k < kMaxSlots; k++) {
            const Slot& sl = s_slots[k];
            if (sl.id < 0 || y < sl.y || y >= sl.y + s_stamps[sl.id].h) continue;
            sig = (sig ^ ((uint32_t)(k + 1) << 28) ^ ((uint32_t)sl.id << 22) ^
                   ((uint32_t)(sl.x + 256) << 11) ^ (uint32_t)(y - sl.y)) * 16777619u;
            sig |= 1u;  // linha com carimbo nunca tem assinatura 0
        }
        const bool stamped = sig != 0;
        if (!changed && sig == s_rowSig[y]) continue;
        if (!built) {
            int x = 0;
            for (int sx = 0; sx < nes::SCREEN_W; sx++) {
                const int next = s_scrCol[sx + 1];
                const uint16_t px = src[sx];
                while (x < next) s_lineBase[x++] = px;
            }
            built = true;
        }
        const uint16_t* out = s_lineBase;
        if (stamped) {
            memcpy(s_lineMix, s_lineBase, (size_t)w * 2);
            for (int k = 0; k < kMaxSlots; k++) {
                const Slot& sl = s_slots[k];
                if (sl.id < 0) continue;
                const Stamp& st = s_stamps[sl.id];
                const int ry = y - sl.y;
                if (ry < 0 || ry >= st.h) continue;
                const uint32_t* idx = (const uint32_t*)(s_scratch + st.off);
                const Run* runs = (const Run*)(s_scratch + st.off + 4u * (st.h + 1u));
                for (uint32_t r = idx[ry], re = idx[ry + 1]; r < re; r++) {
                    int x0 = sl.x + runs[r].x, x1 = x0 + runs[r].len;
                    if (x0 < 0) x0 = 0;
                    if (x1 > w) x1 = w;
                    if (x0 < x1) blendRun(s_lineMix + x0, runs[r].v, x1 - x0);
                }
            }
            out = s_lineMix;
        }
        s_rowSig[y] = sig;
        if (scr->put != nullptr) scr->put(scr->putCtx, y, out);
        else memcpy(scr->px + (size_t)y * scr->stride, out, (size_t)w * 2);
    }
}

// Sink da PPU no FRAME_SCREEN: o bloco de scanlines (RAM do objeto Nes)
// vai direto ao alvo — sem o framebuffer 256x240 intermediario na PSRAM.
void screenSink(void*, const uint16_t* rows, int y, int nrows)
{
    const uint32_t c0 = ccount();
    for (int i = 0; i < nrows; i++) {
        if (y + i >= 0 && y + i < nes::SCREEN_H)
            composeRow(y + i, rows + (size_t)i * nes::SCREEN_W);
    }
    s_sinkCycles += ccount() - c0;
}

// Sink do FRAME classico: blocos -> framebuffer 256x240 da scratch.
void fbSinkBlob(void*, const uint16_t* rows, int y, int nrows)
{
    if (s_fb == nullptr || y < 0 || nrows <= 0) return;
    if (y + nrows > nes::SCREEN_H) nrows = nes::SCREEN_H - y;
    memcpy(s_fb + (size_t)y * nes::SCREEN_W, rows, (size_t)nrows * nes::SCREEN_W * 2);
}

// Carimbo de dois grabs (swap565): alpha pela diferenca de verde entre o
// fundo branco e o preto; a cor sobre preto JA e a cor pre-multiplicada.
bool stampMake(int id, int w, int h)
{
    if (id < 0 || id >= kMaxStamps || w <= 0 || h <= 0) return false;
    if ((uint32_t)w * h * 2 > kGrabCap) return false;
    const uint16_t* gb = (const uint16_t*)(s_scratch + kScaledOff);
    const uint16_t* gw = (const uint16_t*)(s_scratch + kScaledOff + kGrabCap);
    const uint32_t base = kStampOff + s_stampTop;
    const uint32_t idxBytes = 4u * (h + 1u);
    if (s_stampTop + idxBytes > kStampCap) return false;
    uint32_t* idx = (uint32_t*)(s_scratch + base);
    Run* runs = (Run*)(s_scratch + base + idxBytes);
    const uint32_t maxRuns = (kStampCap - s_stampTop - idxBytes) / sizeof(Run);
    uint32_t nr = 0;
    for (int y = 0; y < h; y++) {
        idx[y] = nr;
        for (int x = 0; x < w; x++) {
            const uint32_t b = __builtin_bswap16(gb[y * w + x]);
            const uint32_t wv = __builtin_bswap16(gw[y * w + x]);
            int diff = (int)((wv >> 5) & 63) - (int)((b >> 5) & 63);
            if (diff < 0) diff = 0;
            const int a5 = ((63 - diff) * 32 + 31) / 63;  // 0..32
            if (a5 <= 0) continue;  // transparente: fora dos runs
            const uint32_t v = spread565(b) | ((uint32_t)(32 - (a5 > 32 ? 32 : a5)) << 27);
            if (nr > idx[y] && runs[nr - 1].v == v && runs[nr - 1].x + runs[nr - 1].len == x) {
                runs[nr - 1].len++;
                continue;
            }
            if (nr >= maxRuns) return false;
            runs[nr].x = (uint16_t)x;
            runs[nr].len = 1;
            runs[nr].v = v;
            nr++;
        }
    }
    idx[h] = nr;
    Stamp& st = s_stamps[id];
    st.off = base;
    st.w = (uint16_t)w;
    st.h = (uint16_t)h;
    s_stampTop += (idxBytes + nr * (uint32_t)sizeof(Run) + 7u) & ~7u;
    return true;
}

void stampReset()
{
    for (int k = 0; k < kMaxSlots; k++) s_slots[k].id = -1;
    for (int i = 0; i < kMaxStamps; i++) s_stamps[i].w = s_stamps[i].h = 0;
    s_stampTop = 0;
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
        s_scratch = sc;
        stampReset();
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
        s_force = true;  // o vidro vai receber o caminho antigo
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
        return kScaledOff;
    }
    case CORE_FRAME_SCREEN: {
        const NativeScreen* scr = (const NativeScreen*)(uintptr_t)(uint32_t)arg;
        if (scr == nullptr || scr->px == nullptr || scr->w <= 0 || scr->w > 512 ||
            scr->h <= 0 || scr->h > 512)
            return 0;
        uint8_t buttons = (uint8_t)((uint32_t)scr->arg & 0xFFu);
        bool render = (((uint32_t)scr->arg >> 8) & 1u) != 0;
        s_pcm_len = 0;
        screenGeom(scr->w, scr->h);
        // alvo trocou (painel <-> quadro do app) ou o vidro foi pintado por
        // fora desde o ultimo quadro (flags bit1, do firmware): tudo de novo
        if ((scr->flags & 2) || (scr->flags & 1) != s_lastTarget) s_force = true;
        s_lastTarget = scr->flags & 1;
        s_curScr = scr;
        s_sinkCycles = 0;
        s_nes->setChunkSink(&screenSink, nullptr);
        const uint32_t c0 = ccount();
        s_nes->frame(buttons, render);
        const uint32_t c1 = ccount();
        s_curScr = nullptr;
        if (render) s_force = false;
        s_perfEmu = c1 - c0 - s_sinkCycles;
        s_perfScale = s_sinkCycles;
        return 1;
    }
    case CORE_GRAB_OFF:
        return arg == 0 ? kScaledOff : kScaledOff + kGrabCap;
    case CORE_STAMP_MAKE:
        return stampMake(arg & 31, (arg >> 5) & 1023, (arg >> 15) & 1023) ? 1u : 0u;
    case CORE_STAMP_PLACE: {
        const int slot = arg & 15, id = (arg >> 4) & 63;
        if (slot >= kMaxSlots) return 0;
        if (id >= kMaxStamps || s_stamps[id].w == 0) { s_slots[slot].id = -1; return 1; }
        s_slots[slot].id = (int8_t)id;
        s_slots[slot].x = (int16_t)(((arg >> 10) & 1023) - 256);
        s_slots[slot].y = (int16_t)(((arg >> 20) & 1023) - 256);
        return 1;
    }
    case CORE_STAMP_RESET:
        stampReset();
        return 1;
    case CORE_PERF:
        return arg == 0 ? s_perfEmu : s_perfScale;
    default:
        return 0;
    }
}
