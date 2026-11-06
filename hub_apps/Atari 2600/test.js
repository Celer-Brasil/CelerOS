// test.js — stub do NUCLEO NATIVO do Atari 2600 para o harness/emulador.
//
// O app usa o blob CLRN (a2600_core.bin) por System.native*; no host nao ha
// Xtensa, entao este wire substitui os bindings por um modelo do contrato
// core_ctl (offsets do layout + comandos 0-22). O blob real compila no PC com
// `celer.js native` (toolchain xtensa). Nunca embarca ao device (o publish
// exclui test.js).

module.exports.wire = function (env) {
    var S = env.System;
    var h = 0, loaded = false, frames = 0;

    S.nativeLoad = function (path, kb) {
        h = 1;
        return h;
    };
    S.nativeCall = function (handle, fn, cmd, arg) {
        if (handle !== h) return 0;
        switch (cmd) {
        case 0: return 655360;   // INIT -> capacidade de ROM
        case 1: return 4096;     // ROM_OFF
        case 2: return 524288;   // PCM_OFF
        case 3: return 532480;   // FB_OFF
        case 4: return 593920;   // STATE_OFF
        case 5: return 40960;    // STATE_SIZE
        case 6: loaded = true; return 1;                 // LOAD
        case 7: return 1;                                // RESET
        case 8: if (!loaded) return 0; frames++; return 1;  // FRAME
        case 9: return loaded ? 1400 : 0;                // SAVE_STATE
        case 10: return loaded && arg > 0 ? 1 : 0;       // LOAD_STATE
        case 11: return 1470;                            // PCM_LEN
        case 12: return 69632;                           // SET_SCALE -> offset
        case 13: return 1;                               // SET_AUDIO
        case 20: case 21: return 1;                      // SWITCHES/PADDLE
        case 22: return arg >= 0 ? arg : 2;              // MAPPER
        }
        return 0;
    };
    S.nativeLoadFile = function (handle, off, path) {
        return loaded || off === 4096 ? 40960 : -1;
    };
    S.nativeSaveFile = function () { return true; };
    S.nativeWrite = function (handle, off, s) { return String(s).length; };
    S.nativeDraw = function () { return true; };
    S.nativeAudio = function () { return true; };
    S.nativeAudioStop = function () {};
    S.nativeFree = function () { loaded = false; h = 0; return true; };
    env.__frames = function () { return frames; };
};
