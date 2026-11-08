// Ponte JS <-> core NATIVO do Detona (native/detona_core.cpp).
//
// O core e a autoridade da simulacao da FASE (grade, jogador, bombas,
// chamas, caixas, inimigos, drops, saida, relogio, vidas). Este modulo:
//   - carrega o blob (appDir/detona_core.bin) e monta o nivel da cena;
//   - manda input + dt por nativeCall(CORE_STEP);
//   - le o bloco de estado/eventos/sujos do scratch (fatias de 256 B) e
//     ESPELHA no objeto da cena (s.player, s.enemies, s.bombs...), entao o
//     desenho atual continua valendo sem mudanca.
//
// Layout do wire espelhado de detona_core.cpp (WireState/arrays):
//   head 8B | estado 40B | bombas 16x10 | chamas 64x6 (c,r,owner,pad,t) |
//   inimigos 24x8 | drops 16x4 | sujos 512x2 | eventos 32x8
// Se mudar o core, mude os dois lados (o teste host cobre o tamanho).

var S = System;

var CORE_INIT = 0, CORE_STEP = 2, CORE_LOAD_LEVEL = 3,
    CORE_OUT_OFF = 4, CORE_OUT_SIZE = 5, CORE_LEVEL_OFF = 6;

var CMD_UP = 1, CMD_DOWN = 2, CMD_LEFT = 4, CMD_RIGHT = 8, CMD_BOMB = 16, CMD_DETONATE = 32;

var HEAD = 8;
var ST = 40;                 // sizeof(WireState)
var OFF_BOMBS = 48;          // HEAD + ST
var OFF_FLAMES = OFF_BOMBS + 16 * 10;
var OFF_ENEMIES = OFF_FLAMES + 64 * 6;
var OFF_DROPS = OFF_ENEMIES + 24 * 8;
var DIRTY_OFF = OFF_DROPS + 16 * 4;      // = 848
var EVENTS_OFF = DIRTY_OFF + 512 * 2;    // = 1872

var DROP_KIND = ['range', 'bomb', 'speed', 'remote', 'shield', 'life'];
var EN_TYPE = ['slime', 'hunter', 'ghost', 'boss'];

var h = 0, outOff = 0, levelOff = 0, ready = false;
var st = {};                 // estado parseado do ultimo STEP
var bombs = [], flames = [], enemies = [], drops = [], events = [], dirty = [];

// Leitura do scratch em BYTES NUMERICOS: nativeRead devolve 256 B por
// chamada e o Duktape desta build nao aceita coercao de string "Symbol"
// (concatenar/join de um retorno inesperado estoura) — entao cada chunk vira
// numeros por charCodeAt e o parse e por indice, sem string grande.
function readBytes(base, len) {
    var bytes = [], p = 0, i;
    while (p < len) {
        var n = (len - p) < 256 ? (len - p) : 256;
        var part = S.nativeRead(h, base + p, n);
        // leitura curta (pedaco fora do scratch) vira lixo silencioso: NaN
        // do charCodeAt passa pelo & 0xFF como 0 — barra aqui
        if (part === null || typeof part !== 'string' || part.length !== n) return null;
        for (i = 0; i < n; i++) bytes.push(part.charCodeAt(i) & 0xFF);
        p += n;
    }
    return bytes;
}
function rb16(b, o) { return b[o] | (b[o + 1] << 8); }
function rb32(b, o) {
    var v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
    return v | 0;
}

