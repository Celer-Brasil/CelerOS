// game.waves.d.ts — tipos do modulo CelerGame WAVES (celeros.game.waves),
// que decora o core (celeros.game.d.ts) com E.waves. Inclua os dois.

declare namespace E {
    interface WaveGroup { type: string; n?: number; every?: number; delay?: number; [k: string]: any }
    /** onda de um grupo (os campos do grupo) ou {groups: [...]} */
    interface WaveDef extends Partial<WaveGroup> { groups?: WaveGroup[]; rest?: number }
    interface Waves {
        list: WaveDef[];
        /** onda corrente (1..; 0 antes da 1a) */
        wave: number;
        state: 'wait' | 'spawn' | 'clear' | 'done';
        dead: boolean;
        spawned: number;
        total: number;
        /** ms no estado */
        t: number;
        /** geracao da cena dona (null = global) */
        gen: number | null;
        /** definicao da onda n (com endless escalando a ultima) */
        def(n: number): WaveDef | null;
        /** com auto: false, comeca */
        start(): void;
        /** vai para a proxima ja */
        next(): void;
        stop(): void;
        progress(): number;
        left(): number;
    }
    /** Diretor de ondas; preso a cena. */
    const waves: {
        version: string;
        (list: WaveDef[], o?: {
            spawn?: (type: string, w: Waves, i: number) => void;
            /** onda so fecha com alive() 0 */
            alive?: () => number;
            onWave?: (w: Waves, n: number) => void;
            onClear?: (w: Waves, n: number) => void;
            onDone?: (w: Waves) => void;
            /** pausa default entre ondas (ms, 2000) */
            rest?: number;
            /** espera antes da 1a (ms) */
            delay?: number;
            auto?: boolean;
            global?: boolean;
            endless?: { grow?: number };
        }): Waves;
    };
}
