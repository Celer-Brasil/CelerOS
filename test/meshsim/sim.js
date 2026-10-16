// meshsim/sim.js — coordenador da malha simulada: N apps REAIS (um worker
// por no, node.js) num relogio virtual comum, com o ar modelado no nivel
// que importa para os apps:
//
//   - flood com TTL/saltos e dedup por (origem, seq), como o CelerNet v2:
//     quem ouve um quadro novo entrega (broadcast ou unicast endereçado a
//     ele) e, se repetidor e ttl > 1, repete depois de um jitter;
//   - mensagem = ceil(len/14) quadros (<= 16 B cabe em 1); cada salto
//     perde a mensagem com prob. 1 - (1 - perda)^quadros (basta um
//     fragmento perdido para nao remontar);
//   - fila de TX por no a 8 quadros/s (token bucket do firmware), teto de
//     96 quadros (PENDING_DEPTH) e copias de unicast espacadas ~1,5 s;
//   - presenca (BEAT a cada 3 s, alcance 4 saltos, some 15 s depois de
//     perder o caminho) com rssi do ultimo salto e caps do papel;
//   - Pack: envelopes deduplicados por msgId, handoff de musica e o
//     servico que ENGOLE mensagem crua iniciada por 'P' (len >= 4);
//   - CelerLink: advertising, scan (vizinho direto), connect, pareamento
//     por codigo de 6 digitos com bond, send/poll e selados.
//
// Uso: runMesh(spec) -> Promise({nodes: {nome: resultado}, air: [...]})
//   spec = { nodes: [{name, id, app, caps, board, wire(env, sim), autoStart}],
//            links: [[a, b, rssi, perda]], durationMs, quantumMs, seed,
//            events: [{at, offline: nome} | {at, online: nome}] }
// Tempos em ms do relogio virtual (todo no comeca em 1000, como o harness).
'use strict';
var wt = require('worker_threads');
var path = require('path');

var ROOT = path.resolve(__dirname, '..', '..');
var T0 = 1000;
var FRAME_MS = 125;          // 8 quadros/s por no (K_TOKEN_REFILL_PER_S)
var PENDING_DEPTH = 96;
var COPY_GAP_MS = 1500;      // copias de unicast espacadas (c702377)
var NODE_TTL_MS = 15000;
// Histerese do firmware (CelerNet.cpp nodeExpired): no com fila de TX
// pendente esta surdo (cada burst desliga o scanner) e nao expira par pelo
// TTL normal — so no teto duro de 4x TTL. "Pressao" no sim = TX proprio
// drenando (txFree no futuro) ou repeticoes pendentes no anel.
var NODE_TTL_CAP_MS = 4 * NODE_TTL_MS;
var BEAT_MS = 3000;
var BEAT_TTL = 4;

