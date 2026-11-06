// celeros.gamepad — gamepad Bluetooth LE HID (HOGP) em JS.
//
// O firmware NAO decodifica report nenhum: entrega os bytes crus por
// BT.read(), o HID report descriptor cru por BT.reportMap() e a lista de
// reports por BT.state(). Este modulo faz o parser do descriptor (grammar
// HID: items main/global/local), decodifica os reports de entrada e monta
// os reports de saida (rumble).
//
//   var pad = require("celeros.gamepad");
//   var pads = pad.scan(3000);       // [{addr, name, rssi, gamepad}]
//   pad.connect(pads[0].addr);
//   var gp = pad.setup();            // parser do reportMap do pad conectado
//   var st = gp.poll();              // estado normalizado ou null
//   if (st.buttons.a) ...
//   gp.rumble(0.4, 0.8, 300);
//
// Requer o global BT (API 57; placas com CELEROS_BLE_HID — SmartDisplay e
// watch) e permission "input" no app. Pads testaveis em modo BLE: Xbox One
// S/Series, 8bitdo em modo BLE. O DualShock 4 e Bluetooth CLASSIC (o radio
// S3 nao tem) e NAO funciona aqui.
//
// Normalizacao:
//   lx/ly/rx/ry  -1..1 (deadzone aplicada; para cima = negativo)
//   l2/r2        0..1 (gatilhos analogicos, quando o pad os traz assim)
//   dpad         "n","ne","e","se","s","sw","w","nw" ou ""
//   buttons      {a,b,x,y,l1,r1,select,start,guide,ls,rs} + extras em
//                buttons.b<n> (numero do uso na pagina Button)
//   pressed/released  nomes que mudaram desde o poll() anterior
//
// changelog:
//   0.1.0: primeira versao (parser HID + decodificador + rumble Xbox BLE).
//   0.1.1: items constant (padding) agora avancam o offset em bits — pads
//          reais que fecham byte com Input (Const) entre hat e botoes tinham
//          todos os campos seguintes deslocados (botoes trocados/fantasmas).

var gamepad = { version: '0.1.1' };

// ---------------------------------------------------------------------------
// itens do descriptor HID: byte 0 = size(0..1) | type(2..3) | tag(4..7)
// size: 0 -> 0 bytes, 1 -> 1, 2 -> 2, 3 -> 4.
var IT_INPUT = 0x80, IT_OUTPUT = 0x90, IT_FEATURE = 0xB0;
var IT_COLLECTION = 0xA0, IT_ENDCOLLECTION = 0xC0;
var IG_USAGE_PAGE = 0x04, IG_LOGICAL_MIN = 0x14, IG_LOGICAL_MAX = 0x24;
var IG_REPORT_SIZE = 0x74, IG_REPORT_ID = 0x84, IG_REPORT_COUNT = 0x94;
var IG_PUSH = 0xA4, IG_POP = 0xB4;
var IL_USAGE = 0x08, IL_USAGE_MIN = 0x18, IL_USAGE_MAX = 0x28;

// paginas de uso
var PAGE_GENERIC = 0x01, PAGE_BUTTON = 0x09;
// usos da pagina Generic Desktop
var U_HAT = 0x39;
var U_LX = 0x30, U_LY = 0x31, U_RX = 0x32, U_L2 = 0x33, U_RY = 0x34, U_RZ = 0x35;

// tamanho de um item pelo codigo de size
function itemLen(code) {
    if (code === 0) return 0;
    if (code === 1) return 1;
    if (code === 2) return 2;
    return 4;
}

// valor (little-endian) com sinal: globals (min/max) sao assinados
function readValue(buf, i, bytes) {
    var v = 0, shift = 0, b;
    for (var k = 0; k < bytes; k++) {
        b = buf[i + k] || 0;
        v += b * Math.pow(2, shift);   // sem << em 32 bits: 4 bytes estoura
        shift += 8;
    }
    var bits = bytes * 8;
    if (bytes < 4 && v >= Math.pow(2, bits - 1)) v -= Math.pow(2, bits);
    return v;
}

