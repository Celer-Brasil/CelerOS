#include "JSBindings.h"

#include "../Boards/Board.h"
#include "../Hardware/I2cBus.h"
#include "JsInternal.h"
#include "driver/gpio.h"
#include "esp_private/esp_gpio_reserve.h"

#include <cstdio>

// ============================================================================
// System.i2c (API 54) — barramento I2C generico para apps.
//
// O firmware NAO traz driver de sensor/atuador I2C: entrega o bus cru
// (begin/beginAt/end/pins/scan/read/write/writeReg/readReg) e o protocolo
// mora nas deps JS (ex.: celeros.hw.pca9685). Bytes sempre como array de
// numeros 0..255 (Duktape lean, sem Uint8Array); teto de 128 B por
// transferencia. Mesma permissao do System.gpio ("gpio").
//
// O bus da placa sobre o i2c_master (touch SmartDisplay/watch) ja nasce no
// boot: begin() ADOTA o handle existente em vez de recriar. No cao o bus do
// OLED e do proprio LGFX (I2cPins::rawDriver): begin()/beginAt(pinos da
// placa)/pins() recusam (ver Hardware/I2cBus.h).
// ============================================================================

namespace {

constexpr size_t kMaxXfer = 128;

// Pino utilizavel como SDA/SCL. Nos pinos do proprio perfil confiamos no
// driver do touch/OLED (o IDF ja os reservou); fora deles a mesma guarda do
// System.gpio (flash/PSRAM/gpioDeniedMask).
bool pinAllowed(int pin, const BoardProfile& bp, bool boardPair) {
    if (pin < 0 || pin >= 64 || !GPIO_IS_VALID_OUTPUT_GPIO(pin)) return false;
    if (boardPair) return true;
    const uint64_t bit = 1ULL << pin;
    if (bp.gpioDeniedMask & bit) return false;
    if (esp_gpio_is_reserved(bit)) return false;
    return true;
}

int requirePin(duk_context* ctx, duk_idx_t idx, const BoardProfile& bp, bool boardPair) {
    const int pin = duk_require_int(ctx, idx);
    if (!pinAllowed(pin, bp, boardPair)) {
        // Mensagem pre-formatada: jsThrowMsg e o padrao dos lightfunc (um
        // duk_error com %d corrompe o heap do runtime, bancada 2026-10-02).
        char msg[64];
        snprintf(msg, sizeof(msg), "GPIO %d invalido para I2C (saida/reservado)", pin);
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, msg);
    }
    return pin;
}

int requireAddr(duk_context* ctx, duk_idx_t idx) {
    const int addr = duk_require_int(ctx, idx);
    if (addr < 0x08 || addr > 0x77) {
        char msg[64];
        snprintf(msg, sizeof(msg), "endereco I2C %d fora de 8..119 (7 bits)", addr);
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, msg);
    }
    return addr;
}

int requireReg(duk_context* ctx, duk_idx_t idx) {
    const int reg = duk_require_int(ctx, idx);
    if (reg < 0 || reg > 255) {
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "registrador I2C deve ser 0..255");
    }
    return reg;
}

int requireLen(duk_context* ctx, duk_idx_t idx) {
    const int len = duk_require_int(ctx, idx);
    if (len < 1 || len > (int)kMaxXfer) {
        char msg[64];
        snprintf(msg, sizeof(msg), "tamanho I2C %d fora de 1..%d", len, (int)kMaxXfer);
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, msg);
    }
    return len;
}

// Copia um array de bytes do JS (0..255) para buf. Valida ANTES de copiar:
// um throw no meio nao pode deixar estado pela metade (mesmo padrao do
// JsUsb.cpp:60-91).
size_t readBytes(duk_context* ctx, duk_idx_t idx, uint8_t* buf, size_t cap, const char* what) {
    if (!duk_is_array(ctx, idx)) jsThrowMsg(ctx, DUK_ERR_TYPE_ERROR, what);
    const duk_size_t n = duk_get_length(ctx, idx);
    if (n == 0 || n > cap) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, what);
    for (duk_size_t i = 0; i < n; i++) {
        duk_get_prop_index(ctx, idx, (duk_uarridx_t)i);
        const int v = duk_get_int(ctx, -1);
        duk_pop(ctx);
        if (v < 0 || v > 255) jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, what);
        buf[i] = (uint8_t)v;
    }
    return (size_t)n;
}