// Preenche `st`, as listas e os eventos a partir do bloco de saida.
function readOut() {
    var head = readBytes(outOff, HEAD);
    if (head === null) return false;
    if (rb16(head, 0) !== 1) return false;   // CELER_CORE_VERSION: ABI trocou
    var nState = rb16(head, 2);
    var nEv = rb16(head, 4);
    var nDirty = rb16(head, 6);
    if (nState <= 0 || nState > 2048) return false;
    if (nEv > 32) nEv = 0;
    if (nDirty > 512) nDirty = 0;

    var body = readBytes(outOff + HEAD, nState);
    if (body === null) return false;

    st.px = rb32(body, 0);
    st.py = rb32(body, 4);
    st.gx = rb16(body, 8);
    st.gy = rb16(body, 10);
    st.lives = rb16(body, 12);
    st.score = rb16(body, 14);
    st.range = rb16(body, 16);
    st.maxBombs = rb16(body, 18);
    st.speed = rb16(body, 20);
    st.flags = rb16(body, 22);
    st.timeLeft = rb16(body, 24) / 10;
    st.invuln = rb16(body, 26) / 1000;
    st.animT = rb16(body, 28) / 1000;
    st.face = rb16(body, 30);
    st.nb = body[32];
    st.nf = body[33];
    st.ne = body[34];
    st.nd = body[35];

    var i, o;
    bombs.length = 0;
    for (i = 0; i < st.nb && i < 16; i++) {
        o = (OFF_BOMBS - HEAD) + i * 10;
        bombs.push({ c: body[o], r: body[o + 1],
                     range: body[o + 2], owner: body[o + 3] ? 'boss' : 'player',
                     remote: body[o + 4] !== 0,
                     t: rb16(body, o + 6) / 1000 });
    }
    flames.length = 0;
    for (i = 0; i < st.nf && i < 64; i++) {
        o = (OFF_FLAMES - HEAD) + i * 6;
        var fc = body[o], fr = body[o + 1];
        flames.push({ key: fc + ',' + fr, c: fc, r: fr, t: rb16(body, o + 4) / 1000,
                      owner: body[o + 2] === 1 ? 'boss' : 'player' });
    }
    enemies.length = 0;
    for (i = 0; i < st.ne && i < 24; i++) {
        o = (OFF_ENEMIES - HEAD) + i * 8;
        enemies.push({ c: body[o], r: body[o + 1],
                       type: body[o + 2], hp: body[o + 3],
                       maxHp: body[o + 4], active: body[o + 5] !== 0 });
    }
    drops.length = 0;
    for (i = 0; i < st.nd && i < 16; i++) {
        o = (OFF_DROPS - HEAD) + i * 4;
        drops.push({ c: body[o], r: body[o + 1],
                     kind: DROP_KIND[body[o + 2]] || 'range' });
    }

    dirty.length = 0;
    if (nDirty > 0) {
        var d = readBytes(outOff + DIRTY_OFF, nDirty * 2);
        if (d !== null) for (i = 0; i < nDirty; i++) dirty.push(rb16(d, i * 2));
    }
    events.length = 0;
    if (nEv > 0) {
        var ev = readBytes(outOff + EVENTS_OFF, nEv * 8);
        if (ev !== null) {
            for (i = 0; i < nEv; i++) {
                o = i * 8;
                events.push({ type: rb16(ev, o), a: rb16(ev, o + 2), b: rb16(ev, o + 4), c: rb16(ev, o + 6) });
            }
        }
    }
    return true;
}

// ------------------------------------------------------------- nivel
// Payload do core: [15x13 grid][exitC][exitR][mode][time0_ds][ne][type,c,r,hp]*
//                    [playerC][playerR]
function buildLevel(s) {
    var bytes = [], c, r, i;
    for (r = 0; r < 13; r++)
        for (c = 0; c < 15; c++) bytes.push(s.map ? (s.map.get(c, r) & 0xFF) : 0);
    bytes.push(s.exit[0] & 0xFF, s.exit[1] & 0xFF, 0 /*campaign*/);
    var t0 = Math.round((s.time0 || 0) * 10);
    bytes.push(t0 & 0xFF, (t0 >> 8) & 0xFF);
    var list = s.enemies || [];
    bytes.push(list.length & 0xFF);
    for (i = 0; i < list.length; i++) {
        var e = list[i];
        var type = e.data && e.data.type ? e.data.type : 'slime';
        var ti = 0;
        if (type === 'hunter') ti = 1;
        else if (type === 'ghost') ti = 2;
        else if (type === 'boss') ti = 3;
        var hp = (e.data && e.data.hp) ? e.data.hp : 1;
        bytes.push(ti, cellOf(e.x) & 0xFF, cellOf(e.y) & 0xFF, hp & 0xFF);
    }
    bytes.push(s.gx & 0xFF, s.gy & 0xFF);
    // NIBBLES (2 chars por byte): a string do Duktape e CESU-8 e um char
    // > 0x7F viaja como 2 bytes no nativeWrite — desalinhava o payload
    // inteiro (tempo/inimigos/jogador). Assim todo char fica <= 0x0F.
    var out = [];
    for (i = 0; i < bytes.length; i++) {
        out.push(String.fromCharCode((bytes[i] >> 4) & 0x0F));
        out.push(String.fromCharCode(bytes[i] & 0x0F));
    }
    return out.join('');
}
function cellOf(v) { return Math.round((v - 16) / 32); }

