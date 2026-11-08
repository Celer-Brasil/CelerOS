// Renderizador de linha da PPU do CelerOS (substitui o ppu_handlePixel /
// ppu_getPixel do LakeSnes, que avaliava cada camada e a janela POR PIXEL:
// ~75% do tempo do host na tela-titulo do Mario All-Stars).
//
// Modelo (mesmo resultado do original, pixel a pixel — conferido contra o
// golden do LakeSnes em test/cpp/snes_test.cpp):
//  - cada par (camada, prioridade) do modo tem um RANK (posicao na lista
//    layersPerMode/prioritysPerMode; menor = na frente). O original pegava o
//    primeiro pixel opaco percorrendo a lista; aqui cada camada e decodificada
//    UMA vez na linha e escrita num z-buffer de main e outro de sub quando o
//    rank dela vence — equivalente.
//  - BG comum (modos 0/1/3/5-sem-hires...) sai por SLIVER de 8 pixels: uma
//    leitura de tilemap e 1-4 palavras de planos por tile, nao por pixel.
//  - Mode 7 tem laco proprio (a matriz ja e por pixel).
//  - Modos com offset-per-tile (2/4/6) e hires (5/6) usam o caminho generico
//    por pixel (raros; mantem a semantica do original, inclusive par/impar).
//  - Mosaico horizontal = replica do pixel na coluna x - x % tamanho (o
//    original deslocava lx antes de buscar: mesmo valor).
//  - Saida: RGB565 com bytes trocados (formato do painel/nativeScreen), uma
//    linha por vez para lineSink e/ou outFb.

#ifndef SNES_FAST
#define SNES_FAST
#endif

// rank[modo efetivo 0-9][camada 0-4][prioridade 0-3]; 0xFF = nao existe
static uint8_t s_rank[10][5][4] SNES_FAST;
// Linha de trabalho: o que e ESCRITO a cada linha (z-buffers, camadas
// decodificadas, saida, cache de cores). Fica numa struct apontada por s_w
// (estatica por padrao): da para trocar por outro buffer (ppu_setWork), mas
// a bancada 4848 nao mediu ganho com ela na pilha (RAM interna) — com o dado
// quente no cache da PSRAM o custo e de instrucao.
typedef struct PpuWork {
  uint8_t mz[256];     // rank vencedor no main
  uint8_t sz[256];     // rank vencedor no sub
  uint8_t mlay[256];   // camada do main (0-3 bg, 4 obj, 5 fundo)
  uint8_t slay[256];
  uint16_t mpix[256];  // indice de cgram (ou cor direta 11 bits)
  uint16_t spix[256];
  // camada decodificada: valor | 0x8000 se prioridade alta; 0 = transparente.
  // +16 de margem dos dois lados para slivers parciais e tiles de 16 px.
  uint16_t lp[256 + 32];
  uint16_t lp2[256 + 32];  // sub no hires
  uint16_t hi[512 + 16];   // linha de 512 do modo 5
  uint16_t line[256];      // saida RGB565 trocado
  // cor final (RGB565 trocado, com brilho) de cada entrada da CGRAM: o pixel
  // sem color math/recorte/cor direta sai com UMA leitura
  uint16_t pal[256];
  uint16_t cg15[256];      // copia da CGRAM (BGR555) para o color math
  uint32_t sp[256];        // CGRAM espalhada: r bits 0-4, g 10-14, b 20-24
} PpuWork;

static PpuWork s_workStatic;
static PpuWork* s_w = &s_workStatic;
#define s_mz (s_w->mz)
#define s_sz (s_w->sz)
#define s_mlay (s_w->mlay)
#define s_slay (s_w->slay)
#define s_mpix (s_w->mpix)
#define s_spix (s_w->spix)
#define s_lp (s_w->lp)
#define s_lp2 (s_w->lp2)
#define s_hi (s_w->hi)
#define s_line (s_w->line)
#define s_pal (s_w->pal)
#define s_cg15 (s_w->cg15)
#define s_sp (s_w->sp)

// troca a area de trabalho (NULL = estatica); o cache de cores e refeito
static inline void ppu_setWork(Ppu* ppu, PpuWork* w) {
  s_w = w != NULL ? w : &s_workStatic;
  ppu->palDirty = true;
}
static uint8_t s_win[6][256] SNES_FAST;     // mascara de janela por camada (5 = cor)
static uint8_t s_lutRB[32] SNES_FAST;       // canal 5 bits -> 5 bits com brilho
static uint8_t s_lutG[32] SNES_FAST;        // canal 5 bits -> 6 bits com brilho
static uint8_t s_lutBright = 0xFF;
static uint8_t s_palBright = 0xFF;
// planar -> chunky: byte de plano -> 8 pixels em nibbles (pixel 0 = esquerda
// no nibble 0); [1] = espelhado (hflip)
static uint32_t s_planeLut[2][256] SNES_FAST;


