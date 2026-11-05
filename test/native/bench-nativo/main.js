// Bench Nativo 1.0 — spike de codigo nativo carregavel (API 57).
//
// Carrega o BLOB de teste (asset do proprio app, gerado por
// tools/native/build_core.py) com System.nativeLoad, chama as entradas por
// System.nativeCall e confere TRES coisas:
//   1. fib(20) = 6765 e fib(50) com wrap uint32 = 3996334433 (valores fixos);
//   2. checksum do fill(320, 320) IGUAL ao recalculado EM JS com a mesma
//      aritmetica do C — a prova de que nativo e JS concordam;
//   3. bytes do scratch lidos de volta por System.nativeRead = padrao.
// E mede o ganho: o MESMO fill em JS no Duktape x nativo (System.micros).
//
// Sem hasNative (ou load = -1) o app explica no vidro e no log — nao e
// erro, e a placa dizendo que o acelerador nao esta aqui (molde Bench
// Fisica). Tudo roda num quadro so: trabalho total ~50 ms, a janela de 1 s
// do exec-timeout nunca fica em risco (o contrato da API e tick curto).

var linhas = [];
function linha(s) {
    linhas.push(s);
    System.print(s);
}

// caminho do blob: System.appDir (API 57) devolve a pasta REAL de install
// (/local/apps/<packageName> pela Loja, /local/apps/<basename> pelo
// celerctl) — o mesmo pacote funciona nos dois canais. Leitura da propria
// pasta e livre (jail do FS)
var BLOB = (System.appDir ? System.appDir() : "/local/apps/bench-nativo") +
           "/core_native_test.bin";

// mesma aritmetica do core_fill do C: padrao v = (i*31 + (i>>6)) & 0xFF,
// checksum rotate-xor (uint32). Serve de arbitro: o native TEM que devolver
// o mesmo numero.
function fillJS(area, scratch) {
    var c = 0, v, i;
    for (i = 0; i < area; i++) {
        v = ((i * 31 + (i >>> 6)) & 0xFF) >>> 0;
        if (scratch) scratch[i] = v;
        c = ((((c << 1) | (c >>> 31)) ^ v) >>> 0);
    }
    return c >>> 0;
}

var info = System.getInfo();
var temNat = info.hasNative === true;
linha("placa=" + info.board + " hasNative=" + temNat);

if (!temNat) {
    linha("System.native* nao existe neste build");
    linha("(flag CELEROS_JS_NATIVE desligada ou placa sem PSRAM)");
} else {
    var t0 = System.micros();
    var h = System.nativeLoad(BLOB);   // scratch padrao 128 KB
    var tLoad = System.micros() - t0;
    if (h <= 0) {
        linha("nativeLoad = " + h + " (recusado)");
        linha("blob ausente, chip/api errados ou sem PSRAM");
    } else {
        linha("handle=" + h + " load+sync=" + tLoad + " us");

        // add: o "ping" (registradores ida e volta)
        linha("add(2, 3) = " + System.nativeCall(h, 0, 2, 3));

        // fib: corretude com wrap uint32 (a chamada nativa e o mesmo
        // laco que o JS faria — o valor e o arbitro, nao o tempo)
        var f20 = System.nativeCall(h, 1, 20);
        var f50 = System.nativeCall(h, 1, 50);
        linha("fib(20) = " + f20 + (f20 === 6765 ? " ok" : " DIVERGE"));
        linha("fib(50) = " + f50 + (f50 === 3996334433 ? " ok" : " DIVERGE"));

        // fill: checksum nativo x recalculo JS (a MESMA area) + A/B de
        // tempo. Area 320x320 = 102400 B (cabe no scratch de 128 KB).
        var W = 320, H = 320, area = W * H;
        var t1 = System.micros();
        var cNat = System.nativeCall(h, 2, W, H);
        var tNat = System.micros() - t1;
        var t2 = System.micros();
        var cJs = fillJS(area, null);
        var tJs = System.micros() - t2;
        linha("checksum nat=" + cNat);
        linha("checksum js =" + cJs + (cNat === cJs ? " ok" : " DIVERGE"));
        linha("fill " + area + " B nat=" + tNat + " us");
        linha("fill js=" + tJs + " us" +
              (tNat > 0 ? " ganho=" + Math.round(tJs / tNat) + "x" : ""));

        // nativeRead: bytes do scratch de volta — o padrao tem que bater
        var s = System.nativeRead(h, 0, 8);
        var esperado = "";
        for (var i = 0; i < 8; i++) {
            esperado += String.fromCharCode((i * 31 + (i >>> 6)) & 0xFF);
        }
        var leituraOk = true;
        for (var j = 0; j < 8; j++) {
            if (s.charCodeAt(j) !== esperado.charCodeAt(j)) leituraOk = false;
        }
        linha("read[0..8] = " + (leituraOk ? "padrao ok" : "DIVERGE"));

        System.nativeFree(h);
        linha("free ok");
    }
}
linha("fim");

// vidro: simples e sem deps — loop bloqueante canonico da UI (API 22):
// begin le o toque (o X da topbar sai), text redesenha so quando muda,
// end apresenta e da o pacing. Headless: cai no fim e sai (o log fica).
if (System.getInfo().hasDisplay !== false) {
    while (true) {
        UI.begin();
        for (var l = 0; l < linhas.length && l < 18; l++) {
            UI.text(String(linhas[l]), 4, 8 + l * 15);
        }
        UI.end();
    }
}
