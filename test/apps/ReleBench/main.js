// ReleBench — bancada do rele remoto (API 38, recursos genericos da matilha,
// Documentation/CelerNet_Design.pt-BR.md §10.1). NAO e app de fabrica.
//
// Descobre um "rele*" no catalogo do vizinho (com os metadados do
// LIST_META), abre com {"off":1}, liga, le de volta pelo op [2] e SEGURA a
// sessao — o operador reboota o cliente no meio (ou espera o lease de 20 s
// vencer) para provar o auto-off no dono. Tudo vai para /local/relebench.log
// (linhas "t=<ms> <msg>"), lido com `celerctl cat`.
//
// Requisitos no DONO: matilha privada + `set res_share_gpio 1`.
// /local/relebench.txt (opcional): "segura <segundos>" muda a fase B.
'use strict';

var OUT = '/local/relebench.log';
var lines = [];
function L(s) {
    lines.push('t=' + System.millis() + ' ' + s);
    System.print('[ReleBench] ' + s);
}
function flush() {
    FS.writeTextFile(OUT, lines.join('\n') + '\n');
}

L('inicio (perms gpio/fs)');
var gpios = [];
var reles = [];
for (var tent = 0; tent < 5 && reles.length === 0; tent++) {
    if (tent > 0) System.delay(2000);  // DESCRIBE vai no fundo: ~1 s por rodada
    gpios = Pack.resources('gpio');
    reles = gpios.filter(function (r) { return r.name.indexOf('rele') === 0; });
}
L('catalogo gpio (' + tent + ' rodadas): ' + JSON.stringify(gpios));
if (reles.length === 0) {
    L('FIM: nenhum rele no catalogo (dono ausente, sem malha ou firmware velho)');
} else {
    var alvo = reles[0];
    L('alvo ' + alvo.nodeName + '/' + alvo.name + ' schema=' + (alvo.schema || '-') +
      ' busy=' + alvo.busy);
    var h = Pack.open(alvo.node, alvo.name, { off: 1 });
    var i = 0;
    while (Pack.status(h).state === 'opening' && i < 80) {
        System.delay(100);
        i++;
    }
    var st = Pack.status(h);
    L('open: ' + st.state + (st.reason ? '/' + st.reason : ''));
    if (st.state === 'open') {
        Pack.write(h, '\u0001\u0001');  // [1][1]: liga
        var rb = null;
        for (var k = 0; k < 10 && rb === null; k++) {  // le de volta (1 s de tolerancia)
            System.delay(100);
            Pack.write(h, '\u0002');    // [2]: le
            System.delay(100);
            rb = Pack.read(h);
        }
        L('ligou; leitura de volta: ' + (rb ? rb.charCodeAt(1) : 'sem resposta em 2 s'));
        var segura = 180;
        var m = (FS.readTextFile('/local/relebench.txt') || '').match(/segura (\d+)/);
        if (m) segura = parseInt(m[1], 10);
        for (var t = 0; t < segura; t += 10) {
            System.delay(10000);
            var s2 = Pack.status(h);
            L('segurando ' + (t + 10) + 's: ' + s2.state + (s2.reason ? '/' + s2.reason : ''));
            flush();
        }
        var rb2 = null;
        for (var k2 = 0; k2 < 10 && rb2 === null; k2++) {
            System.delay(100);
            Pack.write(h, '\u0002');
            System.delay(100);
            rb2 = Pack.read(h);
        }
        L('antes de fechar: ' + (rb2 ? rb2.charCodeAt(1) : 'sem resposta (' + Pack.status(h).state + ')'));
        Pack.close(h);
        L('FIM: fechado (auto-off garante 0 no dono)');
    }
}
flush();