static void ppu_buildRankTable(void) {
  for(int b = 0; b < 256; b++) {
    uint32_t n = 0, f = 0;
    for(int i = 0; i < 8; i++) {
      if(b & (0x80 >> i)) n |= 1u << (4 * i);
      if(b & (1 << i)) f |= 1u << (4 * i);
    }
    s_planeLut[0][b] = n;
    s_planeLut[1][b] = f;
  }
  memset(s_rank, 0xFF, sizeof(s_rank));
  for(int m = 0; m < 10; m++) {
    for(int i = 0; i < layerCountPerMode[m]; i++) {
      int l = layersPerMode[m][i], p = prioritysPerMode[m][i];
      if(l < 5 && s_rank[m][l][p] == 0xFF) s_rank[m][l][p] = (uint8_t) i;
    }
  }
}

static void ppu_buildLut(uint8_t bright) {
  // mesmo arredondamento do original: canal expandido a 8 bits, * brilho / 15,
  // e so entao reduzido a 5/6 bits
  for(int c = 0; c < 32; c++) {
    int v = ((c << 3) | (c >> 2)) * bright / 15;
    s_lutRB[c] = (uint8_t) (v >> 3);
    s_lutG[c] = (uint8_t) (v >> 2);
  }
  s_lutBright = bright;
}

static inline uint16_t ppu_out565(int r, int g, int b) {
  uint16_t c = (uint16_t) ((s_lutRB[r] << 11) | (s_lutG[g] << 5) | s_lutRB[b]);
  return (uint16_t) ((c >> 8) | (c << 8));
}

// BGR555 -> campos de 5 bits com um bit de guarda entre eles (r 0-4, g
// 10-14, b 20-24): soma/subtracao saturada dos 3 canais numa conta so
#define PPU_SP_FIELDS 0x01F07C1Fu
#define PPU_SP_GUARD 0x02008020u
static inline uint32_t ppu_spread(uint16_t c) {
  return (uint32_t) (c & 0x1f) | ((uint32_t) (c & 0x3e0) << 5) | ((uint32_t) (c & 0x7c00) << 10);
}

// escrita na CGRAM (ppu_write $2122): atualiza so a entrada; mudanca de
// brilho/estado refaz tudo pelo palDirty
static void ppu_palEntry(Ppu* ppu, uint8_t idx) {
  // a tabela de brilho atual pode nao ser a do cache (linha em forced blank
  // ja trocou o LUT): ai so marca para refazer tudo
  if(ppu->palDirty || s_lutBright != s_palBright) {
    ppu->palDirty = true;
    return;
  }
  uint16_t c = ppu->cgram[idx];
  s_cg15[idx] = c;
  s_sp[idx] = ppu_spread(c);
  s_pal[idx] = ppu_out565(c & 0x1f, (c >> 5) & 0x1f, (c >> 10) & 0x1f);
}

// mascara da janela para a camada (1 = dentro da janela -> camada recortada)
static void ppu_buildWindow(Ppu* ppu, int layer) {
  uint8_t* w = s_win[layer];
  WindowLayer* wl = &ppu->windowLayer[layer];
  if(!wl->window1enabled && !wl->window2enabled) {
    memset(w, 0, 256);
    return;
  }
  for(int x = 0; x < 256; x++) w[x] = ppu_getWindowState(ppu, layer, x) ? 1 : 0;
}

// ---- BG por sliver -----------------------------------------------------

// endereco da palavra do tilemap para (lx, ly) ja com scroll (0..1023)
static inline uint16_t ppu_tilemapWord(Ppu* ppu, BgLayer* bg, int lx, int ly, int tbx, int tby) {
  uint16_t adr = bg->tilemapAdr + (((ly >> tby) & 0x1f) << 5 | ((lx >> tbx) & 0x1f));
  if((lx & (0x100 << (tbx - 3))) && bg->tilemapWider) adr += 0x400;
  if((ly & (0x100 << (tby - 3))) && bg->tilemapHigher) adr += bg->tilemapWider ? 0x800 : 0x400;
  return ppu->vram[adr & 0x7fff];
}

