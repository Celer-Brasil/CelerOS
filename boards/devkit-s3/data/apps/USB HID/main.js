// USB HID — painel do driver de teclado/mouse USB (o trabalho vive no
// service.js, que roda no svchost e injeta Input.key/Input.move).
//
// Placa COM vidro: painel CelerKit UI 2.0 com o estado do servico
// (iniciar/parar grava a chave usbhid.on que o service le), a lista dos
// dispositivos USB, as teclas/eixos do ultimo report e um teste do hardware
// (com o servico parado o painel reclama a interface HID e le os reports
// crus; nada passa pelo Input do OS nesse modo).
// Placa headless (devkit-s3): a saida e o logcat — o mesmo estado e a mesma
// lista, sem desenhar nada.
//
// O driver (HID boot, diff de reports, hotplug) NAO mora aqui: service.js
// segue com o claim/listen/read e as injecoes Input.* intactas.

var S = System;
var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.list");
A.init();

var T = A.style.T;
var INFO = {};
try { INFO = System.getInfo() || {}; } catch (e) { INFO = {}; }
var HAS_UI = INFO.hasDisplay === true && INFO.shape !== "headless";
var LX = A.L.x, LW = A.L.w;
var ON_KEY = "usbhid.on";

function hex4(v) {
  var s = (v | 0).toString(16).toUpperCase();
  while (s.length < 4) s = "0" + s;
  return s;
}
function driverOn() {
  try { return Storage.get(ON_KEY, "1") !== "0"; } catch (e) { return true; }
}
function setDriver(on) {
  try { Storage.set(ON_KEY, on ? "1" : "0"); } catch (e) {}
}

// classe/subclasse/protocolo de uma interface HID boot
function ifaceOf(dev, proto) {
  for (var i = 0; i < dev.ifs.length; i++) {
    var f = dev.ifs[i];
    if (f.cls !== 3 || f.subcls !== 1 || f.proto !== proto) continue;
    for (var e = 0; e < f.eps.length; e++) {
      if (f.eps[e].type === 3 && (f.eps[e].addr & 0x80)) return f;
    }
  }
  return null;
}
function epIn(iface) {
  for (var e = 0; e < iface.eps.length; e++) {
    if (iface.eps[e].type === 3 && (iface.eps[e].addr & 0x80)) return iface.eps[e].addr;
  }
  return -1;
}
function kindOf(dev) {
  if (ifaceOf(dev, 1)) return "kbd";
  if (ifaceOf(dev, 2)) return "mouse";
  for (var i = 0; i < dev.ifs.length; i++) if (dev.ifs[i].cls === 3) return "hid";
  return "";
}
function kindLabel(k) {
  return k === "kbd" ? "Teclado HID" : k === "mouse" ? "Mouse HID"
       : k === "hid" ? "Dispositivo HID" : "Dispositivo USB";
}
// classe.subclasse.protocolo da interface HID (ou a do device)
function ifaceDesc(dev) {
  var f = ifaceOf(dev, 1) || ifaceOf(dev, 2);
  if (!f) for (var i = 0; i < dev.ifs.length; i++) if (dev.ifs[i].cls === 3) f = dev.ifs[i];
  return f ? "cls " + f.cls + "." + f.subcls + "." + f.proto : "classe " + dev.cls;
}
function s8(v) { v = v & 0xFF; return v > 127 ? v - 256 : v; }

// --- lista de dispositivos (cache por carimbo) ------------------------------
var devs = [];
function rescan() { devs = (typeof USB !== "undefined") ? USB.devices() : []; }
var lista = A.list.make(function () {
  var s = "";
  for (var i = 0; i < devs.length; i++) s += devs[i].addr + ":" + devs[i].vid + ":" + devs[i].pid + ";";
  return s;
}, function () {
  var out = [];
  for (var i = 0; i < devs.length; i++) {
    var d = devs[i], k = kindOf(d);
    out.push({ label: kindLabel(k), sub: "addr " + d.addr + " - " + ifaceDesc(d),
               icon: "info", right: hex4(d.vid) + ":" + hex4(d.pid),
               rightColor: k ? T.ok : T.textDim });
  }
  return out;
});

// --- monitor cru (so com o servico parado, para testar o hardware) ----------
var mon = null;       // {addr, iface, ep, kind, keys[], mods, dx, dy, btn, last, at}
var monErr = "";

