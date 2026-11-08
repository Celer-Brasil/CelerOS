// celeros.hid — teclado e mouse Bluetooth LE HID (HOGP) em JS.
//
// O firmware NAO decodifica report nenhum: entrega os bytes crus por
// BT.read(), o HID report descriptor cru por BT.reportMap() e o TIPO do
// device (kbd/mouse/combo/pad) por BT.state().kind. Este modulo reusa o
// parser do descriptor da dep celeros.gamepad (gramatica HID: itens
// main/global/local) e decodifica os reports de teclado e mouse.
//
//   var H = require("celeros.hid");
//   var d = H.setup();               // device conectado (BT.state ready)
//   var r = BT.read();
//   var out = d.feed(r);             // {kbd?} e/ou {mouse?}
//   if (out && out.kbd) Input.key(out.kbd.pressed[0], out.kbd.mods, true);
//   if (out && out.mouse) Input.move(x + out.mouse.dx, y + out.mouse.dy, out.mouse.buttons);
//
// Requer o global BT (API 57; placas com CELEROS_BLE_HID — SmartDisplay e
// watch) e permission "input" no app. Fones BT NAO existem aqui: o radio do
// S3 nao tem Bluetooth Classic (A2DP) nem ISO/LE Audio.
//
// Normalizacao:
//   kbd   - mods (byte HID), keys[] (usage IDs 0x04..), pressed/released
//           (usages que mudaram desde o feed anterior)
//   mouse - dx/dy/wheel (com sinal, sem aceleracao), buttons (bitmask 1..8),
//           pressed/released (numeros de botao)
//
// changelog:
//   0.1.0: primeira versao (teclado + mouse + combo, reusa parseMap do
//          celeros.gamepad 0.1.2 — a versao que corrigiu o sinal de Usage).

var G = require('celeros.gamepad');

var hid = { version: '0.1.0' };

var PAGE_GENERIC = 0x01, PAGE_KEYBOARD = 0x07, PAGE_BUTTON = 0x09;
var U_X = 0x30, U_Y = 0x31, U_WHEEL = 0x38;

// extrai um campo do report: bits LSB-first a partir de f.off (mesma regra do
// gamepad; o byte do report id ja esta contado no off quando o device usa id)
function extract(report, f) {
    var v = 0;
    for (var k = 0; k < f.bits; k++) {
        var bit = report[(f.off + k) >> 3];
        if (bit === undefined) return null;
        if (((bit >> ((f.off + k) & 7)) & 1) !== 0) v += Math.pow(2, k);
    }
    return v;
}

// campo com sinal (Logical Min < 0): complemento de dois
function signed(raw, f) {
    if (raw === null) return 0;
    if (f.min < 0 && raw >= Math.pow(2, f.bits - 1)) return raw - Math.pow(2, f.bits);
    return raw;
}

// report de ENTRADA com mais campos que passam no teste; devolve
// {id, fields} ou null. Um combo (teclado + mouse) tem um report por colecao.
function pickReport(map, test) {
    var best = null, bestN = 0, key, i;
    for (key in map.reports) {
        if (key.indexOf('|in') < 0) continue;
        var fs = map.reports[key], n = 0;
        for (i = 0; i < fs.length; i++) {
            if (test(fs[i])) n++;
        }
        if (n > bestN) {
            bestN = n;
            best = { id: parseInt(key.split('|')[0], 10) || 0, fields: fs };
        }
    }
    return best;
}

// ------------------------------------------------------------------ teclado
// Descriptor classico: modificadores (8 x 1 bit, usages 0xE0..0xE7) + N
// slots de 8+ bits com usage ID da tecla. Os slots de um array (Usage Min 0,
// Usage Max 0xFF) chegam com usage 0 do parser — o VALOR extraido e que e o
// usage da tecla, entao nao dependemos do usage declarado.
hid.keyboard = function (mapBytes) {
    if (!mapBytes || mapBytes.length === 0) return null;
    var map = G.parseMap(mapBytes);
    var rep = pickReport(map, function (f) { return f.page === PAGE_KEYBOARD; });
    if (!rep) return null;
    var modsFields = [], slots = [], i, f;
    for (i = 0; i < rep.fields.length; i++) {
        f = rep.fields[i];
        if (f.page !== PAGE_KEYBOARD) continue;
        if (f.bits === 1 && f.usage >= 0xE0 && f.usage <= 0xE7) modsFields.push(f);
        else if (f.bits >= 8) slots.push(f);
    }
    if (slots.length === 0) return null;
    var prev = [];
    return {
        id: rep.id,
        accepts: function (rid) { return rep.id === 0 || rid === rep.id; },
        feed: function (r) {
            if (!r || !(rep.id === 0 || r.id === rep.id)) return null;
            var m = 0, keys = [], i2, v;
            for (i2 = 0; i2 < modsFields.length; i2++) {
                if (extract(r.data, modsFields[i2])) m |= (1 << (modsFields[i2].usage - 0xE0));
            }
            for (i2 = 0; i2 < slots.length; i2++) {
                v = extract(r.data, slots[i2]);
                if (v) keys.push(v);
            }
            var pressed = [], released = [];
            for (i2 = 0; i2 < keys.length; i2++) {
                if (prev.indexOf(keys[i2]) < 0) pressed.push(keys[i2]);
            }
            for (i2 = 0; i2 < prev.length; i2++) {
                if (keys.indexOf(prev[i2]) < 0) released.push(prev[i2]);
            }
            prev = keys;
            return { mods: m, keys: keys, pressed: pressed, released: released };
        }
    };
};

