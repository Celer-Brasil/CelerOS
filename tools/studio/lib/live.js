'use strict';
// Processo filho do preview (Play) do Celer Studio: roda o emulador ao vivo
// do SDK apontando para o build. O env CELER_MICROS_BIAS=1 liga o skew de
// micros() do runner (o pacing da engine no host precisa que duas leituras
// do mesmo quadro difiram).

const { startLive } = require('../../sdk/lib/live_server.js');

const appDir = process.argv[2];
const port = +process.argv[3] || 8521;

if (!appDir) {
    console.error('uso: live.js <appDir> [porta]');
    process.exit(2);
}

startLive({ appDir: appDir, port: port, fps: 30, open: false, seed: 7 });
