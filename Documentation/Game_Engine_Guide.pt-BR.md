# Guia CelerGame (a game engine do CelerOS)

[English](Game_Engine_Guide.md) | **Português (BR)**

A **CelerGame** é a game engine 2D do CelerOS, entregue como uma **família de dependências compartilhadas do hub que você adota uma a uma** — desde a API 30, `"deps"` no `app.json`: a loja as instala no cache público `/local/modules` e o `require()` resolve de lá, uma única cópia por versão no aparelho. Sem permissão extra; vendorizar uma cópia na pasta do app continua funcionando (e vence).

| Dep | Enxuta | O que entrega |
|---|---|---|
| **`celeros.game`** (core) | ~25 KB | loop com cenas + transições, gestos de toque, desenho com câmera, matemática/RNG, tweens/timers/`E.seq`, grupos/pools, camada suja, áudio chiptune com relógio de batida, saves no NVS |
| **`celeros.game.fx`** | ~6 KB | partículas, bursts/ondas, texto flutuante, flash, campo de estrelas, **emissores contínuos, rastros, parallax** |
| **`celeros.game.spr`** | ~2 KB | sprites PNG em slots nativos com painter de fallback, flipbooks, **spritesheet (1 PNG, N regiões nomeadas)** |
| **`celeros.game.tilemap`** | ~2 KB | grade de células sujas p/ cenários procedurais grandes |
| **`celeros.game.ui`** | ~5 KB | menus, listas com rolagem, diálogos datilografados, telas de título/pausa/fim prontas |
| **`celeros.engine`** | shim (0,2 KB) | a **família inteira montada** — a API pré-modularidade (1.2.x) num `require` só; jogos existentes seguem funcionando sem mudança |
| **`celeros.physics`** (opcional) | ~7 KB | corda/pano por Verlet nativo (`P.verletFast`, API 31) e corpos rígidos (`P.rigid`, API 33). **A maioria dos jogos não precisa de nada disso** — veja a escada de física no §15 |
| `celeros.grid`, `celeros.sfx`, `celeros.mesh` | — | arenas estilo bomberman + BFS de perseguição, tabelas de melodias sfx, boilerplate CelerNet (mesma família, módulos à parte) |

Cada módulo decora o **mesmo objeto `E`** (o cache do `require` faz o core ser singleton): adotar é uma linha — `require("celeros.game.fx")` e o `E.fx` existe. Deps entre módulos são transitivas (fx → core): a loja resolve o grafo inteiro no install. Você paga pelo que adota — deps somam no teto do app MESMO compartilhadas, porque cada jogo as compila no próprio heap Duktape: um jogo só-core fica em ~25 KB enxutos (cabe no teto de 48 KB sem PSRAM), a família inteira em ~35 KB.

Tudo é ES5 (Duktape) e detecta os recursos do firmware em tempo de execução, então o mesmo jogo roda em toda placa — e sem mudanças no harness/emulador Node.

## 1. Requisitos

