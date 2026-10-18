// game.script.d.ts — tipos do modulo CelerGame SCRIPT (celeros.game.script),
// que decora o core (celeros.game.d.ts) com E.script. Inclua os dois.

declare namespace E {
    /** passo funcao: chamado por quadro ate devolver algo diferente de false */
    type ScriptFn = (s: Script, dt: number) => boolean | void;
    interface ScriptStep {
        /** chama e segue no mesmo quadro */
        call?: (s: Script) => void;
        /** espera ms */
        wait?: number;
        /** tween e espera ele terminar */
        tween?: any; to?: Record<string, number | string>; ms?: number;
        ease?: (t: number) => number; delay?: number;
        /** espera fn() ficar true */
        until?: (s: Script) => boolean;
        /** espera um toque seco */
        tap?: boolean;
        /** filhos juntos (passo ou lista de passos cada); espera todos */
        par?: (ScriptStep | ScriptFn | (ScriptStep | ScriptFn)[])[];
        /** marca para o loop */
        label?: string;
        /** volta ao label (times = voltas; sem = para sempre) */
        loop?: string; times?: number;
        /** E.emit (modulo events) */
        emit?: string; arg?: any;
        /** E.goto(scene, opts) */
        scene?: string; opts?: any;
    }
    interface Script {
        steps: (ScriptStep | ScriptFn)[];
        done: boolean;
        dead: boolean;
        paused: boolean;
        skipping: boolean;
        /** geracao da cena dona (null = global) */
        gen: number | null;
        /** bolsa livre dos passos */
        data: Record<string, any>;
        onDone: ((s: Script) => void) | null;
        /** indice do passo corrente */
        step(): number;
        pause(on?: boolean): boolean;
        cancel(): void;
        /** termina ja: tweens no valor final, esperas zeradas, calls restantes rodam */
        skip(): void;
    }
    /** Roteiro de passos (cutscene, tutorial, coreografia de chefe). Preso a cena. */
    const script: {
        version: string;
        (steps: (ScriptStep | ScriptFn)[], opts?: { onDone?: (s: Script) => void; global?: boolean }): Script;
        /** roteiros vivos */
        live(): number;
        /** mata todos */
        clear(): void;
    };
}
