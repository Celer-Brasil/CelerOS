# Guia CelerGame (a game engine do CelerOS)

[English](Game_Engine_Guide.md) | **Português (BR)**

A **CelerGame** é a game engine 2D do CelerOS, entregue como uma **família de dependências compartilhadas do hub que você adota uma a uma** — desde a API 30, `"deps"` no `app.json`: a loja as instala no cache público `/local/modules` e o `require()` resolve de lá, uma única cópia por versão no aparelho. Sem permissão extra; vendorizar uma cópia na pasta do app continua funcionando (e vence).

| Dep | Enxuta | O que entrega |
|---|---|---|
| **`celeros.game`** (core) | ~65 KB | loop com cenas + transições, gestos de toque, desenho com câmera, **`E.color` + sombras/gradientes/bordas/outline no gfx**, matemática/RNG, tweens/timers/`E.seq`, grupos/pools, camada suja, áudio chiptune com relógio de batida, saves no NVS, perfilador (`E.prof`), pool de sprites com dono (`E.slots`) e HUD ancorado (`E.ax/ay/anchor`) |
| **`celeros.game.fx`** | ~13 KB | partículas, bursts/ondas, texto flutuante, flash, campo de estrelas, **emissores contínuos, rastros, parallax** |
| **`celeros.game.spr`** | ~16 KB | sprites PNG em slots nativos com painter de fallback, flipbooks, **spritesheet (1 PNG, N regiões nomeadas)**, metadados de arte (`E.spr.meta`) |
| **`celeros.game.tilemap`** | ~4 KB | grade de células sujas p/ cenários procedurais grandes |
| **`celeros.game.ui`** | ~57 KB | **kit de UI 1.3**: tokens + 4 presets, 24 ícones vetoriais, layout (stack/grid/card), 12+ widgets, listas ricas, scroll genérico, modal/sheet, toasts em fila, HUD memoizado, diálogos com escolhas e as telas de título/pausa/fim prontas |
| **`celeros.engine`** | shim (0,2 KB) | a **família inteira montada** — a API pré-modularidade (1.2.x) num `require` só; jogos existentes seguem funcionando sem mudança |
| **`celeros.physics`** (opcional) | ~7 KB | corda/pano por Verlet nativo (`P.verletFast`, API 31) e corpos rígidos (`P.rigid`, API 33). **A maioria dos jogos não precisa de nada disso** — veja a escada de física no §15 |
| `celeros.grid`, `celeros.sfx`, `celeros.mesh` | — | arenas estilo bomberman + BFS de perseguição, tabelas de melodias sfx, boilerplate CelerNet (mesma família, módulos à parte) |

Os tamanhos são os **enxutos** (jsstrip), medidos em 2026-10 — confira com
`node tools/sdk/lib/jsstrip.js tools/sdk/engine/<modulo>.js` antes de planejar.

Cada módulo decora o **mesmo objeto `E`** (o cache do `require` faz o core ser singleton): adotar é uma linha — `require("celeros.game.fx")` e o `E.fx` existe. Deps entre módulos são transitivas (fx → core): a loja resolve o grafo inteiro no install. Você paga pelo que adota — deps somam no teto do app MESMO compartilhadas, porque cada jogo as compila no próprio heap Duktape: **o core sozinho já passa do teto de 48 KB sem PSRAM** (65 KB desde a 1.7.0; 51 KB na 1.5), então todo app com a engine declara `"requires": ["psram"]`; core + kit de UI somam ~121 KB e a família inteira ~230 KB.

Tudo é ES5 (Duktape) e detecta os recursos do firmware em tempo de execução, então o mesmo jogo roda em toda placa — e sem mudanças no harness/emulador Node.

## 1. Requisitos

| | |
|---|---|
| API do firmware | 23+ para módulos; **30+** para as deps compartilhadas (recursos novos — primitivas smooth, `playMusic`, canvas nativo — são auto-detectados) |
| Placas-alvo | As ESP32-S3 com PSRAM: SmartDisplay, watch Waveshare, cão SpotPear |
| Orçamento de tamanho | Deps somam no teto do app MESMO compartilhadas (compilam no heap de cada jogo): **o core sozinho são ~51 KB enxutos**, acima do teto simples de 48 KB — apps com a engine declaram `"requires": ["psram"]`, o que sobe o teto para 1 MB (a loja passa a bloquear install em placa sem PSRAM). O hub mede as deps **enxutas**, como o aparelho compila |
| Sabor do app | `"topbar": false` para jogos em tela cheia (como o Supernova) é recomendado; o botão de saída mora no menu de título do seu jogo (`System.exitApp()`) |
| CYD (sem PSRAM) | A engine **não roda** na CYD: sem PSRAM o teto é 48 KB e o core sozinho passa disso. Na CYD, app usa a API JS direto (`System`/`UI`), como os apps de sistema; nenhum jogo do catálogo roda nela hoje (todos declaram `psram`) |

## 2. Começando

```bash
# scaffold de jogo pronto pra rodar (app.json com deps core+fx + jogo
# Quica de exemplo; os modulos NAO sao copiados — vem do hub no install):
node tools/sdk/celer.js new MeuJogo --game

# deps do app.json x versões no hub (e o que existe na arvore local):
node tools/sdk/celer.js deps MeuJogo
node tools/sdk/celer.js deps set celeros.game.spr ^1.0.0 MeuJogo  # adota um módulo

# publique as deps da engine no repositorio do hub (publica a arvore
# canonica tools/sdk/engine/; precisa do token com escopo deps; o --dep
# declara as arestas da família — espelhe o tools/sdk/engine/index.json):
python3 tools/celerhub.py publish-dep tools/sdk/engine/celeros.game.js --min-api 30
python3 tools/celerhub.py publish-dep tools/sdk/engine/celeros.game.fx.js --min-api 30 --dep celeros.game=^1.0.0
python3 tools/celerhub.py publish-dep tools/sdk/engine/celeros.physics.js --min-api 31

# depois de mudar QUALQUER modulo em tools/sdk/engine: suba o version:
# 'x.y.z' declarado dentro dele, publique com publish-dep e mantenha o
# `deps-status` verde ANTES do push (e gate) — fix commitado sem publish nao
# chega a nenhum device. `celer.js deps <Pasta> --verify` falha quando um
# range do app.json nao tem versao que satisfaca no hub:
python3 tools/celerhub.py deps-status
node tools/sdk/celer.js deps MeuJogo --verify

# itere (lint a cada save; emulador renderiza PNG; device faz live reload —
# no PC o require resolve as deps da arvore tools/sdk/engine):
node tools/sdk/celer.js lint MeuJogo
node tools/sdk/celer.js emu MeuJogo
python3 tools/celerctl.py dev MeuJogo
```

O `new --game` scaffolds o **Quica**, um joguinho completo de manter-a-bola-no-ar (cenas titulo/jogo/fim, raquete por arrasto, bolas quicando, partículas, sfx, recorde) — leia o `main.js` dele; é o exemplo canônico. A física das bolas é feita à mão de propósito: a escada de física começa no zero (§15).

## 3. Quickstart: um jogo completo em ~30 linhas

```js
// main.js
var E = require("celeros.game");       // core — adote mais com require():
require("celeros.game.fx");            // + partículas (E.fx), uma linha cada

E.init({ dir: "Bolas", fps: 30, save: "bolas." });
var W = E.W, H = E.H;

var balls = [];                    // pool: nenhuma alocacao dentro do frame

E.run({
  jogo: {
    update: function (dt) {
      if (E.input.tap) {
        balls.push({ x: E.input.tap.x, y: E.input.tap.y, r: 8,
                     vx: E.m.rand(-120, 120), vy: 0 });   // bounce: 0.85 abaixo
        if (balls.length > 40) balls.shift();             // teto do pool
        E.audio.sfx("ui");
      }
      for (var i = 0; i < balls.length; i++) {
        var b = balls[i];
        b.vy += 900 * dt;                                 // gravidade
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx) * 0.85; }
        if (b.x + b.r > W) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * 0.85; }
        if (b.y + b.r > H) { b.y = H - b.r; b.vy = -Math.abs(b.vy) * 0.85; }
      }
    },
    draw: function () {
      System.fillScreen(E.theme.bg);
      for (var i = 0; i < balls.length; i++) {
        E.gfx.circle(balls[i].x, balls[i].y, balls[i].r, E.theme.accent);
      }
      E.gfx.text(balls.length + " bolas", W / 2, 8,
                 { align: "center", color: E.theme.textDim, font: 1 });
      E.fx.draw();
    }
  }
}, "jogo");
```

Essa é toda a física que esse jogo precisa: integrar, mover, refletir nas
paredes (§15, degrau 0 da escada — poucos corpos e planos é sempre mais
barato na mão do que em qualquer engine).

A engine **possui o loop**: você descreve cenas e ela chama `update(dt)`/`draw()` no fps alvo, pollando toque e tickando efeitos/timers/tweens/áudio pra você. Esse loop é seguro contra o exec-timeout (cede todo frame).

## 4. Cenas e o game loop

```js
E.init({ dir: "MeuJogo",  // nome da pasta do app → base de assets (/local/apps/...)
         fps: 30,          // alvo de frames (default 30, 0 = sem teto)
         native: false,    // true = canvas nativo (pixels físicos, API 28)
         save: "meujogo.", // prefixo das chaves NVS do E.save
         particles: 96 }); // tamanho do pool de partículas
E.run(cenas, "titulo");
```

Uma cena é `{ enter, update(dt), draw, exit }` — tudo opcional. `E.goto("fim")` troca no começo do próximo frame (rodando o `exit` da cena antiga antes); `E.quit()` encerra o `E.run()`. Use `E.data` para estado que sobrevive à troca de cena (ele vive pelo app inteiro), e `E.sceneName`/`E.dt`/`E.fps` para introspecção. A cena pode sobrepor o alvo de frames global com `fps` (menus a 30, a ação sem teto com `fps: 0`):

**Transições de cena (core 1.0):** `E.goto(nome, {transition, ms, color, dir})` desenha um véu barato (≤ 9 fillRect/quadro, sem captura de tela — o firmware não tem cópia screen→sprite) no lugar do corte seco:

```js
E.goto("jogo", { transition: "fade", ms: 500 });              // véu fecha na cena antiga, abre na nova
E.goto("menu", { transition: "wipe", ms: 300, dir: "left" }); // left|right|up|down
E.goto("jogo", { transition: "iris", ms: 400, color: 0x0000 }); // buraco quadrado abrindo
E.goto("jogo", { transition: "bands", ms: 450 });             // 8 colunas em stagger
```

Enquanto o véu vive a camada suja repinta o fundo inteiro por quadro e cenas `static` redesenham todo frame — transição é curta (≤ 0,5 s), mantenha assim.

```js
E.run({
  menu:    { fps: 30, update, draw },
  jogando: { fps: 0,  update, draw },   // roda no que a placa der
}, "menu");
```

**Cenas estáticas (menus, pausa, fim de jogo):** `static: true` faz a cena desenhar só na entrada, no `E.redraw()` e quando o dedo entra/sai de um `E.gfx.button` — menu parado não repinta (nem empurra) nada por frame. No painel RGB do SmartDisplay o redesenho integral do menu a 30 fps era o que fazia o vidro "vibrar com flashes":

```js
menu: { static: true,
        update: function () { if (E.hit(this.btn)) E.goto("jogo"); },
        draw: function () { /* tudo 1x */ this.btn = E.gfx.button("JOGAR", ...); } }
```

A cada frame a engine roda, em ordem: troca de cena pendente → dt/fps → poll de input → keep-alive de áudio → câmera → fx → timers → tweens → `update(dt)` → `draw()` → pacing do frame.

**Saindo limpo das cenas:** timers e tweens criados numa cena sobrevivem a ela. Chame `E.clearTimers()`/`E.clearTweens()` no `exit()` (ou cancele handles individuais com `E.cancel(t)`).

## 5. Input

`E.input` é atualizado 1x por frame:

| Campo | Significado |
|---|---|
| `x, y, down` | ponto/estado atual do toque |
| `justDown` / `justUp` | pressionou / soltou neste frame |
| `dx, dy` | movimento desde o frame anterior |
| `holdDx, holdDy` | movimento desde o press (arrasto relativo, ex.: raquete) |
| `moved` | arrasto passou do limiar (`dragThresh`, default 12 px) |
| `tap` | `{x, y}` ao soltar, se curto e (quase) parado (`tapMs` 350 ms) |
| `swipe` | `{dir, dx, dy, dist}` ao soltar, se arrastou ≥ `swipeMin` (30 px) |
| `longpress` | segurou ≥ `longMs` (600 ms) sem arrastar; 1 tiro por toque |
| `btn` | botão físico (devkit): 1 curto, 2 longo |

