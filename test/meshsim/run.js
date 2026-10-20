#!/usr/bin/env node
// Suite E2E da malha no host: cenarios com VARIOS nos rodando os apps reais
// (hub_apps/data/apps) sobre o simulador (sim.js). Cada cenario monta a
// topologia (quem ouve quem, rssi, perda), roteiriza toques/prompts por no
// e confere o que cada tela desenhou, o que tocou e o que trafegou no ar.
// Uso: node test/meshsim/run.js [filtro]
'use strict';
var path = require('path');
var sim = require('./sim.js');

var failures = 0, total = 0;
function check(name, cond, extra) {
    total++;
    if (cond) console.log('  PASS  ' + name);
    else {
        failures++;
        console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : ''));
    }
}
function has(res, node, needle) {
    var l = res.nodes[node].log;
    for (var i = 0; i < l.length; i++) if (l[i].indexOf(needle) >= 0) return true;
    return false;
}
function count(res, node, re) {
    var l = res.nodes[node].log, n = 0;
    for (var i = 0; i < l.length; i++) if (re.test(l[i])) n++;
    return n;
}
function last(res, node, re) {
    var l = res.nodes[node].log;
    for (var i = l.length - 1; i >= 0; i--) if (re.test(l[i])) return l[i];
    return null;
}
function noErr(res) {
    for (var k in res.nodes) {
        check(k + ' roda sem erro', !res.nodes[k].err, res.nodes[k].err);
    }
}
function dump(res, node) {
    if (process.env.DEBUG_LOG) console.log('---- ' + node + ' ----\n' + res.nodes[node].log.join('\n'));
}
function airTx(res, from, re) {
    return res.air.filter(function(a) { return a.kind === 'tx' && a.from === from && re.test(a.data); });
}

var scenarios = [];
function scenario(name, fn) { scenarios.push({ name: name, fn: fn }); }

// Wire que so dispara broadcasts em intervalos: via STRING porque o
// coordenador serializa o wire com toString() — clojure do run.js nao viaja
function pinger(from, to, gap, payload) {
    return 'function(env, sim) {' +
        'for (var t = ' + from + '; t < ' + to + '; t += ' + gap + ') {' +
        '  sim.at(t, function(e) { e.CelerNet.broadcast(' + JSON.stringify(payload) + '); });' +
        '} }';
}

