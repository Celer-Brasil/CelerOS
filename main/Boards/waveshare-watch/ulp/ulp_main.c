// Sentinela ULP-RISC-V do watch durante o deep sleep. Roda no
// coprocessador a cada ciclo do timer e vigia:
//   - PEK do AXP2101 (tecla PWR): sem IRQ em GPIO no watch, sem este
//     programa ela NAO acorda o relogio do deep sleep;
//   - INT1 do QMI8658 (GPIO21, ativo-baixo): servida por I2C (ler STATUS1
//     limpa o nivel) e filtrada por janela — dois eventos em ~2 s sao um
//     gesto de levantar o pulso; esbarramento isolado nao acorda;
//   - VBUS do AXP2101: cabo plugado durante o sono acorda (USB/celerctl e
//     a tela de carga voltam sem apertar nada);
//   - VBAT do AXP2101: celula cruzando o limiar acorda UMA vez (borda com
//     histerese — sem isso o re-arm com a celula ja fraca acordava em loop);
//     abaixo do critico a sentinela entra em sobrevivencia sozinha: desliga
//     o IMU e fica so no PEK/VBUS, sem gastar um boot.
// Ciclo adaptativo: rapido (~100 ms) com o pulso mexendo, lento (~250 ms)
// depois de cfg_calm_ms sem INT do IMU (mesa, noite) — o proprio ULP
// reescreve o periodo do timer com os ciclos pre-calculados pelo main. A
// tecla PWR fica latchada no IRQ_ST0, entao o lento so atrasa, nao perde.
// O bus I2C0 (SDA=15, SCL=14) e bit-banged em open-drain com pull-up de
// RTC: o controlador I2C de hardware do ULP so fala GPIO 0..3.
//
// A mailbox (globals abaixo) vive na RTC slow mem e sobrevive ao deep
// sleep; o WatchUlp.cpp a le no boot seguinte pelos simbolos ulp_* do
// header gerado ulp_watch.h. Globals "static" ficam privados do programa.
// Cada arm() recarrega o binario: .data volta aos defaults e o WatchUlp
// sobrescreve a config antes do run().

#include <stdint.h>
#include <stdbool.h>
#include "ulp_riscv.h"
#include "ulp_riscv_utils.h"
#include "ulp_riscv_gpio.h"
#include "ulp_riscv_register_ops.h"
#include "soc/rtc_cntl_reg.h"
#include "UlpWatch.h"

// ---- mailbox (RTC slow) ----------------------------------------------------
uint32_t mb_magic = 0;    // ULP_MB_MAGIC a partir do primeiro ciclo
uint32_t mb_run = 0;      // ciclos executados (diagnostico)
uint32_t mb_wake = 0;     // ULP_WAKE_* — motivo do ultimo wake pedido
uint32_t mb_bat_mv = 0;   // ultima VBAT valida lida
uint32_t mb_i2c_err = 0;  // transacoes falhas acumuladas
uint32_t mb_flags = 0;    // ULP_FLAG_* (estado no momento do wake)
uint32_t mb_slow = 0;     // ciclos rodados no periodo lento (diagnostico)

// ---- config (defaults; o WatchUlp.cpp sobrescreve antes do run) -----------
uint32_t cfg_enable = ULP_EN_PEK | ULP_EN_RAISE | ULP_EN_BAT | ULP_EN_VBUS;
uint32_t cfg_bat_lo_mv = 3300;
uint32_t cfg_bat_crit_mv = 3150;  // abaixo: sobrevivencia (IMU off, sem raise)
uint32_t cfg_bat_hyst_mv = 100;   // rearma o aviso so acima de lo + hyst
uint32_t cfg_raise_win_ms = 2000; // janela do filtro do raise
uint32_t cfg_bat_every_ms = 300000;
uint32_t cfg_vbus_every_ms = 1000;
uint32_t cfg_calm_ms = 60000;     // sem INT do IMU por isso -> ciclo lento
uint32_t cfg_fast_ms = 100;       // periodos em ms (contabilidade de tempo)...
uint32_t cfg_slow_ms = 250;
uint32_t cfg_fast_cyc = 0;        // ... e em ciclos do RTC slow (0 = nao troca)
uint32_t cfg_slow_cyc = 0;

