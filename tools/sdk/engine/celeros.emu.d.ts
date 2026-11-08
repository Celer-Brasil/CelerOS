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
    /** Slots de save state existentes (0-3), contados no scan. */
    saves?: number;
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
    /** Bits do controle no FRAME: 0-7 em arg & 0xFF, 8-15 em arg >> 16. */
    bits: {
        up: number;
        down: number;
        left: number;
        right: number;
        a: number;
        b: number;
        select: number;
        start: number;
        /** Opcionais (SNES): com x/y o A/B vira losango; com l/r, ombros no topo. */
        x?: number;
        y?: number;
        l?: number;
        r?: number;
    };
    labels: { a: string; b: string | null; select: string; start: string; x?: string; y?: string; l?: string; r?: string };
    labelFont?: number;
    /** Controle analogico opcional (paddle): trilho horizontal -> ctl. */
    analog?: { ctl: number; label?: string };
    stateExt?: string;
    /**
     * SRAM do cartucho (bateria): offCtl/sizeCtl dizem onde ela fica na
     * scratch; sumCtl (opcional) devolve um checksum para gravar o arquivo
     * so quando muda. Lida ao abrir a ROM; gravada na pausa, ao trocar de
     * jogo, ao sair e a cada 10 s se mudou.
     */
    sram?: { offCtl: number; sizeCtl: number; sumCtl?: number; ext?: string };
    /** Bancada: ctl que devolve os bytes usados pelos carimbos (log ao abrir). */
    stampUsedCtl?: number;
    audioDefault?: boolean;
    errorHint?: string;
    /** Chamado entre o INIT e o LOAD (mapper override etc.). */
    coreReady?: (api: EmuApi, rom: EmuRom) => void;
    /** Chamado antes de cada FRAME (switches do console etc.). */
    beforeFrame?: (api: EmuApi) => void;
    /** Itens extras do submenu Opcoes (mapper, cor/BW, dificuldade...). */
    menuExtra?: (api: EmuApi) => EmuMenuExtra[];
}

declare const Emu: {
    version: string;
    run(cfg: EmuConfig): void;
};
