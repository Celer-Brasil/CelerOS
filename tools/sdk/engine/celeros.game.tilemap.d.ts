// game.tilemap.d.ts — tipos do modulo CelerGame TILEMAP
// (celeros.game.tilemap), que decora o core (celeros.game.d.ts) com
// E.tilemap. Inclua os dois.

declare namespace E {
    interface Tilemap {
        cols: number; rows: number; cw: number; ch: number; ox: number; oy: number;
        mark(c: number, r: number): void;
        markRect(x: number, y: number, w: number, h: number): void;
        all(): void;
        dirty(): number;
        flush(): number;
        cellAt(x: number, y: number): { c: number; r: number } | null;
        /** rect da celula em pixels (scratch reaproveitado: copie se guardar) */
        cellRect(c: number, r: number): { x: number; y: number; w: number; h: number };
        /** valor da celula (undefined fora da grade / sem data) */
        get(c: number, r: number): any;
        /** muda o valor e marca a celula p/ o proximo flush; false fora da grade */
        set(c: number, r: number, v: any): boolean;
        each(fn: (c: number, r: number, v: any) => void): void;
        /** preenche o retangulo de celulas (marca o que mudou) */
        fill(c: number, r: number, w: number, h: number, v: any): void;
        /** celulas com valor v (ou fn true) */
        find(v: any): { c: number; r: number }[];
        /** mascara 0..15 dos vizinhos iguais: 1 cima, 2 direita, 4 baixo, 8 esquerda */
        autotile(c: number, r: number, same?: (v: any, viz: any) => boolean): number;
        /** fn por vizinho dentro da grade (4, ou 8 com diag) */
        neighbors(c: number, r: number, fn: (c: number, r: number, v: any) => void, diag?: boolean): void;
        /** ponto em pixels numa celula solida (o.solid ou valor truthy; fora = o.outside) */
        solidAt(x: number, y: number): boolean;
        /** caixa em pixels toca alguma celula solida */
        rectSolid(x: number, y: number, w: number, h: number): boolean;
    }
    /** Grade com repintura suja: paint(c, r, x, y, w, h) desenha uma celula. */
    const tilemap: {
        version: string;
        (o: {
            cols: number; rows: number; cell?: number; cw?: number; ch?: number;
            ox?: number; oy?: number;
            paint: (c: number, r: number, x: number, y: number, w: number, h: number) => void;
            /** valores: plano (cols*rows) ou linhas ([r][c] ou strings) */
            data?: any[];
            /** valor solido? (default: truthy) */
            solid?: (v: any, c: number, r: number) => boolean;
            /** fora da grade conta como solido (default true) */
            outside?: boolean;
        }): Tilemap;
    };
}
