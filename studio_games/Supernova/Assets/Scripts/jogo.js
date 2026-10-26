// jogo.js — simulacao do combate do Supernova sobre a game engine do SDK.
// 2.6: o diretor E.waves cuida das ondas (lista por onda, spawn/alive e
// endless escalando, com o chefe a cada 5), a IA dos inimigos usa E.steer
// (seek/pursue/separate/within), os tiros/hitboxes/blast/dano passam pelo
// E.combat (corpos por time com hp proprio) e as fases do chefe
// (entrada/rajadas/enrage/morte) sao uma maquina E.fsm. Os projeteis nao
// vivem mais em pools proprios: o combat resolve tiro x corpo no hash
// espacial dele, e a supernova e um blast (o chefe apanha 15, nao morre).
// A trilha continua sendo o metronomo: cada cruzamento de batida manda a
// rajada para o estado do chefe. Coordenadas em PIXELS FISICOS (canvas
// nativo); medidas e velocidades nasceram no 480 e escalam por
// K = E.U / 2 (1 no SmartDisplay, ~0,85 no relogio de 410).

var E = require("celeros.game");
require("celeros.game.fx");
require("celeros.game.waves");
require("celeros.game.steer");
require("celeros.game.combat");
require("celeros.game.fsm");

// shooter de tiro rapido: o hitstop padrao do combat (45 ms por acerto)
// engasgaria o voo; o dano continua resolvido no tick do modulo
E.combat.hitstop = 0;

// paleta do jogo (preto puro e a cor-chave dos sprites)
var CIANO = 0x07FF, CIANOD = 0x03EF, MAGENTA = 0xF81F, LARANJA = 0xFD20,
    OURO = 0xFFE0, BRANCO = 0xFFFF, VERDE = 0x07E0;

var BPM = 132;

// Sons na tabela do core (E.audio.sfxTable): os eventos chamam
// E.audio.sfx pelo NOME. As entradas padrao shot/hit/boom/power/record
// sao revistas para o jogo; as outras sao chaves proprias na mesma
// tabela. Firmware com mistura (API 32) toca por cima da trilha; no
// antigo um efeito por vez rouba o canal — a supernova usa E.audio.duck
// para a trilha voltar do ponto onde parou.
var SND = E.audio.sfxTable;
SND.shot = [[1500, 16], [1050, 20]];            // tiro da nave
SND.hit = [[900, 18], [620, 26]];               // bala acerta, inimigo vivo
SND.boom = [[190, 45], [120, 85], [70, 130]];   // explosao grande
SND.power = [[784, 35], [988, 35], [1319, 80]]; // orbe de carga
SND.record = [[659, 60], [784, 60], [988, 60], [1319, 180]];
SND.pop = [[880, 18], [520, 30]];
SND.dano = [[300, 60], [180, 90], [120, 120]];
SND.alerta = [[660, 90], [0, 40], [660, 90], [0, 40], [880, 160]];
SND.chefe = [[523, 70], [659, 70], [784, 70], [1047, 220]];
SND.supernova = [[90, 60], [140, 60], [220, 60], [330, 80], [494, 90], [740, 120], [1109, 220]];

// Lá menor, 2 compassos de loop (bumbo/caixa/chimbal GM, baixo triangular,
// melodia quadrada e arpejo sq25 no contratempo).
var SONG = {
    bpm: BPM,
    loops: 8,
    tracks: [
        { drum: true, vol: 100, notes: [
            [36, 2], [42, 1], [42, 1], [38, 2], [42, 1], [42, 1],
            [36, 1], [36, 1], [42, 1], [42, 1], [38, 2], [42, 2],
            [36, 2], [42, 1], [42, 1], [38, 2], [36, 1], [36, 1],
            [42, 1], [42, 1], [38, 1], [38, 1], [42, 1], [42, 1], [42, 2]
        ] },
        { wave: "tri", vol: 92, notes: [
            [45, 2], [45, 2], [57, 2], [45, 2], [45, 2], [57, 2], [45, 2], [45, 2],
            [41, 2], [41, 2], [53, 2], [41, 2], [41, 2], [53, 2], [41, 2], [41, 2],
            [43, 2], [43, 2], [55, 2], [43, 2], [43, 2], [55, 2], [43, 2], [43, 2],
            [45, 2], [45, 2], [57, 2], [45, 2], [45, 2], [57, 2], [45, 2], [45, 2]
        ] },
        { wave: "sq", vol: 68, notes: [
            [69, 2], [0, 2], [72, 2], [0, 2], [76, 4], [74, 4],
            [72, 2], [0, 2], [69, 2], [0, 2], [71, 4], [69, 4],
            [72, 2], [0, 2], [76, 2], [0, 2], [79, 4], [77, 4],
            [76, 2], [74, 2], [72, 2], [71, 2], [69, 6], [0, 2]
        ] },
        { wave: "sq25", vol: 42, notes: [
            [57, 1], [60, 1], [64, 1], [60, 1], [57, 1], [64, 1], [60, 1], [64, 1],
            [53, 1], [57, 1], [60, 1], [57, 1], [53, 1], [60, 1], [57, 1], [60, 1],
            [55, 1], [59, 1], [62, 1], [59, 1], [55, 1], [62, 1], [59, 1], [62, 1],
            [57, 1], [60, 1], [64, 1], [60, 1], [57, 1], [64, 1], [60, 1], [64, 1]
        ] }
    ]
};

