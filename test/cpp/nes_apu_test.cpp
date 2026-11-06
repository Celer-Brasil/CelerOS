// Equivalencia da APU do core NES em lote (tools/native/nes): clockN(n) tem
// de gerar o MESMO PCM, byte a byte, que n chamadas de clock(). O blob do
// Anemoia so roda a APU em lote (Cpu6502::apuSync); um desvio aqui vira
// som errado no aparelho, sem crash nem log.
//
// g++ -std=c++17 -Wall -Wextra -DCELER_HOST_TEST -Itools/native/nes
//     -Itools/native/nes/core -o nes_apu_test test/cpp/nes_apu_test.cpp
//     tools/native/nes/core/apu2A03.cpp && ./nes_apu_test
#include "core/apu2A03.h"
#include "core/bus.h"
#include <cstdio>
#include <cstdlib>
#include <vector>

// a APU so le memoria pelo DMC (canal fora deste teste)
uint8_t Bus::cpuRead(uint16_t) { return 0; }

namespace {

std::vector<uint8_t> g_out;
void sink(const uint8_t* d, uint32_t n) { g_out.insert(g_out.end(), d, d + n); }

// O buffer de audio da APU e static: as duas rodadas sao SEQUENCIAIS com a
// mesma semente (escritas de registrador e tamanhos de lote identicos).
std::vector<uint8_t> run(bool batch, const std::vector<uint16_t>& regs)
{
    g_out.clear();
    Apu2A03* apu = new Apu2A03();
    apu->setAudioSink(sink);
    srand(1234);
    for (int step = 0; step < 20000; step++) {
        if (rand() % 3 == 0) {
            uint16_t r = regs[rand() % regs.size()];
            uint8_t v = rand() & 0xFF;
            if (r == 0x4015) v &= 0x0F;  // DMC desligado
            apu->cpuWrite(r, v);
        }
        int n = rand() % 400;
        if (batch) apu->clockN(n);
        else for (int i = 0; i < n; i++) apu->clock();
    }
    delete apu;
    return g_out;
}

}  // namespace

int main()
{
    const std::vector<std::vector<uint16_t>> sets = {
        {0x4000, 0x4001, 0x4002, 0x4003, 0x4015},           // pulso 1 + sweep
        {0x4008, 0x400A, 0x400B, 0x4015},                   // triangulo
        {0x400C, 0x400E, 0x400F, 0x4015},                   // ruido
        {0x4000, 0x4002, 0x4003, 0x4015, 0x4017},           // frame counter 4/5 passos
        {0x4000, 0x4001, 0x4002, 0x4003, 0x4004, 0x4005, 0x4006, 0x4007,
         0x4008, 0x400A, 0x400B, 0x400C, 0x400E, 0x400F, 0x4015, 0x4017},
    };
    int fails = 0;
    for (size_t k = 0; k < sets.size(); k++) {
        const std::vector<uint8_t> a = run(false, sets[k]), b = run(true, sets[k]);
        if (a != b || a.empty()) {
            size_t i = 0;
            while (i < a.size() && i < b.size() && a[i] == b[i]) i++;
            printf("FALHA conjunto %zu: PCM diverge no byte %zu (%zu x %zu)\n", k, i, a.size(), b.size());
            fails++;
        }
    }
    if (fails) return 1;
    printf("OK: APU em lote == tick a tick (%zu conjuntos de registradores)\n", sets.size());
    return 0;
}
