// app.list.d.ts — tipos do CelerKit LIST (celeros.app.list), que decora o
// core (celeros.app.d.ts) com A.list. Inclua os dois no editor.

declare namespace A {
    interface CachedList<T> {
        /** linhas do cache (build() so roda quando o stamp muda) */
        rows(): T[];
        /** dados mudaram: proxima chamada reconstrói */
        drop(): void;
    }
    interface ListRow {
        label?: string;
        value?: any;
        sub?: string;
        /** nome em A.icons (ex. "wifi") */
        icon?: string;
        right?: string | number;
        rightColor?: number;
        badge?: string | number;
        badgeColor?: number;
        /** 0..4 barras de sinal */
        bars?: number;
        disabled?: boolean;
        color?: number;
        /** cabecalho nao selecionavel */
        section?: boolean | string;
        header?: boolean | string;
        /** linha de secao do A.form */
        k?: string;
    }
    interface ListViewOpts {
        /** altura da linha (default 36) */
        row?: number;
        /** desenha o painel em volta (default true) */
        panel?: boolean;
        panelBg?: number;
        rowBg?: number;
        pad?: number;
        r?: number;
        rowR?: number;
        stroke?: boolean;
        selected?: number;
        /** painter da linha inteira (sem o cabecalho de secao) */
        paintRow?: (item: ListRow, x: number, y: number, w: number, h: number,
                    state: { pressed: boolean; disabled: boolean; selected: boolean }) => void;
        /** widget nativo por linha (ex. UI.toggle); se consumir o tap a linha nao dispara */
        widget?: (item: ListRow, x: number, y: number, w: number, h: number) => void;
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
        /** lista RICA (icone/secao/sub/badge/painter/widget): devolve o indice tocado */
        view(id: string, x: number, y: number, w: number, h: number,
             items: (string | ListRow)[], o?: ListViewOpts): number;
    };
}