var W = 0, H = 0, U = 2, K = 1, HUD_H = 64, HIT_R = 14;
var S = null;
var lastBeatInt = -1;
var superBlast = false;   // blast da supernova no ar (abate nao pontua 2x)

// Contêiner simples de corpos (mesma forma de sempre: world.all alimenta o
// desenho, o sweep e o blast). O combat indexa os corpos que registra.
var world = { all: [] };

// lista REUSADA do separate dos agentes (so inimigos; o array nunca e
// recriado no hot path)
var _foes = [];

// fora da arena o tiro morre: o map do combat checa 1 ponto por tick
var SHOT_MAP = { solidAt: function (x, y) {
    return x < -20 * K || x > W + 20 * K || y < HUD_H - 24 * K || y > H + 20 * K;
} };

// within: mantem o inimigo na largura da arena e abaixo do HUD; a altura
// estendida deixa o inimigo sair pelo rodape (o cull do sweep pega)
var STEER_ARENA = { x: 0, y: 0, w: 0, h: 0 };

// Ondas: cada entrada e uma onda; o endless repete a ultima crescendo.
// A cada 5 ondas o onWave troca o conteudo pelo SENTINELA-MOR: o spawn
// ignora os tipos da onda de chefe (o chefe ja nasceu) e o alive() so
// fecha a onda quando ele cai. every em ms (132 BPM = 454 ms por batida).
var WAVES = [
    { groups: [{ type: "drone", n: 4, every: 850 }], rest: 1700 },
    { groups: [{ type: "drone", n: 4, every: 700 },
               { type: "sentinel", n: 1, every: 0, delay: 1200 }], rest: 1700 },
    { groups: [{ type: "splitter", n: 2, every: 1100 },
               { type: "drone", n: 3, every: 800, delay: 500 }], rest: 1900 },
    { groups: [{ type: "sentinel", n: 2, every: 1400 },
               { type: "drone", n: 5, every: 650, delay: 700 }], rest: 2200 }
];

var _bview = { pbn: 0, ebn: 0 };

function addBody(b) {
    world.all.push(b);
    return b;
}

function removeAt(i) {
    var a = world.all, b = a[i];
    b.dead = true;      // o combat solta o corpo no proximo tick
    a[i] = a[a.length - 1];
    a.pop();
}

function clampX(x) {
    var m = 30 * K;
    return x < m ? m : (x > W - m ? W - m : x);
}

