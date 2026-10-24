# Ferramentas

[English](/Celer-Brasil/CelerOS/wiki/Tools) | **Português (BR)**

Utilitários do lado do host (Python/shell) em [tools/](tools/). Instalação:
`pip install -r tools/requirements.txt` (pyserial; `make_icons` também
precisa de Pillow, fora da lista).

| Ferramenta | Papel |
|---|---|
| [celerctl.py](tools/celerctl.py) | Cliente HostLink: controle do dispositivo pela serial — referência completa em [celerctl (USB)](/Celer-Brasil/CelerOS/wiki/celerctl-USB) |
| [flash_data.sh](tools/flash_data.sh) | Constrói a imagem LittleFS de `data/` e grava a partição `littlefs` |
| [ota_server.py](tools/ota_server.py) | Servidor local de `update.json` + firmware para testes de OTA |
| [celerhub.py](tools/celerhub.py) | Publica/lista/remove apps no hub (valida as pastas de app; token por args/env; `--hub` ou `CELER_HUB`, default `https://os.celer.tec.br`) |
| [sdk/celer.js](tools/sdk/celer.js) | SDK de apps: scaffold, lint, types para o editor, emulador headless e publicação na loja (Node, zero deps npm) |
| [make_icons.py](tools/make_icons.py) | `icons.json` → `icons_src/*.png` (512 px) → `data/icons/*.png` (64 px, RGB565 ditherizado) |
| [make_splash.py](tools/make_splash.py) | PNG → `main/Assets/SplashLogo.h` (RGB565 sobre o THEME_BG) |

## celerctl — o canivete do dia a dia

```bash
python3 tools/celerctl.py devices            # lista dispositivos
python3 tools/celerctl.py shell              # shell interativo no aparelho
python3 tools/celerctl.py push main.js /local/apps/MeuApp/main.js
python3 tools/celerctl.py logcat --dump      # copia o ring de logs (repetível; --ts/--grep)
python3 tools/celerctl.py top -w             # profiling: CPU% por task, heap, app, fps
python3 tools/celerctl.py stats --json       # uma foto de profiling (JSON cru)
python3 tools/celerctl.py debug MeuApp       # debugger JS: breakpoints/step/eval
python3 tools/celerctl.py ota push build/CelerOS.bin   # firmware pela serial
python3 tools/celerctl.py screencap out.png  # captura do framebuffer
python3 tools/celerctl.py tap 120 160        # injeta um toque
```

Ele conversa pela UART do console (CH340, `/dev/ttyUSB0`; `-b` muda o
baud) — ou pela CDC1 em placas com `CELEROS_USB_NATIVE` (watch) e pelo
próprio USB-Serial/JTAG nas placas `CELEROS_LINK_ON_USJ` (dog). Com
firmware proto 2 todo frame carrega um CRC32 e as transferências usam
janela deslizante (negociada no HELLO; firmware antigo segue no caminho
legado — veja [`tools/README_USBTOOL.md`](tools/README_USBTOOL.md)).
Várias placas: `-p` aceita o prefixo de serial USB exibido por `devices`.
Os opcodes vivem em `main/USBDevice/HostLink.h` e a ferramenta lê esse
arquivo por regex: uma fonte da verdade para os dois lados. Não rode
`celerctl` com o `idf.py monitor` segurando a mesma porta.

### Bridge WiFi (Celer Debug Bridge)

Placas no WiFi expõem o mesmo HostLink sobre TCP (porta 5555):
`-p 192.168.0.50` (ou `IP:5555`) e o `celerctl devices` acha elas por
sonda UDP — nada exige cabo, nem o `ota push build/CelerOS.bin`. A
primeira conexão autentica com o token do bridge do device
(`celerctl pair IP`, ou leia por USB com `celerctl info` / shell
`bridge`); ele fica em cache no `~/.config/celerctl/tokens.json`. O
banner do bridge carrega uma identidade estável do device (MAC) e o
cache guarda o token pelo endereço **e** pela identidade: quando o DHCP
muda o IP da placa, o token da identidade re-autentica e o cache se
cura sozinho (o `devices` marca essas placas como `(pareado)`) — a
recuperação por USB só serve para device nunca pareado ou depois de um
`bridge reset`.

### O shell do aparelho

O mesmo dispatcher atende o console interativo (`celerctl shell`) e o
one-shot `celerctl shell "<cmd>"` (opcode EXEC do HostLink). Ele cobre o
vocabulário Unix do dia a dia; caminhos resolvem contra um diretório
corrente (`cd`/`pwd`) e ficam presos em `/local` e `/sd`:

```text
arquivos  ls  cat  head  tail  wc  grep [-inv]  find [-name P] [-type f|d]
          cp [-r]  mv  rm [-r]  mkdir  rmdir  touch  echo [-n]
          du  stat  xxd  md5sum  df
sistema   free  ps  top [ms]  uptime  date  uname  dmesg [n]  clear  info
apps      apps  run  exit  grant  rescan  wifi  lasterror  debug  bridge
```

Comandos encadeiam com `;` e a saída redireciona com `>` / `>>`
(`echo nota > /local/x.txt`). Não há aspas: `;`, `>` e `>>` só valem como
palavra isolada, e argumentos nunca carregam aspas — mande linhas
compactas.

