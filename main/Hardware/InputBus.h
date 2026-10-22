#pragma once

// ============================================================================
// Barramento de input do OS (API 48)
//
// Um driver JS (ex.: HID USB) injeta teclas e o ponteiro AQUI; qualquer app
// com a permission "input" le com Input.poll()/Input.pointer(). Em placas
// com tela o ponteiro tambem entra no pipeline de toque (Kui), entao o mouse
// dirige o launcher/os apps como um dedo.
//
// Sem driver de hardware aqui: o firmware so transporta os eventos. Os usage
// IDs sao os do HID (4=A ... 0x28=Enter), sem tabela de traducao.
// ============================================================================

#include <stdint.h>

namespace InputBus {

struct KeyEvent {
    uint8_t usage = 0;  // HID usage ID (Keyboard/Keypad page, 0x04..)
    uint8_t mods = 0;   // byte de modificadores HID (bit0 LCtrl ... bit7 RGUI)
    bool down = false;
};

struct Pointer {
    int16_t x = 0;       // espaco virtual 240x320 (mesma convencao dos apps)
    int16_t y = 0;
    uint8_t buttons = 0; // bit0 esquerdo, bit1 direito, bit2 meio
};

// Fila de teclas (16). Devolve false se a fila encheu (evento descartado).
bool pushKey(uint8_t usage, uint8_t mods, bool down);
// Proximo evento ou false se vazia.
bool popKey(KeyEvent& out);

// Estado absoluto do ponteiro; coordenadas presas a 240x320.
void setPointer(int16_t x, int16_t y, uint8_t buttons);
Pointer pointer();

// Zera fila e ponteiro (bench / driver que desconectou).
void clear();

}  // namespace InputBus
