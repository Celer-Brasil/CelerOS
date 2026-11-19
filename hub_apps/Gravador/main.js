// Gravador 2.0 — CelerKit UI 2.0. Grava pelo microfone do aparelho (Mic.*,
// API 19) num WAV PCM16 16 kHz no espaco privado do app, com botao circular
// grande, anel de nivel ao vivo e anel fino do tempo. A lista de gravacoes
// mostra data, tamanho e duracao (a data vem de um indice leve no NVS; a
// duracao sai do proprio tamanho do WAV) e abre um sheet com tocar/apagar.
//
// Placa sem microfone (CYD, devkit) ou sem a permissao: o app explica e
// continua sendo um player das gravacoes existentes. Placa sem alto-falante:
// o botao tocar fica desabilitado com o motivo. ES5 puro (Duktape).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.caps");
require("celeros.app.layout");

A.init();
var HAS_DISP = true;
try { HAS_DISP = System.getInfo().hasDisplay !== false; } catch (e) {}
if (HAS_DISP) A.style.preset("soft");
var T = A.style.T;

var caps = A.caps.probe();
var HAS_MIC = !!(caps.mic && typeof Mic !== "undefined" && typeof Mic.start === "function");
var HAS_WAV = caps.speaker && System.getInfo().hasAudio !== false && typeof System.playWav === "function";

var DATA = "/local/";
try { if (FS.appData) DATA = FS.appData() || "/local/"; } catch (e) { DATA = "/local/"; }

// A biblioteca ganha uma coluna propria no painel largo. Em retrato o
// controle de captura e a duracao compartilham uma faixa acima dos arquivos.
var area, capture, library, wide, radius, micX, micY, controlX, controlW, tabsY, labelY;
var lineH, rowH, sheetH;
if (HAS_DISP) {
    area = A.layout.bounds({ top: 40 });
    wide = HAS_MIC && A.layout.columns(area, 200, 6) >= 2;
    lineH = UI.lineHeight("caption");
    rowH = Math.max(38, UI.lineHeight("body") + lineH + 6);
    sheetH = 20 + UI.lineHeight("title") + (lineH + 4) * 2 + 82 +
             (System.screenHeight() - area.y - area.h) + 4;
    if (wide) {
        capture = A.layout.cell(area, 2, 1, 0, 6);
        library = A.layout.cell(area, 2, 1, 1, 6);
    } else {
        var captureH = HAS_MIC ? Math.max(86, 52 + lineH) : UI.lineHeight("body") + lineH * 2 + 22;
        capture = { x: area.x, y: area.y, w: area.w, h: captureH };
        library = { x: area.x, y: area.y + captureH + 6, w: area.w, h: area.h - captureH - 6 };
    }
    radius = wide ? 39 : 30;
    micX = capture.x + (wide ? Math.floor(capture.w / 2) : radius + 10);
    micY = capture.y + Math.floor(capture.h * (wide ? 0.38 : 0.5));
    controlX = wide ? capture.x + 5 : micX + radius + 10;
    controlW = capture.x + capture.w - controlX - 5;
    tabsY = wide ? capture.y + capture.h - 40 : capture.y + capture.h - 34;
    labelY = tabsY - lineH - 3;
}

// ---------------------------------------------------------------- estado ---
var maxS = 5;                  // duracao alvo (2..10 s), persistida
var recording = false;
var recStart = 0;
var level = 0;                 // nivel suavizado 0..100
var recCount = 0;              // proximo indice de nome
var stamp = 0;                 // carimbo da varredura de arquivos
var cache = null;              // { stamp, rows }
var fechaSheet = -1;           // indice aberto no sheet (-1 = fechado)
var sheetOpen = false;

(function carregaCfg() {
    try {
        var m = parseInt(Storage.get("maxS") || "0", 10);
        if (m >= 2 && m <= 10) maxS = m;
    } catch (e) {}
})();
function salvaCfg() {
    try { Storage.set("maxS", String(maxS)); } catch (e) {}
}

