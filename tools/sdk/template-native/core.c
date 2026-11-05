/* Blob nativo inicial do app (formato "CLRN" — tools/native/build_core.py).
 *
 * Contrato de CADA entrada (o loader do firmware so conhece esta assinatura):
 *   uint32_t fn(void* scratch, int32_t a0, int32_t a1);
 *   - "scratch" e memoria do dono (PSRAM, alocada pelo loader; o CHAMADOR
 *     garante os limites — o blob nao sabe o tamanho);
 *   - a0/a1 sao int32 livres (indices, dimensoes, flags...); retorno uint32.
 *
 * Regras do formato (o builder barra o contrario):
 *   - autocontido: sem libc, sem globais, nenhum endereco tomado
 *     (relocation, l32r e callx sao barrados no build);
 *   - chamadas internas PC-relative diretas (blob ate 512 KB);
 *   - ordem das entradas = ORDEM DE ENDERECO das funcoes core_* (nm -n; na
 *     pratica, a ordem de definicao no arquivo): o app chama por indice —
 *     System.nativeCall(h, 0, ...) e a primeira core_* definida.
 *
 * Build: node tools/sdk/celer.js native <pasta do app>   ->  <pasta>/core.bin
 * Load:  System.nativeLoad(System.appDir() + "/core.bin")
 */

typedef unsigned int u32;
typedef int i32;

/* [0] add: exemplo minimo — o "ping" (ida e volta por registradores). */
u32 core_add(void* scratch, i32 a, i32 b) {
    (void)scratch;
    return (u32)(a + b);
}

/* [1] fill: escreve um padrao deterministico em area do scratch e devolve o
 * checksum — o molde de "o nativo calcula e o JS desenha/consome". */
u32 core_fill(void* scratch, i32 w, i32 h) {
    unsigned char* p = (unsigned char*)scratch;
    u32 area = (u32)w * (u32)h;
    u32 c = 0u;
    if (area > (1u << 22)) area = (1u << 22);  /* teto de seguranca do blob */
    for (u32 i = 0u; i < area; i++) {
        unsigned char v = (unsigned char)((i * 31u + (i >> 6)) & 0xFFu);
        p[i] = v;
        c = ((c << 1) | (c >> 31)) ^ (u32)v;
    }
    return c;
}
