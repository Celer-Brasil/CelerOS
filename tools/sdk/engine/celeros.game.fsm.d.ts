// game.fsm.d.ts — tipos do modulo CelerGame FSM (celeros.game.fsm), que
// decora o core (celeros.game.d.ts) com E.fsm. Inclua os dois no editor.

declare namespace E {
    interface FsmState<O = any> {
        enter?: (m: Fsm<O>, arg?: any) => void;
        update?: (m: Fsm<O>, dt: number) => void;
        exit?: (m: Fsm<O>, next: string) => void;
        draw?: (m: Fsm<O>) => void;
        /** volta pelo pop() (bolsa e tempo restaurados); sem resume o pop chama enter */
        resume?: (m: Fsm<O>, arg?: any) => void;
        /** saida automatica: [segundos no estado, proximo | (m) => proximo] */
        after?: [number, string | ((m: Fsm<O>) => string | null)];
        /** handlers do m.send(ev, arg); devolver string = transicao */
        on?: Record<string, (m: Fsm<O>, arg?: any) => string | void>;
    }
    interface Fsm<O = any> {
        owner: O;
        states: Record<string, FsmState<O>>;
        state: string | null;
        prev: string | null;
        /** segundos no estado corrente */
        time: number;
        /** bolsa do estado (nova a cada entrada) */
        data: Record<string, any>;
        history: string[];
        onChange: ((m: Fsm<O>, from: string | null, to: string) => void) | null;
        /** troca (dentro de callback vale no fim dele); mesmo estado so com force */
        go(name: string, arg?: any, force?: boolean): boolean;
        is(name: string): boolean;
        /** empilha o atual e vai; pop() volta */
        push(name: string, arg?: any): boolean;
        pop(arg?: any): boolean;
        update(dt: number): void;
        /** evento ao estado corrente (states[x].on[ev]); true se tratou */
        send(ev: string, arg?: any): boolean;
        draw(): void;
    }
    /** Maquina de estados (IA, heroi, chefe com fases). Estado "*" = coringa:
     *  on/update dele valem em todo estado. */
    const fsm: {
        version: string;
        <O>(owner: O, states: Record<string, FsmState<O>>, first?: string, opts?: {
            arg?: any; history?: number;
            onChange?: (m: Fsm<O>, from: string | null, to: string) => void;
        }): Fsm<O>;
    };
}
