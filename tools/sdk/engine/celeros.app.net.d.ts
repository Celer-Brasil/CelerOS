// app.net.d.ts — tipos do CelerKit NET (celeros.app.net), que decora o core
// (celeros.app.d.ts) com A.net. Inclua os dois no editor.

declare namespace A {
    const net: {
        version: string;
        /** Net.isConnected() a prova de erro (false sem o global) */
        online(): boolean;
        /** GET JSON; null em qualquer erro/fora da rede */
        getJSON(url: string): any;
        getText(url: string): string | null;
        post(url: string, body: string, mime?: string): any;
        /**
         * retry(fn, o): repete fn() ate o resultado "servir".
         * o.n = tentativas extras (default 2); o.backoff = base ms
         * (default 1500, dobra ate x8); o.ok(v) = predicado.
         * Bloqueia entre tentativas (System.delay bombeia o present).
         */
        retry<T>(fn: () => T, o?: {
            n?: number;
            backoff?: number;
            ok?: (v: T) => boolean;
        }): T;
        /** download + MD5 opcional; false apaga o alvo (nunca sobra metade) */
        fetch(url: string, file: string, md5?: string, onProg?: (recebido: number, total: number) => void): boolean;
        /** texto de arquivo baixado; null em erro */
        readText(file: string): string | null;
    };
}