function rng(seed) {
    var s = seed >>> 0;
    return function() {
        s = (s + 0x6D2B79F5) >>> 0;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function frames(len) { return len <= 16 ? 1 : Math.ceil(len / 14); }

function runMesh(spec) {
    var Q = spec.quantumMs || 50;
    var END = T0 + (spec.durationMs || 30000);
    var rand = rng(spec.seed || 1);
    var N = spec.nodes.length;
    var sab = new SharedArrayBuffer(4 * N);
    var gate = new Int32Array(sab);
    var byName = {};
    var nodes = spec.nodes.map(function(n, i) {
        var id = (n.id || ('A' + (i + 1) + 'C' + (i + 1))).toUpperCase();
        var st = {
            i: i, spec: n, id: id, name: n.name, caps: n.caps || 0,
            online: true, netActive: false, relay: true, netName: n.name,
            // CelerNet v3: a chave da rede e nome + senha da matilha (sem
            // matilha = a "celer" aberta). Chave diferente = quadro que nao
            // autentica: nem entrega, nem repete, nem presenca
            netKey: n.pack ? n.pack.name + '\u0000' + n.pack.pass : 'celer',
            txFree: 0, seen: {}, delivered: {}, inbox: [], relayed: 0,
            relayPending: 0, relayDropped: 0,
            waiting: false, barrier: 0, done: null,
            lastReach: {}, lastInfo: {},
            ladv: false, lpairing: true, lname: '', session: null, bonds: {}, wrong: 0,
            proxy: null          // no virtual (PC no cabo, API 41): {id, name}
        };
        byName[n.name] = st;
        return st;
    });
    var byId = {};
    nodes.forEach(function(n) { byId[n.id] = n; });

    // adjacencia (simetrica) com rssi e perda por mensagem-quadro
    var adj = {};
    nodes.forEach(function(n) { adj[n.id] = []; });
    (spec.links || []).forEach(function(l) {
        var a = byName[l[0]], b = byName[l[1]];
        if (!a || !b) throw new Error('link com no desconhecido: ' + l);
        var e = { rssi: l[2] === undefined ? -60 : l[2], loss: l[3] || 0 };
        adj[a.id].push({ to: b, rssi: e.rssi, loss: e.loss });
        adj[b.id].push({ to: a, rssi: e.rssi, loss: e.loss });
    });

    var air = [];                 // trilha: o que saiu (origem) e o que chegou
    var q = [];                   // eventos do ar: {time, fn}
    var evSeq = 0;
    function schedule(time, fn) {
        q.push({ time: time, n: evSeq++, fn: fn });
    }
    function runAirUntil(T) {
        for (;;) {
            var best = -1;
            for (var i = 0; i < q.length; i++) {
                if (q[i].time <= T && (best < 0 || q[i].time < q[best].time ||
                    (q[i].time === q[best].time && q[i].n < q[best].n))) best = i;
            }
            if (best < 0) return;
            var e = q.splice(best, 1)[0];
            e.fn(e.time);
        }
    }
    var timeline = (spec.events || []).slice(0).sort(function(a, b) { return a.at - b.at; });

    function hearable(a, b) {
        return a.online && b.online && a.netActive && b.netActive && a.netKey === b.netKey;
    }

    // um no (origem ou repetidor) poe a mensagem no ar a partir de t;
    // devolve o instante de PARTIDA (null se o no esta fora/sem malha) —
    // o anel de relay do repetidor so libera o slot quando o quadro sai
    function emit(from, msg, ttl, hops, t, urgent) {
        if (!from.online || !from.netActive) return null;
        var fr = frames(msg.wireLen || msg.len);
        var depart = urgent ? t : Math.max(t, from.txFree);
        if (!urgent) from.txFree = depart + fr * FRAME_MS;
        var arrive = depart + fr * FRAME_MS;
        adj[from.id].forEach(function(e) {
            var to = e.to;
            if (Math.pow(1 - e.loss, fr) < 1 && rand() > Math.pow(1 - e.loss, fr)) return;
            schedule(arrive + Math.floor(rand() * 30), function(tt) {
                if (!hearable(from, to)) return;
                hear(to, from, e.rssi, msg, ttl, hops + 1, tt);
            });
        });
        return depart;
    }
    function hear(node, via, rssi, msg, ttl, hops, t) {
        if (node.id === msg.src.id) return;
        if (node.seen[msg.key]) return;
        node.seen[msg.key] = true;
        // copias de mensagem fragmentada dividem a identidade: o destino
        // junta frags de qualquer uma e entrega UMA vez (o relay segue)
        var dup = msg.group && node.delivered[msg.group];
        if (msg.group) node.delivered[msg.group] = true;
        var toPc = !!(node.proxy && msg.dst === node.proxy.id);   // no virtual do gateway
        if (!dup && (msg.dst === null || msg.dst === node.id || toPc)) {
            node.inbox.push({ at: t, ev: { t: 'rx', from: msg.fromId || msg.src.id,
                                           fromName: msg.fromName || msg.src.netName,
                                           data: msg.data, unicast: msg.dst !== null, hops: hops,
                                           rssi: rssi, pack: msg.pack || null, toPc: toPc } });
            air.push({ t: t, kind: 'rx', to: node.name, from: msg.src.name, data: msg.data, hops: hops });
        }
        if (node.relay && ttl > 1) {
            // fragmento: relay fora da frente (jitter largo, c702377)
            var fr = frames(msg.wireLen || msg.len);
            var jit = fr > 1 ? 300 + Math.floor(rand() * 600) : 40 + Math.floor(rand() * 200);
            // Anel de relay (PENDING_DEPTH do firmware): a mensagem inteira
            // entra ou e descartada CONTADA — relayDropped visivel no status
            // do JS, como o Info.relayDropped do CelerNet
            if (node.relayPending + fr > PENDING_DEPTH) {
                node.relayDropped += fr;
                node.inbox.push({ at: t, ev: { t: 'reldrop', n: fr } });
                return;
            }
            node.relayPending += fr;
            node.relayed += fr;
            node.inbox.push({ at: t, ev: { t: 'relayed', n: fr } });
            schedule(t + jit, function(tt) {
                var depart = emit(node, msg, ttl - 1, hops, tt, false);
                if (depart === null) {
                    node.relayPending -= fr;   // fora do ar: slot consumido
                } else {
                    // slot livre quando o quadro sai no ar (como o firmware
                    // libera o Pending no adv_start, nao no jitter)
                    schedule(depart, function() { node.relayPending -= fr; });
                }
            });
        }
    }

    function onTx(n, ev) {
        var len = ev.wireLen ? ev.wireLen + (ev.pack ? 4 : 0) : ev.data.length + (ev.pack ? 4 : 0);
        air.push({ t: ev.at, kind: 'tx', from: n.name, dst: ev.dst, data: ev.data, frames: frames(len),
                   copies: ev.copies, pack: ev.pack ? ev.pack.kind : null });
        for (var c = 0; c < ev.copies; c++) {
            var asPc = ev.as && n.proxy && n.proxy.id === ev.as;  // SUB_SEND: em nome do PC
            var msg = { key: n.id + ':' + ((ev.seq - c) & 0xFFFF), src: n, dst: ev.dst, data: ev.data,
                        fromId: asPc ? n.proxy.id : null, fromName: asPc ? n.proxy.name : null,
                        len: len, wireLen: ev.wireLen ? len : 0, pack: ev.pack || null,
                        group: len > 16 && ev.copies > 1 ? n.id + ':g' + ev.seq : null };
            (function(msg, c) {
                schedule(ev.at + c * COPY_GAP_MS, function(tt) {
                    if (!n.online || !n.netActive) return;
                    emit(n, msg, ev.ttl, 0, tt, ev.urgent);
                });
            })(msg, c);
        }
    }

    // ---- CelerLink: sessao ponto a ponto entre vizinhos diretos ---------
    function adjEdge(a, b) {
        var l = adj[a.id];
        for (var i = 0; i < l.length; i++) if (l[i].to === b) return l[i];
        return null;
    }
    function dropSession(a, t) {
        var s = a.session;
        if (!s) return;
        var b = byId[s.peer];
        a.session = null;
        a.inbox.push({ at: t, ev: { t: 'ldisc' } });
        if (b && b.session && b.session.peer === a.id) {
            b.session = null;
            b.inbox.push({ at: t + 20, ev: { t: 'ldisc' } });
        }
    }
    function onLink(n, ev) {
        if (ev.t === 'ladv') {
            n.ladv = ev.on;
            if (ev.on) { n.lpairing = ev.pairing; n.lname = ev.name; }
        } else if (ev.t === 'lconn') {
            var p = byId[ev.peer];
            var e = p && adjEdge(n, p);
            if (!p || !e || !p.ladv || p.session || !n.online || !p.online) return;
            var bonded = !!(n.bonds[p.id] && p.bonds[n.id]);
            var verified = !p.lpairing || bonded;
            var code = ('00000' + Math.floor(rand() * 1000000)).slice(-6);
            n.session = { peer: p.id, role: 'central', verified: verified };
            p.session = { peer: n.id, role: 'peripheral', verified: verified };
            p.wrong = 0;
            n.inbox.push({ at: ev.at + 300, ev: { t: 'lconn', peer: p.id, role: 'central', rssi: e.rssi,
                                                  verified: verified, peerCode: code } });
            p.inbox.push({ at: ev.at + 300, ev: { t: 'lconn', peer: n.id, role: 'peripheral', rssi: e.rssi,
                                                  verified: verified, code: code } });
            air.push({ t: ev.at, kind: 'link', from: n.name, to: p.name, verified: verified });
        } else if (ev.t === 'lverify') {
            var s = n.session;
            if (!s) return;
            var peer = byId[s.peer];
            if (ev.ok) {
                s.verified = true;
                n.bonds[peer.id] = true;
                peer.bonds[n.id] = true;
                if (peer.session) peer.session.verified = true;
                peer.inbox.push({ at: ev.at + 100, ev: { t: 'lverified' } });
            } else if (++peer.wrong >= 3) {
                dropSession(n, ev.at);
            }
        } else if (ev.t === 'ltx') {
            var ss = n.session;
            if (!ss || !ss.verified) return;
            var to = byId[ss.peer];
            if (!to.online || !n.online) return;
            to.inbox.push({ at: ev.at + 40, ev: { t: 'lrx', data: ev.data, sealed: !!ev.sealed } });
            air.push({ t: ev.at, kind: 'ltx', from: n.name, to: to.name, data: ev.data });
        } else if (ev.t === 'ldisc') {
            dropSession(n, ev.at);
        }
    }

    // ---- presenca vista por um no no instante T -------------------------
    // Pressao de TX do no (histerese do nodeExpired do firmware): fila
    // propria drenando (txFree no futuro) ou repeticoes pendentes no anel
    function underPressure(n, T) {
        return T < n.txFree || n.relayPending > 0;
    }
    function presence(n, T) {
        if (!n.online || !n.netActive) return [];
        var dist = {}, first = {};
        dist[n.id] = 0;
        var frontier = [n];
        for (var h = 1; h <= BEAT_TTL && frontier.length; h++) {
            var nxt = [];
            frontier.forEach(function(u) {
                adj[u.id].forEach(function(e) {
                    var v = e.to;
                    if (dist[v.id] !== undefined || !hearable(u, v) || e.loss >= 1) return;
                    // so repetidores propagam o BEAT dos outros
                    if (u !== n && !u.relay) return;
                    dist[v.id] = h;
                    first[v.id] = u === n ? e.rssi : first[u.id];
                    nxt.push(v);
                });
            });
            frontier = nxt;
        }
        var out = [];
        nodes.forEach(function(m) {
            if (m === n) return;
            if (dist[m.id] !== undefined) {
                // o 1o BEAT so chega depois que o no ligou (fase por no)
                if (n.lastReach[m.id] === undefined && T - Math.max(m.netSince, n.netSince) < 600 + (m.i * 400) % BEAT_MS) return;
                n.lastReach[m.id] = T;
                n.lastInfo[m.id] = { hops: dist[m.id], rssi: first[m.id] };
            }
            var lr = n.lastReach[m.id];
            if (lr === undefined) return;
            var age = T - lr;
            // mesmo criterio do sweep do firmware: sai no TTL normal quando
            // o no esta ouvindo bem; surdo (pressao de TX), so no teto 4x
            if (age >= NODE_TTL_MS && (age >= NODE_TTL_CAP_MS || !underPressure(n, T))) return;
            var age = dist[m.id] !== undefined ? Math.floor(((T + m.i * 977) % BEAT_MS) / 1000)
                                               : Math.floor((T - lr) / 1000) + 2;
            out.push({ id: m.id, name: m.netName, caps: m.caps, rssi: n.lastInfo[m.id].rssi,
                       hops: n.lastInfo[m.id].hops, lastSeen: age });
            // BEAT proxy do gateway alcancavel agora: o PC dele e membro (caps HUB)
            if (m.proxy && dist[m.id] !== undefined) {
                out.push({ id: m.proxy.id, name: m.proxy.name, caps: 0x20, rssi: n.lastInfo[m.id].rssi,
                           hops: n.lastInfo[m.id].hops, lastSeen: age });
            }
        });
        out.sort(function(a, b) { return b.rssi - a.rssi; });
        return out;
    }
    function linkAdv(n) {
        if (!n.online) return [];
        var out = [];
        adj[n.id].forEach(function(e) {
            var m = e.to;
            if (m.ladv && m.online && !m.session) out.push({ id: m.id, name: m.lname, rssi: e.rssi });
        });
        out.sort(function(a, b) { return b.rssi - a.rssi; });
        return out;
    }

    return new Promise(function(resolve, reject) {
        var workers = [];
        var pending = N;
        var G = 0;
        var failed = null;

        function tryAdvance() {
            var live = nodes.filter(function(n) { return !n.done; });
            if (!live.length) return;
            if (!live.every(function(n) { return n.waiting; })) return;
            G = Math.min.apply(null, live.map(function(n) { return n.barrier; }));
            var T = G * Q;
            // linha do tempo do cenario (queda/volta de nos)
            while (timeline.length && timeline[0].at <= T) {
                var ev = timeline.shift();
                var who = byName[ev.offline || ev.online];
                if (ev.offline) {
                    who.online = false;
                    if (who.session) dropSession(who, ev.at);
                    air.push({ t: ev.at, kind: 'offline', from: who.name });
                } else {
                    who.online = true;
                    air.push({ t: ev.at, kind: 'online', from: who.name });
                }
            }
            runAirUntil(T);
            live.forEach(function(n) {
                if (n.barrier > G) return;
                var due = [], keep = [];
                n.inbox.forEach(function(x) { (x.at <= T ? due : keep).push(x); });
                due.sort(function(a, b) { return a.at - b.at; });
                n.inbox = keep;
                n.waiting = false;
                workers[n.i].port.postMessage({
                    nodes: presence(n, T), linkAdv: linkAdv(n), online: n.online,
                    events: due.map(function(x) { return x.ev; }), stop: T >= END
                });
                Atomics.add(gate, n.i, 1);
                Atomics.notify(gate, n.i);
            });
        }

        nodes.forEach(function(n, i) {
            var ch = new wt.MessageChannel();
            var w = new wt.Worker(path.join(__dirname, 'node.js'), {
                workerData: {
                    sab: sab, index: i, port: ch.port2, quantumMs: Q,
                    seed: ((spec.seed || 1) * 7919 + i * 104729) >>> 0,
                    id: n.id, name: n.spec.name, caps: n.caps, board: n.spec.board || 'host',
                    app: n.spec.app, autoStart: n.spec.autoStart !== false,
                    wire: n.spec.wire ? n.spec.wire.toString() : null,
                    settings: n.spec.settings || null,
                    pack: n.spec.pack || null,
                    relays: n.spec.relays || 0,      // API 38: reles do no
                    sensors: n.spec.sensors || null  // API 38: sensores de placa
                },
                transferList: [ch.port2]
            });
            workers.push({ w: w, port: ch.port1 });
            n.netSince = T0;
            w.on('message', function(m) {
                if (m.t === 'sync') {
                    m.out.forEach(function(ev) {
                        if (ev.t === 'tx') onTx(n, ev);
                        else if (ev.t === 'proxy') n.proxy = ev.on ? { id: ev.id, name: ev.name } : null;
                        else if (ev.t === 'netkey') {
                            // Pack.join / convite (API 40): chave nova e, como o
                            // CelerNet::netChanged, a presenca propria zera
                            n.netKey = ev.key;
                            n.lastReach = {};
                            n.lastInfo = {};
                        }
                        else if (ev.t === 'net') {
                            if (ev.active && !n.netActive) n.netSince = ev.at;
                            n.netActive = ev.active;
                            if (ev.active) { n.netName = ev.name; n.relay = ev.relay; }
                        } else onLink(n, ev);
                    });
                    n.barrier = m.barrier;
                    n.waiting = true;
                    tryAdvance();
                } else if (m.t === 'done') {
                    n.done = m;
                    n.done.relayed = n.relayed;
                    n.done.relayDropped = n.relayDropped;
                    pending--;
                    w.terminate();
                    if (pending === 0) finish();
                    else tryAdvance();
                }
            });
            w.on('error', function(e) {
                failed = failed || e;
                n.done = { err: String(e && e.stack || e), log: [] };
                pending--;
                if (pending === 0) finish(); else tryAdvance();
            });
        });

        function finish() {
            if (failed && !spec.tolerateWorkerErrors) { /* erro vira resultado do no */ }
            var out = {};
            nodes.forEach(function(n) { out[n.name] = n.done; });
            resolve({ nodes: out, air: air });
        }
    });
}

module.exports = { runMesh: runMesh, T0: T0 };
