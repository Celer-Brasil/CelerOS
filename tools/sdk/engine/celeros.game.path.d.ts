// game.path.d.ts — tipos do modulo CelerGame PATH (celeros.game.path),
// que decora o core (celeros.game.d.ts) com E.path. Inclua os dois.

declare namespace E {
    interface Cell { c: number; r: number }
    interface PathFollower {
        obj: { x: number; y: number };
        path: Cell[];
        /** indice do ponto alvo */
        i: number;
        speed: number;
        done: boolean;
        /** voltas completas (loop/pingpong) */
        laps: number;
        /** 1 indo, -1 voltando (pingpong) */
        dir: number;
        set(path: Cell[] | null): void;
        /** centro em px do ponto alvo, ou null */
        target(): { x: number; y: number } | null;
        /** anda; true ao chegar no fim */
        update(dt: number): boolean;
    }
    const path: {
        version: string;
        /** nos expandidos na ultima busca */
        expanded: number;
        /** A*: cost(c, r) = custo de entrar (< 0 = parede). null sem caminho / orcamento estourado. */
        find(cols: number, rows: number, c0: number, r0: number, c1: number, r1: number,
             cost: (c: number, r: number) => number,
             opts?: { diag?: boolean; max?: number; near?: boolean }): Cell[] | null;
        /** linha de visao entre celulas (as pontas nao contam); strict = diagonal exige os dois lados livres */
        los(c0: number, r0: number, c1: number, r1: number,
            blocked: (c: number, r: number) => boolean, strict?: boolean): boolean;
        /** mapa de distancias ate (c1, r1) com o mesmo cost do find: next(c, r) da o passo (objeto reaproveitado) */
        flow(cols: number, rows: number, c1: number, r1: number,
             cost: (c: number, r: number) => number, opts?: { diag?: boolean }): {
            dist(c: number, r: number): number;
            next(c: number, r: number): Cell | null;
        };
        /** corta os degraus mantendo so as quebras de visao */
        smooth(path: Cell[] | null, blocked: (c: number, r: number) => boolean): Cell[] | null;
        /** adaptador do tilemap: {cols, rows, cost, blocked} */
        grid(tm: Tilemap, opts?: { cost?: (v: any, c: number, r: number) => number }): {
            cols: number; rows: number;
            cost: (c: number, r: number) => number;
            blocked: (c: number, r: number) => boolean;
        };
        /** anda obj (px) pelos centros das celulas a speed px/s */
        follower(obj: { x: number; y: number }, path: Cell[] | null, speed?: number,
                 o?: { cell?: number; ox?: number; oy?: number;
                       /** volta ao 1o ponto */
                       loop?: boolean;
                       /** vai e volta */
                       pingpong?: boolean }): PathFollower;
    };
}
