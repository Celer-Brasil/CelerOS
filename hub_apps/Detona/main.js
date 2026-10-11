// Detona! — bomberman de grade no CelerOS, sobre a game engine do SDK.
// Tela cheia nos pixels nativos do vidro (API 28; 480x480 no SmartDisplay
// 4"), trilha chiptune como relogio: o pavio das bombas e quantizado na
// BATIDA e as correntes cascateiam de meio tempo em meio tempo — a
// explosao cai no compasso. Modulos: main.js (cenas/visao/HUD/rede) +
// arena.js (simulacao) + niveis.js (geracao por seed, temas, trilhas) +
// ia.js (bichos). Engine/sfx/grid/mesh sao deps do hub (API 30).
//
// DUELO pela malha CelerNet (api 26+, dep celeros.mesh): o radio faz
// ~8 quadros/s de ate 16 B sem ACK — o protocolo e de EVENTOS DISCRETOS
// (cada msg = 1 quadro), cada jogador e a autoridade do proprio corpo
// (posicao por mudanca de celula, a propria morte) e o mundo replica por
// eventos idempotentes numerados (unicast de 1 quadro pode chegar 2x):
//   dhl                      heartbeat do lobby (broadcast 3 s, expira 10 s)
//   di / da0 / da1           convite / recusa / aceite (unicast)
//   ds<seed>,<round>         inicio de round pelo HOST (mesma arena pela
//                            seed; reenvia 2.2 s ate o ack) — melhor de 3
//   dy<round>                recebi o inicio (ack)
//   dp<seq>,<c>,<r>          estou na celula (c,r) — interpolado no outro
//   db<seq>,<c>,<r>,<b10>,<alcance>[,p]   bomba: pavio no MEU beat (b10 =
//                            beat mod 10 em decimos; relogios divergem <1)
//   dd<seq>                  detonei (chip BOOM / toque longo)
//   dg<seq>,<c>,<r>          peguei o powerup da celula
//   dk<seq>,<c>,<r>,<dx>,<dy>  chutei a bomba da celula
//   dm<seq>                  morri (os dois avisam = empate)
//   dq                       desisti/sai
// seq: contador por jogador mod 100000, janela modular de 50k (so entra
// msg mais nova). Prefixo 'd' — nunca 'P' (o servico Pack engole).
//
// Render (engine 1.2): o cenario (chao + blocos + powerups + saida) e um
// E.tilemap no quadro persistente — so as CELULAS SUJAS repintam: as que
// ficaram sob algo que se moveu (camada E.dirty com o tilemap de fundo) e
// as que mudaram na grade (bloco quebrado, bomba, powerup). Antes eram ~600
// chamadas de desenho por quadro (195 lajotas x 3 + blocos) e o vidro
// inteiro ia ao painel a cada frame. O HUD fica fora do recorte da arena e
// so repinta quando um numero muda. Menus sao cenas `static`.
//
// Pega de teste (so existe no harness): o test.js dirige a sim.
if (typeof __harness !== "undefined") {
    __harness.detona = { arena: require("arena"), niveis: require("niveis"),
                         ia: require("ia"), GRID: require("celeros.grid"),
                         E: null };   // E entra depois do require abaixo
}

var E = require("celeros.game");       // familia CelerGame: adota so o que usa
require("celeros.game.fx");
require("celeros.game.spr");
require("celeros.game.tilemap");
var arena = require("arena");
var NV = require("niveis");
var ia = require("ia");
if (typeof __harness !== "undefined") __harness.detona.E = E;

E.init({ dir: "Detona", fps: 30, native: true, save: "detona.", particles: 140 });
var W = E.W, H = E.H, u = E.u;

// layout adaptativo: grade 15x13 + faixa de HUD; no 480 nativo da 32px
// de celula com HUD de 64, no canvas virtual 240x320 da 16px com HUD 44
var CELL = Math.min(Math.floor(W / NV.COLS), Math.floor((H - u(22)) / NV.ROWS));
var GW = CELL * NV.COLS, GH = CELL * NV.ROWS;
var OX = Math.floor((W - GW) / 2);
var OY = 0;
var HUD_Y = OY + GH;
var SZ = { jogador: CELL - 2, bomba: CELL - 4, bloco: CELL };
// PNGs sao masterizados p/ celula 32: em tela menor o blit 1:1 estoura
// a grade — sem nativo/sem folga os painters assumem (e ganham slot)
var USA_PNG = E.caps.native && CELL >= 28;
// itens de powerup sao PNG 32x32 desenhados DIRETO na celula (sem slot):
// pedem celula 32 exata — em 30px sangrariam 2px no vizinho
var USA_ITEM = USA_PNG && CELL >= 32;

var C = {
    preto: 0x0000,
    branco: 0xFFFF, ouro: 0xFFE0, laranja: 0xFD20, vermelho: 0xF800,
    verde: 0x07E0, ciano: 0x07FF, magenta: 0xF81F,
    cinza: System.mixColor(0x0000, 0xFFFF, 55),
    cinzaD: System.mixColor(0x0000, 0xFFFF, 22),
    painel: System.mixColor(0x0000, 0xFD20, 10)
};

var hi = E.save.num("hi", 0);
var prog = { mundo: E.save.num("mundo", 1), nivel: E.save.num("nivel", 1) };

// ------------------------------------------------------------------ rede --
var mesh = require("celeros.mesh");

var SEQMOD = 100000;
var NET = {
    fase: "off",        // off|lobby|convidei|convite|aguarda|jogando|round
    me: null, rival: null,      // {id, nome}
    host: false, round: 0, seed: 0,
    ganhos: 0, perdidos: 0,     // placar (melhor de 3)
    res: null,          // fim do round: venci|perdi|empate|saiu|desisti
    seq: 1, lastSeq: -1, ackRound: -1,
    hbAte: 0, vistos: {}, convide: null,
    envioAte: 0, envioMsg: "", envioN: 0,   // reenvio (di/ds, sem ACK)
    ultC: -1, ultR: -1, keepAte: 0, presAte: 0,
    tx: []              // sem radio (harness): o que seria enviado
};

function logDuelo(s) { System.print("duelo: " + s); }

function netRadio() {
    return typeof CelerNet !== "undefined" && !!CelerNet.status().active;
}

// broadcast=true so no heartbeat do lobby; resto e unicast urgente ao
// rival (2 copias pelo firmware, espacadas — da o retry gratis). 'para'
// quando o destino ainda nao e o rival (convite)
function netSend(msg, broadcast, para) {
    NET.tx.push(msg);
    if (NET.tx.length > 24) NET.tx.shift();
    if (!netRadio()) return;
    if (broadcast) CelerNet.broadcast(msg, 4);
    else {
        var dst = para || (NET.rival ? NET.rival.id : null);
        if (dst) CelerNet.send(dst, msg, { urgent: true });
    }
}

function netSeq() { NET.seq = (NET.seq + 1) % SEQMOD; return NET.seq; }

// evento de jogo so entra se o numero de sequencia for mais novo (modular)
function netNovo(seq) {
    var d = (seq - NET.lastSeq + SEQMOD) % SEQMOD;
    if (d === 0 || d >= SEQMOD / 2) return false;
    NET.lastSeq = seq;
    return true;
}

// beat do dono chega mod 10 em decimos: casa o multiplo mais perto do MEU
// beat — os relogios musicais divergem <1 beat entre aparelhos
function netBeat(dez) {
    var b = arena.beatNow();
    var d = (dez / 10 - (b % 10) + 10) % 10;
    if (d > 5) d -= 10;
    return b + d;
}

// convite a um Detona visto no lobby
function netConvidar(id) {
    NET.convide = { id: id, nome: (NET.vistos[id] || {}).nome || id };
    NET.fase = "convidei";
    NET.envioMsg = "di";
    NET.envioAte = System.millis() + 2200;
    NET.envioN = 1;
    netSend("di", false, NET.convide.id);
    logDuelo("convite para " + NET.convide.nome);
}

// resposta ao convite RECEBIDO (sim = aceite: vira convidado, host=false)
function netAceitar(sim) {
    if (!NET.convide) return;
    if (sim) {
        NET.rival = NET.convide;
        NET.convide = null;
        NET.host = false;
        NET.fase = "aguarda";
        netSend("da1");
        logDuelo("duelo contra " + NET.rival.nome + " (convidado)");
    } else {
        netSend("da0");
        NET.convide = null;
    }
}

// host: proximo round com seed nova (a arena e identica nos dois)
function netInicioRound() {
    NET.round++;
    NET.seed = 1000 + Math.floor(Math.random() * 89000);
    NET.res = null;
    NET.ackRound = -1;
    NET.envioMsg = "ds" + NET.seed + "," + NET.round;
    NET.envioAte = System.millis() + 2200;
    NET.envioN = 1;
    NET.fase = "jogando";
    NET.seq = 1; NET.lastSeq = -1;
    netSend(NET.envioMsg);
    logDuelo("round " + NET.round + " (seed " + NET.seed + ")");
    E.data.modo = "duelo";
    E.data.retomar = false;
    E.goto("jogando");
}

// encerra sessao/round: res decide o placar na cena round
function netEncerra(res) {
    if (NET.fase === "off") return;
    if (!NET.res) NET.res = res;
    NET.envioMsg = "";
    NET.fase = "round";
    arena.parar();
    if (E.sceneName !== "round") E.goto("round");
}

// desistencia do proprio jogador (botao de pausa vira saida no duelo)
function netDesistir() {
    if (NET.rival) netSend("dq");
    netEncerra("desisti");
    logDuelo("desisti");
}

// sessao limpa (voltar ao menu / lobby)
function netReset() {
    NET.fase = "off";
    NET.rival = null;
    NET.convide = null;
    NET.round = 0;
    NET.ganhos = 0;
    NET.perdidos = 0;
    NET.res = null;
    NET.envioMsg = "";
    NET.vistos = {};
}

// maquina de estados "de fundo": heartbeat, reenvios sem ACK e presenca
// do rival (chamado pelos updates das cenas de duelo)
function netPump(now) {
    if (!netRadio()) return;
    if (NET.fase === "lobby" && now >= NET.hbAte) {
        NET.hbAte = now + 3000;
        netSend("dhl", true);
    }
    if (NET.envioMsg && now >= NET.envioAte) {
        var done = NET.envioMsg.charAt(1) === 's' && NET.ackRound >= NET.round;
        if (done) {
            NET.envioMsg = "";
        } else if (NET.envioMsg === "di" && NET.fase !== "convidei") {
            NET.envioMsg = "";   // aceite/recusa chegou, sobrou um tick
        } else if (++NET.envioN > 8) {
            NET.envioMsg = "";
            if (NET.fase === "convidei") { NET.fase = "lobby"; NET.convide = null; }
            else netEncerra("saiu");
        } else {
            netSend(NET.envioMsg, false,
                    NET.envioMsg === "di" && NET.convide ? NET.convide.id : null);
            NET.envioAte = now + 2200;
        }
    }
    if (NET.rival && (NET.fase === "jogando" || NET.fase === "round") && now >= NET.presAte) {
        NET.presAte = now + 2500;
        var ns = CelerNet.nodes(), vivo = false;
        for (var i = 0; i < ns.length; i++)
            if (ns[i].id === NET.rival.id && ns[i].lastSeen < 12) vivo = true;
        if (!vivo) { netEncerra("saiu"); logDuelo("rival saiu (presenca)"); }
    }
}

