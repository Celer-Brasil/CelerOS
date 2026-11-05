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

#if CONFIG_CELEROS_AUDIO
#include "../Hardware/AudioPlayer.h"
#endif

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

// Sink dos blocos de 8 scanlines (o pushPixelsDMA do Anemoia): entrega ao
// pushImage do LovyanGFX, que e o caminho suportado do painel RGB — copia
// crua no framebuffer viola a regra da cache line de 64 B do 4848 (bancada:
// fault dentro do memcpy) e o pushImage incremental nao afoga a PSRAM.
void nesChunkSink(void* ctx, const uint16_t* rows, int y, int nrows)
{
    (void)ctx;
    if (s_sink_dst == nullptr) return;
    s_sink_dst->pushImage(s_sink_x0, y, kNesW, nrows, rows);
}

#if CONFIG_CELEROS_AUDIO
AudioPlayer::PcmFeed* s_feed = nullptr;  // guarda de saida enquanto toca
#endif

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
    if (s_nes != nullptr) s_nes->apuTaskStop();  // APU volta a ficar so no quadro
#if CONFIG_CELEROS_AUDIO
    if (s_feed != nullptr) {
        s_feed->end();  // para o player e solta a guarda (idempotente)
        delete s_feed;
        s_feed = nullptr;
        AudioPlayer::releaseOutput();
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
    // Blocos de 8 linhas via pushImage: a conversao de cor do LovyanGFX leva
    // em conta a convencao swapped do destino (sprite/painel) — a paleta sai
    // NORMAL aqui; paleta _swap + pushImage fazia swap duplo (laranja na
    // bancada: backdrop azul 0x00F2 saindo 0xF200).
    s_nes->setByteSwap(false);
    s_sink_dst = spr;
    s_sink_x0 = 0;
    s_nes->setChunkSink(&nesChunkSink, nullptr);
    duk_push_true(ctx);
    return 1;
}

duk_ret_t JSBindings::js_nesBindFrame(duk_context* ctx)
{
    (void)ctx;
    if (s_nes == nullptr || !s_nes->loaded()) { duk_push_false(ctx); return 1; }
    // Frame em blocos de 8 linhas direto no vidro: pushImage no display (o
    // caminho suportado; incremental como o pushPixelsDMA do Anemoia, sem
    // copia crua no framebuffer do painel). O app desenha so a faixa de
    // controles pelo caminho normal (caixas sujas). Fallback: quadro do Kui.
    lgfx::LovyanGFX* dst = tftInstance;
    int width = tftInstance ? (int)tftInstance->width() : 0;
    if (dst == nullptr || width < kNesW) {
        if (s_frame == nullptr) { duk_push_false(ctx); return 1; }
        dst = s_frame;
        width = (int)s_frame->width();
    }
    s_nes->setByteSwap(false);  // pushImage aplica a conversao do destino
    s_sink_dst = dst;
    s_sink_x0 = (width - kNesW) / 2;  // centrado na horizontal, topo
    s_nes->setChunkSink(&nesChunkSink, nullptr);
    s_spr = nullptr;  // alvo nao e sprite do pool
    duk_push_true(ctx);
    return 1;
}

duk_ret_t JSBindings::js_nesFrame(duk_context* ctx)
{
    if (s_nes == nullptr || !s_nes->loaded()) { duk_push_false(ctx); return 1; }
    uint8_t buttons = (uint8_t)(duk_require_int(ctx, 0) & 0xFF);
    bool render = !duk_is_boolean(ctx, 1) || duk_get_boolean(ctx, 1);
    // O quadro ja sai no alvo (sprite ou frame do Kui): sem copia aqui.
    s_nes->frame(buttons, render);
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
    if (!AudioPlayer::acquireOutput()) { duk_push_false(ctx); return 1; }
    s_feed = new (std::nothrow) AudioPlayer::PcmFeed();
    if (s_feed == nullptr || !s_feed->begin(44100, kAudioQueueBytes)) {
        nesStopAudio();
        duk_push_false(ctx);
        return 1;
    }
    s_feed->start();
    s_nes->setAudioSink(&nesAudioSink);
    s_nes->apuTaskStart();  // APU no core 0, como no Anemoia
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