void pushBytes(duk_context* ctx, const uint8_t* data, size_t n) {
    duk_push_array(ctx);
    for (size_t i = 0; i < n; i++) {
        duk_push_int(ctx, data[i]);
        duk_put_prop_index(ctx, -2, (duk_uarridx_t)i);
    }
}

void pushInfo(duk_context* ctx, const I2cBus::Info& info) {
    duk_push_object(ctx);
    duk_push_int(ctx, info.port);
    duk_put_prop_string(ctx, -2, "port");
    duk_push_int(ctx, info.sda);
    duk_put_prop_string(ctx, -2, "sda");
    duk_push_int(ctx, info.scl);
    duk_put_prop_string(ctx, -2, "scl");
    duk_push_uint(ctx, info.hz);
    duk_put_prop_string(ctx, -2, "hz");
}

}  // namespace

// System.i2c.begin() -> {port,sda,scl,hz} | null
duk_ret_t JSBindings::js_i2cBegin(duk_context* ctx) {
    // Ja aberto pelo app com beginAt (placa sem bus de placa): devolve o
    // bus corrente em vez de falhar — o PCA9685.create({addr}) funciona
    // depois de abrir os pinos explicitos.
    if (I2cBus::active()) {
        pushInfo(ctx, I2cBus::info());
        return 1;
    }
    I2cBus::Info info;
    if (!I2cBus::beginBoard(&info)) {
        duk_push_null(ctx);
        return 1;
    }
    pushInfo(ctx, info);
    return 1;
}

// System.i2c.beginAt(sda, scl, hz) -> {port,sda,scl,hz} | null
duk_ret_t JSBindings::js_i2cBeginAt(duk_context* ctx) {
    const int sda = duk_require_int(ctx, 0);
    const int scl = duk_require_int(ctx, 1);
    uint32_t hz = duk_require_uint(ctx, 2);
    if (sda == scl) {
        jsThrowMsg(ctx, DUK_ERR_RANGE_ERROR, "SDA e SCL nao podem ser o mesmo pino");
    }
    const BoardProfile& bp = Board::profile();
    const bool boardPair = (sda == bp.i2c.sda && scl == bp.i2c.scl);
    // O par da placa so passa pelo gpioDeniedMask quando o bus e ADOTAVEL
    // (i2c_master do touch: os pinos ja nascem reservados pelo driver). No
    // cao (rawDriver) os mesmos pinos sao negados como no System.gpio —
    // abrir ali criaria um segundo master na porta do OLED.
    const bool adoptablePair = boardPair && !bp.i2c.rawDriver;
    requirePin(ctx, 0, bp, adoptablePair);
    requirePin(ctx, 1, bp, adoptablePair);
    if (hz < 10000) hz = 10000;
    if (hz > 1000000) hz = 1000000;
    I2cBus::Info info;
    if (!I2cBus::begin(sda, scl, hz, &info)) {
        duk_push_null(ctx);
        return 1;
    }
    pushInfo(ctx, info);
    return 1;
}

// System.i2c.end() -> boolean (idempotente)
duk_ret_t JSBindings::js_i2cEnd(duk_context* ctx) {
    I2cBus::end();
    duk_push_boolean(ctx, 1);
    return 1;
}

