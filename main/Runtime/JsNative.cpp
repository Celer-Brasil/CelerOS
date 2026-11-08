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
#include "../Kernel/CrashRecord.h"
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
#include "esp_mmu_map.h"
#include "esp_timer.h"
#include "esp_async_memcpy.h"

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
// Regiao fast (header +76, API 60): estado quente do core na RAM INTERNA. O
// teto e a folga protegem o heap interno do sistema (WiFi/BLE/TLS): sem
// sobra, a regiao fica no .bss (PSRAM) e o core so roda mais devagar.
constexpr uint32_t kMaxFast = 64 * 1024;
constexpr size_t kFastReserve = 40 * 1024;    // folga no TOTAL interno livre
constexpr size_t kFastBlockSlack = 8 * 1024;  // e no maior bloco apos a regiao
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
    uint8_t* code;       // alias EXECUTAVEL da imagem (mmap I-window ou RAM interna)
    uint8_t* scratch;    // dados do core em PSRAM (bloco separado)
    uint8_t* data;       // alias de DADOS da imagem (bloco PSRAM do mmap)
    void* mmap_vaddr;    // base mapeada (para esp_mmu_unmap)
    uint8_t* fast;       // regiao fast do .bss na RAM interna (nullptr = ficou no .bss)
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

namespace {
void dmaFree();
}  // namespace

void jsNativeReset() {
    // JSBindings::init do proximo app: blobs do anterior saem (malloc
    // incluso) e o PCM do modulo e encerrado. Roda tambem no boot.
    dmaFree();  // canal GDMA + blocos internos do nativeScreen
    for (int i = 0; i < kMaxModules; i++) {
#if CONFIG_CELEROS_AUDIO
        if (s_modules[i].feed != nullptr) {
            s_modules[i].feed->end();
            delete s_modules[i].feed;
            s_modules[i].feed = nullptr;
        }
#endif
        if (s_modules[i].code != nullptr) {
            if (s_modules[i].mmap_vaddr != nullptr)
                esp_mmu_unmap(s_modules[i].mmap_vaddr);
            heap_caps_free(s_modules[i].data);  // dono do bloco (mmap ou interno)
            s_modules[i].code = nullptr;
            s_modules[i].data = nullptr;
            s_modules[i].mmap_vaddr = nullptr;
        }
        if (s_modules[i].scratch != nullptr) {
            heap_caps_free(s_modules[i].scratch);
            s_modules[i].scratch = nullptr;
        }
        if (s_modules[i].fast != nullptr) {
            heap_caps_free(s_modules[i].fast);
            s_modules[i].fast = nullptr;
        }
    }
}

