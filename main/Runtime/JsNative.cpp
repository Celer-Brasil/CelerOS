// Codigo nativo carregavel — SPIKE (API 57, CONFIG_CELEROS_JS_NATIVE).
//
// O app entrega um BLOB de codigo Xtensa como arquivo (asset do pacote); o
// binding copia o blob do LittleFS para a PSRAM, sincroniza os caches e
// chama as entradas por ponteiro. Prova de conceito do estudo
// Documentation/Estudo_Native_Loader.pt-BR.md — NAO e o caminho de
// producao (assinatura, permissao "native" e gates de catalogo vem depois;
// hoje a superficie so existe com a flag de build ligada: smartdisplay).
//
// Formato do arquivo (tools/native/build_core.py):
//   cabecalho de 96 B: magic "CLRN", tamanho, chip, api, entradas[8],
//   sha256; seguido do codigo. Entrada tem assinatura UNICA
//   uint32_t fn(void* scratch, int32_t a0, int32_t a1) — o scratch e a
//   regiao apos o codigo no MESMO bloco (o dono e o loader; o blob nao
//   toca em mais nada).
//
// Regras do blob: autocontido (sem libc, sem globais, sem l32r/callx —
// gates no builder), chamadas internas PC-relative, blob < 256 KB. So
// executa em placa com PSRAM: a rota instrucao->cache->PSRAM e a mesma
// do SPIRAM_XIP_FROM_PSRAM (ligado no smartdisplay desta rodada).
//
// Seguranca: codigo nativo e ring-0 — o sandbox Duktape acaba aqui. O
// spike nao adiciona permissao; a infra completa desenha consentimento +
// assinatura ECDSA (mesma chave de OTA) no estudo.
//
// Estado por app: os blobs saem no JSBindings::init do proximo app
// (jsNativeReset, malloc incluso) — molde jsPhysicsReset.

#include "JsInternal.h"
#include "JsFsJail.h"
#include "../USBDevice/LogSink.h"
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <new>
#include "esp_task_wdt.h"
#include "esp_heap_caps.h"
#include "esp_cache.h"
#include "esp_memory_utils.h"
#include "esp_timer.h"

#if CONFIG_CELEROS_AUDIO
#include "../Hardware/AudioPlayer.h"
#endif

namespace {

constexpr uint32_t kMagic = 0x4E524C43u;  // "CLRN" (le do builder)
constexpr uint32_t kHeaderSize = 96;      // v1 (computacao pura)
constexpr uint32_t kHeaderSizeV2 = 128;   // v2: data/bss/relocacao
constexpr uint32_t kMaxBlob = 512 * 1024;  // alinhado com o teto do hub (era nativa)
constexpr uint32_t kMaxRelocs = 16384;     // teto de sanidade da tabela (64 KB)
constexpr uint32_t kRelocChunk = 64;       // sites por leitura de pilha (256 B)
constexpr uint32_t kMaxEntries = 8;
constexpr int kMaxModules = 2;
// Xtensa windowed ABI: os 2 bits baixos de um ponteiro de funcao codificam
// a janela (1 = call8, o default do toolchain). O endereco nasce de
// aritmetica (base + offset do cabecalho), nao de "&funcao" do C — a marca
// e nossa, senao o callx saltaria com formato errado.
constexpr uintptr_t kFnFormatCall8 = 1u;
#if CONFIG_IDF_TARGET_ESP32S3
constexpr uint32_t kChip = 1;  // esp32s3
#else
constexpr uint32_t kChip = 0;  // esp32 (nao deve existir: sem PSRAM nao ha rota)
#endif

// Assinatura unica de entrada do formato (builder e blob de teste casam):
//   uint32_t fn(void* scratch, int32_t a0, int32_t a1);
typedef uint32_t (*NativeEntry)(void*, int32_t, int32_t);

struct NativeModule {
    uint8_t* code;       // base de execucao: [imagem][scratch] no MESMO bloco
    size_t blobSize;
    size_t scratchSize;
    uint32_t entries[kMaxEntries];
    int entryCount;
#if CONFIG_CELEROS_AUDIO
    AudioPlayer::PcmFeed* feed;  // dreno de PCM do modulo (nativeAudio)
#endif
};

NativeModule s_modules[kMaxModules];  // estatico: nasce zero

NativeModule* moduleAt(int id) {
    if (id < 1 || id > kMaxModules) return nullptr;
    NativeModule* m = &s_modules[id - 1];
    return m->code != nullptr ? m : nullptr;
}

uint32_t rd32(const uint8_t* p) {
    uint32_t v;
    memcpy(&v, p, 4);  // esp32 e little-endian: leitura direta
    return v;
}

}  // namespace

