# Guia de Desenvolvimento de Apps do CelerOS

[English](App_Development_Guide.md) | **Português (BR)**

Bem-vindo ao Guia de Desenvolvimento de Apps do CelerOS! Desenvolver apps
para o CelerOS é simples. Os apps são escritos em JavaScript e usam uma
estrutura de pastas padrão contendo metadados e código.

## 1. Estrutura de Pastas do App

No CelerOS, um app não é apenas um arquivo `.js`. Cada app é uma **pasta**
contendo todos os arquivos necessários. Quando você instala o app com
`celerctl apps install <pasta>`, pelo cartão SD (Installer) ou pela App
Store, a pasta inteira é o que vai para o aparelho.

Uma pasta de app padrão tem esta cara:
```text
MyAwesomeApp/
├── app.json
├── icon.png
├── main.js
├── notas.js          # módulo JS opcional (require("notas"), API 23)
└── alerta.wav        # asset opcional (playWav/drawPNG/FS.readFile)
```

**Módulos (API 23):** separe o código em quantos `.js` chatos quiser e
carregue com `require("nome")` — estilo CommonJS (`module.exports`/
`exports`), cache por execução, módulos podem requerer módulos:

```js
// main.js
var notas = require("notas");   // carrega notas.js da pasta do app
notas.tocar("alerta");

// notas.js
var audio = require("audio");
exports.tocar = function (n) { audio.beep(n); };
```

**Assets:** arquivos extras na pasta (chatos, sem subpasta) viajam no
pacote pelo hub: `.js .png .wav .json .bin`, até 16 extras, 128 KB cada,
256 KB de assets no total. Use por caminho
(`System.playWav("/local/apps/MyAwesomeApp/alerta.wav")`) ou leia com
`FS.readFile`. O hub computa o manifesto `files` sozinho — nunca sete à
mão (como `size`/`md5`).

## 2. O Arquivo `app.json` (Metadados do App)

O `app.json` é o coração da identidade do seu app. O Installer do CelerOS lê
esse arquivo para instalar, atualizar e categorizar sua aplicação com
segurança.

### Formato de exemplo:
```json
{
  "name": "Meu App",
  "packageName": "com.desenvolvedor.meuapp",
  "version": "1.0.0",
  "metaUrl": "https://raw.githubusercontent.com/.../meuapp/app.json",
  "author": "Fulano",
  "description": "Um app legal que faz coisas incríveis.",
  "type": "App",
  "category": "Utilities",
  "api": 6,
  "changelog": "Lancamento inicial."
}
```

### Detalhe dos campos:
- **`name`**: o nome de exibição do app. É o que o usuário vê na Home.
- **`packageName`**: identificador globalmente único do seu app. **Regras:
  minúsculas, estilo separado por pontos, sem espaços** (ex.:
  `com.seunome.appnome`). O SO usa esse valor para detectar se o app já está
  instalado.
- **`version`**: versionamento semântico (ex.: `1.0.0`, `1.2.1`). Se for
  instalado um app com o mesmo `packageName` e número de versão maior, o SO
  oferece "Atualizar" em vez de "Instalar".
- **`metaUrl`** *(opcional)*: URL raw do `app.json` na internet (ex.: seu
  repositório GitHub). Apps publicados no **CelerOS Hub não precisam dela** —
  o próprio catálogo da loja carrega nome, versão, changelog, tamanho e o
  checksum MD5 do seu `main.js`; `metaUrl` serve só para checagem de versão
  fora do hub.
- **`author`**: seu nome ou estúdio. Se outra pessoa tentar instalar um app
  com o seu `packageName` mas um `author` diferente, o SO emite um aviso de
  conflito para proteger o app contra sobrescrita maliciosa.
- **`description`**: resumo curto do app, exibido ao usuário na primeira
  instalação. Acentos Latin-1 (ç, ã, é...) renderizam bem desde a API 7;
  evite travessão, aspas curvas e emoji (fora da fonte).
- **`type`**: classificação ampla (ex.: `App` ou `Game`). Pode digitar
  qualquer valor, sem restrição.
- **`category`**: categoria específica (ex.: `Utilities`, `Games`, `Tools`).
  Pode digitar qualquer valor, sem restrição.
