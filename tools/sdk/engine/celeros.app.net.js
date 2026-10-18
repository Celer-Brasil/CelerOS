// app.net.js — CelerKit NET (dep "celeros.app.net"): a rede bloqueante do
// firmware embrulhada do jeito que os apps usam — todo erro vira null/false
// (o Net cru ESTOURA e derruba o app sem try/catch), retry com backoff e
// download com MD5. A TELA de "espera o Wi-Fi" fica no core (A.wifiWait).
//
//   var A = require("celeros.app");
//   require("celeros.app.net");
//   var cat = A.net.getJSON(url);            // null se caiu/quebrou
//   cat = A.net.retry(function () { return A.net.getJSON(url); });  // 3 tentativas
//   if (!cat && !A.net.online()) A.wifiWait();   // padrao de app de rede
//
//   // arquivo com integridade (mesmo contrato do install da loja):
//   if (!A.net.fetch(urlZip, "/local/x.new", "a1b2c3...", onProg)) A.error(...);
//
// Retry e BLOQUEANTE com System.delay (bombeia o present, renova a janela
// do exec-timeout) — setTimeout nos apps so dispara no proximo frame, nao
// serve para "esperar e tentar de novo" no meio de uma acao do usuario.

var A = require('celeros.app');

A.net = {
    version: '1.0.0',

    // ligado? (false se o global Net nem existe — build sem rede)
    online: function () {
        try { return !!Net.isConnected(); } catch (e) { return false; }
    },

    // GET que nunca estoura: null em qualquer erro/fora da rede
    getJSON: function (url) {
        try { return Net.getJSON(url); } catch (e) { return null; }
    },
    getText: function (url) {
        try { return Net.get(url); } catch (e) { return null; }
    },
    post: function (url, body, mime) {
        try { return Net.post(url, body, mime); } catch (e) { return null; }
    },

    // retry(fn, o): roda fn() e, se o resultado nao "serve", tenta de novo.
    //   o.n       tentativas EXTRAS (default 2 — 3 no total)
    //   o.backoff base da espera ms (default 1500; dobra a cada tentativa, teto x8)
    //   o.ok(v)   predicado do que "serve" (default: v !== null && v !== false)
    // Devolve o ULTIMO resultado (bom ou nao). Bloqueia entre tentativas.
    retry: function (fn, o) {
        o = o || {};
        var n = typeof o.n === 'number' ? o.n : 2;
        var base = typeof o.backoff === 'number' ? o.backoff : 1500;
        var isOk = o.ok || function (v) { return v !== null && v !== undefined && v !== false; };
        var v = fn();
        var tent = 0;
        while (!isOk(v) && tent < n) {
            tent++;
            var e = tent - 1;
            if (e > 3) e = 3;                 // 1.5s, 3s, 6s, 12s, 12s...
            System.delay(base * (1 << e));
            v = fn();
        }
        return v;
    },

    // download p/ arquivo com integridade: streaming + MD5 conferido; erro
    // ou md5 diferente APAGA o alvo (nunca sobra arquivo pela metade) e
    // devolve false. onProg(recebido, total) vai direto ao Net.download.
    fetch: function (url, file, md5, onProg) {
        var ok = false;
        try { ok = !!Net.download(url, file, onProg || null); } catch (e) { ok = false; }
        if (!ok) return false;
        if (md5) {
            var got = '';
            try { got = FS.getFileMD5(file) || ''; } catch (e2) { got = ''; }
            if (got !== md5) {
                try { FS.deleteFile(file); } catch (e3) { /* nada a apagar */ }
                return false;
            }
        }
        return true;
    },

    // texto de um arquivo baixado (par do fetch; JSON.parse fica com o app
    // ou com o A.data.load)
    readText: function (file) {
        try { return FS.readTextFile(file); } catch (e) { return null; }
    }
};

A._mods.push('net');

module.exports = A;
