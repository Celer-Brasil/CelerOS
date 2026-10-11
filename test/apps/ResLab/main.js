// ResLab - bench dos recursos da matilha (API 36). Roda igual em todo no:
// expoe o canal "eco" e publica nele a cada 250 ms um bloco de 600 B com
// numero de sequencia (so cabe no ESP-NOW: sessoes pela malha nao recebem);
// abre o "eco" de cada vizinho e mede entrega (gaps de sequencia) e vazao.
// Resultado em /local/reslab.txt (headless: sem tela no dog/cam).

var LOG = "/local/reslab.txt";
var PUB_MS = 250, BLOCK = 600;
// /local/reslab_cfg.txt "pub=<ms> block=<bytes>" (estresse do plano de dados;
// pub=0 = so recebe)
var cfg = FS.readTextFile("/local/reslab_cfg.txt") || "";
var mPub = /pub=(\d+)/.exec(cfg), mBlk = /block=(\d+)/.exec(cfg);
if (mPub) PUB_MS = parseInt(mPub[1], 10);
if (mBlk) BLOCK = parseInt(mBlk[1], 10);
var t0 = System.millis();
var me = null;
var hs = {};        // node id -> handle
var st = {};        // node id -> {n, bytes, first, last, gaps}
var lastPub = 0, lastScan = 0, lastLog = 0, seq = 0;
var pad = new Array(BLOCK + 1).join("x");

function note(s) {
    FS.appendTextFile(LOG, Math.floor((System.millis() - t0) / 1000) + "s " + s + "\n");
}

FS.writeTextFile(LOG, "");
// bancada sem toque: sem isto o 4848 entra em deep sleep e some da malha
System.keepAwake(true);
CelerNet.start({});
me = Pack.me();
note("ResLab no ar: " + me.name + " (" + me.id + ") pub " + PUB_MS + " ms x " + BLOCK + " B, expose eco=" + Pack.expose("eco"));

function loop() {
    var now = System.millis();
    if (PUB_MS > 0 && now - lastPub >= PUB_MS) {
        lastPub += PUB_MS;
        if (now - lastPub > 4 * PUB_MS) lastPub = now;  // atrasou demais: nao recupera em rajada
        seq++;
        var head = me.name + "|" + seq + "|";
        Pack.publish("eco", head + pad.substr(0, BLOCK - head.length));
    }
    if (now - lastScan >= 3000) {
        lastScan = now;
        var rs = Pack.resources();
        for (var i = 0; i < rs.length; i++) {
            var r = rs[i];
            if (r.name !== "eco") continue;
            var s0 = hs[r.node] !== undefined ? Pack.status(hs[r.node]) : null;
            if (s0 === null || s0.state === "lost" || s0.state === "revoked" || s0.state === "refused") {
                if (s0 !== null) note("eco de " + r.nodeName + ": " + s0.state + "/" + s0.reason + ", reabrindo");
                hs[r.node] = Pack.open(r.node, "eco");
                st[r.node] = st[r.node] || { n: 0, bytes: 0, first: 0, last: 0, gaps: 0 };
                note("abrindo eco de " + r.nodeName + " -> h" + hs[r.node]);
            }
        }
    }
    for (var n in hs) {
        var d;
        while ((d = Pack.read(hs[n])) !== null) {
            var k = st[n];
            var sq = parseInt(d.split("|")[1], 10);
            if (k.n === 0) note("1o eco de " + n + " (" + d.length + " B, via " + Pack.status(hs[n]).via + ")");
            else if (sq > k.last + 1) k.gaps += sq - k.last - 1;
            if (k.n === 0) k.first = sq;
            k.last = sq;
            k.n++;
            k.bytes += d.length;
        }
    }
    var w;
    while ((w = Pack.pollWrite()) !== null) note("escrita em " + w.res + " de " + w.fromName + ": " + w.data);
    if (now - lastLog >= 10000) {
        lastLog = now;
        var parts = [];
        for (var q in hs) {
            var s2 = Pack.status(hs[q]), z = st[q];
            var span = z.last - z.first + 1;
            parts.push(q + "=" + (s2 ? s2.state + "/" + s2.via : "?") + " rx " + z.n + " perdidos " + z.gaps +
                       (span > 0 ? " (" + Math.round(100 * z.n / span) + "%)" : "") +
                       " " + Math.round(z.bytes / 1024) + " KB");
        }
        note("resumo: sessoes no meu eco=" + Pack.sessions("eco") + " | " + parts.join(" "));
    }
    System.delay(PUB_MS > 0 && PUB_MS < 20 ? 1 : 10);
}

// bancada: motivo da saida no log (exit remoto, erro do app, idle-home...)
try {
    while (true) loop();
} catch (e) {
    note("saiu: " + e + (e && e.stack ? " " + e.stack : ""));
    throw e;
}
