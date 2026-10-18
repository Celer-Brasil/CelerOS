// app.path.d.ts — tipos do CelerKit PATH (celeros.app.path), que decora o
// core (celeros.app.d.ts) com A.path. Inclua os dois no editor.

declare namespace A {
    const path: {
        version: string;
        /** "main.js" de "/local/apps/Loja/main.js" */
        base(p: string): string;
        /** "/local/apps/Loja" (tudo antes do ultimo "/") */
        dir(p: string): string;
        /** extensao em MAIUSCULO ("PNG"); "" se nao tem */
        ext(p: string): string;
        /** nome sem extensao ("pacote" de "pacote.zip") */
        stem(p: string): string;
        /** junta ignorando pedacos vazios: join("a", "", "b") = "a/b" */
        join(...partes: (string | undefined | null)[]): string;
        /** tudo fora de [A-Za-z0-9 ._()-] vira "_" */
        safeName(s: string): string;
    };
}
