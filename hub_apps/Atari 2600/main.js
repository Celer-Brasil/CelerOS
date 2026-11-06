// Atari 2600 — emulador do CelerOS (nucleo nativo em blob CLRN).
//
// O nucleo (tools/native/a2600) viaja no pacote como a2600_core.bin e e
// alimentado por System.native*; a casca compartilhada (dep celeros.emu) cuida
// de lista de ROMs, toque, pausa, slots, frameskip e da malha CelerNet.
// Este arquivo e so o adapter do console: bits do controle, geometria 4:3,
// extensoes e os comandos extras do core:
//   20 SET_SWITCHES (cor/BW + dificuldade)   21 SET_PADDLE   22 MAPPER
//
// Cartuchos: o tamanho decide o mapper (2K/4K/8K->F8/16K->F6/32K->F4). 8K e
// ambiguo (F8/F8SC/FE/E0/3F/3E/UA): o menu de pausa deixa trocar por ROM e
// guarda a escolha no Storage.

var MAPPER_NAMES = ["2K", "4K", "F8", "F6", "F4", "F8SC", "F6SC", "F4SC",
                    "FE", "E0", "3F", "3E", "UA"];
var MAPPER_IDS = { "2K": 0, "4K": 1, "F8": 2, "F6": 3, "F4": 4, "F8SC": 5,
                   "F6SC": 6, "F4SC": 7, "FE": 8, "E0": 9, "3F": 10, "3E": 11,
                   "UA": 12 };

// switches do console (persistidos)
var swColor = true, swDifA = false;
if (typeof Storage !== "undefined") {
    swColor = Storage.get("cor") !== "0";
    swDifA = Storage.get("dif") === "1";
}

function validMappers(size)
{
    if (size === 2048) return [0];
    if (size === 4096) return [1];
    if (size === 8192) return [2, 5, 8, 9, 10, 11, 12];
    if (size === 16384) return [3, 6];
    if (size === 32768) return [4, 7];
    return [];
}

function mapperName(id)
{
    return (id >= 0 && id < MAPPER_NAMES.length) ? MAPPER_NAMES[id] : "?";
}

function storedMapper(rom)
{
    if (typeof Storage === "undefined") return -1;
    var v = Storage.get("map:" + rom.name);
    if (v === undefined || v === null || v === "") return -1;
    var id = parseInt(v, 10);
    return isNaN(id) ? -1 : id;
}

require("celeros.emu").run({
    title: "ATARI 2600",
    coreFile: "a2600_core.bin",
    scratchKB: function (romBytes) {
        // layout fixo ~558 KB (PCM/FB/escalado/state) + a ROM no fim
        return 600 + Math.ceil((romBytes || 32768) / 1024);
    },
    romDirs: ["/sd/roms/a2600", "/local/roms/a2600"],
    romExts: [".a26", ".bin"],
    screenW: 160,
    screenH: 192,
    aspectW: 4,
    aspectH: 3,
    bits: { a: 1, b: 0, select: 4, start: 8, up: 16, down: 32, left: 64, right: 128 },
    labels: { a: "FOGO", b: null, select: "SEL", start: "RST" },
    labelFont: 2,
    analog: { ctl: 21, label: "Paddle" },
    stateExt: ".a26st",
    audioDefault: true,
    errorHint: "tamanho nao suportado (2/4/8/16/32 KB)",

    // antes do LOAD: aplica o mapper escolhido para esta ROM (se houver)
    coreReady: function (api, rom) {
        var m = storedMapper(rom);
        if (m >= 0) api.ctl(22, m);
    },

    // por quadro: switches do console (cor/BW + dificuldade do jogador 0)
    beforeFrame: function (api) {
        api.ctl(20, (swColor ? 0x04 : 0) | (swDifA ? 0x08 : 0));
    },

    // menu de pausa: mapper do cartucho + switches
    menuExtra: function (api) {
        var rom = api.rom();
        var cur = api.ctl(22, -1);
        return [
            {
                label: "Cart: " + mapperName(cur),
                action: function (api2) {
                    if (!rom) return;
                    var list = validMappers(rom.size);
                    if (list.length < 2) return;
                    var at = 0;
                    for (var i = 0; i < list.length; i++) {
                        if (list[i] === cur) { at = i; break; }
                    }
                    var next = list[(at + 1) % list.length];
                    if (typeof Storage !== "undefined") {
                        Storage.set("map:" + rom.name, String(next));
                    }
                    api2.reload();
                },
            },
            {
                label: "Cor: " + (swColor ? "on" : "B/W"),
                action: function () {
                    swColor = !swColor;
                    if (typeof Storage !== "undefined") {
                        Storage.set("cor", swColor ? "1" : "0");
                    }
                },
            },
            {
                label: "Dificuldade: " + (swDifA ? "A" : "B"),
                action: function () {
                    swDifA = !swDifA;
                    if (typeof Storage !== "undefined") {
                        Storage.set("dif", swDifA ? "1" : "0");
                    }
                },
            },
        ];
    },
});