void jsNativeReset() {
    // JSBindings::init do proximo app: blobs do anterior saem (malloc
    // incluso) e o PCM do modulo e encerrado. Roda tambem no boot.
    for (int i = 0; i < kMaxModules; i++) {
#if CONFIG_CELEROS_AUDIO
        if (s_modules[i].feed != nullptr) {
            s_modules[i].feed->end();
            delete s_modules[i].feed;
            s_modules[i].feed = nullptr;
        }
#endif
        if (s_modules[i].code != nullptr) {
            heap_caps_free(s_modules[i].code);
            s_modules[i].code = nullptr;
        }
    }
}

duk_ret_t JSBindings::js_nativeLoad(duk_context* ctx) {
    const char* path = duk_require_string(ctx, 0);
    if (!fsPathAllowed(path)) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "Native.load: caminho fora da jail");
    }
    // scratch padrao 128 KB, teto 1664 KB (blob 512 + estado de core real:
    // NES usa ROM 1MB + framebuffer 120KB + estado)
    int32_t scratchKB = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 128;
    if (scratchKB < 4) scratchKB = 4;
    if (scratchKB > 1664) scratchKB = 1664;

    if (!inService()) present();  // leitura de arquivo: quadro antes
    else esp_task_wdt_reset();    // svchost: present() reentraria o pump
    FILE* f = fopen(path, "rb");
    if (f == nullptr) {
        celer_log_printf("[Native] load: fopen falhou (%s)", path);
        duk_push_int(ctx, -1);
        return 1;
    }
    // Cabecalho v1 (96 B) ou v2 (128 B, relocavel): le 128 e aceita os dois
    // (hsize menor = campos v2 ausentes/zero).
    uint8_t hdr[kHeaderSizeV2];
    if (fread(hdr, 1, kHeaderSize, f) != kHeaderSize) {
        fclose(f);
        celer_log_printf("[Native] load: cabecalho curto");
        duk_push_int(ctx, -1);
        return 1;
    }
    uint32_t hsize = rd32(hdr + 4);
    if (rd32(hdr) != kMagic || (hsize != kHeaderSize && hsize != kHeaderSizeV2)) {
        fclose(f);
        celer_log_printf("[Native] load: magic/versao invalidos (magic=%08x hsize=%u)",
                         (unsigned)rd32(hdr), (unsigned)hsize);
        duk_push_int(ctx, -1);
        return 1;
    }
    if (hsize == kHeaderSizeV2 && fread(hdr + kHeaderSize, 1,
                                        kHeaderSizeV2 - kHeaderSize, f) !=
                                     kHeaderSizeV2 - kHeaderSize) {
        fclose(f);
        celer_log_printf("[Native] load: cabecalho v2 curto");
        duk_push_int(ctx, -1);
        return 1;
    }
    uint32_t blobSize = rd32(hdr + 8);
    uint32_t chip = rd32(hdr + 12);
    uint32_t api = rd32(hdr + 16);
    uint32_t entryCount = rd32(hdr + 20);
    // campos v2 (v1: zero — sem data/bss/reloc)
    uint32_t bssOff = hsize == kHeaderSizeV2 ? rd32(hdr + 56) : 0;
    uint32_t bssSize = hsize == kHeaderSizeV2 ? rd32(hdr + 60) : 0;
    uint32_t relocOff = hsize == kHeaderSizeV2 ? rd32(hdr + 64) : 0;
    uint32_t relocCount = hsize == kHeaderSizeV2 ? rd32(hdr + 68) : 0;
    // valida TUDO antes de alocar; recusa e silenciosa (-1) — o app ve o
    // resultado e decide (o motivo real fica no log)
    if (chip != kChip || api > (uint32_t)CELEROS_API_LEVEL ||
        entryCount < 1 || entryCount > kMaxEntries ||
        blobSize < 4 || blobSize > kMaxBlob) {
        fclose(f);
        celer_log_printf("[Native] load: cabecalho invalido (chip=%u api=%u blob=%u)",
                         (unsigned)chip, (unsigned)api, (unsigned)blobSize);
        duk_push_int(ctx, -1);
        return 1;
    }
    if (relocCount > kMaxRelocs) {
        fclose(f);
        celer_log_printf("[Native] load: %u relocs (max %u)",
                         (unsigned)relocCount, (unsigned)kMaxRelocs);
        duk_push_int(ctx, -1);
        return 1;
    }
    for (uint32_t i = 0; i < entryCount; i++) {
        // entrada tem que cair dentro do blob (offset relativo ao inicio)
        if (rd32(hdr + 24 + 4 * i) >= blobSize) {
            fclose(f);
            celer_log_printf("[Native] load: entrada %u fora do blob", (unsigned)i);
            duk_push_int(ctx, -1);
            return 1;
        }
    }

    // slot livre
    int slot = -1;
    for (int i = 0; i < kMaxModules; i++) {
        if (s_modules[i].code == nullptr) { slot = i; break; }
    }
    if (slot < 0) { fclose(f); duk_push_int(ctx, -1); return 1; }

    // [imagem][scratch] num bloco so; alinhamento 64 (linha de cache 32 com
    // folga — o esp_cache_msync exige alinhamento sem a flag UNALIGNED).
    // O .bss do blob mora logo apos a imagem (dentro da regiao de scratch):
    // o app aloca o scratch JA contando com ele (layout documentado no core).
    size_t scratchSize = (size_t)scratchKB * 1024u;
    if (bssSize && ((size_t)bssOff < blobSize ||
                    (size_t)bssOff + bssSize > blobSize + scratchSize)) {
        fclose(f);
        celer_log_printf("[Native] load: bss fora do bloco (%u+%u)",
                         (unsigned)bssOff, (unsigned)bssSize);
        duk_push_int(ctx, -1);
        return 1;
    }
    uint8_t* base = (uint8_t*)heap_caps_aligned_alloc(
        64, blobSize + scratchSize, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (base == nullptr) {
        fclose(f);
        celer_log_printf("[Native] load: PSRAM cheia (%u KB)", (unsigned)scratchKB);
        duk_push_int(ctx, -1);
        return 1;
    }
    if (fread(base, 1, blobSize, f) != blobSize) {
        fclose(f);
        heap_caps_free(base);
        celer_log_printf("[Native] load: blob curto");
        duk_push_int(ctx, -1);
        return 1;
    }

    // v2: zera o .bss e aplica as relocacoes absolutas (cada site guarda o
    // endereco LINKADO em base 0; a imagem roda em `base`, entao soma-se a
    // base). A tabela fica no arquivo logo apos a imagem; le em blocos de
    // pilha para nao alocar. Sites fora da imagem = blob corrompido.
    if (bssSize) memset(base + bssOff, 0, bssSize);
    bool relocOk = true;
    if (relocCount) {
        if (fseek(f, (long)relocOff, SEEK_SET) != 0) relocOk = false;
        uint32_t chunk[kRelocChunk];
        uint32_t left = relocCount;
        while (relocOk && left) {
            uint32_t n = left < kRelocChunk ? left : kRelocChunk;
            if (fread(chunk, sizeof(uint32_t), n, f) != n) { relocOk = false; break; }
            for (uint32_t i = 0; i < n; i++) {
                uint32_t o = chunk[i];
                if ((o & 3u) || (size_t)o + 4 > blobSize) { relocOk = false; break; }
                uint32_t v = rd32(base + o);
                v += (uint32_t)(uintptr_t)base;
                memcpy(base + o, &v, 4);
            }
            left -= n;
        }
    }
    fclose(f);
    CelerKernel::noteAppYield();  // tempo NATIVO da leitura (mold js_readFile)
    if (!relocOk) {
        heap_caps_free(base);
        celer_log_printf("[Native] load: relocacao invalida");
        duk_push_int(ctx, -1);
        return 1;
    }

    // Execucao: a escrita passou pela D-cache (writeback C2M leva as linhas
    // sujas ao PSRAM) e o I-cache pode ter copias velhas da regiao (M2C +
    // TYPE_INST invalida). O IDF 6.1 RECUSA C2M+TYPE_INST numa chamada so
    // ("C2M direction doesn't support instruction type", esp_cache_msync.c):
    // sao DOIS passos. Memoria interna nao tem esse cache — so sincroniza
    // quando o bloco caiu na PSRAM. Tamanho arredondado para linha de cache
    // (exigencia da API sem UNALIGNED).
    if (esp_ptr_external_ram(base)) {
        size_t syncLen = (blobSize + 31u) & ~((size_t)31u);
        if (esp_cache_msync(base, syncLen,
                            ESP_CACHE_MSYNC_FLAG_DIR_C2M) != ESP_OK) {
            heap_caps_free(base);
            celer_log_printf("[Native] load: writeback falhou (len=%u)",
                             (unsigned)syncLen);
            duk_push_int(ctx, -1);
            return 1;
        }
        // A invalidacao de I-cache em endereco da janela de dados pode nao
        // ser suportada (NOT_SUPPORTED): na primeira carga o I-cache esta
        // frio para esse endereco e o writeback ja garantiu o conteudo — o
        // risco so existe reusando um bloco que ja executou codigo velho.
        // Nao e fatal: segue com aviso no log.
        if (esp_cache_msync(base, syncLen,
                            ESP_CACHE_MSYNC_FLAG_DIR_M2C |
                            ESP_CACHE_MSYNC_FLAG_TYPE_INST) != ESP_OK) {
            celer_log_printf("[Native] load: icache invalidate nao suportada "
                             "(primeira carga segue ok)");
        }
    }

    NativeModule& m = s_modules[slot];
    m.code = base;
    m.blobSize = blobSize;
    m.scratchSize = scratchSize;
    m.entryCount = (int)entryCount;
    for (uint32_t i = 0; i < entryCount; i++) {
        m.entries[i] = rd32(hdr + 24 + 4 * i);
    }
    duk_push_int(ctx, slot + 1);
    return 1;
}


