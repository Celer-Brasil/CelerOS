
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

#include "snes.h"
#include "cpu.h"
#include "apu.h"
#include "spc.h"
#include "dma.h"
#include "ppu.h"
#include "cart.h"
#include "input.h"
#include "statehandler.h"

#ifndef SNES_FAST
#define SNES_FAST
#endif

// Mapa de memoria da CPU (CelerOS) por pagina de 8 KB (2048 paginas nos 24
// bits): ponteiro de leitura/escrita direta para WRAM e ROM pura, e o tempo
// de acesso. Pagina sem ponteiro (I/O, SRAM, open bus) vai pelo caminho
// original (snes_rread/snes_write); tempo 0 = pagina mista ($4000-$5FFF).
static const uint8_t* s_rdMap[2048] SNES_FAST;
static uint8_t* s_wrMap[2048] SNES_FAST;
static uint8_t s_accTime[2048] SNES_FAST;

// Relogio da APU em inteiro exato (o S3 nao tem FPU double e o blob nao
// linka divisao de 64 bits): apu = master * NUM / DEN, guardado como ciclos
// inteiros devidos (apuOwed, negativo = APU adiantada porque roda opcodes
// inteiros) + fracao (apuFrac < DEN). Mesmo resultado do double do LakeSnes
// (conferido quadro a quadro no golden).
#define APU_NUM 1025280u /* 32040 * 32 */
#define APU_DEN_NTSC 21442080u /* 1364 * 262 * 60 */
#define APU_DEN_PAL 21278400u /* 1364 * 312 * 50 */

static inline void snes_apuAdvance(Snes* snes, uint32_t masterCycles) {
  // masterCycles <= ~4000 por chamada: cabe em 32 bits (4000 * NUM + DEN < 2^32)
  uint32_t den = snes->palTiming ? APU_DEN_PAL : APU_DEN_NTSC;
  uint32_t t = snes->apuFrac + masterCycles * APU_NUM;
  snes->apuOwed += (int32_t) (t / den);
  snes->apuFrac = t % den;
}

// (v % n) sem divisao de 64 bits (n <= 65536)
static inline uint32_t snes_mod64(uint64_t v, uint32_t n) {
  uint32_t r = (uint32_t) (v >> 32) % n;
  uint32_t lo = (uint32_t) v;
  r = ((r << 16) | (lo >> 16)) % n;
  r = ((r << 16) | (lo & 0xffff)) % n;
  return r;
}

static void snes_runCycle(Snes* snes);
static void snes_catchupApu(Snes* snes);
static void snes_doAutoJoypad(Snes* snes);
static uint8_t snes_readReg(Snes* snes, uint16_t adr);
static void snes_writeReg(Snes* snes, uint16_t adr, uint8_t val);
static uint8_t snes_rread(Snes* snes, uint32_t adr); // wrapped by read, to set open bus
static int snes_getAccessTime(Snes* snes, uint32_t adr);

Snes* snes_init(void) {
  Snes* snes = (Snes*) malloc(sizeof(Snes));
  snes->cpu = cpu_init(snes, snes_cpuRead, snes_cpuWrite, snes_cpuIdle);
  snes->apu = apu_init(snes);
  snes->dma = dma_init(snes);
  snes->ppu = ppu_init(snes);
  snes->cart = cart_init(snes);
  snes->input1 = input_init(snes);
  snes->input2 = input_init(snes);
  snes->palTiming = false;
  return snes;
}

void snes_free(Snes* snes) {
  cpu_free(snes->cpu);
  apu_free(snes->apu);
  dma_free(snes->dma);
  ppu_free(snes->ppu);
  cart_free(snes->cart);
  input_free(snes->input1);
  input_free(snes->input2);
  free(snes);
}

