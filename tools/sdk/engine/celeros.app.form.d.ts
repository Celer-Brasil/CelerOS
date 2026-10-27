// app.form.d.ts — tipos do CelerKit FORM (celeros.app.form), que decora o
// core (celeros.app.d.ts) com A.form. Inclua os dois no editor.

declare namespace A {
    type FormRow = any;   // linha crua do UI.list tambem vale
    const form: {
        version: string;
        info(label: string, value: any, color?: number): FormRow;
        action(label: string, cb: () => any, o?: { sub?: string }): FormRow;
        toggle(label: string, get: () => any, set: (v: boolean) => void): FormRow;
        choice(label: string, get: () => number, set: (n: number) => void, opts: string[]): FormRow;
        picker(label: string, get: () => number, set: (n: number) => void, items: string[]): FormRow;
        secao(title: string): FormRow;
        /** medidor inline (barra); o pintor rico e celeros.app.rows */
        gauge(label: string, get: () => number,
              o?: { min?: number; max?: number; fmt?: (v: number) => string; color?: number }): FormRow;
        /** - valor + (botoes nativos no pintor rico) */
        stepper(label: string, get: () => number, set: (n: number) => void,
                o?: { min?: number; max?: number; step?: number; fmt?: (v: number) => string }): FormRow;
        /** agrupa rows num bloco com titulo: [secao, ...rows] */
        card(title: string, rows: FormRow[]): FormRow[];
        /** tela de ajustes BLOQUEANTE; rows reconstruidas apos cada acao.
         *  Usa A.list.view + A.rows.formRow quando adotados; cai no UI.list. */
        run(title: string, build: () => FormRow[]): void;
        /** seletor BLOQUEANTE; indice escolhido ou -1 se voltou */
        pick(title: string, items: string[], selected?: number): number;
        askText(title: string, o?: { hint?: string; mask?: boolean; initial?: string }): string | null;
        /** numero validado na faixa; null se cancelou */
        askNum(title: string, o?: { min?: number; max?: number; hint?: string; initial?: string; int?: boolean }): number | null;
    };
}
