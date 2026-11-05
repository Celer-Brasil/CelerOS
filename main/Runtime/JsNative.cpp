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
#include "esp_task_wdt.h"
#include "esp_heap_caps.h"
#include "esp_cache.h"
#include "esp_memory_utils.h"

namespace {

constexpr uint32_t kMagic = 0x4E524C43u;  // "CLRN" (le do builder)
constexpr uint32_t kHeaderSize = 96;
constexpr uint32_t kMaxBlob = 512 * 1024;  // alinhado com o teto do hub (era nativa)
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
    uint8_t* code;       // base de execucao: [blob][scratch] no MESMO bloco
    size_t blobSize;
    size_t scratchSize;
    uint32_t entries[kMaxEntries];
    int entryCount;
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
    // incluso). Roda tambem no boot — s_modules ja nasce zero.
    for (int i = 0; i < kMaxModules; i++) {
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
    // scratch padrao 128 KB, teto 1 MB (PSRAM octal de 8 MB: alem disso o
    // app esta abusando do conceito de scratch)
    int32_t scratchKB = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 128;
    if (scratchKB < 4) scratchKB = 4;
    if (scratchKB > 1024) scratchKB = 1024;

    if (!inService()) present();  // leitura de arquivo: quadro antes
    else esp_task_wdt_reset();    // svchost: present() reentraria o pump
    FILE* f = fopen(path, "rb");
    if (f == nullptr) {
        celer_log_printf("[Native] load: fopen falhou (%s)", path);
        duk_push_int(ctx, -1);
        return 1;
    }
    uint8_t hdr[kHeaderSize];  // 96 B de pilha: cabecalho fixo do formato
    if (fread(hdr, 1, kHeaderSize, f) != kHeaderSize) {
        fclose(f);
        celer_log_printf("[Native] load: cabecalho curto");
        duk_push_int(ctx, -1);
        return 1;
    }
    uint32_t blobSize = rd32(hdr + 8);
    uint32_t chip = rd32(hdr + 12);
    uint32_t api = rd32(hdr + 16);
    uint32_t entryCount = rd32(hdr + 20);
    // valida TUDO antes de alocar; recusa e silenciosa (-1) — o app ve o
    // resultado e decide (o motivo real fica no comment, nao no glass)
    if (rd32(hdr) != kMagic || rd32(hdr + 4) != kHeaderSize ||
        chip != kChip || api > (uint32_t)CELEROS_API_LEVEL ||
        entryCount < 1 || entryCount > kMaxEntries ||
        blobSize < 4 || blobSize > kMaxBlob) {
        fclose(f);
        celer_log_printf("[Native] load: cabecalho invalido (magic=%08x chip=%u api=%u blob=%u)",
                         (unsigned)rd32(hdr), (unsigned)chip, (unsigned)api,
                         (unsigned)blobSize);
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

    // [blob][scratch] num bloco so; alinhamento 64 (linha de cache 32 com
    // folga — o esp_cache_msync exige alinhamento sem a flag UNALIGNED)
    size_t scratchSize = (size_t)scratchKB * 1024u;
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
    fclose(f);
    CelerKernel::noteAppYield();  // tempo NATIVO da leitura (mold js_readFile)

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
    uint32_t r = fn(m->code + m->blobSize, a0, a1);  // scratch: apos o blob
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
    heap_caps_free(m->code);
    m->code = nullptr;
    m->blobSize = 0;
    m->scratchSize = 0;
    m->entryCount = 0;
    duk_push_boolean(ctx, 1);
    return 1;
}
