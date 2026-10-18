// arte.js — o desenho do Arrasa!: sprites da arte gerada (pedra brava,
// goblins, texturas de material, cenario com o estilingue) carregados uma
// vez e redimensionados PARA A TELA DA PLACA (drawSprite smooth, API 33);
// pecas desenhadas giradas (drawSprite com angulo/zoom) + contorno e
// rachaduras procedurais; estilingue com elastico de verdade.
//
// 1.3.0: a arte de IA entra pela E.spr — ai_atlas (grade 4x4 de 64 px,
// fundo magenta 0xF81F: ai0 goblin, ai1 rei, ai2 catapulta, ai3 pedra) e
// ai_bg (campo de flores, estampado no cenario composto do painter). Os
// quadros antigos de goblin/rei/pedra/pedrao saem do pacote; sem atlas
// (E.spr.backed false) cada peca cai no desenho procedural.
//
// Orcamento do pool (16 slots com PSRAM desde a API 33; eram 8 ate a 32 —
// foi por este jogo que o pool dobrou): fundo (tela inteira) + atlas de IA
// + ai_bg + 5 tiros com arte + 3 texturas = 11; sem o atlas, entram os 4
// PNGs antigos (15). Sem slot ou sem PNG, cada peca cai num desenho
// procedural (nunca tela vazia).

var S = System;
var E = require("celeros.game");
var M = require("mundo");

var DEG = 57.29578;
var KEY = 0x0000;
var MAGENTA = 0xF81F;          // cor-chave do atlas de IA

var A = {
    W: 0, H: 0, ESC: 1, OY: 0,
    spr: {},                 // nome -> { id, w, h }
    base: "",
    temAtlas: false,         // ai0..ai3 em slot real
    temBg: false             // ai_bg em slot real
};

var C = {};
function cores() {
    C.ceuTopo = S.color(52, 150, 196);
    C.ceu = S.color(61, 169, 210);
    C.grama = S.color(118, 196, 52);
    C.terra = S.color(120, 74, 46);
    C.madeira = S.color(181, 133, 83);
    C.madeiraEsc = S.color(92, 56, 28);
    C.pedra = S.color(148, 149, 146);
    C.pedraEsc = S.color(58, 60, 66);
    C.vidro = S.color(150, 210, 236);
    C.vidroEsc = S.color(52, 110, 150);
    C.tnt = S.color(206, 54, 38);
    C.tntEsc = S.color(96, 18, 12);
    C.amarelo = S.color(250, 206, 48);
    C.rocha = S.color(110, 104, 98);
    C.rochaEsc = S.color(46, 42, 40);
    C.goblin = S.color(124, 190, 60);
    C.goblinEsc = S.color(30, 60, 18);
    C.couro = S.color(70, 38, 20);
    C.couroClaro = S.color(116, 66, 34);
    C.bomba = S.color(36, 38, 58);
    C.branco = 0xFFFF;
    C.preto = S.color(16, 12, 10);
    C.ouro = S.color(255, 206, 40);
    C.texto = S.color(255, 250, 236);
    C.sombra = S.color(20, 26, 40);
    C.painel = S.color(44, 34, 30);
    C.painelClaro = S.color(86, 62, 44);
}

// ------------------------------------------------------------ vista -------
function sx(x) { return A.ESC * x; }
function sy(y) { return A.OY + A.ESC * y; }
A.sx = sx;
A.sy = sy;
A.wx = function (px) { return px / A.ESC; };
A.wy = function (py) { return (py - A.OY) / A.ESC; };

// ---------------------------------------------------------- carregar ------
function png(id, file) {
    S.useSprite(id);
    S.fillScreen(KEY);
    var ok = false;
    try { ok = !!S.drawPNG(A.base + file, 0, 0); } catch (e) { ok = false; }
    S.useSprite(0);
    return ok;
}

