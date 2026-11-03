#pragma once

// ============================================================================
// Encoder — leitor de encoder incremental (quadratura A/B) pelo PCNT.
//
// API JS (API 55): System.encoder.create/read/reset/free. Usa o perimetro
// PCNT do ESP32/S3 (4 unidades neste driver): o hardware conta os flancos e
// o app so le o acumulado, sem polling de GPIO nem ISR em JS.
//
// O contador acumula alem dos limites (flags.accum_count): a leitura volta
// um int de 32 bits e nao "da a volta" a cada 32767 pulsos. Pinos sao
// entradas com pull-up opcional (encoder open-collector). O driver nao
// mexe no resto do GPIO; o app escolhe A/B e a direcao (invertido na lib JS
// ou trocando os pinos).
// ============================================================================

namespace Encoder {

constexpr int kMax = 4;

// Cria um encoder nos pinos A/B. Devolve o id (0..3) ou -1 (sem unidade
// PCNT livre, pinos invalidos ou falha do driver).
int create(int pinA, int pinB, bool pullup);

// Le o acumulado (pode ser negativo). false = id invalido/sem encoder.
bool read(int id, int* count);

// Zera o contador mantendo o encoder ativo.
bool reset(int id);

// Para e libera a unidade PCNT.
void free(int id);

// Fim do app: libera todas as unidades (JSBindings::init/appExitCleanup).
void resetAll();

}  // namespace Encoder
