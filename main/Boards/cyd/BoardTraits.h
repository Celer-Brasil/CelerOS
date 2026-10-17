#ifndef CELEROS_BOARDS_CYD_TRAITS_H
#define CELEROS_BOARDS_CYD_TRAITS_H

// Traços de compilacao da CYD (240x320). Constantes constexpr: o codigo comum
// escolhe por elas com ramos que o compilador descarta — as fontes da tela
// grande nem entram no binario (slot OTA de 0x190000 = 1.638.400 B).
namespace BoardTraits {
constexpr bool largeUi = false;
}

#endif  // CELEROS_BOARDS_CYD_TRAITS_H
