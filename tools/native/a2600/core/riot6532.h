#pragma once
// RIOT 6532 do Atari 2600: 128 B de RAM, timer de 8 bits e as duas portas de
// I/O (joystick/console switches). Sem o timer os jogos travam em loops de
// INTIM; sem as portas o SWCHA/SWCHB nunca respondem.
//
// Mapa no 2600 (dentro de addr < 0x1000):
//   A7=1, A9=0 -> RAM (0x0080-0x00FF e espelhos)
//   A7=1, A9=1 -> registradores do RIOT (0x0280-0x029F; aqui addr & 7)
// O bus chama readRam/writeRam para a RAM e read/write para os registradores.

#include "../../common/emu_compat.h"
#include "../../common/emu_state.h"

namespace emu {
namespace a2600 {

class Riot6532
{
public:
    void reset();

    // dirs: bits pressionados (1 = pressionado) nas direcoes
    // up=1,down=2,left=4,right=8 do jogador 0 (ativo baixo no SWCHA).
    // switches: bit0 select, bit1 reset, bit2 color, bit3 diff A P0, bit4 diff A P1.
    void setInputs(uint8_t dirs, uint8_t switches);

    uint8_t readRam(uint16_t off) const { return ram_[off & 0x7F]; }
    void writeRam(uint16_t off, uint8_t v) { ram_[off & 0x7F] = v; }

    uint8_t read(uint16_t addr);   // addr & 7
    void write(uint16_t addr, uint8_t v);
    void tick();                   // 1 ciclo de CPU

    void save(emu::StateWriter& w) const;
    bool load(emu::StateReader& r);

private:
    uint8_t ram_[128] = {0};
    uint8_t portA_ = 0, ddrA_ = 0, portB_ = 0, ddrB_ = 0;
    uint8_t inputA_ = 0xFF, inputB_ = 0xFF;
    uint8_t timer_ = 0;
    uint8_t timint_ = 0;
    int presc_ = 0;
    bool irq_ = false;
};

}  // namespace a2600
}  // namespace emu
