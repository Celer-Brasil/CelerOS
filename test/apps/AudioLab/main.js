// AudioLab - bench do audio da matilha (API 36). Acha o 1o vizinho com mic
// pronto, ouve ele ao vivo no alto-falante daqui (Pack.listen) por LISTEN_MS,
// grava REC_MS do mic dele (Pack.record), salva o WAV e toca aqui.
// Log em /local/audiolab.txt.

var LOG = "/local/audiolab.txt";
var LISTEN_MS = 12000, REC_MS = 4000;
var t0 = System.millis();

function note(s) {
    FS.appendTextFile(LOG, Math.floor((System.millis() - t0) / 100) / 10 + "s " + s + "\n");
}
function show(s) {
    System.fillScreen(0);
    System.drawString(s, 10, 120);
}
function waitOpen(h, ms) {
    var until = System.millis() + ms;
    var st = Pack.status(h);
    while (st && st.state === "opening" && System.millis() < until) {
        System.delay(100);
        st = Pack.status(h);
    }
    return st;
}

FS.writeTextFile(LOG, "");
System.keepAwake(true);
CelerNet.start({});
show("procurando um mic na matilha...");
var mic = null, tw = System.millis();
while (mic === null && System.millis() - tw < 40000) {
    var rs = Pack.resources("mic");
    for (var i = 0; i < rs.length; i++) if (rs[i].ready && !rs[i].busy) mic = rs[i];
    if (mic === null) System.delay(1000);
}
if (mic === null) {
    note("nenhum mic pronto na matilha");
    show("nenhum mic pronto");
} else {
    note("mic de " + mic.nodeName + " (" + mic.node + ")");
    show("ouvindo " + mic.nodeName + "...");
    var h = Pack.listen(mic.node);
    var st = waitOpen(h, 14000);
    note("listen h" + h + ": " + JSON.stringify(st));
    if (st && st.state === "open") {
        System.delay(LISTEN_MS);
        note("listen depois: " + JSON.stringify(Pack.status(h)));
    }
    Pack.close(h);
    System.delay(500);

    show("gravando " + mic.nodeName + "...");
    var r = Pack.record(mic.node, { ms: REC_MS });
    st = waitOpen(r, 14000);
    note("record h" + r + ": " + JSON.stringify(st));
    var lv = 0;
    while (Pack.recording(r)) {
        var l = Pack.level();
        if (l > lv) lv = l;
        System.delay(100);
    }
    var ok = Pack.recordStop(r, { path: "/local/remoto.wav" });
    note("gravou em /local/remoto.wav: " + ok + " (nivel max " + lv + ")");
    if (ok) {
        show("tocando a gravacao...");
        note("playWav " + System.playWav("/local/remoto.wav"));
    }
}
note("fim");
show("fim - veja /local/audiolab.txt");
System.delay(3000);
