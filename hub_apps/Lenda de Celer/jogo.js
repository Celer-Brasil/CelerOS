// jogo.js — a cena de jogo da Lenda de Celer: o mundo em salas (E.world),
// a heroina, monstros, baus, portas, bombas, loja, dialogos, HUD e o pad
// multitoque. main.js monta as cenas e chama J.* daqui.

var E = require('celeros.game');
var S = System;
var A = require('arte');
var M = require('mundo');
var H = require('heroi');
var I = require('inimigos');
var SOM = require('som');

var J = { d: null, W: null, h: null, slot: 1, ctl: { x: 0, y: 0, a: false, b: false },
          dlg: null, dlgFim: null, bumerangue: null, debug: {} };
var DV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
var NOMES = { espada: 'Espada de Celer', bombas: 'Bombas', chave: 'Chave pequena', mapa: 'Mapa do Templo',
              bumerangue: 'Bumerangue', conteiner: 'Coracao extra', coracao: 'Coracao', cristal: 'Cristal' };

// ------------------------------------------------------------ dados ----
J.novoDados = function () {
    // comeca com a lamina simples (A sempre ataca); o Sabio da a Espada de
    // Celer (forca 2)
    return { hpMax: 6, hp: 6, espada: true, forca: 1, bombaItem: false, bumerangue: false, mapa: false,
             bombas: 0, cristais: 0, chaves: 0, itemB: null, chefe: false, tempo: 0, mortes: 0,
             onde: { area: 'campo', c: 1, r: 1, at: [7, 6] } };
};
// resumo do arquivo n (tela de titulo) sem trocar o slot corrente
J.resumo = function (n) {
    var antes = E.save.slot();
    E.save.slot(n);
    var d = E.save.obj('heroi', null);
    E.save.slot(antes);
    return d;
};
J.carregar = function (n) {
    J.slot = n;
    E.save.slot(n);
    J.d = E.save.obj('heroi', null) || J.novoDados();
    J.criarMundo();
    J.W.restore();
    return J.d;
};
J.apagar = function (n) {
    var antes = E.save.slot();
    E.save.slot(n);
    E.save.del('heroi');
    E.save.del('mundo');
    E.save.slot(antes);
};
J.salvar = function () {
    if (!J.d) return;
    if (J.h) J.d.hp = J.h.st.hp > 0 ? J.h.st.hp : J.d.hpMax;
    if (J.W && J.W.room && !J.W.room.meta.chefe) {
        var c = J.W.toCell(J.h.x + J.h.w / 2, J.h.y + J.h.h / 2);
        // heroína em cima de porta de area (caverna/escada): guarda a
        // posicao anterior — carregar em cima da porta entraria nela sozinho
        if (c && J.W.room.meta.portas && J.W.room.meta.portas[c.c + ',' + c.r]) c = null;
        if (c) J.d.onde = { area: J.W.room.area, c: J.W.room.c, r: J.W.room.r, at: [c.c, c.r] };
    }
    E.save.setObj('heroi', J.d);
    if (J.W) J.W.save();
};

// ------------------------------------------------------------ mundo ----
J.criarMundo = function () {
    if (J.W) J.W.free();
    J.W = E.world({
        cols: 15, rows: 13, cell: A.CELL, ox: A.OX, oy: A.OY, areas: M.AREAS,
        paint: function (v, x, y) { A.tile(v, x, y); },
        // world 1.1: a sala grava pela regiao do tile (copySprite direto,
        // sem o paint por celula); o paint fica para firmware/engine antigos
        tile: function (v) { return 'tile' + (A.TILE[v] === undefined ? A.TILE.chao : A.TILE[v]); },
        solid: M.solid, outside: false, bg: 0x0000, save: 'mundo',
        anim: { ms: 450, frames: { agua: ['agua', 'agua2'] } },
        slideMs: 520,
        onEnter: function (rec) { J.entrouSala(rec); }
    });
};
J.heroiCentro = function () {
    var h = J.h;
    _hc.x = h.x + h.w / 2; _hc.y = h.y + h.h / 2;
    return _hc;
};
var _hc = { x: 0, y: 0 };
function poeHeroi(c, r) {
    var rc = J.W.cellRect(c, r);
    J.h.x = rc.x + (rc.w - J.h.w) / 2;
    J.h.y = rc.y + (rc.h - J.h.h) / 2;
}

