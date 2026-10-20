// meshsim/node.js — UM no da malha simulada (worker_thread). Roda o main.js
// REAL do app sobre os stubs do js_harness (makeEnv) e troca o CelerNet /
// Pack / CelerLink por versoes ligadas ao coordenador (sim.js).
//
// Sincronia em lockstep: o app so avanca o relogio pelo System.delay (o
// UI.end, os dialogos e o prompt passam por ele). Cada vez que o relogio
// do no cruza uma barreira (multiplo de Q ms), o worker manda ao
// coordenador o que transmitiu e DORME (Atomics.wait) ate o coordenador
// rotear o ar e liberar; a caixa de entrada chega por uma MessagePort lida
// de forma SINCRONA (receiveMessageOnPort). Determinismo: Math.random
// semeado por no, nenhuma fonte de tempo real.
'use strict';
var wt = require('worker_threads');
var path = require('path');
var H = require('../js_harness/run.js');
var Res = require('./resources.js');

var wd = wt.workerData;
var Q = wd.quantumMs;
var gate = new Int32Array(wd.sab);
var slot = wd.index;
var inbox = wd.port;

// ---- determinismo: PRNG semeado (mulberry32) no lugar do Math.random ----
var seed = wd.seed >>> 0;
Math.random = function() {
    seed = (seed + 0x6D2B79F5) >>> 0;
    var t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

var env = H.makeEnv();
var S = env.System;
var log = env.__harness.log;
env.__exposeMesh = true;

// ---- estado visto do coordenador (atualizado a cada barreira) -----------
var view = { nodes: [], linkAdv: [], online: true };
var outbox = [];          // eventos para o coordenador nesta janela
var stopNow = false;
var gen = 0;

// ---- CelerNet (contrato de main/Runtime/JsMesh.cpp) ---------------------
var MSG_MAX = 434, DATA_MAX = 16, CHUNK = 14, PENDING_DEPTH = 96;
var TOKENS_PER_S = 8;
// v3: a rede e a matilha do no (spec.pack), nunca a do app
var net = { active: false, relay: true, name: '', net: wd.pack ? wd.pack.name : 'celer', seq: (wd.seed & 0xFFFF),
            txDropped: 0, rxDropped: 0, relayed: 0, relayDropped: 0 };
// matilha do no (API 40: muda em tempo de execucao pelo Pack.join/leave ou
// pelo convite selado do CelerLink — o coordenador troca a chave do ar)
var pack = wd.pack ? { name: wd.pack.name, key: wd.pack.name + '\u0000' + wd.pack.pass } : null;
var invite = { st: 'idle', at: 0 };
function setPack(p) {
    pack = p;
    net.net = p ? p.name : 'celer';
    outbox.push({ t: 'netkey', key: p ? p.key : 'celer', at: S.millis() });
}
var rxQ = [];             // CelerNet.poll (8, cheia descarta a mais antiga)
var packQ = [];           // Pack.poll (4)
var packSeen = [];        // dedup de msgId por origem (32 entradas, igual ao firmware)
var packMsgId = (wd.seed >>> 3) & 0xFFFF;
var backlog = 0, backlogAt = 0;   // quadros na fila do TX (escoam 8/s)
var stats = { rxDup: 0, swallowed: 0 };

function frames(len) { return len <= DATA_MAX ? 1 : Math.ceil(len / CHUNK); }
function drainBacklog() {
    var now = S.millis();
    backlog = Math.max(0, backlog - (now - backlogAt) * TOKENS_PER_S / 1000);
    backlogAt = now;
}
function payload(m) {
    var s;
    if (m !== null && typeof m === 'object' && typeof m !== 'function') s = JSON.stringify(m);
    else s = String(m);
    if (s.length === 0 || s.length > MSG_MAX) {
        throw new RangeError('mensagem deve ter 1 a ' + MSG_MAX + ' bytes');
    }
    return s;
}
function hex4(n) { return ('000' + (n & 0xFFFF).toString(16).toUpperCase()).slice(-4); }
function myId() { return wd.id; }
function resolve(to) {
    to = String(to);
    if (/^[0-9A-Fa-f]{4}$/.test(to)) {
        var up = to.toUpperCase();
        for (var i = 0; i < view.nodes.length; i++) if (view.nodes[i].id === up) return up;
    }
    var low = to.toLowerCase();
    for (var j = 0; j < view.nodes.length; j++) {
        if (view.nodes[j].name.toLowerCase() === low) return view.nodes[j].id;
    }
    return null;
}
// Enfileira no TX: false se a fila de 96 quadros nao comporta a mensagem
// inteira com as copias (o firmware recusa tudo ou nada)
function enqueue(ev, len, copies) {
    drainBacklog();
    var need = frames(len) * copies;
    if (backlog + need > PENDING_DEPTH) { net.txDropped++; return false; }
    backlog += need;
    ev.at = S.millis();
    ev.backlog = backlog;
    outbox.push(ev);
    return true;
}

env.CelerNet = {
    start: function(opts) {
        opts = opts || {};
        if (typeof opts.name === 'string' && opts.name) net.name = opts.name.slice(0, 14);
        if (!net.name) net.name = 'Celer-' + myId();
        if (opts.relay === false) net.relay = false;
        else if (opts.relay === true) net.relay = true;
        if (!net.active) { net.seq = (net.seq + 101) & 0xFFFF; }
        net.active = true;
        outbox.push({ t: 'net', active: true, name: net.name, net: net.net, relay: net.relay, at: S.millis() });
        return true;
    },
    stop: function() {
        net.active = false;
        outbox.push({ t: 'net', active: false, at: S.millis() });
        return true;
    },
    broadcast: function(m, ttl) {
        var s = payload(m);
        if (!net.active) return false;
        ttl = ttl === undefined || ttl === null ? 4 : Math.max(1, Math.min(8, ttl | 0));
        net.seq = (net.seq + 1) & 0xFFFF;
        return enqueue({ t: 'tx', dst: null, data: s, ttl: ttl, copies: 1, urgent: false, seq: net.seq }, s.length, 1);
    },
    send: function(to, m, opts) {
        var dst = resolve(to);
        if (dst === null) return false;  // destino sumido: false, sem throw
        var s = payload(m);
        if (!net.active) return false;
        opts = opts || {};
        var ttl = typeof opts.ttl === 'number' ? Math.max(1, Math.min(8, opts.ttl | 0)) : 4;
        var copies = typeof opts.copies === 'number' ? Math.max(1, Math.min(3, opts.copies | 0)) : 2;
        net.seq = (net.seq + copies) & 0xFFFF;
        return enqueue({ t: 'tx', dst: dst, data: s, ttl: ttl, copies: copies, urgent: !!opts.urgent, seq: net.seq },
                       s.length, copies);
    },
    poll: function() { return rxQ.length ? rxQ.shift() : null; },
    nodes: function() {
        return view.nodes.map(function(n) {
            return { id: n.id, name: n.name, caps: n.caps, rssi: n.rssi, hops: n.hops, lastSeen: n.lastSeen };
        });
    },
    status: function() {
        drainBacklog();
        return { active: net.active, relay: net.relay, node: myId(), name: net.name || ('Celer-' + myId()),
                 net: net.net, secure: !!pack, provisioned: !!pack,
                 txQueued: Math.ceil(backlog), txDropped: net.txDropped,
                 rxDropped: net.rxDropped, relayed: net.relayed, relayDropped: net.relayDropped,
                 heard: view.nodes.length, rxAuthFail: 0, rxReplay: 0 };
    }
};

// ---- Pack (contrato de main/Runtime/JsPack.cpp + main/Pack/Pack.cpp) ----
var CAPS = ['speaker', 'mic', 'display', 'motors', 'leds', 'hub'];
function decodeCaps(c) {
    var o = {};
    for (var i = 0; i < CAPS.length; i++) o[CAPS[i]] = !!(c & (1 << i));
    return o;
}
function packSend(dst, kind, data, urgent, wireLen) {
    packMsgId = (packMsgId + 1) & 0xFFFF;
    net.seq = (net.seq + 2) & 0xFFFF;
    var ev = { t: 'tx', dst: dst, data: data, pack: { kind: kind, msgId: packMsgId }, ttl: 4,
               copies: 2, urgent: !!urgent, seq: net.seq };
    if (wireLen) ev.wireLen = wireLen;   // o sim soma os 4 B do envelope
    return enqueue(ev, (wireLen || data.length) + 4, 2);
}
// Recursos da matilha (API 36): main/Pack/Resources.cpp em JS (resources.js)
var settings = wd.settings || {};
var res = Res.create({
    S: S,
    send: function(dst, data, wl, urgent) { return net.active && packSend(dst, 3, data, urgent, wl); },
    members: function() { return view.nodes; },
    log: function(m) { log.push(m); },
    caps: wd.caps || 0,
    relays: wd.relays || 0,      // API 38: reles do no (cenario gpio/sensor)
    sensors: wd.sensors || [],   // API 38: sensores de placa do no
    get secure() { return !!pack; },   // a matilha pode mudar (Pack.join / convite)
    // null = setting nao definido (resources.js aplica o default por chave:
    // res_share_gpio nasce '0', as outras '1')
    setting: function(k) { return settings.hasOwnProperty(k) ? String(settings[k]) : null; }
});
env.Pack = {
    me: function() {
        return { id: myId(), name: net.name || ('Celer-' + myId()), caps: decodeCaps(wd.caps),
                 meshActive: net.active, net: net.net, provisioned: !!pack };
    },
    // API 40 (main/Pack/Provision.cpp): a chave e o par nome+senha (o sim nao
    // deriva PBKDF2); o convite leva a chave pelo selo do CelerLink
    join: function(name, pass) {
        name = String(name); pass = String(pass);
        if (!name || name.length > 15 || pass.length < 8) return false;
        setPack({ name: name, key: name + '\u0000' + pass });
        return true;
    },
    leave: function() { setPack(null); return true; },
    acceptInvite: function(on) {
        if (on === false) { if (invite.st === 'waiting') invite.st = 'idle'; return true; }
        // CelerLink::start(nullptr): anuncia com o nome da matilha (PackId)
        env.CelerLink.start(link.name || net.name || undefined);
        invite = { st: 'waiting', at: S.millis() };
        return true;
    },
    invite: function() {
        if (!pack || !linkOk() || !link.bonds[link.conn.peer]) return false;
        invite = { st: 'sent', at: S.millis() };
        outbox.push({ t: 'ltx', data: 'CNJ' + JSON.stringify({ n: pack.name, k: pack.key }), sealed: true,
                      at: S.millis() });
        return true;
    },
    inviteStatus: function() {
        if (invite.st === 'sent' && S.millis() - invite.at > 10000) invite.st = 'fail';
        if (invite.st === 'waiting' && (S.millis() - invite.at > 600000 || !link.listening)) invite.st = 'idle';
        return invite.st;
    },
    members: function() {
        return view.nodes.map(function(n) {
            return { id: n.id, name: n.name, caps: decodeCaps(n.caps), rssi: n.rssi, hops: n.hops,
                     lastSeen: n.lastSeen };
        });
    },
    send: function(to, m, opts) {
        var dst = resolve(to);
        if (dst === null || !net.active) return false;
        var s = payload(m);
        if (s.length > 430) throw new RangeError('mensagem deve ter 1 a 430 bytes');
        return packSend(dst, 0, s, opts && opts.urgent);
    },
    poll: function() { return packQ.length ? packQ.shift() : null; },
    resources: function(only) { return net.active ? res.api.resources(only) : []; },
    open: function(to, name, opts) {
        var dst = resolve(to);
        if (dst === null || !net.active) return -1;
        var params = opts && typeof opts === 'object' ? JSON.stringify(opts) : '';
        if (params.length > 48) throw new RangeError('opts do recurso deve ter 1 a 48 bytes');
        return res.api.open(dst, String(name), params);
    },
    status: function(h) { return res.api.status(h); },
    read: function(h) { return res.api.read(h); },
    onEvent: function(h) { return res.api.onEvent(h); },  // threshold (API 47)
    write: function(h, d) {
        var s = payload(d);
        if (s.length > res.api.MAX_DATA) throw new RangeError('dado do recurso deve ter 1 a 425 bytes');
        return res.api.write(h, s);
    },
    close: function(h) { res.api.close(h); },
    relayState: function(name) { return res.api.relayState(name); },  // oraculo do cenario gpio
    expose: function(name, opts) {
        return res.api.expose(String(name), !(opts && opts.shared === false));
    },
    unexpose: function(name) { return res.api.unexpose(String(name)); },
    publish: function(name, d) {
        var s = payload(d);
        if (s.length > res.api.MAX_DATA) throw new RangeError('dado do recurso deve ter 1 a 425 bytes');
        return res.api.publish(String(name), s);
    },
    sessions: function(name) { return res.api.sessions(String(name)); },
    pollWrite: function() { return res.api.pollWrite(); },
    // audio (R3) exige ESP-NOW, que o sim nao modela: recusa "noLink" como o
    // firmware faria sem canal comum
    listen: function(to) { return env.Pack.open(to, 'mic'); },
    speak: function(to) { return env.Pack.open(to, 'speaker'); },
    record: function(to, opts) { return env.Pack.open(to, 'mic', opts); },
    recording: function() { return false; },
    level: function() { return -1; },
    recordStop: function(h, opts) { res.api.close(h); return opts && opts.path ? false : null; },
    snap: function(to, opts) { return env.Pack.open(to, 'camera', opts); },
    view: function(to, opts) { return env.Pack.open(to, 'camera', opts); },
    drawFrame: function() { return false; },
    handoffMusic: function(to) {
        var ms = env.__harness.music;
        if (!ms.playing || !net.active) return false;
        var dst = null;
        if (to !== undefined && to !== null) dst = resolve(to);
        else {
            for (var i = 0; i < view.nodes.length; i++) {
                if (view.nodes[i].caps & 1) { dst = view.nodes[i].id; break; }
            }
        }
        if (dst === null) return false;
        var song = JSON.parse(ms.songs[ms.songs.length - 1]);   // o stub guarda JSON
        var pos = S.musicPos();
        // encodeSong do firmware e compacto (~1/2 do JSON); teto 430
        var body = JSON.stringify({ song: song, pos: pos });
        var wireLen = Math.min(430, 6 + (body.length >> 1));
        packMsgId = (packMsgId + 1) & 0xFFFF;
        net.seq = (net.seq + 2) & 0xFFFF;
        var ok = enqueue({ t: 'tx', dst: dst, data: body, wireLen: wireLen,
                           pack: { kind: 1, msgId: packMsgId }, ttl: 4, copies: 2, urgent: true,
                           seq: net.seq }, wireLen + 4, 2);
        if (ok) S.musicStop();
        return ok;
    }
};

// ---- CelerLink (contrato de main/Runtime/JsLink.cpp) --------------------
var link = { listening: false, pairing: true, name: '', conn: null, rx: [], sealed: [], dropped: 0,
             lastScan: [], bonds: wd.bonds || {} };
// conn = {peer, role, verified, code (so periferico), wrong}
function linkOk() { return link.conn && link.conn.verified; }
env.CelerLink = {
    start: function(name, opts) {
        link.listening = true;
        link.name = typeof name === 'string' && name ? name.slice(0, 29) : 'Celer-' + myId();
        link.pairing = !(opts && opts.pairing === false);
        outbox.push({ t: 'ladv', on: true, name: link.name, pairing: link.pairing, at: S.millis() });
        return true;
    },
    stop: function() {
        link.listening = false;
        outbox.push({ t: 'ladv', on: false, at: S.millis() });
        return true;
    },
    scan: function(ms) {
        S.delay(typeof ms === 'number' ? ms : 2500);   // bloqueante (atravessa barreiras)
        link.lastScan = view.linkAdv.map(function(a) { return { id: a.id, name: a.name, rssi: a.rssi }; });
        return link.lastScan.slice(0);
    },
    connect: function(who, ms) {
        var tgt = null;
        for (var i = 0; i < link.lastScan.length; i++) {
            if (link.lastScan[i].id === who || link.lastScan[i].name === who) tgt = link.lastScan[i];
        }
        if (!tgt) return false;
        if (link.conn) env.CelerLink.disconnect();
        outbox.push({ t: 'lconn', peer: tgt.id, at: S.millis() });
        // a resposta (aceito, pede codigo) chega na proxima barreira
        var until = S.millis() + (typeof ms === 'number' ? Math.min(ms, 8000) : 4000);
        while (!link.conn && S.millis() < until) S.delay(50);
        return !!link.conn && link.conn.peer === tgt.id && (link.conn.verified || link.conn.needCode);
    },
    disconnect: function() {
        if (link.conn) outbox.push({ t: 'ldisc', at: S.millis() });
        link.conn = null;
        link.rx = [];
        return true;
    },
    verify: function(code) {
        if (!link.conn) return false;
        if (link.conn.verified) return true;
        if (link.conn.role !== 'central') return false;
        S.delay(300);
        var ok = String(code) === link.conn.peerCode;
        outbox.push({ t: 'lverify', ok: ok, at: S.millis() });
        if (ok) {
            link.conn.verified = true;
            link.conn.needCode = false;
            link.bonds[link.conn.peer] = true;
            // o verify do firmware so volta com o "liberado" do periferico:
            // um selo logo depois ja encontra o bond do outro lado
            S.delay(200);
        } else if (++link.conn.wrong >= 3) {
            link.conn = null;
        }
        return ok;
    },
    unpair: function(id) {
        if (id === undefined) { link.bonds = {}; return true; }
        if (!link.bonds[id]) return false;
        delete link.bonds[id];
        return true;
    },
    send: function(m) {
        var s = typeof m === 'object' ? JSON.stringify(m) : String(m);
        if (!linkOk() || s.length > 240) return false;
        outbox.push({ t: 'ltx', data: s, at: S.millis() });
        return true;
    },
    poll: function() { return link.rx.length ? link.rx.shift() : null; },
    sendSealed: function(m) {
        var s = typeof m === 'object' ? JSON.stringify(m) : String(m);
        if (s.length > 209) throw new RangeError('mensagem selada deve ter ate 209 bytes');
        if (!linkOk() || !link.bonds[link.conn.peer]) return false;
        outbox.push({ t: 'ltx', data: s, sealed: true, at: S.millis() });
        return true;
    },
    pollSealed: function() { return link.sealed.length ? link.sealed.shift() : null; },
    status: function() {
        var c = link.conn;
        return { connected: !!(c && c.verified), peer: c ? c.peer : '', listening: link.listening,
                 role: c ? c.role : '', name: link.name || ('Celer-' + myId()),
                 pairing: !!(c && !c.verified), verified: !!(c && c.verified),
                 code: c && !c.verified && c.role === 'peripheral' ? c.code : '',
                 mtu: c ? 247 : 0, rssi: c ? c.rssi : 0, pending: link.rx.length, dropped: link.dropped };
    }
};

// ---- caixa de entrada (do coordenador, na barreira) ---------------------
// No virtual (API 41): o PC no cabo deste no-gateway. pcId = 0xFF00 | byte
// baixo do gateway (packid::pcNodeOf); o que chega para ele vai a pcQ (o
// "celerctl mesh listen" do teste), nunca aos apps daqui.
var pc = { on: false, id: '', name: '', q: [] };
function pcIdOf(id) {
    var v = 0xFF00 | (parseInt(id, 16) & 0xFF);
    if (v === 0xFFFF) v = 0xFFFE;
    return v.toString(16).toUpperCase();
}

function deliver(ev) {
    if (ev.t === 'rx' && ev.toPc) {
        if (!net.active || !pc.on) return;
        if (ev.pack) {
            for (var k = 0; k < packSeen.length; k++) {
                if (packSeen[k] === ev.from + ':' + ev.pack.msgId) { stats.rxDup++; return; }
            }
            packSeen.push(ev.from + ':' + ev.pack.msgId);
            if (packSeen.length > 32) packSeen.shift();
            if (ev.pack.kind === 0) pc.q.push({ from: ev.from, fromName: ev.fromName, raw: false, data: ev.data });
            return;
        }
        pc.q.push({ from: ev.from, fromName: ev.fromName, raw: true, data: ev.data });
        return;
    }
    if (ev.t === 'rx') {
        if (!net.active) return;
        if (ev.pack) {
            for (var i = 0; i < packSeen.length; i++) {
                if (packSeen[i] === ev.from + ':' + ev.pack.msgId) { stats.rxDup++; return; }
            }
            packSeen.push(ev.from + ':' + ev.pack.msgId);
            if (packSeen.length > 32) packSeen.shift();
            if (ev.pack.kind === 3) { res.onEnvelope(ev.from, ev.fromName, ev.data); return; }
            if (ev.pack.kind === 1) {
                var ms = env.__harness.music;
                if (ms.playing) { log.push('[pack] festa recusada: alto-falante ocupado'); return; }
                var o = JSON.parse(ev.data);
                S.playMusic(o.song);
                ms.startAt = S.millis() - o.pos;
                log.push('[pack] festa chegou de ' + ev.fromName + ' @' + o.pos + 'ms');
                return;
            }
            packQ.push({ from: ev.from, fromName: ev.fromName, data: ev.data });
            if (packQ.length > 4) packQ.shift();
            return;
        }
        // mensagem crua com o magic do envelope: o servico Pack engole
        // (main/Pack/Pack.cpp: m.data[0] == 'P' && len >= 4) — nunca chega ao app
        if (ev.data.length >= 4 && ev.data.charAt(0) === 'P') { stats.swallowed++; return; }
        rxQ.push({ from: ev.from, fromName: ev.fromName, msg: ev.data, unicast: ev.unicast,
                   hops: ev.hops, rssi: ev.rssi });
        if (rxQ.length > 8) { rxQ.shift(); net.rxDropped++; }
    } else if (ev.t === 'relayed') {
        net.relayed += ev.n;
    } else if (ev.t === 'reldrop') {
        net.relayDropped += ev.n;   // anel do repetidor cheio (Info.relayDropped)
    } else if (ev.t === 'lconn') {
        // conexao estabelecida (central) ou recebida (periferico)
        link.conn = { peer: ev.peer, role: ev.role, rssi: ev.rssi, wrong: 0,
                      verified: ev.verified, needCode: !ev.verified,
                      code: ev.code || '', peerCode: ev.peerCode || '' };
        link.rx = [];
        if (ev.verified) link.bonds[ev.peer] = true;
    } else if (ev.t === 'lverified') {
        if (link.conn) { link.conn.verified = true; link.bonds[link.conn.peer] = true; }
    } else if (ev.t === 'ldisc') {
        link.conn = null;
    } else if (ev.t === 'lrx') {
        if (!link.conn) return;
        if (ev.sealed) {
            if (!link.bonds[link.conn.peer]) return;
            // tap do kernel (Provision): quadro "CNJ" nunca chega ao app
            if (String(ev.data).indexOf('CNJ') === 0) {
                var d = String(ev.data).slice(3);
                if (d === '!ok' || d === '!fail') {
                    if (invite.st === 'sent') invite.st = d === '!ok' ? 'ok' : 'fail';
                } else if (invite.st === 'waiting') {
                    var iv = JSON.parse(d);
                    setPack({ name: iv.n, key: iv.k });
                    invite.st = 'joined';
                    outbox.push({ t: 'ltx', data: 'CNJ!ok', sealed: true, at: S.millis() });
                }
                return;
            }
            link.sealed.push(ev.data);
            if (link.sealed.length > 2) link.sealed.shift();
        } else {
            link.rx.push(ev.data);
            if (link.rx.length > 8) { link.rx.shift(); link.dropped++; }
        }
    }
}

// ---- roteiro do teste (wire): acoes por tempo + respostas de prompt -----
var actions = [];
var prompts = [];
var sim = {
    at: function(ms, fn) { actions.push({ at: ms, fn: fn }); actions.sort(function(a, b) { return a.at - b.at; }); },
    prompts: function(list) { prompts = prompts.concat(list); },
    note: function(s) { log.push('[sim] ' + s); },
    // o "usuario" lendo o codigo na tela do periferico conectado
    peerCode: function() { return link.conn ? link.conn.peerCode : ''; },
    // gateway USB (no virtual, API 41): o cabo com res_share_usb=1
    pcAttach: function(on) {
        pc.on = on !== false;
        pc.id = pcIdOf(wd.id);
        pc.name = 'pc-' + wd.id;
        outbox.push({ t: 'proxy', on: pc.on, id: pc.id, name: pc.name, at: S.millis() });
        return pc.id;
    },
    pcSend: function(to, m) {   // SUB_SEND: envelope custom DO PC
        var dst = resolve(to);
        if (!pc.on || dst === null || !net.active) return false;
        packMsgId = (packMsgId + 1) & 0xFFFF;
        net.seq = (net.seq + 2) & 0xFFFF;
        var s = typeof m === 'object' ? JSON.stringify(m) : String(m);
        return enqueue({ t: 'tx', dst: dst, data: s, pack: { kind: 0, msgId: packMsgId }, ttl: 4,
                         copies: 2, urgent: false, seq: net.seq, as: pc.id }, s.length + 4, 2);
    },
    pcInbox: function() { var q = pc.q; pc.q = []; return q; },
    id: wd.id,
    name: wd.name
};
S.prompt = function(title) {
    log.push('[prompt] ' + title);
    S.delay(500);
    if (!prompts.length) return '';
    var p = prompts.shift();
    return String(typeof p === 'function' ? p() : p);
};

// ---- barreira -----------------------------------------------------------
var nextBarrier = (Math.floor(S.millis() / Q) + 1) * Q;
var origDelay = S.delay;
function sync() {
    var b = Math.floor(S.millis() / Q);
    var g0 = Atomics.load(gate, slot);
    wt.parentPort.postMessage({ t: 'sync', barrier: b, out: outbox });
    outbox = [];
    Atomics.wait(gate, slot, g0);
    gen++;
    // o lote desta barreira (postado ANTES do notify): drena sincrono
    for (;;) {
        var m = wt.receiveMessageOnPort(inbox);
        if (m === undefined) { Atomics.wait(gate, slot, Atomics.load(gate, slot), 2); continue; }
        var batch = m.message;
        // presenca que sumiu = evento de saida (handles com ele viram "lost")
        var gone = view.nodes.filter(function(o) {
            return !batch.nodes.some(function(n) { return n.id === o.id; });
        });
        gone.forEach(function(o) { res.memberLeft(o.id); });
        view.nodes = batch.nodes;
        view.linkAdv = batch.linkAdv;
        view.online = batch.online;
        for (var i = 0; i < batch.events.length; i++) deliver(batch.events[i]);
        if (batch.stop) stopNow = true;
        break;
    }
    nextBarrier = (b + 1) * Q;
}
var inAction = false;
S.delay = function(ms) {
    origDelay(ms);
    if (stopNow) throw { harnessStop: true };
    while (S.millis() >= nextBarrier) {
        sync();
        if (stopNow) throw { harnessStop: true };
        if (net.active) res.tick();
    }
    if (!inAction) {
        inAction = true;
        try {
            while (actions.length && actions[0].at <= S.millis()) actions.shift().fn(env, sim);
        } finally { inAction = false; }
    }
};

// wire do teste: corpo de funcao (env, sim) serializado pelo coordenador
if (wd.wire) (new Function('return (' + wd.wire + ');'))()(env, sim);
// caps e nome vem da especificacao do no; a placa aparece no getInfo
var info0 = S.getInfo;
S.getInfo = function() { var o = info0(); o.board = wd.board || 'host'; return o; };
if (wd.autoStart) env.CelerNet.start({ name: wd.name });

// ATENCAO: `res` acima e o motor de recursos — o resultado do runApp vive em
// `run` (houve um `var res` duplo aqui: depois da saida do app, res.tick()
// e res.memberLeft explodiam com TypeError ENGOLIDO pelo catch do loop e o
// no abandonava as barreiras em silencio, parando de ouvir/relayar cedo).
var run = H.runApp(wd.app, function(e2) {
    // runApp cria o proprio env: reaproveita o nosso (stubs ligados ao sim)
    for (var k in env) if (Object.prototype.hasOwnProperty.call(env, k)) e2[k] = env[k];
});
// relogio ainda andando? espera o fim da simulacao sem travar a barreira
var exitedAt = S.millis();
try {
    while (!stopNow) S.delay(Q);
} catch (e) { if (!e || !e.harnessStop) throw e; /* harnessStop = fim */ }
wt.parentPort.postMessage({
    t: 'done', err: run.err, log: log, exitedAt: exitedAt,
    music: { playing: env.__harness.music.playing, songs: env.__harness.music.songs,
             startAt: env.__harness.music.startAt },
    storage: env.__storage, stats: stats, net: env.CelerNet.status(),
    link: env.CelerLink.status(), sent: env.__harness.meshSent
});
