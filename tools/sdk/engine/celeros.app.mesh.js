// app.mesh.js — CelerKit MESH (dep "celeros.app.mesh"): o protocolo de app
// sobre a malha CelerNet (o padrao do Sonar generalizado) — familia de
// prefixos, pedido/resposta com correlacao por nonce, dedup de replay e
// cache com TTL. Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.mesh");      // puxa celeros.mesh (gate, me, drain)
//   A.mesh.family("t");               // 1a letra dos quadros DESTE app
//                                     // (unica na malha: "s" e do Sonar)
//
//   // pergunta com resposta (bloqueia o CALLER nao; a resposta chega no each):
//   A.mesh.req(no.id, "?", "temp", function (data, from) {
//       if (data === null) t.note("sem resposta");
//       else t.note(from + ": " + data);
//   });
//
//   A.run({ tela: function (c) {
//       if (!A.mesh.gate("Precisa da malha...")) return;
//       A.mesh.each(function (from, op, rest, m) { ... });  // 1x por frame
//   }}, "tela");
//
// Formato do quadro (cabe nos 434 B do CelerNet):
//   pedido    FAM + op + payload + nonce(2)   ex.: "t?temp07"
//   resposta  FAM + "=" + nonce(2) + "|" + dados   ex.: "t=07|23.5"
//   broadcast FAM + "*" + payload            (sem nonce)
// Quadros de outra familia caem no handler com op "" (o app decide ignorar).

var A = require('celeros.app');
var mesh = require('celeros.mesh');

A.mesh = {
    version: '1.0.1',
    _fam: 'a',
    _seq: 0,
    _pend: {},          // nonce -> {fn}
    _seen: [],          // nonces respondidos (dedup de replay)
    _cache: {},

    // 1a letra dos quadros do app — escolha UMA por app e mantenha
    family: function (ch) { A.mesh._fam = String(ch).charAt(0) || 'a'; },

    // portais do celeros.mesh (o app raramente precisa das duas familias)
    available: function () { return mesh.available(); },
    active: function () { return mesh.active(); },
    gate: function (msg, o) { return mesh.gate(msg, o); },
    me: function () { return mesh.me(); },
    nodes: function () {
        try { return CelerNet.nodes(); } catch (e) { return []; }
    },

    // envia quadro da familia: send(to, op, payload, {copies, urgent}) ou
    // broadcast com o.ttl
    send: function (to, op, payload, o) {
        var s = A.mesh._fam + op + (payload || '');
        try {
            if (o && o.ttl !== undefined) return !!CelerNet.broadcast(s, o.ttl);
            return !!CelerNet.send(to, s, o || { copies: 1 });
        } catch (e) { return false; }
    },

    /**
     * Pedido com resposta esperada. cb(data, from) dispara quando o quadro
     * "FAM=" com o mesmo nonce chega (via each); data === null = timeout
     * (default 4 s). Devolve true se o pedido entrou na fila do radio.
     */
    req: function (to, op, payload, cb, timeoutMs) {
        var ms = timeoutMs || 4000;
        // nonce base36 de 2 chars, deterministico pela sequencia (1296 ids)
        var seq = (A.mesh._seq = (A.mesh._seq + 1) % 1296);
        var b36 = '0123456789abcdefghijklmnopqrstuvwxyz';
        var nonce = b36.charAt(Math.floor(seq / 36)) + b36.charAt(seq % 36);
        A.mesh._pend[nonce] = { fn: cb };
        setTimeout(function () {
            var p = A.mesh._pend[nonce];
            if (p && p.fn) {
                p.fn = null;
                delete A.mesh._pend[nonce];
                cb(null, null);
            }
        }, ms);
        return A.mesh.send(to, op, (payload || '') + nonce, { copies: 1 });
    },

    // nonce ja respondido? (replay do relay nao refaz o callback)
    _fresh: function (n) {
        var s = A.mesh._seen;
        if (s.indexOf(n) >= 0) return false;
        s.push(n);
        if (s.length > 32) s.shift();
        return true;
    },

    /**
     * Drena a fila de quadros (chame 1x por frame). Respostas dos req()
     * pendentes disparam os callbacks; os outros quadros da familia vao ao
     * handler(from, op, rest, m); quadros de OUTRA familia chegam com op "".
     * Resposta "=" SEM req() pendente (ex.: o app perguntou em broadcast e N
     * nos responderam) tambem vai ao handler com op "=" e rest "NN|dados" —
     * antes era engolida, e consulta com multiplas respostas era impossivel.
     * Devolve quantos quadros processou.
     */
    each: function (handler) {
        var n = 0, m;
        while ((m = CelerNet.poll()) !== null) {
            n++;
            var msg = String(m.msg === undefined || m.msg === null ? '' : m.msg);
            if (msg.charAt(0) !== A.mesh._fam) {
                handler(m.from, '', msg, m);
                continue;
            }
            var op = msg.charAt(1);
            var rest = msg.substring(2);
            if (op === '=') {
                var nonce = rest.substring(0, 2);
                var p = A.mesh._pend[nonce];
                if (p && p.fn && A.mesh._fresh(nonce)) {
                    var fn = p.fn;
                    p.fn = null;
                    delete A.mesh._pend[nonce];
                    fn(rest.length > 3 ? rest.substring(3) : '', m.from);
                } else if (!p && A.mesh._fresh(nonce)) {
                    handler(m.from, '=', rest, m);   // resposta orfa (dedup de replay)
                }
                continue;
            }
            handler(m.from, op, rest, m);
        }
        return n;
    },

    // cache TTL de leituras da malha (sensores custam um pedido inteiro):
    // cache("temp:A1B2", 60000, function () { ...busca... })
    cache: function (k, ms, fill) {
        var c = A.mesh._cache[k];
        var now = System.millis();
        if (c && (now - c.at) < ms) return c.v;
        var v = fill();
        A.mesh._cache[k] = { at: now, v: v };
        return v;
    }
};

A._mods.push('mesh');

module.exports = A;
