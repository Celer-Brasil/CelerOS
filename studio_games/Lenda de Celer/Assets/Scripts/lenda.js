// lenda.js - controlador da versao NATIVA da Lenda de Celer no Celer Studio.
// Cada sala e uma cena com tilemap 15x13 (cell 32, HUD de 64 px) e os
// spawns como entidades. O script cuida do heroi, combate, baus, Sabio,
// loja, portais, save automatico e HUD. ES5.

var SONG = {
    bpm: 108, loops: 8,
    tracks: [
        { wave: 'tri', vol: 46, notes: [
            [45, 4], [52, 4], [57, 4], [52, 4],
            [43, 4], [50, 4], [55, 4], [50, 4],
            [41, 4], [48, 4], [53, 4], [48, 4],
            [45, 4], [52, 4], [57, 4], [52, 4]
        ] },
        { wave: 'sq25', vol: 22, notes: [
            [69, 2], [72, 2], [76, 2], [72, 2], [69, 2], [72, 2], [76, 2], [72, 2],
            [67, 2], [71, 2], [74, 2], [71, 2], [67, 2], [71, 2], [74, 2], [71, 2],
            [65, 2], [69, 2], [72, 2], [69, 2], [65, 2], [69, 2], [72, 2], [69, 2],
            [69, 2], [72, 2], [76, 2], [72, 2], [69, 2], [72, 2], [76, 2], [72, 2]
        ] },
        { drum: true, vol: 30, notes: [
            [36, 4], [42, 2], [38, 2], [36, 4], [42, 4],
            [36, 4], [42, 2], [38, 2], [36, 4], [42, 4]
        ] }
    ]
};

var CELL = 32, OY = 64, COLS = 15, ROWS = 13;
var AREA_TITLE = { campo: 'Campo', casa: 'Casa', masm: 'Templo' };
var HERO_ATK = { up: 6, right: 7, down: 8, left: 9 };
var DIRV = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
var OURO = 0xFFE0, BRANCO = 0xFFFF, VERDE = 0x07E0, VERM = 0xF800;
var TEXT = 0xE71C, TEXT2 = 0x9CF3, PAINEL = 0x10C3, ESCURO = 0x0861, AGUA = 0x041F;

function C(hex) {
    return ((hex >> 19) & 31) << 11 | ((hex >> 10) & 63) << 5 | ((hex >> 3) & 31);
}
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function cx(c) { return c * CELL + CELL / 2; }
function cy(r) { return OY + r * CELL + CELL / 2; }
function cellX(x) { return Math.floor(x / CELL); }
function cellY(y) { return Math.floor((y - OY) / CELL); }
function sceneName(area, c, r) { return AREA_TITLE[area] + ' ' + c + ',' + r; }
function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

function newState() {
    return {
        hpMax: 6, hp: 6, sword: 1, bombs: 0, keys: 0, crystals: 0,
        itemB: 'bomba', sage: false, relic: false, bossDead: false,
        opened: {}, got: {}, area: 'campo', room: '1,1', at: [7, 6]
    };
}

exports.create = function (ctx) { return { ctx: ctx }; };

exports.start = function (ctx) {
    var s = this;
    var E = s.E = ctx.E;
    s.ctx = ctx;
    s.scene = ctx.scene;
    s.W = E.W; s.H = E.H; s.U = E.U;
    s.screen = (ctx.scene.data && ctx.scene.data.screen) || 'title';
    s.st = null;
    s.dialog = null;
    s.dlgCd = 0;
    s.paused = false;
    s.dead = false;
    s.win = false;
    s.msg = '';
    s.msgT = 0;
    s.how = false;
    s.buttons = null;
    s.joy = null;
    s.enemies = [];
    s.rocks = [];
    s.bombs = [];
    s.boomerang = null;
    s.items = [];
    s.chests = [];
    s.npcs = [];
    s.portals = [];
    s.map = null;
    s.hero = null;

    if (typeof __harness !== 'undefined') __harness.lenda = s;

    if (s.screen === 'title') {
        s.hasSave = !!E.save.obj('lenda', null);
        s.save = s.hasSave ? E.save.obj('lenda', null) : null;
        if (E.audio) E.audio.music(SONG);
    } else if (s.screen === 'win') {
        s.st = E.data.lenda || E.save.obj('lenda', null) || newState();
        if (E.audio) E.audio.music(SONG);
    } else if (s.screen === 'lose') {
        s.st = E.data.lenda || E.save.obj('lenda', null) || newState();
        if (E.audio) E.audio.music(SONG);
    } else {
        startRoom(s, ctx);
    }
};

// ------------------------------------------------------------- sala ------