// ---------------------------------------------------------- entidades --
J.ents = E.group();
J.bombas = [];
var _fluxo = null, _fluxoC = -1, _fluxoR = -1;
J.fluxo = function () {
    var c = J.W.toCell(J.h.x + J.h.w / 2, J.h.y + J.h.h / 2);
    if (!c) return _fluxo;
    if (!_fluxo || c.c !== _fluxoC || c.r !== _fluxoR) {
        _fluxoC = c.c; _fluxoR = c.r;
        _fluxo = E.path.flow(15, 13, c.c, c.r, J.W.cost);
    }
    return _fluxo;
};
J.monstros = function () { return J.ents.countIf(function (e) { return e.st && !e.npc && !e.dead; }); };

function limparSala() {
    J.ents.each(function (e) { if (e.morrer) e.morrer(); else e.dead = true; });
    J.ents.clear();
    var ss = E.combat.shots();
    for (var i = 0; i < ss.length; i++) ss[i].dead = true;
    J.bombas.length = 0;
    J.bumerangue = null;
    _fluxo = null;
}

// chegou numa sala (go direto ou fim do slide)
J.entrouSala = function (rec) {
    limparSala();
    if (J.slideDir) { J.W.wrapEnt(J.h, J.slideDir); J.slideDir = null; }
    J.bauOculto = null;
    var meta = rec.meta || {};
    var sp = J.W.spawns(), i, s;
    for (i = 0; i < sp.length; i++) {
        s = sp[i];
        if (s.type === 'bau') continue;
        if (s.type === 'chefe' && J.d.chefe) continue;
        if (s.type === 'coracao' || s.type === 'cristal' || s.type === 'chave') {
            J.ents.add(J.pickup(s.type, s.x, s.y, s));
            continue;
        }
        if (s.type === 'loja') { J.ents.add(J.loja(s)); continue; }
        var e = I.criar(s.type, s, J);
        if (e) J.ents.add(e);
    }
    // baus: tomado = aberto (persistido pelo W.set); o que so aparece com a
    // sala limpa fica escondido (chao) ate o ultimo monstro cair
    var todos = rec.lv.spawns;
    for (i = 0; i < todos.length; i++) {
        s = todos[i];
        if (s.type !== 'bau' || J.W.flag('got:' + i)) continue;
        if (meta.bauAoLimpar && J.monstros() > 0) {
            J.W.set(s.c, s.r, 'chao');
            J.bauOculto = s;
        }
    }
    J.tinhaMonstros = J.monstros() > 0;
    // sala do chefe: a grade fecha atras da heroina
    if (meta.chefe && !J.d.chefe) J.W.set(7, 12, 'porta_grade');
    // trilha da area
    if (rec.area === 'campo') SOM.tocar('campo');
    else if (rec.area === 'casa') SOM.tocar('casa');
    else SOM.tocar(meta.chefe && !J.d.chefe ? 'chefe' : 'masm');
    J.nomeSala = meta.nome || '';
    J.nomeT = 1.6;
    J.hudKey = '';
};

// sala limpa: bau escondido aparece, grade do chefe abre
function checarLimpa() {
    if (!J.tinhaMonstros || J.monstros() > 0) return;
    J.tinhaMonstros = false;
    if (J.bauOculto) {
        var s = J.bauOculto;
        J.bauOculto = null;
        J.W.set(s.c, s.r, 'bau');
        E.fx.play('brilho', s.x, s.y);
        SOM.fx('segredo');
    }
    if (J.W.room.meta.chefe) J.W.set(7, 12, 'porta');
}

