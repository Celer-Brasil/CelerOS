// detona.js - controlador da versao NATIVA do Detona no Celer Studio.
// Uma cena = uma tela (Titulo/Mapa/Fase 1..6/Vitoria); o tilemap "mapa" e os
// componentes do Studio sao o nivel; este script le ctx.scene.data e comanda
// o jogador, bombas, inimigos, powerups e HUD. ES5 (Duktape).

var MENU_SONG = {
    bpm: 96, loops: 8,
    tracks: [
        { drum: true, vol: 40,
          notes: [[36, 4], [42, 4], [38, 4], [42, 4]] },
        { wave: 'tri', vol: 55,
          notes: [[45, 8], [52, 8], [50, 8], [48, 8],
                  [45, 8], [52, 8], [55, 8], [52, 8]] }
    ]
};

var BATTLE_SONG = {
    bpm: 128, loops: 8,
    tracks: [
        { drum: true, vol: 70,
          notes: [[36, 2], [42, 2], [38, 2], [42, 2],
                  [36, 2], [42, 2], [38, 2], [42, 2],
                  [36, 2], [42, 2], [38, 2], [42, 2],
                  [36, 2], [36, 2], [38, 2], [42, 2]] },
        { wave: 'tri', vol: 60,
          notes: [[45, 4], [45, 2], [48, 2], [50, 4], [45, 4],
                  [45, 4], [45, 2], [48, 2], [52, 4], [50, 4],
                  [45, 4], [45, 2], [48, 2], [50, 4], [43, 4],
                  [41, 4], [43, 2], [45, 2], [40, 4], [40, 4]] },
        { wave: 'sq', vol: 45,
          notes: [[64, 2], [67, 2], [69, 4], [67, 2], [64, 2],
                  [62, 4], [64, 8],
                  [64, 2], [67, 2], [69, 4], [72, 2], [71, 2],
                  [69, 4], [67, 8],
                  [71, 2], [69, 2], [67, 4], [64, 2], [62, 2],
                  [60, 4], [62, 8]] },
        { wave: 'sq25', vol: 30,
          notes: [[52, 2], [55, 2], [59, 2], [55, 2],
                  [52, 2], [55, 2], [59, 2], [55, 2],
                  [50, 2], [53, 2], [57, 2], [53, 2],
                  [52, 2], [55, 2], [59, 2], [55, 2]] }
    ]
};

var THEMES = {
    garden: { name: 'Jardim de Pedra', hud: 0x0204, hudTxt: 0xE71C, accent: 0x07E0,
              flame: 0xFD20, flame2: 0xFFE0 },
    forge:  { name: 'Forno',           hud: 0x1800, hudTxt: 0xFFE0, accent: 0xFD20,
              flame: 0xF800, flame2: 0xFD20 },
    core:   { name: 'Nucleo',          hud: 0x0004, hudTxt: 0xBDF7, accent: 0xF81F,
              flame: 0x07FF, flame2: 0xF81F }
};

// cor CSS (#RRGGBB) -> RGB565 do firmware; constantes de 4 digitos ja sao RGB565
function C(hex) {
    return ((hex >> 19) & 31) << 11 | ((hex >> 10) & 63) << 5 | ((hex >> 3) & 31);
}

var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
var CELL = 32;
var COLS = 15, ROWS = 13;
var BOARD_H = ROWS * CELL;

// joystick flutuante: base assentada no toque, zona morta antes de andar
var JOY_R = 36, JOY_DEAD = 14;
// opcoes reutilizadas: o draw roda todo quadro e alocar/escalar no Duktape
// custa caro (o pulse da bomba virava caminho afim por bomba)
var OPT_BOMB = { scale: 1, key: 0xF81F };
var OPT_DROP = { scale: 0.5, key: 0xF81F };
var JOY_RING = { fill: false, screen: true };
var JOY_DOT = { fill: true, screen: true };
var RED_DOT = { fill: true };
var FLAME_BIG = { r: 8 };
var FLAME_SMALL = { r: 6 };
var DROP_TXT = { px: 13, align: 'center', valign: 'middle',
                 color: C(0x101010), bg: 0xFFE0 };

