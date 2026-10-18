// game.world.js — CelerGame WORLD (dep "celeros.game.world"): mundo em
// SALAS do tamanho da tela, no estilo das aventuras de 8/16 bits — areas
// (overworld, masmorras) em grade de salas desenhadas em ASCII, troca de
// sala deslizando a tela, estado que persiste por sala (bau aberto, porta
// destrancada, parede explodida), visitas e minimapa. Decora o core:
//
//   var E = require("celeros.game");
//   require("celeros.game.world");
//   var W = E.world({
//       cols: 15, rows: 13, cell: 32, ox: 0, oy: 64,   // sala na tela
//       legend: { '#': 'parede', '.': 'chao', '~': 'agua', '@': { spawn: 'heroi', tile: 'chao' } },
//       areas: { campo: { w: 4, h: 3, rooms: { '0,0': ["###...", ...], ... } } },
//       paint: function (v, x, y, w, h) { E.spr.stamp("t_" + v, x, y, { key: null }); },
//       solid: function (v) { return v === 'parede' || v === 'agua'; },
//       anim: { ms: 450, frames: { agua: ['agua', 'agua2'] } },
//       save: 'mundo'
//   });
//   W.go('campo', 1, 2);                         // entra (sem transicao)
//   E.dirty.enable(W.painter);                   // fundo = sala gravada
//   // update:  var d = W.edge(heroi); if (d) W.move(d);   (desliza)
//   //          if (W.sliding) return;            (o mundo congela no slide)
//   // draw:    W.draw(); ...entidades...
//   E.collide.move(heroi, dx, dy, W);            // W e um mapa de colisao
//
// A sala corrente e GRAVADA uma vez num sprite do tamanho da tela (com
// drawSprite, API 33) e a camada suja repinta dele com blitSprite (API 34)
// — 1 chamada por caixa, sem redesenhar tiles. O slide grava a vizinha num
// 2o sprite e empurra os dois deslocados (2 pushes por quadro). Sem sprite
// livre / sem drawSprite o mundo cai no desenho por celula (paint direto)
// e a troca vira corte seco.
//
// Coordenadas: tudo em pixels de TELA (sala fixa na tela: a camera fica
// parada). celula (c, r) da sala -> x = ox + c * cell, y = oy + r * cell.
//
// 1.0.1: solidAt/rectSolid sem sala corrente (mundo criado, ainda sem
// go/restore — o app recria o mundo no meio da cena) devolvem o outside em
// vez de ler data de null e derrubar o app no primeiro update.
// 1.0.2: a gravacao da sala marca E.spr.alvo (o stamp nao pega o atalho
// do pushSprite, que so desenha no quadro); W.fechado = a colisao com a
// borda da sala solida (monstros/tiros nao saem pelas aberturas).
// 1.1.0: opcao tile(v) -> nome de regiao do E.spr: a sala grava num laco
// inline com System.copySprite (API 45), sem o paint por celula (troca de
// sala da Lenda no 4848: gravacao ~180 -> ~80 ms, troca ~250 -> ~120 ms).

var E = require('celeros.game');
require('celeros.game.level');
var S = System;

var DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
var _rc = { x: 0, y: 0, w: 0, h: 0 };
var _cell = { c: 0, r: 0 };

