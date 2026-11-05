// {{APP_NAME}} — app CelerOS com parte nativa (blob CLRN, API 57).
//
// O core roda em Xtensa (fora do heap Duktape); o JS orquestra: carrega o
// blob uma vez, chama por tick curto (UM quadro por nativeCall — o
// exec-timeout nao ve chamada nativa longa) e desenha.
//
// Sem a parte nativa nesta placa (System.getInfo().hasNative === false,
// ex.: CYD) o app explica e segue so com JS - feature-detect, nao e erro.

var info = System.getInfo();
var temNat = info.hasNative === true;
var linhas = [];

function linha(s) {
    linhas.push(s);
    System.print(s);
}

linha("placa=" + info.board + " hasNative=" + temNat);

if (temNat) {
    // o blob mora na pasta do proprio app (System.appDir, API 57 — o canal
    // de install muda o caminho: Loja usa packageName, celerctl usa a pasta)
    var h = System.nativeLoad(System.appDir() + "/core.bin");
    if (h > 0) {
        linha("core.bin carregado (handle " + h + ")");
        linha("add(2, 3) = " + System.nativeCall(h, 0, 2, 3));
        var soma = System.nativeCall(h, 1, 160, 120);  // fill 160x120
        linha("fill checksum = " + soma);
        System.nativeFree(h);
        linha("free ok");
    } else {
        linha("core.bin recusado (" + h + ") - rebuild com celer.js native");
    }
    } else {
        linha("sem nativo aqui (flag/placa) - lado JS segue valendo");
    }
linha("fim");

// vidro: loop bloqueante canonico da UI (API 22)
if (info.hasDisplay !== false) {
    while (true) {
        UI.begin();
        for (var i = 0; i < linhas.length && i < 18; i++) {
            UI.text(String(linhas[i]), 4, 8 + i * 15);
        }
        UI.end();
    }
}
