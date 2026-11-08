#pragma once
/**
 * @file celeros_core.h
 * @brief Contrato do CORE DE LOGICA nativo (blob CLRN) de um app CelerOS.
 *
 * O padrao "aplicacao industrial": o PACOTE do app entrega as regras em
 * codigo nativo (core.bin) e o main.js fica so com input, desenho e UI.
 * O blob nao chama o JS e nao tem callbacks: o fluxo e sempre JS -> blob
 * por `System.nativeCall`, e o resultado sai no SCRATCH (bloco de saida),
 * lido de volta por `System.nativeRead` em fatias de 256 B.
 *
 * Uso minimo (o template `celer.js new NOME --native-logic` ja vem assim):
 *
 *   uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg) {
 *       switch (cmd) {
 *       case CORE_INIT:        ... s_out = sc + OUT_OFF; return 1;
 *       case CORE_STEP:        step(arg); return CELER_STEP_ALL;
 *       case CORE_OUT_OFF:     return OUT_OFF;
 *       case CORE_OUT_SIZE:    return CELER_OUT_BYTES(sizeof(State));
 *       ...
 *       }
 *   }
 *
 * Contrato do lado JS (ver template-native-logic/main.js):
 *   1. h = nativeLoad(appDir + "/core.bin", kb); nativeCall(h, 0, CORE_INIT);
 *   2. (opcional) nativeWrite(h, levelOff, binario); nativeCall(h, 0, CORE_LOAD_LEVEL, bytes);
 *   3. por quadro: nativeCall(h, 0, CORE_STEP, input); ler o bloco (head + estado
 *      + sujos + eventos) e desenhar.
 *
 * REGRAS DO BLOB (herdadas do loader CLRN):
 *  - sem libc/RTOS: nada de malloc do sistema, arquivo, task, tempo ou IO;
 *  - estado quente em .bss (o builder permite; `.clrn_fast` vai para a RAM
 *    interna em firmware que entende o campo fastSize);
 *  - tick CURTO por chamada (o exec-timeout nao ve o codigo nativo: um
 *    laco longo derruba o aparelho pelo watchdog) — um quadro por chamada;
 *  - inteiros de 32 bits na fronteira; float so dentro do core e nunca no
 *    bloco de saida (Q16.16 e o formato combinado).
 */

#include <stddef.h>
#include <stdint.h>

#define CELER_CORE_VERSION 1

// ---------------------------------------------------------------- comandos
// Entrada unica: uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg).
enum {
    CORE_INIT = 0,        // arg: 0. Aponta os ponteiros do scratch; devolve 1.
    CORE_RESET = 1,       // arg: seed/flags do app. Reinicia a partida; 1.
    CORE_STEP = 2,        // arg: mascara de input. Avanca UM quadro; devolve CELER_STEP_*.
    CORE_LOAD_LEVEL = 3,  // arg: bytes ja copiados em LEVEL_OFF; 1 = carregou.
    CORE_OUT_OFF = 4,     // -> offset do bloco de saida (relativo ao scratch).
    CORE_OUT_SIZE = 5,    // -> bytes do bloco de saida (head+estado+sujos+eventos).
    CORE_LEVEL_OFF = 6,   // -> offset da area de nivel (nativeWrite/nativeLoadFile).
    CORE_LEVEL_SIZE = 7,  // -> capacidade da area de nivel em bytes.
    CORE_SAVE = 8,        // serializa o estado no scratch; devolve bytes escritos.
    CORE_LOAD_STATE = 9,  // arg: bytes validos; 1 = carregou.
};

// Bits devolvidos por CORE_STEP (o JS usa para pular leitura/desenho).
enum {
    CELER_STEP_STATE = 1,   // estado mudou (sempre que o tick avancou)
    CELER_STEP_EVENTS = 2,  // ha eventos no bloco (som, dano, morte, item...)
    CELER_STEP_DIRTY = 4,   // ha celulas sujas (desenhe so elas)
    CELER_STEP_ALL = 7,
};

// ------------------------------------------------------------- wire format
// Bloco de saida no scratch, tudo little-endian:
//
//   [CelerCoreHead 8 B]
//   [estado  stateBytes B]                 (layout do app; Q16.16 por convencao)
//   [sujos   CELER_MAX_DIRTY * 2 B]        (indice u16 de celula)
//   [eventos CELER_MAX_EVENTS * 8 B]       ({type,a,b,c} u16)
//
// As duas listas tem area FIXA (o core pode emitir ate o teto; os counts do
// head dizem quantos valem). Assim os offsets nao dependem do que aconteceu
// no quadro e o JS le o bloco inteiro de uma vez (ou em fatias de 256 B).
#define CELER_MAX_DIRTY 512
#define CELER_MAX_EVENTS 32
#define CELER_OUT_HEAD 8
#define CELER_OUT_DIRTY_BYTES (CELER_MAX_DIRTY * 2)
#define CELER_OUT_EVENT_BYTES (CELER_MAX_EVENTS * 8)
// stateBytes DEVE ser multiplo de 4 (alinhamento u16/u32 das listas).
#define CELER_OUT_BYTES(stateBytes) \
    ((uint32_t)CELER_OUT_HEAD + (uint32_t)(stateBytes) + CELER_OUT_DIRTY_BYTES + CELER_OUT_EVENT_BYTES)