function reset() {
    // o diretor de ondas e GLOBAL (sobrevive ao goto da pausa): sem parar
    // o antigo, o restart do menu deixaria dois diretores nascendo inimigo
    if (S && S.waves) S.waves.stop();
    W = E.W;
    H = E.H;
    U = E.U;
    K = U / 2;
    HUD_H = Math.round(32 * U);
    HIT_R = 14 * K;
    world = { all: [] };
    _foes.length = 0;
    E.combat.clear();
    STEER_ARENA.x = 0;
    STEER_ARENA.y = HUD_H + 1;
    STEER_ARENA.w = W;
    STEER_ARENA.h = H - HUD_H + 200 * K;
    S = {
        t: 0, world: world, player: null,
        score: 0, kills: 0, lives: 3, charge: 0,
        streak: 0, streakT: 0, mult: 1, multPulse: 0,
        wave: 0, intensity: 0,
        boss: null, bossAlt: 0, triple: 0,
        over: false, overT: 0, waves: null
    };
    var p = addBody({ cat: 'player', x: W / 2, y: H * 0.8, r: 24 * K });
    p.cool = 0;
    p.invuln = 1.2;
    S.player = p;
    // o corpo do jogador usa o NUCLEO de graze (14 px de projeto, nao a
    // borda de 24): desviar de tiro continua possivel
    E.combat.body(p, {
        team: "player",
        ox: -HIT_R, oy: -HIT_R, w: HIT_R * 2, h: HIT_R * 2,
        iframes: 0,
        immune: function () { return S.over || p.invuln > 0; },
        onHit: function () { hitPlayer(); }
    });
    // diretor GLOBAL (sobrevive ao goto da pausa; o E.pause congela o tick
    // dos modulos e o reset troca o diretor por um novo)
    S.waves = E.waves(WAVES, {
        global: true,
        delay: 900,
        rest: 1800,
        spawn: waveSpawn,
        alive: aliveEnemies,
        onWave: onWave,
        endless: { grow: 1.16 }
    });
    lastBeatInt = -1;
    superBlast = false;
}

function state() { return S; }

function count(cat) {
    var n = 0, all = world.all;
    for (var i = 0; i < all.length; i++) if (all[i].cat === cat) n++;
    return n;
}

function aliveEnemies() { return count('enemy'); }

function movePlayer(dx) {
    S.player.x = clampX(S.player.x + dx);
}

// ------------------------------------------------------------- ondas ----

function waveSpawn(type, w, i) {
    // onda de chefe: o conteudo e o SENTINELA-MOR (nasceu no onWave)
    if (w.wave % 5 === 0) return;
    if (type === "drone") spawnDrone();
    else if (type === "sentinel") spawnSentinel();
    else if (type === "splitter") spawnSplitter();
}

function onWave(w, n) {
    S.wave = n;
    if (n % 5 === 0) {
        spawnBoss();
    } else if (n > 1) {
        E.fx.popText(W / 2, H * 0.3, "ONDA " + n, { color: CIANO, life: 1.0, ts: 'small' });
    }
}

// ------------------------------------------------------------- spawns ---

// corpo de inimigo unico: hp no proprio ent (o combat usa ent.hp quando o
// corpo nao tem stats), hitbox 2r x 2r e callbacks de dano/abate
function foe(kind, x, y, r, hp) {
    var e = addBody({ cat: 'enemy', kind: kind, x: x, y: y, r: r,
                      hp: hp, hpMax: hp, flashT: 0,
                      ph: Math.random() * Math.PI * 2 });
    E.combat.body(e, {
        team: "foe",
        ox: -r, oy: -r, w: r * 2, h: r * 2,
        iframes: 0,
        onHit: function (ent) { ent.flashT = 0.09; E.audio.sfx("hit"); },
        onKill: foeKilled
    });
    return e;
}

function foeKilled(ent) {
    // supernova: o blast pontua no onHit do hitbox; o abate nao roda o
    // killEnemy (sem combo/carga e sem minis do splitter)
    if (superBlast) ent.noScore = true;
    if (ent.kind === 2 && !superBlast) {
        ent.dying = true;
        killEnemy(ent);         // pontos/combo/bossDown
        if (ent.fsm) ent.fsm.go("morte");
    } else {
        ent.killed = true;
    }
}

function spawnDrone(x) {
    var e = foe(0, x === undefined ? clampX(60 * K + Math.random() * (W - 120 * K)) : clampX(x),
                -40 * K, 20 * K, 1);
    e.x0 = e.x;
    e.tx = e.x;
    e.cool = 1.4 + Math.random() * 2.2;
    e.a = E.steer.agent(e, { speed: (58 + S.intensity * 6) * K,
                             force: (190 + S.intensity * 12) * K, agility: 5 });
    e.upd = updDrone;
    return e;
}

function spawnSentinel() {
    var e = foe(1, clampX(70 * K + Math.random() * (W - 140 * K)), -50 * K, 20 * K,
                3 + Math.floor(S.intensity / 3));
    e.cool = 1.1 + Math.random();
    e.a = E.steer.agent(e, { speed: (54 + S.intensity * 4) * K,
                             force: (170 + S.intensity * 10) * K, agility: 4.5 });
    e.upd = updSentinel;
    return e;
}