// pasta do app: a loja instala FLAT em /local|/sd/apps/<pacote>/; o
// celerctl dev usa o nome da pasta do repo. A 1a base com a arte vence.
function achaBase(dir, pkg) {
    var cands = ["/local/apps/" + pkg + "/", "/sd/apps/" + pkg + "/",
                 "/local/apps/" + dir + "/", "/sd/apps/" + dir + "/"];
    var id = S.createSprite(8, 8);
    if (!id) return cands[0];
    var achou = cands[0];
    for (var i = 0; i < cands.length; i++) {
        A.base = cands[i];
        if (png(id, "tex_madeira.png")) { achou = cands[i]; break; }
    }
    S.deleteSprite(id);
    return achou;
}

// atlas de IA: 1 slot para os 4 personagens/objetos (ai0..ai3) e 1 para o
// campo de flores. Sem slot (ou PNG ausente) o sheet e liberado na hora e
// o jogo cai no procedural/PNG antigo.
function carregaIA() {
    if (!E.spr || typeof E.spr.grid !== "function") return;
    E.spr.grid("ai", { file: "ai_atlas", cols: 4, rows: 4, tw: 64, th: 64, prefix: "ai" });
    A.temAtlas = E.spr.backed("ai0");
    if (!A.temAtlas) E.spr.freeSheet("ai");
    // o PNG fornecido tem 192x192 (o nome sugere 256): o sheet usa o
    // tamanho real do arquivo para nao esticar area vazia
    E.spr.sheet("aibg", { file: "ai_bg", w: 192, h: 192,
                          regions: { bg: [0, 0, 192, 192] } });
    A.temBg = E.spr.backed("bg");
    if (!A.temBg) E.spr.freeSheet("aibg");
}

// PNG (tamanho do arquivo) -> sprite no tamanho da tela (reduz com AA)
function carregaRedim(nome, file, fw, fh, w, h) {
    w = Math.max(4, Math.round(w));
    h = Math.max(4, Math.round(h));
    var tmp = S.createSprite(fw, fh);
    if (!tmp) return null;
    if (!png(tmp, file)) { S.deleteSprite(tmp); return null; }
    var id = S.createSprite(w, h);
    if (!id) { S.deleteSprite(tmp); return null; }
    S.useSprite(id);
    S.fillScreen(KEY);
    S.drawSprite(tmp, w / 2, h / 2, 0, w / fw, h / fh, KEY, true);
    S.useSprite(0);
    S.deleteSprite(tmp);
    A.spr[nome] = { id: id, w: w, h: h };
    return A.spr[nome];
}

function carregaDireto(nome, file, w, h) {
    var id = S.createSprite(w, h);
    if (!id) return null;
    if (!png(id, file)) { S.deleteSprite(id); return null; }
    A.spr[nome] = { id: id, w: w, h: h };
    return A.spr[nome];
}

// fundo: tela inteira; o PNG cobre o MUNDO (480 px = 320 u); acima dele
// (tela mais alta que o mundo) um degradê continua o ceu
function carregaFundo() {
    var W = A.W, H = A.H;
    var id = S.createSprite(W, H);
    if (!id) return false;
    S.useSprite(id);
    if (A.OY > 0) S.fillGradient(0, 0, W, Math.ceil(A.OY) + 1, C.ceuTopo, C.ceu);
    S.useSprite(0);
    var tmp = S.createSprite(480, 480);
    var ok = false;
    if (tmp) {
        ok = png(tmp, "fundo.png");
        if (ok) {
            S.useSprite(id);
            var z = A.ESC / 1.5;
            S.drawSprite(tmp, W / 2, A.OY + 160 * A.ESC, 0, z, z, null, Math.abs(z - 1) > 0.01);
            S.useSprite(0);
        }
        S.deleteSprite(tmp);
    }
    if (!ok) {
        // procedural: ceu, morro, chao e o estilingue em Y
        S.useSprite(id);
        S.fillGradient(0, 0, W, Math.round(sy(M.GROUND)), C.ceuTopo, S.color(170, 226, 250));
        S.fillCircle(Math.round(sx(250)), Math.round(sy(M.GROUND + 90)), Math.round(150 * A.ESC), S.color(86, 170, 60));
        S.fillRect(0, Math.round(sy(M.GROUND)), W, H, C.terra);
        S.fillRect(0, Math.round(sy(M.GROUND)), W, Math.round(6 * A.ESC), C.grama);
        var g = M.GARFO, bx = sx(51.3), by = sy(M.GROUND), my = sy(256), e = Math.max(3, 5 * A.ESC);
        S.drawWideLine(bx, by, bx, my, e, C.madeiraEsc);
        S.drawWideLine(bx, my, sx(g[0].x), sy(g[0].y), e, C.madeiraEsc);
        S.drawWideLine(bx, my, sx(g[1].x), sy(g[1].y), e, C.madeiraEsc);
        S.useSprite(0);
    }
    // arte de IA por cima do cenario: campo de flores na faixa do chao
    // (tile, sem clip extra: o tile comeca na linha do chao) e a catapulta
    // no lugar do estilingue. O fundo composto continua sendo o sprite
    // unico do painter (camada suja intacta).
    if (A.temBg || A.temAtlas) {
        S.useSprite(id);
        if (A.temBg) campoIA();
        if (A.temAtlas) catapultaIA();
        S.useSprite(0);
    }
    A.spr.fundo = { id: id, w: W, h: H };
    return true;
}