- **Placas sem PSRAM** (ex.: a CYD clássica): o `main.js` inteiro — mais o heap JS e os temporários do compile — tem que caber na RAM interna; fonte acima de ~60KB não compila nela (comentários e indentação são removidos antes do compile, não custam nada). Apps acima de 48 KB precisam declarar `"requires": ["psram"]`; a loja marca como "Requer PSRAM" e bloqueia o install em placa sem PSRAM.
- **`permissions`** (opcional, F4): array de capabilities — `"fs"`, `"net"`, `"gpio"`, `"system"`. Sem o campo o app mantém tudo (compatibilidade com a loja existente); com ele, só o que foi declarado é registrado: `FS` / `Net` / `System.gpio` **e as chamadas de hardware externo** (`System.led`, `System.relay*`, `System.neopixel`), além das que afetam o aparelho, como `restart`/`otaStart`. Arquivos do sistema em `/local` (credenciais Wi-Fi, PIN, config de OTA/boot) exigem `"system"` adicionalmente, mesmo para apps com `"fs"`. Apps de sistema (`"system": true`) sempre recebem tudo.
- **`api`**: nível de API do CelerOS que o app mira (veja o [Guia da API
  JS](JS_API_Guide.pt-BR.md) — atualmente `36`). Verificado pelo sistema na
  instalação.
- **`deps`** *(opcional, API 30)* — bibliotecas compartilhadas do hub em vez de
  cópias vendorizadas: `"deps": { "celeros.game": "^1.0.0", "celeros.physics": "^2.1.0" }`.
  A versão é um range `^X.Y.Z` (mesma major, ≥ base) ou um `X.Y.Z` exato; a
  loja resolve **na instalação** para `/local/modules/<nome>/<versao>/` (uma
  cópia por versão no aparelho, compartilhada entre apps) e grava a escolha em
  `<pasta do app>/deps.json`, que é o que o `require()` lê. Um `<nome>.js`
  local na pasta do app ainda vence sobre o cache (vendorizar segue
  funcionando). As deps contam no teto de compilação de 48/128 KB. Ordem de
  resolução e detalhes: [Guia da API JS, seção 35](JS_API_Guide.pt-BR.md).
- **`requires`** (opcional): requisitos de hardware — `"psram"` é o único
  valor hoje. Sobe o teto do hub para o `main.js` de 48 KB para 128 KB
  (placas com PSRAM compilam sem limite runtime); a loja marca o app como
  "Requer PSRAM" e bloqueia o install em placas sem PSRAM (CYD, devkit).
  Cartão SD **não** sobe o teto: o limite é RAM de compilação, não
  armazenamento.
- **`changelog`**: string curta descrevendo o que mudou (uma linha por versão
  funciona bem, ex. `"1.1.0 - conserto de crash\n1.0.0 - primeiro
  lancamento"`). O hub publica junto com o catálogo e a loja do aparelho
  mostra sob o título **"Novidades"** na tela de atualização.

### Campos gerenciados pelo CelerOS Hub

Ao publicar pelo hub (`tools/celerhub.py`), quatro campos
do `app.json` são calculados e gravados pelo servidor — **não escreva à mão**
(um publish manual os recalcula de qualquer forma):

- **`size`** — tamanho em bytes do `main.js` (a loja confere o espaço livre
  no disco antes de baixar).
- **`md5`** — checksum do `main.js`; o aparelho valida depois de baixar e
  aborta o update em caso de divergência, sem tocar na versão instalada.
- **`published_at`** — data/hora UTC do publish.
- **`publisher`** — nome do token que publicou o pacote.

### Regras de atualização de apps (CelerOS Hub)

- **O catálogo é o canal de update.** A loja compara a versão de cada entrada
  com a instalada; versão nova ganha badge **"Atualizar"** na lista, aparece
  na aba **Atualizações** e no botão **"Atualizar tudo"**.
- **Suba a `version` a cada publish.** O hub rejeita versão ≤ à publicada
  (`--force` para exceções, ex. republicar um pacote corrigido).
- **O seu `packageName` tem dono.** Quem publica primeiro vira o dono; só o
  mesmo token (ou o root do hub) atualiza/remove o pacote depois.
