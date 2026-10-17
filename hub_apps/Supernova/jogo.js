// jogo.js — simulacao do combate do Supernova sobre a game engine do SDK.
// Desde a 2.3 os PROJETEIS nao sao mais corpos da fisica: vivem em POOLS
// pre-alocados e colidem por distancia (bala x inimigo, bala x nucleo da
// nave), e o pouco que sobrou (ram de inimigo, orbe) e checado no proprio
// roteamento — a dep celeros.physics saiu do app. Motivo: no pico do chefe
// viviam ~85 corpos sensor no sweep-and-prune da fisica, rodando 2x por
// quadro (os sub-passos eram empurrados pelas balas de 620 px/s), e cada
// rajada alocava ~30 objetos (closure de onCollide inclusa) — engasgo de GC
// no Duktape e, em cascata (fps cai, dt cresce, mais balas vivas), RangeError
// "execution timeout". Vazamento consertado junto: as balas do chefe que
// subiam nunca eram varridas (o cull antigo nao tinha o teto y < -24K) e
// acumulavam como fantasmas no mundo para sempre. A trilha continua sendo
// o metronomo: cada cruzamento de batida pode soltar um comboio (ou a
// rajada do chefe). Coordenadas em PIXELS FISICOS (canvas nativo); medidas
// e velocidades nasceram no 480 e escalam por K = E.U / 2 (1 no
// SmartDisplay, ~0,85 no relogio de 410).

var E = require("celeros.game");
require("celeros.game.fx");
require("celeros.game.spr");

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

var W = 0, H = 0, K = 1;
var S = null;
var lastBeatInt = -1;

// Contêiner simples de corpos (mesma forma de sempre: world.all alimenta o
// desenho, o sweep e a supernova). Nao ha mais broadphase: as unicas
// colisoes entre corpos (ram de inimigo, orbe) sao duas distancias no
// roteamento do update.
var world = { all: [] };

function addBody(b) {
    world.all.push(b);
    return b;
}

function removeAt(i) {
    var a = world.all;
    a[i] = a[a.length - 1];
    a.pop();
}

// Pools de projeteis: objetos pre-alocados, reciclados por swap-pop — zero
// alocacao por rajada (o GC do Duktape nao engasga mais no chefe). O cap e
// teto defensivo: cheio, o tiro nasce morto.
var PB_CAP = 24, EB_CAP = 64;
var PB = [], PBn = 0;    // tiros da nave
var EB = [], EBn = 0;    // tiros inimigos
// visao dos pools para o desenho: MESMO objeto por quadro (o main.js le
// pbn/ebn no hot path; devolver um literal novo a cada draw era lixo para
// o GC do Duktape)
var _bview = { pb: PB, pbn: 0, eb: EB, ebn: 0 };

function clampX(x) {
    var m = 30 * K;
    return x < m ? m : (x > W - m ? W - m : x);
}

function reset() {
    W = E.W;
    H = E.H;
    K = E.U / 2;
    world = { all: [] };
    PBn = 0;
    EBn = 0;
    if (PB.length < PB_CAP) {
        for (var i = 0; i < PB_CAP; i++) PB.push({ x: 0, y: 0, vx: 0, vy: 0 });
    }
    if (EB.length < EB_CAP) {
        for (var j = 0; j < EB_CAP; j++) EB.push({ x: 0, y: 0, vx: 0, vy: 0 });
    }
    S = {
        t: 0, world: world, player: null,
        score: 0, kills: 0, lives: 3, charge: 0,
        streak: 0, streakT: 0, mult: 1, multPulse: 0,
        wave: 0, spawns: 0, intensity: 0,
        boss: null, bossNext: 5, bossAlt: 0, triple: 0,
        over: false, overT: 0
    };
    var p = addBody({ cat: 'player', x: W / 2, y: H * 0.8, r: 24 * K });
    p.cool = 0;
    p.invuln = 1.2;
    S.player = p;
    lastBeatInt = -1;
}

function state() { return S; }

function count(cat) {
    var n = 0, all = world.all;
    for (var i = 0; i < all.length; i++) if (all[i].cat === cat) n++;
    return n;
}

function movePlayer(dx) {
    S.player.x = clampX(S.player.x + dx);
}

// ------------------------------------------------------------- spawns ---