// ------------------------------------------------------------ itens ----
J.pickup = function (item, x, y, spawn) {
    var C = A.CELL, sz = Math.round(C * 0.6);
    var p = { tipo: 'pickup', item: item, x: x - sz / 2, y: y - sz / 2, w: sz, h: sz, t: 0,
              vida: spawn ? 0 : 9, dead: false, spawn: spawn };
    p.update = function (dt) {
        p.t += dt;
        if (p.vida && p.t > p.vida) p.dead = true;
        if (E.collide.rect(p, J.h)) p.pegar();
    };
    p.pegar = function () {
        if (p.dead) return;
        p.dead = true;
        if (p.spawn) J.W.take(p.spawn);
        J.receber(p.item, true);
    };
    p.draw = function () {
        if (p.vida && p.t > p.vida - 2 && Math.floor(p.t * 10) % 2) return;
        var bob = Math.sin(p.t * 5) * C * 0.06;
        // escala 1 = caminho rapido do stamp (pushSprite); so o relicario cresce
        var k = p.item === 'relicario' ? 1.6 : 1;
        var idx = A.ITEM[p.item === 'relicario' ? 'cristal5' : p.item];
        A.at('item' + idx, p.x + p.w / 2, p.y + p.h / 2 + bob, k);
    };
    return p;
};
// soma o item (pickup pequeno = sem cerimonia; item de bau = erguer)
J.receber = function (item, pequeno) {
    var d = J.d, h = J.h;
    if (item === 'coracao') { h.st.heal(2); SOM.fx('vida'); }
    else if (item === 'cristal') { d.cristais += 1; SOM.fx('cristal'); }
    else if (item === 'cristal5') { d.cristais += 5; SOM.fx('cristal'); }
    else if (item === 'bomba') { d.bombas += 4; SOM.fx('power'); }
    else if (item === 'chave') { d.chaves += 1; SOM.fx('chave'); }
    else if (item === 'relicario') { J.fimDeJogo(); return; }
    else J.ganhar(item);
    if (pequeno) E.fx.play('brilho', h.x + h.w / 2, h.y);
    J.hudKey = '';
};
// item de verdade (bau, sabio): heroina ergue + fanfarra + aviso
J.ganhar = function (item) {
    var d = J.d, h = J.h, mostra = item;
    if (item === 'espada') { d.espada = true; d.forca = 2; }
    else if (item === 'bombas') { d.bombaItem = true; d.bombas += 8; if (!d.itemB) d.itemB = 'bomba'; mostra = 'bomba'; }
    else if (item === 'bumerangue') { d.bumerangue = true; d.itemB = 'bumerangue'; }
    else if (item === 'mapa') d.mapa = true;
    else if (item === 'chave') d.chaves += 1;
    else if (item === 'conteiner') { d.hpMax += 2; h.st.base.hp = d.hpMax; h.st.hp = d.hpMax; }
    h.fsm.go('erguer', mostra, true);
    SOM.fx('item');
    if (E.ui && E.ui.toast) E.ui.toast(NOMES[item] || item, { ms: 1800 });
    J.hudKey = '';
    J.salvar();
};

