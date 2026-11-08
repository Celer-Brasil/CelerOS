# Cores de emulador nativos (blobs CLRN)

Emulador no CelerOS **nao entra no firmware**: o nucleo do console compila como
blob CLRN (`tools/native/build_core.py`) e viaja no pacote do app; o JS fala
com ele por `System.native*` (API 58) e desenha por `nativeDraw` (ou
`nativeScreen` na API 60). Corrigir um core = publicar um app, nao um OTA.

```
tools/native/
├── common/            # infra compartilhada (codigo CelerOS, sem GPL de terceiros)
│   ├── emu_compat.h   # freestanding: log, alloc, CRC32, rd/wr LE
│   ├── emu_core.h     # ABI canonica core_ctl (0-19) + frame arg
│   ├── emu_state.h    # save state versionado (CEMU: header + secoes tag/len)
│   ├── emu_video.h    # RGB565 swap + Scaler nearest por runs
│   ├── emu_audio.h    # box-average -> PCM16 44,1 kHz (decima ou repete)
│   ├── emu_screen.h   # FRAME_SCREEN: escala + carimbos direto no vidro
│   └── cpu6502_cycle.# CPU 6502/6507 cycle-stepped, barramento em template
├── nes/               # Anemoia (NES, GPLv3) — app Anemoia
├── a2600/             # Atari 2600 — app "Atari 2600"
│   ├── core/          # cpu reaproveitado de common, tia, riot6532, cart
│   ├── a2600.h/.cpp   # fachada: barramento, frame, save/load
│   ├── A2600Core.cpp  # TU unico (host g++ e blob)
│   └── A2600Blob.cpp  # fonte do blob: runtime + core + core_ctl
├── snes/              # SNES (LakeSnes, MIT) — app "SNES"
│   ├── core/          # LakeSnes + mudancas do CelerOS (ver UPSTREAM/LICENSE)
│   ├── bench/         # golden contra o LakeSnes original (bancada, nao CI)
│   ├── SnesCore.cpp   # TU unico (os .c compilam como C++)
│   └── SnesBlob.cpp   # fonte do blob: layout da scratch + core_ctl
└── runtime.c          # mem*/malloc de arena + CLRN_FAST (blobs)
```

## ABI (`emu_core.h`)

`uint32_t core_ctl(void* scratch, int32_t cmd, int32_t arg)` — unica entrada do
blob. Comandos canonicos (iguais no NES e no 2600):

| cmd | nome | arg | retorno |
|----:|------|-----|---------|
| 0 | INIT | tamanho da scratch em KB | capacidade de ROM em bytes |
| 1..5 | ROM_OFF/PCM_OFF/FB_OFF/STATE_OFF/STATE_SIZE | — | offset/capacidade |
| 6 | LOAD | bytes copiados em ROM_OFF | 1/0 |
| 7 | RESET | — | 1 |
| 8 | FRAME | `buttons \| render << 8` | 1 |
| 9 | SAVE_STATE | — | bytes escritos (0 = falhou) |
| 10 | LOAD_STATE | bytes validos | 1/0 |
| 11 | PCM_LEN | — | bytes de PCM do ultimo FRAME |
| 12 | SET_SCALE | `dstW << 16 \| dstH` | offset do buffer escalado |
| 13 | SET_AUDIO | != 0 liga o PCM | 1 |
| 14 | PERF | 0 emulacao / 1 escala | ciclos |
| 15 | FRAME_SCREEN | `NativeScreen*` | `0xFFFFFFFF` = sem composicao direta |
| 16..19 | GRAB_OFF/STAMP_* | carimbos do overlay | 0 quando nao suporta |
| 20+ | extensoes do console | livre | livre |

O app nunca hardcoda offsets: INIT/ROM_OFF/... devolvem o layout da scratch.
O core nao chama o JS, nao aloca task e roda **um quadro por chamada** (o
watchdog nao ve o codigo nativo).

### Atari 2600: desempenho e video

Bancada 4848 (Pitfall!, audio ligado): emulacao 73 ms -> 10 ms por quadro e
video ~63 ms -> ~1 ms; o jogo roda a 60 fps (o relogio do Pitfall anda 1 s
por segundo). O que pesava, em ordem:

- **Barramento por ciclo.** A CPU e cycle-stepped, mas TIA/RIOT nao precisam
  andar a cada ciclo: o barramento (`A2600::Bus`, inline via `stepT<B>`) so
  sincroniza a TIA/o RIOT quando o jogo acessa um registrador deles
  (`advance(n)`), e o WSYNC vira ciclos somados na escrita. Mesmo quadro e
  mesma contagem de ciclos do modelo ciclo a ciclo.
