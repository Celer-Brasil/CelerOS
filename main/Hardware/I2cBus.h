#pragma once

// ============================================================================
// I2cBus — barramento I2C generico para apps (API 54, System.i2c).
//
// O firmware ja tem I2C0 em tres placas: GT911 da SmartDisplay (19/45),
// FT3168/PMU/RTC/IMU do watch (15/14) e SH1106 do cao (41/42). O driver novo
// do IDF (driver/i2c_master.h, IDF 6.1) serializa as transacoes por bus; este
// helper ADOTA o bus que o touch/OLED ja abriu e so acrescenta os devices do
// app (touch/PMU continuam funcionando).
//
// Placa sem bus de placa (CYD/devkit/devkit-s3/esp32-cam) chama begin() com
// pinos explicitos; nesse caso o bus e criado por nos e apagado no end().
// O runtime JS roda na task do app — sem mutex proprio. No cao o LGFX escreve
// o OLED na MESMA task (nao ha concorrencia); no watch o touch roda em task
// propria, mas o bus_lock_mux do IDF serializa os devices do driver.
// ============================================================================

#include <stddef.h>
#include <stdint.h>

#include "driver/i2c_master.h"

namespace I2cBus {

// Porta/pinos/frequencia do bus aberto.
struct Info {
    int port = -1;
    int sda = -1;
    int scl = -1;
    uint32_t hz = 400000;
    bool valid() const { return sda >= 0 && scl >= 0; }
};

// Abre o bus do perfil da placa (BoardProfile::i2c). false se a placa nao
// declara um bus ou se o IDF falhou. Idempotente: com o bus ja aberto nos
// mesmos pinos, devolve o mesmo Info.
bool beginBoard(Info* out);

// Abre/adota um bus com pinos explicitos. Se a placa ja tem um bus nos
// MESMOS pinos, adota o handle existente (nao recria). Se a porta do perfil
// esta ocupada com outros pinos, tenta a outra porta do chip. false se nao
// houver porta livre ou o IDF falhar.
bool begin(int sda, int scl, uint32_t hz, Info* out);

// Remove os devices criados por nos e, se o bus foi criado por nos, apaga o
// bus. Barramento adotado (touch/OLED) continua vivo. Idempotente.
void end();

bool active();
const Info& info();

// i2c_master_probe: true se houver um device respondendo no endereco 7 bits.
bool probe(uint8_t addr);

// Transferencias (timeout 50 ms). Nao validam argumentos: o binding JS
// valida endereco/tamanho antes; aqui so ha a checagem de buffer.
bool write(uint8_t addr, const uint8_t* data, size_t n);
bool read(uint8_t addr, uint8_t* data, size_t n);
bool writeReg(uint8_t addr, uint8_t reg, const uint8_t* data, size_t n);
bool readReg(uint8_t addr, uint8_t reg, uint8_t* data, size_t n);

}  // namespace I2cBus
