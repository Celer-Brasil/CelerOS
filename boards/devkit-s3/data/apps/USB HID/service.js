// USB HID — servico de fundo do devkit-s3 (API 48).
//
// Teclado e mouse USB viram eventos do OS: Input.key (usage ID HID cru) e
// Input.move (ponteiro no espaco virtual 240x320). Qualquer app com a
// permission "input" le com Input.poll()/Input.pointer(); em placa com tela
// o ponteiro tambem entra no pipeline de toque do Kui.
//
// Nenhum driver de HID mora no firmware: este arquivo decodifica o boot
// report (8 bytes de teclado, 3-4 de mouse) e faz o diff entre reports.
// Roda no svchost: NAO desenha, NAO chama present() — so timers e USB/Input.

var kbd = null;     // {addr, iface, ep, keys, mods}
var mouse = null;   // {addr, iface, ep, x, y, buttons}
var lastScan = 0;

function ifaceOf(dev, proto) {
  for (var i = 0; i < dev.ifs.length; i++) {
    var f = dev.ifs[i];
    if (f.cls !== 3 || f.subcls !== 1 || f.proto !== proto) continue;
    for (var e = 0; e < f.eps.length; e++) {
      if (f.eps[e].type === 3 && (f.eps[e].addr & 0x80)) return f;
    }
  }
  return null;
}

function epIn(iface) {
  for (var e = 0; e < iface.eps.length; e++) {
    if (iface.eps[e].type === 3 && (iface.eps[e].addr & 0x80)) return iface.eps[e].addr;
  }
  return -1;
}

function closeKbd() {
  if (!kbd) return;
  USB.unlisten(kbd.addr, kbd.ep);
  USB.release(kbd.addr, kbd.iface);
  kbd = null;
}

function closeMouse() {
  if (!mouse) return;
  USB.unlisten(mouse.addr, mouse.ep);
  USB.release(mouse.addr, mouse.iface);
  mouse = null;
}

function openDev(dev, proto) {
  var f = ifaceOf(dev, proto);
  if (!f) return null;
  var ep = epIn(f);
  if (ep < 0) return null;
  if (!USB.claim(dev.addr, f.n, f.alt)) return null;
  return { addr: dev.addr, iface: f.n, ep: ep };
}

// Modificadores do boot report -> usage IDs 0xE0..0xE7 (Ctrl/Shift/Alt/GUI).
var MOD_USAGE = [0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7];

function pushMods(prev, next) {
  for (var b = 0; b < 8; b++) {
    var was = (prev & (1 << b)) !== 0;
    var now = (next & (1 << b)) !== 0;
    if (was !== now) Input.key(MOD_USAGE[b], next, now);
  }
}

function has(arr, v) {
  for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true;
  return false;
}

function pollKeyboard() {
  var r;
  while ((r = USB.read(kbd.addr, kbd.ep)) !== null) {
    var mods = r[0] || 0;
    var keys = [];
    for (var i = 2; i < 8 && i < r.length; i++) if (r[i]) keys.push(r[i]);
    pushMods(kbd.mods, mods);
    // solta primeiro: uma tecla que saiu e voltou no mesmo report nao existe
    for (var a = 0; a < kbd.keys.length; a++) {
      if (!has(keys, kbd.keys[a])) Input.key(kbd.keys[a], mods, false);
    }
    for (var b = 0; b < keys.length; b++) {
      if (!has(kbd.keys, keys[b])) Input.key(keys[b], mods, true);
    }
    kbd.keys = keys;
    kbd.mods = mods;
  }
}

function s8(v) {
  v = v & 0xFF;
  return v > 127 ? v - 256 : v;
}

function pollMouse() {
  var r;
  while ((r = USB.read(mouse.addr, mouse.ep)) !== null) {
    mouse.buttons = r[0] || 0;
    mouse.x += s8(r[1] || 0);
    mouse.y += s8(r[2] || 0);
    if (mouse.x < 0) mouse.x = 0;
    if (mouse.x > 239) mouse.x = 239;
    if (mouse.y < 0) mouse.y = 0;
    if (mouse.y > 319) mouse.y = 319;
    Input.move(mouse.x, mouse.y, mouse.buttons);
  }
}

function scan(force) {
  var now = System.millis();
  if (!force && now - lastScan < 2000) return;
  lastScan = now;
  var devs = USB.devices();
  var seenK = false, seenM = false;
  var i;

  for (i = 0; i < devs.length; i++) {
    var d = devs[i];
    if (kbd && d.addr === kbd.addr) seenK = true;
    if (mouse && d.addr === mouse.addr) seenM = true;
  }
  if (kbd && !seenK) closeKbd();
  if (mouse && !seenM) closeMouse();

  for (i = 0; i < devs.length; i++) {
    if (!kbd) {
      var k = openDev(devs[i], 1);
      if (k) {
        if (USB.listen(k.addr, k.ep, 8, 8)) {
          k.keys = [];
          k.mods = 0;
          kbd = k;
        } else {
          USB.release(k.addr, k.iface);
        }
      }
    }
    if (!mouse) {
      var m = openDev(devs[i], 2);
      if (m) {
        if (USB.listen(m.addr, m.ep, 4, 8)) {
          m.x = 120;
          m.y = 160;
          m.buttons = 0;
          mouse = m;
        } else {
          USB.release(m.addr, m.iface);
        }
      }
    }
  }
}

function tick() {
  if (typeof USB === "undefined" || typeof Input === "undefined") return;
  var dirty = false;
  var ev;
  while ((ev = USB.poll()) !== null) dirty = true;
  scan(dirty);
  if (kbd) pollKeyboard();
  if (mouse) pollMouse();
}

// 20 ms: teclado/mouse parecem instantaneos sem gastar o pump do svchost.
setInterval(tick, 20);