// ---- estado interno (persiste entre ciclos; re-init a cada arm) -----------
static uint32_t s_ms = 0;         // tempo de sono acumulado (aprox., em ms)
static uint32_t s_raise_at = 0;
static bool s_raise_have = false;
static uint32_t s_moved_at = 0;   // ultima INT do IMU
static bool s_slow = false;
static uint32_t s_bat_at = 0;
static bool s_bat_first = true;
static bool s_bat_warned = false; // borda do LOWBAT ja consumida
static uint32_t s_vbus_at = 0;
static int s_vbus_prev = -1;      // -1 = sem baseline ainda

// ---- I2C bit-bang (open-drain: escrever 1 solta a linha) ------------------
static inline void scl_lo(void) { ulp_riscv_gpio_output_level(ULP_PIN_SCL, 0); }
static inline void scl_hi(void) { ulp_riscv_gpio_output_level(ULP_PIN_SCL, 1); }
static inline void sda_lo(void) { ulp_riscv_gpio_output_level(ULP_PIN_SDA, 0); }
static inline void sda_hi(void) { ulp_riscv_gpio_output_level(ULP_PIN_SDA, 1); }
static inline bool sda_in(void) { return ulp_riscv_gpio_get_level(ULP_PIN_SDA) != 0; }

static void pins_init(void) {
    ulp_riscv_gpio_init(ULP_PIN_SCL);
    ulp_riscv_gpio_init(ULP_PIN_SDA);
    ulp_riscv_gpio_pulldown_disable(ULP_PIN_SCL);
    ulp_riscv_gpio_pulldown_disable(ULP_PIN_SDA);
    ulp_riscv_gpio_pullup(ULP_PIN_SCL);
    ulp_riscv_gpio_pullup(ULP_PIN_SDA);
    ulp_riscv_gpio_input_enable(ULP_PIN_SCL);
    ulp_riscv_gpio_input_enable(ULP_PIN_SDA);
    ulp_riscv_gpio_output_enable(ULP_PIN_SCL);
    ulp_riscv_gpio_output_enable(ULP_PIN_SDA);
    ulp_riscv_gpio_set_output_mode(ULP_PIN_SCL, RTCIO_MODE_OUTPUT_OD);
    ulp_riscv_gpio_set_output_mode(ULP_PIN_SDA, RTCIO_MODE_OUTPUT_OD);

    ulp_riscv_gpio_init(ULP_PIN_IMU_INT);
    ulp_riscv_gpio_input_enable(ULP_PIN_IMU_INT);
    ulp_riscv_gpio_pulldown_disable(ULP_PIN_IMU_INT);
    ulp_riscv_gpio_pullup(ULP_PIN_IMU_INT);
}

// Linhas livres (altas)? Se um slave prendeu a SDA, 9 pulsos de SCL soltam.
static bool bus_ready(void) {
    scl_hi();
    sda_hi();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    if (sda_in()) return true;
    for (int i = 0; i < 9; i++) {
        scl_lo();
        ulp_riscv_delay_us(ULP_I2C_HALF_US);
        scl_hi();
        ulp_riscv_delay_us(ULP_I2C_HALF_US);
    }
    sda_hi();
    ulp_riscv_delay_us(2 * ULP_I2C_HALF_US);
    return sda_in();
}

static void i2c_start(void) {  // ambas altas -> SDA cai com SCL alto
    sda_lo();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    scl_lo();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
}

static void i2c_restart(void) {  // com SCL baixo: solta SDA, SCL sobe, SDA cai
    sda_hi();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    scl_hi();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    sda_lo();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    scl_lo();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
}

static void i2c_stop(void) {  // com SCL baixo: SDA baixa, SCL sobe, SDA solta
    sda_lo();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    scl_hi();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    sda_hi();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
}

// Escreve 8 bits + clock do ACK; true = slave puxou a SDA baixa.
static bool i2c_write_byte(uint8_t v) {
    for (int i = 7; i >= 0; i--) {
        if ((v >> i) & 1) sda_hi(); else sda_lo();
        ulp_riscv_delay_us(ULP_I2C_HALF_US);
        scl_hi();
        ulp_riscv_delay_us(ULP_I2C_HALF_US);
        scl_lo();
    }
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    sda_hi();  // 9o clock: solta p/ o slave responder
    scl_hi();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    bool nack = sda_in();
    scl_lo();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    return !nack;
}