- **Limites de tamanho:** a **soma dos arquivos `.js`** (`main.js` +
  módulos) tem que ficar em **48 KB**; declarar `"requires": ["psram"]`
  sobe o teto para **128 KB** — é a soma que ocupa a RAM de compilação,
  então módulos contam no mesmo orçamento. Cada `.js` acima de **30 KB**
  exige `api: 6` (firmware antigo baixava via `Net.get`, que trunca em
  32 KB; o downloader streaming da API 6 não tem teto). Assets (não-`.js`):
  até 16 extras, 128 KB cada, 256 KB no total. `icon.png` ≤ 16 KB.
- **O ícone viaja com o update:** mantenha um `icon.png` (PNG 64×64, ≤ 16 KB)
  no pacote — a loja baixa na instalação/atualização e o launcher renova o
  cache de ícones sozinho.
- **O update cai na pasta que o launcher executa** (resolvida por
  `packageName`): atualizar um app preinstalado atualiza in-place, sem criar
  cópia sombreada.
- **A App Store se atualiza sozinha:** a loja é um pacote comum do hub
  (`celeros.appstore`). Quando o catálogo tem loja mais nova, ela aparece
  como qualquer update — depois de instalar, a loja pede para sair e abrir
  de novo (o `main.js` novo é relido do disco na próxima abertura).

## 3. O Arquivo `icon.png` (Ícone do App)

Um PNG quadrado de 64x64 (ou maior) exibido no Launcher. Na instalação ele é
decodificado para o cache de ícones do sistema (RGB565 + alpha de 4 bits),
então transparência e cantos arredondados funcionam. Apps sem `icon.png`
recebem um ícone genérico.

## 4. O Arquivo `main.js` (Lógica do App)

O `main.js` é o ponto de entrada da aplicação. Quando o usuário toca no app
no Launcher, o SO carrega e executa esse arquivo JavaScript.

Como o CelerOS cuida da tradução para C++ por baixo, você escreve JavaScript
de alto nível e simples para desenhar gráficos, ler arquivos e acionar
componentes de UI.

### O modelo do app

* **Só ES5**: sem arrow functions, `let`/`const`, `class` ou template
  literals — a engine é Duktape. Use `var` + `function`.
* O app é um **loop `while` bloqueante** ritmado por `UI.end()` (ou `System.delay()`) — não existem
  eventos nem callbacks. Tudo é polling: `System.getTouch()`,
  `System.keypadPoll()`, `CelerLink.poll()`.
* **Multitoque** (API 43): `System.getTouches()` devolve TODOS os dedos como
  `[{id, x, y, size}]` (primário/mais antigo primeiro, `[]` sem dedo). Ela
  compartilha a cedida de quadro com `System.getTouch()` — chame **uma das
  duas por loop**, nunca as duas. Vidro sem multitoque (CYD resistiva)
  devolve no máximo 1 ponto; o SmartDisplay 4848 e o watch devolvem até 5.
  O chrome do sistema (canto de saída, topbar, bordas do watch) consome só
  o dedo primário.
* Todas as coordenadas vivem no **canvas virtual 240x320**
  (`System.screenWidth()` é 240 em qualquer placa); o OS escala para o vidro
  físico. Pegue cores no `System.theme()` em vez de fixar valores.
* Saia com `System.exitApp()`. Estado que precisa sobreviver vai em
  `FS.appData()` (pasta privada por app).

### Seu Primeiro App (`main.js`)

Desde a API 22 a interface sai do toolkit `UI` — os mesmos widgets das telas
do sistema (fontes, botões com estado pressionado, listas com inércia,
diálogos), sem hit-test à mão:

```javascript
var T = System.theme();
var toques = 0;

while (true) {
    UI.begin(T.bg);                          // lê o toque; pinta o fundo no frame total
    UI.header("Meu App");
    UI.text("Olá CelerOS!", 120, 90, { role: "title", align: "center" });
    UI.text("toques: " + toques, 120, 130, { align: "center", color: T.accent });
    if (UI.button("Tocar", 20, 200, 200, 44)) toques++;
    if (UI.button("Sair", 20, 254, 200, 44, { style: "ghost" })) System.exitApp();
    UI.end();                                // mostra o quadro e segura ~30 fps
}
```

Desenho próprio (jogos, gráficos, mostradores) continua com as primitivas
`System.*`, dentro de `if (full)` — `full` é o retorno do `UI.begin()`. Veja
a seção 27 do [Guia da API JS](JS_API_Guide.pt-BR.md) para o modelo de
redesenho e a lista de widgets.

### Detecção de recursos entre placas

