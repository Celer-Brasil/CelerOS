// Mural — recados que se espalham sozinhos pela malha CelerNet (API 27).
// Escreva um recado e ele chega a todo aparelho com o Mural aberto — inclusive
// os que estavam DESLIGADOS ou longe na hora: cada mural guarda os recados
// (Storage) e conversa com os vizinhos de tempos em tempos, comparando um
// resumo. Resumo diferente = alguem esta desatualizado = os dois empurram o
// que tem. E o algoritmo Trickle (RFC 6206, o mesmo das redes de sensores):
// em silencio quando todos concordam, rapido quando alguem chega atrasado.
//
// Migrado para o CelerKit: o casco do loop e o tema vieram do celeros.app
// (A.run/A.T/A.header), o protocolo de malha do celeros.app.mesh (A.mesh,
// familia "m", each parsing op/resto) e o cache de linhas do celeros.app.list.
// O protocolo no ar NAO mudou (compativel com Mural 1.0..1.2.1 e com o
// service.js do proprio pacote, que vendoriza celeros.mesh — servicos nao
// carregam a tabela de deps do hub):
//   m+<id>|<autor>|<texto>   recado (novo: ttl 4; refofocado: ttl 1)
//   m#<qtd>.<hash>           resumo do mural (ttl 1, so vizinhos diretos)

var A = require("celeros.app");
require("celeros.app.mesh");
require("celeros.app.list");

A.init();
A.mesh.family("m");

var MAX_POSTS = 24, MAX_TXT = 48, MAX_ID = 24, MAX_BY = 16;
var IMIN = 4000, IMAX = 32000;

var posts = [];            // [{id, by, txt, at}] mais novo primeiro
var known = {};            // id -> true
var postsRev = 0;          // muda quando o mural muda (carimbo dos caches)
var me = null;
var mySeq = parseInt(Storage.get("seq", "0"), 10) || 0;
var frameNow = 0;          // relogio do quadro corrente (os handlers usam)

function load() {
    try {
        var a = JSON.parse(Storage.get("posts", "[]"));
        for (var i = 0; i < a.length; i++) {
            posts.push({ id: a[i][0], by: a[i][1], txt: a[i][2], at: -1 });
            known[a[i][0]] = true;
        }
    } catch (e) { posts = []; known = {}; }
}
function save() {
    var a = [];
    for (var i = 0; i < posts.length; i++) a.push([posts[i].id, posts[i].by, posts[i].txt]);
    Storage.set("posts", JSON.stringify(a));
}
function addPost(id, by, txt, now) {
    if (known[id]) return false;
    known[id] = true;
    posts.unshift({ id: id, by: by, txt: txt, at: now });
    // o que sai pelo fundo fica em known: a fofoca dos vizinhos nao o ressuscita
    while (posts.length > MAX_POSTS) posts.pop();
    postsRev++;
    save();
    UI.invalidate();
    return true;
}

// resumo: quantidade + hash dos ids (ordem nao importa). Cacheado por
// postsRev: ele era recalculado (e alocado) a cada quadro para a linha de
// sincronia e de novo a cada resumo m# recebido.
var digestCache = null;
function digest() {
    if (digestCache && digestCache.rev === postsRev) return digestCache.d;
    var ids = [];
    for (var i = 0; i < posts.length; i++) ids.push(posts[i].id);
    ids.sort();
    var h = 5381;
    var s = ids.join(",");
    for (var k = 0; k < s.length; k++) h = ((h * 33) ^ s.charCodeAt(k)) & 0xFFFF;
    var d = posts.length + "." + h.toString(16);
    digestCache = { rev: postsRev, d: d };
    return d;
}

// ---- Trickle -------------------------------------------------------------
var I = IMIN, iStart = 0, tFire = 0, fired = false, consistent = 0;
var neigh = {};            // vizinho -> {d: resumo, at, name}
var pushQ = [];            // ids a refofocar
var pushAt = 0;
var lastSent = {};         // id -> quando EU refofoquei (supressão)
var lastHeard = {};        // id -> quando OUVI alguém refofocar (supressão)
var confirmAt = 0;         // resumo de confirmação agendado (0 = nenhum)
function newInterval(now, len) {
    I = len;
    iStart = now;
    tFire = now + I / 2 + Math.floor(Math.random() * (I / 2));
    fired = false;
    consistent = 0;
}
function inconsistent(now) {
    if (I > IMIN) newInterval(now, IMIN);
    // empurra o que temos, do mais novo ao mais velho (o outro lado faz igual)
    pushQ = [];
    for (var i = 0; i < posts.length && pushQ.length < 6; i++) {
        var id = posts[i].id;
        if (now - (lastSent[id] || -99999) > 20000 && now - (lastHeard[id] || -99999) > 8000) pushQ.push(id);
    }
}
function trickle(now) {
    if (!fired && now >= tFire) {
        fired = true;
        if (consistent < 1) A.mesh.send(null, "#", digest(), { ttl: 1 });
    }
    if (confirmAt && now >= confirmAt) {
        confirmAt = 0;
        A.mesh.send(null, "#", digest(), { ttl: 1 });
    }
    if (now - iStart >= I) newInterval(now, Math.min(IMAX, I * 2));
    if (pushQ.length && now >= pushAt) {
        var id = pushQ.shift();
        for (var i = 0; i < posts.length; i++) {
            if (posts[i].id !== id) continue;
            if (now - (lastHeard[id] || -99999) > 8000 &&
                A.mesh.send(null, "+", id + "|" + posts[i].by + "|" + posts[i].txt, { ttl: 1 })) lastSent[id] = now;
        }
        pushAt = now + 1500;
    }
}

