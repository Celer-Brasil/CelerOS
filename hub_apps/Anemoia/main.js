// Anemoia — emulador de NES do CelerOS (nucleo nativo em blob CLRN).
//
// O app e a casca: lista as ROMs (.nes em /sd/roms e /local/roms), alimenta
// o core com o bitmask do controle, desenha o quadro ESCALADO PARA O VIDRO
// INTEIRO (256x240 -> 480x450, nearest) e poe os controles POR CIMA em
// overlay translucido (System.setAlpha, API 59): d-pad analogico flutuante a
// esquerda (a base assenta onde o dedo pousa e o knob acompanha o traco),
// A/B a direita e SEL/STA no meio de baixo. Multitouch (API 43): cada dedo
// classifica o proprio papel na chegada.
//
// Pausa = botao no canto superior direito, Start+Select juntos ou o icone de
// pausa; o menu tem Reset, 3 slots de save state por ROM no appData e
// frameskip. Canvas nativo (API 28): pixels fisicos do vidro.
//
// Baseado no Anemoia-ESP32 de Shim06 (GPLv3). O app nao vem com jogos.

// ---- bitmask do controller (mesma ordem do Anemoia/NES) ----------------
var BTN_A = 1, BTN_B = 2, BTN_SELECT = 4, BTN_START = 8;
var BTN_UP = 16, BTN_DOWN = 32, BTN_LEFT = 64, BTN_RIGHT = 128;

var S = System;

var HAS_NAT = S.getInfo().hasNative === true &&
              typeof S.nativeLoad === "function" && typeof S.nativeCall === "function";
if (!HAS_NAT) {
    // placa/build sem o acelerador nativo: a Loja ja bloqueia pelo requires
    // (badge S3); este caso e firmware antigo ou build sem a flag
    S.fillScreen(0);
    S.setTextColor(0xFFFF, 0);
    S.drawString("Anemoia", 60, 90, 4);
    S.setTextColor(0xC618, 0);
    S.drawString("Precisa do CelerOS 1.17+", 20, 150, 1);
    S.drawString("(API 59, nucleo nativo no build).", 20, 164, 1);
    S.delay(3500);
    S.exitApp();
}

S.setNativeCanvas(true);
var W = S.screenWidth();
var H = S.screenHeight();

// O nucleo entrega o quadro JA ESCALADO (core_ctl SET_SCALE): nada de
// sprite intermediario nem pushRotateZoom por pixel no JS.

