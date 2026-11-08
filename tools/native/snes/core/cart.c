
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

#include "cart.h"
#include "snes.h"
#include "statehandler.h"

static uint8_t cart_readLorom(Cart* cart, uint8_t bank, uint16_t adr);
static void cart_writeLorom(Cart* cart, uint8_t bank, uint16_t adr, uint8_t val);
static uint8_t cart_readHirom(Cart* cart, uint8_t bank, uint16_t adr);
static uint8_t cart_readExHirom(Cart* cart, uint8_t bank, uint16_t adr);
static void cart_writeHirom(Cart* cart, uint8_t bank, uint16_t adr, uint8_t val);

Cart* cart_init(Snes* snes) {
  Cart* cart = (Cart*) malloc(sizeof(Cart));
  cart->snes = snes;
  cart->type = 0;
  cart->rom = NULL;
  cart->romSize = 0;
  cart->ram = NULL;
  cart->ramSize = 0;
  return cart;
}

void cart_free(Cart* cart) {
  if(cart->ram != NULL) free(cart->ram);
  free(cart);
}

void cart_reset(Cart* cart) {
  (void) cart;
  // do not reset ram, assumed to be battery backed
}

bool cart_handleTypeState(Cart* cart, StateHandler* sh) {
  // when loading, return if values match
  if(sh->saving) {
    sh_handleBytes(sh, &cart->type, NULL);
    sh_handleInts(sh, &cart->romSize, &cart->ramSize, NULL);
    return true;
  } else {
    uint8_t type = 0;
    uint32_t romSize = 0;
    uint32_t ramSize = 0;
    sh_handleBytes(sh, &type, NULL);
    sh_handleInts(sh, &romSize, &ramSize, NULL);
    return !(type != cart->type || romSize != cart->romSize || ramSize != cart->ramSize);
  }
}

void cart_handleState(Cart* cart, StateHandler* sh) {
  if(cart->ram != NULL) sh_handleByteArray(sh, cart->ram, cart->ramSize);
}

void cart_load(Cart* cart, int type, const uint8_t* rom, int romLength, int ramSize) {
  // romLength: multiplo de 32 KB (snes_loadRom garante), ate 8 MB
  cart->type = type;
  if(cart->ram != NULL) free(cart->ram);
  cart->rom = rom;
  // mesma expansao do LakeSnes (completa ate a potencia de 2 copiando os
  // ultimos 'test' bytes), simulada em paginas de 32 KB: com o tamanho
  // multiplo de 32 KB, os blocos copiados sao sempre paginas inteiras
  int pages = romLength >> 15;
  int newPages = 1;
  while(newPages < pages) newPages *= 2;
  for(int i = 0; i < pages; i++) cart->romPage[i] = (uint32_t) i << 15;
  int test = 1;
  while(pages != newPages) {
    if(pages & test) {
      for(int k = 0; k < test; k++) cart->romPage[pages + k] = cart->romPage[pages - test + k];
      pages += test;
    }
    test *= 2;
  }
  cart->romSize = (uint32_t) newPages << 15;
  if(ramSize > 0) cart->ram = (uint8_t*) malloc(ramSize);
  if(ramSize > 0 && cart->ram == NULL) {
    // arena sem espaco para a SRAM declarada (cartuchos raros de 64/128 KB):
    // roda sem bateria em vez de escrever em NULL
    SNES_LOG("SRAM de %d bytes nao coube: sem bateria\n", ramSize);
    ramSize = 0;
  }
  if(ramSize > 0) {
    memset(cart->ram, 0, ramSize);
  } else {
    cart->ram = NULL;
  }
  cart->ramSize = ramSize;
}

bool cart_handleBattery(Cart* cart, bool save, uint8_t* data, int* size) {
  if(save) {
    *size = cart->ramSize;
    if(data == NULL) return true;
    // assumes data is correct size
    if(cart->ram != NULL) memcpy(data, cart->ram, cart->ramSize);
    return true;
  } else {
    if((uint32_t) *size != cart->ramSize) return false;
    if(cart->ram != NULL) memcpy(cart->ram, data, cart->ramSize);
    return true;
  }
}