function spawnConvoy() {
    var s = S;
    if (s.boss) return;
    var n = 2 + Math.min(2, Math.floor(s.intensity / 2));
    var cx = 60 * K + Math.random() * (W - 120 * K);
    for (var i = 0; i < n; i++) {
        var e = addBody({
            cat: 'enemy', kind: 0,
            x: clampX(cx + (i - (n - 1) / 2) * 78 * K), y: (-40 - i * 34) * K, r: 20 * K,
            hp: 1, flashT: 0,
            ph: Math.random() * Math.PI * 2, cool: 1.4 + Math.random() * 2.2,
            vx: (26 + s.intensity * 5) * K
        });
        e.upd = updDrone;
    }
    s.spawns++;
    s.wave = 1 + Math.floor(s.spawns / 4);
    if (s.wave >= s.bossNext) spawnBoss();
}

function spawnSentinel() {
    var e = addBody({
        cat: 'enemy', kind: 1,
        x: clampX(70 * K + Math.random() * (W - 140 * K)), y: -50 * K, r: 20 * K,
        hp: 3 + Math.floor(S.intensity / 3), flashT: 0,
        ph: Math.random() * Math.PI * 2, cool: 1.1 + Math.random()
    });
    e.upd = updSentinel;
    S.spawns++;
    S.wave = 1 + Math.floor(S.spawns / 4);
    if (S.wave >= S.bossNext) spawnBoss();
}

// splitter: desce rapido em senoide apertada e se divide em 2 minis
function spawnSplitter() {
    var e = addBody({
        cat: 'enemy', kind: 3,
        x: clampX(60 * K + Math.random() * (W - 120 * K)), y: -40 * K, r: 20 * K,
        hp: 2, flashT: 0,
        ph: Math.random() * Math.PI * 2
    });
    e.upd = updSplitter;
}

function spawnMini(x, ph) {
    var e = addBody({
        cat: 'enemy', kind: 4,
        x: clampX(x), y: -20 * K, r: 12 * K, hp: 1, flashT: 0,
        ph: ph
    });
    e.upd = updMini;
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
    var b = addBody({
        cat: 'enemy', kind: 2,
        x: W / 2, y: -90 * K, r: 46 * K, hp: hp, hpMax: hp, flashT: 0
    });
    b.upd = updBoss;
    S.boss = b;
    E.fx.popText(W / 2, H * 0.3, "SENTINELA-MOR", { color: MAGENTA, life: 1.6, ts: 'big' });
    E.audio.sfx("alerta");
}

// ------------------------------------------------------ roteiro/movimento ---

function updDrone(e, dt) {
    e.y += (46 + S.intensity * 7) * K * dt;
    e.x += Math.sin(S.t * 2.2 + e.ph) * e.vx * dt * 2.4;
    e.cool -= dt;
    if (e.cool <= 0 && e.y > 30 * K && e.y < H * 0.7) {
        e.cool = 2.6 + Math.random() * 2.5 - S.intensity * 0.12;
        ebullet(e.x, e.y + 22 * K, (S.player.x - e.x) * 0.22, (150 + S.intensity * 8) * K);
    }
}

function updSentinel(e, dt) {
    if (e.y < H * 0.24) e.y += 34 * K * dt;
    else e.x += Math.sin(S.t * 0.9 + e.ph) * 40 * K * dt;
    e.cool -= dt;
    if (e.cool <= 0 && e.y > 20 * K) {
        e.cool = 1.7 + Math.random() * 1.2 - S.intensity * 0.08;
        var dx = S.player.x - e.x, dy = S.player.y - e.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 1;
        var sp = (205 + S.intensity * 10) * K;
        ebullet(e.x, e.y + 16 * K, dx / d * sp, dy / d * sp);
    }
}

function updSplitter(e, dt) {
    e.y += (70 + S.intensity * 8) * K * dt;
    e.x += Math.sin(S.t * 4 + e.ph) * 90 * K * dt;
}

function updMini(e, dt) {
    e.y += (150 + S.intensity * 10) * K * dt;
}

function updBoss(e, dt) {
    var y0 = H * 0.23;
    if (e.y < y0) {
        e.y += 40 * K * dt;
        return;
    }
    var fast = e.hp < e.hpMax / 2;
    e.x = W / 2 + Math.sin(S.t * (fast ? 0.9 : 0.55)) * (W * 0.3);
    if (fast) e.y = y0 + Math.sin(S.t * 1.3) * 14 * K;
}

