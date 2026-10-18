// game.stats.js — CelerGame STATS (dep "celeros.game.stats"): atributos de
// combate com bonus temporarios, vida com invencibilidade apos o golpe,
// recargas de habilidade e XP/nivel. Decora o core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.stats");
//   var st = E.stats({ hp: 10, atk: 3, def: 1 }, {
//       iframes: 600,                                  // ms invencivel apos golpe
//       onDeath: function (s) { E.goto("fim"); },
//       xp: { base: 10, grow: 1.5 }, onLevel: function (s, nv) { s.base.atk++; }
//   });
//   st.mod("atk", { mul: 2, ms: 5000, id: "furia" });   // buff de 5 s
//   inimigo.st.damage(st.get("atk"));                    // - def, minimo 1
//   if (st.cool("dash", 800)) dash();                    // recarga de 800 ms
//   st.addXp(15);
//
// Relogio: o do JOGO (anda no tick da engine — congela no E.pause, segue o
// E.timeScale), igual para buffs, recargas e iframes. st.hp e a vida
// corrente; o teto e get("hp") (buff de hp maximo vale na hora).

var E = require('celeros.game');

var _clock = 0;     // ms de jogo desde o require

E.stats = function (base, o) {
    o = o || {};
    var b = {};
    for (var k in base) b[k] = base[k];
    var s = {
        base: b,
        hp: b.hp !== undefined ? b.hp : 1,
        dead: false,
        mods: [],           // [{stat, add, mul, until, id}]
        iframes: o.iframes || 0,
        lastHit: -1e9,
        level: 1,
        xp: 0,
        onHit: o.onHit || null,         // (s, dano, fonte)
        onDeath: o.onDeath || null,     // (s, fonte)
        onLevel: o.onLevel || null,     // (s, nivel)
        _cool: {},
        _xp: o.xp || null
    };
    function prune() {
        var m = s.mods;
        for (var i = m.length - 1; i >= 0; i--) if (m[i].until >= 0 && m[i].until <= _clock) m.splice(i, 1);
    }
    // valor efetivo: (base + soma dos add) x produto dos mul
    s.get = function (name) {
        prune();
        var v = b[name] === undefined ? 0 : b[name], add = 0, mul = 1;
        for (var i = 0; i < s.mods.length; i++) {
            var md = s.mods[i];
            if (md.stat !== name) continue;
            add += md.add;
            mul *= md.mul;
        }
        var val = (v + add) * mul;
        // buff de vida maxima que venceu: a vida corrente desce ao teto novo
        if (name === 'hp' && s.hp > val) s.hp = val;
        return val;
    };
    // bonus {add, mul, ms (sem = permanente), id (o mesmo id SUBSTITUI —
    // pocao tomada 2x renova em vez de empilhar)}. Devolve o handle {remove()}
    s.mod = function (name, mo) {
        mo = mo || {};
        if (mo.id !== undefined) s.unmod(mo.id);
        var md = { stat: name, add: mo.add || 0, mul: mo.mul === undefined ? 1 : mo.mul,
                   until: mo.ms > 0 ? _clock + mo.ms : -1, id: mo.id };
        md.remove = function () {
            var i = s.mods.indexOf(md);
            if (i >= 0) s.mods.splice(i, 1);
        };
        s.mods.push(md);
        if (name === 'hp') s.get('hp');
        return md;
    };
    s.unmod = function (id) {
        for (var i = s.mods.length - 1; i >= 0; i--) if (s.mods[i].id === id) s.mods.splice(i, 1);
    };
    s.hasMod = function (id) {
        prune();
        for (var i = 0; i < s.mods.length; i++) if (s.mods[i].id === id) return true;
        return false;
    };
    s.maxHp = function () { return s.get('hp'); };
    s.invuln = function () { return _clock - s.lastHit < s.iframes; };
    // dano n: menos def (o.pierce ignora), minimo 1 se n > 0; durante os
    // iframes devolve 0 sem tocar a vida. Devolve o dano aplicado
    s.damage = function (n, d) {
        d = d || {};
        if (s.dead || !(n > 0) || (!d.force && s.invuln())) return 0;
        var real = d.pierce ? n : n - s.get('def');
        if (real < 1) real = 1;
        if (real > s.hp) real = s.hp;
        s.hp -= real;
        s.lastHit = _clock;
        if (s.onHit) s.onHit(s, real, d.source);
        if (s.hp <= 0) {
            s.hp = 0;
            s.dead = true;
            if (s.onDeath) s.onDeath(s, d.source);
        }
        return real;
    };
    // cura ate o teto; devolve quanto curou (morto nao cura — use revive)
    s.heal = function (n) {
        if (s.dead || !(n > 0)) return 0;
        var mx = s.get('hp'), h = Math.min(n, mx - s.hp);
        if (h < 0) h = 0;
        s.hp += h;
        return h;
    };
    s.revive = function (hp) {
        s.dead = false;
        s.hp = hp === undefined ? s.get('hp') : Math.min(hp, s.get('hp'));
        s.lastHit = -1e9;
    };
    // 0..1 da vida (barra)
    s.frac = function () { var mx = s.get('hp'); return mx > 0 ? s.hp / mx : 0; };

    // recarga: true (e comeca a contar) se estava pronta
    s.cool = function (name, ms) {
        var t = s._cool[name];
        if (t !== undefined && _clock < t) return false;
        s._cool[name] = _clock + ms;
        s._cool[name + '#ms'] = ms;
        return true;
    };
    s.ready = function (name) { var t = s._cool[name]; return t === undefined || _clock >= t; };
    // ms que faltam / fracao 0..1 ja recarregada (icone de habilidade)
    s.coolLeft = function (name) {
        var t = s._cool[name];
        return t === undefined || _clock >= t ? 0 : t - _clock;
    };
    s.coolFrac = function (name) {
        var ms = s._cool[name + '#ms'];
        if (!ms) return 1;
        return 1 - s.coolLeft(name) / ms;
    };
    s.resetCool = function (name) {
        if (name === undefined) s._cool = {};
        else { delete s._cool[name]; delete s._cool[name + '#ms']; }
    };

    // XP: proximo nivel custa base * grow^(nivel-1) (o = {base, grow})
    s.xpNeed = function () {
        var x = s._xp || { base: 10, grow: 1.5 };
        return Math.round((x.base || 10) * Math.pow(x.grow || 1.5, s.level - 1));
    };
    // devolve quantos niveis subiu (onLevel por nivel)
    s.addXp = function (n) {
        if (!(n > 0)) return 0;
        s.xp += n;
        var up = 0;
        for (var guard = 0; guard < 100 && s.xp >= s.xpNeed(); guard++) {
            s.xp -= s.xpNeed();
            s.level++;
            up++;
            if (s.onLevel) s.onLevel(s, s.level);
        }
        return up;
    };
    // retrato p/ save: {base, hp, level, xp} (buffs/recargas nao vao)
    s.toJSON = function () { return { base: b, hp: s.hp, level: s.level, xp: s.xp }; };
    s.load = function (v) {
        if (!v) return s;
        if (v.base) for (var k2 in v.base) b[k2] = v.base[k2];
        if (v.level) s.level = v.level;
        if (v.xp !== undefined) s.xp = v.xp;
        if (v.hp !== undefined) { s.hp = v.hp; s.dead = v.hp <= 0; }
        return s;
    };
    return s;
};
E.stats.version = '1.0.0';
// relogio de jogo em ms (o mesmo dos buffs/recargas)
E.stats.now = function () { return _clock; };

E._modTicks.push(function (dt) { _clock += dt * 1000; });
E._mods.push('stats');

module.exports = E;