// -------------------------------------------------------------------- mouse
// X/Y (e roda) com sinal + ate 8 botoes de 1 bit na pagina Button.
hid.mouse = function (mapBytes) {
    if (!mapBytes || mapBytes.length === 0) return null;
    var map = G.parseMap(mapBytes);
    var rep = pickReport(map, function (f) {
        return f.page === PAGE_GENERIC && (f.usage === U_X || f.usage === U_Y);
    });
    if (!rep) return null;
    var fx = null, fy = null, fw = null, btns = [], i, f;
    for (i = 0; i < rep.fields.length; i++) {
        f = rep.fields[i];
        if (f.page === PAGE_GENERIC && f.usage === U_X) fx = f;
        else if (f.page === PAGE_GENERIC && f.usage === U_Y) fy = f;
        else if (f.page === PAGE_GENERIC && f.usage === U_WHEEL) fw = f;
        else if (f.page === PAGE_BUTTON && f.bits === 1 && f.usage >= 1 && f.usage <= 8) btns.push(f);
    }
    if (fx === null && fy === null) return null;
    var prevMask = 0;
    return {
        id: rep.id,
        accepts: function (rid) { return rep.id === 0 || rid === rep.id; },
        feed: function (r) {
            if (!r || !(rep.id === 0 || r.id === rep.id)) return null;
            var mask = 0, i2, v;
            for (i2 = 0; i2 < btns.length; i2++) {
                if (extract(r.data, btns[i2])) mask |= (1 << (btns[i2].usage - 1));
            }
            var pressed = [], released = [];
            for (i2 = 0; i2 < 8; i2++) {
                var was = (prevMask & (1 << i2)) !== 0;
                var now = (mask & (1 << i2)) !== 0;
                if (now && !was) pressed.push(i2 + 1);
                if (!now && was) released.push(i2 + 1);
            }
            prevMask = mask;
            return {
                dx: fx ? signed(extract(r.data, fx), fx) : 0,
                dy: fy ? signed(extract(r.data, fy), fy) : 0,
                wheel: fw ? signed(extract(r.data, fw), fw) : 0,
                buttons: mask, pressed: pressed, released: released
            };
        }
    };
};

// ------------------------------------------------------------------- attach
// Um decoder do device conectado: monta teclado e/ou mouse do MESMO mapa e
// roteia cada report pelo id. Devolve null quando o descriptor nao tem
// nenhuma das duas colecoes (ex.: um gamepad — use celeros.gamepad).
hid.attach = function (mapBytes, kind) {
    var kb = hid.keyboard(mapBytes);
    var ms = hid.mouse(mapBytes);
    if (!kb && !ms) return null;
    return {
        kind: kind || (kb && ms ? 'combo' : (kb ? 'kbd' : 'mouse')),
        keyboard: kb,
        mouse: ms,
        // {kbd?: {...}, mouse?: {...}} ou null quando nenhum aceita o report
        feed: function (r) {
            if (!r) return null;
            var out = null;
            if (kb && kb.accepts(r.id)) {
                out = out || {};
                out.kbd = kb.feed(r);
            }
            if (ms && ms.accepts(r.id)) {
                out = out || {};
                out.mouse = ms.feed(r);
            }
            return out;
        }
    };
};

// decoder do device JA conectado (BT.state().phase === "ready")
hid.setup = function () {
    if (typeof BT === 'undefined') return null;
    var st = BT.state();
    if (!st || st.phase !== 'ready') return null;
    return hid.attach(BT.reportMap(), st.kind);
};

// ------------------------------------------------------------ sessao (BT)
// kind pelo appearance do ADV: so uma dica antes de conectar (teclado BLE
// barato anuncia 0x0000). O tipo OFICIAL vem de BT.state().kind depois.
hid.kindOfAppearance = function (app) {
    if (app === 0x03C1) return 'kbd';
    if (app === 0x03C2) return 'mouse';
    if (app === 0x03C3 || app === 0x03C4) return 'pad';
    return '';
};

// HID devices do ultimo scan, com o tipo (nativo ou pelo appearance)
hid.devices = function () {
    var out = [];
    if (typeof BT === 'undefined') return out;
    var list = BT.scanResults();
    for (var i = 0; i < list.length; i++) {
        var d = list[i];
        out.push({
            addr: d.addr, name: d.name, rssi: d.rssi,
            kind: d.kind || hid.kindOfAppearance(d.appearance),
            appearance: d.appearance
        });
    }
    return out;
};

hid.scan = function (ms) {
    if (typeof BT === 'undefined') return [];
    BT.scan(ms || 3000);
    return hid.devices();
};

hid.connect = function (addr) {
    if (typeof BT === 'undefined') return { ok: false, err: 'sem BT neste firmware' };
    return BT.connect(addr);
};

hid.disconnect = function () {
    if (typeof BT === 'undefined') return false;
    return BT.disconnect();
};

// estado do enlace + tipo (atalho para as telas)
hid.device = function () {
    if (typeof BT === 'undefined') return null;
    return BT.state();
};

hid.kind = function () {
    var st = hid.device();
    return (st && st.kind) || '';
};

module.exports = hid;