- **Desenho preguicoso por trechos.** A TIA pinta o trecho ainda nao
  desenhado antes de cada escrita/leitura de colisao; objetos sao um byte por
  pixel remontado so quando o grafico VISIVEL muda (GRP=0 e HMOVE com 0 em
  toda linha nao custam nada); fundo/playfield puros saem de 4 em 4 pixels.
- **Video direto (FRAME_SCREEN).** A linha da TIA (RAM interna) vai para o
  compositor (`common/emu_screen.h`), que escala e compoe os carimbos do
  overlay no vidro inteiro e so reescreve as linhas que mudaram. O caminho
  FRAME + SET_SCALE + nativeDraw continua como fallback (sem frameskip
  automatico no direto: jogos do 2600 piscam sprites em quadros alternados).

### Extensoes do Atari 2600

| cmd | nome | arg |
|----:|------|-----|
| 20 | SET_SWITCHES | bit2 cor, bit3 dificuldade A do P0, bit4 do P1 |
| 21 | SET_PADDLE | `paddle0 \| paddle1 << 8` |
| 22 | MAPPER | >= 0 define o override do proximo LOAD; -1 le o atual |

### SNES: o que mudou no LakeSnes e por que

Base: LakeSnes (angelo-wf, MIT; commit em `snes/core/UPSTREAM`). Toda
mudanca abaixo foi conferida quadro a quadro (video e audio) contra o
LakeSnes original em ROMs reais (golden, `snes/bench/README.md`): 68 ROMs,
3600 quadros de jogatina do Mario All-Stars, 0 diferencas.

| Mudanca | Por que |
|---|---|
| Renderizador de linha (`core/ppu_render.c`): camadas decodificadas por sliver de 8 px (planar->chunky por tabela) num z-buffer de rank main/sub; Mode 7 e hires com laco proprio; composicao com cache de cores e color math empacotado (3 canais numa conta) | o original avaliava cada camada e a janela POR PIXEL (75% do host) |
| Renderizacao ADIADA: no ponto da linha so a foto dos registradores (172 B); as linhas saem em lote antes de escrita em VRAM/CGRAM/OAM, da leitura de $213E e no vblank | mesma saida linha a linha; codigo e VRAM da PPU ficam quentes |
| Escalonador por eventos + atalho (`nextEv`): so passos com evento rodam `snes_runCycle`; APU e auto-joypad creditados sob demanda | o original rodava 180 mil passos de 2 ciclos por quadro |
| Relogio da APU inteiro (`apuOwed` + `apuFrac`, sem 64 bits) | o S3 nao tem FPU double e o blob nao linka `__divdi3`; identico ao double |
| Mapa da CPU por pagina de 8 KB (ponteiro de leitura/escrita + tempo) e barramento direto CPU/SPC (sem ponteiro de funcao) | cada acesso decodificava banco/endereco |
| Timers do SPC preguicosos (andam no acesso a $F1/$FA-$FF) | 3 decrementos por ciclo de SPC |
| ROM externa sem copia nem expansao (espelho por tabela de 32 KB) | 2,5 MB do Mario custavam 4 MB |
| Save state direto num buffer fixo (`snes_saveStateTo`) | o StateHandler crescia por realloc |

**UMA instancia por vez**: o mapa de paginas e as linhas de trabalho sao
estaticos (o blob roda um console so).

Layout da scratch e extensoes (20 SRAM_OFF, 21 SRAM_SIZE, 22 INFO, 23
PERF_PART, 24 STAMP_USED, 25 SRAM_SUM, 26 DIAG): topo de `SnesBlob.cpp`.
Botoes: 12 bits na ordem do controle; os 8 baixos em `arg & 0xFF` e os 4
altos (A X L R) em `arg >> 16` (casca `celeros.emu` 0.4.0).

**Bancada 4848 (2026-11-07, firmware API 62, Mario All-Stars)**: 4,5 fps
(LakeSnes como veio) -> ~14 fps desenhados com frameskip 1:2 (~28% da
velocidade). Media por quadro na jogatina: CPU+barramento ~20 ms, APU ~11
ms, PPU ~60 ms por quadro DESENHADO. O que a bancada mostrou:
- a regiao CLRN_FAST cai na PSRAM: com WiFi+BLE o 4848 tem ~28 KB de RAM
  interna livre (maior bloco ~7 KB);