Os limiares são campos do `E.input` — ajuste por jogo. Hit-test:

```js
if (E.input.tap) { ... }      // tap cru em qualquer lugar
if (E.hit(rect)) { ... }      // tap dentro do {x,y,w,h}
if (E.press(rect)) { ... }    // dedo pressionado dentro agora (highlight de botão)
```

## 6. Desenho (E.gfx)

Todas as funções recebem **coordenadas de mundo** e aplicam a câmera; passe `{screen: true}` para desenhar HUD por cima. Cores são inteiros RGB565 — use `E.theme` (`bg, card, raised, stroke, accent, accentD, onAccent, text, textDim, ok, warn, err`) ou as constantes (`BLACK`, `WHITE`, ...). Tudo cai em primitivas simples em firmware antigo:

```js
E.gfx.rect(x, y, w, h, cor, { fill: true, r: 8 });        // r = cantos arredondados (API 22)
E.gfx.circle(x, y, r, cor, { smooth: true });              // preenchido anti-alias (API 22)
E.gfx.line(x0, y0, x1, y1, cor, { w: 3 });                 // linha grossa (API 22)
E.gfx.tri(x0, y0, x1, y1, x2, y2, cor);
E.gfx.gradient(x, y, w, h, c1, c2, { dir: "y" });
E.gfx.arc(x, y, r0, r1, a0, a1, cor);                      // graus, -90 = cima
E.gfx.text("PONTOS 42", x, y, { ts: "big", align: "center",      // papel (escala com E.U)
                                valign: "middle", color: 0xFFFF, bg: 0x0000 });
E.gfx.text("SUPERNOVA", x, y, { px: E.u(21), fit: W - 20 });      // altura em pixels, encolhe p/ caber
E.gfx.measure("PONTOS 42", { ts: "big" });                        // largura em pixels
E.gfx.button("JOGAR", x, y, w, h, { primary: true });      // devolve o rect p/ E.hit()
E.gfx.bar(x, y, w, h, 0.75);                               // medidor (vida/carga)
E.gfx.panel(x, y, w, h);                                   // card com borda
```

`bg` omitido no `text` = fundo transparente (chamada de 1 argumento do `setTextColor`). Misturar cores: `System.mixColor(c1, c2, pct)` (API 22) — `pct`% do caminho de `c1` até `c2`.

**Escala e tipografia (1.2):** faça o layout em unidades do projeto — `E.u(v)` converte uma medida do desenho de 240 de largura em pixels da tela atual (`E.U` = min(W, H)/240: 1 no canvas virtual, 2 no nativo de 480, ~1,7 no relógio). Texto vai por **altura em pixels**: `px`, ou um papel de `E.ts` (`tiny 9, small 11, body 13, label 15, big 20, title 28, huge 40`, escalados por `E.U`). O `E.font(px)` escolhe entre as fontes do firmware (já promovidas em tela grande: linha de 13/25/42 px no 480) e prefere o glifo nativo nítido a um `textSize` serrilhado. Evite `size` cru: em tela grande o firmware já dobrou a fonte e `size: 3` por cima dá títulos de 75-120 px.

## 7. Câmera

```js
E.cam.follow(player, 0.15);  // lerp rumo a um alvo {x, y} (centralizado na tela)
E.cam.bounds = { x: 0, y: 0, w: 960, h: 320 };  // clamp dentro do mundo
E.cam.shake(5, 0.3);         // potência (px), duração (s) — decai sozinho
E.cam.center(x, y);          // snap
E.cam.reset();               // identidade (chame no enter da cena)
```

`wx()/wy()` convertem mundo→tela se for desenhar com `System.*` cru.

## 8. Entidades: grupos e pools

```js
var inimigos = E.group();
inimigos.add({ x: 10, y: 10, update: function (dt) { this.x += 20 * dt; },
               draw: function () { E.gfx.circle(this.x, this.y, 6, 0xF800); } });
inimigos.update(E.dt);   // o.dead = true → removido sozinho (swap-pop)
inimigos.draw();

var balas = E.pool(32, function () { return { x: 0, y: 0, vx: 0, vy: 0 }; });
var b = balas.spawn();   // objeto reciclado, ou null quando cheio
b.x = 100; b.y = 200; b.dead = false;
balas.update(E.dt); balas.draw();
```

Pools pré-alocam tudo: zero alocação por frame significa zero engasgo de GC. Os dois recipientes têm `each(fn)` para iteração em lote (o do pool pula os mortos — sem laço de catação no seu frame).

**Culling opcional (core 1.6):** `g.draw({cull: true})` (e `pool.draw`)
pulam a entidade cuja caixa (`x/y` + `w/h`, canto superior esquerdo) não
intersecta a câmera; `pad` dá folga em px. **Sem `w/h` conhecido a entidade
desenha sempre** (como um renderer sem extents) e `e.screen` (HUD) nunca é
cullado. Custa uma comparação por entidade e economiza a chamada nativa
inteira — com `drawSprite` a ~1,25 ms, uma horda fora da tela é dinheiro
jogado. O apagamento não é afetado: a camada suja já apaga as caixas do
quadro anterior.

## 9. Sprites e animação

O pool de sprites do firmware tem **16 slots** em placas com PSRAM desde a API 33 (8 antes disso, desde a API 29; 1 sem PSRAM — sprite come RAM interna ali) (`System.spriteSlots()` informa o limite da placa; a engine consulta sozinha). O `E.spr.load` decodifica cada PNG **uma vez** para dentro de um slot e guarda um `paint` procedural de fallback, então o jogo roda mesmo sem os assets ou em placa sem sprites:

```js
E.spr.load([
  { name: "nave", file: "nave", w: 72, h: 72,
    paint: function (w, h, x, y) {           // fallback: desenha com primitivas
      E.gfx.tri(x + w / 2, y, x, y + h, x + w, y + h, E.theme.accent);
    } },
  { name: "inimigo", file: "inimigo", w: 56, h: 56, paint: ... },
]);
E.spr.blit("nave", x, y, { cx: true, cy: true, key: 0x0000 });  // key = cor-chave
```

- Os assets são sondados em `E.spr.bases` (o `init({dir})` monta `/local/apps/<dir>/assets/` e `/sd/apps/<dir>/assets/`).
- **Convenção de transparência:** masterize os PNGs com fundo *preto puro* (a cor-chave) e transforme os pretos internos em quase-preto `(0,0,8)` — o mesmo truque do Supernova. Só sprite em slot aceita a chave; o painter desenha o que você mandar.
- Mais defs que slots → os excedentes viram painter automaticamente. `E.spr.backed(name)` diz se o sprite ganhou slot real (blit com cor-chave rápido) ou vai desenhar pelo painter. `E.caps.slots` guarda o limite sondado (16 em placas PSRAM com API 33+, 8 na API 29–32, 1 sem PSRAM; 4 é o fallback da engine quando `spriteSlots` não existe) — orce suas defs contra ele.

**Spritesheet (spr 1.0):** uma imagem PNG inteira decodifica em UM único slot e cada região nomeada vira nome de sprite de 1a classe — `blit`, `anim` e `backed` funcionam com regiões, sem código novo no jogo. Regiões são `[cx, cy]` em células de `tw x th`, ou rect livre `[x, y, w, h]` em pixels. Economiza slots (16 no máximo) e passes de decode (`drawPNG` custa ~9 ms por chamada no SmartDisplay — um sheet de 16 tiles paga 1 vez só):

```js
E.spr.sheet("tiles", { file: "tiles", w: 128, h: 64, tw: 16, th: 16,
                       regions: { chao: [0, 0], parede: [1, 0], bau: [2, 0],
                                  logo: [64, 0, 24, 12] } });  // rect livre
E.spr.blit("chao", x, y);
var brilho = E.anim(["bau", "chao"], 4);   // flipbook por regiões
// blit de região = setClip no destino + sheet empurrado deslocado; sem
// setClip (firmware velho) cai no paint(nome, x, y)
E.spr.free("chao");       // tira só o nome (o slot é do sheet)
E.spr.freeSheet("tiles"); // devolve o slot e apaga todas as regiões
```

**Giro e escala por eixo (spr 1.7, API 33):** `{angle}` em GRAUS (horário) e
`{scaleX, scaleY}` no `stamp`/`blit`/`anim.draw`. O giro usa o `drawSprite`
nativo e acontece em volta da **âncora** (`ax/ay`) — o pé no chão fica no lugar
ao girar, não o centro — e a caixa suja vira o AABB dos quatro cantos (sem
rastro). Sem giro e com escala uniforme 1 continuam valendo os caminhos
rápidos (`copySprite`/`pushSprite`); com giro ou eixo diferente o custo é o do
afim (~1,25 ms por sprite no 4848 — meça com `E.prof`):

```js
E.spr.stamp("canhao", x, y, { ax: 0.5, ay: 1, angle: 45 });      // girado
E.spr.stamp("nave", x, y, { scaleX: 2, scaleY: 1 });              // esticada
var box = E.spr.box("heroi", x, y, { angle: 90 });                // hitbox girada
```

Limites: **região de folha não gira** — o `drawSprite` desenha o sprite inteiro
e o recorte é retangular, então uma região girada mostraria a célula vizinha; a
engine avisa 1x e desenha sem giro (para girar, carregue o quadro como sprite
próprio com `prescale`/`load`). Placa sem `drawSprite` (CYD/ESP32) idem: avisa
e desenha reto.

Flipbook sem slot extra: os frames são painters (ou nomes de sprite carregado):

```js
var boom = E.anim([function (x, y) { ... }, function (x, y) { ... }], 12, false);
// por frame: boom.tick(E.dt); if (!boom.done) boom.draw(x, y);
```

## 10. FX

```js
E.fx.burst(x, y, { n: 14, colors: [0xFFE0, 0xFD20], speed: 120, life: 0.6,
                   grav: 200, shape: "dot" });   // dot | spark | ring
E.fx.ring(x, y, { speed: 700, color: 0xFFE0 });  // onda de choque (círculo que expande)
E.fx.popText(x, y, "+10", { color: 0xFFE0 });    // pontuação flutuante
E.fx.flash(0xF800, 150);                         // brilho na borda (moldura que some)
E.fx.flash(0xFFFF, 400, { full: true });         // flash de tela cheia (guarde p/ o momento grande)
// stride: N > 1 move cada estrela 1 vez a cada N quadros (escalonado por
// indice), entao so n/N estrelas sujam caixa por quadro - campo de ceu inteiro
// senao faz a uniao suja cobrir a tela de novo. Velocidade media preservada.
var estrelas = E.fx.stars(60, { colors: [0x39E7, 0xC5F9], stride: 4 });  // parallax
estrelas.update(E.dt); estrelas.draw();
E.fx.draw();                                     // chame no FIM do draw da cena
```

Partículas/floaters/flash são tickados pelo loop; só o `draw()` é seu. Além dos bursts, o fx 1.0 tem **fontes contínuas** (zero alocação por frame — o caminho do emissor semeia o pool direto):

```js
// emissor contínuo: rate/s, duration (ms) opcional e follow () => {x, y}
// p/ fonte móvel (null pula o quadro); opts de partícula como no burst
var fogo = E.fx.emitter({ x: 120, y: 200, rate: 40, life: 0.5, size: 3,
                          grav: -60, colors: [0xFD20, 0xF800] });
fogo.stop(); fogo.start(); fogo.set(140, 200);   // handle

// rastro que segue uma entidade — fonte parada não deixa nada
var rastro = E.fx.trail(function () { return nave; }, { rate: 24, life: 0.4 });

// camadas de parallax procedurais rolando com a câmera (speed = fração)
var fundo = E.fx.parallax([
  { speed: 0.2, gap: 44, paint: function (x, y) { E.gfx.circle(x, y, 1, 0x39E7); } },
  { speed: 0.5, gap: 30, paint: function (x, y) { E.gfx.circle(x, y, 1, 0xC5F9); } },
]);
fundo.draw();                                  // 1a linha do draw da cena
E.dirty.enable(function (x, y, w, h) { fundo.draw(x, y, w, h); });  // ou como painter da camada suja
```

