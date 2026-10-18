// app.history.d.ts — tipos do CelerKit HISTORY (celeros.app.history), que
// decora o core (celeros.app.d.ts) com A.history. Inclua os dois no editor.

declare namespace A {
    interface History {
        /** strings do anel (mais antigas primeiro) */
        all(): string[];
        /** true se gravou; false se vazio ou repetiu a anterior */
        push(s: string): boolean;
        last(): string;
        clear(): void;
    }
    const history: {
        version: string;
        /** o = { file ("historico.json"), max (50) } */
        new(o?: { file?: string; max?: number }): History;
    };
}
