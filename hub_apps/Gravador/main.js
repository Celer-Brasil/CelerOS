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

A.init();
var HAS_DISP = true;
try { HAS_DISP = System.getInfo().hasDisplay !== false; } catch (e) {}
if (HAS_DISP) A.style.preset("soft");
var T = A.style.T;

var caps = A.caps.probe();
var HAS_MIC = !!(caps.mic && typeof Mic !== "undefined" && typeof Mic.start === "function");
var HAS_WAV = typeof System.playWav === "function";

var DATA = "/local/";
try { if (FS.appData) DATA = FS.appData() || "/local/"; } catch (e) { DATA = "/local/"; }

// ---- layout (margem segura do vidro redondo) -------------------------------
var LX = A.L.x, LW = A.L.w, BOT = A.L.bottom, CX = A.L.cx;
var CARD_Y = 44, CARD_H = 124;
var SEG_Y = CARD_Y + CARD_H + 8, SEG_H = 28;
var LIST_Y = SEG_Y + SEG_H + 20, LIST_H = BOT - LIST_Y;

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
    try { wrote = FS.writeFile(DATA + name, wav); } catch (e) { wrote = false; }
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
// Botao circular: anel do nivel (gravando) ou trilha (parado), circulo
// central e tempo. Pintado com System.* a cada frame (como o ring do kit).
function botaoGravar(cy) {
    var r = 41, x = CX, y = cy;
    var frac = recording ? Math.max(0, Math.min(1, level / 100)) : 0;
    // trilha do anel
    System.fillArc(x, y, r - 7, r, 0, 360, T.raised);
    if (recording) {
        if (frac > 0.004) System.fillArc(x, y, r - 7, r, -90, -90 + 360 * frac, T.err);
        var el = System.millis() - recStart;
        var tf = Math.min(1, el / (maxS * 1000));
        System.fillArc(x, y, r + 1, r + 4, -90, -90 + 360 * tf, T.warn);
    } else {
        System.fillArc(x, y, r - 7, r, -90, 270, T.accentD);
    }
    System.fillCircle(x, y, r - 11, recording ? T.err : T.accent);
    // rotulo/tempo no centro (fonte 2, datum MC)
    System.setTextDatum(5);
    System.setTextColor(recording ? T.text : T.onAccent);
    if (recording) System.drawString(mmss(System.millis() - recStart), x, y - 4, 2);
    else System.drawString("Gravar", x, y - 4, 2);
    System.setTextDatum(0);
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
            open: true, full: c.full, h: 170, title: it.label
        }, function (q) {
            var y = q.y;
            UI.text("Duração", q.x, y, { role: "caption", color: T.textDim, w: 72, lines: 1, id: "gv-l0" });
            UI.text(it.right || "-", q.x + q.w, y,
                    { role: "caption", align: "right", color: T.text, w: 128, lines: 1, id: "gv-v0" });
            y += 18;
            UI.text("Tamanho", q.x, y, { role: "caption", color: T.textDim, w: 72, lines: 1, id: "gv-l1" });
            UI.text(fmtBytes(it.size) || "-", q.x + q.w, y,
                    { role: "caption", align: "right", color: T.text, w: 128, lines: 1, id: "gv-v1" });
            y += 18;
            var bw = Math.floor((q.w - 8) / 2);
            var b1 = A.style.button("Tocar", q.x, y + 4, bw, 38,
                                    { disabled: !HAS_WAV, icon: "play" });
            if (b1) toca(it);
            var b2 = A.style.button("Apagar", q.x + bw + 8, y + 4, bw, 38,
                                    { variant: "danger" });
            if (b2) apaga(it);
            var b3 = A.style.button("Fechar", q.x, y + 50, q.w, 32, { variant: "ghost" });
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
        A.style.card(LX, CARD_Y, LW, CARD_H, { full: c.full, pad: 0, draw: function () {
            botaoGravar(CARD_Y + 48);
            UI.text(recording ? "gravando · parar" : "toque para gravar",
                    CX, CARD_Y + CARD_H - 22,
                    { role: "caption", align: "center", color: recording ? T.err : T.textDim,
                      w: LW - 16, lines: 1, id: "gv-st" });
        }});
        // tap no circulo (o header/segmentado ja consumiram o deles)
        var t = UI.touch();
        if (t.tap) {
            var dx = t.x - CX, dy = t.y - (CARD_Y + 48);
            if (dx * dx + dy * dy <= 52 * 52) {
                if (recording) stopRec();
                else startRec();
                UI.invalidate();
            }
        }
    } else {
        A.style.card(LX, CARD_Y, LW, CARD_H, { full: c.full, draw: function (q) {
            A.icons.draw("alert", q.x, q.y + 3, 18, { color: T.warn });
            UI.text("Sem microfone", q.x + 26, q.y,
                    { role: "body", w: q.w - 26, lines: 1, id: "gv-nomic" });
            UI.text("Sem mic ou permissão. Toque numa gravação para ouvir ou apagar.",
                    q.x, q.y + 26,
                    { role: "caption", color: T.textDim, w: q.w, lines: 4, id: "gv-nomic2" });
        }});
    }

    // duracao alvo (persistida) — segmented do kit
    if (HAS_MIC) {
        var idx = 1;
        if (maxS === 2) idx = 0; else if (maxS === 10) idx = 2;
        var sel = A.widgets.segmented(LX, SEG_Y, LW, SEG_H, ["2 s", "5 s", "10 s"], idx);
        if (!recording && sel !== idx) {
            maxS = sel === 0 ? 2 : (sel === 2 ? 10 : 5);
            salvaCfg();
            UI.invalidate();
        }
    }

    // lista de gravacoes (sem mic ela sobe, o segmented nao existe)
    var ly = HAS_MIC ? LIST_Y : CARD_Y + CARD_H + 18;
    var lh = BOT - ly;
    UI.text("Gravações", LX, ly - 14,
            { role: "caption", color: T.textDim, w: LW - 60, lines: 1, id: "gv-cap" });
    if (!r.length) {
        UI.text("Nenhuma gravação.", CX, ly + 18,
                { role: "caption", align: "center", color: T.textDim, w: LW, lines: 1, id: "gv-empty" });
    } else {
        var i = UI.list("gv-list", LX, ly, LW, lh, r, { rowH: 44 });
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
