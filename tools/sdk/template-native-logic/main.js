// Casca JS do app com core de LOGICA nativo (template do --native-logic).
//
// A REGRA vive no blob (native/core.cpp -> core.bin); aqui so:
//   1. carregar o core e mandar input por System.nativeCall;
//   2. ler o bloco de estado/sujos/eventos do scratch (fatias de 256 B);
//   3. desenhar (System.*), tocar som e tratar a UI.
//
// Sem hasNative (placa sem o acelerador) o app explica e sai — o requires
// "native" do app.json ja bloqueia a instalacao na Loja/Installer.

var S = System;
var K = (typeof S.getInfo === "function") ? S.getInfo() : {};
if (!K.hasNative) {
    S.fillScreen(0);
    S.setTextColor(0xFFFF);
    S.drawString("{{APP_NAME}}", 60, 90, 4);
    S.setTextColor(0xC618);
    S.drawString("Precisa de S3 com PSRAM (api 57+)", 20, 150, 1);
    S.delay(3500);
    S.exitApp();
}

S.setNativeCanvas(true);
var W = S.screenWidth(), H = S.screenHeight();

// ---- tabuleiro do exemplo (espelho de native/core.cpp) -------------------
var COLS = 12, ROWS = 12, CELL = 32;
var BW = COLS * CELL, BH = ROWS * CELL;
var BX = (W - BW) >> 1, BY = (H - BH) >> 1;

// ---- contrato do core (celeros_core.h) -----------------------------------
var CORE_INIT = 0, CORE_RESET = 1, CORE_STEP = 2, CORE_LOAD_LEVEL = 3,
    CORE_OUT_OFF = 4, CORE_OUT_SIZE = 5, CORE_LEVEL_OFF = 6, CORE_LEVEL_SIZE = 7;
var IN_UP = 1, IN_DOWN = 2, IN_LEFT = 4, IN_RIGHT = 8, IN_A = 16, IN_B = 32;
var OUT_HEAD = 8, DIRTY_BYTES = 512 * 2, EVENT_BYTES = 32 * 8;

var h = 0, outOff = 0, outSize = 0, levelOff = 0, stateBytes = 0;
function ctl(cmd, arg) { return S.nativeCall(h, 0, cmd, arg || 0); }

function loadCore() {
    h = S.nativeLoad(S.appDir() + "/core.bin", 256);
    if (h <= 0) return false;
    if (ctl(CORE_INIT) !== 1) return false;
    outOff = ctl(CORE_OUT_OFF);
    outSize = ctl(CORE_OUT_SIZE);
    levelOff = ctl(CORE_LEVEL_OFF);
    return true;
}

// ---- leitura do scratch em fatias (nativeRead devolve no maximo 256 B) ----
// Cada chunk vira BYTES NUMERICOS por charCodeAt e o parse e por indice:
// concatenar os chunks em string (`s += part`) estourou no aparelho real
// ("cannot string coerce Symbol" ao ler o bloco de eventos — o mesmo bug
// corrigido na ponte do Detona).
function readBytes(off, len) {
    var b = [], p = 0, i;
    while (p < len) {
        var n = (len - p) < 256 ? (len - p) : 256;
        var part = S.nativeRead(h, off + p, n);
        if (part === null || typeof part !== 'string' || part.length !== n) return null;
        for (i = 0; i < n; i++) b.push(part.charCodeAt(i) & 0xFF);
        p += n;
    }
    return b;
}
function rb16(b, o) { return b[o] | (b[o + 1] << 8); }
function i32(b, o) {
    var v = rb16(b, o) | (rb16(b, o + 2) << 16);
    return (v & 0x80000000) ? (v - 0x100000000) : v;
}
function fx(v) { return v / 256; }  // Q16.16 -> px

// Le head + estado + sujos + eventos do ultimo STEP.
var st = { px: 0, py: 0, score: 0, tick: 0, flags: 0, coinMask: 0, coinCell: [], sparkCell: 0xFFFF };
var dirty = [], events = [];

