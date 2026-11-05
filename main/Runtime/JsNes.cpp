// Emulador de NES para apps JS (objeto Nes, API 57) sobre o nucleo Anemoia
// (GPLv3, Shim06/Anemoia-ESP32) portado em main/Nes.
//
// Por que nativo: emulador e tempo real — CPU 6502 + PPU por scanline a
// 60 Hz nao existe no Duktape do ESP32 (o interpretado nao fecha nem 20
// fps). O nucleo e C++ puro e host-testavel (test/cpp compila o MESMO TU
// com uma ROM sintetica); o JS fica so com a casca: menus, controles de
// toque, save states.
//
// Contrato do app (arquitetura do Anemoia original: APU em task propria e
// frame direto no destino, sem copia intermediaria):
//   Nes.bindFrame();                         // frame direto no quadro do Kui
//   Nes.load("/sd/roms/Jogo.nes");            // fs: ROM inteira na PSRAM
//   Nes.audioStart();                         // APU (task core 0) -> PcmFeed
//   laco: S.fillScreen(0); desenha controles; Nes.frame(btns); UI.end(60)
// Alternativa com sprite do pool (apps que querem escalar/posicionar):
//   var spr = S.createSprite(256, 240); Nes.bind(spr); ... S.pushSprite(GX, GY)
//
// Estado por app: ROM/framebuffer/audio saem no jsNesReset (init do proximo
// app e appExitCleanup). Compilado so com CONFIG_CELEROS_JS_NES (S3+PSRAM);
// nas demais placas o objeto nao existe e o app faz feature-detect.

#include "JsInternal.h"
#include "JsFsJail.h"
#include "../Nes/Nes.h"
#include "../Utils/Mem.h"
#include "../FileSystem/FileSystem.h"
#include "../Display/Display.h"
#include "../USBDevice/LogSink.h"

#if CONFIG_CELEROS_AUDIO
#include "../Hardware/AudioPlayer.h"
#endif

#include <esp_timer.h>

#include <cstdio>
#include <cstring>
#include <new>

namespace {

constexpr int kNesW = nes::SCREEN_W;
constexpr int kNesH = nes::SCREEN_H;
constexpr size_t kAudioQueueBytes = 32 * 1024;  // ~370 ms de colchao (22 quadros)

nes::Nes* s_nes = nullptr;
uint8_t* s_rom = nullptr;        // ROM inteira (o cartucho nao copia: ponteiros)
uint32_t s_romSize = 0;
CelerSprite* s_spr = nullptr;    // sprite bound (nao e dono: pool do JsGfx)
lgfx::LovyanGFX* s_sink_dst = nullptr;  // alvo do pushImage (display ou sprite)
int s_sink_x0 = 0;               // x da regiao 256 no alvo

#if CONFIG_CELEROS_AUDIO
AudioPlayer::PcmFeed* s_feed = nullptr;  // guarda de saida enquanto toca
#endif

// Entrega do quadro: a PPU ja escreve com a paleta _swap (o byte order do
// framebuffer do painel/sprite de 16 bits, rgb565_2Byte), e o ponteiro vai
// tipado como swap565_t — o pixelcopy do LovyanGFX ve origem == destino e
// copia cada linha com memcpy. Com uint16_t* cru ele convertia pixel a pixel
// (61 mil swaps por quadro, lendo e escrevendo PSRAM).
void nesPush(const uint16_t* fb)
{
    // O frame do emulador e full-screen e NAO respeita clip de app: o clip do
    // display pode estar vazio (o Kui restaura o "anterior" caixa a caixa no
    // present) e o pushImage virava no-op — o jogo rodava com a tela
    // congelada (bancada: push 2 us no Diag sem draws; ~7 ms no Anemoia).
    s_sink_dst->clearClipRect();
    // Um push por quadro (swap565: o pixelcopy vira memcpy por linha; o
    // custo e o proprio trafego de 122 KB no barramento PSRAM, que divide
    // com o scanout do LCD_CAM).
    s_sink_dst->pushImage(s_sink_x0, 0, kNesW, kNesH, reinterpret_cast<const lgfx::swap565_t*>(fb));
}

// Medidor do quadro (bancada): a cada 2 s loga fps e a media por quadro de
// emulacao (CPU+PPU), entrega ao vidro e o resto (JS + present + espera).
int64_t s_stWin = 0, s_stEnd = 0, s_stEmu = 0, s_stPush = 0, s_stRest = 0;
int s_stN = 0;
void nesStatsNote(int64_t t0, int64_t t1, int64_t t2)
{
    if (s_stEnd != 0) s_stRest += t0 - s_stEnd;
    s_stEnd = t2;
    s_stEmu += t1 - t0;
    s_stPush += t2 - t1;
    s_stN++;
    if (s_stWin == 0) s_stWin = t0;
    if (t2 - s_stWin < 2000000) return;
    const int n = s_stN;
    celer_log_printf("[nes] %d.%d fps emu %d us push %d us resto %d us\n", (int)(n * 10000000LL / (t2 - s_stWin)) / 10,
                     (int)(n * 10000000LL / (t2 - s_stWin)) % 10, (int)(s_stEmu / n), (int)(s_stPush / n),
                     (int)(s_stRest / n));
    s_stWin = t2;
    s_stEmu = s_stPush = s_stRest = 0;
    s_stN = 0;
}

// Sink da APU: 128 amostras PCM16 mono LE por chamada (~2,9 KB/quadro).
// PcmFeed::write so bloqueia com a fila cheia (22 quadros de colchao: nunca
// em regime, o player drena no I2S em task propria).
void nesAudioSink(const uint8_t* mono16le, uint32_t bytes)
{
#if CONFIG_CELEROS_AUDIO
    if (s_feed != nullptr) s_feed->write(mono16le, bytes);
#else
    (void)mono16le; (void)bytes;
#endif
}

void nesStopAudio()
{
    if (s_nes != nullptr) s_nes->apuTaskStop();  // APU para junto com o audio
#if CONFIG_CELEROS_AUDIO
    if (s_feed != nullptr) {
        // end() para o player E solta a guarda que o begin tomou (_held);
        // releaseOutput aqui soltaria a guarda de outro dono
        s_feed->end();
        delete s_feed;
        s_feed = nullptr;
    }
#endif
}

}  // namespace

