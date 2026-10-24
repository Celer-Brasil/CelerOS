

















var usb = { version: '1.0.0' };


usb.available = function () {
return typeof USB !== "undefined" && System.getInfo().hasUsbHost === true;
};




usb.devices = function () {
if (!usb.available()) return [];
return USB.devices();
};



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


usb.close = function (h) {
if (!h) return false;
return USB.release(h.addr, h.iface.n);
};


usb.write = function (h, data, timeoutMs) {
if (!h || h.epOut < 0) return { ok: false, status: "error", sent: 0 };
return USB.out(h.addr, h.epOut, data, timeoutMs);
};

usb.read = function (h, len, timeoutMs) {
if (!h || h.epIn < 0) return { ok: false, status: "error", len: 0, data: [] };
return USB.in(h.addr, h.epIn, len, timeoutMs);
};


usb.printFile = function (h, path, maxBytes) {
if (!h || h.epOut < 0) return { ok: false, status: "error", sent: 0 };
return USB.sendFile(h.addr, h.epOut, path, maxBytes);
};


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


usb.poll = function () {
if (!usb.available()) return null;
return USB.poll();
};




usb.bytes = function (s) {
var out = [];
s = String(s);
for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF);
return out;
};

usb.ascii = usb.bytes;


usb.hex = function (s) {
var out = [];
s = String(s).replace(/[^0-9A-Fa-f]/g, "");
if (s.length & 1) s = "0" + s;
for (var i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
return out;
};



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