// PROBE_NATIVE (bancada, temporario): tempo dentro de call/draw/audio e o
// resto do laco, log a cada 2 s.
static int64_t s_pbWin = 0, s_pbCall = 0, s_pbDraw = 0, s_pbAud = 0, s_pbLastFrameEnd = 0;
static int s_pbN = 0;
static inline void probeTick(int64_t now)
{
    if (s_pbWin == 0) s_pbWin = now;
    if (now - s_pbWin < 2000000 || s_pbN == 0) return;
    int64_t span = now - s_pbWin;
    celer_log_printf("[native] %d frames/2s call %d us draw %d us aud %d us (por frame) span %d ms\n", s_pbN,
                     (int)(s_pbCall / s_pbN), (int)(s_pbDraw / s_pbN), (int)(s_pbAud / s_pbN), (int)(span / 1000));
    s_pbWin = now;
    s_pbCall = s_pbDraw = s_pbAud = 0;
    s_pbN = 0;
}

duk_ret_t JSBindings::js_nativeCall(duk_context* ctx) {
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
    int fnIdx = duk_require_int(ctx, 1);
    if (m == nullptr || fnIdx < 0 || fnIdx >= m->entryCount) {
        duk_push_number(ctx, (duk_double_t)(uint32_t)0xFFFFFFFFu);
        return 1;
    }
    // opcionais: lightfunc tem nargs na pilha, faltante e undefined (mold
    // numOr do JsPhysics — duk_get_number viraria NaN no int32)
    int32_t a0 = duk_is_number(ctx, 2) ? duk_get_int(ctx, 2) : 0;
    int32_t a1 = duk_is_number(ctx, 3) ? duk_get_int(ctx, 3) : 0;
    // O exec-timeout nao ve chamada nativa (hook so roda entre opcodes):
    // renova a janela ANTES de cada call. Contrato da API: tick curto —
    // nunca "Native.call(runEverything)" (TWDT reboota em ~5 s).
    CelerKernel::noteAppYield();
    NativeEntry fn = (NativeEntry)((uintptr_t)(m->code + m->entries[fnIdx]) |
                                   kFnFormatCall8);
    int64_t pb0 = esp_timer_get_time();
    uint32_t r = fn(m->code + m->blobSize, a0, a1);  // scratch: apos o blob
    int64_t pb1 = esp_timer_get_time();
    s_pbCall += pb1 - pb0;
    if (a0 == 8) { s_pbN++; probeTick(pb1); }
    duk_push_number(ctx, (duk_double_t)r);  // uint32 exato em double
    return 1;
}

