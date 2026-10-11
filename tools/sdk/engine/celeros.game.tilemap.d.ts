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
    }
    /** Grade com repintura suja: paint(c, r, x, y, w, h) desenha uma celula. */
    const tilemap: {
        version: string;
        (o: {
            cols: number; rows: number; cell?: number; cw?: number; ch?: number;
            ox?: number; oy?: number;
            paint: (c: number, r: number, x: number, y: number, w: number, h: number) => void;
        }): Tilemap;
    };
}