## 11. Tweens e timers

Tickados pela engine (não são `setTimeout` — sem limite de 8, determinísticos no harness):

```js
E.tween(botao, { y: 160 }, 500, { ease: E.m.outBack, onDone: function () {} });
E.after(1200, function () { E.goto("fim"); });
var id = E.every(2.5 * 1000, novaOnda);
E.cancel(id); E.clearTimers(); E.clearTweens();

// timeline (core 1.0): passos em ordem no MESMO objeto; {par: [...]} roda
// os filhos juntos e espera o mais longo; cancel() corta a cadeia
var tl = E.seq(nave, [
  { to: { x: 200 }, ms: 400, ease: E.m.outQuad },
  { to: { y: 100 }, ms: 300 },
  { par: [{ to: { x: 0 }, ms: 300 }, { to: { alpha: 1 }, ms: 500 }] },
], { onDone: function () { E.goto("fim"); } });
tl.cancel();
```

Easings: `E.m.linear/inQuad/outQuad/inOutQuad/outBack`.

## 12. Áudio

Desde a API 32 os efeitos são **misturados por cima da trilha** pelo sintetizador (`System.sfx`): o `E.audio.sfx` não trava o loop e toca com a música ligada (`E.caps.mix`). Em firmware anterior há um slot só de alto-falante — `playMusic` OU `playWav`/`playTone` — e o `E.audio` cai no `playTone` bloqueante, educado com a música:

```js
E.audio.music({ bpm: 132, loops: 0, tracks: [
  { wave: "sq",  vol: 70, notes: [[69,4],[71,4],[72,4],[69,4]] },   // [midi, semicolcheias]
  { wave: "tri", vol: 60, drum: true, notes: [[36,2],[0,2],[38,2],[0,2]] },
]});
E.audio.beat();        // posição na batida (1.0 = tempo forte); -1 sem música
E.audio.sfx("coin");   // sfx nomeado (API 32: misturado na trilha; antes: pula com música tocando)
E.audio.sfx([880, 60]);           // ou [freq, ms] cru
E.audio.sfx([[660,60],[0,20],[880,80]]); // ou melodia curta (freq 0 = pausa; um efeito por vez: o mais novo vence)
E.audio.stop(); E.audio.mute(true); E.audio.volume(80);
E.audio.duck(600);  // firmware antigo: abafa a trilha por ms (um sfx alto rouba
                    // o canal) e retoma do ponto onde parou; no-op com
                    // E.caps.mix (o efeito ja soa por cima)
```

A música reinicia sozinha quando os loops acabam (keep-alive). Spawnar na batida: `if (Math.floor(E.audio.beat()) !== ultimaBatida) spawna()`. Voltar de uma pausa: guarde `System.musicPos()` e chame `E.audio.music(song, { startMs: pos })`. Tabela de sfx default: `ui, ok, back, bad, hit, coin, boom, shot, power, over, record, win` — troque entradas no `E.audio.sfxTable`. Placas sem alto-falante (CYD) não fazem nada.

## 13. Save (recordes, ajustes)

NVS (sem permissão), com namespace pelo prefixo `save` do `init`:

```js
E.save.set("skin", "azul");
var skin = E.save.get("skin", "verde");
var recorde = E.save.num("recorde", 0);
if (E.save.best("recorde", pontos)) { /* novo recorde! */ }
```

## 14. Matemática e RNG

`E.m`: `clamp, lerp, map, rand(a,b), randInt, pick, dist, dist2, ang, approach, wrap, sign` + easings. `E.rng(seed)` devolve uma função PRNG determinística — seede a geração do nível e seus testes ficam reprodutíveis.

## 14b. UI de jogo (`celeros.game.ui`, opcional)

O que todo jogo reescrevia: menus, listas com rolagem, diálogos datilografados e as telas de título/pausa/fim prontas. Immediate-mode no estilo do `E.gfx.button` (desenha e devolve o tap no MESMO quadro), tudo com `screen: true` (fora da câmera) e no tema do firmware:

```js
require("celeros.game.ui");

// no draw: menu vertical — devolve o value tocado (ou o label), ou null
var pick = E.ui.menu([{ label: "Jogar", value: "j" },
                      { label: "Opcoes", value: "o" },
                      { label: "Apagar", value: "z", danger: true }]);

// lista com rolagem (retida): arrastar rola, tap seco pega a linha sob o
// scroll; o draw devolve o pick só no quadro do tap (st.picked guarda o
// último pra polling)
var lst = E.ui.list({ items: fases, row: 28, onPick: function (v, i) { ... } });
var pegou = lst.draw(20, 80, 200, 140);   // coords de TELA

// diálogo datilografado: a revelação avança no draw (cena comum, não
// static); tap completa o texto, tap de novo fecha (draw devolve false)
var dlg = E.ui.dialog("A princesa está em outro castelo...", { name: "NPC" });
if (!dlg.draw(20, 230, 200)) dlg = null;  // false = fechou

// telas prontas, desenhadas por cima da sua cena:
if (E.ui.title({ game: "MEU JOGO", best: E.save.num("hi") }) === "start")
  E.goto("jogo", { transition: "fade" });
var a = E.ui.pause({});            // 'resume' | 'restart' | 'quit'
var b = E.ui.gameOver({ score: s, best: hi, isNew: novo });  // 'again' | 'quit'
```

## 14b-2. Kit de UI 1.3: estilo, layout e widgets

O `celeros.game.ui` 1.3 vira o antigo módulo de menu/lista/diálogo em um kit immediate-mode completo. Continua ES5, desenha com `screen: true` e usa o tema do firmware como base. Ele monta em cima das primitivas do core 1.7: `E.color`, `E.gfx.shadow/dim/divider/star`, borda espessa (`bw`), gradientes (`grad`) e `outline` de texto.

### Tokens e presets

```js
E.ui.preset("neon");                            // soft (default) | flat | neon | paper
E.ui.theme({ accent: "#ff5c8a", radius: 14 });  // patch: RGB565 ou '#rrggbb'
E.ui.tokens;                                    // objeto vivo que os widgets leem
E.ui.resetTheme();
```

`E.ui.tokens` carrega `bg/surface/surface2/surface3/outline/text/textDim/accent/accent2/onAccent/ok/warn/err/glow`, mais `radius/gap/pad` (px do projeto) e as flags `shadow` (camadas), `grad`, `bw` e `glowOn`. Os presets: **soft** (sombra/gradiente sutis), **flat** (sem sombra/gradiente), **neon** (borda/glow accent, superfícies escuras) e **paper** (claro, cantos retos). O tema é rederivado de forma lazy quando o app chama `E.init` de novo; preset/patch explícito sobrevive.

### Ícones

`E.ui.icon(name, x, y, size, { color, w })` desenha proceduralmente (sem PNG/sprite): `play pause stop back close check plus minus chevronL/R/U/D gear heart star sound soundOff music home menu search clock lock trash edit info alert refresh download upload`.

### Layout

```js
var c = E.ui.card(8, 40, 224, 140);       // desenha o card e devolve o content rect
var col = E.ui.stack(c.x, c.y, c.w, { gap: 6 });
var r = col.next(34);                    // rect da próxima linha (scratch: use na hora)
E.ui.button("Jogar", r.x, r.y, r.w, r.h);
var grid = E.ui.grid(c.x, c.y, c.w, 3, { rowH: 32 });
E.ui.divider(c.x, c.y, c.w);
E.ui.section("OPCOES", c.x, c.y, c.w, { line: true });
```

`E.ui.card` devolve o **content rect** (o card menos o padding). `stack.next`/`grid.cell` devolvem um rect scratch compartilhado, então use os valores imediatamente. `section` devolve a altura usada.

### Widgets

Todos são immediate-mode e devolvem o novo estado/valor no mesmo quadro:

| Chamada | Devolve |
|---|---|
| `E.ui.button(label, x, y, w, h, o)` | `true` no tap. `variant: primary/secondary/ghost/danger/success`, `icon`, `disabled`, `r`, `grad`, `elev` |
| `E.ui.iconButton(icon, x, y, size, o)` | `true` no tap |
| `E.ui.toggle(x, y, on, o)` | novo `on` (switch) |
| `E.ui.check(label, x, y, on, o)` / `E.ui.radio(...)` | novo `on` |
| `E.ui.slider(x, y, w, value, {min,max,step,id,label,fmt})` | valor arrastado (snap por `step`) |
| `E.ui.stepper(x, y, value, {min,max,step,w,h,fmt})` | novo valor |
| `E.ui.segmented(x, y, w, labels, sel, o)` / `E.ui.tabs(x, y, w, h, labels, sel, o)` | índice selecionado |
| `E.ui.chip(label, x, y, {on,icon,w,h})` | novo `on` |
| `E.ui.badge(text, x, y, o)` | largura desenhada |
| `E.ui.progress(x, y, w, h, frac, o)` / `E.ui.ring(cx, cy, r, frac, o)` | fração limitada |

### Lista rica e scroll genérico

`E.ui.list(o)` mantém a API 1.2 (`items`, `row` = altura da linha, `onPick`, `scroll`, `scrollTo`, `picked`) e ganha:

```js
var lst = E.ui.list({
  items: [
    { section: "FASE 1" },                         // cabeçalho: não selecionável
    { label: "Floresta", value: 1, icon: "play" },
    { label: "Caverna", value: 2, sub: "3 estrelas", right: "1:20" },
    { label: "Chefe", value: 3, badge: "NOVO", danger: true }
  ],
  row: 36, pad: 8, scrollbar: true,
  paintRow: function (item, x, y, w, h, state) {  // painter de linha inteira
    // state = { pressed, disabled, selected }
  }
});
var picked = lst.draw(16, 80, 208, 160);
lst.scrollBy(24); lst.scrollTo(2); lst.index; lst.picked;
```

`E.ui.scroll(id, x, y, w, h, contentH, drawFn)` é o container de scroll genérico (clip + inércia); `drawFn(offset, x, y, w, h)` desenha o conteúdo. `E.ui.scrollTo(id, y)` / `E.ui.resetScroll(id)` controlam.

### Modal, sheet, diálogo, toast e HUD

```js
var act = E.ui.modal("confirm", {
  title: "Apagar?", body: "O save será perdido.",
  buttons: [{ label: "Cancelar", value: 0 }, { label: "Apagar", value: 1, variant: "danger" }]
});                                                   // value | 'dismiss' | null

var close = E.ui.sheet("bag", { h: 180, title: "Inventário" }, function (c) {
  // desenhe dentro de c (content rect)
});                                                   // 'close' | null

var d = E.ui.dialog(fala, { name: "NPC", choices: ["Sim", "Nao"], sound: true });
d.choice;                                             // índice da escolha

E.ui.toast("Salvo!", { type: "ok" });                 // fila de 3, slide/fade
E.ui.hud({ score: 1200, best: 3000, lives: 2, maxLives: 3, time: "1:20" });
```

`E.ui.hud` desenha uma barra no topo com atalhos (`score/best/lives/coins/time/level`) e/ou arrays `left`/`right` de `{ icon, text, color }`. É **memoizado**: na camada suja desenha mudo e só repinta quando a assinatura muda ou algo apaga a caixa (o antigo padrão `hudKey`, embutido). `E.ui.anim(key, target, ms, ease)` devolve 0..1 com easing, usado por modal/sheet; `E.ui.animReset(key)` reinicia.

### Limitações

- **Sem canal alpha**: sombras/véus/opacidade são compostos com `E.color.alpha(c, bg, a)` sobre um fundo **conhecido**; em cena cheia passe o `bg` certo ou desligue a sombra (`shadow: false`).
- **Raio uniforme**: `r` é um raio para os quatro cantos.
- **Gradiente horizontal** (`dir: 'x'`) vira faixas de `step` px (`E.gfx.gradient`) — barato em cards, caro num HUD de tela cheia por quadro.
- **Sem entrada de texto** no UI de jogo (use `System.prompt`/`A.form.askText` do CelerKit), sem z-order (a ordem de desenho é a ordem das chamadas) e sem fontes customizadas (só 1/2/4 do firmware).

## 14c. Módulos para jogos complexos (opcionais)

Seis módulos pequenos, cada um sua própria dep (`app.json` "deps") decorando o
mesmo `E`: adote só o que o jogo precisa. Todos ES5, sem alocar no caminho
quente e testados em `test/sdk/celergame_mods.js`.

