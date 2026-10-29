# Apps de sistema

[English](/Celer-Brasil/CelerOS/wiki/System-Apps) | **Português (BR)**

Os apps de sistema do CelerOS são **JavaScript** (ES5, Duktape) e moram na
partição LittleFS, montada em `/local` — o firmware carrega só o core. Isso
cortou ~330 KB da imagem da CYD e virou o padrão da casa: os 18 apps em
`data/apps/` são todos JS (App Store, Barebone, Celer Agent, Chat IA,
HTTP Demo, Help, Installer, Matilha, Nucleo, Qwen, Regras, Settings,
Snake, Terminal, Touch Test, Watchface, Web Server, WiFi) — a Matilha
(API 27) é o painel da matilha: liga a
malha, mostra os membros com o papel de cada um, mensagens diretas e o
handoff da música itinerante; o WiFi (`celeros.wifi`, API 52) é o app de
setup de WiFi que o firmware abre por `System.openWifiSetup()`. Placas
podem acrescentar os seus por cima (overlay): Dog Face no
dog; Alarmes, Atividade, Celular, Clima, Musica e Timer no watch.

## Layout

```
data/
├── apps/<Nome>/   # app.json + main.js (+ icon.png); nome da pasta = nome exibido
└── icons/<id>.png # GERADO por tools/make_icons.py (RGBA quantizado p/ RGB565)
```

[`hub_apps/`](hub_apps) — 13 apps hoje (2048, Breakout, Calculator,
Previsao, System Info, **Celer Remote** e outros) — segue o mesmo layout,
mas é publicado no hub em vez de virar imagem de fábrica. O Celer Remote
(API 11) é a vitrine de robótica: escaneia CelerOS
próximos pelo Celer Link (BLE), conecta e pilota um robô com D-pad mostrando
a telemetria dele — referência completa de `CelerLink` +
`System.gpio.servo`.

## app.json

Campos obrigatórios:

| Campo | Regra |
|---|---|
| `name` | nome de exibição |
| `packageName` | chave única de instalação (`celeros.<x>` para apps de sistema; o primeiro publicador no hub é o dono) |
| `version` | semver; o hub rejeita republicar a mesma versão sem `--force` |
| `api` | nível mínimo de `CELEROS_API_LEVEL` — declare o menor que você usa de fato |

Opcionais: `author`, `description`, `type` (`System|App|Game`),
`category`, `system`, `order` (ordem no launcher), `icon` (id em
`data/icons/`), `topbar`, `changelog`. Nunca preencha `size`/`md5` na mão —
o hub computa na publicação.

Guia completo de empacotamento em [Guia de apps](/Celer-Brasil/CelerOS/wiki/Guia-de-Apps).

## Regras da casa

* **ES5 somente**: sem arrow functions, `let`/`const`, `class`, template
  literals ou `Promise`. Use `var` + `function` + concatenação.
* O loop do app é um `while` bloqueante com `System.delay()`; saída por
  `System.exitApp()`. Desde a API 18/19 algumas chamadas assíncronas
  aceitam callback (`AI.chat`, `Mic.start`) — ele dispara uma única vez,
  no ciclo do próprio app (`present()`).
* Trabalhe em coordenadas virtuais 240x320 e pegue cores no
  `System.theme()`. Nunca hardcode o tamanho da tela.
* Estado persistente em `/local/...`, nunca dentro da pasta de outro app.
* Strings de UI em português.

## Como um app chega ao dispositivo

| Via | Comando |
|---|---|
| Imagem de fábrica | `tools/flash_data.sh <placa> <porta>` (regrava a partição LittleFS inteira) |
| Um app só, pela serial | `python3 tools/celerctl.py apps install "data/apps/Settings"` |
| Pela App Store | hub `https://os.celer.tec.br` (Wi-Fi) ou Installer via SD |

**OTA de firmware não atualiza apps**: a OTA (Settings → System Updates,
`/update` web ou `celerctl ota push`) troca só a imagem do firmware e não
tocam na LittleFS. Apps se atualizam pelas vias acima.
