// QrNode - no-sensor de QR da CelerNet (esp32-cam, headless).
//
// NAO e app de fabrica: e o lado "sensor" da demo do modulo de camera na
// malha (API 35). Roda sem vidro: a interface e o LED de flash (GPIO4)
// acendendo durante a leitura e piscando o veredito, e o log em
// /sd/qrlog.txt.
//
// Padrao sensor->gateway: le o QR on-device (quirc), acha o gateway pelo
// CAPS_HUB do Pack.members() (bit dinamico: no com WiFi conectado), manda
// {t:'qr'} urgente e espera {t:'ok'} - a malha nao tem ACK, o retry (2x com
// espera de 4 s) cobre a perda.
//
// Deploy: celerctl dev --sd (pasta no cartao) + `grant QrNode` (consentimento
// da perm "camera" e headless - o shell grants o que o app.json declara).

var WAIT_MS = 4000;
var RETRY = 2;

function note(s) {
    System.notify("qrnode", s);
    FS.appendTextFile("/sd/qrlog.txt", System.getTime() + " " + s + "\n");
}

// gateway = primeiro membro ouvido com caps.hub (tem internet agora)
function gateway() {
    var ms = Pack.members();
    for (var i = 0; i < ms.length; i++) {
        if (ms[i].caps && ms[i].caps.hub) return ms[i];
    }
    return null;
}

function blink(times) {
    for (var i = 0; i < times; i++) {
        Camera.led(true);
        System.delay(90);
        Camera.led(false);
        System.delay(140);
    }
}

function deliver(code) {
    var gw = gateway();
    if (gw === null) {
        note("sem gateway na malha (nenhum no com caps.hub)");
        return null;
    }
    for (var attempt = 0; attempt <= RETRY; attempt++) {
        Pack.send(gw.id, { t: "qr", code: code }, { urgent: true });
        var t0 = System.millis();
        while (System.millis() - t0 < WAIT_MS) {
            var r = Pack.poll();
            while (r !== null) {
                if (r.from === gw.id && r.data && r.data.t === "ok") return r.data;
                r = Pack.poll();
            }
            System.delay(100);  // ponto de cedida: "exit" do shell vence aqui
        }
        note("sem resposta do gateway (tentativa " + (attempt + 1) + ")");
    }
    return null;
}

if (typeof Camera === "undefined") {
    // firmware sem CELEROS_JS_CAMERA, perm "camera" negada ou placa sem sensor
    note("QrNode: objeto Camera ausente - conferir firmware/permissoes");
} else if (typeof Pack === "undefined" || typeof CelerNet === "undefined") {
    note("QrNode: build sem Bluetooth (malha) - este no nao tem pra quem entregar");
} else {
    CelerNet.start();  // malha persistente (settings celernet); idempotente
    note("QrNode no ar (id " + Pack.me().id + ")");
    while (true) {
        var code = Camera.scanQR({ timeoutMs: 4000, led: true });
        if (code !== null) {
            note("qr lido: " + code);
            var v = deliver(code);
            if (v !== null) {
                note("veredito: " + (v.valid ? "VALIDO" : "INVALIDO") + " - " + (v.info || ""));
                blink(v.valid ? 3 : 6);
            } else {
                blink(1);
            }
        }
        System.delay(200);  // respiro entre leituras (e ponto de cedida)
    }
}
