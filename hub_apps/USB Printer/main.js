// USB Printer 2.0 — impressora termica USB (ESC/POS) como driver de
// referencia em JS (API 48). Acha a interface classe 7, toma o claim, monta
// o cupom (init, titulo 2x, texto, QR opcional, feed e corte) e envia pelo
// bulk OUT do USB Host. O firmware nao sabe o que e uma impressora: so
// entrega endpoints e transfers.
//
// Trocar de modelo = trocar a sequencia de bytes aqui (ou escrever um driver
// proprio). O cupom de teste e o mesmo da 1.0 (VID/PID, interfaces, aviso de
// que o driver roda em JS); o titulo e editavel e o QR pode ser desligado.
// Status por DLE EOT (online/papel) quando a impressora tem bulk IN.
//
// Sem USB Host o app explica; sem impressora mostra o estado vazio e espera
// o hotplug. Em placa headless imprime o cupom ao conectar.

var A = require("celeros.app");
require("celeros.app.style");

A.init();
var HAS_DISP = true;
try { HAS_DISP = System.getInfo().hasDisplay !== false; } catch (e) {}
if (HAS_DISP) A.style.preset("soft");
var T = A.style.T;

var HAS_USB = typeof USB !== "undefined";
var LX = A.L.x, LW = A.L.w, CX = A.L.cx, BOT = A.L.bottom;
var ESC = 0x1B, GS = 0x1D;

// ---- ESC/POS (o mesmo conjunto do celeros.usb.escpos, inline) --------------
function bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF);
    return out;
}
function cat(a, b) {
    var out = a.slice();
    for (var i = 0; i < b.length; i++) out.push(b[i]);
    return out;
}
function qr(data, size) {
    var d = bytes(String(data));
    var len = d.length + 3, pL = len & 0xFF, pH = (len >> 8) & 0xFF;
    var out = [GS, 0x28, 0x6B, 4, 0, 0x31, 0x41, 0x32, 0];
    var s = size || 6;
    if (s < 1) s = 1;
    if (s > 16) s = 16;
    out = cat(out, [GS, 0x28, 0x6B, 3, 0, 0x31, 0x43, s]);
    out = cat(out, [GS, 0x28, 0x6B, 3, 0, 0x31, 0x45, 49]);
    out = cat(out, [GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30]);
    out = cat(out, d);
    out = cat(out, [GS, 0x28, 0x6B, 3, 0, 0x31, 0x51, 0x30]);
    return out;
}

// ---- USB cru (claim + bulk) ------------------------------------------------
function achaImpressora() {
    if (!HAS_USB || !USB.devices) return null;
    var ds = [];
    try { ds = USB.devices() || []; } catch (e) { ds = []; }
    for (var i = 0; i < ds.length; i++) {
        var d = ds[i];
        for (var k = 0; k < d.ifs.length; k++) {
            if (d.ifs[k].cls === 7) return { dev: d, iface: d.ifs[k] };
        }
    }
    return null;
}
function epBulk(iface, dirIn) {
    for (var i = 0; i < iface.eps.length; i++) {
        var e = iface.eps[i];
        if (e.type === 2 && ((e.addr & 0x80) !== 0) === dirIn) return e.addr;
    }
    return -1;
}
function abre(dev, iface) {
    var ok = false;
    try { ok = USB.claim(dev.addr, iface.n, iface.alt); } catch (e) { ok = false; }
    if (!ok) return null;
    var h = { addr: dev.addr, iface: iface, epOut: epBulk(iface, false), epIn: epBulk(iface, true) };
    if (h.epOut < 0) { USB.release(dev.addr, iface.n); return null; }
    return h;
}
function fecha(h) {
    if (!h) return;
    try { USB.release(h.addr, h.iface.n); } catch (e) {}
}
function escreve(h, b) {
    var r = null;
    try { r = USB.out(h.addr, h.epOut, b, 2000); } catch (e) { r = null; }
    return !!(r && r.ok);
}
function le(h, n) {
    var r = null;
    try { r = USB.in(h.addr, h.epIn, n, 1000); } catch (e) { r = null; }
    return r && r.ok ? r.data : null;
}

