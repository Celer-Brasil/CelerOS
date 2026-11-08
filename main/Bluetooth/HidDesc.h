#pragma once

/**
 * @file HidDesc.h
 * @brief Classificacao do Report Map HID (teclado / mouse / combo / pad).
 *
 * O firmware continua sem entender HID: quem decodifica os reports e a dep JS
 * (celeros.gamepad para pads, celeros.hid para teclado e mouse). Este header
 * responde UMA pergunta que o nativo precisa antes do JS rodar: que tipo de
 * device acabou de conectar? A resposta vai em BT.state().kind, e dela saem
 * duas decisoes:
 *   - o servico Controle BT escolhe o decoder (pad x hid);
 *   - o teclado on-screen esconde a grade quando ha teclado fisico.
 *
 * Heuristica pelos usages do descriptor (nao pelo appearance: teclado BLE
 * barato costuma anunciar appearance 0x0000):
 *   - teclas    = page 7 (Keyboard/Keypad) com Report Size >= 8;
 *   - mods      = page 7 com Report Size 1 (usages 0xE0..0xE7);
 *   - mouse     = page 1 (Generic Desktop) X/Y, SEM hat 0x39, sem gatilhos
 *                 0x33/0x34, sem page 5 (Game Controls) e com <= 8 botoes;
 *   - pad       = hat 0x39 / page 5 / gatilhos / mais de 8 botoes.
 *
 * Header puro (sem IDF) para o test/cpp host rodar a tabela.
 */

#include <stddef.h>
#include <stdint.h>

namespace HidDesc {

enum Kind : uint8_t {
    kOther = 0,
    kKeyboard = 1,
    kMouse = 2,
    kCombo = 3,   // teclado + mouse no mesmo descriptor (K400 e afins)
    kPad = 4,
};

namespace detail {

// itens HID: prefixo = tag(4) | tipo(2) | size(2); size 3 = 4 bytes
inline size_t itemLen(uint8_t sizeCode) {
    return sizeCode == 0 ? 0 : (sizeCode == 1 ? 1 : (sizeCode == 2 ? 2 : 4));
}

}  // namespace detail

/**
 * Classifica um Report Map cru.
 * @param map bytes do descriptor (BT.reportMap())
 * @param len tamanho em bytes
 * @return Kind; kOther sem descriptor reconhecivel
 */
inline Kind classify(const uint8_t* map, size_t len) {
    if (map == nullptr || len == 0) return kOther;

    uint32_t page = 0;      // Usage Page corrente
    uint32_t size = 0;      // Report Size (bits)
    uint32_t count = 0;     // Report Count
    uint32_t usages[8];
    int nUsages = 0;
    bool hasMin = false, hasMax = false;
    uint32_t usageMin = 0, usageMax = 0;

    bool kbdKeys = false, kbdMods = false, mouseXY = false;
    bool hat = false, gamePage = false, triggers = false;
    int buttons = 0;

    const auto clearLocals = [&]() {
        nUsages = 0;
        hasMin = hasMax = false;
        usageMin = usageMax = 0;
    };
    const auto hasUsage = [&](uint32_t u) {
        for (int i = 0; i < nUsages; i++) {
            if (usages[i] == u) return true;
        }
        return hasMin && hasMax && u >= usageMin && u <= usageMax;
    };

    size_t i = 0;
    while (i < len) {
        const uint8_t b = map[i];
        if (b == 0xFE) break;  // long item: nao aparece em descriptor de device
        const size_t nbytes = detail::itemLen(b & 3);
        const uint8_t tag = b & 0xFC;
        uint32_t val = 0;
        for (size_t k = 0; k < nbytes; k++) {
            const size_t at = i + 1 + k;
            if (at < len) val |= (uint32_t)map[at] << (8 * k);
        }
        i += 1 + nbytes;

        switch (tag) {
            case 0x04: page = val; break;                  // Usage Page
            case 0x74: size = val; break;                  // Report Size
            case 0x94: count = val; break;                 // Report Count
            case 0x84: break;                              // Report ID
            case 0x14: case 0x24: break;                   // Logical Min/Max
            case 0x08:                                     // Usage
                if (nUsages < 8) usages[nUsages++] = val;
                break;
            case 0x18: usageMin = val; hasMin = true; break;  // Usage Minimum
            case 0x28: usageMax = val; hasMax = true; break;  // Usage Maximum
            case 0x80: {                                   // Input
                const bool constant = (val & 0x01) != 0;
                if (!constant && size > 0 && count > 0) {
                    if (page == 0x07) {
                        if (size == 1) kbdMods = true;
                        else if (size >= 8) kbdKeys = true;
                    } else if (page == 0x01) {
                        if (hasUsage(0x39)) hat = true;
                        if (hasUsage(0x33) || hasUsage(0x34)) triggers = true;
                        if ((hasUsage(0x30) || hasUsage(0x31)) && size <= 16) mouseXY = true;
                    } else if (page == 0x05) {
                        gamePage = true;
                    } else if (page == 0x09) {
                        if (size == 1) buttons += (int)count;
                    }
                }
                clearLocals();
                break;
            }
            case 0x90: case 0xB0:                          // Output / Feature
            case 0xA0: case 0xC0:                          // Collection / End
                clearLocals();
                break;
            default:
                break;
        }
    }

    // mouse "de verdade": X/Y sem nenhum marcador de pad junto
    const bool mouseLike = mouseXY && !hat && !triggers && !gamePage && buttons <= 8;
    if (kbdKeys && mouseLike) return kCombo;
    if (kbdKeys) return kKeyboard;
    if (mouseLike) return kMouse;
    if (hat || triggers || gamePage || buttons > 8) return kPad;
    // descriptor so de modificadores nao existe na pratica; sem teclas e sem
    // nada que identifique pad, fica "outro"
    (void)kbdMods;
    return kOther;
}

/** Kind pelo appearance do ADV (antes de conectar; o mapa manda depois). */
inline Kind fromAppearance(uint16_t appearance) {
    switch (appearance) {
        case 0x03C1: return kKeyboard;
        case 0x03C2: return kMouse;
        case 0x03C3:   // joystick
        case 0x03C4: return kPad;   // gamepad
        default: return kOther;
    }
}

/** Nome estavel do kind para o JS (BT.state().kind / BT.paired()[].kind). */
inline const char* kindName(Kind k) {
    switch (k) {
        case kKeyboard: return "kbd";
        case kMouse: return "mouse";
        case kCombo: return "combo";
        case kPad: return "pad";
        default: return "";
    }
}

}  // namespace HidDesc