function center(c) { return c * CELL + CELL / 2; }
function cellOf(v) { return Math.round((v - CELL / 2) / CELL); }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function inRect(r, x, y) {
    return !!(r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
}
function keyOf(c, r) { return c + ',' + r; }
function themeOf(name) { return THEMES[name] || THEMES.garden; }
function aliveEnemies(s) {
    var out = [];
    for (var i = 0; i < s.enemies.length; i++) if (s.enemies[i].active !== false) out.push(s.enemies[i]);
    return out;
}
function starCount(timeLeft, time0, lives) {
    var frac = time0 > 0 ? timeLeft / time0 : 0;
    if (frac >= 0.55 && lives >= 2) return 3;
    if (frac >= 0.3) return 2;
    return 1;
}
function drawPanel(E, x, y, w, h, bg, stroke) {
    E.gfx.panel(x, y, w, h, { bg: bg, stroke: stroke, r: 10, screen: true });
}
function drawButton(E, r, label, primary) {
    return E.gfx.button(label, r.x, r.y, r.w, r.h,
        { primary: !!primary, screen: true, px: r.px || 20 });
}

// recorte do mundo: o apagar das caixas sujas e o desenho do jogo nao
// invadem a faixa do HUD (o HUD desenha com unclip e depois devolve)
function applyGameClip(s, E) {
    if (E.dirty && E.dirty.on && E.caps && E.caps.clip && E.dirty.clip) {
        E.dirty.clip(0, 0, s.W, BOARD_H);
        if (typeof System !== 'undefined' && System.setClip) {
            System.setClip(0, 0, s.W, BOARD_H);
        }
    }
}

// tabuleiro assado: as dezenas de stamps por quadro viram 1 blitSprite por
// caixa suja. map.set rebakea so a celula alterada (caixa quebrada/saida).
function rebakeCell(s, E, c, r) {
    if (!s.bg || !s.map || !s.map.paint) return;
    E.dirty._mute++;
    System.useSprite(s.bg);
    if (E.spr) E.spr.alvo = s.bg;
    System.setClip(c * CELL, r * CELL, CELL, CELL);
    s.map.paint(c, r, c * CELL, r * CELL);
    System.clearClip();
    if (E.spr) E.spr.alvo = 0;
    System.useSprite(0);
    E.dirty._mute--;
}

function bakeBoard(s, E) {
    s.bg = 0;
    // no host os alvos de sprite sao stubs (blit nao pinta); preview segue
    // pelo caminho de celulas, a bancada e quem valida o bake
    if (typeof __harness !== 'undefined') return;
    if (!s.map || !s.map.paint || !E.caps || !E.caps.sprites || !E.caps.clip ||
        typeof System === 'undefined' || typeof System.blitSprite !== 'function' ||
        typeof System.copySprite !== 'function' || !E.slots || !E.slots.create) return;
    var slot = E.slots.create('detona:fundo', s.W, BOARD_H);
    if (!slot) return;
    E.dirty._mute++;
    System.useSprite(slot);
    if (E.spr) E.spr.alvo = slot;
    System.fillScreen(0);
    for (var r = 0; r < ROWS; r++) {
        for (var c = 0; c < COLS; c++) s.map.paint(c, r, c * CELL, r * CELL);
    }
    if (E.spr) E.spr.alvo = 0;
    System.useSprite(0);
    E.dirty._mute--;
    s.bg = slot;
    // toda quebra/porta abre passa pelo set: rebakea a celula no fundo
    var mapSet = s.map.set;
    s.map.set = function (c, r, v) {
        var ok = mapSet.call(this, c, r, v);
        if (ok) rebakeCell(s, E, c, r);
        return ok;
    };
    // o apagar das caixas sujas restaura o fundo do sprite em uma chamada
    E.dirty.enable(function (x, y, w, h) {
        System.fillRect(x, y, w, h, 0);
        System.blitSprite(s.bg, x, y, w, h);
    });
}

exports.create = function (ctx) {
    return { ctx: ctx };
};

exports.start = function (ctx) {
    var s = this;
    var E = s.E = ctx.E;
    s.ctx = ctx;
    s.scene = ctx.scene;
    s.W = E.W;
    s.H = E.H;
    s.screen = (ctx.scene.data && ctx.scene.data.screen) || 'title';
    s.how = false;
    s.msg = '';
    s.msgT = 0;
    s.paused = false;
    s.done = false;
    s.won = false;
    s.lost = false;
    s.cards = null;
    s.bombs = [];
    s.flames = [];
    s.drops = [];
    s.pad = null;
    s.btnPause = null;
    s.btnBomb = null;
    s.btnResume = null;
    s.btnMapPause = null;
    s.btnNext = null;
    s.btnMapEnd = null;
    s.btnRetry = null;
    s.btnMapLost = null;
    s.btnMapWin = null;
    s.btnAgain = null;

    if (typeof __harness !== 'undefined') __harness.detona = s;

    if (s.screen === 'title') {
        s.best = E.save.num('best', 0);
        s.unlocked = E.save.num('unlocked', 1);
        if (E.audio) E.audio.music(MENU_SONG);
    } else if (s.screen === 'map') {
        s.unlocked = E.save.num('unlocked', 1);
        s.score = E.data.score || 0;
        if (E.audio) E.audio.music(MENU_SONG);
    } else if (s.screen === 'win') {
        s.score = E.data.score || 0;
        s.best = E.save.num('best', 0);
        if (E.audio) E.audio.music(MENU_SONG);
    } else {
        startGame(s, ctx);
    }
};

function startGame(s, ctx) {
    var E = s.E = ctx.E;
    var d = ctx.scene.data || {};
    s.ctx = ctx;
    s.scene = ctx.scene;
    s.level = d.level || 1;
    s.levelName = d.name || ('Fase ' + s.level);
    s.themeName = d.theme || 'garden';
    s.theme = themeOf(s.themeName);
    s.time0 = d.time || 120;
    s.timeLeft = s.time0;
    s.map = ctx.scene.tm('mapa');
    s.player = ctx.scene.find('Jogador');
    s.enemies = [];
    var ents = ctx.scene.entities;
    for (var i = 0; i < ents.length; i++) {
        if (ents[i].data && ents[i].data.kind === 'enemy') s.enemies.push(ents[i]);
    }
    s.exit = d.exit || [13, 11];
    s.score0 = E.data.score || 0;
    s.score = s.score0;
    s.lives = 3;
    s.range = 1;
    s.maxBombs = 1;
    s.speed = 1;
    s.remote = false;
    s.shield = false;
    s.moving = 0;
    s.moveT = 0;
    s.mt = 0;
    s.invuln = 0;
    s.bossDead = false;
    s.exitRevealed = false;
    s.btnBomb = { x: 396, y: 420, w: 76, h: 52 };
    s.btnPause = { x: 436, y: 6, w: 36, h: 30 };
    s.hudKey = '';
    s.joyOn = false;       // joystick flutuante: base assentada no toque
    s.joyX0 = 0;
    s.joyY0 = 0;
    s.joyMoved = false;
    s.uiTouch = null;      // toque que comecou num botao nao vira joystick
    s.hudForce = true;     // primeiro HUD da cena (o mundo fica em outro clip)
    bakeBoard(s, E);
    applyGameClip(s, E);
    s.gx = s.player ? cellOf(s.player.x) : 1;
    s.gy = s.player ? cellOf(s.player.y) : 1;
    s.bombs = [];
    s.flames = [];
    s.drops = [];
    s.paused = false;
    s.done = false;
    s.won = false;
    s.lost = false;
    s.msg = '';
    s.msgT = 0;
    if (E.audio) E.audio.music(BATTLE_SONG);
    if (s.map) {
        var v = s.map.get(s.exit[0], s.exit[1]);
        if (v === 2) s.exitRevealed = false;
        else s.exitRevealed = true;
    }
};

exports.update = function (dt, ctx) {
    var s = this, E = s.E;
    if (s.screen === 'title') return titleUpdate(s, E);
    if (s.screen === 'map') return mapUpdate(s, E, ctx);
    if (s.screen === 'win') return winUpdate(s, E, ctx);
    gameUpdate(s, E, ctx, dt);
};

function titleUpdate(s, E) {
    if (s.how) {
        if (E.input.tap) { s.how = false; E.redraw(); }
        return;
    }
    if (s.btnPlay && E.hit(s.btnPlay)) {
        E.data.score = 0;
        s.ctx.go('Mapa');
        return;
    }
    if (s.btnHow && E.hit(s.btnHow)) { s.how = true; E.redraw(); }
}

function mapUpdate(s, E, ctx) {
    if (!s.cards) return;
    for (var i = 0; i < s.cards.length; i++) {
        var c = s.cards[i];
        if (!E.hit(c)) continue;
        if (c.locked) {
            s.msg = 'Fase bloqueada';
            s.msgT = 1.2;
            E.redraw();
            return;
        }
        s.msg = '';
        ctx.go(c.name);
        return;
    }
    if (s.btnBack && E.hit(s.btnBack)) { ctx.go('Titulo'); }
}

function winUpdate(s, E, ctx) {
    if (s.btnAgain && E.hit(s.btnAgain)) {
        E.data.score = 0;
        ctx.go('Mapa');
    } else if (s.btnTitle && E.hit(s.btnTitle)) {
        ctx.go('Titulo');
    }
}

function canStep(s, c, r) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return false;
    if (!s.map) return true;
    var x = center(c), y = center(r);
    if (s.map.solidAt(x, y)) return false;
    if (bombAt(s, c, r)) return false;
    return true;
}