// ---- nucleo nativo (API 58): MESMO contrato do antigo objeto Nes de
// firmware, agora sobre o blob CLRN que viaja com o app (appDir/nes_core.bin).
// O core devolve os offsets do proprio layout (core_ctl 1..5): ROM/PCM/FB/
// STATE — o app nunca hardcoda numeros de .bss.
var N = (function () {
    var h = 0, romOff = 0, pcmOff = 0, fbOff = 0, stateOff = 0, scaleOff = 0;
    var audioOn = false;
    var direct = false, slotArg = [];
    var NO_TARGET = 4294967295;
    var HAS_SCREEN = typeof S.nativeScreen === "function" && typeof S.nativeGrab === "function";
    function ctl(cmd, arg) { return S.nativeCall(h, 0, cmd, arg || 0); }
    return {
        load: function (path, romBytes) {
            if (h > 0) S.nativeFree(h);
            // scratch: ~1,3 MB fixos do core (PCM/FB/escalado/estado/arena/
            // carimbos) + a ROM, que fica no fim; INIT diz quanto de ROM cabe
            var kb = 1340 + Math.ceil((romBytes || 1048576) / 1024);
            // firmware < API 60 corta a scratch em 1664 KB sem avisar: o
            // INIT tem de saber o tamanho REAL (ROM grande demais = erro)
            if (S.getAPILevel() < 60 && kb > 1664) kb = 1664;
            h = S.nativeLoad(System.appDir() + "/nes_core.bin", kb);
            if (h <= 0) return false;
            if (ctl(0, kb) < (romBytes || 1)) return false;   // INIT
            romOff = ctl(1); pcmOff = ctl(2); fbOff = ctl(3); stateOff = ctl(4);
            // 12 = SET_SCALE: o core escala 256x240 -> (W, GH) no FRAME
            scaleOff = ctl(12, (W << 16) | GH);
            ctl(13, audioOff ? 0 : 1);           // APU fora do laco sem audio
            var n = S.nativeLoadFile(h, romOff, path);
            return n > 0 && ctl(6, n) === 1;     // LOAD
        },
        reset: function () { if (h > 0) ctl(7); },
        frame: function (btns, render) {
            if (h <= 0) return;
            var arg = ((btns | 0) & 0xFF) | (render ? 0x100 : 0);
            // API 60: o core escreve o quadro escalado + overlay DIRETO no
            // vidro (uma passada de PSRAM). Sem alvo (faixa visivel, AOD,
            // firmware antigo) cai no FRAME + nativeDraw de antes.
            direct = HAS_SCREEN && S.nativeScreen(h, 0, 15, arg, 0, GY, W, GH) !== NO_TARGET;
            if (!direct) {
                ctl(8, arg);
                if (render && scaleOff > 0) S.nativeDraw(h, scaleOff, 0, GY, W, GH);
            }
            if (audioOn) {
                var n = ctl(11);                 // PCM do quadro
                if (n > 0) S.nativeAudio(h, pcmOff, n);
            }
        },
        direct: function () { return direct; },
        // Carimbo `id` (w x h) do overlay: draw(x, y) desenha o controle no
        // quadro com a API normal, uma vez sobre PRETO e outra sobre BRANCO;
        // o core tira alpha e cor pre-multiplicada da diferenca.
        stamp: function (id, w, hh, draw) {
            if (h <= 0 || !HAS_SCREEN) return false;
            var offs = [ctl(16, 0), ctl(16, 1)], bg = [0x0000, 0xFFFF];
            for (var i = 0; i < 2; i++) {
                S.setAlpha(255);
                S.fillRect(0, 0, w, hh, bg[i]);
                draw(0, 0);
                S.setAlpha(255);
                if (!S.nativeGrab(h, offs[i], 0, 0, w, hh)) return false;
            }
            return ctl(17, id | (w << 5) | (hh << 15)) === 1;
        },
        // slot 0..7 recebe o carimbo id em (x, y) do vidro; id < 0 esvazia
        place: function (slot, id, x, y) {
            var a = id < 0 ? (slot | (63 << 4))
                           : (slot | (id << 4) | ((x + 256) << 10) | ((y - GY + 256) << 20));
            if (slotArg[slot] === a) return;
            slotArg[slot] = a;
            ctl(18, a);
        },
        stampReset: function () {
            if (h > 0) ctl(19);
            slotArg = [];
        },
        audioStart: function () {
            audioOn = h > 0;
            if (h > 0) ctl(13, 1);
            return audioOn;
        },
        audioStop: function () {
            audioOn = false;
            if (h > 0) { ctl(13, 0); S.nativeAudioStop(h); }
        },
        saveState: function (p) {
            if (h <= 0) return false;
            var n = ctl(9);
            return n > 0 && S.nativeSaveFile(h, stateOff, n, p);
        },
        loadState: function (p) {
            if (h <= 0) return false;
            var n = S.nativeLoadFile(h, stateOff, p);
            return n > 0 && ctl(10, n) === 1;
        },
        unload: function () {
            if (h > 0) { S.nativeAudioStop(h); S.nativeFree(h); h = 0; }
            audioOn = false;
        },
    };
})();

// ---- layout: jogo em TELA CHEIA + overlay --------------------------------
// O frame 256x240 escala para a largura do vidro e fica centrado na
// vertical; as barras que sobram (480x450 -> 15 px em cima/baixo) ficam
// pretas (fillScreen na entrada).
var SCALE = W / 256;
var GH = Math.round(240 * SCALE);
var GY = Math.round((H - GH) / 2);

// d-pad analogico flutuante: vive no canto inferior esquerdo, a base assenta
// no ponto do POUSO (limitada a zona) e o knob segue o traco clampado
var DP_RING = Math.round(Math.min(W, H) * 0.13);      // 62 no 4848
var KNOB_R = Math.round(DP_RING * 0.42);
var KNOB_TRAVEL = Math.round(DP_RING * 0.61);
var DP_HOME_X = Math.round(W * 0.175);
var DP_HOME_Y = H - Math.round(H * 0.183);
var DP_ZONE_W = Math.round(W * 0.40);                 // x < 192
var DP_ZONE_Y = Math.round(H * 0.45);                 // y > 216
var DEAD = Math.max(10, Math.round(DP_RING * 0.18));