function updOrb(o, dt) {
    o.y += 64 * K * dt;
    o.ph += dt * 5;
}

// ------------------------------------------------------------- tiros ---

function pbullet(x, y, vx, vy) {
    if (PBn >= PB_CAP) return null;
    var b = PB[PBn++];
    b.x = x; b.y = y; b.vx = vx; b.vy = vy;
    return b;
}

function ebullet(x, y, vx, vy) {
    if (EBn >= EB_CAP) return null;
    var b = EB[EBn++];
    b.x = x; b.y = y; b.vx = vx; b.vy = vy;
    return b;
}

// colheita do orbe pela nave
function pickupOrb(o) {
    o.dead = true;
    S.charge = Math.min(100, S.charge + 25);
    S.score += 15;
    E.fx.ring(o.x, o.y, { color: OURO, speed: 300 * K, life: 0.5 });
    E.fx.popText(o.x, o.y - 14 * K, "+CARGA", { color: OURO, ts: 'small' });
    E.audio.sfx("power");
}

// inimigo que ramming a nave: explode junto
function ramPlayer(e) {
    e.dead = true;
    E.fx.burst(e.x, e.y, { n: 12, color: LARANJA, speed: 120 * K, life: 0.5 });
    hitPlayer();
}

// anel do chefe com CLAURO DE FUGA de 2 slots (~50-70 graus) centrado em
// gapA: sempre ha um caminho legivel — o anel fechado aleatorio da 2.2
// nascia com ~20 px entre balas contra 48 px de nave (nao havia onde passar)
function fireRing(x, y, sp, n, gapA) {
    var step = Math.PI * 2 / (n + 2);
    var arc = Math.PI * 2 - 2 * step;
    for (var i = 0; i < n; i++) {
        var a = gapA + step + arc * i / (n - 1);
        ebullet(x + Math.cos(a) * 44 * K, y + Math.sin(a) * 44 * K,
                Math.cos(a) * sp, Math.sin(a) * sp);
    }
}

// rajada do chefe, sincronizada na batida: alterna anel com clauro (virado
// para o lado da nave) e leque mirado de 3 — pressao com metade das balas
function bossBurst() {
    var b = S.boss;
    if (!b || b.y < 60 * K) return;
    var fast = b.hp < b.hpMax / 2;
    E.fx.ring(b.x, b.y, { color: MAGENTA, speed: 500 * K, life: 0.4 });
    if (S.bossAlt++ % 2 === 1) {
        var base = Math.atan2(S.player.y - b.y, S.player.x - b.x);
        var fs = 230 * K;
        for (var f = -1; f <= 1; f++) {
            var fa = base + f * 0.22;
            ebullet(b.x, b.y + 40 * K, Math.cos(fa) * fs, Math.sin(fa) * fs);
        }
    } else {
        var sp = (110 + S.intensity * 6 + (fast ? 25 : 0)) * K;
        var gap = Math.atan2(S.player.y - b.y, S.player.x - b.x) + (Math.random() - 0.5) * 0.6;
        fireRing(b.x, b.y, sp, fast ? 12 : 8, gap);
    }
}

// ----------------------------------------------------------- simulacao ---

