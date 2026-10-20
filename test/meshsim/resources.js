// meshsim/resources.js — recursos da matilha (API 36/38) num no simulado:
// porta JS de main/Pack/Resources.cpp com os mesmos tempos (lease 20 s,
// KEEP urgente a cada lease/4, reabertura no "expired", OPEN com 3 tentativas a cada 2,5 s, LIST fresco por
// 30 s, DESCRIBE no maximo 1 a cada 5 s por no) e os mesmos estados/motivos.
// O op viaja como JSON no envelope KIND_RES (3); wireLen e o tamanho do
// envelope binario do firmware (ResProto.h), que e o que ocupa o ar.
'use strict';

var LEASE_MS = 20000, OPEN_RETRY_MS = 2500, OPEN_TRIES = 3;
var CACHE_FRESH_MS = 30000, DESCRIBE_GAP_MS = 5000;
var HANDLES = 8, LEASES = 8, RX_DEPTH = 6, WR_DEPTH = 4, NAME_MAX = 15, MAX_DATA = 425;
var TYPES = ['data', 'mic', 'speaker', 'camera', 'gpio', 'sensor'];

// caps do BEAT -> nativos anunciados (sem FLAG_READY ate a R2/R3).
// API 38: relés do no (deps.relays, exclusivos, interruptor res_share_gpio
// default "0") e sensores de placa (deps.sensors, compartilhados, leitura
// passiva com unidade/faixa no catalogo)
function natives(caps, deps) {
    var l = [];
    if (caps & 0x02) l.push({ name: 'mic', type: 1, shared: false, ready: false, policy: 'res_share_mic' });
    if (caps & 0x01) l.push({ name: 'speaker', type: 2, shared: false, ready: false, policy: 'res_share_spk' });
    if (caps & 0x40) l.push({ name: 'camera', type: 3, shared: false, ready: false, policy: 'res_share_cam' });
    var nr = deps.relays || 0;
    for (var i = 1; i <= nr; i++) {
        // ops do DATA (API 47): 1 write, 2 read, 3 pulso (ms), 4 pwm (%)
        l.push({ name: 'rele' + i, type: 4, shared: false, ready: true, policy: 'res_share_gpio',
                 schema: '{"off":1,"ops":"1234"}' });
    }
    (deps.sensors || []).forEach(function(s) {
        l.push({ name: s, type: 5, shared: true, ready: true, policy: 'res_share_sensor',
                 unit: '%', range: [0, 100] });
    });
    return l;
}


function wireLen(o) {
    switch (o.op) {
        case 'describe': return 1;
        case 'list': return 2 + o.list.reduce(function(a, e) {
            var n = 3 + e.name.length + 1;  // + mlen do LIST_META (API 38)
            if (e.unit) n += 2 + e.unit.length;
            if (e.range) n += 2 + 8;
            if (e.schema) n += 2 + e.schema.length;
            return a + n;
        }, 0);
        case 'open': return 4 + o.name.length + (o.params ? o.params.length : 0) + 8;  // + enlace ESP-NOW
        case 'accept': return 18;  // + transporte/canal/MAC/token
        case 'refuse': return 3;
        case 'keep': case 'close': return 3;
        case 'revoke': return 4;
        case 'data': return 5 + o.data.length;
    }
    return 1;
}

