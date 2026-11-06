#pragma once
// RIOT 6532 do Atari 2600: 128 B de RAM, timer de 8 bits e as duas portas de
// I/O (joystick/console switches). Sem o timer os jogos travam em loops de
// INTIM; sem as portas o SWCHA/SWCHB nunca respondem.
//
// Mapa no 2600 (dentro de addr < 0x1000):
//   A7=1, A9=0 -> RAM (0x0080-0x00FF e espelhos)
//   A7=1, A9=1 -> registradores do RIOT (0x0280-0x029F)
// O bus chama readRam/writeRam para a RAM e read/write para os registradores.
//
// Decode dos registradores (A2 separa portas de timer):
//   A2=0: SWCHA/SWACNT/SWCHB/SWBCNT por A1-A0 (leitura e escrita)
//   A2=1, leitura: A0=0 INTIM, A0=1 TIMINT (D7 = estouro do timer)
//   A2=1, escrita com A4=1: TIM1T/TIM8T/TIM64T/T1024T (0x294-0x297): A1-A0
//   escolhem o divisor 1/8/64/1024 e o valor carrega o timer. Depois do
//   estouro (0 -> 0xFF) o timer conta a cada ciclo ate a proxima carga.

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

    uint8_t read(uint16_t addr);
    void write(uint16_t addr, uint8_t v);
    void tick() { advance(1); }
    // `n` ciclos de CPU de uma vez (o barramento sincroniza o RIOT so quando
    // o jogo acessa um registrador dele)
    void advance(uint32_t n)
    {
        while (n > 0) {
            if ((uint32_t)presc_ > n) {
                presc_ -= (int)n;
                return;
            }
            n -= (uint32_t)presc_;
            if (timer_ == 0) {
                timer_ = 0xFF;
                irq_ = true;
                interval_ = 1;  // depois do estouro conta a cada ciclo
            } else {
                timer_--;
            }
            presc_ = interval_;
            if (interval_ == 1 && n > 0) {
                // 1 por ciclo: o resto sai de uma vez (estouro so liga o flag)
                if (n > timer_) irq_ = true;
                timer_ = (uint8_t)(timer_ - n);
                return;
            }
        }
    }

    void save(emu::StateWriter& w) const;
    bool load(emu::StateReader& r);

    // diagnostico: quantas leituras por registrador (SWCHA=0, SWCHB=2)
    uint32_t dbgReads(int reg) const { return dbg_reads_[reg & 7]; }

private:
    uint32_t dbg_reads_[8] = {0};
    uint8_t ram_[128] = {0};
    uint8_t portA_ = 0, ddrA_ = 0, portB_ = 0, ddrB_ = 0;
    uint8_t inputA_ = 0xFF, inputB_ = 0xFF;
    uint8_t timer_ = 0;
    int interval_ = 1024;  // ciclos por decremento (1 depois do estouro)
    int presc_ = 1024;     // ciclos ate o proximo decremento
    bool irq_ = false;
};

}  // namespace a2600
}  // namespace emu