// ---- cupom ----------------------------------------------------------------
function cupom(h, titulo, qrOn, dev) {
    var b = [];
    var l = ["Teste de impressao USB",
             "VID:PID " + hex4(dev.vid) + ":" + hex4(dev.pid),
             "Interface " + dev.ifs.length + " - ESC/POS",
             "",
             "O driver roda em JavaScript.",
             "O firmware so entrega os bytes."];
    b = cat(b, [ESC, 0x40]);                      // init
    b = cat(b, [ESC, 0x61, 1]);                   // centro
    b = cat(b, [GS, 0x21, 0x11]);                 // 2x2
    b = cat(b, [ESC, 0x45, 1]);                   // negrito
    b = cat(b, cat(bytes(titulo || "CELER OS"), [0x0A]));
    b = cat(b, [GS, 0x21, 0x00]);
    b = cat(b, [ESC, 0x45, 0]);
    b = cat(b, [ESC, 0x61, 0]);
    for (var i = 0; i < l.length; i++) b = cat(b, cat(bytes(l[i]), [0x0A]));
    b = cat(b, [ESC, 0x64, 1]);                   // feed
    if (qrOn) {
        b = cat(b, [ESC, 0x61, 1]);
        b = cat(b, qr("https://os.celer.tec.br", 5));
        b = cat(b, [ESC, 0x61, 0]);
    }
    b = cat(b, [ESC, 0x64, 4]);                   // feed
    b = cat(b, [GS, 0x56, 0]);                    // cut
    return escreve(h, b);
}
function hex4(v) {
    var s = (v | 0).toString(16).toUpperCase();
    while (s.length < 4) s = "0" + s;
    return s;
}

// ---- status (DLE EOT) ------------------------------------------------------
function status(h) {
    if (h.epIn < 0) return null;
    function ask(q) {
        for (var t = 0; t < 3; t++) {
            if (!escreve(h, [0x10, 0x04, q])) return -1;
            var d = le(h, 1);
            if (d && d.length > 0) return d[0];
        }
        return -1;
    }
    var s1 = ask(1);
    if (s1 < 0) return null;
    var s2 = ask(2);
    return {
        online: (s1 & 0x08) === 0,
        erro: (s1 & 0x40) !== 0,
        papel: s2 >= 0 && (s2 & 0x60) !== 0,
        acabando: s2 >= 0 && (s2 & 0x0C) !== 0
    };
}

// ---- estado ----------------------------------------------------------------
var acha = null;          // {dev, iface} do hotplug
var ultimo = "";          // "ultimo envio"
var stTxt = "";           // status da ultima consulta
var stCor = 0;
var qrOn = true;
var titulo = "CELER OS";
(function cfg() {
    try {
        if (Storage.get("qr") === "0") qrOn = false;
        var t = Storage.get("titulo");
        if (t) titulo = t;
    } catch (e) {}
})();
function salvaCfg() {
    try { Storage.set("qr", qrOn ? "1" : "0"); Storage.set("titulo", titulo); } catch (e) {}
}

// ---- headless: imprime o cupom ao conectar ---------------------------------
if (!HAS_DISP) {
    if (!HAS_USB) {
        System.print("USB Printer: sem USB Host neste firmware/placa");
        while (true) System.delay(5000);
    }
    var lastAddr = 0;
    while (true) {
        var p = achaImpressora();
        if (p && p.dev.addr !== lastAddr) {
            lastAddr = p.dev.addr;
            var hh = abre(p.dev, p.iface);
            System.print(hh && cupom(hh, titulo, qrOn, p.dev)
                         ? "USB Printer: cupom enviado" : "USB Printer: falha ao imprimir");
            fecha(hh);
        } else if (!p && lastAddr) {
            lastAddr = 0;
            System.print("USB Printer: impressora desconectada");
        }
        while (USB.poll && USB.poll()) { /* drena */ }
        System.delay(2000);
    }
}

// ---- UI --------------------------------------------------------------------
function glyph(k, x, y, s, c) {
    var cx = x + s / 2, cy = y + s / 2;
    if (k === "dot") { System.fillCircle(cx, cy, 3, c); return; }
    System.drawTriangle(cx, y, x, y + s, x + s, y + s, c);
    System.drawLine(cx, cy - 1, cx, cy + 3, c);
    System.fillCircle(cx, cy + 5, 1, c);
}

function imprime(p) {
    A.busy("Enviando o cupom...");
    var h = abre(p.dev, p.iface);
    if (!h) { A.toast("impressora em uso por outro app/serviço"); UI.invalidate(); return; }
    var ok = cupom(h, titulo, qrOn, p.dev);
    fecha(h);
    ultimo = (ok ? "enviado " : "falhou ") + System.getTime();
    A.toast(ok ? "cupom enviado" : "falha ao enviar");
    UI.invalidate();
}

function consulta(p) {
    A.busy("Consultando o status...");
    var h = abre(p.dev, p.iface);
    if (!h) { A.toast("impressora em uso"); UI.invalidate(); return; }
    var st = status(h);
    fecha(h);
    if (!st) {
        stTxt = "sem resposta de status (bulk IN?)";
        stCor = T.warn;
    } else if (st.erro) {
        stTxt = "erro na impressora";
        stCor = T.err;
    } else if (st.papel) {
        stTxt = "papel acabou";
        stCor = T.err;
    } else if (!st.online) {
        stTxt = "off-line";
        stCor = T.warn;
    } else {
        stTxt = "online" + (st.acabando ? " · papel acabando" : "");
        stCor = T.ok;
    }
    A.toast(stTxt);
    UI.invalidate();
}