// campo de flores ai_bg em tiles na faixa do chao; escala 1.25 em 480 px
// (a imagem fornecida tem 192 px, entao 2 tiles cobrem a largura)
function campoIA() {
    var sc = Math.max(1, A.W / 384);
    var tile = 192 * sc;
    var y = Math.round(sy(M.GROUND));
    for (var x = 0; x < A.W; x += tile) {
        E.spr.stamp("bg", x, y, { scale: sc, key: null });
    }
}

// catapulta ai2: a forquilha do estilingue (desenhada no fundo e usada pelo
// elastico) fica dentro do sprite; a ancora e o pe, no chao
function catapultaIA() {
    var sc = 70 * A.ESC / 64;
    E.spr.stamp("ai2", sx(51.3), sy(M.GROUND), { scale: sc, key: MAGENTA, ax: 0.5, ay: 1 });
}

// lado do sprite / diametro do corpo (medido pelo tools/arrasa_sprites.py)
// + folga do contorno
var TIRO_ARTE = { pedrao: 1.06, tripla: 1.05, flecha: 1.27, bomba: 1.37,
                  chocadeira: 1.15, bumerangue: 1.07 };

A.init = function (W, H, dir, pkg) {
    cores();
    A.W = W; A.H = H;
    A.ESC = W / M.MW;
    if (M.MW * A.ESC > W) A.ESC = W / M.MW;
    A.OY = H - 320 * A.ESC;
    if (typeof S.drawSprite !== "function") return false;
    A.base = achaBase(dir, pkg);
    carregaIA();                 // atlas + campo de flores (2 slots)
    carregaFundo();              // cenario composto (usa o campo/catapulta)
    // personagens: o circulo do corpo ocupa ~78% do sprite (orelhas/coroa).
    // Com o atlas de IA os PNGs antigos nem entram no pool (nem no pacote).
    if (!A.temAtlas) {
        var dp = 2 * M.TIRO.pedra.r * A.ESC * 1.08;
        carregaRedim("pedra", "pedra.png", 64, 64, dp, dp);
        var dg = 2 * 7 * A.ESC * 1.42;
        carregaRedim("goblin", "goblin.png", 64, 64, dg, dg);
        var dr = 2 * 10 * A.ESC * 1.42;
        carregaRedim("rei", "rei.png", 64, 64, dr, dr);
    }
    // um sprite por tipo de tiro (o circulo ocupa uma fracao do sprite:
    // estopim, bico, crista e ponta passam do corpo). O pedrao vem do
    // atlas (ai3) quando ele esta carregado.
    for (var tp in TIRO_ARTE) {
        if (tp === "pedrao" && A.temAtlas) continue;
        var d = 2 * M.TIRO[tp].r * A.ESC * TIRO_ARTE[tp];
        carregaRedim("t_" + tp, tp + ".png", 64, 64, d, d);
    }
    carregaDireto("madeira", "tex_madeira.png", 64, 12);
    carregaDireto("pedra_t", "tex_pedra.png", 40, 40);
    carregaDireto("vidro", "tex_vidro.png", 40, 40);
    return true;
};

