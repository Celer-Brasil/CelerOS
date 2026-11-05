// Anemoia — emulador de NES do CelerOS (nucleo nativo main/Nes, API 57).
//
// O app e a casca: lista as ROMs (.nes em /sd/roms e /local/roms), desenha
// o frame do nucleo (Nes.frame blita no sprite; System.drawSprite escala),
// mapeia toque -> bitmask do controller (d-pad por traco na esquerda, A/B
// na direita, Start/Select no centro; multitouch API 43) e guarda save
// states por ROM em slots no appData. Pausa = Start+Select juntos (mesmo
// gesto do Anemoia original) ou toque no canto superior direito.
//
// Canvas nativo (API 28): pixels fisicos do vidro, o sprite nasce exato
// 256x240 e o toque chega nas coordenadas do vidro. Pede firmware com o
// objeto Nes (1.15.0+, placas com PSRAM) — feature-detect com mensagem.
//
// Baseado no Anemoia-ESP32 de Shim06 (GPLv3). O app nao vem com jogos.

// ---- bitmask do controller (mesma ordem do Anemoia/NES) ----------------
var BTN_A = 1, BTN_B = 2, BTN_SELECT = 4, BTN_START = 8;
var BTN_UP = 16, BTN_DOWN = 32, BTN_LEFT = 64, BTN_RIGHT = 128;

var S = System;

if (typeof Nes === "undefined") {
    // firmware sem o nucleo: mensagem e sai (a Loja ja bloqueia placas sem
    // PSRAM; este caso e firmware velho no aparelho novo)
    S.fillScreen(0);
    S.setTextColor(0xFFFF, 0);
    S.drawString("Anemoia", 60, 90, 4);
    S.setTextColor(0xC618, 0);
    S.drawString("Precisa do firmware 1.15.0+", 20, 150, 1);
    S.drawString("(objeto Nes, API 57). Atualize", 20, 164, 1);
    S.drawString("pela Loja ou OTA.", 20, 178, 1);
    S.delay(3500);
    S.exitApp();
}

S.setNativeCanvas(true);
var W = S.screenWidth();
var H = S.screenHeight();

// Frame direto no quadro do Kui (bindFrame): a PPU escreve a regiao do jogo
// sem copia; o laco so limpa a tela, desenha os controles e roda o quadro.

// ---- layout -------------------------------------------------------------
// Jogo em cima (256x240 1:1, centrado pelo bindFrame), controles embaixo.
var CH = Math.round(H * 0.2);            // altura da faixa de controles
if (CH < 78) CH = 78; if (CH > 130) CH = 130;
var FH = 240;                            // altura do frame no vidro (1:1)
var GY = 0;

var R = Math.max(20, Math.min(32, Math.round(W * 0.062)));  // raio de A/B
var A_X = W - Math.round(R * 2.6), A_Y = H - Math.round(R * 2.6);
var B_X = W - Math.round(R * 6.4), B_Y = H - Math.round(R * 1.4);
var SS_W = Math.round(R * 2.0), SS_H = Math.round(R * 0.9);
var SS_Y = H - SS_H - 6;
var SEL_X = Math.round(W * 0.30);
var STA_X = Math.round(W * 0.425);
var PAUSE_X = W - 56, PAUSE_W = 56, PAUSE_H = 44;
var DPAD_MAX_X = Math.round(W * 0.42);
var DEAD = Math.max(12, Math.round(W * 0.033));  // zona morta do d-pad

// ---- cores --------------------------------------------------------------
var C_PANEL = 0x1082;
var C_TEXT = 0xFFFF, C_DIM = 0x8410, C_ACC = 0x4BF3, C_OK = 0x07E0, C_ERR = 0xF800;

// ---- estado -------------------------------------------------------------
var screen = "sel";          // sel | game | pause | err
var errMsg = "";
var roms = [];               // [{name, path, size}]
var listOff = 0;
var romName = "";
var slotMsg = "";
var skipMode = (typeof Storage !== "undefined" && Storage.get("skip") === "1");
var audioOff = false;  // true desliga o audio (bancada)
var frameNo = 0;

// Dedos vivos: id -> {ax, ay, x, y} (a = onde POUSOU). `fresh` marca quem
// chegou NESTE quadro — cada tela decide o que chegada nova significa.
var fingers = {};
var freshIds = [];