// a frente da heroina: interage com bau, porta trancada, sabio
J.frente = function () {
    var h = J.h, v = DV[h.dir];
    var x = h.x + h.w / 2 + v[0] * A.CELL * 0.75, y = h.y + h.h / 2 + v[1] * A.CELL * 0.75;
    return J.W.toCell(x, y);
};
J.interagir = function () {
    var f = J.frente();
    if (!f) return false;
    var c = f.c, r = f.r, v = J.W.get(c, r);
    if (v === 'bau') { J.abrirBau(c, r); return true; }
    if (v === 'porta_chave') {
        if (J.d.chaves > 0) {
            J.d.chaves--;
            J.W.set(c, r, 'porta', true);
            SOM.fx('porta');
            J.salvar();
        } else J.falar(['A porta esta trancada.'], null);
        return true;
    }
    // NPC perto
    var hc = J.heroiCentro(), npc = J.ents.find(function (e) {
        return e.npc && E.m.dist(hc.x, hc.y, e.x + e.w / 2, e.y + e.h / 2) < A.CELL * 1.6;
    });
    if (npc && npc.tipo === 'sabio') { J.falarSabio(); return true; }
    return false;
};
J.abrirBau = function (c, r) {
    var lv = J.W.room.lv.spawns, sp = null;
    for (var i = 0; i < lv.length; i++) if (lv[i].type === 'bau' && lv[i].c === c && lv[i].r === r) { sp = lv[i]; sp.i = i; }
    J.W.set(c, r, 'bau_aberto', true);
    if (sp) J.W.take(sp);
    J.ganhar(J.W.room.meta.bau || 'cristal5');
};
J.cortarArbusto = function () {
    var f = J.frente();
    if (f && J.W.get(f.c, f.r) === 'arbusto') {
        J.W.set(f.c, f.r, 'grama');
        var rc = J.W.cellRect(f.c, f.r);
        E.fx.play('poeira', rc.x + rc.w / 2, rc.y + rc.h / 2, { colors: [0x2C04, 0x5D0A] });
        if (Math.random() < 0.3) J.ents.add(J.pickup(E.m.pick(['cristal', 'coracao']), rc.x + rc.w / 2, rc.y + rc.h / 2));
    }
};

// ----------------------------------------------------------- bombas ----
J.bombaViva = function () { return J.bombas.length > 0; };
J.soltarBomba = function (x, y) {
    J.bombas.push({ x: x, y: y, t: 0 });
    SOM.fx('planta');
};
function explodir(b) {
    var C = A.CELL;
    E.combat.blast(b.x, b.y, C * 1.4, { team: 'heroi', dmg: 2, owner: J.h });
    E.fx.play('explosao', b.x, b.y);
    E.audio.sfx('boomPeq');
    // parede rachada / arbusto no raio: abre (rachada persiste dos 2 lados)
    var id = J.W.room.id, pares = M.RACHADAS[id] || {};
    for (var r = 0; r < 13; r++) {
        for (var c = 0; c < 15; c++) {
            var rc = J.W.cellRect(c, r);
            if (E.m.dist(b.x, b.y, rc.x + rc.w / 2, rc.y + rc.h / 2) > C * 1.6) continue;
            var v = J.W.get(c, r);
            if (v === 'rachada') {
                J.W.set(c, r, 'porta', true);
                var p = pares[c + ',' + r];
                if (p) J.W.setIn(p.area, p.c, p.r, p.cell[0], p.cell[1], 'porta');
                SOM.fx('segredo');
                J.salvar();
            } else if (v === 'arbusto') J.W.set(c, r, 'grama');
        }
    }
}

// ------------------------------------------------------------- loja ----
J.loja = function (sp) {
    var C = A.CELL;
    var l = { tipo: 'loja', x: sp.x - C * 0.4, y: sp.y - C * 0.4, w: C * 0.8, h: C * 0.8, t: 0, dead: false, npc: true, longe: true };
    l.update = function (dt) {
        l.t += dt;
        var em = E.collide.rect(l, J.h);
        if (em && l.longe) {
            l.longe = false;
            if (J.d.cristais >= 10) {
                J.d.cristais -= 10;
                J.d.bombaItem = true;
                if (!J.d.itemB) J.d.itemB = 'bomba';
                J.receber('bomba', true);
                J.salvar();
            } else {
                SOM.fx('bad');
                if (E.ui && E.ui.toast) E.ui.toast('4 bombas: 10 cristais', { ms: 1500 });
            }
        } else if (!em) l.longe = true;
    };
    l.draw = function () {
        A.at('item' + A.ITEM.bomba, l.x + l.w / 2, l.y + l.h / 2 - C * 0.1);
        _lo.px = Math.round(C * 0.38);
        E.gfx.text('10', l.x + l.w / 2, l.y + l.h + C * 0.15, _lo);
    };
    l.morrer = function () { l.dead = true; };
    return l;
};
var _lo = { align: 'center', color: 0x07E0, px: 12, shadow: 0x0000 };