// --------------------------------------------------------- fundo ----------
// painter da camada suja: devolve o pedaco do cenario. API 34: blitSprite
// numa chamada; antes, pushSprite recortado (5 bindings por caixa — no
// quadro de voo eram ~30 caixas, 2/3 das chamadas nativas do quadro)
var BLIT = typeof S.blitSprite === "function";
A.painter = function (x, y, w, h) {
    var f = A.spr.fundo;
    if (!f) { S.fillRect(x, y, w, h, C.ceu); return; }
    if (BLIT) { S.blitSprite(f.id, x, y, w, h); return; }
    S.setClip(x, y, w, h);
    S.useSprite(f.id);
    S.pushSprite(0, 0);
    S.useSprite(0);
    S.clearClip();
};

A.fundoInteiro = function () {
    var f = A.spr.fundo;
    if (!f) { S.fillScreen(C.ceu); return; }
    S.useSprite(f.id);
    S.pushSprite(0, 0);
    S.useSprite(0);
};

// ---------------------------------------------------------- pecas ---------
var TEXN = { madeira: "madeira", pedra: "pedra_t", vidro: "vidro", rocha: "pedra_t" };
var CONT = {};   // contorno por material (preenchido no 1o uso)
function contorno(mat) {
    if (!CONT.madeira) {
        CONT.madeira = C.madeiraEsc; CONT.pedra = C.pedraEsc; CONT.vidro = C.vidroEsc;
        CONT.tnt = C.tntEsc; CONT.rocha = C.rochaEsc;
    }
    return CONT[mat] || C.preto;
}
function corBase(mat) {
    if (mat === "madeira") return C.madeira;
    if (mat === "pedra") return C.pedra;
    if (mat === "vidro") return C.vidro;
    if (mat === "tnt") return C.tnt;
    return C.rocha;
}
A.corMat = corBase;

// cantos do retangulo girado em px de tela (reaproveita o array). Guarda
// o cos/sin em CS/SN: o loc() da mesma peca reaproveita (faixa da TNT e
// rachaduras chamavam Math.cos/sin de novo por ponto)
var Q = [0, 0, 0, 0, 0, 0, 0, 0];
var CS = 1, SN = 0;
function cantos(x, y, hw, hh, a) {
    var c = CS = Math.cos(a), s = SN = Math.sin(a);
    var ax = c * hw, ay = s * hw, bx = -s * hh, by = c * hh;
    var X = sx(x), Y = sy(y), E = A.ESC;
    Q[0] = X + (-ax - bx) * E; Q[1] = Y + (-ay - by) * E;
    Q[2] = X + (ax - bx) * E;  Q[3] = Y + (ay - by) * E;
    Q[4] = X + (ax + bx) * E;  Q[5] = Y + (ay + by) * E;
    Q[6] = X + (-ax + bx) * E; Q[7] = Y + (-ay + by) * E;
}

// local (u) -> tela, no referencial da peca (cos/sin do ultimo cantos():
// so chame logo depois dele, para a mesma peca)
function loc(x, y, lx, ly, out, k) {
    var c = CS, s = SN;
    out[k] = sx(x + c * lx - s * ly);
    out[k + 1] = sy(y + s * lx + c * ly);
}

