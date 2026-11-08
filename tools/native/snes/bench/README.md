# Golden do core SNES (bancada, fora do CI)

O core em `../core` e o LakeSnes com mudancas de desempenho. Cada mudanca
tem que dar o MESMO quadro (video RGB565 do main screen) e o MESMO PCM que o
LakeSnes original, quadro a quadro. Precisa de ROMs reais (nao vao para o
repo) — o CI roda so `test/cpp/snes_test.cpp` com ROM sintetica.

```bash
B=/tmp/snesgold && mkdir -p $B && cd $B
git clone https://github.com/angelo-wf/LakeSnes && cd LakeSnes
git checkout $(cut -d' ' -f1 <REPO>/tools/native/snes/core/UPSTREAM)
python3 <REPO>/tools/native/snes/bench/patch_upstream_apu.py snes
cd $B && gcc -O2 -ILakeSnes/snes -o golden <REPO>/tools/native/snes/bench/golden.c LakeSnes/snes/*.c -lm
./golden ROM.sfc 3600 rom.txt [pasta_ppm] [intervalo]   # CRC por quadro

R=<REPO>/tools/native/snes
g++ -std=c++17 -O2 -I$R -I$R/core -o compare $R/bench/compare.cpp
./compare ROM.sfc 3600 rom.txt [pasta_do_1o_quadro_ruim]   # exit 0 = identico
SNES_NODEFER=1 ./compare ...   # sem a renderizacao adiada
```

O roteiro de botoes (`script()` em golden.c e compare.cpp, iguais) entra no
Super Mario Bros. do Mario All-Stars e anda pela fase (quadros 150-1600:
menus; 1600+: direita + pulo + corrida). ROMs de teste usadas em 2026-11:
o Mario All-Stars + SMW (2,5 MB) e as demos/testes de PPU/CPU/SPC do
repositorio PeterLemon/SNES (67 ROMs, 240 quadros cada).