// Reset por app (JSBindings::init e appExitCleanup): audio, cartucho, ROM e
// framebuffer voltam ao heap AGORA — o launcher nao carrega 400 KB de
// emulador durante um OTA push comecado logo apos a saida.
void jsNesReset()
{
    nesStopAudio();
    s_sink_dst = nullptr;
    if (s_nes != nullptr) {
        delete s_nes;
        s_nes = nullptr;
    }
    if (s_rom != nullptr) {
        heap_caps_free(s_rom);
        s_rom = nullptr;
        s_romSize = 0;
    }
    s_spr = nullptr;
}

duk_ret_t JSBindings::js_nesLoad(duk_context* ctx)
{
    const char* path = duk_require_string(ctx, 0);
    // Jail do FS: so /local e /sd (o nucleo le direto da PSRAM, sem passar
    // pela API JS de arquivos). O fopen usa o mesmo path: o VFS resolve.
    if (!fsPathAllowed(path)) {
        char msg[128];
        snprintf(msg, sizeof(msg), "fs: caminho fora do jail: %.90s", path);
        duk_error(ctx, DUK_ERR_ERROR, msg);  // pre-formatado: varargs %s em lightfunc corrompe
    }

    jsNesReset();  // ROM nova: solta a anterior (audio inclusive)

    // Le o arquivo inteiro na PSRAM (teto 1 MB no nucleo; acima disso o
    // load recusa). readFile nativo: sem teto de 64 KB da API JS.
    FILE* f = fopen(path, "rb");
    if (f == nullptr) { duk_push_false(ctx); return 1; }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0 || size > (long)nes::MAX_ROM_SIZE) { fclose(f); duk_push_false(ctx); return 1; }
    s_rom = (uint8_t*)mem::alloc((size_t)size, mem::Want::Psram);
    if (s_rom == nullptr) { fclose(f); duk_push_false(ctx); return 1; }
    size_t got = fread(s_rom, 1, (size_t)size, f);
    fclose(f);
    if (got != (size_t)size) { jsNesReset(); duk_push_false(ctx); return 1; }
    s_romSize = (uint32_t)got;

    s_nes = new (std::nothrow) nes::Nes();
    if (s_nes == nullptr) { jsNesReset(); duk_push_false(ctx); return 1; }

    uint32_t crc = 0;
    uint8_t mapper = 0;
    const char* err = nullptr;
    if (!s_nes->load(s_rom, s_romSize, &crc, &mapper, &err)) {
        jsNesReset();
        duk_push_false(ctx);
        return 1;
    }
    if (!s_nes->openScreen()) {
        jsNesReset();
        duk_push_false(ctx);
        return 1;
    }

    duk_push_true(ctx);
    (void)err;  // diagnostico segue no log do kernel via duk_error nos erros duros
    return 1;
}