function bombAt(s, c, r) {
    for (var i = 0; i < s.bombs.length; i++) {
        if (s.bombs[i].c === c && s.bombs[i].r === r) return s.bombs[i];
    }
    return null;
}

function step(s, dc, dr) {
    if (s.moving > 0 || s.done || s.lost || s.paused) return;
    var c = s.gx + dc, r = s.gy + dr;
    if (!canStep(s, c, r)) return;
    s.gx = c;
    s.gy = r;
    s.fromX = s.player.x;
    s.fromY = s.player.y;
    s.toX = center(c);
    s.toY = center(r);
    s.mt = 0;
    s.moveT = 0.12 / s.speed;
    s.moving = s.moveT;
}

function stepDir(s, dir) {
    if (dir === 'left') step(s, -1, 0);
    else if (dir === 'right') step(s, 1, 0);
    else if (dir === 'up') step(s, 0, -1);
    else if (dir === 'down') step(s, 0, 1);
}

function placeBomb(s) {
    if (s.done || s.lost || s.paused || s.moving > 0) return;
    if (s.bombs.length >= s.maxBombs) return;
    if (bombAt(s, s.gx, s.gy)) return;
    s.bombs.push({ c: s.gx, r: s.gy, t: 1.6, range: s.range,
                   remote: s.remote, owner: 'player' });
    if (s.E.audio) s.E.audio.sfx([62, 55], { gap: 30 });
}

function detonateRemote(s) {
    for (var i = 0; i < s.bombs.length; i++) {
        if (s.bombs[i].remote) s.bombs[i].t = 0;
    }
}

function addFlame(s, c, r, owner) {
    var k = keyOf(c, r);
    for (var i = 0; i < s.flames.length; i++) if (s.flames[i].key === k) {
        s.flames[i].t = 0.35;
        return;
    }
    s.flames.push({ key: k, c: c, r: r, t: 0.35, owner: owner || 'player' });
}

function updateBombs(s, dt) {
    var i;
    for (i = 0; i < s.bombs.length; i++) s.bombs[i].t -= dt;
    var guard = 0;
    while (guard++ < 64) {
        var boom = null;
        for (i = 0; i < s.bombs.length; i++) if (s.bombs[i].t <= 0) { boom = s.bombs[i]; break; }
        if (!boom) break;
        explode(s, boom);
    }
}