// uma mensagem da malha (o mesh.each entrega aqui)
function netMsg(m) {
    var msg = m.msg;
    if (typeof msg !== "string" || msg.length < 2 || msg.charAt(0) !== 'd') return;
    var op = msg.charAt(1);
    if (op === 'h') {   // outro Detona no lobby
        if (NET.fase === "lobby" || NET.fase === "convidei")
            NET.vistos[m.from] = { nome: m.fromName || m.from, at: System.millis() };
        return;
    }
    if (op === 'i') {   // convite (so faz sentido no lobby)
        if (NET.fase === "lobby" && (!NET.convide || NET.convide.id !== m.from))
            NET.convide = { id: m.from, nome: m.fromName || m.from, at: System.millis() };
        return;
    }
    if (op === 'a') {   // resposta do MEU convite
        if (NET.fase === "convidei" && NET.convide && m.from === NET.convide.id) {
            if (msg.charAt(2) === '1') {
                NET.rival = NET.convide;
                NET.convide = null;
                NET.host = true;
                logDuelo("duelo contra " + NET.rival.nome + " (host)");
                netInicioRound();
            } else {
                NET.fase = "lobby";
                NET.convide = null;
                E.audio.sfx("ui");
            }
        }
        return;
    }
    if (!NET.rival || m.from !== NET.rival.id) return;
    if (op === 'q') { netEncerra("saiu"); logDuelo("rival desistiu"); return; }
    if (op === 's') {   // inicio de round do host
        var vs = msg.substring(2).split(',');
        var round = parseInt(vs[1], 10);
        if (round > NET.round) {
            NET.round = round;
            NET.seed = parseInt(vs[0], 10);
            NET.fase = "jogando";
            netSend("dy" + round);
            logDuelo("round " + round + " (seed " + NET.seed + ")");
            E.data.modo = "duelo";
            E.data.retomar = false;
            E.goto("jogando");
        } else {
            netSend("dy" + round);   // reenvio perdido: re-ack
        }
        return;
    }
    if (op === 'y') { NET.ackRound = parseInt(msg.substring(2), 10); return; }
    if (NET.fase !== "jogando" && NET.fase !== "round") return;
    var p = msg.substring(2).split(',');
    var seq = parseInt(p[0], 10);
    if (op === 'm') {   // o rival morreu no aparelho DELE
        if (!netNovo(seq)) return;
        // eu ja tinha morrido (res 'perdi' nos 900 ms de espera ou na cena
        // round): os dois avisam = EMPATE
        if (NET.res === "perdi") NET.res = "empate";
        var st = arena.state();
        if (st && st.rival && !st.rival.morto) {
            st.rival.morto = true;
            E.fx.burst(OX + st.rival.x, OY + st.rival.y,
                       { n: 22, colors: [C.branco, C.laranja], speed: CELL * 4, life: 0.6 });
        }
        arena.rivalMorreu();
        logDuelo("rival morreu");
        return;
    }
    if (!netNovo(seq)) return;
    var s = arena.state();
    if (!s || !s.duelo) return;
    if (op === 'p') arena.rivalAlvo(parseInt(p[1], 10), parseInt(p[2], 10));
    else if (op === 'b') {
        if (arena.addBomba(parseInt(p[1], 10), parseInt(p[2], 10), 4,
                           parseInt(p[4], 10), true, 'r',
                           netBeat(parseInt(p[3], 10)),
                           p.length > 5 && p[5] === '1'))
            logDuelo("bomba do rival em " + p[1] + "," + p[2]);
    }
    else if (op === 'd') arena.detonar('r');
    else if (op === 'g') arena.pegarRival(parseInt(p[1], 10), parseInt(p[2], 10));
    else if (op === 'k') arena.chutar(parseInt(p[1], 10), parseInt(p[2], 10),
                                      parseInt(p[3], 10), parseInt(p[4], 10), true);
}
if (typeof __harness !== "undefined" && __harness.detona) {
    __harness.detona.net = NET;
    __harness.detona.netIn = netMsg;   // test.js injeta mensagens da malha
}

// ------------------------------------------------------------- sprites ---
function painterJogador(w, h, x, y) {
    var r = w * 0.42;
    System.fillCircle(x + w / 2, y + h / 2, r, C.branco);
    System.fillCircle(x + w / 2, y + h / 2, r * 0.62, C.ciano);
    System.fillCircle(x + w / 2, y + h * 0.4, r * 0.34, 0x001F);
}
function painterBomba(w, h, x, y) {
    System.fillCircle(x + w / 2, y + h / 2 + 2, w * 0.36, 0x4208);
    System.fillCircle(x + w / 2 - 3, y + h / 2 - 3, Math.max(2, w * 0.1), C.cinza);
    System.fillRect(x + w / 2 - 1, y + 2, 2, Math.max(3, h * 0.2), 0x8410);
}
function painterMacio(w, h, x, y) {
    System.fillRect(x + 1, y + 1, w - 2, h - 2, corMacio);
    System.drawLine(x + 1, y + 1, x + w - 2, y + h - 2, corMacioLo);
    System.drawLine(x + w - 2, y + 1, x + 1, y + h - 2, corMacioLo);
    System.fillRect(x + 1, y + 1, w - 2, 2, corMacioHi);
}
function painterDuro(w, h, x, y) {
    System.fillRect(x, y, w, h, corDuro);
    System.fillRect(x + 1, y + 1, w - 2, h - 2, corDuroMid);
    System.fillRect(x + 2, y + 2, w - 4, 3, corDuroLo);
    System.fillRect(x + 2, y + 2, 3, h - 4, corDuroLo);
}
function painterBalao(w, h, x, y) {
    var r = w * 0.42;
    System.fillCircle(x + w / 2, y + h / 2, r, 0xFE19);
    System.fillCircle(x + w / 2 - 3, y + h / 2 - 3, r * 0.3, 0xFFE0);
    System.fillRect(x + w / 2 - 4, y + h / 2 + 1, 2, 3, 0x001F);
    System.fillRect(x + w / 2 + 2, y + h / 2 + 1, 2, 3, 0x001F);
}
function painterFantasma(w, h, x, y) {
    System.fillCircle(x + w / 2, y + h * 0.42, w * 0.4, 0x5FDF);
    System.fillRect(x + w * 0.1, y + h * 0.42, w * 0.8, h * 0.28, 0x5FDF);
    System.fillRect(x + w / 2 - 4, y + h * 0.4, 2, 3, 0x001F);
    System.fillRect(x + w / 2 + 2, y + h * 0.4, 2, 3, 0x001F);
}
function painterCacador(w, h, x, y) {
    System.fillCircle(x + w / 2, y + h / 2, w * 0.42, 0xFD00);
    System.fillCircle(x + w / 2, y + h * 2 / 3, w * 0.2, 0xFB80);
    System.fillRect(x + w / 2 - 5, y + h / 2 - 3, 3, 3, C.preto);
    System.fillRect(x + w / 2 + 2, y + h / 2 - 3, 3, 3, C.preto);
}
function painterChefe(w, h, x, y) {
    System.fillCircle(x + w / 2, y + h / 2, w * 0.46, 0x4208);
    System.fillCircle(x + w / 2, y + h / 2, w * 0.38, 0x630C);
    System.fillTriangle(x + w * 0.3, y + 6, x + w * 0.45, y + 6,
                        x + w * 0.37, y + h * 0.16, 0xFFE0);
    System.fillTriangle(x + w * 0.55, y + 6, x + w * 0.7, y + 6,
                        x + w * 0.63, y + h * 0.16, 0xFFE0);
    System.fillCircle(x + w * 0.38, y + h * 0.45, 4, C.vermelho);
    System.fillCircle(x + w * 0.62, y + h * 0.45, 4, C.vermelho);
}
function painterBlindado(w, h, x, y) {
    System.fillRoundRect(x + w * 0.12, y + h * 0.12, w * 0.76, h * 0.76, Math.max(2, w * 0.18), 0x632C);
    System.fillRect(x + w * 0.2, y + h * 0.36, w * 0.6, Math.max(2, h * 0.12), 0x07FF);
    System.drawRoundRect(x + w * 0.12, y + h * 0.12, w * 0.76, h * 0.76, Math.max(2, w * 0.18), 0xBDF7);
}
function painterDivisor(w, h, x, y) {
    System.fillCircle(x + w * 0.35, y + h / 2, w * 0.27, 0x87F0);
    System.fillCircle(x + w * 0.65, y + h / 2, w * 0.27, 0x87F0);
    System.fillRect(x + w * 0.3, y + h * 0.42, 2, 3, C.preto);
    System.fillRect(x + w * 0.66, y + h * 0.42, 2, 3, C.preto);
}
function painterMini(w, h, x, y) {
    System.fillCircle(x + w / 2, y + h / 2, w * 0.42, 0xAFF5);
    System.fillRect(x + w / 2 - 2, y + h * 0.4, 2, 2, C.preto);
    System.fillRect(x + w / 2 + 1, y + h * 0.4, 2, 2, C.preto);
}
function painterCuspidor(w, h, x, y) {
    // casca de basalto com a boca de brasa acesa
    System.fillCircle(x + w / 2, y + h / 2, w * 0.44, 0x2945);
    System.fillCircle(x + w / 2, y + h / 2, w * 0.34, 0x4208);
    System.fillRect(x + w * 0.28, y + h * 0.34, 3, 3, 0xFD20);
    System.fillRect(x + w * 0.62, y + h * 0.34, 3, 3, 0xFD20);
    System.fillCircle(x + w / 2, y + h * 0.68, w * 0.18, 0xFB80);
    System.fillCircle(x + w / 2, y + h * 0.68, w * 0.1, C.branco);
}
function painterLadrao(w, h, x, y) {
    // guaxinim de mascara: corpo cinza, cauda listrada e o saco beige
    System.fillCircle(x + w * 0.45, y + h * 0.5, w * 0.3, C.cinza);
    System.fillCircle(x + w * 0.45, y + h * 0.5, w * 0.12, 0x8410);
    System.fillRect(x + w * 0.32, y + h * 0.32, 3, 2, C.preto);
    System.fillRect(x + w * 0.55, y + h * 0.32, 3, 2, C.preto);
    System.fillCircle(x + w * 0.75, y + h * 0.55, w * 0.18, 0xFDC0);
    System.fillRect(x + w * 0.1, y + h * 0.55, w * 0.2, 3, 0xFB80);
}
function painterRival(w, h, x, y) {
    var r = w * 0.42;
    System.fillCircle(x + w / 2, y + h / 2, r, C.branco);
    System.fillCircle(x + w / 2, y + h / 2, r * 0.62, C.laranja);
    System.fillCircle(x + w / 2, y + h * 0.4, r * 0.34, 0x001F);
    System.fillRect(x + w / 2 - r * 0.5, y + h * 0.62, w * 0.5, 2, C.vermelho);
}
// PNGs por TRAS dos slots: o pool de hardware tem 8 vagas e o CONTEUDO
// delas e recarregado por fase (armarSprites): os blocos vestem o tema do
// mundo e as vagas de bicho vao pros kinds mais frequentes da arena. O
// que fica de fora desenha pelo painter — inclusive em tela sem nativo.
var corMacio = 0x8410, corMacioHi = 0xA514, corMacioLo = 0x4208;
var corDuro = 0x7BEF, corDuroMid = 0x528A, corDuroLo = 0x39E7;