O mesmo app roda em placas muito diferentes (SmartDisplay 4" com PSRAM, CYD
de 128 KB, cachorro robô). Detecte em vez de assumir:

```javascript
if (System.getAPILevel() >= 9 && typeof CelerLink !== "undefined") {
    // Link Bluetooth LE entre CelerOS (API 9)
    var perto = CelerLink.scan();
    if (perto.length) CelerLink.connect(perto[0].id);
}

if (System.relayCount() > 0) System.relay(1, true);  // SKUs "Y" (API 8)
if (typeof System.gpio.servo === "function") System.gpio.servo(13, 90);  // API 10

var bateria = System.battery();   // -1 em placa sem divisor
var nivel = System.micLevel();    // -1 sem microfone
```

As flags de placa em `System.getInfo()` (`hasLed`, `hasLightSensor`,
`hasSpeaker`) e os retornos `-1`/`false`/contagem das chamadas de hardware
são o contrato — nunca assuma que um periférico existe.

### Apps de referência para ler

* Embarcados (`data/apps/`): **Snake** (loop de jogo, recorde persistido),
  **Terminal** (teclado acoplado `System.keypad*`), **Touch Test**,
  **HTTP Demo** (rede).
* Hub (`hub_apps/`): **Celer Remote** (API 11) — exemplo completo de
  robótica: escaneia e conecta via Celer Link, pilota um D-pad que repete
  mensagens `{type:"move",dir}` e mostra a telemetria do robô.

### Jogos: CelerGame como dependências compartilhadas

Para jogos 2D a própria engine vem do hub como a **família de dependências
CelerGame**: `celeros.game` (o núcleo — cenas, loop, câmera, entidades,
camada suja, save) mais os módulos opcionais `celeros.game.fx`
(partículas/flash), `.spr` (sprites + flipbooks), `.tilemap` (grade de
células sujas) e `.ui`; cada módulo decora o mesmo objeto `E`, então adotar
pouco custa pouco. A física é a dep `celeros.physics` (2.1 — `P.hit`,
`P.verlet`/`P.verletFast`, `P.rigid`), grades de IA/tiles são `celeros.grid`
e sons de tabela são `celeros.sfx`. A `celeros.engine` monolítica segue no
hub como shim de compatibilidade 1.2.5 que monta a família. Jogos miram as
placas S3 com PSRAM — declare `"requires": ["psram"]` e `"topbar": false`
(o scaffold `new --game` faz isso por você):

```bash
node tools/sdk/celer.js new MeuJogo --game    # scaffold + celeros.game(+fx) nas deps do app.json
node tools/sdk/celer.js deps MeuApp           # deps do app.json + versões no hub/local
node tools/sdk/celer.js deps set celeros.game.spr ^1.0.0 MeuApp
```

> [!NOTE]
> **Migrando da física 2.0:** `P.world`, `P.tiles` e `P.flow` saíram no
> celeros.physics 2.0 — use a dep `celeros.grid` para grades de tiles/IA e
> `System.rigid*` (API 33) para corpos rígidos que rolam e tombam.
> `P.verlet`/`P.verletFast` (e o caminho nativo `System.verlet*`) não mudaram.

Documentação completa: **[Guia da Game Engine](Game_Engine_Guide.pt-BR.md)**.

> [!IMPORTANT]
> Para ver tudo o que dá para fazer no `main.js`, consulte o **[Guia da API
> JS](JS_API_Guide.pt-BR.md)** completo! Lá está toda a documentação de
> desenho, pinos GPIO, sistema de arquivos, componentes de UI e mais.

## 5. SDK: do scaffold à publicação

As ferramentas de desenvolvimento moram em `tools/` do repo e têm uma porta de
entrada única (`tools/sdk/celer.js`), sem dependências para instalar. Fluxo
recomendado:

```bash
# 1) crie o esqueleto (app.json no API level atual, main.js de exemplo,
#    icon.png e celer.d.ts para autocomplete no VS Code)
node tools/sdk/celer.js new MeuApp

# 2) itere localmente: lint a cada save, preview ao vivo no navegador
node tools/sdk/celer.js lint MeuApp
node tools/sdk/celer.js emu MeuApp --serve --open   # ao vivo: mouse/toque, teclas, hot reload
node tools/sdk/celer.js emu MeuApp                  # salva MeuApp/.dev/tela.png

# 3) dev loop no aparelho: watch dos arquivos, reinstalla o que mudou,
#    encerra o app em execucao (shell `exit`) e reabre, com logs ao vivo
python3 tools/celerctl.py dev MeuApp [--shots]

# 4) publique
node tools/sdk/celer.js publish MeuApp --dry  # valida offline
node tools/sdk/celer.js publish MeuApp
```

