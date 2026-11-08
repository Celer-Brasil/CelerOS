#include "I2cBus.h"

#include "esp_log.h"

#include "../Boards/Board.h"

// ============================================================================
// Implementacao do bus I2C generico (ver I2cBus.h).
// ============================================================================

namespace {

constexpr int kMaxDev = 8;
constexpr int kTimeoutMs = 50;
constexpr size_t kMaxXfer = 128;

i2c_master_bus_handle_t s_bus = nullptr;
bool s_ownsBus = false;
I2cBus::Info s_info;

struct Dev {
    uint8_t addr = 0;
    i2c_master_dev_handle_t handle = nullptr;
    uint32_t used = 0;  // carimbo LRU (maior = mais recente)
};
Dev s_devs[kMaxDev];
int s_devCount = 0;
uint32_t s_useTick = 0;  // relogio LRU monotonico

bool busExists(int port, i2c_master_bus_handle_t* out) {
    i2c_master_bus_handle_t h = nullptr;
    if (i2c_master_get_bus_handle((i2c_port_num_t)port, &h) != ESP_OK || h == nullptr) {
        *out = nullptr;
        return false;
    }
    *out = h;
    return true;
}

i2c_master_dev_handle_t devFor(uint8_t addr) {
    if (s_bus == nullptr) return nullptr;
    s_useTick++;
    for (int i = 0; i < s_devCount; i++) {
        if (s_devs[i].addr == addr) {
            s_devs[i].used = s_useTick;
            return s_devs[i].handle;
        }
    }
    int slot = s_devCount;
    if (s_devCount >= kMaxDev) {
        // Cache cheio: expulsa o device MENOS RECENTEMENTE usado em vez de
        // falhar para sempre (antes o 9o endereco morria ate o end()). Seguro:
        // as transferencias sao sincronas e vem so da task do runtime JS —
        // entre duas chamadas nao ha transacao em voo no handle expulso.
        slot = 0;
        for (int i = 1; i < s_devCount; i++) {
            if (s_devs[i].used < s_devs[slot].used) slot = i;
        }
        ESP_LOGI("celer.i2c", "cache cheio: expulsa 0x%02X pelo 0x%02X (LRU)",
                 (unsigned)s_devs[slot].addr, (unsigned)addr);
        i2c_master_bus_rm_device(s_devs[slot].handle);
        s_devs[slot].handle = nullptr;
    }
    i2c_device_config_t dcfg = {};
    dcfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    dcfg.device_address = addr;
    dcfg.scl_speed_hz = s_info.hz;
    i2c_master_dev_handle_t h = nullptr;
    if (i2c_master_bus_add_device(s_bus, &dcfg, &h) != ESP_OK || h == nullptr) {
        ESP_LOGW("celer.i2c", "nao consegui adicionar o device 0x%02X", (unsigned)addr);
        if (slot < s_devCount) {
            // expulso sem substituto: o ultimo toma o vao (array fica denso)
            s_devs[slot] = s_devs[s_devCount - 1];
            s_devs[s_devCount - 1] = Dev{};
            s_devCount--;
        }
        return nullptr;
    }
    s_devs[slot].addr = addr;
    s_devs[slot].handle = h;
    s_devs[slot].used = s_useTick;
    if (slot == s_devCount) s_devCount++;
    return h;
}

}  // namespace