E.spr.load([
    { name: "jogador", file: USA_PNG ? "jogador" : null,
      w: SZ.jogador, h: SZ.jogador, paint: painterJogador },
    { name: "bomba", file: USA_PNG ? "bomba" : null,
      w: SZ.bomba, h: SZ.bomba, paint: painterBomba },
    { name: "macio", file: USA_PNG ? "bloco_macio_1" : null,
      w: SZ.bloco, h: SZ.bloco, paint: painterMacio },
    { name: "duro", file: USA_PNG ? "bloco_duro_1" : null,
      w: SZ.bloco, h: SZ.bloco, paint: painterDuro },
    { name: "balao", file: USA_PNG ? "balao" : null,
      w: SZ.jogador, h: SZ.jogador, paint: painterBalao },
    { name: "fantasma", file: USA_PNG ? "fantasma" : null,
      w: SZ.jogador, h: SZ.jogador, paint: painterFantasma },
    { name: "cacador", file: USA_PNG ? "perseguidor" : null,
      w: SZ.jogador, h: SZ.jogador, paint: painterCacador },
    { name: "chefe", file: USA_PNG ? "chefe" : null,
      w: CELL * 2 - 4, h: CELL * 2 - 4, paint: painterChefe },
    // mini/rival: mini e painter (0,7x de tamanho); o rival ganha slot no
    // duelo (as vagas de bicho ficam livres sem spawns)
    { name: "blindado", file: USA_PNG ? "blindado" : null,
      w: SZ.jogador, h: SZ.jogador, paint: painterBlindado },
    { name: "divisor", file: USA_PNG ? "divisor" : null,
      w: SZ.jogador, h: SZ.jogador, paint: painterDivisor },
    { name: "mini", w: Math.round(SZ.jogador * 0.7), h: Math.round(SZ.jogador * 0.7), paint: painterMini },
    { name: "cuspidor", file: USA_PNG ? "cuspidor" : null,
      w: SZ.jogador, h: SZ.jogador, paint: painterCuspidor },
    { name: "ladrao", file: USA_PNG ? "ladrao" : null,
      w: SZ.jogador, h: SZ.jogador, paint: painterLadrao },
    { name: "rival", file: USA_PNG ? "rival" : null,
      w: SZ.jogador, h: SZ.jogador, paint: painterRival }
]);

var BICHOS_PNG = { balao: "balao", fantasma: "fantasma", cacador: "perseguidor",
                   chefe: "chefe", cuspidor: "cuspidor", ladrao: "ladrao",
                   blindado: "blindado", divisor: "divisor", rival: "rival" };
var PAINTERS = { balao: painterBalao, fantasma: painterFantasma,
                 cacador: painterCacador, chefe: painterChefe,
                 cuspidor: painterCuspidor, ladrao: painterLadrao,
                 blindado: painterBlindado, divisor: painterDivisor,
                 rival: painterRival };
var SLOTS_BICHO = ["balao", "fantasma", "cacador", "chefe"];
var BICHO_SLOT = {};   // kind -> slot que o desenha nesta fase

// redesenha o CONTEUDO de um slot (o id permanece): PNG se existir, senao
// o painter — 1-2 drawPNG por TROCA DE FASE, blit rapido igual
function reloadSlot(name, file, paint) {
    var s = E.spr._slots[name];
    if (!s || !s.id) return;
    System.useSprite(s.id);
    System.fillScreen(0x0000);
    var ok = false;
    if (file && E.caps.png) {
        for (var b = 0; b < E.spr.bases.length && !ok; b++) {
            try { ok = !!System.drawPNG(E.spr.bases[b] + file + ".png", 0, 0); }
            catch (e) { ok = false; }
        }
    }
    if (!ok && paint) paint(s.w, s.h, 0, 0);
    System.useSprite(0);
}

// por fase: blocos do tema + vagas de bicho pros kinds mais frequentes
// (chefe incluso). Painters de tela pequena ja saem tingidos do mundo
function armarSprites(s) {
    var t = s.tema;
    corMacio = System.mixColor(0x8410, t.detalhe, 16);
    corMacioHi = System.mixColor(0xA514, t.detalhe, 16);
    corMacioLo = System.mixColor(0x4208, t.detalhe, 16);
    corDuro = System.mixColor(0x7BEF, t.detalhe, 14);
    corDuroMid = System.mixColor(0x528A, t.detalhe, 14);
    corDuroLo = System.mixColor(0x39E7, t.detalhe, 14);
    reloadSlot("macio", USA_PNG ? t.macio : null, painterMacio);
    reloadSlot("duro", USA_PNG ? t.duro : null, painterDuro);
    BICHO_SLOT = {};
    if (!USA_PNG) return;
    var cont = {}, ordem = [];
    if (s.duelo) { cont.rival = 1; ordem.push("rival"); }   // sem spawns: vaga livre
    for (var i = 0; i < s.spawns.length; i++) {
        var k = s.spawns[i].kind;
        if (!cont[k]) { cont[k] = 0; ordem.push(k); }
        cont[k]++;
    }
    ordem.sort(function (a, b) { return cont[b] - cont[a]; });
    var si = 0;
    for (var j = 0; j < ordem.length && si < SLOTS_BICHO.length; j++) {
        var kk = ordem[j];
        if (!BICHOS_PNG[kk]) continue;
        BICHO_SLOT[kk] = SLOTS_BICHO[si];
        reloadSlot(SLOTS_BICHO[si], BICHOS_PNG[kk], PAINTERS[kk]);
        si++;
    }
}

// SOBREVIVENCIA: onda trouxe kind que ficou de fora dos slots — rouba uma
// vaga cujo kind nao esta vivo (1 redraw pontual, o resto nao nota)
function armaVivos(s) {
    var falta = null;
    for (var i = 0; i < s.enemies.length; i++) {
        var e = s.enemies[i];
        if (!e.morto && BICHOS_PNG[e.kind] && !BICHO_SLOT[e.kind]) { falta = e.kind; break; }
    }
    if (!falta) return;
    var usados = {};
    for (var v = 0; v < s.enemies.length; v++) {
        var ev = s.enemies[v];
        if (!ev.morto && BICHO_SLOT[ev.kind]) usados[BICHO_SLOT[ev.kind]] = 1;
    }
    for (var sl = 0; sl < SLOTS_BICHO.length; sl++) {
        var nome = SLOTS_BICHO[sl];
        if (!usados[nome]) {
            BICHO_SLOT[falta] = nome;
            reloadSlot(nome, BICHOS_PNG[falta], PAINTERS[falta]);
            return;
        }
    }
}

// ---------------------------------------------------------------- sons ---
// efeitos pela dep celeros.sfx: no firmware API 32 sao misturados por cima
// da trilha (o duck vira no-op e a musica nao para a cada explosao)
var SFX = require("celeros.sfx");

// ------------------------------------------------------------- cenario ---

var D = E.dirty;

function corPower(k) {
    return k === 'B' ? C.ciano : k === 'C' ? C.laranja : k === 'V' ? C.verde :
           k === 'K' ? C.magenta : k === 'R' ? C.vermelho :
           k === 'E' ? C.branco : k === 'P' ? 0xFC9F : k === 'T' ? 0xAFE5 : C.ouro;
}
function glifoPower(k) {
    return k === 'X' ? "+" : k;   // B C V K R E P T; vida = +
}

// arte de powerup: PNG RGBA (placa com borda na cor exata do jogo, cantos
// com alfa — o drawPNG compoe sobre o piso). Repinta so quando um corpo
// cruza a celula: ~9 ms pontuais no 4848, nada por quadro.
var POWPNG = { B: "pw_bomba", C: "pw_chama", V: "pw_veloz", K: "pw_chute",
               R: "pw_boom", E: "pw_escudo", X: "pw_vida", P: "pw_furo", T: "pw_relogio" };
var ARQ_OK = {};   // nome -> base que abriu (-1: nao existe)

// desenha <nome>.png em (x,y) pelas bases do app; cacheia a primeira
// tentativa (arquivo ausente falha rapido, mas so uma vez)
function drawArquivo(nome, x, y) {
    var b = ARQ_OK[nome];
    if (b === -1) return false;
    if (b !== undefined) {
        System.drawPNG(E.spr.bases[b] + nome + ".png", x, y);
        return true;
    }
    for (var i = 0; i < E.spr.bases.length; i++) {
        if (System.drawPNG(E.spr.bases[i] + nome + ".png", x, y)) {
            ARQ_OK[nome] = i;
            return true;
        }
    }
    ARQ_OK[nome] = -1;
    return false;
}

var PULSO = 0;   // fracao da batida do quadro (powerup/saida pulsam nela)

