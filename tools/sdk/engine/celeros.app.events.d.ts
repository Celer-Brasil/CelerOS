// app.events.d.ts — tipos do CelerKit EVENTS (celeros.app.events), que
// decora o core (celeros.app.d.ts) com A.on/A.emit/A.bus. Inclua os dois.

declare namespace A {
    /** inscricao (chame .off() ou A.off(sub)) */
    interface Sub {
        off(): void;
    }
    type Listener = (a1?: any, a2?: any, a3?: any) => any;
    interface Bus {
        /** prioridade maior ouve antes; devolve false no fn PARA a propagacao */
        on(name: string, fn: Listener, o?: { once?: boolean; prio?: number }): Sub;
        once(name: string, fn: Listener, o?: { prio?: number }): Sub;
        /** inscricao, ou "nome" para todos os ouvintes do nome */
        off(sub: Sub | string): void;
        /** devolve quantos ouviram */
        emit(name: string, a1?: any, a2?: any, a3?: any): number;
        count(name: string): number;
        clear(): void;
    }
    /** barramento global do app */
    const events: Bus & { version: string };
    const on: Bus['on'];
    const once: Bus['once'];
    const off: Bus['off'];
    const emit: Bus['emit'];
    /** barramento novo e privado (ex.: por tela) */
    function bus(): Bus;
}
