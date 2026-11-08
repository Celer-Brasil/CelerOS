
#ifndef STATEHANDLER_H
#define STATEHANDLER_H

#include <stdint.h>
#include <stdbool.h>

typedef struct StateHandler {
  bool saving;
  int offset;
  uint8_t* data;
  int allocSize;
  bool external;  // CelerOS: buffer do chamador, tamanho fixo (sem realloc)
  bool overflow;  // escrita passou do buffer externo
} StateHandler;

StateHandler* sh_init(bool saving, const uint8_t* data, int size);
// buffer externo: salvar escreve direto em buf (ate cap), carregar le sem copia
void sh_initExt(StateHandler* sh, bool saving, uint8_t* buf, int cap);
void sh_free(StateHandler* sh);

void sh_handleBools(StateHandler* sh, ...);
void sh_handleBytes(StateHandler* sh, ...);
void sh_handleBytesS(StateHandler* sh, ...);
void sh_handleWords(StateHandler* sh, ...);
void sh_handleWordsS(StateHandler* sh, ...);
void sh_handleInts(StateHandler* sh, ...);
void sh_handleIntsS(StateHandler* sh, ...);
void sh_handleLongLongs(StateHandler* sh, ...);
void sh_handleFloats(StateHandler* sh, ...);
void sh_handleDoubles(StateHandler* sh, ...);
void sh_handleByteArray(StateHandler* sh, uint8_t* data, int size);
void sh_handleWordArray(StateHandler* sh, uint16_t* data, int size);
void sh_placeInt(StateHandler* sh, int location, uint32_t value);

#endif
