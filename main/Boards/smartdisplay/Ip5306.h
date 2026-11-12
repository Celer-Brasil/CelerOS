#ifndef CELER_BOARDS_SMARTDISPLAY_IP5306_H
#define CELER_BOARDS_SMARTDISPLAY_IP5306_H

// ============================================================================
// IP5306 (power bank / charger da Guition ESP32-S3-4848S040) — leitura
// opcional por I2C.
//
// A placa tem o conector de celula LiPo 1S e o IP5306 faz carga + boost. O
// chip NAO entrega tensao nem corrente: o que existe de leitura e a barra de
// 4 LEDs (reg 0x78 bits 7..4) mais as flags de carga (0x70/0x71). Ou seja:
// nivel em passos de 25% + "carregando" + "cheia" — que e exatamente o que
// interessa num painel de parede (cheia vs. perto de desligar).
//
// O IP5306 so responde quando os pinos L1/L2 dele estao no barramento I2C do
// MCU. Nesta placa o fabricante NAO documenta essa ligacao ("no direct
// control from the ESP32 module") e varias revisoes nao a tem. Por isso TUDO
// aqui e fail-safe: sonda o endereco uma vez; sem resposta, tried() vira true
// e o perfil fica como se a placa nao tivesse bateria (hasBattery = false,
// batteryInfo() = null) — nenhum app quebra, nenhum recurso muda.
//
// Barramento: o mesmo do GT911 (SDA 19 / SCL 45), adotado com
// i2c_master_get_bus_handle como o WatchI2c do relogio faz. Adicionar um
// device no driver novo do IDF e seguro: o bus_lock serializa as transacoes
// e o touch continua funcionando.
//
// Bancada: `celerctl shell "bat"` mostra o probe + os registradores crus.
// ============================================================================

#include "driver/i2c_master.h"
#include "esp_log.h"

#include <stdint.h>
#include <stdio.h>

