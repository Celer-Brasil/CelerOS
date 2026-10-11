// game.spr.js — CelerGame SPRITES (dep "celeros.game.spr"): sprites PNG
// nos slots nativos do firmware (com painter procedural de fallback) e o
// flipbook E.anim. Decora o core no require (mesmo E de celeros.game):
//
//   var E = require("celeros.game");
//   require("celeros.game.spr");      // agora E.spr/E.anim existem
//   E.spr.load([{ name: "heroi", file: "heroi", w: 16, h: 16,
//                 paint: function (w, h, x, y) { ... } }]);
//   E.spr.blit("heroi", 120, 160);
//
// E.init({ dir }) preenche E.spr.bases com as pastas de assets do app —
// carregue o modulo ANTES do init (a ordem natural do require no topo).

var E = require('celeros.game');
var S = System;

// o firmware informa o limite do pool (System.spriteSlots, API 29; 8 com
// PSRAM); o que nao couber vira painter procedural
E.spr = {
    version: '1.0.0',
    bases: [],
    _slots: {},
    _used: 0,

    // defs: [{ name, file, w, h, paint }] — tenta PNG (em bases, prefixo por
    // app via init opts.dir) e cai no painter. paint(w, h, x, y) desenha em
    // coords absolutas.
    load: function (defs, opts) {
        var bases = (opts && opts.bases) || E.spr.bases;
        var out = {};
        for (var i = 0; i < defs.length; i++) {
            var d = defs[i];
            var slot = { id: 0, w: d.w, h: d.h, paint: d.paint || null };
            if (E.caps.sprites && E.spr._used < E.caps.slots) {
                var id = S.createSprite(d.w, d.h);
                if (id) {
                    var ok = false;
                    S.useSprite(id);
                    S.fillScreen(0x0000);
                    if (E.caps.png && d.file) {
                        for (var b = 0; b < bases.length && !ok; b++) {
                            try { ok = !!S.drawPNG(bases[b] + d.file + '.png', 0, 0); }
                            catch (e) { ok = false; }
                        }
                    }
                    if (!ok && d.paint) {
                        d.paint(d.w, d.h, 0, 0);
                        ok = true;
                    }
                    S.useSprite(0);
                    if (ok) {
                        slot.id = id;
                        E.spr._used++;
                    } else {
                        S.deleteSprite(id);
                    }
                }
            }
            E.spr._slots[d.name] = slot;
            out[d.name] = slot;
        }
        return out;
    },

    has: function (name) { return !!E.spr._slots[name]; },

    // true se o sprite esta num slot real (blit com cor-chave rapido);
    // false = o blit vai cair no painter procedural
    backed: function (name) {
        var s = E.spr._slots[name];
        return !!(s && s.id);
    },

    // opts: { key: cor-chave (default preto), cx/cy: centralizar }
    blit: function (name, x, y, opts) {
        var s = E.spr._slots[name];
        if (!s) return;
        var dx = Math.round(opts && opts.cx ? x - s.w / 2 : x);
        var dy = Math.round(opts && opts.cy ? y - s.h / 2 : y);
        if (E.dirty.on) E.dirty.add(dx, dy, s.w, s.h);
        if (s.id) {
            S.useSprite(s.id);
            S.pushSprite(dx, dy, opts && opts.key !== undefined ? opts.key : 0x0000);
            S.useSprite(0);
        } else if (s.paint) {
            s.paint(s.w, s.h, dx, dy);
        }
    },

    free: function (name) {
        var s = E.spr._slots[name];
        if (!s) return;
        if (s.id) {
            S.deleteSprite(s.id);
            E.spr._used--;
        }
        delete E.spr._slots[name];
    },
    freeAll: function () {
        for (var n in E.spr._slots) E.spr.free(n);
    }
};

// flipbook: frames = painters function(x,y) ou nomes de sprite carregado
E.anim = function (frames, fps, loop) {
    return {
        frames: frames, fps: fps || 6, loop: loop !== false,
        t: 0, i: 0, done: false,
        tick: function (dt) {
            this.t += dt;
            var fi = Math.floor(this.t * this.fps);
            if (fi >= this.frames.length) {
                if (this.loop) {
                    fi = fi % this.frames.length;
                    this.t = fi / this.fps;
                } else {
                    fi = this.frames.length - 1;
                    this.done = true;
                }
            }
            this.i = fi;
        },
        draw: function (x, y, opts) {
            var f = this.frames[this.i];
            if (typeof f === 'function') f(x, y);
            else E.spr.blit(f, x, y, opts);
        }
    };
};

E._mods.push('spr');

module.exports = E;
