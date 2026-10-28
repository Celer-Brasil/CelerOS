// Wire de teste do Web Server (nunca vai ao aparelho): WiFi conectado com IP,
// servidor ligado/desligado de mentira e credenciais fixas; um toque no
// toggle (centro 198,82) liga o servidor no meio da rodada para o harness
// cobrir o card de acesso e o polling. Usado por
// `node tools/sdk/celer.js test|emu "data/apps/Web Server"`.
module.exports.wire = function (env) {
    var on = false;
    env.System.wifiStatus = function () {
        return { connected: true, ip: "192.168.0.50", webServer: on, savedNetworks: 1 };
    };
    env.System.webActive = function () { return on; };
    env.System.webSetActive = function (v) { on = !!v; };
    env.System.webAuthInfo = function () { return { user: "admin", pass: "celer123" }; };
    env.System.getIPAddress = function () { return "192.168.0.50"; };

    var feito = false;
    var orig = env.System.delay;
    env.System.delay = function (ms) {
        if (!feito && env.System.millis() >= 1600) {
            feito = true;
            env.__harness.tap(198, 82);   // toggle do servidor
        }
        return orig(ms);
    };
};
