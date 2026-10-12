// NetLab - bench da CelerNet v3. Mostra a rede (aberta/privada) e os
// contadores de seguranca, lista os recursos dos vizinhos e tenta abrir o
// mic (Pack.listen) e a camera (Pack.snap) do 1o vizinho que os tem: na
// "celer" aberta o provedor recusa ("denied"), na matilha privada abre.
// Log em /local/netlab.txt.

var LOG = "/local/netlab.txt";
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
function first(type) {
    var tw = System.millis();
    while (System.millis() - tw < 20000) {
        var rs = Pack.resources(type);
        if (rs.length > 0) return rs[0];
        System.delay(1000);
    }
    return null;
}

FS.writeTextFile(LOG, "");
System.keepAwake(true);
CelerNet.start({});
show("NetLab: aguardando vizinhos...");
System.delay(4000);
var s = CelerNet.status();
note("rede " + s.net + " secure=" + s.secure + " nos=" + s.heard + " semChave=" + s.rxAuthFail +
     " repetidos=" + s.rxReplay);

var mic = first("mic");
if (mic === null) {
    note("nenhum mic na matilha");
} else {
    note("mic de " + mic.nodeName + ": " + JSON.stringify(mic));
    var h = Pack.listen(mic.node);
    var st = waitOpen(h, 12000);
    note("listen: " + JSON.stringify(st));
    Pack.close(h);
}
var cam = first("camera");
if (cam === null) {
    note("nenhuma camera na matilha");
} else {
    note("camera de " + cam.nodeName + ": " + JSON.stringify(cam));
    var c = Pack.snap(cam.node, { path: "/local/netlab.jpg" });
    var cs = waitOpen(c, 12000);
    note("snap: " + JSON.stringify(cs));
    // aberta: a foto vem em seguida (bulk confiavel, ~3 s em VGA)
    var until = System.millis() + 15000;
    while (cs && cs.state === "open" && System.millis() < until) {
        System.delay(200);
        cs = Pack.status(c);
    }
    note("foto: " + JSON.stringify(cs));
    Pack.close(c);
}
s = CelerNet.status();
note("fim: semChave=" + s.rxAuthFail + " repetidos=" + s.rxReplay);
show("NetLab: fim (ver " + LOG + ")");