function explode(s, b) {
    var E = s.E;
    var idx = s.bombs.indexOf(b);
    if (idx >= 0) s.bombs.splice(idx, 1);
    var owner = b.owner || 'player';
    addFlame(s, b.c, b.r, owner);
    var dirs = DIRS;
    for (var d = 0; d < dirs.length; d++) {
        for (var n = 1; n <= b.range; n++) {
            var c = b.c + dirs[d][0] * n, r = b.r + dirs[d][1] * n;
            if (c < 0 || r < 0 || c >= COLS || r >= ROWS) break;
            var v = s.map ? s.map.get(c, r) : 0;
            if (v === 1) break;
            if (v === 2) {
                addFlame(s, c, r, owner);
                destroyCrate(s, c, r);
                break;
            }
            addFlame(s, c, r, owner);
            var other = bombAt(s, c, r);
            if (other && other.t > 0) other.t = 0;
        }
    }
    var px = center(b.c), py = center(b.r);
    if (E.fx) E.fx.burst(px, py, { n: 14, color: s.theme.flame, speed: 130, life: 0.45 });
    if (E.audio) E.audio.sfx([50, 55, 60, 55], { gap: 40 });
    // dano imediato das celulas de fogo
    for (var i = 0; i < s.flames.length; i++) {
        var f = s.flames[i];
        if (f.owner !== owner) continue;
        hitEnemiesAt(s, f.c, f.r, owner);
    }
    if (flameAt(s, s.gx, s.gy)) hurtPlayer(s);
}

function flameAt(s, c, r) {
    for (var i = 0; i < s.flames.length; i++) {
        if (s.flames[i].c === c && s.flames[i].r === r) return true;
    }
    return false;
}

function destroyCrate(s, c, r) {
    if (!s.map) return;
    s.map.set(c, r, 0);
    s.score += 10;
    if (c === s.exit[0] && r === s.exit[1]) {
        s.map.set(c, r, 3);
        s.exitRevealed = true;
    } else if (s.E.m.chance(0.38)) {
        var kinds = ['range', 'bomb', 'speed', 'remote', 'shield', 'life'];
        var weights = [26, 24, 18, 12, 10, 10];
        s.drops.push({ c: c, r: r, kind: s.E.m.weighted(
            [[kinds[0], weights[0]], [kinds[1], weights[1]], [kinds[2], weights[2]],
             [kinds[3], weights[3]], [kinds[4], weights[4]], [kinds[5], weights[5]]]) });
    }
}

function hitEnemiesAt(s, c, r, owner) {
    for (var i = 0; i < s.enemies.length; i++) {
        var e = s.enemies[i];
        if (e.active === false) continue;
        if (e.data && e.data.type === 'boss' && owner === 'boss') continue;
        if (cellOf(e.x) !== c || cellOf(e.y) !== r) continue;
        e.hp = (e.hp === undefined ? (e.data.hp || 1) : e.hp) - 1;
        if (e.hp <= 0) {
            e.active = false;
            s.score += e.data.type === 'boss' ? 500 : 50;
            if (s.E.fx) s.E.fx.burst(center(c), center(r),
                { n: 10, color: 0x07E0, speed: 100, life: 0.4 });
            if (e.data.type === 'boss') s.bossDead = true;
        } else {
            if (s.E.audio) s.E.audio.sfx([70, 74], { gap: 30 });
        }
    }
}

function updateFlames(s, dt) {
    var out = [];
    for (var i = 0; i < s.flames.length; i++) {
        s.flames[i].t -= dt;
        if (s.flames[i].t > 0) out.push(s.flames[i]);
    }
    s.flames = out;
}

function enemyInterval(e) {
    var t = e.data.type;
    if (t === 'hunter') return 0.42;
    if (t === 'ghost') return 0.58;
    if (t === 'boss') return 1.0;
    return 0.82;
}

function moveEnemy(s, e, dc, dr) {
    var c = cellOf(e.x), r = cellOf(e.y);
    var nc = c + dc, nr = r + dr;
    if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) return false;
    if (s.map && s.map.get(nc, nr) === 1) return false;
    if (s.map && s.map.get(nc, nr) === 2) return false;
    if (bombAt(s, nc, nr)) return false;
    e.x = center(nc);
    e.y = center(nr);
    return true;
}

function updateEnemies(s, dt) {
    var pc = s.gx, pr = s.gy;
    for (var i = 0; i < s.enemies.length; i++) {
        var e = s.enemies[i];
        if (e.active === false) continue;
        if (cellOf(e.x) === pc && cellOf(e.y) === pr) {
            hurtPlayer(s);
            continue;
        }
        e.aiT = (e.aiT === undefined ? enemyInterval(e) : e.aiT) - dt;
        if (e.aiT > 0) continue;
        e.aiT = enemyInterval(e);
        var c = cellOf(e.x), r = cellOf(e.y);
        var dc = pc === c ? 0 : (pc > c ? 1 : -1);
        var dr = pr === r ? 0 : (pr > r ? 1 : -1);
        if (Math.abs(pc - c) > Math.abs(pr - r)) {
            if (!moveEnemy(s, e, dc, 0)) moveEnemy(s, e, 0, dr);
        } else {
            if (!moveEnemy(s, e, 0, dr)) moveEnemy(s, e, dc, 0);
        }
        if (cellOf(e.x) === pc && cellOf(e.y) === pr) hurtPlayer(s);
        if (e.data.type === 'boss' && s.E.m.chance(0.18) && s.bombs.length < 5) {
            s.bombs.push({ c: cellOf(e.x), r: cellOf(e.y), t: 2.2, range: 2,
                           remote: false, owner: 'boss' });
        }
    }
}