void snes_reset(Snes* snes, bool hard) {
  cpu_reset(snes->cpu, hard);
  apu_reset(snes->apu);
  dma_reset(snes->dma);
  ppu_reset(snes->ppu);
  input_reset(snes->input1);
  input_reset(snes->input2);
  cart_reset(snes->cart);
  if(hard) memset(snes->ram, 0, sizeof(snes->ram));
  snes->ramAdr = 0;
  snes->hPos = 0;
  snes->vPos = 0;
  snes->frames = 0;
  snes->cycles = 0;
  snes->syncCycle = 0;
  snes->apuOwed = 0;
  snes->apuFrac = 0;
  snes->apuCredited = 0;
  snes->nextEv = 0;
  snes->autoJoyEnd = 0;
  snes->hIrqEnabled = false;
  snes->vIrqEnabled = false;
  snes->nmiEnabled = false;
  snes->hTimer = 0x1ff;
  snes->vTimer = 0x1ff;
  snes->inNmi = false;
  snes->irqCondition = false;
  snes->inIrq = false;
  snes->inVblank = false;
  memset(snes->portAutoRead, 0, sizeof(snes->portAutoRead));
  snes->autoJoyRead = false;
  snes->autoJoyTimer = 0;
  snes->ppuLatch = false;
  snes->multiplyA = 0xff;
  snes->multiplyResult = 0xfe01;
  snes->divideA = 0xffff;
  snes->divideResult = 0x101;
  snes->fastMem = false;
  snes->openBus = 0;
  snes_buildMemMap(snes);
}

static void snes_apuCredit(Snes* snes);

void snes_handleState(Snes* snes, StateHandler* sh) {
  if(sh->saving) {
    // creditos preguicosos viram o estado explicito do LakeSnes
    snes_apuCredit(snes);
    snes->autoJoyTimer = snes->autoJoyEnd > snes->cycles ? (uint16_t) (snes->autoJoyEnd - snes->cycles) : 0;
  }
  sh_handleBools(sh,
    &snes->palTiming, &snes->hIrqEnabled, &snes->vIrqEnabled, &snes->nmiEnabled, &snes->inNmi, &snes->irqCondition,
    &snes->inIrq, &snes->inVblank, &snes->autoJoyRead, &snes->ppuLatch, &snes->fastMem, NULL
  );
  sh_handleBytes(sh, &snes->multiplyA, &snes->openBus, NULL);
  sh_handleWords(sh,
    &snes->hPos, &snes->vPos, &snes->hTimer, &snes->vTimer,
    &snes->portAutoRead[0], &snes->portAutoRead[1], &snes->portAutoRead[2], &snes->portAutoRead[3],
    &snes->autoJoyTimer, &snes->multiplyResult, &snes->divideA, &snes->divideResult, NULL
  );
  sh_handleInts(sh, &snes->ramAdr, &snes->frames, NULL);
  sh_handleLongLongs(sh, &snes->cycles, &snes->syncCycle, NULL);
  sh_handleInts(sh, (uint32_t*) &snes->apuOwed, &snes->apuFrac, NULL);
  sh_handleByteArray(sh, snes->ram, 0x20000);
  if(!sh->saving) {
    snes->apuCredited = snes->cycles;
    snes->autoJoyEnd = snes->cycles + snes->autoJoyTimer;
    snes->nextEv = 0;
    snes_buildMemMap(snes);  // fastMem do estado
  }
  // components
  cpu_handleState(snes->cpu, sh);
  dma_handleState(snes->dma, sh);
  ppu_handleState(snes->ppu, sh);
  apu_handleState(snes->apu, sh);
  input_handleState(snes->input1, sh);
  input_handleState(snes->input2, sh);
  cart_handleState(snes->cart, sh);
}

void snes_runFrame(Snes* snes) {
  // TODO: improve handling of dma's that take up entire vblank / frame
  // run until we are starting a new frame (leaving vblank)
  while(snes->inVblank) {
    cpu_runOpcode(snes->cpu);
  }
  // then run until we are at vblank, or we end up at next frame (DMA caused vblank to be skipped)
  uint32_t frame = snes->frames;
  while(!snes->inVblank && frame == snes->frames) {
    cpu_runOpcode(snes->cpu);
  }
  snes_catchupApu(snes); // catch up the apu after running
  ppu_flushLines(snes->ppu);  // linhas adiadas (quadro sem vblank, etc.)
}

