/* Runtime freestanding dos blobs CLRN v2 (tools/native/runtime.c).
 *
 * Incluido no TU unico do blob (build_core.py) — por isso tudo em extern "C"
 * quando compilado como C++. Satisfaz os simbolos que um core C/C++ real
 * puxa sem libc:
 *   - memcpy/memset/memmove/memcmp (o compilador emite chamadas mesmo com
 *     -ffreestanding quando o laco e grande);
 *   - malloc/free/calloc com free-list sobre uma arena estatica no .bss do
 *     blob (o loader zera o .bss antes da primeira entrada).
 *
 * A arena vive DENTRO do .bss do blob, que cai na regiao de scratch logo
 * apos a imagem: os offsets uteis do app comecam depois de CORE_RESERVED
 * (core_ctl devolve esse numero). Tamanho por CORE_ARENA_BYTES (-D).
 * operator new/delete ficam em runtime_new.hpp (so C++).
 */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef CORE_ARENA_BYTES
// Fallback pequeno: cores de verdade chamam nes_arena_use() com um buffer da
// SCRATCH (PSRAM) — a arena nao precisa ocupar .bss, que agora vive na RAM
// interna do loader junto da imagem (orcamento apertado).
#define CORE_ARENA_BYTES (8u * 1024u)
#endif

static uint8_t g_arena_static[CORE_ARENA_BYTES] __attribute__((aligned(8)));
static uint8_t* g_arena;
static size_t g_arena_cap;

/* Free-list da arena (typedef aqui: nes_arena_use/arena_ensure usam antes). */
typedef struct Block {
    struct Block* next;
    uint32_t size;   /* bytes uteis */
    uint32_t free;   /* 1 = livre */
} Block;

static Block* g_blocks;
static uint8_t* g_top;

/* Aponta a arena para um buffer do chamador (ex.: scratch+offset do blob).
 * Zera o estado da arena; o conteudo do buffer nao e limpo (blocos sao
 * escritos antes de ler). */
void nes_arena_use(void* buf, uint32_t cap) {
    g_arena = (uint8_t*)buf;
    g_arena_cap = (size_t)cap;
    g_blocks = 0;
    g_top = 0;
}

void* memcpy(void* dst, const void* src, size_t n) {
    uint8_t* d = (uint8_t*)dst;
    const uint8_t* s = (const uint8_t*)src;
    while (n--) *d++ = *s++;
    return dst;
}

void* memmove(void* dst, const void* src, size_t n) {
    uint8_t* d = (uint8_t*)dst;
    const uint8_t* s = (const uint8_t*)src;
    if (d < s) {
        while (n--) *d++ = *s++;
    } else if (d > s) {
        d += n;
        s += n;
        while (n--) *--d = *--s;
    }
    return dst;
}

void* memset(void* dst, int c, size_t n) {
    uint8_t* d = (uint8_t*)dst;
    while (n--) *d++ = (uint8_t)c;
    return dst;
}

int memcmp(const void* a, const void* b, size_t n) {
    const uint8_t* x = (const uint8_t*)a;
    const uint8_t* y = (const uint8_t*)b;
    while (n--) {
        if (*x != *y) return (int)*x - (int)*y;
        x++; y++;
    }
    return 0;
}

/* Alocador first-fit sobre a arena: header de 8 B por bloco, lista unica
 * encadeada; free marca livre e o malloc seguinte reaproveita. O padrao do
 * core (aloca na carga, cria/destroi cartucho+mapper no load) cabe nisto.
 * A arena nunca cresce nem devolve ao loader; reset = nova partida do app. */
void nes_arena_reset(void) {
    g_blocks = 0;
    g_top = g_arena;
}

static void arena_ensure(void) {
    if (g_arena == 0) {
        g_arena = g_arena_static;
        g_arena_cap = sizeof(g_arena_static);
        g_top = g_arena;
    }
}

void* malloc(size_t n) {
    if (n == 0) n = 1;
    n = (n + 7u) & ~(size_t)7u;  /* payload alinhado a 8 */
    arena_ensure();
    if (g_top == 0) nes_arena_reset();
    for (Block* b = g_blocks; b != 0; b = b->next) {
        if (b->free && b->size >= n) {
            b->free = 0;
            return (uint8_t*)b + sizeof(Block);
        }
    }
    size_t need = n + sizeof(Block);
    if ((size_t)(g_top - g_arena) + need > g_arena_cap) return 0;
    Block* b = (Block*)g_top;
    g_top += need;
    b->next = g_blocks;
    b->size = (uint32_t)n;
    b->free = 0;
    g_blocks = b;
    return (uint8_t*)b + sizeof(Block);
}

void free(void* p) {
    if (p == 0) return;
    Block* b = (Block*)((uint8_t*)p - sizeof(Block));
    b->free = 1;
}

void* calloc(size_t n, size_t sz) {
    size_t total = n * sz;
    void* p = malloc(total);
    if (p != 0) memset(p, 0, total);
    return p;
}

/* Espaco total da arena configurada (core_ctl reporta o layout). */
uint32_t nes_arena_bytes(void) { return (uint32_t)g_arena_cap; }

#ifdef __cplusplus
}  /* extern "C" */
#endif