// deps: {S (System do harness), send(dst, obj, wireLen, urgent), members() -> [{id,name}],
//        log(s), caps, setting(key) -> string}
function create(deps) {
    var S = deps.S;
    var local = natives(deps.caps, deps).map(function(n) { n.app = false; return n; });
    var hw = {};   // "fisico" simulado: estado dos reles por nome (0/1)
    var pulses = {};  // nome -> ms do fim do pulso (API 47)
    // default do interruptor do dono (Resources.cpp/policyDefault): o atuador
    // nasce DESLIGADO; leitura nasce compartilhada. deps.setting volta null
    // quando o no nao definiu
    function policyVal(k) {
        var v = deps.setting(k);
        if (v === null || v === undefined) return k === 'res_share_gpio' ? '0' : '1';
        return String(v);
    }
    function sample() {  // leitura que muda com o tempo (prova amostras novas)
        return 40 + (Math.floor(now() / 3000) % 20);
    }
    var leases = [];       // {sid, client, name, expires}
    var nextSid = Math.floor(Math.random() * 0xFFFF);
    var h = [];            // handles
    var cache = {};        // id -> {fetched, asked, list, name}
    var rx = [];           // {h, data}
    var wr = [];           // {res, from, fromName, data}
    for (var i = 0; i < HANDLES; i++) h.push({ state: 'free', gen: 0 });

    function now() { return S.millis(); }
    function send(dst, o, urgent) { return deps.send(dst, JSON.stringify(o), wireLen(o), !!urgent); }
    function findLocal(name) {
        for (var i = 0; i < local.length; i++) if (local[i].name.toLowerCase() === String(name).toLowerCase()) return local[i];
        return null;
    }
    function leasesOf(name) { return leases.filter(function(l) { return l.name === name; }); }
    function revokeAll(name, reason) {
        leasesOf(name).forEach(function(l) { send(l.client, { op: 'revoke', sid: l.sid, reason: reason }, true); });
        leases = leases.filter(function(l) {
            if (l.name !== name) return true;
            if (l.autoOff) { hw[l.name] = 0; deps.log('[res] ' + l.name + ' desligou (fim da sessao)'); }
            return false;
        });
    }
    function bySid(node, sid) {
        for (var i = 0; i < HANDLES; i++) {
            if ((h[i].state === 'open' || h[i].state === 'opening') && h[i].node === node && h[i].sid === sid) return i;
        }
        return -1;
    }
    function sendOpen(i) {
        h[i].sent = now();
        h[i].tries++;
        send(h[i].node, { op: 'open', req: i + ':' + h[i].gen, name: h[i].name, params: h[i].params }, true);
    }

    function onEnvelope(from, fromName, raw) {
        var o;
        try { o = JSON.parse(raw); } catch (e) { return; }
        var i, l;
        switch (o.op) {
            case 'describe':
                send(from, { op: 'list', list: local.map(function(x) {
                    var e = { name: x.name, type: x.type, shared: x.shared, ready: x.ready,
                              busy: !x.shared && leasesOf(x.name).length > 0 };
                    if (x.unit) e.unit = x.unit;
                    if (x.range) e.range = x.range;
                    if (x.schema) e.schema = x.schema;
                    return e;
                }) });
                return;
            case 'list':
                cache[from] = cache[from] || { asked: 0 };
                cache[from].fetched = now() || 1;
                cache[from].list = o.list;
                cache[from].name = fromName;
                return;
            case 'open': {
                var x = findLocal(o.name), reason = '';
                if (!x) reason = 'notFound';
                // v3: mic e camera so na matilha privada; gpio (API 38) idem —
                // na aberta qualquer vizinho acenderia o rele
                else if ((x.type === 1 || x.type === 3 || x.type === 4) && !deps.secure) reason = 'denied';
                else if (x.policy && policyVal(x.policy) === '0') reason = 'denied';
                else if (!x.ready) reason = 'unsupported';
                else if (!x.shared && leasesOf(x.name).some(function(q) { return q.client !== from; })) reason = 'busy';
                if (!reason) {
                    l = null;
                    for (i = 0; i < leases.length; i++) if (leases[i].client === from && leases[i].name === x.name) l = leases[i];
                    if (!l && leases.length >= LEASES) reason = 'full';
                    else {
                        if (!l) {
                            nextSid = (nextSid + 1) & 0xFFFF || 1;
                            l = { sid: nextSid, client: from, name: x.name };
                            leases.push(l);
                            deps.log('[res] sessao ' + l.sid + ': ' + from + ' abriu "' + x.name + '"');
                        }
                        l.expires = now() + LEASE_MS;
                        // API 38: gpio com auto-off (fim do lease desliga) e
                        // sensor com taxa de amostragem (0 = so por pedido)
                        var pp = {};
                        try { pp = JSON.parse(o.params || '{}'); } catch (e2) { pp = {}; }
                        l.autoOff = x.type === 4 && pp.off === 1;
                        l.rate = x.type === 5 ? Math.max(0, pp.rate | 0) : 0;
                        // threshold (API 47): evento na transicao, histerese h,
                        // cooldown de 1 s por sessao (como SensorRes.cpp)
                        l.gt = x.type === 5 && pp.gt !== undefined ? Number(pp.gt) : null;
                        l.lt = x.type === 5 && pp.lt !== undefined ? Number(pp.lt) : null;
                        l.h = pp.h !== undefined ? Math.max(0, Number(pp.h)) : 0;
                        l.armedGt = l.gt !== null;
                        l.armedLt = l.lt !== null;
                        l.lastEvt = 0;
                        l.nextSample = 0;
                        send(from, { op: 'accept', req: o.req, sid: l.sid, leaseDs: LEASE_MS / 100 }, true);
                        return;
                    }
                }
                deps.log('[res] ' + from + ' pediu "' + o.name + '": ' + reason);
                send(from, { op: 'refuse', req: o.req, reason: reason }, true);
                return;
            }
            case 'accept': {
                i = parseInt(String(o.req).split(':')[0], 10);
                if (!(i >= 0 && i < HANDLES) || h[i].state !== 'opening' || h[i].node !== from ||
                    o.req !== i + ':' + h[i].gen) {
                    send(from, { op: 'close', sid: o.sid });
                    return;
                }
                h[i].state = 'open';
                h[i].sid = o.sid;
                h[i].sent = now();
                deps.log('[res] handle ' + i + ': "' + h[i].name + '" em ' + from + ' aberto');
                return;
            }
            case 'refuse':
                i = parseInt(String(o.req).split(':')[0], 10);
                if (i >= 0 && i < HANDLES && h[i].state === 'opening' && o.req === i + ':' + h[i].gen) {
                    h[i].state = 'refused';
                    h[i].reason = o.reason;
                }
                return;
            case 'keep':
                for (i = 0; i < leases.length; i++) {
                    if (leases[i].sid === o.sid && leases[i].client === from) { leases[i].expires = now() + LEASE_MS; return; }
                }
                send(from, { op: 'revoke', sid: o.sid, reason: 'expired' }, true);
                return;
            case 'close': {
                leases = leases.filter(function(q) {
                    if (!(q.sid === o.sid && q.client === from)) return true;
                    if (q.autoOff) { hw[q.name] = 0; deps.log('[res] ' + q.name + ' desligou (fim da sessao)'); }
                    return false;
                });
                return;  // CLOSE so cliente -> servidor (Resources.cpp)
            }
            case 'revoke':
                i = bySid(from, o.sid);
                if (i >= 0 && o.reason === 'expired') {
                    deps.log('[res] handle ' + i + ': sessao expirou, reabrindo');
                    h[i].state = 'opening';
                    h[i].sid = 0;
                    h[i].tries = 0;
                    h[i].gen++;
                    sendOpen(i);
                } else if (i >= 0) {
                    h[i].state = 'revoked';
                    h[i].reason = o.reason;
                    deps.log('[res] handle ' + i + ': revogado (' + o.reason + ')');
                }
                return;
            case 'data':
                i = bySid(from, o.sid);
                if (i >= 0) {
                    // evento de threshold (API 47): fila propria do handle
                    if (h[i].evt && o.data && o.data.ev) {
                        h[i].evts = h[i].evts || [];
                        h[i].evts.push({ v: o.data.v, dir: o.data.dir, at: o.data.ts });
                        return;
                    }
                    rx.push({ h: i, data: o.data });
                    if (rx.length > RX_DEPTH) rx.shift();
                    return;
                }
                for (var k = 0; k < leases.length; k++) {
                    l = leases[k];
                    if (l.sid === o.sid && l.client === from) {
                        l.expires = now() + LEASE_MS;
                        var x2 = findLocal(l.name);
                        // o write do cliente chega como string JSON
                        var d2 = o.data || {};
                        if (typeof d2 === 'string') { try { d2 = JSON.parse(d2); } catch (e3) { d2 = {}; } }
                        if (x2 && x2.type === 4) {  // gpio: atuacao na hora
                            if (d2.w !== undefined) hw[l.name] = d2.w ? 1 : 0;
                            else if (d2.r !== undefined) {
                                send(from, { op: 'data', sid: l.sid, data: { r: hw[l.name] || 0 } });
                            } else if (d2.p !== undefined) {  // pulso: liga agora, o tick desliga
                                hw[l.name] = 1;
                                pulses[l.name] = now() + Math.max(1, d2.p | 0);
                                deps.log('[res] ' + l.name + ' pulso de ' + (d2.p | 0) + 'ms');
                            } else if (d2.d !== undefined) {  // PWM em rele: RES_ERR (rede eletrica)
                                send(from, { op: 'data', sid: l.sid, data: { e: 255 } });
                            }
                        } else if (x2 && x2.type === 5) {  // sensor por pedido
                            if (d2.r !== undefined) {
                                send(from, { op: 'data', sid: l.sid, data: { v: sample(), ts: now() } });
                            }
                        } else {
                            wr.push({ res: l.name, from: from, fromName: fromName, data: o.data });
                            if (wr.length > WR_DEPTH) wr.shift();
                        }
                    }
                }
                return;
        }
    }

    function tick() {
        var t = now();
        leases = leases.filter(function(l) {
            if (t - l.expires > 0) {
                deps.log('[res] sessao ' + l.sid + ': lease de ' + l.client + ' venceu');
                if (l.autoOff) { hw[l.name] = 0; deps.log('[res] ' + l.name + ' desligou (fim da sessao)'); }
                return false;
            }
            return true;
        });
        // pulso vencido: desliga sozinho (GpioRes::tick no firmware)
        Object.keys(pulses).forEach(function(n) {
            if (t - pulses[n] >= 0) {
                delete pulses[n];
                if (hw[n]) { hw[n] = 0; deps.log('[res] ' + n + ' pulso terminou'); }
            }
        });
        // sensor em stream (rate > 0) e threshold (API 47): uma passada so.
        // O threshold avalia no rate (ou 1 s sem stream) e empurra o evento
        // no cruzamento; a histerese re-arma e o cooldown segura o ruido.
        leases.forEach(function(l) {
            var thr = l.gt !== null || l.lt !== null;
            var period = l.rate > 0 ? l.rate : (thr ? 1000 : 0);
            if (period === 0 || t - (l.nextSample || 0) < 0) return;
            l.nextSample = t + period;
            var v = sample();
            if (l.rate > 0) send(l.client, { op: 'data', sid: l.sid, data: { v: v, ts: t } });
            if (!thr) return;
            function fire(dir) {
                if (l.lastEvt && t - l.lastEvt < 1000) return;
                l.lastEvt = t;
                send(l.client, { op: 'data', sid: l.sid, data: { ev: 1, v: v, ts: t, dir: dir } });
            }
            if (l.gt !== null) {
                if (l.armedGt && v >= l.gt) { l.armedGt = false; fire('gt'); }
                else if (!l.armedGt && v <= l.gt - l.h) l.armedGt = true;
            }
            if (l.lt !== null) {
                if (l.armedLt && v <= l.lt) { l.armedLt = false; fire('lt'); }
                else if (!l.armedLt && v >= l.lt + l.h) l.armedLt = true;
            }
        });
        for (var i = 0; i < HANDLES; i++) {
            var x = h[i];
            if (x.state === 'opening' && t - x.sent >= OPEN_RETRY_MS) {
                if (x.tries >= OPEN_TRIES) { x.state = 'lost'; deps.log('[res] handle ' + i + ': sem resposta'); }
                else sendOpen(i);
            } else if (x.state === 'open' && t - x.sent >= LEASE_MS / 4) {
                x.sent = t;
                send(x.node, { op: 'keep', sid: x.sid }, true);
            }
        }
    }

    function memberLeft(id) {
        for (var i = 0; i < HANDLES; i++) {
            if ((h[i].state === 'open' || h[i].state === 'opening') && h[i].node === id) h[i].state = 'lost';
        }
    }

    function closeH(i) {
        if (!(i >= 0 && i < HANDLES)) return;
        if (h[i].state === 'open') send(h[i].node, { op: 'close', sid: h[i].sid });
        if (h[i].state !== 'free') h[i].state = 'closed';
        rx = rx.filter(function(m) { return m.h !== i; });
    }

    var api = {
        resources: function(only) {
            var out = [], t = now();
            deps.members().forEach(function(m) {
                var c = cache[m.id];
                var fresh = c && c.fetched && t - c.fetched < CACHE_FRESH_MS;
                if (!fresh && (!c || !c.asked || t - c.asked >= DESCRIBE_GAP_MS)) {
                    cache[m.id] = c = c || {};
                    c.asked = t;
                    send(m.id, { op: 'describe' });
                }
                if (!c || !c.fetched) return;
                c.list.forEach(function(e) {
                    var type = TYPES[e.type] || 'data';
                    if (only && only !== type) return;
                    var r = { node: m.id, nodeName: m.name || c.name, name: e.name, type: type,
                              busy: !!e.busy, shared: !!e.shared, ready: !!e.ready };
                    if (e.unit) r.unit = e.unit;
                    if (e.range) { r.min = e.range[0]; r.max = e.range[1]; }
                    if (e.schema) r.schema = e.schema;
                    out.push(r);
                });
            });
            return out;
        },
        open: function(node, name, params) {
            if (!name || name.length > NAME_MAX) return -1;
            var i, slot = -1;
            for (i = 0; i < HANDLES && slot < 0; i++) if (h[i].state === 'free') slot = i;
            for (i = 0; i < HANDLES && slot < 0; i++) if (h[i].state !== 'open' && h[i].state !== 'opening') slot = i;
            if (slot < 0) return -1;
            h[slot] = { state: 'opening', gen: h[slot].gen + 1, tries: 0, node: node, name: name,
                        params: params || '', reason: '', sid: 0 };
            // sessao com threshold (API 47): o DATA de evento vira fila propria
            var pp = {};
            try { pp = JSON.parse(params || '{}'); } catch (e) { pp = {}; }
            h[slot].evt = pp.gt !== undefined || pp.lt !== undefined;
            h[slot].evts = [];
            sendOpen(slot);
            return slot;
        },
        status: function(i) {
            if (!(i >= 0 && i < HANDLES) || h[i].state === 'free') return null;
            // o sim nao modela o ESP-NOW: toda sessao vai pela malha
            return { state: h[i].state, reason: h[i].reason || '', node: h[i].node, name: h[i].name,
                     via: h[i].state === 'open' ? 'mesh' : '' };
        },
        read: function(i) {
            for (var k = 0; k < rx.length; k++) {
                if (rx[k].h === i) return rx.splice(k, 1)[0].data;
            }
            return null;
        },
        // evento de threshold pendente (API 47) ou null
        onEvent: function(i) {
            if (!(i >= 0 && i < HANDLES)) return null;
            return h[i].evts && h[i].evts.length ? h[i].evts.shift() : null;
        },
        write: function(i, data) {
            if (!(i >= 0 && i < HANDLES) || h[i].state !== 'open') return false;
            return send(h[i].node, { op: 'data', sid: h[i].sid, data: data });
        },
        close: closeH,
        expose: function(name, shared) {
            if (!name || name.length > NAME_MAX || findLocal(name) || local.length >= 12) return false;
            local.push({ name: name, type: 0, shared: shared, ready: true, app: true });
            return true;
        },
        unexpose: function(name) {
            var x = findLocal(name);
            if (!x || !x.app) return false;
            revokeAll(x.name, 'gone');
            local = local.filter(function(q) { return q !== x; });
            return true;
        },
        publish: function(name, data) {
            var x = findLocal(name);
            if (!x || !x.app) return -1;
            var n = 0;
            leasesOf(x.name).forEach(function(l) { if (send(l.client, { op: 'data', sid: l.sid, data: data })) n++; });
            return n;
        },
        sessions: function(name) {
            var x = findLocal(name);
            return x ? leasesOf(x.name).length : -1;
        },
        pollWrite: function() { return wr.length ? wr.shift() : null; },
        relayState: function(name) { return hw[name] === undefined ? -1 : hw[name]; },
        MAX_DATA: MAX_DATA
    };
    return { api: api, onEnvelope: onEnvelope, tick: tick, memberLeft: memberLeft };
}

module.exports = { create: create };
