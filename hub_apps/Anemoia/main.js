// Anemoia — emulador de NES do CelerOS (nucleo nativo em blob CLRN).
//
// O nucleo (tools/native/nes, Anemoia-ESP32 de Shim06, GPLv3) viaja no
// pacote como nes_core.bin e e alimentado por System.native*; a casca
// compartilhada (dep celeros.emu, a mesma do Atari 2600) cuida da lista de
// ROMs, toque, pausa, slots, frameskip, malha CelerNet e do video: com o
// firmware API 60 o core compoe o quadro + os controles (carimbos) direto no
// vidro inteiro; sem alvo cai no FRAME + nativeDraw com o overlay em JS.
// Este arquivo e so o adapter do console: bits do controle, geometria e
// layout da scratch.
//
// O quadro 256x240 escala para a largura do vidro (480x450 no 4848) e fica
// centrado na vertical. Os slots continuam em <appData>/<rom>.s0..s2 (mesmo
// nome da casca propria de antes: saves antigos seguem valendo).
//
// O app nao vem com jogos.

require("celeros.emu").run({
    title: "Anemoia",
    coreFile: "nes_core.bin",
    scratchKB: function (romBytes) {
        // ~1,3 MB fixos do core (PCM/FB/escalado/estado/arena/carimbos) + a
        // ROM no fim; o INIT diz quanto de ROM cabe
        return 1340 + Math.ceil((romBytes || 1048576) / 1024);
    },
    romDirs: ["/sd/roms", "/local/roms"],
    romExts: [".nes"],
    screenW: 256,
    screenH: 240,
    aspectW: 256,
    aspectH: 240,
    bits: { a: 1, b: 2, select: 4, start: 8, up: 16, down: 32, left: 64, right: 128 },
    labels: { a: "A", b: "B", select: "SEL", start: "STA" },
    labelFont: 4,
    stateExt: ".s",
    audioDefault: true,
    errorHint: "nao e iNES, grande demais ou mapper fora da lista: 0/1/2/3/4/69",
});