// rachaduras: 3 linhas quebradas sorteadas pela semente, do canto ao meio
function rachas(c) {
    if (c.rachas) return c.rachas;
    var r = [], sd = c.semente || 1;
    function rnd() { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return (sd % 1000) / 1000; }
    var hw = c.w / 2, hh = c.h / 2;
    for (var k = 0; k < 3; k++) {
        var lado = Math.floor(rnd() * 4);
        var px = lado < 2 ? (rnd() * 2 - 1) * hw : (lado === 2 ? -hw : hw);
        var py = lado < 2 ? (lado === 0 ? -hh : hh) : (rnd() * 2 - 1) * hh;
        var linha = [px, py];
        for (var s = 0; s < 3; s++) {
            px = px * 0.45 + (rnd() * 2 - 1) * hw * 0.35;
            py = py * 0.45 + (rnd() * 2 - 1) * hh * 0.35;
            linha.push(px, py);
        }
        r.push(linha);
    }
    c.rachas = r;
    return r;
}

var P2 = [0, 0, 0, 0];
A.peca = function (c, x, y, a) {
    var hw = c.w / 2, hh = c.h / 2;
    cantos(x, y, hw, hh, a);
    var tex = A.spr[TEXN[c.mat]];
    if (tex) {
        S.drawSprite(tex.id, sx(x), sy(y), a * DEG, c.w * A.ESC / tex.w, c.h * A.ESC / tex.h);
    } else if (c.mat !== "tnt") {
        var cb = corBase(c.mat);
        S.fillTriangle(Q[0], Q[1], Q[2], Q[3], Q[4], Q[5], cb);
        S.fillTriangle(Q[0], Q[1], Q[4], Q[5], Q[6], Q[7], cb);
    }
    if (c.mat === "tnt") {
        S.fillTriangle(Q[0], Q[1], Q[2], Q[3], Q[4], Q[5], C.tnt);
        S.fillTriangle(Q[0], Q[1], Q[4], Q[5], Q[6], Q[7], C.tnt);
        // faixa amarela + estopim
        loc(x, y, -hw, -hh * 0.25, P2, 0);
        loc(x, y, hw, -hh * 0.25, P2, 2);
        S.drawWideLine(P2[0], P2[1], P2[2], P2[3], Math.max(2, c.h * 0.32 * A.ESC), C.amarelo);
        loc(x, y, 0, -hh * 0.25, P2, 0);
        S.fillCircle(Math.round(P2[0]), Math.round(P2[1]), Math.max(1, Math.round(1.6 * A.ESC)), C.preto);
    }
    var ct = contorno(c.mat), e = Math.max(1, A.ESC * 0.9);
    S.drawWideLine(Q[0], Q[1], Q[2], Q[3], e, ct);
    S.drawWideLine(Q[2], Q[3], Q[4], Q[5], e, ct);
    S.drawWideLine(Q[4], Q[5], Q[6], Q[7], e, ct);
    S.drawWideLine(Q[6], Q[7], Q[0], Q[1], e, ct);
    // dano: rachaduras (1 com 2/3 da vida, todas com 1/3)
    if (c.hp0 && c.hp < c.hp0 * 0.7) {
        var rs = rachas(c), n = c.hp < c.hp0 * 0.38 ? 3 : 1;
        var cr = c.mat === "vidro" ? C.branco : ct;
        for (var k = 0; k < n; k++) {
            var L = rs[k];
            for (var j = 0; j + 3 < L.length; j += 2) {
                loc(x, y, L[j], L[j + 1], P2, 0);
                loc(x, y, L[j + 2], L[j + 3], P2, 2);
                S.drawLine(Math.round(P2[0]), Math.round(P2[1]), Math.round(P2[2]), Math.round(P2[3]), cr);
            }
        }
    }
    return caixaQ(e + 1);
};

var BOX = { x: 0, y: 0, w: 0, h: 0 };
function caixaQ(m) {
    var x0 = Math.min(Q[0], Q[2], Q[4], Q[6]), x1 = Math.max(Q[0], Q[2], Q[4], Q[6]);
    var y0 = Math.min(Q[1], Q[3], Q[5], Q[7]), y1 = Math.max(Q[1], Q[3], Q[5], Q[7]);
    BOX.x = x0 - m; BOX.y = y0 - m; BOX.w = x1 - x0 + 2 * m; BOX.h = y1 - y0 + 2 * m;
    return BOX;
}

