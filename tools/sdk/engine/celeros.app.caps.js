// app.caps.js — CelerKit CAPS (dep "celeros.app.caps"): as sondas de
// capacidade da placa num lugar so (hoje: typeof espalhado + heuristica de
// PSRAM na loja + forks de UI por placa). Probe() e carregado na 1a chamada
// e cacheado — a placa nao muda de hardware no meio do app:
//
//   var A = require("celeros.app");
//   require("celeros.app.caps");
//   var c = A.caps.probe();     // { api, board, w, h, inset, shape, psram,
//                               //   battery, speaker, led, light, touch, mic,
//                               //   camera, bt, phone, small }
//   if (A.caps.has("mic")) Mic.start();
//   if (A.caps.has("psram")) carregaGraficoGrande();
//
// "small" = 4 MB sem PSRAM (CYD/devkit): a placa onde cada KB custa — apps
// usam para encolher caches e pular arte pesada. Feature-detect com typeof
// (globais ausentes em builds sem o Kconfig ligado NUNCA estouram).

var A = require('celeros.app');

A.caps = {
    version: '1.0.0',
    _c: null,

    probe: function () {
        if (A.caps._c) return A.caps._c;
        var info = {};
        try { info = System.getInfo() || {}; } catch (e) { info = {}; }
        var api = 0;
        try { api = System.getAPILevel() || 0; } catch (e) { api = 0; }
        var psram = (info.totalPSRAM || 0) > 0;
        var c = {
            api: api,
            board: info.board || '',
            w: info.screenW || 240,
            h: info.screenH || 320,
            inset: info.inset || 0,
            shape: info.shape || 'rect',
            psram: psram,
            battery: !!info.hasBattery,
            speaker: !!info.hasSpeaker,
            led: !!info.hasLed,
            light: !!info.hasLightSensor,
            touch: typeof UI !== 'undefined',
            mic: typeof Mic !== 'undefined',
            camera: typeof Camera !== 'undefined',
            bt: typeof CelerNet !== 'undefined' && typeof Pack !== 'undefined',
            phone: typeof Phone !== 'undefined',
            small: !psram && (info.flashSize || 0) <= 8 * 1024 * 1024
        };
        A.caps._c = c;
        return c;
    },

    has: function (name) { return !!A.caps.probe()[name]; }
};

A._mods.push('caps');

module.exports = A;
