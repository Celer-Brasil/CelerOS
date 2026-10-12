// game.d.ts — tipos do CelerGame CORE (celeros.game): loop de cenas,
// input, gfx, camera, matematica, timers/tweens, entidades, camada suja,
// audio e save. Os modulos da familia (celeros.game.fx/spr/tilemap)
// adicionam seus proprios d.ts sobre este — o pacote celeros.engine
// monta tudo (celeros.engine.d.ts). Vendorizado no app por
// `celer.js new --game`.

declare namespace E {
    const version: string;
    /** Modulos CelerGame carregados (["fx", "spr", ...]). */
    const _mods: string[];
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
        bases?: string[];    // prefixos alternativos p/ E.spr.load (modulo spr)
        particles?: number;  // tamanho do pool de particulas (modulo fx)
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
    /** Troca de cena; opts = {transition: 'fade'|'iris'|'wipe'|'bands', ms, color, dir} desenha um veu.
     *  Sem opts no meio de um fade: a troca e seca e o veu que fechava e descartado (nunca fica pendurado). */
    function goto(name: string, opts?: {
        transition?: 'fade' | 'iris' | 'wipe' | 'bands';
        ms?: number;
        color?: number;
        /** direcao do wipe (default 'left') */
        dir?: 'left' | 'right' | 'up' | 'down';
    }): void;
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
        /** Recorte da area de jogo (o HUD fica de fora); sem args remove. O veu de
         *  transicao cobre a tela INTEIRA: no fim dele a engine repinta tambem a
         *  faixa de fora do recorte com o fundo — o HUD em si e do jogo, cujo memo
         *  deve incluir E.dirty.touches(caixaDoHud). */
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

    // -------------------------------------------------- timers e tweens --
    interface Timer { dead: boolean }
    interface Tween { dead: boolean }
    function after(ms: number, fn: () => void): Timer;
    function every(ms: number, fn: () => void): Timer;
    function cancel(t: Timer | Tween): void;
    function clearTimers(): void;
    function clearTweens(): void;
    /** Tween de props numericas. Dois tweens na MESMA prop: o mais antigo
     *  vence (escreve por cima a cada quadro — o tick percorre a lista de
     *  tras pra frente); cancele o antigo antes de retweenar. */
    function tween(obj: any, to: Record<string, number>, ms: number,
                   opts?: { ease?: (t: number) => number; delay?: number;
                            onDone?: () => void }): Tween;
    interface SeqStep {
        to?: Record<string, number>;
        ms?: number;
        ease?: (t: number) => number;
        delay?: number;
        /** passos que rodam JUNTOS (o seq espera o mais longo) */
        par?: SeqStep[];
    }
    interface Seq {
        dead: boolean;
        done: boolean;
        step: number;
        cancel(): void;
    }
    /** Timeline de tweens no mesmo obj: passos em ordem, {par:[...]} em paralelo. */
    function seq(obj: any, steps: SeqStep[], opts?: { onDone?: () => void }): Seq;

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