- escrever na PSRAM com o dado em cache custa o mesmo que na pilha interna
  (medido: 2,3 ciclos/palavra nos dois); linhas de trabalho na pilha nao
  ganharam nada e ~9 KB a mais na pilha da task main derrubavam o aparelho;
- leitura espalhada da VRAM: ~160 ciclos por falta de cache;
- o custo dominante e de INSTRUCAO: CPI ~2,5-3 mesmo em laco quente (codigo
  e dados vem da PSRAM pelo barramento que o DMA do painel RGB usa ~19 MB/s
  o tempo todo). Uma linha da PPU custa ~50 mil ciclos com cache quente.
- PSRAM: o Mario (2,5 MB) pede ~3,26 MB de scratch; com a casca aberta o
  maior bloco e ~3,4 MB (a imagem do blob sai dele antes). Firmware antes da
  API 62 cortava a scratch em 2560 KB.

Metodo: app de bancada numa pasta de `/sd/apps` (o `/local` enche) chamando
FRAME_SCREEN em laco e lendo PERF/PERF_PART/DIAG, log por
`FS.appendTextFile` no SD, `S.delay(1)` por quadro.

## Formatos

- **Video**: RGB565 com bytes TROCADOS (swap565), o formato de `nativeDraw`/
  `nativeScreen`/`FrameSprite`. O core preenche o FB nativo; SET_SCALE produz
  um segundo buffer no tamanho do retangulo pedido (nearest por runs).
- **Audio**: PCM16 mono LE a 44,1 kHz. `PCM_LEN` diz quantos bytes o ultimo
  FRAME gerou; o app drena com `nativeAudio`.
- **Save state**: container `CEMU` (`emu_state.h`): magic, versao, console,
  CRC32 da ROM, tamanho/CRC do payload e secoes `tag/len`. O reader recusa
  outro console/ROM e detecta truncamento; secoes desconhecidas sao puladas.

## Build e teste

```bash
# blob do app (toolchain Xtensa do IDF; gera header CLRN v2)
# ATENCAO: --src e --include sao resolvidos a partir da PASTA do app, nao do
# repo — passe caminhos ABSOLUTOS (ou relativos a pasta do app).
node tools/sdk/celer.js native "hub_apps/Atari 2600" \
  --src "$PWD/tools/native/a2600/A2600Blob.cpp" \
  --out "$PWD/hub_apps/Atari 2600/a2600_core.bin" \
  --include "$PWD/tools/native/common" --include "$PWD/tools/native/a2600" --include "$PWD/tools/native/a2600/core"

# teste host do core (mesmo TU do blob; sem Xtensa)
g++ -std=c++17 -Wall -Wextra -DCELER_HOST_TEST \
  -Itools/native/common -Itools/native/a2600 -Itools/native/a2600/core \
  -o a2600_test test/cpp/a2600_test.cpp tools/native/a2600/A2600Core.cpp
./a2600_test
```

Regras do blob (validadas pelo builder): freestanding (sem libc/RTOS/IO),
`-mno-longcalls` (texto <= ~256 KB), sem `.sdata/.sbss` (`-G0`), apenas
relocacoes `R_XTENSA_32`, entradas `core_*` em ordem de endereco (max. 8) e
512 KB por blob. O estado quente vai de `CLRN_FAST` (RAM interna quando o
loader tem folga); os buffers grandes ficam na scratch (PSRAM).

## Como adicionar um console

1. Crie `tools/native/<console>/` com `core/` (chips), a fachada, um
   `*Core.cpp` (TU unico) e um `*Blob.cpp` (`core_ctl` + layout da scratch).
2. Reuse o que der de `common/` (CPU, state, video, audio) e o padrao do
   `A2600Blob.cpp` (placement-new no `.bss`, offsets devolvidos, SET_SCALE).
3. Escreva o teste host em `test/cpp/<console>_test.cpp` (chips + ROM
   sintetica original + save/load) e adicione a linha no CI/AGENTS.
4. No app: `app.json` com `requires:["psram","native"]` e a dep
   `celeros.emu`; o `main.js` vira um adapter de bits/geometria/extensoes e o
   `test.js` modela o `core_ctl` para o harness/emulador.
5. Publique a dep e o app (`celerhub.py publish-dep`, `celer.js publish`).

Nao ha Kconfig/CMake/ledger por emulador: o core nao esta no firmware. Se o
console exigir algo novo do loader (taxa de audio, formato de pixel), suba a
API **uma vez** em `emu_core.h` + firmware, nao por console.