// Coleta UMA vez por quadro (o chrome consome so o primario; getTouches e
// a cedida certa para multitoque). Devolve a lista crua.
function pollTouch() {
    var ts = S.getTouches();
    freshIds = [];
    var seen = {};
    for (var i = 0; i < ts.length; i++) {
        var t = ts[i];
        seen[t.id] = true;
        if (!fingers[t.id]) {
            fingers[t.id] = { ax: t.x, ay: t.y, x: t.x, y: t.y };
            freshIds.push(t.id);
        } else {
            fingers[t.id].x = t.x;
            fingers[t.id].y = t.y;
        }
    }
    for (var id in fingers) {
        if (!seen[id]) delete fingers[id];
    }
    return ts;
}

// ---- fs -----------------------------------------------------------------
var dataDir = FS.appData();
if (!FS.exists(dataDir)) { try { FS.mkdir(dataDir); } catch (e) {} }

function romBase() {
    var n = romName, i = n.lastIndexOf(".");
    if (i > 0) n = n.substring(0, i);
    return n;
}
function slotPath(n) { return dataDir + "/" + romBase() + ".s" + n; }

function scanRoms() {
    roms = [];
    var dirs = ["/sd/roms", "/local/roms"];
    for (var d = 0; d < dirs.length; d++) {
        var files = [];
        try { files = FS.listDir(dirs[d]); } catch (e) { continue; }
        for (var i = 0; i < files.length; i++) {
            // contrato do listDir: cada item JA e o path completo (path+"/"+nome)
            var p = files[i];
            var low = p.toLowerCase();
            if (low.length <= 4 || low.substring(low.length - 4) !== ".nes") continue;
            var sz = 0;
            try { sz = FS.getFileSize(p); } catch (e) {}
            roms.push({ name: p.substring(p.lastIndexOf("/") + 1), path: p, size: sz });
        }
    }
    // ordena por nome (case-insensitive, insertion sort — lista pequena)
    for (var a = 1; a < roms.length; a++) {
        var key = roms[a], k = key.name.toLowerCase(), b = a - 1;
        while (b >= 0 && roms[b].name.toLowerCase() > k) { roms[b + 1] = roms[b]; b--; }
        roms[b + 1] = key;
    }
}

function openRom(idx) {
    romName = roms[idx].name;
    listOff = 0;
    Nes.unload();
    if (!Nes.load(roms[idx].path)) {
        errMsg = romName + " nao abriu (nao e iNES, grande demais ou mapper fora da lista: 0/1/2/3/4/69).";
        screen = "err";
        return;
    }
    screen = "game";
    slotMsg = "";
    Nes.bindFrame();   // o load solta o alvo (reset por ROM): re-aponta
    needClear = true;  // tira a tela da lista do vidro no primeiro quadro
    Nes.reset();
    if (!audioOff) Nes.audioStart();
}

// ---- desenho ------------------------------------------------------------
function txt(s, x, y, color, font) {
    S.setTextColor(color, 0);
    S.drawString(s, x, y, font || 1);
}
function txtCenter(s, cx, y, color, font) {
    S.setTextColor(color, 0);
    var w = S.textWidth(s, font || 1);
    S.drawString(s, Math.round(cx - w / 2), y, font || 1);
}
function dist(x, y, cx, cy) {
    var dx = x - cx, dy = y - cy;
    return Math.sqrt(dx * dx + dy * dy);
}

// ---- d-pad por traco ------------------------------------------------------
// Direcao do dedo ANCORSADO na chegada; zona morta; 8 setores de 45 graus.
function dpadBits(x, y) {
    var dx = x - ax_, dy = y - ay_;
    if (Math.abs(dx) < DEAD && Math.abs(dy) < DEAD) return 0;
    var deg = Math.atan2(dy, dx) * 180 / Math.PI;
    if (deg >= -22.5 && deg < 22.5) return BTN_RIGHT;
    if (deg >= 22.5 && deg < 67.5) return BTN_RIGHT | BTN_DOWN;
    if (deg >= 67.5 && deg < 112.5) return BTN_DOWN;
    if (deg >= 112.5 && deg < 157.5) return BTN_LEFT | BTN_DOWN;
    if (deg >= 157.5 || deg < -157.5) return BTN_LEFT;
    if (deg >= -157.5 && deg < -112.5) return BTN_LEFT | BTN_UP;
    if (deg >= -112.5 && deg < -67.5) return BTN_UP;
    return BTN_RIGHT | BTN_UP;
}
var ax_ = 0, ay_ = 0;

// Mascara do controller a partir dos dedos vivos (so na tela de jogo;
// cada dedo classificou o SEU papel na chegada).
var btnsMask = 0;
var pauseHit = false;