duk_ret_t JSBindings::js_nesBind(duk_context* ctx)
{
    if (s_nes == nullptr) return 0;
    int id = duk_require_int(ctx, 0);
    CelerSprite* spr = JSBindings::spriteById(id);
    if (spr == nullptr) { duk_push_false(ctx); return 1; }
    // O sprite tem que comportar o frame em PIXELS FISICOS (o app usa canvas
    // nativo: createSprite(256, 240) cria 256x240 fisico exato; em canvas
    // virtual o escalamento do vidro muda pw/ph e o contrato quebra).
    int pw = spr->width();
    int ph = spr->height();
    if (pw < kNesW || ph < kNesH) { duk_push_false(ctx); return 1; }
    s_spr = spr;
    // A PPU acumula o quadro no fb proprio (sink interno do openScreen) e o
    // frame() entrega o quadro INTEIRO num pushImage so: um msync por quadro,
    // como qualquer app full-redraw do OS. O pushImage por bloco de 8 linhas
    // (30 msyncs/frame) faultava no esp_cache_msync com o LCD_CAM sob carga
    // (bancada 2026-11-05).
    s_nes->setByteSwap(true);  // fb ja no byte order do painel (ver nesPush)
    s_sink_dst = spr;
    s_sink_x0 = 0;
    duk_push_true(ctx);
    return 1;
}

duk_ret_t JSBindings::js_nesBindFrame(duk_context* ctx)
{
    (void)ctx;
    if (s_nes == nullptr || !s_nes->loaded()) { duk_push_false(ctx); return 1; }
    // Frame INTEIRO por pushImage no display a cada frame (1 msync/frame; o
    // bloco de 8 linhas fazia 30 msyncs e faultava sob carga). O app desenha
    // so a faixa de controles pelo caminho normal (caixas sujas) e NAO
    // desenha o frame: a regiao 256x240 fica centrada na horizontal, no topo.
    // Fallback sem vidro: quadro do Kui (s_frame).
    lgfx::LovyanGFX* dst = tftInstance;
    int width = tftInstance ? (int)tftInstance->width() : 0;
    if (dst == nullptr || width < kNesW) {
        if (s_frame == nullptr) { duk_push_false(ctx); return 1; }
        dst = s_frame;
        width = (int)s_frame->width();
    }
    s_nes->setByteSwap(true);  // fb ja no byte order do painel (ver nesPush)
    s_sink_dst = dst;
    s_sink_x0 = (width - kNesW) / 2;  // centrado na horizontal, topo
    s_nes->setChunkSink(nullptr, nullptr);  // sink interno do fb (openScreen)
    s_spr = nullptr;  // alvo nao e sprite do pool
    duk_push_true(ctx);
    return 1;
}

duk_ret_t JSBindings::js_nesFrame(duk_context* ctx)
{
    if (s_nes == nullptr || !s_nes->loaded()) { duk_push_false(ctx); return 1; }
    uint8_t buttons = (uint8_t)(duk_require_int(ctx, 0) & 0xFF);
    bool render = !duk_is_boolean(ctx, 1) || duk_get_boolean(ctx, 1);
    // A PPU acumula o quadro no fb proprio (sink interno); aqui vai UM
    // pushImage por quadro ao alvo — o msync unico do caminho do OS.
    const int64_t t0 = esp_timer_get_time();
    s_nes->frame(buttons, render);
    const int64_t t1 = esp_timer_get_time();
    if (render && s_sink_dst != nullptr) {
        const uint16_t* fb = s_nes->framebuffer();
        if (fb != nullptr) nesPush(fb);
    }
    const int64_t t2 = esp_timer_get_time();
    nesStatsNote(t0, t1, t2);
    duk_push_true(ctx);
    return 1;
}

duk_ret_t JSBindings::js_nesReset(duk_context* ctx)
{
    if (s_nes != nullptr && s_nes->loaded()) s_nes->reset();
    return 0;
}