typedef struct {
    uint16_t version;     // CELER_CORE_VERSION
    uint16_t stateBytes;  // bytes de estado (o layout e do app)
    uint16_t eventCount;  // eventos validos na area de eventos
    uint16_t dirtyCount;  // celulas sujas validas
} CelerCoreHead;

typedef struct {
    uint16_t type;  // tipo do evento (do app)
    uint16_t a, b, c;  // parametros (celula, entidade, valor)
} CelerCoreEvent;

// ------------------------------------------------------------ Q16.16 (fixo)
// Nada de float no bloco de saida: o Duktape le bytes e monta os numeros.
#define CELER_Q 8
#define CELER_ONE (1 << CELER_Q)
static inline int32_t celer_fx(int32_t v) { return (int32_t)(v * CELER_ONE); }
static inline int32_t celer_px(int32_t v) { return (int32_t)(v / CELER_ONE); }
static inline int32_t celer_mul(int32_t a, int32_t b) {
    return (int32_t)(((int64_t)a * (int64_t)b) >> CELER_Q);
}
static inline int32_t celer_div(int32_t a, int32_t b) {
    return b == 0 ? 0 : (int32_t)(((int64_t)a << CELER_Q) / b);
}
// Raiz inteira (distancias em px, sem libm): floor(sqrt(v)).
static inline uint32_t celer_isqrt(uint32_t v) {
    uint32_t r = 0, bit = 1u << 30;
    while (bit > v) bit >>= 2;
    while (bit) {
        if (v >= r + bit) { v -= r + bit; r = (r >> 1) + bit; }
        else r >>= 1;
        bit >>= 2;
    }
    return r;
}

// ------------------------------------------------------------- escritor
typedef struct {
    uint8_t* out;         // inicio do bloco de saida
    uint16_t cap;         // capacidade (CELER_OUT_BYTES(stateBytes))
    uint16_t stateBytes;
    uint16_t dirtyCount;
    uint16_t eventCount;
} CelerCoreOut;

static inline void celer_core_begin(CelerCoreOut* o, void* out, uint16_t cap, uint16_t stateBytes) {
    o->out = (uint8_t*)out;
    o->cap = cap;
    o->stateBytes = stateBytes;
    o->dirtyCount = 0;
    o->eventCount = 0;
    CelerCoreHead* h = (CelerCoreHead*)out;
    h->version = CELER_CORE_VERSION;
    h->stateBytes = stateBytes;
    h->eventCount = 0;
    h->dirtyCount = 0;
}

/// Ponteiro do bloco de estado (preencha os campos e chame celer_core_end).
static inline void* celer_core_state(CelerCoreOut* o) {
    return o->out + CELER_OUT_HEAD;
}

/// Marca uma celula como suja (o JS redesenha so ela).
static inline void celer_core_dirty(CelerCoreOut* o, uint16_t cell) {
    if (o->dirtyCount >= CELER_MAX_DIRTY) return;
    uint16_t* p = (uint16_t*)(o->out + CELER_OUT_HEAD + o->stateBytes);
    p[o->dirtyCount++] = cell;
}

/// Enfileira um evento (som, dano, morte, item, saida...).
static inline void celer_core_event(CelerCoreOut* o, uint16_t type,
                                    uint16_t a, uint16_t b, uint16_t c) {
    if (o->eventCount >= CELER_MAX_EVENTS) return;  // anel cheio: descarta o novo (estado terminal va nos bits do STEP/head, nao em evento)
    uint16_t* p = (uint16_t*)(o->out + CELER_OUT_HEAD + o->stateBytes + CELER_OUT_DIRTY_BYTES);
    p += (size_t)o->eventCount * 4;
    p[0] = type; p[1] = a; p[2] = b; p[3] = c;
    o->eventCount++;
}

/// Fecha o quadro: grava os counts no head.
static inline void celer_core_end(CelerCoreOut* o) {
    CelerCoreHead* h = (CelerCoreHead*)o->out;
    h->version = CELER_CORE_VERSION;
    h->stateBytes = o->stateBytes;
    h->eventCount = o->eventCount;
    h->dirtyCount = o->dirtyCount;
}
