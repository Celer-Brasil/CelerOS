// CamLab - bench da camera da matilha (API 36). Acha o 1o no com camera
// pronta, tira uma foto (Pack.snap -> /local/camlab.jpg, System.drawJPG) e
// mostra VIEW_MS de video ao vivo (Pack.view + Pack.drawFrame), medindo fps.
// Log em /local/camlab.txt.

var LOG = "/local/camlab.txt";
var VIEW_MS = 15000;
var t0 = System.millis();

function note(s) {
    FS.appendTextFile(LOG, Math.floor((System.millis() - t0) / 100) / 10 + "s " + s + "\n");
}
function msg(s) {
    System.fillRect(0, 290, 240, 30, 0);
    System.drawString(s, 4, 298);
}

FS.writeTextFile(LOG, "");
System.keepAwake(true);
System.fillScreen(0);
CelerNet.start({});
msg("procurando camera...");
var cam = null, tw = System.millis();
while (cam === null && System.millis() - tw < 120000) {
    var rs = Pack.resources("camera");
    for (var i = 0; i < rs.length; i++) if (rs[i].ready && !rs[i].busy) cam = rs[i];
    if (cam === null) System.delay(1000);
}
if (cam === null) {
    note("nenhuma camera pronta");
    msg("nenhuma camera pronta");
} else {
    note("camera de " + cam.nodeName + " (" + cam.node + ")");
    msg("foto de " + cam.nodeName + "...");
    var ts = System.millis();
    var h = Pack.snap(cam.node, { path: "/local/camlab.jpg", quality: 12 });
    var st = Pack.status(h);
    while (st && (st.state === "opening" || st.state === "open") && System.millis() - ts < 20000) {
        System.delay(100);
        st = Pack.status(h);
    }
    note("snap h" + h + " em " + (System.millis() - ts) + " ms: " + JSON.stringify(st));
    Pack.close(h);  // nao concluiu no prazo: libera a sessao (o video abre outra)
    if (st && st.state === "done") {
        System.drawJPG("/local/camlab.jpg", 0, 0);
        msg("foto ok (" + (System.millis() - ts) + " ms)");
        System.delay(3000);
    }

    msg("video ao vivo...");
    var v = Pack.view(cam.node, { fps: 5, quality: 15 });
    var tv = System.millis(), drawn = 0, first = 0;
    while (System.millis() - tv < VIEW_MS) {
        if (Pack.drawFrame(v, 0, 0)) {
            if (drawn === 0) first = System.millis() - tv;
            drawn++;
        }
        System.delay(20);
    }
    var sv = Pack.status(v);
    note("view h" + v + ": " + drawn + " quadros desenhados em " + VIEW_MS + " ms (1o aos " + first +
         " ms) status " + JSON.stringify(sv));
    Pack.close(v);
    msg(drawn + " quadros (" + Math.round(drawn * 10000 / VIEW_MS) / 10 + " fps)");
}
note("fim");
System.delay(3000);
