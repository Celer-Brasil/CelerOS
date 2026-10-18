// app.svc.js — CelerKit SVC (dep "celeros.app.svc"): o kit de service.js
// (API 42) — as licoes do Nucleo/Regras/Mural num modulo: gates de politica,
// drain com cap, estado persistido, notificar-so-uma-vez e tick com cadencia.
//
//   ATENCAO: servicos NAO carregam a tabela de deps compartilhadas —
//   copie celeros.app.js + celeros.app.svc.js para a PASTA do app
//   (vendoring: o require acha a copia local no main.js E no service.js,
//   que carregam o mesmo codigo).
//
//   // service.js
//   var A = require("celeros.app");
//   require("celeros.app.svc");
//   var svc = A.svc.new({ key: "regras" });
//   setInterval(function () {
//       if (!svc.tick(5000)) return;          // trabalha a cada 5 s
//       if (svc.blocked()) return;            // app em fg/OTA/shell: dorme
//       svc.drain(Pack.poll, 16, function (m) { ... });  // burst nao mata
//       svc.save();                           // estado persiste
//   }, 1000);

var A = require('celeros.app');
require('celeros.app.data');

A.svc = {
    version: '1.0.0',

    // o = { key: chave unica do servico (prefixo do estado no Storage) }
    new: function (o) {
        o = o || {};
        var PREFIX = 'svc.' + (o.key || 'app') + '.';
        var s = {
            key: o.key || 'app',
            ticks: 0,                 // ticks que trabalharam
            erros: 0,                 // erros registrados (svc.error)
            _last: 0,
            _once: {},
            _st: {}
        };

        // tick(ms): true quando passou a cadencia (os timers disparam mais
        // rapido do que o servico deve trabalhar)
        s.tick = function (ms) {
            var now = System.millis();
            if (now - s._last < ms) return false;
            s._last = now;
            s.ticks++;
            return true;
        };

        // null = pode trabalhar; 'app' (app em primeiro plano), 'ota' ou
        // 'shell' = deixe para la (os gates de politica do svchost)
        s.blocked = function () {
            try {
                if (System.appOpen && System.appOpen()) return 'app';
                if (System.updateBusy && System.updateBusy()) return 'ota';
                if (System.shellActive && System.shellActive()) return 'shell';
            } catch (e) { /* API velha: segue */ }
            return null;
        };

        // drena com cap: o burst de quadros nao estrela o pump (Regras)
        s.drain = function (pollFn, cap, cb) {
            var n = 0;
            for (;;) {
                var m = pollFn();
                if (m === null || m === undefined) break;
                cb(m);
                n++;
                if (n >= cap) break;
            }
            return n;
        };

        // estado persistido no Storage (JSON): sobrevive ao reinicio do
        // servico e ao boot — carregue no top-level, salve no fim do tick
        s.load = function () {
            s._st = A.data.loadState(PREFIX + 'st', {});
            return s._st;
        };
        s.save = function () { return A.data.saveState(PREFIX + 'st', s._st); };
        s.state = function () { return s._st; };

        // notifica UMA vez por chave (nao enxota o centro de notificacoes)
        s.notifyOnce = function (chave, msg) {
            if (s._once[chave]) return false;
            s._once[chave] = 1;
            try { System.notify(msg); } catch (e) { /* sem notificacoes */ }
            return true;
        };
        // reabre a chave (a condicao voltou: notifique de novo)
        s.resetOnce = function (chave) { delete s._once[chave]; };

        // erro registrado (contador para o diagnostico); msg opcional via
        // notifyOnce(chave)
        s.error = function (chave, msg) {
            s.erros++;
            if (chave) return s.notifyOnce(chave, msg || chave);
            return false;
        };

        return s;
    }
};

A._mods.push('svc');

module.exports = A;
