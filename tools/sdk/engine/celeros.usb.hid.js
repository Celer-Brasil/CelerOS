// celeros.usb.hid — HID boot protocol em JS (teclado e mouse simples).
//
// O firmware nao decodifica report nenhum: entrega os bytes crus por
// USB.listen/read. Este modulo decodifica o BOOT REPORT (o que BIOS e
// teclados/mouses simples usam sem SET_PROTOCOL/report descriptor) e faz o
// diff de teclas entre reports.
//
//   var hid = require("celeros.usb.hid");
//   var kbd = hid.openKeyboard(usb.find({}));
//   var evs = kbd.poll();       // [{key, mods, down}] desde o quadro anterior
//
// Para um mouse que tambem move o ponteiro do OS, o driver chama
// Input.move(x, y, buttons) (com a permission "input").
//
// usage IDs: 0x04=A ... 0x1D=Z, 0x1E..0x27=1..0, 0x28=Enter, 0x29=Esc,
// 0x2C=Espaco, 0xE0..0xE7 = Ctrl/Shift/Alt/GUI esq/dir.

var usb = require("celeros.usb");

var hid = { version: '1.0.0' };

// Interface de teclado/mouse boot: classe 3, subclasse 1, protocolo 1/2.
hid.PROTO_KEYBOARD = 1;
hid.PROTO_MOUSE = 2;

hid.findKeyboard = function (devs) {
    devs = devs || usb.devices();
    for (var i = 0; i < devs.length; i++) {
        var f = usb.ifaceOf(devs[i], 3, 1, 1);
        if (f && usb.ep(f, 3, "in") >= 0) return devs[i];
    }
    return null;
};

hid.findMouse = function (devs) {
    devs = devs || usb.devices();
    for (var i = 0; i < devs.length; i++) {
        var f = usb.ifaceOf(devs[i], 3, 1, 2);
        if (f && usb.ep(f, 3, "in") >= 0) return devs[i];
    }
    return null;
};

// Boot keyboard report: [mods, reservado, k1..k6]. Devolve {mods, keys:[]}.
hid.decodeKeyboard = function (report) {
    var out = { mods: report[0] || 0, keys: [] };
    for (var i = 2; i < 8 && i < report.length; i++) {
        if (report[i]) out.keys.push(report[i]);
    }
    return out;
};

// Diferenca entre o report anterior e o novo -> teclas que desceram/subiram.
hid.diffKeys = function (prev, next) {
    var pressed = [], released = [];
    var i, j, found;
    for (i = 0; i < next.length; i++) {
        found = false;
        for (j = 0; j < prev.length; j++) if (prev[j] === next[i]) { found = true; break; }
        if (!found) pressed.push(next[i]);
    }
    for (i = 0; i < prev.length; i++) {
        found = false;
        for (j = 0; j < next.length; j++) if (next[j] === prev[i]) { found = true; break; }
        if (!found) released.push(prev[i]);
    }
    return { pressed: pressed, released: released };
};

hid.signed8 = function (v) {
    v = v & 0xFF;
    return v > 127 ? v - 256 : v;
};

// Boot mouse report: [buttons, dx, dy, wheel?]. buttons bit0 esq, bit1 dir,
// bit2 meio.
hid.decodeMouse = function (report) {
    return {
        buttons: report[0] || 0,
        dx: hid.signed8(report[1] || 0),
        dy: hid.signed8(report[2] || 0),
        wheel: report.length > 3 ? hid.signed8(report[3] || 0) : 0
    };
};

// ---- teclado ---------------------------------------------------------------
hid.openKeyboard = function (dev) {
    if (!dev) return null;
    var iface = usb.ifaceOf(dev, 3, 1, 1);
    if (!iface) return null;
    var h = usb.open(dev, { iface: iface });
    if (!h || h.epIntIn < 0) {
        if (h) usb.close(h);
        return null;
    }
    return new hid.Keyboard(h, iface, 8);
};

hid.Keyboard = function (h, iface, reportLen) {
    this.h = h;
    this.iface = iface;
    this.ep = h.epIntIn;
    this.reportLen = reportLen || 8;
    this.mods = 0;
    this.keys = [];
    this.events = [];
    this.listening = usb.listen(this.h, this.ep, this.reportLen, 8);
};

// Drena os reports novos e devolve os eventos ACUMULADOS desde a ultima
// chamada: [{key, mods, down}]. Fila cheia/erro apenas para o quadro.
hid.Keyboard.prototype.poll = function () {
    var out = [];
    if (!this.listening) return out;
    var r;
    while ((r = usb.readReport(this.h, this.ep)) !== null) {
        var d = hid.decodeKeyboard(r);
        var diff = hid.diffKeys(this.keys, d.keys);
        var i;
        for (i = 0; i < diff.released.length; i++) out.push({ key: diff.released[i], mods: d.mods, down: false });
        for (i = 0; i < diff.pressed.length; i++) out.push({ key: diff.pressed[i], mods: d.mods, down: true });
        this.keys = d.keys;
        this.mods = d.mods;
    }
    return out;
};

hid.Keyboard.prototype.close = function () {
    if (this.listening) usb.stopListen(this.h, this.ep);
    var ok = usb.close(this.h);
    this.h = null;
    return ok;
};

// ---- mouse -----------------------------------------------------------------
hid.openMouse = function (dev) {
    if (!dev) return null;
    var iface = usb.ifaceOf(dev, 3, 1, 2);
    if (!iface) return null;
    var h = usb.open(dev, { iface: iface });
    if (!h || h.epIntIn < 0) {
        if (h) usb.close(h);
        return null;
    }
    return new hid.Mouse(h, iface);
};

hid.Mouse = function (h, iface) {
    this.h = h;
    this.iface = iface;
    this.ep = h.epIntIn;
    this.x = 120;   // centro do espaco virtual 240x320
    this.y = 160;
    this.buttons = 0;
    this.wheel = 0;
    this.listening = usb.listen(this.h, this.ep, 4, 8);
};

// Drena os reports e devolve a posicao acumulada no espaco virtual:
// [{x,y,buttons,wheel}] — uma entrada por report (o driver decide o que fazer
// com ela: Input.move, arrastar, etc.).
hid.Mouse.prototype.poll = function () {
    var out = [];
    if (!this.listening) return out;
    var r;
    while ((r = usb.readReport(this.h, this.ep)) !== null) {
        var d = hid.decodeMouse(r);
        this.x += d.dx;
        this.y += d.dy;
        if (this.x < 0) this.x = 0; if (this.x > 239) this.x = 239;
        if (this.y < 0) this.y = 0; if (this.y > 319) this.y = 319;
        this.buttons = d.buttons;
        this.wheel = d.wheel;
        out.push({ x: this.x, y: this.y, buttons: this.buttons, wheel: d.wheel });
    }
    return out;
};

hid.Mouse.prototype.close = function () {
    if (this.listening) usb.stopListen(this.h, this.ep);
    var ok = usb.close(this.h);
    this.h = null;
    return ok;
};

module.exports = hid;
