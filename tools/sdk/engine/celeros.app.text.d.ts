// app.text.d.ts — tipos do CelerKit TEXT (celeros.app.text), que decora o
// core (celeros.app.d.ts) com A.text. Inclua os dois no editor.

declare namespace A {
    const text: {
        version: string;
        /** fora do Latin-1 some (\n fica) — as fontes so tem U+0020..U+00FF */
        fit(s: string): string;
        /** quantas linhas o texto ocupa na largura w (papel 'body') */
        lines(s: string, w: number, role?: string): number;
        /**
         * Leitor rolante BLOQUEANTE (header com voltar). getText() devolve
         * o texto na hora da abertura.
         */
        viewer(title: string, getText: () => string): void;
    };
}
