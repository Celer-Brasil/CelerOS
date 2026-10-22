// USB Printer — driver ESC/POS em JS (API 48).
//
// O firmware nao tem nada de impressora: este app acha a interface classe 7
// (printer), pede o claim, monta os bytes com celeros.usb.escpos e manda por
// USB.out (ou sendFile para um job pre-gravado). Trocar de modelo = trocar a
// sequencia de comandos aqui, no modulo escpos, ou num driver proprio.

var usb = require("celeros.usb");
var esc = require("celeros.usb.escpos");

var lastPrint = "";
var lastAddr = 0;

function printerDev() {
  return usb.find({ cls: 7 });
}

function printTest(dev) {
  if (!dev) return "Nenhuma impressora (classe 7) conectada.";
  var p = esc.open(dev);
  if (!p) return "Impressora em uso por outro app/servico.";
  var lines = [
    "Teste de impressao USB",
    "VID:PID " + ("0000" + dev.vid.toString(16).toUpperCase()).slice(-4) +
      ":" + ("0000" + dev.pid.toString(16).toUpperCase()).slice(-4),
    "Interface " + dev.ifs.length + " - ESC/POS",
    "",
    "O driver roda em JavaScript.",
    "O firmware so entrega os bytes."
  ];
  p.receipt("CELER OS", lines, "https://os.celer.tec.br");
  p.close();
  lastPrint = System.getTime();
  return "Cupom enviado.";
}

// ---- headless: imprime ao conectar ---------------------------------------
if (!System.getInfo().hasDisplay) {
  if (typeof USB === "undefined") {
    System.print("USB Printer: sem USB Host neste firmware/placa");
  }
  while (true) {
    if (typeof USB !== "undefined") {
      var d = printerDev();
      if (d && d.addr !== lastAddr) {
        lastAddr = d.addr;
        System.print("USB Printer: " + printTest(d));
      } else if (!d && lastAddr) {
        lastAddr = 0;
        System.print("USB Printer: impressora desconectada");
      }
      while (usb.poll() !== null) { }
    }
    System.delay(2000);
  }
}

// ---- com tela -------------------------------------------------------------
var msg = "";

while (true) {
  UI.begin();
  if (UI.header("Impressora USB")) System.exitApp();

  if (typeof USB === "undefined") {
    UI.text("Esta placa/firmware não tem USB Host (API 48).", 12, 60, { w: 216, lines: 3 });
    UI.end();
    continue;
  }

  var dev = printerDev();
  while (usb.poll() !== null) UI.invalidate();

  if (dev) {
    UI.card(8, 52, 224, 92);
    UI.text("Impressora encontrada", 16, 60, { role: "body", id: 1 });
    UI.text("VID " + ("0000" + dev.vid.toString(16).toUpperCase()).slice(-4) +
            " · PID " + ("0000" + dev.pid.toString(16).toUpperCase()).slice(-4),
            16, 82, { role: "caption", id: 2 });
    UI.text(dev.ifs.length + " interface(s) · classe 7", 16, 100,
            { role: "caption", id: 3 });
    UI.cardEnd();
    if (UI.button("Imprimir cupom de teste", 8, 160, 224, 44, { id: 10 })) {
      msg = printTest(dev);
      UI.invalidate();
    }
  } else {
    UI.text("Nenhuma impressora.\nConecte uma ESC/POS no USB-C host.", 12, 60,
            { w: 216, lines: 3 });
  }

  if (msg) UI.text(msg, 12, 220, { role: "caption", w: 216, lines: 3, id: 20 });
  if (lastPrint) UI.text("último envio: " + lastPrint, 12, 288,
                         { role: "caption", align: "center", id: 21 });

  UI.end();
}