duk_ret_t JSBindings::js_nativeRead(duk_context* ctx) {
    // bytes do scratch de volta ao JS: a prova de que o codigo nativo
    // escreveu memoria que o app enxerga. String JS (0..255 por char, mold
    // FS.readFile); teto 256 por chamada para nao inflar o heap Duktape.
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
    if (m == nullptr) { duk_push_null(ctx); return 1; }
    int32_t off = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 0;
    int32_t maxLen = duk_is_number(ctx, 2) ? duk_get_int(ctx, 2) : 64;
    if (off < 0 || maxLen <= 0 || (size_t)off >= m->scratchSize) {
        duk_push_null(ctx);
        return 1;
    }
    size_t n = (size_t)maxLen;
    if (n > 256) n = 256;
    if (n > m->scratchSize - (size_t)off) n = m->scratchSize - (size_t)off;
    char* buf = (char*)malloc(n > 0 ? n : 1);
    if (buf == nullptr) { duk_push_null(ctx); return 1; }
    memcpy(buf, m->code + m->blobSize + off, n);
    CelerKernel::noteAppYield();
    return jsPushOwnedString(ctx, buf, n);
}

duk_ret_t JSBindings::js_nativeFree(duk_context* ctx) {
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
    if (m == nullptr) { duk_push_boolean(ctx, 0); return 1; }
#if CONFIG_CELEROS_AUDIO
    if (m->feed != nullptr) {
        m->feed->end();
        delete m->feed;
        m->feed = nullptr;
    }
#endif
    heap_caps_free(m->code);
    m->code = nullptr;
    m->blobSize = 0;
    m->scratchSize = 0;
    m->entryCount = 0;
    duk_push_boolean(ctx, 1);
    return 1;
}

