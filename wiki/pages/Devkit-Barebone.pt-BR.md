# Devkit barebone (sem display)

[English](/Celer-Brasil/CelerOS/wiki/Barebone-Devkit) | **Português (BR)**

O CelerOS roda num devkit ESP32 comum **sem display nenhum**: a "tela" é o
LED on-board, o "toque" é o botão BOOT, e o console/celerctl fica na UART.
O OS inteiro boota igual nas outras placas — o launcher só fica
*invisível* (o display é um painel stub que descarta o desenho) — e os
apps JS rodam headless: timers, Storage, Net, FS, GPIO e notificações
funcionam sem desenhar nada.

Compile com:

```bash
idf.py -B build-devkit \
  -DSDKCONFIG=build-devkit/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/devkit/sdkconfig.defaults" \
  -DCELEROS_BOARD=devkit set-target esp32
idf.py -B build-devkit build flash -p /dev/ttyUSB0 monitor
```

## Presunções de hardware

| Sinal | GPIO | Observações |
|---|---|---|
| LED de status | **GPIO2** | LED de canal único (azul do DOIT DevKit v1), acende em nível alto, PWM via `System.led`. LED em outro pino: edite `main/Boards/devkit/Board.cpp` |
| Botão BOOT | **GPIO0** | Ativo-baixo com pull-up. Input dos apps via `System.button()` (API 17) — ver abaixo |
| Console UART0 | GPIO1/3 | `celerctl` + logs (CH340 ou ponte USB-UART). Negado à API GPIO do JS (`gpioDeniedMask`) |
| SD / alto-falante / bateria | — | Nada no perfil; os GPIOs livres ficam para `System.gpio` |

Sem touch, sem calibração, sem backlight: o perfil usa
`capacitiveTouch = true` e não tem hooks de tela, então `ScreenPower` e
`Backlight` viram no-op. O orçamento de flash é o da CYD (4MB, slots OTA
de 1,56MB); updates OTA vêm do canal `updates/devkit/`.

## O modelo de interação headless

* **Botão como input do app** — o perfil usa `buttonToApp`, então o BOOT
  deixa de ser "home" dentro de um app: toques curtos aparecem em
  `System.button()` (`0` nada, `1` curto, `2` segurou ~1,2 s — e segurar
  **sai** do app). No launcher, o curto relança o `homeApp`, então o
  aparelho nunca fica preso no launcher invisível.
* **O app É o aparelho** — grave o `/local/autostart.txt` (ex.:
  `celeros.barebone`, via `celerctl push` ou pelo gerenciador web) ou
  compile um `homeApp` no perfil. O app de fábrica **Barebone**
  (`data/apps/Barebone`) é a referência: padrões de LED alternados pelo
  BOOT, padrão persistido no `Storage`.
* **Erros de runtime dispensam sem toque** — a tela de erro espera um
  toque *ou* o botão físico.
* **Feature-detect do vidro** — `System.getInfo().hasDisplay` é `false` e
  `shape` vale `"headless"`; apps que desenham devem checar antes de
  tocar no Canvas.

## Provisionamento de WiFi (sem tela!)

A tela de setup nativa e o captive portal precisam de display, então o
caminho é o shell pela UART:

```
celerctl shell
wifi                      # lista as redes salvas
wifi MinhaRede minhaSenha # salva no NVS e conecta (em segundo plano)
info                      # mostra o IP quando subir
```

Com o WiFi no ar, a [interface web](/Celer-Brasil/CelerOS/wiki/Interface-Web)
funciona como nas outras placas (gerenciador de arquivos, upload OTA em
`/update`, instalação de apps).

## O que é diferente de propósito

* `/screen` e screenshots servem **imagem vazia** — o painel stub não
  guarda framebuffer (um buffer 240x320x2 não cabe nos ~70 KB de heap do
  boot de um ESP32 sem PSRAM).
* Apps centrados em tela ficam fora da imagem de fábrica
  (`boards/devkit/data-exclude.txt`); app que só desenha é peso morto
  aqui.
* Os apps continuam cedendo (`System.delay`/`System.button` no loop) —
  mesmas regras de watchdog de todas as placas.
