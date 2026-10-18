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
//
// 1.1.0: blit com ancora {ax, ay} (0..1 — 0.5/1 = pe no chao) alem de
// cx/cy; E.spr.size(nome); E.anim com reset/play/onEnd, modo pingpong e
// frames vazios sem NaN.
// 1.2.0: E.spr.grid (spritesheet em grade com nomes numerados, 1 slot so)
// e E.spr.frames(prefixo, de, ate) -> lista de nomes para o E.anim.
// 1.3.0: load/sheet de um nome JA carregado vazava o slot nativo antigo
// (enter de cena que carrega a cada entrada esgotava o pool em 4 voltas)
// — o antigo e liberado antes; anim.play com o MESMO clipe ignorava fps/
// loop novos (correr mais rapido nao acelerava). Novos: anim.speed
// (multiplicador) e anim.onFrame(anim, i) ao trocar de quadro; a volta
// do loop guardava so fi/fps e perdia a sobra do quadro (o ciclo atrasava).
// 1.4.0: E.spr.stamp(nome, x, y, {scale}) desenha sprite/REGIAO de folha
// no alvo CORRENTE — o quadro ou um sprite selecionado com useSprite (o
// blit so empurra para o quadro) — e escala com drawSprite (API 33): o
// fundo de uma sala e montado uma vez num sprite e a arte de 32 px serve
// em celula de 27 no relogio. E.anim.dir({down, up, left, right}) junta os
// clipes direcionais com face(dir)/walk(on).

var E = require('celeros.game');
var S = System;
var EMPTY = {};
var _stO = { key: 0 };