| Dep | Dá | Uso típico |
|---|---|---|
| `celeros.game.fsm` | `E.fsm(dono, estados, primeiro)` | IA de inimigo, estados do herói, fases de chefe |
| `celeros.game.events` | `E.on/once/off/emit/emitLater`, `E.bus()` | sistemas desacoplados (placar, som, conquistas) |
| `celeros.game.path` | `E.path.find/los/smooth/grid/follower` | perseguidor A*, linha de visão, rota de patrulha |
| `celeros.game.collide` | `E.collide.rect/circle/test/push/segRect/hash/move` | muitos corpos (hash espacial), move-and-slide de plataforma |
| `celeros.game.pad` | `E.pad.stick/button/draw` | controle na tela para jogo de ação |
| `celeros.game.level` | `E.level.parse/progress` | fases em ASCII com spawns, progressão com desbloqueio |

**FSM.** Estados são `{enter(m, arg), update(m, dt), exit(m, prox), draw(m),
after: [segundos, prox], on: {evento: fn}}`. Um `m.go()` pedido *dentro* de um
callback vale quando ele retorna (nada de entrar num estado no meio do update
de outro). `m.time` são os segundos no estado, `m.data` uma bolsa zerada a
cada entrada, `m.push/pop` empilham um estado (atordoado por cima de qualquer
coisa) e `m.send(ev)` repassa um evento ao estado atual (string devolvida =
transição).

```js
var ia = E.fsm(inimigo, {
  patrulha: { update: function (m, dt) { if (vê(m.owner)) m.go("caca"); } },
  caca:     { update: function (m, dt) { perseguir(m.owner, dt); if (m.time > 4) m.go("patrulha"); },
              on: { dano: function (m) { return "atordoado"; } } },
  atordoado:{ after: [0.8, "caca"] }
}, "patrulha");
```

**Eventos.** Síncronos; ouvinte que devolve `false` para a propagação;
`{prio}` ordena; `{scene: true}` dorme sob um `E.push` e morre quando a cena
dele sai. `E.emitLater` entrega no quadro seguinte (seguro de dentro de um
laço de colisão).

**Caminho.** `E.path.find(cols, rows, c0, r0, c1, r1, custo, {diag, max, near})`
— `custo(c, r)` < 0 é parede; diagonal nunca corta canto de parede; `max` é o
orçamento de nós (padrão 2000), então uma busca grande devolve `null` em vez
de comer o quadro (`near: true` devolve o caminho até a célula alcançável mais
perto). `E.path.grid(tilemap)` adapta o módulo tilemap; `smooth` tira o
zigue-zague da grade por linha de visão; `follower(obj, caminho, vel, {cell})`
anda a entidade por ele.

**Colisão.** As formas são as da engine: retângulo `{x, y, w, h}` (canto) e
círculo `{x, y, r}` (centro). `hash(cell)` é refeito por quadro (`clear` +
`add`) e `query(forma, fn)` chama `fn` uma vez por toque real — tiros x
inimigos sem O(n²). `move(corpo, dx, dy, tilemap)` anda X e depois Y em
passos de meia célula (queda de 400 px não atravessa piso de 16 px), para na
parede, zera `vx/vy` do eixo que bateu e devolve `{hitX, hitY, ground, ceil}`.

```js
var r = E.collide.move(heroi, heroi.vx * dt, heroi.vy * dt, mapa);
if (r.ground && pulo.pressed) heroi.vy = -260;
```

**Pad.** `stick({zone, r, float, dead, dirs})` dá `x/y` em -1..1, `mag`,
`angle`, `dir`; `button({x, y, r, label})` dá `down/pressed/released`.
**As telas são de toque único**: segurar o stick e um botão ao mesmo tempo
não existe — `stick.tap` (tap seco dentro da zona do stick) é a ação "A", e o
botão físico (`E.input.btn`) pode ser a segunda.

**Fases.** `E.level.parse(linhas, {legend, cell})`: valor simples na legenda é
tile, `{spawn: tipo, tile}` é entidade (com o que fica no chão). Caractere
fora da legenda lança com linha e coluna. `lv.data` vai direto no
`E.tilemap({data})`; `lv.spawn({tipo: fabrica})` cria as entidades.
`E.level.progress(lista, {save})` guarda a fase atual, o desbloqueio salvo
(`next()`) e as estrelas por fase (só a melhor).

## 14d. Mais módulos: roteiro, inventário, steering, geração, atributos, ondas

Mais sete deps sobre o mesmo `E` (testadas em `test/sdk/celergame_r3.js`):

| Dep | Dá | Uso típico |
|---|---|---|
| `celeros.game.script` | `E.script(passos, {onDone})` | cutscene, tutorial, coreografia de chefe |
| `celeros.game.inv` | `E.inv.items(defs)`, `E.inv.bag({slots})` | mochila de RPG, cinto de poções, baú, loja |
| `celeros.game.steer` | `E.steer.agent(obj, {speed, force})` | morcego, peixe, nave, bando em espaço aberto |
| `celeros.game.gen` | `E.gen.rooms/cave/maze/scatter/lines` | masmorra de roguelike, caverna, labirinto por semente |
| `celeros.game.stats` | `E.stats(base, {iframes, xp})` | vida com invencibilidade, buffs, recargas, XP/nível |
| `celeros.game.rpg` | `E.rpg` — stats + inv + script num bundle só | cérebro de personagem dentro do teto de 8 deps (o kit usa) |
| `celeros.game.waves` | `E.waves(lista, {spawn, alive})` | diretor de ondas de shooter / tower defense / arena |

**Script.** Lista de passos rodados em ordem no tick da engine (tempo de jogo:
congela no `E.pause`, segue o `E.timeScale`): `{call: fn}` (instantâneo),
`{wait: ms}`, `{tween: obj, to, ms}` (espera terminar), `{until: fn}`, `{tap: true}`,
`{par: [...]}` (filhos juntos, espera todos), `{label}` + `{loop: label, times}`,
`{emit: nome, arg}`, `{scene: nome}`, ou uma função chamada a cada quadro até
devolver algo diferente de `false`. O roteiro é da cena onde nasceu (dorme sob
`E.push`, morre quando a cena sai; `{global: true}` sobrevive). `s.skip()`
termina na hora: tweens vão ao valor final, esperas acabam e os `{call}`
restantes rodam.

```js
E.script([
  { call: function () { heroi.trava = true; } },
  { tween: E.cam, to: { y: 200 }, ms: 800 },   // mostra a porta
  { wait: 500 },
  { call: function () { porta.abre(); } },
  { until: function () { return porta.aberta; } },
  { tween: E.cam, to: { y: 0 }, ms: 600 },
  { call: function () { heroi.trava = false; } }
]);
```

**Inv.** `E.inv.items({pocao: {max: 9, use: fn}})` registra as definições
(`use(item, bag)` devolvendo `true` gasta um). `bag.add(id, n)` completa as
pilhas existentes primeiro e devolve o que não coube; `remove`, `count`, `has`,
`fits`, `move(i, j)` (mesmo item junta, outro troca), `split`, `use(i)`, `sort()`
(junta e ordena pelo registro), `save(chave)` / `restore(chave)` pelo `E.save`.

**Steer.** Steering de Reynolds: cada chamada soma uma força ponderada no
quadro — `seek`, `flee(x, y, w, raio)`, `arrive(x, y, freio)`, `pursue/evade(alvo)`,
`wander`, `separate/align/cohere(lista, raio)` (boids), `within(rect, margem)` —
e `update(dt)` limita força e velocidade, move o `obj` e zera. Em labirinto use
`celeros.game.path` e passe o próximo ponto ao `arrive`.

**Gen.** Grades de caracteres (`grid[r][c]`) que vão direto no
`E.level.parse(E.gen.lines(grid), ...)`: `rooms(cols, rows, {rnd, rooms})` (salas
sem sobrepor ligadas por corredores em L — toda sala alcançável),
`cave(cols, rows, {fill, steps})` (autômato celular; fica só a maior região
livre), `maze(cols, rows, {loops})` (labirinto perfeito, backtracking iterativo),
`scatter(grid, ch, n, {minDist})`. Passe `rnd: E.rng(semente)`: mesma semente,
mesma fase. Gere na entrada da fase, nunca por quadro.

**Stats.** `E.stats({hp: 10, atk: 3, def: 1}, {iframes: 600, onDeath, xp})`:
`get(nome)` = (base + adds) x muls; `mod(nome, {add, mul, ms, id})` (o mesmo `id`
substitui — poção tomada duas vezes renova em vez de empilhar); `damage(n,
{pierce, force})` tira a `def` com mínimo 1 e devolve 0 na janela de
invencibilidade; `heal`, `revive`, `frac()`; `cool(nome, ms)` devolve `true` e
começa a recarga quando pronta (`coolFrac` para o ícone da habilidade);
`addXp(n)` sobe de nível pela curva `base * grow^(nivel-1)`. Tudo no relógio do
jogo (`E.stats.now()`), congelado pelo `E.pause`.

**Waves.** `E.waves([{type, n, every}, {groups: [...], rest}], {spawn(tipo, w, i),
alive(), onWave, onClear, onDone, endless: {grow}})`: nasce no ritmo, espera o
`alive()` zerar, descansa e começa a próxima; `endless` repete a última onda
crescendo `grow`. Estados: `wait`, `spawn`, `clear`, `done`.

## 14e. Ação e aventura: combate e salas do tamanho da tela (rodada 4)

Mais duas deps, feitas para a aventura de cima *Lenda de Celer* (em
`hub_apps/`, o jogo de referência), testadas em `test/sdk/celergame_r4.js`:

| Dep | Dá | Uso típico |
|---|---|---|
| `celeros.game.combat` | `E.combat.body/hit/sword/blast/shot/move/knock` | times, golpe de espada, explosão, projéteis e bumerangue, knockback, hitstop |
| `celeros.game.world` | `E.world({areas, paint, solid, ...})` | overworld/masmorra em salas do tamanho da tela, troca deslizando, estado persistente por sala, minimapa |
| `celeros.game.kit` | collide, level, fsm, events, path, steer, stats, inv, script + `E.sfx` numa dep SÓ | jogos complexos dentro do teto de 8 deps do `app.json` |

**Combat.** `E.combat.body(ent, {team, stats})` registra um alvo. A caixa de
dano é o retângulo de canto da entidade `{x, y, w, h}`, o mesmo do
`collide.move`. Formas de acertar:
- `hit(dono, forma | fn, {dmg, knock, ms, once, stun})` mantém uma hitbox viva
  por ms. Forma em função segue o dono.
- `sword(dono, dir, {reach, width})` é o golpe à frente do dono.
- `blast(x, y, r)` é a bomba e fere todos os times.
- `shot(dono, {x, y, vx, vy, map, boomerang: {range, speed}})` dispara um
  projétil. Ele some na parede do `map`; o bumerangue vai, atravessa, atordoa e
  volta ao dono.

O dano passa pelo `stats.damage`, então os iframes valem. O golpe que acerta:
- empurra o alvo com `knock` px/s, decaindo em `knockMs`;
- chama `E.freeze(E.combat.hitstop)`;
- emite `hit`/`kill` quando o módulo events está carregado.

Mova quem leva empurrão com `E.combat.move(ent, dt, map)`, que também desliza
na parede.

```js
E.combat.body(heroi, { team: "heroi", stats: heroi.st });
E.combat.body(polvo, { team: "monstro", stats: polvo.st,
                       onKill: function (p) { p.dead = true; E.fx.play("poof", p.x, p.y); } });
if (botaoA.pressed) E.combat.sword(heroi, heroi.dir, { dmg: 1, knock: 240 });
E.combat.move(heroi, dt, W);   // W = o mundo: mapa de colisão
```

**World.** Uma área é uma grade de salas; cada sala é um mapa ASCII parseado
pelo `E.level` (`areas: {campo: {w: 4, h: 3, rooms: {"0,0": [...]}}}`).
- `W.go(area, c, r)` entra na sala. A sala é desenhada uma vez (`paint` por
  célula, com `E.spr.stamp`) num sprite do tamanho da tela.
- `E.dirty.enable(W.painter)` repinta desse sprite com um `blitSprite` por
  caixa suja, sem redesenhar tiles.