// ---------------------------------------------------------------------------
// parser: devolve {reports: {"id|tipo" -> [campos]}, ids: [..]} onde cada
// campo e {t:'in'|'out'|'feat', id, page, usage, off, bits, min, max} e off
// e em BITS (LSB-first).
gamepad.parseMap = function (map) {
    var reports = {};        // "id|tipo" -> [campos]
    var curId = 0;           // 0 = descriptor sem report id
    var g = { page: 0, min: 0, max: 0, size: 0, count: 0 };
    var stack = [];
    var usages = [];
    var uMin = -1, uMax = -1;
    var offs = { in: {}, out: {}, feat: {} };    // offsets em bits por id
    var i = 0, n = map.length;
    while (i < n) {
        var b = map[i];
        var bytes = itemLen(b & 3);
        var tag = b & 0xFC;
        var val = bytes > 0 ? readValue(map, i + 1, bytes) : 0;
        i += 1 + bytes;
        if (tag === IG_USAGE_PAGE) { g.page = val; continue; }
        if (tag === IG_LOGICAL_MIN) { g.min = val; continue; }
        if (tag === IG_LOGICAL_MAX) { g.max = val; continue; }
        if (tag === IG_REPORT_SIZE) { g.size = val; continue; }
        if (tag === IG_REPORT_ID) { curId = val; continue; }
        if (tag === IG_REPORT_COUNT) { g.count = val; continue; }
        if (tag === IG_PUSH) { stack.push(JSON.stringify(g)); continue; }
        if (tag === IG_POP) {
            if (stack.length > 0) {
                var s = JSON.parse(stack.pop());
                g.page = s.page; g.min = s.min; g.max = s.max;
                g.size = s.size; g.count = s.count;
            }
            continue;
        }
        if (tag === IL_USAGE) {
            usages.push(val < 0x10000 ? ((g.page << 16) | val) : val);
            continue;
        }
        if (tag === IL_USAGE_MIN) {
            uMin = val < 0x10000 ? ((g.page << 16) | val) : val;
            continue;
        }
        if (tag === IL_USAGE_MAX) {
            uMax = val < 0x10000 ? ((g.page << 16) | val) : val;
            continue;
        }
        if (tag === IT_COLLECTION || tag === IT_ENDCOLLECTION) {
            usages = []; uMin = uMax = -1;
            continue;
        }
        var kind = null;
        if (tag === IT_INPUT) kind = 'in';
        else if (tag === IT_OUTPUT) kind = 'out';
        else if (tag === IT_FEATURE) kind = 'feat';
        else continue;   // desconhecido: size esta no byte 0, pula inteiro
        var isConst = (val & 0x01) !== 0;   // flag constant vai no DADO do item
        // items constant ocupam bits no report mesmo sem dado (HID 6.2.2.4:
        // padding para fechar byte) — o offset tem que avancar POR ELES
        // tambem, senao todo campo depois do padding sai deslocado (pads
        // reais enchem byte com Input (Const) entre hat e botoes)
        if (g.size > 0 && g.count > 0) {
            if (offs[kind][curId] === undefined) {
                // o byte do report id ocupa os 8 primeiros bits do report
                offs[kind][curId] = curId ? 8 : 0;
            }
            if (!isConst) {
                var key = String(curId) + '|' + kind;
                if (reports[key] === undefined) reports[key] = [];
                var expanded = usages.slice();
                if (expanded.length === 0 && uMin >= 0 && uMax >= 0 && uMax >= uMin) {
                    for (var u = uMin; u <= uMax; u++) expanded.push(u);
                }
                var per = expanded.length > 0 ? expanded : null;
                for (var c = 0; c < g.count; c++) {
                    var page = g.page, usage = 0;
                    if (per !== null && per.length === g.count) {
                        page = (per[c] >> 16) & 0xFFFF;
                        usage = per[c] & 0xFFFF;
                    } else if (per !== null && per.length > 0) {
                        // menos usos que count: o 1o uso cobre o grupo (hat,
                        // tri-axis, bloco anonimo de vendor)
                        page = (per[0] >> 16) & 0xFFFF;
                        usage = per[0] & 0xFFFF;
                    }
                    if (page === 0) page = g.page;
                    reports[key].push({
                        t: kind, id: curId, page: page, usage: usage,
                        off: offs[kind][curId] || 0, bits: g.size,
                        min: g.min, max: g.max
                    });
                    offs[kind][curId] = (offs[kind][curId] || 0) + g.size;
                }
            } else {
                // padding: nada para emitir, mas os bits existem no report
                offs[kind][curId] += g.size * g.count;
            }
        }
        usages = []; uMin = uMax = -1;   // locals morrem depois do main item
    }
    var ids = [];
    for (var kk in reports) {
        var id = kk.split('|')[0];
        if (ids.indexOf(id) < 0) ids.push(id);
    }
    return { reports: reports, ids: ids };
};