// decodifica os 8 pixels de uma linha de tile (bd = 2/4/8 bits) em out[0..7]
// ja na ordem da tela; base = valor de paleta somado ao pixel opaco. Planos
// viram nibbles por tabela (planar -> chunky): sem extrair bit a bit.
static inline void ppu_decodeSliver(Ppu* ppu, uint16_t* out, uint16_t adr, int bd, bool hflip, uint16_t base) {
  const uint16_t* v = ppu->vram;
  const uint32_t* lut = s_planeLut[hflip ? 1 : 0];
  uint32_t p01 = v[adr & 0x7fff];
  uint32_t lo = lut[p01 & 0xff] | (lut[p01 >> 8] << 1);
  uint32_t hi = 0;
  if(bd > 2) {
    uint32_t p23 = v[(adr + 8) & 0x7fff];
    lo |= (lut[p23 & 0xff] << 2) | (lut[p23 >> 8] << 3);
    if(bd > 4) {
      uint32_t p45 = v[(adr + 16) & 0x7fff];
      uint32_t p67 = v[(adr + 24) & 0x7fff];
      hi = lut[p45 & 0xff] | (lut[p45 >> 8] << 1) | (lut[p67 & 0xff] << 2) | (lut[p67 >> 8] << 3);
    }
  }
  if((lo | hi) == 0) {
    for(int i = 0; i < 8; i++) out[i] = 0;
    return;
  }
  for(int i = 0; i < 8; i++) {
    uint32_t px = ((lo >> (4 * i)) & 0xf) | (((hi >> (4 * i)) & 0xf) << 4);
    out[i] = px ? (uint16_t) (base + px) : 0;
  }
}

// camada BG sem OPT/hires: s_lp[16 + x] para x em 0..255
static void ppu_renderBgFast(Ppu* ppu, int layer, int y, int bd) {
  BgLayer* bg = &ppu->bgLayer[layer];
  int ly = y;
  if(bg->mosaicEnabled && ppu->mosaicSize > 1) ly -= (ly - ppu->mosaicStartLine) % ppu->mosaicSize;
  ly = (ly + bg->vScroll) & 0x3ff;
  const int big = bg->bigTiles;
  const int tb = big ? 4 : 3;
  const int hs = bg->hScroll;
  const int palShift = bd == 2 ? 2 : bd == 4 ? 4 : 8;
  const int palAdd = ppu->mode == 0 ? 8 * layer : 0;
  const int wordsPerTile = 4 * bd;
  uint16_t* lp = s_lp + 16;
  // primeira coluna alinhada a 8 pixels de tela
  int sx = -(hs & 7);
  for(; sx < 256; sx += 8) {
    int lx = (hs + sx) & 0x3ff;  // multiplo de 8
    uint16_t tile = ppu_tilemapWord(ppu, bg, lx, ly, tb, tb);
    bool hflip = tile & 0x4000;
    int row = (tile & 0x8000) ? 7 - (ly & 7) : (ly & 7);
    int tileNum = tile & 0x3ff;
    if(big) {
      if(((lx & 8) != 0) ^ hflip) tileNum += 1;
      if(((ly & 8) != 0) ^ ((tile & 0x8000) != 0)) tileNum += 0x10;
    }
    int pal = ((tile & 0x1c00) >> 10) + palAdd;
    uint16_t base = (uint16_t) ((pal << palShift) | ((tile & 0x2000) ? 0x8000 : 0));
    uint16_t adr = (uint16_t) (bg->tileAdr + ((tileNum & 0x3ff) * wordsPerTile) + row);
    ppu_decodeSliver(ppu, lp + sx, adr, bd, hflip, base);
  }
}

// camada BG do modo 5 (hires sem OPT, mosaico desligado na camada): a linha tem 512 px
// logicos com tiles de 16 px de largura; o main ve as colunas IMPARES
// (lx * 2 + 1) e o sub as PARES — mesma conta do caminho generico, mas por
// sliver de 8 px numa linha de 512

static void ppu_renderBgHires(Ppu* ppu, int layer, int y, int bd) {
  BgLayer* bg = &ppu->bgLayer[layer];
  int ly = y;
  if(ppu->interlace) ly = ly * 2 + (ppu->evenFrame ? 0 : 1);
  ly = (ly + bg->vScroll) & 0x3ff;
  const int tby = bg->bigTiles ? 4 : 3;
  const int palShift = bd == 2 ? 2 : bd == 4 ? 4 : 8;
  const int wordsPerTile = 4 * bd;
  const int start = (bg->hScroll * 2) & 0x3ff;  // coluna logica do x = 0 (par)
  const int base0 = start & ~7;
  // slivers cobrindo [start, start + 512)
  for(int i = 0; i < 520; i += 8) {
    int lx = (base0 + i) & 0x3ff;
    uint16_t tile = ppu_tilemapWord(ppu, bg, lx, ly, 4, tby);
    bool hflip = tile & 0x4000;
    int row = (tile & 0x8000) ? 7 - (ly & 7) : (ly & 7);
    int tileNum = tile & 0x3ff;
    if(((lx & 8) != 0) ^ hflip) tileNum += 1;
    if(bg->bigTiles && (((ly & 8) != 0) ^ ((tile & 0x8000) != 0))) tileNum += 0x10;
    int pal = (tile & 0x1c00) >> 10;
    uint16_t base = (uint16_t) ((pal << palShift) | ((tile & 0x2000) ? 0x8000 : 0));
    uint16_t adr = (uint16_t) (bg->tileAdr + ((tileNum & 0x3ff) * wordsPerTile) + row);
    ppu_decodeSliver(ppu, s_hi + i, adr, bd, hflip, base);
  }
  uint16_t* lp = s_lp + 16;
  uint16_t* lp2 = s_lp2 + 16;
  const uint16_t* src = s_hi + (start - base0);
  for(int x = 0; x < 256; x++) {
    lp2[x] = src[2 * x];      // sub: coluna par
    lp[x] = src[2 * x + 1];   // main: coluna impar
  }
}

