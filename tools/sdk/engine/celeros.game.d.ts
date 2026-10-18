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
        /** overlay de fps/ms/caixas sujas no canto (E.debug) */
        debug?: boolean;
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
    /** ms gastos no ultimo quadro (update + draw) */
    let frameMs: number;
    /** overlay de diagnostico: fps, ms do quadro, caixas sujas, particulas */
    let debug: boolean;
    /** escala o dt do update/fx/camera (0.3 = camera lenta); timers e tweens seguem o relogio */
    let timeScale: number;
    /** true durante E.pause(true) */
    let paused: boolean;
    /** Pausa do jogo (sem arg alterna): update recebe dt 0, fx/camera/timers/tweens
     *  congelam e o draw segue (desenhe o E.ui.pause por cima). Devolve o estado. */
    function pause(on?: boolean): boolean;
    let fpsTarget: number;
    const data: Record<string, any>;
    let sceneName: string;
    /** true enquanto um veu de E.goto esta ativo (cena static nao repinta a toa). */
    let transitioning: boolean;

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
        /** 2o tap seco perto do 1o em menos de dblMs (o 3o recomeca) */
        doubleTap: { x: number; y: number } | null;
        swipe: { dir: 'left' | 'right' | 'up' | 'down'; dx: number; dy: number; dist: number } | null;
        longpress: boolean;
        btn: number;         // 0 nada, 1 curto, 2 longo (devkit)
        dragThresh: number;
        tapMs: number;
        swipeMin: number;
        longMs: number;
        dblMs: number;
        /** ms com o dedo pousado (0 solto) */
        heldMs: number;
    }
    const input: Input;
    interface Rect { x: number; y: number; w: number; h: number }
    /** Toque seco no rect; pad = folga em px em volta (alvo pequeno). */
    function hit(b: Rect, pad?: number): boolean;
    function press(b: Rect, pad?: number): boolean;

    // ----------------------------------------------------- cenas e loop --
    interface Scene {
        fps?: number;        // sobrepoe o alvo global nesta cena (0 = sem teto)
        /** Desenha so na entrada, no E.redraw() e quando o dedo entra/sai de um E.gfx.button. */
        static?: boolean;
        /** ao sair (goto/pop) mata os timers e tweens criados durante a cena */
        cleanup?: boolean;
        enter?: () => void;
        update?: (dt: number) => void;
        draw?: () => void;
        exit?: () => void;
        /** coberta por um E.push */
        pause?: () => void;
        /** descoberta pelo E.pop */
        resume?: () => void;
    }
    function run(scenes: Record<string, Scene>, first: string): void;
    /** Troca de cena (cena inexistente lanca NA HORA, com a lista); opts = {transition: 'fade'|'iris'|'wipe'|'bands', ms, color, dir} desenha um veu.
     *  Sem opts no meio de um fade: a troca e seca e o veu que fechava e descartado (nunca fica pendurado). */
    function goto(name: string, opts?: {
        transition?: 'fade' | 'iris' | 'wipe' | 'bands';
        ms?: number;
        color?: number;
        /** direcao do wipe (default 'left') */
        dir?: 'left' | 'right' | 'up' | 'down';
    }): void;
    function quit(): void;
    /** Abre a cena POR CIMA da atual (que recebe pause() e fica parada); pop() volta (resume()). */
    function push(name: string, opts?: Parameters<typeof goto>[1]): void;
    /** Volta a cena de baixo da pilha; false se a pilha esta vazia. */
    function pop(opts?: Parameters<typeof goto>[1]): boolean;
    /** Profundidade da pilha de cenas (0 = base). */
    function depth(): number;
    /** Cancela todo tween que mexe em obj; devolve quantos. */
    function killTweensOf(obj: any): number;
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
    /** Repete a cada ms; times = numero de disparos (sem = para sempre). */
    function every(ms: number, fn: () => void, times?: number): Timer;
    function cancel(t: Timer | Tween): void;
    function clearTimers(): void;
    function clearTweens(): void;
    /** Tween de props numericas. Dois tweens na MESMA prop: o mais antigo
     *  vence (escreve por cima a cada quadro — o tick percorre a lista de
     *  tras pra frente); cancele o antigo antes de retweenar. */
    function tween(obj: any, to: Record<string, number>, ms: number,
                   opts?: { ease?: (t: number) => number; delay?: number;
                            onDone?: () => void;
                            /** por quadro, com o progresso 0..1 */
                            onUpdate?: (obj: any, p: number) => void;
                            /** cada volta do repeat inverte o sentido */
                            yoyo?: boolean;
                            /** voltas extras (-1 = para sempre) */
                            repeat?: number }): Tween;
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
        /** 1o vivo que passa em fn, ou null */
        find(fn: (o: Entity) => boolean): Entity | null;
        /** quantos vivos passam em fn (sem fn = todos os vivos) */
        countIf(fn?: (o: Entity) => boolean): number;
        /** tira ja (fora do update); false se nao estava */
        remove(o: Entity): boolean;
        /** ordem de desenho estavel: nome de prop ('y') ou comparador */
        sort(key: string | ((a: Entity, b: Entity) => number)): void;
    }
    function group(): Group;
    interface Pool extends Omit<Group, 'add' | 'remove' | 'sort' | 'find' | 'countIf'> {
        /** init(o) prepara o reciclado */
        spawn(init?: (o: Entity) => void): Entity | null;
        alive: number;
    }
    function pool(n: number, factory: (i: number) => Entity): Pool;

    // ------------------------------------------------------------ math --
    const m: {
        clamp(v: number, a: number, b: number): number;
        lerp(a: number, b: number, t: number): number;
        map(v: number, a: number, b: number, c: number, d: number): number;
        rand(a?: number, b?: number): number;
        /** randInt(n) = 0..n; randInt(a, b) = a..b (inclusivos) */
        randInt(a: number, b?: number): number;
        pick<T>(arr: T[]): T;
        dist(x0: number, y0: number, x1: number, y1: number): number;
        dist2(x0: number, y0: number, x1: number, y1: number): number;
        ang(x0: number, y0: number, x1: number, y1: number): number;
        approach(v: number, target: number, delta: number): number;
        /** v dentro de [a, b) */
        wrap(v: number, a: number, b: number): number;
        /** diferenca angular mais curta de a para b, em (-PI, PI] */
        angDiff(a: number, b: number): number;
        smoothstep(e0: number, e1: number, v: number): number;
        /** interpola angulos pelo caminho curto */
        lerpAngle(a: number, b: number, t: number): number;
        /** multiplo de step mais proximo */
        snap(v: number, step: number): number;
        /** ruido de valor suave 0..1 (1D com y omitido) */
        noise(x: number, y?: number, seed?: number): number;
        /** true com probabilidade p; rnd opcional (E.rng) */
        chance(p: number, rnd?: () => number): boolean;
        /** Fisher-Yates NO LUGAR; devolve o mesmo array */
        shuffle<T>(arr: T[], rnd?: () => number): T[];
        sign(v: number): number;
        linear(t: number): number;
        inQuad(t: number): number;
        outQuad(t: number): number;
        inOutQuad(t: number): number;
        outBack(t: number): number;
        inCubic(t: number): number;
        outCubic(t: number): number;
        inOutCubic(t: number): number;
        outElastic(t: number): number;
        outBounce(t: number): number;
    };
    interface Rng {
        (): number;
        /** float em [a, b) */
        range(a: number, b: number): number;
        /** int(n) = 0..n; int(a, b) = a..b (inclusivos) */
        int(a: number, b?: number): number;
        pick<T>(arr: T[]): T;
    }
    /** PRNG deterministico (xorshift32). */
    function rng(seed: number): Rng;

    // ---------------------------------------------------------- camera --
    const cam: {
        x: number;
        y: number;
        ox: number;
        oy: number;
        bounds: Rect | null;
        /** deadzone {w, h}: caixa no centro onde o alvo anda sem mover a camera */
        follow(target: { x: number; y: number }, lerp?: number,
               opts?: { deadzone?: { w: number; h: number };
                        /** olha a frente do alvo */
                        offset?: { x: number; y: number } }): void;
        offset: { x: number; y: number } | null;
        /** a caixa de mundo aparece na tela (pad = folga)? */
        inView(x: number, y: number, w?: number, h?: number, pad?: number): boolean;
        shake(pow: number, dur: number): void;
        center(x: number, y: number): void;
        reset(): void;
        wx(x: number): number;
        wy(y: number): number;
        /** tela -> mundo (toque em coordenada do mapa) */
        worldX(sx: number): number;
        worldY(sy: number): number;
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
        /** cor da sombra (1 px x U abaixo-direita) */
        shadow?: number;
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
        /** quebra por palavras (e \n) dentro de maxW px */
        wrap(str: any, maxW: number, o?: TextOpts): string[];
        /** texto em varias linhas; devolve a altura usada */
        textBox(str: any, x: number, y: number, w: number,
                o?: TextOpts & { lh?: number; max?: number }): number;
        /** poligono convexo [x0, y0, x1, y1, ...] cheio ou contorno ({fill: false}) */
        poly(pts: number[], color: number, o?: DrawOpts): void;
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
        sfx(what: string | number[] | number[][], opts?: { gap?: number }): void;
        /** intervalo minimo (ms) entre toques do MESMO som por nome (default 40; 0 desliga) */
        gap: number;
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
        /** objeto/array guardado em JSON (JSON podre ou ausente = def) */
        obj<T = any>(key: string, def?: T): T;
        setObj(key: string, val: any): void;
        del(key: string): void;
        /** contador persistente; devolve o novo valor */
        inc(key: string, n?: number): number;
    };
}
