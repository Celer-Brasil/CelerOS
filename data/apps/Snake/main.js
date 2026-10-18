// CelerOS Snake — classico da cobrinha. ES5 puro (Duktape); placar, pausa e
// fim de jogo do toolkit UI (API 22). Swipe do dedo para virar; toque pausa. A cobra acelera
// a cada fruta e toda 5a fruta e dourada (+3, pisca e expira). Recorde
// persistido em /local/config_snake_hi.txt. Sons via playTone quando o
// firmware tem (API 12+). Desenho por celulas alteradas: zero flicker.

var T = System.theme();
var W = 240, H = 320;

var CELL = 12;
var COLS = 20;                  // 240 px
var ROWS = 23;                  // 276 px
var FX = 0;                     // x fisico do campo
var FY = 32;                    // y do campo (sob o placar fino)
var FW = COLS * CELL;
var FH = ROWS * CELL;
var HI_FILE = "/local/config_snake_hi.txt";
var GOLD_EVERY = 5;             // fruta dourada a cada N frutas
var GOLD_MS = 7000;             // validade da dourada

// Som: System.sfx (API 32) mistura o efeito por cima da trilha e NAO trava
// o loop do jogo; firmware antigo cai no playTone (bloqueante)
var somFn = typeof System.sfx === "function" ? System.sfx :
            (typeof System.playTone === "function" ? System.playTone : null);
var hasTone = somFn !== null;
function tone(hz, ms) {          // playTone aceita melodia [[freq,ms],...]
    if (hasTone) { try { somFn && somFn([[hz, ms]]); } catch (e) {} }
}
function tune(notes) {           // sequencia curta (ex.: recorde)
    if (hasTone) { try { somFn && somFn(notes); } catch (e) {} }
}
if (typeof System.keepAwake === "function") {
    try { System.keepAwake(120000); } catch (e) {}  // partida sem apagar tela
}

var hi = 0;
var raw = FS.readTextFile(HI_FILE);
if (raw) {
    var p = parseInt(raw, 10);
    if (!isNaN(p)) hi = p;
}

// ------------------------------------------------------------ estado ------
var snake, dir, nextDir, food, gold, score, interval, state, growPending;
var fruits, goldUntil, newRecord;

function reset() {
    snake = [{ x: 8, y: 11 }, { x: 7, y: 11 }, { x: 6, y: 11 }];
    dir = { dx: 1, dy: 0 };
    nextDir = null;
    score = 0;
    interval = 220;
    growPending = 0;
    fruits = 0;
    gold = null;
    goldUntil = 0;
    newRecord = false;
    state = "count";
    spawnFood();
    drawBoard();
    drawHeader();
    drawFood();
}

function countdown() {
    for (var n = 3; n >= 1; n--) {
        // id FIXO: o slot do UI.text apaga o numero anterior antes de pintar o
        // novo; com id por numero (3/2/1) eram tres slots sobrepostos e os
        // digitos empilhavam
        UI.text(String(n), 120, 120, { role: "display", align: "center", color: T.accent, bg: T.bg, id: 1 });
        System.delay(450);
    }
    // o numero ficaria pintado no campo (redesenho e por celula): limpa
    System.fillRect(FX, FY, FW, FH, T.bg);
    drawBoard();
    drawFood();
    state = "play";
}

function onSnake(x, y) {
    for (var i = 0; i < snake.length; i++) {
        if (snake[i].x === x && snake[i].y === y) return true;
    }
    return false;
}

// livre = fora da cobra E fora da outra fruta (a normal nascia em cima da
// dourada: comer uma apagava a outra do desenho e ela virava invisivel)
function busy(x, y) {
    return onSnake(x, y) || (food && food.x === x && food.y === y) ||
           (gold && gold.x === x && gold.y === y);
}

function freeCell() {
    var tries = 0;
    while (tries < 300) {
        var x = Math.floor(Math.random() * COLS);
        var y = Math.floor(Math.random() * ROWS);
        if (!busy(x, y)) return { x: x, y: y };
        tries++;
    }
    // campo quase cheio: primeira celula livre
    for (var j = 0; j < ROWS; j++) {
        for (var i2 = 0; i2 < COLS; i2++) {
            if (!busy(i2, j)) return { x: i2, y: j };
        }
    }
    return null;  // venceu de verdade
}

