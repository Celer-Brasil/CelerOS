// celeros.usb — helpers para escrever DRIVERS de dispositivo em JS sobre a
// API USB do firmware (API 48). O firmware so entrega devices, descritores e
// transfers; o protocolo (ESC/POS, HID, SCSI...) mora aqui ou no app.
//
// Uso tipico:
//   var usb = require("celeros.usb");
//   var dev = usb.find({ cls: 7 });              // impressora
//   var h = usb.open(dev);                        // claim da interface + EPs
//   usb.write(h, usb.bytes("Ola\n"));
//   usb.close(h);
//
// Bytes sempre como array de numeros 0..255 (o Duktape do firmware e lean,
// sem Uint8Array). Teto de 4KB por transfer; arquivos maiores vao por
// usb.printFile (USB.sendFile, streaming no lado C++).
//
// A placa precisa de USB Host e o app da permission "usb" (o objeto USB
// simplesmente nao existe sem elas).

var usb = { version: '1.0.0' };

// USB Host presente neste firmware/placa (e o app tem a permission).
usb.available = function () {
    return typeof USB !== "undefined" && System.getInfo().hasUsbHost === true;
};

// Lista de devices: [{addr,vid,pid,cls,subcls,proto,speed,claimed,[ifs]}]
// Cada iface: {n,alt,cls,subcls,proto,eps:[{addr,type,mps,ivl}]}
// type: 0 control, 1 iso, 2 bulk, 3 interrupt; addr bit7 = IN.
usb.devices = function () {
    if (!usb.available()) return [];
    return USB.devices();
};

// Primeiro device que casa com os filtros (todos opcionais):
//   {vid, pid, cls, subcls, proto}
usb.find = function (want) {
    want = want || {};
    var list = usb.devices();
    for (var i = 0; i < list.length; i++) {
        var d = list[i];
        if (want.vid !== undefined && d.vid !== want.vid) continue;
        if (want.pid !== undefined && d.pid !== want.pid) continue;
        if (want.cls !== undefined && d.cls !== want.cls) continue;
        if (want.subcls !== undefined && d.subcls !== want.subcls) continue;
        if (want.proto !== undefined && d.proto !== want.proto) continue;
        return d;
    }
    return null;
};

// Primeira interface do device que casa (classe/subclasse/protocolo).
usb.ifaceOf = function (dev, cls, subcls, proto) {
    if (!dev || !dev.ifs) return null;
    for (var i = 0; i < dev.ifs.length; i++) {
        var f = dev.ifs[i];
        if (cls !== undefined && f.cls !== cls) continue;
        if (subcls !== undefined && f.subcls !== subcls) continue;
        if (proto !== undefined && f.proto !== proto) continue;
        return f;
    }
    return null;
};

// Endereco de endpoint da interface: type 2=bulk, 3=interrupt; dir "in"/"out".
// Devolve -1 quando nao existe.
usb.ep = function (iface, type, dir) {
    if (!iface || !iface.eps) return -1;
    var wantIn = (dir === "in");
    for (var i = 0; i < iface.eps.length; i++) {
        var e = iface.eps[i];
        if (e.type !== type) continue;
        if (((e.addr & 0x80) !== 0) !== wantIn) continue;
        return e.addr;
    }
    return -1;
};

// Abre o device: claim da interface (opts.iface ou a primeira com bulk, ou a
// primeira) e resolve os endpoints mais comuns. Devolve um handle ou null.
//   {addr, dev, iface, epOut, epIn, epIntIn}
usb.open = function (dev, opts) {
    opts = opts || {};
    if (!dev) return null;
    var iface = opts.iface || null;
    if (!iface) {
        for (var i = 0; i < dev.ifs.length; i++) {
            if (usb.ep(dev.ifs[i], 2, "out") >= 0 || usb.ep(dev.ifs[i], 2, "in") >= 0) {
                iface = dev.ifs[i];
                break;
            }
        }
    }
    if (!iface && dev.ifs.length) iface = dev.ifs[0];
    if (!iface) return null;
    if (!USB.claim(dev.addr, iface.n, iface.alt)) return null;
    return {
        addr: dev.addr,
        dev: dev,
        iface: iface,
        epOut: usb.ep(iface, 2, "out"),
        epIn: usb.ep(iface, 2, "in"),
        epIntIn: usb.ep(iface, 3, "in")
    };
};

// Solta a interface do handle.
usb.close = function (h) {
    if (!h) return false;
    return USB.release(h.addr, h.iface.n);
};

// Transfers sobre o handle (endpoint escolhido automaticamente).
usb.write = function (h, data, timeoutMs) {
    if (!h || h.epOut < 0) return { ok: false, status: "error", sent: 0 };
    return USB.out(h.addr, h.epOut, data, timeoutMs);
};

usb.read = function (h, len, timeoutMs) {
    if (!h || h.epIn < 0) return { ok: false, status: "error", len: 0, data: [] };
    return USB.in(h.addr, h.epIn, len, timeoutMs);
};

// Envia um arquivo binario direto (comandos ESC/POS pre-gravados, logo...).
usb.printFile = function (h, path, maxBytes) {
    if (!h || h.epOut < 0) return { ok: false, status: "error", sent: 0 };
    return USB.sendFile(h.addr, h.epOut, path, maxBytes);
};

// IN continuo (teclado/mouse/status): o core mantem um anel por endpoint.
usb.listen = function (h, ep, len, depth) {
    if (!h) return false;
    return USB.listen(h.addr, ep === undefined ? h.epIntIn : ep, len, depth);
};

usb.readReport = function (h, ep) {
    if (!h) return null;
    return USB.read(h.addr, ep === undefined ? h.epIntIn : ep);
};

usb.stopListen = function (h, ep) {
    if (!h) return false;
    return USB.unlisten(h.addr, ep === undefined ? h.epIntIn : ep);
};

// Plug/unplug: {type:"add"|"remove", addr, vid, pid} ou null.
usb.poll = function () {
    if (!usb.available()) return null;
    return USB.poll();
};

// ---- bytes <-> texto -------------------------------------------------------
// String -> bytes (charCode & 0xFF). Acentos em UTF-8 viram 2 bytes: para
// texto de impressora que espera Latin-1, converta antes (ver usb.toLatin1).
usb.bytes = function (s) {
    var out = [];
    s = String(s);
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF);
    return out;
};

usb.ascii = usb.bytes;

// "1B 40 0A" / "1B400A" -> [0x1B,0x40,0x0A]
usb.hex = function (s) {
    var out = [];
    s = String(s).replace(/[^0-9A-Fa-f]/g, "");
    if (s.length & 1) s = "0" + s;
    for (var i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
    return out;
};

// bytes -> string 0..255 (para debug/log; nao use como payload de volta ao
// firmware se houver byte >0x7F: o Duktape gravaria UTF-8 de novo)
usb.str = function (b) {
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i] & 0xFF);
    return s;
};

usb.concat = function (a, b) {
    var out = a.slice();
    for (var i = 0; i < b.length; i++) out.push(b[i]);
    return out;
};

module.exports = usb;
