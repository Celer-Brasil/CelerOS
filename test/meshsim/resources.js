// meshsim/resources.js — recursos da matilha (API 36) num no simulado:
// porta JS de main/Pack/Resources.cpp com os mesmos tempos (lease 20 s,
// KEEP urgente a cada lease/4, reabertura no "expired", OPEN com 3 tentativas a cada 2,5 s, LIST fresco por
// 30 s, DESCRIBE no maximo 1 a cada 5 s por no) e os mesmos estados/motivos.
// O op viaja como JSON no envelope KIND_RES (3); wireLen e o tamanho do
// envelope binario do firmware (ResProto.h), que e o que ocupa o ar.
'use strict';

var LEASE_MS = 20000, OPEN_RETRY_MS = 2500, OPEN_TRIES = 3;
var CACHE_FRESH_MS = 30000, DESCRIBE_GAP_MS = 5000;
var HANDLES = 8, LEASES = 8, RX_DEPTH = 6, WR_DEPTH = 4, NAME_MAX = 15, MAX_DATA = 425;
var TYPES = ['data', 'mic', 'speaker', 'camera'];

// caps do BEAT -> nativos anunciados (sem FLAG_READY ate a R2/R3)
function natives(caps) {
    var l = [];
    if (caps & 0x02) l.push({ name: 'mic', type: 1, shared: false, ready: false, policy: 'res_share_mic' });
    if (caps & 0x01) l.push({ name: 'speaker', type: 2, shared: false, ready: false, policy: 'res_share_spk' });
    if (caps & 0x40) l.push({ name: 'camera', type: 3, shared: false, ready: false, policy: 'res_share_cam' });
    return l;
}

function wireLen(o) {
    switch (o.op) {
        case 'describe': return 1;
        case 'list': return 2 + o.list.reduce(function(a, e) { return a + 3 + e.name.length; }, 0);
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
    var local = natives(deps.caps).map(function(n) { n.app = false; return n; });
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
        leases = leases.filter(function(l) { return l.name !== name; });
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
                    return { name: x.name, type: x.type, shared: x.shared, ready: x.ready,
                             busy: !x.shared && leasesOf(x.name).length > 0 };
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
                // v3: mic e camera so na matilha privada
                else if ((x.type === 1 || x.type === 3) && !deps.secure) reason = 'denied';
                else if (x.policy && deps.setting(x.policy) === '0') reason = 'denied';
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
                leases = leases.filter(function(q) { return !(q.sid === o.sid && q.client === from); });
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
                    rx.push({ h: i, data: o.data });
                    if (rx.length > RX_DEPTH) rx.shift();
                    return;
                }
                for (var k = 0; k < leases.length; k++) {
                    l = leases[k];
                    if (l.sid === o.sid && l.client === from) {
                        l.expires = now() + LEASE_MS;
                        wr.push({ res: l.name, from: from, fromName: fromName, data: o.data });
                        if (wr.length > WR_DEPTH) wr.shift();
                    }
                }
                return;
        }
    }

    function tick() {
        var t = now();
        leases = leases.filter(function(l) {
            if (t - l.expires > 0) { deps.log('[res] sessao ' + l.sid + ': lease de ' + l.client + ' venceu'); return false; }
            return true;
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
                    out.push({ node: m.id, nodeName: m.name || c.name, name: e.name, type: type,
                               busy: !!e.busy, shared: !!e.shared, ready: !!e.ready });
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
        MAX_DATA: MAX_DATA
    };
    return { api: api, onEnvelope: onEnvelope, tick: tick, memberLeft: memberLeft };
}

module.exports = { create: create };
