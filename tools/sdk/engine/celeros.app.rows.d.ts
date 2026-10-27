// app.rows.d.ts — tipos do CelerKit ROWS (celeros.app.rows): o pintor de
// linha rico do A.form no A.list.view. Opcional fora do kit; use com
// celeros.app.form + celeros.app.style.

declare namespace A {
    interface RowsRowState {
        pressed: boolean;
        disabled: boolean;
        selected: boolean;
    }
    const rows: {
        version: string;
        /** pintor de linha do form (toggle/gauge/stepper/choice/picker/info) */
        formRow(r: any, x: number, y: number, w: number, h: number,
                state: RowsRowState): void;
    };
}
