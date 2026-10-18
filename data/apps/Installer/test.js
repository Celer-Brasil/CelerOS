// Wire de teste do Installer (nunca vai ao aparelho): publica um pacote de
// mentira no cartao SD, ensina o stub de FS.renameFile a renomear PASTA (o
// firmware renomeia por POSIX rename; o stub do harness so cobre arquivo —
// mesma semantica, nada de regra nova) e navega lista -> detalhe ->
// Instalar -> OK do dialogo de sucesso. Toques agendados pelo RELOGIO do
// app (o boot tem um frame de busy que consome mais clock). Usado por
// `node tools/sdk/celer.js test|emu data/apps/Installer`.
module.exports.wire = function (env) {
    var FS = env.FS;
    FS.mkdir("/sd/apps");
    FS.mkdir("/sd/apps/Demo SD");
    FS.writeTextFile("/sd/apps/Demo SD/app.json", JSON.stringify({
        name: "Demo SD", packageName: "demo.sd", version: "1.0.1",
        api: 22, author: "CelerOS",
        description: "App de teste do Installer (wire do harness)."
    }));
    FS.writeTextFile("/sd/apps/Demo SD/main.js", "// app de teste\nSystem.print('oi do SD');\n");

    // rename de diretorio para o staging do install (mesmo contrato do
    // FileSystem::renameFile do firmware: rename() POSIX cobre pasta)
    var origRename = FS.renameFile;
    FS.renameFile = function (a, b) {
        if (FS.isDirectory(a) && !FS.exists(b)) {
            if (!FS.copyDirectory(a, b)) return false;
            FS.removeDirectory(a);
            return true;
        }
        return origRename(a, b);
    };

    // toques por marco do relogio (o clock comeca em 1000): 1o item da
    // lista (linha 0: y 100..148), botao Instalar, OK do dialogo de
    // resultado do kit (A._result: botao em 70,264 100x34)
    var passos = [
        [1600, 120, 124],
        [2800, 120, 288],
        [4200, 120, 281]
    ];
    var feitos = 0;
    var orig = env.System.delay;
    env.System.delay = function (ms) {
        var agora = env.System.millis();
        while (feitos < passos.length && agora >= passos[feitos][0]) {
            env.__harness.tap(passos[feitos][1], passos[feitos][2]);
            feitos++;
        }
        return orig(ms);
    };
};