static uint8_t i2c_read_byte(bool ack) {
    uint8_t v = 0;
    sda_hi();  // slave conduz
    for (int i = 7; i >= 0; i--) {
        scl_hi();
        ulp_riscv_delay_us(ULP_I2C_HALF_US);
        v = (uint8_t)((v << 1) | (sda_in() ? 1 : 0));
        scl_lo();
        ulp_riscv_delay_us(ULP_I2C_HALF_US);
    }
    if (ack) sda_lo(); else sda_hi();  // ACK na ultima? NACK encerra a leitura
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    scl_hi();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    scl_lo();
    ulp_riscv_delay_us(ULP_I2C_HALF_US);
    sda_hi();
    return v;
}

// Le n bytes de um registrador de 8 bits (write reg + repeated start + read).
static bool i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t* out, int n) {
    if (!bus_ready()) return false;
    i2c_start();
    if (!i2c_write_byte((uint8_t)(addr << 1))) {
        i2c_stop();
        return false;
    }
    if (!i2c_write_byte(reg)) {
        i2c_stop();
        return false;
    }
    i2c_restart();
    if (!i2c_write_byte((uint8_t)((addr << 1) | 1))) {
        i2c_stop();
        return false;
    }
    for (int i = 0; i < n; i++) out[i] = i2c_read_byte(i != n - 1);
    i2c_stop();
    return true;
}

// Escreve um registrador de 8 bits.
static bool i2c_write_reg(uint8_t addr, uint8_t reg, uint8_t val) {
    if (!bus_ready()) return false;
    i2c_start();
    bool ok = i2c_write_byte((uint8_t)(addr << 1)) && i2c_write_byte(reg) && i2c_write_byte(val);
    i2c_stop();
    return ok;
}

// Troca o periodo do timer do ULP (vale a partir do proximo halt). Os
// ciclos vem prontos do main: o ULP nao tem a calibracao do RTC slow.
static void set_slow(bool slow) {
    const uint32_t cyc = slow ? cfg_slow_cyc : cfg_fast_cyc;
    if (cyc == 0 || slow == s_slow) return;
    REG_SET_FIELD(RTC_CNTL_ULP_CP_TIMER_1_REG, RTC_CNTL_ULP_CP_TIMER_SLP_CYCLE, cyc);
    s_slow = slow;
    if (slow) mb_flags |= ULP_FLAG_SLOW; else mb_flags &= ~ULP_FLAG_SLOW;
}

static void wake_main(uint32_t why) {
    mb_wake = why;
    ulp_riscv_wakeup_main_processor();
}

// Celula critica: IMU desligado pelo proprio ULP (o QMI8658 a 30 Hz e o
// maior consumidor que sobra no sono) e raise fora. PEK/VBUS seguem.
static void survive(void) {
    if (mb_flags & ULP_FLAG_SURVIVE) return;
    mb_flags |= ULP_FLAG_SURVIVE;
    if (cfg_enable & ULP_EN_RAISE) {
        cfg_enable &= ~ULP_EN_RAISE;
        i2c_write_reg(ULP_QMI_ADDR, ULP_QMI_CTRL7, 0x00);
    }
    set_slow(true);
}

