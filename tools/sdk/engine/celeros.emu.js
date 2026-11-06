// emu.js — casca compartilhada dos emuladores NATIVOS do CelerOS (dep
// "celeros.emu"). O nucleo de cada console viaja no pacote do app como blob
// CLRN e e alimentado por System.native* (tools/native/common/emu_core.h).
// Esta dep e o que TODO emulador repete: lista de ROMs, controles de toque,
// pausa/menu, 3 slots de save state, frameskip, pausa da malha CelerNet e as
// telas de erro. O app fica com um adapter de ~150 linhas (bits, geometria,
// extensao, comandos extras do console).
//
// Uso:
//   require("celeros.emu").run({
//       title: "ATARI 2600", coreFile: "a2600_core.bin",
//       scratchKB: function (romBytes) { return 600 + Math.ceil(romBytes/1024); },
//       romDirs: ["/sd/roms/a2600", "/local/roms/a2600"],
//       romExts: [".a26", ".bin"],
//       screenW: 160, screenH: 192, aspectW: 4, aspectH: 3,
//       bits: { a:1, b:0, select:4, start:8, up:16, down:32, left:64, right:128 },
//       labels: { a:"FOGO", b:null, select:"SEL", start:"RESET" },
//       labelFont: 2,
//       analog: { ctl: 21, label: "Paddle" },     // opcional
//       coreReady: function (api, rom) { ... },   // antes do LOAD (mapper etc.)
//       beforeFrame: function (api) { ... },      // antes de cada FRAME
//       menuExtra: function (api) { return [{ label:"...", action:function(api){} }]; },
//   });
//
// O caminho de video e o comprovado FRAME + SET_SCALE + nativeDraw (o core
// entrega o quadro JA escalado para o retangulo 4:3 do vidro; o overlay e
// desenhado por cima em JS). Cores que implementam FRAME_SCREEN podem compor
// direto, mas esta dep nao depende disso.

var S = System;

var C_PANEL = 0x1082;
var C_TEXT = 0xFFFF, C_DIM = 0x8410, C_ACC = 0x4BF3, C_OK = 0x07E0, C_ERR = 0xF800;
var C_SOFT = 0xE71C;