namespace I2cBus {

bool beginBoard(Info* out) {
    const I2cPins& bp = Board::profile().i2c;
    if (bp.sda < 0 || bp.scl < 0) return false;
    return begin(bp.sda, bp.scl, bp.hz, out);
}

bool begin(int sda, int scl, uint32_t hz, Info* out) {
    if (sda < 0 || scl < 0 || sda == scl) return false;
    if (hz == 0) hz = 400000;
    if (hz < 10000) hz = 10000;
    if (hz > 1000000) hz = 1000000;

    // Ja aberto: so reusa nos MESMOS pinos. Trocar de pinos exige end() —
    // o binding avisa o app em vez de deixar dois buses disputando o GPIO.
    if (s_bus != nullptr) {
        if (s_info.sda == sda && s_info.scl == scl) {
            if (out) *out = s_info;
            return true;
        }
        return false;
    }

    const BoardProfile& profile = Board::profile();
    const bool boardPair = (sda == profile.i2c.sda && scl == profile.i2c.scl);

    // Bus de placa movido por driver PROPRIO (LGFX do cao escreve os
    // registradores do OLED; i2c_master nunca abre handle la): nao ha o que
    // adotar e criar OUTRO master na mesma porta derruba os dois lados (o
    // LGFX limpa os int_raw que o driver novo espera a cada STOP). Recusa o
    // par da placa inteiro — a outra porta com esses pinos roubaria o GPIO.
    if (boardPair && profile.i2c.rawDriver) return false;

    // Portas candidatas: a do perfil (quando sao os pinos dela) e a outra.
    int candidates[2] = {-1, -1};
    int n = 0;
    if (boardPair) candidates[n++] = (profile.i2c.port >= 0 ? profile.i2c.port : 0);
    for (int p = 0; p < 2; p++) {
        bool dup = false;
        for (int i = 0; i < n; i++) if (candidates[i] == p) dup = true;
        if (!dup) candidates[n++] = p;
    }

    for (int i = 0; i < n; i++) {
        const int port = candidates[i];
        // Porta de placa com driver proprio: nunca criamos nem adotamos aqui,
        // mesmo com pinos diferentes (o controlador inteiro e do OLED).
        if (profile.i2c.rawDriver && port == profile.i2c.port) continue;
        i2c_master_bus_handle_t existing = nullptr;
        const bool exists = busExists(port, &existing);
        // Bus ja aberto com OUTROS pinos: nao ha como conferir os pinos pelo
        // handle do IDF, entao nao adota (o touch/OLED manda nele).
        if (exists && !(boardPair && port == profile.i2c.port)) continue;

        if (exists) {
            s_bus = existing;
            s_ownsBus = false;
            ESP_LOGI("celer.i2c", "adotou o bus I2C%d da placa (sda %d, scl %d)",
                     port, sda, scl);
        } else {
            i2c_master_bus_config_t bcfg = {};
            bcfg.i2c_port = (i2c_port_num_t)port;
            bcfg.sda_io_num = (gpio_num_t)sda;
            bcfg.scl_io_num = (gpio_num_t)scl;
            bcfg.clk_source = I2C_CLK_SRC_DEFAULT;
            bcfg.glitch_ignore_cnt = 7;
            bcfg.flags.enable_internal_pullup = true;
            i2c_master_bus_handle_t bus = nullptr;
            if (i2c_new_master_bus(&bcfg, &bus) != ESP_OK || bus == nullptr) {
                ESP_LOGW("celer.i2c", "i2c_new_master_bus falhou (porta %d)", port);
                continue;
            }
            s_bus = bus;
            s_ownsBus = true;
            ESP_LOGI("celer.i2c", "abriu I2C%d (sda %d, scl %d, %lu Hz)",
                     port, sda, scl, (unsigned long)hz);
        }

        s_info.port = port;
        s_info.sda = sda;
        s_info.scl = scl;
        s_info.hz = hz;
        s_devCount = 0;
        if (out) *out = s_info;
        return true;
    }
    return false;
}

void end() {
    for (int i = 0; i < s_devCount; i++) {
        if (s_devs[i].handle) i2c_master_bus_rm_device(s_devs[i].handle);
        s_devs[i].handle = nullptr;
    }
    s_devCount = 0;
    if (s_ownsBus && s_bus) {
        i2c_del_master_bus(s_bus);
        ESP_LOGI("celer.i2c", "fechou o bus I2C%d do app", s_info.port);
    }
    s_bus = nullptr;
    s_ownsBus = false;
    s_info = Info{};
}

bool active() { return s_bus != nullptr; }

const Info& info() { return s_info; }

bool probe(uint8_t addr) {
    if (s_bus == nullptr) return false;
    return i2c_master_probe(s_bus, addr, 20) == ESP_OK;
}

bool write(uint8_t addr, const uint8_t* data, size_t n) {
    if (n == 0 || n > kMaxXfer) return false;
    i2c_master_dev_handle_t dev = devFor(addr);
    if (dev == nullptr) return false;
    return i2c_master_transmit(dev, data, n, kTimeoutMs) == ESP_OK;
}

bool read(uint8_t addr, uint8_t* data, size_t n) {
    if (n == 0 || n > kMaxXfer) return false;
    i2c_master_dev_handle_t dev = devFor(addr);
    if (dev == nullptr) return false;
    return i2c_master_receive(dev, data, n, kTimeoutMs) == ESP_OK;
}

bool writeReg(uint8_t addr, uint8_t reg, const uint8_t* data, size_t n) {
    if (n > kMaxXfer) return false;
    uint8_t buf[kMaxXfer + 1];
    buf[0] = reg;
    for (size_t i = 0; i < n; i++) buf[i + 1] = data[i];
    return write(addr, buf, n + 1);
}

bool readReg(uint8_t addr, uint8_t reg, uint8_t* data, size_t n) {
    if (n == 0 || n > kMaxXfer) return false;
    i2c_master_dev_handle_t dev = devFor(addr);
    if (dev == nullptr) return false;
    return i2c_master_transmit_receive(dev, &reg, 1, data, n, kTimeoutMs) == ESP_OK;
}

}  // namespace I2cBus