// projeteis: integracao + colisao por distancia em micro-passos curtos (a
// bala da nave a 620 px/s nao atravessa o mini de r 12). Contra tiros
// inimigos a nave acerta pelo NUCLEO (graze de 14 px, nao a borda de 24):
// classico dos shmups — o vaisivel nao muda, desviar fica possivel
function updateBullets(dt) {
    var s = S, p = s.player;
    var i, j, k, b, e, nsub, sdt, dx, dy, rr, dead, all;

    for (i = PBn - 1; i >= 0; i--) {
        b = PB[i];
        nsub = Math.max(1, Math.min(4,
              Math.ceil((Math.abs(b.vx) + Math.abs(b.vy)) * dt / (10 * K))));
        sdt = dt / nsub;
        dead = false;
        all = world.all;
        for (k = 0; k < nsub && !dead; k++) {
            b.x += b.vx * sdt;
            b.y += b.vy * sdt;
            for (j = 0; j < all.length; j++) {
                e = all[j];
                if (e.cat !== 'enemy' || e.dead || e.killed) continue;
                dx = b.x - e.x; dy = b.y - e.y;
                rr = 5 * K + e.r;
                if (dx * dx + dy * dy <= rr * rr) {
                    dead = true;
                    e.hp -= 1;
                    e.flashT = 0.09;
                    E.audio.sfx("hit");
                    E.fx.burst(b.x, b.y + 6 * K, { n: 3, color: BRANCO, speed: 80 * K, life: 0.3, size: 1 });
                    if (e.hp <= 0) e.killed = true;
                    break;
                }
            }
        }
        if (dead || b.y < -24 * K) {
            PBn--;
            PB[i] = PB[PBn];
            PB[PBn] = b;
        }
    }

    var gr = (14 + 5) * K;   // nucleo da nave + raio da bala
    for (i = EBn - 1; i >= 0; i--) {
        b = EB[i];
        nsub = Math.max(1, Math.min(2,
              Math.ceil((Math.abs(b.vx) + Math.abs(b.vy)) * dt / (9 * K))));
        sdt = dt / nsub;
        dead = false;
        for (k = 0; k < nsub && !dead; k++) {
            b.x += b.vx * sdt;
            b.y += b.vy * sdt;
            if (!s.over && p.invuln <= 0) {
                dx = b.x - p.x; dy = b.y - p.y;
                if (dx * dx + dy * dy <= gr * gr) {
                    dead = true;
                    hitPlayer();
                }
            }
        }
        if (dead || b.y < -24 * K || b.y > H + 24 * K ||
            b.x < -24 * K || b.x > W + 24 * K) {
            EBn--;
            EB[i] = EB[EBn];
            EB[EBn] = b;
        }
    }
}

function update(dt) {
    var s = S;
    if (s.over) {
        s.overT += dt;
        return;
    }
    s.t += dt;
    s.intensity = Math.min(10, s.t / 14);
    if (s.triple > 0) s.triple -= dt;
    if (s.multPulse > 0) s.multPulse -= dt;

    // diretor: comboio no cruzamento de batida; chefe comanda a tela
    var beatF = E.audio.beat();
    if (beatF >= 0) {
        var bi = Math.floor(beatF);
        if (bi !== lastBeatInt) {
            lastBeatInt = bi;
            if (s.boss) bossBurst();
            else {
                var chance = 0.3 + s.intensity * 0.05;
                if (Math.random() < chance && count('enemy') < 14) spawnConvoy();
            }
        }
    } else if (!s.boss && count('enemy') < 3 && Math.random() < dt * 0.5) {
        spawnConvoy();   // sem musica (fallback): relogio proprio
    }
    if (!s.boss) {
        if (Math.random() < dt / 9) spawnSentinel();
        if (Math.random() < dt / 11) spawnSplitter();
        if (Math.random() < dt / 12) spawnOrb();
    } else if (Math.random() < dt / 14) {
        spawnOrb();      // orbe de alivio durante o chefe
    }

    // nave: tiro duplo (triplo com o poder do chefe) + rastro no motor
    var p = s.player;
    p.cool -= dt;
    if (p.invuln > 0) p.invuln -= dt;
    if (p.cool <= 0) {
        p.cool = 0.16;
        pbullet(p.x - 14 * K, p.y - 26 * K, 0, -620 * K);
        pbullet(p.x + 14 * K, p.y - 26 * K, 0, -620 * K);
        if (s.triple > 0) {
            pbullet(p.x, p.y - 30 * K, -130 * K, -600 * K);
            pbullet(p.x, p.y - 30 * K, 130 * K, -600 * K);
        }
        E.audio.sfx("shot");
    }

    // roteia os corpos; ram de inimigo e orbe colhem por distancia direta
    // (nao sobrou broadphase — e so a nave contra poucos corpos)
    var all = world.all;
    for (var i = 0; i < all.length; i++) {
        var b = all[i];
        if (b.flashT > 0) b.flashT -= dt;
        if (b.upd && !b.dead && !b.killed) b.upd(b, dt);
        if (b.cat === 'enemy' && b.kind !== 2) b.x = clampX(b.x);
        if (b.cat !== 'player' && !b.dead && !b.killed && !s.over) {
            var dx = b.x - p.x, dy = b.y - p.y;
            var rr = b.r + p.r;
            if (dx * dx + dy * dy <= rr * rr) {
                if (b.cat === 'orb') pickupOrb(b);
                else if (p.invuln <= 0) ramPlayer(b);
            }
        }
    }
    updateBullets(dt);
    sweep();

    if (s.streakT > 0) {
        s.streakT -= dt;
        if (s.streakT <= 0 && s.streak > 0) {
            s.streak = 0;
            s.mult = 1;
        }
    }
}

