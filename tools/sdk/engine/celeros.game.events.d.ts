// game.events.d.ts — tipos do modulo CelerGame EVENTS (celeros.game.events),
// que decora o core (celeros.game.d.ts) com E.on/emit/bus. Inclua os dois.

declare namespace E {
    interface Sub { name: string; dead: boolean; off(): void }
    interface SubOpts {
        once?: boolean;
        /** cai sozinho quando a cena onde nasceu sai (dorme sob um E.push) */
        scene?: boolean;
        /** maior ouve antes */
        prio?: number;
    }
    type Listener = (a1?: any, a2?: any, a3?: any) => boolean | void;
    interface Bus {
        on(name: string, fn: Listener, o?: SubOpts): Sub;
        once(name: string, fn: Listener, o?: SubOpts): Sub;
        /** Sub ou nome (todos do nome) */
        off(s: Sub | string): void;
        /** sincrono; ouvinte devolvendo false para a propagacao. Devolve quantos ouviram */
        emit(name: string, a1?: any, a2?: any, a3?: any): number;
        count(name: string): number;
        clear(): void;
    }
    /** barramento privado (de uma entidade/sistema) */
    function bus(): Bus;
    /** barramento global do jogo */
    const events: Bus & { version: string };
    function on(name: string, fn: Listener, o?: SubOpts): Sub;
    function once(name: string, fn: Listener, o?: SubOpts): Sub;
    function off(s: Sub | string): void;
    function emit(name: string, a1?: any, a2?: any, a3?: any): number;
    /** entrega no PROXIMO quadro (fora do laco que disparou) */
    function emitLater(name: string, a1?: any, a2?: any, a3?: any): void;
}