// splitter: desce rapido em senoide apertada e se divide em 2 minis
function spawnSplitter() {
    var e = foe(3, clampX(60 * K + Math.random() * (W - 120 * K)), -40 * K, 20 * K, 2);
    e.x0 = e.x;
    e.a = E.steer.agent(e, { speed: (100 + S.intensity * 8) * K,
                             force: (260 + S.intensity * 14) * K, agility: 5 });
    e.upd = updSplitter;
    return e;
}

function spawnMini(x, ph) {
    var e = foe(4, clampX(x), -20 * K, 12 * K, 1);
    e.x0 = e.x;
    e.ph = ph;
    e.a = E.steer.agent(e, { speed: (165 + S.intensity * 10) * K,
                             force: 420 * K, agility: 6 });
    e.upd = updMini;
    return e;
}

function spawnMinis(e) {
    spawnMini(e.x - 22 * K, e.ph);
    spawnMini(e.x + 22 * K, e.ph + 1.5);
}

function spawnOrb(x) {
    var o = addBody({
        cat: 'orb',
        x: x === undefined ? 50 * K + Math.random() * (W - 100 * K) : clampX(x),
        y: -30 * K, r: 16 * K, ph: 0
    });
    o.upd = updOrb;
}

function spawnBoss() {
    var hp = 26 + S.wave * 3;
    var b = foe(2, W / 2, -90 * K, 46 * K, hp);
    b.upd = updBoss;
    b.fsm = makeBossFsm(b);
    S.boss = b;
    E.fx.popText(W / 2, H * 0.3, "SENTINELA-MOR", { color: MAGENTA, life: 1.6, ts: 'big' });
    E.audio.sfx("alerta");
    return b;
}

// ------------------------------------------------------ roteiro/movimento ---

function updDrone(e, dt) {
    var p = S.player, a = e.a;
    a.speed = (58 + S.intensity * 6) * K;   // a dificuldade acompanha o tempo
    e.tx = e.x0 + Math.sin(S.t * 2.2 + e.ph) * 40 * K;
    a.pursue(p, 0.35);
    a.seek(e.tx, H + 140 * K, 0.8);
    a.separate(_foes, 44 * K, 1.2);
    a.within(STEER_ARENA, 16 * K, 0.6);
    a.update(dt);
    e.cool -= dt;
    if (e.cool <= 0 && e.y > 30 * K && e.y < H * 0.7) {
        e.cool = 2.6 + Math.random() * 2.5 - S.intensity * 0.12;
        E.combat.shot(e, {
            x: e.x, y: e.y + 22 * K, vx: (p.x - e.x) * 0.22,
            vy: (150 + S.intensity * 8) * K, r: 4 * K, dmg: 1,
            team: "foe", life: 2600, map: SHOT_MAP
        });
    }
}

function updSentinel(e, dt) {
    var p = S.player, a = e.a;
    a.speed = (54 + S.intensity * 4) * K;
    a.pursue(p, 0.55);
    a.within(STEER_ARENA, 22 * K, 1.0);
    a.separate(_foes, 50 * K, 1.0);
    a.update(dt);
    e.cool -= dt;
    if (e.cool <= 0 && e.y > 20 * K) {
        e.cool = 1.7 + Math.random() * 1.2 - S.intensity * 0.08;
        var dx = p.x - e.x, dy = p.y - e.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 1;
        var sp = (205 + S.intensity * 10) * K;
        E.combat.shot(e, {
            x: e.x, y: e.y + 16 * K, vx: dx / d * sp, vy: dy / d * sp,
            r: 4 * K, dmg: 1, team: "foe", life: 2600, map: SHOT_MAP
        });
    }
}

function updSplitter(e, dt) {
    var a = e.a;
    a.speed = (100 + S.intensity * 8) * K;
    a.seek(e.x0 + Math.sin(S.t * 4 + e.ph) * 70 * K, H + 120 * K, 1);
    a.separate(_foes, 40 * K, 1.0);
    a.within(STEER_ARENA, 12 * K, 0.5);
    a.update(dt);
}

function updMini(e, dt) {
    var a = e.a;
    a.speed = (165 + S.intensity * 10) * K;
    a.seek(e.x0, H + 140 * K, 1);
    a.update(dt);
}

