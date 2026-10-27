# CelerKit — módulos compartilhados para apps gerais (família `celeros.app.*`)

O CelerKit é para apps gerais (não-jogo) o que o CelerGame é para os jogos:
um core opinado e módulos pequenos opcionais, distribuídos como
**dependências compartilhadas** (API 30+). Um `require` decora um único
objeto `A` — o cache do require faz `celeros.app` ser singleton, e todo
módulo da família se pendura no mesmo objeto:

```js
var A = require("celeros.app");
require("celeros.app.fmt");          // módulo opcional, decora A.fmt
A.run({ main: function (c) { /* ... */ } }, "main");
```

| dep | stripped | o que dá ao app |
|-----|---------:|-----------------|
| `celeros.app` (core) | 3.5 KB | tema/layout cacheados, loop de telas com pilha (`A.run`), overlays (ocupado/progresso/resultado/espera Wi-Fi), ticker de polling |
| `celeros.app.fmt` | 1.4 KB | bytes/uptime/duração/data nos formatos exatos do sistema |
| `celeros.app.path` | 0.9 KB | base/dir/ext/stem/join/safeName |
| `celeros.app.semver` | 2.2 KB | comparação de versão, ranges `^`, resolução transitiva de deps (mesmo algoritmo da loja) |
| `celeros.app.data` | 0.9 KB | JSON em arquivo e blobs no NVS com try/catch, caches com carimbo de validade |
| `celeros.app.history` | 0.8 KB | anel persistente com dedup consecutivo (histórico de comandos/conversa) |
| `celeros.app.net` | 1.4 KB | getJSON/getText que nunca estouram, retry bloqueante com backoff, download + MD5 |
| `celeros.app.caps` | 1.0 KB | uma sonda cacheada: placa, tela, PSRAM, presença de mic/câmera/BT/phone |
| `celeros.app.events` | 1.9 KB | barramento de eventos (on/once/off/emit, coringa, prioridades) |
| `celeros.app.text` | 0.8 KB | saneamento Latin-1 e leitor rolante pronto |
| `celeros.app.input` | 2.0 KB | sessão de teclado dockado + linha de digitação (caret, cauda, placeholder, chips) |
| `celeros.app.form` | 4.8 KB | tela de ajustes a partir de construtores de linha (info/toggle/choice/picker/action/gauge/stepper/card), seletor, askNum validado; linhas ricas quando `A.rows` é adotado |
| `celeros.app.list` | 4.7 KB | listas com cache por carimbo, sort estável com chave pré-computada, cores de badge, barras RSSI, **`view()` com linhas ricas** (ícones/seções/badges/painter/widget) |
| `celeros.app.style` | 5.9 KB | **tokens + 4 presets**, safe area, stack, card (gradiente/sombra), divider, botão |
| `celeros.app.icons` | 3.6 KB | **12 ícones vetoriais** (back/close/check/gear/wifi/star/play/search/menu/heart/info/alert), sem PNG |
| `celeros.app.widgets` | 5.8 KB | **header com ações**, botão com ícone, iconButton, anel/medidor, sheet inferior, segmented |
| `celeros.app.rows` | 2.4 KB | pintor de linha rico do form no `A.list.view` (toggle/gauge/stepper/choice/picker/info) |
| `celeros.app.launch` | 2.1 KB | scan dos apps instalados (1ª vista vence), linhas de estado contra o catálogo do hub, abrir app |
| `celeros.app.ai` | 2.8 KB | cliente do AI.chat: retry dos transientes (502/504/429), busy flag, histórico persistido, saída Latin-1 |
| `celeros.app.chat` | 2.2 KB | transcript: bolhas medidas, rolagem por inércia que segue o fim, bolha "pensando" |
| `celeros.app.updater` | 2.8 KB | checagem contra o catálogo do hub, promoção de deps no `/local/modules`, fluxo de instalação |
| `celeros.app.fsx` | 2.8 KB | instalação staged (.new + MD5 + rename em lote), blob zip único (API 42), ensureDir/treeSize |
| `celeros.app.svc` | 1.4 KB | kit de serviço em segundo plano (API 42): gates de política, drain com cap, estado persistido, notify-once |
| `celeros.app.mesh` | 2.2 KB | protocolo de app sobre a CelerNet: prefixo de família, req/resp com nonce, dedup de replay, cache TTL |
| `celeros.app.kit` | 0.3 KB | pacote dos 8 módulos comuns (contorna o teto de 8 deps do hub) |

A família inteira tem ~63 KB stripped; o fecho do `kit`, ~19 KB. Todo
módulo declara o próprio `version` e registra um nome único em `A._mods`.

## Kit de UI 2.0 (`celeros.app.style`, `.icons`, `.widgets`, `.rows`)

Quatro módulos opcionais dão aos apps o mesmo controle que os jogos ganharam, **sem mexer no firmware**. Eles compõem o `UI.*` nativo (frame/toque/topbar/pacing) com superfícies `System.*` e ícones vetoriais:

- `celeros.app.style`: tokens vivos + 4 presets (`soft/flat/neon/paper`), `content()` com safe area, `stack()`, `card()` (UI.card nativo + gradiente/sombra no frame cheio), `divider()`, `button()`.
- `celeros.app.icons`: `A.icons.draw(name, x, y, size, { color })` com back/close/check/gear/wifi/star/play/search/menu/heart/info/alert.
- `celeros.app.widgets`: `header(title, { back, sub, actions, full })`, botão com ícone, `iconButton`, `ring`, `sheet` (sheet inferior não bloqueante), `segmented`.
- `celeros.app.rows`: `A.rows.formRow` para o `A.form.run` com `A.list.view` (linhas gauge/stepper/toggle).

```js
var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
A.style.preset("neon");
var h = A.widgets.header("Rede", { full: c.full,
  actions: [{ icon: "wifi", id: "wifi" }] });
if (h.back) return A.BACK;
if (h.action === "wifi") abrirWifi();
var cr = A.style.card(8, 48, 224, 120, { full: c.full, draw: function (r) {
  UI.text("Conteudo", r.x, r.y);
}});
```

**Regra de redesenho:** o `UI.card` empilha o fundo em **todo frame** e pinta só no frame cheio. Chame `A.style.card`/`A.style.header` todo frame e passe `{ full: c.full }`; nunca repinte uma superfície opaca todo quadro por cima de um `UI.text` slotizado (apagaria o texto que o slot pulou). O `UI.text` dentro do card usa o bg empilhado; trocar de preset chama `UI.invalidate()`.

A lista rica (`A.list.view`) aceita `{label, sub, icon, right, badge, bars, disabled, section}`, `paintRow` e um `widget` por linha (embute `UI.toggle`/`UI.button`); o `UI.list` nativo continua para linhas simples.

Orçamento: cada módulo ≤6 KB; o fecho do kit fica em ~19 KB. `style/icons/widgets/rows` ficam **fora** do `celeros.app.kit` (o kit já tem 8 deps): cada app adiciona o que precisa. A Loja na CYD tem ~6,4 KB livres, então adota no máximo o `style`; os outros apps têm folga. Os extras nativos `UI.custom`/`UI.clip`/`UI.style` para as placas S3 são uma rodada separada, habilitada em compilação (`CELEROS_UI_EXTRAS`), mantendo a CYD na UI base.

## O contrato do core (`celeros.app`)

`A.init()` cacheia o tema (`A.T`) e o layout virtual fixo (`A.L`: x=8,
w=224, top=48, bottom=312, cx=120). `A.run(screens, first, opts)` é dono do
`UI.begin/UI.end`; a tela só desenha e **devolve**:

- `undefined` — fica na tela;
- `"nome"` — empilha a atual e abre `nome`;
- `A.BACK` — volta na pilha (pilha vazia encerra o app);
- `A.EXIT` — encerra na hora.

O ctx passado a cada tela é `{ full, now, entered }`; `entered` vale true
só no primeiro frame da tela (lazy load, reset de rolagem). FPS por tela:
pendure `.fps` na função da tela. Os overlays (`A.busy`, `A.progress`,
`A.error`, `A.ok`, `A.wifiWait`) desenham o chrome para o app não desenhar;
`A.every(ms, chave)` é o jeito de fazer polling (timers são escassos — o
pool é de 8, no firmware e no harness).

## Serviços (API 42) e vendoring

Serviços em segundo plano compilam fora do carregador de apps e **não**
carregam a tabela de deps compartilhadas. Para usar o kit num
`service.js`, vendorize os arquivos na pasta do app (`celeros.app.js` +
`celeros.app.svc.js`): a precedência do require (cópia local primeiro) faz
`main.js` e `service.js` carregarem a mesma cópia. O `app_lint` avisa de
vendoring — para serviços é esperado.

## Publicando um módulo do kit

```bash
node tools/sdk/celer.js publish-dep tools/sdk/engine/celeros.app.js --min-api 30
# um por módulo; celeros.app.svc usa --min-api 42 (gates de política são API 42)
python3 tools/celerhub.py deps-status     # tem que voltar limpo
```

As arestas moram em `tools/sdk/engine/index.json` (o publish-dep herda para
arquivos desse diretório; o harness e o `celerctl --deps-local` resolvem o
mesmo fecho). Ranges são `^x.y.z` (mesma major, >= base) ou exatos.

## Scaffold de app

`node tools/sdk/celer.js new --appkit Nome` cria o app com as deps do kit
no `app.json` e copia os `.d.ts` da família (só dev; o publish exclui).
Com editor com suporte a tipos, deixe os `.d.ts` dos módulos adotados junto
do projeto — eles aumentam o `declare namespace A`.

## Convenções que todo módulo segue

- Só ES5 (Duktape); zero alocação em caminho de desenho; scratch pré-alocado.
- Comentários em português (sem acentos); texto de tela pode ter acentos.
- Exatamente um literal `version: 'x.y.z'` por arquivo (o hub recusa dois).
- O `test/sdk/celerosapp_r1.js` trava a família: d.ts + entrada no
  index.json por módulo, o guia cita todo módulo em EN e pt-BR, orçamento
  de tamanho, paridade de linhas stripped e cobertura de membros do d.ts.
