// TU unico do nucleo do Atari 2600.
//
// O gate g++ do host e o blob CLRN compilam ESTE arquivo (nunca os .cpp do
// core separadamente: haveria simbolos duplicados). O blob inclui este TU e
// define core_ctl; o teste host inclui os headers e linka este objeto.

#include "../common/cpu6502_cycle.cpp"
#include "core/tia.cpp"
#include "core/cart_a2600.cpp"
#include "core/riot6532.cpp"
#include "a2600.cpp"