function pollGame() {
    var ts = pollTouch();
    btnsMask = 0;
    pauseHit = false;
    for (var i = 0; i < freshIds.length; i++) {
        var f = fingers[freshIds[i]];
        var kind = classifyArrival(f.ax, f.ay);
        if (kind === "pause") { pauseHit = true; f.kind = "dead"; }
        else f.kind = kind;   // "" = dedo no jogo (sem papel)
    }
    for (var id in fingers) {
        var f = fingers[id];
        if (f.kind === "dpad") { ax_ = f.ax; ay_ = f.ay; btnsMask |= dpadBits(f.x, f.y); }
        else if (f.kind === "a") btnsMask |= BTN_A;
        else if (f.kind === "b") btnsMask |= BTN_B;
        else if (f.kind === "start") btnsMask |= BTN_START;
        else if (f.kind === "select") btnsMask |= BTN_SELECT;
    }
}
function classifyArrival(x, y) {
    if (x >= PAUSE_X && y <= PAUSE_H) return "pause";
    if (dist(x, y, A_X, A_Y) <= R * 1.7) return "a";
    if (dist(x, y, B_X, B_Y) <= R * 1.7) return "b";
    if (y >= SS_Y - SS_H && y <= SS_Y + SS_H * 2) {
        if (x >= STA_X && x <= STA_X + SS_W) return "start";
        if (x >= SEL_X - SS_W && x <= SEL_X + SS_W) return "select";
    }
    if (x < DPAD_MAX_X && y >= GY + FH) return "dpad";
    return "";
}

// ---- primitivas de controle desenhadas -----------------------------------
function drawBtn(cx, cy, r, on, label) {
    S.fillSmoothCircle(cx, cy, r, on ? C_ACC : 0x18E3);
    S.drawCircle(cx, cy, r, 0x4229);
    txtCenter(label, cx, cy - 6, on ? 0 : C_TEXT, 2);
}
function drawPill(x, y, on, label) {
    S.fillRoundRect(x, y, SS_W, SS_H, 4, on ? C_ACC : 0x2104);
    S.drawRoundRect(x, y, SS_W, SS_H, 4, on ? C_ACC : 0x4229);
    txtCenter(label, x + Math.round(SS_W / 2), y + 2, on ? 0 : C_TEXT);
}

function drawControls(clearBand) {
    // A banda de fundo so na entrada (o resto do redesenho sao os botoes em
    // cima): mudanca de estado marca caixas pequenas, nao a banda inteira.
    if (clearBand) S.fillRect(0, GY + FH, W, H - GY - FH, C_PANEL);
    var dpadOn = (btnsMask & (BTN_UP | BTN_DOWN | BTN_LEFT | BTN_RIGHT)) !== 0;
    var dcx = Math.round(DPAD_MAX_X / 2), dcy = GY + FH + Math.round((H - GY - FH) / 2);
    S.drawCircle(dcx, dcy, Math.round(R * 1.3), dpadOn ? C_ACC : 0x3186);
    txtCenter("D-PAD", dcx, dcy - 4, dpadOn ? C_ACC : C_DIM);
    drawBtn(A_X, A_Y, R, (btnsMask & BTN_A) !== 0, "A");
    drawBtn(B_X, B_Y, R, (btnsMask & BTN_B) !== 0, "B");
    drawPill(SEL_X, SS_Y, (btnsMask & BTN_SELECT) !== 0, "SEL");
    drawPill(STA_X, SS_Y, (btnsMask & BTN_START) !== 0, "STA");
    // pausa: FORA da regiao do jogo (o bindFrame escreve 256x240 centrado =
    // x 112..368; o botao vive em x 424..480), entao nao e sobrescrito pelo
    // quadro do NES e pode ficar na camada suja do Kui
    S.fillRect(PAUSE_X, 0, PAUSE_W, PAUSE_H, 0);
    S.drawRect(PAUSE_X, 0, PAUSE_W, PAUSE_H, 0x3186);
    txt("II", PAUSE_X + 22, 14, C_DIM, 2);
}

// ---- tela: lista de ROMs ---------------------------------------------------
var ROW_H = 44;
var LIST_TOP = 44;