- `W.edge(ent)` + `W.move(dir)` deslizam para a vizinha. Enquanto
  `W.sliding` for true o jogo espera, os dois sprites de sala são empurrados
  deslocados e `W.slideShift()` posiciona o herói.
- Sem slot de sprite livre ou sem `drawSprite` (API 33), o mundo pinta célula
  a célula e a troca de sala vira corte.
- `W.set(c, r, v, true)` (baú aberto, porta destrancada) e `W.take(spawn)`
  (chave pega) persistem por sala no `E.save` (`save: chave`). `W.flag/gflag`
  guardam qualquer outro estado, e `W.restore()` os carrega de volta.
- `anim: {ms, frames: {agua: ["agua", "agua2"]}}` anima células.
- `W.minimap(x, y)` desenha as salas visitadas.
- `W` também é um mapa de colisão (`solidAt/rectSolid/cw/ch`) para
  `collide.move`, `combat.shot` e `path` (`W.cost`).

**Multitoque (core 1.4 + pad 1.2, API 43).**
- `E.input.touches` lista os dedos no vidro por `id`, cada um com `x/y`,
  `sx/sy` (onde pousou), `down`, `justDown`, `justUp`, `heldMs` e `moved`. O
  dedo que levanta fica um quadro com `justUp`. `E.input.finger(id)` acha um
  dedo; `E.caps.multi` diz que o vidro é multitoque.
- O core lê `System.getTouches()` uma vez por quadro. O dedo primário segue
  alimentando `E.input.x/y/tap/swipe`. Quando ele levanta com outro dedo na
  tela, isso vira soltura seguida de toque novo, nunca um pulo lido como
  swipe.
- Com o `celeros.game.pad` 1.2 cada controle pega o dedo que pousa nele e o
  segue até levantar. Andar com o stick e apertar A e B ao mesmo tempo
  funciona na 4848 (5 dedos) e no relógio.
- Vidro de toque único (CYD) e firmware antigo funcionam como antes
  (`stick.tap` é a ação). `stick({follow: true})` arrasta o centro junto com
  o dedo.

**Core 1.4 e o resto da rodada 4.**
- Core: `E.freeze(ms)` (hitstop: dt 0 no update, nos módulos e no fx) e
  `E.save.slot(n)` (arquivos de jogo 1..3 no mesmo prefixo).
- spr 1.4:
  - `E.spr.stamp(nome, x, y, {scale, key})` desenha sprite ou região de folha
    no alvo CORRENTE — o quadro ou um sprite selecionado com `useSprite`, que é
    como as salas são gravadas — com escala via `drawSprite`.
  - `E.anim.dir({down, up, left, right}, fps)` acrescenta `face(dir)` /
    `walk(on)`.
- ui 1.2: `E.ui.dialog([...páginas], {realtime, tap: false})` + `d.next()`
  (avança pelo botão A do pad).
- fx 1.4: presets `corte`, `poof`, `brilho`, `pedrinha` e `play(..., {dir})`.
- stats 1.1: `damage(n, {dir})`, `blink()` para o pisca dos iframes,
  `hpMax()`, `full()`.
- sfx 1.4: sons de aventura originais (`espada`, `porta`, `segredo`, `item`,
  `chave`, `bumerangue`, `queda`, `escada`, `cristal`).

## 14f. Cena e prefab como dado (`celeros.game.scene`, opcional)

Quando o mapa tem **entidades** (inimigos, baús, gatilhos, spawn points) e não só
tiles, o `celeros.game.scene` deixa o layout fora do código. A lista mora num
módulo de dados do app — não `.json`: ler arquivo exige a permissão `fs` e o
diálogo de consentimento; um `require` não pede nada.

```js
// fase1.js — só dado
module.exports = [
  { tipo: 'goblin', x: 300, y: 200, hp: 5, nome: 'chefe' },
  { tipo: 'bau',    x: 120, y: 210, abre: '#chefe' },      // referência por nome
  { tipo: 'saida',  x: 420, y: 210, precisa: '#chefe' }
];

// jogo.js
var E = require('celeros.game'); require('celeros.game.scene');
E.scene.def('goblin', {
  campos: ['hp', 'vel'], defaults: { vel: 20 },
  create: function (p) { return criaGoblin(p); },   // objeto com update/draw
  start: function (e) { e.anim = E.anim(CLIPES.goblin, 8); }
});
E.scene.def('bau', { campos: ['abre'], create: function () { return criaBau(); } });
E.scene.def('saida', { campos: ['precisa'], create: function () { return criaSaida(); } });

var grupo = E.group();
E.scene.instantiate(require('fase1'), grupo);      // prefab posicionado: {x, y} desloca
```

As três fases do `instantiate` são o contrato: **cria todas** → **resolve as
referências** (`"#nome"` ou `"#id"`) → **chama `start`**. Nenhum `start` vê
referência nula, então a ordem da lista não importa. Quem nasce depois (spawn em
runtime) resolve com `E.scene.resolve(ent, grupo)` — a referência sem alvo fica
como string no dado, não vira `undefined` silencioso.

Persistir o mundo é uma linha, e o resultado é JSON-safe (o `save` reemite a
referência como `"#nome"`, não o objeto inteiro):

```js
var dados = E.scene.save(grupo);          // {version: 1, entidades: [...]}
E.save.setObj('mundo', dados);            // ou FS.writeFile com permissão fs
// depois:
var novos = E.scene.load(E.save.obj('mundo', null), grupo);   // ids novos, refs re-resolvidas
```

Compatibilidade, que é o motivo de o formato ter `version`: dado de versão
**maior** é recusado inteiro (`load` devolve `null` e avisa no log) em vez de
carregar pela metade; de versão menor passa pelas migrações registradas com
`E.scene.migra(0, function (rec) { rec.hp = rec.vida; delete rec.vida; })`.
Campo desconhecido sobrevive ao `save` (um arquivo mais novo não perde dados ao
passar por esta engine) e renomear campo tem caminho no `def`:
`rename: { hp: 'vida' }` lê a chave antiga quando a nova falta e o save deixa de
emitir a velha.

Custo: é módulo, não core — quem não adota não paga. Prefabs nomeados
(`E.scene.prefab('sala1', lista)` e `instantiate('sala1')`) reusam o mesmo dado
em vários mapas.

## 14g. Hierarquia de transform (`celeros.game.node`, opcional)

Partes articuladas (canhão na torre, chama no estopim, HUD composto) sem conta
na mão. O filho **segue** o pai: cada tick escreve `e.x/e.y` de MUNDO a partir
do offset local, da rotação (graus) e da escala — desenho, colisão e camada
suja continuam lendo `e.x/e.y` como sempre.

```js
var E = require("celeros.game"); require("celeros.game.node");
E.node.attach(canhao, torre, { ox: 0, oy: -6 });      // canhao segue a torre
// no update, depois de mover a torre:
torre.x += 20;
E.node.tick();                                        // aplica ja
E.spr.stamp("canhao", canhao.x, canhao.y, { angle: E.node.rotOf(canhao) });
```

- `attach(filho, pai, {ox, oy, rot, sx, sy})` recusa ciclo (avisa 1x);
  `detach(filho)` solta e o filho **fica onde está**; `setPos(filho, ox, oy,
  rot)` é o setter combinado do offset; `wx/wy/rotOf/scaleXOf/parentOf` leem o
  mundo.
- **`E.node.tick()` já roda no começo do quadro** (registrado em
  `E._modTicks`): o filho usa o mundo do **quadro anterior**. Para zero atraso,
  chame de novo no fim do `update`, depois de mover o pai (é barato: uma cadeia
  de multiplicações, com caminho sem `sin/cos` quando o pai não gira).
- Posição de filho é do `setPos`/`rot`, não de `e.x` (o tick sobrescreve).
- Escala não uniforme em pai girado não é representável por (rotação, escala):
  o resultado combina e pode cisalhar — evite.
- Na cena como dado, o registro ganha `pai: "#nome"` (+ `ox/oy/rot/sx/sy`) e o
  `instantiate` liga antes do `start`; o `save` reemite os offsets vivos. Exige
  o módulo adotado (a cena não o arrasta como dependência).

## 15. Física (`celeros.physics`, opcional)

**A maioria dos jogos não precisa de módulo de física.** Num device
Duktape, um mundo objeto-por-corpo paga pressão de GC que cresce com o
número de corpos — os jogos da própria loja aprenderam isso em produção (o
Supernova largou o módulo quando ~85 corpos sensor por frame trouxeram
engasgos de GC) e convergiram para a mesma escada. Só suba o degrau que o
jogo pedir:

| Degrau | Estilo de jogo | Ferramenta | Referência |
|---|---|---|---|
| **0 — nenhuma** | Arcade com até poucas dezenas de corpos: pong, breakout, runners, shooters | Pools pré-alocados + testes de distância/AABB + reflexão, na mão | Template Quica, Supernova |
| **1 — Verlet** | Cordas, panos, soft bodies, sandboxes de pontos | `P.verletFast` → `System.verlet*` nativo (API 31, **todas as placas**; cai sozinho no verlet JS em firmware antigo) | Physics Drop |
| **2 — Rígido** | Pilhas que tombam, destruição, estilingues | `P.rigid` → `System.rigid*` nativo (API 33, placas S3 com PSRAM) | Arrasa! |

Campos de perseguição **não** são física: o módulo disso é o `celeros.grid`
(BFS — os perseguidores do Detona usam).

Coordenadas em tudo: y cresce para **baixo** (tela); o `x, y` do corpo é o
**centro**; corpo circular tem `r`, caixa `w/h`. Nenhuma chamada a `System`
na matemática, então testa unitariamente em qualquer lugar.

### Degrau 0: pools + reflexão (o default)

Corpos num array pré-alocado (`{x, y, vx, vy, r}` — campos crus, nada criado
por frame), integra na mão, reflete nas paredes e teste raquete/plataforma
por **travessia**: o corpo cruzou a superfície quando
`prevY + r <= topo && novoY + r > topo` e está dentro do alcance horizontal —
isso é à prova de túnel e não precisa de sub-passos. O template Quica é o
exemplo completo; o Supernova roda balas/inimigos em pools com checagem por
distância do mesmo jeito. É também o degrau mais amigo do GC: zero alocação
dentro do frame.

### Degrau 1: corda / pano / softbody (`P.verletFast`)

```js
var P = require("celeros.physics");
var w = P.verletFast({ iterations: 4, radius: 2.5 });  // radius > 0 = nós com corpo (colidem)
var a = w.add(120, 30), b = w.add(120, 60);
w.stick(a, b);                    // len default = distância atual
w.pin(a);                         // prega o no no ar
w.step(dt, { gravity: { x: 0, y: 900 }, damp: 0.999,
             bounds: { x: 0, y: 0, w: 240, h: 320 }, bounce: 0.8 });
var xy = w.xy();                  // [x0, y0, x1, y1, ...] plano
```

Na API 31+ o mundo vive em floats C++ fora do heap Duktape
(`w.native === true`); firmware antigo roda transparentemente o verlet JS
com a mesma interface (sem colisão ponto-ponto). Acesso por índice,
`delPoint`/`delStick` para cirurgia, `pins()` lê as pregas. Exemplo
completo: Physics Drop (pintar, pegar-e-arremessar, pino, tesoura, apagar).

### Degrau 2: corpo rígido (`P.rigid`, API 33)

Para castelos de tábuas que tombam, rodas e jogos de "jogar a pedra na
torre", o `P.rigid()` usa o solver de corpo rígido nativo do firmware
(API 33, placas S3; `System.rigid*`): caixas e círculos que giram, atrito,
restituição, pilhas que dormem e sub-passos anti-túnel. Por índice como o
`verletFast`; o `state()` devolve 6 números por corpo (`x, y, angle, hit,
speed, flags`) e o `hit` (impulso do impacto no último step) é o que vira
dano. **Sem fallback JS**: devolve `null` em firmware sem o binding — avise
o jogador para atualizar.

```js
var w = P.rigid({ iterations: 10 });
w.box(160, 300, 400, 20, { static: true });                  // chão
var tabua = w.box(200, 260, 48, 6, { density: 0.6, friction: 0.7 });
var pedra = w.circle(40, 200, 6, { density: 3, bounce: 0.3 });
w.set(pedra, 40, 200, 0, 420, -40, 0);                       // lança
w.step(dt, { gravity: { x: 0, y: 400 } });
var s = w.state();
if (w.hit(tabua, s) / massaTabua > 55) w.remove(tabua);      // quebrou
System.drawSprite(sprTabua, w.x(tabua, s), w.y(tabua, s), w.angle(tabua, s) * 57.2958, 1, 1, 0);
```