function updateDrops(s) {
    var out = [];
    for (var i = 0; i < s.drops.length; i++) {
        var d = s.drops[i];
        if (d.c === s.gx && d.r === s.gy) {
            applyDrop(s, d.kind);
        } else out.push(d);
    }
    s.drops = out;
}

function applyDrop(s, kind) {
    if (kind === 'range') s.range = clamp(s.range + 1, 1, 5);
    else if (kind === 'bomb') s.maxBombs = clamp(s.maxBombs + 1, 1, 5);
    else if (kind === 'speed') s.speed = clamp(s.speed * 1.18, 1, 2.2);
    else if (kind === 'remote') s.remote = true;
    else if (kind === 'shield') s.shield = true;
    else if (kind === 'life') s.lives = clamp(s.lives + 1, 1, 5);
    s.score += 25;
    if (s.E.audio) s.E.audio.sfx([72, 76, 79, 84], { gap: 30 });
    if (s.E.fx) s.E.fx.popText(center(s.gx), center(s.gy), kind, { color: 0xFFE0 });
}

function hurtPlayer(s) {
    if (s.invuln > 0 || s.done || s.lost) return;
    if (s.shield) {
        s.shield = false;
        s.invuln = 1.4;
        if (s.E.audio) s.E.audio.sfx([76, 72], { gap: 30 });
        return;
    }
    s.lives--;
    s.invuln = 2.0;
    if (s.E.audio) s.E.audio.sfx([60, 55, 48], { gap: 40 });
    if (s.E.fx) s.E.fx.flash(0xF800, 140);
    if (s.lives <= 0) {
        s.lives = 0;
        s.lost = true;
        s.done = true;
        if (s.E.audio) s.E.audio.stop();
        return;
    }
    // volta ao canto seguro (1,1)
    s.gx = 1; s.gy = 1;
    s.moving = 0;
    if (s.player) {
        s.player.x = center(1);
        s.player.y = center(1);
        s.player.active = true;
    }
}

function checkExit(s) {
    if (s.done || s.lost) return;
    if (s.gx !== s.exit[0] || s.gy !== s.exit[1]) return;
    if (!s.exitRevealed) return;
    if (aliveEnemies(s).length) return;
    s.done = true;
    s.won = true;
    var stars = starCount(s.timeLeft, s.time0, s.lives);
    s.score += 100 + Math.floor(s.timeLeft) * 10;
    var unlocked = s.E.save.num('unlocked', 1);
    if (s.level + 1 > unlocked) s.E.save.set('unlocked', s.level + 1);
    var old = s.E.save.num('stars.' + s.level, 0);
    if (stars > old) s.E.save.set('stars.' + s.level, stars);
    if (s.score > s.E.save.num('best', 0)) s.E.save.set('best', s.score);
    s.E.data.score = s.score;
    if (s.E.audio) {
        s.E.audio.stop();
        s.E.audio.sfx([72, 76, 79, 84, 79, 84], { gap: 90 });
    }
}

function gameUpdate(s, E, ctx, dt) {
    if (s.done || s.lost) {
        if (s.won) {
            if (s.btnNext && E.hit(s.btnNext)) {
                E.data.score = s.score;
                if (s.level >= 6) ctx.go('Vitoria');
                else ctx.go('Fase ' + (s.level + 1));
            } else if (s.btnMapEnd && E.hit(s.btnMapEnd)) {
                E.data.score = s.score;
                ctx.go('Mapa');
            }
        } else {
            if (s.btnRetry && E.hit(s.btnRetry)) {
                E.data.score = s.score0;
                ctx.go('Fase ' + s.level);
            } else if (s.btnMapLost && E.hit(s.btnMapLost)) {
                E.data.score = s.score0;
                ctx.go('Mapa');
            }
        }
        return;
    }
    if (s.paused) {
        if (s.btnResume && E.hit(s.btnResume)) {
            s.paused = false;
            s.hudForce = true;   // a overlay de pausa cobriu a faixa do HUD
        }
        else if (s.btnMapPause && E.hit(s.btnMapPause)) ctx.go('Mapa');
        return;
    }
    if (s.msgT > 0) { s.msgT -= dt; if (s.msgT <= 0) s.msg = ''; }

    // BOMBA/pause por press: o toque nao espera o release para valer
    if (E.input.justDown) {
        if (inRect(s.btnPause, E.input.x, E.input.y)) {
            s.uiTouch = 'pause';
            s.paused = true;
            return;
        }
        if (inRect(s.btnBomb, E.input.x, E.input.y)) {
            s.uiTouch = 'bomb';
            placeBomb(s);
            return;
        }
        s.uiTouch = null;
    }
    if (s.uiTouch) {
        if (!E.input.down) s.uiTouch = null;
    } else if (E.input.down) {
        // joystick flutuante: o toque assenta a base e o delta desde ela
        // escolhe a direcao; step() tem o cadeado de movimento, entao
        // segurar anda casa a casa sem engatilhar de novo
        if (!s.joyOn) {
            s.joyOn = true;
            // base dentro do tabuleiro: o circulo nao invade o HUD nem o vidro
            s.joyX0 = clamp(E.input.x, JOY_R, s.W - JOY_R);
            s.joyY0 = clamp(E.input.y, JOY_R, BOARD_H - JOY_R);
            s.joyMoved = false;
        }
        var jdx = E.input.x - s.joyX0, jdy = E.input.y - s.joyY0;
        var jd = Math.abs(jdx) > Math.abs(jdy) ? Math.abs(jdx) : Math.abs(jdy);
        if (jd > JOY_DEAD) {
            s.joyMoved = true;
            if (Math.abs(jdx) > Math.abs(jdy)) stepDir(s, jdx > 0 ? 'right' : 'left');
            else stepDir(s, jdy > 0 ? 'down' : 'up');
        }
    } else {
        s.joyOn = false;
        s.joyMoved = false;
    }
    // toque seco no tabuleiro planta bomba (um arrasto nao planta)
    if (E.input.tap && !s.joyMoved && s.uiTouch === null &&
        E.input.tap.y < BOARD_H - 4) placeBomb(s);
    if (E.input.longpress && !s.joyMoved) detonateRemote(s);

    s.timeLeft -= dt;
    if (s.timeLeft <= 0) {
        s.timeLeft = 0;
        hurtPlayer(s);
        if (!s.lost) s.timeLeft = s.time0 * 0.5;
    }
    if (s.invuln > 0) {
        s.invuln -= dt;
        if (s.player) {
            s.player.active = Math.floor(s.invuln * 10) % 2 === 0;
            if (s.invuln <= 0) s.player.active = true;
        }
    }
    if (s.moving > 0) {
        s.mt += dt;
        var k = clamp(s.mt / s.moveT, 0, 1);
        if (s.player) {
            s.player.x = s.fromX + (s.toX - s.fromX) * k;
            s.player.y = s.fromY + (s.toY - s.fromY) * k;
        }
        if (k >= 1) {
            s.moving = 0;
            if (s.player) { s.player.x = s.toX; s.player.y = s.toY; }
            updateDrops(s);
            checkExit(s);
        }
    }
    updateBombs(s, dt);
    updateFlames(s, dt);
    updateEnemies(s, dt);
    updateDrops(s);
    checkExit(s);
    // um blit do tabuleiro inteiro custa menos no 4848 do que restaurar as
    // caixas sujas uma a uma (cada blitSprite percorre o sprite de fundo)
    if (E.dirty && E.dirty.full) E.dirty.full();
}

