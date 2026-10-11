// engine.d.ts — tipos do pacote celeros.engine: a familia CelerGame
// MONTADA (core + fx + spr + tilemap) + physics. Apps novos adotam os
// modulos um a um (celeros.game.d.ts + os d.ts dos modulos usados);
// este arquivo e a uniao completa, para quem require("celeros.engine").

declare namespace E {
    const version: string;
    /** Recursos da placa/firmware detectados no init(). */
    interface Caps {
        psram: boolean;
        speaker: boolean;
        music: boolean;      // playMusic (API 25)
        png: boolean;        // drawPNG
        sprites: boolean;    // createSprite
        smooth: boolean;     // fillSmoothCircle (API 22)
        round: boolean;      // fillSmoothRoundRect (API 22)
        gradient: boolean;   // fillGradient (API 22)
        arc: boolean;        // fillArc (API 22)
        wide: boolean;       // drawWideLine/mixColor (API 22)
        slots: number;       // limite do pool (spriteSlots, API 29; 4 em firmware velho)
        mix: boolean;        // System.sfx: efeito misturado sem bloquear (API 32)
        clip: boolean;       // setClip/clearClip
        button: boolean;     // System.button (botao fisico)
        big: boolean;        // tela fisica >= 400 px (firmware promove as fontes)
        native: boolean;     // canvas nativo ativo (API 28)
        w: number;
        h: number;
    }
    interface InitOpts {
        fps?: number;        // alvo de frames (default 30; 0 = sem teto)
        native?: boolean;    // canvas nativo (pixels fisicos, sem topbar)
        keepAwake?: boolean; // default true durante o run
        save?: string;       // prefixo das chaves no Storage NVS
        dir?: string;        // nome da pasta do app (base dos assets)
        bases?: string[];    // prefixos alternativos p/ E.spr.load
        particles?: number;  // tamanho do pool de particulas (default 96)
    }

    const caps: Caps;
    const theme: CelerTheme | null;
    let W: number;
    let H: number;
    /** Escala do projeto: min(W, H) / 240 (1 no virtual, 2 no 480 nativo). */
    let U: number;
    /** Medida do projeto (240 de largura) em pixels da tela atual. */
    function u(v: number): number;
    interface FontPick { font: number; size: number; h: number }
    /** Maior fonte (1/2/4 x textSize) cuja altura cabe em px. */
    function font(px: number): FontPick;
    /** Alturas de texto por papel, em px do projeto (o text escala por U). */
    const ts: { tiny: number; small: number; body: number; label: number;
                big: number; title: number; huge: number; [k: string]: number };
    let dt: number;
    let fps: number;
    let fpsTarget: number;
    const data: Record<string, any>;
    let sceneName: string;

    function init(opts?: InitOpts): Caps;

    // ------------------------------------------------------------- input --
    interface Input {
        x: number;
        y: number;
        down: boolean;
        justDown: boolean;
        justUp: boolean;
        moved: boolean;
        dx: number;
        dy: number;
        holdDx: number;
        holdDy: number;
        tap: { x: number; y: number } | null;
        swipe: { dir: 'left' | 'right' | 'up' | 'down'; dx: number; dy: number; dist: number } | null;
        longpress: boolean;
        btn: number;         // 0 nada, 1 curto, 2 longo (devkit)
        dragThresh: number;
        tapMs: number;
        swipeMin: number;
        longMs: number;
    }
    const input: Input;
    interface Rect { x: number; y: number; w: number; h: number }
    function hit(b: Rect): boolean;
    function press(b: Rect): boolean;

    // ----------------------------------------------------- cenas e loop --
    interface Scene {
        fps?: number;        // sobrepoe o alvo global nesta cena (0 = sem teto)
        /** Desenha so na entrada, no E.redraw() e quando o dedo entra/sai de um E.gfx.button. */
        static?: boolean;
        enter?: () => void;
        update?: (dt: number) => void;
        draw?: () => void;
        exit?: () => void;
    }
    function run(scenes: Record<string, Scene>, first: string): void;
    function goto(name: string): void;
    function quit(): void;
    /** Cena static: agenda um draw (o estado mudou). */
    function redraw(): void;