// extrai um campo do report: bits LSB-first a partir de off
function extract(report, f) {
    var v = 0;
    for (var k = 0; k < f.bits; k++) {
        var bit = report[(f.off + k) >> 3];
        if (bit === undefined) return null;
        if (((bit >> ((f.off + k) & 7)) & 1) !== 0) v += Math.pow(2, k);
    }
    return v;
}

// normaliza um eixo -1..1 com deadzone
gamepad.axis = function (raw, dead) {
    var v = raw;
    if (v > dead) v = (v - dead) / (1 - dead);
    else if (v < -dead) v = (v + dead) / (1 - dead);
    else return 0;
    return v < -1 ? -1 : (v > 1 ? 1 : v);
};

var DPAD = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

// nomes normalizados: ordem tipica de um pad estilo Xbox (indice = numero do
// uso na pagina Button). Pads com ordem diferente caem nos nomes b<n> brutos
// tambem expostos.
var BTN_NAMES = ['a', 'b', 'x', 'y', 'l1', 'r1', 'select', 'start', 'guide', 'ls', 'rs'];

function fieldOf(fields, page, usage, wantMinPositive) {
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.page !== page || f.usage !== usage) continue;
        if (wantMinPositive === true && f.min < 0) continue;
        if (wantMinPositive === false && f.min >= 0) continue;
        return f;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Gamepad: um pad conectado com o layout parseado
gamepad.Gamepad = function () {
    this.map = null;
    this.mainId = 0;      // id do report principal (sticks/botoes); 0 = sem id
    this.mainHasId = false;
    this.inFields = [];
    // plano de eixos resolvido no setup (referencias diretas aos campos)
    this.fLx = this.fLy = this.fRx = this.fRy = null;
    this.fL2 = this.fR2 = this.fHat = null;
    this.outId = 0;       // id do report de output (0 = sem id)
    this.outLen = 0;      // bytes do report de output
    this.profile = 'generic';
    this.dead = 0.10;
    this.connected = false;
    this.name = '';
    this.state = null;
    this.prevBtns = {};
};