function clampByte(v)
{
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

function run(cfg)
{
    cfg = cfg || {};
    var title = cfg.title || "Emulador";

    // ---- acelerador nativo presente? --------------------------------------
    if (!(S.getInfo().hasNative === true &&
          typeof S.nativeLoad === "function" && typeof S.nativeCall === "function")) {
        S.fillScreen(0);
        S.setTextColor(0xFFFF, 0);
        S.drawString(title, 20, 90, 4);
        S.setTextColor(0xC618, 0);
        S.drawString("Precisa do CelerOS 1.17+", 20, 150, 1);
        S.drawString("(API 58, nucleo nativo no build).", 20, 164, 1);
        S.delay(3500);
        S.exitApp();
        return;
    }

    S.setNativeCanvas(true);
    var W = S.screenWidth();
    var H = S.screenHeight();

    // ---- geometria: quadro nativo -> retangulo 4:3 centrado no vidro ------
    var NW = cfg.screenW || 256, NH = cfg.screenH || 240;
    var AW = cfg.aspectW || 4, AH = cfg.aspectH || 3;
    var GH = Math.min(H, Math.round(W * AH / AW));
    var GW = Math.round(GH * AW / AH);
    if (GW > W) { GW = W; GH = Math.round(GW * AH / AW); }
    var GX = Math.round((W - GW) / 2);
    var GY = Math.round((H - GH) / 2);

    var bits = cfg.bits || { up: 16, down: 32, left: 64, right: 128, a: 1, b: 2, select: 4, start: 8 };
    var labels = cfg.labels || { a: "A", b: "B", select: "SEL", start: "STA" };
    var labelFont = cfg.labelFont || 4;
    var hasB = labels.b !== null && labels.b !== undefined && bits.b;
    var romDirs = cfg.romDirs || [];
    var romExts = cfg.romExts || [];
    var stateExt = cfg.stateExt || ".s";
    var analog = cfg.analog || null;
    var audioOn = cfg.audioDefault !== false;
    var skipMode = (typeof Storage === "undefined") || Storage.get("skip") !== "0";
    var analogOn = false;
    if (analog && typeof Storage !== "undefined") analogOn = Storage.get("paddle") === "1";

    // d-pad analogico flutuante (canto inferior esquerdo)
    var DP_RING = Math.round(Math.min(W, H) * 0.13);
    var KNOB_R = Math.round(DP_RING * 0.42);
    var KNOB_TRAVEL = Math.round(DP_RING * 0.61);
    var DP_HOME_X = Math.round(W * 0.175);
    var DP_HOME_Y = H - Math.round(H * 0.183);
    var DP_ZONE_W = Math.round(W * 0.40);
    var DP_ZONE_Y = Math.round(H * 0.45);
    var DEAD = Math.max(10, Math.round(DP_RING * 0.18));

    // A/B: cluster da direita. Sem B, o A desce um pouco (polegar).
    var AB_R = Math.round(Math.min(W, H) * 0.098);
    var A_X = W - AB_R - 14;
    var A_Y = H - Math.round(AB_R * (hasB ? 2.05 : 1.55));
    var B_X = A_X - Math.round(AB_R * 2.2);
    var B_Y = A_Y + Math.round(AB_R * 0.67);

    // SEL/STA (ou SEL/RESET): pilulas no meio de baixo
    var SS_W = Math.round(W * 0.130);
    var SS_H = Math.round(H * 0.052);
    var SS_Y = H - Math.round(SS_H * 1.6);
    var SEL_X = Math.round(W * 0.275);
    var STA_X = Math.round(W * 0.415);

    // pausa: canto superior direito
    var PAUSE_R = Math.max(11, Math.round(Math.min(W, H) * 0.030));
    var PAUSE_X = W - PAUSE_R - Math.round(PAUSE_R * 0.9);
    var PAUSE_Y = PAUSE_R + Math.round(PAUSE_R * 0.9);

    // paddle: trilho horizontal na zona do d-pad (valor absoluto 0..255)
    var PADDLE_X0 = Math.round(W * 0.06);
    var PADDLE_X1 = Math.round(W * 0.38);
    var PADDLE_Y = DP_HOME_Y;

    // ---- estado -----------------------------------------------------------
    var screen = "sel";
    var errMsg = "";
    var roms = [];
    var listOff = 0;
    var romName = "";
    var slotMsg = "";
    var frameNo = 0;
    var curIdx = -1;
    var needClear = true;
    var paddleValue = 0;

    var fingers = {};
    var freshIds = [];

    function pollTouch()
    {
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
            if (fingers.hasOwnProperty(id) && !seen[id]) delete fingers[id];
        }
        return ts;
    }

    // ---- fs ---------------------------------------------------------------
    var dataDir = FS.appData();
    if (!FS.exists(dataDir)) { try { FS.mkdir(dataDir); } catch (e) {} }

    function romBase()
    {
        var n = romName, i = n.lastIndexOf(".");
        if (i > 0) n = n.substring(0, i);
        return n;
    }
    function slotPath(n) { return dataDir + romBase() + stateExt + n; }

    function scanRoms()
    {
        roms = [];
        for (var d = 0; d < romDirs.length; d++) {
            var files = [];
            try { files = FS.listDir(romDirs[d]); } catch (e) { continue; }
            for (var i = 0; i < files.length; i++) {
                var p = files[i];
                var low = p.toLowerCase();
                var ok = false;
                for (var e = 0; e < romExts.length; e++) {
                    var ext = String(romExts[e]).toLowerCase();
                    if (low.length > ext.length && low.substring(low.length - ext.length) === ext) {
                        ok = true;
                        break;
                    }
                }
                if (!ok) continue;
                var sz = 0;
                try { sz = FS.getFileSize(p); } catch (e2) {}
                roms.push({ name: p.substring(p.lastIndexOf("/") + 1), path: p, size: sz });
            }
        }
        for (var a = 1; a < roms.length; a++) {
            var key = roms[a], k = key.name.toLowerCase(), b = a - 1;
            while (b >= 0 && roms[b].name.toLowerCase() > k) { roms[b + 1] = roms[b]; b--; }
            roms[b + 1] = key;
        }
    }

    // ---- nucleo nativo (ABI canonica 0-19) --------------------------------
    var api = {
        ctl: function (cmd, arg) { return N.ctl(cmd, arg); },
        reload: function () { if (curIdx >= 0) openRom(curIdx); },
        rom: function () { return curIdx >= 0 ? roms[curIdx] : null; },
        setAudio: function (on) { audioOn = !!on; if (audioOn) N.audioStart(); else N.audioStop(); },
        audioOn: function () { return audioOn; },
    };

    var N = (function () {
        var h = 0, romOff = 0, pcmOff = 0, fbOff = 0, stateOff = 0, scaleOff = 0;
        var audio = false;
        function ctl(cmd, arg) { return S.nativeCall(h, 0, cmd, arg || 0); }
        return {
            ctl: function (cmd, arg) { return h > 0 ? ctl(cmd, arg) : 0; },
            load: function (path, rom) {
                if (h > 0) S.nativeFree(h);
                var romBytes = rom.size || 1;
                var kb = cfg.scratchKB ? cfg.scratchKB(romBytes)
                                       : 600 + Math.ceil(romBytes / 1024);
                // firmware < API 60 corta a scratch em 1664 KB sem avisar
                if (S.getAPILevel() < 60 && kb > 1664) kb = 1664;
                h = S.nativeLoad(S.appDir() + "/" + cfg.coreFile, kb);
                if (h <= 0) return false;
                if (ctl(0, kb) < romBytes) return false;
                romOff = ctl(1);
                pcmOff = ctl(2);
                fbOff = ctl(3);
                stateOff = ctl(4);
                scaleOff = ctl(12, (GW << 16) | GH);
                ctl(13, audioOn ? 1 : 0);
                if (cfg.coreReady) {
                    try { cfg.coreReady(api, rom); } catch (e) {}
                }
                var n = S.nativeLoadFile(h, romOff, path);
                return n > 0 && ctl(6, n) === 1;
            },
            reset: function () { if (h > 0) ctl(7); },
            frame: function (btns, render) {
                if (h <= 0) return;
                var arg = ((btns | 0) & 0xFF) | (render ? 0x100 : 0);
                ctl(8, arg);
                if (render && scaleOff > 0) S.nativeDraw(h, scaleOff, GX, GY, GW, GH);
                if (audio) {
                    var n = ctl(11);
                    if (n > 0) S.nativeAudio(h, pcmOff, n);
                }
            },
            audioStart: function () { audio = h > 0; if (h > 0) ctl(13, 1); return audio; },
            audioStop: function () {
                audio = false;
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
                audio = false;
            },
        };
    })();

    function openRom(idx)
    {
        curIdx = idx;
        romName = roms[idx].name;
        listOff = 0;
        N.unload();
        if (!N.load(roms[idx].path, roms[idx])) {
            errMsg = romName + " nao abriu" +
                     (cfg.errorHint ? " (" + cfg.errorHint + ")." : ".");
            screen = "err";
            return;
        }
        screen = "game";
        slotMsg = "";
        needClear = true;
        dpReset();
        toastStart = S.millis();
        N.reset();
        radioPause();
        if (audioOn) N.audioStart();
    }

    // ---- radio ------------------------------------------------------------
    var radioOn = false;
    function radioPause()
    {
        if (radioOn) return;
        if (typeof CelerNet === "undefined") return;
        try { CelerNet.stop(); radioOn = true; } catch (e) {}
    }
    function radioResume()
    {
        if (!radioOn) return;
        radioOn = false;
        if (typeof CelerNet === "undefined") return;
        try { CelerNet.start({ relay: false }); } catch (e) {}
    }

    // ---- texto ------------------------------------------------------------
    function txt(s, x, y, color, font)
    {
        S.setTextColor(color);  // 1 arg = fundo TRANSPARENTE (sem caixa preta)
        S.drawString(s, x, y, font || 1);
    }
    function txtCenter(s, cx, y, color, font)
    {
        S.setTextColor(color);
        var w = S.textWidth(s, font || 1);
        S.drawString(s, Math.round(cx - w / 2), y, font || 1);
    }
    function txtMid(s, cx, cy, color, font)
    {
        font = font || 1;
        var tw = S.textWidth(s, font), fh = S.fontHeight(font);
        S.setTextColor(color);
        S.drawString(s, Math.round(cx - tw / 2), Math.round(cy - fh / 2), font);
    }
    function dist(x, y, cx, cy)
    {
        var dx = x - cx, dy = y - cy;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ---- d-pad analogico --------------------------------------------------
    var dpBaseX = 0, dpBaseY = 0, dpKnobX = 0, dpKnobY = 0, dpActive = false;

    function dpReset()
    {
        dpBaseX = DP_HOME_X; dpBaseY = DP_HOME_Y;
        dpKnobX = dpBaseX; dpKnobY = dpBaseY;
        dpActive = false;
    }

    function dpadBits(x, y)
    {
        var dx = x - dpBaseX, dy = y - dpBaseY;
        if (Math.sqrt(dx * dx + dy * dy) < DEAD) return 0;
        var deg = Math.atan2(dy, dx) * 180 / Math.PI;
        if (deg >= -22.5 && deg < 22.5) return bits.right;
        if (deg >= 22.5 && deg < 67.5) return bits.right | bits.down;
        if (deg >= 67.5 && deg < 112.5) return bits.down;
        if (deg >= 112.5 && deg < 157.5) return bits.left | bits.down;
        if (deg >= 157.5 || deg < -157.5) return bits.left;
        if (deg >= -157.5 && deg < -112.5) return bits.left | bits.up;
        if (deg >= -112.5 && deg < -67.5) return bits.up;
        return bits.right | bits.up;
    }

    var btnsMask = 0;
    var pauseHit = false;

    function paddleFromX(x)
    {
        var v = Math.round((x - PADDLE_X0) * 255 / (PADDLE_X1 - PADDLE_X0));
        return clampByte(v);
    }

    function pollGame()
    {
        pollTouch();
        btnsMask = 0;
        pauseHit = false;
        dpActive = false;
        for (var i = 0; i < freshIds.length; i++) {
            var f = fingers[freshIds[i]];
            var kind = classifyArrival(f.ax, f.ay);
            if (kind === "pause") { pauseHit = true; f.kind = "dead"; }
            else f.kind = kind;
        }
        for (var id in fingers) {
            if (!fingers.hasOwnProperty(id)) continue;
            var g = fingers[id];
            if (g.kind === "dpad") {
                // Base FIXA no lugar de descanso: o d-pad nao salta para o
                // dedo ao tocar (o usuario via isso como bug). O knob segue o
                // dedo dentro do curso e a direcao sai do delta contra a base.
                dpActive = true;
                var dx = g.x - dpBaseX, dy = g.y - dpBaseY;
                var m = Math.sqrt(dx * dx + dy * dy);
                if (m > KNOB_TRAVEL) { dx = dx * KNOB_TRAVEL / m; dy = dy * KNOB_TRAVEL / m; }
                dpKnobX = dpBaseX + dx; dpKnobY = dpBaseY + dy;
                btnsMask |= dpadBits(g.x, g.y);
            } else if (g.kind === "paddle") {
                paddleValue = paddleFromX(g.x);
            } else if (g.kind === "a") btnsMask |= bits.a;
            else if (g.kind === "b") btnsMask |= bits.b;
            else if (g.kind === "start") btnsMask |= bits.start;
            else if (g.kind === "select") btnsMask |= bits.select;
        }
        if (!dpActive) { dpBaseX = DP_HOME_X; dpBaseY = DP_HOME_Y; dpKnobX = DP_HOME_X; dpKnobY = DP_HOME_Y; }
    }

    function classifyArrival(x, y)
    {
        if (dist(x, y, PAUSE_X, PAUSE_Y) <= PAUSE_R + 10) return "pause";
        if (dist(x, y, A_X, A_Y) <= AB_R + 10) return "a";
        if (hasB && dist(x, y, B_X, B_Y) <= AB_R + 10) return "b";
        if (y >= SS_Y - 8 && y <= SS_Y + SS_H + 8) {
            if (x >= STA_X - 6 && x <= STA_X + SS_W + 6) return "start";
            if (x >= SEL_X - 6 && x <= SEL_X + SS_W + 6) return "select";
        }
        if (x < DP_ZONE_W && y > DP_ZONE_Y) return analogOn ? "paddle" : "dpad";
        return "";
    }

    // ---- overlay ----------------------------------------------------------
    function drawDpadAt(bx, by, active, on)
    {
        S.setAlpha(active ? 150 : 90);
        S.drawCircle(bx, by, DP_RING + 6, 0x9CF3);
        S.drawCircle(bx, by, DP_RING - 4, 0x4A69);
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
    function drawKnobAt(kx, ky, active)
    {
        S.setAlpha(active ? 210 : 130);
        S.fillCircle(kx, ky, KNOB_R - 4, 0xD69A);
        S.setAlpha(active ? 240 : 170);
        S.drawCircle(kx, ky, KNOB_R, 0xFFFF);
        S.drawCircle(kx, ky, KNOB_R - 4, 0x8C71);
    }
    function drawDpad()
    {
        var on = (btnsMask & (bits.up | bits.down | bits.left | bits.right)) !== 0;
        drawDpadAt(dpBaseX, dpBaseY, dpActive, on);
        drawKnobAt(dpKnobX, dpKnobY, dpActive);
    }

    function drawPaddle()
    {
        var kx = PADDLE_X0 + Math.round((PADDLE_X1 - PADDLE_X0) * paddleValue / 255);
        S.setAlpha(85);
        S.fillRoundRect(PADDLE_X0 - 10, PADDLE_Y - 22, (PADDLE_X1 - PADDLE_X0) + 20, 44, 22, 0x0000);
        S.setAlpha(170);
        S.drawLine(PADDLE_X0, PADDLE_Y, PADDLE_X1, PADDLE_Y, 0x9CF3);
        S.setAlpha(210);
        S.fillCircle(kx, PADDLE_Y, KNOB_R - 6, 0xD69A);
        S.setAlpha(240);
        S.drawCircle(kx, PADDLE_Y, KNOB_R, 0xFFFF);
    }

    function drawAB(cx, cy, label, on)
    {
        S.setAlpha(on ? 175 : 70);
        S.fillCircle(cx, cy, AB_R - 6, 0x0000);
        S.setAlpha(on ? 255 : 120);
        S.drawCircle(cx, cy, AB_R, on ? C_ACC : 0x9CF3);
        S.drawCircle(cx, cy, AB_R - 3, on ? C_ACC : 0x52AA);
        S.setAlpha(255);
        txtMid(label, cx, cy, on ? 0xFFFF : C_SOFT, labelFont);
    }

    function drawPillAt(x, y, label, on)
    {
        S.setAlpha(on ? 185 : 75);
        S.fillRoundRect(x, y, SS_W, SS_H, Math.round(SS_H / 2), 0x0000);
        S.setAlpha(on ? 255 : 120);
        S.drawRoundRect(x, y, SS_W, SS_H, Math.round(SS_H / 2), on ? C_ACC : 0x8C71);
        S.setAlpha(255);
        txtMid(label, x + Math.round(SS_W / 2), y + Math.round(SS_H / 2), on ? 0xFFFF : C_SOFT, 2);
    }
    function drawPill(x, label, on) { drawPillAt(x, SS_Y, label, on); }

    function drawPauseAt(px, py)
    {
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
    function drawToastAt(x, y)
    {
        S.setAlpha(120);
        S.fillRoundRect(x, y, toastW(), 22, 11, 0x0000);
        S.setAlpha(255);
        S.setTextColor(C_SOFT);
        S.drawString(romBase(), x + 10, y + 6, 1);
    }
    function toastOn()
    {
        var dt = S.millis() - toastStart;
        return dt >= 0 && dt <= 2200;
    }
    function drawToast() { if (toastOn()) drawToastAt(8, GY + 8); }

    // Faixas fora do retangulo do jogo (letterbox): o overlay e translucido e
    // redesenhado todo quadro. Dentro do quadro o proprio jogo repinta por
    // baixo; FORA dele nada limpa o vidro, entao os circulos/botoes iam
    // somando e a base flutuante do d-pad deixava as posicoes antigas na
    // tela. Pinta-las de preto antes do overlay devolve o fundo do app.
    function clearBands()
    {
        S.setAlpha(255);
        if (GY > 0) S.fillRect(0, 0, W, GY, 0x0000);
        if (H - GY - GH > 0) S.fillRect(0, GY + GH, W, H - GY - GH, 0x0000);
        if (GX > 0) S.fillRect(0, 0, GX, H, 0x0000);
        if (W - GX - GW > 0) S.fillRect(GX + GW, 0, W - GX - GW, H, 0x0000);
    }

    function drawOverlay()
    {
        if (analogOn) drawPaddle(); else drawDpad();
        drawAB(A_X, A_Y, labels.a, (btnsMask & bits.a) !== 0);
        if (hasB) drawAB(B_X, B_Y, labels.b, (btnsMask & bits.b) !== 0);
        drawPill(SEL_X, labels.select, (btnsMask & bits.select) !== 0);
        drawPill(STA_X, labels.start, (btnsMask & bits.start) !== 0);
        drawPauseBtn();
        drawToast();
        S.setAlpha(255);
    }

    // ---- tela: lista de ROMs ----------------------------------------------
    var ROW_H = 44;
    var LIST_TOP = 50;

    function drawSel()
    {
        S.fillScreen(C_PANEL);
        txt(title, 8, 6, C_ACC, 4);
        txt(roms.length + (roms.length === 1 ? " ROM" : " ROMs"), W - 74, 26, C_DIM);
        S.drawLine(0, 38, W, 38, 0x3186);
        if (roms.length === 0) {
            txtCenter("Sem ROMs", W / 2, 110, C_TEXT, 2);
            txtCenter("Ponha " + romExts.join(" ") + " em", W / 2, 146, C_DIM);
            var d0 = romDirs.length > 0 ? romDirs[0] : "";
            var d1 = romDirs.length > 1 ? romDirs[1] : "";
            txtCenter(d0, W / 2, 162, C_DIM);
            if (d1) txtCenter("ou " + d1, W / 2, 176, C_DIM);
            txtCenter("(celerctl push)", W / 2, 196, C_DIM);
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
    function rowArrived(y)
    {
        for (var i = 0; i < freshIds.length; i++) {
            var f = fingers[freshIds[i]];
            if (f.ay >= y && f.ay < y + ROW_H) return true;
        }
        return false;
    }

    function loopSel()
    {
        var ts = pollTouch();
        if (roms.length === 0) { drawSel(); UI.end(30); return; }
        for (var i = 0; i < freshIds.length; i++) {
            var f = fingers[freshIds[i]];
            if (f.ay < LIST_TOP || f.ay > H - 24) continue;
            var idx = Math.floor((f.ay + listOff - LIST_TOP) / ROW_H);
            if (idx >= 0 && idx < roms.length) { fingers = {}; freshIds = []; openRom(idx); return; }
        }
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

    // ---- tela: pausa ------------------------------------------------------
    // A lista de pausa tem os itens padrao + os extras do console (mapper,
    // cor, dificuldade): 11 linhas de 36 px cabem nos 480 sem cortar o Sair.
    var MENU_TOP = 28;
    var MENU_H = 36;
    var menuSub = 0;
    var menuHover = -1;
    var menuArm = -1;
    var hadMenuTouch = false;

    function slotInfo(n)
    {
        var p = slotPath(n);
        if (FS.exists(p)) {
            var sz = 0;
            try { sz = FS.getFileSize(p); } catch (e) {}
            return "slot " + (n + 1) + "  -  " + Math.round(sz / 1024) + " KB";
        }
        return "slot " + (n + 1) + "  -  vazio";
    }

    function menuList()
    {
        if (menuSub === 1 || menuSub === 2) {
            var slots = [];
            for (var s = 0; s < 3; s++) {
                slots.push({
                    label: slotInfo(s),
                    action: (function (n, sub) {
                        return function () {
                            if (sub === 1) {
                                slotMsg = N.saveState(slotPath(n)) ? "salvo no slot " + (n + 1)
                                                                   : "falhou ao salvar";
                            } else if (!FS.exists(slotPath(n))) {
                                slotMsg = "slot vazio";
                            } else if (N.loadState(slotPath(n))) {
                                slotMsg = "carregado do slot " + (n + 1);
                            } else {
                                slotMsg = "state invalido";
                            }
                            menuSub = 0; menuArm = -1;
                        };
                    })(s, menuSub),
                });
            }
            return slots;
        }

        var items = [
            { label: "Continuar", action: function () { resumeGame(); } },
            { label: "Reset", action: function () { N.reset(); slotMsg = ""; resumeGame(); } },
            { label: "Salvar estado", action: function () { menuSub = 1; menuArm = -1; } },
            { label: "Carregar estado", action: function () { menuSub = 2; menuArm = -1; } },
            { label: "Frameskip: " + (skipMode ? "auto" : "off"), action: function () {
                skipMode = !skipMode;
                if (typeof Storage !== "undefined") Storage.set("skip", skipMode ? "1" : "0");
            } },
            { label: "Audio: " + (audioOn ? "on" : "off"), action: function () {
                api.setAudio(!audioOn);
            } },
        ];
        if (analog) {
            items.push({
                label: (analog.label || "Paddle") + ": " + (analogOn ? "on" : "off"),
                action: function () {
                    analogOn = !analogOn;
                    if (typeof Storage !== "undefined") Storage.set("paddle", analogOn ? "1" : "0");
                    dpReset();
                },
            });
        }
        var extra = cfg.menuExtra ? cfg.menuExtra(api) : [];
        for (var e = 0; e < extra.length; e++) items.push(extra[e]);
        items.push({ label: "Sair", action: function () { radioResume(); N.unload(); S.exitApp(); } });
        return items;
    }

    function drawPause()
    {
        S.fillScreen(C_PANEL);
        txt(romBase(), 8, 6, C_ACC, 2);
        S.drawLine(0, 26, W, 26, 0x3186);
        var items = menuList();
        var y = MENU_TOP;
        for (var i = 0; i < items.length; i++) {
            var on = (i === menuHover);
            if (on) S.fillRect(0, y, W, MENU_H, 0x1886);
            txt(items[i].label, 12, y + 10, on ? C_ACC : C_TEXT, 2);
            y += MENU_H;
        }
        if (slotMsg) txtCenter(slotMsg, W / 2, y + 4, C_OK);
        txtCenter(labels.select + "+" + labels.start + " pausa - canto sup. dir. tambem",
                  W / 2, H - 14, 0x3186);
    }

    function loopPause()
    {
        var ts = pollTouch();
        var items = menuList();
        menuHover = -1;
        for (var m = 0; m < ts.length; m++) {
            var i3 = Math.floor((ts[m].y - MENU_TOP) / MENU_H);
            if (ts[m].y >= MENU_TOP && i3 >= 0 && i3 < items.length) menuHover = i3;
        }
        for (var i = 0; i < freshIds.length; i++) {
            var f = fingers[freshIds[i]];
            var i4 = Math.floor((f.ay - MENU_TOP) / MENU_H);
            menuArm = (f.ay >= MENU_TOP && i4 >= 0 && i4 < items.length) ? i4 : -1;
            hadMenuTouch = menuArm >= 0;
        }
        if (ts.length === 0) {
            if (hadMenuTouch && menuArm >= 0 && menuArm < items.length) {
                var chosen = items[menuArm];
                hadMenuTouch = false; menuArm = -1; menuHover = -1;
                chosen.action(api);
                return;
            }
            hadMenuTouch = false;
        }
        drawPause();
        UI.end(30);
    }

    // ---- tela: erro -------------------------------------------------------
    function drawErr()
    {
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
    function loopErr()
    {
        var ts = pollTouch();
        if (ts.length > 0) { screen = "sel"; fingers = {}; return; }
        drawErr();
        UI.end(30);
    }

    // ---- ciclo do jogo ----------------------------------------------------
    function loopGame()
    {
        pollGame();
        if (pauseHit) { pauseGame(); return; }
        if ((btnsMask & bits.start) !== 0 && (btnsMask & bits.select) !== 0) { pauseGame(); return; }
        if (needClear) {
            S.setAlpha(255);
            S.fillScreen(0);
            needClear = false;
        }
        if (cfg.beforeFrame) {
            try { cfg.beforeFrame(api); } catch (e) {}
        }
        if (analog && analogOn) N.ctl(analog.ctl, paddleValue);
        var render = true;
        if (skipMode) render = (frameNo % 2) === 0;
        N.frame(btnsMask, render);
        if (render) {
            clearBands();
            drawOverlay();
            UI.end(skipMode ? 30 : 60);
        }
    }

    function pauseGame()
    {
        screen = "pause";
        menuSub = 0; menuArm = -1; menuHover = -1; hadMenuTouch = false;
        slotMsg = "";
        fingers = {}; freshIds = [];
        S.setAlpha(255);
        N.audioStop();
        radioResume();
    }
    function resumeGame()
    {
        screen = "game";
        fingers = {}; freshIds = [];
        needClear = true;
        dpReset();
        radioPause();
        if (audioOn) N.audioStart();
    }

    // ---- laco principal ---------------------------------------------------
    S.keepAwake(true);
    scanRoms();
    dpReset();

    while (true) {
        frameNo++;
        if (screen === "game") loopGame();
        else if (screen === "sel") loopSel();
        else if (screen === "pause") loopPause();
        else loopErr();
        // Yield OBRIGATORIO: o quadro emulado e um laco puro de JS + blob e o
        // UI.end nao segura o bastante. Sem esta pausa a IDLE0 do core 0 (com
        // o audio ligado o player do PcmFeed ainda disputa as janelas) nao
        // roda e o TASK WDT (15 s) reinicia o aparelho. 1 tick = 1 ms no
        // CONFIG_FREERTOS_HZ=1000, ou seja ~1% do quadro.
        S.delay(1);
    }
}

module.exports = {
    version: "0.1.3",
    run: run,
};
