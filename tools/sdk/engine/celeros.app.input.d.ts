// app.input.d.ts — tipos do CelerKit INPUT (celeros.app.input), que decora
// o core (celeros.app.d.ts) com A.input. Inclua os dois no editor.

declare namespace A {
    interface KeypadEv {
        type: 'enter' | 'cancel';
        text: string;
    }
    const input: {
        version: string;
        /** abre o teclado dockado; chips = labels da faixa superior */
        open(o?: { maxLen?: number; chips?: string[] }): boolean;
        /** y onde o teclado comeca (o conteudo do app termina aqui) */
        top(): number;
        ativo(): boolean;
        /** texto corrente da linha */
        text(): string;
        /** drena 1 evento; cancel reabre a sessao sozinho */
        poll(): KeypadEv | null;
        /** frame total apaga o teclado: redesenha (chame apos UI.begin) */
        redraw(full: boolean): void;
        /** a linha de digitacao: card + caret + cauda + placeholder */
        line(placeholder?: string): void;
        chips(labels: string[]): void;
        chip(): string | null;
        close(): void;
    };
}
