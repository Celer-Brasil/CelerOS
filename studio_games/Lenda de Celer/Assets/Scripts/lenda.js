// lenda.js - controlador da versao NATIVA da Lenda de Celer no Celer Studio.
// Cada sala e uma cena com tilemap 15x13 (cell 32, HUD de 64 px) e os
// spawns como entidades. O script cuida do heroi, combate, baus, Sabio,
// loja, portais, save automatico e HUD. ES5.

var PERF_LOG = false;  // medicao de bancada; falso no build final
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

// opcoes de sprite reutilizadas: o draw roda todo quadro e alocar um objeto
// por peca no Duktape custa caro (o GC aparece como engasgo no 4848)
var OPT_ROCK = { scale: 0.7, key: 0x0000 };
var OPT_ITEM = { scale: 1, key: 0x0000 };
var OPT_SWORD = { scale: 1.15, key: 0x0000, ax: 0.5, ay: 0.5 };
var OPT_ACTION = { scale: 1.08, key: 0x0000 };
var WORLD_RING = { fill: false };
var WORLD_DOT = { fill: true };
var ACT_RECT = { r: 8, screen: true };
var JOY_RING = { fill: false, screen: true };
var JOY_DOT = { fill: true, screen: true };
// joystick flutuante: raio visivel/limite do botao e zona morta antes de andar
var JOY_R = 36, JOY_DEAD = 12;
var MSG_TXT = { px: 16, align: 'center', color: 0x101010, bg: 0xFFE0, screen: true };
var ACT_TXT = { px: 10, align: 'center', valign: 'middle', color: OURO, screen: true };

// heroina.png: 4x4 de 40 px (text2d animate-set): linhas baixo, cima,
// esquerda, direita; 4 quadros de caminhada cada. Nomes prontos
var HERO_FRAME = [];
for (var _h = 0; _h < 16; _h++) HERO_FRAME.push('heroina#h' + _h);
var HERO_ROW = { down: 0, up: 4, left: 8, right: 12 };
// efeitos.png: 6x6 de 48 px (text2d vfx). Corte pre-girado nas 4 direcoes
// (regiao de folha nao gira), fumaca e cura; explosao em boom.png (96 px)
var FX = [];
for (var _f = 0; _f < 36; _f++) FX.push('efeitos#e' + _f);
var SLASH_ROW = { right: 0, down: 6, left: 12, up: 18 };
var FX_POOF = 24, FX_HEAL = 30;
var BOOM = ['boom#b0', 'boom#b1', 'boom#b2', 'boom#b3', 'boom#b4', 'boom#b5'];
var FX_T = 0.06;
var OPT_FX = { key: 0xF81F };
var OPT_ICON = { key: 0x0000 };
var UI_THEME = { accent: '#ffd23f', accent2: '#e08a00', onAccent: 0x0000, radius: 12 };
var HERO_SWORD = ['heroi#heroi6', 'heroi#heroi7', 'heroi#heroi8', 'heroi#heroi9'];
var ENEMY_FRAME = {
    polvo: ['inimigos#inimigos0', 'inimigos#inimigos1'],
    morcego: ['inimigos#inimigos2', 'inimigos#inimigos3'],
    esqueleto: ['inimigos#inimigos4', 'inimigos#inimigos5'],
    geleia: ['inimigos#inimigos6', 'inimigos#inimigos7'],
    chefe: ['chefe#chefe0', 'chefe#chefe1']
};

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
        itemB: 'bomba', boom: false, sage: false, relic: false, bossDead: false,
        ms: 0, falls: 0,          // minutos de jornada e quedas (tela de save)
        opened: {}, got: {}, area: 'campo', room: '1,1', at: [7, 6]
    };
}

// ------------------------------------------------------- slots de save ----
// A 0.x guardava uma jornada so ('lenda'). A 1.x tem 3 slots; o save antigo
// migra para o slot 1 na primeira vez que o titulo abre.
var SLOTS = ['lenda.1', 'lenda.2', 'lenda.3'];

function slotState(E, n) {
    if (n < 1 || n > 3) return null;
    return E.save.obj(SLOTS[n - 1], null);
}

function slotSave(E, n, st) {
    if (n < 1 || n > 3) return;
    E.save.setObj(SLOTS[n - 1], st);
}

