// Core novo x golden do LakeSnes original. Uso: newh ROM FRAMES GOLD.txt [dumpdir]
// Sai 0 se todos os quadros (video e audio) batem.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "SnesCore.cpp"

static uint32_t crc32b(const void* d, size_t n, uint32_t crc) {
  const uint8_t* p = (const uint8_t*) d; crc = ~crc;
  while(n--) { crc ^= *p++; for(int i = 0; i < 8; i++) crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1)); }
  return ~crc;
}
static uint16_t script(int f) {
  uint16_t b = 0;
  if((f >= 150 && f < 156) || (f >= 600 && f < 606) || (f >= 900 && f < 906) || (f >= 1200 && f < 1206) || (f >= 1420 && f < 1426)) b |= 1 << 3;
  if(f >= 1600) {
    b |= 1 << 7;
    if((f % 90) < 20) b |= 1;
    if((f % 240) > 200) b |= 1 << 1;
  }
  return b;
}
static void dump(const char* nm, const uint16_t* fb) {
  FILE* o = fopen(nm, "wb"); fprintf(o, "P6 256 224 255\n");
  for(int k = 0; k < 256 * 224; k++) { uint16_t q = fb[k]; fputc((q >> 11) << 3, o); fputc(((q >> 5) & 63) << 2, o); fputc((q & 31) << 3, o); }
  fclose(o);
}
int main(int c, char** v) {
  FILE* f = fopen(v[1], "rb"); if(!f) return 2;
  fseek(f, 0, 2); long n = ftell(f); fseek(f, 0, 0);
  uint8_t* b = (uint8_t*) malloc(n); if(fread(b, 1, n, f) != (size_t) n) return 2; fclose(f);
  int frames = atoi(v[2]);
  FILE* g = c > 3 ? fopen(v[3], "r") : NULL;
  Snes* s = snes_init(); if(!snes_loadRom(s, b, n)) return 1;
  static uint8_t snapq[64 * 1024]; if(!getenv("SNES_NODEFER")) ppu_setSnapBuffer(s->ppu, snapq);
  static uint16_t fbs[256 * 239], fb[256 * 224]; static int16_t smp[2 * 800];
  snes_setFrameBuffer(s, fbs);
  int bad = 0, badA = 0, first = -1;
  double tot = 0;
  for(int i = 0; i < frames; i++) {
    uint16_t bt = script(i);
    for(int k = 0; k < 12; k++) snes_setButtonState(s, 1, k, (bt >> k) & 1);
    struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0);
    snes_runFrame(s); snes_setSamples(s, smp, 534);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    tot += (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6;
    for(int k = 0; k < 256 * 224; k++) fb[k] = (uint16_t) ((fbs[k] >> 8) | (fbs[k] << 8));
    uint32_t cv = crc32b(fb, sizeof(fb), 0), ca = crc32b(smp, 534 * 4, 0);
    if(g) {
      int gi; unsigned gv, ga;
      if(fscanf(g, "%d %x %x", &gi, &gv, &ga) != 3) break;
      if(gv != cv) { if(first < 0) { first = i; if(c > 4) { char nm[600]; snprintf(nm, sizeof nm, "%s/bad%05d.ppm", v[4], i); dump(nm, fb); } } bad++; }
      if(ga != ca) badA++;
    }
  }
  printf("%-70s %.3f ms/q  video %d/%d ruins (1o %d)  audio %d\n", v[1], tot / frames, bad, frames, first, badA);
  return (bad || badA) ? 1 : 0;
}