const uint8_t* cart_romPagePtr(Cart* cart, uint8_t bank, uint16_t adr) {
  // mesma classificacao de cart_readLorom/Hirom/ExHirom; as fronteiras
  // (SRAM em 70-7d/f0-ff:0000-7fff ou 6000-7fff, open bus abaixo de 8000)
  // sao todas multiplas de 8 KB, entao valem para a pagina inteira
  if(cart->rom == NULL || cart->romSize == 0) return NULL;
  uint32_t off;
  if(cart->type == 1) {
    if(((bank >= 0x70 && bank < 0x7e) || bank >= 0xf0) && adr < 0x8000 && cart->ramSize > 0) return NULL;
    uint8_t b = bank & 0x7f;
    if(!(adr >= 0x8000 || b >= 0x40)) return NULL;
    off = ((b << 15) | (adr & 0x7fff)) & (cart->romSize - 1);
  } else if(cart->type == 2 || cart->type == 3) {
    uint8_t b = bank & 0x7f;
    if(b < 0x40 && adr >= 0x6000 && adr < 0x8000 && cart->ramSize > 0) return NULL;
    if(!(adr >= 0x8000 || b >= 0x40)) return NULL;
    if(cart->type == 2) {
      off = (((b & 0x3f) << 16) | adr) & (cart->romSize - 1);
    } else {
      off = (((b & 0x3f) << 16) | (bank < 0x80 ? 0x400000 : 0) | adr) & (cart->romSize - 1);
    }
  } else {
    return NULL;
  }
  return &cart->rom[cart->romPage[off >> 15] + (off & 0x7fff)];
}

uint8_t cart_read(Cart* cart, uint8_t bank, uint16_t adr) {
  switch(cart->type) {
    case 0: return cart->snes->openBus;
    case 1: return cart_readLorom(cart, bank, adr);
    case 2: return cart_readHirom(cart, bank, adr);
    case 3: return cart_readExHirom(cart, bank, adr);
  }
  return cart->snes->openBus;
}

void cart_write(Cart* cart, uint8_t bank, uint16_t adr, uint8_t val) {
  switch(cart->type) {
    case 0: break;
    case 1: cart_writeLorom(cart, bank, adr, val); break;
    case 2: cart_writeHirom(cart, bank, adr, val); break;
    case 3: cart_writeHirom(cart, bank, adr, val); break;
  }
}

static uint8_t cart_readLorom(Cart* cart, uint8_t bank, uint16_t adr) {
  if(((bank >= 0x70 && bank < 0x7e) || bank >= 0xf0) && adr < 0x8000 && cart->ramSize > 0) {
    // banks 70-7e and f0-ff, adr 0000-7fff
    return cart->ram[(((bank & 0xf) << 15) | adr) & (cart->ramSize - 1)];
  }
  bank &= 0x7f;
  if(adr >= 0x8000 || bank >= 0x40) {
    // adr 8000-ffff in all banks or all addresses in banks 40-7f and c0-ff
    return cart_romByte(cart, ((bank << 15) | (adr & 0x7fff)) & (cart->romSize - 1));
  }
  return cart->snes->openBus;
}

static void cart_writeLorom(Cart* cart, uint8_t bank, uint16_t adr, uint8_t val) {
  if(((bank >= 0x70 && bank < 0x7e) || bank > 0xf0) && adr < 0x8000 && cart->ramSize > 0) {
    // banks 70-7e and f0-ff, adr 0000-7fff
    cart->ram[(((bank & 0xf) << 15) | adr) & (cart->ramSize - 1)] = val;
  }
}

static uint8_t cart_readHirom(Cart* cart, uint8_t bank, uint16_t adr) {
  bank &= 0x7f;
  if(bank < 0x40 && adr >= 0x6000 && adr < 0x8000 && cart->ramSize > 0) {
    // banks 00-3f and 80-bf, adr 6000-7fff
    return cart->ram[(((bank & 0x3f) << 13) | (adr & 0x1fff)) & (cart->ramSize - 1)];
  }
  if(adr >= 0x8000 || bank >= 0x40) {
    // adr 8000-ffff in all banks or all addresses in banks 40-7f and c0-ff
    return cart_romByte(cart, (((bank & 0x3f) << 16) | adr) & (cart->romSize - 1));
  }
  return cart->snes->openBus;
}

static uint8_t cart_readExHirom(Cart* cart, uint8_t bank, uint16_t adr) {
  if((bank & 0x7f) < 0x40 && adr >= 0x6000 && adr < 0x8000 && cart->ramSize > 0) {
    // banks 00-3f and 80-bf, adr 6000-7fff
    return cart->ram[(((bank & 0x3f) << 13) | (adr & 0x1fff)) & (cart->ramSize - 1)];
  }
  bool secondHalf = bank < 0x80;
  bank &= 0x7f;
  if(adr >= 0x8000 || bank >= 0x40) {
    // adr 8000-ffff in all banks or all addresses in banks 40-7f and c0-ff
    return cart_romByte(cart, (((bank & 0x3f) << 16) | (secondHalf ? 0x400000 : 0) | adr) & (cart->romSize - 1));
  }
  return cart->snes->openBus;
}

static void cart_writeHirom(Cart* cart, uint8_t bank, uint16_t adr, uint8_t val) {
  bank &= 0x7f;
  if(bank < 0x40 && adr >= 0x6000 && adr < 0x8000 && cart->ramSize > 0) {
    // banks 00-3f and 80-bf, adr 6000-7fff
    cart->ram[(((bank & 0x3f) << 13) | (adr & 0x1fff)) & (cart->ramSize - 1)] = val;
  }
}