// Escalonador por eventos (CelerOS). O LakeSnes chamava snes_runCycle a
// cada 2 ciclos master (~180 mil chamadas por quadro), testando IRQ e
// posicao em todas. Aqui so os passos em que algo pode acontecer rodam o
// snes_runCycle completo (hPos 0/16/512/1104, o ultimo passo da linha, o
// ponto do H-IRQ e o passo seguinte a ele, e sempre o primeiro passo de
// cada chamada — registradores podem ter mudado entre chamadas). Os passos
// entre eventos andam em lote: a condicao de IRQ e constante neles (so muda
// nos pontos acima), entao o resultado e o mesmo passo a passo.
static int snes_stepsToEvent(Snes* snes) {
  int h = snes->hPos;
  int end;
  if(!snes->palTiming) {
    end = (snes->vPos == 240 && !snes->ppu->evenFrame && !snes->ppu->frameInterlace) ? 1360 : 1364;
  } else {
    end = (snes->vPos == 311 && !snes->ppu->evenFrame && snes->ppu->frameInterlace) ? 1368 : 1364;
  }
  int ev = end - 2;  // passo que vira a linha
  if(h <= 16) ev = 16 < ev ? 16 : ev;
  else if(h <= 512) ev = 512 < ev ? 512 : ev;
  else if(h <= 1104) ev = 1104 < ev ? 1104 : ev;
  if(h == 0) return 0;
  if(snes->hIrqEnabled) {
    int hi = snes->hTimer * 4;
    if(hi >= h && hi < ev) ev = hi;
    if(hi + 2 >= h && hi + 2 < ev) ev = hi + 2;
  }
  return (ev - h) >> 1;
}

static void snes_runCyclesSlow(Snes* snes, int cycles);

void snes_runCycles(Snes* snes, int cycles) {
  // atalho: nenhum passo completo no caminho (ver nextEv)
  uint32_t h = snes->hPos + (uint32_t) cycles;
  if(h <= snes->nextEv) {
    snes->hPos = (uint16_t) h;
    snes->cycles += (uint32_t) cycles;
    return;
  }
  snes_runCyclesSlow(snes, cycles);
}

static void snes_runCyclesSlow(Snes* snes, int cycles) {
  if(snes->hPos + cycles >= 536 && snes->hPos < 536) {
    // if we go past 536, add 40 cycles for dram refersh
    cycles += 40;
  }
  int steps = (cycles + 1) >> 1;
  while(steps > 0) {
    snes_runCycle(snes);
    steps--;
    if(steps == 0) break;
    int bulk = snes_stepsToEvent(snes);
    if(bulk <= 0) continue;
    if(bulk > steps) bulk = steps;
    steps -= bulk;
    uint32_t c = (uint32_t) bulk * 2;
    snes->cycles += c;
    snes->hPos += c;
  }
  // proximo ponto em que um passo precisa ser completo; ate la runCycles so
  // soma. Antes de 536 o refresh da DRAM (+40) tambem conta como fronteira.
  uint32_t ev = snes->hPos + 2u * (uint32_t) snes_stepsToEvent(snes);
  if(snes->hPos < 536 && ev > 534) ev = 534;
  snes->nextEv = ev;
}

void snes_syncCycles(Snes* snes, bool start, int syncCycles) {
  if(start) {
    snes->syncCycle = snes->cycles;
    int count = syncCycles - (int) snes_mod64(snes->cycles, (uint32_t) syncCycles);
    snes_runCycles(snes, count);
  } else {
    int count = syncCycles - (int) ((uint32_t) (snes->cycles - snes->syncCycle) % (uint32_t) syncCycles);
    snes_runCycles(snes, count);
  }
}