int main(void) {
    if (mb_magic != ULP_MB_MAGIC) {  // primeiro ciclo desde o arm()
        mb_magic = ULP_MB_MAGIC;
        mb_run = 0;
        mb_wake = ULP_WAKE_NONE;
        mb_bat_mv = 0;
        mb_i2c_err = 0;
        mb_flags = 0;
        mb_slow = 0;
        s_ms = 0;
        s_raise_at = 0;
        s_raise_have = false;
        s_moved_at = 0;
        s_slow = false;
        s_bat_at = 0;
        s_bat_first = true;
        s_bat_warned = false;
        s_vbus_at = 0;
        s_vbus_prev = -1;
        pins_init();
    }
    mb_run++;
    if (s_slow) mb_slow++;
    s_ms += s_slow ? cfg_slow_ms : cfg_fast_ms;
    if (mb_flags & ULP_FLAG_BUS_DEAD) return 0;

    // PEK: bit4 do IRQ_ST0 e borda de descida da tecla. Acorda na hora — o
    // boot le o motivo na mailbox e acende a tela.
    uint8_t st0 = 0;
    if (!i2c_read_reg(ULP_AXP_ADDR, ULP_AXP_IRQ_ST0, &st0, 1)) {
        // Sem ACK (bus sem pull-up suficiente, slave preso): ~100 falhas
        // seguidas e a sentinela desiste do I2C — BOOT/timer seguem valendo.
        // O timer vai para o lento: nada mais a vigiar com pressa.
        if (++mb_i2c_err > 100) {
            mb_flags |= ULP_FLAG_BUS_DEAD;
            set_slow(true);
        }
        return 0;
    }
    if ((cfg_enable & ULP_EN_PEK) && (st0 & ULP_AXP_PEK_PRESS)) {
        wake_main(ULP_WAKE_PEK);
        return 0;
    }

    // Raise: nivel baixo na INT1 (segura ate ler STATUS1). Servir limpa e
    // rearma o engine; cada evento e 1 hit e 2 hits na janela sao o gesto.
    // Qualquer hit volta o ciclo para o rapido: pulso mexendo = PWR e raise
    // provaveis em seguida. Leitura que FALHA nao limpou a INT (nivel segue
    // baixo): se contasse como hit, o ciclo seguinte (leitura ok) via
    // "2 hits na janela" e acordava o relogio com um raise falso a cada
    // glitch de I2C no sono.
    if ((cfg_enable & ULP_EN_RAISE) && ulp_riscv_gpio_get_level(ULP_PIN_IMU_INT) == 0) {
        uint8_t st1 = 0;
        const bool ok = i2c_read_reg(ULP_QMI_ADDR, ULP_QMI_STATUS1, &st1, 1);
        s_moved_at = s_ms;
        set_slow(false);
        if (ok) {
            if (s_raise_have && (s_ms - s_raise_at) <= cfg_raise_win_ms) {
                wake_main(ULP_WAKE_RAISE);
                return 0;
            }
            s_raise_at = s_ms;
            s_raise_have = true;
        }
    }

    // VBUS: so a borda de subida acorda (dormir JA no cabo nao dispara).
    if ((cfg_enable & ULP_EN_VBUS) && (s_vbus_prev < 0 || s_ms - s_vbus_at >= cfg_vbus_every_ms)) {
        uint8_t s1 = 0;
        if (i2c_read_reg(ULP_AXP_ADDR, ULP_AXP_STATUS1, &s1, 1)) {
            s_vbus_at = s_ms;
            const int vbus = (s1 & ULP_AXP_VBUS_GOOD) ? 1 : 0;
            const int prev = s_vbus_prev;
            s_vbus_prev = vbus;
            if (prev == 0 && vbus == 1) {
                wake_main(ULP_WAKE_VBUS);
                return 0;
            }
        }
    }

    // Bateria: primeira leitura no primeiro ciclo (baseline), depois a cada
    // cfg_bat_every_ms. Ja fraca no arm = o usuario ja viu acordado: sem
    // wake, so a borda de uma celula que CAI durante o sono acorda.
    if ((cfg_enable & ULP_EN_BAT) && (s_bat_first || s_ms - s_bat_at >= cfg_bat_every_ms)) {
        uint8_t b[2] = {0, 0};
        if (i2c_read_reg(ULP_AXP_ADDR, ULP_AXP_VBAT_H, b, 2)) {
            s_bat_at = s_ms;
            const uint32_t mv = (((uint32_t)b[0] << 8) | b[1]) & 0x3FFF;
            if (mv >= 2500 && mv <= 5000) {  // faixa util de Li-ion 1S
                const bool first = s_bat_first;
                s_bat_first = false;
                mb_bat_mv = mv;
                if (mv < cfg_bat_crit_mv && s_vbus_prev != 1) survive();
                if (mv < cfg_bat_lo_mv) {
                    if (!s_bat_warned) {
                        s_bat_warned = true;
                        if (!first && !(mb_flags & ULP_FLAG_SURVIVE)) {
                            wake_main(ULP_WAKE_LOWBAT);
                            return 0;
                        }
                    }
                } else if (mv > cfg_bat_lo_mv + cfg_bat_hyst_mv) {
                    s_bat_warned = false;
                }
            }
        }
    }

    // Pulso parado por cfg_calm_ms (ou sem raise ligado): ciclo lento.
    if (!s_slow && s_ms - s_moved_at >= cfg_calm_ms) set_slow(true);
    return 0;  // halt automatico; main() roda de novo no proximo ciclo
}
