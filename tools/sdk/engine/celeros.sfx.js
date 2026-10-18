// celeros.sfx — biblioteca de efeitos sonoros chiptune para jogos.
//
// Dep compartilhada (API 30): apps declaram "celeros.sfx": "^1.0.0" no
// app.json e fazem var SFX = require("celeros.sfx"). Puro dado + helpers
// de manipulacao de melodia — nao toca no System: a melodia chega ao
// alto-falante pelo E.audio.sfx(mel) da engine ou System.playTone(mel)
// direto (BLOQUEANTE, < ~300 ms).
//
// Formato: [freq, ms] ou melodia [[freq, ms], ...] — o mesmo do playTone.
// freq 0 = pausa que avanca o tempo. Sons curtos de verdade: o falante do
// device tem um canal so (musica OU sfx; o E.audio.duck resolve a disputa).

// 1.1.0: SFX.varia (afinacao sorteada por toque — o mesmo "hit" 20x
// seguidas nao cansa) e SFX.junta (concatena melodias com pausa).
// 1.2.0: SFX.arpejo(base, semitons, ms) — fanfarra/acorde sem tabela.

var SFX = { version: '1.2.0' };

// Tabela por intencao. "p" = pausa curta de articulacao.
var T = {
    // interface
    ui: [880, 40],
    ok: [[660, 50], [880, 60]],
    back: [330, 60],
    erro: [[200, 80], [150, 120]],

    // impacto / combate
    hit: [220, 50],
    zap: [[1200, 30], [900, 30], [600, 50]],
    soco: [[180, 60], [90, 120]],
    bicho: [[520, 40], [390, 70]],

    // recompensa
    coin: [[988, 50], [1319, 80]],
    power: [[784, 40], [988, 40], [1319, 90]],
    vida: [[523, 60], [659, 60], [784, 60], [1047, 120]],

    // explosoes (duck na trilha!)
    boomPeq: [[100, 70], [60, 150]],
    boomGra: [[100, 70], [60, 150], [40, 120]],
    boomBoss: [[150, 60], [100, 80], [60, 160], [35, 260]],

    // util
    chute: [[440, 30], [660, 40]],
    escudo: [[1200, 40], [900, 60]],
    tick: [1500, 20],
    alerta: [[880, 90], [880, 90]],
    planta: [700, 35],

    // jingles de fim
    morte: [[300, 90], [220, 90], [140, 220]],
    vitoria: [[523, 90], [659, 90], [784, 160]],
    derrota: [[400, 120], [300, 120], [200, 120], [100, 300]],
    recorde: [[659, 70], [784, 70], [988, 70], [1319, 200]]
};
SFX.tabela = T;

// mel(nome) — copia a melodia (mexer na copia nao suja a tabela)
SFX.mel = function (nome) {
    var m = T[nome];
    if (!m) return null;
    return typeof m[0] === 'number' ? [m.slice(0)] : m.map(function (n) { return n.slice(0); });
};

// transpor(mel, semi) — desloca em semitons (razao 2^(1/12)): varia um som
// de chamada sem duplicar entrada na tabela
SFX.transpor = function (mel, semi) {
    var r = Math.pow(2, semi / 12);
    return mel.map(function (n) { return n[0] > 0 ? [Math.round(n[0] * r), n[1]] : [n[0], n[1]]; });
};

// tempo(mel, fator) — estica (fator > 1) ou encurta as duracoes
SFX.tempo = function (mel, fator) {
    return mel.map(function (n) {
        return [n[0], Math.max(15, Math.round(n[1] * fator))];
    });
};

// varia(mel, semi, rnd) — transpoe por um sorteio em [-semi, +semi]
// semitons (inteiros); rnd opcional (E.rng) para replay deterministico
SFX.varia = function (mel, semi, rnd) {
    var s = semi === undefined ? 2 : semi;
    var k = Math.round(((rnd ? rnd() : Math.random()) * 2 - 1) * s);
    return k ? SFX.transpor(mel, k) : mel.map(function (n) { return n.slice(0); });
};

// junta(a, b, ..., {pausa: ms}) — melodias (ou nomes da tabela) em fila;
// a ultima arg objeto define a pausa entre elas (default 0)
SFX.junta = function () {
    var out = [], pausa = 0, args = [];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    var last = args[args.length - 1];
    if (last && !Array.isArray(last) && typeof last === 'object') {
        pausa = last.pausa || 0;
        args.pop();
    }
    for (var j = 0; j < args.length; j++) {
        var m = typeof args[j] === 'string' ? SFX.mel(args[j]) :
                (typeof args[j][0] === 'number' ? [args[j]] : args[j]);
        if (!m) continue;
        if (j > 0 && pausa > 0) out.push([0, pausa]);
        for (var k = 0; k < m.length; k++) out.push([m[k][0], m[k][1]]);
    }
    return out;
};

// arpejo(base, semitons, ms) — notas base*2^(s/12) em fila: arpejo(523,
// [0, 4, 7, 12], 70) = do maior subindo (vitoria, nivel novo)
SFX.arpejo = function (base, semis, ms) {
    var d = ms || 60, out = [];
    for (var i = 0; i < semis.length; i++) {
        out.push(semis[i] === null ? [0, d] : [Math.round(base * Math.pow(2, semis[i] / 12)), d]);
    }
    return out;
};

// via(audio, nome, opts) — toca pela engine com as manhas do canal unico:
// opts.duck = ms para abafar a trilha (explosao), opts.oitava/velocidade
// derivam variantes, opts.varia = semitons de sorteio (SFX.varia). Passa null/false se nao ha audio (vira no-op).
SFX.via = function (audio, nome, opts) {
    if (!audio || typeof audio.sfx !== 'function') return false;
    opts = opts || {};
    if (opts.duck && typeof audio.duck === 'function') audio.duck(opts.duck);
    var mel = SFX.mel(nome);
    if (!mel) return false;
    if (opts.oitava) mel = SFX.transpor(mel, opts.oitava * 12);
    if (opts.velocidade && opts.velocidade > 0) mel = SFX.tempo(mel, 1 / opts.velocidade);
    if (opts.varia) mel = SFX.varia(mel, opts.varia, opts.rnd);
    audio.sfx(mel);
    return true;
};

module.exports = SFX;