O `state()` devolve o **mesmo array** a cada chamada, preenchido no lugar
(physics 2.1: nada de 6 x n números novos por quadro para o GC); faça
`slice()` se precisar do retrato do quadro anterior. Nos laços por corpo
leia por índice — `s[i * w.N + 5] & 1` (vivo), `& 2` (acordado),
`s[i * w.N]` (x) — porque `w.x(i, s)` e cia. são chamadas de função, e no
Duktape uma chamada custa mais que o resto do corpo do laço.

O `System.drawSprite` (também API 33) desenha um sprite girado e escalado
em torno do centro — o par natural dos corpos que giram; com `smooth` ele
também redimensiona a arte uma vez no load para a tela da placa. Exemplo
completo: `hub_apps/Arrasa` (estilingue contra fortalezas de goblins).

### Sobreposição estática: `P.hit`

`P.hit(a, b)` responde "esses dois círculos/caixas se sobrepõem agora" (todas
as combinações) — útil para pickups e testes de UI, sem mundo envolvido.

### Legado: `P.world`, `P.tiles`, `P.flow` (saíram na 2.0)

O módulo 1.x embarcava um mundo arcade interpretado (`P.world` + tilemaps
`P.tiles`) e um campo BFS (`P.flow`). Saíram na **2.0.0**: zero consumidores
na loja, e o mundo interpretado era exatamente a armadilha de GC que o degrau
0 evita (quem usava já tinha migrado — o Supernova para pools, o Detona para o
`celeros.grid`; campo de perseguição mora no `celeros.grid`). Apps em `^1.x`
continuam resolvendo a 1.5.0 do hub como sempre.

### Receitas

- **Platformer:** degrau 0 — herói AABB contra o tilemap, move X depois Y, pousa e pula quando o passo do Y acha chão; `grounded` é "o passo do Y colidiu neste frame". A câmera dá `follow` no herói.
- **Breakout:** degrau 0 — o padrão do Quica com tijolos como grade de flags vivas; o teste de travessia da bola por aresta do tijolo é o mesmo da raquete.
- **Shooter top-down:** degrau 0 — `vx/vy` pelo input com fator de arrasto; inimigos/balas em pools, checagem por distância para acertos.
- **Bomberman:** estado de grade, não corpos — `celeros.grid` para consultas sólido/oneway e caminhos dos perseguidores; a explosão anda pela grade para fora a partir do centro, um bloco macio de profundidade (é o Detona hoje).

## 16. Canvas nativo (tela cheia, API 28)

`E.init({ native: true })` troca desenho/toque para os **pixels físicos do vidro** (ex.: 480×480 no SmartDisplay em vez do 240×320 escalado) — mais nítido e rápido para jogos fullscreen, mas as formas deixam de ser escaladas uniformemente. Exige `"topbar": false` no `app.json` (sem isso o pedido falha graciosamente e `E.caps.native` fica false — sempre ramifique por ele). `E.W/E.H` refletem o modo ativo.

## 16b. Render sem tremor (engine 1.2)

O quadro é **persistente** e o firmware só empurra ao vidro as caixas que você desenhou (até 8 caixas sujas por quadro desde a API 32 — antes, a união de tudo). Então o quadro mais barato é o que toca menos pixels:

- **Menus:** cenas `static: true` (§4).
- **Ação em fundo liso:** `E.dirty.enable(corDeFundo)` no `enter`. Todo desenho da engine (`E.gfx.*`, `E.spr.blit`, `E.fx`, texto) registra sua caixa de tela; no quadro seguinte a engine repinta só essas caixas com o fundo antes do seu `draw`. Sem `fillScreen`. Desenho direto via `System.*` registra com `E.dirty.add(x, y, w, h)`. O `E.fx.stars` apaga os próprios pixels antigos e só repinta estrela que moveu (a que foi coberta por algo desenhado por cima cura no próximo tick dela).
- **HUD:** `E.dirty.clip(x, y, w, h)` mantém o apagar e o mundo dentro da arena; chame `E.dirty.unclip()` e redesenhe o HUD só quando os valores mudam (guarde uma string-chave).
- **Mundos de tiles:** `E.tilemap({ cols, rows, cell, ox, oy, paint(c, r, x, y, w, h) })` mantém o cenário no quadro; `E.dirty.enable(function (x, y, w, h) { mapa.markRect(x, y, w, h); })` marca as células sob o que se moveu, `mapa.mark(c, r)` as que mudaram (bloco quebrado), e `mapa.flush()` no topo do `draw` repinta só elas. O que o `paint` desenha é fundo — nunca entra na camada suja.
- **O que está parado fica fora da camada:** corpo que não se mexeu (dormindo na física, mesma pose do quadro anterior) só é desenhado quando `E.dirty.touches(caixa)` diz que a borracha o tocou, e não registra nada — castelo dormindo não custa apagar, redesenhar nem push. Quando ele volta a se mexer, o desenho velho não tem caixa para a borracha apagar: chame `E.dirty.erase(x, y, w, h)` (1.2.4) na última caixa dele no **topo** do `draw` — repinta o fundo na hora e registra a caixa, e o que for desenhado depois vê o toque e se redesenha. O `hub_apps/Arrasa` faz isso com o castelo, o estilingue e o nome da fase.
- **Fundo em sprite:** com um sprite de fundo de tela inteira, o painter é `System.blitSprite(fundo, x, y, w, h)` (API 34, placas S3: uma chamada no lugar de `setClip` + `useSprite` + `pushSprite` + `useSprite(0)` + `clearClip` por caixa); detecte e mantenha o caminho de 5 chamadas para firmware antigo.
- `E.dirty.full()` repinta o fundo inteiro no próximo quadro (troca de cena e flash de tela cheia fazem por você); a camada desliga sozinha a cada troca de cena.

```js
jogo: {
  enter: function () { E.dirty.enable(0x0000); E.dirty.clip(0, HUD_H, W, H - HUD_H); },
  draw: function () {
    desenhaMundo();              // E.gfx / E.spr — caixas registradas sozinhas
    E.fx.draw();
    E.dirty.unclip();
    if (chaveHud() !== ultimaChave) desenhaHud();
  }
}
```

## 17. Testando seu jogo

O harness roda seu jogo sem tela, com relógio virtual — física, engine e tudo:

```js
// MeuJogo/test.js (dev-only, nunca publicado)
module.exports.wire = function (env) {
  env.__harness.tap(120, 178);                       // aperta JOGAR
  env.setTimeout(function () {
    if (typeof __harness !== "undefined") { /* o app expôs hooks no __harness */ }
  }, 2000);
};
```

```bash
node tools/sdk/celer.js test MeuJogo       # rodada headless
node tools/sdk/celer.js emu MeuJogo --serve --open       # preview ao vivo: jogue o jogo
node tools/sdk/celer.js emu MeuJogo --ms 2000 --out tela.png
node tools/sdk/celer.js emu MeuJogo --frames 0,600,1500   # PNG por marco + diff de pixels
node tools/sdk/celer.js emu MeuJogo --gif rodada.gif --ms 4000 --fps 20 --seed 7
node tools/sdk/celer.js emu MeuJogo --input toques.txt --frames 0,600,1500
```

No preview ao vivo o ponteiro/arrasto na tela é toque de verdade, setas/WASD
sintetizam um swipe do centro (Snake/2048/menus), espaço toca no ponteiro,
`P` pausa e `R` reinicia o app (hot reload ao salvar é automático). O botão
**Gravar** registra a sessão e baixa um `toques.txt` no formato exato do
`--input`: jogue uma vez na mão e depois reproduza headless. Um arquivo de
entrada roteirizada dispensa o `test.js`:

```
# toques.txt — tempo em ms do app, depois o gesto
0    tap 120,200          # JOGAR
600  swipe 120,240 120,80 6
900  down 120,160
980  move 150,180
1100 up 150,180
```

`--seed` fixa o `Math.random` (mesma semente = mesma rodada), `--grid`
desenha a grade de coordenadas no PNG e `--mark 120,200` marca um ponto —
o jeito mais rápido de achar as coordenadas de toque de um botão.

No app, exponha um hook de introspecção tipo `if (typeof __harness !== "undefined") __harness.meuJogo = { state: ... };` e dirija tudo deterministicamente (veja o padrão do test.js do Supernova).

## 18. Tamanho e performance

- As deps somam no teto do app (cada jogo as compila no próprio heap) — **adopte só o que usa**: core ~51 KB enxutos, fx ~13, ui ~12, spr ~12, tilemap ~4 (família inteira ~171 KB). Como o core sozinho já passa de 48 KB, app com a engine declara `"requires": ["psram"]` (teto de 1 MB). O hub mede as deps **como publicadas**: o `celerhub publish-dep` as sobe pelo `tools/sdk/lib/jsstrip.js` (porte 1:1 do JsStripper do firmware — sem comentários/indentação, quebras mantidas, então a linha do erro bate com o fonte), que é exatamente o que o aparelho compila.
- **Zero alocação por frame**: use `E.pool`, remoção swap-pop e reúso de objetos. Um `new`/`[...]` por frame por entidade é o que dispara pausa de GC. Desde a engine 1.2.3 os wrappers também não alocam: chamadas de `E.gfx.*` sem opts compartilham um objeto só de leitura, a busca do `E.font` é memoizada e a largura de cada string (`textWidth`) é medida uma vez por estilo — HUD/placar/botão repetidos não custam chamadas de firmware.
- Se você chama `System.setTextDatum` direto, devolva o `0` ao terminar: a engine 1.2.3 só toca no datum quando o texto pede origem diferente do default, então o `E.gfx.text` confia que o app o deixou em `0` (todos os apps do repo já fazem).
- Evite `fillScreen` + redesenho total por frame: no painel RGB do SmartDisplay (framebuffer varrido da PSRAM) isso estrangula o DMA do LCD e a imagem treme. Use cenas `static`, `E.dirty` e `E.tilemap` (§16b).
- `world.step` é O(n²) no número de corpos no pior caso, mas um **sweep-and-prune** (corpos ordenados por x a cada sub-passo, corte cedo pela distância em x) o mantém quase linear em cenas espalhadas — shooters com ~40 corpos rodam folgados.
- O `E.audio.sfx` não bloqueia na API 32 (`System.sfx`); em firmware anterior é **bloqueante** (`playTone`): mantenha as melodias abaixo de ~300 ms.
- Rajada de JS puro acima de ~1 s esbarra no exec-timeout do firmware — o loop do `E.run` cede todo frame, então fique dentro dele.

## 18c. Rodada de performance (core 1.4.2, spr 1.5, ui 1.2.1, collide 1.2, path 1.1.1, pad 1.2.2)

Medido no SmartDisplay 4848 sem teto de fps. O Detona foi de 17,8 para 25 fps, a Lenda segura
33 fps com diálogo aberto (eram 18) e o Supernova foi de 4 para 7 fps só pelo lado do jogo. As
regras abaixo foram o que fez a diferença.

- **Nunca desenhe sprite com escala por quadro.** `E.spr.stamp(nome, x, y, {scale})` com escala
  diferente de 1 vai pelo `drawSprite` afim, ~1,25 ms por chamada. Grave os quadros uma vez com
  `E.spr.prescale([[nome, escala, novoNome], ...], {key})`. Todos vão para UM slot, e os nomes
  novos desenham em escala 1 pelo `pushSprite`. Sem slot livre, `drawSprite` ou `setClip`, os
  nomes novos viram apelidos do original naquela escala, então o jogo mantém um caminho só.
- **Grave o fundo estático.** Fundo estampado todo quadro, ou célula de 64 px por célula no
  painter da camada suja, deve ser gravado uma vez num sprite do tamanho da tela. O painter vira
  um único `System.blitSprite(id, x, y, w, h)` por caixa suja (API 34; detecte com `typeof`).
- **Menu é `static`.** Título ou fim de jogo sem `static` repinta a tela inteira todo quadro. A
  cena static só redesenha no `E.redraw()` ou quando o dedo entra ou sai de um `E.gfx.button`. Se
  um toque fora dos botões precisa agir, chame `E.redraw()` no `update` quando houver
  `E.input.tap`.