// --------------------------------------------------------- dialogos ----
J.falar = function (paginas, nome, depois) {
    J.dlg = E.ui.dialog(paginas, { name: nome || undefined, speed: 40, px: Math.round(A.CELL * 0.5) });
    J.dlgFim = depois || null;
    J.h.fsm.go('parado', null, true);
};
J.falarSabio = function () {
    var d = J.d;
    if (!(d.forca >= 2)) {
        J.falar(['Celer! O Guardiao de pedra despertou no Templo do Monte Cinzento.',
                 'Essa laminazinha nao corta pedra. Leve a Espada de Celer.'], 'Sabio',
                function () { J.ganhar('espada'); });
    } else if (!d.chefe) {
        J.falar([d.bombaItem ? 'Paredes rachadas cedem a uma boa explosao.' :
                 'Sem bombas? Troco 4 delas por 10 cristais, ali no pedestal.',
                 'O Templo fica ao norte da clareira, a leste. Coragem!'], 'Sabio');
    } else {
        J.falar(['O Cristal voltou a brilhar. As terras de Celer agradecem.'], 'Sabio');
    }
};

// ------------------------------------------------------------ portas ---
// celula sob a heroina com destino de outra area (caverna, escada)
function checarPortas() {
    var meta = J.W.room.meta;
    if (!meta.portas) return;
    var c = J.W.toCell(J.h.x + J.h.w / 2, J.h.y + J.h.h / 2);
    if (!c) return;
    var dst = meta.portas[c.c + ',' + c.r];
    if (!dst) return;
    J.h.fsm.go('parado', null, true);
    SOM.fx('escada');
    J.salvar();
    E.goto('jogo', { transition: 'fade', ms: 500, arg: { porta: dst } });
}

// --------------------------------------------------------- morte/fim ---
J.matou = function (e) {
    var cx = e.x + e.w / 2, cy = e.y + e.h / 2;
    if (e.morrer) e.morrer();
    E.fx.play('poof', cx, cy);
    SOM.fx('bicho');
    if (e.tipo === 'chefe') {
        J.d.chefe = true;
        E.fx.play('explosao', cx, cy);
        E.cam.shake(Math.round(10 * A.K), 0.8);
        E.audio.sfx('boomBoss');
        // os morcegos invocados pelo Guardiao somem com ele: a sala limpa
        // abre a grade (checarLimpa) sem virar cacada depois da luta
        J.ents.each(function (m) {
            if (m !== e && m.st && !m.npc && !m.dead && m.morrer) {
                m.morrer();
                E.fx.play('poof', m.x + m.w / 2, m.y + m.h / 2);
            }
        });
        J.ents.add(J.pickup('conteiner', cx - A.CELL, cy));
        J.ents.add(J.pickup('relicario', cx + A.CELL, cy));
        SOM.tocar('masm');
        J.salvar();
        return;
    }
    var it = E.m.weighted([['nada', 5], ['cristal', 3], ['coracao', 2], ['cristal5', 0.6],
                           ['bomba', J.d.bombaItem ? 1 : 0]]);
    if (it !== 'nada') J.ents.add(J.pickup(it, cx, cy));
};
J.chamarMorcegos = function (n) {
    for (var i = 0; i < n; i++) {
        var rc = J.W.cellRect(3 + i * 8, 6);
        J.ents.add(I.criar('morcego', { x: rc.x + rc.w / 2, y: rc.y + rc.h / 2 }, J));
    }
    J.tinhaMonstros = true;
};
J.morreu = function () {
    J.d.mortes++;
    E.goto('fim', { transition: 'fade', ms: 700 });
};
J.fimDeJogo = function () {
    var h = J.h;
    h.fsm.go('erguer', 'cristal5', true);
    SOM.parar();
    E.audio.sfx('recorde');
    J.salvar();
    E.script([{ wait: 1600 }, { scene: 'vitoria', opts: { transition: 'fade', ms: 900 } }]);
};

