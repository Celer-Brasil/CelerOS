// Bilheteria - gateway da malha (roda no no com internet, ex. SmartDisplay).
//
// NAO e app de fabrica: e o lado "gateway" da demo do modulo de camera na
// CelerNet. Drena o Pack.poll() a cada quadro (padrao Matilha/Sentinela),
// valida o ticket POR REGRA LOCAL e responde {t:'ok'} ao no-sensor. A
// validacao de verdade (API HTTP) entra no validate(): Net.post ja existe,
// e o slot de URL fica num Storage setting para nao recompilar app.
//
// Regra local da demo: ticket valido = "CEL-" + 6 hex, ainda nao usado
// (anti-reuso no Storage do gateway - trocar a bateria do no-sensor nao
// reemite). Historico na tela: codigo, veredito e placar.

var FONT_TITLE = 4;

var last = { code: "-", info: "aguardando o no-sensor...", valid: false };
var score = { ok: 0, no: 0 };

function validate(code) {
    if (!/^CEL-[0-9A-F]{6}$/.test(code)) {
        return { valid: false, info: "formato invalido" };
    }
    var key = "used_" + code;
    if (Storage.get(key, "") === "1") {
        return { valid: false, info: "ticket reutilizado" };
    }
    Storage.set(key, "1");
    return { valid: true, info: "ticket valido" };
}

function onEnvelope(env) {
    var d = env.data;
    if (typeof d === "string") {
        try { d = JSON.parse(d); } catch (e) { d = null; }
    }
    if (d === null || d.t !== "qr") return;
    var v = validate(d.code);
    Pack.send(env.from, { t: "ok", valid: v.valid, info: v.info });
    if (v.valid) score.ok += 1; else score.no += 1;
    last = { code: d.code, info: v.info, valid: v.valid };
    System.beep(v.valid ? 1400 : 350, 90);
    System.notify("bilheteria", d.code + ": " + (v.valid ? "VALIDO" : "INVALIDO"));
}

function draw() {
    UI.begin();
    UI.header("Bilheteria", { sub: "gateway da malha" });
    var col = last.valid ? 0x07E0 : (last.code === "-" ? 0x7BEF : 0xF800);
    UI.card(12, 70, 216, 60, {});
    UI.text(last.code, 120, 92, { align: "center", role: "title", color: col });
    UI.text(last.info, 120, 114, { align: "center", role: "body" });
    UI.text("validos: " + score.ok + "   invalidos: " + score.no,
            120, 160, { align: "center", role: "body" });
    var ms = Pack.members();
    var names = [];
    for (var i = 0; i < ms.length; i++) names.push(ms[i].name);
    UI.text("matilha: " + (names.length ? names.join(", ") : "ninguem ouvido"),
            120, 200, { align: "center", role: "caption" });
    if (UI.button("zerar placar", 60, 250, 120, 36, {})) {
        score.ok = 0;
        score.no = 0;
    }
    UI.end(10);
}

if (typeof Pack === "undefined" || typeof CelerNet === "undefined") {
    // build sem Bluetooth: nada a gatewayar - avisa e sai (sem loop vazio)
    System.notify("bilheteria", "build sem Bluetooth: a malha nao existe aqui");
} else {
CelerNet.start();  // malha persistente; caps.hub acende com o WiFi conectado
while (true) {
    var env = Pack.poll();
    while (env !== null) {
        onEnvelope(env);
        env = Pack.poll();
    }
    draw();
    System.delay(100);
}
}
