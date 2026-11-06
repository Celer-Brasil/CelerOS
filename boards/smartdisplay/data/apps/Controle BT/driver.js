// driver.js — mapeamento PURO entre o estado normalizado da dep
// celeros.gamepad e o barramento do OS (Input.pad/Input.move). Sem globais
// de device: testavel no harness (test/js_harness) com estados canned.
//
// Bitmask do canal InputBus::pad (doc: main/Hardware/InputBus.h):
//   bit0 A, 1 B, 2 X, 3 Y, 4 L1, 5 R1, 6 L2, 7 R2, 8 select, 9 start,
//   10 guide, 11 LS, 12 RS; dpad bit0 N, 1 E, 2 S, 3 W; eixos -127..127.

var driver = { version: '1.0.0' };

driver.BITS = {
    a: 1, b: 2, x: 4, y: 8, l1: 16, r1: 32, l2: 64, r2: 128,
    select: 256, start: 512, guide: 1024, ls: 2048, rs: 4096
};
driver.DPAD = { n: 1, e: 2, s: 4, w: 8 };
// clique do ponteiro = R2 (A fica reservado para "confirmar" no foco)
driver.CLICK_BIT = driver.BITS.r2;

// estado da dep ({buttons:{a..}, dpad:"ne", lx..ry em -1..1}) -> canal
driver.toBus = function (st) {
    var bits = 0, d = 0;
    for (var k in driver.BITS) {
        if (st.buttons && st.buttons[k]) bits |= driver.BITS[k];
    }
    if (st.dpad && st.dpad.length) {
        if (st.dpad.indexOf('n') >= 0) d |= driver.DPAD.n;
        if (st.dpad.indexOf('e') >= 0) d |= driver.DPAD.e;
        if (st.dpad.indexOf('s') >= 0) d |= driver.DPAD.s;
        if (st.dpad.indexOf('w') >= 0) d |= driver.DPAD.w;
    }
    return {
        buttons: bits,
        dpad: d,
        lx: Math.round((st.lx || 0) * 127),
        ly: Math.round((st.ly || 0) * 127),
        rx: Math.round((st.rx || 0) * 127),
        ry: Math.round((st.ry || 0) * 127)
    };
};

// stick direito -> ponteiro absoluto 240x320; R2 = clique (bit0 do
// Input.move). NAO muta cur: devolve {x, y, click} e o chamador grava.
// dtMs e o intervalo do drain do servico (25 ms).
driver.toPointer = function (st, cur, dtMs, box) {
    var w = (box && box.w) || 240;
    var h = (box && box.h) || 320;
    var vmax = 420;  // px/s com o stick no talo
    var nx = cur.x + Math.round((st.rx || 0) * vmax * dtMs / 1000);
    var ny = cur.y + Math.round((st.ry || 0) * vmax * dtMs / 1000);
    if (nx < 0) nx = 0;
    if (nx > w - 1) nx = w - 1;
    if (ny < 0) ny = 0;
    if (ny > h - 1) ny = h - 1;
    return { x: nx, y: ny, click: (st.buttons && st.buttons.r2) ? 1 : 0 };
};

module.exports = driver;
