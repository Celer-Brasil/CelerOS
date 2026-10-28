// Wire de teste do HTTP Demo (nunca vai ao aparelho): WiFi conectado e as
// duas APIs publicas respondendo com valores fixos, para o harness exercitar
// o caminho online (cards, latencia, auto-refresh) sem rede de verdade.
// Usado por `node tools/sdk/celer.js test|emu "data/apps/HTTP Demo"`.
module.exports.wire = function (env) {
    env.Net.isConnected = function () { return true; };
    env.System.getIPAddress = function () { return "192.168.0.42"; };
    env.Net.getJSON = function (url) {
        if (url.indexOf("awesomeapi") >= 0) {
            return { USDBRL: { bid: "5.4321", high: "5.5012", low: "5.3120" } };
        }
        return { data: { amount: "123456.78" } };
    };
};
