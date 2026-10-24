
















var usb = require("celeros.usb");

var esc = { version: '1.1.0' };

var ESC = 0x1B;
var GS = 0x1D;
var FS = 0x1C;

esc.ESC = ESC;
esc.GS = GS;


esc.initCmd = function () { return [ESC, 0x40]; };
esc.feedCmd = function (n) { return [ESC, 0x64, (n || 1) & 0xFF]; };
esc.alignCmd = function (a) { return [ESC, 0x61, a & 0x03]; };
esc.boldCmd = function (on) { return [ESC, 0x45, on ? 1 : 0]; };
esc.underlineCmd = function (n) { return [ESC, 0x2D, (n || 0) & 0x03]; };
esc.reverseCmd = function (on) { return [GS, 0x42, on ? 1 : 0]; };


esc.sizeCmd = function (w, h) {
w = w || 1; h = h || 1;
if (w < 1) w = 1; if (w > 8) w = 8;
if (h < 1) h = 1; if (h > 8) h = 8;
return [GS, 0x21, (((w - 1) & 0x07) << 4) | ((h - 1) & 0x07)];
};
esc.cutCmd = function (partial) { return [GS, 0x56, partial ? 1 : 0]; };
esc.codepageCmd = function (n) { return [ESC, 0x74, n & 0xFF]; };
esc.drawerCmd = function (pin, onMs, offMs) {
return [ESC, 0x70, (pin || 0) & 1, (onMs || 25) & 0xFF, ((offMs || 250) / 2) & 0xFF];
};


esc.barcodeCmd = function (data) {
var b = usb.bytes(String(data).toUpperCase());
var out = [GS, 0x6B, 4];
for (var i = 0; i < b.length; i++) out.push(b[i]);
out.push(0);
return out;
};


esc.qrCmd = function (data, size, ec) {
var d = usb.bytes(data);
var len = d.length + 3;
var pL = len & 0xFF;
var pH = (len >> 8) & 0xFF;
var out = [];
out = usb.concat(out, [GS, 0x28, 0x6B, 4, 0, 0x31, 0x41, 0x32, 0]);
var s = size || 6;
if (s < 1) s = 1; if (s > 16) s = 16;
out = usb.concat(out, [GS, 0x28, 0x6B, 3, 0, 0x31, 0x43, s]);
out = usb.concat(out, [GS, 0x28, 0x6B, 3, 0, 0x31, 0x45, ec === undefined ? 49 : (48 + (ec & 3))]);
out = usb.concat(out, [GS, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30]);
for (var i = 0; i < d.length; i++) out.push(d[i]);
out = usb.concat(out, [GS, 0x28, 0x6B, 3, 0, 0x31, 0x51, 0x30]);
return out;
};




esc.open = function (dev) {
if (!dev) return null;
var iface = usb.ifaceOf(dev, 7);
var h = usb.open(dev, { iface: iface || undefined });
if (!h || h.epOut < 0) {
if (h) usb.close(h);
return null;
}
return new esc.Printer(h);
};

esc.openByVid = function (vid, pid) {
return esc.open(usb.find({ vid: vid, pid: pid }));
};

esc.Printer = function (h) {
this.h = h;
};


esc.Printer.prototype.raw = function (bytes) {
return usb.write(this.h, bytes, 2000);
};

esc.Printer.prototype.init = function () { this.raw(esc.initCmd()); return this; };
esc.Printer.prototype.text = function (s) { this.raw(usb.bytes(s)); return this; };
esc.Printer.prototype.line = function (s) {
this.raw(usb.concat(usb.bytes(s === undefined ? "" : s), [0x0A]));
return this;
};
esc.Printer.prototype.feed = function (n) { this.raw(esc.feedCmd(n)); return this; };
esc.Printer.prototype.align = function (a) { this.raw(esc.alignCmd(a)); return this; };
esc.Printer.prototype.bold = function (on) { this.raw(esc.boldCmd(on)); return this; };
esc.Printer.prototype.underline = function (n) { this.raw(esc.underlineCmd(n)); return this; };
esc.Printer.prototype.reverse = function (on) { this.raw(esc.reverseCmd(on)); return this; };
esc.Printer.prototype.size = function (w, h) { this.raw(esc.sizeCmd(w, h)); return this; };
esc.Printer.prototype.codepage = function (n) { this.raw(esc.codepageCmd(n)); return this; };
esc.Printer.prototype.barcode = function (data) { this.raw(esc.barcodeCmd(data)); return this; };
esc.Printer.prototype.qr = function (data, size, ec) { this.raw(esc.qrCmd(data, size, ec)); return this; };
esc.Printer.prototype.cut = function (partial) { this.raw(esc.cutCmd(partial)); return this; };
esc.Printer.prototype.drawer = function (pin) { this.raw(esc.drawerCmd(pin)); return this; };












esc.Printer.prototype.status = function (tries) {
if (this.h.epIn < 0) return null;
var n = tries || 3;
var ask = function (self, q) {
for (var t = 0; t < n; t++) {
if (!usb.write(self.h, [0x10, 0x04, q], 1000).ok) return -1;
var r = usb.read(self.h, 1, 1000);
if (r.ok && r.len > 0) return r.data[0];
}
return -1;
};
var s1 = ask(this, 1);
if (s1 < 0) return null;
var st = {
online: (s1 & 0x08) === 0,
erro: (s1 & 0x40) !== 0,
esperando: (s1 & 0x20) !== 0,
papel: false,
acabando: false,
raw1: s1,
raw2: -1
};
var s2 = ask(this, 2);
if (s2 >= 0) {
st.raw2 = s2;
st.papel = (s2 & 0x60) !== 0;
st.acabando = !st.papel && (s2 & 0x0C) !== 0;
}
return st;
};


esc.Printer.prototype.file = function (path, maxBytes) {
return usb.printFile(this.h, path, maxBytes);
};


esc.Printer.prototype.receipt = function (title, lines, qrText) {
this.init();
this.align(1).size(2, 2).bold(true).line(title || "CELER OS");
this.size(1, 1).bold(false).line("");
this.align(0);
for (var i = 0; i < (lines || []).length; i++) this.line(lines[i]);
this.feed(1);
if (qrText) this.align(1).qr(qrText, 5, 1);
this.align(0).feed(4).cut();
return this;
};

esc.Printer.prototype.close = function () {
var ok = usb.close(this.h);
this.h = null;
return ok;
};

module.exports = esc;