namespace Ip5306 {

static constexpr uint8_t kAddr = 0x75;  // 7 bits (datasheet: 0xEA/0xEB em 8)
static constexpr int kPort = 0;         // I2C0 — o do GT911 (SDA 19 / SCL 45)

static constexpr uint8_t REG_READ0 = 0x70;  // bit3: carga habilitada
static constexpr uint8_t REG_READ1 = 0x71;  // bit3: celula cheia
static constexpr uint8_t REG_READ3 = 0x77;  // bit0..2: press/no botao
static constexpr uint8_t REG_READ4 = 0x78;  // bit7..4: LED4..LED1

/// Handle do IP5306 no bus do touch; nullptr se a placa nao o expoe.
/// Sonda UMA vez (i2c_master_probe) e desiste para sempre em caso de falha.
inline i2c_master_dev_handle_t dev() {
    static i2c_master_dev_handle_t s_dev = nullptr;
    static bool s_tried = false;
    if (s_tried) return s_dev;
    s_tried = true;

    i2c_master_bus_handle_t bus = nullptr;
    // O GT911 abre o bus no boot do painel; se ainda nao existe, nao insiste
    // (a proxima chamada tenta de novo — o bus nasce antes de qualquer app).
    if (i2c_master_get_bus_handle((i2c_port_num_t)kPort, &bus) != ESP_OK || bus == nullptr) {
        s_tried = false;  // bus ainda nao existe: permite tentar mais tarde
        return nullptr;
    }
    if (i2c_master_probe(bus, kAddr, 50) != ESP_OK) {
        ESP_LOGI("celer.bat", "IP5306 ausente no endereco 0x%02X (placa sem I2C do charger)",
                 (unsigned)kAddr);
        return nullptr;  // s_tried fica true: nao sonda de novo
    }
    i2c_device_config_t dcfg = {};
    dcfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    dcfg.device_address = kAddr;
    dcfg.scl_speed_hz = 100000;  // datasheet: 100 kHz e o robusto
    if (i2c_master_bus_add_device(bus, &dcfg, &s_dev) != ESP_OK) {
        s_dev = nullptr;
        ESP_LOGW("celer.bat", "IP5306 respondeu mas nao entrou no bus");
        return nullptr;
    }
    ESP_LOGI("celer.bat", "IP5306 encontrado em 0x%02X", (unsigned)kAddr);
    return s_dev;
}

/// Leitura crua de um registrador. false sem resposta.
inline bool rd(uint8_t reg, uint8_t* out) {
    i2c_master_dev_handle_t d = dev();
    if (d == nullptr || out == nullptr) return false;
    return i2c_master_transmit_receive(d, &reg, 1, out, 1, 50) == ESP_OK;
}

/// Percent 0..100 pela barra de LEDs (100/75/50/25/0); -1 sem resposta.
/// Hook BoardProfile::readBatteryPct.
inline int readBatteryPct() {
    uint8_t v = 0;
    if (!rd(REG_READ4, &v)) return -1;
    const uint8_t leds = (uint8_t)((v & 0xF0) >> 4);
    if (leds == 0) {
        // Barra apagada = celula vazia OU chip dormindo (sem carga). Com
        // carga ligada a barra pisca; sem ela, "0%" e a leitura honesta.
        return 0;
    }
    return (int)leds * 25;
}

/// Estado de energia no contrato do BoardIO (bit0 carregando, bit1 USB,
/// bit2 cheia); -1 sem resposta. Hook BoardProfile::readChargeState.
inline int readChargeState() {
    uint8_t r0 = 0, r1 = 0;
    if (!rd(REG_READ0, &r0) || !rd(REG_READ1, &r1)) return -1;
    const bool enabled = (r0 & 0x08) != 0;  // carga habilitada
    const bool full = (r1 & 0x08) != 0;     // celula cheia (bit3 = 1)
    int r = 0;
    if (enabled && !full) r |= 1;  // carregando
    if (enabled) r |= 2;           // alimentacao presente
    if (full) r |= 4;              // cheia
    return r;
}

/// Tensao SINTETICA em mV para o contrato de System.battery().
///
/// O IP5306 nao mede tensao (datasheet: "no internal voltage/current
/// information"), mas `hasBattery`/`batteryInfo()` do runtime sao gated em
/// mV (JsSystem.cpp). Este valor so existe para o gate abrir e para dar uma
/// referencia no System Info — a verdade e o pct(), que vem da barra.
/// Valores no meio de cada faixa da curva LiPo 1S: 25% ~3,75 V, 50% ~3,85 V,
/// 75% ~3,95 V, 100% ~4,05 V (repouso, sem carga).
inline bool readBatteryMv(int* mv) {
    const int pct = readBatteryPct();
    if (pct < 0 || mv == nullptr) return false;
    static const int16_t kMv[] = {3300, 3750, 3850, 3950, 4050};
    const int idx = pct / 25;
    *mv = kMv[idx < 0 ? 0 : (idx > 4 ? 4 : idx)];
    return true;
}

/// Botao de power do IP5306 (a tecla escondida ao lado do USB-C fala com
/// ele, nao com o ESP32). Reg 0x77: bit0 curto, bit1 longo, bit2 duplo.
/// Leitura NAO limpa o status no chip — devolvemos o que esta la (os
/// chamadores comparam com o valor anterior se precisarem de borda).
inline int buttonRaw() {
    uint8_t v = 0;
    if (!rd(REG_READ3, &v)) return -1;
    return v & 0x07;
}

/// Diagnostico de bancada (shell `bat`): probe + registradores crus.
/// Hook BoardProfile::chargeDebug. Devolve o tamanho escrito, -1 sem chip.
inline int debug(char* buf, size_t cap) {
    if (buf == nullptr || cap == 0) return -1;
    i2c_master_dev_handle_t d = dev();
    if (d == nullptr) {
        int n = snprintf(buf, cap,
                         "IP5306: sem resposta em 0x%02X (I2C0 do GT911, SDA 19 / SCL 45)\r\n"
                         "esta revisao da placa nao expoe o I2C do charger\r\n",
                         (unsigned)kAddr);
        return n > 0 ? n : -1;
    }
    uint8_t r70 = 0, r71 = 0, r77 = 0, r78 = 0;
    const bool o70 = rd(REG_READ0, &r70);
    const bool o71 = rd(REG_READ1, &r71);
    const bool o77 = rd(REG_READ3, &r77);
    const bool o78 = rd(REG_READ4, &r78);
    int n = snprintf(buf, cap,
                     "IP5306 em 0x%02X (I2C0 do GT911)\r\n"
                     "  0x70 = %02X %s  bit3 carga habilitada = %d\r\n"
                     "  0x71 = %02X %s  bit3 celula cheia      = %d\r\n"
                     "  0x77 = %02X %s  botao (curto/longo/duplo) = %d%d%d\r\n"
                     "  0x78 = %02X %s  barra LED4..1        = %d%d%d%d -> %d%%\r\n",
                     (unsigned)kAddr,
                     (unsigned)r70, o70 ? "" : "(!)", (r70 >> 3) & 1,
                     (unsigned)r71, o71 ? "" : "(!)", (r71 >> 3) & 1,
                     (unsigned)r77, o77 ? "" : "(!)",
                     (r77 >> 2) & 1, (r77 >> 1) & 1, r77 & 1,
                     (unsigned)r78, o78 ? "" : "(!)",
                     (r78 >> 7) & 1, (r78 >> 6) & 1, (r78 >> 5) & 1, (r78 >> 4) & 1,
                     ((r78 & 0xF0) >> 4) * 25);
    return n > 0 ? n : -1;
}

}  // namespace Ip5306

#endif  // CELER_BOARDS_SMARTDISPLAY_IP5306_H
