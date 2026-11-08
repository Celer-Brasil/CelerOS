// Golden do LakeSnes ORIGINAL: CRC32 por quadro do main screen em RGB565
// (256 px, linhas 1..224) + CRC do PCM. Uso: golden ROM FRAMES OUT.txt [snapdir]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "snes.h"

static uint32_t crc32(const void* d, size_t n, uint32_t crc) {
  const uint8_t* p = d; crc = ~crc;
  while(n--) { crc ^= *p++; for(int i = 0; i < 8; i++) crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1)); }
  return ~crc;
}
// roteiro de input deterministico (mesmo no golden e no core novo)
static uint16_t script(int f) {
  uint16_t b = 0;  // bits: 0 B 1 Y 2 Sel 3 St 4 U 5 D 6 L 7 R 8 A 9 X 10 L 11 R
  if((f >= 150 && f < 156) || (f >= 600 && f < 606) || (f >= 900 && f < 906) || (f >= 1200 && f < 1206) || (f >= 1420 && f < 1426)) b |= 1 << 3;
  if(f >= 1600) {
    b |= 1 << 7;                 // direita
    if((f % 90) < 20) b |= 1;    // pulo
    if((f % 240) > 200) b |= 1 << 1; // corre
  }
  return b;
}
int main(int c, char** v) {
  FILE* f = fopen(v[1], "rb"); if(!f) return 2;
  fseek(f, 0, 2); long n = ftell(f); fseek(f, 0, 0);
  uint8_t* b = malloc(n); fread(b, 1, n, f); fclose(f);
  int frames = atoi(v[2]);
  FILE* out = fopen(v[3], "w");
  Snes* s = snes_init(); if(!snes_loadRom(s, b, n)) return 1;
  static uint8_t px[512 * 480 * 4]; static int16_t smp[2 * 800];
  static uint16_t fb[256 * 224];
  struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0);
  for(int i = 0; i < frames; i++) {
    uint16_t bt = script(i);
    for(int k = 0; k < 12; k++) snes_setButtonState(s, 1, k, (bt >> k) & 1);
    snes_runFrame(s); snes_setSamples(s, smp, 534);
    // setPixels: 512x(2*239) BGRX, linha y*2, pixel par/impar; pega o impar (main)
    for(int y = 0; y < 224; y++) for(int x = 0; x < 256; x++) {
      Ppu* pp = s->ppu; int row = y + (pp->evenFrame ? 0 : 239);
      uint8_t* p = pp->pixelBuffer + row * 2048 + x * 8 + 4 + pp->pixelOutputFormat;
      fb[y * 256 + x] = (uint16_t)(((p[2] >> 3) << 11) | ((p[1] >> 2) << 5) | (p[0] >> 3));
    }
    fprintf(out, "%d %08x %08x\n", i, crc32(fb, sizeof(fb), 0), crc32(smp, 534 * 4, 0));
    if(c > 4 && (i % (c > 5 ? atoi(v[5]) : 300) == 0)) {
      char nm[512]; snprintf(nm, sizeof nm, "%s/f%05d.ppm", v[4], i);
      FILE* o = fopen(nm, "wb"); fprintf(o, "P6 256 224 255\n");
      for(int k = 0; k < 256 * 224; k++) { uint16_t q = fb[k]; fputc((q >> 11) << 3, o); fputc(((q >> 5) & 63) << 2, o); fputc((q & 31) << 3, o); }
      fclose(o);
    }
  }
  clock_gettime(CLOCK_MONOTONIC, &t1);
  fprintf(stderr, "%.3f ms/frame\n", ((t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6) / frames);
  fclose(out);
  return 0;
}
