#ifndef CELEROS_TOUCH_GT911_IDF_H
#define CELEROS_TOUCH_GT911_IDF_H

// Touch GT911 sobre o driver i2c_master oficial do ESP-IDF.
//
// Motivo: a camada I2C register-level (LL) do LovyanGFX falha silenciosamente
// no IDF 6.1 neste alvo (probe com o driver oficial confirmou o GT911
// respondendo em 0x5D enquanto o getTouch do LovyanGFX retornava 0). Este
// driver implementa a interface ITouch do LovyanGFX usando o driver novo do
// IDF, mantendo o painel/display intacto.
//
// O protocolo e um porte fiel do Touch_GT911.inl do LovyanGFX (1.2.30):
//   - so considera dado quando o bit7 de 0x814E esta pronto, e NUNCA limpa a
//     flag quando nao ha dado pronto (limpar apaga eventos pendentes);
//   - le os pontos e limpa (0x814E=0) uma unica vez por leitura util;
//   - respeita o refresh rate do controlador (reg 0x8056) e descarta dados
//     stale apos >128ms sem leitura (flush + retry);
//   - tenta 0x5D e 0x14 (enderecos alternativos do GT911).
//
// Leitura em SEGUNDO PLANO (task "gt911", nucleo 0): a task le o chip no
// ritmo dele (refresh com dedo, kIdleMs parado) e publica o ultimo estado;
// getTouchRaw so copia. Antes o I2C rodava no getTouch do app: ~2 ms por
// quadro em todo jogo e, com o loop do app acima de 128 ms (jogo pesado a
// < 8 fps), TODA leitura caia no flush + espera de amostra nova (ate 24 x
// delay(1)) - ~30 ms travando a thread do JS a cada quadro, um ciclo
// vicioso (bancada 2026-10-18, Supernova a 6 fps). Sem a task (sem RAM)
// segue o caminho sincrono de antes.
//
// Layout dos pontos (a partir de 0x814F, 8 bytes por ponto):
//   [track][x_lo][x_hi][y_lo][y_hi][sz_lo][sz_hi][rsv]

#include "lgfx/v1/Touch.hpp"
#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"
#include <string.h>

