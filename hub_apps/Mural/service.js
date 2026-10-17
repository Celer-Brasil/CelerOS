/* Mural em segundo plano (API 42): o Trickle continua com o app FECHADO —
 * recado novo chega sozinho e vira notificação (1 por recado, no máximo 1
 * a cada 30 s). Enquanto QUALQUER app está em primeiro plano o serviço
 * dorme: quem drena a malha é o app da vez (dois consumidores na mesma
 * fila se roubam recados). Ao acordar, o estado recarrega do Storage —
 * o Mural aberto pode ter mudado o mural. Requer firmware API 42. */
var mesh = require("celeros.mesh");
var MAX_POSTS = 24, MAX_TXT = 48, MAX_ID = 24, MAX_BY = 16;
var IMIN = 4000, IMAX = 32000;

var posts = [];            // [{id, by, txt}] mais novo primeiro
var known = {};            // id -> true
var wasOpen = true;        // 1o giro recarrega do Storage
var notifyAt = -999999;

function load() {
    try {
        var a = JSON.parse(Storage.get("posts", "[]"));
        for (var i = 0; i < a.length; i++) {
            posts.push({ id: a[i][0], by: a[i][1], txt: a[i][2] });
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
    posts.unshift({ id: id, by: by, txt: txt });
    while (posts.length > MAX_POSTS) posts.pop();
    save();
    if (now - notifyAt > 30000) {
        notifyAt = now;
        System.notify("Mural", by + ": " + txt);
    }
    return true;
}

// resumo: quantidade + hash dos ids (ordem não importa) — igual ao app
function digest() {
    var ids = [];
    for (var i = 0; i < posts.length; i++) ids.push(posts[i].id);
    ids.sort();
    var h = 5381;
    var s = ids.join(",");
    for (var k = 0; k < s.length; k++) h = ((h * 33) ^ s.charCodeAt(k)) & 0xFFFF;
    return posts.length + "." + h.toString(16);
}

// ---- Trickle (mesmo algoritmo do app) ------------------------------------
var I = IMIN, iStart = 0, tFire = 0, fired = false, consistent = 0;
var neigh = {};
var pushQ = [];
var pushAt = 0;
var lastSent = {};
var lastHeard = {};
var confirmAt = 0;
function newInterval(now, len) {
    I = len;
    iStart = now;
    tFire = now + I / 2 + Math.floor(Math.random() * (I / 2));
    fired = false;
    consistent = 0;
}
function inconsistent(now) {
    if (I > IMIN) newInterval(now, IMIN);
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
        // id/autor vem da rede: corta no teto para um vizinho com texto
        // gigante nao encher o Storage do mural (24 posts * valor)
        var id = a.substring(0, p1).substring(0, MAX_ID);
        lastHeard[id] = now;
        if (addPost(id, a.substring(p1 + 1, p2).substring(0, MAX_BY),
                    a.substring(p2 + 1).substring(0, MAX_TXT), now)) {
            inconsistent(now);     // novidade: acelera o Trickle
        }
    } else if (op === "#") {
        var prev = neigh[m.from];
        neigh[m.from] = { d: a, at: now };
        if (a === digest()) {
            consistent++;
            if (!prev || prev.d !== a) confirmAt = now + 300 + Math.floor(Math.random() * 1200);
        } else {
            inconsistent(now);
        }
    }
}

// feature-detect: um firmware com servico mas sem o gate nao derruba o tick
function appOpen() {
    return typeof System.appOpen === "function" && System.appOpen() === true;
}

function tick() {
    var now = System.millis();
    if (appOpen()) { wasOpen = true; return; }  // o app da vez drena
    if (wasOpen) {
        wasOpen = false;
        posts = []; known = {};
        load();                                  // o app pode ter mudado o mural
        newInterval(now, IMIN);
    }
    if (!mesh.available() || !CelerNet.status().active) return;
    mesh.each(onMsg, now);
    trickle(now);
}
setInterval(tick, 500);
