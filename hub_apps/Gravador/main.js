// Gravador de Voz — grava pelo microfone do aparelho (Mic.*, API 19) sobre o
// CelerKit (deps celeros.app.*): a duracao alvo persiste no NVS
// (celeros.app.data), a lista de gravacoes so varre o disco quando muda
// (celeros.app.list), duracoes/tamanhos saem no formato do sistema
// (celeros.app.fmt) e os caminhos vem de celeros.app.path. Salva WAVs no
// appData e reproduz com System.playWav (API 13). Requer permissao de
// microfone e uma placa com mic (relogio/cao): sem ele o app explica e vira
// um player das gravacoes existentes. ES5 puro (Duktape).

var A = require("celeros.app");
require("celeros.app.data");      // duracao alvo no NVS
require("celeros.app.fmt");       // A.fmt.dur / A.fmt.bytes
require("celeros.app.list");      // cache das linhas por carimbo
require("celeros.app.path");      // base/ext dos arquivos varridos

A.init();
var T = A.T;
var W = 240;
var DATA = (FS.appData ? FS.appData() : "/local/");
var hasMic = (typeof Mic !== "undefined") && (typeof Mic.start === "function");
var hasWav = (typeof System.playWav === "function");
var hasTone = (typeof System.playTone === "function");
function tone(hz, ms) {
    if (hasTone) { try { System.playTone([[hz, ms]]); } catch (e) {} }
}

// ---------------------------------------------------------------- estado ---
var recMaxS = 6;             // duracao alvo (slider, persistida)
var recording = false;
var recStart = 0;
var recCount = 0;            // proximo indice de nome
var level = 0;               // 0..100 para o gauge

(function () {               // duracao escolhida sobrevive a saida do app
    var cfg = A.data.loadState("cfg", null);
    if (cfg && typeof cfg.maxS === "number" && cfg.maxS >= 2 && cfg.maxS <= 10) recMaxS = cfg.maxS;
})();
function salvaCfg() { A.data.saveState("cfg", { maxS: recMaxS }); }

// espaco livre antes de gravar (o WAV e 32 KB/s; o firmware exige o drive)
function temEspaco() {
    try { return FS.getFreeSpace("/local") > recMaxS * 32 * 1024; }
    catch (e) { return true; }           // sem como saber: deixa tentar
}

// ---- lista de gravacoes: [{label, right, file}] ------------------------------
// so varre o disco quando o carimbo muda (gravou/apagou)
var verRecs = 0;
function varreRecs() {
    var found = [];
    var names = FS.listDir ? FS.listDir(DATA) : [];
    for (var i = 0; i < names.length; i++) {
        var n = A.path.base(names[i]);
        if (n.indexOf("voz-") !== 0 || A.path.ext(n) !== "WAV") continue;
        var num = parseInt(n.substring(4), 10);
        if (isNaN(num)) continue;
        if (num >= recCount) recCount = num + 1;
        found.push({ num: num, file: n });
    }
    A.list.sort(found, function (r) { return ("000" + r.num).slice(-4); });
    var out = [];
    for (var k = 0; k < found.length; k++) {
        var sz = 0;
        try { sz = FS.getFileSize ? FS.getFileSize(DATA + found[k].file) : 0; } catch (e) { sz = 0; }
        out.push({ label: "voz " + found[k].num,
                   right: sz > 0 ? A.fmt.bytes(sz) : "wav",
                   file: found[k].file });
    }
    return out;
}
var lista = A.list.make(function () { return verRecs; }, varreRecs);

function startRec() {
    var ok = false;
    try { ok = Mic.start({ ms: recMaxS * 1000 }); } catch (e) { ok = false; }
    if (!ok) { A.toast("não deu para gravar agora"); return false; }
    recording = true;
    recStart = System.millis();
    tone(880, 40);
    return true;
}

// encerra e salva; devolve true se gravou algo
function stopRec() {
    recording = false;
    var wav = null;
    try { wav = Mic.stop({ raw: true }); } catch (e) { wav = null; }
    var ms = System.millis() - recStart;
    if (!wav) { A.toast("gravação vazia (muito curta?)"); return false; }
    var name = "voz-" + recCount + ".wav";
    var wrote = false;
    try { wrote = FS.writeFile(DATA + name, wav); } catch (e) { wrote = false; }
    if (!wrote) { A.toast("sem espaço para salvar"); tone(220, 200); return false; }
    recCount++;
    verRecs++;
    A.toast("salvo: " + name + " (" + A.fmt.dur(ms) + ")");
    tone(660, 60);
    return true;
}