function slotDelete(E, n) {
    if (n < 1 || n > 3) return;
    E.save.setObj(SLOTS[n - 1], null);
}

function migrateSlots(E) {
    var antigo = E.save.obj('lenda', null);
    if (!antigo) return;
    var tem = slotState(E, 1) || slotState(E, 2) || slotState(E, 3);
    if (!tem) slotSave(E, 1, antigo);
    E.save.setObj('lenda', null);   // consome o formato antigo
}

function slotLine(st) {
    if (!st) return 'vazio';
    var min = Math.floor((st.ms || 0) / 60000);
    return (AREA_TITLE[st.area] || '?') + ' ' + st.room + '  ·  ' +
        (st.crystals || 0) + ' cristais  ·  ' + min + ' min  ·  ' +
        (st.falls || 0) + ' queda(s)';
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
    s.joyOn = false;       // joystick flutuante: base assentada no toque
    s.joyX0 = 0;
    s.joyY0 = 0;
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
    s.vfx = [];
    s.act = null;
    s.walking = false;
    s.art = !!(E.spr && E.spr.has && E.spr.has(FX[0]));
    if (E.ui) {
        E.ui.preset('soft');
        E.ui.theme(UI_THEME);
    }

    if (s.screen === 'title') {
        migrateSlots(E);
        s.pick = false;            // seletor de save aberto?
        s.pickDlg = null;
        s.slot = E.save.num('lenda.slot', 1);
        if (s.slot < 1 || s.slot > 3) s.slot = 1;
        s.hasSave = !!slotState(E, s.slot);
        if (s.hasSave) E.data.lenda = null;
        if (E.audio) E.audio.music(SONG);
    } else if (s.screen === 'win') {
        s.st = E.data.lenda || slotState(s.E, s.slot) || newState();
        if (E.audio) E.audio.music(SONG);
    } else if (s.screen === 'lose') {
        s.st = E.data.lenda || slotState(s.E, s.slot) || newState();
        if (E.audio) E.audio.music(SONG);
    } else {
        startRoom(s, ctx);
    }
};

// ------------------------------------------------------------- sala ------

// botoes de tela fixos: atualizar/draw nao alocam um objeto por quadro
function initButtons(s) {
    var W = s.W, H = s.H;
    s.buttons = {
        a: { x: W - 56, y: H - 52, w: 46, h: 40 },
        b: { x: W - 56, y: H - 100, w: 46, h: 40 },
        pause: { x: W - 36, y: 6, w: 28, h: 24 }
    };
    s.btnPause = s.buttons.pause;
}

// recorte do mundo: o apagar das caixas sujas e o desenho do jogo nao
// invadem a faixa do HUD (o HUD desenha com unclip e depois devolve)
function applyGameClip(s, E) {
    if (E.dirty && E.dirty.on && E.caps && E.caps.clip && E.dirty.clip) {
        E.dirty.clip(0, OY, s.W, s.H - OY);
        if (typeof System !== 'undefined' && System.setClip) {
            System.setClip(0, OY, s.W, s.H - OY);
        }
    }
}

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
        s.hero.spr = HERO_FRAME[0];
    }
    s.hx = cx(at[0]);
    s.hy = cy(at[1]);
    initButtons(s);
    s.hudKey = '';
    applyGameClip(s, E);
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
    var n = s.E.data.lendaSlot || s.E.save.num('lenda.slot', 1);
    slotSave(s.E, n, s.st);
}

// ------------------------------------------------------------ update -----

exports.update = function (dt, ctx) {
    var s = this, E = s.E;
    if (s.screen === 'title') updateTitle(s, E, ctx);
    else if (s.screen === 'win') updateWin(s, E, ctx);
    else if (s.screen === 'lose') updateLose(s, E, ctx);
    else updateGame(s, E, ctx, dt);
    // diagnostico opt-in (E.debug no build ou pelo debugger): o overlay ja
    // mostra fps; o log permite medir na bancada sem foto
    if (E.debug || PERF_LOG) {
        s._perfT = (s._perfT || 0) + dt;
        if (s._perfT >= 2) {
            s._perfT = 0;
            var d = E.dirty && E.dirty._prev ? E.dirty._prev : [];
            var area = 0;
            for (var di = 0; di < d.length; di += 4) area += d[di + 2] * d[di + 3];
            System.print('[lenda] fps=' + E.fps + ' frame=' + E.frameMs + 'ms dirty=' +
                  (d.length / 4) + ' area=' + area +
                  ' full=' + (E.dirty && E.dirty._wasFull ? 1 : 0) +
                  ' cells=' + (s.map ? s.map.dirty() : 0) +
                  ' upd=' + (E.prof ? (E.prof.update / 1000 | 0) : 0) +
                  ' draw=' + (E.prof ? (E.prof.draw / 1000 | 0) : 0) +
                  ' scene=' + E.sceneName);
        }
    }
};