function updOrb(o, dt) {
    o.y += 64 * K * dt;
    o.ph += dt * 5;
}

// chefe: a maquina de fases anda no update do corpo
function updBoss(e, dt) {
    if (e.fsm) e.fsm.update(dt);
}

function makeBossFsm(b) {
    var y0 = H * 0.23;
    return E.fsm(b, {
        entrada: {
            update: function (m, dt) {
                if (b.y < y0) b.y += 40 * K * dt;
                else m.go("rajadas");
            }
        },
        rajadas: {
            update: function (m, dt) {
                b.x = W / 2 + Math.sin(S.t * 0.55) * (W * 0.3);
                // sem musica (beat -1) o proprio estado marca o compasso
                if (E.audio.beat() < 0) {
                    m.data.alt = (m.data.alt || 0) + dt;
                    if (m.data.alt >= 0.9) { m.data.alt = 0; bossBurst(b); }
                }
                if (b.hp <= b.hpMax / 2) m.go("enrage");
            },
            on: { rajada: function (m) { bossBurst(b); } }
        },
        enrage: {
            enter: function (m) { E.audio.sfx("alerta"); },
            update: function (m, dt) {
                b.x = W / 2 + Math.sin(S.t * 0.9) * (W * 0.3);
                b.y = y0 + Math.sin(S.t * 1.3) * 14 * K;
                if (E.audio.beat() < 0) {
                    m.data.alt = (m.data.alt || 0) + dt;
                    if (m.data.alt >= 0.7) { m.data.alt = 0; bossBurst(b); }
                }
            },
            on: { rajada: function (m) { bossBurst(b); } }
        },
        morte: {
            enter: function (m) {
                m.data.t = 0;
                E.fx.flash(MAGENTA, 300);
                E.fx.ring(b.x, b.y, { color: MAGENTA, speed: 600 * K, life: 0.7, r0: 16 * K });
            },
            update: function (m, dt) {
                m.data.t += dt;
                b.flashT = 0.15;
                if (m.data.t < 0.8) {
                    var n = Math.floor(m.data.t / 0.17);
                    if (n !== m.data.last) {
                        m.data.last = n;
                        E.fx.burst(b.x + (Math.random() - 0.5) * 60 * K,
                                   b.y + (Math.random() - 0.5) * 60 * K,
                                   { n: 10, color: MAGENTA, speed: 160 * K, life: 0.5 });
                        E.cam.shake(3 * K, 0.12);
                    }
                }
                if (m.data.t >= 0.85) b.dead = true;
            }
        }
    }, "entrada");
}

// ------------------------------------------------------------- tiros ---

// anel do chefe com CLAURO DE FUGA de 2 slots (~50-70 graus) centrado em
// gapA: sempre ha um caminho legivel
function fireRing(owner, x, y, sp, n, gapA) {
    var step = Math.PI * 2 / (n + 2);
    var arc = Math.PI * 2 - 2 * step;
    for (var i = 0; i < n; i++) {
        var a = gapA + step + arc * i / (n - 1);
        E.combat.shot(owner, {
            x: x + Math.cos(a) * 44 * K, y: y + Math.sin(a) * 44 * K,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: 4 * K, dmg: 1,
            team: "foe", life: 2600, map: SHOT_MAP
        });
    }
}

// rajada do chefe, sincronizada na batida: alterna anel com clauro (virado
// para o lado da nave) e leque mirado de 3
function bossBurst(b) {
    if (!b || b.dying || b.y < 60 * K) return;
    var fast = b.hp < b.hpMax / 2;
    E.fx.ring(b.x, b.y, { color: MAGENTA, speed: 500 * K, life: 0.4 });
    if (S.bossAlt++ % 2 === 1) {
        var base = Math.atan2(S.player.y - b.y, S.player.x - b.x);
        var fs = 230 * K;
        for (var f = -1; f <= 1; f++) {
            var fa = base + f * 0.22;
            E.combat.shot(b, {
                x: b.x, y: b.y + 40 * K, vx: Math.cos(fa) * fs, vy: Math.sin(fa) * fs,
                r: 4 * K, dmg: 1, team: "foe", life: 2600, map: SHOT_MAP
            });
        }
    } else {
        var sp = (110 + S.intensity * 6 + (fast ? 25 : 0)) * K;
        var gap = Math.atan2(S.player.y - b.y, S.player.x - b.x) + (Math.random() - 0.5) * 0.6;
        fireRing(b, b.x, b.y, sp, fast ? 12 : 8, gap);
    }
}

