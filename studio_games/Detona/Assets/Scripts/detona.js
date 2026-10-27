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
var OPT_ART = { key: 0xF81F };
var OPT_HUD = { key: 0xF81F, screen: true };
var OPT_BIG = { key: 0xF81F, scale: 3 };
var JOY_RING = { fill: false, screen: true };
var JOY_DOT = { fill: true, screen: true };
var RED_DOT = { fill: true };
var FLAME_BIG = { r: 8 };
var FLAME_SMALL = { r: 6 };

// arte.png: grade 8x6 de 32 px gerada com text2d (animate-set 4 direcoes,
// items, vfx). Os nomes ficam prontos: concatenar por quadro pesa no Duktape
var ART = [];
for (var _a = 0; _a < 48; _a++) ART.push('arte#a' + _a);
var FACE = { down: 0, up: 4, left: 8, right: 12 };
var ENEMY_ART = { slime: 16, ghost: 20, hunter: 24 };
var A_BOMB = 28, A_EXIT = 30, A_STAR = 31;
var ITEM_ART = { range: 32, bomb: 33, speed: 34, remote: 35, shield: 36, life: 37 };
var ITEM_NAME = { range: 'Alcance +1', bomb: 'Bomba +1', speed: 'Velocidade',
                  remote: 'Detonador', shield: 'Escudo', life: 'Vida +1' };
// explosao: faisca -> bola de fogo -> fumaca (quadros 41..45)
var BOOM_SEQ = [41, 42, 42, 42, 43, 44];
var BOSS_ART = ['chefe#c0', 'chefe#c1'];