exports.destroy = function () {
    var s = this, E = s.E;
    if (s && s.bg && E && E.slots) E.slots.release(s.bg);
    if (s) s.bg = 0;
};

exports.draw = function (ctx) {
    var s = this, E = s.E;
    if (s.screen === 'title') return drawTitle(s, E);
    if (s.screen === 'map') return drawMap(s, E);
    if (s.screen === 'win') return drawWin(s, E);
    drawGame(s, E);
};

function drawTitle(s, E) {
    var W = s.W, H = s.H;
    drawPanel(E, 50, 110, W - 100, 300, C(0x0A1320), C(0x2A3A5A));
    E.gfx.text('DETONA!', W / 2, 160, { px: 56, align: 'center', valign: 'middle',
        color: 0xFFE0, shadow: 0x0000 });
    E.gfx.text('3 mundos  ·  6 fases', W / 2, 206,
        { px: 16, align: 'center', color: C(0x9FB0CC) });
    E.gfx.text('fase ' + clamp(s.unlocked, 1, 6) + '  ·  recorde ' + s.best,
        W / 2, 238, { px: 15, align: 'center', color: C(0x7EE2A8) });
    s.btnPlay = E.gfx.button('JOGAR', W / 2 - 110, 270, 220, 54,
        { primary: true, screen: true, px: 24 });
    s.btnHow = E.gfx.button('COMO JOGAR', W / 2 - 110, 336, 220, 44,
        { primary: false, screen: true, px: 18 });
    if (s.how) {
        E.gfx.rect(0, 0, W, H, C(0x05080E), { screen: true });
        drawPanel(E, 36, 90, W - 72, 300, C(0x101A2A), C(0x38BCF8));
        E.gfx.text('COMO JOGAR', W / 2, 126, { px: 28, align: 'center', color: C(0x38BCF8) });
        E.gfx.text('arraste no tabuleiro: andar', W / 2, 172, { px: 16, align: 'center', color: C(0xE8EEFC) });
        E.gfx.text('toque no tabuleiro ou BOMBA: plantar', W / 2, 204, { px: 16, align: 'center', color: C(0xE8EEFC) });
        E.gfx.text('segure: detonar bombas remotas', W / 2, 236, { px: 16, align: 'center', color: C(0xE8EEFC) });
        E.gfx.text('destrua caixas, pegue powerups e ache a saida', W / 2, 268,
            { px: 14, align: 'center', color: C(0x9FB0CC), fit: W - 100 });
        E.gfx.text('toque para voltar', W / 2, 330, { px: 14, align: 'center', color: C(0xFFD479) });
    }
}