- **Pausa desenha o véu uma vez.** Empilhe uma cena de pausa static (`E.push('pausa')`). Não
  desenhe `E.ui.pause` todo quadro sobre a camada suja viva: isso repinta o campo inteiro por
  baixo do véu.
- **Campo de IA sob demanda.** O `E.path.flow` com custo uniforme (1 ou parede, sem diagonal)
  agora roda como BFS. Calcular campo de fluxo 2x a cada 0,5 s para bicho que nem segue custava
  ~32 ms por campo no Detona. Use como chave a célula do jogador mais uma versão da grade.
- **Poucos pixels espalhados.** O firmware guarda até 32 caixas sujas (eram 8). Centenas de
  desenhos de 1 px espalhados (estrelas, poeira) ainda viram uniões grandes, e o present copia
  essas uniões para o painel.
- **Conte chamadas de função, não só de desenho.** Medido no 4848: uma chamada de função JS vazia
  custa ~15 µs, `Math.round` ou `System.millis` ~20 µs, `drawPixel` ~35 µs, `fillRect` 3x3 ~40 µs,
  `blitSprite` 32x32 ~100 µs, `fillSmoothCircle` r4 ~140 µs, `drawString` ~180 µs. Camadas de helper,
  callbacks por célula e funções de teste por par dentro do laço do quadro custam mais que os pixels
  que desenham. Desde o core 1.4.4 os wrappers do `E.gfx` arredondam inline (sem `px`/`cam.wx`/
  `Math.round` por coordenada), o `fx.stars` desenha só as estrelas cujo pixel mudou e o `combat`
  1.0.2 filtra time e dono antes de um teste de forma inline.
- Correções da engine que vêm de graça:
  - O tap dura até o ÚLTIMO quadro com o dedo no vidro. Um quadro lento entre o aperto e a
    soltura não engole mais o toque; os botões do `pad` seguem a mesma regra.
  - O `ui.dialog` com camada suja só redesenha quando o texto revelado muda.
  - O `gfx.hearts` pinta cada coração cheio uma vez.
  - O lerp da câmera é corrigido pelo dt (calibrado em 30 fps).
  - Partícula fora da tela não é desenhada.
  - `E.save.set` e `setObj` devolvem `false` e avisam no log o erro da NVS (chave acima de 15
    chars, valor acima de 4 KB) em vez de falhar calados.
  - Estilos de texto com `font`/`size` crus são memoizados.
  - O `collide.hash` usa baldes numéricos (sem chave string por célula).
- Firmware (mesma API):
  - O GC completo periódico roda a cada 10 s nas placas com PSRAM (era a cada 1 s: ~40 ms, um
    quadro perdido por segundo em jogo grande).
  - O toque GT911 é lido por uma task de fundo. Abaixo de ~8 fps, todo `getTouch` travava ~30 ms
    esperando uma amostra nova.
  - O caminho rápido do `drawPixel` respeita o `setClip` do app no quadro.
- Como medir: injete cronômetros de `System.millis()` em volta de `update`/`draw` das cenas do
  `E.run`, do `E.dirty._begin`, do `E._pollInput` e do `System.delay`. Imprima a cada 2 s com
  `System.print` e leia as linhas com `celerctl logcat --dump`. No harness, conte as chamadas
  nativas por quadro embrulhando o `System.*` num arquivo de `--events`. A área em pixels por
  quadro é o custo que importa no painel RGB.

## 18d. Core 1.5: perfilador, pool com dono, HUD ancorado e metadados de arte

Rodada vinda do estudo do **deki-engine** (veja `DekiEngine_Estudo.pt-BR.md`). Tudo aditivo:
declare `^1.5.0` no core (e `^1.6.0` no spr) para usar. **Atenção ao tamanho**: com esta
rodada o core sozinho passou de 48 KB enxutos — app com a engine declara `"requires": ["psram"]`.

### `E.prof` — onde vão os milissegundos

`E.frameMs` diz *quanto* o quadro custou; `E.prof` diz *onde*. Ligado, custa 5 leituras de
`System.micros()` por quadro e publica a média da janela de 30 quadros, em microssegundos.

```js
E.init({ fps: 30 });
E.prof.on = true;                  // que liga: o E.debug passa a mostrar "u3 d12"
// depois de alguns segundos (ou via celerctl debug --eval):
System.print(JSON.stringify(E.prof.snapshot()));
// {"n":12,"fps":29,"frame":41200,"input":900,"mods":1500,"update":21000,
//  "draw":17800,"maxFrame":61000}
E.prof.reset();                    // zera a janela (ex.: antes de medir uma cena)
```

`input` é o poll de toque, `mods` a soma dos ticks de módulo (fx/pad/etc.), `update` e `draw`
são a cena, e `frame` o quadro inteiro (sem o sono do pacing). Desligado o custo é um `if`.
Ele mede o que **você** escreveu; para CPU por task use `celerctl top -w`.

### `E.slots` — o pool de sprites com dono

O pool nativo (16 slots com PSRAM, **1 sem**) era contado à mão e um slot esquecido só voltava
no reset do app. Agora `spr` e `world` alocam por um ledger único, que **avisa no log** quando
falta slot (com tamanho pedido e lotação):

```js
var id = E.slots.create('minhaHud', 120, 24);   // 0 = nao coube (avisa 1x no log)
if (id) { /* System.useSprite(id) ... */ E.slots.release(id); }
E.slots.n();          // quantos ocupados agora
E.slots.report();     // { used, cap, owners: { "spr:heroi": 1, "world:sala": 1 } }
```

Cena que aloca recurso nativo ganha um lugar certo para devolver: **`dispose()`**.

```js
var cena = {
    enter: function () { this.fundo = E.slots.create('fundo', E.W, E.H); },
    exit: function () { /* ultimo uso */ },
    dispose: function () { E.slots.release(this.fundo); }   // depois do exit, ao SAIR
};
```

`dispose` roda no `goto`, no `quit` e no `goto` que esvazia a pilha — **não** roda no `push`
(ali a cena só pausa e volta no `pop`; devolver o slot ali quebraria o `resume`).

### `E.ax` / `E.ay` / `E.anchor` — HUD em 9 pontos

`pt` é 0..8 como o teclado numérico (0 noroeste, 4 centro, 8 sudeste). A margem segura do vidro
(`E.inset`, do firmware — o relógio redondo) entra nas bordas esquerda/direita; nada de
`E.W - w` espalhado pelo código:

```js
var x = E.ax(2, 4, 100), y = E.ay(0, 4, 20);      // canto superior direito
E.gfx.text('HP', x, y, { screen: true });

var r = E.anchor(8, 4, 4, 100, 30, meuOut);        // sudeste; meuOut evita alocar
E.gfx.rect(r.x, r.y, r.w, r.h, cor, { screen: true });
```

### `E.spr.meta` / `animOf` / `box` — a arte descrita uma vez (spr 1.6)

Metadados de arte num objeto ES5 vindo de um **módulo de dados do app** (não `.json`: ler
arquivo exige a permissão `fs` e o diálogo de consentimento; um `require` não pede nada):

```js
// arte.js
module.exports = {
  heroi: { file: 'heroi', cols: 4, rows: 2, tw: 16, th: 16, prefix: 'h',
           anims: { idle: [0, 1], run: [4, 5, 6, 7], atk: [2] },
           fps: { run: 12 }, loop: { atk: false },
           ax: 0.5, ay: 1,              // pe no chao: nao repita em cada blit
           hitbox: [2, 4, 12, 10] }     // dentro do quadro
};

// jogo.js
var E = require('celeros.game'); require('celeros.game.spr');
E.spr.meta(require('arte'));            // registra (e monta a grade/se o sheet)
var andando = E.spr.animOf('heroi', 'run');   // E.anim pronto (frames, fps, loop)
andando.draw(x, y);                            // blit ja usa a ancora do metadado
var caixa = E.spr.box('heroi', x, y, 1, meuArray);  // [x, y, w, h] na origem do blit
```

`meta(nome)` devolve o metadado; `meta({a: m1, b: m2})` registra vários. `box` aceita o nome do
metadado (quadro 0 da grade) ou o de um quadro (`'h4'`).

### Pacing e `remove` no tick (correções)

- O pacing agora é em **microssegundos com sobra**: 60 fps pede 16,67 ms por quadro (antes o piso
  de `1000/fps` em ms inteiros rodava a ~62). No estouro o loop cede a cada 100 ms, não em todo
  quadro (1 ms por quadro atrasado).
- `group.remove(o)` **dentro do update** não corrompe mais o laço: durante o tick ele marca
  `dead` e o próprio laço recolhe. Fora do update continua removendo na hora.

## 18e. Rodada 2 do estudo do deki (core 1.6, spr 1.7, node 1.0, cena 1.1)

Segunda leva do que o estudo do `deki-engine` rendeu (o primeiro capítulo está
no `DekiEngine_Estudo.pt-BR.md`). Tudo aditivo; declare `^1.6.0` no core,
`^1.7.0` no spr, `^1.0.0` no node.

- **Rotação e escala por eixo no sprite** (§9): `{angle}`, `{scaleX, scaleY}`;
  gira em volta da âncora e a caixa suja vira o AABB girado.
- **Culling** (§8): `g.draw({cull: true, pad})`, sem `w/h` desenha sempre.
- **Hierarquia** (§14g): `celeros.game.node` + `pai: "#nome"` na cena.
- **Geração de slot** (`E.slots.gen`): um id reciclado não desenha arte nova
  por um nome velho — o spr recusa e avisa 1x.
- **Orçamento** (`E.slots.fit(w, h)`): bytes físicos estimados (16 bits,
  caindo para 8) contra `maxAllocRAM`/`freePSRAM`; **advisory** (o host/emulador
  não tem PSRAM e diz não). A mensagem de falha do `create` passou a dizer o
  motivo do orçamento.
- **Sono** (firmware API 51): `System.isScreenOn()`/`System.screenState()` e,
  na engine, `E.onSleep`/`E.onWake`. Com a tela apagada ou em AOD o loop **não
  roda update nem desenhar** (o `present` dos apps já é suprimido); no wake a
  engine reancora o `dt`, remonta o pacing e repinta tudo. `E.screenOn` diz o
  estado atual. Como o `E.init` chama `keepAwake(true)` por padrão, jogo
  comum nunca chega a dormir; quem quer a economia solta o keep-awake
  (`E.init({ keepAwake: false })`). Padrão para salvar no sono:

  ```js
  E.onSleep = function () { E.pause(true); E.save.setObj("estado", salvar()); };
  E.onWake  = function () { E.pause(false); };
  ```

## 18b. CelerGame 1.1 (core 1.1.0, fx/spr/tilemap/ui/sfx 1.1.0)

Versão aditiva: toda chamada da 1.0 continua valendo. Declare `^1.1.0` no
`app.json` para usar o que vem abaixo (o scaffold já faz isso — lê as versões
dos módulos).

**Pausa e câmera lenta.** `E.pause(true|false)` (sem argumento alterna;
`E.paused` lê): o `update` da cena segue rodando com `dt = 0` para tocar um
menu de pausa, enquanto fx, câmera, timers e tweens congelam — no resume todo
prazo é empurrado pelo tempo parado. `E.timeScale = 0.3` escala o `dt` do
update/fx/câmera (timers e tweens seguem o relógio).

```js
update: function (dt) {
    if (E.input.doubleTap) E.pause();
    if (E.paused) { var a = E.ui.pause(); if (a === "resume") E.pause(false); return; }
    // ... jogo ...
}
```

**Entrada.** `E.input.doubleTap` (2º tap seco perto do 1º em até
`E.input.dblMs`, padrão 300). `E.hit(rect, pad)` / `E.press(rect, pad)` aceitam
uma folga em px — a moeda de 12 px fica tocável sem crescer na tela.

**Tempo.** `E.every(ms, fn, vezes)` para depois de `vezes` disparos (`t.left`).
`E.tween(obj, to, ms, {yoyo, repeat, onUpdate})`: `repeat` = voltas extras
(`-1` para sempre), `yoyo` inverte a cada volta. Correções: o tween lê o valor
de partida quando COMEÇA (depois do `delay`), e prop ausente no `obj` parte de
0 (era `NaN`).