// ---- caminho generico (OPT, hires 5/6): mesma conta do original --------

// valor do pixel da camada em (lx, ly) ja escalados/com scroll, qualquer
// prioridade: valor | 0x8000 se a prioridade do tile for alta
static uint16_t ppu_bgPixelAny(Ppu* ppu, int x, int y, int layer) {
  BgLayer* bg = &ppu->bgLayer[layer];
  bool wideTiles = bg->bigTiles || ppu->mode == 5 || ppu->mode == 6;
  int tbx = wideTiles ? 4 : 3;
  int tby = bg->bigTiles ? 4 : 3;
  uint16_t tile = ppu_tilemapWord(ppu, bg, x, y, tbx, tby);
  int paletteNum = (tile & 0x1c00) >> 10;
  int row = (tile & 0x8000) ? 7 - (y & 0x7) : (y & 0x7);
  int col = (tile & 0x4000) ? (x & 0x7) : 7 - (x & 0x7);
  int tileNum = tile & 0x3ff;
  if(wideTiles && (((x & 8) != 0) ^ ((tile & 0x4000) != 0))) tileNum += 1;
  if(bg->bigTiles && (((y & 8) != 0) ^ ((tile & 0x8000) != 0))) tileNum += 0x10;
  int bitDepth = bitDepthsPerMode[ppu->mode][layer];
  if(ppu->mode == 0) paletteNum += 8 * layer;
  uint16_t a = (uint16_t) (bg->tileAdr + ((tileNum & 0x3ff) * 4 * bitDepth) + row);
  uint16_t p1 = ppu->vram[a & 0x7fff];
  int pixel = ((p1 >> col) & 1) | (((p1 >> (8 + col)) & 1) << 1);
  int paletteSize = 4;
  if(bitDepth > 2) {
    paletteSize = 16;
    uint16_t p2 = ppu->vram[(a + 8) & 0x7fff];
    pixel |= (((p2 >> col) & 1) << 2) | (((p2 >> (8 + col)) & 1) << 3);
  }
  if(bitDepth > 4) {
    paletteSize = 256;
    uint16_t p3 = ppu->vram[(a + 16) & 0x7fff];
    uint16_t p4 = ppu->vram[(a + 24) & 0x7fff];
    pixel |= (((p3 >> col) & 1) << 4) | (((p3 >> (8 + col)) & 1) << 5);
    pixel |= (((p4 >> col) & 1) << 6) | (((p4 >> (8 + col)) & 1) << 7);
  }
  if(pixel == 0) return 0;
  return (uint16_t) ((paletteSize * paletteNum + pixel) | ((tile & 0x2000) ? 0x8000 : 0));
}

static uint16_t ppu_bgGenericAt(Ppu* ppu, int layer, int x, int y, bool sub) {
  BgLayer* bg = &ppu->bgLayer[layer];
  int lx = x, ly = y;
  if(bg->mosaicEnabled && ppu->mosaicSize > 1) {
    lx -= lx % ppu->mosaicSize;
    ly -= (ly - ppu->mosaicStartLine) % ppu->mosaicSize;
  }
  lx += bg->hScroll;
  if(ppu->mode == 5 || ppu->mode == 6) {
    lx *= 2;
    lx += (sub || bg->mosaicEnabled) ? 0 : 1;
    if(ppu->interlace) {
      ly *= 2;
      ly += (ppu->evenFrame || bg->mosaicEnabled) ? 0 : 1;
    }
  }
  ly += bg->vScroll;
  if(ppu->mode == 2 || ppu->mode == 4 || ppu->mode == 6) ppu_handleOPT(ppu, layer, &lx, &ly);
  return ppu_bgPixelAny(ppu, lx & 0x3ff, ly & 0x3ff, layer);
}

// ---- Mode 7 -------------------------------------------------------------

