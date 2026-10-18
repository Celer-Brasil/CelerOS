// app.list.d.ts — tipos do CelerKit LIST (celeros.app.list), que decora o
// core (celeros.app.d.ts) com A.list. Inclua os dois no editor.

declare namespace A {
    interface CachedList<T> {
        /** linhas do cache (build() so roda quando o stamp muda) */
        rows(): T[];
        /** dados mudaram: proxima chamada reconstrói */
        drop(): void;
    }
    const list: {
        version: string;
        /** getStamp() e barato e roda todo frame; build() so no cambio */
        make<T>(getStamp: () => any, build: () => T[]): CachedList<T>;
        /** sort estavel com chave pre-computada (ASC; desc = true inverte) */
        sort<T>(items: T[], keyFn: (it: T) => string, desc?: boolean): T[];
        /** cor de badge por estado */
        badge(kind: 'ok' | 'warn' | 'err' | 'dim'): number;
        /** barras de sinal 0..4 a partir do RSSI (-1 se invalido) */
        bars(rssi: number): number;
    };
}
