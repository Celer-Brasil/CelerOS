// USB Storage 2.0 — pendrive no USB Host (API 48), driver 100% em JS.
// celeros.usb.msc fala Bulk-Only Transport + SCSI e le FAT32/exFAT (somente
// leitura): o firmware so entrega os bulk transfers. O app monta, mostra
// rotulo/tipo/tamanho, navega as pastas e abre arquivos de texto.
//
// Sem USB Host explica; sem pendrive espera o hotplug; se o mount falhar
// (FAT12/16, NTFS ou aparelho lento) tenta de novo no botao. Em placa
// headless imprime o volume e a raiz no logcat, uma vez por conexao.

var A = require("celeros.app");
require("celeros.usb");
var msc = require("celeros.usb.msc");

A.init();
var HAS_DISP = System.getInfo().hasDisplay !== false;
var T = A.T;
var CB = { color: T.card, radius: 10, stroke: true };
var HAS_USB = typeof USB !== "undefined";
var LX = A.L.x, LW = A.L.w, BOT = A.L.bottom;

function fmtSize(n) {
    n = n | 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    if (n < 1073741824) return Math.round(n / 1048576) + " MB";
    return Math.round(n / 1073741824) + " GB";
}

function findMsc() {
    if (!HAS_USB || !USB.devices) return null;
    var ds = [];
    try { ds = USB.devices() || []; } catch (e) { ds = []; }
    for (var i = 0; i < ds.length; i++) {
        var d = ds[i];
        for (var k = 0; k < d.ifs.length; k++) {
            var f = d.ifs[k];
            if (f.cls === 8 && f.subcls === 6 && f.proto === 0x50) return d;
        }
    }
    return null;
}
// O device pode ainda nao estar pronto no plug (INQUIRY/CAPACITY falham):
// tenta de novo por ~1 s. Devolve o volume ou null.
function montar(dev, n) {
    for (var i = 0; i < n; i++) {
        var v = null;
        try { v = msc.openVolume(dev); } catch (e) { v = null; }
        if (v) return v;
        System.delay(200);
    }
    return null;
}

function textOf(b, max) {
    var s = "";
    for (var i = 0; i < b.length && i < max; i++) {
        var c = b[i];
        if (c === 10) s += "\n";
        else if (c === 13) { /* CR */ }
        else if (c < 32) s += ".";
        else s += String.fromCharCode(c);
    }
    return s;
}
function parentOf(p) {
    if (!p || p === "/") return "/";
    var i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.substring(0, i);
}

// ---- headless --------------------------------------------------------------
if (!HAS_DISP) {
    if (!HAS_USB) {
        System.print("USB Storage: sem USB Host neste firmware/placa");
        while (true) System.delay(5000);
    }
    var lastAddr = 0;
    while (true) {
        var d0 = findMsc();
        if (d0 && d0.addr !== lastAddr) {
            lastAddr = d0.addr;
            var v0 = montar(d0, 8);
            if (!v0) {
                System.print("USB Storage: nao consegui montar (FAT32/exFAT?)");
            } else {
                var in0 = v0.info();
                System.print("USB Storage: " + in0.type + " rotulo '" + in0.label + "' " +
                             fmtSize(in0.totalBytes) + " (" + in0.clusterCount + " clusters)");
                var l0 = v0.list("/");
                for (var q = 0; q < l0.length && q < 32; q++) {
                    System.print("  " + (l0[q].dir ? "[dir] " : "") + l0[q].name +
                                 (l0[q].dir ? "" : "  " + fmtSize(l0[q].size)));
                }
                v0.close();
            }
        } else if (!d0 && lastAddr) {
            lastAddr = 0;
            System.print("USB Storage: pendrive removido");
        }
        while (USB.poll && USB.poll()) { /* drena */ }
        System.delay(2000);
    }
}

// ---- estado ----------------------------------------------------------------
var vol = null;
var volAddr = 0;
var tentou = 0;          // addr que ja falhou o mount (nao repete sozinho)
var msg = "";
var path = "/";
var preview = null;      // {name, text, more}
var listPath = "", listRev = -1, rows = [];

function solta() {
    if (vol) { try { vol.close(); } catch (e) {} }
    vol = null;
    volAddr = 0;
    tentou = 0;
    path = "/";
    preview = null;
    rows = [];
    listRev = -1;
}
// chama o mount quando um device novo aparece; force refaz o que falhou
function garante(force) {
    var d = findMsc();
    if (!d) {
        if (vol) solta();
        tentou = 0;
        msg = "";
        return false;
    }
    if (vol && volAddr === d.addr) return true;
    if (!force && tentou === d.addr) return false;
    if (vol) { try { vol.close(); } catch (e) {} vol = null; }
    tentou = d.addr;
    A.busy("Montando o pendrive...");
    vol = montar(d, 3);
    volAddr = vol ? d.addr : 0;
    path = "/";
    preview = null;
    msg = vol ? "" : "não montou (FAT32/exFAT?)";
    UI.invalidate();
    return !!vol;
}