function readOut() {
    var head = readBytes(outOff, OUT_HEAD);
    if (head === null) return false;
    if (rb16(head, 0) !== 1) return false;   // CELER_CORE_VERSION
    var nState = rb16(head, 2);
    var nEvents = rb16(head, 4);
    var nDirty = rb16(head, 6);
    if (nState <= 0 || nState > 2048) return false;
    stateBytes = nState;

    var body = readBytes(outOff + OUT_HEAD, nState + nDirty * 2);
    if (body === null) return false;
    st.px = i32(body, 0);
    st.py = i32(body, 4);
    st.score = rb16(body, 8);
    st.tick = rb16(body, 10);
    st.flags = rb16(body, 12);
    st.coinMask = rb16(body, 14);
    for (var i = 0; i < 8; i++) st.coinCell[i] = rb16(body, 16 + i * 2);
    st.sparkCell = rb16(body, 32);

    dirty.length = 0;
    for (var d = 0; d < nDirty; d++) dirty.push(rb16(body, nState + d * 2));

    events.length = 0;
    if (nEvents > 0) {
        var ev = readBytes(outOff + OUT_HEAD + nState + DIRTY_BYTES, nEvents * 8);
        if (ev !== null) {
            for (var e = 0; e < nEvents; e++) {
                var o = e * 8;
                events.push({ type: rb16(ev, o), a: rb16(ev, o + 2), b: rb16(ev, o + 4), c: rb16(ev, o + 6) });
            }
        }
    }
    return true;
}

// ---- desenho -------------------------------------------------------------
var C_BG1 = 0x18C3, C_BG2 = 0x20E3, C_GRID = 0x3186;
var C_COIN = 0xFE60, C_PLAYER = 0x4BF3, C_SPARK = 0xFBE0, C_TEXT = 0xFFFF;

function drawCell(c) {
    var cx = c % COLS, cy = (c / COLS) | 0;
    var x = BX + cx * CELL, y = BY + cy * CELL;
    S.fillRect(x, y, CELL, CELL, ((cx + cy) & 1) ? C_BG2 : C_BG1);
    for (var i = 0; i < 8; i++) {
        if ((st.coinMask & (1 << i)) === 0 && st.coinCell[i] === c) {
            S.fillCircle(x + CELL / 2, y + CELL / 2, 7, C_COIN);
        }
    }
    if (st.sparkCell === c) S.drawRect(x + 2, y + 2, CELL - 4, CELL - 4, C_SPARK);
}

function drawPlayer() {
    var x = BX + fx(st.px), y = BY + fx(st.py);
    S.fillCircle(x + CELL / 2, y + CELL / 2, 10, C_PLAYER);
    S.drawCircle(x + CELL / 2, y + CELL / 2, 10, 0xFFFF);
}

function drawHud() {
    S.setTextColor(C_TEXT);
    S.drawString("SCORE " + st.score, 10, 10, 2);
    S.drawString("TICK " + st.tick, 10, 30, 1);
}

// ---- input (canvas nativo: dedos em px fisicos) --------------------------
var fingers = {};
function pollInput() {
    var ts = S.getTouches ? S.getTouches() : [];
    var mask = 0;
    var seen = {};
    for (var i = 0; i < ts.length; i++) {
        var t = ts[i];
        seen[t.id] = 1;
        // zona esquerda: direcional por setor; zona direita: botao B
        if (t.x < W * 0.45) {
            var dx = t.x - W * 0.22, dy = t.y - H * 0.72;
            if (Math.abs(dx) > Math.abs(dy)) mask |= dx < 0 ? IN_LEFT : IN_RIGHT;
            else mask |= dy < 0 ? IN_UP : IN_DOWN;
        } else {
            mask |= IN_B;
        }
    }
    fingers = seen;
    return mask;
}

// ---- laco ----------------------------------------------------------------
if (!loadCore()) {
    S.fillScreen(0);
    S.setTextColor(0xF800);
    S.drawString("core.bin nao carregou", 20, 120, 2);
    S.delay(3000);
    S.exitApp();
}

var first = true;
while (true) {
    var inMask = pollInput();
    ctl(CORE_STEP, inMask);
    readOut();

    if (first) {
        S.fillScreen(0);
        for (var c = 0; c < COLS * ROWS; c++) drawCell(c);
        first = false;
    } else {
        for (var d = 0; d < dirty.length; d++) drawCell(dirty[d]);
    }
    // o jogador anda DENTRO da celula: redesenha a celula dele todo quadro
    drawCell(((fx(st.py) / CELL) | 0) * COLS + ((fx(st.px) / CELL) | 0));
    drawPlayer();
    drawHud();
    for (var e = 0; e < events.length; e++) {
        if (events[e].type === 2 && S.beep) S.beep(880, 40);   // moeda
        if (events[e].type === 1 && S.beep) S.beep(440, 60);   // sinal
        if (events[e].type === 3) { S.setTextColor(0x07E0); S.drawString("VOCE VENCEU", BX, BY + BH + 6, 2); }
    }
    S.delay(16);
}
