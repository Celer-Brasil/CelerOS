// Impressora — teste de impressora termica ESC/POS via USB Host (API 48).
// O driver (descoberta da interface classe 7, DLE EOT 1/2 com retry do ZLP
// da Epson, WPC1252 e a pagina de teste) mora aqui e na dep
// celeros.usb.escpos; o app so escolhe a cara:
//
//   - placa COM vidro: painel CelerKit UI 2.0 — lista de impressoras
//     (A.list.view), tela do device com as interfaces, status em tempo real
//     (1 Hz) e o cupom num sheet com confirmacao;
//   - placa headless (devkit-s3): o caminho de sempre — acha a impressora em
//     ate 30 s, imprime a pagina de teste e a saida e o logcat.
//
// Uso na bancada: `grant Impressora` (consentimento headless) e
// `celerctl apps run Impressora`.

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.list");
var usb = require("celeros.usb");
var esc = require("celeros.usb.escpos");
A.init();

var T = A.style.T;
var INFO = {};
try { INFO = System.getInfo() || {}; } catch (e) { INFO = {}; }
var HAS_UI = INFO.hasDisplay === true && INFO.shape !== "headless";
var LX = A.L.x, LW = A.L.w, BOT = A.L.bottom;

function hex(v, n) {
  var s = (v | 0).toString(16).toUpperCase();
  while (s.length < n) s = "0" + s;
  return s;
}
function log(s) { System.print("Impressora: " + s); }

// Primeiro device com interface classe 7 (printer); Epson (04B8) vence.
function findPrinter() {
  var devs = usb.devices();
  var any = null;
  for (var i = 0; i < devs.length; i++) {
    var d = devs[i];
    if (!usb.ifaceOf(d, 7)) continue;
    if (d.vid === 0x04B8) return d;
    if (any === null) any = d;
  }
  return any;
}

// Lista de candidatas na mesma ordem do findPrinter (Epson primeiro).
function printers() {
  var devs = usb.devices(), out = [], rest = [];
  for (var i = 0; i < devs.length; i++) {
    if (!usb.ifaceOf(devs[i], 7)) continue;
    if (devs[i].vid === 0x04B8) out.push(devs[i]);
    else rest.push(devs[i]);
  }
  for (var k = 0; k < rest.length; k++) out.push(rest[k]);
  return out;
}

function modelOf(d) {
  if (d.vid === 0x04B8) return "Epson TM-T20X";
  return "Impressora USB";
}

function dumpIfs(dev) {
  for (var i = 0; i < dev.ifs.length; i++) {
    var f = dev.ifs[i];
    var eps = "";
    for (var e = 0; e < f.eps.length; e++) {
      eps += " 0x" + hex(f.eps[e].addr, 2) + "/t" + f.eps[e].type +
             "/mps" + f.eps[e].mps;
    }
    log("iface " + f.n + "." + f.alt + " cls " + f.cls + "." + f.subcls +
        "." + f.proto + ":" + eps);
  }
}

// Status em tempo real via a dep (DLE EOT 1/2 com retry do ZLP da Epson).
function statusStr(st) {
  if (st === null) return "sem resposta";
  var out = st.online ? "on-line" : "OFF-LINE";
  if (st.erro) out += " erro";
  if (st.esperando) out += " aguardando-recuperacao";
  if (st.papel) out += " SEM-PAPEL";
  else if (st.acabando) out += " papel acabando";
  out += " (0x" + hex(st.raw1, 2) + ")";
  return out;
}
function statusColor(st) {
  if (st === null) return T.textDim;
  if (!st.online || st.erro) return T.err;
  if (st.papel) return T.warn;
  return T.ok;
}