### Depurando no aparelho

Placas com o debugger (as ESP32-S3 por padrão:
`CONFIG_CELEROS_JS_DEBUGGER`) dão breakpoints, passo a passo e inspeção ao
vivo do app rodando:

```bash
python3 tools/celerctl.py debug MeuApp    # abre o app pausado na linha 1 + REPL
```

```
dbg> b 42 if pontos > 100    # breakpoint condicional (linha do arquivo pausado)
dbg> w jogador               # watch: impresso a cada pausa
dbg> c                       # continua até um breakpoint
dbg> v jogador               # objetos mostram o conteúdo: {"x":12,"y":40}
dbg> lc                      # locais do frame;  cs = pilha, up/down
dbg> e pontos * 2            # eval no frame;  set vidas 9 muda uma variável
dbg> n                       # step over (s = into, o = out, u 50 = roda até a linha 50)
dbg> r                       # envia os arquivos editados + reinicia, mantendo os breakpoints
```

* **Erro não capturado pausa no throw**, com pilha e locais intactos; `c`
  deixa o erro seguir para a tela de erro de sempre.
* `debugger;` no código pausa ali quando há debugger attachado (sem ele é
  no-op, mas tire antes de publicar).
* Ctrl-C pausa um app rodando; Ctrl-C duas vezes (ou `q`) desattacha e o app
  segue. Os logs do aparelho aparecem no mesmo terminal.
* Ciclo editar-e-tentar: salve no editor, `r` no REPL — a pasta local do app
  (achada em `data/apps`/`hub_apps`, ou `--src PASTA`) passa no lint e os
  arquivos mudados vão para o aparelho antes do reinício; erro de lint mantém
  o app antigo. (`celerctl debug --serve` deixa só o proxy, para um cliente
  separado.)

Detalhes que valem saber:

* **`celer.d.ts`** (gerado de `tools/sdk/celer.js types`): tipos da API para
  o editor — o scaffold copia para a pasta do app junto de um
  `jsconfig.json`. É artefato gerado do código do firmware; ao mudar a API,
  regenere e commite (o `celer.js check` acusa drift no CI).
* **Emulador** (`emu`): roda o app no harness Node com desenhos reais num
  framebuffer 240x320 (480x480 quando o app usa o canvas nativo). `--serve`
  abre um **preview ao vivo** no navegador: ponteiro = toque de verdade,
  setas/WASD = swipe, espaço = tap, além de pausa/passo/velocidade e hot
  reload ao salvar um arquivo; o loop roda no relógio do próprio app. Modos
  headless: um PNG (`--out`), um PNG por marco com diff de pixels
  (`--frames`) ou um GIF animado (`--gif out.gif --ms 3000 --fps 20`).
  `--input ARQ` roteiriza toques/arrastos por tempo, `--seed N` deixa o
  `Math.random` reproduzível, `--grid`/`--mark x,y` acham coordenadas e
  `--scale N` amplia o PNG. O botão **Gravar** do preview ao vivo registra
  os toques e baixa um arquivo que você reaproveita no `--input`. É uma
  aproximação (fonte 8x8; `drawPNG`/`drawBMP`/`drawIcon` renderizam a arte
  de verdade, `drawJPG` ainda não) — a tela final sempre é a do aparelho.
* **`test`/`emu` aceitam script de eventos**: crie `test.js` na pasta do app
  exportando `wire(env)` (toques via `env.__harness.tap/pushTouch`, respostas
  de rede, estado do CelerLink) e o runner injeta antes de executar. Para
  entrada reproduzível sem código, use `--input ARQ`:

```
# toques.txt — tempo em ms do app, depois o gesto
0    tap 120,200
600  swipe 120,240 120,80 6
900  down 120,160
980  move 150,180
1100 up 150,180
```
* **`celerctl dev`** negocia 921600 baud sozinho e mantém um keepalive com o
  aparelho (o canal cai para console após 8s sem tráfego do host). O comando
  `exit` do shell do aparelho encerra o app em execução de forma limpa —
  é ele que permite o reload sem reboot.
