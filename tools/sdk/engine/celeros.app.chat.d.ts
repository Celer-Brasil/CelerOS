// app.chat.d.ts — tipos do CelerKit CHAT (celeros.app.chat), que decora o
// core (celeros.app.d.ts) com A.chat. Inclua os dois no editor.

declare namespace A {
    interface Transcript {
        /** baloes em vista: {k:'user'|'assistant'|'note', s, c?, bw, h} */
        view: any[];
        /** true = balao "pensando" com spinner no fim */
        busy: boolean;
        max: number;
        bw: number;
        top: number;
        /** altura do conteudo (atualizada no draw) */
        height: number;
        /** novo balao cru (k: 'user'|'assistant'|'note') */
        push(k: string, s: string, color?: number): void;
        user(s: string): void;
        bot(s: string): void;
        note(s: string, color?: number): void;
        err(s: string): void;
        clear(): void;
        /** desenha na area (0,top)..(W,top+h); devolve a altura do conteudo */
        draw(full: boolean, h?: number): number;
    }
    const chat: {
        version: string;
        /** o = { max (60), bw (180), top (4), pad (8) } */
        new(o?: { max?: number; bw?: number; top?: number; pad?: number }): Transcript;
    };
}