function drawMap(s, E) {
    var W = s.W, H = s.H;
    E.gfx.rect(0, 0, W, H, C(0x080C16), { screen: true });
    E.gfx.text('ESCOLHA A FASE', W / 2, 26, { px: 28, align: 'center', color: 0xFFE0 });
    var unlocked = clamp(s.unlocked, 1, 6);
    var stars = 0;
    for (var i = 1; i <= 6; i++) stars += E.save.num('stars.' + i, 0);
    E.gfx.text(unlocked + '/6 liberadas', W / 2, 64,
        { px: 17, align: 'center', color: C(0x9FB0CC) });
    E.gfx.text(stars + ' estrelas  ·  ' + s.score + ' pts', W / 2, 84,
        { px: 14, align: 'center', color: C(0x9FB0CC) });

    var CW = 204, CH = 96, GX = 16, GY = 16;
    var x0 = (W - (CW * 2 + GX)) / 2, y0 = 110;
    s.cards = [];
    for (var n = 1; n <= 6; n++) {
        var col = (n - 1) % 2, row = Math.floor((n - 1) / 2);
        var x = x0 + col * (CW + GX), y = y0 + row * (CH + GY);
        var locked = n > unlocked;
        drawPanel(E, x, y, CW, CH, locked ? C(0x10141E) : C(0x162338), locked ? C(0x222B3D) : C(0x38BCF8));
        E.gfx.text('FASE ' + n, x + 14, y + 12, { px: 18, color: locked ? C(0x5A6A84) : 0xFFE0 });
        var names = ['Jardim 1', 'Jardim 2', 'Forno 1', 'Forno 2', 'Nucleo', 'Chefe'];
        E.gfx.text(locked ? 'bloqueada' : names[n - 1], x + 14, y + 40,
            { px: 13, color: locked ? C(0x5A6A84) : C(0x9FB0CC) });
        if (!locked) {
            var st = E.save.num('stars.' + n, 0);
            E.gfx.text(st > 0 ? new Array(st + 1).join('*') : '---', x + 14, y + 64,
                { px: 15, color: C(0xFFD479) });
        }
        s.cards.push({ x: x, y: y, w: CW, h: CH, name: 'Fase ' + n, locked: locked });
    }
    s.btnBack = E.gfx.button('VOLTAR', W / 2 - 90, H - 58, 180, 40,
        { primary: false, screen: true, px: 17 });
    if (s.msg) E.gfx.text(s.msg, W / 2, H - 18, { px: 14, align: 'center', color: C(0xFF8B8B) });
}

function drawWin(s, E) {
    var W = s.W, H = s.H;
    E.gfx.rect(0, 0, W, H, C(0x080C16), { screen: true });
    drawPanel(E, 44, 100, W - 88, 300, C(0x101A2A), 0xFFE0);
    E.gfx.text('DETONA! COMPLETO', W / 2, 150, { px: 30, align: 'center', color: 0xFFE0 });
    E.gfx.text('voce limpou os 3 mundos e derrubou o chefe', W / 2, 196,
        { px: 16, align: 'center', color: C(0xE8EEFC), fit: W - 120 });
    E.gfx.text('pontuacao final: ' + s.score, W / 2, 236,
        { px: 22, align: 'center', color: C(0x7EE2A8) });
    E.gfx.text('recorde: ' + s.best, W / 2, 270,
        { px: 13, align: 'center', color: C(0x9FB0CC), fit: W - 30 });
    s.btnAgain = E.gfx.button('JOGAR DE NOVO', W / 2 - 120, 310, 240, 46,
        { primary: true, screen: true, px: 18 });
    s.btnTitle = E.gfx.button('TITULO', W / 2 - 90, 364, 180, 38,
        { primary: false, screen: true, px: 15 });
}