// paleta do kit de UI: arcade quente sobre o crepusculo do fundo
var UI_THEME = { accent: '#ffb000', accent2: '#ff5a00', onAccent: 0x0000,
                 radius: 14 };

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
function hasArt(E, name) {
    return !!(E.spr && E.spr.has && E.spr.has(name));
}
function uiTheme(E) {
    if (!E.ui) return;
    E.ui.preset('neon');
    E.ui.theme(UI_THEME);
}
// estrelas da fase: as ganhas em ouro, as faltantes em contorno escuro
function drawStars(E, cx, cy, n, r) {
    for (var i = 0; i < 3; i++) {
        var x = cx + (i - 1) * r * 2.4;
        E.gfx.star(x, cy, r, r * 0.45, 5, i < n ? C(0xFFC83C) : C(0x2A3350),
                   { screen: true, fill: true });
    }
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
    s.act = null;
    s.stars = 0;

    if (typeof __harness !== 'undefined') __harness.detona = s;
    uiTheme(E);

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
    s.btnBomb = { x: 392, y: 420, w: 80, h: 54 };
    s.btnPause = { x: 340, y: 422, w: 44, h: 50 };
    s.hudKey = '';
    s.face = 'down';
    s.art = hasArt(E, ART[0]);
    s.boomCols = [0, 0, 0xFFFF];
    s.animT = 0;           // relogio das folhas animadas novas
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

// os widgets do kit de UI decidem no draw (immediate-mode) e deixam a acao
// em s.act; o update do quadro seguinte a executa (troca de cena fora do draw)
function takeAct(s) {
    var a = s.act;
    s.act = null;
    return a;
}

function titleUpdate(s, E) {
    var a = takeAct(s);
    if (s.how) E.redraw();          // modal anima: a cena estatica repinta
    if (a === 'play') {
        E.data.score = 0;
        s.ctx.go('Mapa');
    } else if (a === 'how') {
        s.how = true;
        E.redraw();
    } else if (a === 'howClose') {
        s.how = false;
        E.redraw();
    }
}

function mapUpdate(s, E, ctx) {
    var a = takeAct(s);
    if (a === 'back') { ctx.go('Titulo'); return; }
    if (a === 'locked') {
        if (E.ui) E.ui.toast('Termine a fase anterior', { type: 'warn', icon: 'lock' });
        return;
    }
    if (a) ctx.go(a);
}

function winUpdate(s, E, ctx) {
    var a = takeAct(s);
    if (a === 'again') {
        E.data.score = 0;
        ctx.go('Mapa');
    } else if (a === 'title') {
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
    // vira para o lado pedido mesmo contra a parede (le a intencao)
    s.face = dc < 0 ? 'left' : (dc > 0 ? 'right' : (dr < 0 ? 'up' : 'down'));
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
    if (E.fx) {
        s.boomCols[0] = s.theme.flame;
        s.boomCols[1] = s.theme.flame2;
        E.fx.burst(px, py, { n: 16, colors: s.boomCols, speed: 150, life: 0.45,
                             shape: 'spark' });
        E.fx.ring(px, py, { speed: 260, color: s.theme.flame2 });
    }
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
    // fantasma atravessa caixa: so o fogo da caixa quebrando o pega la dentro
    if (s.map && s.map.get(nc, nr) === 2 && e.data.type !== 'ghost') return false;
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
        if (s.art) {
            if (e.data.type === 'boss') e.spr = BOSS_ART[Math.floor(s.animT * 2) % 2];
            else e.spr = ART[(ENEMY_ART[e.data.type] || 16) + (Math.floor(s.animT * 6 + i) % 4)];
        }
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
    if (s.E.fx) s.E.fx.popText(center(s.gx), center(s.gy) - 10, ITEM_NAME[kind] || kind,
                               { color: 0xFFE0 });
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
    s.stars = stars;
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
    var act = takeAct(s);
    if (s.done || s.lost) {
        if (act === 'next') {
            E.data.score = s.score;
            ctx.go(s.level >= 6 ? 'Vitoria' : 'Fase ' + (s.level + 1));
        } else if (act === 'retry') {
            E.data.score = s.score0;
            ctx.go('Fase ' + s.level);
        } else if (act === 'map') {
            E.data.score = s.won ? s.score : s.score0;
            ctx.go('Mapa');
        }
        return;
    }
    if (s.paused) {
        if (act === 'resume') {
            s.paused = false;
            s.hudForce = true;   // o modal cobriu a faixa do HUD
        } else if (act === 'map') ctx.go('Mapa');
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
    s.animT = (s.animT || 0) + dt;
    if (s.player && s.art) {
        // parado = quadro de contato da direcao; andando = ciclo de 4
        s.player.spr = ART[FACE[s.face] + (s.moving > 0 ? Math.floor(s.animT * 10) % 4 : 0)];
    }
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

// ---------------------------------------------------------------- menus
// o fundo (parallax da fabrica, text2d) e a entidade Fundo da cena; aqui so
// o que fica por cima. Titulo/Mapa/Vitoria sao cenas estaticas: repintam no
// toque (E._btns) ou num E.redraw()

var LOGO_TXT = { px: 72, align: 'center', valign: 'middle', color: 0xFFE0,
                 outline: C(0x3A0A00), screen: true };
var SUB_TXT = { px: 16, align: 'center', valign: 'middle', color: C(0xFFE6B0),
                outline: C(0x1A0A20), screen: true };
var HEAD_TXT = { px: 30, align: 'center', valign: 'middle', color: 0xFFE0,
                 outline: C(0x1A0A20), screen: true };
var BTN_BIG = { variant: 'primary', icon: 'play', ts: 'big' };
var BTN_SEC = { variant: 'secondary', icon: 'info' };
var BTN_BACK = { variant: 'secondary', icon: 'back' };
var BTN_HOME = { variant: 'secondary', icon: 'home' };
var BTN_AGAIN = { variant: 'primary', icon: 'refresh' };
var CARD_T = { px: 18, color: 0xFFE0, screen: true };
var CARD_S = { px: 14, color: C(0xB8C4DC), screen: true };
var LOCK_T = { px: 14, color: C(0x5A6A84), screen: true };
var WORLD_COLOR = [C(0x3DDC84), C(0x3DDC84), C(0xFF7A1A), C(0xFF7A1A),
                   C(0xE040FB), C(0xFF3355)];
var PHASE_NAME = ['Jardim 1', 'Jardim 2', 'Forno 1', 'Forno 2', 'Nucleo', 'Chefe'];
// rosto de cada fase no mapa: o inimigo que manda nela
var PHASE_FACE = [16, 16, 24, 20, 24, -1];
var HOW_BODY = 'Arraste: anda. Toque: bomba. Segure: detona as remotas. ' +
               'Quebre caixas e ache a saida.';
var HOW_BTNS = [{ label: 'Entendi', value: 1, icon: 'check' }];
var BOSS_SMALL = { key: 0xF81F, scale: 0.5 };

function totalStars(E) {
    var n = 0;
    for (var i = 1; i <= 6; i++) n += E.save.num('stars.' + i, 0);
    return n;
}

function drawTitle(s, E) {
    var W = s.W;
    E.gfx.text('DETONA!', W / 2, 74, LOGO_TXT);
    E.gfx.text('3 mundos  ·  ' + totalStars(E) + '/18 estrelas', W / 2, 124, SUB_TXT);
    // elenco em escala 3 (cena estatica: o afim so roda no repaint)
    if (hasArt(E, ART[0])) {
        E.spr.stamp(ART[0], 92, 200, OPT_BIG);
        E.spr.stamp(ART[ITEM_ART.bomb], 388, 204, OPT_BIG);
    }
    var c = E.ui.card(40, 256, W - 80, 200);
    var bx = c.x;
    bx += E.ui.badge('RECORDE ' + s.best, bx, c.y, { color: C(0xFFC83C), textColor: 0x0000 }) + 8;
    E.ui.badge('FASE ' + clamp(s.unlocked, 1, 6) + '/6', bx, c.y);
    if (E.ui.button('JOGAR', c.x, c.y + 40, c.w, 60, BTN_BIG)) s.act = 'play';
    if (E.ui.button('COMO JOGAR', c.x, c.y + 112, c.w, 44, BTN_SEC)) s.act = 'how';
    if (s.how) {
        var r = E.ui.modal('how', { title: 'COMO JOGAR', body: HOW_BODY,
                                    buttons: HOW_BTNS });
        if (r !== null) s.act = 'howClose';
    }
}

function drawMap(s, E) {
    var W = s.W, H = s.H;
    E.gfx.text('ESCOLHA A FASE', W / 2, 34, HEAD_TXT);
    var unlocked = clamp(s.unlocked, 1, 6);
    E.gfx.text(unlocked + '/6 liberadas  ·  ' + totalStars(E) + '/18', W / 2, 70, SUB_TXT);

    var CW = 212, CH = 96, GX = 12, GY = 12;
    var x0 = (W - (CW * 2 + GX)) / 2, y0 = 100;
    for (var n = 1; n <= 6; n++) {
        var col = (n - 1) % 2, row = Math.floor((n - 1) / 2);
        var x = x0 + col * (CW + GX), y = y0 + row * (CH + GY);
        var locked = n > unlocked;
        E.ui.card(x, y, CW, CH, { pad: 0, stroke: locked ? C(0x222B3D) : WORLD_COLOR[n - 1],
                                  bg: locked ? C(0x0C1018) : C(0x141C2C) });
        E.gfx.rect(x + 6, y + 10, 5, CH - 20, locked ? C(0x222B3D) : WORLD_COLOR[n - 1],
                   { r: 2, screen: true });
        E.gfx.text('FASE ' + n, x + 20, y + 12, locked ? LOCK_T : CARD_T);
        E.gfx.text(PHASE_NAME[n - 1], x + 20, y + 38, locked ? LOCK_T : CARD_S);
        if (locked) {
            E.ui.icon('lock', x + CW - 46, y + 30, 32, { color: C(0x5A6A84) });
        } else {
            drawStars(E, x + 52, y + 74, E.save.num('stars.' + n, 0), 9);
            var face = PHASE_FACE[n - 1];
            if (face < 0 && hasArt(E, BOSS_ART[0])) E.spr.stamp(BOSS_ART[0], x + CW - 34, y + 48, BOSS_SMALL);
            else if (face >= 0 && hasArt(E, ART[face])) E.spr.stamp(ART[face], x + CW - 34, y + 48, OPT_ART);
        }
        // o card inteiro e o alvo do toque (registra no E._btns da cena estatica)
        var hit = { x: x, y: y, w: CW, h: CH };
        E._btns.push(hit);
        if (E.input.tap && E.hit(hit)) s.act = locked ? 'locked' : 'Fase ' + n;
    }
    if (E.ui.button('VOLTAR', W / 2 - 90, H - 62, 180, 46, BTN_BACK)) s.act = 'back';
}

function drawWin(s, E) {
    var W = s.W;
    E.gfx.text('VENCEU!', W / 2, 54, LOGO_TXT);
    E.gfx.text('o Rei Slime caiu', W / 2, 104, SUB_TXT);
    if (hasArt(E, ART[0])) E.spr.stamp(ART[0], 120, 196, OPT_BIG);
    if (hasArt(E, BOSS_ART[0])) E.spr.stamp(BOSS_ART[1], 360, 196, OPT_ART);
    var c = E.ui.card(40, 236, W - 80, 232);
    var stars = totalStars(E);
    E.ui.ring(c.x + 52, c.y + 50, 42, stars / 18, { th: 9, label: stars + '/18' });
    E.gfx.text('PONTUACAO', c.x + 116, c.y + 14, CARD_S);
    E.gfx.text('' + s.score, c.x + 116, c.y + 34, { px: 28, color: C(0x7EE2A8), screen: true });
    E.gfx.text('recorde ' + s.best, c.x + 116, c.y + 72, CARD_S);
    if (E.ui.button('JOGAR DE NOVO', c.x, c.y + 100, c.w, 50, BTN_AGAIN)) s.act = 'again';
    if (E.ui.button('TITULO', c.x + c.w / 2 - 90, c.y + 158, 180, 40, BTN_HOME)) s.act = 'title';
}

// ---------------------------------------------------------------- jogo

var END_WIN_BTNS = [{ label: 'Mapa', value: 'map', icon: 'menu' },
                    { label: 'Proxima', value: 'next' }];
var END_LAST_BTNS = [{ label: 'Mapa', value: 'map', icon: 'menu' },
                     { label: 'Final', value: 'next' }];
var END_LOST_BTNS = [{ label: 'Mapa', value: 'map', icon: 'menu' },
                     { label: 'De novo', value: 'retry' }];
var PAUSE_BTNS = [{ label: 'Mapa', value: 'map', icon: 'menu' },
                  { label: 'Continuar', value: 'resume' }];
var BOSS_BAR = { fg: 0xF800, bg: C(0x300808) };
var BOSS_TXT = { px: 11, align: 'center', color: 0xFFE0, outline: 0x0000, screen: true };
var MSG_TXT = { px: 15, align: 'center', color: C(0x101010), bg: 0xFFE0 };
var EXIT_RING = { fill: false };

function drawGame(s, E) {
    var i;
    var th = s.theme;
    var art = s.art;
    // saida aberta e sem inimigos: anel pulsando chama o jogador
    if (s.exitRevealed && !s.done && aliveEnemies(s).length === 0) {
        var pr = 10 + Math.floor(s.animT * 16) % 6;
        E.gfx.circle(center(s.exit[0]), center(s.exit[1]), pr, th.accent, EXIT_RING);
    }
    // bombas: pavio pisca mais rapido perto do estouro (2 quadros, sem afim)
    for (i = 0; i < s.bombs.length; i++) {
        var b = s.bombs[i];
        var bx = center(b.c), by = center(b.r);
        if (art) {
            var blink = Math.floor(s.animT * (b.t < 0.6 ? 14 : 4)) % 2;
            E.spr.stamp(ART[A_BOMB + blink], bx, by, OPT_ART);
        } else {
            E.gfx.circle(bx, by, 11, 0x0000, RED_DOT);
        }
        if (b.t < 0.5) E.gfx.circle(bx, by - 12, 4, 0xF800, RED_DOT);
    }
    // chamas: faisca -> bola de fogo -> fumaca pela idade da celula
    for (i = 0; i < s.flames.length; i++) {
        var f = s.flames[i];
        var x = center(f.c), y = center(f.r);
        if (art) {
            var k = Math.floor((1 - f.t / 0.35) * 6);
            E.spr.stamp(ART[BOOM_SEQ[k < 0 ? 0 : (k > 5 ? 5 : k)]], x, y, OPT_ART);
        } else {
            E.gfx.rect(x - 14, y - 14, 28, 28, th.flame, FLAME_BIG);
            E.gfx.rect(x - 8, y - 8, 16, 16, th.flame2, FLAME_SMALL);
        }
    }
    // itens: icone do pack text2d, quicando 1 px
    for (i = 0; i < s.drops.length; i++) {
        var d = s.drops[i];
        var bob = Math.floor(s.animT * 4 + d.c) % 2;
        if (art) E.spr.stamp(ART[ITEM_ART[d.kind]], center(d.c), center(d.r) - bob, OPT_ART);
        else E.gfx.circle(center(d.c), center(d.r), 9, 0xFFE0, RED_DOT);
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
    // barra do chefe
    var boss = null;
    for (i = 0; i < s.enemies.length; i++) {
        if (s.enemies[i].active !== false && s.enemies[i].data.type === 'boss') boss = s.enemies[i];
    }
    if (boss && E.ui) {
        var maxhp = boss.data.hp || 8;
        var hp = boss.hp === undefined ? maxhp : boss.hp;
        E.ui.progress(140, 8, 200, 12, hp / maxhp, BOSS_BAR);
        E.gfx.text('REI SLIME', 240, 24, BOSS_TXT);
    }
    if (s.msg) E.gfx.text(s.msg, s.W / 2, BOARD_H - 20, MSG_TXT);

    // HUD e botoes: memoizados fora da camada suja
    drawHud(s, E);

    if (s.paused || s.done) {
        if (E.dirty.unclip) E.dirty.unclip();   // o modal cobre tambem o HUD
        var r = null;
        if (s.paused) {
            r = E.ui.modal('pausa', { title: 'PAUSA', body: s.levelName + '  ·  ' +
                                      Math.ceil(s.timeLeft) + ' s restantes',
                                      buttons: PAUSE_BTNS,
                                      // o release do toque que pausou cai fora do card
                                      dismiss: false });
        } else if (s.won) {
            r = E.ui.modal('fim', { title: 'FASE LIMPA!', body: s.score + ' pts  ·  ' +
                                    Math.ceil(s.timeLeft) + ' s de sobra',
                                    contentH: 44, dismiss: false,
                                    buttons: s.level < 6 ? END_WIN_BTNS : END_LAST_BTNS },
                           function (cr) {
                               drawStars(E, cr.x + cr.w / 2, cr.y + 22, s.stars, 16);
                           });
        } else {
            r = E.ui.modal('fim', { title: 'FIM DE JOGO', body: 'pontos ' + s.score,
                                    dismiss: false, buttons: END_LOST_BTNS });
        }
        if (r !== null) s.act = r;
        applyGameClip(s, E);
    }
}

function hudKey(s) {
    return s.level + '|' + s.lives + '|' + s.maxBombs + '|' + s.range + '|' +
        (s.speed > 1 ? 1 : 0) + '|' + (s.shield ? 1 : 0) + '|' + (s.remote ? 1 : 0) +
        '|' + s.score + '|' + Math.ceil(s.timeLeft);
}

var HUD_T = { px: 14, screen: true, color: 0xFFFF };
var HUD_N = { px: 15, screen: true, valign: 'middle', color: 0xFFFF };
var HUD_R = { px: 14, align: 'right', screen: true, color: 0xFFFF };
var BTN_LBL = { px: 11, align: 'center', screen: true, color: 0xFFE0 };

// um icone do pack + numero; devolve o x seguinte
function hudStat(E, x, y, art, text, color) {
    E.spr.stamp(ART[art], x + 16, y, OPT_HUD);
    if (text) {
        HUD_N.color = color;
        E.gfx.text(text, x + 32, y, HUD_N);
        return x + 32 + 10 * text.length + 12;
    }
    return x + 36;
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
    var W = s.W, th = s.theme, y0 = BOARD_H;
    E.gfx.gradient(0, y0, W, s.H - y0, th.hud, C(0x05070C), { screen: true, dir: 'y', step: 8 });
    E.gfx.rect(0, y0, W, 2, th.accent, { screen: true });
    HUD_T.color = th.hudTxt;
    E.gfx.text('FASE ' + s.level + '  ' + s.levelName, 10, y0 + 7, HUD_T);
    HUD_R.color = th.hudTxt;
    E.gfx.text(s.score + ' pts', 330, y0 + 7, HUD_R);
    HUD_R.color = s.timeLeft < 20 ? C(0xFF8B8B) : th.hudTxt;
    E.gfx.text(Math.ceil(s.timeLeft) + ' s', 236, y0 + 7, HUD_R);
    E.ui.icon('clock', 168, y0 + 6, 16, { color: HUD_R.color });
    var cy = y0 + 46, x = 4;
    if (s.art) {
        x = hudStat(E, x, cy, ITEM_ART.life, 'x' + s.lives, C(0xFF8B8B));
        x = hudStat(E, x, cy, ITEM_ART.bomb, '' + s.maxBombs, th.hudTxt);
        x = hudStat(E, x, cy, ITEM_ART.range, '' + s.range, th.hudTxt);
        if (s.speed > 1) x = hudStat(E, x, cy, ITEM_ART.speed, '', 0);
        if (s.shield) x = hudStat(E, x, cy, ITEM_ART.shield, '', 0);
        if (s.remote) x = hudStat(E, x, cy, ITEM_ART.remote, '', 0);
    } else {
        HUD_T.color = th.hudTxt;
        E.gfx.text('VIDAS ' + s.lives + '   B ' + s.maxBombs + '/R ' + s.range,
                   10, cy - 8, HUD_T);
    }
    // pausa e bomba: o toque e por press (inRect no update), aqui so a arte
    var pr = s.btnPause;
    E.gfx.rect(pr.x, pr.y, pr.w, pr.h, C(0x101A2A), { r: 10, screen: true, bw: 2,
                                                     stroke: th.accent });
    E.ui.icon('pause', pr.x + 10, pr.y + 13, 24, { color: C(0xE8EEFC) });
    var br = s.btnBomb;
    E.gfx.rect(br.x, br.y, br.w, br.h, C(0x8A2A1A), { r: 12, screen: true, bw: 2,
                                                     stroke: C(0xFFB000) });
    if (s.art) E.spr.stamp(ART[A_BOMB], br.x + br.w / 2, br.y + 20, OPT_HUD);
    E.gfx.text(s.remote ? 'BOMBA*' : 'BOMBA', br.x + br.w / 2, br.y + 38, BTN_LBL);
    E.dirty._mute--;
    applyGameClip(s, E);
}