// os widgets do kit de UI decidem no draw e deixam a acao em s.act; o
// update do quadro seguinte a executa (troca de cena fora do draw)
function takeAct(s) {
    var a = s.act;
    s.act = null;
    return a;
}

function goSaved(ctx, st) {
    ctx.go(sceneName(st.area, parseInt(st.room.split(',')[0], 10),
                     parseInt(st.room.split(',')[1], 10)), { at: st.at });
}

function newGame(E, ctx) {
    var st = newState();
    var n = E.data.lendaSlot || E.save.num('lenda.slot', 1);
    E.data.lenda = st;
    saveState({ E: E, st: st });
    ctx.go('Campo 1,1');
}

function updateTitle(s, E, ctx) {
    var a = takeAct(s);
    if (s.how || s.pick || s.delSlot) E.redraw();   // modal/card animam
    if (a === 'exit') { if (s.ctx && s.ctx.exit) s.ctx.exit(); return; }
    if (a === 'pick') { s.pick = true; E.redraw(); return; }
    if (a === 'pickClose') { s.pick = false; E.redraw(); return; }
    if (a && a.indexOf('slot:') === 0) {
        var n = parseInt(a.substring(5), 10);
        s.slot = n;
        E.data.lendaSlot = n;
        E.save.set('lenda.slot', n);
        var st = slotState(E, n);
        if (st) { E.data.lenda = st; goSaved(ctx, st); }
        else { E.data.lenda = null; newGame(E, ctx); }
        return;
    }
    if (a && a.indexOf('del:') === 0) { s.delSlot = parseInt(a.substring(4), 10); E.redraw(); return; }
    if (a === 'delYes') {
        slotDelete(E, s.delSlot || 1);
        s.delSlot = null;
        E.redraw();
        return;
    }
    if (a === 'delNo') { s.delSlot = null; E.redraw(); return; }
    if (a === 'new') newGame(E, ctx);
    else if (a === 'cont') {
        var st2 = slotState(E, s.slot) || newState();
        E.data.lenda = st2;
        goSaved(ctx, st2);
    } else if (a === 'how') { s.how = true; E.redraw(); }
    else if (a === 'howClose') { s.how = false; E.redraw(); }
}

function updateWin(s, E, ctx) {
    var a = takeAct(s);
    if (a === 'new') newGame(E, ctx);
    else if (a === 'menu') ctx.go('Titulo');
}