E.world = function (o) {
    o = o || {};
    var cols = o.cols || 15, rows = o.rows || 13;
    var cell = o.cell || 32, ox = o.ox || 0, oy = o.oy || 0;
    var areas = o.areas || {};
    var paint = o.paint || function () {};
    // 1.1.0: tile(v) -> nome de sprite/regiao do E.spr (no lugar do paint
    // por celula): a regiao e resolvida 1x por valor e a sala e gravada com
    // System.copySprite direto (API 45). Pelo paint, cada tile passava por
    // paintCell -> frameOf -> paint -> (app) -> stamp -> nativa: ~0,65 ms de
    // JS por tile, ~130 ms dos ~180 da troca de sala da Lenda no 4848
    var tileOf = o.tile || null;
    var HAS_COPY = typeof S.copySprite === 'function';
    var _tc = {};           // valor -> {id, rx, ry, nm} (id 0 = vai pelo stamp)
    var _opaco = { key: null };
    function regOf(v) {
        var nm = tileOf(v), sl = E.spr && E.spr._slots[nm];
        var id = sl && !sl.alias ? (sl.sheet ? sl.sheet.id : sl.id) : 0;
        var rg = { id: id && sl.w === cell && sl.h === cell ? id : 0,
                   rx: sl && sl.sheet ? sl.rx : 0, ry: sl && sl.sheet ? sl.ry : 0, nm: nm };
        _tc[v] = rg;
        return rg;
    }
    // uma celula pelo tile (copia direta) ou pelo stamp do nome
    function tileCell(v, x, y) {
        var rg = _tc[v] || regOf(v);
        if (rg.id && HAS_COPY) S.copySprite(rg.id, rg.rx, rg.ry, cell, cell, x, y);
        else if (E.spr) E.spr.stamp(rg.nm, x, y, _opaco);
    }
    var solid = o.solid || function (v) { return !!v; };
    var anim = o.anim || null;
    var saveKey = o.save || null;
    var W = {
        version: E.world.version,
        cols: cols, rows: rows, cell: cell, cw: cell, ch: cell, ox: ox, oy: oy,
        pw: cols * cell, ph: rows * cell,       // tamanho da sala em px
        area: null, room: null,
        sliding: false, slideDir: null, slideP: 0, slideMs: o.slideMs || 500,
        visited: {}, flags: {},                  // flags: id da sala -> {chave: v}
        global: {},                              // flags do jogo (fora de sala)
        baked: false, outside: o.outside !== false,
        onEnter: o.onEnter || null, onExit: o.onExit || null,
        _slotA: 0, _slotB: 0, _next: null, _anim: 0, _animT: 0, _animCells: [],
        _pendCells: []
    };
    var hasDraw = typeof S.drawSprite === 'function' && typeof S.createSprite === 'function' &&
                  o.bake !== false;

    // ------------------------------------------------- salas e flags --
    function roomId(area, c, r) { return area + ':' + c + ',' + r; }
    function defOf(area, c, r) {
        var A = areas[area];
        if (!A || !A.rooms) return null;
        return A.rooms[c + ',' + r] || null;
    }
    W.has = function (area, c, r) { return !!defOf(area, c, r); };
    // monta o registro da sala: dados mutaveis (copia do level) + mods
    // persistidos reaplicados
    function load(area, c, r) {
        var d = defOf(area, c, r);
        if (!d) throw new Error('world: sala inexistente ' + roomId(area, c, r));
        var lines = d.lines || d;
        var A = areas[area];
        var lv = E.level.parse(lines, { legend: d.legend || A.legend || o.legend || {},
                                        cell: cell, ox: ox, oy: oy, meta: d.meta || null });
        if (lv.cols !== cols || lv.rows !== rows) {
            throw new Error('world: sala ' + roomId(area, c, r) + ' tem ' + lv.cols + 'x' + lv.rows +
                            ' (esperado ' + cols + 'x' + rows + ')');
        }
        var rec = { id: roomId(area, c, r), area: area, c: c, r: r, lv: lv,
                    data: lv.data.slice(), meta: d.meta || {}, def: d };
        var fl = W.flags[rec.id];
        if (fl && fl._mods) {
            for (var k in fl._mods) {
                var i = +k;
                if (i >= 0 && i < rec.data.length) rec.data[i] = fl._mods[k];
            }
        }
        return rec;
    }
    // flag da sala corrente (ou de outra: W.flagIn(id, k)); v ausente le
    W.flag = function (k, v) { return W.flagIn(W.room ? W.room.id : '', k, v); };
    W.flagIn = function (id, k, v) {
        var f = W.flags[id];
        if (v === undefined) return f ? f[k] : undefined;
        if (!f) f = W.flags[id] = {};
        f[k] = v;
        if (saveKey && o.autosave !== false) W.save();
        return v;
    };
    W.gflag = function (k, v) {
        if (v === undefined) return W.global[k];
        W.global[k] = v;
        if (saveKey && o.autosave !== false) W.save();
        return v;
    };
    // spawns da sala menos os ja coletados/derrotados de vez (flag
    // 'got:<indice>' — W.take(spawn) marca)
    W.spawns = function () {
        var out = [], sp = W.room ? W.room.lv.spawns : [];
        for (var i = 0; i < sp.length; i++) {
            sp[i].i = i;
            if (!W.flag('got:' + i)) out.push(sp[i]);
        }
        return out;
    };
    W.take = function (spawn) { W.flag('got:' + spawn.i, true); };

    // ---------------------------------------------------- celulas ------
    W.get = function (c, r) {
        if (!W.room || c < 0 || r < 0 || c >= cols || r >= rows) return undefined;
        return W.room.data[r * cols + c];
    };
    // muda a celula (repinta ja); persist grava no save da sala (bau
    // aberto, porta destrancada) — sem persist volta ao ASCII na proxima visita
    W.set = function (c, r, v, persist) {
        if (!W.room || c < 0 || r < 0 || c >= cols || r >= rows) return false;
        var k = r * cols + c;
        W.room.data[k] = v;
        if (persist) {
            var f = W.flags[W.room.id] || (W.flags[W.room.id] = {});
            if (!f._mods) f._mods = {};
            f._mods[k] = v;
            if (saveKey && o.autosave !== false) W.save();
        }
        W._pendCells.push(k);
        return true;
    };
    // muda persistente uma celula de OUTRA sala (a parede rachada que
    // explodiu daqui abre tambem do lado de la); vale na proxima entrada
    W.setIn = function (area, rc, rr, c, r, v) {
        if (rc === undefined) return false;
        var id = roomId(area, rc, rr);
        if (W.room && W.room.id === id) return W.set(c, r, v, true);
        var f = W.flags[id] || (W.flags[id] = {});
        if (!f._mods) f._mods = {};
        f._mods[r * cols + c] = v;
        if (saveKey && o.autosave !== false) W.save();
        return true;
    };
    W.cellRect = function (c, r) {
        _rc.x = ox + c * cell; _rc.y = oy + r * cell; _rc.w = cell; _rc.h = cell;
        return _rc;
    };
    // pixel de tela -> celula da sala (objeto reaproveitado; null fora)
    W.toCell = function (x, y) {
        var c = Math.floor((x - ox) / cell), r = Math.floor((y - oy) / cell);
        if (c < 0 || r < 0 || c >= cols || r >= rows) return null;
        _cell.c = c; _cell.r = r;
        return _cell;
    };
    W.find = function (v) {
        var out = [];
        if (!W.room) return out;
        for (var k = 0; k < W.room.data.length; k++) {
            if (W.room.data[k] === v) out.push({ c: k % cols, r: (k - k % cols) / cols });
        }
        return out;
    };
    // mapa de colisao (collide.move/ray, combat.shot, path.grid). Mundo sem
    // sala corrente (criado, ainda sem go/restore — o app troca o mundo no
    // meio da cena): responde "fora" em vez de ler data de null e derrubar
    // o app no update seguinte
    W.solidAt = function (x, y) {
        if (!W.room) return W.outside;
        var c = Math.floor((x - ox) / cell), r = Math.floor((y - oy) / cell);
        if (c < 0 || r < 0 || c >= cols || r >= rows) return W.outside;
        return !!solid(W.room.data[r * cols + c], c, r);
    };
    W.rectSolid = function (x, y, w, h) {
        if (!W.room) return W.outside;
        var c0 = Math.floor((x - ox) / cell), c1 = Math.floor((x + w - 1 - ox) / cell);
        var r0 = Math.floor((y - oy) / cell), r1 = Math.floor((y + h - 1 - oy) / cell);
        for (var r = r0; r <= r1; r++) {
            for (var c = c0; c <= c1; c++) {
                if (c < 0 || r < 0 || c >= cols || r >= rows) { if (W.outside) return true; continue; }
                if (solid(W.room.data[r * cols + c], c, r)) return true;
            }
        }
        return false;
    };
    // a MESMA colisao com a borda da sala sempre solida (monstros e tiros:
    // com outside false o heroi atravessa a borda para a vizinha, mas o
    // monstro saia pela abertura e andava por cima do HUD)
    W.fechado = {
        cw: cell, ch: cell, ox: ox, oy: oy,
        solidAt: function (x, y) {
            if (x < ox || y < oy || x >= ox + W.pw || y >= oy + W.ph) return true;
            return W.solidAt(x, y);
        },
        rectSolid: function (x, y, w, h) {
            if (x < ox || y < oy || x + w > ox + W.pw || y + h > oy + W.ph) return true;
            return W.rectSolid(x, y, w, h);
        }
    };
    // custo por celula para o E.path (parede = -1)
    W.cost = function (c, r) {
        var v = W.get(c, r);
        return v === undefined || solid(v, c, r) ? -1 : 1;
    };

    // ------------------------------------------------- desenho/bake ----
    function frameOf(v) {
        if (!anim || !anim.frames) return v;
        var fr = anim.frames[v];
        return fr ? fr[W._anim % fr.length] : v;
    }
    function paintCell(rec, k, x0, y0) {
        var c = k % cols, r = (k - c) / cols;
        if (tileOf) { tileCell(frameOf(rec.data[k]), x0 + c * cell, y0 + r * cell); return; }
        paint(frameOf(rec.data[k]), x0 + c * cell, y0 + r * cell, cell, cell, c, r);
    }
    function alloc() {
        if (!hasDraw) return 0;
        if (E.spr && E.spr._used >= E.caps.slots) return 0;
        var id = 0;
        try { id = S.createSprite(E.W, E.H); } catch (e) { id = 0; }
        if (id && E.spr) E.spr._used++;
        return id || 0;
    }
    // grava a sala rec inteira no sprite slot (fundo o.bg fora da sala)
    function bake(rec, slot) {
        if (!slot) return false;
        E.dirty._mute++;
        S.useSprite(slot);
        if (E.spr) E.spr.alvo = slot;
        S.fillScreen(o.bg === undefined ? 0x0000 : o.bg);
        if (tileOf) {
            // laco INLINE (sem paintCell/frameOf por celula); regioes
            // resolvidas de novo a cada gravacao (folha recarregada muda o id)
            _tc = {};
            var fr = anim && anim.frames, d = rec.data, n = d.length;
            for (var q = 0; q < n; q++) {
                var v = d[q];
                if (fr && fr[v]) v = fr[v][W._anim % fr[v].length];
                var rg = _tc[v] || regOf(v);
                var cc = q % cols, x = ox + cc * cell, y = oy + (q - cc) / cols * cell;
                if (rg.id && HAS_COPY) S.copySprite(rg.id, rg.rx, rg.ry, cell, cell, x, y);
                else if (E.spr) E.spr.stamp(rg.nm, x, y, _opaco);
            }
        } else {
            for (var k = 0; k < rec.data.length; k++) paintCell(rec, k, ox, oy);
        }
        if (o.decor) o.decor(rec, W);    // por cima dos tiles, dentro do bake
        if (E.spr) E.spr.alvo = 0;
        S.useSprite(0);
        E.dirty._mute--;
        return true;
    }
    function rebakeCell(k) {
        if (!W.baked || !W._slotA) return;
        E.dirty._mute++;
        S.useSprite(W._slotA);
        if (E.spr) E.spr.alvo = W._slotA;
        var c = k % cols, r = (k - c) / cols;
        S.setClip(ox + c * cell, oy + r * cell, cell, cell);
        paintCell(W.room, k, ox, oy);
        S.clearClip();
        if (E.spr) E.spr.alvo = 0;
        S.useSprite(0);
        E.dirty._mute--;
    }
    function scanAnim() {
        W._animCells.length = 0;
        if (!anim || !anim.frames || !W.room) return;
        for (var k = 0; k < W.room.data.length; k++) {
            if (anim.frames[W.room.data[k]]) W._animCells.push(k);
        }
    }
    // painter da camada suja: copia do fundo gravado (ou repinta celulas)
    W.painter = function (x, y, w, h) {
        if (W.baked && W._slotA) {
            if (typeof S.blitSprite === 'function') { S.blitSprite(W._slotA, x, y, w, h); return; }
            S.setClip(x, y, w, h);
            S.useSprite(W._slotA);
            S.pushSprite(0, 0);
            S.useSprite(0);
            S.clearClip();
            return;
        }
        S.fillRect(x, y, w, h, o.bg === undefined ? 0x0000 : o.bg);
        if (!W.room) return;
        var c0 = Math.max(0, Math.floor((x - ox) / cell)), c1 = Math.min(cols - 1, Math.floor((x + w - 1 - ox) / cell));
        var r0 = Math.max(0, Math.floor((y - oy) / cell)), r1 = Math.min(rows - 1, Math.floor((y + h - 1 - oy) / cell));
        if (c1 < c0 || r1 < r0) return;
        // repintura de FUNDO nao entra na camada suja (senao cada celula
        // repintada se apagaria no quadro seguinte e a lista crescia sem fim)
        E.dirty._mute++;
        S.setClip(x, y, w, h);
        for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) paintCell(W.room, r * cols + c, ox, oy);
        S.clearClip();
        E.dirty._mute--;
    };
    // sala inteira na tela (sem camada suja / 1o quadro)
    W.drawRoom = function () {
        if (!W.room) return;
        if (W.baked && W._slotA) {
            S.useSprite(W._slotA);
            S.pushSprite(0, 0);
            S.useSprite(0);
        } else {
            E.dirty._mute++;
            for (var k = 0; k < W.room.data.length; k++) paintCell(W.room, k, ox, oy);
            E.dirty._mute--;
        }
        if (E.dirty.on) E.dirty.full();
    };

    // --------------------------------------------------- transicoes ----
    function enterRec(rec) {
        if (W.room && W.onExit) W.onExit(W.room, W);
        W.room = rec;
        W.area = rec.area;
        W.visited[rec.id] = true;
        W._pendCells.length = 0;
        scanAnim();
        if (W.onEnter) W.onEnter(rec, W);
        if (E.dirty.on) E.dirty.full();
    }
    // entra direto (corte seco); grava o fundo
    W.go = function (area, c, r) {
        var rec = load(area, c, r);
        if (!W._slotA) W._slotA = alloc();
        W.baked = bake(rec, W._slotA);
        W.sliding = false;
        enterRec(rec);
        return rec;
    };
    // vizinha na direcao dir existe?
    W.neighbor = function (dir) {
        var d = DIRS[dir];
        if (!d || !W.room) return null;
        var c = W.room.c + d[0], r = W.room.r + d[1];
        return defOf(W.room.area, c, r) ? { area: W.room.area, c: c, r: r } : null;
    };
    // desliza para a vizinha (false se nao ha). Durante o slide W.sliding
    // = true: o jogo nao anda (so W.draw + o heroi via W.slideShift)
    W.move = function (dir) {
        if (W.sliding) return false;
        var nb = W.neighbor(dir);
        if (!nb) return false;
        var rec = load(nb.area, nb.c, nb.r);
        if (!W._slotB && W.baked) W._slotB = alloc();
        if (W.baked && W._slotB && bake(rec, W._slotB)) {
            W._next = rec;
            W.sliding = true;
            W.slideDir = dir;
            W.slideP = 0;
            if (W.onExit) W.onExit(W.room, W);
            return true;
        }
        // sem 2o sprite: troca seca
        W.baked = bake(rec, W._slotA);
        enterRec(rec);
        return true;
    };
    // deslocamento (px) de quem esta na sala NOVA durante o slide: o heroi
    // desenha em (x + s.x, y + s.y). Objeto reaproveitado
    var _sh = { x: 0, y: 0 };
    W.slideShift = function () {
        _sh.x = 0; _sh.y = 0;
        if (!W.sliding) return _sh;
        var d = DIRS[W.slideDir], p = E.m.inOutQuad(W.slideP);
        _sh.x = d[0] * W.pw * (1 - p);
        _sh.y = d[1] * W.ph * (1 - p);
        return _sh;
    };
    // borda cruzada pela entidade (centro fora da sala) — 'left'... ou null
    W.edge = function (ent) {
        var w = ent.w || 0, h = ent.h || 0;
        var x = ent.x + w / 2, y = ent.y + h / 2;
        if (x < ox) return 'left';
        if (x >= ox + W.pw) return 'right';
        if (y < oy) return 'up';
        if (y >= oy + W.ph) return 'down';
        return null;
    };
    // reposiciona a entidade na borda oposta (depois do move)
    W.wrapEnt = function (ent, dir) {
        var w = ent.w || 0, h = ent.h || 0, m = 2;
        if (dir === 'left') ent.x = ox + W.pw - w - m;
        else if (dir === 'right') ent.x = ox + m;
        else if (dir === 'up') ent.y = oy + W.ph - h - m;
        else if (dir === 'down') ent.y = oy + m;
    };

    W._tick = function (dt) {
        if (W.sliding) {
            W.slideP += dt * 1000 / W.slideMs;
            if (W.slideP >= 1) {
                W.slideP = 1;
                W.sliding = false;
                // o B vira o fundo corrente
                var t = W._slotA; W._slotA = W._slotB; W._slotB = t;
                var rec = W._next;
                W._next = null;
                var ex = W.onExit;
                W.onExit = null;          // o exit ja rodou no inicio do slide
                enterRec(rec);
                W.onExit = ex;
            }
            return;
        }
        if (anim && W._animCells.length) {
            W._animT += dt * 1000;
            if (W._animT >= (anim.ms || 400)) {
                W._animT = 0;
                W._anim++;
                for (var i = 0; i < W._animCells.length; i++) W._pendCells.push(W._animCells[i]);
            }
        }
    };
    // no draw da cena, ANTES das entidades: slide e celulas mudadas
    W.draw = function () {
        if (W.sliding) {
            var d = DIRS[W.slideDir], p = E.m.inOutQuad(W.slideP);
            var ax = -d[0] * W.pw * p, ay = -d[1] * W.ph * p;
            var bx = ax + d[0] * W.pw, by = ay + d[1] * W.ph;
            S.setClip(ox, oy, W.pw, W.ph);
            S.useSprite(W._slotA);
            S.pushSprite(Math.round(ax), Math.round(ay));
            S.useSprite(W._slotB);
            S.pushSprite(Math.round(bx), Math.round(by));
            S.useSprite(0);
            S.clearClip();
            if (E.dirty.on) E.dirty.add(ox, oy, W.pw, W.ph);
            return;
        }
        if (!W._pendCells.length) return;
        for (var i = 0; i < W._pendCells.length; i++) {
            var k = W._pendCells[i], c = k % cols, r = (k - c) / cols;
            rebakeCell(k);
            var x = ox + c * cell, y = oy + r * cell;
            if (E.dirty.on) E.dirty.erase(x, y, cell, cell);
            else W.painter(x, y, cell, cell);
        }
        W._pendCells.length = 0;
    };

    // ------------------------------------------------- mapa / save ----
    // minimapa da area corrente: salas visitadas (cor), a atual (destaque),
    // as nao visitadas so com o.reveal (mapa achado). o {size (px por
    // sala, 8), gap (1), color, here, dim, reveal, screen}
    W.minimap = function (x, y, mo) {
        mo = mo || {};
        var A = areas[W.area];
        if (!A) return { w: 0, h: 0 };
        var sz = mo.size || 8, gap = mo.gap === undefined ? 1 : mo.gap;
        var aw = A.w || 1, ah = A.h || 1;
        for (var r = 0; r < ah; r++) {
            for (var c = 0; c < aw; c++) {
                if (!A.rooms[c + ',' + r]) continue;
                var id = roomId(W.area, c, r);
                var vis = W.visited[id];
                if (!vis && !mo.reveal) continue;
                var here = W.room && W.room.c === c && W.room.r === r;
                var col = here ? (mo.here === undefined ? 0xFFE0 : mo.here) :
                          (vis ? (mo.color === undefined ? 0x07FF : mo.color) : (mo.dim === undefined ? 0x4208 : mo.dim));
                E.gfx.rect(x + c * (sz + gap), y + r * (sz + gap), sz, sz, col, _mmO);
            }
        }
        return { w: aw * (sz + gap) - gap, h: ah * (sz + gap) - gap };
    };
    var _mmO = { screen: true };
    W.toJSON = function () { return { flags: W.flags, global: W.global, visited: W.visited }; };
    W.load = function (v) {
        if (!v) return W;
        W.flags = v.flags || {};
        W.global = v.global || {};
        W.visited = v.visited || {};
        return W;
    };
    W.save = function () { if (saveKey) E.save.setObj(saveKey, W.toJSON()); };
    // volta do save (true se havia)
    W.restore = function () {
        if (!saveKey) return false;
        var v = E.save.obj(saveKey, null);
        if (!v) return false;
        W.load(v);
        return true;
    };
    W.reset = function () { W.flags = {}; W.global = {}; W.visited = {}; W.save(); };
    // libera os sprites (saida do jogo)
    W.free = function () {
        var ids = [W._slotA, W._slotB === W._slotA ? 0 : W._slotB];
        for (var i = 0; i < ids.length; i++) {
            if (!ids[i]) continue;
            try { S.deleteSprite(ids[i]); } catch (e) {}
            if (E.spr && E.spr._used > 0) E.spr._used--;
        }
        W._slotA = W._slotB = 0;
        W.baked = false;
        var k = _live.indexOf(W);
        if (k >= 0) _live.splice(k, 1);
    };
    _live.push(W);
    return W;
};
var _live = [];
E.world.version = '1.1.0';

E._modTicks.push(function (dt) {
    for (var i = 0; i < _live.length; i++) _live[i]._tick(dt);
});
E._mods.push('world');

module.exports = E;