// indice nome -> data da gravacao (o WAV nao carrega metadado de data)
var datas = {};
(function carregaDatas() {
    try {
        var d = JSON.parse(Storage.get("datas") || "null");
        if (d && typeof d === "object") datas = d;
    } catch (e) {}
})();
function salvaDatas(nome) {
    datas[nome] = System.getDate() + " " + System.getTime();
    var s = JSON.stringify(datas);
    if (s.length > 3000) {           // NVS tem teto: recomeca o indice
        var novo = {};
        novo[nome] = datas[nome];
        datas = novo;
        s = JSON.stringify(datas);
    }
    try { Storage.set("datas", s); } catch (e) {}
}

// ---- formato local (o app nao adota o fmt so por 2 funcoes) ----------------
function fmtDur(ms) {
    var s = Math.round((ms || 0) / 100) / 10;
    return (s % 1 ? s : s.toFixed(0)) + " s";
}
function fmtBytes(n) {
    n = n | 0;
    return n <= 0 ? "" : (n < 1024 ? n + " B" : Math.round(n / 1024) + " KB");
}
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function mmss(ms) {
    var s = Math.floor((ms || 0) / 1000);
    return "0:" + pad2(s % 60) + "." + Math.floor((ms || 0) / 100) % 10;
}

// ---- lista de gravacoes ----------------------------------------------------
function varre() {
    var out = [], nomes = [], found = [];
    try { nomes = FS.listDir ? (FS.listDir(DATA) || []) : []; } catch (e) { nomes = []; }
    for (var i = 0; i < nomes.length; i++) {
        var n = String(nomes[i]), j = n.lastIndexOf("/");
        if (j >= 0) n = n.substring(j + 1);
        if (n.indexOf("voz-") !== 0 || n.substring(n.length - 4).toUpperCase() !== ".WAV") continue;
        var num = parseInt(n.substring(4), 10);
        if (isNaN(num)) continue;
        if (num >= recCount) recCount = num + 1;
        found.push({ num: num, file: n });
    }
    // mais novas primeiro (chave pre-computada: sort do Duktape nao cede)
    for (var a = 1; a < found.length; a++) {
        var it = found[a], b = a - 1;
        while (b >= 0 && found[b].num < it.num) { found[b + 1] = found[b]; b--; }
        found[b + 1] = it;
    }
    for (var j = 0; j < found.length; j++) {
        var sz = 0;
        try { sz = FS.getFileSize ? (FS.getFileSize(DATA + found[j].file) || 0) : 0; } catch (e) { sz = 0; }
        var d = datas[found[j].file] || "";
        out.push({
            label: "voz " + found[j].num,
            sub: d || (sz > 0 ? "gravação" : ""),
            right: sz > 44 ? fmtDur((sz - 44) / 32) : "",
            file: found[j].file,
            size: sz
        });
    }
    return out;
}
function rows() {
    if (cache && cache.stamp === stamp) return cache.rows;
    cache = { stamp: stamp, rows: varre() };
    return cache.rows;
}

// --------------------------------------------------------------- gravacao ---
function temEspaco() {
    try { return !FS.getFreeSpace || FS.getFreeSpace("/local") > maxS * 32 * 1024 + 8192; }
    catch (e) { return true; }
}

function startRec() {
    if (!HAS_MIC || recording) return false;
    if (!temEspaco()) { A.toast("sem espaço livre para gravar"); return false; }
    var ok = false;
    try { ok = Mic.start({ ms: maxS * 1000 }); } catch (e) { ok = false; }
    if (!ok) { A.toast("não deu para gravar agora"); return false; }
    recording = true;
    recStart = System.millis();
    level = 0;
    UI.invalidate();
    return true;
}

// encerra e salva; devolve true se gravou algo
function stopRec() {
    if (!recording) return false;
    recording = false;
    var wav = null;
    try { wav = Mic.stop({ raw: true }); } catch (e) { wav = null; }
    var ms = System.millis() - recStart;
    level = 0;
    if (!wav) { A.toast("gravação vazia (muito curta?)"); UI.invalidate(); return false; }
    var name = "voz-" + recCount + ".wav";
    var wrote = false;
    try { wrote = FS.writeFile(DATA + name, wav); } catch (e) {
        if (e.name === "RangeError") {
            A.toast("WAV acima do limite de 64 KB");
            UI.invalidate();
            return false;
        }
    }
    if (!wrote) { A.toast("sem espaço para salvar"); UI.invalidate(); return false; }
    recCount++;
    salvaDatas(name);
    stamp++;
    A.toast("salvo: " + name + " (" + fmtDur(ms) + ")");
    UI.invalidate();
    return true;
}