| | |
|---|---|
| API do firmware | 23+ para módulos; **30+** para as deps compartilhadas (recursos novos — primitivas smooth, `playMusic`, canvas nativo — são auto-detectados) |
| Placas-alvo | As ESP32-S3 com PSRAM: SmartDisplay, watch Waveshare, cão SpotPear |
| Orçamento de tamanho | Deps somam no teto do app MESMO compartilhadas (compilam no heap de cada jogo): core ~25 KB + ~20 KB do seu código cabe no teto simples de 48 KB; jogos maiores declaram `"requires": ["psram"]` para subir o teto para 1 MB (a loja passa a bloquear install em placa sem PSRAM). O hub mede as deps **enxutas**, como o aparelho compila |
| Sabor do app | `"topbar": false` para jogos em tela cheia (como o Supernova) é recomendado; o botão de saída mora no menu de título do seu jogo (`System.exitApp()`) |
| CYD (sem PSRAM) | **Jogos só-core agora cabem**: `celeros.game` (~25 KB) + ~20 KB de código ficam sob o teto de 48 KB, sem vendorizar. Adote fx/spr/tilemap só se o orçamento permitir; família inteira + código pede `"psram"` |

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
node tools/sdk/celer.js emu MeuJogo --ms 2000 --out tela.png
node tools/sdk/celer.js emu MeuJogo --frames 0,600,1500   # PNG por marco + diff de pixels
```

No app, exponha um hook de introspecção tipo `if (typeof __harness !== "undefined") __harness.meuJogo = { state: ... };` e dirija tudo deterministicamente (veja o padrão do test.js do Supernova).

## 18. Tamanho e performance

- As deps somam no teto do app (cada jogo as compila no próprio heap) — **adopte só o que usa**: core ~25 KB enxutos, fx ~6, ui ~5, spr ~2, tilemap ~2 (família inteira ~35 KB ≈ a engine monolítica antiga). Passou de 48 KB no total → `"requires": ["psram"]` sobe o teto para 1 MB. O hub mede as deps **como publicadas**: o `celerhub publish-dep` as sobe pelo `tools/sdk/lib/jsstrip.js` (porte 1:1 do JsStripper do firmware — sem comentários/indentação, quebras mantidas, então a linha do erro bate com o fonte), que é exatamente o que o aparelho compila.
- **Zero alocação por frame**: use `E.pool`, remoção swap-pop e reúso de objetos. Um `new`/`[...]` por frame por entidade é o que dispara pausa de GC. Desde a engine 1.2.3 os wrappers também não alocam: chamadas de `E.gfx.*` sem opts compartilham um objeto só de leitura, a busca do `E.font` é memoizada e a largura de cada string (`textWidth`) é medida uma vez por estilo — HUD/placar/botão repetidos não custam chamadas de firmware.
- Se você chama `System.setTextDatum` direto, devolva o `0` ao terminar: a engine 1.2.3 só toca no datum quando o texto pede origem diferente do default, então o `E.gfx.text` confia que o app o deixou em `0` (todos os apps do repo já fazem).
- Evite `fillScreen` + redesenho total por frame: no painel RGB do SmartDisplay (framebuffer varrido da PSRAM) isso estrangula o DMA do LCD e a imagem treme. Use cenas `static`, `E.dirty` e `E.tilemap` (§16b).
- `world.step` é O(n²) no número de corpos no pior caso, mas um **sweep-and-prune** (corpos ordenados por x a cada sub-passo, corte cedo pela distância em x) o mantém quase linear em cenas espalhadas — shooters com ~40 corpos rodam folgados.
- O `E.audio.sfx` não bloqueia na API 32 (`System.sfx`); em firmware anterior é **bloqueante** (`playTone`): mantenha as melodias abaixo de ~300 ms.
- Rajada de JS puro acima de ~1 s esbarra no exec-timeout do firmware — o loop do `E.run` cede todo frame, então fique dentro dele.

## 19. Cola de API

| Chamada | Faz |
|---|---|
| `E.init(opts)` / `E.run(cenas, primeira)` | detecta caps / possui o loop |
| `E.goto(nome, {transition})` / `E.quit()` | troca de cena (véu: fade/iris/wipe/bands) / sai do loop |
| `E.input`, `E.hit(r)`, `E.press(r)` | estado do toque, tap no rect, pressão no rect |
| `E.gfx.*`, `E.cam` | desenho com câmera, scroll/shake/follow |
| `E.u(v)`, `E.U`, `E.font(px)`, `E.ts` | escala em unidades do projeto, tipografia por pixel |
| `cena.static`, `E.redraw()` | menus que só desenham quando algo muda |
| `E.dirty.enable/clip/unclip/add/full/erase`, `E.tilemap` | apaga-e-redesenha só o que mudou (tilemap: módulo opcional) |
| `E.group()`, `E.pool(n, f)` | listas de entidades, reciclagem pré-alocada |
| `E.spr.load/blit`, `E.spr.sheet`, `E.anim(frames, fps)` | sprites PNG, regiões de spritesheet, flipbooks (módulo opcional) |
| `E.fx.burst/ring/popText/flash/stars/draw` | juice |
| `E.fx.emitter/trail/parallax` | fontes contínuas, rastros, parallax pela câmera (módulo fx) |
| `E.tween/seq/after/every/cancel/clear*` | tempo tickado pela engine, timelines de tween |
| `E.ui.menu/list/dialog/title/pause/gameOver` | UI de jogo pronta (módulo opcional — §14b) |
| `E.audio.music/beat/sfx/stop/mute/volume` | chiptune + sfx educado |
| `E.save.get/set/num/best` | persistência NVS |
| `E.m.*`, `E.rng(seed)` | matemática, RNG determinístico |
| `P.verletFast`, `P.rigid`, `P.hit` | a escada de física: verlet nativo, corpo rígido nativo, sobreposição estática (módulo opcional — §15) |

O autocomplete do editor vem no scaffold: o `.d.ts` de cada módulo adotado (`celeros.game.d.ts`, `celeros.game.fx.d.ts`, ...) junto do `celer.d.ts` (API do firmware); quem faz `require("celeros.engine")` segue com o `celeros.engine.d.ts` tudo-em-um.