// A/B: cluster da direita (A em cima/direita, B embaixo/esquerda), encostado
// na borda direita — com o raio de 0,098*W o B chega em x=269 e as pilulas
// precisam terminar antes disso.
var AB_R = Math.round(Math.min(W, H) * 0.098);
var A_X = W - AB_R - 14;
var A_Y = H - Math.round(AB_R * 2.05);
var B_X = A_X - Math.round(AB_R * 2.2);
var B_Y = A_Y + Math.round(AB_R * 0.67);

// SEL/STA: pilulas no meio de baixo, COM folga do cluster A/B e do d-pad
var SS_W = Math.round(W * 0.130);
var SS_H = Math.round(H * 0.052);
var SS_Y = H - Math.round(SS_H * 1.6);
var SEL_X = Math.round(W * 0.275);
var STA_X = Math.round(W * 0.415);

// pausa: canto superior direito, sobre o jogo (translucido)
var PAUSE_R = Math.max(11, Math.round(Math.min(W, H) * 0.030));
var PAUSE_X = W - PAUSE_R - Math.round(PAUSE_R * 0.9);
var PAUSE_Y = PAUSE_R + Math.round(PAUSE_R * 0.9);

// ---- cores --------------------------------------------------------------
var C_PANEL = 0x1082;
var C_TEXT = 0xFFFF, C_DIM = 0x8410, C_ACC = 0x4BF3, C_OK = 0x07E0, C_ERR = 0xF800;
var C_SOFT = 0xE71C;   // texto do overlay (cinza claro)

// ---- estado -------------------------------------------------------------
var screen = "sel";          // sel | game | pause | err
var errMsg = "";
var roms = [];               // [{name, path, size}]
var listOff = 0;
var romName = "";
var slotMsg = "";
var skipMode = (typeof Storage === "undefined") || Storage.get("skip") !== "0";
var audioOff = false;  // APU em lote no core (clockN): o som custa ~1 ms por quadro
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
function slotPath(n) { return dataDir + romBase() + ".s" + n; }   // dataDir ja tem a barra

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
    N.unload();
    if (!N.load(roms[idx].path, roms[idx].size)) {
        errMsg = romName + " nao abriu (nao e iNES, grande demais ou mapper fora da lista: 0/1/2/3/4/69).";
        screen = "err";
        return;
    }
    buildStamps();     // desenha no quadro; o fillScreen do 1o quadro limpa
    screen = "game";
    slotMsg = "";
    needClear = true;  // tira a tela da lista do vidro no primeiro quadro
    dpReset();
    toastStart = S.millis();
    N.reset();
    radioPause();      // modo jogo: sem scan da malha (o controller BLE + msync do painel estalam sob carga)
    if (!audioOff) N.audioStart();
}

// ---- radio ----------------------------------------------------------------
// O controller BLE do chip asserta (r_lld_scan/r_rwble_isr, "causa debug")
// com o scanner da malha ativo durante o emulador: a main a ~50 fps divide o
// core 0 com o BT e o msync do framebuffer do painel suspende o cache por
// janelas. Pausar a malha enquanto o jogo roda tira o scan do caminho; volta
// na saida do jogo. Feature-detect: firmware sem malha so ignora.
var radioOn = false;

function radioPause() {
    if (radioOn) return;
    if (typeof CelerNet === "undefined") return;
    try { CelerNet.stop(); radioOn = true; } catch (e) {}
}
function radioResume() {
    if (!radioOn) return;
    radioOn = false;
    if (typeof CelerNet === "undefined") return;
    try { CelerNet.start({ relay: false }); } catch (e) {}
}

// ---- texto ------------------------------------------------------------
function txt(s, x, y, color, font) {
    S.setTextColor(color, 0);
    S.drawString(s, x, y, font || 1);
}
function txtCenter(s, cx, y, color, font) {
    S.setTextColor(color, 0);
    var w = S.textWidth(s, font || 1);
    S.drawString(s, Math.round(cx - w / 2), y, font || 1);
}
// Texto centrado nos DOIS eixos (rotulos dos botoes do overlay): o
// drawString ancora no topo-esquerda, entao o centro sai de textWidth e
// fontHeight — era isso que deixava "A"/"B"/"SEL"/"STA" fora do lugar.
// Um argumento em setTextColor = fundo TRANSPARENTE: com bg 0 o rotulo
// levava uma caixa preta por cima do jogo.
function txtMid(s, cx, cy, color, font) {
    font = font || 1;
    var tw = S.textWidth(s, font), fh = S.fontHeight(font);
    S.setTextColor(color);
    S.drawString(s, Math.round(cx - tw / 2), Math.round(cy - fh / 2), font);
}
function dist(x, y, cx, cy) {
    var dx = x - cx, dy = y - cy;
    return Math.sqrt(dx * dx + dy * dy);
}