// o firmware informa o limite do pool (System.spriteSlots, API 29; 8 com
// PSRAM); o que nao couber vira painter procedural
E.spr = {
    version: '1.4.0',
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
            // recarregar o mesmo nome devolve o slot velho ao pool antes
            if (E.spr._slots[d.name]) E.spr.free(d.name);
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

    // {w, h} do sprite/regiao carregado (null se nao existe) — layout e
    // colisao sem repetir as medidas do load
    size: function (name) {
        var s = E.spr._slots[name];
        return s ? { w: s.w, h: s.h } : null;
    },

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
        if (E.spr._sheets[name]) E.spr.freeSheet(name);
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

    // spritesheet em GRADE: cols x rows celulas de tw x th viram os nomes
    // prefix + indice (0.. em linhas) — heroi0..heroi7 de uma tira de 8
    // quadros. Mesmo slot unico do sheet; o.paint / o.w / o.h opcionais
    grid: function (name, o) {
        var cols = o.cols || 1, rows = o.rows || 1;
        var tw = o.tw || 16, th = o.th || 16;
        var pre = o.prefix === undefined ? name : o.prefix;
        var regs = {};
        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) regs[pre + (r * cols + c)] = [c, r];
        }
        return E.spr.sheet(name, { file: o.file, w: o.w || cols * tw, h: o.h || rows * th,
                                   tw: tw, th: th, regions: regs, paint: o.paint });
    },

    // nomes prefix+a .. prefix+b (inclusivo) — a lista de quadros do anim
    frames: function (prefix, a, b) {
        var out = [];
        if (a <= b) for (var i = a; i <= b; i++) out.push(prefix + i);
        else for (var j = a; j >= b; j--) out.push(prefix + j);
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

    // opts: { key: cor-chave (default preto), cx/cy: centralizar, ax/ay:
    // ancora 0..1 (ax 0.5 + ay 1 = x,y e o pe do personagem) }
    blit: function (name, x, y, opts) {
        var s = E.spr._slots[name];
        if (!s) return;
        // sem slot E sem painter nada pode ser desenhado (PNG falhou no
        // load/sheet e a def nao trouxe paint): no-op SECO — antes registrava
        // a caixa na camada suja mesmo assim e o "apagar" do quadro seguinte
        // comia o que estivesse embaixo do fantasma
        var pode = s.paint || (s.sheet ? (s.sheet.id && E.caps.clip) : s.id);
        if (!pode) return;
        var ax = 0, ay = 0;
        if (opts) {
            ax = opts.ax !== undefined ? opts.ax : (opts.cx ? 0.5 : 0);
            ay = opts.ay !== undefined ? opts.ay : (opts.cy ? 0.5 : 0);
        }
        var dx = Math.round(x - s.w * ax);
        var dy = Math.round(y - s.h * ay);
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

    // desenha no alvo corrente (quadro OU sprite selecionado por
    // useSprite), com escala: o {scale (1), key (cor-chave; null = opaco;
    // default preto), cx/cy/ax/ay como no blit}. Regiao de folha recorta
    // com setClip no alvo e desenha a folha inteira deslocada pelo
    // drawSprite. Sem drawSprite (firmware sem API 33/placa sem PSRAM) cai
    // no blit (escala 1, so quadro) ou no painter. Devolve false se nada
    // pode ser desenhado
    stamp: function (name, x, y, o) {
        var s = E.spr._slots[name];
        if (!s) return false;
        o = o || EMPTY;
        var k = o.scale || 1;
        var w = s.w * k, h = s.h * k;
        var ax = o.ax !== undefined ? o.ax : (o.cx ? 0.5 : 0);
        var ay = o.ay !== undefined ? o.ay : (o.cy ? 0.5 : 0);
        var dx = Math.round(x - w * ax), dy = Math.round(y - h * ay);
        var key = o.key === undefined ? 0x0000 : o.key;
        var id = s.sheet ? s.sheet.id : s.id;
        if (id && typeof S.drawSprite === 'function') {
            var W2 = Math.round(w), H2 = Math.round(h);
            var kk = key === null ? undefined : key;
            if (s.sheet) {
                var sh = s.sheet;
                S.setClip(dx, dy, W2, H2);
                S.drawSprite(id, dx + (sh.w / 2 - s.rx) * k, dy + (sh.h / 2 - s.ry) * k, 0, k, k, kk);
                S.clearClip();
            } else {
                S.drawSprite(id, dx + w / 2, dy + h / 2, 0, k, k, kk);
            }
            if (E.dirty.on) E.dirty.add(dx, dy, W2, H2);
            return true;
        }
        if (k === 1 && id) {
            _stO.key = key === null ? undefined : key;
            E.spr.blit(name, dx, dy, _stO);
            return true;
        }
        if (s.paint) {
            if (s.sheet) s.paint(name, dx, dy, k);
            else s.paint(w, h, dx, dy);
            if (E.dirty.on) E.dirty.add(dx, dy, w, h);
            return true;
        }
        return false;
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

// flipbook: frames = painters function(x,y) ou nomes de sprite carregado.
// loop: true (default) | false (para no ultimo, done = true) | 'pingpong'
// (vai e volta). onEnd(anim) dispara no fim de cada volta (loop) ou uma
// vez no fim (sem loop). play(frames, fps) troca de animacao (andar ->
// pular) sem alocar outra; reset() recomeca.
E.anim = function (frames, fps, loop) {
    return {
        frames: frames, fps: fps || 6, loop: loop === undefined ? true : loop,
        t: 0, i: 0, done: false, onEnd: null, onFrame: null,
        speed: 1,           // multiplicador (2 = corre o dobro sem trocar fps)
        tick: function (dt) {
            var n = this.frames.length;
            if (!n || this.done) return;
            var i0 = this.i;
            this._tick(dt * this.speed, n);
            if (this.onFrame && this.i !== i0) this.onFrame(this, this.i);
        },
        _tick: function (dt, n) {
            this.t += dt;
            var fi = Math.floor(this.t * this.fps);
            if (this.loop === 'pingpong' && n > 1) {
                var per = 2 * n - 2;
                if (fi >= per) {
                    fi = fi % per;
                    // guarda a sobra dentro do quadro (fi/fps jogava fora o
                    // resto e a volta atrasava um pouco a cada ciclo)
                    this.t = this.t % (per / this.fps);
                    if (this.onEnd) this.onEnd(this);
                }
                this.i = fi < n ? fi : per - fi;
                return;
            }
            if (fi >= n) {
                if (this.loop) {
                    fi = fi % n;
                    this.t = this.t % (n / this.fps);
                    if (this.onEnd) this.onEnd(this);
                } else {
                    fi = n - 1;
                    this.done = true;
                    if (this.onEnd) this.onEnd(this);
                }
            }
            this.i = fi;
        },
        reset: function () {
            this.t = 0;
            this.i = 0;
            this.done = false;
            return this;
        },
        // troca o clipe; o MESMO frames nao recomeca (nem terminado —
        // chamar por quadro com o clipe do estado e seguro; reset() refaz)
        play: function (fr, fp, lp) {
            if (fr === this.frames) {
                // mesmo clipe: so ajusta velocidade/modo, sem recomecar
                if (fp) this.fps = fp;
                if (lp !== undefined) this.loop = lp;
                return this;
            }
            this.frames = fr;
            if (fp) this.fps = fp;
            if (lp !== undefined) this.loop = lp;
            return this.reset();
        },
        draw: function (x, y, opts) {
            var f = this.frames[this.i];
            if (f === undefined) return;
            if (typeof f === 'function') f(x, y);
            else if (opts && opts.scale) E.spr.stamp(f, x, y, opts);   // 1.4: escala
            else E.spr.blit(f, x, y, opts);
        }
    };
};

// clipes por direcao: clips = {down, up, left, right} (listas de quadros;
// direcao ausente usa a 'down'). face(dir) troca o clipe sem recomecar o
// passo; walk(false) para no quadro 0 (parado); draw/tick como o anim
E.anim.dir = function (clips, fps, loop) {
    var a = E.anim(clips.down || clips.right || [], fps, loop);
    a.clips = clips;
    a.facing = 'down';
    a.walking = true;
    a.face = function (dir) {
        if (!dir || dir === a.facing) return a;
        var fr = clips[dir] || clips.down;
        if (!fr) return a;
        a.facing = dir;
        var t = a.t;
        a.play(fr);
        a.t = t;
        a.i = fr.length ? Math.floor(t * a.fps) % fr.length : 0;
        return a;
    };
    a.walk = function (on) {
        if (!!on === a.walking) return a;
        a.walking = !!on;
        if (!on) { a.t = 0; a.i = 0; }
        return a;
    };
    var tk = a.tick;
    a.tick = function (dt) { if (a.walking) tk.call(a, dt); };
    return a;
};

E._mods.push('spr');

module.exports = E;