// parse do reportMap do pad conectado + plano de eixos/botoes.
gamepad.Gamepad.prototype.setup = function () {
    var mapBytes = BT.reportMap();
    if (!mapBytes || mapBytes.length === 0) return false;
    this.map = gamepad.parseMap(mapBytes);
    var bestKey = null, bestCount = 0, key, i;
    for (key in this.map.reports) {
        if (key.indexOf('|in') < 0) continue;
        var fields = this.map.reports[key];
        var used = 0;
        for (i = 0; i < fields.length; i++) {
            if (fields[i].usage !== 0) used++;
        }
        if (used > bestCount) { bestCount = used; bestKey = key; }
    }
    if (bestKey === null) return false;
    this.mainId = parseInt(bestKey.split('|')[0], 10) || 0;
    this.mainHasId = this.mainId !== 0;
    this.inFields = this.map.reports[bestKey];

    // plano de eixos: sticks X/Y sempre; RX = Z(0x32); RY prefere RZ(0x35),
    // cai para RY(0x34) se ela for eixo com sinal; gatilhos = 0x33/0x34
    // SEM sinal (0..1023 no Xbox BLE) quando 0x34 nao virou RY.
    this.fLx = fieldOf(this.inFields, PAGE_GENERIC, U_LX);
    this.fLy = fieldOf(this.inFields, PAGE_GENERIC, U_LY);
    this.fRx = fieldOf(this.inFields, PAGE_GENERIC, U_RX);
    this.fRy = fieldOf(this.inFields, PAGE_GENERIC, U_RZ);
    if (this.fRy === null) {
        var r34 = fieldOf(this.inFields, PAGE_GENERIC, U_RY);
        if (r34 !== null && r34.min < 0) this.fRy = r34;
    }
    this.fL2 = fieldOf(this.inFields, PAGE_GENERIC, U_L2, true);
    if (this.fRy === null || fieldOf(this.inFields, PAGE_GENERIC, U_RZ) !== null) {
        this.fR2 = fieldOf(this.inFields, PAGE_GENERIC, U_RY, true);
    } else {
        this.fR2 = null;   // 0x34 ja e o eixo do stick direito
    }
    this.fHat = fieldOf(this.inFields, PAGE_GENERIC, U_HAT);

    // output maior = report de rumble
    var outKey = null, outBits = 0;
    for (var kk in this.map.reports) {
        if (kk.indexOf('|out') < 0) continue;
        var fs = this.map.reports[kk];
        var bits = 0, j;
        for (j = 0; j < fs.length; j++) bits += fs[j].bits;
        if (bits > outBits) { outBits = bits; outKey = kk; }
    }
    if (outKey !== null) {
        this.outId = parseInt(outKey.split('|')[0], 10) || 0;
        this.outLen = (outBits + 7) >> 3;
    }

    var info = BT.state();
    if (info && info.name) {
        var nm = info.name.toLowerCase();
        if (nm.indexOf('xbox') >= 0) this.profile = 'xbox';
    }
    this.connected = true;
    return true;
};

// decodifica um report do report principal no estado normalizado
gamepad.Gamepad.prototype.decode = function (report) {
    var st = {
        lx: 0, ly: 0, rx: 0, ry: 0, l2: 0, r2: 0, dpad: '',
        buttons: {}, pressed: [], released: [],
        b: [], battery: -1
    };
    var span, sv, raw, norm, i, f, v;
    for (i = 0; i < this.inFields.length; i++) {
        f = this.inFields[i];
        if (f.page === PAGE_BUTTON && f.usage > 0) {
            v = extract(report, f);
            if (v === null) continue;
            if (v) {
                var nm = BTN_NAMES[f.usage - 1] || ('b' + f.usage);
                st.buttons[nm] = true;
                st.b.push(nm);
            }
        }
    }
    // eixo com sinal (DS4: -127..127) ou sem (Xbox: 0..255): ambos viram
    // -1..1 centrado no meio do span
    function center(f, report) {
        raw = extract(report, f);
        if (raw === null) return 0;
        sv = f.min < 0 ? (raw >= Math.pow(2, f.bits - 1) ? raw - Math.pow(2, f.bits) : raw) : raw;
        span = f.max - f.min;
        if (span <= 0) return 0;
        return (sv - f.min) / span * 2 - 1;
    }
    if (this.fLx) st.lx = gamepad.axis(center(this.fLx, report), this.dead);
    if (this.fLy) st.ly = gamepad.axis(center(this.fLy, report), this.dead);
    if (this.fRx) st.rx = gamepad.axis(center(this.fRx, report), this.dead);
    if (this.fRy) st.ry = gamepad.axis(center(this.fRy, report), this.dead);
    // gatilhos: 0..1 do min..max (HID gamepad: solto = min)
    if (this.fL2) {
        raw = extract(report, this.fL2);
        span = this.fL2.max - this.fL2.min;
        st.l2 = raw === null || span <= 0 ? 0 : (raw - this.fL2.min) / span;
    }
    if (this.fR2) {
        raw = extract(report, this.fR2);
        span = this.fR2.max - this.fR2.min;
        st.r2 = raw === null || span <= 0 ? 0 : (raw - this.fR2.min) / span;
    }
    if (this.fHat) {
        v = extract(report, this.fHat);
        if (v !== null && v >= 0 && v < 8) st.dpad = DPAD[v];
    }
    return st;
};

