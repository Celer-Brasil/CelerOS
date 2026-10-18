// app.fmt.d.ts — tipos do CelerKit FMT (celeros.app.fmt), que decora o core
// (celeros.app.d.ts) com A.fmt. Inclua os dois no editor.

declare namespace A {
    const fmt: {
        version: string;
        /** "512 B", "1.5 KB", "2.3 MB"; "" se <= 0 */
        bytes(n: number): string;
        /** "1d 3h", "2h 5m", "4m" */
        uptime(ms: number): string;
        /** "07" */
        pad2(n: number): string;
        /** hora do aparelho "10:32"; com segundos: "10:32:05" */
        clock(withSecs?: boolean): string;
        /** "27/09 10:32" a partir de epoch em SEGUNDOS; "" se vazio */
        when(epochSecs: number): string;
        /** "2.3 s" (1 casa), "1m 05s" */
        dur(ms: number): string;
    };
}
