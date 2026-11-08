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
//       scratchKB: function (romBytes) { return 1240 + Math.ceil(romBytes/1024); },
//       romDirs: ["/sd/roms/a2600", "/local/roms/a2600"],
//       romExts: [".a26", ".bin"],
//       screenW: 160, screenH: 192, aspectW: 4, aspectH: 3,
//       bits: { a:1, b:0, select:4, start:8, up:16, down:32, left:64, right:128 },
//       labels: { a:"FOGO", b:null, select:"SEL", start:"RESET" },
//       labelFont: 2,
//       analog: { ctl: 21, label: "Paddle" },     // opcional
//       sram: { offCtl: 20, sizeCtl: 21, sumCtl: 25, ext: ".srm" },  // opcional (bateria)
//       coreReady: function (api, rom) { ... },   // antes do LOAD (mapper etc.)
//       beforeFrame: function (api) { ... },      // antes de cada FRAME
//       menuExtra: function (api) { return [{ label:"...", action:function(api){} }]; },
//   });
//
// Botoes extras (SNES): bits.x/y/l/r + labels.x/y/l/r ligam um losango
// A/B/X/Y a direita e os ombros L/R no topo. O FRAME leva os 8 bits baixos em
// arg & 0xFF (como sempre) e os bits 8-15 do controle em arg >> 16: cores
// antigos ignoram. O gamepad do OS (Input.padState) segue o rotulo (A->A...)
// ou a posicao Nintendo/Xbox, escolhida em Opcoes.
//
// Video (API 60): o core que implementa FRAME_SCREEN compoe o quadro
// escalado + o overlay DIRETO no vidro inteiro (System.nativeScreen), numa
// passada so e reescrevendo apenas as linhas que mudaram; o overlay vira
// CARIMBOS (cada controle e desenhado uma vez sobre preto e branco na
// abertura da ROM; por quadro so se diz qual carimbo vai onde). Sem alvo
// (firmware antigo, core sem FRAME_SCREEN, vidro ocupado) cai no caminho
// FRAME + SET_SCALE + nativeDraw com o overlay em JS. Bancada 4848 (Atari,
// Pitfall): o caminho antigo gastava ~63 ms de video por quadro renderizado;
// o direto, ~1 ms.

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

    // ---- geometria: quadro nativo -> retangulo centrado no vidro ---------
    // Modos (Opcoes > Tela): 0 = proporcao do console (cfg.aspectW:H),
    // 1 = 4:3 de TV, 2 = esticar no vidro inteiro.
    var NW = cfg.screenW || 256, NH = cfg.screenH || 240;
    var GW = 0, GH = 0, GX = 0, GY = 0;
    var aspectMode = 0;
    if (typeof Storage !== "undefined") {
        aspectMode = parseInt(Storage.get("tela") || "0", 10) || 0;
        if (aspectMode < 0 || aspectMode > 2) aspectMode = 0;
    }
    function computeGeom()
    {
        var AW = cfg.aspectW || 4, AH = cfg.aspectH || 3;
        if (aspectMode === 1) { AW = 4; AH = 3; }
        if (aspectMode === 2) {
            GW = W; GH = H;
        } else {
            GH = Math.min(H, Math.round(W * AH / AW));
            GW = Math.round(GH * AW / AH);
            if (GW > W) { GW = W; GH = Math.round(GW * AH / AW); }
        }
        GX = Math.round((W - GW) / 2);
        GY = Math.round((H - GH) / 2);
    }
    computeGeom();

    var bits = cfg.bits || { up: 16, down: 32, left: 64, right: 128, a: 1, b: 2, select: 4, start: 8 };
    var labels = cfg.labels || { a: "A", b: "B", select: "SEL", start: "STA" };
    var labelFont = cfg.labelFont || 4;
    var hasB = labels.b !== null && labels.b !== undefined && bits.b;
    // losango A/B/X/Y + ombros L/R (SNES): so quando o adapter declara
    var hasXY = !!(bits.x && bits.y && labels.x && labels.y);
    var hasLR = !!(bits.l && bits.r && labels.l && labels.r);
    var sram = cfg.sram || null;
    var romDirs = cfg.romDirs || [];
    var romExts = cfg.romExts || [];
    var stateExt = cfg.stateExt || ".s";
    var analog = cfg.analog || null;
    var audioOn = cfg.audioDefault !== false;
    // frameskip: 0 = desenha tudo, 1 = um sim um nao, 2 = um a cada 3,
    // -1 = auto (adaptativo; ver loopGame). "1" antigo do Storage = auto.
    var skipSet = -1;
    if (typeof Storage !== "undefined") {
        var sk = Storage.get("skip");
        if (sk === "0") skipSet = 0;
        else if (sk === "f1") skipSet = 1;
        else if (sk === "f2") skipSet = 2;
    }
    // controles na tela: 0 auto (somem com o gamepad em uso), 1 sempre, 2 nunca
    var touchUi = 0;
    // botoes do gamepad: 0 pelo rotulo (A->A), 1 pela posicao (troca A/B e X/Y)
    var padSwap = 0;
    if (typeof Storage !== "undefined") {
        touchUi = parseInt(Storage.get("toque") || "0", 10) || 0;
        padSwap = Storage.get("padpos") === "1" ? 1 : 0;
    }
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

    // A/B: cluster da direita. Sem B, o A desce um pouco (polegar). Com
    // X/Y vira o losango do controle do SNES (A direita, B baixo, X cima,
    // Y esquerda) com botoes menores.
    var AB_R = Math.round(Math.min(W, H) * (hasXY ? 0.072 : 0.098));
    var A_X, A_Y, B_X, B_Y, X_X = 0, X_Y = 0, Y_X = 0, Y_Y = 0;
    if (hasXY) {
        var dd = Math.round(AB_R * 1.95);
        var cxd = W - dd - AB_R - 10, cyd = H - dd - AB_R - Math.round(H * 0.07);
        A_X = cxd + dd; A_Y = cyd;
        B_X = cxd; B_Y = cyd + dd;
        X_X = cxd; X_Y = cyd - dd;
        Y_X = cxd - dd; Y_Y = cyd;
    } else {
        A_X = W - AB_R - 14;
        A_Y = H - Math.round(AB_R * (hasB ? 2.05 : 1.55));
        B_X = A_X - Math.round(AB_R * 2.2);
        B_Y = A_Y + Math.round(AB_R * 0.67);
    }

    // SEL/STA (ou SEL/RESET): pilulas no meio de baixo
    var SS_W = Math.round(W * 0.130);
    var SS_H = Math.round(H * 0.052);
    var SS_Y = H - Math.round(SS_H * 1.6);
    var SEL_X = Math.round(W * 0.275);
    var STA_X = Math.round(W * 0.415);

    // Faixa de cima reservada ao sistema: no modo retratil o terco direito
    // dela e o gesto de revelar a topbar (pollAppChrome engole o toque) e os
    // tercos esquerdo/central abrem paineis. Pausa e ombros ficam abaixo.
    var TOP_SAFE = Math.round(H * 0.075);

    // pausa: canto superior direito
    var PAUSE_R = Math.max(11, Math.round(Math.min(W, H) * 0.030));
    var PAUSE_X = W - PAUSE_R - Math.round(PAUSE_R * 0.9);
    var PAUSE_Y = TOP_SAFE + PAUSE_R + 4;

    // L/R: pilulas de ombro no topo (L a esquerda; R a esquerda da pausa)
    var SH_W = Math.round(W * 0.16), SH_H = Math.round(H * 0.06);
    var L_X = 8, L_Y = TOP_SAFE;
    var R_X = PAUSE_X - PAUSE_R - 12 - SH_W, R_Y = TOP_SAFE;

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
    // frameskip auto adaptativo (por ROM aberta): quadros na janela de medida
    var skipHeavy = false, skipT0 = 0, skipN = 0, skipSlow = 0;
    // velocidade (cabecalho da pausa): quadros emulados/desenhados por s
    var spdT0 = 0, spdEmu = 0, spdDraw = 0, spdText = "";
    // gamepad em uso (controles na tela "auto"): ultimo seq visto e quando
    var padSeq = 0, padSeen = -100000, touchSeen = 0;
    var sramT = 0;
    var lastRom = (typeof Storage !== "undefined") ? (Storage.get("ultima") || "") : "";

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
    function sramPath() { return dataDir + romBase() + (sram && sram.ext ? sram.ext : ".srm"); }
    function baseOf(name)
    {
        var i = name.lastIndexOf(".");
        return i > 0 ? name.substring(0, i) : name;
    }
    function sramFlush(force)
    {
        if (!sram || curIdx < 0) return;
        try { N.sramSave(sramPath(), force); } catch (e) {}
    }

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
                var nm = p.substring(p.lastIndexOf("/") + 1);
                var saves = 0;
                for (var sv = 0; sv < 3; sv++) {
                    if (FS.exists(dataDir + baseOf(nm) + stateExt + sv)) saves++;
                }
                roms.push({ name: nm, path: p, size: sz, saves: saves });
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
        var h = 0, romOff = 0, pcmOff = 0, fbOff = 0, stateOff = 0, scaleOff = 0, sramSum = 0;
        var audio = false;
        var direct = false, slotArg = [];
        var NO_TARGET = 4294967295;
        var HAS_SCREEN = typeof S.nativeScreen === "function" && typeof S.nativeGrab === "function";
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
                slotArg = [];
                direct = false;
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
            rescale: function () {
                if (h > 0) scaleOff = ctl(12, (GW << 16) | GH);
            },
            // SRAM do cartucho (bateria) <-> arquivo; sumCtl detecta mudanca
            sramLoad: function (p) {
                if (h <= 0 || !sram) return false;
                var off = ctl(sram.offCtl), n = ctl(sram.sizeCtl);
                if (off <= 0 || n <= 0 || !FS.exists(p)) return false;
                var got = S.nativeLoadFile(h, off, p);
                sramSum = sram.sumCtl ? ctl(sram.sumCtl) : 0;
                return got > 0;
            },
            sramSave: function (p, force) {
                if (h <= 0 || !sram) return false;
                var off = ctl(sram.offCtl), n = ctl(sram.sizeCtl);
                if (off <= 0 || n <= 0) return false;
                if (sram.sumCtl && !force) {
                    var sum = ctl(sram.sumCtl);
                    if (sum === sramSum) return false;
                    sramSum = sum;
                }
                return S.nativeSaveFile(h, off, n, p);
            },
            // canDirect: so com os carimbos prontos (sem eles o overlay sumiria)
            frame: function (btns, render, canDirect) {
                if (h <= 0) return;
                // bits 0-7 do controle + render (bit 8) + bits 8-15 em 16-23
                var arg = ((btns | 0) & 0xFF) | (render ? 0x100 : 0) | (((btns | 0) & 0xFF00) << 8);
                // alvo = vidro inteiro: o core centra o quadro, pinta as
                // faixas e compoe os carimbos fora do retangulo do jogo
                direct = canDirect && HAS_SCREEN &&
                         S.nativeScreen(h, 0, 15, arg, 0, 0, W, H) !== NO_TARGET;
                if (!direct) {
                    ctl(8, arg);
                    if (render && scaleOff > 0) S.nativeDraw(h, scaleOff, GX, GY, GW, GH);
                }
                if (audio) {
                    var n = ctl(11);
                    if (n > 0) S.nativeAudio(h, pcmOff, n);
                }
            },
            direct: function () { return direct; },
            // Carimbo `id` (w x hh) do overlay: draw(x, y) desenha o controle
            // no quadro do app, uma vez sobre PRETO e outra sobre BRANCO; o
            // core tira alpha e cor pre-multiplicada da diferenca.
            stamp: function (id, w, hh, draw) {
                if (h <= 0 || !HAS_SCREEN) return false;
                var offs = [ctl(16, 0), ctl(16, 1)], bg = [0x0000, 0xFFFF];
                if (offs[0] === 0) return false;  // core sem carimbos
                for (var i = 0; i < 2; i++) {
                    S.setAlpha(255);
                    S.fillRect(0, 0, w, hh, bg[i]);
                    draw();
                    S.setAlpha(255);
                    if (!S.nativeGrab(h, offs[i], 0, 0, w, hh)) return false;
                }
                return ctl(17, id | (w << 5) | (hh << 15)) === 1;
            },
            // slot 0..7 recebe o carimbo id em (x, y) do vidro; id < 0 esvazia
            place: function (slot, id, x, y) {
                var a = id < 0 ? (slot | (63 << 4))
                               : (slot | (id << 4) | ((x + 256) << 10) | ((y + 256) << 20));
                if (slotArg[slot] === a) return;
                slotArg[slot] = a;
                ctl(18, a);
            },
            stampReset: function () {
                if (h > 0) ctl(19);
                slotArg = [];
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
                direct = false;
                slotArg = [];
            },
        };
    })();

    function openRom(idx)
    {
        curIdx = idx;
        romName = roms[idx].name;
        listOff = 0;
        N.unload();
        // ROM grande no SD leva segundos (2,5 MB ~6 s no 4848): mostra o que
        // esta acontecendo em vez da lista congelada
        S.setAlpha(255);
        S.fillScreen(C_PANEL);
        txtCenter(fitText(baseOf(romName), W - 24, 2), W / 2, Math.round(H * 0.42), C_TEXT, 2);
        txtCenter("carregando " + sizeText(roms[idx].size) + "...", W / 2, Math.round(H * 0.42) + 30, C_DIM);
        UI.end(30);
        if (!N.load(roms[idx].path, roms[idx])) {
            errMsg = romName + " nao abriu" +
                     (cfg.errorHint ? " (" + cfg.errorHint + ")." : ".");
            screen = "err";
            return;
        }
        screen = "game";
        slotMsg = "";
        // bateria do cartucho antes do primeiro quadro
        if (sram) {
            try { N.sramLoad(sramPath()); } catch (e) {}
        }
        sramT = S.millis();
        lastRom = romName;
        if (typeof Storage !== "undefined") Storage.set("ultima", romName);
        spdT0 = 0;
        buildStamps();      // desenha no quadro do app; o needClear limpa
        skipHeavy = false;
        skipT0 = 0;
        skipSlow = 0;
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
            else if (g.kind === "x") btnsMask |= bits.x;
            else if (g.kind === "y") btnsMask |= bits.y;
            else if (g.kind === "l") btnsMask |= bits.l;
            else if (g.kind === "r") btnsMask |= bits.r;
            else if (g.kind === "start") btnsMask |= bits.start;
            else if (g.kind === "select") btnsMask |= bits.select;
        }
        if (freshIds.length > 0) touchSeen = S.millis();
        // gamepad do OS (API 61, canal Input.padState): mescla no MESMO
        // bitmask depois do toque — dpad e esquerdo = direcao, A/B/SEL/STA =
        // os botoes da tela. Broadcast: o toque nao derruba o que veio do
        // pad e vice-versa. O guide nem chega aqui (o servico inputsys
        // consome a borda dele e sai do app pelo caminho limpo).
        if (typeof Input !== "undefined" && typeof Input.padState === "function") {
            var ps = Input.padState();
            if (ps.seq > 0) {
                if (ps.seq !== padSeq) { padSeq = ps.seq; padSeen = S.millis(); }
                // rotulo (A->A) ou posicao (Nintendo x Xbox: troca A/B e X/Y)
                var pa = padSwap ? 2 : 1, pb = padSwap ? 1 : 2;
                var px = padSwap ? 8 : 4, py = padSwap ? 4 : 8;
                if ((ps.buttons & pa) !== 0) btnsMask |= bits.a;          // A
                if ((ps.buttons & pb) !== 0 && bits.b) btnsMask |= bits.b;  // B
                if (hasXY) {
                    if ((ps.buttons & px) !== 0) btnsMask |= bits.x;      // X
                    if ((ps.buttons & py) !== 0) btnsMask |= bits.y;      // Y
                }
                if (hasLR) {
                    if ((ps.buttons & (16 | 64)) !== 0) btnsMask |= bits.l;   // L1/L2
                    if ((ps.buttons & (32 | 128)) !== 0) btnsMask |= bits.r;  // R1/R2
                }
                if ((ps.buttons & 256) !== 0) btnsMask |= bits.select;  // select
                if ((ps.buttons & 512) !== 0) btnsMask |= bits.start;   // start
                if (ps.dpad & 0x1) btnsMask |= bits.up;
                if (ps.dpad & 0x4) btnsMask |= bits.down;
                if (ps.dpad & 0x8) btnsMask |= bits.left;
                if (ps.dpad & 0x2) btnsMask |= bits.right;
                var dz = 70;  // esquerdo tambem dirige (~55% do curso)
                if (ps.lx > dz) btnsMask |= bits.right;
                else if (ps.lx < -dz) btnsMask |= bits.left;
                if (ps.ly > dz) btnsMask |= bits.down;
                else if (ps.ly < -dz) btnsMask |= bits.up;
            }
        }
        if (!dpActive) { dpBaseX = DP_HOME_X; dpBaseY = DP_HOME_Y; dpKnobX = DP_HOME_X; dpKnobY = DP_HOME_Y; }
    }

    // controles na tela visiveis? (auto: somem com o gamepad em uso e voltam
    // ao primeiro toque no vidro)
    function uiVisible()
    {
        if (touchUi === 1) return true;
        if (touchUi === 2) return false;
        var now = S.millis();
        return !(now - padSeen < 8000 && padSeen > touchSeen);
    }

    function classifyArrival(x, y)
    {
        if (dist(x, y, PAUSE_X, PAUSE_Y) <= PAUSE_R + 10) return "pause";
        if (hasLR) {
            if (y >= L_Y - 10 && y <= L_Y + SH_H + 10) {
                if (x >= L_X - 6 && x <= L_X + SH_W + 6) return "l";
                if (x >= R_X - 6 && x <= R_X + SH_W + 6) return "r";
            }
        }
        if (hasXY) {
            // losango: o botao mais proximo dentro do raio + folga
            var best = "", bd = AB_R + 12;
            var cand = [["a", A_X, A_Y], ["b", B_X, B_Y], ["x", X_X, X_Y], ["y", Y_X, Y_Y]];
            for (var c = 0; c < cand.length; c++) {
                var dc = dist(x, y, cand[c][1], cand[c][2]);
                if (dc <= bd) { bd = dc; best = cand[c][0]; }
            }
            if (best) return best;
        }
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

    function paddleKnobX()
    {
        return PADDLE_X0 + Math.round((PADDLE_X1 - PADDLE_X0) * paddleValue / 255);
    }
    function drawRailAt(x0, y)
    {
        S.setAlpha(85);
        S.fillRoundRect(x0 - 10, y - 22, (PADDLE_X1 - PADDLE_X0) + 20, 44, 22, 0x0000);
        S.setAlpha(170);
        S.drawLine(x0, y, x0 + (PADDLE_X1 - PADDLE_X0), y, 0x9CF3);
    }
    function drawPaddleKnobAt(kx, ky)
    {
        S.setAlpha(210);
        S.fillCircle(kx, ky, KNOB_R - 6, 0xD69A);
        S.setAlpha(240);
        S.drawCircle(kx, ky, KNOB_R, 0xFFFF);
    }
    function drawPaddle()
    {
        drawRailAt(PADDLE_X0, PADDLE_Y);
        drawPaddleKnobAt(paddleKnobX(), PADDLE_Y);
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

    // ombro L/R: pilula larga no topo
    function drawShoulderAt(x, y, label, on)
    {
        S.setAlpha(on ? 185 : 70);
        S.fillRoundRect(x, y, SH_W, SH_H, Math.round(SH_H / 2), 0x0000);
        S.setAlpha(on ? 255 : 120);
        S.drawRoundRect(x, y, SH_W, SH_H, Math.round(SH_H / 2), on ? C_ACC : 0x8C71);
        S.setAlpha(255);
        txtMid(label, x + Math.round(SH_W / 2), y + Math.round(SH_H / 2), on ? 0xFFFF : C_SOFT, 2);
    }

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
        if (!uiVisible()) {
            drawPauseBtn();
            drawToast();
            S.setAlpha(255);
            return;
        }
        if (analogOn) drawPaddle(); else drawDpad();
        drawAB(A_X, A_Y, labels.a, (btnsMask & bits.a) !== 0);
        if (hasB) drawAB(B_X, B_Y, labels.b, (btnsMask & bits.b) !== 0);
        if (hasXY) {
            drawAB(X_X, X_Y, labels.x, (btnsMask & bits.x) !== 0);
            drawAB(Y_X, Y_Y, labels.y, (btnsMask & bits.y) !== 0);
        }
        if (hasLR) {
            drawShoulderAt(L_X, L_Y, labels.l, (btnsMask & bits.l) !== 0);
            drawShoulderAt(R_X, R_Y, labels.r, (btnsMask & bits.r) !== 0);
        }
        drawPill(SEL_X, labels.select, (btnsMask & bits.select) !== 0);
        drawPill(STA_X, labels.start, (btnsMask & bits.start) !== 0);
        drawPauseBtn();
        drawToast();
        S.setAlpha(255);
    }

    // ---- overlay em CARIMBOS (caminho direto) -----------------------------
    // Cada controle/estado vira um carimbo no core na abertura da ROM; por
    // quadro o app so diz qual carimbo vai em que lugar (N.place manda ao
    // core so os slots que mudaram) e o core compoe junto com o quadro.
    var ST_DPAD = 0, ST_KNOB = 3, ST_A = 5, ST_B = 7, ST_SEL = 9, ST_STA = 11,
        ST_PAUSE = 13, ST_TOAST = 14, ST_RAIL = 15, ST_PKNOB = 16,
        ST_X = 17, ST_Y = 19, ST_L = 21, ST_R = 23;
    var DP_BOX = 2 * (DP_RING + 6) + 4, KNOB_BOX = 2 * KNOB_R + 4, AB_BOX = 2 * AB_R + 4,
        PAUSE_BOX = 2 * PAUSE_R + 4, RAIL_W = (PADDLE_X1 - PADDLE_X0) + 24, RAIL_H = 48;
    var stampsOk = false;

    function buildStamps()
    {
        N.stampReset();
        var dc = DP_BOX >> 1, kc = KNOB_BOX >> 1, ac = AB_BOX >> 1, pc = PAUSE_BOX >> 1;
        var ok = N.stamp(ST_DPAD, DP_BOX, DP_BOX, function () { drawDpadAt(dc, dc, false, false); }) &&
            N.stamp(ST_DPAD + 1, DP_BOX, DP_BOX, function () { drawDpadAt(dc, dc, true, false); }) &&
            N.stamp(ST_DPAD + 2, DP_BOX, DP_BOX, function () { drawDpadAt(dc, dc, true, true); }) &&
            N.stamp(ST_KNOB, KNOB_BOX, KNOB_BOX, function () { drawKnobAt(kc, kc, false); }) &&
            N.stamp(ST_KNOB + 1, KNOB_BOX, KNOB_BOX, function () { drawKnobAt(kc, kc, true); }) &&
            N.stamp(ST_A, AB_BOX, AB_BOX, function () { drawAB(ac, ac, labels.a, false); }) &&
            N.stamp(ST_A + 1, AB_BOX, AB_BOX, function () { drawAB(ac, ac, labels.a, true); }) &&
            (!hasB || (N.stamp(ST_B, AB_BOX, AB_BOX, function () { drawAB(ac, ac, labels.b, false); }) &&
                       N.stamp(ST_B + 1, AB_BOX, AB_BOX, function () { drawAB(ac, ac, labels.b, true); }))) &&
            N.stamp(ST_SEL, SS_W + 4, SS_H + 4, function () { drawPillAt(2, 2, labels.select, false); }) &&
            N.stamp(ST_SEL + 1, SS_W + 4, SS_H + 4, function () { drawPillAt(2, 2, labels.select, true); }) &&
            N.stamp(ST_STA, SS_W + 4, SS_H + 4, function () { drawPillAt(2, 2, labels.start, false); }) &&
            N.stamp(ST_STA + 1, SS_W + 4, SS_H + 4, function () { drawPillAt(2, 2, labels.start, true); }) &&
            N.stamp(ST_PAUSE, PAUSE_BOX, PAUSE_BOX, function () { drawPauseAt(pc, pc); }) &&
            N.stamp(ST_TOAST, toastW() + 4, 26, function () { drawToastAt(2, 2); }) &&
            (!analog || (N.stamp(ST_RAIL, RAIL_W, RAIL_H, function () { drawRailAt(12, 24); }) &&
                         N.stamp(ST_PKNOB, KNOB_BOX, KNOB_BOX, function () { drawPaddleKnobAt(kc, kc); }))) &&
            (!hasXY || (N.stamp(ST_X, AB_BOX, AB_BOX, function () { drawAB(ac, ac, labels.x, false); }) &&
                        N.stamp(ST_X + 1, AB_BOX, AB_BOX, function () { drawAB(ac, ac, labels.x, true); }) &&
                        N.stamp(ST_Y, AB_BOX, AB_BOX, function () { drawAB(ac, ac, labels.y, false); }) &&
                        N.stamp(ST_Y + 1, AB_BOX, AB_BOX, function () { drawAB(ac, ac, labels.y, true); }))) &&
            (!hasLR || (N.stamp(ST_L, SH_W + 4, SH_H + 4, function () { drawShoulderAt(2, 2, labels.l, false); }) &&
                        N.stamp(ST_L + 1, SH_W + 4, SH_H + 4, function () { drawShoulderAt(2, 2, labels.l, true); }) &&
                        N.stamp(ST_R, SH_W + 4, SH_H + 4, function () { drawShoulderAt(2, 2, labels.r, false); }) &&
                        N.stamp(ST_R + 1, SH_W + 4, SH_H + 4, function () { drawShoulderAt(2, 2, labels.r, true); })));
        S.setAlpha(255);
        stampsOk = ok;
        // bancada: quanto da area de carimbos o overlay usou (dimensiona o
        // layout da scratch do core; cores sem o comando devolvem 0)
        if (cfg.stampUsedCtl) S.print("[emu] carimbos " + (ok ? "ok" : "FALHOU") + ": " + Math.round(N.ctl(cfg.stampUsedCtl) / 1024) + " KB");
        return ok;
    }

    function placeStamps()
    {
        var dc = DP_BOX >> 1, kc = KNOB_BOX >> 1, ac = AB_BOX >> 1, pc = PAUSE_BOX >> 1;
        if (!uiVisible()) {
            // gamepad em uso: so a pausa (e o nome da ROM) ficam no vidro
            for (var k = 0; k < 12; k++) {
                if (k !== 6 && k !== 7) N.place(k, -1, 0, 0);
            }
            N.place(6, ST_PAUSE, PAUSE_X - pc, PAUSE_Y - pc);
            N.place(7, toastOn() ? ST_TOAST : -1, 6, GY + 6);
            return;
        }
        if (hasXY) {
            N.place(8, ST_X + ((btnsMask & bits.x) !== 0 ? 1 : 0), X_X - ac, X_Y - ac);
            N.place(9, ST_Y + ((btnsMask & bits.y) !== 0 ? 1 : 0), Y_X - ac, Y_Y - ac);
        }
        if (hasLR) {
            N.place(10, ST_L + ((btnsMask & bits.l) !== 0 ? 1 : 0), L_X - 2, L_Y - 2);
            N.place(11, ST_R + ((btnsMask & bits.r) !== 0 ? 1 : 0), R_X - 2, R_Y - 2);
        }
        if (analogOn) {
            N.place(0, ST_RAIL, PADDLE_X0 - 12, PADDLE_Y - 24);
            N.place(1, ST_PKNOB, paddleKnobX() - kc, PADDLE_Y - kc);
        } else {
            var on = (btnsMask & (bits.up | bits.down | bits.left | bits.right)) !== 0;
            N.place(0, ST_DPAD + (dpActive ? (on ? 2 : 1) : 0),
                    Math.round(dpBaseX) - dc, Math.round(dpBaseY) - dc);
            N.place(1, ST_KNOB + (dpActive ? 1 : 0), Math.round(dpKnobX) - kc, Math.round(dpKnobY) - kc);
        }
        N.place(2, ST_A + ((btnsMask & bits.a) !== 0 ? 1 : 0), A_X - ac, A_Y - ac);
        if (hasB) N.place(3, ST_B + ((btnsMask & bits.b) !== 0 ? 1 : 0), B_X - ac, B_Y - ac);
        else N.place(3, -1, 0, 0);
        N.place(4, ST_SEL + ((btnsMask & bits.select) !== 0 ? 1 : 0), SEL_X - 2, SS_Y - 2);
        N.place(5, ST_STA + ((btnsMask & bits.start) !== 0 ? 1 : 0), STA_X - 2, SS_Y - 2);
        N.place(6, ST_PAUSE, PAUSE_X - pc, PAUSE_Y - pc);
        N.place(7, toastOn() ? ST_TOAST : -1, 6, GY + 6);
    }

    // ---- tela: lista de ROMs ----------------------------------------------
    // Linhas: "Continuar" (o ultimo jogo aberto) fixo no topo, depois as ROMs
    // em ordem alfabetica: nome sem extensao (reticencias se nao couber),
    // tamanho e quantos slots de save existem. Toque seco abre, arrasto rola,
    // toque no cabecalho reescaneia; gamepad: cima/baixo escolhe, A/START abre.
    var ROW_H = 44;
    // cabecalho medido pela fonte do titulo (a fonte 4 desce abaixo de 38 px)
    var HEAD_H = Math.max(38, S.fontHeight(4) + 10);
    var LIST_TOP = HEAD_H + 8;
    var selRow = -1;          // foco do gamepad (-1 = nenhum)
    var padPrevList = 0, padRepT = 0;

    function listRows()
    {
        var rows = [];
        var cont = -1;
        if (lastRom) {
            for (var i = 0; i < roms.length; i++) {
                if (roms[i].name === lastRom) { cont = i; break; }
            }
        }
        if (cont >= 0) rows.push({ idx: cont, cont: true });
        for (var j = 0; j < roms.length; j++) rows.push({ idx: j, cont: false });
        return rows;
    }
    function fitText(t, maxW, font)
    {
        if (S.textWidth(t, font) <= maxW) return t;
        var n = t.length;
        while (n > 1 && S.textWidth(t.substring(0, n) + "...", font) > maxW) n--;
        return t.substring(0, n) + "...";
    }
    function sizeText(b)
    {
        if (b >= 1048576) {
            var mb = Math.round(b * 10 / 1048576) / 10;
            return String(mb).replace(".", ",") + " MB";
        }
        return Math.round(b / 1024) + " KB";
    }
    function listView() { return H - LIST_TOP - 24; }

    function drawSel()
    {
        S.fillScreen(C_PANEL);
        txt(title, 8, 6, C_ACC, 4);
        var cnt = roms.length + (roms.length === 1 ? " ROM" : " ROMs");
        txt(cnt, W - S.textWidth(cnt, 1) - 10, 10, C_DIM);
        txt("toque: atualizar", W - S.textWidth("toque: atualizar", 1) - 10, 24, 0x3186);
        S.drawLine(0, HEAD_H, W, HEAD_H, 0x3186);
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
        var rows = listRows();
        var total = rows.length * ROW_H;
        var maxOff = total - listView();
        if (maxOff < 0) maxOff = 0;
        if (listOff > maxOff) listOff = maxOff;
        if (listOff < 0) listOff = 0;
        var y = LIST_TOP - listOff;
        for (var i = 0; i < rows.length; i++) {
            // Linha STRADDLING o cabecalho nao desenha: o nome dela em fonte 2
            // invadia a faixa do titulo ("N ROMs") e o divisor enquanto rolava.
            // Recorte padrao de lista: a linha entra quando o topo dela cruza
            // o divisor (embaixo o vidro recorta sozinho).
            if (y >= LIST_TOP && y <= H) {
                var r = roms[rows[i].idx];
                var hot = rowArrived(y) || i === selRow;
                if (hot) S.fillRect(0, y, W, ROW_H, 0x1886);
                var sz = sizeText(r.size);
                var szw = S.textWidth(sz, 1);
                if (rows[i].cont) {
                    txt("Continuar", 10, y + 4, C_OK, 1);
                    txt(fitText(baseOf(r.name), W - szw - 30, 2), 10, y + 18, hot ? C_ACC : C_TEXT, 2);
                } else {
                    txt(fitText(baseOf(r.name), W - szw - 30, 2), 10, y + 5, hot ? C_ACC : C_TEXT, 2);
                    var sub = r.saves > 0 ? (r.saves + (r.saves === 1 ? " save" : " saves")) : "";
                    if (sub) txt(sub, 10, y + 27, C_DIM);
                }
                txt(sz, W - szw - 12, y + 16, C_DIM);
                S.drawLine(10, y + ROW_H - 1, W - 10, y + ROW_H - 1, 0x2124);
            }
            y += ROW_H;
        }
        // barra de rolagem
        if (total > listView()) {
            var vh = listView();
            var bh = Math.max(20, Math.round(vh * vh / total));
            var by = LIST_TOP + Math.round((vh - bh) * listOff / (total - vh));
            S.fillRect(W - 4, by, 3, bh, 0x4208);
        }
        txtCenter("toque abre - arraste rola - gamepad: A abre", W / 2, H - 14, 0x3186);
    }
    function rowArrived(y)
    {
        for (var i = 0; i < freshIds.length; i++) {
            var f = fingers[freshIds[i]];
            if (f.ay >= y && f.ay < y + ROW_H) return true;
        }
        return false;
    }

    // Toque seco numa linha ARMA a abertura (dispara na saida do dedo);
    // traco que passa do toque seco desarma e vira rolagem 1:1 (delta ENTRE
    // quadros). Antes qualquer chegada abria na hora — arrasto comecado numa
    // linha nunca rolava — e o deslocamento TOTAL desde o pouso era somado de
    // novo a cada quadro: com o dedo parado a lista corria ate o fim.
    var TAP_SLOP = 14;   // px de traco que ainda conta como toque seco
    var armIdx = -1;     // linha armada na chegada
    var scrollY = -1;    // y do dedo de rolagem no quadro anterior
    var armHeader = false;

    // gamepad na lista: borda local (o canal e broadcast) + repeticao
    function padList(rows)
    {
        if (typeof Input === "undefined" || typeof Input.padState !== "function") return -1;
        var ps = Input.padState();
        if (ps.seq <= 0) return -1;
        var cur = ps.buttons | ((ps.dpad & 0xF) << 16);
        if (ps.ly < -70) cur |= 1 << 16;
        if (ps.ly > 70) cur |= 4 << 16;
        var edge = cur & ~padPrevList;
        var now = S.millis();
        if ((cur & (5 << 16)) !== 0 && (cur & (5 << 16)) === (padPrevList & (5 << 16)) && now >= padRepT) {
            edge |= cur & (5 << 16);
            padRepT = now + 120;
        } else if (edge & (5 << 16)) {
            padRepT = now + 400;
        }
        padPrevList = cur;
        if (edge & (1 << 16)) selRow = selRow <= 0 ? 0 : selRow - 1;
        if (edge & (4 << 16)) selRow = selRow < 0 ? 0 : Math.min(rows.length - 1, selRow + 1);
        if (selRow >= 0) {
            var top = selRow * ROW_H;
            if (top < listOff) listOff = top;
            if (top + ROW_H > listOff + listView()) listOff = top + ROW_H - listView();
        }
        if ((edge & (1 | 2 | 512)) !== 0 && selRow >= 0 && selRow < rows.length) return rows[selRow].idx;
        return -1;
    }

    function loopSel()
    {
        var ts = pollTouch();
        for (var h0 = 0; h0 < freshIds.length; h0++) {
            if (fingers[freshIds[h0]].ay < HEAD_H) armHeader = true;
        }
        if (ts.length === 0 && armHeader) {
            armHeader = false;
            scanRoms();
            selRow = -1;
        }
        if (roms.length === 0) { drawSel(); UI.end(30); return; }
        var rows = listRows();
        var padPick = padList(rows);
        if (padPick >= 0) {
            fingers = {}; freshIds = [];
            openRom(padPick);
            return;
        }
        for (var i = 0; i < freshIds.length; i++) {
            var f = fingers[freshIds[i]];
            if (f.ay < LIST_TOP || f.ay > H - 24) continue;
            var ri = Math.floor((f.ay + listOff - LIST_TOP) / ROW_H);
            if (ri >= 0 && ri < rows.length) { armIdx = rows[ri].idx; selRow = -1; }
        }
        for (var id in fingers) {
            if (!fingers.hasOwnProperty(id)) continue;
            var g = fingers[id];
            if (Math.abs(g.x - g.ax) > TAP_SLOP || Math.abs(g.y - g.ay) > TAP_SLOP) {
                armIdx = -1;
                armHeader = false;
                break;
            }
        }
        if (ts.length > 0) {
            var p = fingers[ts[0].id];
            if (p && p.ay >= LIST_TOP) {
                if (scrollY < 0) scrollY = p.y;
                else { listOff += scrollY - p.y; scrollY = p.y; }
                if (listOff < 0) listOff = 0;
            }
        } else {
            scrollY = -1;
            if (armIdx >= 0) {
                var pick = armIdx;
                armIdx = -1;
                fingers = {}; freshIds = [];
                openRom(pick);
                return;
            }
        }
        drawSel();
        UI.end(30);
    }

    // ---- tela: pausa ------------------------------------------------------
    // A lista de pausa tem os itens padrao + os extras do console (mapper,
    // cor, dificuldade). A altura da linha se adapta ao vidro: com 36 px
    // fixos, os 11 itens do Atari estouravam os 320 px do SmartDisplay e o
    // Sair ficava FORA do vidro (impossivel sair pelo menu) enquanto as
    // linhas invisiveis continuavam alcancaveis pelo toque.
    var MENU_TOP = 28;
    var MENU_H = 36;
    var menuSub = 0;
    function menuLayout(n)
    {
        var h = Math.floor((H - MENU_TOP - 8) / (n > 0 ? n : 1));
        MENU_H = h < 26 ? 26 : h > 36 ? 36 : h;  // piso = altura de toque
    }
    var menuHover = -1;
    var menuArm = -1;
    var hadMenuTouch = false;
    var menuFocus = -1;        // foco do gamepad no menu
    var padPrevMenu = 0;
    // o dedo que pausou ainda esta no vidro: sem esperar ele sair, a soltura
    // caia na linha do menu embaixo dele ("Continuar") e o jogo voltava
    var menuWaitRelease = false;

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

        if (menuSub === 3) return optionsList();

        var items = [
            { label: "Continuar", action: function () { resumeGame(); } },
            { label: "Reset", action: function () { N.reset(); slotMsg = ""; resumeGame(); } },
            { label: "Salvar estado", action: function () { menuSub = 1; menuArm = -1; } },
            { label: "Carregar estado", action: function () { menuSub = 2; menuArm = -1; } },
            { label: "Opcoes...", action: function () { menuSub = 3; menuArm = -1; } },
            { label: "Trocar jogo", action: function () { backToList(); } },
        ];
        items.push({ label: "Sair", action: function () { sramFlush(false); radioResume(); N.unload(); S.exitApp(); } });
        return items;
    }

    function skipLabel()
    {
        return skipSet < 0 ? "auto" : skipSet === 0 ? "desenha tudo" : skipSet === 1 ? "1 de 2" : "1 de 3";
    }
    function optionsList()
    {
        var tela = ["original", "4:3", "esticar"][aspectMode];
        var toque = ["auto", "sempre", "nunca"][touchUi];
        var items = [
            { label: "< Voltar", action: function () { menuSub = 0; menuArm = -1; } },
            { label: "Frameskip: " + skipLabel(), action: function () {
                skipSet = skipSet < 0 ? 0 : skipSet === 0 ? 1 : skipSet === 1 ? 2 : -1;
                skipHeavy = false; skipT0 = 0; skipSlow = 0;
                if (typeof Storage !== "undefined") {
                    Storage.set("skip", skipSet < 0 ? "1" : skipSet === 0 ? "0" : "f" + skipSet);
                }
            } },
            { label: "Audio: " + (audioOn ? "on" : "off"), action: function () {
                // na pausa o audio fica parado; vale ao continuar
                audioOn = !audioOn;
            } },
            { label: "Tela: " + tela, action: function () {
                aspectMode = (aspectMode + 1) % 3;
                if (typeof Storage !== "undefined") Storage.set("tela", String(aspectMode));
                computeGeom();
                N.rescale();
                needClear = true;
            } },
            { label: "Controles na tela: " + toque, action: function () {
                touchUi = (touchUi + 1) % 3;
                if (typeof Storage !== "undefined") Storage.set("toque", String(touchUi));
            } },
            { label: "Botoes do gamepad: " + (padSwap ? "posicao" : "rotulo"), action: function () {
                padSwap = padSwap ? 0 : 1;
                if (typeof Storage !== "undefined") Storage.set("padpos", padSwap ? "1" : "0");
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
        return items;
    }

    function drawPause()
    {
        S.fillScreen(C_PANEL);
        var head = menuSub === 3 ? "Opcoes" : menuSub === 1 ? "Salvar em..." : menuSub === 2 ? "Carregar de..." : romBase();
        txt(fitText(head, W - (spdText ? S.textWidth(spdText, 1) + 24 : 16), 2), 8, 6, C_ACC, 2);
        if (spdText && menuSub === 0) txt(spdText, W - S.textWidth(spdText, 1) - 8, 10, C_DIM);
        S.drawLine(0, 26, W, 26, 0x3186);
        var items = menuList();
        menuLayout(items.length);
        var y = MENU_TOP;
        for (var i = 0; i < items.length; i++) {
            var on = (i === menuHover || i === menuFocus);
            if (on) S.fillRect(0, y, W, MENU_H, 0x1886);
            txt(items[i].label, 12, y + 10, on ? C_ACC : C_TEXT, 2);
            y += MENU_H;
        }
        // rodape e msg de slot so quando sobra faixa livre (vidros baixos:
        // as linhas ocupam tudo e sobrepor o texto atrapalha o toque visual)
        if (slotMsg && y + 12 <= H) txtCenter(slotMsg, W / 2, y + 4, C_OK);
        if (y + 12 < H - 20) {
            var foot = menuSub === 3 ? "controles auto: somem com o gamepad, voltam no toque"
                                     : labels.select + "+" + labels.start + " pausa - gamepad: A escolhe, B volta";
            txtCenter(foot, W / 2, H - 14, 0x3186);
        }
    }

    // gamepad no menu: cima/baixo, A escolhe, B volta (ou continua)
    function padMenu(items)
    {
        if (typeof Input === "undefined" || typeof Input.padState !== "function") return null;
        var ps = Input.padState();
        if (ps.seq <= 0) return null;
        var cur = ps.buttons | ((ps.dpad & 0xF) << 16);
        var edge = cur & ~padPrevMenu;
        padPrevMenu = cur;
        if (edge & (1 << 16)) menuFocus = menuFocus <= 0 ? items.length - 1 : menuFocus - 1;
        if (edge & (4 << 16)) menuFocus = menuFocus < 0 || menuFocus >= items.length - 1 ? 0 : menuFocus + 1;
        if ((edge & 1) !== 0 && menuFocus >= 0 && menuFocus < items.length) return items[menuFocus];
        if ((edge & 2) !== 0) {
            return { action: function () {
                if (menuSub !== 0) { menuSub = 0; menuFocus = -1; } else resumeGame();
            } };
        }
        return null;
    }

    function loopPause()
    {
        var ts = pollTouch();
        var items = menuList();
        menuLayout(items.length);
        var pick = padMenu(items);
        if (pick) { pick.action(api); return; }
        if (menuWaitRelease) {
            if (ts.length === 0) menuWaitRelease = false;
            freshIds = [];
            drawPause();
            UI.end(30);
            return;
        }
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
        // Frameskip "auto": no caminho direto comeca desenhando TODO quadro
        // (o skip esconde de vez os sprites que o jogo pisca em quadros
        // alternados) e so passa a alternar se o jogo ficar claramente lento
        // assim (2 janelas de 2 s seguidas abaixo de 52 fps: um soluco de
        // toque/WiFi nao derruba). Bancada 4848: Atari ~59 fps desenhando
        // tudo, cabe; NES com a tela rolando ~6,5 ms de composicao, 44 fps,
        // nao cabe -> alterna e volta a ~59.
        var direct = N.direct() && stampsOk;
        var alt = !direct || skipHeavy;
        if (direct && !skipHeavy && skipSet < 0) {
            var now = S.millis();
            if (skipT0 === 0) {
                skipT0 = now + 500;  // aquecimento: limpeza do vidro, 1o quadro
                skipN = 0;
            } else if (now >= skipT0) {
                skipN++;
                if (now - skipT0 >= 2000) {
                    skipSlow = skipN * 1000 / (now - skipT0) < 52 ? skipSlow + 1 : 0;
                    if (skipSlow >= 2) skipHeavy = true;
                    skipT0 = now;
                    skipN = 0;
                }
            }
        }
        var render = true;
        var period = 1;
        if (skipSet > 0) period = skipSet + 1;
        else if (skipSet < 0 && alt) period = 2;
        if (period > 1) render = (frameNo % period) === 0;
        if (render && stampsOk) placeStamps();
        N.frame(btnsMask, render, stampsOk);
        // velocidade (mostrada na pausa): janelas de 2 s
        var tn = S.millis();
        if (spdT0 === 0) { spdT0 = tn; spdEmu = 0; spdDraw = 0; }
        spdEmu++;
        if (render) spdDraw++;
        if (tn - spdT0 >= 2000) {
            var fe = spdEmu * 1000 / (tn - spdT0), fd = spdDraw * 1000 / (tn - spdT0);
            spdText = Math.round(fe * 100 / 60) + "% - " + Math.round(fd) + " fps";
            spdT0 = tn; spdEmu = 0; spdDraw = 0;
        }
        // bateria: confere a cada 10 s e grava o .srm so se mudou
        if (sram && tn - sramT >= 10000) {
            sramT = tn;
            sramFlush(false);
        }
        if (render) {
            if (!N.direct()) {
                clearBands();
                drawOverlay();
            }
            UI.end(period > 1 ? Math.round(60 / period) : 60);
        }
    }

    function backToList()
    {
        sramFlush(false);
        N.unload();
        curIdx = -1;
        radioResume();
        scanRoms();
        screen = "sel";
        listOff = 0;
        selRow = -1;
        fingers = {}; freshIds = [];
    }

    function pauseGame()
    {
        screen = "pause";
        sramFlush(false);
        menuSub = 0; menuArm = -1; menuHover = -1; hadMenuTouch = false;
        menuFocus = -1; padPrevMenu = 0xFFFFFFFF;  // o botao que pausou nao vira escolha
        menuWaitRelease = true;
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
        skipT0 = 0;  // a pausa nao entra na medida
        spdT0 = 0;
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
    version: "0.4.0",  // 0.4.0: botoes X/Y/L/R opcionais (losango + ombros; bits
                       // 8-15 do controle no FRAME em arg >> 16), SRAM com bateria
                       // (cfg.sram: .srm ao abrir, na pausa/troca/saida e a cada
                       // 10 s se mudou), lista com "Continuar", nomes sem
                       // extensao, saves por ROM, barra de rolagem, reescan no
                       // cabecalho e navegacao pelo gamepad; pausa com "Trocar
                       // jogo", velocidade (% e fps) e submenu Opcoes (frameskip
                       // auto/0/1/2, audio, tela original/4:3/esticar, controles
                       // na tela auto/sempre/nunca, botoes do pad por rotulo ou
                       // posicao + extras do console); gamepad navega os menus.
                       // 0.3.1: menu de pausa com altura de linha adaptativa ao
                       // vidro (Sair alcancavel no 240x320; linhas invisiveis
                       // nao sao mais alcancaveis) e lista sem invadir o
                       // cabecalho ao rolar. 0.3.0: gamepad do OS (Input.padState,
                       // API 61) mesclado no btnsMask — dpad/esquerdo = direcao,
                       // A/B/SEL/STA = botoes da tela; toque e pad coexistem.
                       // 0.2.0: frameskip auto adaptativo e lista com
                       // toque/arrasto.
    run: run,
};