static void snes_runCycle(Snes* snes) {
  snes->cycles += 2;
  // check for h/v timer irq's
  bool condition = (
    (snes->vIrqEnabled || snes->hIrqEnabled) &&
    (snes->vPos == snes->vTimer || !snes->vIrqEnabled) &&
    (snes->hPos == snes->hTimer * 4 || !snes->hIrqEnabled)
  );
  if(!snes->irqCondition && condition) {
    snes->inIrq = true;
    cpu_setIrq(snes->cpu, true);
  }
  snes->irqCondition = condition;
  // handle positional stuff
  if(snes->hPos == 0) {
    // end of hblank, do most vPos-tests
    bool startingVblank = false;
    if(snes->vPos == 0) {
      // end of vblank
      snes->inVblank = false;
      snes->inNmi = false;
      ppu_handleFrameStart(snes->ppu);
    } else if(snes->vPos == 225) {
      // ask the ppu if we start vblank now or at vPos 240 (overscan)
      startingVblank = !ppu_checkOverscan(snes->ppu);
    } else if(snes->vPos == 240){
      // if we are not yet in vblank, we had an overscan frame, set startingVblank
      if(!snes->inVblank) startingVblank = true;
    }
    if(startingVblank) {
      // if we are starting vblank
      ppu_handleVblank(snes->ppu);
      snes->inVblank = true;
      snes->inNmi = true;
      if(snes->autoJoyRead) {
        // TODO: this starts a little after start of vblank
        // o LakeSnes poe 4224 e ja desconta 2 neste passo; depois 2 por passo
        snes->autoJoyEnd = snes->cycles + 4222;
        snes_doAutoJoypad(snes);
      }
      if(snes->nmiEnabled) {
        cpu_nmi(snes->cpu);
      }
    }
  } else if(snes->hPos == 16) {
    if(snes->vPos == 0) snes->dma->hdmaInitRequested = true;
  } else if(snes->hPos == 512) {
    // render the line halfway of the screen for better compatibility
    if(!snes->inVblank && snes->vPos > 0) ppu_runLine(snes->ppu, snes->vPos);
  } else if(snes->hPos == 1104) {
    if(!snes->inVblank) snes->dma->hdmaRunRequested = true;
  }
  // increment position
  snes->hPos += 2;
  if(!snes->palTiming) {
    // line 240 of odd frame with no interlace is 4 cycles shorter
    if((snes->hPos == 1360 && snes->vPos == 240 && !snes->ppu->evenFrame && !snes->ppu->frameInterlace) || snes->hPos == 1364) {
      snes->hPos = 0;
      snes->vPos++;
      // even interlace frame is 263 lines
      if((snes->vPos == 262 && (!snes->ppu->frameInterlace || !snes->ppu->evenFrame)) || snes->vPos == 263) {
        snes->vPos = 0;
        snes->frames++;
      }
    }
  } else {
    // line 311 of odd frame with interlace is 4 cycles longer
    if((snes->hPos == 1364 && (snes->vPos != 311 || snes->ppu->evenFrame || !snes->ppu->frameInterlace)) || snes->hPos == 1368) {
      snes->hPos = 0;
      snes->vPos++;
      // even interlace frame is 313 lines
      if((snes->vPos == 312 && (!snes->ppu->frameInterlace || !snes->ppu->evenFrame)) || snes->vPos == 313) {
        snes->vPos = 0;
        snes->frames++;
      }
    }
  }
}

// credita a APU com os ciclos master desde o ultimo credito (somas inteiras:
// o mesmo resultado de creditar 2 a cada passo)
static void snes_apuCredit(Snes* snes) {
  uint64_t d = snes->cycles - snes->apuCredited;
  snes->apuCredited = snes->cycles;
  while(d > 4000) {
    snes_apuAdvance(snes, 4000);
    d -= 4000;
  }
  snes_apuAdvance(snes, (uint32_t) d);
}

static void snes_catchupApu(Snes* snes) {
  SNES_PROF_BEGIN();
  snes_apuCredit(snes);
  int ranCycles = apu_runCycles(snes->apu, snes->apuOwed);
  snes->apuOwed -= ranCycles;
  SNES_PROF_END(1);
}

static void snes_doAutoJoypad(Snes* snes) {
  memset(snes->portAutoRead, 0, sizeof(snes->portAutoRead));
  // latch controllers
  input_latch(snes->input1, true);
  input_latch(snes->input2, true);
  input_latch(snes->input1, false);
  input_latch(snes->input2, false);
  for(int i = 0; i < 16; i++) {
    uint8_t val = input_read(snes->input1);
    snes->portAutoRead[0] |= ((val & 1) << (15 - i));
    snes->portAutoRead[2] |= (((val >> 1) & 1) << (15 - i));
    val = input_read(snes->input2);
    snes->portAutoRead[1] |= ((val & 1) << (15 - i));
    snes->portAutoRead[3] |= (((val >> 1) & 1) << (15 - i));
  }
}

