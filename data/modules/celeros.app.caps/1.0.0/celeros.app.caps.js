
















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
