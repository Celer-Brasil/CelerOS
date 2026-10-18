// game.level.js — CelerGame LEVEL (dep "celeros.game.level"): fases
// escritas em ASCII (o mapa e o desenho) + legenda que separa CENARIO de
// ENTIDADES, e a progressao de fases com desbloqueio salvo. Decora o core:
//
//   var E = require("celeros.game");
//   require("celeros.game.level");
//   var lv = E.level.parse([
//       "##########",
//       "#@...o..E#",
//       "##########"
//   ], { legend: { '#': 'parede', '.': null, '@': { spawn: 'heroi' },
//                  'o': { spawn: 'moeda' }, 'E': { spawn: 'inimigo', tile: null } },
//        cell: 16 });
//   lv.data      // valores de cenario por celula (plano, cols*rows)
//   lv.spawns    // [{type, c, r, x, y, ch}] — x,y = centro em px
//   lv.find('heroi')  // o 1o spawn do tipo
//   // com o modulo tilemap: E.tilemap({ cols: lv.cols, rows: lv.rows,
//   //   cell: 16, data: lv.data, paint: ... })
//
// Legenda: valor simples = tile; {spawn: tipo, tile: valor-que-fica-no-
// chao (default null)} = entidade. Caractere fora da legenda = erro claro
// com linha e coluna (fase digitada errada falha no teste, nao no device).
//
// 1.1.0: texto com CRLF (fase salva no Windows/colada de outro editor)
// estourava "caractere fora da legenda" no \r; progress de lista vazia
// dava unlocked -1. Novos: lv.tilemap(o) monta o E.tilemap da fase (com o
// modulo tilemap), progress.complete(i, estrelas) e totalStars().

var E = require('celeros.game');

E.level = {
    version: '1.1.0',

    parse: function (lines, o) {
        o = o || {};
        if (typeof lines === 'string') lines = lines.split('\n');
        // \r do CRLF sai de cada linha (string colada ou array de arquivo)
        var clean = [];
        for (var li = 0; li < lines.length; li++) {
            var ln = lines[li];
            clean.push(ln.charAt(ln.length - 1) === '\r' ? ln.slice(0, -1) : ln);
        }
        lines = clean;
        // linhas vazias nas pontas (template string colado) saem
        while (lines.length && !lines[0].length) lines = lines.slice(1);
        while (lines.length && !lines[lines.length - 1].length) lines = lines.slice(0, -1);
        var legend = o.legend || {};
        var cell = o.cell || 16, ox = o.ox || 0, oy = o.oy || 0;
        var rows = lines.length, cols = 0, r, c;
        for (r = 0; r < rows; r++) if (lines[r].length > cols) cols = lines[r].length;
        var pad = o.pad === undefined ? ' ' : o.pad;
        var data = [], spawns = [];
        for (r = 0; r < rows; r++) {
            for (c = 0; c < cols; c++) {
                var ch = c < lines[r].length ? lines[r].charAt(c) : pad;
                var def;
                if (Object.prototype.hasOwnProperty.call(legend, ch)) def = legend[ch];
                else if (ch === ' ' && !Object.prototype.hasOwnProperty.call(legend, ' ')) def = null;
                else throw new Error('level: caractere "' + ch + '" fora da legenda (linha ' +
                                     (r + 1) + ', coluna ' + (c + 1) + ')');
                if (def !== null && typeof def === 'object') {
                    if (def.spawn) {
                        spawns.push({ type: def.spawn, c: c, r: r, ch: ch,
                                      x: ox + c * cell + cell / 2, y: oy + r * cell + cell / 2 });
                    }
                    data.push(def.tile === undefined ? null : def.tile);
                } else data.push(def);
            }
        }
        var lv = { cols: cols, rows: rows, cell: cell, ox: ox, oy: oy,
                   data: data, spawns: spawns, meta: o.meta || null };
        lv.get = function (cc, rr) {
            if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) return undefined;
            return data[rr * cols + cc];
        };
        lv.find = function (type) {
            for (var i = 0; i < spawns.length; i++) if (spawns[i].type === type) return spawns[i];
            return null;
        };
        lv.all = function (type) {
            var out = [];
            for (var i = 0; i < spawns.length; i++) if (spawns[i].type === type) out.push(spawns[i]);
            return out;
        };
        // fabrica por tipo: factories[tipo](spawn) -> entidade (tipo sem
        // fabrica e ignorado); devolve a lista criada
        // E.tilemap da fase (modulo celeros.game.tilemap): cols/rows/cell/
        // ox/oy/data prontos; o = {paint, solid, outside} do tilemap
        lv.tilemap = function (tmo) {
            if (!E.tilemap) throw new Error('level.tilemap: carregue celeros.game.tilemap');
            tmo = tmo || {};
            var t = { cols: cols, rows: rows, cell: cell, ox: ox, oy: oy, data: data };
            for (var k in tmo) t[k] = tmo[k];
            return E.tilemap(t);
        };
        lv.spawn = function (factories) {
            var out = [];
            for (var i = 0; i < spawns.length; i++) {
                var f = factories[spawns[i].type];
                if (f) { var ent = f(spawns[i]); if (ent) out.push(ent); }
            }
            return out;
        };
        return lv;
    },

    // progressao: list = [{name, map, ...}] (qualquer formato — o jogo
    // interpreta); save = chave no E.save do maior indice desbloqueado.
    // p.cur (indice), p.def(), p.next() (desbloqueia e avanca; false no
    // fim), p.go(i) (so ate o desbloqueado), p.unlocked, p.stars(i, n)
    progress: function (list, o) {
        o = o || {};
        var key = o.save || 'level';
        var p = { list: list, cur: 0, unlocked: 0 };
        p.unlocked = Math.max(0, Math.min(list.length - 1, Math.floor(E.save.num(key, 0))));
        p.def = function () { return list[p.cur]; };
        p.isLast = function () { return p.cur >= list.length - 1; };
        p.go = function (i) {
            if (i < 0 || i >= list.length || i > p.unlocked) return false;
            p.cur = i;
            return true;
        };
        p.next = function () {
            if (p.isLast()) return false;
            p.cur++;
            if (p.cur > p.unlocked) {
                p.unlocked = p.cur;
                E.save.set(key, p.unlocked);
            }
            return true;
        };
        // estrelas/nota por fase: guarda so se melhorou; sem n le
        p.stars = function (i, n) {
            var k = key + '.s' + i;
            var cur = E.save.num(k, 0);
            if (n === undefined) return cur;
            if (n > cur) { E.save.set(k, n); return true; }
            return false;
        };
        // fim de fase num passo: guarda as estrelas (se melhorou) e
        // desbloqueia a seguinte. Devolve true se havia proxima
        p.complete = function (i, n) {
            if (i === undefined) i = p.cur;
            if (n !== undefined) p.stars(i, n);
            var nx = i + 1;
            if (nx < list.length && nx > p.unlocked) {
                p.unlocked = nx;
                E.save.set(key, nx);
            }
            return nx < list.length;
        };
        // soma das estrelas de todas as fases (porta que abre com 10)
        p.totalStars = function () {
            var t = 0;
            for (var i = 0; i < list.length; i++) t += p.stars(i);
            return t;
        };
        p.reset = function () {
            p.cur = 0;
            p.unlocked = 0;
            E.save.set(key, 0);
        };
        return p;
    }
};

E._mods.push('level');

module.exports = E;