duk_ret_t JSBindings::js_nativeLoad(duk_context* ctx) {
    const char* path = duk_require_string(ctx, 0);
    if (!fsPathAllowed(path)) {
        duk_error(ctx, DUK_ERR_RANGE_ERROR, "Native.load: caminho fora da jail");
    }
    // scratch padrao 128 KB, teto 6144 KB (API 62; era 2560). Estado de core
    // real: o NES usa ROM 1MB + framebuffer 120KB + quadro escalado 450KB +
    // carimbos; o SNES ~0,7 MB fixos + a ROM inteira (o Mario All-Stars tem
    // 2,5 MB). Acima do que a PSRAM tem, o alloc falha e o load devolve
    // erro ("PSRAM cheia") — o teto so barra pedido absurdo.
    int32_t scratchKB = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 128;
    if (scratchKB < 4) scratchKB = 4;
    if (scratchKB > 6144) scratchKB = 6144;

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
    uint32_t fastSize = hsize == kHeaderSizeV2 ? rd32(hdr + 76) : 0;
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
    if (fastSize > bssSize || fastSize > kMaxFast) {
        fclose(f);
        celer_log_printf("[Native] load: regiao fast invalida (%u de bss %u)",
                         (unsigned)fastSize, (unsigned)bssSize);
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

    // EXECUCAO (bancada 2026-11-05): o S3 nao busca instrucao pela janela
    // de DADOS da PSRAM (InstructionFetchError). Dois caminhos, nesta ordem:
    //  1) bloco PSRAM mapeado na JANELA DE INSTRUCAO (esp_mmu_map EXEC) —
    //     mesmo caminho do XIP, sem gastar RAM interna; `base` = alias exec
    //     (fetch) e `baseData` = alias de dados (R/W). Relocacao de FUNCAO
    //     leva o alias exec (callx cai na janela); de dados/rodata, o alias
    //     de dados (store no alias exec faultaria).
    //  2) imagem+bss inteiros em RAM INTERNA (blob pequeno) se o mmap falhar.
    // O scratch do app e sempre um bloco PSRAM SEPARADO.
    size_t scratchSize = (size_t)scratchKB * 1024u;
    size_t imgSpan = blobSize;
    if (bssSize) {
        if ((size_t)bssOff < blobSize) {
            fclose(f);
            celer_log_printf("[Native] load: bss sobrepoe a imagem (%u+%u)",
                             (unsigned)bssOff, (unsigned)bssSize);
            duk_push_int(ctx, -1);
            return 1;
        }
        imgSpan = (size_t)bssOff + bssSize;
    }
    uint8_t* baseData = (uint8_t*)heap_caps_aligned_alloc(
        64, imgSpan, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    uint8_t* base = baseData;
    void* mmapRoot = nullptr;
    bool mapped = false;
    if (baseData != nullptr) {
        const size_t page = 0x10000;  // CONFIG_MMU_PAGE_SIZE (S3)
        uintptr_t pa = (uintptr_t)baseData & ~(uintptr_t)(page - 1);
        size_t span = (((uintptr_t)baseData - pa) + imgSpan + page - 1) &
                      ~(page - 1);
        void* vaddr = nullptr;
        // EXEC|32BIT como o flash_mmap do IDF faz para CODIGO: o l32r do
        // literal pool e uma carga de 32 bits atraves da janela; sem 32BIT o
        // acesso falha (bancada: fault com addr = pc+3 = literal).
        esp_err_t merr = esp_mmu_map((esp_paddr_t)pa, span, MMU_TARGET_PSRAM0,
                                     (mmu_mem_caps_t)(MMU_MEM_CAP_EXEC | MMU_MEM_CAP_32BIT), 0,
                                     &vaddr);
        if (merr == ESP_OK) {
            base = (uint8_t*)vaddr + ((uintptr_t)baseData - pa);
            mapped = true;
            mmapRoot = vaddr;
        } else {
            celer_log_printf("[Native] load: mmap exec falhou (%d) — "
                             "caindo na RAM interna", (int)merr);
            heap_caps_free(baseData);
            baseData = nullptr;
            base = nullptr;
        }
    }
    if (base == nullptr) {
        base = (uint8_t*)heap_caps_aligned_alloc(
            64, imgSpan, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        baseData = base;
        if (base == nullptr) {
            fclose(f);
            celer_log_printf("[Native] load: sem mmap exec e sem RAM interna "
                             "para imagem+bss (%u B; maior bloco %u B)",
                             (unsigned)imgSpan,
                             (unsigned)heap_caps_get_largest_free_block(
                                 MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
            duk_push_int(ctx, -1);
            return 1;
        }
    }
    uint8_t* scratch = (uint8_t*)heap_caps_aligned_alloc(
        64, scratchSize, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (scratch == nullptr) {
        fclose(f);
        if (mapped) esp_mmu_unmap(mmapRoot);
        heap_caps_free(baseData);
        celer_log_printf("[Native] load: PSRAM cheia (%u KB)", (unsigned)scratchKB);
        duk_push_int(ctx, -1);
        return 1;
    }
    if (fread(baseData, 1, blobSize, f) != blobSize) {
        fclose(f);
        if (mapped) esp_mmu_unmap(mmapRoot);
        heap_caps_free(baseData);
        heap_caps_free(scratch);
        celer_log_printf("[Native] load: blob curto");
        duk_push_int(ctx, -1);
        return 1;
    }

    // v2/v3: zera o .bss e aplica as relocacoes absolutas. v3 (header r4=1):
    // bit31 do offset = KIND — 1 aponta para dados/rodata (alias de dados),
    // 0 para funcao (alias executavel). v2 antigo: tudo com a mesma base.
    if (bssSize) memset(baseData + bssOff, 0, bssSize);
    // Regiao fast = os ULTIMOS fastSize bytes do .bss: vai para a RAM
    // interna se sobrar folga; as relocacoes de DADOS que caem nela sao
    // redirecionadas abaixo (codigo nunca aponta para la).
    uint32_t fastOff = bssOff + bssSize - fastSize;
    uint8_t* fast = nullptr;
    if (fastSize) {
        size_t largest = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        size_t freeInt = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (largest >= (size_t)fastSize + kFastBlockSlack && freeInt >= (size_t)fastSize + kFastReserve) {
            fast = (uint8_t*)heap_caps_aligned_alloc(16, fastSize, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
            if (fast != nullptr) memset(fast, 0, fastSize);
        }
        celer_log_printf("[Native] fast %u B: %s (interna livre %u B, maior bloco %u B)\n",
                         (unsigned)fastSize, fast != nullptr ? "RAM interna" : "PSRAM",
                         (unsigned)freeInt, (unsigned)largest);
    }
    uint32_t relocKindFlag = rd32(hdr + 72);  // 1 = tabela com kind
    bool relocOk = true;
    if (relocCount) {
        if (fseek(f, (long)relocOff, SEEK_SET) != 0) relocOk = false;
        uint32_t chunk[kRelocChunk];
        uint32_t left = relocCount;
        while (relocOk && left) {
            uint32_t n = left < kRelocChunk ? left : kRelocChunk;
            if (fread(chunk, sizeof(uint32_t), n, f) != n) { relocOk = false; break; }
            for (uint32_t i = 0; i < n; i++) {
                uint32_t raw = chunk[i];
                bool isData = relocKindFlag != 0 && (raw & 0x80000000u) != 0;
                uint32_t o = relocKindFlag ? (raw & 0x7FFFFFFFu) : raw;
                if ((o & 3u) || (size_t)o + 4 > blobSize) { relocOk = false; break; }
                uint32_t v = rd32(baseData + o);
                if (fast != nullptr && isData && v >= fastOff && v - fastOff <= fastSize)
                    v = (uint32_t)(uintptr_t)fast + (v - fastOff);
                else
                    v += (uint32_t)(uintptr_t)(isData ? baseData : base);
                memcpy(baseData + o, &v, 4);
            }
            left -= n;
        }
    }
    fclose(f);
    CelerKernel::noteAppYield();  // tempo NATIVO da leitura (mold js_readFile)
    if (!relocOk) {
        if (fast != nullptr) heap_caps_free(fast);
        if (mapped) esp_mmu_unmap(mmapRoot);
        heap_caps_free(baseData);
        heap_caps_free(scratch);
        celer_log_printf("[Native] load: relocacao invalida");
        duk_push_int(ctx, -1);
        return 1;
    }

    // Cache: writeback da imagem pelo ALIAS DE DADOS e invalidacao de
    // I-cache pelo ALIAS EXECUTIVO (as duas linhas de cache sao fisicas: o
    // mesmo endereco fisico muda pelos dois mapeamentos).
    if (mapped) {
        size_t syncLen = (blobSize + 31u) & ~((size_t)31u);
        if (esp_cache_msync(baseData, syncLen,
                            ESP_CACHE_MSYNC_FLAG_DIR_C2M) != ESP_OK) {
            celer_log_printf("[Native] load: writeback da imagem falhou");
        }
        if (esp_cache_msync(base, syncLen,
                            ESP_CACHE_MSYNC_FLAG_DIR_M2C |
                            ESP_CACHE_MSYNC_FLAG_TYPE_INST) != ESP_OK) {
            celer_log_printf("[Native] load: icache invalidate no alias falhou "
                             "(primeira carga segue ok)");
        }
    }

    // Crash record: guarda a base exec do blob para o panic relatar
    // (offset = pc - base -> addr2line no ELF do blob).
    CrashRecord::setNativeExec((uint32_t)(uintptr_t)base);
    NativeModule& m = s_modules[slot];
    m.code = base;        // alias executavel (entradas e callx)
    m.data = baseData;    // alias de dados (liberar/unmap)
    m.mmap_vaddr = mmapRoot;
    m.scratch = scratch;
    m.fast = fast;
    m.blobSize = blobSize;
    m.scratchSize = scratchSize;
    m.entryCount = (int)entryCount;
    for (uint32_t i = 0; i < entryCount; i++) {
        m.entries[i] = rd32(hdr + 24 + 4 * i);
    }
    // Diagnostico: exec/data (pc - exec = offset para addr2line), tamanhos
    // e o scratch. mmap=1 => imagem PSRAM na janela de instrucao.
    celer_log_printf("[Native] load ok: exec=%p data=%p img=%u bss=%u "
                     "scratch=%p/%u mmap=%d\n",
                     (void*)base, (void*)baseData, (unsigned)blobSize,
                     (unsigned)bssSize, (void*)scratch, (unsigned)scratchSize,
                     (int)mapped);
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
    // SEM o marcador |1: a bancada mostrou o salto caindo 1 byte dentro da
    // primeira instrucao (pc = entry+1 -> StoreProhibited). O callx8 que o
    // compilador emite ja define a janela; o endereco vai cru.
    NativeEntry fn = (NativeEntry)(m->code + m->entries[fnIdx]);
    uint32_t r = fn(m->scratch, a0, a1);  // scratch: bloco PSRAM separado
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
    memcpy(buf, m->scratch + off, n);
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
    if (m->mmap_vaddr != nullptr) esp_mmu_unmap(m->mmap_vaddr);
    heap_caps_free(m->data);
    m->code = nullptr;
    m->data = nullptr;
    m->mmap_vaddr = nullptr;
    if (m->scratch != nullptr) heap_caps_free(m->scratch);
    m->scratch = nullptr;
    if (m->fast != nullptr) heap_caps_free(m->fast);
    m->fast = nullptr;
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
    memcpy(m->scratch + off, data, len);
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
    // em blocos: uma ROM de SNES (2,5 MB) leva ~6 s no SD SPI do 4848; um
    // fread unico prendia a task sem ceder (IDLE parado, watchdog no limite)
    size_t got = 0;
    while (got < want) {
        size_t chunk = want - got > 65536 ? 65536 : want - got;
        size_t n = fread(m->scratch + off + got, 1, chunk, f);
        got += n;
        if (n < chunk) break;
        esp_task_wdt_reset();
        vTaskDelay(1);
    }
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
    bool ok = fwrite(m->scratch + off, 1, (size_t)len, f) == (size_t)len;
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
    // Sem writeback do scratch: o pushImage le pela CPU (mesma cache que o
    // core escreveu), nao por DMA — o msync de ~430 KB por quadro era custo
    // puro.
    tgt->clearClipRect();
    tgt->pushImage(jsx(x), jsy(y), w, h,
                   reinterpret_cast<const lgfx::swap565_t*>(m->scratch + off));
    CelerKernel::noteAppYield();
    duk_push_boolean(ctx, 1);
#else
    (void)x; (void)y;
    duk_push_boolean(ctx, 0);
#endif
    return 1;
}

// API 60: o core escreve o quadro DIRETO no vidro. A entrada recebe
// fn(scratch, a0, &NativeScreen): ponteiro para o pixel (x,y) do alvo,
// stride em pixels, w/h do retangulo e o a1 do app. Alvo, nesta ordem:
//  1) framebuffer do PAINEL (placa que o expoe, vidro livre: sem faixa,
//     sem AOD) — uma passada de PSRAM e nada no present;
//  2) quadro automatico do app (FrameSprite) + caixa suja — o present leva.
// Pixels RGB565 com bytes TROCADOS nos dois (convencao do quadro). Sem
// alvo (sprite do app ativo, placa sem quadro) a entrada NAO roda e o
// retorno e 0xFFFFFFFF: o app cai no caminho nativeCall + nativeDraw.
struct NativeScreen {
    uint16_t* px;
    int32_t stride;
    int32_t w;
    int32_t h;
    int32_t arg;
    int32_t flags;  // bit0: 1 = framebuffer do painel, 0 = quadro do app; bit1: redesenho total
    // Escrita de linha pronta (opcional): o core entrega a linha y (w px,
    // RAM interna) em vez de escrever no alvo pela CPU. No painel o
    // firmware junta linhas contiguas e despeja por GDMA — a CPU escrevendo
    // na PSRAM fica presa na latencia de cada linha de cache (fill +
    // writeback): 432 KB custavam ~21 ms. nullptr = o core escreve direto.
    void (*put)(void* ctx, int32_t y, const uint16_t* src);
    void* putCtx;
};

// ---- GDMA do nativeScreen ---------------------------------------------------
// Blocos de kDmaRows linhas na RAM interna (DMA): a linha entra no bloco
// corrente; bloco cheio (ou linha fora de sequencia) vai por esp_async_memcpy
// e o proximo bloco livre assume. A GDMA corre em paralelo com o core (que
// segue emulando as scanlines seguintes). Sem canal/RAM interna: CPU.
namespace {
constexpr int kDmaSlots = 3;
constexpr int kDmaRows = 8;
constexpr size_t kDmaRowMax = 480 * 2;
async_memcpy_handle_t s_mcp = nullptr;
uint8_t* s_dmaBuf[kDmaSlots];
volatile bool s_dmaBusy[kDmaSlots];
bool s_dmaTried = false;

struct DmaPut {
    uint8_t* base;      // pixel (x, 0) do retangulo no framebuffer
    size_t strideB;     // bytes por linha do framebuffer
    size_t rowB;        // bytes por linha do retangulo (== strideB: contiguo)
    int slot;           // bloco corrente (-1 = nenhum)
    int y0, rows;       // linhas acumuladas no bloco
    uint32_t cpuRows;   // linhas que cairam na CPU (diagnostico)
};

bool dmaDone(async_memcpy_handle_t, async_memcpy_event_t*, void* arg) {
    *(volatile bool*)arg = false;
    return false;
}

bool dmaInit() {
    if (s_mcp != nullptr) return true;
    if (s_dmaTried) return false;
    s_dmaTried = true;
    for (int i = 0; i < kDmaSlots; i++) {
        s_dmaBuf[i] = (uint8_t*)heap_caps_aligned_alloc(32, kDmaRows * kDmaRowMax,
                                                        MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        if (s_dmaBuf[i] == nullptr) {
            celer_log_printf("[Native] dma: sem RAM interna para os blocos\n");
            return false;
        }
    }
    async_memcpy_config_t cfg = ASYNC_MEMCPY_DEFAULT_CONFIG();
    cfg.backlog = kDmaSlots;
    cfg.dma_burst_size = 32;
    esp_err_t err = esp_async_memcpy_install_gdma_ahb(&cfg, &s_mcp);
    if (err != ESP_OK) {
        celer_log_printf("[Native] dma: canal GDMA indisponivel (%d)\n", (int)err);
        s_mcp = nullptr;
        return false;
    }
    return true;
}

void dmaFree() {
    if (s_mcp != nullptr) {
        for (int i = 0; i < kDmaSlots; i++)
            while (s_dmaBusy[i]) {}
        esp_async_memcpy_uninstall(s_mcp);
        s_mcp = nullptr;
    }
    for (int i = 0; i < kDmaSlots; i++) {
        heap_caps_free(s_dmaBuf[i]);
        s_dmaBuf[i] = nullptr;
    }
    s_dmaTried = false;
}

void dmaSubmit(DmaPut* d) {
    if (d->slot < 0 || d->rows == 0) return;
    uint8_t* dst = d->base + (size_t)d->y0 * d->strideB;
    const size_t n = (size_t)d->rows * d->rowB;
    volatile bool* busy = &s_dmaBusy[d->slot];
    *busy = true;
    if (esp_async_memcpy(s_mcp, dst, s_dmaBuf[d->slot], n, dmaDone, (void*)busy) != ESP_OK) {
        // fila cheia/alinhamento: CPU + writeback (o DMA do painel le a PSRAM)
        *busy = false;
        memcpy(dst, s_dmaBuf[d->slot], n);
        esp_cache_msync(dst, n, ESP_CACHE_MSYNC_FLAG_DIR_C2M | ESP_CACHE_MSYNC_FLAG_UNALIGNED);
        d->cpuRows += d->rows;
    }
    d->slot = -1;
    d->rows = 0;
}

void dmaPut(void* ctx, int32_t y, const uint16_t* src) {
    DmaPut* d = (DmaPut*)ctx;
    if (d->slot >= 0 && (d->rows == kDmaRows || y != d->y0 + d->rows)) dmaSubmit(d);
    if (d->slot < 0) {
        int k = 0;
        for (;;) {  // proximo bloco livre (a GDMA de 8 linhas leva ~0,1 ms)
            if (!s_dmaBusy[k]) break;
            if (++k == kDmaSlots) k = 0;
        }
        d->slot = k;
        d->y0 = y;
        d->rows = 0;
    }
    memcpy(s_dmaBuf[d->slot] + (size_t)d->rows * d->rowB, src, d->rowB);
    d->rows++;
}

void dmaFinish(DmaPut* d) {
    dmaSubmit(d);
    for (int i = 0; i < kDmaSlots; i++)
        while (s_dmaBusy[i]) {}
}
}  // namespace
typedef uint32_t (*NativeScreenEntry)(void*, int32_t, NativeScreen*);

duk_ret_t JSBindings::js_nativeScreen(duk_context* ctx) {
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
    int fnIdx = duk_require_int(ctx, 1);
    const duk_double_t kNoTarget = (duk_double_t)(uint32_t)0xFFFFFFFFu;
    if (m == nullptr || fnIdx < 0 || fnIdx >= m->entryCount) {
        duk_push_number(ctx, kNoTarget);
        return 1;
    }
    int32_t a0 = duk_is_number(ctx, 2) ? duk_get_int(ctx, 2) : 0;
    int32_t a1 = duk_is_number(ctx, 3) ? duk_get_int(ctx, 3) : 0;
#if CONFIG_CELEROS_UI
    int32_t x = jsx(duk_is_number(ctx, 4) ? duk_get_int(ctx, 4) : 0);
    int32_t y = jsy(duk_is_number(ctx, 5) ? duk_get_int(ctx, 5) : 0);
    int32_t w = duk_is_number(ctx, 6) ? duk_get_int(ctx, 6) : 0;
    int32_t h = duk_is_number(ctx, 7) ? duk_get_int(ctx, 7) : 0;
    if (tftInstance == nullptr || s_frame == nullptr || gfx() != s_frame ||
        w <= 0 || h <= 0 || x < 0 || y < 0 ||
        x + w > s_frame->width() || y + h > s_frame->height()) {
        duk_push_number(ctx, kNoTarget);
        return 1;
    }
    NativeScreen scr;
    int32_t stride = 0;
    uint16_t* fb = screenDirectOk() ? tftInstance->directFb(&stride) : nullptr;
    if (fb != nullptr && x + w <= tftInstance->width() && y + h <= tftInstance->height()) {
        scr.px = fb + (size_t)y * stride + x;
        scr.stride = stride;
        scr.flags = 1;
    } else {
        fb = nullptr;
        scr.px = (uint16_t*)s_frame->getBuffer() + (size_t)y * s_frame->stride() + x;
        scr.stride = s_frame->stride();
        scr.flags = 0;
    }
    if (takePanelTouched()) scr.flags |= 2;  // present pintou o vidro: redesenho total
    scr.w = w;
    scr.h = h;
    scr.arg = a1;
    scr.put = nullptr;
    scr.putCtx = nullptr;
    // GDMA so no painel e com linhas contiguas (retangulo da largura toda,
    // alinhado ao que a GDMA de PSRAM exige)
    DmaPut dp;
    if (fb != nullptr && w == stride && ((uintptr_t)scr.px & 31u) == 0 &&
        ((size_t)w * 2 & 31u) == 0 && (size_t)w * 2 <= kDmaRowMax && dmaInit()) {
        dp.base = (uint8_t*)scr.px;
        dp.strideB = (size_t)stride * 2;
        dp.rowB = (size_t)w * 2;
        dp.slot = -1;
        dp.rows = 0;
        dp.y0 = 0;
        dp.cpuRows = 0;
        scr.put = &dmaPut;
        scr.putCtx = &dp;
    }
    CelerKernel::noteAppYield();
    NativeScreenEntry fn = (NativeScreenEntry)(m->code + m->entries[fnIdx]);
    uint32_t r = fn(m->scratch, a0, &scr);
    if (scr.put != nullptr) {
        dmaFinish(&dp);  // espera a GDMA: o proximo quadro reusa os blocos
    } else if (fb != nullptr) {
        tftInstance->directFbFlush(y, h);  // o DMA do painel le a PSRAM
    } else {
        s_frame->markDirty(x, y, x + w - 1, y + h - 1);
    }
    duk_push_number(ctx, (duk_double_t)r);
#else
    (void)m; (void)a0; (void)a1;
    duk_push_number(ctx, kNoTarget);
#endif
    return 1;
}

duk_ret_t JSBindings::js_nativeGrab(duk_context* ctx) {
    // pixels do alvo corrente (quadro/sprite/display) -> scratch[off], RGB565
    // com bytes TROCADOS (o formato que nativeDraw/nativeScreen usam). O app
    // desenha algo com a API normal e o core captura (carimbos do overlay).
    NativeModule* m = moduleAt(duk_require_int(ctx, 0));
    if (m == nullptr) { duk_push_boolean(ctx, 0); return 1; }
    int32_t off = duk_is_number(ctx, 1) ? duk_get_int(ctx, 1) : 0;
    int32_t x = duk_is_number(ctx, 2) ? duk_get_int(ctx, 2) : 0;
    int32_t y = duk_is_number(ctx, 3) ? duk_get_int(ctx, 3) : 0;
    int32_t w = duk_is_number(ctx, 4) ? duk_get_int(ctx, 4) : 0;
    int32_t h = duk_is_number(ctx, 5) ? duk_get_int(ctx, 5) : 0;
    if (off < 0 || w <= 0 || h <= 0 || (off & 1) ||
        (size_t)off + (size_t)w * (size_t)h * 2 > m->scratchSize) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
#if CONFIG_CELEROS_UI
    lgfx::LGFXBase* tgt = gfx();
    if (tgt == nullptr) { duk_push_boolean(ctx, 0); return 1; }
    tgt->readRect(jsx(x), jsy(y), w, h, reinterpret_cast<lgfx::swap565_t*>(m->scratch + off));
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
    bool okw = m->feed->write(m->scratch + off, (size_t)len);
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
