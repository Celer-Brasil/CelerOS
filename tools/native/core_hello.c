/* Blob de teste do spike de codigo nativo carregavel (CelerOS, API 57).
 *
 * Contrato de cada entrada (o loader do firmware so conhece esta assinatura):
 *   uint32_t fn(void* scratch, int32_t a0, int32_t a1);
 *
 * Regras do blob (o builder recusa o contrario em tools/native/build_core.py):
 *   - autocontido: sem libc, sem globais, nenhum endereco tomado
 *     (relocation absoluta ou l32r no desassembly = build barrado);
 *   - chamadas internas PC-relative diretas (blob ate 512 KB, sem
 *     -mlongcalls: call8 direto alcanca +/-256 KB);
 *   - "scratch" e memoria do dono (PSRAM alocada pelo loader); o CHAMADOR
 *     garante os limites — o blob nao sabe o tamanho do scratch;
 *   - entradas do blob = funcoes core_* em ORDEM DE ENDERECO (nm -n): o
 *     app chama por indice (System.nativeCall(h, 0, ...) = primeira).
 *
 * Estado futuro real (assinatura, contexto rico, multi-alvo) esta desenhado
 * em Documentation/Estudo_Native_Loader.pt-BR.md.
 */

typedef unsigned int u32;
typedef int i32;

/* [0] add: soma inteira — o "ping" do spike (registradores e retorno). */
u32 core_add(void* scratch, i32 a, i32 b) {
    (void)scratch;
    return (u32)(a + b);
}

/* [1] fib: laco aritmetico puro (o custo de chamada vs Duktape, medido). */
u32 core_fib(void* scratch, i32 n, i32 unused) {
    (void)scratch;
    (void)unused;
    u32 a = 0u, b = 1u;
    if (n < 0) n = 0;
    if (n > 50) n = 50;  /* trava o laco; uint32 faz wrap, deterministico */
    while (n-- > 0) {
        u32 t = a + b;
        a = b;
        b = t;
    }
    return a;
}

/* [2] fill: escreve o padrao deterministico v = (i*31 + (i>>6)) & 0xFF em
 * w*h bytes do scratch e devolve o checksum rotate-xor — o ".Native" 
 * escreveu memoria que o JS consegue ler de volta (System.nativeRead). */
u32 core_fill(void* scratch, i32 w, i32 h) {
    unsigned char* p = (unsigned char*)scratch;
    u32 area = (u32)w * (u32)h;
    u32 c = 0u;
    if (area > (1u << 20)) area = (1u << 20);  /* teto de seguranca do blob */
    for (u32 i = 0u; i < area; i++) {
        unsigned char v = (unsigned char)((i * 31u + (i >> 6)) & 0xFFu);
        p[i] = v;
        c = ((c << 1) | (c >> 31)) ^ (u32)v;
    }
    return c;
}