// ---------------------------------------------- ganchos (teste/debug) --
// monstro na celula (c, r) da sala corrente
J.spawnar = function (tipo, c, r) {
    var rc = J.W.cellRect(c, r);
    var e = I.criar(tipo, { x: rc.x + rc.w / 2, y: rc.y + rc.h / 2 }, J);
    if (e) { J.ents.add(e); if (e.st) J.tinhaMonstros = true; }
    return e;
};
// vai direto a uma sala/celula (sem veu)
J.teleporte = function (area, c, r, at) {
    J.salvar();
    E.goto('jogo', { arg: { porta: { area: area, c: c, r: r, at: at || [7, 6] } } });
};

// -------------------------------------------------------------- cena ---
var _pad = {};
J.enter = function (arg) {
    E.combat.clear();
    J.h = H.criar(J);
    E.dirty.enable(function (x, y, w, h) { J.W.painter(x, y, w, h); });
    var C = A.CELL;
    // stick: descansa no canto inferior esquerdo; o centro nasce onde o
    // dedo pousa (qualquer ponto da metade esquerda da sala)
    _pad.st = E.pad.stick({ zone: { x: 0, y: A.OY, w: Math.round(E.W * 0.5), h: E.H - A.OY },
                            x: Math.round(C * 2.1), y: E.H - Math.round(C * 2.1),
                            r: Math.round(C * 1.4), follow: true, dirs: 8 });
    _pad.a = E.pad.button({ x: E.W - Math.round(C * 1.5), y: E.H - Math.round(C * 2.1),
                            r: Math.round(C * 0.95), label: 'A' });
    _pad.b = E.pad.button({ x: E.W - Math.round(C * 3.5), y: E.H - Math.round(C * 1.0),
                            r: Math.round(C * 0.8), label: 'B', color: 0xFD20 });
    var d = J.d;
    if (arg && arg.porta) {
        J.W.go(arg.porta.area, arg.porta.c, arg.porta.r);
        poeHeroi(arg.porta.at[0], arg.porta.at[1]);
    } else {
        J.W.go(d.onde.area, d.onde.c, d.onde.r);
        poeHeroi(d.onde.at[0], d.onde.at[1]);
    }
    J.dlg = null;
    J.hudKey = '';
    // primeira vez: o sabio chama
    if (!(d.forca >= 2) && J.W.room.id === 'campo:1,1' && !J.debug.semIntro && !J.introVista) {
        J.introVista = true;
        J.falar(['...Celer... venha a gruta, a oeste daqui...'], 'Uma voz');
    }
};
J.update = function (dt) {
    var W = J.W, h = J.h;
    J.d.tempo += dt;
    if (J.nomeT > 0) J.nomeT -= dt;
    // mundo trocado em voo (recarregar arquivo no meio da cena): sem sala
    // corrente nao ha o que atualizar — solidAt/portas responderiam fora
    if (W.sliding || !W.room) return;
    var c = J.ctl;
    c.x = _pad.st.x; c.y = _pad.st.y;
    c.a = _pad.a.pressed || _pad.st.tap;
    c.b = _pad.b.pressed;
    if (J.dlg) {
        if (c.a) J.dlg.next();
        if (J.dlg.closed) {
            J.dlg = null;
            if (h.fsm.is('parado')) h.fsm.go('andar');
            var fn = J.dlgFim;
            J.dlgFim = null;
            if (fn) fn();
        }
        return;
    }
    // pausa: toque no botao do HUD
    if (E.hit(J.btnPausa)) { E.push('pausa'); return; }
    H.update(h, dt);
    if (!h.fsm.is('morto')) E.combat.move(h, dt, W);
    J.ents.update(dt);
    for (var i = J.bombas.length - 1; i >= 0; i--) {
        var b = J.bombas[i];
        b.t += dt;
        if (b.t >= 1.5) { J.bombas.splice(i, 1); explodir(b); }
    }
    if (J.bumerangue && J.bumerangue.dead) J.bumerangue = null;
    // o bumerangue traz os itens que toca
    if (J.bumerangue) {
        var bm = J.bumerangue;
        J.ents.each(function (p) { if (p.tipo === 'pickup' && !p.dead && E.collide.circleRect(bm, p)) p.pegar(); });
    }
    checarLimpa();
    if (h.fsm.is('morto') || h.fsm.is('parado')) return;
    checarPortas();
    var lado = W.edge(h);
    if (lado) {
        if (W.move(lado)) { J.slideDir = lado; limparSala(); }
        else {   // sem vizinha: segura na borda
            h.x = E.m.clamp(h.x, W.ox, W.ox + W.pw - h.w);
            h.y = E.m.clamp(h.y, W.oy, W.oy + W.ph - h.h);
        }
    }
};