// ---- telas -----------------------------------------------------------------
function telaLista(c) {
    if (HAS_USB && USB.poll) while (USB.poll()) UI.invalidate();
    garante(false);
    var sub = vol ? (path === "/" ? "raiz" : path.substring(path.lastIndexOf("/") + 1)) : "pendrive";
    if (A.header("Pendrive", { sub: sub })) {
        if (path !== "/") { path = parentOf(path); rows = []; listRev = -1; UI.resetScroll("st-list"); }
        else return A.BACK;
    }

    if (!HAS_USB) {
        UI.card(LX, 50, LW, 118, CB);
        UI.text("Sem USB Host", LX + 12, 60, { role: "title", color: T.warn, w: LW - 24, lines: 1 });
        UI.text("Sem USB Host (API 48). O pendrive MSC roda no devkit-S3 com a permissão usb.",
                LX + 12, 86, { role: "caption", color: T.textDim, w: LW - 24, lines: 4, id: "s-nohost" });
        UI.cardEnd();
        return;
    }

    if (!vol) {
        UI.card(LX, 50, LW, 104, CB);
        UI.text("Nenhum pendrive", LX + 12, 60, { role: "body", color: T.text, w: LW - 24, lines: 1 });
        UI.text("Conecte um pendrive FAT32 ou exFAT no USB-C host.",
                LX + 12, 84, { role: "caption", color: T.textDim, w: LW - 24, lines: 3, id: "s-empty" });
        if (msg) UI.text(msg, LX + 12, 122, { role: "caption", color: T.warn, w: LW - 24, lines: 2, id: "s-msg" });
        UI.cardEnd();
        if (findMsc() && UI.button("Tentar de novo", LX, 168, LW, 38)) garante(true);
        return;
    }

    var info = vol.info();
    UI.card(LX, 44, LW, 58, CB);
    UI.text(String(info.type || "").toUpperCase() + " · " + (info.label || "sem rótulo"),
            LX + 10, 50, { role: "body", color: T.text, w: LW - 20, lines: 1, id: "s-vol" });
    UI.text(fmtSize(info.totalBytes), LX + 10, 68,
            { role: "caption", color: T.textDim, w: LW - 20, lines: 1, id: "s-cap" });
    UI.text(path, LX + 10, 84,
            { role: "caption", color: T.accent, w: LW - 20, lines: 1, id: "s-path" });
    UI.cardEnd();

    if (listRev !== path.length || listPath !== path) {
        listRev = path.length;
        listPath = path;
        var raw = [];
        try { raw = vol.list(path) || []; } catch (e) { raw = []; }
        // diretorios primeiro, depois nome (chave pre-computada: o sort do
        // Duktape e preventyield e nao renova a janela do exec-timeout)
        for (var i = 0; i < raw.length; i++) {
            raw[i].key = (raw[i].dir ? "0:" : "1:") + String(raw[i].name).toLowerCase();
        }
        for (var a = 1; a < raw.length; a++) {
            var it = raw[a], b = a - 1;
            while (b >= 0 && raw[b].key > it.key) { raw[b + 1] = raw[b]; b--; }
            raw[b + 1] = it;
        }
        rows = [];
        for (var k = 0; k < raw.length; k++) {
            var f = raw[k];
            rows.push({
                label: (f.dir ? "[dir] " : "") + f.name,
                sub: f.dir ? "pasta" : fmtSize(f.size),
                item: f
            });
        }
        UI.resetScroll("st-list");
    }

    var sel = UI.list("st-list", LX, 108, LW, BOT - 158, rows, { rowH: 40 });
    if (sel >= 0) {
        var f2 = rows[sel].item;
        if (f2.dir) {
            path = path === "/" ? "/" + f2.name : path + "/" + f2.name;
            rows = [];
            listRev = -1;
            UI.invalidate();
        } else {
            var full = path === "/" ? "/" + f2.name : path + "/" + f2.name;
            A.busy("Abrindo " + f2.name + "...");
            var bts = null;
            try { bts = vol.read(full, 2048); } catch (e) { bts = null; }
            preview = { name: f2.name, text: bts ? textOf(bts, 2048) : "(falha na leitura)" };
            UI.invalidate();
            return "prev";
        }
    }
    var bw = Math.floor((LW - 8) / 2);
    if (UI.button("Ejetar", LX, BOT - 42, bw, 34, { style: "ghost" })) {
        var ea = volAddr;
        solta();
        tentou = ea;
        UI.invalidate();
    }
    if (UI.button("Raiz", LX + bw + 8, BOT - 42, bw, 34, { style: "ghost" })) {
        path = "/";
        rows = [];
        listRev = -1;
        UI.resetScroll("st-list");
        UI.invalidate();
    }
}
telaLista.fps = 15;

function telaPreview(c) {
    if (!preview) return A.BACK;
    if (A.header("Arquivo", { sub: preview.name })) { preview = null; UI.resetScroll("st-prev"); return; }
    UI.card(LX, 44, LW, BOT - 52, CB);
    var maxW = LW - 20;
    var body = preview.text;
    var contentH = 0;
    try { contentH = UI.measureWrap(body, maxW, "caption"); } catch (e) { contentH = 400; }
    var h = BOT - 52 - 12;
    var off = UI.scrollBegin("st-prev", LX + 10, 50, maxW, h, Math.max(h, contentH + 8));
    UI.text(body, LX + 10, 50 - off, { role: "caption", color: T.text, w: maxW, lines: 64 });
    UI.scrollEnd();
    UI.cardEnd();
}
telaPreview.fps = 15;

A.run({ lista: telaLista, prev: telaPreview }, "lista", { fps: 15 });