// uma celula inteira do cenario: lajota (2 tons + junta + variacao da
// seed), bloco, saida achada e powerup exposto. Bombas, chamas e bichos
// vao por cima, como entidades da camada suja.
function paintCell(c, r, x, y, w, h) {
    var s = arena.state();
    if (!s) return;
    var t = s.tema;
    var v = s.variacao[r * NV.COLS + c];
    var base = (c + r) % 2 === 0 ? t.a : t.b;
    System.fillRect(x, y, w, h, v > 0.85 ? System.mixColor(base, t.detalhe, 8) : base);
    // pedrinha/mancha pela seed da fase: ~15% das lajotas ganham vida
    // (arquivo por celula custa ~9 ms no 4848 — o chao segue procedural)
    if (v < 0.10) {
        var px = x + 2 + Math.floor(v * 89) % Math.max(1, w - 5);
        var py = y + 2 + Math.floor(v * 577) % Math.max(1, h - 5);
        System.fillRect(px, py, 2, 2, System.mixColor(base, C.preto, 38));
    } else if (v > 0.93) {
        var qx = x + 1 + Math.floor(v * 149) % Math.max(1, w - 4);
        System.fillRect(qx, y + h - 3, 3, 1, System.mixColor(base, t.detalhe, 30));
    }
    System.fillRect(x, y + h - 1, w, 1, t.junta);
    System.fillRect(x + w - 1, y, 1, h, t.junta);
    var ch = s.grid[r][c];
    if (ch === '#') {
        E.spr.blit("duro", x, y);
        if (c === NV.COLS - 1 && r === 0) {   // botao de pausa no bloco do canto
            var bw = Math.max(2, Math.round(w * 0.14)), bh = Math.round(h * 0.46);
            System.fillRect(x + w / 2 - bw - 2, y + (h - bh) / 2, bw, bh, C.branco);
            System.fillRect(x + w / 2 + 2, y + (h - bh) / 2, bw, bh, C.branco);
        }
        return;
    }
    if (ch === '%') { E.spr.blit("macio", x, y); return; }
    if (s.exit.achada && c === s.exit.c && r === s.exit.r) {
        var brilho = s.exit.aberta ? 40 + Math.floor(40 * PULSO) : 18;
        System.fillRect(x + 2, y + 2, w - 4, h - 4, System.mixColor(t.a, C.verde, brilho));
        System.fillRect(x + 5, y + 4, w - 10, h - 8, System.mixColor(C.preto, C.verde, 60));
        if (s.exit.aberta) {
            E.gfx.text(">", x + w / 2, y + h / 2, { color: C.branco, px: h * 0.6,
                       align: "center", valign: "middle", screen: true });
        }
        return;
    }
    var vt = ventoEm(s, c, r);
    if (vt) {
        // respiro do Forno: grelha; acende no tempo que antecede a erupcao
        var quente = vt.aviso ? 55 + Math.floor(35 * PULSO) : 12;
        System.fillRect(x + 3, y + 3, w - 6, h - 6, System.mixColor(0x2000, 0xFD20, quente));
        System.drawRect(x + 2, y + 2, w - 4, h - 4, System.mixColor(0x2000, 0xFD20, vt.aviso ? 95 : 45));
        for (var gl = 0; gl < 3; gl++) {
            System.fillRect(x + 6, y + 7 + gl * Math.floor((h - 14) / 2), w - 12, 2, 0x1000);
        }
        return;
    }
    var tp = teleEm(s, c, r);
    if (tp >= 0) {
        // teleporte do Nucleo: pad com anel pulsando (cor por par)
        var cor = (tp >> 1) === 0 ? C.magenta : C.ciano;
        var cxp = x + w / 2, cyp = y + h / 2;
        System.fillCircle(cxp, cyp, w * 0.42, System.mixColor(C.preto, cor, 22));
        System.drawCircle(cxp, cyp, w * (0.22 + 0.18 * PULSO), cor);
        System.drawCircle(cxp, cyp, w * 0.42, System.mixColor(C.preto, cor, 70));
    }
    var k = s.powerups[c + ',' + r];
    if (k && ch === '.') {
        var kor = corPower(k);
        // PNG quando ha (com cache por arquivo); quadrado com letra senao
        if (!(USA_ITEM && POWPNG[k] && drawArquivo(POWPNG[k], x, y))) {
            var kw = w - 4;
            System.fillRect(x + 2, y + 2, kw, kw, System.mixColor(C.preto, kor, 35));
            System.drawRect(x + 2, y + 2, kw, kw, System.mixColor(C.preto, kor, 70));
            E.gfx.text(glifoPower(k), x + w / 2, y + h / 2, { color: kor, px: h * 0.55,
                       align: "center", valign: "middle", screen: true });
        }
    }
}

function ventoEm(s, c, r) {
    for (var i = 0; i < s.ventos.length; i++)
        if (s.ventos[i].c === c && s.ventos[i].r === r) return s.ventos[i];
    return null;
}
function teleEm(s, c, r) {
    for (var i = 0; i < s.teles.length; i++)
        if (s.teles[i].c === c && s.teles[i].r === r) return i;
    return -1;
}

var mapa = E.tilemap({ cols: NV.COLS, rows: NV.ROWS, cell: CELL, ox: OX, oy: OY, paint: paintCell });

// celulas que mudaram na grade (bloco quebrou, bomba entrou/saiu, powerup
// pego, saida achada): a arena as lista em st.mudou — nada de varrer as
// 195 celulas por quadro. O que pulsa na batida (saida aberta, portais,
// respiro avisando) repinta todo quadro, poucas celulas.
function marcaMudancas(s) {
    var m = s.mudou;
    for (var i = 0; i < m.length; i += 2) mapa.mark(m[i], m[i + 1]);
    m.length = 0;
    if (s.exit.achada) mapa.mark(s.exit.c, s.exit.r);
    for (var t = 0; t < s.teles.length; t++) mapa.mark(s.teles[t].c, s.teles[t].r);
    for (var vv = 0; vv < s.ventos.length; vv++) {
        if (s.ventos[vv].aviso || s.ventos[vv].avisoAntes) mapa.mark(s.ventos[vv].c, s.ventos[vv].r);
        s.ventos[vv].avisoAntes = s.ventos[vv].aviso;
    }
}

// ------------------------------------------------------------- entidades ---

function drawChama(fl, pulso) {
    var x = OX + fl.c * CELL, y = OY + fl.r * CELL;
    var meia = CELL / 2;
    var cresce = 0.55 + 0.45 * pulso;
    if (fl.tipo === 'cuspe') {
        // bola de fogo do cuspidor: core branco-acucar no miolo laranja
        System.fillCircle(x + meia, y + meia, meia * (0.6 + 0.3 * cresce), C.laranja);
        System.fillCircle(x + meia, y + meia, meia * 0.42 * cresce + 2, C.ouro);
        System.fillCircle(x + meia, y + meia, meia * 0.2 * cresce, C.branco);
    } else if (fl.tipo === 'nucleo') {
        E.gfx.circle(x + meia, y + meia, meia * 0.95 * cresce + 2, C.branco, { screen: true });
        System.fillCircle(x + meia, y + meia, meia * 0.7 * cresce, C.ouro);
        System.fillCircle(x + meia, y + meia, meia * 0.4 * cresce, 0xFB18);
    } else {
        var len = CELL * cresce, esp = Math.floor(CELL * 0.7);
        var x0 = fl.dx > 0 ? x + meia : fl.dx < 0 ? x + meia - len : x + meia - esp / 2;
        var y0 = fl.dy > 0 ? y + meia : fl.dy < 0 ? y + meia - len : y + meia - esp / 2;
        var w_ = fl.dy !== 0 ? esp : len;
        var h_ = fl.dy !== 0 ? len : esp;
        E.gfx.rect(x0, y0, w_, h_, C.laranja, { screen: true });
        System.fillRect(x0 + (fl.dy !== 0 ? 2 : 0), y0 + (fl.dx !== 0 ? 2 : 0),
                        fl.dy !== 0 ? esp - 4 : w_, fl.dx !== 0 ? esp - 4 : h_, C.ouro);
        if (fl.tipo === 'ponta') {
            System.fillCircle(x + meia + fl.dx * (meia * 0.6),
                              y + meia + fl.dy * (meia * 0.6), 3, C.branco);
        }
    }
}

function drawEntidades(s, beat, pulso) {
    var i;
    // bombas: blit + faisca do pavio piscando na batida
    for (i = 0; i < s.bombs.length; i++) {
        var bo = s.bombs[i];
        var bx = Math.round(OX + bo.fx * CELL + (CELL - SZ.bomba) / 2);
        var by = Math.round(OY + bo.fy * CELL + (CELL - SZ.bomba) / 2 - Math.floor(2 * pulso));
        E.spr.blit("bomba", bx, by);
        // pavio: o fim se le de longe — avermelha e pisca no dobro do ritmo
        var resta = Math.max(0, bo.vai - beat), tot = Math.max(0.1, bo.vai - bo.de);
        var quente = 1 - resta / tot;
        var pisca = resta < 1 ? Math.floor(beat * 8) % 2 === 0 : pulso < 0.5;
        if (quente > 0.45) {
            System.fillCircle(bx + SZ.bomba / 2, by + SZ.bomba / 2 + 2, SZ.bomba * 0.16,
                              System.mixColor(0x4208, C.vermelho, Math.round(quente * 100)));
        }
        if (pisca) System.fillCircle(bx + SZ.bomba / 2, by + 1, 2, resta < 1 ? C.vermelho : C.ouro);
        if (bo.dono === 'x') System.drawCircle(bx + SZ.bomba / 2, by + SZ.bomba / 2 + 2, SZ.bomba * 0.42, C.magenta);
    }
    for (i = 0; i < s.flames.length; i++) drawChama(s.flames[i], pulso);
    // inimigos: bob no compasso; chefe pisca ao levar acerto
    armaVivos(s);
    for (i = 0; i < s.enemies.length; i++) {
        var e = s.enemies[i];
        if (e.morto) continue;
        var nome = e.kind;
        var ew = e.kind === 'chefe' ? CELL * 2 - 4 :
                 e.kind === 'mini' ? Math.round(SZ.jogador * 0.7) : SZ.jogador;
        var eflash = e.flash > 0;   // (a ia desconta o flash)
        var cx = OX + e.fx * CELL, cy = OY + e.fy * CELL;
        if (eflash && Math.floor(beat * 16) % 2 === 0) {
            E.gfx.circle(cx, cy, ew * 0.5, C.branco, { screen: true });
        } else {
            var ex0 = Math.round(cx - ew / 2);
            var ey0 = Math.round(cy - ew / 2 + Math.floor(2 * Math.sin(beat * Math.PI * 2 + i)));
            E.spr.blit(BICHO_SLOT[nome] || nome, ex0, ey0);
            if (e.kind === 'blindado' && e.hp < e.hpMax) {   // blindagem rachada
                System.drawLine(ex0 + ew * 0.3, ey0 + ew * 0.15, ex0 + ew * 0.5, ey0 + ew * 0.55, C.branco);
                System.drawLine(ex0 + ew * 0.5, ey0 + ew * 0.55, ex0 + ew * 0.42, ey0 + ew * 0.85, C.branco);
            }
            // cuspidor com o cuspe armado: a boca acende avisando
            if (e.kind === 'cuspidor' && e.bocaAte > 0) {
                var bx2 = cx + (e.cuspeDir ? e.cuspeDir.dx * ew * 0.34 : 0);
                var by2 = cy + (e.cuspeDir ? e.cuspeDir.dy * ew * 0.34 : 0);
                System.fillCircle(bx2, by2, ew * (0.16 + 0.08 * pulso),
                                  Math.floor(beat * 12) % 2 === 0 ? C.branco : C.ouro);
            }
            // ladrao: cada powerup engolido acende um ponto no saco
            for (var rb2 = 0; rb2 < e.roubos.length && rb2 < 4; rb2++) {
                System.fillCircle(ex0 + ew * (0.68 + rb2 * 0.1), ey0 + ew * 0.68,
                                  Math.max(1, ew * 0.06), C.ouro);
            }
        }
    }
    // rival do duelo (bob fora de fase com o meu boneco); jogador por cima
    if (s.duelo && s.rival && !s.rival.morto && !s.fim) {
        var rx = OX + s.rival.x, ry = OY + s.rival.y;
        var rbob = Math.floor(2 * Math.sin(beat * Math.PI * 2 + 1.7));
        E.spr.blit(BICHO_SLOT["rival"] || "rival", Math.round(rx - SZ.jogador / 2),
                   Math.round(ry - SZ.jogador / 2 + rbob));
    }
    // jogador (pisca invulneravel; bob no compasso)
    var inv = s.stats.inv > 0 && Math.floor(beat * 8) % 2 === 0;
    if (!inv && !s.fim) {
        var px = OX + s.player.x, py = OY + s.player.y;
        var bob = Math.floor(2 * Math.sin(beat * Math.PI * 2));
        E.spr.blit("jogador", Math.round(px - SZ.jogador / 2), Math.round(py - SZ.jogador / 2 + bob));
        if (s.stats.shield) E.gfx.circle(px, py, SZ.jogador * 0.62, C.ciano, { fill: false, screen: true });
    }
    // chefe na arena: barra de vida no topo
    for (i = 0; i < s.enemies.length; i++) {
        if (s.enemies[i].kind !== 'chefe' || s.enemies[i].morto) continue;
        var bw = Math.floor(GW * 0.6);
        E.gfx.bar(OX + (GW - bw) / 2, OY + u(3), bw, u(4), s.enemies[i].hp / s.enemies[i].hpMax,
                  { fg: C.vermelho, bg: C.cinzaD, screen: true });
        break;
    }
}