// descarta o buffer (voltar no meio da gravacao)
function cancelaRec() {
    recording = false;
    try { Mic.stop({ raw: true }); } catch (e) {}
    tone(220, 80);
    A.toast("gravação cancelada");
}

// ------------------------------------------------------------------ telas ---
function telaMain(c) {
    var rows = lista.rows();
    if (A.header("Gravador de voz", { sub: rows.length + " gravações" })) return A.BACK;

    if (!hasMic) {
        UI.badge("sem microfone", 12, 54, { color: T.err, textColor: T.onAccent });
        UI.text("esta placa não tem microfone (ou a permissão não foi dada).",
                W / 2, 92, { role: "caption", align: "center", color: T.textDim, w: W - 32, lines: 2 });
    } else {
        UI.text("duração máxima", 16, 58, { role: "caption", color: T.textDim });
        var novo = UI.slider(16, 70, 150, recMaxS, { min: 2, max: 10, step: 1 });
        if (novo !== recMaxS) { recMaxS = novo; salvaCfg(); }
        UI.text(recMaxS + "s", 178, 74, { role: "title" });
        if (UI.button("Gravar", 16, 108, 208, 52)) {
            if (!temEspaco()) { A.toast("sem espaço livre para gravar"); tone(220, 200); }
            else if (startRec()) return "gravando";
        }
        UI.text("32 KB por segundo de áudio", W / 2, 170,
                { role: "caption", align: "center", color: T.textDim });
    }

    var sel = UI.list("recs", 16, 196, W - 32, 96, rows, { rowH: 30 });
    if (sel >= 0 && hasWav) {
        var it = rows[sel];
        A.toast("tocando " + it.label);
        var played = false;
        try { played = System.playWav(DATA + it.file); } catch (e) { played = false; }
        if (!played) A.toast("falha ao tocar " + it.file);
    }

    if (rows.length && UI.button("Apagar ultima", 16, 296, 208, 20, { style: "ghost" })) {
        var last = rows[rows.length - 1];
        if (UI.confirm("Apagar", "Remover " + last.label + " (" + last.right + ")?", { danger: true })) {
            try { FS.deleteFile(DATA + last.file); } catch (e) {}
            verRecs++;
            A.toast("apagado");
        }
    }
}

function telaGravando(c) {
    // nivel ao vivo (0..100) alimentando o arco
    var lv = -1;
    try { lv = Mic.level(); } catch (e) { lv = -1; }
    level = lv >= 0 ? Math.max(0, Math.min(100, lv)) : 0;
    var el = System.millis() - recStart;
    var pct = Math.min(100, Math.round(el / (recMaxS * 1000) * 100));

    if (A.header("Gravando", { sub: A.fmt.dur(el) })) {
        cancelaRec();                    // voltar cancela sem salvar
        return A.BACK;
    }
    // gauge: arco do nivel + arco fino do tempo
    System.fillArc(W / 2, 130, 44, 54, -120, -120 + 240 * level / 100, T.accent);
    System.fillArc(W / 2, 130, 34, 40, -120, -120 + 240 * pct / 100, T.accentD);
    System.setTextDatum(5);           // MC (LovyanGFX: 4 e middle-left)
    System.setTextColor(T.text, T.bg);
    System.drawString(level + "%", W / 2, 126, 2);
    System.setTextColor(T.textDim, T.bg);
    System.drawString("nível do microfone", W / 2, 148, 1);
    System.setTextDatum(0);

    // expirou sozinho (fim do buffer)? encerra e salva
    var alive = false;
    try { alive = Mic.recording(); } catch (e) { alive = false; }
    if (!alive) { stopRec(); return A.BACK; }
    if (UI.button("Parar e salvar", 40, 210, 160, 48, { style: "danger" })) {
        stopRec();
        return A.BACK;
    }
}
telaGravando.fps = 25;

// ---- laco -----------------------------------------------------------------------
A.run({ main: telaMain, gravando: telaGravando }, "main", { fps: 15 });