// caixa de tela de uma peca/goblin/tiro sem desenhar (dirty/touches).
// Memoizada por POSE no proprio corpo: a pilha dormindo pergunta a caixa a
// cada quadro (a borracha me tocou?) com x/y/angulo identicos — sem cos/sin
// nem min/max de 4 cantos de novo
A.caixa = function (c, x, y, a) {
    if (c._cx === x && c._cy === y && c._ca === a) {
        BOX.x = c._bx; BOX.y = c._by; BOX.w = c._bw; BOX.h = c._bh;
        return BOX;
    }
    if (c.k === "box") {
        cantos(x, y, c.w / 2, c.h / 2, a);
        caixaQ(A.ESC + 1);
    } else {
        var r = (c.k === "goblin" ? c.r * 1.45 : c.r * 1.2 + 3) * A.ESC + 2;
        BOX.x = sx(x) - r; BOX.y = sy(y) - r * 1.15; BOX.w = r * 2; BOX.h = r * 2.15;
    }
    c._cx = x; c._cy = y; c._ca = a;
    c._bx = BOX.x; c._by = BOX.y; c._bw = BOX.w; c._bh = BOX.h;
    return BOX;
};

A.goblin = function (c, x, y, a) {
    var X = sx(x), Y = sy(y);
    var desenhou = false;
    if (A.temAtlas) {
        // ai0 goblin / ai1 rei: 64 px de celula, corpo do circulo ocupa
        // ~69% dela (mesma proporcao dos PNGs antigos: r * 1.45)
        var k = (c.r * 2 * 1.45 * A.ESC) / 64;
        desenhou = E.spr.stamp(c.tipo === "rei" ? "ai1" : "ai0", X, Y,
                               { scale: k, key: MAGENTA, ax: 0.5, ay: 0.5 });
    }
    if (desenhou) {
        // atlas ja desenhou
    } else {
        var sp = A.spr[c.tipo === "rei" ? "rei" : "goblin"];
        if (sp) {
            S.drawSprite(sp.id, X, Y, a * DEG, 1, 1, KEY);
        } else {
            var r = c.r * A.ESC;
            S.fillSmoothCircle(X, Y, r, C.goblin);
            S.fillCircle(Math.round(X - r * 0.35), Math.round(Y - r * 0.2), Math.max(1, Math.round(r * 0.22)), C.branco);
            S.fillCircle(Math.round(X + r * 0.35), Math.round(Y - r * 0.2), Math.max(1, Math.round(r * 0.22)), C.branco);
            if (c.tipo === "rei") S.fillTriangle(X - r * 0.6, Y - r * 0.8, X + r * 0.6, Y - r * 0.8, X, Y - r * 1.5, C.ouro);
        }
    }
    // machucado: curativo em X na testa
    if (c.hp < c.hp0 * 0.6) {
        var q = c.r * 0.45 * A.ESC, cx = X + c.r * 0.25 * A.ESC, cy = Y - c.r * 0.55 * A.ESC;
        var e = Math.max(2, Math.round(A.ESC * 1.6));
        S.drawWideLine(cx - q, cy - q * 0.5, cx + q, cy + q * 0.5, e, S.color(240, 222, 196));
        S.drawWideLine(cx - q, cy + q * 0.5, cx + q, cy - q * 0.5, e, S.color(240, 222, 196));
    }
    return A.caixa(c, x, y, a);
};