var _sombra = { color: 0x0000, px: 12, align: 'center' };
// linha de diagnostico na bancada (J.debug.hud = true pelo gancho de
// teste/__harness ou numa copia de bancada):
// slide, dialogo, estado da heroina, hitstop, monstros e dedos
var _dbg = { px: 11, color: 0x07E0, bg: 0x0000, screen: true };
function linhaDebug() {
    var W = J.W, h = J.h;
    var s = 'sl' + (W.sliding ? 1 : 0) + ' p' + W.slideP.toFixed(2) + ' dlg' + (J.dlg ? 1 : 0) +
            ' ' + h.fsm.state + ' fz' + (E.frozen() ? 1 : 0) + ' ps' + (E.paused ? 1 : 0) +
            ' m' + J.monstros() + ' t' + E.input.touches.length + ' dt' + E.dt.toFixed(3) + ' ' + E.fps + 'fps';
    // toCell devolve objeto reaproveitado: a 2a chamada sobrescreve c0
    var c0 = W.toCell(h.x + h.w + 1, h.y + 1);
    var c0v = c0 ? c0.c + ',' + c0.r + '=' + W.get(c0.c, c0.r) : '-';
    var c1 = W.toCell(h.x + h.w + 1, h.y + h.h - 1);
    s += ' x' + Math.round(h.x) + ',' + Math.round(h.y) + ' fr ' + c0v +
         ' ' + (c1 ? c1.c + ',' + c1.r + '=' + W.get(c1.c, c1.r) : '-');
    // fora da camada suja (nao repinta o HUD por quadro) e com fundo opaco
    E.dirty._mute++;
    S.fillRect(0, A.HUD - 16, E.W, 15, 0x0000);
    E.gfx.text(s, 2, A.HUD - 15, _dbg);
    E.dirty._mute--;
}
J.draw = function () {
    var W = J.W, h = J.h, C = A.CELL;
    W.draw();
    if (W.sliding) {
        var sh = W.slideShift(), d = DV[W.slideDir];
        // a heroina atravessa junto com a tela
        H.draw(h, sh.x - d[0] * W.pw, sh.y - d[1] * W.ph);
        J.hud();
        if (J.debug.hud) linhaDebug();
        return;
    }
    J.ents.sort('y');
    J.ents.draw();
    for (var i = 0; i < J.bombas.length; i++) {
        var b = J.bombas[i];
        var pisca = b.t > 1 && Math.floor(b.t * 12) % 2;
        if (!pisca) A.at('item' + A.ITEM.bomba, b.x, b.y);
    }
    H.draw(h, 0, 0);
    E.combat.drawShots(function (s) {
        if (s.owner === h) A.at('item' + A.ITEM.bumerangue, s.x, s.y);
        else A.at('ini' + A.INI.pedra, s.x, s.y);
    });
    E.fx.draw();
    if (J.nomeT > 0 && J.nomeSala) {
        _sombra.px = Math.round(C * 0.45);
        _sombra.color = 0xFFFF;
        _sombra.shadow = 0x0000;
        E.gfx.text(J.nomeSala, A.OX + W.pw / 2, A.OY + C * 0.6, _sombra);
    }
    // no TOPO da sala: embaixo ficam o stick e os botoes (o polegar cobria)
    if (J.dlg) J.dlg.draw(A.OX + C * 0.5, A.OY + C * 0.4, W.pw - C);
    E.pad.draw();
    J.hud();
    if (J.debug.hud) linhaDebug();
};

