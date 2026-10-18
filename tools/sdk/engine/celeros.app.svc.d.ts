// app.svc.d.ts — tipos do CelerKit SVC (celeros.app.svc), que decora o core
// (celeros.app.d.ts) com A.svc. VENDORED em apps com service.js (servicos
// nao carregam a tabela de deps). Inclua os dois no editor.

declare namespace A {
    interface Svc {
        key: string;
        /** ticks que trabalharam */
        ticks: number;
        erros: number;
        /** true quando passou a cadencia ms */
        tick(ms: number): boolean;
        /** null = pode; 'app'|'ota'|'shell' = deixe para la */
        blocked(): string | null;
        /** drena com cap (burst nao estrela o pump); devolve n processados */
        drain<T>(pollFn: () => T, cap: number, cb: (m: T) => void): number;
        load(): any;
        save(): boolean;
        state(): any;
        /** notifica UMA vez por chave; true se notificou agora */
        notifyOnce(chave: string, msg: string): boolean;
        resetOnce(chave: string): void;
        error(chave?: string, msg?: string): boolean;
    }
    const svc: {
        version: string;
        new(o: { key: string }): Svc;
    };
}
