// Impressora — teste de impressora termica ESC/POS via USB Host (API 48).
//
// Headless: a saida e o logcat (celerctl logcat). O protocolo mora na dep
// celeros.usb.escpos; aqui so descobrimos o device, abrimos a interface
// classe 7 (printer) e mandamos a pagina de teste. Epson TM-T20X: vid 04B8,
// bulk OUT de dados e bulk IN de status (interface protocolo 2).
//
// Uso na bancada: `grant Impressora` (consentimento headless) e
// `celerctl apps run Impressora`.

var usb = require("celeros.usb");
var esc = require("celeros.usb.escpos");

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

  // WPC1252 (ESC t 16): os acentos Latin-1 imprimem direito na Epson.
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
  p.close();
  log("pagina de teste enviada");
  return true;
}

// Espera o device (ate 30 s) — a impressora pode ser plugada depois do run.
if (!usb.available()) {
  log("esta placa/firmware nao tem USB Host (API 48)");
} else {
  var deadline = System.millis() + 30000;
  while (System.millis() < deadline) {
    var dev = findPrinter();
    if (dev !== null && printTest(dev)) break;
    System.delay(2000);
  }
  if (System.millis() >= deadline) log("nenhuma impressora classe 7 em 30 s");
}
