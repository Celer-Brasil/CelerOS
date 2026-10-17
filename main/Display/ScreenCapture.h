#pragma once

#include <stddef.h>
#include <stdint.h>
#include <functional>

// ============================================================================
// ScreenCapture — leitura da tela SEGURA entre tasks.
//
// O LovyanGFX nao e thread-safe: o contador de transacao do SPI e do objeto,
// nao da task, entao um readRect de outra task (celerctl, servidor web) no
// meio de um desenho da UI embaralha a transferencia. Aqui quem le o display
// e SEMPRE a task da UI: as outras pedem blocos de linhas e a UI atende em
// pontos seguros (celerLoop, present() e delay() dos apps) — um bloco por
// vez, com a UI seguindo entre eles (tela fluida enquanto espelha).
// ============================================================================
namespace ScreenCapture {

// Registra a task da UI (chamar no setup, na task que desenha).
void init();

// Qualquer task: le `n` linhas a partir de `y` em `dst` (RGB565, n*w px).
// Na task da UI le direto; nas outras espera a UI atender (ate timeoutMs).
// Devolve as linhas lidas (0 = timeout). Ao retornar, a UI nao escreve mais
// em `dst` (o pedido e cancelado ou concluido) — o chamador pode liberar o
// buffer logo em seguida.
int readRows(uint16_t y, uint16_t n, uint16_t* dst, uint32_t timeoutMs = 2000);

// Task da UI, em ponto seguro: atende o pedido pendente (barato sem pedido).
void service();

// delay() da task da UI que continua atendendo capturas durante a espera.
void serviceDelay(uint32_t ms);

// Tela inteira comprimida, bloco a bloco, para `sink` (false aborta):
//   rle=true:  pares {u16 contagem, u16 pixel RGB565} LE
//   rle=false: pixels RGB565 LE crus
// `buf`/`cap`: buffer de saida do chamador (cap multiplo de 4).
bool stream(bool rle, uint8_t* buf, size_t cap, const std::function<bool(const uint8_t*, size_t)>& sink);

}  // namespace ScreenCapture
