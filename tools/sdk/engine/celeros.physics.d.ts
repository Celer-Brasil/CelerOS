// celeros.physics.d.ts — tipos da dep celeros.physics (P.hit, verlet,
// verletFast nativo, corpo rigido API 33). Dep do hub (app.json "deps"):
// "celeros.physics": "^2.0.0". Entra tambem no celeros.engine.d.ts.

declare namespace P {
    const version: string;
    interface Vec { x: number; y: number }
    /** formas para o P.hit: circulo tem r, caixa tem w/h (x,y = centro) */
    interface Body {
        x: number; y: number;
        r?: number;
        w?: number; h?: number;
        [k: string]: any;
    }
    function hit(a: Body, b: Body): boolean;
    interface VerletPoint { x: number; y: number; px?: number; py?: number; pin?: boolean; [k: string]: any }
    interface VerletStick { a: number; b: number; len?: number }
    interface Verlet {
        points: VerletPoint[];
        sticks: VerletStick[];
        iterations: number;
        stick(a: number, b: number, len?: number): VerletStick;
        stickLen(s: VerletStick): number;
        pin(i: number, on?: boolean): void;
        step(dt: number, o?: { gravity?: Vec; damp?: number;
                               bounds?: { x: number; y: number; w: number; h: number };
                               bounce?: number }): void;
    }
    function verlet(opts?: {
        points?: VerletPoint[];
        sticks?: VerletStick[];
        iterations?: number;
    }): Verlet;
    /** verlet por INDICE em arrays planos (xy()[2i], xy()[2i+1]). NATIVO na
     *  API 31+ (System.verlet*, w.native === true); sem o binding roda o
     *  P.verlet JS com a mesma interface (sem colisao ponto-ponto). */
    interface VerletFast {
        native: boolean;
        id: number;
        step(dt: number, o?: { gravity?: Vec; damp?: number;
                               bounds?: { x: number; y: number; w: number; h: number };
                               bounce?: number }): void;
        xy(): number[];
        sticks(): number[];
        add(x: number, y: number): number;
        stick(a: number, b: number, len?: number): void;
        pin(i: number, on?: boolean): void;
        set(i: number, x: number, y: number): void;
        count(): number;
        delStick(i: number): boolean;
        delPoint(i: number): boolean;
        pins(): number[];
        free(): void;
    }
    function verletFast(opts?: { iterations?: number; radius?: number }): VerletFast;
    /** Corpo rigido nativo (API 33). Indices estaveis; state() = [x, y, ang, hit, rapidez, flags] por indice. */
    interface RigidOpts { static?: boolean; density?: number; friction?: number; bounce?: number; angle?: number }
    interface Rigid {
        id: number;
        /** numeros por corpo no array do state() (6) */
        N: number;
        box(x: number, y: number, w: number, h: number, o?: RigidOpts): number;
        circle(x: number, y: number, r: number, o?: RigidOpts): number;
        remove(i: number): boolean;
        set(i: number, x: number, y: number, angle?: number, vx?: number, vy?: number, w?: number): boolean;
        impulse(i: number, jx: number, jy: number): boolean;
        /** devolve os sub-passos rodados */
        step(dt: number, o?: { gravity?: Vec; maxSub?: number }): number;
        /** o MESMO array a cada chamada (2.1: preenchido no lugar) — copie com slice() para guardar um quadro */
        state(): number[];
        count(): number;
        x(i: number, s: number[]): number;
        y(i: number, s: number[]): number;
        angle(i: number, s: number[]): number;
        hit(i: number, s: number[]): number;
        speed(i: number, s: number[]): number;
        alive(i: number, s: number[]): boolean;
        awake(i: number, s: number[]): boolean;
        free(): void;
    }
    /** null em firmware sem System.rigidNew (API 33, placas S3). */
    function rigid(opts?: { iterations?: number }): Rigid | null;
}
