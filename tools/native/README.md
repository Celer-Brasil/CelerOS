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
│   ├── emu_audio.h    # decimador box-average -> PCM16 44,1 kHz
│   └── cpu6502_cycle.# CPU 6502/6507 cycle-stepped (decimal + ilegais)
├── nes/               # Anemoia (NES, GPLv3) — app Anemoia
├── a2600/             # Atari 2600 — app "Atari 2600"
│   ├── core/          # cpu reaproveitado de common, tia, riot6532, cart
│   ├── a2600.h/.cpp   # fachada: barramento, frame, save/load
│   ├── A2600Core.cpp  # TU unico (host g++ e blob)
│   └── A2600Blob.cpp  # fonte do blob: runtime + core + core_ctl
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

### Extensoes do Atari 2600

| cmd | nome | arg |
|----:|------|-----|
| 20 | SET_SWITCHES | bit2 cor, bit3 dificuldade A do P0, bit4 do P1 |
| 21 | SET_PADDLE | `paddle0 \| paddle1 << 8` |
| 22 | MAPPER | >= 0 define o override do proximo LOAD; -1 le o atual |

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