    // ------------------------------------------------- camada suja ------
    const dirty: {
        /** true enquanto ligada (desliga sozinha na troca de cena). */
        on: boolean;
        /** Liga: fundo = cor RGB565 ou painter(x, y, w, h). 1o quadro repinta tudo. */
        enable(bg?: number | ((x: number, y: number, w: number, h: number) => void)): any;
        off(): void;
        /** Proximo quadro repinta o fundo inteiro. */
        full(): void;
        /** Recorte da area de jogo (o HUD fica de fora); sem args remove. */
        clip(x?: number, y?: number, w?: number, h?: number): void;
        /** Solta o recorte no meio do draw (desenhar o HUD). */
        unclip(): void;
        /** Registra caixa de TELA desenhada por System.* direto. */
        add(x: number, y: number, w: number, h: number): void;
        /** Apaga JA o rect (fundo/painter) e registra a caixa (1.2.4): desenho PARADO que vai se mexer. Chame no inicio do draw. */
        erase(x: number, y: number, w: number, h: number): void;
        /** Alguma caixa apagada/desenhada agora toca o rect? */
        touches(x: number, y: number, w: number, h: number): boolean;
    };
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
    function tilemap(o: {
        cols: number; rows: number; cell?: number; cw?: number; ch?: number;
        ox?: number; oy?: number;
        paint: (c: number, r: number, x: number, y: number, w: number, h: number) => void;
    }): Tilemap;

    // -------------------------------------------------- timers e tweens --
    interface Timer { dead: boolean }
    interface Tween { dead: boolean }
    function after(ms: number, fn: () => void): Timer;
    function every(ms: number, fn: () => void): Timer;
    function cancel(t: Timer | Tween): void;
    function clearTimers(): void;
    function clearTweens(): void;
    function tween(obj: any, to: Record<string, number>, ms: number,
                   opts?: { ease?: (t: number) => number; delay?: number;
                            onDone?: () => void }): Tween;

    // ------------------------------------------------ grupos e pools -----
    interface Entity {
        dead?: boolean;
        update?: (dt: number) => void;
        draw?: () => void;
        [k: string]: any;
    }
    interface Group {
        items: Entity[];
        count: number;
        add(o: Entity): Entity;
        update(dt: number): void;
        draw(): void;
        each(fn: (o: Entity) => void): void;
        clear(): void;
    }
    function group(): Group;
    interface Pool extends Omit<Group, 'add'> {
        spawn(): Entity | null;
        alive: number;
    }
    function pool(n: number, factory: (i: number) => Entity): Pool;

    // ------------------------------------------------------------ math --
    const m: {
        clamp(v: number, a: number, b: number): number;
        lerp(a: number, b: number, t: number): number;
        map(v: number, a: number, b: number, c: number, d: number): number;
        rand(a?: number, b?: number): number;
        randInt(a: number, b: number): number;
        pick<T>(arr: T[]): T;
        dist(x0: number, y0: number, x1: number, y1: number): number;
        dist2(x0: number, y0: number, x1: number, y1: number): number;
        ang(x0: number, y0: number, x1: number, y1: number): number;
        approach(v: number, target: number, delta: number): number;
        wrap(v: number, a: number, b: number): number;
        sign(v: number): number;
        linear(t: number): number;
        inQuad(t: number): number;
        outQuad(t: number): number;
        inOutQuad(t: number): number;
        outBack(t: number): number;
    };
    function rng(seed: number): () => number;

    // --------------------------------------------------------- sprites --
    interface SpriteDef {
        name: string;
        file?: string;        // <base>/<file>.png (bases do init)
        w: number;
        h: number;
        paint?: (w: number, h: number, x: number, y: number) => void;
    }
    interface SpriteSlot { id: number; w: number; h: number; paint: SpriteDef['paint'] | null }
    const spr: {
        bases: string[];
        load(defs: SpriteDef[], opts?: { bases?: string[] }): Record<string, SpriteSlot>;
        has(name: string): boolean;
        /** true se esta num slot real (blit com cor-chave); false = painter */
        backed(name: string): boolean;
        blit(name: string, x: number, y: number,
             opts?: { key?: number; cx?: boolean; cy?: boolean }): void;
        free(name: string): void;
        freeAll(): void;
    };
    interface Anim {
        i: number;
        done: boolean;
        tick(dt: number): void;
        draw(x: number, y: number, opts?: { key?: number }): void;
    }
    function anim(frames: (string | ((x: number, y: number) => void))[],
                  fps?: number, loop?: boolean): Anim;

    // ---------------------------------------------------------- camera --
    const cam: {
        x: number;
        y: number;
        ox: number;
        oy: number;
        bounds: Rect | null;
        follow(target: { x: number; y: number }, lerp?: number): void;
        shake(pow: number, dur: number): void;
        center(x: number, y: number): void;
        reset(): void;
        wx(x: number): number;
        wy(y: number): number;
    };