// --------------------------------------------------------------- HUD ------

var hudKey = "";
function drawHUD(s, pulso, force) {
    if (s.duelo) { drawHudDuelo(s, pulso, force); return; }
    var seg = s.sobrevivencia ? 0 : Math.max(0, Math.ceil(s.tLeft));
    var piscaTempo = !s.sobrevivencia && seg < 30 && pulso > 0.5;
    var piscaBoom = s.stats.remote ? Math.floor(pulso * 3) : 0;
    var key = s.stats.vidas + "|" + s.stats.bombs + "|" + s.stats.flame + "|" + s.stats.vel + "|" +
              seg + "|" + s.onda + "|" + s.score + "|" + (piscaTempo ? 1 : 0) + "|" + piscaBoom +
              "|" + (s.stats.kick ? 1 : 0) + (s.stats.shield ? 1 : 0);
    if (!force && key === hudKey) return;
    hudKey = key;
    var t = s.tema, y0 = HUD_Y, hh = H - y0;
    System.fillRect(0, y0, W, hh, t.hud);
    System.fillRect(0, y0, W, Math.max(2, u(1)), t.detalhe);
    var cy = Math.floor(y0 + hh / 2) + 1;
    var pad = u(6);
    var dim = System.mixColor(t.hudTxt, t.hud, 40);

    // coluna esquerda: vidas (coracoes) em cima, poderes embaixo
    var hr = Math.max(3, Math.round(hh * 0.08)), step = hr * 3 + u(2);
    var hy = y0 + Math.round(hh * 0.32);
    for (var v = 0; v <= s.stats.vidas && v < 5; v++) {
        var hx = pad + hr + v * step;
        System.fillCircle(hx, hy - hr * 0.3, hr, C.vermelho);
        System.fillCircle(hx + hr * 1.4, hy - hr * 0.3, hr, C.vermelho);
        System.fillTriangle(hx - hr, hy + hr * 0.3, hx + hr * 2.4, hy + hr * 0.3,
                            hx + hr * 0.7, hy + hr * 2.2, C.vermelho);
    }
    var lbl = "B" + s.stats.bombs + " C" + s.stats.flame + " V" + s.stats.vel +
              (s.stats.kick ? " K" : "") + (s.stats.shield ? " E" : "");
    E.gfx.text(lbl, pad, y0 + hh - u(4), { color: t.hudTxt, ts: "small", valign: "bottom",
               fit: Math.round(W * 0.36), screen: true });
    // centro: fase + tempo (vermelho piscando no fim) ou onda na sobrevivencia
    var xm = Math.round(W * 0.5);
    E.gfx.text(s.sobrevivencia ? "ONDA" : "FASE " + s.mundo + "-" + s.nivel, xm, y0 + u(4),
               { color: dim, ts: "tiny", align: "center", screen: true });
    E.gfx.text(s.sobrevivencia ? String(s.onda) : String(seg), xm, cy + u(6), {
        color: piscaTempo ? C.vermelho : t.hudTxt, ts: "label",
        align: "center", valign: "middle", screen: true });
    // direita: detonador remoto (chip BOOM pulsando) + pontos
    var xr = W - pad;
    if (s.stats.remote) {
        var bw2 = u(34), bh = hh - u(8), bx = W - bw2 - u(4), by = y0 + u(4);
        E.gfx.rect(bx, by, bw2, bh, System.mixColor(C.preto, C.vermelho, 25 + piscaBoom * 12),
                   { r: u(5), screen: true });
        E.gfx.text("BOOM", bx + bw2 / 2, by + bh / 2, { color: C.branco, ts: "small",
                   align: "center", valign: "middle", screen: true });
        xr = bx - u(6);
    }
    E.gfx.text("PONTOS", xr, y0 + u(4), { color: dim, ts: "tiny", align: "right", screen: true });
    E.gfx.text(String(s.score), xr, cy + u(6), { color: C.ouro, ts: "label",
               align: "right", valign: "middle", screen: true });
}

// HUD do duelo: rounds ganhos (coracoes, melhor de 3) de um lado, nome do
// rival do outro, round e placar no centro
function drawHudDuelo(s, pulso, force) {
    var key = "d" + NET.ganhos + "|" + NET.perdidos + "|" + NET.round +
              (s.stats.remote ? "r" : "") + (pulso > 0.5 ? 1 : 0);
    if (!force && key === hudKey) return;
    hudKey = key;
    var t = s.tema, y0 = HUD_Y, hh = H - y0;
    System.fillRect(0, y0, W, hh, t.hud);
    System.fillRect(0, y0, W, Math.max(2, u(1)), t.detalhe);
    var cy = Math.floor(y0 + hh / 2) + 1;
    var pad = u(6);
    var dim = System.mixColor(t.hudTxt, t.hud, 40);
    var hr = Math.max(3, Math.round(hh * 0.08)), step = hr * 3 + u(2);
    var hy = y0 + Math.round(hh * 0.32);
    for (var v = 0; v < NET.ganhos && v < 2; v++) {
        var hx = pad + hr + v * step;
        System.fillCircle(hx, hy - hr * 0.3, hr, C.vermelho);
        System.fillCircle(hx + hr * 1.4, hy - hr * 0.3, hr, C.vermelho);
        System.fillTriangle(hx - hr, hy + hr * 0.3, hx + hr * 2.4, hy + hr * 0.3,
                            hx + hr * 0.7, hy + hr * 2.2, C.vermelho);
    }
    var lbl = "B" + s.stats.bombs + " C" + s.stats.flame + " V" + s.stats.vel +
              (s.stats.kick ? " K" : "") + (s.stats.shield ? " E" : "");
    E.gfx.text(lbl, pad, y0 + hh - u(4), { color: t.hudTxt, ts: "small", valign: "bottom",
               fit: Math.round(W * 0.36), screen: true });
    var xm = Math.round(W * 0.5);
    E.gfx.text("ROUND " + NET.round, xm, y0 + u(4),
               { color: dim, ts: "tiny", align: "center", screen: true });
    E.gfx.text(NET.ganhos + " - " + NET.perdidos, xm, cy + u(6), {
        color: C.branco, ts: "label", align: "center", valign: "middle", screen: true });
    var xr = W - pad;
    var piscaBoom = s.stats.remote ? Math.floor(pulso * 3) : 0;
    if (s.stats.remote) {
        var bw2 = u(34), bh = hh - u(8), bx = W - bw2 - u(4), by = y0 + u(4);
        E.gfx.rect(bx, by, bw2, bh, System.mixColor(C.preto, C.vermelho, 25 + piscaBoom * 12),
                   { r: u(5), screen: true });
        E.gfx.text("BOOM", bx + bw2 / 2, by + bh / 2, { color: C.branco, ts: "small",
                   align: "center", valign: "middle", screen: true });
        xr = bx - u(6);
    }
    E.gfx.text((NET.rival ? NET.rival.nome : "?").substring(0, 10), xr, y0 + u(4),
               { color: dim, ts: "tiny", align: "right", screen: true });
    E.gfx.text("RIVAL", xr, cy + u(6), { color: C.laranja, ts: "label",
               align: "right", valign: "middle", screen: true });
}

// --------------------------------------------------------------- mundo ----

// cartao de abertura sobre a arena (a camada suja apaga quando some)
function drawIntro(s) {
    var pw = Math.min(u(170), GW - u(20)), ph = u(70);
    var px = OX + Math.round((GW - pw) / 2), py = OY + Math.round((GH - ph) / 2);
    E.gfx.panel(px, py, pw, ph, { bg: System.mixColor(C.preto, s.tema.detalhe, 14),
                                   stroke: s.tema.detalhe, screen: true });
    var titulo = s.duelo ? "ROUND " + NET.round :
                 s.sobrevivencia ? "SOBREVIVENCIA" :
                 (s.nivel % NV.NIVEIS_POR_MUNDO === 0 ? "CHEFE " : "FASE ") + s.mundo + "-" + s.nivel;
    E.gfx.text(titulo, px + pw / 2, py + u(20), { color: C.ouro, ts: "big", align: "center",
               valign: "middle", fit: pw - u(12), screen: true });
    var sub = s.duelo ? "contra " + (NET.rival ? NET.rival.nome : "?") :
              s.sobrevivencia ? "aguente as ondas" :
              s.tema.nome + (s.ventos.length ? " - cuidado com os respiros" :
                             s.teles.length ? " - use os portais" : "");
    E.gfx.text(sub, px + pw / 2, py + u(42), { color: C.cinza, ts: "small", align: "center",
               valign: "middle", fit: pw - u(12), screen: true });
    E.gfx.text(s.duelo ? "melhor de 3 - bombas no compasso" :
               s.sobrevivencia ? "" : "ache a saida e limpe a arena", px + pw / 2, py + u(56),
               { color: C.cinzaD, ts: "tiny", align: "center", valign: "middle",
                 fit: pw - u(12), screen: true });
}