// projetil (no ar, no estilingue ou na fila)
A.tiro = function (tipo, x, y, a, t) {
    var X = sx(x), Y = sy(y), r = M.TIRO[tipo].r;
    var arte = A.spr["t_" + tipo];
    var pedra = tipo === "pedra" || tipo === "pedrao";
    var desenhou = false;
    if (pedra && A.temAtlas) {
        // ai3: a pedra do atlas; a celula tem ~87% de pedra, entao 1.2 de
        // folga deixa o diametro visual igual ao corpo fisico
        var kp = (r * 2 * 1.2 * A.ESC) / 64;
        desenhou = E.spr.stamp("ai3", X, Y, { scale: kp, key: MAGENTA, ax: 0.5, ay: 0.5 });
    }
    if (desenhou) {
        // atlas ja desenhou a pedra
    } else if (arte) {
        S.drawSprite(arte.id, X, Y, a * DEG, 1, 1, KEY);
    } else if (tipo === "ovo") {
        // ovo-bomba da chocadeira: oval branco pintado + estopim aceso
        var er = r * A.ESC, eh = er * 1.25;
        S.fillTriangle(X, Y - eh * 1.05, X - er * 0.8, Y - eh * 0.2, X + er * 0.8, Y - eh * 0.2, C.preto);
        S.fillSmoothCircle(X, Y, er + 1, C.preto);
        S.fillSmoothCircle(X, Y, er, C.branco);
        S.fillTriangle(X, Y - eh, X - er * 0.72, Y - eh * 0.25, X + er * 0.72, Y - eh * 0.25, C.branco);
        S.fillCircle(Math.round(X - er * 0.3), Math.round(Y + er * 0.2), Math.max(1, Math.round(A.ESC * 0.8)), C.pedra);
        S.fillCircle(Math.round(X + er * 0.35), Math.round(Y - er * 0.25), Math.max(1, Math.round(A.ESC * 0.7)), C.pedra);
        var pe = ((t || 0) * 12) % 2 < 1;
        S.fillCircle(Math.round(X), Math.round(Y - eh * 1.15), Math.max(2, Math.round(A.ESC * (pe ? 2 : 1.3))), pe ? C.amarelo : S.color(255, 120, 30));
    } else if (tipo === "bomba") {
        var R = r * A.ESC;
        S.fillSmoothCircle(X, Y, R + Math.max(1, A.ESC * 0.8), C.preto);
        S.fillSmoothCircle(X, Y, R, C.bomba);
        S.fillCircle(Math.round(X - R * 0.35), Math.round(Y - R * 0.35), Math.max(1, Math.round(R * 0.28)), S.color(120, 126, 170));
        // estopim girando junto + faisca piscando
        var ca = Math.cos(a - 1.2), sa = Math.sin(a - 1.2);
        var fx = X + ca * R * 1.45, fy = Y + sa * R * 1.45;
        S.drawWideLine(X + ca * R * 0.8, Y + sa * R * 0.8, fx, fy, Math.max(2, A.ESC * 1.4), C.couroClaro);
        var pis = ((t || 0) * 12) % 2 < 1;
        S.fillCircle(Math.round(fx), Math.round(fy), Math.max(2, Math.round(A.ESC * (pis ? 2.2 : 1.4))), pis ? C.amarelo : S.color(255, 120, 30));
    } else {
        var sp = A.spr.pedra;
        var z = r / M.TIRO.pedra.r;
        if (sp) S.drawSprite(sp.id, X, Y, a * DEG, z, z, KEY);
        else {
            S.fillSmoothCircle(X, Y, r * A.ESC, C.pedra);
            S.drawCircle(Math.round(X), Math.round(Y), Math.round(r * A.ESC), C.pedraEsc);
        }
        if (tipo !== "pedra" && tipo !== "pedrao") {
            S.drawCircle(Math.round(X), Math.round(Y), Math.round(r * A.ESC + 1.5 * A.ESC), S.color(90, 200, 255));
        }
    }
    var m = r * A.ESC * 2 + 3;
    BOX.x = X - m; BOX.y = Y - m; BOX.w = m * 2; BOX.h = m * 2;
    return BOX;
};

