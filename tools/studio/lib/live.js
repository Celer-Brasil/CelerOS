'use strict';
// Processo filho do preview (Play) do Celer Studio: roda o emulador ao vivo
// do SDK apontando para o build. O env CELER_MICROS_BIAS=1 liga o skew de
// micros() do runner (o pacing da engine no host precisa que duas leituras
// do mesmo quadro difiram).

const { startLive } = require('../../sdk/lib/live_server.js');

const appDir = process.argv[2];
const port = +process.argv[3] || 8521;
// fps do projeto (canvas.fps), passado pelo server; 30 e o padrao antigo
const fps = +process.argv[4] || 30;

if (!appDir) {
    console.error('uso: live.js <appDir> [porta] [fps]');
    process.exit(2);
}

startLive({ appDir: appDir, port: port, fps: fps, open: false, seed: 7 });