// drena BT.read() e devolve o estado novo (ou null sem dado/novo report)
gamepad.Gamepad.prototype.poll = function () {
    if (!this.connected) return null;
    var st = null;
    var r;
    while ((r = BT.read()) !== null) {
        if (this.mainHasId && r.id !== this.mainId) continue;   // vendor/bateria
        st = this.decode(r.data);
    }
    if (st === null) return null;
    var prev = this.prevBtns;
    var kk;
    for (kk in st.buttons) {
        if (!prev[kk]) st.pressed.push(kk);
    }
    for (kk in prev) {
        if (!st.buttons[kk]) st.released.push(kk);
    }
    this.prevBtns = st.buttons;
    this.state = st;
    return st;
};

// ultimo estado (sem drenar)
gamepad.Gamepad.prototype.state = function () { return this.state; };

// monta o report de output do rumble. Xbox BLE (GIP haptics): report do
// output com [id, 0x00, pequeno, grande, 0xFF, duracao]; generic: bytes 1/2.
gamepad.Gamepad.prototype.rumble = function (small, big, ms) {
    if (!this.connected || this.outLen === 0) return false;
    var buf = [];
    if (this.outId) buf.push(this.outId & 0xFF);
    if (this.profile === 'xbox') {
        buf.push(0x00);
        buf.push(Math.round((small || 0) * 255) & 0xFF);
        buf.push(Math.round((big || 0) * 255) & 0xFF);
        buf.push(0xFF);
        buf.push(0x00);
        buf.push(Math.round((ms || 0) / 2.5) & 0xFF);   // unidades de 2,5 ms
    } else if (buf.length === 0) {
        buf.push(Math.round((small || 0) * 255) & 0xFF);
        buf.push(Math.round((big || 0) * 255) & 0xFF);
    }
    while (buf.length < this.outLen) buf.push(0x00);
    var r = BT.write(buf);
    return !!(r && r.ok);
};

// ---------------------------------------------------------------------------
// helpers de sessao (scan/setup direto pelo global BT)

// lista de HID devices do ultimo scan; gamepad true por appearance 0x03C4
gamepad.pads = function () {
    var out = [];
    var list = typeof BT !== 'undefined' ? BT.scanResults() : [];
    for (var i = 0; i < list.length; i++) {
        var d = list[i];
        out.push({
            addr: d.addr, name: d.name, rssi: d.rssi,
            gamepad: d.appearance === 0x03C4,
            hid: true
        });
    }
    return out;
};

gamepad.scan = function (ms) {
    if (typeof BT === 'undefined') return [];
    BT.scan(ms || 3000);
    return gamepad.pads();
};

gamepad.connect = function (addr) {
    if (typeof BT === 'undefined') return { ok: false, err: 'sem BT' };
    return BT.connect(addr);
};

gamepad.disconnect = function () {
    if (typeof BT === 'undefined') return;
    BT.disconnect();
};

// cria o Gamepad do pad conectado agora
gamepad.setup = function () {
    if (typeof BT === 'undefined') return null;
    var info = BT.state();
    if (!info || info.phase !== 'ready') return null;
    var g = new gamepad.Gamepad();
    g.name = info.name || '';
    if (!g.setup()) return null;
    return g;
};

module.exports = gamepad;