// varre os corpos: mortos, marcados como abate e fora da tela (projeteis
// sao varridos no proprio updateBullets — inclusive as balas que SOBEM,
// que antigamente escapavam do cull e viravam fantasmas eternos)
function sweep() {
    var all = world.all;
    for (var i = all.length - 1; i >= 0; i--) {
        var b = all[i];
        if (b.cat === 'orb') {
            if (b.dead || b.y > H + 30 * K) removeAt(i);
        } else if (b.cat === 'enemy') {
            if (b.killed) { killEnemy(b); removeAt(i); }
            else if (b.dead) { explosionFx(b); removeAt(i); }
            else if (b.y > H + 60 * K) removeAt(i);
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
    s.bossNext += 5;
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
        E.audio.stop();
        E.audio.sfx("over");
    } else {
        // a trilha segue (sfx misturado): perder vida nao corta a musica
        p.invuln = 2.2;
        E.audio.sfx("dano");
    }
}

// detonacao da SUPERNOVA: limpa a tela (o chefe apanha 15 em vez de morrer),
// pontos por cabeca, duas ondas de choque e flash; a trilha volta depois
function detonate() {
    var s = S;
    if (s.over || s.charge < 100) return false;
    var gained = 0;
    var all = world.all;
    var i, b;
    for (i = 0; i < all.length; i++) {
        b = all[i];
        if (b.cat !== 'enemy' || b.dead || b.killed) continue;
        if (b.kind === 2) {
            b.hp -= 15;
            b.flashT = 0.3;
            gained += 60;
            if (b.hp <= 0) b.killed = true;
        } else {
            gained += b.kind === 1 ? 45 : 15;
            b.killed = true;
            E.fx.burst(b.x, b.y, { n: 14, color: OURO, speed: 150 * K, life: 0.6 });
        }
    }
    for (i = all.length - 1; i >= 0; i--) {
        b = all[i];
        if (b.cat === 'enemy' && b.killed) {
            if (b.kind === 2) bossDown(b);
            removeAt(i);
        }
    }
    EBn = 0;   // os tiros inimigos somem inteiros (pool: esvaziar e O(1))
    s.score += gained + 60;
    s.charge = 0;
    E.fx.burst(s.player.x, s.player.y - 30 * K, { n: 40, color: OURO, speed: 300 * K, life: 0.9 });
    E.fx.burst(s.player.x, s.player.y - 30 * K, { n: 24, color: BRANCO, speed: 180 * K, life: 0.6 });
    E.fx.ring(s.player.x, s.player.y - 30 * K, { color: OURO, speed: 700 * K, life: 0.7, r0: 10 * K });
    E.fx.ring(s.player.x, s.player.y - 30 * K, { color: CIANO, speed: 520 * K, life: 0.7, r0: 10 * K });
    // o evento maior do jogo: este sim e flash de tela cheia
    E.fx.flash(BRANCO, 420, { full: true });
    E.cam.shake(8 * K, 0.45);
    E.fx.popText(W / 2, H / 2 - 30 * K, "SUPERNOVA! +" + gained, { color: OURO, life: 1.4, ts: 'big' });
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

// pools para o desenho (main.js) e para o teste — objeto reaproveitado
function bullets() {
    _bview.pbn = PBn;
    _bview.ebn = EBn;
    return _bview;
}

// testes deterministcos (harness): tiro inimigo em cima da nave e anel do
// chefe em ponto dado
function debugHit() {
    var p = S.player;
    ebullet(p.x, p.y, 0, 120);
}

function debugRing(x, y) {
    fireRing(x, y, 150 * K, 12, -Math.PI / 2);
}

module.exports = {
    reset: reset, update: update, detonate: detonate,
    state: state, movePlayer: movePlayer, bullets: bullets,
    SONG: SONG, startMusic: startMusic, BPM: BPM, SND: SND,
    debugHit: debugHit, debugRing: debugRing
};