function spawnFood() {
    food = null;          // a fruta comida nao bloqueia a celula da nova
    food = freeCell();
    if (!food) { saveHi(); state = "over"; }
}

function spawnGold() {
    var c = freeCell();
    if (!c) return;
    gold = c;
    goldUntil = System.millis() + GOLD_MS;
}

// ------------------------------------------------------------- desenho ----
function cellRect(x, y) {
    return { x: FX + x * CELL + 1, y: FY + y * CELL + 1, w: CELL - 2, h: CELL - 2 };
}

function drawCell(x, y, col) {
    var r = cellRect(x, y);
    System.fillRoundRect(r.x, r.y, r.w, r.h, 3, col);
}

function clearCell(x, y) {
    // Apaga a celula com 2 linhas de folga EMBAIXO: a fruta e um circulo e o
    // firmware o desenha com raio medio (jsu) — em escala nao-inteira (4848:
    // 2x horizontal, 1,5x vertical) ele passa 1px alem do retangulo da celula
    // e a ultima linha do circulo vazava do apagamento (artefato de "linha"
    // no lugar da fruta comida). Na ultima linha do campo a folga e cortada
    // para nao comer o traco da borda.
    System.fillRect(FX + x * CELL + 1, FY + y * CELL + 1, CELL - 2,
                    y === ROWS - 1 ? CELL - 2 : CELL, T.bg);
}

function drawBoard() {
    System.fillRect(FX, FY, FW, FH, T.bg);
    System.drawRoundRect(FX, FY, FW, FH, 2, T.stroke);
    for (var i = 0; i < snake.length; i++) {
        drawCell(snake[i].x, snake[i].y, i === 0 ? T.ok : T.accent);
    }
}

function drawFood() {
    if (!food) return;
    var r = cellRect(food.x, food.y);
    System.fillSmoothCircle(r.x + r.w / 2, r.y + r.h / 2, (CELL - 4) / 2, T.err);
}

function drawGold(on) {
    if (!gold) return;
    if (on) {
        var r = cellRect(gold.x, gold.y);
        System.fillSmoothCircle(r.x + r.w / 2, r.y + r.h / 2, (CELL - 3) / 2, T.warn);
    } else {
        clearCell(gold.x, gold.y);
    }
}

function level() {
    return 1 + Math.floor((220 - interval) / 6);
}

function drawHeader() {
    // o nome vive na faixa do sistema (retratil); aqui e so o placar.
    // drawString direto (nao UI.text): o fillRect do fundo apagaria textos
    // cuja assinatura nao mudou e o slot nao redesenharia
    System.fillRect(0, 0, W, 28, T.card);
    System.setTextColor(T.text, T.card);
    System.drawString("Pontos " + score, 10, 8, 2);
    System.setTextDatum(2);           // TR
    System.setTextColor(score > 0 && score >= hi && newRecord ? T.ok : T.textDim, T.card);
    System.drawString("Rec " + hi, W - 10, 10, 1);
    System.setTextDatum(0);
    System.setTextColor(T.textDim, T.card);
    System.drawString("Nv " + level(), 132, 10, 1);
    System.fillRect(0, 28, W, 2, T.accent);
}

function redrawField() {
    drawBoard();
    drawFood();
    if (gold) drawGold(true);
}

// Fim de jogo: dialogo nativo; ao voltar, partida nova
function gameOver(win) {
    UI.alert(win ? "Você venceu!" : "Fim de jogo",
             "Pontos: " + score + "  ·  Tamanho: " + snake.length + "  ·  " +
             (newRecord ? "Novo recorde!" : "Recorde: " + hi), "Jogar de novo");
}

// Pausa (toque seco): seguir ou reiniciar
function pauseMenu() {
    var seguir = UI.confirm("Pausado", "Nível " + level() + "  ·  " + score + " pontos",
                            { yes: "Seguir", no: "Reiniciar" });
    if (seguir) {
        redrawField();
        state = "play";
    } else {
        System.fillScreen(T.bg);
        reset();
        countdown();
    }
}

