// Runtime de cenas do Celer Studio (ES5, Duktape). Este arquivo NAO e um
// modulo: o build concatena este corpo dentro do main.js gerado e chama
// studioBoot(E, require("game.data")). Toda cena/prefab foi achatada no
// build; aqui so existe entidade + componentes de dados.

function studioBoot(E, data) {
    var S = System;
    var A = data.assets || {};
    var SC = data.scenes || {};
    var NAME = data.names || {};
    var byName = {};
    var an;
    for (an in A) if (A[an] && A[an].n) byName[A[an].n] = A[an];

    function firstKey(obj) {
        for (var k in obj) return k;
        return '';
    }

    function loadAsset(a) {
        if (!a || !E.spr) return;
        var meta = { ax: a.ax, ay: a.ay, anims: a.anims, fps: a.fps,
                     loop: a.loop, hitbox: a.hitbox };
        if (a.t === 'g') {
            if (a.mode === 'regions' || !E.spr.meta) {
                E.spr.sheet(a.n, { file: a.f, w: a.w, h: a.h,
                                   tw: a.tw || 16, th: a.th || 16,
                                   regions: a.regions || {} });
                if (E.spr.meta) E.spr.meta(a.n, meta);
            } else {
                // spr 1.6: grade + metadados num objeto so (E.spr.meta)
                meta.file = a.f; meta.w = a.w; meta.h = a.h;
                meta.cols = a.cols || 1; meta.rows = a.rows || 1;
                meta.tw = a.tw || 16; meta.th = a.th || 16;
                meta.prefix = a.prefix;
                E.spr.meta(a.n, meta);
            }
        } else if (a.t === 's') {
            E.spr.load([{ name: a.n, file: a.f, w: a.w, h: a.h }]);
            if (E.spr.meta) E.spr.meta(a.n, meta);
        }
    }

    function makeTilemap(tm, asset) {
        var cols = tm.cols, rows = tm.rows, data = tm.data, solids = tm.solids;
        var solidValues = tm.solidValues || null;
        var auto = tm.autotile || null;
        // nome do slot e opcoes reaproveitados: o flush repinta varias
        // celulas por quadro e concatenar/objetar por celula pesa no Duktape
        var tileSlots = {};
        var tileOpts = { scale: 1, ax: 0, ay: 0 };
        var map = E.tilemap({
            cols: cols, rows: rows, cell: tm.cell, ox: tm.ox, oy: tm.oy, data: data,
            // tileset com solidity por TILE (Studio): o valor da celula
            // manda, entao map.set() para quebrar caixa/abrir saida ja
            // atualiza a colisao; cenas antigas usam a grade `solids`.
            solid: function (v, c, r) {
                if (solidValues && v !== undefined && v !== null && v >= 0) {
                    return !!solidValues[v];
                }
                return !!(solids && solids[r * cols + c]);
            },
            paint: function (c, r, x, y) {
                var v = data[r * cols + c];
                if (auto) {
                    var mask = map.autotile(c, r);
                    var alt = auto[mask];
                    if (alt !== undefined && alt !== null) v = alt;
                }
                if (v === undefined || v === null || v < 0) return;
                if (!E.spr) return;
                // tilemap desenha a celula pelo CANTO: o slot da folha pode
                // ter ax/ay do .spr.meta (pivot 0.5 por default), e usa-lo
                // aqui deslocava cada tile meia celula (buracos pretos nas
                // bordas/portas)
                var slot = tileSlots[v];
                if (!slot) slot = tileSlots[v] = asset.n + '#' + v;
                E.spr.stamp(slot, x - E.cam.x + E.cam.ox,
                            y - E.cam.y + E.cam.oy, tileOpts);
            }
        });
        map.all();
        return map;
    }

    function spriteOpts(e) {
        // ax/ay ausentes = ancora do metadado (E.spr.meta/slot), nao 0.5 fixo.
        // rot (graus, como o editor grava) e sy sao aplicados de verdade desde
        // o spr 1.7: giro pelo drawSprite e escala por eixo no caminho afim
        var sx = e.sx > 0 ? e.sx : 1, sy = e.sy > 0 ? e.sy : sx;
        var o = { scale: sx, key: e.key };
        if (sy !== sx) o.scaleY = sy;
        if (e.rot) o.angle = e.rot;
        if (e.ax !== undefined) o.ax = e.ax;
        if (e.ay !== undefined) o.ay = e.ay;
        return o;
    }

    function frameOf(e) {
        if (e.anim && e.anim.frames.length) return e.anim.frames[e.anim.i];
        return e.spr || null;
    }

    function textPx(t) {
        if (t.px !== undefined) return t.px;
        if (t.ts) return (E.ts[t.ts] || 13) * E.U;
        return 13 * E.U;
    }

    function entityWH(e) {
        var f = frameOf(e);
        if (f && E.spr && E.spr.size) {
            var s = E.spr.size(f);
            if (s) return { w: s.w * (e.sx > 0 ? e.sx : 1), h: s.h * (e.sy > 0 ? e.sy : 1) };
        }
        if (e.text) {
            var t = e.text, px = textPx(t);
            var o = { px: px };
            var w = 0;
            try { w = E.gfx.measure(t.text, o); } catch (err) { w = String(t.text).length * 8; }
            var fh = 10;
            try { fh = E.font(px).h; } catch (err2) { fh = px; }
            return { w: w, h: fh };
        }
        if (e.shape) {
            var sh = e.shape;
            if (sh.shape === 'circle') { var r = sh.r || (sh.w || 0) / 2; return { w: r * 2, h: r * 2 }; }
            if (sh.shape === 'line') return { w: Math.abs(sh.x2 || 0), h: Math.abs(sh.y2 || 0) };
            return { w: sh.w || 0, h: sh.h || 0 };
        }
        return null;
    }

    var _hudOut = { x: 0, y: 0, w: 0, h: 0 };
    function hudBox(e) {
        if (!E.anchor) return null;
        var wh = entityWH(e);
        if (!wh) return null;
        return E.anchor(e.hud.a | 0, e.hud.mx || 0, e.hud.my || 0, wh.w, wh.h, _hudOut);
    }

    function drawHud(e, b) {
        var f = frameOf(e);
        if (f && E.spr) {
            var s = E.spr._slots[f];
            var ax = e.ax !== undefined ? e.ax : (s && s.ax !== undefined ? s.ax : 0);
            var ay = e.ay !== undefined ? e.ay : (s && s.ay !== undefined ? s.ay : 0);
            var wh = entityWH(e);
            E.spr.stamp(f, b.x + wh.w * ax, b.y + wh.h * ay,
                        { scale: e.sx > 0 ? e.sx : 1, ax: ax, ay: ay, key: e.key });
        }
        if (e.text) {
            var t = e.text;
            var o = { color: t.color, screen: true, align: 'left', valign: 'top' };
            if (t.px !== undefined) o.px = t.px;
            if (t.ts) o.ts = t.ts;
            if (t.shadow !== undefined && t.shadow !== null && t.shadow !== '') o.shadow = t.shadow;
            E.gfx.text(t.text, b.x, b.y, o);
        }
        if (e.shape) {
            var sh = e.shape;
            if (sh.shape === 'circle') {
                E.gfx.circle(b.x + b.w / 2, b.y + b.h / 2, sh.r || (sh.w || 0) / 2,
                             sh.color, { fill: sh.fill !== false, screen: true });
            } else if (sh.shape === 'line') {
                E.gfx.line(b.x, b.y, b.x + (sh.x2 || 0), b.y + (sh.y2 || 0),
                           sh.color, { w: sh.w, screen: true });
            } else {
                E.gfx.rect(b.x, b.y, b.w, b.h, sh.color,
                           { fill: sh.fill !== false, screen: true });
            }
        }
    }

    function drawText(e) {
        var t = e.text;
        var o = { color: t.color, align: t.align, valign: t.valign };
        if (t.px !== undefined) o.px = t.px;
        if (t.ts) o.ts = t.ts;
        if (t.shadow !== undefined && t.shadow !== null && t.shadow !== '') o.shadow = t.shadow;
        E.gfx.text(t.text, e.x, e.y, o);
    }

    function drawShape(e) {
        var sh = e.shape;
        if (sh.shape === 'circle') {
            E.gfx.circle(e.x, e.y, sh.r || sh.w / 2, sh.color, { fill: sh.fill !== false });
        } else if (sh.shape === 'line') {
            E.gfx.line(e.x, e.y, e.x + (sh.x2 || 0), e.y + (sh.y2 || 0), sh.color, { w: sh.w });
        } else {
            E.gfx.rect(e.x - (sh.w || 0) / 2, e.y - (sh.h || 0) / 2,
                       sh.w || 0, sh.h || 0, sh.color, { fill: sh.fill !== false });
        }
    }

    function enterScene(s, arg) {
        var def = s._def;
        var k, i, j;
        s.arg = arg;
        var load = def.load || [];
        for (k = 0; k < load.length; k++) loadAsset(A[load[k]]);

        var ents = def.entities || [];
        for (i = 0; i < ents.length; i++) {
            var d = ents[i];
            var ent = {
                fid: d.fid, name: d.name,
                active: d.active !== false,
                x: d.x, y: d.y, rot: d.rot, sx: d.sx, sy: d.sy,
                ax: d.ax, ay: d.ay, z: d.z,
                spr: null, key: 0, anim: null, clips: null, playing: false,
                text: null, shape: null, col: null, hud: null, meta: null,
                data: null, scripts: [], fields: {}, current: ''
            };
            // hitbox do metadado na MESMA origem do desenho, em coords de MUNDO
            ent.box = function (scale, out) {
                var f = frameOf(this);
                if (!f || !E.spr || !E.spr.box) return null;
                var camx = E.cam ? E.cam.x - E.cam.ox : 0;
                var camy = E.cam ? E.cam.y - E.cam.oy : 0;
                var b = E.spr.box(f, this.x - camx, this.y - camy, scale, out);
                if (b) { b[0] += camx; b[1] += camy; }
                return b;
            };
            ent.setClip = function (clip, reset) {
                if (this.meta && E.spr && E.spr.animOf) {
                    var a = E.spr.animOf(this.meta, clip);
                    if (a) {
                        this.anim = a;
                        this.current = clip;
                        this.playing = true;
                        if (reset) a.reset();
                        return true;
                    }
                }
                var c = this.clips && this.clips[clip];
                if (!c) return false;
                this.current = clip;
                if (this.anim) this.anim.play(c.frames, c.fps, c.loop);
                this.playing = true;
                if (reset && this.anim) this.anim.reset();
                return true;
            };
            var comps = d.comps || [];
            for (j = 0; j < comps.length; j++) {
                var c = comps[j];
                if (c.t === 'spr') { ent.spr = c.s; ent.key = c.key; }
                else if (c.t === 'anim') {
                    ent.clips = c.clips || {};
                    ent.meta = c.meta || null;
                    ent.current = c.current || firstKey(ent.clips);
                    if (ent.meta && E.spr && E.spr.animOf && ent.current) {
                        ent.anim = E.spr.animOf(ent.meta, ent.current);
                    }
                    var cl = ent.clips[ent.current];
                    if (!ent.anim && cl && E.anim) {
                        ent.anim = E.anim(cl.frames, cl.fps, cl.loop);
                    }
                    if (ent.anim) ent.playing = c.autoplay !== false;
                } else if (c.t === 'txt') { ent.text = c; }
                else if (c.t === 'shape') { ent.shape = c; }
                else if (c.t === 'col') { ent.col = c; }
                else if (c.t === 'hud') { ent.hud = c; }
                else if (c.t === 'data') { ent.data = c.fields || {}; }
                else if (c.t === 'script') {
                    ent.fields[c.id || ('s' + j)] = c.fields || {};
                    var mod = null;
                    try { mod = require(c.m); }
                    catch (errReq) {
                        // script quebrado (sintaxe/require) nao pode sumir:
                        // a entidade rodaria "muda" sem nenhuma pista no log
                        mod = null;
                        try { S.print('[studio] script ' + c.m + ' falhou: ' + errReq); } catch (e2) {}
                    }
                    if (mod) {
                        var ctx = {
                            E: E, scene: s, entity: ent, assets: A, arg: arg,
                            save: E.save, data: E.data,
                            asset: function (n) { return byName[n] || null; },
                            go: function (n, o) {
                                var key = scenes[n] ? n : (NAME[n] || n);
                                // o 2o argumento do ctx.go e o arg da cena
                                E.goto(key, { arg: o });
                            }
                        };
                        var inst = mod.create ? mod.create(ctx) : {};
                        if (!inst) inst = {};
                        inst.fields = c.fields || {};
                        inst.entity = ent;
                        inst._mod = mod;
                        inst._ctx = ctx;
                        ent.scripts.push(inst);
                    }
                }
            }
            s._ents.push(ent);
        }
        s._ents.sort(function (a, b) { return (a.z || 0) - (b.z || 0); });

        var tms = def.tilemaps || [];
        for (i = 0; i < tms.length; i++) {
            var asset = A[tms[i].tileset];
            if (asset && E.tilemap) s._tms.push({ def: tms[i], map: makeTilemap(tms[i], asset) });
        }
        s._tms.sort(function (a, b) { return (a.def.layer || 0) - (b.def.layer || 0); });

        // API de jogo para scripts: entidades/tilemaps/dados da cena
        s.entities = s._ents;
        s.tilemaps = s._tms;
        s.title = def.title || s._def.name;
        s.data = def.data || {};
        s.find = function (ref) {
            for (var ei = 0; ei < s._ents.length; ei++) {
                if (s._ents[ei].fid === ref || s._ents[ei].name === ref) return s._ents[ei];
            }
            return null;
        };
        s.tm = function (id) {
            for (var ti = 0; ti < s._tms.length; ti++) if (s._tms[ti].def.id === id) return s._tms[ti].map;
            return null;
        };
        s.solidAt = function (x, y) {
            for (var ti = 0; ti < s._tms.length; ti++) {
                var t = s._tms[ti].def;
                if (t.cols && t.rows && t.cell &&
                    x >= (t.ox || 0) && y >= (t.oy || 0) &&
                    x < (t.ox || 0) + t.cols * t.cell &&
                    y < (t.oy || 0) + t.rows * t.cell) {
                    if (s._tms[ti].map.solidAt(x, y)) return true;
                }
            }
            return false;
        };
        s.rectSolid = function (x, y, w, h) {
            for (var ti = 0; ti < s._tms.length; ti++) {
                var t = s._tms[ti].def;
                if (t.cols && t.rows && t.cell &&
                    x < (t.ox || 0) + t.cols * t.cell && x + w > (t.ox || 0) &&
                    y < (t.oy || 0) + t.rows * t.cell && y + h > (t.oy || 0)) {
                    if (s._tms[ti].map.rectSolid(x, y, w, h)) return true;
                }
            }
            return false;
        };
        s.asset = function (n) { return byName[n] || null; };

        // pintor do fundo: apaga a caixa suja com a cor da cena e MARCA as
        // celulas de tilemap que ela toca (o flush do draw repinta por cima).
        // Sem isso o rastro de quem anda vira buraco preto.
        if (E.dirty) {
            var bg = def.bg === undefined ? 0x0000 : def.bg;
            E.dirty.enable(function (x, y, w, h) {
                S.fillRect(x, y, w, h, bg);
                // camera do quadro (dinamica: o painter roda antes do draw)
                var wx = x + (E.cam ? E.cam.x - E.cam.ox : 0);
                var wy = y + (E.cam ? E.cam.y - E.cam.oy : 0);
                for (var i = 0; i < s._tms.length; i++) s._tms[i].map.markRect(wx, wy, w, h);
            });
        }
        if (E.cam) {
            E.cam.reset();
            var camDef = def.camera;
            if (camDef) {
                if (camDef.bounds) {
                    E.cam.bounds = { x: camDef.bounds[0], y: camDef.bounds[1],
                                     w: camDef.bounds[2], h: camDef.bounds[3] };
                }
                if (camDef.follow) {
                    var target = null;
                    for (var fi = 0; fi < s._ents.length; fi++) {
                        if (s._ents[fi].fid === camDef.follow) { target = s._ents[fi]; break; }
                    }
                    if (target) {
                        var dz = camDef.deadzone
                            ? { w: camDef.deadzone[0], h: camDef.deadzone[1] } : null;
                        E.cam.follow(target, 1, { deadzone: dz });
                    }
                }
            }
        }
        s._camX = -1;
        s._camY = -1;

        var music = def.music && A[def.music];
        if (music && typeof S.playWav === 'function' &&
            E.spr && E.spr.bases && E.spr.bases.length) {
            try { S.playWav(E.spr.bases[0] + music.f); } catch (e) {}
        }

        // start() depois de TODAS as entidades/tilemaps: o controlador da
        // cena ja encontra o mundo inteiro montado
        for (i = 0; i < s._ents.length; i++) {
            var se = s._ents[i];
            if (se.active === false) continue;
            for (j = 0; j < se.scripts.length; j++) {
                var si = se.scripts[j];
                if (si._mod.start) si._mod.start.call(si, si._ctx);
            }
        }
    }

    function updateScene(s, dt) {
        var ents = s._ents;
        for (var i = 0; i < ents.length; i++) {
            var e = ents[i];
            if (e.active === false) continue;
            if (e.anim && e.playing) e.anim.tick(dt);
            var scr = e.scripts;
            for (var j = 0; j < scr.length; j++) {
                var inst = scr[j];
                if (inst._mod.update) inst._mod.update.call(inst, dt, inst._ctx);
            }
        }
    }

    function drawScene(s) {
        var i, j;
        var cx = E.cam ? E.cam.x : 0;
        var cy = E.cam ? E.cam.y : 0;
        if (cx !== s._camX || cy !== s._camY) {
            for (i = 0; i < s._tms.length; i++) s._tms[i].map.all();
            s._camX = cx;
            s._camY = cy;
        }
        for (i = 0; i < s._tms.length; i++) s._tms[i].map.flush();

        var ox = E.cam ? E.cam.ox : 0;
        var oy = E.cam ? E.cam.oy : 0;
        var ents = s._ents;
        for (i = 0; i < ents.length; i++) {
            var e = ents[i];
            if (e.active === false) continue;
            var sx = e.x - cx + ox;
            var sy = e.y - cy + oy;
            var hb = e.hud ? hudBox(e) : null;
            if (hb) {
                // HUD: E.ax/ay/anchor posicionam na tela (inset do vidro incluso)
                drawHud(e, hb);
            } else {
                if (e.anim && e.anim.frames.length) {
                    var fr = e.anim.frames[e.anim.i];
                    if (fr && E.spr) E.spr.stamp(fr, sx, sy, spriteOpts(e));
                } else if (e.spr && E.spr) {
                    E.spr.stamp(e.spr, sx, sy, spriteOpts(e));
                }
                if (e.text) drawText(e);
                if (e.shape) drawShape(e);
            }
            var scr = e.scripts;
            for (j = 0; j < scr.length; j++) {
                var inst = scr[j];
                if (inst._mod.draw) inst._mod.draw.call(inst, inst._ctx);
            }
        }
    }

    function exitScene(s) {
        var i, j;
        for (i = 0; i < s._ents.length; i++) {
            var scr = s._ents[i].scripts;
            for (j = 0; j < scr.length; j++) {
                var inst = scr[j];
                if (inst._mod.destroy) inst._mod.destroy.call(inst, inst._ctx);
            }
        }
        s._ents.length = 0;
        s._tms.length = 0;
        if (E.spr) E.spr.freeAll();
        if (E.cam) E.cam.reset();
    }

    function buildScene(name, def) {
        var s = {
            fps: def.fps,
            static: !!def.static,
            _def: def,
            title: def.title || name,
            data: def.data || {},
            arg: undefined,
            _ents: [],
            _tms: [],
            _camX: -1,
            _camY: -1
        };
        s.enter = function (arg) { enterScene(this, arg); };
        s.exit = function () { exitScene(this); };
        s.update = function (dt) { updateScene(this, dt); };
        s.draw = function () { drawScene(this); };
        return s;
    }

    var scenes = {};
    var name;
    for (name in SC) scenes[name] = buildScene(name, SC[name]);
    var start = data.start;
    if (!scenes[start]) {
        for (start in scenes) break;
    }
    if (start) E.run(scenes, start);
}