`sh [-e] [-x] script.sh` roda um interpretador reduzido de script: um
comando por linha, `#` comenta a linha inteira, `-e` para no primeiro
comando que erra e `-x` ecoa cada linha antes de rodar. Os scripts têm
blocos e variáveis:

```text
set I=0
while [ $I -lt 3 ]
  echo volta $I
  set I=$I + 1        # aritmetica de inteiros no valor: N + 1
end
if [ -f /local/x.txt ]
  cat /local/x.txt
else
  echo ausente
end
```

A condição é um comando rodado calado (código 0 = verdadeiro), na
prática o builtin `[` / `test`: `a = b`, `a != b`, `-eq -ne -lt -le -gt
-ge` (inteiros), `-e/-f/-d` (caminhos, presos a `/local`+`/sd`), `-z/-n`.
`if COND / else / end`, `while COND / end` (teto de 65535 iterações) e
`break`/`continue`. `set VAR=val` grava, `set` lista, `unset VAR` apaga;
`$VAR`, `${VAR}` e `$?` (último código) expandem em qualquer linha —
inclusive na condição do `while`, re-avaliada a cada volta.

`logcat --dump` copia o ring buffer sem drená-lo (repetível); `--ts`
prefixa timestamps do host e `--grep` filtra linhas no host. Todo erro de
app é persistido em `/local/lastcrash.txt` (versão do OS, data, uptime,
app + stack completa) e sobrevive a reboot — o `lasterror` do shell
serial mostra tamanho e horário da gravação; o file manager web lê o
arquivo.

`top` é a visão de profiling: CPU% por task medida numa janela de
amostragem (duas fotos; `--sort cpu|stack|name`, `-n` limita linhas, `-w`
atualiza como o `top` clássico), heap interna/PSRAM (livre/mínimo/maior
bloco), watermark de stack livre por task, contagem viva de alocações
Duktape, heap consumido pelo app JS desde o lançamento, busy% do loop do
OS e o fps real/custo do present do app. As taxas são calculadas no host a
partir de contadores cumulativos (o device fica stateless); em chip
dual-core o somatório por task dá ~200%. `stats` imprime uma foto única
com taxas desde o boot (`--json` para o payload cru). O shell serial tem a
mesma visão como `top [ms]` para sessões só de hardware. Exige firmware
com o opcode `KL_STATS` — firmware antigo responde com um aviso para
atualizar.

`celerctl debug MeuApp` (placas com `CONFIG_CELEROS_JS_DEBUGGER`, default
nos alvos ESP32-S3) sobe um proxy TCP e o REPL do debugger Duktape: o app
pausa no attach (primeira linha) e no throw de um erro não capturado, com
breakpoints, step, eval, watches e `r` (reinicia relendo o `main.js` e
mantendo breakpoints). Referência completa em
[`tools/README_USBTOOL.md`](tools/README_USBTOOL.md).

## celerhub — publicar no hub

```bash
python3 tools/celerhub.py list               # versões locais vs hub
python3 tools/celerhub.py publish hub_apps/2048
```

## celer.js — o SDK de apps

```bash
node tools/sdk/celer.js new MeuApp      # scaffold: app.json + main.js + ícone + types para o editor
node tools/sdk/celer.js lint MeuApp     # checa ES5 + API contra o manifest real do firmware (app_lint)
node tools/sdk/celer.js test MeuApp     # roda o app no harness Node (APIs do aparelho stubadas)
node tools/sdk/celer.js emu MeuApp --frames "0,600,1500"   # emulador: PNG por marco do relógio + diff de pixels
python3 tools/celerctl.py dev MeuApp    # ao vivo no dispositivo (push + relançamento)
node tools/sdk/celer.js publish MeuApp  # publica na loja do hub
```

`lint`/`check` delegam ao `tools/app_lint` (o manifest é derivado do código do
firmware, então o linter conhece a superfície real da API); `dev`/`publish`
delegam ao celerctl/celerhub. O `emu` roda o app headless e tira snapshot
PNG da tela; com `--frames "0,600,1500"` renderiza um PNG por marco do
relógio (`tela-0000.png`, ..., na pasta `.dev` do app) e imprime o diff de
pixels entre frames consecutivos. Zero dependências npm — o acorn é
vendorado e o codificador PNG usa o zlib do Node.

## Flash sem toolchain — CelerOS Flasher

Toda tag `v*` publica, nos
[releases do GitHub](https://github.com/Celer-Brasil/CelerOS/releases):

* um zip por placa — firmware + imagem LittleFS + `flash.json` (o plano de
  gravação), e um `README.txt` com a linha `esptool` equivalente para quem
  preferir gravar na mão;
* o **CelerOS Flasher**, um flasher gráfico para Linux e Windows com o
  esptool embutido — baixe ele e o zip da sua placa na mesma pasta, escolha a
  placa, conecte o aparelho e grave. Sem instalar o ESP-IDF.

## Geradores de assets

`make_icons.py` e `make_splash.py` são passos manuais (não fazem parte do
`idf.py build`); os outputs são commitados (`data/icons/`,
`SplashLogo.h`).

Para trocar a arte de um ícone: edite o `tools/icons.json` e/ou apague o
`icons_src/<id>.png` e rode `make_icons.py --regen` — nunca edite
`data/icons/*.png` na mão (um PNG 512 px manual em `icons_src/` é
respeitado como está).