**Matemática.** `E.m.angDiff(a, b)` (giro mais curto), `smoothstep`,
`chance(p, rnd)`, `shuffle(arr, rnd)`; easings
`inCubic/outCubic/inOutCubic/outElastic/outBounce`. `E.rng(seed)` agora traz
`.int(a, b)`, `.range(a, b)` e `.pick(arr)`. Correções: `E.m.wrap(-10, 0, 10)`
é `0` (era `10`), `E.m.randInt(n)` é `0..n` (era `NaN`).

**Câmera.** `E.cam.follow(alvo, lerp, {deadzone: {w, h}})` — o alvo anda
dentro da caixa central sem mover a câmera. `E.cam.worldX(sx)` / `worldY(sy)`
transformam o toque em coordenada do mapa.

**Entidades e save.** `pool.spawn()` continua do último slot (sem re-varrer o
prefixo vivo); `group.sort("y")` (ordem de desenho estável) e
`group.remove(o)`. `E.save.obj(chave, def)` / `setObj(chave, val)` (JSON; JSON
podre devolve `def`) e `E.save.del(chave)`.

**Cenas e diagnóstico.** `E.goto("errado")` lança na hora, listando as cenas
que existem. `E.debug = true` (ou `E.init({debug: true})`) desenha fps, ms do
quadro (`E.frameMs`), caixas sujas e partículas vivas no canto.

**Módulos.**
- fx: `E.fx.clear()` (chame no `exit` da cena — as partículas não vazam mais
  para o menu); `popText(..., {vy, grow})`; correção: `burst({n: 0})` semeava 12.
- spr: âncora no `blit(nome, x, y, {ax, ay})` (`ax: 0.5, ay: 1` = pé no chão);
  `E.spr.size(nome)`; `E.anim` ganha `reset()`, `play(frames, fps)` (o mesmo
  clipe não recomeça — seguro chamar por quadro), `onEnd`, modo `'pingpong'`, e
  nada de `NaN` com lista de frames vazia.
- tilemap: camada de dados opcional — `E.tilemap({..., data: ['#..#', ...],
  solid: function (v) { return v === '#'; }})`; `get/set` (`set` marca a célula
  para o próximo `flush`), `each`, `cellRect` e consultas de colisão
  `solidAt(x, y)` / `rectSolid(x, y, w, h)` (fora da grade é sólido, salvo
  `outside: false`).
- ui: `E.ui.confirm(msg, {title})` -> `'yes'|'no'|null`; `E.ui.toast(msg, {ms})`
  é desenhado pela engine por cima da cena (sem chamada no draw, funciona em
  cena static); `list` rola com inércia e tem `scrollTo(i)`; as telas prontas
  não alocam mais objetos de opções por quadro. Pede core `^1.1.0`.
- sfx: `SFX.varia(mel, semi, rnd)` (afinação sorteada por toque) e
  `SFX.junta(a, b, {pausa})`; `SFX.via(..., {varia: 2})`.

**Core 1.2 / fx, spr, tilemap, sfx 1.2.** Pilha de cenas: `E.push(nome)` abre
uma cena por cima da atual (que recebe `pause()` e congela — nem update nem
draw), `E.pop()` volta a ela (`resume()`, camada suja restaurada); `E.goto`
com a pilha cheia sai de todas; `E.depth()`. Cena com `cleanup: true` mata os
timers e tweens que criou ao sair; `E.killTweensOf(obj)`. Matemática:
`E.m.noise(x, y, seed)` (ruído de valor suave 0..1), `lerpAngle`, `snap`.
`E.input.heldMs` (tiro carregado). `group.find/countIf`, `pool.spawn(init)`.
`E.cam.inView(x, y, w, h, pad)` (pule o que está fora da tela) e
`follow(alvo, lerp, {offset})` (olhar à frente). `E.gfx.wrap`,
`E.gfx.textBox(str, x, y, w, {max})`, `E.gfx.poly(pts, cor)` e texto
`{shadow: cor}`. `E.audio.gap` (padrão 40 ms): o mesmo sfx nomeado duas vezes
dentro do intervalo toca uma. `E.save.inc(chave)`. fx: `E.fx.play("explosao", x, y)`
com `E.fx.presets` (explosao, faisca, fumaca, confete, poeira, gosma, cura).
spr: `E.spr.grid(nome, {file, cols, rows, tw, th})` + `E.spr.frames(prefixo, a, b)`.
tilemap: `fill(c, r, w, h, v)`, `find(v)`. sfx: `SFX.arpejo(base, semitons, ms)`.

**Core 1.3 / correções dos módulos.** Timers e tweens que vencem no mesmo
quadro rodam na ordem de criação (dois tweens na mesma prop: o mais novo
vence — use `E.killTweensOf` antes de retweenar); `E.tween` sem `ms` termina
em vez de rodar `NaN` para sempre; `every(0, fn, n)` repete; `E.m.map` com
intervalo vazio devolve `c`; `button/bar/panel` aceitam preto (`0x0000`);
`textBox {max}` deixa o `...` dentro da largura; tick de módulo marcado
`always` roda na pausa (o botão "continuar" do pad funciona). Novos:
`goto/push(nome, {arg})` chega no `enter(arg)` e `pop({arg})` no `resume(arg)`
(só `{arg}` não abre véu), `E.prevScene`, `E.run(cenas, primeira, arg)`,
`E.timeLeft(timer)`, tween relativo (`{x: "+=20"}`), passos `{wait}` e `{call}`
no `seq`, `E.m.weighted/lerpColor/fmt/clock/moveToward`, `group.closest`,
`pool.find`, `E.cam.panTo(x, y, ms)`, `E.gfx.hearts(hp, max, x, y)`,
`E.save.bool/toggle`, e o overlay de debug mostra a cena e a pilha.
Módulos: events 1.1 (emit reentrante não pula mais ouvintes; ouvinte coringa
`"*"`), pad 1.1 (funciona na pausa; toque que desce num botão não pega o
stick; controles pertencem à cena; `heldMs`/`tap`), level 1.1 (texto CRLF;
`lv.tilemap()`, `progress.complete/totalStars`), collide 1.1 (`move` com `NaN`
não trava; o hash recicla células em mundo que rola; `ray` e `sweep`), path
1.1 (alvo bloqueado sai na hora; `smooth` não corta quina de parede; mapas de
distância `flow`; `follower {loop|pingpong}`), fsm 1.1 (string devolvida vence
um `go` pendente; `pop` volta com a bolsa e o tempo do estado via `resume`;
estado coringa `"*"`), tilemap 1.3 (`autotile`, `neighbors`), spr 1.3
(recarregar um nome libera o slot antigo; `anim.play` do mesmo clipe aplica o
fps novo; o loop guarda a sobra do tempo; `anim.speed`, `onFrame`), fx 1.3
(`beam`, `count`), sfx 1.3 (nota única em `transpor/tempo/varia`; `combo`),
grid 1.1.1 (`flood` com origem fora da grade), physics 2.1.1 (`verletFast` cai
no JS quando os mundos nativos acabam).

## 19. Cola de API

| Chamada | Faz |
|---|---|
| `E.init(opts)` / `E.run(cenas, primeira)` | detecta caps / possui o loop |
| `E.goto(nome, {transition})` / `E.quit()` | troca de cena (véu: fade/iris/wipe/bands) / sai do loop |
| `E.input`, `E.hit(r, pad)`, `E.press(r, pad)` | estado do toque (+ `doubleTap`), tap no rect, pressão no rect |
| `E.pause()`, `E.paused`, `E.timeScale`, `E.debug` | pausa do jogo, câmera lenta, overlay de fps (§18b) |
| `E.gfx.*`, `E.cam` | desenho com câmera, scroll/shake/follow |
| `E.u(v)`, `E.U`, `E.font(px)`, `E.ts` | escala em unidades do projeto, tipografia por pixel |
| `cena.static`, `E.redraw()` | menus que só desenham quando algo muda |
| `E.dirty.enable/clip/unclip/add/full/erase`, `E.tilemap` | apaga-e-redesenha só o que mudou (tilemap: módulo opcional) |
| `E.group()` (+ `sort/remove`), `E.pool(n, f)` | listas de entidades, reciclagem pré-alocada |
| `E.spr.load/blit`, `E.spr.sheet`, `E.anim(frames, fps)` | sprites PNG, regiões de spritesheet, flipbooks (módulo opcional) |
| `E.fx.burst/ring/popText/flash/stars/draw` | juice |
| `E.fx.emitter/trail/parallax` | fontes contínuas, rastros, parallax pela câmera (módulo fx) |
| `E.tween/seq/after/every/cancel/clear*` | tempo tickado pela engine, timelines de tween |
| `E.ui.menu/list/dialog/title/pause/gameOver/confirm/toast` | UI de jogo pronta (módulo opcional — §14b) |
| `E.audio.music/beat/sfx/stop/mute/volume` | chiptune + sfx educado |
| `E.save.get/set/num/best/obj/setObj/del` | persistência NVS (objetos em JSON) |
| `E.m.*`, `E.rng(seed)` | matemática (+ `noise`), RNG determinístico |
| `E.push/pop/depth`, `cleanup` da cena | pilha de cenas (inventário sobre o jogo), timers da cena mortos sozinhos |
| `E.fsm`, `E.on/emit`, `E.path`, `E.collide`, `E.pad`, `E.level` | módulos para jogos complexos (§14c) |
| `E.script`, `E.inv`, `E.steer`, `E.gen`, `E.stats`, `E.waves` | cutscene, inventário, steering, fase procedural, atributos de combate, diretor de ondas (§14d) |
| `E.combat`, `E.world`, `E.freeze`, `E.save.slot`, `E.spr.stamp`, `E.anim.dir` | ação e aventura: hitbox/knockback/hitstop, salas do tamanho da tela com slide, arquivos de jogo, sala gravada, animação em 4 direções (§14e) |
| `E.scene.def/spawn/instantiate`, `E.scene.save/load/migra`, `E.scene.prefab` | cena e prefab como dado: referências por nome resolvidas antes do `start`, save/load com versão e migração (§14f) |
| `E.spr.prescale(lista, {key})` | grava quadros na escala da tela num slot só: desenho em escala 1 no lugar do `drawSprite` afim por quadro (§18c) |
| `goto/push/pop {arg}`, `E.prevScene`, `E.timeLeft`, `E.cam.panTo`, `E.gfx.hearts` | parâmetro de cena, recarga na tela, passeio de câmera, corações de vida (core 1.3) |
| `E.prof.on/snapshot/reset`, `E.frameMs` | perfilador por trecho: input/mods/update/draw em us (§18d) |
| `E.slots.create/release/n/report`, `cena.dispose()` | pool de sprites com dono + lugar de devolver o recurso nativo (§18d) |
| `E.ax/ay/anchor`, `E.inset` | HUD em 9 pontos, ciente da margem segura do vidro (§18d) |
| `E.spr.meta/animOf/box` | metadados de arte (grade, clipes, fps, âncora, hitbox) num módulo de dados (§18d) |
| `E.spr.stamp/blit {angle, scaleX, scaleY}`, `E.spr.box` | giro (em volta da âncora) e escala por eixo; caixa suja girada (§9, §18e) |
| `g.draw({cull, pad})`, `pool.draw({cull})` | pula entidade fora da câmera pelos extents `w/h` (§8) |
| `E.slots.fit(w, h)`, `E.slots.gen(id)` | orçamento de bytes ANTES de alocar; geração do slot (id reciclado) (§18e) |
| `E.node.attach/detach/tick/setPos`, `E.node.wx/wy/rotOf` | hierarquia pai/filho com cache world (§14g) |
| `E.onSleep/onWake`, `E.screenOn`, `System.isScreenOn/screenState` | tela apagou/acordou: pausar, salvar, repintar (§18e, firmware API 51) |
| `P.verletFast`, `P.rigid`, `P.hit` | a escada de física: verlet nativo, corpo rígido nativo, sobreposição estática (módulo opcional — §15) |

O autocomplete do editor vem no scaffold: o `.d.ts` de cada módulo adotado (`celeros.game.d.ts`, `celeros.game.fx.d.ts`, ...) junto do `celer.d.ts` (API do firmware); quem faz `require("celeros.engine")` segue com o `celeros.engine.d.ts` tudo-em-um, GERADO a partir dos `.d.ts` dos módulos por `node tools/sdk/lib/engine_dts.js` (edite o arquivo do módulo e rode de novo; o `test/sdk` falha com drift e com membro público da engine sem tipo).