// ---- d-pad analogico ------------------------------------------------------
// Direcao em 8 setores a partir do ponto onde o dedo POUSOU (a "base" do
// stick virtual); zona morta radial. O knob desenhado usa o deslocamento
// clampado ao curso do stick, entao o controle "anima" como um analogico.
var dpBaseX = 0, dpBaseY = 0, dpKnobX = 0, dpKnobY = 0, dpActive = false;

function dpReset() {
    dpBaseX = DP_HOME_X; dpBaseY = DP_HOME_Y;
    dpKnobX = dpBaseX; dpKnobY = dpBaseY;
    dpActive = false;
}

function dpadBits(x, y) {
    var dx = x - dpBaseX, dy = y - dpBaseY;
    if (Math.sqrt(dx * dx + dy * dy) < DEAD) return 0;
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

// Mascara do controller a partir dos dedos vivos (so na tela de jogo;
// cada dedo classificou o SEU papel na chegada).
var btnsMask = 0;
var pauseHit = false;

function pollGame() {
    pollTouch();
    btnsMask = 0;
    pauseHit = false;
    dpActive = false;
    for (var i = 0; i < freshIds.length; i++) {
        var f = fingers[freshIds[i]];
        var kind = classifyArrival(f.ax, f.ay);
        if (kind === "pause") { pauseHit = true; f.kind = "dead"; }
        else f.kind = kind;   // "" = dedo no jogo (sem papel)
    }
    for (var id in fingers) {
        var g = fingers[id];
        if (g.kind === "dpad") {
            // base assenta no pouso (limitada a zona) e o knob segue o traco
            dpActive = true;
            dpBaseX = g.ax; dpBaseY = g.ay;
            if (dpBaseX > DP_ZONE_W - KNOB_R) dpBaseX = DP_ZONE_W - KNOB_R;
            if (dpBaseX < KNOB_R + 2) dpBaseX = KNOB_R + 2;
            if (dpBaseY > H - KNOB_R - 2) dpBaseY = H - KNOB_R - 2;
            if (dpBaseY < DP_ZONE_Y + KNOB_R) dpBaseY = DP_ZONE_Y + KNOB_R;
            var dx = g.x - g.ax, dy = g.y - g.ay;
            var m = Math.sqrt(dx * dx + dy * dy);
            if (m > KNOB_TRAVEL) { dx = dx * KNOB_TRAVEL / m; dy = dy * KNOB_TRAVEL / m; }
            dpKnobX = dpBaseX + dx; dpKnobY = dpBaseY + dy;
            btnsMask |= dpadBits(g.x, g.y);
        }
        else if (g.kind === "a") btnsMask |= BTN_A;
        else if (g.kind === "b") btnsMask |= BTN_B;
        else if (g.kind === "start") btnsMask |= BTN_START;
        else if (g.kind === "select") btnsMask |= BTN_SELECT;
    }
    if (!dpActive) { dpBaseX = DP_HOME_X; dpBaseY = DP_HOME_Y; dpKnobX = DP_HOME_X; dpKnobY = DP_HOME_Y; }
}

function classifyArrival(x, y) {
    if (dist(x, y, PAUSE_X, PAUSE_Y) <= PAUSE_R + 10) return "pause";
    if (dist(x, y, A_X, A_Y) <= AB_R + 10) return "a";
    if (dist(x, y, B_X, B_Y) <= AB_R + 10) return "b";
    if (y >= SS_Y - 8 && y <= SS_Y + SS_H + 8) {
        if (x >= STA_X - 6 && x <= STA_X + SS_W + 6) return "start";
        if (x >= SEL_X - 6 && x <= SEL_X + SS_W + 6) return "select";
    }
    if (x < DP_ZONE_W && y > DP_ZONE_Y) return "dpad";
    return "";
}

// ---- desenho do overlay (translucido: System.setAlpha, API 59) ------------
// Nada cobre o jogo por completo: base escura em alpha baixo + anel e
// rotulos claros. O texto fica opaco por cima do chip escuro (texto nao tem
// alpha) — a leitura melhora e o cenario continua aparecendo em volta.
function drawDpadAt(bx, by, active, on) {
    S.setAlpha(active ? 150 : 90);
    S.drawCircle(bx, by, DP_RING + 6, 0x9CF3);
    S.drawCircle(bx, by, DP_RING - 4, 0x4A69);
    // chevrons das 4 direcoes (linhas, que tem alpha)
    var o = DP_RING - 16, c = 6;
    S.setAlpha(on ? 210 : 90);
    S.drawLine(bx - c, by - o + c, bx, by - o - c, 0xFFFF);
    S.drawLine(bx + c, by - o + c, bx, by - o - c, 0xFFFF);
    S.drawLine(bx - c, by + o - c, bx, by + o + c, 0xFFFF);
    S.drawLine(bx + c, by + o - c, bx, by + o + c, 0xFFFF);
    S.drawLine(bx - o + c, by - c, bx - o - c, by, 0xFFFF);
    S.drawLine(bx - o + c, by + c, bx - o - c, by, 0xFFFF);
    S.drawLine(bx + o - c, by - c, bx + o + c, by, 0xFFFF);
    S.drawLine(bx + o - c, by + c, bx + o + c, by, 0xFFFF);
}
// knob: acompanha o traco (o "analogico" que faltava)
function drawKnobAt(kx, ky, active) {
    S.setAlpha(active ? 210 : 130);
    S.fillCircle(kx, ky, KNOB_R - 4, 0xD69A);
    S.setAlpha(active ? 240 : 170);
    S.drawCircle(kx, ky, KNOB_R, 0xFFFF);
    S.drawCircle(kx, ky, KNOB_R - 4, 0x8C71);
}
function drawDpad() {
    var on = (btnsMask & (BTN_UP | BTN_DOWN | BTN_LEFT | BTN_RIGHT)) !== 0;
    drawDpadAt(dpBaseX, dpBaseY, dpActive, on);
    drawKnobAt(dpKnobX, dpKnobY, dpActive);
}

function drawAB(cx, cy, label, on) {
    S.setAlpha(on ? 175 : 70);
    S.fillCircle(cx, cy, AB_R - 6, 0x0000);
    S.setAlpha(on ? 255 : 120);
    S.drawCircle(cx, cy, AB_R, on ? C_ACC : 0x9CF3);
    S.drawCircle(cx, cy, AB_R - 3, on ? C_ACC : 0x52AA);
    S.setAlpha(255);
    txtMid(label, cx, cy, on ? 0xFFFF : C_SOFT, 4);
}

function drawPillAt(x, y, label, on) {
    S.setAlpha(on ? 185 : 75);
    S.fillRoundRect(x, y, SS_W, SS_H, Math.round(SS_H / 2), 0x0000);
    S.setAlpha(on ? 255 : 120);
    S.drawRoundRect(x, y, SS_W, SS_H, Math.round(SS_H / 2), on ? C_ACC : 0x8C71);
    S.setAlpha(255);
    txtMid(label, x + Math.round(SS_W / 2), y + Math.round(SS_H / 2), on ? 0xFFFF : C_SOFT, 2);
}
function drawPill(x, label, on) { drawPillAt(x, SS_Y, label, on); }

function drawPauseAt(px, py) {
    S.setAlpha(80);
    S.fillCircle(px, py, PAUSE_R, 0x0000);
    S.setAlpha(150);
    S.drawCircle(px, py, PAUSE_R, 0x9CF3);
    S.setAlpha(230);
    var bh = PAUSE_R, bw = Math.max(2, Math.round(PAUSE_R * 0.22));
    S.fillRect(px - Math.round(bw * 1.4), py - (bh >> 1), bw, bh, 0xFFFF);
    S.fillRect(px + Math.round(bw * 0.4), py - (bh >> 1), bw, bh, 0xFFFF);
}
function drawPauseBtn() { drawPauseAt(PAUSE_X, PAUSE_Y); }

var toastStart = 0;

function toastW() { return S.textWidth(romBase(), 1) + 20; }
function drawToastAt(x, y) {
    S.setAlpha(120);
    S.fillRoundRect(x, y, toastW(), 22, 11, 0x0000);
    S.setAlpha(255);
    S.setTextColor(C_SOFT);   // 1 arg = fundo transparente
    S.drawString(romBase(), x + 10, y + 6, 1);
}
function toastOn() {
    var dt = S.millis() - toastStart;
    return dt >= 0 && dt <= 2200;
}
function drawToast() {
    if (toastOn()) drawToastAt(8, GY + 8);
}

// Caminho antigo (sem System.nativeScreen): overlay redesenhado no quadro do
// app a cada quadro renderizado.
function drawOverlay() {
    drawDpad();
    drawAB(A_X, A_Y, "A", (btnsMask & BTN_A) !== 0);
    drawAB(B_X, B_Y, "B", (btnsMask & BTN_B) !== 0);
    drawPill(SEL_X, "SEL", (btnsMask & BTN_SELECT) !== 0);
    drawPill(STA_X, "STA", (btnsMask & BTN_START) !== 0);
    drawPauseBtn();
    drawToast();
    S.setAlpha(255);   // o resto do app (menus) desenha opaco
}

// ---- overlay em CARIMBOS (API 60) -----------------------------------------
// Cada controle/estado e desenhado UMA vez na entrada do jogo e vira um
// carimbo no core; por quadro o app so diz qual carimbo vai em que lugar e
// o core compoe junto com a escala, na mesma passada do vidro. O overlay
// redesenhado por JS custava ~12 ms por quadro mais o present do quadro.
var ST_DPAD = 0, ST_KNOB = 3, ST_A = 5, ST_B = 7, ST_SEL = 9, ST_STA = 11,
    ST_PAUSE = 13, ST_TOAST = 14;
var DP_BOX = 2 * (DP_RING + 6) + 4, KNOB_BOX = 2 * KNOB_R + 4, AB_BOX = 2 * AB_R + 4,
    PAUSE_BOX = 2 * PAUSE_R + 4;
var stampsOk = false;

function buildStamps() {
    N.stampReset();
    var dc = DP_BOX >> 1, kc = KNOB_BOX >> 1, ac = AB_BOX >> 1, pc = PAUSE_BOX >> 1;
    var ok = N.stamp(ST_DPAD, DP_BOX, DP_BOX, function () { drawDpadAt(dc, dc, false, false); }) &&
        N.stamp(ST_DPAD + 1, DP_BOX, DP_BOX, function () { drawDpadAt(dc, dc, true, false); }) &&
        N.stamp(ST_DPAD + 2, DP_BOX, DP_BOX, function () { drawDpadAt(dc, dc, true, true); }) &&
        N.stamp(ST_KNOB, KNOB_BOX, KNOB_BOX, function () { drawKnobAt(kc, kc, false); }) &&
        N.stamp(ST_KNOB + 1, KNOB_BOX, KNOB_BOX, function () { drawKnobAt(kc, kc, true); }) &&
        N.stamp(ST_A, AB_BOX, AB_BOX, function () { drawAB(ac, ac, "A", false); }) &&
        N.stamp(ST_A + 1, AB_BOX, AB_BOX, function () { drawAB(ac, ac, "A", true); }) &&
        N.stamp(ST_B, AB_BOX, AB_BOX, function () { drawAB(ac, ac, "B", false); }) &&
        N.stamp(ST_B + 1, AB_BOX, AB_BOX, function () { drawAB(ac, ac, "B", true); }) &&
        N.stamp(ST_SEL, SS_W + 4, SS_H + 4, function () { drawPillAt(2, 2, "SEL", false); }) &&
        N.stamp(ST_SEL + 1, SS_W + 4, SS_H + 4, function () { drawPillAt(2, 2, "SEL", true); }) &&
        N.stamp(ST_STA, SS_W + 4, SS_H + 4, function () { drawPillAt(2, 2, "STA", false); }) &&
        N.stamp(ST_STA + 1, SS_W + 4, SS_H + 4, function () { drawPillAt(2, 2, "STA", true); }) &&
        N.stamp(ST_PAUSE, PAUSE_BOX, PAUSE_BOX, function () { drawPauseAt(pc, pc); }) &&
        N.stamp(ST_TOAST, toastW() + 4, 26, function () { drawToastAt(2, 2); });
    S.setAlpha(255);
    stampsOk = ok;
    return ok;
}

// Slots do quadro: so os que mudaram viram chamada ao core (N.place).
function placeStamps() {
    var on = (btnsMask & (BTN_UP | BTN_DOWN | BTN_LEFT | BTN_RIGHT)) !== 0;
    var dc = DP_BOX >> 1, kc = KNOB_BOX >> 1, ac = AB_BOX >> 1, pc = PAUSE_BOX >> 1;
    N.place(0, ST_DPAD + (dpActive ? (on ? 2 : 1) : 0), Math.round(dpBaseX) - dc, Math.round(dpBaseY) - dc);
    N.place(1, ST_KNOB + (dpActive ? 1 : 0), Math.round(dpKnobX) - kc, Math.round(dpKnobY) - kc);
    N.place(2, ST_A + ((btnsMask & BTN_A) !== 0 ? 1 : 0), A_X - ac, A_Y - ac);
    N.place(3, ST_B + ((btnsMask & BTN_B) !== 0 ? 1 : 0), B_X - ac, B_Y - ac);
    N.place(4, ST_SEL + ((btnsMask & BTN_SELECT) !== 0 ? 1 : 0), SEL_X - 2, SS_Y - 2);
    N.place(5, ST_STA + ((btnsMask & BTN_START) !== 0 ? 1 : 0), STA_X - 2, SS_Y - 2);
    N.place(6, ST_PAUSE, PAUSE_X - pc, PAUSE_Y - pc);
    N.place(7, toastOn() ? ST_TOAST : -1, 6, GY + 6);
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
        slotMsg = N.saveState(slotPath(i)) ? "salvo no slot " + (i + 1) : "falhou ao salvar";
        menuSub = 0; menuArm = -1; return;
    }
    if (menuSub === 2) {
        if (!FS.exists(slotPath(i))) slotMsg = "slot vazio";
        else if (N.loadState(slotPath(i))) { slotMsg = "carregado do slot " + (i + 1); }
        else slotMsg = "state invalido";
        menuSub = 0; menuArm = -1; return;
    }
    var item = MENU[i];
    if (item === "Continuar") resumeGame();
    else if (item === "Reset") { N.reset(); slotMsg = ""; resumeGame(); }
    else if (item === "Salvar estado") { menuSub = 1; menuArm = -1; }
    else if (item === "Carregar estado") { menuSub = 2; menuArm = -1; }
    else if (item === "Frameskip") {
        skipMode = !skipMode;
        if (typeof Storage !== "undefined") Storage.set("skip", skipMode ? "1" : "0");
    }
    else if (item === "Sair") { radioResume(); S.exitApp(); }
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
var needClear = true;

function loopGame() {
    pollGame();
    if (pauseHit) { pauseGame(); return; }
    if ((btnsMask & BTN_START) !== 0 && (btnsMask & BTN_SELECT) !== 0) { pauseGame(); return; }
    if (needClear) {
        S.setAlpha(255);
        S.fillScreen(0);   // unica limpeza: tira a tela anterior do vidro
        needClear = false;
    }
    var render = true;
    if (skipMode) render = (frameNo % 2) === 0;
    if (render && stampsOk) placeStamps();
    N.frame(btnsMask, render);
    if (render && !N.direct()) drawOverlay();
    // Ritmo por QUADRO RENDERIZADO: o teto por iteracao fazia o quadro
    // pulado (rapido) esperar ate 16 ms enquanto o renderizado passava do
    // prazo — o par perdia ~5 ms. Com frameskip, 30 pares/s = 60 quadros de
    // jogo; os pulados nao param (o toque ja passa pelo present).
    if (render) UI.end(skipMode ? 30 : 60);
}

function pauseGame() {
    screen = "pause";
    menuSub = 0; menuArm = -1; menuHover = -1; hadMenuTouch = false;
    slotMsg = "";
    fingers = {}; freshIds = [];
    S.setAlpha(255);
    N.audioStop();
    radioResume();  // fora do jogo a malha volta
}
function resumeGame() {
    screen = "game";
    fingers = {}; freshIds = [];
    needClear = true;  // o menu de pausa pintou o vidro inteiro: limpa 1x
    dpReset();
    radioPause();
    if (!audioOff) N.audioStart();
}

// ---- laco principal ----------------------------------------------------------
S.keepAwake(true);
scanRoms();
dpReset();

while (true) {
    frameNo++;
    if (screen === "game") loopGame();
    else if (screen === "sel") loopSel();
    else if (screen === "pause") loopPause();
    else loopErr();
}
