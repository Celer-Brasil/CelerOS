// Wire de teste do Settings (nunca vai ao aparelho): poda os recursos que
// variam por placa (sensores, som, notificacoes, relogio) para o menu ficar
// deterministico e atravessa as telas principais: Wi-Fi, Aplicativos, Hora
// (toggle NTP + seletor de fuso), Seguranca, Tela (aba de tempo de tela),
// Atualizacao (check sem Wi-Fi -> aviso) e Sobre. Com __gate, o app sobe
// pelo gate de PIN (bloqueante antes do A.run) aceitando '1234'. Usado por
// `node tools/sdk/celer.js test|emu "data/apps/Settings"`.
module.exports.wire = function (env) {
    if (env.__gate) {
        env.System.pinState = function () { return 1; };
        var vp = env.System.verifyPin;
        env.System.verifyPin = function (p) { return p === '1234' ? true : vp(p); };
        env.__harness.pushPrompt(['1234']);   // entra no menu; o voltar final sai
    }
    // menu fixo: Wi-Fi, Aplicativos, Hora e fuso, Seguranca, Tela, Atualizacao, Sobre
    env.Sensors = {};
    env.System.getVolume = undefined;
    env.System.notifications = undefined;
    var getInfo = env.System.getInfo;
    env.System.getInfo = function () {
        var i = getInfo();
        i.hasImu = false;
        return i;
    };
    env.Net.isConnected = function () { return false; };

    var t = env.__harness.tap;
    // Wi-Fi (row 0): desenha card de estado; volta
    t(120, 66);
    t(20, 20);
    // Aplicativos (row 1): lista + espaco livre; volta
    t(120, 102);
    t(20, 20);
    // Hora e fuso (row 2): toggle NTP (198,144), seletor de fuso (row em 230),
    // escolhe "UTC-11 Midway" (row 1 — o seletor fecha sozinho), volta p/ menu
    t(120, 138);
    t(198, 144);
    t(120, 230);
    t(120, 102);
    t(20, 20);
    // Seguranca (row 3): tela do A.form; volta
    t(120, 174);
    t(20, 20);
    // Tela (row 4): aba "1 min" do tempo de tela; volta
    t(120, 210);
    t(123, 233);
    t(20, 20);
    // Atualizacao (row 5): "Procurar atualizacao" sem Wi-Fi -> aviso; um tap
    // neutro da tempo do estado "Sem conexao" desenhar antes do voltar
    t(120, 246);
    t(120, 154);
    t(120, 305);
    t(20, 20);
    // Sobre (row 6): lista de infos; volta ao menu
    t(120, 282);
    // volta no menu raiz encerra o app
    t(20, 20);
};
