// celeros.hw.button.d.ts — tipos da dep celeros.hw.button (botao fisico por
// polling, com debounce e gestos). Dep do hub: "celeros.hw": "^1.0.0" ou
// "celeros.hw.button": "^1.0.0". API 12 + permissao "gpio".
//
// NAO ha attachInterrupt no JS: use B.start(ms) (um timer para todos) ou
// B.tick()/HW.tick() no proprio laco.

declare namespace B {
    const version: string;

    type Event = 'press' | 'release' | 'click' | 'double' | 'long' | 'repeat';

    interface Opts {
        pin: number;
        /** Botao para GND com pull-up (default true). */
        activeLow?: boolean;
        pullup?: boolean;
        debounceMs?: number;   // default 20
        longMs?: number;       // default 1200
        doubleMs?: number;     // default 300
        repeatMs?: number;     // 0 = sem repeat
    }

    interface Button {
        /** handlers recebem a duracao em ms (press recebe 0). */
        on(event: Event, fn: (ms: number) => void): () => void;
        off(event: Event, fn?: (ms: number) => void): void;
        tick(now?: number): void;
        pressed(): boolean;
        heldMs(): number;
    }

    interface Group {
        tick(now?: number): void;
        on(event: Event, fn: (ms: number) => void): Group;
        off(event: Event, fn?: (ms: number) => void): Group;
    }

    function create(opts: Opts): Button;
    function group(list: Button[]): Group;
    function tick(now?: number): void;
    function start(ms?: number): number;
    function stop(): void;
    function available(): boolean;
}
