// USB Devices 2.0 — inspetor do USB Host (API 48) no CelerKit UI 2.0.
// Lista ao vivo (hotplug) com VID/PID, classe, endereco e interfaces; toque
// abre um sheet com o resumo e "Interfaces" leva ao detalhe com cada
// interface (classe/subclasse/protocolo) e seus endpoints (direcao, tipo,
// mps). "Copiar p/ log" despeja o dump completo no logcat.
//
// Sem USB Host (qualquer placa que nao o devkit-S3, ou sem a permissao
// "usb") o objeto USB nem existe: o app explica em vez de estourar. Em
// placa headless (devkit-S3) imprime a lista no logcat.

var A = require("celeros.app");
require("celeros.app.style");

A.init();
var HAS_DISP = true;
try { HAS_DISP = System.getInfo().hasDisplay !== false; } catch (e) {}
if (HAS_DISP) A.style.preset("soft");
var T = A.style.T;

var HAS_USB = typeof USB !== "undefined";
var LX = A.L.x, LW = A.L.w, CX = A.L.cx, BOT = A.L.bottom;

function hex4(v) {
    var s = (v | 0).toString(16).toUpperCase();
    while (s.length < 4) s = "0" + s;
    return s;
}
function hex2(v) {
    var s = (v | 0).toString(16).toUpperCase();
    return s.length < 2 ? "0" + s : s;
}
function clsName(c) {
    if (c === 0) return "composta";
    if (c === 1) return "áudio";
    if (c === 2) return "comunicação";
    if (c === 3) return "HID";
    if (c === 7) return "impressora";
    if (c === 8) return "armazenamento";
    if (c === 9) return "hub";
    if (c === 10) return "CDC";
    if (c === 14) return "vídeo";
    if (c === 224) return "wireless";
    return "classe " + c;
}
// device composto (cls 0) herda a classe da primeira interface, que e onde
// a maioria dos aparelhos declara o que e (impressora, pendrive, HID...)
function devCls(d) {
    if (d.cls) return clsName(d.cls);
    return d.ifs && d.ifs.length ? clsName(d.ifs[0].cls) : clsName(0);
}
function epType(t) {
    return t === 2 ? "bulk" : t === 3 ? "int" : t === 1 ? "iso" : "ctl";
}
function epName(e) {
    return (e.addr & 0x80 ? "IN " : "OUT ") + "0x" + hex2(e.addr) + " " + epType(e.type);
}
function velName(s) {
    return s === 3 ? "480 Mbps" : s === 2 ? "12 Mbps" : s === 1 ? "1.5 Mbps" : "-";
}

// glifos locais (o app nao adota celeros.app.icons para caber no orcamento)
function glyph(k, x, y, s, c) {
    var cx = x + s / 2, cy = y + s / 2;
    if (k === "dot") { System.fillCircle(cx, cy, 3, c); return; }
    if (k === "info") {
        System.drawCircle(cx, cy, Math.round(s * .4), c);
        System.fillCircle(cx, cy - 3, 1, c);
        System.drawLine(cx, cy, cx, cy + 4, c);
        return;
    }
    System.drawTriangle(cx, y, x, y + s, x + s, y + s, c);
    System.drawLine(cx, cy - 1, cx, cy + 3, c);
    System.fillCircle(cx, cy + 5, 1, c);
}

// ---- headless: imprime no logcat a cada mudanca ---------------------------
if (!HAS_DISP) {
    if (!HAS_USB) {
        System.print("USB Devices: sem USB Host neste firmware/placa");
        while (true) System.delay(5000);
    }
    var visto = "";
    while (true) {
        var ds = USB.devices ? USB.devices() : [];
        var sig = "", i, k;
        for (i = 0; i < ds.length; i++) sig += ds[i].addr + ":" + ds[i].vid + ":" + ds[i].pid + ";";
        if (sig !== visto) {
            visto = sig;
            System.print("USB Devices: " + ds.length + " device(s)");
            for (i = 0; i < ds.length; i++) {
                var d = ds[i];
                System.print("  " + hex4(d.vid) + ":" + hex4(d.pid) + " " + devCls(d) +
                             " addr " + d.addr + (d.claimed.length ? " [em uso]" : ""));
                for (k = 0; k < d.ifs.length; k++) {
                    var f = d.ifs[k], ln = "    if" + f.n + "." + f.alt + " " +
                                            f.cls + "/" + f.subcls + "/" + f.proto;
                    for (var e = 0; e < f.eps.length; e++) ln += "  " + epName(f.eps[e]) +
                                                               " " + f.eps[e].mps;
                    System.print(ln);
                }
            }
        }
        while (USB.poll && USB.poll()) { /* drena */ }
        System.delay(1000);
    }
}

// ---- estado ----------------------------------------------------------------
var devs = [];
var rev = 0;              // muda quando a lista de devices muda
var selAddr = 0;          // device aberto no detalhe
var shAddr = 0;           // device aberto no sheet (0 = fechado)
var hot = 0;              // eventos de hotplug vistos
var rowsRev = -1, rowsCache = [];
var detRev = -1, detCache = [];
var parKey = "", parCache = [];