namespace lgfx
{
 inline namespace v1
 {
//----------------------------------------------------------------------------

  struct Touch_GT911_IDF : public ITouch
  {
    static constexpr const uint8_t default_addr_1 = 0x14;
    static constexpr const uint8_t default_addr_2 = 0x5D;

    Touch_GT911_IDF(void)
    {
      _cfg.i2c_addr = default_addr_2;
      _cfg.freq = 400000;
    }

    ~Touch_GT911_IDF(void) override
    {
      deinit();
    }

    bool init(void) override
    {
      if (_inited) return true;
      deinit();

      for (int retry = 6; retry; --retry)
      {
        if (!openBus()) { deinit(); return false; }

        // Valida com o product id (0x8140) e le o refresh rate (0x8056)
        uint8_t ver[2] = {0x81, 0x40};
        uint8_t id[4] = {0, 0, 0, 0};
        if (writeRead(ver, 2, id, 4)) {
            productId[0] = id[0]; productId[1] = id[1]; productId[2] = id[2];
            uint8_t rate[2] = {0x81, 0x56};
            uint8_t r = 0;
            if (writeRead(rate, 2, &r, 1)) _refresh_rate = 5 + (r & 0x0F);
            _inited = true;
            ESP_LOGI("celer.touch", "GT911 init OK (addr 0x%02X refresh %ums id=%c%c%c)",
                     (unsigned)_cfg.i2c_addr, (unsigned)_refresh_rate,
                     productId[0], productId[1], productId[2]);
            startPoller();
            return true;
        }
        // alterna o endereco e tenta de novo
        closeBus();
        if (_cfg.i2c_addr == default_addr_2) _cfg.i2c_addr = default_addr_1;
        else _cfg.i2c_addr = default_addr_2;
      }
      ESP_LOGE("celer.touch", "GT911 nao respondeu em nenhum endereco");
      return false;
    }

    void wakeup(void) override {}
    void sleep(void) override {}

    uint_fast8_t getTouchRaw(touch_point_t* tp, uint_fast8_t count) override
    {
      if (!_inited || tp == nullptr || count == 0) return 0;
      if (count > 5) count = 5;

      if (_task != nullptr) {
        // task de fundo: so copia o ultimo estado publicado (sem I2C aqui)
        uint8_t snap[sizeof(_readdata)];
        portENTER_CRITICAL(&_mux);
        memcpy(snap, _shared, sizeof(snap));
        portEXIT_CRITICAL(&_mux);
        return parse(snap, tp, count);
      }
      poll();
      return parse(_readdata, tp, count);
    }

  private:
    // leitura no ritmo do chip (sincrona: chamada pela task ou, sem ela,
    // pelo getTouchRaw como antes)
    void poll(void)
    {
      uint32_t msec = lgfx::millis();
      uint32_t diff_msec = msec - _last_update;
      // Sem dedo na ultima leitura: consulta no maximo a cada kIdleMs (a
      // placa nao liga o INT, entao e polling; com o loop a 5 ms e refresh
      // de ~5-10 ms eram 100-200 transacoes I2C/s com ninguem tocando).
      // Com dedo, segue o refresh do chip (arrasto sem perder amostras).
      const uint32_t interval = (_readdata[0] & 0x0F) ? _refresh_rate
                                : std::max<uint32_t>(_refresh_rate, kIdleMs);

      if (diff_msec >= interval)
      {
        _last_update = msec;

        if (diff_msec >= 128)
        {
          // Dado antigo demais: limpa e espera leitura fresca (com retry)
          flushStatus();
          for (size_t retry = 24; retry; --retry)
          {
            if (updateData()) break;
            delay(1);
          }
        }
        else
        {
          updateData();
        }
      }
    }

    uint_fast8_t parse(const uint8_t* rd, touch_point_t* tp, uint_fast8_t count)
    {
      uint32_t points = std::min<uint_fast8_t>(count, rd[0] & 0x0F);
      for (size_t idx = 0; idx < points; ++idx)
      {
        // bytes little-endian lidos um a um: rd pode ser a copia da pilha
        // (snap, uint8_t sem alinhamento garantido) e uma leitura uint16_t
        // desalinhada e LoadStoreAlignment no Xtensa (so com dedo na tela)
        const uint8_t* b = &rd[idx * 8];
        tp[idx].id   = b[1];
        tp[idx].x    = (uint16_t)(b[2] | (b[3] << 8));
        tp[idx].y    = (uint16_t)(b[4] | (b[5] << 8));
        tp[idx].size = (uint16_t)(b[6] | (b[7] << 8));

        if (tp[idx].x < _cfg.x_min) tp[idx].x = _cfg.x_min;
        if (tp[idx].x > _cfg.x_max) tp[idx].x = _cfg.x_max;
        if (tp[idx].y < _cfg.y_min) tp[idx].y = _cfg.y_min;
        if (tp[idx].y > _cfg.y_max) tp[idx].y = _cfg.y_max;
      }
      return points;
    }

    static void pollTask(void* arg)
    {
      auto* self = static_cast<Touch_GT911_IDF*>(arg);
      for (;;) {
        self->poll();
        portENTER_CRITICAL(&self->_mux);
        memcpy(self->_shared, self->_readdata, sizeof(self->_shared));
        portEXIT_CRITICAL(&self->_mux);
        // proxima amostra no ritmo do chip (com dedo) ou kIdleMs (parado)
        const uint32_t iv = (self->_readdata[0] & 0x0F) ? self->_refresh_rate
                          : std::max<uint32_t>(self->_refresh_rate, kIdleMs);
        vTaskDelay(pdMS_TO_TICKS(iv > 1 ? iv : 1));
      }
    }

    void startPoller(void)
    {
      if (_task != nullptr) return;
      // nucleo 0 (o da main/Duktape, WiFi e audio): longe da ISR do VSYNC do
      // painel RGB no nucleo 1. Prioridade 2 > main: a amostra sai no ritmo
      // do chip, e a task passa quase todo o tempo bloqueada no I2C
      BaseType_t ok = xTaskCreatePinnedToCoreWithCaps(pollTask, "gt911", 3072, this, 2, &_task, 0,
                                                      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
      if (ok != pdPASS) ok = xTaskCreatePinnedToCore(pollTask, "gt911", 3072, this, 2, &_task, 0);
      if (ok != pdPASS) _task = nullptr;   // segue sincrono (getTouchRaw faz o poll)
    }

    static constexpr uint32_t kIdleMs = 20;
    TaskHandle_t _task = nullptr;
    portMUX_TYPE _mux = portMUX_INITIALIZER_UNLOCKED;
    uint8_t _shared[5 * 8 + 2] = {};

    i2c_master_bus_handle_t _bus = nullptr;
    i2c_master_dev_handle_t _dev = nullptr;
    bool _inited = false;
    uint32_t _last_update = 0;
    uint32_t _refresh_rate = 5;
    char productId[4] = {'?', '?', '?', 0};
    uint8_t _readdata[5 * 8 + 2] = {};  // [0]=status; pontos a partir de _readdata[1]

    bool openBus(void)
    {
        i2c_master_bus_config_t bcfg = {};
        bcfg.i2c_port = _cfg.i2c_port;
        bcfg.sda_io_num = (gpio_num_t)_cfg.pin_sda;
        bcfg.scl_io_num = (gpio_num_t)_cfg.pin_scl;
        bcfg.clk_source = I2C_CLK_SRC_DEFAULT;
        bcfg.glitch_ignore_cnt = 7;
        bcfg.flags.enable_internal_pullup = true;
        if (i2c_new_master_bus(&bcfg, &_bus) != ESP_OK) {
            _bus = nullptr;
            return false;
        }

        i2c_device_config_t dcfg = {};
        dcfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
        dcfg.device_address = (uint16_t)_cfg.i2c_addr;
        uint32_t freq = _cfg.freq;
        if (freq == 0 || freq > 400000) freq = 400000;  // GT911: max 400 kHz
        dcfg.scl_speed_hz = freq;
        if (i2c_master_bus_add_device(_bus, &dcfg, &_dev) != ESP_OK) {
            closeBus();
            return false;
        }
        return true;
    }

    void closeBus(void)
    {
        if (_dev) { i2c_master_bus_rm_device(_dev); _dev = nullptr; }
        if (_bus) { i2c_del_master_bus(_bus); _bus = nullptr; }
    }

    void deinit(void)
    {
        closeBus();
        _inited = false;
    }

    bool writeBytes(const uint8_t* data, size_t len)
    {
        return i2c_master_transmit(_dev, data, len, 20) == ESP_OK;
    }

    bool writeRead(const uint8_t* w, size_t wl, uint8_t* r, size_t rl)
    {
        return i2c_master_transmit_receive(_dev, w, wl, r, rl, 20) == ESP_OK;
    }

    // Limpa a flag de dados (0x814E = 0)
    void flushStatus(void)
    {
        static constexpr uint8_t clr[3] = {0x81, 0x4E, 0x00};
        writeBytes(clr, 3);
    }

    // So considera dado com o bit7 pronto; so limpa quando leu pontos.
    bool updateData(void)
    {
        static constexpr uint8_t reg[2] = {0x81, 0x4E};
        uint8_t status = 0;
        if (!writeRead(reg, 2, &status, 1)) return false;

        if ((status & 0x80) == 0) return false;  // NAO limpa: nada pronto

        uint_fast8_t points = std::min<uint_fast8_t>(5, status & 0x0F);
        if (points > 0) {
            // pontos a partir de 0x814F, 8 bytes cada
            uint8_t preg[2] = {0x81, 0x4F};
            if (!writeRead(preg, 2, &_readdata[1], points * 8)) return false;
        }

        _readdata[0] = status;
        flushStatus();  // um unico clear, com os pontos ja lidos
        return true;
    }
};

//----------------------------------------------------------------------------
 }
}

#endif // CELEROS_TOUCH_GT911_IDF_H