function startRoom(s, ctx) {
    var E = s.E = ctx.E;
    var d = ctx.scene.data || {};
    s.st = E.data.lenda || E.save.obj('lenda', null) || newState();
    var st = s.st;
    st.area = d.area || st.area;
    st.room = d.room || st.room;
    s.map = ctx.scene.tm('mapa');
    s.hero = ctx.scene.find('Heroi');
    s.portals = d.portals || [];
    s.roomName = d.name || st.room;
    var at = (ctx.arg && ctx.arg.at) || (st.area === d.area && st.room === d.room && st.at) || d.start || [7, 6];
    st.at = [at[0], at[1]];
    if (s.hero) {
        s.hero.x = cx(at[0]);
        s.hero.y = cy(at[1]);
        s.hero.active = true;
        s.hero.spr = 'heroi#heroi0';
    }
    s.hx = cx(at[0]);
    s.hy = cy(at[1]);
    s.dir = 'down';
    s.walkT = 0;
    s.frame = 0;
    s.attackT = 0;
    s.invuln = 0;
    s.portalCd = 0.8;
    s.t = 0;
    s.rocks = [];
    s.bombs = [];
    s.boomerang = null;
    s.items = [];
    s.chests = [];
    s.npcs = [];
    s.enemies = [];
    s.dialog = null;
    s.paused = false;
    s.dead = false;
    s.win = false;
    s.msg = '';
    s.msgT = 0;
    // portais abertos (chave/rachadura) refletem no tilemap desta cena
    for (var p = 0; p < s.portals.length; p++) {
        var po = s.portals[p];
        if (po.openKey && st.opened[po.openKey] && s.map) s.map.set(po.c, po.r, 0);
    }
    var ents = ctx.scene.entities;
    for (var i = 0; i < ents.length; i++) {
        var e = ents[i];
        if (!e.data) continue;
        var k = e.data.kind;
        if (k === 'enemy') {
            if (e.data.type === 'chefe' && st.bossDead) { e.active = false; continue; }
            var en = {
                type: e.data.type, ent: e, x: e.x, y: e.y, t: 0,
                r: e.data.type === 'chefe' ? 27 : 11,
                hp: e.data.type === 'chefe' ? 10 : (e.data.type === 'esqueleto' || e.data.type === 'geleia' ? 2 : 1),
                cool: 1.5 + Math.random(), dir: ['up', 'down', 'left', 'right'][Math.floor(Math.random() * 4)],
                stun: 0, tx: e.x, ty: e.y, flash: 0
            };
            en.maxhp = en.hp;
            s.enemies.push(en);
        } else if (k === 'chest') {
            if (st.got[e.data.key]) {
                e.active = false;
                if (s.map) s.map.set(e.data.c, e.data.r, 15);
            } else {
                s.chests.push({ ent: e, loot: e.data.loot, key: e.data.key,
                                c: e.data.c, r: e.data.r });
            }
        } else if (k === 'item') {
            if (st.got[e.data.key]) e.active = false;
            else s.items.push({ ent: e, item: e.data.item, key: e.data.key });
        } else if (k === 'npc') {
            s.npcs.push({ ent: e, who: e.data.who });
        }
    }
    saveState(s);
    if (E.audio) E.audio.music(SONG);
}

function saveState(s) {
    if (!s.st) return;
    s.st.area = s.st.area || 'campo';
    s.st.room = s.st.room || '1,1';
    s.st.at = s.st.at || [7, 6];
    s.E.save.setObj('lenda', s.st);
}

// ------------------------------------------------------------ update -----

exports.update = function (dt, ctx) {
    var s = this, E = s.E;
    if (s.screen === 'title') return updateTitle(s, E, ctx);
    if (s.screen === 'win') return updateWin(s, E, ctx);
    if (s.screen === 'lose') return updateLose(s, E, ctx);
    updateGame(s, E, ctx, dt);
};

function updateTitle(s, E, ctx) {
    if (s.how) {
        if (E.input.tap) { s.how = false; E.redraw(); }
        return;
    }
    if (s.btnNew && E.hit(s.btnNew)) {
        var st = newState();
        E.data.lenda = st;
        saveState({ E: E, st: st });
        ctx.go('Campo 1,1');
    } else if (s.btnCont && E.hit(s.btnCont)) {
        var st2 = E.save.obj('lenda', null) || newState();
        E.data.lenda = st2;
        ctx.go(sceneName(st2.area, parseInt(st2.room.split(',')[0], 10),
                         parseInt(st2.room.split(',')[1], 10)), { at: st2.at });
    } else if (s.btnHow && E.hit(s.btnHow)) {
        s.how = true;
        E.redraw();
    }
}

function updateWin(s, E, ctx) {
    if (s.btnNew && E.hit(s.btnNew)) {
        var st = newState();
        E.data.lenda = st;
        saveState({ E: E, st: st });
        ctx.go('Campo 1,1');
    } else if (s.btnMenu && E.hit(s.btnMenu)) {
        ctx.go('Titulo');
    }
}

function updateLose(s, E, ctx) {
    if (s.btnCont && E.hit(s.btnCont)) {
        s.st.hp = s.st.hpMax;
        saveState(s);
        E.data.lenda = s.st;
        ctx.go(sceneName(s.st.area, parseInt(s.st.room.split(',')[0], 10),
                         parseInt(s.st.room.split(',')[1], 10)), { at: s.st.at });
    } else if (s.btnMenu && E.hit(s.btnMenu)) {
        ctx.go('Titulo');
    }
}