// --------------------------------------------------------------- HUD ---
// parado: desenha so quando muda (ou quando a camada suja apagou a faixa)
// fora da camada suja (_mute) — o HUD nao entra no apaga-redesenha
var _ht = { px: 14, color: 0xFFFF, valign: 'middle' };
J.btnPausa = { x: 0, y: 0, w: 0, h: 0 };
J.hud = function () {
    var d = J.d, h = J.h, C = A.CELL, HH = A.HUD;
    var key = h.st.hp + '|' + d.hpMax + '|' + d.cristais + '|' + d.bombas + '|' + d.chaves + '|' +
              d.itemB + '|' + (J.W.room ? J.W.room.id : '') + '|' + d.mapa;
    if (key === J.hudKey && !E.dirty.touches(0, 0, E.W, HH)) return;
    J.hudKey = key;
    E.dirty._mute++;
    S.fillRect(0, 0, E.W, HH, 0x0000);
    var y0 = Math.round(HH * 0.32), y1 = Math.round(HH * 0.74);
    var hs = Math.round(C * 0.5);
    E.gfx.hearts(h.st.hp / 2, d.hpMax / 2, A.OX + C * 0.3, y0 - hs / 2, { size: hs, screen: true });
    _ht.px = Math.round(C * 0.55);
    var x = A.OX + C * 0.3;
    A.at('item' + A.ITEM.cristal, x + C * 0.2, y1, 0.55);
    E.gfx.text('x' + d.cristais, x + C * 0.5, y1, _ht);
    if (d.bombaItem) {
        A.at('item' + A.ITEM.bomba, x + C * 2.0, y1, 0.55);
        E.gfx.text('x' + d.bombas, x + C * 2.3, y1, _ht);
    }
    if (d.chaves > 0 || (J.W.room && J.W.room.area === 'masm')) {
        A.at('item' + A.ITEM.chave, x + C * 3.8, y1, 0.55);
        E.gfx.text('x' + d.chaves, x + C * 4.1, y1, _ht);
    }
    // caixa do item B
    // B e pausa no CENTRO do HUD: o terco direito da faixa do topo e do
    // sistema (o toque ali e o gesto que revela a topbar — o app nunca ve)
    var by = Math.round(HH * 0.12), bs = Math.round(HH * 0.76);
    var bx = Math.round(E.W / 2 - bs - C * 0.25);
    E.gfx.rect(bx, by, bs, bs, 0xFD20, { fill: false, screen: true });
    if (d.itemB) A.at('item' + A.ITEM[d.itemB === 'bomba' ? 'bomba' : 'bumerangue'], bx + bs / 2, by + bs / 2, 0.7);
    var px = Math.round(E.W / 2 + C * 0.25);
    J.btnPausa.x = px; J.btnPausa.y = by; J.btnPausa.w = bs; J.btnPausa.h = bs;
    E.gfx.rect(px, by, bs, bs, 0x2124, { screen: true, r: Math.round(C * 0.15) });
    E.gfx.rect(px + bs * 0.3, by + bs * 0.25, bs * 0.13, bs * 0.5, 0xFFFF, { screen: true });
    E.gfx.rect(px + bs * 0.57, by + bs * 0.25, bs * 0.13, bs * 0.5, 0xFFFF, { screen: true });
    // minimapa da masmorra (com o mapa achado mostra as nao visitadas)
    if (J.W.room && J.W.room.area === 'masm') {
        J.W.minimap(px + bs + C * 0.5, by + 2, { size: Math.round(bs / 3.6), gap: 2, reveal: d.mapa });
    }
    E.dirty._mute--;
};

module.exports = J;