function saveHi() {
    if (score > hi) {
        hi = score;
        newRecord = true;
        FS.writeTextFile(HI_FILE, String(hi));
        tune([[880, 90], [1320, 120]]);
    }
}

// ---------------------------------------------------------------- passo ---
function step() {
    if (nextDir) {
        // proibe reversao de 180 graus
        if (!(nextDir.dx === -dir.dx && nextDir.dy === -dir.dy)) dir = nextDir;
        nextDir = null;
    }
    var head = { x: snake[0].x + dir.dx, y: snake[0].y + dir.dy };

    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) return die();
    // a cauda anda junto: colidir com o corpo e valido (a cauda atual sai
    // exceto se estiver crescendo — checagem simples contra o corpo inteiro)
    if (onSnake(head.x, head.y)) {
        var tail = snake[snake.length - 1];
        if (!(growPending === 0 && tail.x === head.x && tail.y === head.y)) return die();
    }

    // fruta na celula da cabeca: apaga ANTES de desenhar a cabeca (antes a
    // ordem apagava a cabeca recem-desenhada e deixava um buraco por um passo)
    var ate = 0;
    if (food && head.x === food.x && head.y === food.y) {
        ate = 1;
    } else if (gold && head.x === gold.x && head.y === gold.y) {
        ate = 3;
    }
    if (ate) clearCell(head.x, head.y);

    snake.unshift(head);
    drawCell(head.x, head.y, T.ok);
    if (snake.length > 1) drawCell(snake[1].x, snake[1].y, T.accent);

    if (ate > 0) {
        if (ate === 3) gold = null;
        fruits++;
        score += ate;
        if (score > hi && !newRecord) {
            newRecord = true;
            drawHeader();
        }
        growPending += ate + 1;
        interval = Math.max(90, 220 - fruits * 6);
        drawHeader();
        tone(ate === 3 ? 990 : 660, ate === 3 ? 70 : 45);
        if (fruits % GOLD_EVERY === 0 && !gold) spawnGold();
        if (food && ate === 1) spawnFood();
        if (!food) { saveHi(); state = "over"; return; }
        drawFood();
    }

    // dourada pisca e expira
    if (gold) {
        if (System.millis() > goldUntil) {
            drawGold(false);
            gold = null;
        } else {
            drawGold(Math.floor(System.millis() / 220) % 2 === 0);
        }
    }

    if (growPending > 0) {
        growPending--;
    } else {
        var t2 = snake.pop();
        drawCell(t2.x, t2.y, T.bg);
    }
}

function die() {
    tone(150, 220);
    saveHi();
    drawHeader();
    state = "over";
}

// -------------------------------------------------------------- entrada ---
var press = null, lastP = null;

function pollTouch() {
    var t = System.getTouch();
    if (t.touched) {
        if (!press) { press = { x: t.x, y: t.y }; lastP = { x: t.x, y: t.y }; }
        else { lastP.x = t.x; lastP.y = t.y; }
        return false;
    }
    if (press) {
        var dx = lastP.x - press.x, dy = lastP.y - press.y;
        press = null;
        if (state === "play") {
            if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
                state = "pause";      // toque seco: pausa
                return false;
            }
            if (Math.abs(dx) > Math.abs(dy)) nextDir = { dx: dx > 0 ? 1 : -1, dy: 0 };
            else nextDir = { dx: 0, dy: dy > 0 ? 1 : -1 };
        }
        return true;  // gesto completo (usado no game over)
    }
    return false;
}

// ------------------------------------------------------------------ main ---
reset();
countdown();

var lastTick = System.millis();
while (true) {
    pollTouch();

    if (state === "count") {
        countdown();
        lastTick = System.millis();
    } else if (state === "play") {
        var now = System.millis();
        if (now - lastTick >= interval) {
            lastTick = now;
            step();
        }
    } else if (state === "pause") {
        pauseMenu();
        lastTick = System.millis();
    } else if (state === "over") {
        gameOver(snake.length >= COLS * ROWS);
        System.fillScreen(T.bg);
        reset();
        countdown();
        lastTick = System.millis();
    }

    System.delay(10);
}