function drawMundo(force) {
    var s = arena.state();
    if (!s) return;
    var beat = arena.beatNow();
    var pulso = beat - Math.floor(beat);   // 0..1 dentro da batida
    PULSO = pulso;
    if (force) {
        mapa.all();
        s.mudou.length = 0;
    }
    marcaMudancas(s);
    mapa.flush();
    drawEntidades(s, beat, pulso);
    E.fx.draw();
    if (s.intro > 0) drawIntro(s);
    E.dirty.unclip();
    drawHUD(s, pulso, force);
}

// ------------------------------------------------------------- menus ------

// botoes empilhados e centrados: devolve os hit-rects na ordem dos rotulos
function botoes(y, rotulos, fundo) {
    var bw = Math.min(u(150), W - u(40)), bh = u(27), gap = u(10);
    var n = rotulos.length, x = Math.round((W - bw) / 2);
    System.fillRect(x - 2, y - 2, bw + 4, bh * n + gap * (n - 1) + 4, fundo);
    var out = [];
    for (var i = 0; i < n; i++) {
        out.push(i === 0 ?
            E.gfx.button(rotulos[i], x, y, bw, bh, { color: C.laranja, screen: true }) :
            E.gfx.button(rotulos[i], x, y + i * (bh + gap), bw, bh, {
                primary: false, bg: C.painel, stroke: System.mixColor(C.laranja, C.preto, 40),
                textColor: C.branco, screen: true }));
    }
    return out;
}

// joystick flutuante: a ancora nasce no toque e segue o dedo quando ele se
// afasta demais (virar e instantaneo); toque seco planta bomba
var JOY = { ax: 0, ay: 0, dead: u(7), raio: u(22) };
function joystick() {
    var i = E.input;
    if (i.justDown) { JOY.ax = i.x; JOY.ay = i.y; }
    if (!i.down || !i.moved) return [0, 0];
    var dx = i.x - JOY.ax, dy = i.y - JOY.ay;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > JOY.raio) {
        JOY.ax = i.x - dx / d * JOY.raio;
        JOY.ay = i.y - dy / d * JOY.raio;
    }
    if (d < JOY.dead) return [0, 0];
    return Math.abs(dx) > Math.abs(dy) ? [dx > 0 ? 1 : -1, 0] : [0, dy > 0 ? 1 : -1];
}