function cancelaRec() {
    if (!recording) return;
    recording = false;
    level = 0;
    try { Mic.stop({ raw: true }); } catch (e) {}
    A.toast("gravação cancelada");
    UI.invalidate();
}

// ---- sheet -----------------------------------------------------------------
function abreSheet(i) {
    fechaSheet = i;
    sheetOpen = true;
    UI.invalidate();
}
function fecha() {
    sheetOpen = false;
    UI.invalidate();
}

function toca(it) {
    fecha();
    A.busy("Tocando " + it.label + "...");
    var ok = false;
    try { ok = System.playWav(DATA + it.file); } catch (e) { ok = false; }
    UI.invalidate();
    if (!ok) A.toast("falha ao tocar " + it.file);
    else A.toast(it.label + " · " + it.right);
}

function apaga(it) {
    if (!UI.confirm("Apagar", "Remover " + it.label + " (" + it.right + ")?", { danger: true })) return;
    try { FS.deleteFile(DATA + it.file); } catch (e) {}
    stamp++;
    fecha();
    A.toast("apagado");
}

// ---------------------------------------------------------------- desenho ---
function botaoGravar(full) {
    if (!recording && !full) return;
    var r = radius, x = micX, y = micY;
    var frac = Math.max(0, Math.min(1, level / 100));
    System.fillArc(x, y, r - 4, r, 0, 360, recording ? T.raised : T.accentD);
    if (recording) {
        if (frac > 0.004) System.fillArc(x, y, r - 4, r, -90, -90 + 360 * frac, T.err);
        var tf = Math.min(1, (System.millis() - recStart) / (maxS * 1000));
        System.fillArc(x, y, r + 1, r + 3, -90, -90 + 360 * tf, T.warn);
    }
    if (full) {
        System.fillCircle(x, y, r - 8, recording ? T.err : T.accent);
        if (recording) {
            System.fillRoundRect(x - 6, y - 6, 12, 12, 2, T.text);
        } else {
            System.fillRoundRect(x - 4, y - 11, 8, 14, 4, T.onAccent);
            System.fillArc(x, y, 7, 9, 0, 180, T.onAccent);
            System.fillRect(x - 1, y + 7, 3, 5, T.onAccent);
            System.fillRect(x - 5, y + 11, 11, 2, T.onAccent);
        }
    }
}