// Bytes da pagina de teste (o driver de verdade; o headless e o UI usam).
// WPC1252 (ESC t 16): os acentos Latin-1 imprimem direito na Epson.
function pagina(p, dev) {
  p.init().codepage(16);
  p.align(1).size(2, 2).bold(true).line("CELER OS");
  p.align(1).size(1, 1).line("Impressora termica USB");
  p.line("");
  p.align(0).line("Epson TM-T20X  " + hex(dev.vid, 4) + ":" + hex(dev.pid, 4));
  p.line("Teste de acentos: acao, coracao, avo,");
  p.line("ponte, trocu, saida.");
  p.line("");
  p.align(1).qr("celeros.printer", 5, 1);
  p.align(0).feed(4).cut();
}

function printTest(dev) {
  log("device " + hex(dev.vid, 4) + ":" + hex(dev.pid, 4) + " addr " + dev.addr);
  dumpIfs(dev);

  var p = esc.open(dev);
  if (p === null) {
    log("falha no claim da interface classe 7");
    return false;
  }
  log("aberta iface " + p.h.iface.n + " epOut 0x" + hex(p.h.epOut, 2) +
      " epIn " + (p.h.epIn < 0 ? "-" : "0x" + hex(p.h.epIn, 2)));

  log("status: " + statusStr(p.status()));

  pagina(p, dev);
  p.close();
  log("pagina de teste enviada");
  return true;
}

// ---------------------------------------------------------------- headless --
function cabecalho(dev) { return modelOf(dev) + "  " + hex(dev.vid, 4) + ":" + hex(dev.pid, 4); }

function headless() {
  if (!usb.available()) {
    log("esta placa/firmware nao tem USB Host (API 48)");
    return;
  }
  var deadline = System.millis() + 30000;
  while (System.millis() < deadline) {
    var dev = findPrinter();
    if (dev !== null && printTest(dev)) break;
    System.delay(2000);
  }
  if (System.millis() >= deadline) log("nenhuma impressora classe 7 em 30 s");
}

// --------------------------------------------------------------------- UI --
var devs = [], sel = null, ph = null, pst = null, pstAt = 0, claimFail = false;
var sheetOpen = false, sheetUntil = 0;

function rescan() {
  devs = usb.available() ? printers() : [];
}

function fecharPrinter() {
  if (ph) { try { ph.close(); } catch (e) {} ph = null; }
  pst = null;
  claimFail = false;
}

// abre (claim) e le o status; devolve true se abriu
function abrirPrinter() {
  if (!sel) return false;
  if (!ph) {
    fecharPrinter();
    ph = esc.open(sel);
    claimFail = !ph;
  }
  return !!ph;
}

function lerStatus(force) {
  var now = System.millis();
  // impressora muda (unidirecional com IN que nao responde): o status()
  // gasta os timeouts de transferencia; depois de um null espera 5 s
  if (!force && pst === null && pstAt && now - pstAt < 5000) return;
  if (!force && pstAt && now - pstAt < 1000) return;
  if (!abrirPrinter()) { pstAt = now; return; }
  pstAt = now;
  try { pst = ph.status(); } catch (e) { pst = null; }
}

function devRows() {
  var out = [];
  for (var i = 0; i < devs.length; i++) {
    var d = devs[i];
    out.push({
      label: modelOf(d),
      sub: "addr " + d.addr + " - classe 7",
      icon: "info",
      right: hex(d.vid, 4) + ":" + hex(d.pid, 4),
      rightColor: T.textDim
    });
  }
  return out;
}
var lista = A.list.make(function () {
  var s = "";
  for (var i = 0; i < devs.length; i++) s += devs[i].addr + ":" + devs[i].vid + ":" + devs[i].pid + ";";
  return s;
}, devRows);

function semUsb(c) {
  A.style.card(LX, 48, LW, 150, { full: c.full, draw: function (r) {
    UI.text("Sem USB Host", r.x, r.y, { role: "title", color: T.warn, w: r.w, lines: 1 });
    UI.text("Este firmware/placa não expõe o", r.x, r.y + 28,
            { role: "caption", color: T.textDim, w: r.w, lines: 1 });
    UI.text("USB Host (API 48).", r.x, r.y + 42,
            { role: "caption", color: T.textDim, w: r.w, lines: 1 });
    UI.text("O app abre e explica; o driver", r.x, r.y + 62,
            { role: "caption", color: T.text, w: r.w, lines: 1 });
    UI.text("segue disponível nas placas com", r.x, r.y + 76,
            { role: "caption", color: T.text, w: r.w, lines: 1 });
    UI.text("CELEROS_USB_HOST.", r.x, r.y + 90,
            { role: "caption", color: T.text, w: r.w, lines: 1 });
  }});
}