static void ppu_renderMode7(Ppu* ppu, int layer) {
  uint16_t* lp = s_lp + 16;
  const bool ext = layer == 1;
  const int a = ppu->m7matrix[0], c = ppu->m7matrix[2];
  const int sx0 = ppu->m7startX, sy0 = ppu->m7startY;
  const bool large = ppu->m7largeField, fill = ppu->m7charFill;
  for(int x = 0; x < 256; x++) {
    uint8_t rx = ppu->m7xFlip ? 255 - x : x;
    int xPos = (sx0 + a * rx) >> 8;
    int yPos = (sy0 + c * rx) >> 8;
    bool outside = large && (xPos < 0 || xPos >= 1024 || yPos < 0 || yPos >= 1024);
    xPos &= 0x3ff;
    yPos &= 0x3ff;
    uint8_t tile = outside ? 0 : ppu->vram[(yPos >> 3) * 128 + (xPos >> 3)] & 0xff;
    uint8_t pixel = (outside && !fill) ? 0 : ppu->vram[tile * 64 + (yPos & 7) * 8 + (xPos & 7)] >> 8;
    if(ext) {
      lp[x] = (pixel & 0x7f) ? (uint16_t) ((pixel & 0x7f) | ((pixel & 0x80) ? 0x8000 : 0)) : 0;
    } else {
      lp[x] = pixel;  // camada 0 do modo 7: prioridade unica (rank da prio 0)
    }
  }
}

// ---- composicao ---------------------------------------------------------

// z-merge de uma camada numa tela. Ponteiros locais __restrict: com os
// arrays de byte acessados via s_w (global), cada store de uint8 obrigava o
// GCC a recarregar s_w e as bases dentro do laco (mesmo efeito visto no
// Anemoia com *ptr_member++).
static inline void ppu_mergeOne(const uint16_t* __restrict lp, uint8_t rLo, uint8_t rHi, uint8_t layer,
                                const uint8_t* __restrict win, uint8_t* __restrict z,
                                uint16_t* __restrict pix, uint8_t* __restrict lay) {
  if(win == NULL) {
    for(int x = 0; x < 256; x++) {
      uint16_t v = lp[x];
      if(!v) continue;
      uint8_t r = (v & 0x8000) ? rHi : rLo;
      if(r < z[x]) {
        z[x] = r;
        pix[x] = v & 0x7fff;
        lay[x] = layer;
      }
    }
  } else {
    for(int x = 0; x < 256; x++) {
      uint16_t v = lp[x];
      if(!v || win[x]) continue;
      uint8_t r = (v & 0x8000) ? rHi : rLo;
      if(r < z[x]) {
        z[x] = r;
        pix[x] = v & 0x7fff;
        lay[x] = layer;
      }
    }
  }
}

static inline void ppu_merge(const uint16_t* lp, const uint16_t* lpSub, int layer, int am,
                             bool mainOn, bool subOn, const uint8_t* mwin, const uint8_t* swin) {
  const uint8_t rLo = s_rank[am][layer][0], rHi = s_rank[am][layer][1];
  PpuWork* w = s_w;
  if(mainOn) ppu_mergeOne(lp, rLo, rHi, (uint8_t) layer, mwin, w->mz, w->mpix, w->mlay);
  if(subOn) ppu_mergeOne(lpSub, rLo, rHi, (uint8_t) layer, swin, w->sz, w->spix, w->slay);
}

static inline void ppu_color(Ppu* ppu, int am, int layer, uint16_t pix, int* r, int* g, int* b) {
  if(ppu->directColor && layer < 4 && bitDepthsPerMode[am][layer] == 8) {
    *r = ((pix & 0x7) << 2) | ((pix & 0x100) >> 7);
    *g = ((pix & 0x38) >> 1) | ((pix & 0x200) >> 8);
    *b = ((pix & 0xc0) >> 3) | ((pix & 0x400) >> 8);
  } else {
    uint16_t color = ppu->cgram[pix & 0xff];
    *r = color & 0x1f;
    *g = (color >> 5) & 0x1f;
    *b = (color >> 10) & 0x1f;
  }
}

static void ppu_emitLine(Ppu* ppu, int line) {
  if(ppu->outFb != NULL && line >= 1 && line <= 239) {
    memcpy(ppu->outFb + (line - 1) * 256, s_line, sizeof(s_line));
  }
  if(ppu->lineSink != NULL) ppu->lineSink(ppu->lineCtx, line - 1, s_line);
}

static void ppu_runLineImpl(Ppu* ppu, int line);

void ppu_runLine(Ppu* ppu, int line) {
  // called for lines 1-224/239
  if(!ppu->renderOn) return;  // quadro pulado: nada da linha e visivel
  if(ppu->deferOn && ppu->snapCount < 240) {
    // so a foto dos registradores; o desenho sai em lote (ppu_flushLines)
    uint8_t* d = ppu->snapBuf + ppu->snapCount * (2 + PPU_SNAP_BYTES);
    d[0] = (uint8_t) line;
    d[1] = ppu->oamAdr;
    memcpy(d + 2, (uint8_t*) ppu + PPU_SNAP_OFF, PPU_SNAP_BYTES);
    ppu->snapCount++;
    return;
  }
  SNES_PROF_BEGIN();
  ppu_runLineImpl(ppu, line);
  SNES_PROF_END(0);
}