function telaMain(c) {
    var r = rows();

    // nivel ao vivo + parada automatica no teto (vale com o sheet aberto)
    if (recording) {
        var lv = -1;
        try { lv = Mic.level(); } catch (e) { lv = -1; }
        if (lv >= 0) level = level * 0.55 + Math.min(100, lv) * 0.45;
        else level *= 0.9;
        var el = System.millis() - recStart;
        var alive = false;
        try { alive = Mic.recording(); } catch (e) { alive = false; }
        if (!alive || el >= maxS * 1000) { stopRec(); return; }
    }

    if (sheetOpen) {
        // sheet aberto: a base nao e repintada (as primitivas cruas do botao
        // passariam por cima do cartao nos frames parciais)
        var it = r[fechaSheet];
        if (!it) { fecha(); return; }
        var res = A.widgets.sheet("gv-det", {
            open: true, full: c.full, h: sheetH, title: it.label
        }, function (q) {
            var x = Math.max(q.x, area.x);
            var w = Math.min(q.x + q.w, area.x + area.w) - x;
            var y = q.y;
            UI.text("Duração", x, y, { role: "caption", color: T.textDim, w: 72, lines: 1, id: "gv-l0" });
            UI.text(it.right || "-", x + w, y,
                    { role: "caption", align: "right", color: T.text, w: 128, lines: 1, id: "gv-v0" });
            y += lineH + 4;
            UI.text("Tamanho", x, y, { role: "caption", color: T.textDim, w: 72, lines: 1, id: "gv-l1" });
            UI.text(fmtBytes(it.size) || "-", x + w, y,
                    { role: "caption", align: "right", color: T.text, w: 128, lines: 1, id: "gv-v1" });
            y += lineH + 4;
            var bw = Math.floor((w - 8) / 2);
            var b1 = A.style.button(HAS_WAV ? "Tocar" : "Sem áudio", x, y + 4, bw, 38,
                                    { disabled: !HAS_WAV, icon: HAS_WAV ? "play" : "" });
            if (b1) toca(it);
            var b2 = A.style.button("Apagar", x + bw + 8, y + 4, bw, 38,
                                    { variant: "danger" });
            if (b2) apaga(it);
            var b3 = A.style.button("Fechar", x, y + 50, w, 32, { variant: "ghost" });
            if (b3) fecha();
        });
        if (res === "close") fecha();
        return;
    }

    var h = A.widgets.header("Gravador", {
        full: c.full,
        sub: r.length ? r.length + (r.length === 1 ? " gravação" : " gravações") : "vazio"
    });
    if (h.back) {
        if (recording) cancelaRec();
        return A.BACK;
    }

    if (HAS_MIC) {
        A.style.card(capture.x, capture.y, capture.w, capture.h, { full: c.full, pad: 0, elev: 0, draw: function () {
            botaoGravar(c.full);
            var cx = controlX + controlW / 2;
            var statusY = wide ? micY + radius + 8 : capture.y + 4;
            UI.text(recording ? mmss(System.millis() - recStart) : "Gravar", cx, statusY,
                    { role: "title", align: "center", color: recording ? T.err : T.text, w: controlW });
            UI.text("Duração (s)", cx, labelY,
                    { role: "caption", align: "center", color: T.textDim, w: controlW });
            var idx = maxS === 2 ? 0 : (maxS === 10 ? 2 : 1);
            var selected = A.widgets.segmented(controlX, tabsY, controlW, 28, ["2", "5", "10"], idx);
            if (!recording && selected !== idx) {
                maxS = [2, 5, 10][selected];
                salvaCfg();
                UI.invalidate();
            }
        }});
        var t = UI.touch(), dx = t.x - micX, dy = t.y - micY;
        if (t.tap && dx * dx + dy * dy <= (radius + 4) * (radius + 4)) {
            if (recording) stopRec();
            else startRec();
        }
    } else {
        A.style.card(capture.x, capture.y, capture.w, capture.h, { full: c.full, pad: 6, elev: 0, draw: function (q) {
            if (c.full) A.icons.draw("alert", q.x, q.y, 16, { color: T.warn });
            UI.text("Sem microfone", q.x + 22, q.y, { role: "body", w: q.w - 22 });
            UI.text("Toque numa gravação para ouvir ou apagar.", q.x, q.y + UI.lineHeight("body") + 3,
                    { role: "caption", color: T.textDim, w: q.w, lines: 2 });
        }});
    }

    UI.text("Gravações", library.x + 4, library.y + 3,
            { role: "caption", color: T.textDim, w: library.w - 8 });
    var ly = library.y + lineH + 8, lh = library.h - lineH - 8;
    if (!r.length) {
        A.style.card(library.x, ly, library.w, lh, { full: c.full, elev: 0, pad: 4, draw: function (q) {
            UI.text("Nenhuma gravação", q.x + q.w / 2, q.y + (q.h - lineH) / 2,
                    { role: "caption", align: "center", color: T.textDim, w: q.w });
        }});
    } else {
        var i = UI.list("gv-list", library.x, ly, library.w, lh, r, { rowH: rowH });
        if (i >= 0) abreSheet(i);
    }
}
telaMain.fps = 20;

// ---- laco ------------------------------------------------------------------
if (!HAS_DISP) {
    // placa headless: sem UI e sem mic util; avisa no log e sai limpo
    System.print("Gravador: sem tela");
    System.exitApp();
} else {
    A.run({ main: telaMain }, "main", { fps: 20 });
}
