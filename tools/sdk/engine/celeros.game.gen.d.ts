// game.gen.d.ts — tipos do modulo CelerGame GEN (celeros.game.gen), que
// decora o core (celeros.game.d.ts) com E.gen. Inclua os dois.

declare namespace E {
    /** grade de caracteres: grid[r][c] */
    type CharGrid = string[][];
    interface GenRoom { x: number; y: number; w: number; h: number; cx: number; cy: number }
    interface GenOpts { rnd?: () => number; wall?: string; floor?: string }
    const gen: {
        version: string;
        grid(cols: number, rows: number, ch: string): CharGrid;
        /** grade -> linhas (E.level.parse) */
        lines(grid: CharGrid): string[];
        /** salas sem sobrepor + corredores em L ligando todas */
        rooms(cols: number, rows: number, o?: GenOpts & { rooms?: number; min?: number; max?: number; tries?: number }):
            { grid: CharGrid; rooms: GenRoom[] };
        /** automato celular; keep (default true) mantem so a maior regiao */
        cave(cols: number, rows: number, o?: GenOpts & { fill?: number; steps?: number; keep?: boolean }):
            { grid: CharGrid; open: number };
        /** so a maior regiao 4-conexa de pass; o resto vira fillCh. Devolve o tamanho */
        keepLargest(g: CharGrid, pass: (ch: string) => boolean, fillCh: string): number;
        /** labirinto perfeito (dimensoes pares crescem 1); loops 0..1 abre atalhos */
        maze(cols: number, rows: number, o?: GenOpts & { loops?: number }):
            { grid: CharGrid; cols: number; rows: number };
        /** espalha n ch sobre o.on (default '.'), minDist entre eles */
        scatter(g: CharGrid, ch: string, n: number, o?: { rnd?: () => number; on?: string; minDist?: number }):
            { c: number; r: number }[];
        findAll(g: CharGrid, ch: string): { c: number; r: number }[];
    };
}
