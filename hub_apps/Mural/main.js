// Mural — recados que se espalham sozinhos pela malha CelerNet (API 27).
// Escreva um recado e ele chega a todo aparelho com o Mural aberto — inclusive
// os que estavam DESLIGADOS ou longe na hora: cada mural guarda os recados
// (Storage) e conversa com os vizinhos de tempos em tempos, comparando um
// resumo. Resumo diferente = alguém está desatualizado = os dois empurram o
// que têm. É o algoritmo Trickle (RFC 6206, o mesmo das redes de sensores):
// em silêncio quando todos concordam, rápido quando alguém chega atrasado.
//
// Protocolo (prefixo "m"):
//   m+<id>|<autor>|<texto>   recado (novo: ttl 4; refofocado: ttl 1)
//   m#<qtd>.<hash>           resumo do mural (ttl 1, só vizinhos diretos)

var mesh = require("celeros.mesh");
var T = System.theme();
var MAX_POSTS = 24, MAX_TXT = 48, MAX_ID = 24, MAX_BY = 16;
var IMIN = 4000, IMAX = 32000;

var posts = [];            // [{id, by, txt, at}] mais novo primeiro
var known = {};            // id -> true
var me = null;
var mySeq = parseInt(Storage.get("seq", "0"), 10) || 0;

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
    // o que sai pelo fundo fica em known: a fofoca dos vizinhos não o ressuscita
    while (posts.length > MAX_POSTS) posts.pop();
    save();
    UI.invalidate();
    return true;
}

// resumo: quantidade + hash dos ids (ordem não importa)
function digest() {
    var ids = [];
    for (var i = 0; i < posts.length; i++) ids.push(posts[i].id);
    ids.sort();
    var h = 5381;
    var s = ids.join(",");
    for (var k = 0; k < s.length; k++) h = ((h * 33) ^ s.charCodeAt(k)) & 0xFFFF;
    return posts.length + "." + h.toString(16);
}

// ---- Trickle -------------------------------------------------------------
var I = IMIN, iStart = 0, tFire = 0, fired = false, consistent = 0;
var neigh = {};            // vizinho -> {d: resumo, at}
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
        if (consistent < 1) CelerNet.broadcast("m#" + digest(), 1);
    }
    if (confirmAt && now >= confirmAt) {
        confirmAt = 0;
        CelerNet.broadcast("m#" + digest(), 1);
    }
    if (now - iStart >= I) newInterval(now, Math.min(IMAX, I * 2));
    if (pushQ.length && now >= pushAt) {
        var id = pushQ.shift();
        for (var i = 0; i < posts.length; i++) {
            if (posts[i].id !== id) continue;
            if (now - (lastHeard[id] || -99999) > 8000 &&
                CelerNet.broadcast("m+" + id + "|" + posts[i].by + "|" + posts[i].txt, 1)) lastSent[id] = now;
        }
        pushAt = now + 1500;
    }
}

function onMsg(m, now) {
    var s = "" + m.msg;
    if (s.length < 3 || s.charAt(0) !== "m") return;
    var op = s.charAt(1), a = s.substring(2);
    if (op === "+") {
        var p1 = a.indexOf("|"), p2 = a.indexOf("|", p1 + 1);
        if (p1 < 1 || p2 < 0) return;
        // id/autor vem da rede: corta no teto (o Storage do mural e finito)
        var id = a.substring(0, p1).substring(0, MAX_ID);
        lastHeard[id] = now;
        if (addPost(id, a.substring(p1 + 1, p2).substring(0, MAX_BY),
                    a.substring(p2 + 1).substring(0, MAX_TXT), now)) {
            System.beep(1500, 30);
            inconsistent(now);     // novidade: acelera o Trickle (outros podem não ter)
        }
    } else if (op === "#") {
        var prev = neigh[m.from];
        neigh[m.from] = { d: a, at: now, name: m.fromName || m.from };
        if (a === digest()) {
            consistent++;
            // o vizinho acabou de alcançar o nosso resumo: confirma uma vez
            // (a supressão do Trickle o deixaria sem saber que está em dia)
            if (!prev || prev.d !== a) confirmAt = now + 300 + Math.floor(Math.random() * 1200);
        } else {
            inconsistent(now);
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
    if (!CelerNet.broadcast("m+" + id + "|" + me.name + "|" + txt, 4)) {
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

load();
newInterval(System.millis(), IMIN);

while (true) {
    var full = UI.begin();
    if (UI.header("Mural", { back: true })) System.exitApp();
    if (!mesh.gate("Ligue a malha (app Matilha) para trocar recados com os aparelhos ao redor.")) {
        UI.end();
        continue;
    }
    me = mesh.me();
    var now = System.millis();
    mesh.each(onMsg, now);
    trickle(now);

    // quantos vizinhos (ouvidos nos últimos 70 s) concordam com o nosso resumo
    var d = digest(), agree = 0, nn = 0;
    for (var k in neigh) {
        if (!neigh.hasOwnProperty(k) || now - neigh[k].at > 70000) continue;
        nn++;
        if (neigh[k].d === d) agree++;
    }
    UI.text(posts.length + " recados · " + (nn ? (agree === nn ? "em dia com " + nn + " vizinho" + (nn > 1 ? "s" : "")
                                                              : "sincronizando " + (nn - agree) + " de " + nn)
                                               : "sem vizinhos ainda"),
            10, 50, { role: "caption", color: agree === nn && nn ? T.ok : T.textDim, w: 220, id: "sync" });
    var items = [];
    for (var i = 0; i < posts.length; i++) {
        items.push({ label: posts[i].txt, sub: posts[i].by + " · " + ago(posts[i].at, now) });
    }
    if (!items.length) items.push({ label: "Mural vazio: escreva o primeiro recado", enabled: false });
    UI.list("posts", 10, 68, 220, 196, items, { rowH: 48 });
    if (UI.button("Escrever recado", 10, 274, 220, 36)) write();
    UI.end();
}