// API -----------------------------------------------------------------
var mod = {
    available: function () {
        var info = S.getInfo ? S.getInfo() : {};
        return info.hasNative === true && typeof S.nativeLoad === 'function';
    },

    // Carrega o blob e monta o nivel da cena. false = sem core (fallback JS).
    load: function (s) {
        if (!mod.available()) return false;
        if (s.mode && s.mode !== 'campaign') return false;   // sobrevivencia/duelo seguem no JS
        if (h > 0) { S.nativeFree(h); h = 0; }
        h = S.nativeLoad(S.appDir() + '/core.bin', 64);
        if (h <= 0) { if (S.print) S.print('detona: sem core (nativeLoad=' + h + ')'); return false; }
        if (S.nativeCall(h, 0, CORE_INIT, 0) !== 1) {
            if (S.print) S.print('detona: sem core (INIT)');
            S.nativeFree(h); h = 0; return false;
        }
        outOff = S.nativeCall(h, 0, CORE_OUT_OFF, 0);
        levelOff = S.nativeCall(h, 0, CORE_LEVEL_OFF, 0);
        var lv = buildLevel(s);
        var n = S.nativeWrite(h, levelOff, lv);
        var lr = n > 0 ? S.nativeCall(h, 0, CORE_LOAD_LEVEL, n) : -1;
        if (n <= 0 || lr <= 0) {
            if (S.print) S.print('detona: sem core (nivel ' + n + '/' + lr + ')');
            S.nativeFree(h); h = 0; return false;
        }
        ready = readOut();
        if (!ready) { S.nativeFree(h); h = 0; return false; }
        if (S.print) S.print('detona: core nativo (fase ' + (s.level || 0) + ', ' + st.ne +
                             ' inimigo(s), ' + st.timeLeft + 's)');
        return true;
    },

    // Um quadro: cmds (bits do core) + dt em ms.
    step: function (cmds, dtMs) {
        if (h <= 0) return false;
        if (dtMs < 1) dtMs = 1;
        if (dtMs > 255) dtMs = 255;   // o byte alto do arg e o dt
        S.nativeCall(h, 0, CORE_STEP, ((dtMs & 0xFF) << 8) | (cmds & 0xFF));
        return readOut();
    },

    state: function () { return st; },
    dirty: function () { return dirty; },
    events: function () { return events; },
    bombs: function () { return bombs; },
    flames: function () { return flames; },
    enemyList: function () { return enemies; },
    dropList: function () { return drops; },

    // Espelha o wire no objeto da cena (o desenho atual le tudo daqui).
    apply: function (s) {
        s.gx = st.gx; s.gy = st.gy;
        if (s.player) {
            s.player.x = st.px / 256;
            s.player.y = st.py / 256;
        }
        s.lives = st.lives;
        // o core pontua SO a fase: o placar acumulado das fases anteriores
        // (s.score0) entra aqui, senao o nativo comecava cada fase do zero
        s.score = (s.score0 || 0) + st.score;
        s.range = st.range;
        s.maxBombs = st.maxBombs;
        s.speed = st.speed / 256;
        s.remote = (st.flags & 8) !== 0;
        s.shield = (st.flags & 4) !== 0;
        s.exitRevealed = (st.flags & 16) !== 0;
        s.bossDead = (st.flags & 64) !== 0;
        s.moving = (st.flags & 32) !== 0 ? 1 : 0;
        s.timeLeft = st.timeLeft;
        s.invuln = st.invuln;
        s.animT = st.animT;
        s.face = st.face === 1 ? 'left' : (st.face === 2 ? 'right' : (st.face === 3 ? 'up' : 'down'));

        // listas do desenho
        s.bombs = bombs;
        s.flames = flames;
        s.drops = drops;
        for (var i = 0; i < s.enemies.length; i++) {
            var e = s.enemies[i];
            var w = enemies[i];
            if (!w) { e.active = false; continue; }
            e.active = w.active;
            e.x = w.c * 32 + 16;
            e.y = w.r * 32 + 16;
            e.hp = w.hp;
        }
        // fim de partida pelos BITS do estado: o anel de eventos do core
        // descarta o novo quando os 32 slots enchem (explosoa em cadeia) e o
        // EV_WIN/EV_LOSE do quadro podia se perder — os flags nao se perdem
        if ((st.flags & 1) !== 0) { s.done = true; s.lost = true; }
        if ((st.flags & 2) !== 0) { s.done = true; s.won = true; }
        // caixas/saida: o mapa do JS e a fonte do desenho do fundo — so os
        // EVENTOS mudam o mapa (uma celula suja por fogo/passo nao e caixa)
        for (var e2 = 0; e2 < events.length; e2++) {
            var ev = events[e2];
            if (ev.type === 2) {   // EV_CRATE: abriu a caixa (o mapa segue)
                var cc = ev.a % 15, rr = (ev.a / 15) | 0;
                var isExit = (cc === s.exit[0] && rr === s.exit[1]);
                if (s.map && s.map.set) s.map.set(cc, rr, isExit ? 3 : 0);
            } else if (ev.type === 6) {   // EV_EXIT
                var ec = ev.a % 15, er = (ev.a / 15) | 0;
                if (s.map && s.map.set) s.map.set(ec, er, 3);
                s.exitRevealed = true;
            } else if (ev.type === 7) {   // EV_WIN
                s.done = true; s.won = true;
            } else if (ev.type === 8) {   // EV_LOSE
                s.done = true; s.lost = true;
            }
        }
    },
};

module.exports = mod;
