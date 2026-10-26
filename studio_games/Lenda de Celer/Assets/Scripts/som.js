// som.js — trilhas chiptune ORIGINAIS da Lenda de Celer (formato do
// System.playMusic: [midi, dezesseis-avos]; cada trilha soma 64 = 4
// compassos, e as trilhas andam juntas) e a ponte para os sfx da
// celeros.sfx (kit: E.sfx) pela tabela do E.audio (com o intervalo minimo
// por som do core).

var E = require('celeros.game');

var BAT = [[36, 2], [42, 2], [38, 2], [42, 2], [36, 2], [42, 2], [38, 2], [42, 2]];
function rep(p, n) { var o = []; for (var i = 0; i < n; i++) o = o.concat(p); return o; }

var SOM = {
    // campo: maior, alegre, passo de caminhada
    campo: { bpm: 132, loops: 8, tracks: [
        { wave: 'sq', vol: 60, notes: [[72, 4], [76, 2], [79, 2], [84, 4], [79, 4],
                                       [77, 2], [76, 2], [74, 4], [72, 8],
                                       [74, 4], [76, 2], [77, 2], [79, 6], [76, 2],
                                       [74, 4], [72, 4], [71, 4], [72, 4]] },
        { wave: 'tri', vol: 85, notes: [[48, 8], [55, 8], [53, 8], [48, 8], [50, 8], [55, 8], [43, 8], [48, 8]] },
        { drum: true, vol: 55, notes: rep(BAT, 4) }
    ] },
    // templo: menor, lento, eco de pedra
    masm: { bpm: 100, loops: 8, tracks: [
        { wave: 'sq25', vol: 55, notes: [[57, 4], [60, 4], [64, 4], [63, 4],
                                         [62, 4], [60, 4], [59, 8],
                                         [57, 4], [60, 4], [65, 4], [64, 4],
                                         [62, 6], [59, 2], [57, 8]] },
        { wave: 'tri', vol: 85, notes: [[45, 8], [45, 8], [41, 8], [40, 8], [45, 8], [45, 8], [41, 8], [44, 8]] },
        { drum: true, vol: 40, notes: rep([[36, 4], [42, 4], [38, 4], [42, 4]], 4) }
    ] },
    // guardiao: rapido, serra insistente
    chefe: { bpm: 150, loops: 8, tracks: [
        { wave: 'saw', vol: 50, notes: [[64, 2], [64, 2], [67, 2], [64, 2], [70, 4], [69, 4],
                                        [64, 2], [64, 2], [67, 2], [64, 2], [62, 4], [60, 4],
                                        [65, 2], [65, 2], [68, 2], [65, 2], [71, 4], [70, 4],
                                        [64, 2], [67, 2], [71, 2], [72, 2], [71, 8]] },
        { wave: 'tri', vol: 90, notes: rep([[40, 4]], 8).concat(rep([[41, 4]], 4), rep([[40, 4]], 4)) },
        { drum: true, vol: 60, notes: rep([[36, 2], [42, 2], [38, 2], [42, 2]], 8) }
    ] },
    // gruta do sabio: calma
    casa: { bpm: 84, loops: 4, tracks: [
        { wave: 'tri', vol: 70, notes: [[67, 8], [72, 8], [71, 8], [67, 8], [69, 8], [65, 8], [67, 16]] },
        { wave: 'sq25', vol: 35, notes: [[48, 16], [53, 16], [50, 16], [48, 16]] }
    ] }
};

var _tocando = null;
// troca a trilha (a mesma nao recomeca)
SOM.tocar = function (nome) {
    if (_tocando === nome) return;
    _tocando = nome;
    if (!nome) { E.audio.stop(); return; }
    E.audio.stop();
    E.audio.music(SOM[nome]);
};
SOM.parar = function () { _tocando = null; E.audio.stop(); };

// sfx: as melodias da celeros.sfx entram na tabela do core (E.audio.sfx
// com nome ganha o intervalo minimo por som)
SOM.init = function () {
    var T = E.sfx ? E.sfx.tabela : {};
    for (var k in T) E.audio.sfxTable[k] = T[k];
};
SOM.fx = function (nome) { E.audio.sfx(nome); };

module.exports = SOM;