uint8_t snes_readBBus(Snes* snes, uint8_t adr) {
  if(adr < 0x40) {
    return ppu_read(snes->ppu, adr);
  }
  if(adr < 0x80) {
    snes_catchupApu(snes); // catch up the apu before reading
    return snes->apu->outPorts[adr & 0x3];
  }
  if(adr == 0x80) {
    uint8_t ret = snes->ram[snes->ramAdr++];
    snes->ramAdr &= 0x1ffff;
    return ret;
  }
  return snes->openBus;
}

void snes_writeBBus(Snes* snes, uint8_t adr, uint8_t val) {
  if(adr < 0x40) {
    ppu_write(snes->ppu, adr, val);
    return;
  }
  if(adr < 0x80) {
    snes_catchupApu(snes); // catch up the apu before writing
    snes->apu->inPorts[adr & 0x3] = val;
    return;
  }
  switch(adr) {
    case 0x80: {
      snes->ram[snes->ramAdr++] = val;
      snes->ramAdr &= 0x1ffff;
      break;
    }
    case 0x81: {
      snes->ramAdr = (snes->ramAdr & 0x1ff00) | val;
      break;
    }
    case 0x82: {
      snes->ramAdr = (snes->ramAdr & 0x100ff) | (val << 8);
      break;
    }
    case 0x83: {
      snes->ramAdr = (snes->ramAdr & 0x0ffff) | ((val & 1) << 16);
      break;
    }
  }
}

static uint8_t snes_readReg(Snes* snes, uint16_t adr) {
  switch(adr) {
    case 0x4210: {
      uint8_t val = 0x2; // CPU version (4 bit)
      val |= snes->inNmi << 7;
      snes->inNmi = false;
      return val | (snes->openBus & 0x70);
    }
    case 0x4211: {
      uint8_t val = snes->inIrq << 7;
      snes->inIrq = false;
      cpu_setIrq(snes->cpu, false);
      return val | (snes->openBus & 0x7f);
    }
    case 0x4212: {
      uint8_t val = (snes->cycles < snes->autoJoyEnd);
      val |= (snes->hPos < 4 || snes->hPos >= 1096) << 6;
      val |= snes->inVblank << 7;
      return val | (snes->openBus & 0x3e);
    }
    case 0x4213: {
      return snes->ppuLatch << 7; // IO-port
    }
    case 0x4214: {
      return snes->divideResult & 0xff;
    }
    case 0x4215: {
      return snes->divideResult >> 8;
    }
    case 0x4216: {
      return snes->multiplyResult & 0xff;
    }
    case 0x4217: {
      return snes->multiplyResult >> 8;
    }
    case 0x4218:
    case 0x421a:
    case 0x421c:
    case 0x421e: {
      return snes->portAutoRead[(adr - 0x4218) / 2] & 0xff;
    }
    case 0x4219:
    case 0x421b:
    case 0x421d:
    case 0x421f: {
      return snes->portAutoRead[(adr - 0x4219) / 2] >> 8;
    }
    default: {
      return snes->openBus;
    }
  }
}