#ifndef FLUSH_HOOK
#define FLUSH_HOOK(n, why) do { } while(0)
#endif
// s_flushWhy (declarado no ppu.c): quem pediu a descarga (bancada)

void ppu_flushLines(Ppu* ppu) {
  int n = ppu->snapCount;
  if(n == 0) return;
  FLUSH_HOOK(n, s_flushWhy);
  s_flushWhy = 0;
  ppu->snapCount = 0;
  SNES_PROF_BEGIN();
  // guarda o estado vivo, desenha cada linha com a foto dela e volta; as
  // flags de sprite (time/range over) seguem em ordem, como no desenho na hora
  uint8_t live[PPU_SNAP_BYTES];
  uint8_t liveOam = ppu->oamAdr;
  memcpy(live, (uint8_t*) ppu + PPU_SNAP_OFF, PPU_SNAP_BYTES);
  bool tOver = ppu->timeOver, rOver = ppu->rangeOver;
  for(int i = 0; i < n; i++) {
    const uint8_t* d = ppu->snapBuf + i * (2 + PPU_SNAP_BYTES);
    memcpy((uint8_t*) ppu + PPU_SNAP_OFF, d + 2, PPU_SNAP_BYTES);
    ppu->oamAdr = d[1];
    ppu->timeOver = tOver;
    ppu->rangeOver = rOver;
    ppu_runLineImpl(ppu, d[0]);
    tOver = ppu->timeOver;
    rOver = ppu->rangeOver;
  }
  memcpy((uint8_t*) ppu + PPU_SNAP_OFF, live, PPU_SNAP_BYTES);
  ppu->oamAdr = liveOam;
  ppu->timeOver = tOver;
  ppu->rangeOver = rOver;
  SNES_PROF_END(0);
}