function telaMain(c) {
  var h = A.widgets.header("Impressora", { full: c.full,
    actions: [{ icon: "search", id: "scan" }] });
  if (h.back) return A.BACK;
  if (h.action === "scan") {
    rescan();
    UI.invalidate();
    A.toast(devs.length ? devs.length + " impressora(s)" : "Nenhuma impressora");
  }
  if (A.every(1500, "usb")) {
    var antes = lista.rows().length;
    rescan();
    if (lista.rows().length !== antes) UI.invalidate();
  }

  if (!usb.available()) {
    semUsb(c);
    UI.text("Conecte a impressora no USB-C host do devkit.", LX, BOT - 26,
            { role: "caption", color: T.textDim, w: LW, lines: 2, id: "nousb2" });
    return;
  }

  var rows = lista.rows();
  if (!rows.length) {
    A.style.card(LX, 48, LW, 120, { full: c.full, draw: function (r) {
      UI.text("Nenhuma impressora", r.x, r.y,
              { role: "title", color: T.textDim, w: r.w, lines: 1 });
      UI.text("Conecte a impressora no USB-C", r.x, r.y + 30,
              { role: "caption", color: T.textDim, w: r.w, lines: 1 });
      UI.text("host e toque na lupa.", r.x, r.y + 44,
              { role: "caption", color: T.textDim, w: r.w, lines: 1 });
      UI.text("Epson TM-T20X (04B8) ou", r.x, r.y + 66,
              { role: "caption", color: T.stroke, w: r.w, lines: 1 });
      UI.text("qualquer interface classe 7.", r.x, r.y + 80,
              { role: "caption", color: T.stroke, w: r.w, lines: 1 });
    }});
    return;
  }

  var i = A.list.view("prn-devs", LX, 48, LW, BOT - 90, rows, { row: 52 });
  if (i >= 0 && devs[i]) { sel = devs[i]; return "dev"; }

  UI.text(devs.length + " impressora(s) - toque para abrir", LX, BOT - 22,
          { role: "caption", color: T.textDim, w: LW, lines: 1, id: "n1" });
}

function telaDev(c) {
  var h = A.widgets.header(sel ? modelOf(sel) : "Impressora", { full: c.full,
    sub: sel ? hex(sel.vid, 4) + ":" + hex(sel.pid, 4) : "" });
  if (h.back) { fecharPrinter(); UI.invalidate(); return A.BACK; }
  lerStatus(c.entered);

  // status em tempo real (1 Hz)
  var scol = statusColor(pst);
  A.style.card(LX, 48, LW, 62, { full: c.full, draw: function (r) {
    UI.text("status", r.x, r.y, { role: "caption", color: T.textDim,
                                   w: r.w, lines: 1, id: "stl" });
    UI.text(!ph && claimFail ? "interface ocupada por outro app" : statusStr(pst),
            r.x, r.y + 14,
            { role: "body", color: !ph && claimFail ? T.warn : scol,
              w: r.w, lines: 2, id: "stv" });
    UI.text(sel ? "addr " + sel.addr : "", r.x + r.w, r.y,
            { role: "caption", align: "right", color: T.textDim, w: r.w,
              lines: 1, id: "adr" });
  }});

  // interfaces do device (list.view)
  var ifs = sel ? sel.ifs : [];
  var irows = [];
  for (var i = 0; i < ifs.length; i++) {
    var f = ifs[i], n = 0;
    for (var e = 0; e < f.eps.length; e++) n++;
    irows.push({
      label: "Interface " + f.n + "." + f.alt,
      sub: "classe " + f.cls + "." + f.subcls + "." + f.proto +
           (f.cls === 7 ? " printer" : ""),
      right: n + " EP",
      rightColor: f.cls === 7 ? T.ok : T.textDim
    });
  }
  A.list.view("prn-ifs", LX, 118, LW, 96, irows, { row: 40, r: 12 });

  var b1 = A.style.button("Imprimir cupom", LX, 224, LW, 40,
                          { color: T.accent, textColor: T.onAccent });
  if (b1) { sheetOpen = true; UI.invalidate(); }
  if (A.style.button("Atualizar status", LX, 270, LW, 30,
                     { variant: "ghost", role: "caption" })) {
    lerStatus(true);
    UI.invalidate();
  }
}