function monClose() {
  if (!mon) return;
  try { USB.unlisten(mon.addr, mon.ep); } catch (e) {}
  try { USB.release(mon.addr, mon.iface); } catch (e) {}
  mon = null;
}
function monOpen() {
  if (mon || typeof USB === "undefined") return;
  var want = null, kind = "";
  for (var i = 0; i < devs.length; i++) {
    var k = ifaceOf(devs[i], 1) ? "kbd" : ifaceOf(devs[i], 2) ? "mouse" : "";
    if (k) { want = devs[i]; kind = k; break; }
  }
  if (!want) { monErr = ""; return; }
  var f = ifaceOf(want, kind === "kbd" ? 1 : 2);
  var ep = epIn(f);
  if (ep < 0) { monErr = "sem endpoint IN"; return; }
  if (!USB.claim(want.addr, f.n, f.alt)) { monErr = "interface ocupada (o servico ainda esta soltando)"; return; }
  if (!USB.listen(want.addr, ep, kind === "kbd" ? 8 : 4, 8)) {
    try { USB.release(want.addr, f.n); } catch (e) {}
    monErr = "listen recusado";
    return;
  }
  monErr = "";
  mon = { addr: want.addr, iface: f.n, ep: ep, kind: kind, keys: [], mods: 0,
          dx: 0, dy: 0, btn: 0, last: 0, at: 0 };
}
function monTick() {
  if (!mon) return;
  var r;
  while ((r = USB.read(mon.addr, mon.ep)) !== null) {
    mon.at = System.millis();
    if (mon.kind === "kbd") {
      mon.mods = r[0] || 0;
      var ks = [];
      for (var i = 2; i < 8 && i < r.length; i++) if (r[i]) ks.push(r[i]);
      for (var a = 0; a < ks.length; a++) {
        var novo = true;
        for (var b = 0; b < mon.keys.length; b++) if (mon.keys[b] === ks[a]) novo = false;
        if (novo) mon.last = ks[a];
      }
      mon.keys = ks;
    } else {
      mon.btn = r[0] || 0;
      mon.dx = s8(r[1] || 0);
      mon.dy = s8(r[2] || 0);
    }
  }
}

// eixos do mouse num quadradinho (area pintada)
function eixos(c) {
  A.style.custom("usbhid-eixos", LX + LW - 54, 233, 46, 46,
    mon ? mon.dx + ":" + mon.dy + ":" + mon.btn : "off",
    function (x, y, w, h) {
      var cx = x + w / 2, cy = y + h / 2;
      S.fillRoundRect(x, y, w, h, 8, T.raised);
      S.drawFastHLine(x + 4, cy, w - 8, T.stroke);
      S.drawFastVLine(cx, y + 4, h - 8, T.stroke);
      if (mon) {
        var tx = cx + Math.max(-24, Math.min(24, mon.dx * 3));
        var ty = cy + Math.max(-24, Math.min(24, mon.dy * 3));
        S.drawLine(cx, cy, tx, ty, T.accent);
        S.fillCircle(tx, ty, 3, T.accent);
      }
    }, { bg: T.bg });
}

// --- telas ------------------------------------------------------------------
function semUsb(c) {
  A.style.card(LX, 48, LW, 140, { full: c.full, draw: function (r) {
    UI.text("Sem USB Host", r.x, r.y, { role: "title", color: T.warn, w: r.w, lines: 1 });
    UI.text("Esta placa/firmware não expõe o", r.x, r.y + 28,
            { role: "caption", color: T.textDim, w: r.w, lines: 1 });
    UI.text("USB Host (API 48).", r.x, r.y + 42,
            { role: "caption", color: T.textDim, w: r.w, lines: 1 });
    UI.text("O driver segue disponível nas", r.x, r.y + 62,
            { role: "caption", color: T.text, w: r.w, lines: 1 });
    UI.text("placas com CELEROS_USB_HOST.", r.x, r.y + 76,
            { role: "caption", color: T.text, w: r.w, lines: 1 });
  }});
}