function updateLose(s, E, ctx) {
    var a = takeAct(s);
    if (a === 'cont') {
        s.st.hp = s.st.hpMax;
        saveState(s);
        E.data.lenda = s.st;
        goSaved(ctx, s.st);
    } else if (a === 'menu') ctx.go('Titulo');
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
    var act = takeAct(s);
    if (s.paused) {
        if (act === 'resume') { s.paused = false; s.hudKey = ''; E.redraw(); }
        else if (act === 'swap') {        // troca o item B (bomba <-> bumerangue)
            s.st.itemB = s.st.itemB === 'bumerangue' ? 'bomba' : 'bumerangue';
            saveState(s);
            E.redraw();
        } else if (act === 'menu') ctx.go('Titulo');
        return;
    }
    if (s.st) s.st.ms = (s.st.ms || 0) + dt * 1000;   // jornada em ms
    if (E.input.justDown && inRect(s.btnPause, E.input.x, E.input.y)) { s.paused = true; return; }
    if (s.msgT > 0) { s.msgT -= dt; if (s.msgT <= 0) s.msg = ''; }
    if (s.portalCd > 0) s.portalCd -= dt;
    if (s.invuln > 0) s.invuln -= dt;
    if (s.attackT > 0) s.attackT -= dt;

    // movimento: JOYSTICK FLUTUANTE. O toque so ASSENTA a base (nao anda) e o
    // diferencial desde ela da a direcao. Antes a heroina andava NA DIRECAO DO
    // DEDO (vetor heroina->toque): o toque inicial ja a colocava em movimento
    // e a direcao mudava sozinha conforme ela se aproximava. A gesto que comeca
    // num botao nao pega o stick; um que comecou fora continua valendo mesmo se
    // passar por cima do botao.
    s.walking = false;
    var r0 = s.buttons;
    var overUi = inRect(r0 && r0.a, E.input.x, E.input.y) ||
                 inRect(r0 && r0.b, E.input.x, E.input.y) ||
                 inRect(r0 && r0.pause, E.input.x, E.input.y);
    if (E.input.down && (s.joyOn || !overUi)) {
        if (!s.joyOn) {
            s.joyOn = true;
            s.joyX0 = E.input.x;
            s.joyY0 = E.input.y;
        }
        var dx = E.input.x - s.joyX0, dy = E.input.y - s.joyY0;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > JOY_DEAD) {
            var speed = CELL * 3.4 * dt;
            moveHero(s, dx / d * speed, dy / d * speed);
            if (Math.abs(dx) > Math.abs(dy)) s.dir = dx > 0 ? 'right' : 'left';
            else s.dir = dy > 0 ? 'down' : 'up';
            s.walkT += dt;
            s.walking = true;
            s.frame = Math.floor(s.walkT * 7) % 2;
        }
    } else {
        s.joyOn = false;
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
    if (s.art) updateFx(s, dt);
    updateEnemies(s, E, dt);
    updateRocks(s, E, dt);
    updateBombs(s, E, dt);
    updateBoomerang(s, E, dt);
    updateItems(s, E);
    checkPortals(s, E, ctx);
}

function addFx(s, x, y, kind) {
    if (!s.vfx) return;
    if (s.vfx.length >= 8) s.vfx.shift();
    s.vfx.push({ x: x, y: y, t: 0, kind: kind });
}

function updateFx(s, dt) {
    for (var i = s.vfx.length - 1; i >= 0; i--) {
        s.vfx[i].t += dt;
        if (s.vfx[i].t >= FX_T * 6) s.vfx.splice(i, 1);
    }
}

function drawFx(s, E) {
    for (var i = 0; i < s.vfx.length; i++) {
        var v = s.vfx[i];
        var f = Math.floor(v.t / FX_T);
        if (f > 5) continue;
        if (v.kind === 'boom') E.spr.stamp(BOOM[f], v.x, v.y, OPT_FX);
        else E.spr.stamp(FX[(v.kind === 'heal' ? FX_HEAL : FX_POOF) + f], v.x, v.y, OPT_FX);
    }
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
    // linha da direcao; parada = quadro de contato. A espada continua
    // overlay da folha antiga (quadros 6..9, desenhada por drawSword)
    var f = (HERO_ROW[s.dir] || 0) + (s.walking ? Math.floor(s.walkT * 8) % 4 : 0);
    var active = !(s.invuln > 0 && Math.floor(s.invuln * 12) % 2 === 0);
    if (s.hero.active !== active) s.hero.active = active;
    var spr = HERO_FRAME[f];
    if (s.hero.spr !== spr) s.hero.spr = spr;
}