function updateGame(s, E, ctx, dt) {
    if (s.win) {
        s.msgT -= dt;
        if (s.msgT <= 0) ctx.go('Vitoria');
        return;
    }
    if (s.dead) {
        s.msgT -= dt;
        if (s.msgT <= 0) ctx.go('Fim');
        return;
    }
    if (s.dialog) {
        s.dlgCd -= dt;
        if (E.input.tap && s.dlgCd <= 0) {
            s.dialog.i++;
            if (s.dialog.i >= s.dialog.lines.length) {
                var cb = s.dialog.done;
                s.dialog = null;
                if (cb) cb();
            }
        }
        return;
    }
    if (s.paused) {
        if (s.btnResume && E.hit(s.btnResume)) s.paused = false;
        else if (s.btnMenuPause && E.hit(s.btnMenuPause)) ctx.go('Titulo');
        return;
    }
    if (s.btnPause && E.hit(s.btnPause)) { s.paused = true; return; }
    if (s.msgT > 0) { s.msgT -= dt; if (s.msgT <= 0) s.msg = ''; }
    if (s.portalCd > 0) s.portalCd -= dt;
    if (s.invuln > 0) s.invuln -= dt;
    if (s.attackT > 0) s.attackT -= dt;

    // movimento: o dedo puxa a heroina na direcao do toque (funciona tambem
    // quando o down chega no mesmo quadro de um move do roteiro de teste)
    var r0 = s.buttons;
    var overUi = inRect(r0 && r0.a, E.input.x, E.input.y) ||
                 inRect(r0 && r0.b, E.input.x, E.input.y) ||
                 inRect(r0 && r0.pause, E.input.x, E.input.y);
    if (E.input.down && !overUi) {
        var dx = E.input.x - s.hx, dy = E.input.y - s.hy;
        var d = Math.sqrt(dx * dx + dy * dy);
        s.joy = { x: E.input.x, y: E.input.y };
        if (d > 14) {
            var speed = CELL * 3.4 * dt;
            moveHero(s, dx / d * speed, dy / d * speed);
            if (Math.abs(dx) > Math.abs(dy)) s.dir = dx > 0 ? 'right' : 'left';
            else s.dir = dy > 0 ? 'down' : 'up';
            s.walkT += dt;
            s.frame = Math.floor(s.walkT * 7) % 2;
        }
    } else {
        s.joy = null;
    }

    var bt = E.input.tap;
    if (E.input.tap) {
        if (inRect(s.buttons && s.buttons.a, bt.x, bt.y)) {
            actionA(s, E);
        } else if (inRect(s.buttons && s.buttons.b, bt.x, bt.y)) {
            actionB(s, E);
        }
    }

    updateHeroAnim(s);
    updateEnemies(s, E, dt);
    updateRocks(s, E, dt);
    updateBombs(s, E, dt);
    updateBoomerang(s, E, dt);
    updateItems(s, E);
    checkPortals(s, E, ctx);
}

