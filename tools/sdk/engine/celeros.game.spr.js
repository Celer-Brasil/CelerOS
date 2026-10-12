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
    version: '1.0.1',
    bases: [],
    _slots: {},
    _sheets: {},        // spritesheets: 1 PNG inteiro + regioes nomeadas
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

    // spritesheet: 1 PNG inteiro num UNICO slot + regioes nomeadas — cada
    // regiao vira nome de sprite de 1a classe (blit/anim/backed funcionam).
    // regions: { nome: [cx, cy] } em CELULAS de tw x th, ou [x, y, w, h]
    // livre em pixels. Economiza os slots do pool (16 no maximo) e o decode
    // (drawPNG custa ~9 ms/tile no 4848 — o sheet decodifica 1 vez so).
    // Regiao sem setClip (firmware velho) cai no paint(nome, x, y).
    // Devolve os slots das regioes; libere com freeSheet(name).
    sheet: function (name, o) {
        var sh = { id: 0, w: o.w, h: o.h, name: name, regs: [] };
        if (E.caps.sprites && E.spr._used < E.caps.slots) {
            var id = S.createSprite(o.w, o.h);
            if (id) {
                var ok = false;
                S.useSprite(id);
                S.fillScreen(0x0000);
                if (E.caps.png && o.file) {
                    var bases = E.spr.bases;
                    for (var b = 0; b < bases.length && !ok; b++) {
                        try { ok = !!S.drawPNG(bases[b] + o.file + '.png', 0, 0); }
                        catch (e) { ok = false; }
                    }
                }
                S.useSprite(0);
                if (ok) {
                    sh.id = id;
                    E.spr._used++;
                } else {
                    S.deleteSprite(id);
                }
            }
        }
        var tw = o.tw || 16, th = o.th || 16;
        var regs = o.regions || {};
        var out = {}, rn;
        for (rn in regs) {
            var r = regs[rn];
            var rx = r[0] * tw, ry = r[1] * th, rw = tw, rh = th;
            if (r.length >= 4) { rx = r[0]; ry = r[1]; rw = r[2]; rh = r[3]; }
            E.spr._slots[rn] = { id: sh.id, w: rw, h: rh, sheet: sh,
                                 rx: rx, ry: ry, paint: o.paint || null };
            sh.regs.push(rn);
            out[rn] = E.spr._slots[rn];
        }
        E.spr._sheets[name] = sh;
        return out;
    },

    // libera o slot do sheet e todas as regioes dele
    freeSheet: function (name) {
        var sh = E.spr._sheets[name];
        if (!sh) return;
        if (sh.id) {
            S.deleteSprite(sh.id);
            E.spr._used--;
        }
        for (var i = 0; i < sh.regs.length; i++) delete E.spr._slots[sh.regs[i]];
        delete E.spr._sheets[name];
    },

    // opts: { key: cor-chave (default preto), cx/cy: centralizar }
    blit: function (name, x, y, opts) {
        var s = E.spr._slots[name];
        if (!s) return;
        // sem slot E sem painter nada pode ser desenhado (PNG falhou no
        // load/sheet e a def nao trouxe paint): no-op SECO — antes registrava
        // a caixa na camada suja mesmo assim e o "apagar" do quadro seguinte
        // comia o que estivesse embaixo do fantasma
        var pode = s.paint || (s.sheet ? (s.sheet.id && E.caps.clip) : s.id);
        if (!pode) return;
        var dx = Math.round(opts && opts.cx ? x - s.w / 2 : x);
        var dy = Math.round(opts && opts.cy ? y - s.h / 2 : y);
        if (E.dirty.on) E.dirty.add(dx, dy, s.w, s.h);
        var key = opts && opts.key !== undefined ? opts.key : 0x0000;
        if (s.sheet) {
            // regiao: clipa o destino no tamanho da regiao e empurra o
            // sheet INTEIRO deslocado — so o rect recortado aterrissa
            if (s.sheet.id && E.caps.clip) {
                S.setClip(dx, dy, s.w, s.h);
                S.useSprite(s.sheet.id);
                S.pushSprite(dx - s.rx, dy - s.ry, key);
                S.useSprite(0);
                S.clearClip();
            } else if (s.paint) {
                s.paint(name, dx, dy);
            }
            return;
        }
        if (s.id) {
            S.useSprite(s.id);
            S.pushSprite(dx, dy, key);
            S.useSprite(0);
        } else if (s.paint) {
            s.paint(s.w, s.h, dx, dy);
        }
    },

    free: function (name) {
        var s = E.spr._slots[name];
        if (!s) return;
        // regiao de sheet COMPARTILHA o slot (o sheet inteiro sai no
        // freeSheet); free de regiao so tira o nome
        if (s.id && !s.sheet) {
            S.deleteSprite(s.id);
            E.spr._used--;
        }
        delete E.spr._slots[name];
    },
    freeAll: function () {
        for (var n in E.spr._sheets) E.spr.freeSheet(n);
        for (var n2 in E.spr._slots) E.spr.free(n2);
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