function tela(c) {
    var p = achaImpressora();
    if (USB.poll) while (USB.poll()) UI.invalidate();
    var h = A.header("Impressora USB", { sub: HAS_USB ? (p ? "conectada" : "procurando") : "sem host" });
    if (h) return A.BACK;

    if (!HAS_USB) {
        A.style.card(LX, 50, LW, 130, { full: c.full, draw: function (q) {
            glyph("alert", q.x, q.y + 2, 20, T.warn);
            UI.text("Sem USB Host", q.x + 28, q.y, { role: "title", w: q.w - 28, lines: 1 });
            UI.text("Esta placa/firmware não tem USB Host (API 48). O driver ESC/POS roda no devkit-S3, com a permissão \"usb\".",
                    q.x, q.y + 28, { role: "caption", color: T.textDim, w: q.w, lines: 4, id: "p-nohost" });
        }});
        return;
    }

    if (!p) {
        A.style.card(LX, 50, LW, 116, { full: c.full, draw: function (q) {
            glyph("alert", q.x, q.y + 2, 18, T.accent);
            UI.text("Nenhuma impressora", q.x + 26, q.y, { role: "body", w: q.w - 26, lines: 1 });
            UI.text("Conecte uma ESC/POS (interface classe 7) no USB-C host. A tela acorda sozinha no plug.",
                    q.x, q.y + 26, { role: "caption", color: T.textDim, w: q.w, lines: 3, id: "p-empty" });
        }});
        UI.text("O cupom de teste usa só texto e QR: troque a sequência no código para o seu modelo.",
                CX, 190, { role: "caption", align: "center", color: T.textDim, w: LW, lines: 3, id: "p-hint" });
        return;
    }

    // identidade + status
    A.style.card(LX, 44, LW, 92, { full: c.full, draw: function (q) {
        UI.text("Impressora", q.x, q.y, { role: "body", w: q.w - 88, lines: 1, id: "p-found" });
        UI.text((stTxt || "sem status"), q.x + q.w, q.y,
                { role: "caption", align: "right", color: stTxt ? stCor : T.textDim,
                  w: 88, lines: 1, id: "p-status" });
        UI.text("VID " + hex4(p.dev.vid) + " · PID " + hex4(p.dev.pid), q.x, q.y + 22,
                { role: "caption", color: T.textDim, w: q.w, lines: 1, id: "p-id" });
        var eo = epBulk(p.iface, false), ei = epBulk(p.iface, true);
        UI.text("if " + p.iface.n + " · OUT " + (eo < 0 ? "-" : "0x" + hex4(eo).slice(2)) +
                " / IN " + (ei < 0 ? "-" : "0x" + hex4(ei).slice(2)),
                q.x, q.y + 40, { role: "caption", color: T.textDim, w: q.w, lines: 1, id: "p-eps" });
        UI.text(ultimo ? "último envio: " + ultimo : "driver ESC/POS em JS",
                q.x, q.y + 60, { role: "caption", color: T.textDim, w: q.w, lines: 1, id: "p-last" });
    }});

    // cupom: titulo e QR
    A.style.card(LX, 142, LW, 80, { full: c.full, draw: function (q) {
        UI.text("Cupom", q.x, q.y, { role: "caption", color: T.textDim, w: q.w - 70, lines: 1 });
        var nq = UI.toggle(q.x + q.w - 44, q.y - 4, qrOn);
        if (nq !== qrOn) { qrOn = nq; salvaCfg(); UI.invalidate(); }
        UI.text("QR: " + (qrOn ? "sim" : "não"), q.x + q.w - 50, q.y,
                { role: "caption", align: "right", color: qrOn ? T.ok : T.textDim, w: 44, lines: 1, id: "p-qr" });
        UI.text("Título: " + titulo, q.x, q.y + 24, { role: "body", w: q.w, lines: 1, id: "p-title" });
        if (A.style.button("Editar título", q.x, q.y + 42, q.w, 28, { variant: "ghost" })) {
            var t = null;
            try { t = System.prompt("Título do cupom", titulo, { nullOnCancel: true }); } catch (e) { t = null; }
            if (t) { titulo = String(t).substring(0, 28); salvaCfg(); UI.invalidate(); }
        }
    }});

    if (A.style.button("Imprimir cupom de teste", LX, 230, LW, 44)) imprime(p);
    if (A.style.button("Consultar status", LX, 280, LW, 30, { variant: "ghost" })) consulta(p);
}
tela.fps = 15;

A.run({ main: tela }, "main", { fps: 15 });
