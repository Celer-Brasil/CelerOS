
#ifndef CART_H
#define CART_H

#include <stdint.h>
#include <stdbool.h>

typedef struct Cart Cart;

#include "snes.h"
#include "statehandler.h"

struct Cart {
  Snes* snes;
  uint8_t type;

  // ROM EXTERNA (CelerOS): aponta para o buffer do chamador (a scratch do
  // blob), sem copia. romSize e a potencia de 2 que o LakeSnes usava; o
  // espelho da expansao vira romPage (pagina de 32 KB -> offset real).
  const uint8_t* rom;
  uint32_t romSize;
  uint32_t romPage[256];
  uint8_t* ram;
  uint32_t ramSize;
};

// TODO: how to handle reset & load?

Cart* cart_init(Snes* snes);
void cart_free(Cart* cart);
void cart_reset(Cart* cart); // will reset special chips etc, general reading is set up in load
bool cart_handleTypeState(Cart* cart, StateHandler* sh);
void cart_handleState(Cart* cart, StateHandler* sh);
void cart_load(Cart* cart, int type, const uint8_t* rom, int romLength, int ramSize); // rom externa (sem copia), sets up ram buffer
bool cart_handleBattery(Cart* cart, bool save, uint8_t* data, int* size); // saves/loads ram
uint8_t cart_read(Cart* cart, uint8_t bank, uint16_t adr);
void cart_write(Cart* cart, uint8_t bank, uint16_t adr, uint8_t val);

// ponteiro para a pagina de 8 KB (bank:adr alinhado) se ela for ROM pura
// na leitura; NULL = SRAM/open bus (caminho lento)
const uint8_t* cart_romPagePtr(Cart* cart, uint8_t bank, uint16_t adr);

// byte da ROM no offset ja mascarado por romSize - 1
static inline uint8_t cart_romByte(Cart* cart, uint32_t off) {
  return cart->rom[cart->romPage[off >> 15] + (off & 0x7fff)];
}

#endif