function inRect(r, x, y) {
    return !!(r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
}

function moveHero(s, dx, dy) {
    var nx = s.hx + dx, ny = s.hy + dy;
    if (s.map && !s.map.rectSolid(nx - 9, s.hy - 9, 18, 18)) s.hx = nx;
    if (s.map && !s.map.rectSolid(s.hx - 9, ny - 9, 18, 18)) s.hy = ny;
    s.hx = clamp(s.hx, CELL / 2, 480 - CELL / 2);
    s.hy = clamp(s.hy, OY + CELL / 2, 480 - CELL / 2);
    if (s.hero) { s.hero.x = s.hx; s.hero.y = s.hy; s.hero.active = true; }
}

function updateHeroAnim(s) {
    if (!s.hero) return;
    var f;
    if (s.attackT > 0) f = HERO_ATK[s.dir] || 8;
    else if (s.dir === 'down') f = s.frame;
    else if (s.dir === 'up') f = 2 + s.frame;
    else if (s.dir === 'right') f = 4;
    else f = 5;
    if (s.invuln > 0 && Math.floor(s.invuln * 12) % 2 === 0) s.hero.active = false;
    else s.hero.active = true;
    s.hero.spr = 'heroi#heroi' + f;
}

// ------------------------------------------------------------ acoes ------

function nearChestOrNpc(s) {
    var best = null, bd = 48 * 48;
    for (var i = 0; i < s.chests.length; i++) {
        var c = s.chests[i];
        if (!c.ent.active) continue;
        var d = dist2(s.hx, s.hy, c.ent.x, c.ent.y);
        if (d < bd) { bd = d; best = c; }
    }
    for (var j = 0; j < s.npcs.length; j++) {
        var n = s.npcs[j];
        var dd = dist2(s.hx, s.hy, n.ent.x, n.ent.y);
        if (dd < bd) { bd = dd; best = n; }
    }
    return best;
}

function nearPortal(s, need) {
    for (var i = 0; i < s.portals.length; i++) {
        var p = s.portals[i];
        if (!p.need || p.need !== need) continue;
        var dx = cx(p.c) - s.hx, dy = cy(p.r) - s.hy;
        if (dx * dx + dy * dy < 46 * 46) return p;
    }
    return null;
}

function openPortal(s, E, p) {
    if (s.st.opened[p.openKey]) return true;
    if (p.need === 'key') {
        if (s.st.keys <= 0) { s.msg = 'PRECISA DE CHAVE'; s.msgT = 1.2; return false; }
        s.st.keys--;
    } else {
        if (s.st.bombs <= 0) { s.msg = 'PRECISA DE BOMBA'; s.msgT = 1.2; return false; }
        s.st.bombs--;
    }
    s.st.opened[p.openKey] = 1;
    if (s.map) s.map.set(p.c, p.r, 0);
    saveState(s);
    s.msg = p.need === 'key' ? 'PORTA ABERTA' : 'PAREDE RACHADA ABERTA';
    s.msgT = 1.4;
    if (E.audio) E.audio.sfx('power', { gap: 0 });
    return true;
}

function actionA(s, E) {
    var door = nearPortal(s, 'key');
    if (door) { openPortal(s, E, door); return; }
    var near = nearChestOrNpc(s);
    if (near) {
        if (near.loot !== undefined) openChest(s, E, near);
        else talk(s, E, near.who);
        return;
    }
    sword(s, E);
}

function sword(s, E) {
    s.attackT = 0.18;
    var v = DIRV[s.dir] || DIRV.down;
    if (E.audio) E.audio.sfx('hit', { gap: 30 });
    // arbusto a frente
    var fc = cellX(s.hx) + v[0], fr = cellY(s.hy) + v[1];
    if (s.map && s.map.get(fc, fr) === 9) s.map.set(fc, fr, 0);
    for (var i = 0; i < s.enemies.length; i++) {
        var e = s.enemies[i];
        if (e.hp <= 0) continue;
        var dx = e.x - s.hx, dy = e.y - s.hy;
        if (dx * dx + dy * dy > 44 * 44) continue;
        var dot = dx * v[0] + dy * v[1];
        if (dot < 0 && Math.abs(dot) > 14) continue;
        hitEnemy(s, E, e, s.st.sword || 1);
    }
}

function talk(s, E, who) {
    var lines;
    var done = null;
    if (who === 'sabio') {
        if (!s.st.sage) {
            lines = ['SABIO: Celer, a pedra do templo despertou.',
                     'Leve esta espada e estas bombas.',
                     'O Guardiao dorme atras da porta de chave.'];
            done = function () {
                s.st.sage = true;
                s.st.sword = 2;
                s.st.bombs += 4;
                saveState(s);
                s.msg = 'ESPADA + BOMBAS x4';
                s.msgT = 2;
                if (E.audio) E.audio.sfx('power', { gap: 0 });
            };
        } else {
            lines = ['SABIO: A chave abre o salao do Guardiao.',
                     'Cristais compram bombas na loja.'];
        }
    } else {
        if (s.st.crystals >= 10) {
            s.st.crystals -= 10;
            s.st.bombs += 4;
            saveState(s);
            lines = ['LOJA: 10 cristais = 4 bombas. Negocio fechado.'];
        } else {
            lines = ['LOJA: traga 10 cristais e levo 4 bombas.'];
        }
    }
    s.dialog = { lines: lines, i: 0, done: done };
    s.dlgCd = 0.3;
}

function openChest(s, E, chest) {
    var loot = chest.loot;
    chest.ent.active = false;
    if (s.map) s.map.set(chest.c, chest.r, 15);
    s.st.got[chest.key] = 1;
    if (loot === 'bombs' || loot === 'bombas') s.st.bombs += 4;
    else if (loot === 'conteiner') { s.st.hpMax += 2; s.st.hp += 2; }
    else if (loot === 'chave') s.st.keys += 1;
    else if (loot === 'mapa') s.st.hasMap = true;
    else if (loot === 'bumerangue') s.st.itemB = 'bumerangue';
    else s.st.bombs += 4;
    saveState(s);
    s.msg = loot === 'bumerangue' ? 'BUMERANGUE!' : (loot === 'conteiner' ? 'VIDA MAXIMA!' : 'BAU ABERTO');
    s.msgT = 1.6;
    if (E.audio) E.audio.sfx('coin', { gap: 0 });
}

function actionB(s, E) {
    if (s.st.itemB === 'bumerangue') {
        if (s.boomerang) return;
        var v = DIRV[s.dir];
        s.boomerang = { x: s.hx, y: s.hy, vx: v[0], vy: v[1], d: 0, back: false, t: 0 };
        if (E.audio) E.audio.sfx('power', { gap: 0 });
    } else {
        if (s.st.bombs <= 0) { s.msg = 'SEM BOMBAS'; s.msgT = 1; return; }
        for (var i = 0; i < s.bombs.length; i++) if (s.bombs[i]) return;
        s.st.bombs--;
        var v = DIRV[s.dir] || DIRV.down;
        s.bombs.push({ c: cellX(s.hx) + v[0], r: cellY(s.hy) + v[1], t: 1.5 });
        saveState(s);
        if (E.audio) E.audio.sfx('ok', { gap: 0 });
    }
}

// ------------------------------------------------------------ inimigos ----

function moveEnt(s, e, dx, dy) {
    var nx = e.x + dx, ny = e.y + dy;
    if (s.map && !s.map.rectSolid(nx - e.r, e.y - e.r, e.r * 2, e.r * 2)) e.x = nx;
    if (s.map && !s.map.rectSolid(e.x - e.r, ny - e.r, e.r * 2, e.r * 2)) e.y = ny;
}

function updateEnemies(s, E, dt) {
    for (var i = s.enemies.length - 1; i >= 0; i--) {
        var e = s.enemies[i];
        if (e.hp <= 0) continue;
        e.t += dt;
        if (e.stun > 0) { e.stun -= dt; continue; }
        if (e.flash > 0) e.flash -= dt;
        var speed = e.type === 'morcego' ? 64 : (e.type === 'geleia' ? 42 :
            (e.type === 'esqueleto' ? 45 : (e.type === 'chefe' ? 26 : 30)));
        var dx = s.hx - e.x, dy = s.hy - e.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 1;
        if (e.type === 'polvo') {
            e.cool -= dt;
            if (e.cool <= 0) {
                e.cool = 2.2;
                s.rocks.push({ x: e.x, y: e.y, vx: dx / d * 130, vy: dy / d * 130 });
            }
            e.tx -= dt;
            if (e.tx <= 0) {
                e.tx = 0.7 + Math.random();
                e.dir = ['up', 'down', 'left', 'right'][Math.floor(Math.random() * 4)];
            }
            var v = DIRV[e.dir];
            moveEnt(s, e, v[0] * speed * dt, v[1] * speed * dt);
        } else if (e.type === 'morcego') {
            e.x += dx / d * speed * dt;
            e.y += dy / d * speed * dt;
            e.x = clamp(e.x, 14, 480 - 14);
            e.y = clamp(e.y, OY + 14, 480 - 14);
        } else if (e.type === 'geleia') {
            e.cool -= dt;
            if (e.cool <= 0) {
                e.cool = 1.2;
                moveEnt(s, e, dx / d * 26, dy / d * 26);
            }
        } else if (e.type === 'chefe') {
            e.cool -= dt;
            if (e.cool <= 0) {
                var ph = e.hp > 6 ? 1 : (e.hp > 3 ? 2 : 3);
                e.cool = ph === 3 ? 1.1 : (ph === 2 ? 1.6 : 2.1);
                var n = ph === 3 ? 5 : 3;
                for (var k = 0; k < n; k++) {
                    var a = Math.atan2(dy, dx) + (k - (n - 1) / 2) * 0.28;
                    s.rocks.push({ x: e.x, y: e.y, vx: Math.cos(a) * (ph === 3 ? 165 : 140),
                                   vy: Math.sin(a) * (ph === 3 ? 165 : 140) });
                }
            }
            moveEnt(s, e, dx / d * speed * dt, dy / d * speed * dt);
        } else {
            moveEnt(s, e, dx / d * speed * dt, dy / d * speed * dt);
        }
        if (s.hero) {
            e.ent.x = e.x; e.ent.y = e.y;
            var fr = 0;
            if (e.type === 'morcego') fr = 2 + (Math.floor(e.t * 5) % 2);
            else if (e.type === 'esqueleto') fr = 4 + (Math.floor(e.t * 5) % 2);
            else if (e.type === 'geleia') fr = 6 + (Math.floor(e.t * 5) % 2);
            else if (e.type === 'polvo') fr = Math.floor(e.t * 5) % 2;
            if (e.type === 'chefe') e.ent.spr = 'chefe#chefe' + (e.flash > 0 ? 1 : 0);
            else e.ent.spr = 'inimigos#inimigos' + fr;
        }
        var rr = e.r + 9;
        if (dist2(e.x, e.y, s.hx, s.hy) < rr * rr) hurtHero(s, E, e.type === 'chefe' ? 2 : 1);
    }
}

function hitEnemy(s, E, e, dmg) {
    e.hp -= dmg;
    e.flash = 0.15;
    if (E.audio) E.audio.sfx('hit', { gap: 30 });
    if (e.hp <= 0) {
        e.ent.active = false;
        if (E.fx) E.fx.burst(e.x, e.y, { n: 12, color: e.type === 'chefe' ? OURO : VERDE,
            speed: 120, life: 0.4 });
        if (e.type === 'chefe') {
            s.st.bossDead = true;
            s.st.relic = true;
            saveState(s);
            s.win = true;
            s.msgT = 1.6;
            s.msg = 'GUARDIAO DERROTADO!';
            if (E.audio) { E.audio.stop(); E.audio.sfx('win', { gap: 0 }); }
        }
    }
}

function updateRocks(s, E, dt) {
    for (var i = s.rocks.length - 1; i >= 0; i--) {
        var r = s.rocks[i];
        r.x += r.vx * dt; r.y += r.vy * dt;
        if (r.x < -10 || r.x > 490 || r.y < OY - 10 || r.y > 490) { s.rocks.splice(i, 1); continue; }
        if (s.map && s.map.solidAt(r.x, r.y)) { s.rocks.splice(i, 1); continue; }
        if (dist2(r.x, r.y, s.hx, s.hy) < 15 * 15) {
            s.rocks.splice(i, 1);
            hurtHero(s, E, 1);
        }
    }
}

function updateBombs(s, E, dt) {
    for (var i = s.bombs.length - 1; i >= 0; i--) {
        var b = s.bombs[i];
        b.t -= dt;
        if (b.t > 0) continue;
        s.bombs.splice(i, 1);
        boom(s, E, cx(b.c), cy(b.r));
    }
}

function boom(s, E, x, y) {
    if (E.fx) {
        E.fx.burst(x, y, { n: 26, color: 0xFD20, speed: 190, life: 0.6 });
        E.fx.flash(0xFD20, 150);
    }
    if (E.audio) E.audio.sfx('boom', { gap: 0 });
    var c0 = cellX(x), r0 = cellY(y);
    for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
        var c = c0 + dc, r = r0 + dr;
        if (s.map) {
            var v = s.map.get(c, r);
            if (v === 9 || v === 19) s.map.set(c, r, 0);
            if (v === 19) {
                for (var p = 0; p < s.portals.length; p++) {
                    var po = s.portals[p];
                    if (po.c === c && po.r === r && po.openKey) s.st.opened[po.openKey] = 1;
                }
                saveState(s);
            }
        }
        for (var e = s.enemies.length - 1; e >= 0; e--) {
            var en = s.enemies[e];
            if (en.hp > 0 && dist2(en.x, en.y, x, y) < 44 * 44) hitEnemy(s, E, en, 2);
        }
    }
    if (dist2(s.hx, s.hy, x, y) < 44 * 44) hurtHero(s, E, 1);
}

