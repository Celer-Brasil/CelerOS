#!/usr/bin/env python3
# Gera test/fixtures/a2600/joystick.a26 — ROM ORIGINAL de teste do emulador.
#
# Kernel 2600: VSYNC (3 linhas) + 37 VBLANK + 192 visiveis. O playfield e
# branco (PF0=$10, PF1=$80, PF2=$E0), o sprite e laranja (GRP0=$3C, COLUP0=
# $46) e a posicao horizontal segue o joystick (SWCHA bits 2/3, ativos
# baixos) via atraso antes do RESP0. FOGO (INPT4) troca o sprite para ouro
# ($1E). AUDC0=$1C/AUDF0=8/AUDV0=$0A deixa um tom constante.
#
# Bytes conferidos contra o core no teste host (test/cpp/a2600_test.cpp).
import os

CODE = bytes([
    0xD8,                    # F000 CLD
    0xA2, 0xFF,              # F001 LDX #$FF
    0x9A,                    # F003 TXS
    0xA9, 0x1C,              # F004 LDA #$1C
    0x85, 0x15,              # F006 STA AUDC0
    0xA9, 0x08,              # F008 LDA #8
    0x85, 0x17,              # F00A STA AUDF0
    0xA9, 0x0A,              # F00C LDA #10
    0x85, 0x19,              # F00E STA AUDV0
    0xA9, 0x14,              # F010 LDA #20 (px inicial)
    0x85, 0x80,              # F012 STA $80
    # frame
    0xA9, 0x02,              # F014 LDA #2
    0x85, 0x02,              # F016 STA WSYNC
    0x85, 0x00,              # F018 STA VSYNC
    0x85, 0x02,              # F01A STA WSYNC
    0x85, 0x02,              # F01C STA WSYNC
    0xA9, 0x00,              # F01E LDA #0
    0x85, 0x00,              # F020 STA VSYNC
    0xA2, 0x25,              # F022 LDX #37
    0x85, 0x02,              # F024 vb: STA WSYNC
    0xCA,                    # F026 DEX
    0xD0, 0xFB,              # F027 BNE vb
    0xAD, 0x80, 0x02,        # F029 LDA SWCHA
    0x29, 0x04,              # F02C AND #4 (esquerda)
    0xD0, 0x02,              # F02E BNE +2
    0xC6, 0x80,              # F030 DEC $80
    0xAD, 0x80, 0x02,        # F032 LDA SWCHA
    0x29, 0x08,              # F035 AND #8 (direita)
    0xD0, 0x02,              # F037 BNE +2
    0xE6, 0x80,              # F039 INC $80
    0xA5, 0x80,              # F03B LDA $80
    0x29, 0x1F,              # F03D AND #$1F
    0x85, 0x80,              # F03F STA $80
    0xA9, 0x46,              # F041 LDA #$46 (laranja)
    0x85, 0x06,              # F043 STA COLUP0
    0xAD, 0x3C, 0x00,        # F045 LDA INPT4
    0x29, 0x80,              # F048 AND #$80
    0xD0, 0x04,              # F04A BNE +4
    0xA9, 0x1E,              # F04C LDA #$1E (ouro com fogo)
    0x85, 0x06,              # F04E STA COLUP0
    0xA9, 0x00,              # F050 LDA #0
    0x85, 0x09,              # F052 STA COLUBK
    0xA9, 0x0E,              # F054 LDA #$0E (playfield branco)
    0x85, 0x08,              # F056 STA COLUPF
    0xA9, 0x10,              # F058 LDA #$10
    0x85, 0x0D,              # F05A STA PF0
    0xA9, 0x80,              # F05C LDA #$80
    0x85, 0x0E,              # F05E STA PF1
    0xA9, 0xE0,              # F060 LDA #$E0
    0x85, 0x0F,              # F062 STA PF2
    0xA9, 0x3C,              # F064 LDA #$3C
    0x85, 0x1B,              # F066 STA GRP0
    0xA9, 0x00,              # F068 LDA #0
    0x85, 0x01,              # F06A STA VBLANK (visivel)
    0xA6, 0x80,              # F06C LDX $80
    0xF0, 0x03,              # F06E BEQ nodly
    0xCA,                    # F070 delay: DEX
    0xD0, 0xFD,              # F071 BNE delay
    0xA9, 0x00,              # F073 LDA #0
    0x85, 0x10,              # F075 STA RESP0
    0xA2, 0xC0,              # F077 LDX #192
    0x85, 0x02,              # F079 vis: STA WSYNC
    0xCA,                    # F07B DEX
    0xD0, 0xFB,              # F07C BNE vis
    0xA9, 0x02,              # F07E LDA #2
    0x85, 0x01,              # F080 STA VBLANK
    0x4C, 0x14, 0xF0,        # F082 JMP $F014
])

assert len(CODE) == 0x85, "codigo com tamanho inesperado: %d" % len(CODE)

rom = bytearray([0xEA] * 4096)
rom[0:len(CODE)] = CODE
rom[0xFFC] = 0x00  # reset -> $F000
rom[0xFFD] = 0xF0

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "joystick.a26")
with open(out, "wb") as f:
    f.write(rom)
print("ok:", out, len(rom), "bytes")