function drawSel() {
    S.fillScreen(C_PANEL);
    txt("ANEMOIA", 8, 6, C_ACC, 4);
    txt(roms.length + (roms.length === 1 ? " ROM" : " ROMs"), W - 74, 26, C_DIM);
    S.drawLine(0, 38, W, 38, 0x3186);
    if (roms.length === 0) {
        txtCenter("Sem ROMs", W / 2, 120, C_TEXT, 2);
        txtCenter("Ponha arquivos .nes em", W / 2, 152, C_DIM);
        txtCenter("/sd/roms ou /local/roms", W / 2, 166, C_DIM);
        txtCenter("(celerctl push)", W / 2, 180, C_DIM);
        return;
    }
    var maxOff = roms.length * ROW_H - (H - LIST_TOP - 24);
    if (maxOff < 0) maxOff = 0;
    if (listOff > maxOff) listOff = maxOff;
    var y = LIST_TOP - listOff;
    for (var i = 0; i < roms.length; i++) {
        if (y + ROW_H >= LIST_TOP && y <= H) {
            var hot = rowArrived(y);
            if (hot) S.fillRect(0, y, W, ROW_H, 0x1886);
            txt(roms[i].name, 10, y + 5, hot ? C_ACC : C_TEXT, 2);
            txt(Math.round(roms[i].size / 1024) + " KB", 10, y + 26, C_DIM);
        }
        y += ROW_H;
    }
    txtCenter("toque abre - arraste rola", W / 2, H - 14, 0x3186);
}
function rowArrived(y) {
    for (var i = 0; i < freshIds.length; i++) {
        var f = fingers[freshIds[i]];
        if (f.ay >= y && f.ay < y + ROW_H) return true;
    }
    return false;
}

function loopSel() {
    var ts = pollTouch();
    if (roms.length === 0) { drawSel(); UI.end(30); return; }

    // chegada dentro de uma linha visivel -> abre
    for (var i = 0; i < freshIds.length; i++) {
        var f = fingers[freshIds[i]];
        if (f.ay < LIST_TOP || f.ay > H - 24) continue;
        var idx = Math.floor((f.ay + listOff - LIST_TOP) / ROW_H);
        if (idx >= 0 && idx < roms.length) { fingers = {}; freshIds = []; openRom(idx); return; }
    }
    // arrasto do primario rola a lista (delta desde o pousou)
    if (ts.length > 0) {
        var p = fingers[ts[0].id];
        if (p && p.ay >= LIST_TOP) {
            var dy = p.ay - p.y;
            if (dy > 2) listOff += dy; if (dy < -2) listOff += dy;
            if (listOff < 0) listOff = 0;
        }
    }
    drawSel();
    UI.end(30);
}

// ---- tela: pausa -----------------------------------------------------------
var MENU = ["Continuar", "Reset", "Salvar estado", "Carregar estado", "Frameskip", "Sair"];
var menuSub = 0;      // 0 = menu, 1 = slots salvar, 2 = slots carregar
var menuHover = -1;   // linha sob o dedo AGORA
var menuArm = -1;     // linha onde um dedo POUSOU (dispara na saida)
var hadMenuTouch = false;

function slotInfo(n) {
    var p = slotPath(n);
    if (FS.exists(p)) {
        var sz = 0;
        try { sz = FS.getFileSize(p); } catch (e) {}
        return "slot " + (n + 1) + "  -  " + Math.round(sz / 1024) + " KB";
    }
    return "slot " + (n + 1) + "  -  vazio";
}
function menuItems() {
    if (menuSub === 0) return MENU;
    var items = [];
    for (var i = 0; i < 3; i++) items.push(slotInfo(i));
    return items;
}
function menuLabel(i, s) {
    if (menuSub === 0 && i === 4) return "Frameskip: " + (skipMode ? "auto" : "off");
    return s;
}

function drawPause() {
    S.fillScreen(C_PANEL);
    txt(romBase(), 8, 6, C_ACC, 2);
    S.drawLine(0, 26, W, 26, 0x3186);
    var items = menuItems();
    var y = 36;
    for (var i = 0; i < items.length; i++) {
        var on = (i === menuHover);
        if (on) S.fillRect(0, y, W, ROW_H, 0x1886);
        txt(menuLabel(i, items[i]), 12, y + 12, on ? C_ACC : C_TEXT, 2);
        y += ROW_H;
    }
    if (slotMsg) txtCenter(slotMsg, W / 2, y + 10, C_OK);
    txtCenter("Start+Select pausa - canto sup. dir. tambem", W / 2, H - 14, 0x3186);
}