function drawGame(s, E) {
    var W = s.W, H = s.H, i;
    var th = s.theme;
    // bombas (o jogador/inimigos sao entidades do runtime); sem pulse afim:
    // cada drawSprite custa ~1,25 ms no 4848, o aviso fica pelo circulo
    for (i = 0; i < s.bombs.length; i++) {
        var b = s.bombs[i];
        E.spr.stamp('ai_atlas#ai2', center(b.c), center(b.r), OPT_BOMB);
        if (b.t < 0.5) E.gfx.circle(center(b.c), center(b.r), 5, 0xF800, RED_DOT);
    }
    // chamas
    for (i = 0; i < s.flames.length; i++) {
        var f = s.flames[i];
        var x = center(f.c), y = center(f.r);
        E.gfx.rect(x - 14, y - 14, 28, 28, th.flame, FLAME_BIG);
        E.gfx.rect(x - 8, y - 8, 16, 16, th.flame2, FLAME_SMALL);
    }
    // drops
    for (i = 0; i < s.drops.length; i++) {
        var d = s.drops[i];
        E.spr.stamp('ai_atlas#ai3', center(d.c), center(d.r), OPT_DROP);
        E.gfx.text(d.kind.charAt(0).toUpperCase(), center(d.c), center(d.r), DROP_TXT);
    }
    // joystick
    if (s.joyOn && E.input.down) {
        E.gfx.circle(s.joyX0, s.joyY0, JOY_R, C(0x2A3A5A), JOY_RING);
        var kx = E.input.x - s.joyX0, ky = E.input.y - s.joyY0;
        var kd = Math.sqrt(kx * kx + ky * ky);
        if (kd > JOY_R) {
            kx = kx / kd * JOY_R;
            ky = ky / kd * JOY_R;
        }
        E.gfx.circle(s.joyX0 + kx, s.joyY0 + ky, 6, 0xFFE0, JOY_DOT);
    }
    // HUD e botoes: memoizados fora da camada suja
    drawHud(s, E);

    // boss hp
    var boss = null;
    for (i = 0; i < s.enemies.length; i++) {
        if (s.enemies[i].active !== false && s.enemies[i].data.type === 'boss') boss = s.enemies[i];
    }
    if (boss) {
        var maxhp = boss.data.hp || 8;
        var hp = boss.hp === undefined ? maxhp : boss.hp;
        E.gfx.rect(140, 8, 200, 12, C(0x300808), { screen: true });
        E.gfx.rect(140, 8, 200 * clamp(hp / maxhp, 0, 1), 12, 0xF800, { screen: true });
        E.gfx.text('CHEFE', 240, 24, { px: 11, align: 'center', color: 0xFFE0, screen: true });
    }
    if (s.msg) {
        E.gfx.text(s.msg, W / 2, BOARD_H - 20, { px: 15, align: 'center',
            color: C(0x101010), bg: 0xFFE0 });
    }
    if (s.paused) {
        if (E.dirty.unclip) E.dirty.unclip();   // a overlay cobre tambem o HUD
        E.gfx.rect(0, 0, W, H, C(0x05080E), { screen: true });
        drawPanel(E, 60, 150, W - 120, 190, C(0x101A2A), C(0x38BCF8));
        E.gfx.text('PAUSA', W / 2, 186, { px: 32, align: 'center', color: C(0x38BCF8) });
        s.btnResume = E.gfx.button('CONTINUAR', W / 2 - 100, 228, 200, 42,
            { primary: true, screen: true, px: 17 });
        s.btnMapPause = E.gfx.button('MAPA', W / 2 - 70, 282, 140, 34,
            { primary: false, screen: true, px: 14 });
        applyGameClip(s, E);
    }
    if (s.done) {
        if (E.dirty.unclip) E.dirty.unclip();
        E.gfx.rect(0, 0, W, H, C(0x05080E), { screen: true });
        drawPanel(E, 50, 120, W - 100, 250, C(0x101A2A), s.won ? 0xFFE0 : C(0xFF8B8B));
        if (s.won) {
            E.gfx.text('FASE LIMPA!', W / 2, 160, { px: 32, align: 'center', color: C(0x7EE2A8) });
            E.gfx.text(s.score + ' pts  ·  ' + Math.ceil(s.timeLeft) + ' s',
                W / 2, 200, { px: 18, align: 'center', color: C(0xE8EEFC) });
            s.btnNext = E.gfx.button(s.level < 6 ? 'PROXIMA' : 'FINAL', W / 2 - 110, 232, 220, 44,
                { primary: true, screen: true, px: 18 });
            s.btnMapEnd = E.gfx.button('MAPA', W / 2 - 70, 288, 140, 34,
                { primary: false, screen: true, px: 14 });
        } else {
            E.gfx.text('FIM DE JOGO', W / 2, 160, { px: 32, align: 'center', color: C(0xFF8B8B) });
            E.gfx.text('pontos ' + s.score, W / 2, 200,
                { px: 16, align: 'center', color: C(0xE8EEFC) });
            s.btnRetry = E.gfx.button('TENTAR DE NOVO', W / 2 - 130, 232, 260, 42,
                { primary: true, screen: true, px: 16 });
            s.btnMapLost = E.gfx.button('MAPA', W / 2 - 70, 286, 140, 34,
                { primary: false, screen: true, px: 14 });
        }
        applyGameClip(s, E);
    }
}

function hudKey(s) {
    return s.level + '|' + s.levelName + '|' + s.lives + '|' + s.maxBombs +
        '|' + s.range + '|' + (s.shield ? 1 : 0) + '|' + (s.remote ? 1 : 0) +
        '|' + s.score + '|' + Math.ceil(s.timeLeft);
}

// HUD fora da camada suja: o mundo nao o apaga (recorte proprio), entao nao
// usa touches — um full do tabuleiro nao precisa redesenhar a faixa de baixo.
function drawHud(s, E) {
    if (!s.theme || s.paused || s.done) return;
    var key = hudKey(s);
    if (s.hudKey === key && !s.hudForce) return;
    s.hudKey = key;
    s.hudForce = false;
    E.dirty._mute++;
    if (E.dirty.unclip) E.dirty.unclip();
    var W = s.W, th = s.theme;
    E.gfx.rect(0, BOARD_H, W, s.H - BOARD_H, th.hud, { screen: true });
    E.gfx.rect(0, BOARD_H, W, 2, th.accent, { screen: true });
    E.gfx.text('FASE ' + s.level + '  ' + s.levelName, 12, BOARD_H + 8,
        { px: 14, color: th.hudTxt, screen: true });
    E.gfx.text('VIDAS ' + s.lives + '   B ' + s.maxBombs + '/R ' + s.range +
               (s.shield ? '  ESCUDO' : '') + (s.remote ? '  REMOTO' : ''),
        12, BOARD_H + 27, { px: 13, color: th.hudTxt, screen: true });
    E.gfx.text('PONTOS ' + s.score, 380, BOARD_H + 8,
        { px: 14, align: 'right', color: th.hudTxt, screen: true });
    E.gfx.text('TEMPO ' + Math.ceil(s.timeLeft), 380, BOARD_H + 27,
        { px: 13, align: 'right', color: s.timeLeft < 20 ? C(0xFF8B8B) : th.hudTxt,
          screen: true });
    var br = s.btnBomb;
    E.gfx.rect(br.x, br.y, br.w, br.h, C(0x8A2A1A), { r: 10, screen: true });
    E.gfx.text('BOMBA', br.x + br.w / 2, br.y + br.h / 2,
        { px: 15, align: 'center', valign: 'middle', color: 0xFFE0, screen: true });
    var pr = s.btnPause;
    E.gfx.rect(pr.x, pr.y, pr.w, pr.h, C(0x101A2A), { r: 6, screen: true });
    E.gfx.text('II', pr.x + pr.w / 2, pr.y + pr.h / 2,
        { px: 15, align: 'center', valign: 'middle', color: C(0xE8EEFC), screen: true });
    E.dirty._mute--;
    applyGameClip(s, E);
}