// ------------------------------------------------------------- coleta ---

// colheita do orbe pela nave
function pickupOrb(o) {
    o.dead = true;
    S.charge = Math.min(100, S.charge + 25);
    S.score += 15;
    E.fx.ring(o.x, o.y, { color: OURO, speed: 300 * K, life: 0.5 });
    E.fx.popText(o.x, o.y - 14 * K, "+CARGA", { color: OURO, ts: 'small' });
    E.audio.sfx("power");
}

// ----------------------------------------------------------- simulacao ---

function update(dt) {
    var s = S, i, all;
    if (s.over) {
        s.overT += dt;
        return;
    }
    s.t += dt;
    s.intensity = Math.min(10, s.t / 14);
    if (s.triple > 0) s.triple -= dt;
    if (s.multPulse > 0) s.multPulse -= dt;
    // o blast da supernova e resolvido no tick do combat DESTE quadro (que
    // roda antes do update): agora pode baixar
    if (superBlast) superBlast = false;

    // lista reusada do separate (so inimigos, sem orbes/jogador)
    all = world.all;
    _foes.length = 0;
    for (i = 0; i < all.length; i++) if (all[i].cat === 'enemy') _foes.push(all[i]);

    // diretor: a rajada do chefe cai na batida (o fsm decide se a fase atira)
    var beatF = E.audio.beat();
    if (beatF >= 0) {
        var bi = Math.floor(beatF);
        if (bi !== lastBeatInt) {
            lastBeatInt = bi;
            if (s.boss && s.boss.fsm && !s.boss.dying) s.boss.fsm.send("rajada");
        }
    }

    // orbe de alivio (nao e inimigo: fica fora do diretor de ondas)
    if (Math.random() < dt / 10) spawnOrb();

    // nave: tiro duplo (triplo com o premio do chefe)
    var p = s.player;
    p.cool -= dt;
    if (p.invuln > 0) p.invuln -= dt;
    if (p.cool <= 0) {
        p.cool = 0.16;
        E.combat.shot(p, {
            x: p.x - 14 * K, y: p.y - 26 * K, vx: 0, vy: -620 * K,
            r: 5 * K, dmg: 1, team: "player", life: 1400, map: SHOT_MAP
        });
        E.combat.shot(p, {
            x: p.x + 14 * K, y: p.y - 26 * K, vx: 0, vy: -620 * K,
            r: 5 * K, dmg: 1, team: "player", life: 1400, map: SHOT_MAP
        });
        if (s.triple > 0) {
            E.combat.shot(p, {
                x: p.x, y: p.y - 30 * K, vx: -130 * K, vy: -600 * K,
                r: 5 * K, dmg: 1, team: "player", life: 1400, map: SHOT_MAP
            });
            E.combat.shot(p, {
                x: p.x, y: p.y - 30 * K, vx: 130 * K, vy: -600 * K,
                r: 5 * K, dmg: 1, team: "player", life: 1400, map: SHOT_MAP
            });
        }
        E.audio.sfx("shot");
    }

    // roteia os corpos: ram de inimigo (hitbox curta do combat) e orbe
    for (i = 0; i < all.length; i++) {
        var b = all[i];
        if (b.flashT > 0) b.flashT -= dt;
        if (b.upd && !b.dead && !b.killed && (!b.dying || b.kind === 2)) b.upd(b, dt);
        if (b.cat !== 'player' && !b.dead && !b.killed && !b.dying && !s.over) {
            var dx = b.x - p.x, dy = b.y - p.y, rr = b.r + p.r;
            if (dx * dx + dy * dy <= rr * rr) {
                if (b.cat === 'orb') pickupOrb(b);
                else if (b.cat === 'enemy' && p.invuln <= 0) {
                    // o ram passa pelo combat: hitbox de 1 tick no corpo do
                    // inimigo; a pancada explode o corpo (o chefe nao morre)
                    E.combat.hit(b, { x: b.x, y: b.y, r: b.r + 6 * K },
                                 { dmg: 1, team: "foe", ms: 1, stop: 0 });
                    if (b.kind !== 2) {
                        b.dead = true;
                        E.fx.burst(b.x, b.y, { n: 12, color: LARANJA, speed: 120 * K, life: 0.5 });
                    }
                }
            }
        }
    }
    sweep();

    if (s.streakT > 0) {
        s.streakT -= dt;
        if (s.streakT <= 0 && s.streak > 0) {
            s.streak = 0;
            s.mult = 1;
        }
    }
}