// ---------------------------------------------------------------------------
// Ponte de dados: JS <-> scratch (v2). O app alimenta o core (ROM, estado) e
// recupera o resultado (savestate) sem passar bytes pelo heap Duktape.
// ---------------------------------------------------------------------------

duk_ret_t JSBindings::js_nativeWrite(duk_context* ctx) {
    // bytes do JS (string binaria 0..255) para o scratch, no offset dado;
    // devolve quantos couberam (corta no fim do scratch, como o read)
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
    if (m == nullptr) { duk_push_int(ctx, -1); return 1; }
    int32_t off = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 0;
    size_t len = 0;
    const char* data = duk_require_lstring(ctx, 2, &len);
    if (off < 0 || (size_t)off >= m->scratchSize) { duk_push_int(ctx, -1); return 1; }
    if (len > m->scratchSize - (size_t)off) len = m->scratchSize - (size_t)off;
    memcpy(m->code + m->blobSize + off, data, len);
    CelerKernel::noteAppYield();
    duk_push_int(ctx, (duk_int_t)len);
    return 1;
}

duk_ret_t JSBindings::js_nativeLoadFile(duk_context* ctx) {
    // arquivo -> scratch[off] (ROM, savestate): le no maximo o que cabe no
    // scratch a partir do offset; devolve bytes lidos ou -1
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
    const char* path = duk_require_string(ctx, 2);
    if (!fsPathAllowed(path)) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "Native.loadFile: caminho fora da jail");
    }
    int32_t off = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 0;
    if (m == nullptr || off < 0 || (size_t)off >= m->scratchSize) {
        duk_push_int(ctx, -1);
        return 1;
    }
    if (!inService()) present();
    else esp_task_wdt_reset();
    FILE* f = fopen(path, "rb");
    if (f == nullptr) { duk_push_int(ctx, -1); return 1; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) { fclose(f); duk_push_int(ctx, -1); return 1; }
    size_t cap = m->scratchSize - (size_t)off;
    size_t want = (size_t)sz > cap ? cap : (size_t)sz;
    size_t got = fread(m->code + m->blobSize + off, 1, want, f);
    fclose(f);
    CelerKernel::noteAppYield();
    duk_push_int(ctx, (duk_int_t)got);
    return 1;
}

duk_ret_t JSBindings::js_nativeSaveFile(duk_context* ctx) {
    // scratch[off..off+len) -> arquivo, atomico (.tmp + rename em /local;
    // no SD grava direto). Mesma jail de escrita do FS.writeFile.
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
    if (m == nullptr) { duk_push_boolean(ctx, 0); return 1; }
    int32_t off = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 0;
    int32_t len = duk_is_number(ctx, 2) ? duk_get_int(ctx, 2) : 0;
    const char* path = duk_require_string(ctx, 3);
    if (!fsWriteAllowed(path)) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "Native.saveFile: caminho fora da jail");
    }
    if (off < 0 || len < 0 || (size_t)off + (size_t)len > m->scratchSize) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    if (strlen(path) > kJsPathMax) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "Native.saveFile: caminho longo demais");
    }
    char tmp[kJsPathMax + 8];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    if (!inService()) present();
    else esp_task_wdt_reset();
    FILE* f = fopen(tmp, "wb");
    if (f == nullptr) { duk_push_boolean(ctx, 0); return 1; }
    bool ok = fwrite(m->code + m->blobSize + off, 1, (size_t)len, f) == (size_t)len;
    ok = fclose(f) == 0 && ok;
    if (ok) {
        remove(path);  // rename nao sobrescreve no littlefs: remove primeiro
        ok = rename(tmp, path) == 0;
    }
    if (!ok) remove(tmp);
    CelerKernel::noteAppYield();
    duk_push_boolean(ctx, ok);
    return 1;
}

