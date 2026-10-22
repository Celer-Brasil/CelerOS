// USB HID — status do driver de teclado/mouse (o trabalho vive no service.js).
//
// Headless: so logcat. Em placa com tela este app mostraria a lista; no
// devkit-s3 a interface e o console (celerctl logcat).

function hex4(v) {
  var s = (v | 0).toString(16).toUpperCase();
  while (s.length < 4) s = "0" + s;
  return s;
}

var info = System.getInfo();
System.print("USB HID: board=" + info.board + " usbHost=" + (info.hasUsbHost ? "sim" : "nao"));
if (typeof USB === "undefined") {
  System.print("USB HID: esta placa/firmware nao tem USB Host (API 48).");
}

while (true) {
  if (typeof USB !== "undefined") {
    var devs = USB.devices();
    var line = "USB HID: " + devs.length + " device(s)";
    for (var i = 0; i < devs.length; i++) {
      line += " | " + hex4(devs[i].vid) + ":" + hex4(devs[i].pid) + " class " + devs[i].cls;
    }
    System.print(line);
  }
  System.delay(5000);
}