// handler do A.mesh.each: (de, op, resto, quadro). op "" = familia alheia.
function onMesh(from, op, rest, m) {
    if (op === "+") {
        var p1 = rest.indexOf("|"), p2 = rest.indexOf("|", p1 + 1);
        if (p1 < 1 || p2 < 0) return;
        // id/autor vem da rede: corta no teto (o Storage do mural e finito)
        var id = rest.substring(0, p1).substring(0, MAX_ID);
        lastHeard[id] = frameNow;
        if (addPost(id, rest.substring(p1 + 1, p2).substring(0, MAX_BY),
                    rest.substring(p2 + 1).substring(0, MAX_TXT), frameNow)) {
            System.beep(1500, 30);
            inconsistent(frameNow);     // novidade: acelera o Trickle (outros podem não ter)
        }
    } else if (op === "#") {
        var prev = neigh[from];
        neigh[from] = { d: rest, at: frameNow, name: m.fromName || from };
        if (rest === digest()) {
            consistent++;
            // o vizinho acabou de alcancar o nosso resumo: confirma uma vez
            // (a supressao do Trickle o deixaria sem saber que esta em dia)
            if (!prev || prev.d !== rest) confirmAt = frameNow + 300 + Math.floor(Math.random() * 1200);
        } else {
            inconsistent(frameNow);
        }
    }
}

function write() {
    var txt = System.prompt("Recado para o mural", "");
    if (!txt) return;
    txt = ("" + txt).substring(0, MAX_TXT).split("|").join("/");
    mySeq++;
    Storage.set("seq", "" + mySeq);
    var id = me.id + mySeq.toString(36);
    var now = System.millis();
    addPost(id, me.name, txt, now);
    if (!A.mesh.send(null, "+", id + "|" + me.name + "|" + txt, { ttl: 4 })) {
        UI.toast("Fila cheia: o recado sai na próxima conversa");
    }
    lastSent[id] = now;
    inconsistent(now);
}

function ago(at, now) {
    if (at < 0) return "guardado";
    var s = Math.floor((now - at) / 1000);
    return s < 60 ? "agora" : "há " + Math.floor(s / 60) + " min";
}

// linhas do mural: rebuild so quando o mural muda ou o minuto vira (o "ha N
// min" das linhas envelhece)
var postList = A.list.make(function () {
    return postsRev + ":" + Math.floor(A.now() / 60000);
}, function () {
    var now = A.now();
    var items = [];
    for (var i = 0; i < posts.length; i++) {
        items.push({ label: posts[i].txt, sub: posts[i].by + " · " + ago(posts[i].at, now) });
    }
    if (!items.length) items.push({ label: "Mural vazio: escreva o primeiro recado", enabled: false });
    return items;
});

load();
newInterval(System.millis(), IMIN);

// ---- app -----------------------------------------------------------------
A.run({
    main: function (c) {
        if (A.header("Mural")) return A.BACK;
        if (!A.mesh.gate("Ligue a malha (app Matilha) para trocar recados com os aparelhos ao redor.")) return;

        me = A.mesh.me();
        var now = c.now;
        frameNow = now;
        A.mesh.each(onMesh);
        trickle(now);

        // quantos vizinhos (ouvidos nos ultimos 70 s) concordam com o nosso resumo
        var d = digest(), agree = 0, nn = 0;
        for (var k in neigh) {
            if (!neigh.hasOwnProperty(k) || now - neigh[k].at > 70000) continue;
            nn++;
            if (neigh[k].d === d) agree++;
        }
        UI.text(posts.length + " recados · " + (nn ? (agree === nn ? "em dia com " + nn + " vizinho" + (nn > 1 ? "s" : "")
                                                              : "sincronizando " + (nn - agree) + " de " + nn)
                                               : "sem vizinhos ainda"),
                10, 50, { role: "caption", color: agree === nn && nn ? A.T.ok : A.T.textDim, w: 220, id: "sync" });
        UI.list("posts", 10, 68, 220, 196, postList.rows(), { rowH: 48 });
        if (UI.button("Escrever recado", 10, 274, 220, 36)) write();
    }
}, "main");