function drawSword(s, E) {
    if (s.attackT <= 0 || !s.hero || s.hero.active === false) return;
    var f = HERO_ATK[s.dir] || 8;
    var x = s.hx, y = s.hy - 4;
    if (s.dir === 'right') x += CELL * 0.85;
    else if (s.dir === 'left') x -= CELL * 0.85;
    else if (s.dir === 'down') y += CELL * 0.8;
    else { x += CELL * 0.18; y -= CELL * 0.8; }
    if (E.spr && E.spr.has && E.spr.has(HERO_SWORD[(f - 6 + HERO_SWORD.length) % HERO_SWORD.length])) {
        E.spr.stamp(HERO_SWORD[(f - 6 + HERO_SWORD.length) % HERO_SWORD.length], x, y, OPT_SWORD);
    }
    // arco do golpe (vfx slash): 4 quadros ao longo dos 0,18 s
    if (s.art) {
        var k = Math.floor((0.18 - s.attackT) / 0.045);
        E.spr.stamp(FX[(SLASH_ROW[s.dir] || 0) + (k < 0 ? 0 : (k > 3 ? 3 : k))], x, y, OPT_FX);
    }
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
    else if (loot === 'bumerangue') { s.st.itemB = 'bumerangue'; s.st.boom = true; }
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
            if (e.ent.x !== e.x) e.ent.x = e.x;
            if (e.ent.y !== e.y) e.ent.y = e.y;
            var fr = 0;
            if (e.type === 'morcego') fr = 2 + (Math.floor(e.t * 5) % 2);
            else if (e.type === 'esqueleto') fr = 4 + (Math.floor(e.t * 5) % 2);
            else if (e.type === 'geleia') fr = 6 + (Math.floor(e.t * 5) % 2);
            else if (e.type === 'polvo') fr = Math.floor(e.t * 5) % 2;
            var spr;
            if (e.type === 'chefe') spr = ENEMY_FRAME.chefe[e.flash > 0 ? 1 : 0];
            else {
                var list = ENEMY_FRAME[e.type] || ENEMY_FRAME.polvo;
                spr = list[fr % list.length];
            }
            if (e.ent.spr !== spr) e.ent.spr = spr;
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
        addFx(s, e.x, e.y, 'poof');
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
    addFx(s, x, y, 'boom');
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
    if (it.item === 'coracao') {
        s.st.hp = clamp(s.st.hp + 1, 0, s.st.hpMax);
        addFx(s, s.hx, s.hy - 8, 'heal');
    }
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
        s.st.falls = (s.st.falls || 0) + 1;
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

var LOGO_TXT = { px: 40, align: 'center', valign: 'middle', color: OURO,
                 outline: C(0x2A1A00), screen: true };
var SUB_TXT = { px: 14, align: 'center', valign: 'middle', color: TEXT2, screen: true };
var BTN_NEW = { variant: 'primary', icon: 'play' };
var BTN_CONT = { variant: 'secondary', icon: 'refresh' };
var BTN_HOW = { variant: 'ghost', icon: 'info' };
var BTN_MENU = { variant: 'secondary', icon: 'home' };
var HOW_BODY = 'Arraste para andar. A: espada, falar, abrir bau. ' +
               'B: bomba ou bumerangue. Fale com o Sabio.';
var HOW_BTNS = [{ label: 'Entendi', value: 1, icon: 'check' }];
var BIG2 = { key: 0xF81F, scale: 2 };

function drawTitle(s, E) {
    var W = s.W;
    // a arte do titulo e a entidade; a faixa de baixo dela traz uma barra de
    // UI assada na imagem: o painel escuro comeca antes dela
    E.gfx.rect(0, 186, W, s.H - 186, C(0x0B1020), { screen: true });
    E.gfx.text('LENDA DE CELER', W / 2, 266, LOGO_TXT);
    E.gfx.text('a pedra do templo despertou', W / 2, 300, SUB_TXT);
    if (s.pick) { drawSlots(s, E); return; }
    var c = E.ui.card(40, 318, W - 80, 152);
    if (E.ui.button('JOGAR', c.x, c.y, c.w, 46, BTN_NEW)) s.act = 'pick';
    if (E.ui.button('AJUDA', c.x, c.y + 54, c.w, 40, BTN_HOW)) s.act = 'how';
    if (E.ui.button('SAIR', c.x, c.y + 102, c.w, 40, BTN_CONT)) s.act = 'exit';
    if (s.how) {
        var r = E.ui.modal('how', { title: 'COMO JOGAR', body: HOW_BODY, buttons: HOW_BTNS });
        if (r !== null) s.act = 'howClose';
    }
}

// Seletor de save: 3 slots com nome da sala, cristais, minutos e quedas.
// Alvo do toque e o card inteiro (E.hit), como o mapa do Detona; o X apaga.
var SLOT_T = { px: 15, screen: true, color: 0xFFFF };
var SLOT_S = { px: 11, screen: true, color: 0x8894A8 };
var SLOT_X = { px: 16, screen: true, align: 'center', color: 0xF04848 };

function drawSlots(s, E) {
    var W = s.W, H = s.H;
    E.gfx.rect(0, 186, W, H - 186, C(0x0B1020), { screen: true });
    E.gfx.text('ESCOLHA O SAVE', W / 2, 210, LOGO_TXT);
    var c = E.ui.card(40, 246, W - 80, 200);
    for (var n = 1; n <= 3; n++) {
        var st = slotState(E, n);
        var y = c.y + 8 + (n - 1) * 58;
        var sel = n === s.slot;
        E.ui.card(c.x + 6, y, c.w - 12, 50,
                  { pad: 0, stroke: sel ? C(0xFFC83C) : C(0x22304A),
                    bg: sel ? C(0x1C2436) : C(0x121A2C) });
        SLOT_T.color = st ? C(0xFFFFFF) : C(0x6A7A94);
        E.gfx.text('SLOT ' + n, c.x + 16, y + 6, SLOT_T);
        E.gfx.text(slotLine(st), c.x + 16, y + 28, SLOT_S);
        E.gfx.text('x', c.x + c.w - 26, y + 14, SLOT_X);
        var hit = { x: c.x + 6, y: y, w: c.w - 60, h: 50 };
        var del = { x: c.x + c.w - 52, y: y, w: 46, h: 50 };
        E._btns.push(hit);
        E._btns.push(del);
        if (E.input.tap && E.hit(del) && st) { s.act = 'del:' + n; return; }
        if (E.input.tap && E.hit(hit)) { s.act = 'slot:' + n; return; }
    }
    if (E.ui.button('VOLTAR', W / 2 - 80, c.y + c.h + 12, 160, 40, BTN_CONT)) s.act = 'pickClose';
    if (s.delSlot) {
        var r = E.ui.modal('del', { title: 'APAGAR SAVE',
                                    body: 'slot ' + s.delSlot + ' sera perdido.',
                                    buttons: [{ label: 'Nao', value: 'delNo' },
                                              { label: 'Apagar', value: 'delYes' }] });
        if (r !== null) s.act = r;
    }
}

function endCard(s, E, title, color, sub) {
    var W = s.W;
    E.gfx.rect(0, 0, W, s.H, C(0x0B1020), { screen: true });
    E.gfx.text(title, W / 2, 70, { px: 30, align: 'center', valign: 'middle', color: color,
                                   outline: 0x0000, screen: true });
    E.gfx.text(sub, W / 2, 108, SUB_TXT);
    if (E.spr.has(HERO_FRAME[0])) E.spr.stamp(HERO_FRAME[0], W / 2, 186, BIG2);
    var c = E.ui.card(40, 250, W - 80, 210);
    E.gfx.hearts(s.st.hp > 0 ? s.st.hp : s.st.hpMax, s.st.hpMax, c.x, c.y,
                 { size: 22, color: VERM, empty: 0x3008, screen: true });
    if (E.spr.has('itens#itens1')) E.spr.stamp('itens#itens1', c.x + c.w - 70, c.y + 11, OPT_ICON);
    E.gfx.text('x' + s.st.crystals, c.x + c.w, c.y + 11,
               { px: 15, align: 'right', valign: 'middle', color: BRANCO, screen: true });
    return c;
}

function drawWin(s, E) {
    var c = endCard(s, E, 'LENDA VIVA!', OURO, 'o Guardiao caiu e o cristal e seu');
    if (E.ui.button('NOVO JOGO', c.x, c.y + 54, c.w, 48, BTN_NEW)) s.act = 'new';
    if (E.ui.button('MENU', c.x + c.w / 2 - 80, c.y + 112, 160, 40, BTN_MENU)) s.act = 'menu';
}

function drawLose(s, E) {
    var c = endCard(s, E, 'VOCE CAIU', VERM, 'o Sabio ainda espera na gruta');
    if (E.ui.button('CONTINUAR', c.x, c.y + 54, c.w, 48, BTN_NEW)) s.act = 'cont';
    if (E.ui.button('MENU', c.x + c.w / 2 - 80, c.y + 112, 160, 40, BTN_MENU)) s.act = 'menu';
}

function drawGame(s, E) {
    var W = s.W, H = s.H, i;
    if (!s.buttons) initButtons(s);
    // projeteis/bomba/bumerangue por cima das entidades (recorte do mundo
    // ativo: nada disso invade a faixa do HUD)
    for (i = 0; i < s.rocks.length; i++) {
        var r = s.rocks[i];
        E.spr.stamp('inimigos#inimigos11', r.x, r.y, OPT_ROCK);
    }
    for (i = 0; i < s.bombs.length; i++) {
        var b = s.bombs[i];
        E.spr.stamp('itens#itens4', cx(b.c), cy(b.r), OPT_ITEM);
        if (b.t < 0.4) E.gfx.circle(cx(b.c), cy(b.r), 9, VERM, WORLD_RING);
    }
    if (s.boomerang) {
        E.spr.stamp('itens#itens5', s.boomerang.x, s.boomerang.y, OPT_ITEM);
    }
    for (i = 0; i < s.enemies.length; i++) {
        var en = s.enemies[i];
        if (en.hp > 0 && en.flash > 0) {
            E.gfx.circle(en.x, en.y, en.r + 3, BRANCO, WORLD_RING);
        }
    }
    drawSword(s, E);
    if (s.art) drawFx(s, E);
    // HUD e botoes: memoizados fora da camada suja
    drawHud(s, E);
    // joystick: base assentada no toque + botao deslocado pelo diferencial
    // (limitado ao raio). So aparece com o dedo na tela.
    if (s.joyOn) {
        E.gfx.circle(s.joyX0, s.joyY0, JOY_R, C(0x2A3A5A), JOY_RING);
        var kx = E.input.x - s.joyX0, ky = E.input.y - s.joyY0;
        var kd = Math.sqrt(kx * kx + ky * ky);
        if (kd > JOY_R) {
            kx = kx / kd * JOY_R;
            ky = ky / kd * JOY_R;
        }
        E.gfx.circle(s.joyX0 + kx, s.joyY0 + ky, 6, OURO, JOY_DOT);
    }
    if (s.msg) {
        E.gfx.text(s.msg, W / 2, H - 70, MSG_TXT);
    }
    if (s.dialog) drawDialog(s, E);
    if (s.paused) {
        if (E.dirty.unclip) E.dirty.unclip();   // a pausa cobre tambem o HUD
        var pr = E.ui.modal('pausa', { title: 'PAUSA', dismiss: false,
                                       body: s.roomName + (s.st && s.st.boom ? ('  ·  B: ' + s.st.itemB) : ''),
                                       buttons: (s.st && s.st.boom) ? PAUSE_BTNS_ITEM : PAUSE_BTNS });
        if (pr !== null) s.act = pr;
        applyGameClip(s, E);
    }
    if (s.dead || s.win) {
        E.gfx.text(s.win ? 'GUARDIAO DERROTADO!' : 'VOCE CAIU',
            W / 2, H / 2, { px: 30, align: 'center', valign: 'middle',
                color: s.win ? OURO : VERM, bg: C(0x0B1020), screen: true });
    }
}

var PAUSE_ITEM = { label: 'Item', value: 'swap', icon: 'swap' };
var PAUSE_BTNS = [{ label: 'Menu', value: 'menu', icon: 'home' },
                  { label: 'Continuar', value: 'resume' }];
var PAUSE_BTNS_ITEM = [{ label: 'Menu', value: 'menu', icon: 'home' },
                       PAUSE_ITEM,
                       { label: 'Continuar', value: 'resume' }];
var DLG_TXT = { px: 15, color: BRANCO, screen: true };
var DLG_HINT = { px: 11, align: 'right', color: TEXT2, screen: true };
var DLG_LINE = [];

// fala: card com retrato (Sabio = inimigos#8, lojista = bau) e o nome num
// badge; a linha quebra pelo E.gfx.wrap
function drawDialog(s, E) {
    var dlg = s.dialog, W = s.W, H = s.H;
    var line = dlg.lines[dlg.i];
    var sep = line.indexOf(': ');
    var who = sep > 0 ? line.substring(0, sep) : '';
    var txt = sep > 0 ? line.substring(sep + 2) : line;
    var c = E.ui.card(10, H - 150, W - 20, 140);
    E.gfx.rect(c.x, c.y, 44, 44, C(0x1B2740), { r: 8, screen: true });
    var face = who === 'LOJA' ? 'tileset#14' : 'inimigos#inimigos8';
    if (E.spr.has(face)) E.spr.stamp(face, c.x + 22, c.y + 22, OPT_ICON);
    if (who) E.ui.badge(who, c.x + 54, c.y + 4, { color: OURO, textColor: 0x0000 });
    var lines = E.gfx.wrap ? E.gfx.wrap(txt, c.w - 54, DLG_TXT) : [txt];
    for (var i = 0; i < lines.length && i < 3; i++) {
        E.gfx.text(lines[i], c.x + 54, c.y + 44 + i * 22, DLG_TXT);
    }
    E.gfx.text((dlg.i + 1) + '/' + dlg.lines.length + '  toque', c.x + c.w, c.y + c.h - 12, DLG_HINT);
}

function drawAction(E, r, key, icon) {
    E.gfx.rect(r.x, r.y, r.w, r.h, C(0x1B2740), ACT_RECT);
    if (E.spr && E.spr.has && E.spr.has(icon)) {
        E.spr.stamp(icon, r.x + r.w / 2, r.y + r.h / 2 + 1, OPT_ACTION);
    }
    E.gfx.text(key, r.x + 8, r.y + 7, ACT_TXT);
}

var HUD_INV = ['itens#itens1', 'itens#itens4', 'itens#itens3', 'itens#itens9'];
var HUD_N = { px: 14, valign: 'middle', color: BRANCO, screen: true };

function hudKey(s) {
    return s.st.hp + '|' + s.st.hpMax + '|' + s.st.crystals + '|' + s.st.bombs +
        '|' + s.st.keys + '|' + (s.st.sword || 1) + '|' + s.st.itemB +
        '|' + s.roomName;
}

function hudTouched(s, E) {
    if (!E.dirty || !E.dirty.touches) return true;
    if (E.dirty.touches(0, 0, s.W, OY)) return true;
    // dialogo/mensagem cobrem a faixa dos botoes: nao vale repintar o HUD
    // inteiro por quadro; quando o overlay sai, a caixa suja dele forca o
    // repaint dos botoes
    if (s.dialog || s.msg) return false;
    var b = s.buttons;
    return E.dirty.touches(b.a.x, b.a.y, b.a.w, b.a.h) ||
        E.dirty.touches(b.b.x, b.b.y, b.b.w, b.b.h) ||
        E.dirty.touches(b.pause.x, b.pause.y, b.pause.w, b.pause.h);
}

function drawHud(s, E) {
    if (!s.st || s.paused || s.dead || s.win) return;
    var key = hudKey(s);
    if (s.hudKey === key && !hudTouched(s, E)) return;
    s.hudKey = key;
    // HUD fora da camada suja: parado ele nao entra no apaga-redesenha do
    // mundo. O recorte nativo e solto so durante o HUD e devolvido depois.
    E.dirty._mute++;
    if (E.dirty.unclip) E.dirty.unclip();
    var W = s.W;
    E.gfx.rect(0, 0, W, OY, C(0x080C16), { screen: true });
    E.gfx.rect(0, OY - 2, W, 2, OURO, { screen: true });
    E.gfx.text(s.roomName, 8, 6, { px: 15, color: OURO, screen: true });
    E.gfx.text('VIDA', 8, 30, { px: 9, color: TEXT2, screen: true });
    E.gfx.hearts(s.st.hp, s.st.hpMax, 40, 26, { size: 10, color: VERM,
        empty: 0x3008, screen: true });
    // inventario em icones da folha de itens (cristal, bomba, chave, espada)
    var ix = 200;
    for (var ii = 0; ii < HUD_INV.length; ii++) {
        var n = ii === 0 ? s.st.crystals : (ii === 1 ? s.st.bombs :
                (ii === 2 ? s.st.keys : (s.st.sword || 1)));
        E.spr.stamp(HUD_INV[ii], ix + 16, 40, OPT_ICON);
        E.gfx.text('' + n, ix + 32, 40, HUD_N);
        ix += 58;
    }
    E.ui.icon('pause', W - 32, 8, 22, { color: BRANCO });
    if (!s.dialog) {
        drawAction(E, s.buttons.a, 'A', 'itens#itens9');
        drawAction(E, s.buttons.b, 'B',
            s.st.itemB === 'bumerangue' ? 'itens#itens5' : 'itens#itens4');
    }
    E.dirty._mute--;
    applyGameClip(s, E);
}
