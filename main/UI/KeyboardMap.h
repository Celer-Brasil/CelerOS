#pragma once

/**
 * @file KeyboardMap.h
 * @brief Tabela HID usage -> caractere do teclado fisico (layout US).
 *
 * O teclado BLE/USB entrega usage IDs crus (Keyboard/Keypad page, 0x04..);
 * o firmware nao tem tabela de traducao para apps (Input.poll entrega o
 * usage). Este header existe para o KeyboardScreen: o teclado fisico digita
 * no mesmo buffer do teclado on-screen, entao alguem tem que virar letra.
 *
 * Layout US (o mesmo que o BLE HID reporta por padrao). Dead keys de acento
 * (´ ` ~ ^) nao existem aqui nesta versao: viram os caracteres literais.
 *
 * Header puro (sem IDF) para o test/cpp host cobrir a tabela.
 */

#include <stdint.h>

namespace KeyboardMap {

enum Action : uint8_t {
    kNone = 0,   // sem efeito: modificador, Tab, setas, tecla desconhecida
    kChar,       // use `ch`
    kEnter,
    kBackspace,
    kEscape,
    kCapsLock,
};

struct Key {
    Action action;
    char ch;
};

/** Shift esquerdo/direito (byte de modificadores HID). */
inline bool shiftDown(uint8_t mods) { return (mods & 0x22) != 0; }
/** Ctrl esquerdo/direito. */
inline bool ctrlDown(uint8_t mods) { return (mods & 0x11) != 0; }

/**
 * Traduz um usage ID para a acao no campo de texto.
 * @param usage HID usage (Keyboard/Keypad page)
 * @param mods byte de modificadores do report
 * @param caps Caps Lock ligado (estado do HOST, nao vem no report)
 */
inline Key map(uint8_t usage, uint8_t mods, bool caps) {
    const bool sh = shiftDown(mods);
    Key k{kNone, 0};

    // linhas de letras e digitos
    if (usage >= 0x04 && usage <= 0x1D) {              // a..z
        char c = (char)('a' + (usage - 0x04));
        if (sh != caps) c = (char)(c - 'a' + 'A');     // shift XOR caps
        k.action = kChar;
        k.ch = c;
        return k;
    }
    if (usage >= 0x1E && usage <= 0x27) {              // 1..9,0
        static const char kPlain[] = "1234567890";
        static const char kShift[] = "!@#$%^&*()";
        k.action = kChar;
        k.ch = sh ? kShift[usage - 0x1E] : kPlain[usage - 0x1E];
        return k;
    }
    if (usage >= 0x59 && usage <= 0x61) {              // keypad 1..9
        k.action = kChar;
        k.ch = (char)('1' + (usage - 0x59));
        return k;
    }

    switch (usage) {
        case 0x28: k.action = kEnter; return k;
        case 0x29: k.action = kEscape; return k;
        case 0x2A: k.action = kBackspace; return k;
        case 0x2C: k.action = kChar; k.ch = ' '; return k;
        case 0x2D: k.action = kChar; k.ch = sh ? '_' : '-'; return k;
        case 0x2E: k.action = kChar; k.ch = sh ? '+' : '='; return k;
        case 0x2F: k.action = kChar; k.ch = sh ? '{' : '['; return k;
        case 0x30: k.action = kChar; k.ch = sh ? '}' : ']'; return k;
        case 0x31: k.action = kChar; k.ch = sh ? '|' : '\\'; return k;
        case 0x32: k.action = kChar; k.ch = sh ? '~' : '#'; return k;
        case 0x33: k.action = kChar; k.ch = sh ? ':' : ';'; return k;
        case 0x34: k.action = kChar; k.ch = sh ? '"' : '\''; return k;
        case 0x35: k.action = kChar; k.ch = sh ? '~' : '`'; return k;
        case 0x36: k.action = kChar; k.ch = sh ? '<' : ','; return k;
        case 0x37: k.action = kChar; k.ch = sh ? '>' : '.'; return k;
        case 0x38: k.action = kChar; k.ch = sh ? '?' : '/'; return k;
        case 0x39: k.action = kCapsLock; return k;
        // keypad (0x53..0x63, 0x67) — o 0x58 e o Enter do teclado numerico
        case 0x53: k.action = kChar; k.ch = ','; return k;
        case 0x54: k.action = kChar; k.ch = '/'; return k;
        case 0x55: k.action = kChar; k.ch = '*'; return k;
        case 0x56: k.action = kChar; k.ch = '-'; return k;
        case 0x57: k.action = kChar; k.ch = '+'; return k;
        case 0x58: k.action = kEnter; return k;
        case 0x62: k.action = kChar; k.ch = '0'; return k;
        case 0x63: k.action = kChar; k.ch = '.'; return k;
        case 0x67: k.action = kChar; k.ch = '='; return k;
        default: return k;   // 0xE0..0xE7 (mods), Tab, setas, F-keys
    }
}

}  // namespace KeyboardMap
