// game.level.d.ts — tipos do modulo CelerGame LEVEL (celeros.game.level),
// que decora o core (celeros.game.d.ts) com E.level. Inclua os dois.

declare namespace E {
    interface Spawn { type: string; c: number; r: number; x: number; y: number; ch: string }
    interface Level {
        cols: number; rows: number; cell: number; ox: number; oy: number;
        /** cenario por celula (plano) — vai direto no E.tilemap({data}) */
        data: any[];
        spawns: Spawn[];
        meta: any;
        get(c: number, r: number): any;
        find(type: string): Spawn | null;
        all(type: string): Spawn[];
        /** factories[tipo](spawn) -> entidade; devolve as criadas */
        spawn(factories: Record<string, (s: Spawn) => any>): any[];
        /** E.tilemap pronto da fase (precisa de celeros.game.tilemap) */
        tilemap(o: { paint: (c: number, r: number, x: number, y: number, w: number, h: number) => void;
                     solid?: (v: any, c: number, r: number) => boolean; outside?: boolean }): Tilemap;
    }
    interface Progress {
        list: any[];
        cur: number;
        unlocked: number;
        def(): any;
        isLast(): boolean;
        go(i: number): boolean;
        /** avanca e desbloqueia (salvo); false no fim */
        next(): boolean;
        /** guarda a nota se melhorou; sem n le */
        stars(i: number, n?: number): number | boolean;
        /** fim de fase: guarda estrelas e desbloqueia a seguinte; true se ha proxima */
        complete(i?: number, stars?: number): boolean;
        /** soma das estrelas */
        totalStars(): number;
        reset(): void;
    }
    const level: {
        version: string;
        /** ASCII + legenda: valor = tile; {spawn, tile} = entidade. Caractere fora da legenda lanca com linha/coluna. */
        parse(lines: string[] | string, o?: {
            legend?: Record<string, any>; cell?: number; ox?: number; oy?: number;
            pad?: string; meta?: any;
        }): Level;
        progress(list: any[], o?: { save?: string }): Progress;
    };
}