function updateBoomerang(s, E, dt) {
    var b = s.boomerang;
    if (!b) return;
    b.t += dt;
    var sp = CELL * 9;
    if (!b.back) {
        b.x += b.vx * sp * dt; b.y += b.vy * sp * dt;
        b.d += sp * dt;
        if (b.d > CELL * 5) b.back = true;
    } else {
        var dx = s.hx - b.x, dy = s.hy - b.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 1;
        b.x += dx / d * sp * dt; b.y += dy / d * sp * dt;
        if (d < 16) { s.boomerang = null; return; }
    }
    for (var i = 0; i < s.enemies.length; i++) {
        var e = s.enemies[i];
        if (e.hp > 0 && dist2(e.x, e.y, b.x, b.y) < 24 * 24) e.stun = 1.5;
    }
    for (var j = s.items.length - 1; j >= 0; j--) {
        if (dist2(s.items[j].ent.x, s.items[j].ent.y, b.x, b.y) < 22 * 22) {
            pickup(s, E, s.items[j]);
            s.items.splice(j, 1);
        }
    }
}

function updateItems(s, E) {
    for (var i = s.items.length - 1; i >= 0; i--) {
        var it = s.items[i];
        if (dist2(it.ent.x, it.ent.y, s.hx, s.hy) < 22 * 22) {
            pickup(s, E, it);
            s.items.splice(i, 1);
        }
    }
}