function refresh() {
    if (!HAS_USB) { devs = []; return; }
    var mudou = false;
    if (USB.poll) while (USB.poll()) { hot++; mudou = true; }
    if (mudou) UI.invalidate();
    if (mudou || A.every(300, "usb")) {
        try { devs = USB.devices ? (USB.devices() || []) : []; } catch (e) { devs = []; }
        rev++;
    }
}
function byAddr(a) {
    for (var i = 0; i < devs.length; i++) if (devs[i].addr === a) return devs[i];
    return null;
}
function dump(d) {
    var i, e;
    System.print("USB " + hex4(d.vid) + ":" + hex4(d.pid) + " " + devCls(d) +
                 " addr " + d.addr + " " + velName(d.speed) +
                 (d.claimed.length ? " [ifs " + d.claimed.join(",") + " em uso]" : ""));
    for (i = 0; i < d.ifs.length; i++) {
        var f = d.ifs[i];
        System.print("  if" + f.n + "." + f.alt + " " + clsName(f.cls) + " " +
                     f.cls + "/" + f.subcls + "/" + f.proto);
        for (e = 0; e < f.eps.length; e++) {
            System.print("    ep 0x" + hex2(f.eps[e].addr) + " " + epType(f.eps[e].type) +
                         " mps " + f.eps[e].mps);
        }
    }
}

// ---- sheet local (o app nao adota widgets para caber no orcamento) --------
function sheet(full, titulo, draw) {
    var h = 196, y = 320 - h;
    if (full) {
        var veu = T.bg;
        try { if (System.mixColor) veu = System.mixColor(T.bg, 0x0000, 55); } catch (e) {}
        System.fillRect(0, 0, 240, 320, veu);
    }
    A.style.card(0, y, 240, h, { full: full, r: T.radius, pad: 12, draw: function (c) {
        System.fillRoundRect(108, y + 6, 24, 3, 2, T.stroke);
        UI.text(titulo, c.x, c.y, { role: "title", w: c.w, lines: 1 });
        draw({ x: c.x, y: c.y + 24, w: c.w, h: c.h - 24 });
    }});
    if (full) {
        var t = UI.touch();
        if (t.tap && t.y < y) { shAddr = 0; UI.invalidate(); }
    }
}

