
#ifndef SNES_H
#define SNES_H

#include <stdint.h>
#include <stdbool.h>

// Perfil por subsistema (o blob define SNES_PROF_NOW como o ccount do
// Xtensa; no host fica desligado): soma ciclos em snes_prof[k].
//   0 = PPU (linhas)  1 = APU (catch-up)  2 = DMA/HDMA
#ifdef SNES_PROF_NOW
extern uint32_t snes_prof[4];
#define SNES_PROF_BEGIN() uint32_t snes_prof_t0 = SNES_PROF_NOW()
#define SNES_PROF_END(k) (snes_prof[k] += SNES_PROF_NOW() - snes_prof_t0)
#else
#define SNES_PROF_BEGIN() do { } while(0)
#define SNES_PROF_END(k) do { } while(0)
#endif

// log do core: stderr no host (CELER_HOST_TEST/teste), calado no blob
#ifndef SNES_LOG
#if defined(EMU_BLOB)
#define SNES_LOG(...) do { } while(0)
#else
#include <stdio.h>
#define SNES_LOG(...) fprintf(stderr, __VA_ARGS__)
#endif
#endif

typedef struct Snes Snes;

#include "cpu.h"
#include "apu.h"
#include "dma.h"
#include "ppu.h"
#include "cart.h"
#include "input.h"
#include "statehandler.h"

struct Snes {
  Cpu* cpu;
  Apu* apu;
  Ppu* ppu;
  Dma* dma;
  Cart* cart;
  bool palTiming;
  // input
  Input* input1;
  Input* input2;
  // ram
  uint8_t ram[0x20000];
  uint32_t ramAdr;
  // frame timing
  uint16_t hPos;
  uint16_t vPos;
  uint32_t frames;
  uint64_t cycles;
  uint64_t syncCycle;
  // cpu handling
  int32_t apuOwed;   // ciclos de APU devidos (negativo = APU adiantada)
  uint32_t apuFrac;  // fracao: (master * APU_NUM) % DEN
  // nmi / irq
  bool hIrqEnabled;
  bool vIrqEnabled;
  bool nmiEnabled;
  uint16_t hTimer;
  uint16_t vTimer;
  bool inNmi;
  bool irqCondition;
  bool inIrq;
  bool inVblank;
  // joypad handling
  uint16_t portAutoRead[4]; // as read by auto-joypad read
  bool autoJoyRead;
  uint16_t autoJoyTimer; // times how long until reading is done
  bool ppuLatch;
  // multiplication/division
  uint8_t multiplyA;
  uint16_t multiplyResult;
  uint16_t divideA;
  uint16_t divideResult;
  // misc
  bool fastMem;
  uint8_t openBus;
  // CelerOS: atalho do escalonador e creditos preguicosos
  uint32_t nextEv;         // runCycles pode so somar se hPos + n <= nextEv (0 = recalcula)
  uint64_t apuCredited;    // ate que snes->cycles a APU ja foi creditada
  uint64_t autoJoyEnd;     // auto-joypad ocupado enquanto cycles < autoJoyEnd
};

// UMA instancia por vez (CelerOS): o mapa de paginas da CPU e as linhas de
// trabalho da PPU sao estaticos (o blob roda um console so)
Snes* snes_init(void);
void snes_free(Snes* snes);
void snes_reset(Snes* snes, bool hard);
void snes_handleState(Snes* snes, StateHandler* sh);
void snes_runFrame(Snes* snes);
// used by dma, cpu
void snes_runCycles(Snes* snes, int cycles);
void snes_syncCycles(Snes* snes, bool start, int syncCycles);
uint8_t snes_readBBus(Snes* snes, uint8_t adr);
void snes_writeBBus(Snes* snes, uint8_t adr, uint8_t val);
uint8_t snes_read(Snes* snes, uint32_t adr);
void snes_write(Snes* snes, uint32_t adr, uint8_t val);
void snes_cpuIdle(void* mem, bool waiting);
uint8_t snes_cpuRead(void* mem, uint32_t adr);
void snes_cpuWrite(void* mem, uint32_t adr, uint8_t val);
// mapa de memoria por pagina de 8 KB (refazer apos LOAD/estado/$420D)
void snes_buildMemMap(Snes* snes);
// debugging
void snes_runCpuCycle(Snes* snes);
void snes_runSpcCycle(Snes* snes);

// snes_other.c functions:

bool snes_loadRom(Snes* snes, const uint8_t* data, int length);
void snes_setButtonState(Snes* snes, int player, int button, bool pressed);
void snes_setFrameBuffer(Snes* snes, uint16_t* fb);
void snes_setSamples(Snes* snes, int16_t* sampleData, int samplesPerFrame);
int snes_saveBattery(Snes* snes, uint8_t* data);
bool snes_loadBattery(Snes* snes, uint8_t* data, int size);
int snes_saveState(Snes* snes, uint8_t* data);
int snes_saveStateTo(Snes* snes, uint8_t* buf, int cap);
bool snes_loadState(Snes* snes, uint8_t* data, int size);

#endif