function pickup(s, E, it) {
    it.ent.active = false;
    s.st.got[it.key] = 1;
    if (it.item === 'coracao') s.st.hp = clamp(s.st.hp + 1, 0, s.st.hpMax);
    else if (it.item === 'cristal') s.st.crystals++;
    else if (it.item === 'chave') s.st.keys++;
    saveState(s);
    if (E.audio) E.audio.sfx('coin', { gap: 0 });
    s.msg = it.item.toUpperCase() + ' PEGO';
    s.msgT = 1;
}

function hurtHero(s, E, dmg) {
    if (s.invuln > 0 || s.dead || s.win) return;
    s.st.hp -= dmg;
    s.invuln = 1.1;
    saveState(s);
    if (E.audio) E.audio.sfx('bad', { gap: 0 });
    if (E.fx) E.fx.flash(VERM, 180);
    if (s.st.hp <= 0) {
        s.st.hp = 0;
        s.dead = true;
        s.msgT = 1.4;
        s.msg = 'VOCE CAIU';
        if (E.audio) { E.audio.stop(); E.audio.sfx('bad', { gap: 0 }); }
    }
}

// ------------------------------------------------------------ portais -----

function checkPortals(s, E, ctx) {
    if (s.portalCd > 0) return;
    var c = cellX(s.hx), r = cellY(s.hy);
    for (var i = 0; i < s.portals.length; i++) {
        var p = s.portals[i];
        if (p.c !== c || p.r !== r) continue;
        if (p.need && !s.st.opened[p.openKey]) {
            if (p.need === 'key') {
                if (s.st.keys <= 0) { s.msg = 'PRECISA DE CHAVE'; s.msgT = 1.2; return; }
                s.st.keys--;
            } else {
                if (s.st.bombs <= 0) { s.msg = 'PRECISA DE BOMBA'; s.msgT = 1.2; return; }
                s.st.bombs--;
            }
            s.st.opened[p.openKey] = 1;
            if (s.map) s.map.set(p.c, p.r, 0);
            saveState(s);
            if (E.audio) E.audio.sfx('power', { gap: 0 });
        }
        s.st.area = p.to.indexOf('Campo') === 0 ? 'campo' :
            (p.to.indexOf('Casa') === 0 ? 'casa' : 'masm');
        var sp = p.to.split(' ');
        var rc = sp[1].split(',');
        s.st.room = rc[0] + ',' + rc[1];
        s.st.at = [p.tc, p.tr];
        saveState(s);
        ctx.go(p.to, { at: [p.tc, p.tr] });
        return;
    }
}

