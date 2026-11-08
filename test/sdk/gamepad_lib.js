// Testes da dep celeros.gamepad (gamepad Bluetooth LE HID/HOGP, API 57) no
// host. Carrega o modulo pelo require do harness (mesma semantica do
// firmware) com um global BT falso controlavel: mapa de reports injetado,
// reports canned na fila e writes capturados. Os descriptors de fixture
// seguem a gramatica HID (Xbox One S BLE: sticks 0..255, hat 4 bits, 15
// botoes de 1 bit, gatilhos 10 bits, report de rumble id 0x03).

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

    // Xbox One S BLE (simplificado): report 0x01 = sticks X/Y/Z/RZ (8 bits,
    // 0..255) + hat (4) + 15 botoes (1 bit cada) + gatilhos 33/34 (10 bits,
    // 0..1023) + vendor (8 bytes). Output id 0x03 com 10 bytes (rumble).
    var XBOX_MAP = hex(
        '05 01 09 05 A1 01' +               // GD / gamepad / collection app
        '85 01' +                            // report id 1
        'A1 00' +                            // collection physical
        '09 30 09 31 09 32 09 35' +          // X Y Z RZ
        '15 00 26 FF 00 75 08 95 04 81 02' + // min 0 max 255, 4x8, input
        'C0' +
        '09 39 15 00 25 07 75 04 95 01 81 42' + // hat 0..7, 4 bits
        '05 09 19 01 29 0F 15 00 25 01 75 01 95 0F 81 02' + // botoes 1..15
        '05 01 09 33 09 34' +                // RX RY (gatilhos)
        '15 00 27 FF 03 00 00 75 0A 95 02 81 02' + // 10 bits, max 1023
        '06 00 FF 09 20 75 08 95 08 81 02' + // vendor 8 bytes
        'C0' +
        '06 00 FF 09 21 A1 01' +             // collection app (output)
        '85 03' +                            // report id 3
        '09 97 15 00 26 FF 00 75 08 95 0A 91 02' + // 10x8 output
        'C0'
    );

    // DS4-like sem report id: sticks assinados (-127..127) + 8 botoes.
    var DS4_MAP = hex(
        '05 01 09 05 A1 01' +
        '09 30 09 31 09 32 09 35' +
        '15 81 25 7F 75 08 95 04 81 02' +    // min -127 max 127
        '05 09 19 01 29 08 15 00 25 01 75 01 95 08 81 02' +
        'C0'
    );

    // Report 0x01 do Xbox: X=255 (lx 1), Y=0 (ly -1), Z=128 (rx 0 morto),
    // RZ=255 (ry 1), hat norte, botao A, LT=512 (~0.5), resto zero.
    var XBOX_REPORT_A = [1, 255, 0, 128, 255, 0x10, 0, 0, 0x10, 0,
                         0, 0, 0, 0, 0, 0, 0, 0];
    // Hat leste, botao B, LT zero, sticks no centro.
    var XBOX_REPORT_B = [1, 128, 128, 128, 128, 0x22, 0, 0, 0, 0,
                         0, 0, 0, 0, 0, 0, 0, 0];
    // DS4-like: sem id no report (X=min(-127) -> lx -1; Y=max(127) -> ly 1;
    // botao 1). O data do BT.read vem SEM byte de id quando o descriptor
    // nao usa report id.
    var DS4_REPORT = [0x81, 127, 127, 127, 0x01];

    function setup(map, name) {
        var env = harness.makeEnv();
        var H = env.__harness;
        H.btReset();
        if (map) H.btSetMap(map);
        H.btSetState({ phase: 'ready', addr: 'AA:BB:CC:DD:EE:FF',
                       name: name || 'Xbox Wireless Controller' });
        var req = harness.makeRequire(ENGINE_DIR, env);
        return { env: env, H: H, req: req };
    }

    (function () {
        console.log('SDK gamepad:');

        var t = setup(XBOX_MAP);
        var G = t.req('celeros.gamepad');
        check('gamepad: exporta version', typeof G.version === 'string' && !!G.version,
              String(G.version));

        // ------------------------------------------------- parser ---------
        var m = G.parseMap(XBOX_MAP);
        var rin = m.reports['1|in'];
        var rout = m.reports['3|out'];
        check('gamepad: parseMap separa reports por id|tipo',
              !!rin && !!rout && rin.length === 30 && rout.length === 10,
              'in=' + (rin ? rin.length : 0) + ' out=' + (rout ? rout.length : 0));
        var hat = null, l2 = null, r2 = null, b5 = null;
        for (var i = 0; i < rin.length; i++) {
            var f = rin[i];
            if (f.page === 1 && f.usage === 0x39) hat = f;
            else if (f.page === 1 && f.usage === 0x33) l2 = f;
            else if (f.page === 1 && f.usage === 0x34) r2 = f;
            else if (f.page === 9 && f.usage === 5) b5 = f;
        }
        check('gamepad: hat fica no offset 40 (4 bits)',
              !!hat && hat.off === 40 && hat.bits === 4,
              JSON.stringify(hat));
        check('gamepad: gatilhos sao campos de 10 bits (LT offset 59, RT 69)',
              !!l2 && !!r2 && l2.off === 59 && r2.off === 69 && l2.bits === 10,
              JSON.stringify(l2));
        check('gamepad: botao 5 (L1) no offset 48',
              !!b5 && b5.off === 48 && b5.bits === 1, JSON.stringify(b5));

        // -------------------------------------------------- setup ---------
        var gp = G.setup();
        check('gamepad: setup cria o Gamepad do pad conectado',
              gp !== null && gp.connected === true);
        check('gamepad: report principal id 1, output id 3 com 10 bytes',
              !!gp && gp.mainId === 1 && gp.mainHasId === true && gp.outId === 3 &&
              gp.outLen === 10,
              'main=' + (gp && gp.mainId) + ' out=' + (gp && gp.outId) + '/' +
              (gp && gp.outLen));
        check('gamepad: profile xbox pelo nome do pad',
              !!gp && gp.profile === 'xbox', gp && gp.profile);

        // ------------------------------------------------- decode ---------
        t.H.btPushReport(1, XBOX_REPORT_A);
        var st = gp.poll();
        check('gamepad: stick esquerdo no canto (lx 1, ly -1)',
              !!st && st.lx === 1 && st.ly === -1,
              'lx=' + (st && st.lx) + ' ly=' + (st && st.ly));
        check('gamepad: stick direito (rx morto no centro, ry 1)',
              !!st && st.rx === 0 && st.ry === 1,
              'rx=' + (st && st.rx) + ' ry=' + (st && st.ry));
        check('gamepad: dpad norte', !!st && st.dpad === 'n', String(st && st.dpad));
        check('gamepad: botao A apertado', !!st && st.buttons.a === true,
              JSON.stringify(st && st.buttons));
        check('gamepad: LT ~0.5', !!st && Math.abs(st.l2 - 512 / 1023) < 0.01,
              String(st && st.l2));
        check('gamepad: diff pressed na 1a leitura',
              !!st && st.pressed.length === 1 && st.pressed[0] === 'a',
              JSON.stringify(st && st.pressed));

        t.H.btPushReport(1, XBOX_REPORT_B);
        var st2 = gp.poll();
        check('gamepad: soltou A / apertou B no report seguinte',
              !!st2 && st2.released.length === 1 && st2.released[0] === 'a' &&
              st2.pressed.length === 1 && st2.pressed[0] === 'b',
              JSON.stringify(st2 && [st2.pressed, st2.released]));
        check('gamepad: dpad leste', !!st2 && st2.dpad === 'e', String(st2 && st2.dpad));
        check('gamepad: stick solto volta para 0',
              !!st2 && st2.lx === 0 && st2.ly === 0,
              'lx=' + (st2 && st2.lx));

        check('gamepad: fila vazia -> poll devolve null', gp.poll() === null);

        // ------------------------------------------------- rumble ---------
        var okR = gp.rumble(0.2, 0.9, 300);
        var w = t.H.btWrites;
        check('gamepad: rumble xbox formata o report de output',
              okR === true && w.length === 1 && w[0][0] === 3 && w[0][1] === 0 &&
              w[0][2] === 51 && w[0][3] === 230 && w[0][4] === 255 && w[0].length === 10,
              JSON.stringify(w[0]));

        // --------------------------------------------- deadzone/axis ------
        check('gamepad: axis dentro da deadzone e 0',
              G.axis(0.05, 0.1) === 0 && G.axis(-0.09, 0.1) === 0);
        check('gamepad: axis nas pontas',
              G.axis(1, 0.1) === 1 && G.axis(-1, 0.1) === -1);

        // --------------------------------------------------- pads ---------
        t.H.btScan([{ addr: '11:22:33:44:55:66', name: 'Xbox Wireless Controller',
                      rssi: -40, appearance: 0x03C4 },
                    { addr: '77:88:99:AA:BB:CC', name: 'BLE Keyboard',
                      rssi: -60, appearance: 0x03C1 }]);
        var pads = G.scan(1500);
        check('gamepad: scan devolve os pads do ultimo scan',
              pads.length === 2 && pads[0].addr === '11:22:33:44:55:66' &&
              pads[0].rssi === -40,
              JSON.stringify(pads));
        check('gamepad: appearance 0x03C4 marca gamepad (0x03C1 nao)',
              pads[0].gamepad === true && pads[1].gamepad === false);

        // ----------------------------------------- padding Input(Const) ---
        // Gramatica HID real: items constant fecham byte (hat de 4 bits +
        // 4 bits de Input (Const) antes dos botoes, comum em pads BLE de
        // verdade). O offset do parser tem que avancar NOS items constant
        // tambem — sem isto os botoes saiam 4 bits deslocados.
        var PADDED_MAP = hex(
            '05 01 09 05 A1 01' +
            '85 01' +
            '09 30 09 31 15 00 26 FF 00 75 08 95 02 81 02' +   // X Y 0..255
            '09 39 15 00 25 07 75 04 95 01 81 42' +             // hat 4 bits (off 24)
            '75 01 95 04 81 03' +                                // 4 bits CONST (padding, off 28)
            '05 09 19 01 29 04 15 00 25 01 75 01 95 04 81 02' + // botoes 1..4 (off 32)
            'C0'
        );
        var mp = G.parseMap(PADDED_MAP);
        var pin = mp.reports['1|in'];
        var pBtn1 = null;
        for (i = 0; i < pin.length; i++) {
            if (pin[i].page === 9 && pin[i].usage === 1) pBtn1 = pin[i];
        }
        check('gamepad: padding Input(Const) avanca o offset (botao 1 no bit 32)',
              !!pBtn1 && pBtn1.off === 32, JSON.stringify(pBtn1));
        var gpPad = new G.Gamepad();
        gpPad.map = mp;
        gpPad.mainId = 1;
        gpPad.mainHasId = true;
        gpPad.inFields = pin;
        gpPad.fLx = null; gpPad.fLy = null; gpPad.fRx = null; gpPad.fRy = null;
        gpPad.fL2 = null; gpPad.fR2 = null; gpPad.fHat = null;
        for (i = 0; i < pin.length; i++) {
            if (pin[i].page === 1 && pin[i].usage === 0x39) gpPad.fHat = pin[i];
            else if (pin[i].page === 1 && pin[i].usage === 0x30) gpPad.fLx = pin[i];
            else if (pin[i].page === 1 && pin[i].usage === 0x31) gpPad.fLy = pin[i];
        }
        gpPad.connected = true;
        var stP = gpPad.decode([1, 255, 128, 0xF0, 0x02]);
        check('gamepad: report com padding decodifica hat + botao nos bits certos',
              !!stP && stP.lx === 1 && stP.dpad === 'n' && stP.buttons.b === true,
              'lx=' + (stP && stP.lx) + ' dpad=' + (stP && stP.dpad) + ' ' +
              JSON.stringify(stP && stP.buttons));

        // ------------------------------------------------ ds4-like --------
        var t2 = setup(DS4_MAP, '8BitDo SN30 Pro');
        var G2 = t2.req('celeros.gamepad');
        var gp2 = G2.setup();
        check('gamepad: descriptor sem report id -> mainId 0',
              gp2 !== null && gp2.mainId === 0 && gp2.mainHasId === false,
              'main=' + (gp2 && gp2.mainId));
        check('gamepad: sem output no descriptor -> rumble false',
              !!gp2 && gp2.outLen === 0 && gp2.rumble(1, 1, 100) === false);
        t2.H.btPushReport(0, DS4_REPORT);
        var st3 = gp2.poll();
        check('gamepad: sticks assinados (-127..127) normalizam',
              !!st3 && st3.lx === -1 && st3.ly === 1,
              'lx=' + (st3 && st3.lx) + ' ly=' + (st3 && st3.ly));
        check('gamepad: profile generic sem xbox no nome',
              !!gp2 && gp2.profile === 'generic', gp2 && gp2.profile);

        // ------------------------------------------------ sessao ----------
        var t3 = setup(XBOX_MAP);
        var G3 = t3.req('celeros.gamepad');
        t3.H.btSetState({ phase: 'idle' });
        check('gamepad: setup falha fora de ready', G3.setup() === null);
        t3.H.btSetState({ phase: 'ready' });
        check('gamepad: setup volta a funcionar em ready', G3.setup() !== null);
    })();
};