var tituloArte = false;
E.run({
    titulo: {
        static: true,
        enter: function () {
            this.first = true;
            hi = E.save.num("hi", 0);
            E.audio.music(NV.SONG_MENU);
        },
        update: function () {
            if (!this.btn) return;
            if (E.hit(this.btn[0])) {
                E.audio.sfx("ok");
                E.data.retomar = false;
                E.data.modo = "campanha";
                prog.mundo = E.save.num("mundo", 1);
                prog.nivel = E.save.num("nivel", 1);
                E.goto("jogando", { transition: "wipe", ms: 300 });
            } else if (E.hit(this.btn[1])) {
                E.audio.sfx("ok");
                E.goto("duelo", { transition: "fade", ms: 350 });
            } else if (E.hit(this.btn[2])) {
                E.audio.sfx("ok");
                E.data.retomar = false;
                E.data.modo = "sobre";
                E.goto("jogando", { transition: "fade", ms: 350 });
            }
        },
        draw: function () {
            if (this.first) {
                this.first = false;
                System.fillScreen(C.preto);
                tituloArte = false;
                if (E.caps.png && W >= 480) {
                    try { tituloArte = !!System.drawPNG(E.spr.bases[0] + "titulo.png", Math.round((W - 480) / 2), 0); }
                    catch (e) { tituloArte = false; }
                }
                // nome na placa preta da arte (y 172..225) ou centrado sem arte
                var ty = tituloArte ? 199 : Math.round(H * 0.3);
                E.gfx.text("DETONA!", W / 2, ty, { color: C.ouro, px: u(21), align: "center",
                           valign: "middle", screen: true });
                var y = tituloArte ? 230 + u(14) : ty + u(30);
                E.gfx.text("campanha " + prog.mundo + "-" + prog.nivel + "   recorde " + hi, W / 2, y,
                           { color: C.cinza, ts: "small", align: "center", fit: W - u(16), screen: true });
                y += u(11);
                E.gfx.text("sobrevivencia: recorde " + E.save.num("sobre.hi", 0), W / 2, y,
                           { color: C.cinza, ts: "small", align: "center", fit: W - u(16), screen: true });
                E.gfx.text("deslize para andar - toque para a bomba", W / 2, H - u(9),
                           { color: C.cinzaD, ts: "small", align: "center", valign: "middle",
                             fit: W - u(16), screen: true });
            }
            this.btn = botoes(H - u(27) * 3 - u(10) * 2 - u(20),
                              ["JOGAR", "DUELO", "SOBREVIVENCIA"], C.preto);
        }
    },

    // ------------------------------------------------- lobby do duelo ----
    // Portao proprio (o mesh.gate da dep desenha com UI.* do sistema; aqui
    // a engine manda): sem BT = carta fixa; malha off = botao LIGAR. O
    // heartbeat 'dhl' anuncia este Detona aos outros por perto.
    duelo: {
        fps: 12,
        exit: function () { E.clearTimers(); },   // idem jogando: fim de round agenda E.after(900)
        enter: function () {
            this.first = true;
            this.ligaAte = 0;
            netReset();
            NET.fase = "lobby";
            NET.hbAte = 0;
            if (mesh.available()) {
                try { NET.me = mesh.me(); } catch (e) { NET.me = null; }
            } else NET.me = null;
        },
        update: function () {
            var now = System.millis();
            if (mesh.available() && netRadio()) {
                mesh.each(netMsg, now);
                netPump(now);
            }
            for (var k in NET.vistos)
                if (now - NET.vistos[k].at > 10000) delete NET.vistos[k];
            if (NET.convide && NET.fase === "lobby" && now - NET.convide.at > 12000)
                NET.convide = null;
            var b = this.btns;
            if (!b) return;
            for (var i = 0; i < b.length; i++) {
                if (!E.hit(b[i])) continue;
                var a = b[i]._a;
                E.audio.sfx("ok");
                if (a === "voltar") { netReset(); E.goto("titulo", { transition: "fade", ms: 300 }); }
                else if (a === "ligar" && now >= this.ligaAte) {
                    this.ligaAte = now + 1200;
                    CelerNet.start({});
                }
                else if (a === "desafiar") netConvidar(b[i]._id);
                else if (a === "aceitar") netAceitar(true);
                else if (a === "recusar") netAceitar(false);
                else if (a === "cancelar") {
                    if (NET.fase === "aguarda" && NET.rival) netSend("dq");
                    NET.fase = "lobby";
                    NET.convide = null;
                    NET.rival = null;
                    NET.envioMsg = "";
                }
                break;
            }
        },
        draw: function () {
            if (this.first) {
                this.first = false;
                System.fillScreen(C.preto);
                E.gfx.text("DUELO", W / 2, u(16), { color: C.ouro, px: u(16),
                           align: "center", valign: "middle", screen: true });
                E.gfx.text("bomberman 1x1 pela malha", W / 2, u(29),
                           { color: C.cinza, ts: "small", align: "center", screen: true });
            }
            var yTop = u(40);
            System.fillRect(0, yTop, W, H - yTop, C.preto);   // corpo muda por estado
            this.btns = [];
            var eu = this;
            function bt(rotulo, y, acao, extra, primario) {
                var bw = Math.min(u(150), W - u(40)), bh = u(27);
                var r = E.gfx.button(rotulo, Math.round((W - bw) / 2), y, bw, bh,
                                     primario === false ? { primary: false, bg: C.painel,
                                       stroke: System.mixColor(C.laranja, C.preto, 40),
                                       textColor: C.branco, screen: true }
                                                        : { color: C.laranja, screen: true });
                r._a = acao;
                if (extra) for (var q in extra) r[q] = extra[q];
                eu.btns.push(r);
                return y + bh + u(8);
            }
            var y;
            if (!mesh.available()) {
                E.gfx.text("esta placa nao tem bluetooth", W / 2, u(70),
                           { color: C.cinza, ts: "small", align: "center", screen: true });
                bt("< VOLTAR", u(110), "voltar");
                return;
            }
            if (!netRadio()) {
                E.gfx.text("ligue a malha para desafiar", W / 2, u(70),
                           { color: C.cinza, ts: "small", align: "center", screen: true });
                y = bt("LIGAR A MALHA", u(96), "ligar");
                bt("< VOLTAR", y + u(6), "voltar", null, false);
                return;
            }
            if (NET.convide && NET.fase === "lobby") {
                E.gfx.text((NET.convide.nome || "?") + " te desafia!", W / 2, u(62),
                           { color: C.branco, ts: "label", align: "center", screen: true });
                y = bt("ACEITAR", u(84), "aceitar");
                bt("RECUSAR", y + u(6), "recusar", null, false);
                return;
            }
            if (NET.fase === "convidei") {
                E.gfx.text("convite enviado para", W / 2, u(62),
                           { color: C.cinza, ts: "small", align: "center", screen: true });
                E.gfx.text(NET.convide ? NET.convide.nome : "?", W / 2, u(76),
                           { color: C.branco, ts: "label", align: "center", screen: true });
                bt("CANCELAR", u(104), "cancelar", null, false);
                return;
            }
            if (NET.fase === "aguarda") {
                E.gfx.text("duelo contra", W / 2, u(62),
                           { color: C.cinza, ts: "small", align: "center", screen: true });
                E.gfx.text(NET.rival ? NET.rival.nome : "?", W / 2, u(76),
                           { color: C.branco, ts: "label", align: "center", screen: true });
                E.gfx.text("esperando o inicio...", W / 2, u(96),
                           { color: C.cinza, ts: "small", align: "center", screen: true });
                bt("CANCELAR", u(120), "cancelar", null, false);
                return;
            }
            // lobby: Detonas vistos por perto (heartbeat dhl)
            var ids = [];
            for (var id in NET.vistos) ids.push(id);
            ids.sort(function (a, b) { return NET.vistos[b].at - NET.vistos[a].at; });
            y = u(58);
            var n = 0;
            for (var i = 0; i < ids.length && n < 3; i++) {
                var nome = (NET.vistos[ids[i]].nome || ids[i]).substring(0, 12);
                y = bt("DESAFIAR " + nome, y, "desafiar", { _id: ids[i] });
                n++;
            }
            if (!n)
                E.gfx.text("procurando Detona por perto...", W / 2, u(66),
                           { color: C.cinzaD, ts: "small", align: "center", screen: true });
            bt("< VOLTAR", H - u(27) - u(8), "voltar", null, false);
        }
    },

    jogando: {
        fps: 30,
        // o fim de rodada agenda E.after(900, ...) para a transicao; sair
        // da arena antes (pausa/titulo) derruba o timer pendente — sem isso
        // ele disparava E.goto("fim") em cima da proxima cena
        exit: function () { E.clearTimers(); },
        enter: function () {
            var sobre = E.data.modo === "sobre";
            var duelo = E.data.modo === "duelo";
            var mu = duelo ? 2 : prog.mundo, ni = duelo ? 4 : prog.nivel;
            if (!E.data.retomar) {
                var plano;
                if (duelo) {
                    // arena Irma: mesma seed nos dois aparelhos (mundo 2 =
                    // tema Forno + mix de powerups do meio da campanha)
                    plano = NV.gerar(2, 4, { duelo: true, seed: NET.seed });
                    plano.duelo = {
                        id: NET.rival ? NET.rival.id : "?",
                        nome: NET.rival ? NET.rival.nome : "?",
                        host: NET.host
                    };
                } else if (sobre) {
                    plano = NV.gerar(1, 1, { sobrevivencia: true });
                } else {
                    plano = NV.gerar(prog.mundo, prog.nivel);
                }
                arena.iniciar(mu, ni, plano);
                arena.layout(CELL, OX, OY);
                wireArena();
                if (duelo) {
                    NET.fase = "jogando";
                    NET.ultC = -1; NET.ultR = -1; NET.keepAte = 0;
                    arena.state().intro = 2.4;   // countdown contra o rival
                } else {
                    ia.ligar();                  // bichos do plano (+ chefe no 8o)
                    if (sobre) { ia.onda(); E.data.ondaBeat = -1; }
                }
            } else {
                E.data.retomar = false;
            }
            armarSprites(arena.state());   // blocos do tema + slots de bicho
            // fundo da camada suja = as celulas do mapa sob a caixa
            E.dirty.enable(function (x, y, w, h) { mapa.markRect(x, y, w, h); });
            E.dirty.clip(OX, OY, GW, GH);
            this.force = true;
            hudKey = "";
            if (E.data.musicPos !== undefined) {
                E.audio.music(NV.musica(mu, ni, sobre), { startMs: E.data.musicPos });
                E.data.musicPos = undefined;
            } else {
                E.audio.music(NV.musica(mu, ni, sobre));
            }
        },
        update: function (dt) {
            var s = arena.state();
            var tap = E.input.tap;
            var duelo = s && s.duelo;
            // canto superior direito: PAUSA na campanha; no duelo o mundo
            // nao para (o rival segue) — o botao vira desistencia
            if (tap && tap.x >= OX + (NV.COLS - 2) * CELL && tap.y < OY + CELL) {
                if (duelo) { netDesistir(); return; }
                E.data.retomar = true;
                var pos = typeof System.musicPos === "function" ? System.musicPos() : -1;
                E.data.musicPos = pos > 0 ? pos : undefined;
                E.goto("pausa");
                return;
            }
            // detonador remoto: chip BOOM no canto direito do HUD
            if (s && s.stats.remote && tap && tap.x > W - u(40) && tap.y > HUD_Y) {
                if (arena.detonar() && duelo) netSend("dd" + netSeq());
                tap = null;
            }
            // toque longo parado = detonador (quando tem)
            if (s && s.stats.remote && E.input.longpress && arena.detonar() && duelo)
                netSend("dd" + netSeq());
            var dir = joystick();
            arena.mover(dir[0], dir[1], dt);
            if (tap && tap.y < HUD_Y && arena.plantar()) {
                if (duelo) {
                    var bo = s.bombs[s.bombs.length - 1];
                    netSend("db" + netSeq() + "," + bo.fx + "," + bo.fy + "," +
                            Math.round((bo.de % 10) * 10) + "," + bo.range +
                            (bo.pierce ? ",1" : ""));
                }
            }
            // rede: drena a fila da malha, publica a minha celula, vigia o
            // rival (presenca) — ~3,4 msgs/s andando + keepalive de 2 s
            if (duelo && NET.fase === "jogando") {
                var now = System.millis();
                if (mesh.available()) mesh.each(netMsg, now);
                netPump(now);
                var cel = arena.celulaPlayer();
                if (cel.c !== NET.ultC || cel.r !== NET.ultR || now >= NET.keepAte) {
                    NET.ultC = cel.c; NET.ultR = cel.r; NET.keepAte = now + 2000;
                    netSend("dp" + netSeq() + "," + cel.c + "," + cel.r);
                }
            }
            var antesIntro = s && s.intro > 0;
            arena.update(dt);
            // dicas da 1a fase quando o cartao some
            if (antesIntro && s.intro <= 0 && s.mundo === 1 && s.nivel === 1 && !s.sobrevivencia) {
                var pcx = OX + s.player.x, pcy = OY + s.player.y;
                E.fx.popText(pcx + CELL * 3, pcy + CELL, "deslize = andar", { color: C.branco, ts: 'label', life: 2.4 });
                E.fx.popText(pcx + CELL * 3, pcy + CELL * 2.2, "toque = bomba", { color: C.ouro, ts: 'label', life: 2.4 });
            }
            // sobrevivencia: onda na batida (a cada 12) ou arena vazia
            if (s && s.sobrevivencia && !s.fim) {
                var bInt = Math.floor(arena.beatNow());
                if (bInt !== E.data.ondaBeat) {
                    E.data.ondaBeat = bInt;
                    if (bInt % 12 === 0 ||
                        (s.enemies.length === 0 && s.ondaAte <= 0)) ia.onda();
                }
            }
        },
        draw: function () {
            drawMundo(this.force);
            this.force = false;
        }
    },

    // ------------------------------------------- placar entre rounds -----
    // Mostra o resultado do round e o placar; 1.6 s de janela para o 'dm'
    // tardio do rival transformar derrota em EMPATE. Host comanda o
    // proximo round ('ds'); partida acaba em 2 vitorias (ou W.O./saida).
    round: {
        static: true,
        enter: function () {
            E.audio.stop();
            this.first = true;
            this.t = 0;
            this.ok = false;
            this.prox = false;
            this.fim = false;
            this.btn = null;
            hudKey = "";
        },
        update: function (dt) {
            this.t += dt;
            var now = System.millis();
            if (mesh.available() && netRadio()) {
                mesh.each(netMsg, now);
                netPump(now);
            }
            if (!this.ok && this.t > 1.6) {
                this.ok = true;
                if (NET.res === "venci") NET.ganhos++;
                else if (NET.res === "perdi") NET.perdidos++;
                else if (NET.res === "saiu") NET.ganhos = 2;      // W.O.
                else if (NET.res === "desisti") NET.perdidos = 2;
                logDuelo("round " + NET.round + ": " + (NET.res || "?") +
                         " (" + NET.ganhos + "x" + NET.perdidos + ")");
                this.fim = NET.ganhos >= 2 || NET.perdidos >= 2;
                E.redraw();
            }
            if (this.ok && this.fim) {
                if (this.btn && this.t > 0.4 && E.hit(this.btn[0])) {
                    E.audio.sfx("ok");
                    netReset();
                    E.goto("titulo", { transition: "fade", ms: 300 });
                }
                return;
            }
            if (this.ok && NET.host && !this.prox && this.t > 2.8) {
                this.prox = true;
                netInicioRound();
            }
        },
        draw: function () {
            if (this.first) {
                this.first = false;
                System.fillScreen(C.preto);
            }
            var res = NET.res || "...";
            var tit = this.fim ? (NET.ganhos >= 2 ? "VITORIA NO DUELO!" : "DERROTA") :
                      res === "venci" ? "ROUND GANHO!" :
                      res === "perdi" ? "ROUND PERDIDO" :
                      res === "empate" ? "EMPATE!" :
                      res === "saiu" ? "RIVAL SAIU" :
                      res === "desisti" ? "VOCE SAIU" : "ROUND";
            var y = Math.round(H * 0.16);
            E.gfx.text(tit, W / 2, y, { color: this.fim && NET.ganhos >= 2 ? C.verde : C.ouro,
                       px: u(18), fit: W - u(24), align: "center", valign: "middle",
                       screen: true });
            y += u(32);
            E.gfx.text("voce " + NET.ganhos + " x " + NET.perdidos + " " +
                       (NET.rival ? NET.rival.nome.substring(0, 10) : "?"),
                       W / 2, y, { color: C.branco, ts: "label", align: "center",
                       valign: "middle", screen: true });
            if (!this.ok) {
                E.gfx.text("conferindo...", W / 2, y + u(24),
                           { color: C.cinzaD, ts: "small", align: "center", screen: true });
            } else if (this.fim) {
                this.btn = botoes(H - u(27) - u(10) - u(18), ["MENU"], C.preto);
            } else {
                E.gfx.text(NET.host ? "proximo round..." : "esperando o host...",
                           W / 2, y + u(24), { color: C.cinza, ts: "small",
                           align: "center", screen: true });
            }
        }
    },

    pausa: {
        static: true,
        enter: function () {
            E.audio.stop();
            this.first = true;
        },
        update: function () {
            if (!this.btn) return;
            if (E.hit(this.btn[0])) { E.audio.sfx("ui"); E.goto("jogando"); }   // retomar (estado vivo)
            else if (E.hit(this.btn[1])) { arena.parar(); E.goto("titulo"); }
        },
        draw: function () {
            var pw = Math.min(u(180), W - u(30)), ph = u(150);
            var px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
            if (this.first) {
                this.first = false;
                // painel por cima da arena congelada (sem limpar a tela)
                E.gfx.panel(px, py, pw, ph, { bg: C.painel, stroke: C.laranja, screen: true });
                E.gfx.text("PAUSA", W / 2, py + u(26), { color: C.ouro, px: u(21),
                           align: "center", valign: "middle", screen: true });
            }
            var bw = pw - u(30), bh = u(27), bx = Math.round((W - bw) / 2), by = py + u(52);
            System.fillRect(bx - 2, by - 2, bw + 4, bh * 2 + u(10) + 4, C.painel);
            this.btn = [
                E.gfx.button("CONTINUAR", bx, by, bw, bh, { color: C.laranja, screen: true }),
                E.gfx.button("MENU", bx, by + bh + u(10), bw, bh, {
                    primary: false, bg: C.preto, stroke: C.laranja, textColor: C.branco, screen: true })
            ];
        }
    },

    fim: {
        static: true,
        enter: function () {
            E.audio.stop();
            this.first = true;
            this.t = 0;
            var info = E.data.fimInfo || { fim: 'dead', score: 0 };
            E.data.novoRec = E.save.best(info.sobre ? "sobre.hi" : "hi", info.score);
            if (E.data.novoRec) E.audio.sfx("record");
        },
        update: function (dt) {
            this.t += dt;
            if (this.t < 0.4 || !this.btn) return;   // engole o tap do momento final
            var info = E.data.fimInfo || { fim: 'dead', score: 0 };
            if (E.hit(this.btn[0])) {
                E.audio.sfx("ok");
                E.data.retomar = false;
                if (!info.sobre && info.fim === 'win') {
                    prog.mundo = E.save.num("mundo", 1);
                    prog.nivel = E.save.num("nivel", 1);
                }
                E.data.modo = info.sobre ? "sobre" : "campanha";
                E.goto("jogando", { transition: "wipe", ms: 300 });
            } else if (E.hit(this.btn[1])) {
                E.audio.sfx("ui");
                E.goto("titulo", { transition: "fade", ms: 300 });
            }
        },
        draw: function () {
            var info = E.data.fimInfo || { fim: 'dead', score: 0 };
            if (this.first) {
                this.first = false;
                System.fillScreen(C.preto);
                var titulo = info.sobre ? "ONDA " + info.onda :
                             info.zerou ? "CAMPANHA COMPLETA!" :
                             info.fim === 'win' ? "FASE LIMPA!" :
                             info.fim === 'tempo' ? "TEMPO ESGOTADO" : "FIM DE JOGO";
                var y = Math.round(H * 0.17);
                E.gfx.text(titulo, W / 2, y, { color: info.fim === 'win' ? C.verde : C.ouro,
                           px: u(21), fit: W - u(24), align: "center", valign: "middle", screen: true });
                y += u(36);
                E.gfx.text(String(info.score), W / 2, y, { color: C.branco, px: u(30),
                           align: "center", valign: "middle", screen: true });
                y += u(26);
                E.gfx.text(info.fim === 'win' && info.bonus ? "pontos (bonus de tempo +" + info.bonus + ")"
                                                             : "pontos", W / 2, y,
                           { color: C.cinza, ts: "small", align: "center", valign: "middle",
                             fit: W - u(20), screen: true });
                y += u(18);
                if (info.zerou) {
                    E.gfx.text("os 3 mundos cairam - recomeca do 1-1", W / 2, y - u(36) + u(54),
                               { color: C.verde, ts: "small", align: "center", valign: "middle",
                                 fit: W - u(20), screen: true });
                }
                if (E.data.novoRec) {
                    E.gfx.text("NOVO RECORDE!", W / 2, y, { color: C.laranja, ts: "label",
                               align: "center", valign: "middle", screen: true });
                }
            }
            var rotulo = info.sobre ? "DE NOVO" : info.zerou ? "DE NOVO"
                       : info.fim === 'win' ? "PROXIMA FASE" : "TENTAR DE NOVO";
            this.btn = botoes(H - u(27) * 2 - u(10) - u(18), [rotulo, "MENU"], C.preto);
        }
    }
}, "titulo");

