// Runtime de cenas do Celer Studio (ES5, Duktape). Este arquivo NAO e um
// modulo: o build concatena este corpo dentro do main.js gerado e chama
// studioBoot(E, require("game.data")). Toda cena/prefab foi achatada no
// build; aqui so existe entidade + componentes de dados.

function studioBoot(E, data) {
    var S = System;
    var A = data.assets || {};
    var SC = data.scenes || {};

    function firstKey(obj) {
        for (var k in obj) return k;
        return '';
    }

    function loadAsset(a) {
        if (!a || !E.spr) return;
        if (a.t === 'g') {
            E.spr.sheet(a.n, { file: a.f, w: a.w, h: a.h,
                               tw: a.tw || 16, th: a.th || 16,
                               regions: a.regions || {} });
        } else if (a.t === 's') {
            E.spr.load([{ name: a.n, file: a.f, w: a.w, h: a.h }]);
        }
    }

    function makeTilemap(tm, asset) {
        var cols = tm.cols, rows = tm.rows, data = tm.data, solids = tm.solids;
        var auto = tm.autotile || null;
        var map = E.tilemap({
            cols: cols, rows: rows, cell: tm.cell, ox: tm.ox, oy: tm.oy, data: data,
            solid: function (v, c, r) {
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
                E.spr.stamp(asset.n + '#' + v,
                            x - E.cam.x + E.cam.ox,
                            y - E.cam.y + E.cam.oy, { scale: 1 });
            }
        });
        map.all();
        return map;
    }

    function spriteOpts(e) {
        return { scale: e.sx > 0 ? e.sx : 1, ax: e.ax, ay: e.ay, key: e.key };
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

    function enterScene(s) {
        var def = s._def;
        var k, i, j;
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
                text: null, shape: null, col: null,
                scripts: [], fields: {}, current: ''
            };
            ent.setClip = function (clip, reset) {
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
                    ent.current = c.current || firstKey(ent.clips);
                    var cl = ent.clips[ent.current];
                    if (cl && E.anim) {
                        ent.anim = E.anim(cl.frames, cl.fps, cl.loop);
                        ent.playing = c.autoplay !== false;
                    }
                } else if (c.t === 'txt') { ent.text = c; }
                else if (c.t === 'shape') { ent.shape = c; }
                else if (c.t === 'col') { ent.col = c; }
                else if (c.t === 'script') {
                    ent.fields[c.id || ('s' + j)] = c.fields || {};
                    var mod = null;
                    try { mod = require(c.m); } catch (e) { mod = null; }
                    if (mod) {
                        var ctx = { E: E, scene: s, entity: ent, assets: A };
                        var inst = mod.create ? mod.create(ctx) : {};
                        if (!inst) inst = {};
                        inst.fields = c.fields || {};
                        inst.entity = ent;
                        inst._mod = mod;
                        inst._ctx = ctx;
                        ent.scripts.push(inst);
                        if (mod.start) mod.start.call(inst, ctx);
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
            if (e.anim && e.anim.frames.length) {
                var fr = e.anim.frames[e.anim.i];
                if (fr && E.spr) E.spr.stamp(fr, sx, sy, spriteOpts(e));
            } else if (e.spr && E.spr) {
                E.spr.stamp(e.spr, sx, sy, spriteOpts(e));
            }
            if (e.text) drawText(e);
            if (e.shape) drawShape(e);
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
            _ents: [],
            _tms: [],
            _camX: -1,
            _camY: -1
        };
        s.enter = function () { enterScene(this); };
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