// varre os corpos: mortos, marcados como abate e fora da tela. O chefe em
// morte (fsm) fica ate a animacao terminar; o que o blast da supernova
// matou (noScore) sai sem rodar o killEnemy (o onHit do blast ja pontuou)
function sweep() {
    var all = world.all;
    for (var i = all.length - 1; i >= 0; i--) {
        var b = all[i];
        if (b.cat === 'orb') {
            if (b.dead || b.y > H + 30 * K) removeAt(i);
        } else if (b.cat === 'enemy') {
            if (b.killed) {
                if (b.noScore) {
                    if (b.kind === 2) bossDown(b);
                    removeAt(i);
                } else {
                    killEnemy(b);
                    removeAt(i);
                }
            } else if (b.dead) {
                if (!b.dying) explosionFx(b);
                removeAt(i);
            } else if (b.y > H + 60 * K) {
                removeAt(i);
            }
        }
    }
}

function explosionFx(e) {
    var big = e.kind === 1 || e.kind === 2 || e.kind === 3;
    var col = (e.kind === 1 || e.kind === 2) ? MAGENTA : (e.kind === 3 ? OURO : LARANJA);
    E.fx.burst(e.x, e.y, { n: big ? 22 : 12, color: col, speed: (big ? 170 : 120) * K, life: 0.6 });
    E.fx.burst(e.x, e.y, { n: big ? 8 : 4, color: BRANCO, speed: 90 * K, life: 0.35, size: 1 });
    E.fx.ring(e.x, e.y, { color: col, speed: (big ? 420 : 260) * K, life: 0.5 });
    // tremor so em evento grande: drone comum abatido em serie sacudia a
    // tela o tempo todo (a "vibracao" que o player sentia)
    if (big) E.cam.shake(4 * K, 0.25);
    E.audio.sfx(big ? "boom" : "pop");
}

function killEnemy(e) {
    var s = S;
    var pts = e.kind === 2 ? 300 : (e.kind === 1 ? 30 : (e.kind === 3 ? 20 : (e.kind === 4 ? 5 : 10)));
    s.streak++;
    s.streakT = 2.2;
    s.kills++;
    var m = 1 + Math.min(4, Math.floor(s.streak / 8));
    if (m > s.mult) {
        s.mult = m;
        s.multPulse = 1.2;
        E.fx.popText(s.player.x, s.player.y - 50 * K, "COMBO x" + m, { color: OURO, life: 1.1, ts: 'big' });
    }
    var tot = pts * s.mult;
    s.score += tot;
    if (e.kind !== 4) {
        s.charge = Math.min(100, s.charge + (e.kind === 2 ? 40 : (e.kind === 1 ? 7 : 3)));
    }
    explosionFx(e);
    E.fx.popText(e.x, e.y - 10 * K, "+" + tot, { color: e.kind === 1 ? MAGENTA : OURO, ts: 'small' });
    if (e.kind === 3) spawnMinis(e);
    if (e.kind === 2) bossDown(e);
}

function bossDown(e) {
    var s = S;
    s.boss = null;
    s.triple = 10;
    E.fx.flash(MAGENTA, 350);
    E.fx.ring(e.x, e.y, { color: MAGENTA, speed: 700 * K, life: 0.7, r0: 20 * K });
    E.cam.shake(7 * K, 0.4);
    spawnOrb(e.x - 50 * K);
    spawnOrb(e.x + 50 * K);
    E.fx.popText(W / 2, H * 0.4, "CHEFE AO CHAO!", { color: MAGENTA, life: 1.4, ts: 'big' });
    E.fx.popText(W / 2, H * 0.4 + 30 * K, "TIRO TRIPLO", { color: VERDE, life: 1.4, ts: 'label' });
    E.audio.sfx("chefe");
}