static void snes_writeReg(Snes* snes, uint16_t adr, uint8_t val) {
  switch(adr) {
    case 0x4200: {
      snes->autoJoyRead = val & 0x1;
      if(!snes->autoJoyRead) snes->autoJoyEnd = 0;
      snes->nextEv = 0;  // enables de IRQ mudaram: proximo passo completo
      snes->hIrqEnabled = val & 0x10;
      snes->vIrqEnabled = val & 0x20;
      if(!snes->hIrqEnabled && !snes->vIrqEnabled) {
        snes->inIrq = false;
        cpu_setIrq(snes->cpu, false);
      }
      // if nmi is enabled while inNmi is still set, immediately generate nmi
      if(!snes->nmiEnabled && (val & 0x80) && snes->inNmi) {
        cpu_nmi(snes->cpu);
      }
      snes->nmiEnabled = val & 0x80;
      break;
    }
    case 0x4201: {
      if(!(val & 0x80) && snes->ppuLatch) {
        // latch the ppu
        ppu_read(snes->ppu, 0x37);
      }
      snes->ppuLatch = val & 0x80;
      break;
    }
    case 0x4202: {
      snes->multiplyA = val;
      break;
    }
    case 0x4203: {
      snes->multiplyResult = snes->multiplyA * val;
      break;
    }
    case 0x4204: {
      snes->divideA = (snes->divideA & 0xff00) | val;
      break;
    }
    case 0x4205: {
      snes->divideA = (snes->divideA & 0x00ff) | (val << 8);
      break;
    }
    case 0x4206: {
      if(val == 0) {
        snes->divideResult = 0xffff;
        snes->multiplyResult = snes->divideA;
      } else {
        snes->divideResult = snes->divideA / val;
        snes->multiplyResult = snes->divideA % val;
      }
      break;
    }
    case 0x4207: {
      snes->hTimer = (snes->hTimer & 0x100) | val;
      snes->nextEv = 0;
      break;
    }
    case 0x4208: {
      snes->hTimer = (snes->hTimer & 0x0ff) | ((val & 1) << 8);
      snes->nextEv = 0;
      break;
    }
    case 0x4209: {
      snes->vTimer = (snes->vTimer & 0x100) | val;
      snes->nextEv = 0;
      break;
    }
    case 0x420a: {
      snes->vTimer = (snes->vTimer & 0x0ff) | ((val & 1) << 8);
      snes->nextEv = 0;
      break;
    }
    case 0x420b: {
      dma_startDma(snes->dma, val, false);
      break;
    }
    case 0x420c: {
      dma_startDma(snes->dma, val, true);
      break;
    }
    case 0x420d: {
      if(snes->fastMem != (bool) (val & 0x1)) {
        snes->fastMem = val & 0x1;
        snes_buildMemMap(snes);  // tempos dos bancos 80+
      }
      break;
    }
    default: {
      break;
    }
  }
}

static uint8_t snes_rread(Snes* snes, uint32_t adr) {
  uint8_t bank = adr >> 16;
  adr &= 0xffff;
  if(bank == 0x7e || bank == 0x7f) {
    return snes->ram[((bank & 1) << 16) | adr]; // ram
  }
  if(bank < 0x40 || (bank >= 0x80 && bank < 0xc0)) {
    if(adr < 0x2000) {
      return snes->ram[adr]; // ram mirror
    }
    if(adr >= 0x2100 && adr < 0x2200) {
      return snes_readBBus(snes, adr & 0xff); // B-bus
    }
    if(adr == 0x4016) {
      return input_read(snes->input1) | (snes->openBus & 0xfc);
    }
    if(adr == 0x4017) {
      return input_read(snes->input2) | (snes->openBus & 0xe0) | 0x1c;
    }
    if(adr >= 0x4200 && adr < 0x4220) {
      return snes_readReg(snes, adr); // internal registers
    }
    if(adr >= 0x4300 && adr < 0x4380) {
      return dma_read(snes->dma, adr); // dma registers
    }
  }
  // read from cart
  return cart_read(snes->cart, bank, adr);
}

void snes_write(Snes* snes, uint32_t adr, uint8_t val) {
  snes->openBus = val;
  uint8_t bank = adr >> 16;
  adr &= 0xffff;
  if(bank == 0x7e || bank == 0x7f) {
    snes->ram[((bank & 1) << 16) | adr] = val; // ram
  }
  if(bank < 0x40 || (bank >= 0x80 && bank < 0xc0)) {
    if(adr < 0x2000) {
      snes->ram[adr] = val; // ram mirror
    }
    if(adr >= 0x2100 && adr < 0x2200) {
      snes_writeBBus(snes, adr & 0xff, val); // B-bus
    }
    if(adr == 0x4016) {
      input_latch(snes->input1, val & 1); // input latch
      input_latch(snes->input2, val & 1);
    }
    if(adr >= 0x4200 && adr < 0x4220) {
      snes_writeReg(snes, adr, val); // internal registers
    }
    if(adr >= 0x4300 && adr < 0x4380) {
      dma_write(snes->dma, adr, val); // dma registers
    }
  }
  // write to cart
  cart_write(snes->cart, bank, adr, val);
}