// Save/load state (formato do Anemoia: "ANEMOIA"+CRC+RAM/CPU/PPU/mapper,
// ~6-20 KB). O path e do app: escrito/lido pelo FileSystem com o jail da
// permissao fs (o nucleo so serializa em buffer).
duk_ret_t JSBindings::js_nesSaveState(duk_context* ctx)
{
    if (s_nes == nullptr || !s_nes->loaded()) { duk_push_false(ctx); return 1; }
    const char* path = duk_require_string(ctx, 0);
    if (!fsWriteAllowed(path)) {
        char msg[128];
        snprintf(msg, sizeof(msg), "fs: caminho fora do jail: %.90s", path);
        duk_error(ctx, DUK_ERR_ERROR, msg);  // pre-formatado: varargs %s em lightfunc corrompe
    }

    nes::File buf;
    if (!s_nes->saveState(buf)) { duk_push_false(ctx); return 1; }
    FILE* f = fopen(path, "wb");
    if (f == nullptr) { duk_push_false(ctx); return 1; }
    size_t n = buf.bytes().size();
    bool ok = fwrite(buf.bytes().data(), 1, n, f) == n;
    fclose(f);
    duk_push_boolean(ctx, ok);
    return 1;
}

duk_ret_t JSBindings::js_nesLoadState(duk_context* ctx)
{
    if (s_nes == nullptr || !s_nes->loaded()) { duk_push_false(ctx); return 1; }
    const char* path = duk_require_string(ctx, 0);
    if (!fsPathAllowed(path)) {
        char msg[128];
        snprintf(msg, sizeof(msg), "fs: caminho fora do jail: %.90s", path);
        duk_error(ctx, DUK_ERR_ERROR, msg);  // pre-formatado: varargs %s em lightfunc corrompe
    }

    FILE* f = fopen(path, "rb");
    if (f == nullptr) { duk_push_false(ctx); return 1; }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0 || size > 64 * 1024) { fclose(f); duk_push_false(ctx); return 1; }
    uint8_t* data = (uint8_t*)mem::alloc((size_t)size, mem::Want::Any);
    if (data == nullptr) { fclose(f); duk_push_false(ctx); return 1; }
    size_t got = fread(data, 1, (size_t)size, f);
    fclose(f);
    if (got != (size_t)size) { heap_caps_free(data); duk_push_false(ctx); return 1; }

    nes::File in(data, (size_t)got);
    bool ok = s_nes->loadState(in);
    heap_caps_free(data);
    duk_push_boolean(ctx, ok);
    return 1;
}

duk_ret_t JSBindings::js_nesAudioStart(duk_context* ctx)
{
#if CONFIG_CELEROS_AUDIO
    if (s_nes == nullptr || !s_nes->loaded()) { duk_push_false(ctx); return 1; }
    if (s_feed != nullptr) { duk_push_true(ctx); return 1; }  // ja tocando
    // O PcmFeed::begin toma a guarda de reproducao por conta propria (_held):
    // NAO chamar acquireOutput antes — a mesma guarda era disputada duas
    // vezes e o begin recusava sempre (bancada: "begin falhou" sem audio).
    s_feed = new (std::nothrow) AudioPlayer::PcmFeed();
    if (s_feed == nullptr || !s_feed->begin(44100, kAudioQueueBytes)) {
        celer_log_printf("[nes] audio: begin falhou (i2s/codec/ram)\n");
        nesStopAudio();
        duk_push_false(ctx);
        return 1;
    }
    s_feed->start();
    s_nes->setAudioSink(&nesAudioSink);
    s_nes->apuTaskStart();  // APU no core 1, como no Anemoia
    celer_log_printf("[nes] audio: 44100 Hz (apu task no core %d)\n", portNUM_PROCESSORS - 1);
    duk_push_true(ctx);
#else
    (void)ctx;
    duk_push_false(ctx);  // placa sem I2S de audio (mesmo contrato do playWav)
#endif
    return 1;
}

duk_ret_t JSBindings::js_nesAudioStop(duk_context* ctx)
{
    (void)ctx;
    nesStopAudio();
    return 0;
}

duk_ret_t JSBindings::js_nesUnload(duk_context* ctx)
{
    (void)ctx;
    jsNesReset();
    return 0;
}