duk_ret_t JSBindings::js_nativeDraw(duk_context* ctx) {
    // RGB565 do scratch -> alvo corrente (display/quadro/sprite), UM push
    // por chamada. Molde provado do NES: ponteiro tipado swap565_t (o
    // pixelcopy vira memcpy por linha; uint16_t* cru converte pixel a
    // pixel) e clearClipRect (o clip do Kui no present deixava o push
    // no-op com a tela congelada).
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
    if (m == nullptr) { duk_push_boolean(ctx, 0); return 1; }
    int32_t off = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 0;
    int32_t x = duk_is_number(ctx, 2) ? duk_get_int(ctx, 2) : 0;
    int32_t y = duk_is_number(ctx, 3) ? duk_get_int(ctx, 3) : 0;
    int32_t w = duk_is_number(ctx, 4) ? duk_get_int(ctx, 4) : 0;
    int32_t h = duk_is_number(ctx, 5) ? duk_get_int(ctx, 5) : 0;
    if (off < 0 || w <= 0 || h <= 0 ||
        (size_t)off + (size_t)w * (size_t)h * 2 > m->scratchSize) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
#if CONFIG_CELEROS_UI
    lgfx::LGFXBase* tgt = gfx();
    if (tgt == nullptr) { duk_push_boolean(ctx, 0); return 1; }
    // O buffer pode ter sido escrito pela CPU agora: writeback antes do DMA
    // (mesmo rito do load, so a direcao de dados).
    int64_t pb0 = esp_timer_get_time();
    if (esp_ptr_external_ram(m->code)) {
        size_t syncLen = ((size_t)w * (size_t)h * 2u + 31u) & ~((size_t)31u);
        esp_cache_msync(m->code + m->blobSize + off, syncLen,
                        ESP_CACHE_MSYNC_FLAG_DIR_C2M);
    }
    tgt->clearClipRect();
    tgt->pushImage(jsx(x), jsy(y), w, h,
                   reinterpret_cast<const lgfx::swap565_t*>(m->code + m->blobSize + off));
    s_pbDraw += esp_timer_get_time() - pb0;
    CelerKernel::noteAppYield();
    duk_push_boolean(ctx, 1);
#else
    (void)x; (void)y;
    duk_push_boolean(ctx, 0);
#endif
    return 1;
}

duk_ret_t JSBindings::js_nativeAudio(duk_context* ctx) {
    // PCM16 mono LE do scratch -> PcmFeed (44,1 kHz, fila de 32 KB). A fila
    // nasce no primeiro write (begin SEM acquireOutput: o begin ja toma a
    // guarda — o double-acquire do antigo Nes.audioStart impedia o audio).
    // O player drena em task propria; bloqueia so com a fila cheia.
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
#if CONFIG_CELEROS_AUDIO
    int32_t off = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 0;
    int32_t len = duk_is_number(ctx, 2) ? duk_get_int(ctx, 2) : 0;
    if (m == nullptr || off < 0 || len <= 0 ||
        (size_t)off + (size_t)len > m->scratchSize) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    if (m->feed == nullptr) {
        m->feed = new (std::nothrow) AudioPlayer::PcmFeed();
        if (m->feed == nullptr || !m->feed->begin(44100, 32 * 1024)) {
            delete m->feed;
            m->feed = nullptr;
            duk_push_boolean(ctx, 0);
            return 1;
        }
        m->feed->start();
    }
    CelerKernel::noteAppYield();
    int64_t pb0 = esp_timer_get_time();
    bool okw = m->feed->write(m->code + m->blobSize + off, (size_t)len);
    s_pbAud += esp_timer_get_time() - pb0;
    duk_push_boolean(ctx, okw);
    return 1;
#else
    (void)m;
    duk_push_boolean(ctx, 0);
    return 1;
#endif
}

duk_ret_t JSBindings::js_nativeAudioStop(duk_context* ctx) {
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
#if CONFIG_CELEROS_AUDIO
    if (m != nullptr && m->feed != nullptr) {
        m->feed->end();
        delete m->feed;
        m->feed = nullptr;
    }
#endif
    (void)m;
    return 0;
}
