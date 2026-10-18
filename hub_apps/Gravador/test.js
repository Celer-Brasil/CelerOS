// Wire de teste do Gravador (nunca vai ao aparelho): garante espaco livre no
// FS falso e um WAV "tocavel". O Mic ja vem stubado no harness (start/stop/
// level/recording). Usado por `node tools/sdk/celer.js test|emu hub_apps/Gravador`.
module.exports.wire = function (env) {
    env.FS.getFreeSpace = function () { return 8 * 1024 * 1024; };
    env.System.playWav = function (p) { env.__harness.log.push('[wav] ' + p); return true; };
};