// System.i2c.pins() -> {port,sda,scl,hz} | null (bus do perfil da placa)
duk_ret_t JSBindings::js_i2cPins(duk_context* ctx) {
    const I2cPins& bp = Board::profile().i2c;
    // rawDriver (OLED do cao): o bus existe, mas NAO e recurso de app —
    // devolver o par aqui preencheria um seletor com pinos que o beginAt
    // recusa em seguida.
    if (bp.sda < 0 || bp.scl < 0 || bp.rawDriver) {
        duk_push_null(ctx);
        return 1;
    }
    I2cBus::Info info;
    info.port = bp.port;
    info.sda = bp.sda;
    info.scl = bp.scl;
    info.hz = bp.hz;
    pushInfo(ctx, info);
    return 1;
}

// System.i2c.scan() -> number[] (0x08..0x77)
duk_ret_t JSBindings::js_i2cScan(duk_context* ctx) {
    duk_push_array(ctx);
    if (!I2cBus::active()) return 1;  // sem begin: lista vazia
    duk_uarridx_t n = 0;
    for (int addr = 0x08; addr <= 0x77; addr++) {
        if (I2cBus::probe((uint8_t)addr)) {
            duk_push_int(ctx, addr);
            duk_put_prop_index(ctx, -2, n++);
        }
        // 112 probes: um barramento travado pode levar segundos. A janela do
        // executor e 1 s; renovar a cada 16 enderecos mantem o app vivo.
        if (((addr - 0x08) & 15) == 15) CelerKernel::noteAppYield();
    }
    CelerKernel::noteAppYield();
    return 1;
}

// System.i2c.write(addr, data) -> boolean
duk_ret_t JSBindings::js_i2cWrite(duk_context* ctx) {
    const int addr = requireAddr(ctx, 0);
    uint8_t buf[kMaxXfer];
    const size_t n = readBytes(ctx, 1, buf, sizeof(buf),
                               "System.i2c.write: data 1..128 bytes 0..255");
    if (!I2cBus::active()) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    duk_push_boolean(ctx, I2cBus::write((uint8_t)addr, buf, n) ? 1 : 0);
    return 1;
}

// System.i2c.read(addr, len) -> number[] | null
duk_ret_t JSBindings::js_i2cRead(duk_context* ctx) {
    const int addr = requireAddr(ctx, 0);
    const int len = requireLen(ctx, 1);
    if (!I2cBus::active()) {
        duk_push_null(ctx);
        return 1;
    }
    uint8_t buf[kMaxXfer];
    if (!I2cBus::read((uint8_t)addr, buf, (size_t)len)) {
        duk_push_null(ctx);
        return 1;
    }
    pushBytes(ctx, buf, (size_t)len);
    return 1;
}

// System.i2c.writeReg(addr, reg, data) -> boolean
duk_ret_t JSBindings::js_i2cWriteReg(duk_context* ctx) {
    const int addr = requireAddr(ctx, 0);
    const int reg = requireReg(ctx, 1);
    uint8_t buf[kMaxXfer];
    const size_t n = readBytes(ctx, 2, buf, sizeof(buf),
                               "System.i2c.writeReg: data 1..128 bytes 0..255");
    if (!I2cBus::active()) {
        duk_push_boolean(ctx, 0);
        return 1;
    }
    duk_push_boolean(ctx, I2cBus::writeReg((uint8_t)addr, (uint8_t)reg, buf, n) ? 1 : 0);
    return 1;
}

// System.i2c.readReg(addr, reg, len) -> number[] | null
duk_ret_t JSBindings::js_i2cReadReg(duk_context* ctx) {
    const int addr = requireAddr(ctx, 0);
    const int reg = requireReg(ctx, 1);
    const int len = requireLen(ctx, 2);
    if (!I2cBus::active()) {
        duk_push_null(ctx);
        return 1;
    }
    uint8_t buf[kMaxXfer];
    if (!I2cBus::readReg((uint8_t)addr, (uint8_t)reg, buf, (size_t)len)) {
        duk_push_null(ctx);
        return 1;
    }
    pushBytes(ctx, buf, (size_t)len);
    return 1;
}

// Fim do app (appExitCleanup e init do proximo): solta devices e o bus que
// o app abriu. O bus da placa (touch/OLED) continua vivo.
void jsI2cReset() { I2cBus::end(); }