function doMenu(i) {
    if (menuSub === 1) {
        slotMsg = Nes.saveState(slotPath(i)) ? "salvo no slot " + (i + 1) : "falhou ao salvar";
        menuSub = 0; menuArm = -1; return;
    }
    if (menuSub === 2) {
        if (!FS.exists(slotPath(i))) slotMsg = "slot vazio";
        else if (Nes.loadState(slotPath(i))) { slotMsg = "carregado do slot " + (i + 1); }
        else slotMsg = "state invalido";
        menuSub = 0; menuArm = -1; return;
    }
    var item = MENU[i];
    if (item === "Continuar") resumeGame();
    else if (item === "Reset") { Nes.reset(); slotMsg = ""; resumeGame(); }
    else if (item === "Salvar estado") { menuSub = 1; menuArm = -1; }
    else if (item === "Carregar estado") { menuSub = 2; menuArm = -1; }
    else if (item === "Frameskip") {
        skipMode = !skipMode;
        if (typeof Storage !== "undefined") Storage.set("skip", skipMode ? "1" : "0");
    }
    else if (item === "Sair") S.exitApp();
}

function loopPause() {
    var ts = pollTouch();
    menuHover = -1;
    for (var m = 0; m < ts.length; m++) {
        var i3 = Math.floor((ts[m].y - 36) / ROW_H);
        if (ts[m].y >= 36 && i3 >= 0 && i3 < menuItems().length) menuHover = i3;
    }
    // braço armado na chegada; dispara quando TODOS os dedos saem
    for (var i = 0; i < freshIds.length; i++) {
        var f = fingers[freshIds[i]];
        var i4 = Math.floor((f.ay - 36) / ROW_H);
        menuArm = (f.ay >= 36 && i4 >= 0 && i4 < menuItems().length) ? i4 : -1;
        hadMenuTouch = menuArm >= 0;
    }
    if (ts.length === 0) {
        if (hadMenuTouch && menuArm >= 0) {
            var chosen = menuArm;
            hadMenuTouch = false; menuArm = -1; menuHover = -1;
            doMenu(chosen);
            return;
        }
        hadMenuTouch = false;
    }
    drawPause();
    UI.end(30);
}

// ---- tela: erro -------------------------------------------------------------
function drawErr() {
    S.fillScreen(C_PANEL);
    txtCenter("Ops", W / 2, 80, C_ERR, 4);
    var rest = errMsg, y = 140;
    while (rest.length > 0 && y < H - 40) {
        var cut = Math.min(34, rest.length);
        if (cut < rest.length) {
            var sp = rest.lastIndexOf(" ", cut);
            if (sp > 10) cut = sp;
        }
        txtCenter(rest.substring(0, cut), W / 2, y, C_TEXT);
        rest = rest.substring(cut);
        y += 16;
    }
    txtCenter("toque para voltar", W / 2, H - 24, C_DIM);
}
function loopErr() {
    var ts = pollTouch();
    if (ts.length > 0) { screen = "sel"; fingers = {}; return; }
    drawErr();
    UI.end(30);
}

// ---- ciclo do jogo ----------------------------------------------------------
// bindFrame escreve o quadro do NES DIRETO no vidro (scanline a scanline, sem
// copia); o Kui so leva a banda de controles pelas caixas sujas. Por isso:
// limpa o quadro UMA vez ao entrar (o resto do vidro fica preto) e redesenha
// os controles so quando o estado deles muda — nada de fillScreen por quadro.
var needClear = true;
var bandSig = -1;

function loopGame() {
    pollGame();
    if (pauseHit) { pauseGame(); return; }
    if ((btnsMask & BTN_START) !== 0 && (btnsMask & BTN_SELECT) !== 0) { pauseGame(); return; }
    if (needClear) {
        S.fillScreen(0);   // unica limpeza: tira a tela anterior do vidro
        drawControls(true);
        bandSig = btnsMask;
        needClear = false;
    } else if (btnsMask !== bandSig) {
        drawControls(false);
        bandSig = btnsMask;
    }
    var render = true;
    if (skipMode) render = (frameNo % 2) === 0;
    Nes.frame(btnsMask, render);
    UI.end(60);
}

function pauseGame() {
    screen = "pause";
    menuSub = 0; menuArm = -1; menuHover = -1; hadMenuTouch = false;
    slotMsg = "";
    fingers = {}; freshIds = [];
    Nes.audioStop();
}
function resumeGame() {
    screen = "game";
    fingers = {}; freshIds = [];
    needClear = true;  // o menu de pausa pintou o vidro inteiro: limpa 1x
    if (!audioOff) Nes.audioStart();
}

// ---- laco principal ----------------------------------------------------------
S.keepAwake(true);
scanRoms();

while (true) {
    frameNo++;
    if (screen === "game") loopGame();
    else if (screen === "sel") loopSel();
    else if (screen === "pause") loopPause();
    else loopErr();
}
