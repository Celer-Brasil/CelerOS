// PcLab - bench do no virtual (API 41). O gateway com o cabo anuncia o PC
// como pc-XXXX; aqui: quem e membro, um envelope ao PC a cada 3 s
// ("ping N") e o que o PC manda (Pack.poll). Alvo em /local/pclab_cfg.txt.
// Log em /local/pclab.txt.

var LOG = "/local/pclab.txt";
var t0 = System.millis();
var alvo = "pc";
try {
    var c = FS.readTextFile("/local/pclab_cfg.txt");
    if (c && c.replace(/\s+/g, "").length > 0) alvo = c.replace(/\s+/g, "");
} catch (e) {}

function note(s) {
    FS.appendTextFile(LOG, Math.floor((System.millis() - t0) / 100) / 10 + "s " + s + "\n");
}

if (typeof Pack === "undefined") {
    note("sem Pack (placa sem Bluetooth)");
    System.exitApp();
}
note("inicio alvo=" + alvo + " eu=" + Pack.me().name + " net=" + Pack.me().net);
var n = 0;
var lastSend = 0;
var lastMembers = 0;
while (true) {
    var now = System.millis();
    if (now - lastMembers > 5000) {
        lastMembers = now;
        var ms = Pack.members();
        var s = [];
        for (var i = 0; i < ms.length; i++) s.push(ms[i].name + "/" + ms[i].id + (ms[i].caps.hub ? "/hub" : ""));
        note("membros " + s.join(","));
    }
    if (now - lastSend > 3000) {
        lastSend = now;
        n++;
        note("send ping " + n + " -> " + Pack.send(alvo, "ping " + n));
    }
    var m;
    while ((m = Pack.poll()) !== null) note("poll " + m.data + " de " + m.fromName + "/" + m.from);
    System.fillScreen(0);
    System.drawString("PcLab " + alvo + " #" + n, 10, 120);
    System.delay(100);
}
