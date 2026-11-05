// TU unico do nucleo Anemoia: o gate do host (g++ do test/cpp) e o CMake do
// device incluem so este arquivo, em vez de listar 13 .cpp do nucleo. Os .cpp
// do nucleo sao independentes (estaticos sao file-local, membros static tem
// definicao unica), entao o unity build e seguro — e o device nao paga nada
// em runtime por isso.
#include "core/cpu6502.cpp"
#include "core/apu2A03.cpp"
#include "core/bus.cpp"
#include "core/ppu2C02.cpp"
#include "core/cartridge.cpp"
#include "core/mappers/mapper000.cpp"
#include "core/mappers/mapper001.cpp"
#include "core/mappers/mapper002.cpp"
#include "core/mappers/mapper003.cpp"
#include "core/mappers/mapper004.cpp"
#include "core/mappers/mapper069.cpp"