// cupom: sheet com a previa e a confirmacao
function cupom(c) {
  return A.widgets.sheet("prn-cupom", { open: sheetOpen, full: c.full && sheetOpen,
                                        h: 226, title: "Cupom de teste" },
    function (r) {
      UI.text("CELER OS", r.x, r.y, { role: "title", color: T.text,
                                      w: r.w, lines: 1, id: "c1" });
      UI.text("Impressora térmica USB", r.x, r.y + 20,
              { role: "caption", color: T.textDim, w: r.w, lines: 1, id: "c2" });
      UI.text(sel ? cabecalho(sel) : "", r.x, r.y + 34,
              { role: "caption", color: T.textDim, w: r.w, lines: 1, id: "c3" });
      UI.text("Teste de acentos: ação, coração,", r.x, r.y + 52,
              { role: "caption", color: T.text, w: r.w, lines: 1, id: "c4" });
      UI.text("avô, ponte, troçu, saída.", r.x, r.y + 64,
              { role: "caption", color: T.text, w: r.w, lines: 1, id: "c5" });
      UI.text("[QR] celeros.printer", r.x, r.y + 82,
              { role: "caption", color: T.textDim, w: r.w, lines: 1, id: "c6" });
      A.style.divider(r.x, r.y + 98, r.w);
      UI.text("Papel 80 mm - corte automático", r.x, r.y + 104,
              { role: "caption", color: T.textDim, w: r.w, lines: 1, id: "c7" });

      var w2 = Math.floor((r.w - 8) / 2);
      if (sheetOpen && A.style.button("Cancelar", r.x, r.y + 126, w2, 38,
                                      { variant: "ghost" })) {
        sheetOpen = false;
        sheetUntil = System.millis() + 260;
        UI.invalidate();
      }
      if (sheetOpen && A.style.button("Imprimir", r.x + r.w - w2, r.y + 126, w2, 38,
                                      { color: T.accent, textColor: T.onAccent })) {
        sheetOpen = false;
        sheetUntil = System.millis() + 260;
        A.busy("Imprimindo...");
        fecharPrinter();                       // o driver reclama a interface
        var ok = printTest(sel);
        pstAt = 0;
        A.toast(ok ? "Cupom enviado" : "Falha ao abrir a impressora");
        UI.invalidate();
      }
    });
}

// ---------------------------------------------------------------- entrada --
if (!HAS_UI) {
  headless();
} else {
  A.run({
    main: function (c) {
      if (c.entered) { rescan(); UI.invalidate(); }
      var inSheet = sheetOpen || (!sheetOpen && System.millis() < sheetUntil);
      if (inSheet) {
        // cupom aberto/fechando: a base continua desenhada, mas sem toque
        if (!sheetOpen) { telaMain(c); return; }
        telaMain(c);
        var r = cupom(c);
        if (r === "close") {
          sheetOpen = false;
          sheetUntil = System.millis() + 260;
          UI.invalidate();
        }
        return;
      }
      var next = telaMain(c);
      if (next === "dev") return "dev";
      return next;
    },
    dev: function (c) {
      if (sheetOpen || System.millis() < sheetUntil) {
        telaDev(c);
        var r = cupom(c);
        if (r === "close") {
          sheetOpen = false;
          sheetUntil = System.millis() + 260;
          UI.invalidate();
        }
        return;
      }
      return telaDev(c);
    }
  }, "main", { fps: 10 });
}
