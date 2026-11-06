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

// Canal do gamepad (API 61): estado CORRENTE broadcast, sem fila — cada
// consumidor guarda sua copia e faz o diff de bordas local, entao dois
// leitores (launcher nativo e apps JS) nao brigam pelo evento. O driver JS
// (servico Controle BT) injeta a cada report do pad; seq sobe a cada push
// (0 = nenhum pad injetou ainda).
//
// Botoes no bitmask (mesmos nomes da dep celeros.gamepad):
//   bit0 A, 1 B, 2 X, 3 Y, 4 L1, 5 R1, 6 L2, 7 R2, 8 select, 9 start,
//   10 guide, 11 LS, 12 RS
// dpad: bit0 N, 1 E, 2 S, 3 W. Eixos: -127..127 (para cima = negativo).
struct PadState {
    uint32_t buttons = 0;
    uint8_t dpad = 0;
    int8_t lx = 0;
    int8_t ly = 0;
    int8_t rx = 0;
    int8_t ry = 0;
    uint32_t seq = 0;
};
void pushPad(const PadState& st);
PadState pad();

// Consumo de sistema (servico "inputsys", ALWAYS): borda do botao GUIDE
// sai do app (LauncherUI::requestAppExit — mesmo caminho do botao 1 curto)
// e, no launcher, volta para a casa; qualquer borda de BOTAO acorda a tela
// pelo mesmo hub do toque (Backlight::noteActivity). Dpad/sticks NAO
// acordam nem navegam aqui — o launcher tem consumidor proprio.
void sysTick(bool inApp);

// Zera fila e ponteiro (bench / driver que desconectou).
void clear();

}  // namespace InputBus