// ---------------------------------------------------------------------------
// Sonar: ping atravessando 2 saltos, censo e perda real num enlace ruim
scenario('Sonar: ping por 2 saltos e censo', function() {
    var app = 'hub_apps/Sonar/main.js';
    return sim.runMesh({
        durationMs: 40000, seed: 11,
        nodes: [
            { name: 'Celer-A', id: 'AAAA', app: app, caps: 0x05, wire: function(env, sim) {
                sim.at(5000, function(e) { e.__harness.tap(120, 63); });     // aba Ping
                sim.at(6000, function(e) { e.__harness.tap(120, 137); });    // 2a linha: Celer-C
                sim.at(7000, function(e) { e.__harness.tap(120, 299); });    // Pingar 10x
            } },
            { name: 'Celer-B', id: 'BBBB', app: app, caps: 0x09, wire: function(env, sim) {
                sim.at(5000, function(e) { e.__harness.tap(193, 63); });     // aba Censo
                sim.at(6000, function(e) { e.__harness.tap(120, 102); });    // Chamar todos
            } },
            { name: 'Celer-C', id: 'CCCC', app: app, caps: 0x01 }
        ],
        links: [['Celer-A', 'Celer-B', -45], ['Celer-B', 'Celer-C', -70]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Celer-A');
        check('radar desenha os nos ouvidos', has(res, 'Celer-C', '2 nós · anel = saltos'));
        check('A pingou C 10x pelo B', airTx(res, 'Celer-A', /^s\?\d+$/).length === 10);
        check('C respondeu cada ping', airTx(res, 'Celer-C', /^s!\d+$/).length === 10);
        check('A mostra 10/10 sem perda', has(res, 'Celer-A', 'Celer-C: 10/10 · perda 0%'),
              last(res, 'Celer-A', /Celer-C: /));
        var rtt = last(res, 'Celer-A', /^RTT \d+/);
        var m = rtt && rtt.match(/RTT (\d+) \/ (\d+) \/ (\d+) ms/);
        check('RTT de 2 saltos ida e volta plausivel (300..3000 ms)',
              m && +m[1] >= 300 && +m[3] <= 3000 && +m[1] <= +m[2] && +m[2] <= +m[3], rtt);
        check('censo pediu todos (broadcast s*)', airTx(res, 'Celer-B', /^s\*\d+$/).length === 1);
        check('censo: A e C responderam com bateria/uptime',
              has(res, 'Celer-B', 'Celer-A') && count(res, 'Celer-B', /salto.* · \d+ ms · \d+ min/) >= 2);
        check('respostas do censo em unicast de 1 quadro',
              airTx(res, 'Celer-C', /^s=\d+\|-?\d+\|\d+$/).every(function(a) { return a.frames === 1 && a.dst === 'BBBB'; }));
    });
});

scenario('Sonar: enlace ruim mostra perda (sem copias mascarando)', function() {
    var app = 'hub_apps/Sonar/main.js';
    return sim.runMesh({
        durationMs: 34000, seed: 5,
        nodes: [
            { name: 'Celer-A', id: 'AAAA', app: app, wire: function(env, sim) {
                sim.at(5000, function(e) { e.__harness.tap(120, 63); });
                sim.at(6000, function(e) { e.__harness.tap(120, 103); });    // 1a linha: Celer-B
                sim.at(7000, function(e) { e.__harness.tap(120, 299); });
            } },
            { name: 'Celer-B', id: 'BBBB', app: app }
        ],
        links: [['Celer-A', 'Celer-B', -88, 0.35]]
    }).then(function(res) {
        noErr(res);
        var l = last(res, 'Celer-A', /Celer-B: \d+\/10/);
        var m = l && l.match(/: (\d+)\/10 · perda (\d+)%/);
        check('perda medida > 0 e coerente', m && +m[2] > 0 && +m[1] < 10 &&
              Math.abs((10 - +m[1]) * 10 - +m[2]) <= 1, l);
    });
});

// ---------------------------------------------------------------------------
// Batata Quente: roda de 3 em linha (A-B-C), batata passando por 2 saltos
function batataWire(startAt) {
    return 'function(env, sim) {' +
        (startAt ? 'sim.at(' + startAt + ', function(e) { e.__harness.tap(120, 284); });' : '') +
        'for (var t = 9000; t < 60000; t += 1300) (function(t) {' +
        '  sim.at(t + (sim.id.charCodeAt(0) % 7) * 90, function(e) { e.__harness.tap(120, 278); });' +
        '})(t); }';
}
scenario('Batata Quente: roda de 3, passes multi-salto e estouro unico', function() {
    var app = 'hub_apps/Batata Quente/main.js';
    return sim.runMesh({
        durationMs: 46000, seed: 21,
        nodes: [
            { name: 'Ana', id: 'A001', app: app, wire: batataWire(8000) },
            { name: 'Bia', id: 'B002', app: app, wire: batataWire(0) },
            { name: 'Caio', id: 'C003', app: app, wire: batataWire(0) }
        ],
        links: [['Ana', 'Bia', -50], ['Bia', 'Caio', -62]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Ana');
        check('Ana comecou a rodada (bs)', airTx(res, 'Ana', /^bs\d+,\d+$/).length >= 1);
        var passes = res.air.filter(function(a) { return a.kind === 'tx' && /^bp/.test(a.data); });
        check('a batata passou de mao em mao (>= 3 passes)', passes.length >= 3, passes.length);
        check('todo passe e unicast com 2 copias', passes.every(function(a) { return a.dst && a.copies === 2; }));
        check('passes cruzaram 2 saltos (Ana <-> Caio)', res.air.some(function(a) {
            return a.kind === 'rx' && /^bp/.test(a.data) && a.hops === 2;
        }));
        var acks = res.air.filter(function(a) { return a.kind === 'tx' && /^bk/.test(a.data); });
        check('cada passe pego foi confirmado (bk)', acks.length >= passes.length - 1);
        var booms = res.air.filter(function(a) { return a.kind === 'tx' && /^bx/.test(a.data); });
        check('estourou ao menos uma vez', booms.length >= 1);
        // por rodada, um unico perdedor
        var byRound = {};
        booms.forEach(function(b) { (byRound[b.data] = byRound[b.data] || {})[b.from] = true; });
        check('um unico estouro por rodada', Object.keys(byRound).every(function(r) {
            return Object.keys(byRound[r]).length === 1;
        }), JSON.stringify(byRound));
        var loser = booms[0].from;
        check('o perdedor ve BUM', has(res, loser, 'BUM! Você queimou'));
        ['Ana', 'Bia', 'Caio'].forEach(function(n) {
            if (n !== loser) check(n + ' ve quem queimou', has(res, n, loser + ' queimou!'));
        });
    });
});

scenario('Batata Quente: passe perdido e reenviado ate alguem pegar', function() {
    var app = 'hub_apps/Batata Quente/main.js';
    return sim.runMesh({
        durationMs: 62000, seed: 8,
        nodes: [
            { name: 'Ana', id: 'A001', app: app, wire: batataWire(8000) },
            { name: 'Bia', id: 'B002', app: app, wire: batataWire(0) }
        ],
        links: [['Ana', 'Bia', -85, 0.45]]
    }).then(function(res) {
        noErr(res);
        var passes = res.air.filter(function(a) { return a.kind === 'tx' && /^bp/.test(a.data); });
        var keys = {};
        passes.forEach(function(p) { var k = p.data.split('.').slice(0, 2).join('.'); keys[k] = (keys[k] || 0) + 1; });
        check('algum passe foi reenviado (mesmo numero, nova tentativa)',
              Object.keys(keys).some(function(k) { return keys[k] > 1; }), JSON.stringify(keys));
        check('o jogo seguiu ate estourar', res.air.some(function(a) { return a.kind === 'tx' && /^bx/.test(a.data); }));
    });
});

// ---------------------------------------------------------------------------
// Mural: Caio esta fora do ar quando Ana e Bia escrevem; ao voltar, a fofoca
// (Trickle) entrega os recados por store-and-forward, e o recado dele volta
scenario('Mural: recados alcancam quem estava fora do ar', function() {
    var app = 'hub_apps/Mural/main.js';
    function writer(at, txt) {
        return 'function(env, sim) { sim.prompts([' + JSON.stringify(txt) + ']);' +
               'sim.at(' + at + ', function(e) { e.__harness.tap(120, 292); }); }';
    }
    return sim.runMesh({
        durationMs: 95000, seed: 4,
        nodes: [
            { name: 'Ana', id: 'A001', app: app, wire: writer(6000, 'cafe pronto na cozinha') },
            { name: 'Bia', id: 'B002', app: app, wire: writer(9000, 'reuniao as 15h') },
            { name: 'Caio', id: 'C003', app: app, wire: writer(60000, 'cheguei! alguem viu a chave?') }
        ],
        links: [['Ana', 'Bia', -50], ['Bia', 'Caio', -60]],
        events: [{ at: 1000, offline: 'Caio' }, { at: 25000, online: 'Caio' }]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Caio');
        var caioPosts = JSON.parse(res.nodes.Caio.storage.posts || '[]');
        var txts = caioPosts.map(function(p) { return p[2]; });
        check('Caio recebeu os 2 recados que perdeu', txts.indexOf('cafe pronto na cozinha') >= 0 &&
              txts.indexOf('reuniao as 15h') >= 0, JSON.stringify(txts));
        check('a entrega a Caio veio por refofoca (ttl 1, depois de voltar)', res.air.some(function(a) {
            return a.kind === 'rx' && a.to === 'Caio' && /^m\+.*cafe/.test(a.data) && a.t > 25000;
        }));
        var anaPosts = JSON.parse(res.nodes.Ana.storage.posts || '[]').map(function(p) { return p[2]; });
        check('o recado de Caio chegou a Ana (2 saltos)', anaPosts.indexOf('cheguei! alguem viu a chave?') >= 0,
              JSON.stringify(anaPosts));
        check('os tres murais convergiram (3 recados cada)', ['Ana', 'Bia', 'Caio'].every(function(n) {
            return JSON.parse(res.nodes[n].storage.posts || '[]').length === 3;
        }));
        check('Ana mostra "em dia" com o vizinho no fim', last(res, 'Ana', /recados · /) === '3 recados · em dia com 1 vizinho',
              last(res, 'Ana', /recados · /));
        var digests = res.air.filter(function(a) { return a.kind === 'tx' && /^m#/.test(a.data); }).length;
        check('Trickle economiza: resumos espaçados (< 1 por no a cada 3 s)', digests < 3 * 95 / 3, digests);
    });
});

// ---------------------------------------------------------------------------
// Sentinela: vigia (relogio na porta) -> repetidor que nem tem o app aberto
// (Sonar) -> central; movimento dispara, desarme por PIN volta pela malha
function vigiaWire(shakeAt) {
    return 'function(env, sim) { sim.prompts(["4321"]);' +
           'sim.at(5000, function(e) { e.__harness.tap(198, 68); });' +
           (shakeAt ? 'sim.at(' + shakeAt + ', function(e) { e.Sensors.accel = function() { return {x: 0.6, y: -0.3, z: 0.7}; }; });' : '') +
           '}';
}
scenario('Sentinela: movimento na vigia toca na central a 2 saltos e PIN desarma', function() {
    return sim.runMesh({
        durationMs: 40000, seed: 31,
        nodes: [
            { name: 'Porta', id: 'D00A', app: 'hub_apps/Sentinela/main.js', board: 'waveshare-amoled206',
              wire: vigiaWire(15000) },
            { name: 'Corredor', id: 'D00B', app: 'hub_apps/Sonar/main.js' },
            { name: 'Sala', id: 'D00C', app: 'hub_apps/Sentinela/main.js', wire: function(env, sim) {
                sim.prompts(['4321']);
                sim.at(24000, function(e) { e.__harness.tap(120, 272); });   // Desarmar tudo (PIN)
            } }
        ],
        links: [['Porta', 'Corredor', -55], ['Corredor', 'Sala', -66]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Sala');
        check('vigia armou com PIN (hash guardado, nao o PIN)', res.nodes.Porta.storage.pin &&
              res.nodes.Porta.storage.pin !== '4321' && /^[0-9a-f]{4}$/.test(res.nodes.Porta.storage.pin));
        check('sinal de vigia armada atravessa (a^1)', airTx(res, 'Porta', /^a\^1/).length >= 3);
        check('Sala lista a vigia armada', has(res, 'Sala', 'armada · sinal há'));
        var al = airTx(res, 'Porta', /^a!\d+\.m$/);
        check('movimento disparou alarme em 2 vias (ttl 8)', al.length === 2 && al[0].data === al[1].data);
        check('o Corredor repetiu sem ter o app (relay do OS)', res.nodes.Corredor.relayed > 0);
        check('Sala tocou com a zona certa', has(res, 'Sala', 'ALARME') &&
              has(res, 'Sala', '[notify] Sentinela|Porta: movimento'));
        check('a segunda via nao tocou de novo (dedup)', count(res, 'Sala', /\[notify\] Sentinela/) === 1);
        check('desarme por PIN atravessou e desarmou a vigia', res.nodes.Porta.storage.armed === '0' &&
              has(res, 'Porta', 'Desarmada por Sala'));
        check('o PIN nao trafegou em claro', !res.air.some(function(a) { return /4321/.test(a.data || ''); }));
    });
});

scenario('Sentinela: vigia armada que some do ar dispara a central', function() {
    return sim.runMesh({
        durationMs: 45000, seed: 9,
        nodes: [
            { name: 'Porta', id: 'D00A', app: 'hub_apps/Sentinela/main.js', wire: vigiaWire(0) },
            { name: 'Sala', id: 'D00C', app: 'hub_apps/Sentinela/main.js' }
        ],
        links: [['Porta', 'Sala', -60]],
        events: [{ at: 20000, offline: 'Porta' }]
    }).then(function(res) {
        noErr(res);
        check('Sala acusou a vigia sumida', has(res, 'Sala', '[notify] Sentinela|Porta: vigia sumiu'));
        var t = res.air.filter(function(a) { return a.kind === 'tx' && a.from === 'Sala' && /^a!\d+\.vD00A$/.test(a.data); });
        check('o sumico foi avisado a malha uma vez (2 vias)', t.length === 2, t.length);
        check('acusou so depois do prazo (>= 16 s sem sinal)', t.length && t[0].t >= 20000 + 11000, t.length && t[0].t);
    });
});

// ---------------------------------------------------------------------------
// Coral: 3 musicos em linha; as 4 vozes divididas sem sobra nem repeticao e
// as entradas alinhadas apesar dos 2 saltos ate a ponta
scenario('Coral: vozes divididas e entrada sincronizada por 2 saltos', function() {
    var app = 'hub_apps/Coral/main.js';
    return sim.runMesh({
        durationMs: 30000, seed: 17,
        nodes: [
            { name: 'Sala', id: 'C001', app: app, caps: 0x05, wire: function(env, sim) {
                sim.at(9000, function(e) { e.__harness.tap(120, 296); });   // Reger Ciranda
            } },
            { name: 'Cozinha', id: 'C002', app: app, caps: 0x01 },
            { name: 'Quarto', id: 'C003', app: app, caps: 0x09 }
        ],
        links: [['Sala', 'Cozinha', -52], ['Cozinha', 'Quarto', -64]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Quarto');
        var parts = ['Sala', 'Cozinha', 'Quarto'].map(function(n) {
            var ms = res.nodes[n].music;
            var song = ms.songs.length ? JSON.parse(ms.songs[ms.songs.length - 1]) : null;
            return { n: n, song: song, at: ms.startAt };
        });
        check('os 3 tocaram', parts.every(function(p) { return p.song && p.song.tracks.length >= 1; }),
              JSON.stringify(parts.map(function(p) { return p.song ? p.song.tracks.length : 0; })));
        var all = [];
        parts.forEach(function(p) { if (p.song) p.song.tracks.forEach(function(t) { all.push(JSON.stringify(t.notes.slice(0, 3)) + t.wave + t.drum); }); });
        var uniq = all.filter(function(x, i) { return all.indexOf(x) === i; });
        check('4 vozes no total, nenhuma repetida', all.length === 4 && uniq.length === 4, all.length + '/' + uniq.length);
        var ats = parts.map(function(p) { return p.at; });
        var spread = Math.max.apply(null, ats) - Math.min.apply(null, ats);
        check('entradas alinhadas (espalhamento <= 350 ms)', spread <= 350, 'spread ' + spread + ' ' + ats);
        check('Quarto ouviu a entrada por 2 saltos', res.air.some(function(a) {
            return a.kind === 'rx' && a.to === 'Quarto' && /^cg/.test(a.data) && a.hops === 2;
        }));
        check('Quarto mostra a sua parte', has(res, 'Quarto', 'Tocando: '));
    });
});

// ---------------------------------------------------------------------------
// Pong Duplo (CelerLink): pareamento por codigo (um erro antes do certo), a
// bola cruzando as duas telas e a partida terminando com placar coerente
scenario('Pong Duplo: pareamento por codigo e partida atravessando as telas', function() {
    var app = 'hub_apps/Pong Duplo/main.js';
    return sim.runMesh({
        durationMs: 240000, seed: 13,
        nodes: [
            { name: 'Mesa', id: 'E001', app: app, wire: function(env, sim) {
                sim.at(2000, function(e) { e.__harness.tap(198, 242); });   // piloto automatico
                sim.at(4000, function(e) { e.__harness.tap(120, 132); });   // Hospedar
            } },
            { name: 'Sofa', id: 'E002', app: app, wire: function(env, sim) {
                sim.prompts(['000000', function() { return sim.peerCode(); }]);
                sim.at(2000, function(e) { e.__harness.tap(198, 242); });
                sim.at(5000, function(e) { e.__harness.tap(120, 184); });   // Entrar
                sim.at(9000, function(e) { e.__harness.tap(120, 74); });    // 1o da lista
            } }
        ],
        links: [['Mesa', 'Sofa', -48]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Sofa');
        check('anfitriao mostrou um codigo de 6 digitos', count(res, 'Mesa', /^\d{6}$/) >= 1);
        check('convidado digitou o codigo (2 tentativas)', count(res, 'Sofa', /^\[prompt\] Código na tela do outro/) === 2);
        check('o codigo errado foi recusado', has(res, 'Sofa', 'Código errado'));
        var balls = res.air.filter(function(a) { return a.kind === 'ltx' && /"t":"b"/.test(a.data); });
        check('a bola cruzou nos dois sentidos', balls.some(function(b) { return b.from === 'Mesa'; }) &&
              balls.some(function(b) { return b.from === 'Sofa'; }), balls.length);
        var won = has(res, 'Mesa', 'Você venceu!') ? 'Mesa' : has(res, 'Sofa', 'Você venceu!') ? 'Sofa' : null;
        check('alguem venceu a partida', won !== null);
        var lost = won === 'Mesa' ? 'Sofa' : 'Mesa';
        check('o outro perdeu (placares espelhados)', won && has(res, lost, 'Você perdeu'));
        var points = res.air.filter(function(a) { return a.kind === 'ltx' && /"t":"p"/.test(a.data); });
        check('5 pontos para o vencedor', points.filter(function(p) { return p.from === lost; }).length === 5);
    });
});

// ---------------------------------------------------------------------------
// Matilha (app de sistema): a festa itinerante entre o cachorro e o quadro,
// mensagem direta (Pack.send) e para todos (CelerNet.broadcast)
scenario('Matilha: festa passa do cachorro ao quadro e mensagens chegam', function() {
    var app = 'data/apps/Matilha/main.js';
    return sim.runMesh({
        durationMs: 30000, seed: 2,
        nodes: [
            { name: 'Celer-Dog', id: 'D06A', app: app, caps: 0x1B, wire: function(env, sim) {
                sim.at(3000, function(e) {
                    e.System.playMusic({ bpm: 128, loops: 8, tracks: [
                        { wave: 'sq', vol: 80, notes: [[64, 2], [67, 2], [71, 2], [74, 2]] },
                        { drum: true, vol: 90, notes: [[36, 4], [42, 2], [42, 2]] }] });
                });
                sim.at(8000, function(e) { e.__harness.tap(120, 247); });   // Passar a musica
                sim.prompts(['bora brincar?']);
                sim.at(14000, function(e) { e.__harness.tap(120, 285); });  // Mensagem para todos
            } },
            { name: 'Celer-AB3E', id: 'AB3E', app: app, caps: 0x05, wire: function(env, sim) {
                sim.prompts(['au?']);
                sim.at(12000, function(e) { e.__harness.tap(120, 144); });  // 1o membro: mensagem direta
            } }
        ],
        links: [['Celer-Dog', 'Celer-AB3E', -28]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Celer-Dog');
        var ho = res.air.filter(function(a) { return a.kind === 'tx' && a.pack === 1; });
        check('handoff saiu como envelope de musica urgente', ho.length === 1 && ho[0].dst === 'AB3E');
        check('a festa chegou ao quadro do mesmo ponto', /\[pack\] festa chegou de Celer-Dog @\d+ms/.test(
              (last(res, 'Celer-AB3E', /festa chegou/) || '')), last(res, 'Celer-AB3E', /festa/));
        var pos = +((last(res, 'Celer-AB3E', /festa chegou/) || '@0ms').match(/@(\d+)ms/)[1]);
        check('retomou de ~5 s de musica (o seek viajou)', pos >= 4500 && pos <= 5600, pos);
        check('o cachorro parou de tocar', res.nodes['Celer-Dog'].music.playing === false);
        check('mensagem direta (Pack.send) chegou ao cachorro', has(res, 'Celer-Dog', 'Celer-AB3E (direta): au?'));
        check('a direta (fragmentada, 2 copias) foi entregue uma vez so', res.air.filter(function(a) {
            return a.kind === 'rx' && a.to === 'Celer-Dog' && a.data === '{"de":"Celer-AB3E","texto":"au?"}';
        }).length === 1 && count(res, 'Celer-Dog', /\(direta\): au\?/) >= 1);
        check('mensagem para todos chegou ao quadro', has(res, 'Celer-AB3E', 'Celer-Dog: bora brincar?'));
    });
});

// Contrato do firmware que pega desavisados: mensagem CRUA comecando com
// 'P' (>= 4 B) e engolida pelo servico Pack — nunca chega ao CelerNet.poll
scenario('CelerNet: mensagem crua com "P" no inicio some (magic do envelope)', function() {
    var src = 'test/meshsim/fixtures/eco.js';
    return sim.runMesh({
        durationMs: 12000, seed: 1,
        nodes: [
            { name: 'A', id: 'AAAA', app: src, wire: function(env, sim) {
                sim.at(5000, function(e) {
                    e.CelerNet.broadcast('Ping 1');
                    e.CelerNet.broadcast('ping 2');
                    e.CelerNet.broadcast('Pi');
                });
            } },
            { name: 'B', id: 'BBBB', app: src }
        ],
        links: [['A', 'B', -50]]
    }).then(function(res) {
        noErr(res);
        check('"ping 2" (minusculo) chega', has(res, 'B', 'rx ping 2 de A'));
        check('"Pi" (3 B, curta demais p/ envelope) chega', has(res, 'B', 'rx Pi de A'));
        check('"Ping 1" foi engolida pelo Pack', !has(res, 'B', 'Ping 1') && res.nodes.B.stats.swallowed === 1);
    });
});

// ---------------------------------------------------------------------------
// CelerNet v3 (API 37): a rede e a matilha do no (nome + senha), nunca a do
// app. Mesmo nome com senha errada = outra chave: nada se ouve nem se repete.
// Mic/camera so abrem na matilha privada (na "celer" aberta: denied).
scenario('CelerNet v3: matilhas isoladas e mic so na privada', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    var pack = { name: 'bancada', pass: 'senha-forte-1' };
    // o wire viaja por toString (sem closure): a etiqueta e o nome do no
    function probe(env, sim) {
            sim.at(2000, function(e) {
                // o net do app e ignorado: a matilha do no vale
                e.CelerNet.start({ net: 'outra-rede' });
            });
            sim.at(4500, function(e) { e.CelerNet.broadcast(e.CelerNet.status().name + ' ola'); });
            sim.at(9000, function(e) {
                var st = e.CelerNet.status();
                sim.note('rede ' + st.net + ' secure=' + st.secure + ' nos=' +
                         e.CelerNet.nodes().map(function(n) { return n.name; }).sort().join(','));
                var m, got = [];
                while ((m = e.CelerNet.poll()) !== null) got.push(m.msg);
                sim.note('rx ' + got.sort().join('|'));
                e.Pack.resources();
            });
            sim.at(12000, function(e) {
                var mics = e.Pack.resources('mic');
                sim.note('mics ' + mics.map(function(r) { return r.nodeName; }).join(','));
                if (mics.length) sim.h = e.Pack.open(mics[0].nodeName, 'mic');
            });
            sim.at(16000, function(e) {
                if (sim.h === undefined) return;
                var st = e.Pack.status(sim.h);
                sim.note('mic ' + st.state + '/' + st.reason);
            });
    }
    return sim.runMesh({
        durationMs: 20000, seed: 11,
        nodes: [
            { name: 'A', id: 'AAAA', app: src, caps: 0x02, pack: pack, wire: probe },
            { name: 'B', id: 'BBBB', app: src, caps: 0x04, pack: pack, wire: probe },
            { name: 'Intruso', id: 'C0C0', app: src, caps: 0x02, pack: { name: 'bancada', pass: 'chute' },
              wire: probe },
            { name: 'Aberto1', id: 'D1D1', app: src, caps: 0x02, wire: probe },
            { name: 'Aberto2', id: 'D2D2', app: src, caps: 0x04, wire: probe }
        ],
        links: [['A', 'B', -50], ['A', 'Intruso', -50], ['B', 'Intruso', -50], ['Intruso', 'Aberto1', -50],
                ['A', 'Aberto1', -55], ['Aberto1', 'Aberto2', -50]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'A'); dump(res, 'B'); dump(res, 'Intruso'); dump(res, 'Aberto2');
        check('matilha: A e B se veem (net do app ignorado)', has(res, 'B', '[sim] rede bancada secure=true nos=A') &&
              has(res, 'A', '[sim] rede bancada secure=true nos=B'));
        check('senha errada nao ve ninguem', has(res, 'Intruso', '[sim] rede bancada secure=true nos='));
        check('broadcast da matilha nao vaza', has(res, 'B', '[sim] rx A ola') &&
              !has(res, 'Intruso', 'A ola') && !has(res, 'Aberto1', 'A ola'));
        check('rede aberta separada da matilha', has(res, 'Aberto2', '[sim] rede celer secure=false nos=Aberto1') &&
              has(res, 'Aberto2', '[sim] rx Aberto1 ola'));
        // provedor sem driver de mic no sim: passar da politica = unsupported
        check('mic na matilha passa da politica', has(res, 'B', '[sim] mic refused/unsupported'));
        check('mic na rede aberta = denied', has(res, 'Aberto2', '[sim] mic refused/denied'));
    });
});

// ---------------------------------------------------------------------------
// Entrar na matilha (API 40): os tres pilares juntos. O aparelho novo abre a
// janela de convite (CelerLink anunciando com codigo); o membro conecta,
// digita o codigo e manda a chave pelo selo do bond (Pack.invite). O novo
// passa a ouvir a matilha e o mic dele sai do "denied" da rede aberta. Um
// terceiro entra pela porta da senha (Pack.join) e o convite fora da janela
// e ignorado.
scenario('Matilha: convite selado pelo CelerLink e Pack.join', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    var pack = { name: 'bancada', pass: 'senha-forte-1' };
    function membro(env, sim) {
            sim.at(500, function(e) { e.CelerNet.start({}); });
            sim.at(2000, function(e) {
                var ps = e.CelerLink.scan(2000);
                var alvo = null;
                for (var i = 0; i < ps.length; i++) if (ps[i].name === 'Novo') alvo = ps[i];
                if (!alvo || !e.CelerLink.connect(alvo.id, 4000)) { sim.note('sem alvo'); return; }
                sim.note('verify ' + e.CelerLink.verify(sim.peerCode()));
                sim.note('invite ' + e.Pack.invite());
            });
            sim.at(9000, function(e) { sim.note('convite ' + e.Pack.inviteStatus()); });
            sim.at(16000, function(e) {
                sim.note('nos ' + e.CelerNet.nodes().map(function(n) { return n.name; }).sort().join(','));
            });
    }
    function novo(env, sim) {
            sim.at(500, function(e) {
                e.CelerNet.start({ name: 'Novo' });
                e.CelerLink.start('Novo');
                sim.note('antes ' + e.Pack.me().net + ' prov=' + e.Pack.me().provisioned);
                e.Pack.acceptInvite(true);
            });
            sim.at(9000, function(e) {
                var me = e.Pack.me();
                sim.note('depois ' + me.net + ' prov=' + me.provisioned + ' st=' + e.Pack.inviteStatus());
                sim.note('selados p/ app ' + (e.CelerLink.pollSealed() === null ? 'nenhum' : 'vazou'));
            });
            sim.at(16000, function(e) {
                sim.note('nos ' + e.CelerNet.nodes().map(function(n) { return n.name; }).sort().join(','));
            });
    }
    function senha(env, sim) {
            sim.at(500, function(e) { e.CelerNet.start({ name: 'Senha' }); });
            sim.at(3000, function(e) {
                sim.note('curta ' + e.Pack.join('bancada', 'curta'));
                sim.note('join ' + e.Pack.join('bancada', 'senha-forte-1'));
            });
            sim.at(16000, function(e) {
                sim.note('nos ' + e.CelerNet.nodes().map(function(n) { return n.name; }).sort().join(','));
            });
    }
    return sim.runMesh({
        durationMs: 18000, seed: 21,
        nodes: [
            { name: 'A', id: 'AAAA', app: src, caps: 0x02, pack: pack, wire: membro },
            { name: 'Novo', id: 'B0B0', app: src, caps: 0x04, wire: novo },
            { name: 'Senha', id: 'C0C0', app: src, caps: 0x04, wire: senha }
        ],
        links: [['A', 'Novo', -50], ['A', 'Senha', -50], ['Novo', 'Senha', -50]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'A'); dump(res, 'Novo'); dump(res, 'Senha');
        check('novo comeca na rede aberta', has(res, 'Novo', '[sim] antes celer prov=false'));
        check('membro verifica o codigo e convida', has(res, 'A', '[sim] verify true') &&
              has(res, 'A', '[sim] invite true'));
        check('novo entra pelo convite', has(res, 'Novo', '[sim] depois bancada prov=true st=joined'));
        check('ACK volta ao membro', has(res, 'A', '[sim] convite ok'));
        check('quadro do convite nunca chega ao app', has(res, 'Novo', '[sim] selados p/ app nenhum'));
        check('senha curta recusada', has(res, 'Senha', '[sim] curta false'));
        check('porta da senha', has(res, 'Senha', '[sim] join true'));
        check('as tres portas na mesma matilha', has(res, 'A', '[sim] nos Novo,Senha') &&
              has(res, 'Novo', '[sim] nos A,Senha') && has(res, 'Senha', '[sim] nos A,Novo'));
    });
});

// ---------------------------------------------------------------------------
// O PC como no virtual (API 41): o gateway com o cabo (res_share_usb=1)
// anuncia o PC com id proprio (0xFF00 | byte baixo do gateway); os membros o
// listam, mandam envelopes para "pc-XXXX" (chegam no cabo, nunca nos apps
// do gateway) e recebem os dele. Outra matilha nao ve o PC; cabo fora = o
// PC some da presenca.
scenario('No virtual: o PC na matilha pelo gateway', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    var pack = { name: 'bancada', pass: 'senha-forte-1' };
    function gw(env, sim) {
            sim.at(500, function(e) { e.CelerNet.start({ name: 'Gw' }); });
            sim.at(1500, function(e) { sim.note('pc ' + sim.pcAttach(true)); });
            sim.at(9000, function(e) {
                sim.pcInbox().forEach(function(m) {
                    sim.note('pc recebeu ' + m.data + ' de ' + m.fromName + (m.raw ? ' cru' : ''));
                });
                var x;
                while ((x = e.Pack.poll()) !== null) sim.note('app do gw viu ' + x.data);
                sim.note('pcSend ' + sim.pcSend('W', 'oi do pc'));
            });
            sim.at(14000, function(e) { sim.pcAttach(false); });
    }
    function membro(env, sim) {
            sim.at(500, function(e) { e.CelerNet.start({ name: 'W' }); });
            sim.at(6000, function(e) {
                var pcs = e.Pack.members().filter(function(m) { return m.name.indexOf('pc-') === 0; });
                sim.note('membros pc ' + pcs.map(function(m) { return m.name + '/' + m.id + '/hub=' + m.caps.hub; }).join(','));
                sim.note('send ' + e.Pack.send('pc-AA01', 'oi pc'));
                e.CelerNet.send('pc-AA01', 'cru');
            });
            sim.at(13000, function(e) {
                var x;
                while ((x = e.Pack.poll()) !== null) sim.note('poll ' + x.data + ' de ' + x.fromName + '/' + x.from);
            });
            sim.at(17000, function(e) {
                sim.note('depois ' + e.Pack.members().map(function(m) { return m.name; }).sort().join(','));
            });
    }
    function fora(env, sim) {
            sim.at(500, function(e) { e.CelerNet.start({ name: 'Fora' }); });
            sim.at(6000, function(e) {
                sim.note('fora ve ' + e.Pack.members().map(function(m) { return m.name; }).join(','));
            });
    }
    return sim.runMesh({
        durationMs: 18000, seed: 31,
        nodes: [
            { name: 'Gw', id: 'AA01', app: src, caps: 0x04, pack: pack, wire: gw },
            { name: 'W', id: 'BB02', app: src, caps: 0x02, pack: pack, wire: membro },
            { name: 'Fora', id: 'CC03', app: src, caps: 0x02, pack: { name: 'outra', pass: 'senha-forte-2' },
              wire: fora }
        ],
        links: [['Gw', 'W', -50], ['Gw', 'Fora', -50], ['W', 'Fora', -50]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Gw'); dump(res, 'W'); dump(res, 'Fora');
        check('id do PC derivado do gateway', has(res, 'Gw', '[sim] pc FF01'));
        check('membro lista o PC (hub)', has(res, 'W', '[sim] membros pc pc-AA01/FF01/hub=true'));
        check('envelope do membro chega ao PC', has(res, 'Gw', '[sim] pc recebeu oi pc de W'));
        check('mensagem crua tambem chega ao PC', has(res, 'Gw', '[sim] pc recebeu cru de W cru'));
        check('nada para o PC vaza aos apps do gateway', !has(res, 'Gw', 'app do gw viu'));
        check('o PC fala com a matilha', has(res, 'Gw', '[sim] pcSend true') &&
              has(res, 'W', '[sim] poll oi do pc de pc-AA01/FF01'));
        check('outra matilha nao ve o PC', has(res, 'Fora', '[sim] fora ve ') && !has(res, 'Fora', 'pc-AA01'));
        check('cabo fora: PC sai da presenca', has(res, 'W', '[sim] depois Gw'));
    });
});

// ---------------------------------------------------------------------------
// Dedup de envelopes (a semantica do duplo transporte): o Pack.send do
// firmware sai sempre com 2 copias (cada uma com seq propria no fio) e a
// MESMA msgId no envelope — o destino tem que enxergar as 2 copias no ar e
// entregar 1 vez so (a 2a vira rxDup contado, como o seenBefore do Pack.cpp)
scenario('Pack: 2 copias no ar, 1 entrega (dedup por msgId)', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    return sim.runMesh({
        durationMs: 14000, seed: 51,
        nodes: [
            { name: 'Em', id: 'A111', app: src, wire: function(env, sim) {
                sim.at(5000, function(e) { sim.note('envio ' + e.Pack.send('Rec', 'oi')); });
            } },
            { name: 'Rec', id: 'B222', app: src, wire: function(env, sim) {
                sim.at(10000, function(e) {
                    var m, got = [];
                    while ((m = e.Pack.poll()) !== null) got.push(m.data + ' de ' + m.fromName);
                    sim.note('poll ' + got.join('|'));
                });
                sim.at(12500, function(e) {
                    sim.note('poll2 ' + (e.Pack.poll() === null ? 'vazio' : 'denovo'));
                });
            } }
        ],
        links: [['Em', 'Rec', -50]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Rec');
        check('o envio saiu com as 2 copias de fabrica', has(res, 'Em', '[sim] envio true'));
        var rx = res.air.filter(function(a) { return a.kind === 'rx' && a.to === 'Rec' && a.data === 'oi'; });
        check('as 2 copias chegaram de verdade no destino', rx.length === 2, rx.length);
        check('o app viu a mensagem 1 vez so', has(res, 'Rec', '[sim] poll oi de Em'));
        check('a 2a copia foi consumida como duplicata (rxDup)', res.nodes.Rec.stats.rxDup === 1,
              res.nodes.Rec.stats.rxDup);
        check('a fila do Pack nao guardou fantasma', last(res, 'Rec', /\[sim\] poll2/) === '[sim] poll2 vazio',
              last(res, 'Rec', /\[sim\] poll2/));
    });
});

// ---------------------------------------------------------------------------
// Politica do dono fechada (a semantica da recusa de midia/recurso): o
// interruptor "0" recusa TODOS os nativos com o motivo certo (denied), mesmo
// os prontos e compartilhados — a politica fala antes do driver (na vaza se
// o dono tem o hardware) e antes do busy. Recusa e no USO: o catalogo
// continua listando. E o handle recusado e terminal: o cliente nao reteia.
scenario('Recursos: politica fechada recusa com o motivo certo e sem re-tentativa', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    var pack = { name: 'fechada', pass: 'senha-forte-3' };
    return sim.runMesh({
        durationMs: 26000, seed: 53,
        nodes: [
            { name: 'Fechado', id: 'B0B0', app: src, caps: 0x43, relays: 1, sensors: ['lum'],
              pack: pack,
              settings: { res_share_mic: '0', res_share_spk: '0', res_share_cam: '0',
                          res_share_gpio: '0', res_share_sensor: '0' } },
            { name: 'Cli', id: 'C0C0', app: src, caps: 0x04, pack: pack,
              wire: function(env, sim) {
                  var h = {};
                  sim.at(4200, function(e) { e.Pack.resources(); });  // primao DESCRIBE
                  sim.at(5500, function(e) {
                      sim.note('catalogo ' + e.Pack.resources().map(function(r) {
                          return r.nodeName + '/' + r.name;
                      }).sort().join(','));
                      h.mic = e.Pack.open('Fechado', 'mic');
                      h.spk = e.Pack.open('Fechado', 'speaker');
                      h.cam = e.Pack.open('Fechado', 'camera');
                      h.rel = e.Pack.open('Fechado', 'rele1');
                      h.lum = e.Pack.open('Fechado', 'lum');
                  });
                  sim.at(9000, function(e) {
                      ['mic', 'spk', 'cam', 'rel', 'lum'].forEach(function(k) {
                          var st = e.Pack.status(h[k]);
                          sim.note('st ' + k + ' ' + st.state + (st.reason ? '/' + st.reason : ''));
                      });
                  });
                  sim.at(24000, function(e) {
                      var st = e.Pack.status(h.mic);
                      sim.note('fim ' + st.state + '/' + st.reason);
                  });
              } }
        ],
        links: [['Fechado', 'Cli', -50]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Cli'); dump(res, 'Fechado');
        var catalogo = last(res, 'Cli', /\[sim\] catalogo /) || '';
        check('catalogo lista os fechados (a recusa e no uso, nao na vitrine)',
              catalogo.indexOf('Fechado/mic') >= 0 && catalogo.indexOf('Fechado/rele1') >= 0 &&
              catalogo.indexOf('Fechado/lum') >= 0, catalogo);
        check('mic fechado = denied', has(res, 'Cli', '[sim] st mic refused/denied'));
        check('speaker fechado = denied', has(res, 'Cli', '[sim] st spk refused/denied'));
        check('camera fechada = denied', has(res, 'Cli', '[sim] st cam refused/denied'));
        check('rele fechado = denied', has(res, 'Cli', '[sim] st rel refused/denied'));
        check('sensor pronto e compartilhado TAMBEM denied (politica fala antes)',
              has(res, 'Cli', '[sim] st lum refused/denied'));
        var pediu = res.nodes.Fechado.log.filter(function(l) { return /pediu "/.test(l); });
        check('um pedido por recurso, sem re-tentativa da recusa', pediu.length === 5 &&
              ['mic', 'speaker', 'camera', 'rele1', 'lum'].every(function(n) {
                  return pediu.filter(function(l) { return l.indexOf('"' + n + '"') >= 0; }).length === 1;
              }), pediu.join(' | '));
        check('handle recusado fica terminal ate o fim', has(res, 'Cli', '[sim] fim refused/denied'));
    });
});

// ---------------------------------------------------------------------------
// O no virtual quando a sessao acaba (o ciclo inteiro do cabo): ligado, o PC
// e membro e recebe envelopes; o cabo cai, ele SAI da presenca e o send para
// o id dele passa a falhar (nada do PC falido vai ao ar nem vira fantasma);
// o cabo volta e o PC retorna com a conversa retomando. O gateway nunca ve
// o trafego do PC (o cabo nao e do app).
scenario('No virtual: cabo cai, PC sai da presenca; cabo volta, PC retorna', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    var pack = { name: 'bancada', pass: 'senha-forte-1' };
    function gw(env, sim) {
            sim.at(1500, function(e) { sim.note('pc ' + sim.pcAttach(true)); });
            sim.at(5000, function(e) {
                sim.note('caixa ' + sim.pcInbox().map(function(m) {
                    return m.data + ' de ' + m.fromName;
                }).join('|'));
                var x, vazou = false;
                while ((x = e.Pack.poll()) !== null) vazou = true;
                sim.note('vazou ' + vazou);
            });
            sim.at(6000, function(e) { sim.pcAttach(false); });
            sim.at(12000, function(e) { sim.pcAttach(true); });
            sim.at(15500, function(e) {
                sim.note('caixa2 ' + sim.pcInbox().map(function(m) { return m.data; }).join('|'));
            });
    }
    function membro(env, sim) {
            sim.at(4000, function(e) {
                sim.note('membros1 ' + e.Pack.members().map(function(m) { return m.name; }).sort().join(','));
                sim.note('envio1 ' + e.Pack.send('pc-AA01', 'antes'));
            });
            sim.at(8000, function(e) {
                sim.note('membros2 ' + e.Pack.members().map(function(m) { return m.name; }).sort().join(','));
                sim.note('envio2 ' + e.Pack.send('pc-AA01', 'depois'));
                sim.note('envio3 ' + e.CelerNet.send('pc-AA01', 'cru'));
            });
            sim.at(9500, function(e) {
                sim.note('poll ' + (e.Pack.poll() === null ? 'vazio' : 'fantasma'));
            });
            sim.at(13500, function(e) {
                sim.note('membros3 ' + e.Pack.members().map(function(m) { return m.name; }).sort().join(','));
                sim.note('envio4 ' + e.Pack.send('pc-AA01', 'volta'));
            });
    }
    return sim.runMesh({
        durationMs: 18000, seed: 37,
        nodes: [
            { name: 'Gw', id: 'AA01', app: src, caps: 0x04, pack: pack, wire: gw },
            { name: 'W', id: 'BB02', app: src, caps: 0x02, pack: pack, wire: membro }
        ],
        links: [['Gw', 'W', -50]]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Gw'); dump(res, 'W');
        check('PC e membro com o cabo ligado', has(res, 'W', '[sim] membros1 Gw,pc-AA01'));
        check('envelope chega ao PC (dedup deixou 1 copia na caixa)',
              has(res, 'Gw', '[sim] caixa antes de W'));
        check('trafego do PC nunca vaza para o app do gateway', has(res, 'Gw', '[sim] vazou false'));
        check('cabo fora: PC sai da presenca', has(res, 'W', '[sim] membros2 Gw'));
        check('send para o PC sumido falha (envelope e cru)', has(res, 'W', '[sim] envio2 false') &&
              has(res, 'W', '[sim] envio3 false'));
        check('nada do PC falido foi ao ar', !res.air.some(function(a) {
            return a.kind === 'tx' && (a.data === 'depois' || a.data === 'cru');
        }));
        check('nenhuma mensagem fantasma no poll com o cabo fora', has(res, 'W', '[sim] poll vazio'));
        check('cabo de volta: PC retorna a presenca', has(res, 'W', '[sim] membros3 Gw,pc-AA01'));
        check('a conversa com o PC retoma', has(res, 'W', '[sim] envio4 true') &&
              has(res, 'Gw', '[sim] caixa2 volta'));
    });
});

// ---------------------------------------------------------------------------
// Recursos da matilha (API 36): DESCRIBE/LIST, canal de dados compartilhado,
// exclusivo (busy), politica do dono, nativo sem provedor, escrita do
// cliente, lease que vence quando o cliente some e REVOKE no unexpose
scenario('Recursos: descoberta, sessoes, leases e revogacao', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    return sim.runMesh({
        durationMs: 60000, seed: 3,
        nodes: [
            { name: 'Prov', id: 'A0A0', app: src, caps: 0x03, settings: { res_share_mic: '0' },
              wire: function(env, sim) {
                sim.at(2500, function(e) {
                    sim.note('expose temp ' + e.Pack.expose('temp'));
                    sim.note('expose botao ' + e.Pack.expose('botao', { shared: false }));
                    sim.note('expose dup ' + e.Pack.expose('temp'));
                });
                for (var t = 8000; t <= 20000; t += 1000) {
                    (function(t) {
                        sim.at(t, function(e) { sim.note('pub ' + t + ' -> ' + e.Pack.publish('temp', 'T' + t)); });
                    })(t);
                }
                sim.at(15000, function(e) {
                    var w = e.Pack.pollWrite();
                    sim.note('escrita ' + (w ? w.res + ':' + w.data + ' de ' + w.fromName : 'nenhuma'));
                });
                sim.at(21000, function(e) { sim.note('sessoes temp ' + e.Pack.sessions('temp')); });
                sim.at(30000, function(e) { sim.note('unexpose ' + e.Pack.unexpose('temp')); });
                sim.at(54000, function(e) { sim.note('sessoes botao ' + e.Pack.sessions('botao')); });
            } },
            { name: 'Cli', id: 'C1C1', app: src, caps: 0x04, wire: function(env, sim) {
                var h = {};
                sim.at(4000, function(e) { e.Pack.resources(); });
                sim.at(7000, function(e) {
                    sim.note('lista ' + e.Pack.resources().map(function(r) {
                        return r.nodeName + '/' + r.name + '/' + r.type + (r.ready ? '/ok' : '') + (r.shared ? '/sh' : '');
                    }).join(','));
                    sim.note('so mic ' + e.Pack.resources('mic').length);
                    h.temp = e.Pack.open('Prov', 'temp');
                    h.mic = e.Pack.open('Prov', 'mic');
                    h.spk = e.Pack.open('Prov', 'speaker');
                    h.nada = e.Pack.open('Prov', 'nada');
                    h.botao = e.Pack.open('Prov', 'botao');
                });
                sim.at(10000, function(e) {
                    ['temp', 'mic', 'spk', 'nada', 'botao'].forEach(function(k) {
                        var st = e.Pack.status(h[k]);
                        sim.note('st ' + k + ' ' + st.state + (st.reason ? '/' + st.reason : ''));
                    });
                    sim.note('write botao ' + e.Pack.write(h.botao, 'click'));
                });
                for (var t = 9000; t <= 21000; t += 2000) {
                    sim.at(t, function(e) {
                        var d, got = [];
                        while ((d = e.Pack.read(h.temp)) !== null) got.push(d);
                        sim.note('leu ' + got.join('|'));
                    });
                }
            } },
            { name: 'C2', id: 'C2C2', app: src, caps: 0x04, wire: function(env, sim) {
                var h = {};
                sim.at(11000, function(e) {
                    h.botao = e.Pack.open('Prov', 'botao');
                    h.temp = e.Pack.open('Prov', 'temp');
                });
                sim.at(16000, function(e) {
                    sim.note('c2 botao ' + e.Pack.status(h.botao).state + '/' + e.Pack.status(h.botao).reason);
                    sim.note('c2 temp ' + e.Pack.status(h.temp).state);
                });
                sim.at(34000, function(e) {
                    var st = e.Pack.status(h.temp);
                    sim.note('c2 temp depois ' + st.state + '/' + st.reason);
                });
                // lease do Cli (offline aos 22 s) vence ~20 s depois do ultimo KEEP
                sim.at(47000, function(e) { h.botao2 = e.Pack.open('Prov', 'botao'); });
                sim.at(52000, function(e) { sim.note('c2 botao2 ' + e.Pack.status(h.botao2).state); });
            } }
        ],
        links: [['Prov', 'Cli', -50], ['Prov', 'C2', -55], ['Cli', 'C2', -60]],
        events: [{ at: 22000, offline: 'Cli' }]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Cli'); dump(res, 'Prov'); dump(res, 'C2');
        check('expose ok e duplicado recusado', has(res, 'Prov', '[sim] expose temp true') &&
              has(res, 'Prov', '[sim] expose botao true') && has(res, 'Prov', '[sim] expose dup false'));
        var lista = last(res, 'Cli', /\[sim\] lista /) || '';
        check('LIST traz nativos e canais', /Prov\/mic\/mic/.test(lista) && /Prov\/speaker\/speaker/.test(lista) &&
              /Prov\/temp\/data\/ok\/sh/.test(lista) && /Prov\/botao\/data\/ok(?!\/sh)/.test(lista), lista);
        check('filtro por tipo', has(res, 'Cli', '[sim] so mic 1'));
        check('canal compartilhado abre', has(res, 'Cli', '[sim] st temp open'));
        check('mic com politica do dono = denied', has(res, 'Cli', '[sim] st mic refused/denied'));
        check('speaker sem provedor = unsupported', has(res, 'Cli', '[sim] st spk refused/unsupported'));
        check('nome desconhecido = notFound', has(res, 'Cli', '[sim] st nada refused/notFound'));
        check('exclusivo abre para o 1o', has(res, 'Cli', '[sim] st botao open'));
        check('exclusivo ocupado para o 2o', has(res, 'C2', '[sim] c2 botao refused/busy'));
        check('compartilhado abre para o 2o', has(res, 'C2', '[sim] c2 temp open'));
        check('escrita do cliente chega ao provedor', has(res, 'Prov', '[sim] escrita botao:click de Cli'));
        var leu = res.nodes.Cli.log.filter(function(l) { return l.indexOf('[sim] leu ') === 0; }).join(' ');
        var ts = (leu.match(/T\d+/g) || []).map(function(x) { return +x.slice(1); });
        check('publicacoes chegam todas e em ordem', ts.join(',') ===
              [8000, 9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000, 20000].join(','), leu);
        check('publish alcanca as 2 sessoes', has(res, 'Prov', '[sim] pub 14000 -> 2'));
        check('lease do cliente que sumiu vence', has(res, 'Prov', 'lease de C1C1 venceu'));
        check('unexpose revoga a sessao do C2', has(res, 'Prov', '[sim] unexpose true') &&
              has(res, 'C2', '[sim] c2 temp depois revoked/gone'));
        check('exclusivo liberado volta a abrir', has(res, 'C2', '[sim] c2 botao2 open') &&
              has(res, 'Prov', '[sim] sessoes botao 1'));
    });
});

// ---------------------------------------------------------------------------
// Recursos API 38: gpio/relé como recurso (privada + interruptor do dono
// default "0", atuacao na hora, leitura de volta) com AUTO-OFF no fim do
// lease, e sensor com metadados no catalogo (unidade/faixa) + stream por
// taxa + leitura por pedido
scenario('Recursos Onda A: rele com auto-off e sensor com meta', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    return sim.runMesh({
        durationMs: 52000, seed: 7,
        nodes: [
            { name: 'Releiro', id: 'F1F1', app: src, caps: 0x01, relays: 2,
              pack: { name: 'fazenda', pass: 'senhaforte' },
              settings: { res_share_gpio: '1' },
              wire: function(env, sim) {
                // oraculo do "fisico": o estado do rele na placa simulada
                sim.at(13000, function(e) { sim.note('rele1=' + e.Pack.relayState('rele1')); });
                sim.at(40000, function(e) { sim.note('rele1=' + e.Pack.relayState('rele1')); });
                sim.at(43000, function(e) { sim.note('rele1=' + e.Pack.relayState('rele1')); });
              } },
            { name: 'Fechado', id: 'F4F4', app: src, caps: 0x01, relays: 1,
              pack: { name: 'fazenda', pass: 'senhaforte' } },  // policy default "0"
            { name: 'Sensor', id: 'F2F2', app: src, caps: 0x04, sensors: ['lum', 'bat'],
              pack: { name: 'fazenda', pass: 'senhaforte' } },
            { name: 'Cli', id: 'F3F3', app: src, caps: 0x04,
              pack: { name: 'fazenda', pass: 'senhaforte' },
              wire: function(env, sim) {
                var h = {};
                sim.at(4200, function(e) { e.Pack.resources(); });  // primao DESCRIBE
                sim.at(5500, function(e) {
                    var meta = e.Pack.resources().filter(function(r) {
                        return r.type === 'gpio' || r.type === 'sensor';
                    }).map(function(r) {
                        return r.nodeName + '/' + r.name + (r.schema ? '/sch:' + r.schema : '') +
                               (r.unit ? '/' + r.unit + ':' + r.min + '-' + r.max : '');
                    }).join(',');
                    sim.note('meta ' + meta);
                });
                sim.at(6000, function(e) {
                    h.rel = e.Pack.open('Releiro', 'rele1', { off: 1 });
                    h.neg = e.Pack.open('Fechado', 'rele1');
                    h.lum = e.Pack.open('Sensor', 'lum', { rate: 5000 });
                    h.bat = e.Pack.open('Sensor', 'bat');  // rate 0: so por pedido
                });
                sim.at(9000, function(e) {
                    ['rel', 'neg', 'lum', 'bat'].forEach(function(k) {
                        var st = e.Pack.status(h[k]);
                        sim.note('st ' + k + ' ' + st.state + (st.reason ? '/' + st.reason : ''));
                    });
                });
                sim.at(10000, function(e) { sim.note('liga ' + e.Pack.write(h.rel, '{"w":1}')); });
                sim.at(12000, function(e) { e.Pack.write(h.bat, '{"r":1}'); });
                sim.at(14000, function(e) { e.Pack.write(h.rel, '{"r":1}'); });
                // API 47: o schema do rele cresceu no LIST_META — 1 s de folga
                // para o RESP do rel na malha (o comportamento e o mesmo)
                sim.at(17000, function(e) {
                    var d, got = [];
                    while ((d = e.Pack.read(h.rel)) !== null) got.push(JSON.stringify(d));
                    sim.note('volta rele ' + got.join('|'));
                    d = null; got = [];
                    while ((d = e.Pack.read(h.bat)) !== null) got.push(String(d.v));
                    sim.note('sob pedido ' + got.join('|'));
                    d = null; got = [];
                    while ((d = e.Pack.read(h.lum)) !== null) got.push(String(d.v));
                    sim.note('stream ' + got.join('|'));
                });
                // sai do ar: o lease vence ~20 s depois do ultimo KEEP e o
                // auto-off tem que desligar o rele sozinho
                sim.at(18500, function(e) { e.Pack.close(h.lum); e.Pack.close(h.bat); });
              } },
            { name: 'C2', id: 'F5F5', app: src, caps: 0x04,
              pack: { name: 'fazenda', pass: 'senhaforte' },
              wire: function(env, sim) {
                var h2 = {};
                sim.at(12000, function(e) { h2.b = e.Pack.open('Releiro', 'rele1'); });
                sim.at(15000, function(e) {
                    var st = e.Pack.status(h2.b);
                    sim.note('c2 rele ' + st.state + '/' + st.reason);
                });
                sim.at(38500, function(e) { h2.c = e.Pack.open('Releiro', 'rele1', { off: 1 }); });
                sim.at(40500, function(e) { sim.note('c2 volta ' + e.Pack.status(h2.c).state); });
                sim.at(41000, function(e) { e.Pack.write(h2.c, '{"w":1}'); });
              } }
        ],
        links: [['Releiro', 'Cli', -50], ['Fechado', 'Cli', -55], ['Sensor', 'Cli', -55],
                ['C2', 'Cli', -60], ['Releiro', 'C2', -65]],
        events: [{ at: 18000, offline: 'Cli' }]
    }).then(function(res) {
        noErr(res);
        dump(res, 'Cli'); dump(res, 'Releiro'); dump(res, 'C2');
        var meta = last(res, 'Cli', /\[sim\] meta /) || '';
        check('catalogo traz meta de rele e sensor', /Releiro\/rele1\/sch:\{\"off\":1,\"ops\":\"1234\"\}/.test(meta) &&
              /Sensor\/lum\/%:0-100/.test(meta), meta);
        check('gpio sem o sim do dono = denied', has(res, 'Cli', '[sim] st neg refused/denied'));
        check('rele abre com auto-off', has(res, 'Cli', '[sim] st rel open'));
        check('sensor abre (stream e por pedido)', has(res, 'Cli', '[sim] st lum open') &&
              has(res, 'Cli', '[sim] st bat open'));
        check('escrita liga o fisico', has(res, 'Cli', '[sim] liga true') &&
              has(res, 'Releiro', '[sim] rele1=1'));
        check('rele responde leitura', has(res, 'Cli', '[sim] volta rele {"r":1}'));
        check('sensor por pedido responde', !!last(res, 'Cli', /\[sim\] sob pedido \d+/));
        var st = (last(res, 'Cli', /\[sim\] stream /) || '').replace('[sim] stream ', '');
        check('sensor em stream chega com taxa', st.split(',').filter(function(x) { return x; }).length >= 1, st);
        check('exclusivo ocupado para o 2o', has(res, 'C2', '[sim] c2 rele refused/busy'));
        check('lease vencido desliga o rele (auto-off)', has(res, 'Releiro', 'rele1 desligou (fim da sessao)') &&
              /\[sim\] rele1=1[\s\S]*rele1=0/.test(res.nodes.Releiro.log.join('\n')));
        check('rele liberado volta a abrir e liga', has(res, 'C2', '[sim] c2 volta open') &&
              has(res, 'Releiro', '[sim] rele1=1'));
        var fins = res.nodes.Releiro.log.filter(function(l) { return l.indexOf('rele1=') >= 0; });
        check('ciclo completo 0 -> 1 -> 0 -> 1',
              fins.join(' ') === '[sim] rele1=1 [sim] rele1=0 [sim] rele1=1', fins.join(' | '));
    });
});

// Atuador API 47: PULSO (liga na hora e o tick do DONO desliga sozinho) e
// PWM em rele recusado (RES_ERR: rede eletrica nao e dimmer). O catalogo
// anuncia as ops no schema.
scenario('Recursos API 47: pulso no rele e PWM recusado', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    return sim.runMesh({
        durationMs: 26000, seed: 11,
        nodes: [
            { name: 'Releiro', id: 'E1E1', app: src, caps: 0x01, relays: 1,
              pack: { name: 'fazenda2', pass: 'senhaforte' },
              settings: { res_share_gpio: '1' },
              wire: function(env, sim) {
                // oraculo do fisico: antes / durante / depois do pulso
                sim.at(9000, function(e) { sim.note('r0=' + e.Pack.relayState('rele1')); });
                sim.at(12000, function(e) { sim.note('r1=' + e.Pack.relayState('rele1')); });
                sim.at(17000, function(e) { sim.note('r2=' + e.Pack.relayState('rele1')); });
              } },
            { name: 'Cli', id: 'E2E2', app: src, caps: 0x04,
              pack: { name: 'fazenda2', pass: 'senhaforte' },
              wire: function(env, sim) {
                var h = {};
                sim.at(5000, function(e) { h.r = e.Pack.open('Releiro', 'rele1', { off: 1 }); });
                sim.at(8000, function(e) { sim.note('st ' + e.Pack.status(h.r).state); });
                // pulso de 5 s: liga agora; o dono desliga no tick
                sim.at(10000, function(e) { sim.note('pulso ' + e.Pack.write(h.r, '{"p":5000}')); });
                // PWM no rele: RES_ERR e o estado fisico nao muda
                sim.at(18000, function(e) { e.Pack.write(h.r, '{"d":50}'); });
                sim.at(19000, function(e) {
                    var d, got = [];
                    while ((d = e.Pack.read(h.r)) !== null) got.push(JSON.stringify(d));
                    sim.note('resposta ' + got.join('|'));
                });
                sim.at(20000, function(e) { e.Pack.write(h.r, '{"r":1}'); });
                sim.at(21000, function(e) {
                    var d, got = [];
                    while ((d = e.Pack.read(h.r)) !== null) got.push(JSON.stringify(d));
                    sim.note('leitura ' + got.join('|'));
                });
              } }
        ],
        links: [['Releiro', 'Cli', -50]],
        events: []
    }).then(function(res) {
        noErr(res);
        dump(res, 'Cli'); dump(res, 'Releiro');
        check('rele abre', has(res, 'Cli', '[sim] st open'));
        check('pulso liga o fisico', has(res, 'Cli', '[sim] pulso true') &&
              has(res, 'Releiro', '[sim] r1=1'));
        check('pulso termina sozinho no dono', has(res, 'Releiro', 'rele1 pulso terminou') &&
              has(res, 'Releiro', '[sim] r2=0'));
        check('PWM em rele responde RES_ERR', has(res, 'Cli', '[sim] resposta {"e":255}'));
        check('depois do erro o rele responde leitura', has(res, 'Cli', '[sim] leitura {"r":0}'));
    });
});

// Sensor API 47: threshold vira EVENTO empurrado (transicao + histerese +
// cooldown), sem stream continuo — o app colhe com Pack.onEvent.
scenario('Recursos API 47: evento de threshold no sensor', function() {
    var src = 'test/meshsim/fixtures/ocioso.js';
    return sim.runMesh({
        durationMs: 20000, seed: 13,
        nodes: [
            { name: 'Sensor', id: 'D1D1', app: src, caps: 0x04, sensors: ['lum'],
              pack: { name: 'fazenda3', pass: 'senhaforte' } },
            { name: 'Cli', id: 'D2D2', app: src, caps: 0x04,
              pack: { name: 'fazenda3', pass: 'senhaforte' },
              wire: function(env, sim) {
                var h = {};
                // o sample do sim sobe 40..59; gt 44 e cruzado em ~12 s
                sim.at(5000, function(e) { h.l = e.Pack.open('Sensor', 'lum', { gt: 44 }); });
                sim.at(8000, function(e) { sim.note('st ' + e.Pack.status(h.l).state); });
                sim.at(14000, function(e) {
                    sim.note('evento ' + JSON.stringify(e.Pack.onEvent(h.l)));
                    sim.note('de novo ' + JSON.stringify(e.Pack.onEvent(h.l)));
                });
                sim.at(17000, function(e) {
                    // sem stream: o read nao recebe amostra nenhuma
                    sim.note('read ' + JSON.stringify(e.Pack.read(h.l)));
                });
              } }
        ],
        links: [['Sensor', 'Cli', -50]],
        events: []
    }).then(function(res) {
        noErr(res);
        dump(res, 'Cli'); dump(res, 'Sensor');
        check('sensor abre', has(res, 'Cli', '[sim] st open'));
        check('evento de threshold chega com dir gt', has(res, 'Cli', '[sim] evento {"v":44,"dir":"gt"') &&
              has(res, 'Cli', '"at":'));
        check('fila de 1: o evento e consumido', has(res, 'Cli', '[sim] de novo null'));
        check('sem stream, read fica vazio', has(res, 'Cli', '[sim] read null'));
    });
});

// ---------------------------------------------------------------------------
// Transporte: TTL corta o alcance, no so-escuta (relay:false) nao repete,
// presenca expira 15 s depois de perder o caminho e volta, fila de TX cheia
scenario('CelerNet: TTL, so-escuta, presenca que vai e volta, fila cheia', function() {
    var src = 'test/meshsim/fixtures/eco.js';
    var line = ['N1', 'N2', 'N3', 'N4', 'N5'];
    var nodes = line.map(function(n, i) {
        return { name: n, id: 'F00' + (i + 1), app: src };
    });
    nodes[0].wire = function(env, sim) {
        sim.at(6000, function(e) { e.CelerNet.broadcast('alcance ttl2', 2); });
        sim.at(9000, function(e) { e.CelerNet.broadcast('alcance ttl4', 4); });
        sim.at(12000, function(e) {
            var big = new Array(435).join('x');      // 434 B = 31 quadros
            sim.note('grande x2 ' + e.CelerNet.send('N2', big, { copies: 2 }));
            sim.note('grande x2 de novo ' + e.CelerNet.send('N2', big, { copies: 2 }));
            sim.note('fila ' + e.CelerNet.status().txQueued);
        });
        sim.at(14000, function(e) { sim.note('nos ' + e.CelerNet.nodes().map(function(n) { return n.name + '/' + n.hops; }).join(',')); });
        sim.at(33000, function(e) { sim.note('nos ' + e.CelerNet.nodes().map(function(n) { return n.name + '/' + n.hops; }).join(',')); });
        sim.at(52000, function(e) { sim.note('nos ' + e.CelerNet.nodes().map(function(n) { return n.name + '/' + n.hops; }).join(',')); });
    };
    nodes[3].wire = function(env, sim) {
        // N4 so escuta: recebe, mas nao leva adiante
        sim.at(1500, function(e) { e.CelerNet.start({ name: 'N4', relay: false }); });
    };
    return sim.runMesh({
        durationMs: 56000, seed: 6,
        nodes: nodes,
        links: [['N1', 'N2', -50], ['N2', 'N3', -55], ['N3', 'N4', -60], ['N4', 'N5', -65]],
        events: [{ at: 15000, offline: 'N3' }, { at: 40000, online: 'N3' }]
    }).then(function(res) {
        noErr(res);
        dump(res, 'N1');
        check('ttl 2 chega a 2 saltos', has(res, 'N3', 'rx alcance ttl2 de N1 h2'));
        check('ttl 2 nao passa do 2o salto', !has(res, 'N4', 'alcance ttl2'));
        check('ttl 4 chega ao so-escuta (N4, 3 saltos)', has(res, 'N4', 'rx alcance ttl4 de N1 h3'));
        check('so-escuta nao repete: N5 fica sem', !has(res, 'N5', 'alcance ttl4'));
        check('presenca enxerga ate o so-escuta, nao alem dele', has(res, 'N1', '[sim] nos N2/1,N3/2,N4/3'),
              last(res, 'N1', /\[sim\] nos/));
        check('434 B x2 copias = 62 quadros cabe na fila de 96', has(res, 'N1', '[sim] grande x2 true'));
        check('a 2a logo em seguida nao cabe e e recusada inteira', has(res, 'N1', '[sim] grande x2 de novo false'));
        var l = res.nodes.N1.log.filter(function(x) { return /\[sim\] nos /.test(x); });
        check('15 s apos N3 cair, N3 e quem dependia dele somem', l[1] === '[sim] nos N2/1', l[1]);
        check('N3 voltou e a presenca se refez', l[2] === '[sim] nos N2/1,N3/2,N4/3', l[2]);
    });
});

// ---------------------------------------------------------------------------
// Saturacao do relay: as duas pontas metralhando mensagens de 434 B fazem o
// anel de repeticao do meio encher — a repeticao descartada tem que aparecer
// CONTADA (relayDropped do status, como o Info.relayDropped do firmware), nao
// sumir calada (o "relay handler silencioso" da bancada)
scenario('CelerNet: relay saturado conta relayDropped (anel de 96)', function() {
    var src = 'test/meshsim/fixtures/eco.js';
    var big = new Array(435).join('x');   // 434 B = 31 quadros
    return sim.runMesh({
        durationMs: 34000, seed: 41,
        nodes: [
            { name: 'P1', id: '9001', app: src, wire: pinger(3000, 30000, 700, big) },
            { name: 'Meio', id: '9002', app: src },
            { name: 'P2', id: '9003', app: src, wire: pinger(3000, 30000, 700, big) }
        ],
        links: [['P1', 'Meio', -50], ['Meio', 'P2', -52]]
    }).then(function(res) {
        noErr(res);
        check('o meio repetiu sob carga', res.nodes.Meio.relayed > 0, res.nodes.Meio.relayed);
        check('anel cheio: repeticoes descartadas contadas', res.nodes.Meio.relayDropped > 0,
              res.nodes.Meio.relayDropped);
        check('relayDropped visivel no status do JS', res.nodes.Meio.net.relayDropped > 0,
              res.nodes.Meio.net.relayDropped);
        // degradacao graciosa: algo das pontas ainda atravessa no meio da carga
        check('alguma mensagem atravessou apesar da saturacao', res.air.some(function(a) {
            return a.kind === 'rx' && a.data === big;
        }));
    });
});

// ---------------------------------------------------------------------------
// Presenca estavel sob trafego fragmentado sustentado: BEATs continuam
// atravessando rajadas de mensagens grandes — a lista nao pode tremer
// (join/leave flapping era o sintoma da bancada do "peer-watch")
scenario('CelerNet: presenca nao treme sob trafego fragmentado continuo', function() {
    var src = 'test/meshsim/fixtures/eco.js';
    var medio = new Array(201).join('y');   // 200 B = 15 quadros
    return sim.runMesh({
        durationMs: 44000, seed: 43,
        nodes: [
            { name: 'A', id: '9101', app: src, wire: pinger(4000, 40000, 2000, medio) },
            { name: 'B', id: '9102', app: src, wire: function(env, sim) {
                for (var t = 6000; t < 42000; t += 3000) {
                    (function(t) {
                        sim.at(t, function(e) {
                            sim.note('nos ' + e.CelerNet.nodes().map(function(n) {
                                return n.name;
                            }).sort().join(','));
                        });
                    })(t);
                }
            } },
            { name: 'C', id: '9103', app: src }
        ],
        links: [['A', 'B', -50, 0.05], ['B', 'C', -55, 0.05]]
    }).then(function(res) {
        noErr(res);
        var amostras = res.nodes.B.log.filter(function(l) { return l.indexOf('[sim] nos ') === 0; });
        var estaveis = amostras.filter(function(l) { return l === '[sim] nos A,C'; });
        check('B viu A e C em todas as amostras (sem flapping)',
              amostras.length >= 10 && amostras.length === estaveis.length,
              estaveis.length + '/' + amostras.length);
        check('mensagens grandes ainda chegaram a B com perda leve', res.air.some(function(a) {
            return a.kind === 'rx' && a.to === 'B' && a.data === medio;
        }));
    });
});

// ---------------------------------------------------------------------------
// No que foi embora de verdade: sob pressao CONTINUA de fila no observador a
// histerese segura a presenca alem do TTL (no surdo nao dita morte), mas o
// teto duro de 4x TTL derruba mesmo assim — o ciclo de peer-watch da bancada
// so fecha com as duas pontas deste contrato
scenario('CelerNet: no sumido sai no teto 4xTTL mesmo sob fila cheia', function() {
    var src = 'test/meshsim/fixtures/eco.js';
    var big = new Array(435).join('x');
    // wire em string (ver pinger): rajada + as duas amostras da presenca
    var amostra = function(t, tag) {
        return 'sim.at(' + t + ', function(e) {' +
            '  sim.note("' + tag + ' " + e.CelerNet.nodes().map(function(n) {' +
            '    return n.name; }).sort().join(",") + " fila " + e.CelerNet.status().txQueued);' +
            '});';
    };
    var wireA = 'function(env, sim) {' +
        'for (var t = 2000; t < 72000; t += 700) {' +
        '  sim.at(t, function(e) { e.CelerNet.broadcast(' + JSON.stringify(big) + '); });' +
        '}' + amostra(30000, 'nos30') + amostra(78000, 'nos78') + '}';
    return sim.runMesh({
        durationMs: 82000, seed: 47,
        nodes: [
            { name: 'A', id: '9201', app: src, wire: wireA },
            { name: 'B', id: '9202', app: src },
            { name: 'C', id: '9203', app: src }
        ],
        links: [['A', 'B', -50], ['B', 'C', -55]],
        events: [{ at: 12000, offline: 'C' }]
    }).then(function(res) {
        noErr(res);
        var l30 = last(res, 'A', /\[sim\] nos30 /) || '';
        var l78 = last(res, 'A', /\[sim\] nos78 /) || '';
        // pressao real: a fila propria nao esvaziou entre as rajadas
        check('observador sob pressao continua de TX (fila > 0)', /fila [1-9]/.test(l30), l30);
        // 18 s sem BEAT do C: histerese (no surdo) SEGURA alem dos 15 s
        check('C ainda presente a 18 s sem BEAT (histerese da fila cheia)',
              l30.indexOf('C') >= 0, l30);
        // 66 s sem BEAT: o teto 4x TTL derruba mesmo com a fila cheia — e o
        // vizinho vivo (B) nao sai junto
        check('C saiu no teto 4xTTL (66 s sem BEAT)', l78.indexOf('B') >= 0 && l78.indexOf('C') < 0, l78);
    });
});

// ---------------------------------------------------------------------------
// Detona!: duelo 1x1 completo — lobby por heartbeat, convite/aceite, round
// com a MESMA arena por seed, bomba remota aplicada, morte anunciada ('dm'),
// placar e o round 2 comandado pelo host. O wire da Bia planta UMA bomba no
// pe dela (quando o round 1 esta valendo) e a labareda encerra o round.
(function () {
    var APP = 'hub_apps/Detona/main.js';
    var NOTE = 'sim.at(23000, function(e) { var n = e.__harness.detona && e.__harness.detona.net;' +
               '  sim.note("round=" + (n ? n.round : "?") + " placar=" +' +
               '           (n ? n.ganhos + "x" + n.perdidos : "?")); });';
    function detonaHost() {
        return 'function(env, sim) {' +
            'sim.at(3000, function(e) { e.__harness.tap(240, 339); });' +    // DUELO no titulo
            'sim.at(8200, function(e) { e.__harness.tap(240, 143); });' +    // DESAFIAR Celer-B
            NOTE + '}';
    }
    function detonaConvidado() {
        return 'function(env, sim) {' +
            'sim.at(3000, function(e) { e.__harness.tap(240, 339); });' +    // DUELO no titulo
            'sim.at(10000, function(e) { e.__harness.tap(240, 142); });' +   // ACEITAR (1a linha da lista)
            'for (var t = 13000; t <= 17500; t += 350) (function(t) {' +     // planta 1 bomba no pe
            '  sim.at(t, function(e) {' +
            '    var d = e.__harness.detona;' +
            '    if (!d || !d.net || d.net.round !== 1 || d.E.sceneName !== "jogando") return;' +
            '    var s = d.arena.state();' +
            '    if (!s || !s.duelo) return;' +
            '    if (s.intro > 0) { s.intro = 0; return; }' +
            '    if (e.__harness._planta) return;' +
            '    var tem = false;' +
            '    for (var i = 0; i < s.bombs.length; i++) if (s.bombs[i].dono === "p") tem = true;' +
            '    if (!tem) { e.__harness._planta = true; e.__harness.tap(432, 368); }' +  // (13,11)
            '  });' +
            '})(t);' +
            NOTE + '}';
    }
    scenario('Detona: duelo 1x1 pela malha (convite, arena irma, morte, round 2)', function() {
        return sim.runMesh({
            durationMs: 26000, seed: 77,
            nodes: [
                { name: 'Celer-A', id: 'A001', app: APP, wire: detonaHost() },
                { name: 'Celer-B', id: 'B002', app: APP, wire: detonaConvidado() }
            ],
            links: [['Celer-A', 'Celer-B', -55]]
        }).then(function(res) {
            noErr(res);
            if (process.env.DEBUG_LOG) { dump(res, 'Celer-A'); dump(res, 'Celer-B'); }
            // sessao: lobby -> convite unicast -> aceite -> host
            check('convite foi ao ar (unicast di)', airTx(res, 'Celer-A', /^di$/).length >= 1);
            check('host abriu o duelo', has(res, 'Celer-A', 'duelo: duelo contra Celer-B (host)'));
            check('convidado aceitou', has(res, 'Celer-B', 'duelo: duelo contra Celer-A (convidado)'));
            // round 1: mesma arena por seed nos dois aparelhos
            check('host iniciou o round 1 (ds)', airTx(res, 'Celer-A', /^ds\d+,\d+$/).length >= 1);
            var sa = (last(res, 'Celer-A', /round 1 \(seed \d+\)/) || '').match(/seed (\d+)/);
            var sb = (last(res, 'Celer-B', /round 1 \(seed \d+\)/) || '').match(/seed (\d+)/);
            check('round 1 com a mesma seed nos dois', sa && sb && sa[1] === sb[1],
                  (sa && sa[1]) + ' vs ' + (sb && sb[1]));
            // eventos de jogo: bomba replicada, morte autoritativa, placar
            check('bomba do convidado aplicada no host', has(res, 'Celer-A', 'duelo: bomba do rival em'));
            check('morte anunciada foi ao ar (dm)',
                  res.air.some(function(a) { return a.kind === 'tx' && a.from === 'Celer-B' && /^dm/.test(a.data); }));
            check('host fechou o round com rwin', has(res, 'Celer-A', 'duelo: fim do round: rwin'));
            check('convidado fechou com dead', has(res, 'Celer-B', 'duelo: fim do round: dead'));
            check('host consolidou 1x0', has(res, 'Celer-A', 'duelo: round 1: venci (1x0)'));
            check('convidado consolidou 0x1', has(res, 'Celer-B', 'duelo: round 1: perdi (0x1)'));
            // round 2 comandado pelo host
            check('round 2 chegou nos dois', has(res, 'Celer-A', '[sim] round=2') && has(res, 'Celer-B', '[sim] round=2'));
            check('placar certo nos dois', has(res, 'Celer-A', '[sim] round=2 placar=1x0') &&
                                          has(res, 'Celer-B', '[sim] round=2 placar=0x1'));
            check('round 2 com seed nova e igual',
                  (function() {
                      var a2 = (last(res, 'Celer-A', /round 2 \(seed \d+\)/) || '').match(/seed (\d+)/);
                      var b2 = (last(res, 'Celer-B', /round 2 \(seed \d+\)/) || '').match(/seed (\d+)/);
                      return !!(a2 && b2 && sa && a2[1] === b2[1] && a2[1] !== sa[1]);
                  })());
        });
    });
})();

// ---------------------------------------------------------------------------
var filter = process.argv[2] || '';
(function next(i) {
    if (i >= scenarios.length) {
        console.log(failures ? '\nFALHOU: ' + failures + ' de ' + total + ' verificacoes'
                             : '\nOK: ' + total + ' verificacoes da malha passaram');
        process.exit(failures ? 1 : 0);
    }
    var s = scenarios[i];
    if (filter && s.name.indexOf(filter) < 0) return next(i + 1);
    console.log(s.name + ':');
    Promise.resolve().then(s.fn).then(function() { next(i + 1); }, function(e) {
        failures++;
        console.log('  FAIL  cenario lancou: ' + (e && e.stack || e));
        next(i + 1);
    });
})(0);