// --------------------------------------------------------------- draw -----

exports.draw = function (ctx) {
    var s = this, E = s.E;
    if (s.screen === 'title') return drawTitle(s, E);
    if (s.screen === 'win') return drawWin(s, E);
    if (s.screen === 'lose') return drawLose(s, E);
    drawGame(s, E);
};

function drawTitle(s, E) {
    var W = s.W, H = s.H;
    E.gfx.rect(0, 220, W, H - 220, C(0x0B1020), { screen: true });
    E.gfx.text('LENDA DE CELER', W / 2, 250, { px: 32, align: 'center', color: OURO });
    E.gfx.text('a pedra do templo despertou', W / 2, 284,
        { px: 14, align: 'center', color: TEXT2 });
    var y = 314;
    s.btnNew = E.gfx.button('NOVO JOGO', W / 2 - 110, y, 220, 44,
        { primary: true, screen: true, px: 18 });
    if (s.hasSave) {
        s.btnCont = E.gfx.button('CONTINUAR', W / 2 - 110, y + 54, 220, 38,
            { primary: false, screen: true, px: 15 });
        s.btnHow = E.gfx.button('COMO JOGAR', W / 2 - 90, y + 100, 180, 32,
            { primary: false, screen: true, px: 12 });
    } else {
        s.btnCont = null;
        s.btnHow = E.gfx.button('COMO JOGAR', W / 2 - 90, y + 54, 180, 34,
            { primary: false, screen: true, px: 12 });
    }
    if (s.how) {
        E.gfx.rect(0, 0, W, H, C(0x05080E), { screen: true });
        s.btnNew = null; s.btnCont = null; s.btnHow = null;
        E.gfx.panel(28, 80, W - 56, 330, { bg: PAINEL, stroke: OURO, r: 12, screen: true });
        E.gfx.text('COMO JOGAR', W / 2, 112, { px: 26, align: 'center', color: OURO });
        E.gfx.text('arraste para andar', W / 2, 154, { px: 16, align: 'center', color: BRANCO });
        E.gfx.text('A: espada / falar / abrir bau', W / 2, 184, { px: 15, align: 'center', color: BRANCO });
        E.gfx.text('B: bomba ou bumerangue', W / 2, 214, { px: 15, align: 'center', color: BRANCO });
        E.gfx.text('fale com o Sabio para ganhar a espada', W / 2, 250,
            { px: 13, align: 'center', color: TEXT2 });
        E.gfx.text('toque para voltar', W / 2, 350, { px: 14, align: 'center', color: OURO });
    }
}

function drawWin(s, E) {
    var W = s.W, H = s.H;
    E.gfx.rect(0, 0, W, H, C(0x0B1020), { screen: true });
    E.gfx.panel(40, 100, W - 80, 300, { bg: PAINEL, stroke: OURO, r: 12, screen: true });
    E.gfx.text('A LENDA CONTINUA', W / 2, 142, { px: 28, align: 'center', color: OURO });
    E.gfx.text('o Guardiao caiu e o cristal e seu', W / 2, 184,
        { px: 14, align: 'center', color: TEXT2 });
    E.gfx.text('vida ' + s.st.hpMax + '  ·  cristais ' + s.st.crystals,
        W / 2, 222, { px: 16, align: 'center', color: BRANCO });
    s.btnNew = E.gfx.button('NOVO JOGO', W / 2 - 110, 264, 220, 44,
        { primary: true, screen: true, px: 17 });
    s.btnMenu = E.gfx.button('MENU', W / 2 - 70, 320, 140, 32,
        { primary: false, screen: true, px: 13 });
}

function drawLose(s, E) {
    var W = s.W, H = s.H;
    E.gfx.rect(0, 0, W, H, C(0x0B1020), { screen: true });
    E.gfx.panel(40, 100, W - 80, 300, { bg: PAINEL, stroke: VERM, r: 12, screen: true });
    E.gfx.text('VOCE CAIU', W / 2, 150, { px: 34, align: 'center', color: VERM });
    E.gfx.text('o Sabio ainda espera na gruta', W / 2, 196,
        { px: 14, align: 'center', color: TEXT2 });
    s.btnCont = E.gfx.button('CONTINUAR', W / 2 - 110, 240, 220, 44,
        { primary: true, screen: true, px: 17 });
    s.btnMenu = E.gfx.button('MENU', W / 2 - 70, 296, 140, 32,
        { primary: false, screen: true, px: 13 });
}