static void ppu_runLineImpl(Ppu* ppu, int line) {
  if(ppu->brightness != s_lutBright) ppu_buildLut(ppu->brightness);
  if(ppu->forcedBlank) {
    memset(s_line, 0, sizeof(s_line));
    ppu_emitLine(ppu, line);
    return;
  }
  // sprites da linha (mesmo avaliador do original)
  {
    SNES_PROF_BEGIN();
    memset(ppu->objPixelBuffer, 0, sizeof(ppu->objPixelBuffer));
    ppu_evaluateSprites(ppu, line - 1);
    SNES_PROF_END(2);
  }
  if(ppu->mode == 7) ppu_calculateMode7Starts(ppu, line);

  int am = ppu->mode == 1 && ppu->bg3priority ? 8 : ppu->mode;
  am = ppu->mode == 7 && ppu->m7extBg ? 9 : am;
  const bool hires = ppu->pseudoHires || ppu->mode == 5 || ppu->mode == 6;
  bool anyMath = false;
  for(int i = 0; i < 6; i++) anyMath |= ppu->mathEnabled[i];
  const bool needSub = hires || (anyMath && ppu->addSubscreen);

  memset(s_mz, 0xFF, 256);
  memset(s_mlay, 5, 256);
  memset(s_mpix, 0, sizeof(s_mpix));
  if(needSub) {
    memset(s_sz, 0xFF, 256);
    memset(s_slay, 5, 256);
    memset(s_spix, 0, sizeof(s_spix));
  }

  // camadas 0-3 + sprites (4)
  for(int L = 0; L < 5; L++) {
    if(s_rank[am][L][0] == 0xFF && s_rank[am][L][1] == 0xFF && s_rank[am][L][2] == 0xFF &&
       s_rank[am][L][3] == 0xFF) continue;
    Layer* ly = &ppu->layer[L];
    bool mainOn = ly->mainScreenEnabled;
    bool subOn = needSub && ly->subScreenEnabled;
    if(!mainOn && !subOn) continue;
    const uint8_t* mwin = NULL;
    const uint8_t* swin = NULL;
    if((mainOn && ly->mainScreenWindowed) || (subOn && ly->subScreenWindowed)) {
      ppu_buildWindow(ppu, L);
      if(ly->mainScreenWindowed) mwin = s_win[L];
      if(ly->subScreenWindowed) swin = s_win[L];
    }
    uint16_t* lp = s_lp + 16;
    const uint16_t* lpSub = lp;
    if(L == 4) {
      // sprites: prioridade 0-3 -> rank direto
      const uint8_t* __restrict rk4 = s_rank[am][4];
      const uint8_t* __restrict op = ppu->objPixelBuffer;
      const uint8_t* __restrict opr = ppu->objPriorityBuffer;
      PpuWork* w = s_w;
      for(int pass = 0; pass < 2; pass++) {
        if(pass == 0 ? !mainOn : !subOn) continue;
        const uint8_t* __restrict win = pass == 0 ? mwin : swin;
        uint8_t* __restrict z = pass == 0 ? w->mz : w->sz;
        uint16_t* __restrict pix = pass == 0 ? w->mpix : w->spix;
        uint8_t* __restrict lay = pass == 0 ? w->mlay : w->slay;
        for(int x = 0; x < 256; x++) {
          uint8_t v = op[x];
          if(!v || (win && win[x])) continue;
          uint8_t r = rk4[opr[x]];
          if(r < z[x]) {
            z[x] = r;
            pix[x] = v;
            lay[x] = 4;
          }
        }
      }
      continue;
    }
    BgLayer* bg = &ppu->bgLayer[L];
    if(ppu->mode == 7) {
      ppu_renderMode7(ppu, L);
    } else if(ppu->mode == 5 && !bg->mosaicEnabled) {
      ppu_renderBgHires(ppu, L, line, bitDepthsPerMode[am][L]);
      ppu_merge(lp, s_lp2 + 16, L, am, mainOn, subOn, mwin, swin);
      continue;
    } else if(ppu->mode == 2 || ppu->mode == 4 || ppu->mode == 5 || ppu->mode == 6) {
      for(int x = 0; x < 256; x++) lp[x] = ppu_bgGenericAt(ppu, L, x, line, false);
      if((ppu->mode == 5 || ppu->mode == 6) && subOn) {
        uint16_t* lp2 = s_lp2 + 16;
        for(int x = 0; x < 256; x++) lp2[x] = ppu_bgGenericAt(ppu, L, x, line, true);
        lpSub = lp2;
      }
      ppu_merge(lp, lpSub, L, am, mainOn, subOn, mwin, swin);
      continue;
    } else {
      ppu_renderBgFast(ppu, L, line, bitDepthsPerMode[am][L]);
    }
    // mosaico horizontal (mode 7 incluso: a coluna buscada era x - x % n)
    if(bg->mosaicEnabled && ppu->mosaicSize > 1) {
      int n = ppu->mosaicSize;
      for(int x = 0; x < 256; x++) {
        int src = x - x % n;
        if(src != x) lp[x] = lp[src];
      }
    }
    ppu_merge(lp, lp, L, am, mainOn, subOn, mwin, swin);
  }

  // janela de cor (clip / prevent math)
  const bool needColorWin = ppu->clipMode == 1 || ppu->clipMode == 2 ||
                            ppu->preventMathMode == 1 || ppu->preventMathMode == 2;
  if(needColorWin) ppu_buildWindow(ppu, 5);
  const uint8_t* cwin = s_win[5];
  SNES_PROF_BEGIN();
  if(ppu->palDirty || s_palBright != ppu->brightness) {
    for(int i = 0; i < 256; i++) {
      uint16_t c = ppu->cgram[i];
      s_cg15[i] = c;
      s_sp[i] = ppu_spread(c);
      s_pal[i] = ppu_out565(c & 0x1f, (c >> 5) & 0x1f, (c >> 10) & 0x1f);
    }
    ppu->palDirty = false;
    s_palBright = ppu->brightness;
  }
  // pixel "simples" (sem recorte, sem color math, sem cor direta) sai pelo
  // cache; o resto pela conta completa do original, inline sobre a copia
  // 15 bits da CGRAM (RAM rapida)
  uint8_t mathOf[7];
  for(int i = 0; i < 6; i++) mathOf[i] = ppu->mathEnabled[i];
  mathOf[6] = 0;
  const int clip = ppu->clipMode;
  const int prevent = ppu->preventMathMode;
  const bool directAny = ppu->directColor;
  const bool add = ppu->addSubscreen;
  const bool sub = ppu->subtractColor;
  const bool half = ppu->halfColor;
  const int fr = ppu->fixedColorR, fg = ppu->fixedColorG, fb = ppu->fixedColorB;
  bool direct8[6] = {false, false, false, false, false, false};
  if(directAny) {
    for(int l = 0; l < 4; l++) direct8[l] = bitDepthsPerMode[am][l] == 8;
  }

  // Caso comum (sem recorte, sem prevent, sem cor direta): sem math o pixel
  // sai do cache; com math, soma/subtracao saturada empacotada (campos de 5
  // bits com guarda) — mesma conta do original canal a canal: soma ou
  // diferenca, metade (se pedida) e trava em 0..31.
  if(clip == 0 && prevent == 0 && !directAny) {
    bool anyM = false;
    for(int i = 0; i < 6; i++) anyM |= mathOf[i] != 0;
    PpuWork* w = s_w;
    const uint8_t* __restrict mlayP = w->mlay;
    const uint8_t* __restrict slayP = w->slay;
    const uint16_t* __restrict mpixP = w->mpix;
    const uint16_t* __restrict spixP = w->spix;
    const uint16_t* __restrict palP = w->pal;
    const uint32_t* __restrict spP = w->sp;
    uint16_t* __restrict out = w->line;
    if(!anyM) {
      for(int x = 0; x < 256; x++) out[x] = palP[mpixP[x] & 0xff];
    } else {
      const uint32_t fixedSp = (uint32_t) fr | ((uint32_t) fg << 10) | ((uint32_t) fb << 20);
      for(int x = 0; x < 256; x++) {
        int ml = mlayP[x];
        uint16_t mp = mpixP[x];
        if(ml == 4 && mp < 0xc0) ml = 6;
        if(!mathOf[ml]) {
          out[x] = palP[mp & 0xff];
          continue;
        }
        uint32_t a = spP[mp & 0xff];
        uint32_t o = fixedSp;
        bool doHalf = half;
        if(add) {
          if(slayP[x] != 5) o = spP[spixP[x] & 0xff];
          else doHalf = false;  // sub = fundo: soma a cor fixa sem metade
        }
        uint32_t r;
        if(!sub) {
          r = a + o;
          if(doHalf) {
            r = (r >> 1) & PPU_SP_FIELDS;
          } else {
            uint32_t ov = r & PPU_SP_GUARD;
            r = (r | (ov - (ov >> 5))) & PPU_SP_FIELDS;
          }
        } else {
          r = (a | PPU_SP_GUARD) - o;
          uint32_t keep = r & PPU_SP_GUARD;
          r &= (keep - (keep >> 5)) & PPU_SP_FIELDS;
          if(doHalf) r = (r >> 1) & PPU_SP_FIELDS;
        }
        out[x] = ppu_out565(r & 0x1f, (r >> 10) & 0x1f, (r >> 20) & 0x1f);
      }
    }
    SNES_PROF_END(3);
    ppu_emitLine(ppu, line);
    return;
  }

  for(int x = 0; x < 256; x++) {
    int ml = s_mlay[x];
    uint16_t mp = s_mpix[x];
    if(ml == 4 && mp < 0xc0) ml = 6;
    if(clip == 0 && (prevent == 3 || !mathOf[ml]) && !direct8[ml < 6 ? ml : 5]) {
      s_line[x] = s_pal[mp & 0xff];
      continue;
    }
    bool cw = needColorWin && cwin[x];
    uint16_t c = direct8[ml < 6 ? ml : 5]
      ? (uint16_t) ((((mp & 0x7) << 2) | ((mp & 0x100) >> 7)) |
                    ((((mp & 0x38) >> 1) | ((mp & 0x200) >> 8)) << 5) |
                    ((((mp & 0xc0) >> 3) | ((mp & 0x400) >> 8)) << 10))
      : s_cg15[mp & 0xff];
    int r = c & 0x1f, g = (c >> 5) & 0x1f, b = (c >> 10) & 0x1f;
    if(clip == 3 || (clip == 2 && cw) || (clip == 1 && !cw)) r = g = b = 0;
    bool math = ml < 6 && mathOf[ml] && !(prevent == 3 || (prevent == 2 && cw) || (prevent == 1 && !cw));
    if(math) {
      int second = 5;
      int ar = fr, ag = fg, ab = fb;
      if(add) {
        second = s_slay[x];
        if(second != 5) {
          uint16_t sp = s_spix[x];
          uint16_t c2 = (second < 4 && direct8[second])
            ? (uint16_t) ((((sp & 0x7) << 2) | ((sp & 0x100) >> 7)) |
                          ((((sp & 0x38) >> 1) | ((sp & 0x200) >> 8)) << 5) |
                          ((((sp & 0xc0) >> 3) | ((sp & 0x400) >> 8)) << 10))
            : s_cg15[sp & 0xff];
          ar = c2 & 0x1f; ag = (c2 >> 5) & 0x1f; ab = (c2 >> 10) & 0x1f;
        }
      }
      if(sub) {
        r -= ar; g -= ag; b -= ab;
      } else {
        r += ar; g += ag; b += ab;
      }
      if(half && (second != 5 || !add)) {
        r >>= 1; g >>= 1; b >>= 1;
      }
      if(r > 31) r = 31;
      if(g > 31) g = 31;
      if(b > 31) b = 31;
      if(r < 0) r = 0;
      if(g < 0) g = 0;
      if(b < 0) b = 0;
    }
    s_line[x] = ppu_out565(r, g, b);
  }
  SNES_PROF_END(3);
  ppu_emitLine(ppu, line);
}
