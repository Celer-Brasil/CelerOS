#ifndef CELER_BOARDS_ESP32_CAM_TRAITS_H
#define CELER_BOARDS_ESP32_CAM_TRAITS_H

// Constantes compile-time da placa (o compilador descarta os ramos mortos):
// tela grande = fontes grandes no binario — sem vidro, sempre false.
namespace BoardTraits {
constexpr bool largeUi = false;
}

#endif  // CELER_BOARDS_ESP32_CAM_TRAITS_H
