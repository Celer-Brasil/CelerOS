// emu.d.ts — tipos da casca compartilhada dos emuladores NATIVOS (celeros.emu).
//
// O nucleo de cada console e um blob CLRN que viaja no pacote do app; esta dep
// cuida do que todo emulador repete: lista de ROMs, controles de toque, pausa,
// 3 slots de save state, frameskip, pausa da malha CelerNet e telas de erro.
// O adapter do app declara bits/geometria/extensao e os comandos extras do
// console (mapper, switches, paddle...).

interface EmuRom {
    name: string;
    path: string;
    size: number;
}

interface EmuApi {
    /** core_ctl canonico (0-19) + extensoes do console (20+). */
    ctl(cmd: number, arg?: number): number;
    /** Recarrega a ROM atual (aplica coreReady de novo). */
    reload(): void;
    /** ROM aberta (null antes da primeira). */
    rom(): EmuRom | null;
    /** Liga/desliga a geracao de PCM do core. */
    setAudio(on: boolean): void;
    audioOn(): boolean;
}

interface EmuMenuExtra {
    /** Rotulo recalculado a cada quadro do menu. */
    label: string;
    action: (api: EmuApi) => void;
}

interface EmuConfig {
    title: string;
    coreFile: string;
    scratchKB?: (romBytes: number) => number;
    romDirs: string[];
    romExts: string[];
    screenW: number;
    screenH: number;
    aspectW?: number;
    aspectH?: number;
    bits: {
        up: number;
        down: number;
        left: number;
        right: number;
        a: number;
        b: number;
        select: number;
        start: number;
    };
    labels: { a: string; b: string | null; select: string; start: string };
    labelFont?: number;
    /** Controle analogico opcional (paddle): trilho horizontal -> ctl. */
    analog?: { ctl: number; label?: string };
    stateExt?: string;
    audioDefault?: boolean;
    errorHint?: string;
    /** Chamado entre o INIT e o LOAD (mapper override etc.). */
    coreReady?: (api: EmuApi, rom: EmuRom) => void;
    /** Chamado antes de cada FRAME (switches do console etc.). */
    beforeFrame?: (api: EmuApi) => void;
    /** Itens extras do menu de pausa (mapper, cor/BW, dificuldade...). */
    menuExtra?: (api: EmuApi) => EmuMenuExtra[];
}

declare const Emu: {
    version: string;
    run(cfg: EmuConfig): void;
};