// ---- telas -----------------------------------------------------------------
function telaLista(c) {
    refresh();

    // sheet aberto: a base nao e repintada (as primitivas cruas passariam
    // por cima do cartao nos frames parciais e o UI.list consumiria o toque)
    if (shAddr) {
        var dv = byAddr(shAddr);
        if (!dv) { shAddr = 0; return; }
        var irDet = false;
        var nEp = 0, i;
        for (i = 0; i < dv.ifs.length; i++) nEp += dv.ifs[i].eps.length;
        var pk = shAddr + ":" + rev;
        if (parKey !== pk) {
            parKey = pk;
            parCache = [
                ["VID", hex4(dv.vid)], ["PID", hex4(dv.pid)],
                ["Classe", devCls(dv) + (dv.claimed.length ? " (em uso)" : "")],
                ["Endereço", "addr " + dv.addr],
                ["Interfaces", dv.ifs.length + " · " + nEp + " ep"]
            ];
            for (var z = 0; z < dv.ifs.length && z < 3; z++) {
                var fz = dv.ifs[z];
                parCache.push(["if" + fz.n, clsName(fz.cls) + " · " + fz.eps.length + " ep"]);
            }
        }
        sheet(c.full, "Dispositivo", function (q) {
            var y = q.y;
            for (var n = 0; n < parCache.length; n++) {
                UI.text(parCache[n][0], q.x, y, { role: "caption", color: T.textDim, w: 76, lines: 1, id: "u-l" + n });
                UI.text(parCache[n][1], q.x + q.w, y,
                        { role: "caption", align: "right", color: T.text, w: 128, lines: 1, id: "u-v" + n });
                y += 16;
            }
            var bw = Math.floor((q.w - 8) / 2);
            if (A.style.button("Interfaces", q.x, y + 4, bw, 36)) {
                selAddr = dv.addr;
                shAddr = 0;
                UI.invalidate();
                irDet = true;
            }
            if (A.style.button("Fechar", q.x + bw + 8, y + 4, bw, 36, { variant: "ghost" })) {
                shAddr = 0;
                UI.invalidate();
            }
        });
        if (irDet) return "det";
        return;
    }

    var h = A.header("USB", { sub: !HAS_USB ? "sem host" :
        (devs.length ? devs.length + (devs.length === 1 ? " dispositivo" : " dispositivos") : "nenhum") });
    if (h) return A.BACK;

    if (!HAS_USB) {
        A.style.card(LX, 50, LW, 142, { full: c.full, draw: function (q) {
            glyph("alert", q.x, q.y + 2, 20, T.warn);
            UI.text("Sem USB Host", q.x + 28, q.y, { role: "title", w: q.w - 28, lines: 1 });
            UI.text("Esta placa/firmware não tem USB Host (API 48). O inspetor roda no devkit-S3, com a permissão \"usb\" concedida no launcher.",
                    q.x, q.y + 28, { role: "caption", color: T.textDim, w: q.w, lines: 4, id: "u-nohost" });
        }});
        UI.text("Classes de um driver em JS: HID, impressora (ESC/POS), armazenamento (MSC) e hubs.",
                CX, 216, { role: "caption", align: "center", color: T.textDim, w: LW, lines: 3, id: "u-hint" });
        return;
    }

    A.style.card(LX, 46, LW, 34, { full: c.full, pad: 8, draw: function (q) {
        glyph("dot", q.x, q.y + 4, 12, T.ok);
        UI.text("Host ativo", q.x + 16, q.y, { role: "caption", color: T.ok, w: 90, lines: 1, id: "u-host" });
        UI.text(hot ? hot + " evento(s)" : "hotplug ao vivo", q.x + q.w, q.y,
                { role: "caption", align: "right", color: T.textDim, w: 96, lines: 1, id: "u-hot" });
    }});

    if (!devs.length) {
        A.style.card(LX, 88, LW, 104, { full: c.full, draw: function (q) {
            glyph("info", q.x, q.y + 2, 18, T.accent);
            UI.text("Nenhum dispositivo", q.x + 26, q.y, { role: "body", w: q.w - 26, lines: 1 });
            UI.text("Conecte no USB-C host (um hub aceita vários). A lista acorda sozinha no plug.",
                    q.x, q.y + 26, { role: "caption", color: T.textDim, w: q.w, lines: 3, id: "u-empty" });
        }});
        return;
    }

    if (rowsRev !== rev) {
        rowsRev = rev;
        rowsCache = [];
        for (var k = 0; k < devs.length; k++) {
            var d2 = devs[k], ne2 = 0, j;
            for (j = 0; j < d2.ifs.length; j++) ne2 += d2.ifs[j].eps.length;
            rowsCache.push({
                label: hex4(d2.vid) + ":" + hex4(d2.pid) + "  " + devCls(d2),
                sub: "addr " + d2.addr + " · " + d2.ifs.length + " interface(s) · " + ne2 + " ep(s)",
                right: d2.claimed.length ? "em uso" : "",
                rightColor: d2.claimed.length ? T.warn : T.textDim
            });
        }
    }
    var sel = UI.list("u-list", LX, 86, LW, BOT - 104, rowsCache, { rowH: 52 });
    if (sel >= 0) {
        shAddr = devs[sel].addr;
        UI.invalidate();
    }
}

function telaDetalhe(c) {
    refresh();
    var d = byAddr(selAddr);
    if (!d) { A.toast("dispositivo desconectado"); return A.BACK; }
    var h = A.header("Dispositivo", { sub: "addr " + d.addr });
    if (h) return A.BACK;

    A.style.card(LX, 44, LW, 76, { full: c.full, draw: function (q) {
        UI.text(hex4(d.vid) + ":" + hex4(d.pid), q.x, q.y, { role: "title", w: q.w, lines: 1, id: "d-id" });
        UI.text(devCls(d) + " · " + velName(d.speed), q.x, q.y + 24,
                { role: "caption", color: T.textDim, w: q.w, lines: 1, id: "d-cls" });
        UI.text((d.claimed.length ? "em uso: if " + d.claimed.join(",") : "livre") +
                " · " + d.ifs.length + " interface(s)", q.x, q.y + 44,
                { role: "caption", color: d.claimed.length ? T.warn : T.textDim, w: q.w, lines: 1, id: "d-use" });
    }});

    if (detRev !== rev * 1000 + selAddr) {
        detRev = rev * 1000 + selAddr;
        detCache = [];
        for (var i = 0; i < d.ifs.length; i++) {
            var f = d.ifs[i];
            detCache.push({
                label: "Interface " + f.n + (f.alt ? "." + f.alt : ""),
                sub: clsName(f.cls) + " · " + f.cls + "/" + f.subcls + "/" + f.proto,
                right: f.eps.length + " ep"
            });
            for (var e = 0; e < f.eps.length; e++) {
                var ep = f.eps[e];
                detCache.push({
                    label: "  " + epName(ep),
                    sub: (ep.addr & 0x80 ? "device -> host" : "host -> device") + " · if " + f.n,
                    right: "mps " + ep.mps
                });
            }
        }
        if (!detCache.length) detCache.push({ label: "Sem interfaces", sub: "device sem descritores" });
    }
    UI.list("d-list", LX, 126, LW, 138, detCache, { rowH: 44 });

    if (A.style.button("Copiar p/ log", LX, 272, LW, 38, { variant: "ghost" })) {
        dump(d);
        A.toast("dump enviado ao log");
    }
}
telaDetalhe.fps = 20;

A.run({ lista: telaLista, det: telaDetalhe }, "lista", { fps: 15 });