// ---------------------------------------------------------------- ganchos --

function wireArena() {
    var s = arena.state();
    s.onSfx = function (nome, tam) {
        if (nome === 'bum') {
            SFX.via(E.audio, tam >= 7 ? 'boomGra' : 'boomPeq', { duck: 650 });
        } else if (nome === 'bicho') {
            SFX.via(E.audio, 'bicho', { oitava: -1 });
        } else if (nome === 'vento') {
            E.audio.sfx([[90, 60], [70, 120]]);
        } else if (nome === 'tele') {
            E.audio.sfx([[600, 30], [900, 30], [1300, 60]]);
        } else {
            SFX.via(E.audio, nome);
        }
    };
    s.onFx = function (tipo, a, b) {
        if (tipo === 'bum') {
            // explosao comum: anel + faiscas (sem flash/tremor a cada bomba:
            // era o vidro "vibrando com flashes" o tempo todo)
            var cx = OX + (a.c + 0.5) * CELL, cy = OY + (a.r + 0.5) * CELL;
            E.fx.ring(cx, cy, { speed: CELL * 9, color: C.laranja, life: 0.4 });
            E.fx.burst(cx, cy, { n: 14, colors: [C.ouro, C.laranja, C.vermelho],
                                 speed: CELL * 5, life: 0.45 });
            if (b && b.length >= 7) E.fx.flash(C.ouro, 120);   // so a explosao grande brilha
        } else if (tipo === 'macio') {
            var mx = OX + (a.c + 0.5) * CELL, my = OY + (a.r + 0.5) * CELL;
            E.fx.burst(mx, my, { n: 8, colors: [0x8410, 0x6204, C.cinza],
                                 speed: CELL * 3, life: 0.45, grav: CELL * 6 });
        } else if (tipo === 'power') {
            var cel = arena.celulaPlayer();
            var px = OX + (cel.c + 0.5) * CELL, py = OY + (cel.r + 0.5) * CELL;
            E.fx.popText(px, py - CELL, nomePower(b), { color: C.ciano, ts: 'label' });
        } else if (tipo === 'combo') {
            var cbx = OX + (a.c + 0.5) * CELL, cby = OY + (a.r + 0.5) * CELL;
            E.fx.popText(cbx, cby - CELL, "COMBO x" + a.mult, { color: C.magenta, ts: 'big' });
            E.fx.ring(cbx, cby, { speed: CELL * 12, color: C.magenta, life: 0.3 });
        } else if (tipo === 'saida') {
            var sx = OX + (a.c + 0.5) * CELL, sy = OY + (a.r + 0.5) * CELL;
            E.fx.popText(sx, sy - CELL, "SAIDA!", { color: C.verde, ts: 'label' });
            E.fx.ring(sx, sy, { speed: CELL * 8, color: C.verde, life: 0.5 });
        } else if (tipo === 'bicho') {
            // a veio em pixels do centro do bicho (coordenadas da grade)
            E.fx.burst(OX + a.x, OY + a.y, { n: 12, colors: [C.branco, C.laranja],
                                             speed: CELL * 4, life: 0.5 });
            E.fx.popText(OX + a.x, OY + a.y - CELL / 2, "+" + a.pontos, { color: C.ouro, ts: 'small' });
        } else if (tipo === 'golpe') {
            var gx = OX + a.fx * CELL, gy = OY + a.fy * CELL;
            E.fx.burst(gx, gy, { n: 10, colors: [C.branco, 0xBDF7], speed: CELL * 4, life: 0.35 });
            E.fx.popText(gx, gy - CELL * 0.6, a.kind === 'chefe' ? "-1" : "BLINDAGEM!", { color: C.ciano, ts: 'small' });
        } else if (tipo === 'vento') {
            E.fx.burst(OX + (a.c + 0.5) * CELL, OY + (a.r + 0.5) * CELL,
                       { n: 8, colors: [C.laranja, C.ouro], speed: CELL * 3, life: 0.4, grav: -CELL * 4 });
        } else if (tipo === 'tele') {
            E.fx.ring(OX + (a.c + 0.5) * CELL, OY + (a.r + 0.5) * CELL, { speed: CELL * 6, color: C.magenta, life: 0.35 });
            E.fx.ring(OX + (b.c + 0.5) * CELL, OY + (b.r + 0.5) * CELL, { speed: CELL * 6, color: C.ciano, life: 0.45 });
        } else if (tipo === 'escudo') {
            E.fx.ring(OX + a.x, OY + a.y, { speed: CELL * 7, color: C.ciano, life: 0.4 });
            E.fx.popText(OX + a.x, OY + a.y - CELL, "ESCUDO!", { color: C.ciano, ts: 'label' });
        } else if (tipo === 'respawn') {
            E.fx.ring(OX + a.x, OY + a.y, { speed: CELL * 5, color: C.branco, life: 0.5 });
        } else if (tipo === 'joga') {
            E.fx.ring(OX + (b.c + 0.5) * CELL, OY + (b.r + 0.5) * CELL, { speed: CELL * 4, color: C.magenta, life: 0.3 });
        } else if (tipo === 'onda') {
            E.fx.popText(OX + GW / 2, OY + GH * 0.4, "ONDA " + a, { color: C.laranja, ts: 'big', life: 1.4 });
        } else if (tipo === 'morte') {
            E.fx.burst(OX + a.x, OY + a.y, { n: 22, colors: [C.branco, C.ciano],
                                             speed: CELL * 4, life: 0.6 });
            E.fx.flash(C.vermelho, 320);
            E.cam.shake(CELL * 0.25, 0.4);
        }
    };
    // eventos que viram mensagem na malha (so em duelo)
    s.onPegar = function (kind, cel) {
        if (s.duelo) netSend("dg" + netSeq() + "," + cel.c + "," + cel.r);
    };
    s.onChutar = function (c, r, dx, dy) {
        if (s.duelo) netSend("dk" + netSeq() + "," + c + "," + r + "," + dx + "," + dy);
    };
    s.onFim = function () {
        var st = arena.state();
        if (st.duelo) {
            // a morte e autoridade de cada um: 'dead' avisa o rival; 'rwin'
            // veio do 'dm' dele. Os dois avisarem = empate (handler 'm')
            if (st.fim === 'dead') {
                netSend("dm" + netSeq());
                if (!NET.res) NET.res = "perdi";
            } else if (st.fim === 'rwin' && !NET.res) {
                NET.res = "venci";
            }
            logDuelo("fim do round: " + st.fim);
            E.after(900, function () {
                arena.parar();
                NET.fase = "round";
                E.goto("round");
            });
            return;
        }
        var sobre = !!st.sobrevivencia;
        E.data.fimInfo = { fim: st.fim, score: st.score, sobre: sobre,
                           onda: st.onda, mundo: st.mundo, nivel: st.nivel,
                           bonus: st.bonusTempo || 0, zerou: false };
        if (st.fim === 'win') {
            var nv = st.nivel + 1, mu = st.mundo;
            if (nv > NV.NIVEIS_POR_MUNDO) { nv = 1; mu++; }
            if (mu > NV.MUNDOS) {
                // fechou o chefe do ultimo mundo: campanha completa
                E.data.fimInfo.zerou = true;
                E.save.set("zerou", String(E.save.num("zerou", 0) + 1));
                mu = 1; nv = 1;
            }
            E.save.set("mundo", String(mu));
            E.save.set("nivel", String(nv));
        } else if (sobre) {
            E.save.best("sobre.hi", st.score);
        }
        E.after(900, function () { arena.parar(); E.goto("fim"); });
    };
}

function nomePower(k) {
    if (k === 'B') return "+BOMBA";
    if (k === 'C') return "+CHAMA";
    if (k === 'V') return "VELOCIDADE";
    if (k === 'K') return "CHUTE";
    if (k === 'R') return "DETONADOR";
    if (k === 'E') return "ESCUDO";
    if (k === 'X') return "+VIDA";
    if (k === 'P') return "PERFURANTE";
    if (k === 'T') return "+30 S";
    return "?";
}
