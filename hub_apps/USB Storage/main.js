// USB Storage — pendrive no USB Host (API 48).
//
// Todo o driver e JS: celeros.usb.msc fala Bulk-Only Transport + SCSI com o
// device e le a FAT32/exFAT (somente leitura). O firmware so entrega bulk
// transfers — nenhuma linha de MSC no C++.
//
// Headless: imprime o volume e a raiz no logcat, uma vez por conexao.
// Com tela: navega (entra em pasta, abre arquivo de texto, volta).

var usb = require("celeros.usb");
var msc = require("celeros.usb.msc");

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return Math.round(n / 1024) + " KB";
  if (n < 1073741824) return Math.round(n / 1048576) + " MB";
  return Math.round(n / 1073741824) + " GB";
}

function findMsc() {
  var devs = usb.devices();
  for (var i = 0; i < devs.length; i++) {
    var d = devs[i];
    for (var k = 0; k < d.ifs.length; k++) {
      var f = d.ifs[k];
      if (f.cls === 8 && f.subcls === 6 && f.proto === 0x50) return d;
    }
  }
  return null;
}

// O device pode ainda nao estar pronto logo apos o plug (INQUIRY/CAPACITY
// falham): tenta de novo por ~2 s. Devolve o volume ou null.
function mountWithRetry(dev, tries) {
  var n = tries || 5;
  for (var i = 0; i < n; i++) {
    var v = msc.openVolume(dev);
    if (v) return v;
    if (typeof System.delay === "function") System.delay(200);
    else {
      var t = System.millis();
      while (System.millis() - t < 200) { }
    }
  }
  return null;
}

function textOf(bytes, max) {
  var s = "";
  for (var i = 0; i < bytes.length && i < max; i++) {
    var c = bytes[i];
    if (c === 10) s += "\n";
    else if (c === 13) { /* ignora CR */ }
    else if (c === 9) s += " ";
    else if (c < 32) s += ".";
    else s += String.fromCharCode(c);
  }
  return s;
}

// ---- headless --------------------------------------------------------------
if (!System.getInfo().hasDisplay) {
  if (typeof USB === "undefined") {
    System.print("USB Storage: sem USB Host neste firmware/placa");
  }
  var lastAddr = 0;
  while (true) {
    if (typeof USB !== "undefined") {
      var dev = findMsc();
      if (dev && dev.addr !== lastAddr) {
        lastAddr = dev.addr;
        var vol = mountWithRetry(dev, 8);
        if (!vol) {
          System.print("USB Storage: nao consegui montar (FAT32/exFAT?)");
        } else {
          var info = vol.info();
          System.print("USB Storage: " + info.type + " rotulo '" + info.label + "' " +
                       fmtSize(info.totalBytes) + " (" + info.clusterCount + " clusters)");
          var list = vol.list("/");
          for (var i = 0; i < list.length && i < 32; i++) {
            System.print("  " + (list[i].dir ? "[dir] " : "") + list[i].name +
                         (list[i].dir ? "" : "  " + fmtSize(list[i].size)));
          }
          vol.close();
        }
      } else if (!dev && lastAddr) {
        lastAddr = 0;
        System.print("USB Storage: pendrive removido");
      }
      while (usb.poll() !== null) { }
    }
    System.delay(2000);
  }
}

// ---- com tela --------------------------------------------------------------
var path = "/";
var vol = null;
var volAddr = 0;
var msg = "";
var scroll = 0;
var preview = null;

function ensureVolume() {
  var dev = findMsc();
  if (!dev) {
    if (vol) { vol.close(); vol = null; volAddr = 0; }
    path = "/";
    preview = null;
    return false;
  }
  if (vol && dev.addr === volAddr) return true;
  if (vol) vol.close();
  vol = mountWithRetry(dev, 3);
  volAddr = vol ? dev.addr : 0;
  scroll = 0;
  preview = null;
  if (!vol) msg = "Nao consegui montar (FAT32/exFAT?).";
  else msg = "";
  return !!vol;
}

function parentOf(p) {
  if (!p || p === "/") return "/";
  var i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.substr(0, i);
}

while (true) {
  UI.begin();
  if (UI.header("Pendrive USB", { sub: path })) System.exitApp();

  if (typeof USB === "undefined") {
    UI.text("Esta placa/firmware não tem USB Host (API 48).", 12, 60, { w: 216, lines: 3 });
    UI.end();
    continue;
  }
  while (usb.poll() !== null) UI.invalidate();

  if (!ensureVolume()) {
    UI.text("Conecte um pendrive FAT32 ou exFAT\nno USB-C host.", 12, 60, { w: 216, lines: 3 });
    if (msg) UI.text(msg, 12, 120, { w: 216, lines: 2, role: "caption", id: 90 });
    UI.end();
    continue;
  }

  if (preview) {
    UI.card(8, 48, 224, 236);
    UI.text(preview.name, 16, 54, { role: "body", id: 1 });
    UI.text(preview.text, 16, 76, { w: 208, lines: 15, role: "caption", id: 2 });
    UI.cardEnd();
    if (UI.button("Voltar", 8, 284, 100, 30, { id: 5 })) preview = null;
    UI.end();
    continue;
  }

  var list = vol.list(path);
  var info = vol.info();
  var y = 46;
  var shown = 0;
  var i;
  if (path === "/") {
    UI.text(info.type + "  " + info.label + "  " + fmtSize(info.totalBytes),
            10, 44, { role: "caption", id: 3 });
    y = 62;
  }
  if (scroll > list.length - 1) scroll = Math.max(0, list.length - 1);

  for (i = scroll; i < list.length && shown < 4; i++, shown++) {
    var it = list[i];
    if (UI.button((it.dir ? "[ " : "") + it.name + (it.dir ? " ]" : ""),
                  8, y, 224, 30, { id: 100 + i, style: "ghost" })) {
      if (it.dir) {
        path = path === "/" ? "/" + it.name : path + "/" + it.name;
        scroll = 0;
        UI.invalidate();
      } else {
        var bytes = vol.read(path === "/" ? "/" + it.name : path + "/" + it.name, 2048);
        preview = { name: it.name, text: bytes ? textOf(bytes, 2048) : "(falha na leitura)" };
        UI.invalidate();
      }
      break;
    }
    UI.text(it.dir ? "" : fmtSize(it.size), 236, y + 8,
            { role: "caption", align: "right", id: 200 + i });
    y += 34;
  }

  if (!list.length) UI.text("(pasta vazia)", 12, y + 4, { role: "caption", id: 4 });

  if (path !== "/") UI.text("< voltar", 10, 292, { role: "caption", id: 6 });
  if (list.length > 4) {
    if (UI.button("^", 140, 284, 40, 28, { id: 7 })) { scroll--; UI.invalidate(); }
    if (UI.button("v", 184, 284, 40, 28, { id: 8 })) { scroll++; UI.invalidate(); }
  }
  if (UI.button("<", 8, 284, 40, 28, { id: 9 })) {
    if (path === "/") { vol.close(); vol = null; volAddr = 0; }
    else path = parentOf(path);
    scroll = 0;
    UI.invalidate();
  }

  UI.end();
}
