// game.collide.d.ts — tipos do modulo CelerGame COLLIDE
// (celeros.game.collide), que decora o core (celeros.game.d.ts) com
// E.collide. Inclua os dois.

declare namespace E {
    /** retangulo {x, y, w, h} (canto) ou circulo {x, y, r} (centro) */
    interface Shape { x: number; y: number; w?: number; h?: number; r?: number; [k: string]: any }
    interface SpatialHash {
        count: number;
        add(o: Shape): void;
        clear(): void;
        /** fn(o) por candidato que COLIDE (1x cada); fn devolvendo true para. Devolve quantos */
        query(q: Shape, fn?: (o: Shape) => boolean | void): number;
        /** cada par que colide uma vez so */
        pairs(list: Shape[], fn: (a: Shape, b: Shape) => void): void;
    }
    interface MoveResult { hitX: boolean; hitY: boolean; ground: boolean; ceil: boolean; dx: number; dy: number }
    const collide: {
        version: string;
        rect(a: Rect, b: Rect): boolean;
        circle(a: { x: number; y: number; r: number }, b: { x: number; y: number; r: number }): boolean;
        circleRect(c: { x: number; y: number; r: number }, b: Rect): boolean;
        point(x: number, y: number, b: Shape): boolean;
        /** qualquer combinacao rect/circulo */
        test(a: Shape, b: Shape): boolean;
        /** menor empurrao que tira a de dentro de b, ou null */
        push(a: Rect, b: Rect): { x: number; y: number } | null;
        /** fracao 0..1 do 1o toque do segmento no retangulo, ou -1 */
        segRect(x0: number, y0: number, x1: number, y1: number, b: Rect): number;
        hash(cell?: number): SpatialHash;
        /** move-and-slide contra {rectSolid, cw, ch} (tilemap); zera vx/vy no eixo que bateu */
        move(b: Rect & { vx?: number; vy?: number }, dx: number, dy: number,
             map: { rectSolid(x: number, y: number, w: number, h: number): boolean; cw?: number; ch?: number }): MoveResult;
    };
}