function painel(c) {
  var h = A.widgets.header("USB HID", { full: c.full,
    actions: [{ icon: "search", id: "scan" }] });
  if (h.back) { monClose(); return A.BACK; }
  if (h.action === "scan") { rescan(); UI.invalidate(); }
  if (A.every(1200, "usb")) {
    var n = devs.length;
    rescan();
    if (n !== devs.length) UI.invalidate();
  }

  if (typeof USB === "undefined" || !INFO.hasUsbHost) { semUsb(c); return; }

  var on = driverOn();

  // servico: estado + iniciar/parar
  A.style.card(LX, 48, LW, 76, { full: c.full, draw: function (r) {
    UI.text("serviço", r.x, r.y, { role: "caption", color: T.textDim,
                                    w: r.w, lines: 1, id: "svl" });
    S.fillCircle(r.x + 3, r.y + 20, 3, on ? T.ok : T.warn);
    UI.text(on ? "ativo" : "parado", r.x + 12, r.y + 14,
            { role: "title", color: on ? T.ok : T.warn, w: r.w - 96, lines: 1, id: "svs" });
    UI.text("no Input do OS", r.x, r.y + 34,
            { role: "caption", color: T.textDim, w: r.w - 84, lines: 1, id: "svc" });
    var bw = 78, bh = 30;
    if (A.style.button(on ? "Parar" : "Iniciar", r.x + r.w - bw, r.y + 8, bw, bh,
                       on ? { variant: "danger", role: "caption" }
                          : { color: T.ok, textColor: T.onAccent, role: "caption" })) {
      setDriver(!on);
      if (on) monClose();
      UI.invalidate();
      A.toast(!on ? "Driver iniciado" : "Driver parado");
    }
  }});

  // dispositivos
  var rows = lista.rows();
  if (!rows.length) {
    A.style.card(LX, 130, LW, 60, { full: c.full, draw: function (r) {
      UI.text("Nenhum dispositivo USB", r.x, r.y,
              { role: "body", color: T.textDim, w: r.w, lines: 1, id: "nd" });
      UI.text("conecte teclado/mouse no host", r.x, r.y + 18,
              { role: "caption", color: T.stroke, w: r.w, lines: 1, id: "nd2" });
    }});
  } else {
    A.list.view("usbhid-devs", LX, 130, LW, Math.min(110, rows.length * 40 + 8),
                rows, { row: 40, r: 12 });
  }

  // teste: teclas/eixos do ultimo report
  var ty = 228;
  A.style.card(LX, ty, LW, 54, { full: c.full, draw: function (r) {
    UI.text("teste", r.x, r.y, { role: "caption", color: T.textDim,
                                  w: r.w, lines: 1, id: "tstl" });
    if (on) {
      UI.text("pare o serviço para testar o hardware", r.x, r.y + 16,
              { role: "caption", color: T.textDim, w: r.w - 60, lines: 2, id: "tsto" });
    } else if (!mon) {
      UI.text(monErr || "procurando teclado/mouse...", r.x, r.y + 16,
              { role: "caption", color: monErr ? T.warn : T.textDim,
                w: r.w - 60, lines: 2, id: "tstn" });
    } else if (mon.kind === "kbd") {
      UI.text("tecla 0x" + hex4(mon.last).substring(2), r.x, r.y + 10,
              { role: "body", color: T.text, w: r.w - 64, lines: 1, id: "tstk" });
      UI.text("mods 0x" + hex4(mon.mods).substring(2) +
              (mon.keys.length ? " - " + mon.keys.length + " tecla(s)" : " - solto"),
              r.x, r.y + 24, { role: "caption", color: T.textDim,
                                w: r.w - 64, lines: 1, id: "tstk2" });
    } else {
      UI.text("dx " + (mon.dx >= 0 ? "+" : "") + mon.dx +
              "  dy " + (mon.dy >= 0 ? "+" : "") + mon.dy, r.x, r.y + 10,
              { role: "body", color: T.text, w: r.w - 64, lines: 1, id: "tstm" });
      UI.text("botões 0x" + hex4(mon.btn).substring(2), r.x, r.y + 24,
              { role: "caption", color: T.textDim, w: r.w - 64, lines: 1, id: "tstm2" });
    }
    eixos(c);
  }});

  if (!on) { monOpen(); monTick(); }
  else if (mon) monClose();
}

// --- headless: o mesmo estado no logcat --------------------------------------
function headless() {
  if (typeof USB === "undefined") {
    System.print("USB HID: esta placa/firmware nao tem USB Host (API 48).");
  }
  while (true) {
    if (typeof USB !== "undefined") {
      var ds = USB.devices();
      var line = "USB HID: driver " + (driverOn() ? "ativo" : "parado") +
                 " | " + ds.length + " device(s)";
      for (var i = 0; i < ds.length; i++) {
        line += " | " + hex4(ds[i].vid) + ":" + hex4(ds[i].pid) + " class " + ds[i].cls;
      }
      System.print(line);
    }
    System.delay(5000);
  }
}

if (!HAS_UI) headless();
else A.run({ main: painel }, "main", { fps: 10 });