// ------------------------------------------------------- estilingue -------
// elastico de couro: duas tiras grossas que AFINAM com o puxao. A de tras
// (garfo esquerdo) passa atras da pedra; a da frente por cima dela.
// sem pedra: as tiras ligam os garfos com uma barriga que vibra no solto.
A.elastico = function (fase, p, forca, vib) {
    var g = M.GARFO, E = A.ESC;
    var esp = Math.max(2, E * (3.4 - 1.8 * forca));
    var gi = fase === "tras" ? 0 : 1;
    var gx = sx(g[gi].x), gy = sy(g[gi].y);
    if (p) {
        // ponto de amarra: atras da pedra (lado oposto ao lancamento)
        var r = M.TIRO[p.tipo].r * 0.9;
        var dx = p.x - M.BERCO.x, dy = p.y - M.BERCO.y, d = Math.sqrt(dx * dx + dy * dy);
        var ux = d > 0.5 ? dx / d : -1, uy = d > 0.5 ? dy / d : 0;
        var ax = sx(p.x + ux * r), ay = sy(p.y + uy * r);
        if (fase === "tras") {
            // bolsa de couro abraca a pedra por tras
            S.drawWideLine(sx(p.x - uy * r), sy(p.y + ux * r), sx(p.x + uy * r), sy(p.y - ux * r),
                           Math.max(3, E * 3.2), C.couro);
        }
        S.drawWideLine(gx, gy, ax, ay, esp, fase === "tras" ? C.couro : C.couroClaro);
        var x0 = Math.min(gx, ax, sx(p.x - r * 1.5)), x1 = Math.max(gx, ax, sx(p.x + r * 1.5));
        var y0 = Math.min(gy, ay, sy(p.y - r * 1.5)), y1 = Math.max(gy, ay, sy(p.y + r * 1.5));
        BOX.x = x0 - esp - 2; BOX.y = y0 - esp - 2; BOX.w = x1 - x0 + esp * 2 + 4; BOX.h = y1 - y0 + esp * 2 + 4;
        return BOX;
    }
    if (fase !== "tras") return null;
    // solto: tiras dos dois garfos ate o meio, com barriga e vibracao
    var mx = (sx(g[0].x) + sx(g[1].x)) / 2 + (vib || 0) * E * 0.6;
    var my = sy(g[0].y + 3) + (vib || 0) * E;
    S.drawWideLine(sx(g[0].x), sy(g[0].y), mx, my, Math.max(2, E * 2.6), C.couro);
    S.drawWideLine(sx(g[1].x), sy(g[1].y), mx, my, Math.max(2, E * 2.6), C.couroClaro);
    S.fillCircle(Math.round(mx), Math.round(my), Math.max(2, Math.round(E * 2.2)), C.couro);
    BOX.x = sx(g[0].x) - 4 * E; BOX.y = sy(g[0].y) - 4 * E - Math.abs(vib || 0) * E;
    BOX.w = sx(g[1].x) - sx(g[0].x) + 8 * E; BOX.h = 14 * E + Math.abs(vib || 0) * 2 * E;
    return BOX;
};

// pontinho de mira/rastro (branco com borda)
A.ponto = function (x, y, r, cor) {
    var X = Math.round(sx(x)), Y = Math.round(sy(y)), R = Math.max(1, Math.round(r * A.ESC));
    S.fillCircle(X, Y, R + 1, C.sombra);
    S.fillCircle(X, Y, R, cor || C.branco);
    BOX.x = X - R - 2; BOX.y = Y - R - 2; BOX.w = R * 2 + 5; BOX.h = R * 2 + 5;
    return BOX;
};

// estrela de 5 pontas (HUD e placar)
A.estrela = function (cx, cy, r, cor, borda) {
    if (borda !== undefined) A.estrela(cx, cy, r + Math.max(2, r * 0.18), borda);
    var pts = [];
    for (var k = 0; k < 10; k++) {
        var rr = k % 2 ? r * 0.45 : r;
        var a = -Math.PI / 2 + k * Math.PI / 5;
        pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    for (var t = 0; t < 10; t += 2) {
        var p1 = (t + 1) % 10, p0 = (t + 9) % 10;
        S.fillTriangle(cx, cy, pts[p0 * 2], pts[p0 * 2 + 1], pts[t * 2], pts[t * 2 + 1], cor);
        S.fillTriangle(cx, cy, pts[t * 2], pts[t * 2 + 1], pts[p1 * 2], pts[p1 * 2 + 1], cor);
    }
};

A.C = C;
A.KEY = KEY;
A.DEG = DEG;

module.exports = A;
