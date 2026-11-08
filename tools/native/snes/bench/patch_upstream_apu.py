#!/usr/bin/env python3
"""Referencia do golden: troca o relogio double da APU do LakeSnes ORIGINAL
por inteiro exato (int64, mesma conta do core do CelerOS). Uso:

    python3 patch_upstream_apu.py <LakeSnes>/snes

O golden do LakeSnes float e o do inteiro deram identicos (video e audio)
em 3600 quadros do Mario All-Stars; o inteiro e a referencia porque o
core do CelerOS nao tem double. Cuidado: o acumulador PRECISA ser com
sinal — apu_runCycles executa opcodes inteiros e passa do pedido; com
uint64 o "negativo" enrola e o quadro seguinte roda bilhoes de ciclos.
"""
import sys

d = sys.argv[1]
s = open(d + '/snes.c').read()
s = s.replace("""static const double apuCyclesPerMaster = (32040 * 32) / (1364 * 262 * 60.0);
static const double apuCyclesPerMasterPal = (32040 * 32) / (1364 * 312 * 50.0);""",
"""#define APU_NUM 1025280ll /* 32040 * 32 */
#define APU_DEN_NTSC 21442080ll /* 1364 * 262 * 60 */
#define APU_DEN_PAL 21278400ll /* 1364 * 312 * 50 */""")
s = s.replace("snes->apuCatchupCycles = 0.0;", "snes->apuAcc = 0;")
s = s.replace("sh_handleDoubles(sh, &snes->apuCatchupCycles, NULL);",
              "sh_handleLongLongs(sh, (uint64_t*) &snes->apuAcc, NULL);")
s = s.replace("  snes->apuCatchupCycles += (snes->palTiming ? apuCyclesPerMasterPal : apuCyclesPerMaster) * 2.0;\n",
              "  snes->apuAcc += 2 * APU_NUM;\n")
s = s.replace("""  int catchupCycles = (int) snes->apuCatchupCycles;
  int ranCycles = apu_runCycles(snes->apu, catchupCycles);
  snes->apuCatchupCycles -= (double) ranCycles;""", """  int64_t den = snes->palTiming ? APU_DEN_PAL : APU_DEN_NTSC;
  int catchupCycles = (int) (snes->apuAcc / den);
  int ranCycles = apu_runCycles(snes->apu, catchupCycles);
  snes->apuAcc -= (int64_t) ranCycles * den;""")
open(d + '/snes.c', 'w').write(s)
h = open(d + '/snes.h').read()
h = h.replace("  double apuCatchupCycles;", "  int64_t apuAcc;")
open(d + '/snes.h', 'w').write(h)
print("ok:", d)