static int snes_getAccessTime(Snes* snes, uint32_t adr) {
  uint8_t bank = adr >> 16;
  adr &= 0xffff;
  if((bank < 0x40 || (bank >= 0x80 && bank < 0xc0)) && adr < 0x8000) {
    // 00-3f,80-bf:0-7fff
    if(adr < 0x2000 || adr >= 0x6000) return 8; // 0-1fff, 6000-7fff
    if(adr < 0x4000 || adr >= 0x4200) return 6; // 2000-3fff, 4200-5fff
    return 12; // 4000-41ff
  }
  // 40-7f,co-ff:0000-ffff, 00-3f,80-bf:8000-ffff
  return (snes->fastMem && bank >= 0x80) ? 6 : 8; // depends on setting in banks 80+
}

uint8_t snes_read(Snes* snes, uint32_t adr) {
  uint8_t val = snes_rread(snes, adr);
  snes->openBus = val;
  return val;
}

void snes_buildMemMap(Snes* snes) {
  for(int page = 0; page < 2048; page++) {
    uint8_t bank = (uint8_t) (page >> 3);
    uint16_t adr = (uint16_t) ((page & 7) << 13);
    const uint8_t* rd = NULL;
    uint8_t* wr = NULL;
    if(bank == 0x7e || bank == 0x7f) {
      rd = wr = &snes->ram[((bank & 1) << 16) | adr];
    } else if((bank < 0x40 || (bank >= 0x80 && bank < 0xc0)) && adr < 0x8000) {
      // 0000-1fff = espelho da WRAM; 2000-7fff = I/O/SRAM/open bus (lento)
      if(adr < 0x2000) rd = wr = &snes->ram[adr];
    } else if(snes->cart != NULL) {
      rd = cart_romPagePtr(snes->cart, bank, adr);
    }
    s_rdMap[page] = rd;
    s_wrMap[page] = wr;
    // $4000-$5FFF mistura 12 e 6 ciclos: calcula por acesso
    bool mixed = (bank < 0x40 || (bank >= 0x80 && bank < 0xc0)) && adr == 0x4000;
    s_accTime[page] = mixed ? 0 : (uint8_t) snes_getAccessTime(snes, ((uint32_t) bank << 16) | adr);
  }
}

static inline void snes_dmaCheck(Snes* snes, int cycles) {
  Dma* dma = snes->dma;
  if(dma->hdmaInitRequested || dma->hdmaRunRequested || dma->dmaState != 0) dma_handleDma(dma, cycles);
}

void snes_cpuIdle(void* mem, bool waiting) {
  (void) waiting;
  Snes* snes = (Snes*) mem;
  snes_dmaCheck(snes, 6);
  snes_runCycles(snes, 6);
}

uint8_t snes_cpuRead(void* mem, uint32_t adr) {
  Snes* snes = (Snes*) mem;
  uint32_t page = (adr >> 13) & 0x7ff;
  int cycles = s_accTime[page];
  if(cycles == 0) cycles = snes_getAccessTime(snes, adr);
  snes_dmaCheck(snes, cycles);
  snes_runCycles(snes, cycles);
  const uint8_t* p = s_rdMap[page];
  uint8_t val = p != NULL ? p[adr & 0x1fff] : snes_rread(snes, adr);
  snes->openBus = val;
  return val;
}

void snes_cpuWrite(void* mem, uint32_t adr, uint8_t val) {
  Snes* snes = (Snes*) mem;
  uint32_t page = (adr >> 13) & 0x7ff;
  int cycles = s_accTime[page];
  if(cycles == 0) cycles = snes_getAccessTime(snes, adr);
  snes_dmaCheck(snes, cycles);
  snes_runCycles(snes, cycles);
  uint8_t* p = s_wrMap[page];
  if(p != NULL) {
    // WRAM: o cart_write do original nao faz nada nestes enderecos
    snes->openBus = val;
    p[adr & 0x1fff] = val;
  } else {
    snes_write(snes, adr, val);
  }
}

// debugging

void snes_runCpuCycle(Snes* snes) {
  cpu_runOpcode(snes->cpu);
}

void snes_runSpcCycle(Snes* snes) {
  // TODO: apu catchup is not aware of this, SPC runs extra cycle(s)
  spc_runOpcode(snes->apu->spc);
}