function hitPlayer() {
    var s = S, p = s.player;
    s.lives--;
    s.streak = 0;
    s.mult = 1;
    E.fx.burst(p.x, p.y, { n: 26, color: CIANO, speed: 170 * K, life: 0.8 });
    E.fx.ring(p.x, p.y, { color: CIANO, speed: 420 * K, life: 0.55 });
    E.fx.flash(0xF800, 260);
    E.cam.shake(6 * K, 0.35);
    if (s.lives <= 0) {
        s.over = true;
        s.overT = 0;
        if (s.waves) s.waves.stop();
        E.audio.stop();
        E.audio.sfx("over");
    } else {
        // a trilha segue (sfx misturado): perder vida nao corta a musica
        p.invuln = 2.2;
        E.audio.sfx("dano");
    }
}

// detonacao da SUPERNOVA: um blast do combat limpa a tela (o chefe apanha
// 15 em vez de morrer), os tiros inimigos somem e o abate nao roda o combo
// (o onHit do blast pontua por cabeca); a trilha volta depois
function detonate() {
    var s = S;
    if (s.over || s.charge < 100) return false;
    superBlast = true;
    E.combat.blast(s.player.x, s.player.y - 20 * K, Math.max(W, H), {
        team: "player", dmg: 15, knock: 0, stop: 0, ms: 60,
        onHit: function (alvo) {
            if (alvo.cat !== 'enemy' || alvo.dying) return;
            alvo.flashT = 0.3;
            if (alvo.kind === 2) {
                s.score += 60;
            } else {
                s.score += alvo.kind === 1 ? 45 : 15;
                E.fx.burst(alvo.x, alvo.y, { n: 14, color: OURO, speed: 150 * K, life: 0.6 });
            }
        }
    });
    // os tiros inimigos somem inteiros (o combat compacta no proximo tick)
    var sh = E.combat.shots();
    for (var i = 0; i < sh.length; i++) if (sh[i].team === "foe") sh[i].dead = true;
    s.score += 60;
    s.charge = 0;
    E.fx.burst(s.player.x, s.player.y - 30 * K, { n: 40, color: OURO, speed: 300 * K, life: 0.9 });
    E.fx.burst(s.player.x, s.player.y - 30 * K, { n: 24, color: BRANCO, speed: 180 * K, life: 0.6 });
    E.fx.ring(s.player.x, s.player.y - 30 * K, { color: OURO, speed: 700 * K, life: 0.7, r0: 10 * K });
    E.fx.ring(s.player.x, s.player.y - 30 * K, { color: CIANO, speed: 520 * K, life: 0.7, r0: 10 * K });
    // o evento maior do jogo: este sim e flash de tela cheia
    E.fx.flash(BRANCO, 420, { full: true });
    E.cam.shake(8 * K, 0.45);
    E.fx.popText(W / 2, H / 2 - 30 * K, "SUPERNOVA!", { color: OURO, life: 1.4, ts: 'big' });
    if (E.caps.mix) {
        E.audio.sfx("supernova");     // por cima da trilha
    } else {
        // firmware velho, canal unico: o duck para a trilha, deixa o
        // estrondo soar na janela e a retoma do MESMO ponto
        E.audio.duck(1700);
        E.audio.sfx("supernova");
    }
    return true;
}

function startMusic() {
    E.audio.music(SONG);
}

// visao dos tiros para o desenho (mesmo array do combat, sem copia)
function shots() { return E.combat.shots(); }

// contagem por time para o teste — objeto reaproveitado
function bullets() {
    var sh = E.combat.shots(), pn = 0, en = 0;
    for (var i = 0; i < sh.length; i++) {
        if (sh[i].dead) continue;
        if (sh[i].team === "player") pn++;
        else en++;
    }
    _bview.pbn = pn;
    _bview.ebn = en;
    return _bview;
}

// testes deterministas (harness): tiro inimigo em cima da nave e anel do
// chefe em ponto dado
function debugHit() {
    var p = S.player;
    E.combat.shot(null, {
        x: p.x, y: p.y, vx: 0, vy: 120, r: 4 * K, dmg: 1,
        team: "foe", life: 2000, map: SHOT_MAP
    });
}

function debugRing(x, y) {
    fireRing(null, x, y, 150 * K, 12, -Math.PI / 2);
}

module.exports = {
    reset: reset, update: update, detonate: detonate,
    state: state, movePlayer: movePlayer, bullets: bullets, shots: shots,
    SONG: SONG, startMusic: startMusic, BPM: BPM, SND: SND,
    debugHit: debugHit, debugRing: debugRing
};