function drawGame(s, E) {
    var W = s.W, H = s.H, i;
    // projeteis/bomba/bumerangue por cima das entidades
    for (i = 0; i < s.rocks.length; i++) {
        var r = s.rocks[i];
        E.spr.stamp('inimigos#inimigos11', r.x, r.y, { scale: 0.7, key: 0x0000 });
    }
    for (i = 0; i < s.bombs.length; i++) {
        var b = s.bombs[i];
        E.spr.stamp('itens#itens4', cx(b.c), cy(b.r), { scale: 1, key: 0x0000 });
        if (b.t < 0.4) E.gfx.circle(cx(b.c), cy(b.r), 9, VERM, { fill: false });
    }
    if (s.boomerang) {
        E.spr.stamp('itens#itens5', s.boomerang.x, s.boomerang.y, { scale: 1, key: 0x0000 });
    }
    // HUD
    drawHud(s, E);
    // joystick
    if (s.joy && E.input.down) {
        E.gfx.circle(s.joy.x, s.joy.y, 20, C(0x2A3A5A), { fill: false, screen: true });
        E.gfx.circle(s.joy.x, s.joy.y, 4, OURO, { fill: true, screen: true });
    }
    // botoes A/B
    s.buttons = {
        a: { x: W - 56, y: H - 52, w: 46, h: 40 },
        b: { x: W - 56, y: H - 100, w: 46, h: 40 },
        pause: { x: W - 36, y: 6, w: 28, h: 24 }
    };
    drawAction(E, s.buttons.a, 'A', 'itens#itens9');
    drawAction(E, s.buttons.b, 'B', s.st.itemB === 'bumerangue' ? 'itens#itens5' : 'itens#itens4');
    if (s.msg) {
        E.gfx.text(s.msg, W / 2, H - 70, { px: 16, align: 'center',
            color: 0x101010, bg: 0xFFE0, screen: true });
    }
    if (s.dialog) {
        var dlg = s.dialog;
        E.gfx.rect(0, H - 146, W, 146, C(0x05080E), { screen: true });
        E.gfx.rect(10, H - 140, W - 20, 132, C(0x101A2A), { screen: true });
        E.gfx.text(dlg.lines[dlg.i], W / 2, H - 104,
            { px: 15, align: 'center', color: BRANCO, fit: W - 44 });
        E.gfx.text('toque para continuar', W / 2, H - 42,
            { px: 11, align: 'center', color: TEXT2 });
    }
    if (s.paused) {
        E.gfx.rect(0, 0, W, H, C(0x05080E), { screen: true });
        E.gfx.panel(60, 150, W - 120, 190, { bg: PAINEL, stroke: OURO, r: 12, screen: true });
        E.gfx.text('PAUSA', W / 2, 186, { px: 32, align: 'center', color: OURO });
        s.btnResume = E.gfx.button('CONTINUAR', W / 2 - 100, 228, 200, 42,
            { primary: true, screen: true, px: 17 });
        s.btnMenuPause = E.gfx.button('MENU', W / 2 - 60, 282, 120, 32,
            { primary: false, screen: true, px: 13 });
    }
    if (s.dead || s.win) {
        E.gfx.text(s.win ? 'GUARDIAO DERROTADO!' : 'VOCE CAIU',
            W / 2, H / 2, { px: 30, align: 'center', valign: 'middle',
                color: s.win ? OURO : VERM, bg: C(0x0B1020), screen: true });
    }
}

function drawAction(E, r, key, icon) {
    E.gfx.rect(r.x, r.y, r.w, r.h, C(0x1B2740), { r: 8, screen: true });
    if (E.spr && E.spr.has && E.spr.has(icon)) {
        E.spr.stamp(icon, r.x + r.w / 2, r.y + r.h / 2 + 1,
            { scale: 1.08, key: 0x0000 });
    }
    E.gfx.text(key, r.x + 8, r.y + 7, { px: 10, align: 'center', valign: 'middle',
        color: OURO, screen: true });
}

function drawHud(s, E) {
    var W = s.W;
    E.gfx.rect(0, 0, W, OY, C(0x080C16), { screen: true });
    E.gfx.rect(0, OY - 2, W, 2, OURO, { screen: true });
    E.gfx.text(s.roomName, 8, 6, { px: 15, color: OURO, screen: true });
    E.gfx.text('VIDA', 8, 30, { px: 9, color: TEXT2, screen: true });
    E.gfx.hearts(s.st.hp, s.st.hpMax, 40, 26, { size: 10, color: VERM,
        empty: 0x3008, screen: true });
    var info = 'CRISTAIS ' + s.st.crystals + '   BOMBAS ' + s.st.bombs +
        '   CHAVES ' + s.st.keys + (s.st.sage ? '   ESPADA 2' : '   ESPADA 1');
    E.gfx.text(info, W / 2, 48, { px: 11, align: 'center', color: TEXT2,
        fit: W - 80, screen: true });
    E.gfx.text('II', W - 22, 18, { px: 13, align: 'center', valign: 'middle',
        color: BRANCO, screen: true });
}
