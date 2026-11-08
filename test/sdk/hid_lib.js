// Testes da dep celeros.hid (teclado e mouse Bluetooth LE HID/HOGP, API 62)
// no host. Carrega o modulo pelo require do harness (mesma semantica do
// firmware) com um global BT falso controlavel: mapa de reports injetado,
// reports canned na fila e estado do enlace. Os descriptors de fixture sao
// os reais de um teclado HOGP e de um mouse 3 botoes + roda.

'use strict';

var path = require('path');

module.exports = function (check) {
    var ROOT = path.resolve(__dirname, '..', '..');
    var harness = require('../js_harness/run.js');
    var ENGINE_DIR = path.join(ROOT, 'tools', 'sdk', 'engine');

    function hex(s) {
        var out = [];
        var t = s.replace(/[^0-9A-Fa-f]/g, '');
        for (var i = 0; i < t.length; i += 2) out.push(parseInt(t.substr(i, 2), 16));
        return out;
    }

    // Teclado HOGP: report id 1, 8 modificadores + 6 slots de 8 bits.
    var KBD_MAP = hex(
        '05 01 09 06 A1 01 85 01' +
        '05 07 19 E0 29 E7 15 00 25 01 75 01 95 08 81 02' +
        '95 01 75 08 81 03' +
        '95 06 75 08 15 00 25 65 05 07 19 00 29 65 81 00' +
        'C0'
    );

    // Mouse: report id 2, 3 botoes + X/Y/roda assinados (-127..127).
    var MOUSE_MAP = hex(
        '05 01 09 02 A1 01 85 02 09 01 A1 00' +
        '05 09 19 01 29 03 15 00 25 01 95 03 75 01 81 02' +
        '95 01 75 05 81 03' +
        '05 01 09 30 09 31 09 38 15 81 25 7F 75 08 95 03 81 06' +
        'C0 C0'
    );

    // Combo (K400 e afins): as duas colecoes no mesmo mapa, ids 1 e 2.
    var COMBO_MAP = KBD_MAP.concat(MOUSE_MAP);

    // [id, mods, reservado, ate 6 usage IDs]
    var KBD_A = [1, 0x02, 0, 0x04, 0, 0, 0, 0, 0];        // Shift + A
    var KBD_AB = [1, 0x02, 0, 0x04, 0x05, 0, 0, 0, 0];    // + B
    var KBD_NONE = [1, 0x00, 0, 0, 0, 0, 0, 0, 0];        // soltou tudo

    // [id, botoes, dx, dy, roda]
    var MOU_1 = [2, 0x01, 0x05, 0xFB, 0x00];   // botao 1, dx 5, dy -5
    var MOU_2 = [2, 0x00, 0xFF, 0x02, 0x01];   // soltou, dx -1, dy 2, roda 1

    function setup(map, kind, name) {
        var env = harness.makeEnv();
        var H = env.__harness;
        H.btReset();
        if (map) H.btSetMap(map);
        H.btSetState({ phase: 'ready', addr: 'AA:BB:CC:DD:EE:01',
                       name: name || 'Device', kind: kind || '' });
        var req = harness.makeRequire(ENGINE_DIR, env);
        return { env: env, H: H, req: req };
    }

    (function () {
        console.log('SDK hid:');

        var t = setup(KBD_MAP, 'kbd', 'Teclado BLE');
        var H = t.req('celeros.hid');
        check('hid: exporta version', typeof H.version === 'string' && !!H.version,
              String(H.version));
        check('hid: kind vem do BT.state (nativo)', H.kind() === 'kbd', H.kind());

        // ------------------------------------------------- teclado --------
        var kb = H.keyboard(KBD_MAP);
        check('hid: keyboard monta do descriptor', kb !== null && kb.id === 1,
              'kb=' + !!kb + ' id=' + (kb && kb.id));

        var s = kb.feed({ id: 1, data: KBD_A });
        check('hid: mods do report (LShift) e tecla A',
              !!s && s.mods === 0x02 && s.keys.length === 1 && s.keys[0] === 0x04,
              JSON.stringify(s));
        check('hid: pressed na 1a leitura', !!s && s.pressed.length === 1 &&
              s.pressed[0] === 0x04, JSON.stringify(s && s.pressed));

        s = kb.feed({ id: 1, data: KBD_AB });
        check('hid: tecla nova vira pressed (B)', !!s && s.pressed.length === 1 &&
              s.pressed[0] === 0x05 && s.released.length === 0,
              JSON.stringify(s && [s.pressed, s.released]));
        check('hid: keys mantem A e B abertos',
              !!s && s.keys.length === 2 && s.keys[0] === 0x04 && s.keys[1] === 0x05,
              JSON.stringify(s && s.keys));

        s = kb.feed({ id: 1, data: KBD_NONE });
        check('hid: soltar tudo gera released das duas',
              !!s && s.released.length === 2 && s.keys.length === 0,
              JSON.stringify(s && s.released));

        check('hid: report de outro id e ignorado', kb.feed({ id: 9, data: KBD_A }) === null);

        // -------------------------------------------------- mouse ---------
        var ms = H.mouse(MOUSE_MAP);
        check('hid: mouse monta do descriptor', ms !== null && ms.id === 2,
              'ms=' + !!ms + ' id=' + (ms && ms.id));

        var m = ms.feed({ id: 2, data: MOU_1 });
        check('hid: botoes e dx positivo', !!m && m.buttons === 1 && m.dx === 5,
              JSON.stringify(m));
        check('hid: dy assinado (-5)', !!m && m.dy === -5, String(m && m.dy));
        check('hid: pressed do botao 1', !!m && m.pressed.length === 1 &&
              m.pressed[0] === 1, JSON.stringify(m && m.pressed));

        m = ms.feed({ id: 2, data: MOU_2 });
        check('hid: dx -1 e roda +1', !!m && m.dx === -1 && m.wheel === 1,
              JSON.stringify(m));
        check('hid: released do botao 1',
              !!m && m.released.length === 1 && m.released[0] === 1,
              JSON.stringify(m && m.released));

        // -------------------------------------------------- combo ---------
        var d = H.attach(COMBO_MAP, 'combo');
        check('hid: attach reconhece combo', !!d && d.kind === 'combo' &&
              !!d.keyboard && !!d.mouse, d && d.kind);

        var o = d.feed({ id: 1, data: KBD_A });
        check('hid: combo roteia report 1 para o teclado',
              !!o && !!o.kbd && o.mouse === undefined, JSON.stringify(o));
        o = d.feed({ id: 2, data: MOU_1 });
        check('hid: combo roteia report 2 para o mouse',
              !!o && !!o.mouse && o.kbd === undefined, JSON.stringify(o));
        check('hid: combo com report desconhecido devolve null',
              d.feed({ id: 7, data: [7, 0] }) === null);
        check('hid: feed sem report devolve null', d.feed(null) === null);

        // ------------------------------------------------ sessao ---------
        var devs = H.devices();
        t.H.btScan([
            { addr: 'AA:BB:CC:DD:EE:02', name: 'Teclado', rssi: -40, kind: 'kbd', appearance: 0 },
            { addr: 'AA:BB:CC:DD:EE:03', name: 'Mouse', rssi: -55, kind: '', appearance: 0x03C2 }
        ]);
        devs = H.devices();
        check('hid: devices usa o kind nativo', devs.length === 2 && devs[0].kind === 'kbd',
              JSON.stringify(devs));
        check('hid: devices cai no appearance quando falta kind',
              devs[1].kind === 'mouse', JSON.stringify(devs[1]));

        check('hid: kindOfAppearance mapeia a familia HID',
              H.kindOfAppearance(0x03C1) === 'kbd' &&
              H.kindOfAppearance(0x03C2) === 'mouse' &&
              H.kindOfAppearance(0x03C4) === 'pad' &&
              H.kindOfAppearance(0x0000) === '');

        var d2 = H.setup();
        check('hid: setup do device conectado monta o teclado',
              !!d2 && d2.kind === 'kbd' && !!d2.keyboard && !d2.mouse);

        t.H.btSetState({ phase: 'idle' });
        check('hid: setup fora de ready devolve null', H.setup() === null);

        // descriptor que nao e teclado nem mouse (gamepad)
        var gmap = hex('05 01 09 05 A1 01 09 39 15 00 25 07 75 04 95 01 81 42 ' +
                       '05 09 19 01 29 0A 15 00 25 01 75 01 95 0A 81 02 C0');
        check('hid: attach de descriptor de pad devolve null', H.attach(gmap) === null);
        check('hid: keyboard de um mapa vazio devolve null', H.keyboard([]) === null);
    })();
};