    // ------------------------------------------------------------ gfx --
    interface DrawOpts { screen?: boolean; fill?: boolean; r?: number }
    interface TextOpts {
        color?: number; bg?: number;
        /** altura em pixels (escolhe fonte/size) */
        px?: number;
        /** papel em E.ts (escala com E.U) */
        ts?: 'tiny' | 'small' | 'body' | 'label' | 'big' | 'title' | 'huge';
        size?: number; font?: number;
        /** largura maxima: encolhe ate caber */
        fit?: number;
        align?: 'left' | 'center' | 'right';
        valign?: 'top' | 'middle' | 'bottom'; screen?: boolean;
    }
    const gfx: {
        rect(x: number, y: number, w: number, h: number, color: number, o?: DrawOpts): void;
        circle(x: number, y: number, r: number, color: number,
               o?: DrawOpts & { smooth?: boolean }): void;
        line(x0: number, y0: number, x1: number, y1: number, color: number,
             o?: DrawOpts & { w?: number }): void;
        tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
            color: number, o?: DrawOpts): void;
        gradient(x: number, y: number, w: number, h: number, c1: number, c2: number,
                 o?: DrawOpts & { dir?: 'x' | 'y' }): void;
        arc(x: number, y: number, r0: number, r1: number, a0: number, a1: number,
            color: number, o?: DrawOpts): void;
        text(str: any, x: number, y: number, o?: TextOpts): void;
        /** Largura em pixels com as mesmas opts do text(). */
        measure(str: any, o?: TextOpts): number;
        button(label: string, x: number, y: number, w: number, h: number, o?: {
            primary?: boolean; color?: number; bg?: number; r?: number; font?: number;
            px?: number; textColor?: number; stroke?: number | false; screen?: boolean;
        }): Rect;
        bar(x: number, y: number, w: number, h: number, frac: number, o?: {
            fg?: number; bg?: number; r?: number; screen?: boolean;
        }): void;
        panel(x: number, y: number, w: number, h: number, o?: {
            bg?: number; stroke?: number; r?: number; screen?: boolean;
        }): void;
    };

    // ------------------------------------------------------------- fx --
    const fx: {
        burst(x: number, y: number, o?: {
            n?: number; color?: number; colors?: number[];
            speed?: number; speed2?: number; angle?: number; spread?: number;
            life?: number; size?: number; grav?: number; drag?: number;
            shape?: 'dot' | 'spark' | 'ring';
        }): void;
        popText(x: number, y: number, str: any, o?: {
            color?: number; life?: number; font?: number; px?: number;
            ts?: TextOpts['ts']; screen?: boolean;
        }): void;
        /** Brilho na borda (default) ou tela cheia com {full: true}. */
        flash(color: number, ms?: number, o?: { full?: boolean }): void;
        /** onda de choque: anel que expande (speed px/s) e some */
        ring(x: number, y: number, o?: {
            r0?: number; speed?: number; color?: number; life?: number;
        }): void;
        stars(n: number, o?: {
            w?: number; h?: number; vy?: number; color?: number;
            colors?: number[];
            /** move 1/N das estrelas por quadro (velocidade media preservada) */
            stride?: number;
        }): {
            update(dt: number): void;
            draw(): void;
        };
        draw(): void;
    };

    // ----------------------------------------------------------- audio --
    const audio: {
        muted: boolean;
        sfxOverMusic: boolean;
        sfxTable: Record<string, number[] | number[][]>;
        music(song: {
            bpm?: number; loops?: number;
            tracks: { wave?: 'sq' | 'sq25' | 'tri' | 'saw'; drum?: boolean;
                      vol?: number; notes: number[][] }[];
        }, opts?: { startMs?: number }): boolean;
        stop(): void;
        playing(): boolean;
        beat(): number;      // -1 sem musica
        /** Misturado por cima da trilha sem bloquear (API 32); playTone em firmware velho. */
        sfx(what: string | number[] | number[][]): void;
        /** Abafa a trilha por ms (sfx alto rouba o canal) e retoma sozinho. No-op com caps.mix. */
        duck(ms: number): boolean;
        mute(on: boolean): void;
        volume(v: number): void;
    };

    // ------------------------------------------------------------ save --
    const save: {
        prefix: string;
        get(key: string, def?: string): string;
        set(key: string, val: any): void;
        num(key: string, def?: number): number;
        best(key: string, score: number): boolean;
    };
}

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
