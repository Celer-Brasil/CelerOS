// USB Devices — inspetor do USB Host (API 48).
//
// Mostra o que o firmware enxerga: addr, VID/PID, classe do device, e por
// interface a classe/subclasse/protocolo + endpoints (tipo, direcao, mps).
// E a ferramenta para escrever um driver: descubra a interface e o endpoint
// que o seu aparelho usa e chame USB.claim/USB.out no app.
//
// Com tela desenha a lista (6 por pagina); sem tela imprime no logcat.
// Hotplug: USB.poll() acorda a lista.

var usb = require("celeros.usb");

function hex4(v) {
  var s = (v | 0).toString(16).toUpperCase();
  while (s.length < 4) s = "0" + s;
  return s;
}

function epType(t) {
  return t === 2 ? "bulk" : t === 3 ? "int" : t === 1 ? "iso" : "ctl";
}

function epName(e) {
  return (e.addr & 0x80 ? "in" : "out") + " 0x" + hex4(e.addr).slice(2) +
         " " + epType(e.type) + " " + e.mps;
}

function classOf(d) {
  if (d.cls === 7) return "impressora";
  if (d.cls === 3) return "HID";
  if (d.cls === 8) return "armazenamento";
  if (d.cls === 9) return "hub";
  if (d.cls === 0) return "composta";
  return "classe " + d.cls;
}

function devLines(d) {
  var out = [];
  out.push(hex4(d.vid) + ":" + hex4(d.pid) + "  " + classOf(d) +
           (d.claimed.length ? "  [" + d.claimed.join(",") + "]" : ""));
  for (var i = 0; i < d.ifs.length; i++) {
    var f = d.ifs[i];
    var line = "if" + f.n + (f.alt ? "." + f.alt : "") + " " + f.cls + "/" + f.subcls + "/" + f.proto;
    for (var e = 0; e < f.eps.length; e++) line += "  " + epName(f.eps[e]);
    out.push(line);
  }
  return out;
}

// ---- headless: logcat ------------------------------------------------------
if (!System.getInfo().hasDisplay) {
  if (typeof USB === "undefined") {
    System.print("USB Devices: sem USB Host neste firmware/placa");
  }
  var lastSig = "";
  while (true) {
    if (typeof USB !== "undefined") {
      var devs = usb.devices();
      var sig = "";
      var i;
      for (i = 0; i < devs.length; i++) sig += devs[i].addr + ":" + devs[i].vid + ":" + devs[i].pid + ";";
      if (sig !== lastSig) {
        lastSig = sig;
        System.print("USB Devices: " + devs.length + " device(s)");
        for (i = 0; i < devs.length; i++) {
          var ls = devLines(devs[i]);
          for (var k = 0; k < ls.length; k++) System.print("  " + ls[k]);
        }
      }
      while (usb.poll() !== null) { /* drena o hotplug */ }
    }
    System.delay(1000);
  }
}

// ---- com tela: lista paginada ---------------------------------------------
var scroll = 0;
var PER_PAGE = 6;

while (true) {
  UI.begin();
  if (UI.header("USB", { sub: "dispositivos" })) System.exitApp();

  if (typeof USB === "undefined") {
    UI.text("Esta placa/firmware não tem USB Host (API 48).", 12, 60, { w: 216, lines: 3 });
    UI.end();
    continue;
  }

  var devs = usb.devices();
  while (usb.poll() !== null) UI.invalidate();

  if (!devs.length) {
    UI.text("Nenhum dispositivo.\nConecte no USB-C host (hub aceita\nvários).", 12, 60, { w: 216, lines: 4 });
    UI.end();
    continue;
  }

  if (scroll > devs.length - PER_PAGE) scroll = Math.max(0, devs.length - PER_PAGE);
  if (scroll < 0) scroll = 0;

  var y = 52;
  for (var i = scroll; i < devs.length && i < scroll + PER_PAGE; i++) {
    var d = devs[i];
    UI.card(8, y, 224, 38);
    UI.text(hex4(d.vid) + ":" + hex4(d.pid) + "  " + classOf(d), 16, y + 5,
            { role: "body", id: 100 + i });
    var sub = "addr " + d.addr + " · " + d.ifs.length + " interface(s)" +
              (d.claimed.length ? " · em uso" : "");
    UI.text(sub, 16, y + 21, { role: "caption", id: 200 + i });
    UI.cardEnd();
    y += 44;
  }

  if (devs.length > PER_PAGE) {
    if (UI.button("^", 8, 280, 44, 32, { id: 1 })) { scroll--; UI.invalidate(); }
    if (UI.button("v", 56, 280, 44, 32, { id: 2 })) { scroll++; UI.invalidate(); }
    UI.text((scroll + 1) + "-" + Math.min(devs.length, scroll + PER_PAGE) + " de " + devs.length,
            120, 288, { role: "caption", align: "center", id: 3 });
  }
  UI.end();
}
