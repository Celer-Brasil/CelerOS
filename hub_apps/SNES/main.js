// SNES — emulador do CelerOS (nucleo nativo em blob CLRN).
//
// O nucleo (tools/native/snes: LakeSnes, MIT, com o renderizador de linha, o
// escalonador por eventos e o relogio inteiro da APU do CelerOS) viaja no
// pacote como snes_core.bin e e alimentado por System.native*; a casca
// compartilhada (dep celeros.emu) cuida de lista de ROMs, toque, pausa,
// slots, frameskip e do video direto no vidro (FRAME_SCREEN). Este arquivo e
// so o adapter do console: os 12 botoes, a geometria e a SRAM do cartucho.
//
// Botoes na ordem do registrador do controle do SNES: B Y Select Start
// cima baixo esq dir (bits 0-7) e A X L R (bits 8-11).
//
// SRAM (bateria): lida de <appData>/<rom>.srm ao abrir a ROM e gravada ao
// pausar/sair (comandos 20/21 do core dizem onde ela fica na scratch).
//
// O app nao vem com jogos.

require("celeros.emu").run({
    title: "SNES",
    coreFile: "snes_core.bin",
    scratchKB: function (romBytes) {
        // ~680 KB fixos do core (PCM, uniao grabs/estado/fila de linhas,
        // carimbos, arena das structs) + a ROM no fim (sem expansao) +
        // folga; o INIT diz quanto de ROM cabe
        return 680 + 16 + Math.ceil((romBytes || 1048576) / 1024);
    },
    romDirs: ["/sd/roms/snes", "/local/roms/snes"],
    romExts: [".sfc", ".smc"],
    screenW: 256,
    screenH: 224,
    aspectW: 8,
    aspectH: 7,
    bits: {
        b: 1, y: 2, select: 4, start: 8, up: 16, down: 32, left: 64, right: 128,
        a: 256, x: 512, l: 1024, r: 2048,
    },
    labels: { a: "A", b: "B", x: "X", y: "Y", l: "L", r: "R", select: "SEL", start: "STA" },
    labelFont: 4,
    stateExt: ".ss",
    sram: { offCtl: 20, sizeCtl: 21, sumCtl: 25, ext: ".srm" },
    stampUsedCtl: 24,
    audioDefault: true,
    errorHint: "nao e ROM de SNES, grande demais para a PSRAM livre ou chip especial (SA-1/SuperFX/DSP)",
});
