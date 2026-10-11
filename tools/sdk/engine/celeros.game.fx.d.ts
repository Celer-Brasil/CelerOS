// game.fx.d.ts — tipos do modulo CelerGame FX (celeros.game.fx), que
// decora o core (celeros.game.d.ts) com E.fx. Inclua os dois no editor.

declare namespace E {
    const fx: {
        version: string;
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
        interface Emitter {
            on: boolean;
            start(): void;
            stop(): void;
            /** move a fonte fixa do emissor */
            set(x: number, y: number): void;
            dead: boolean;
        }
        /** Fonte continua: rate part/s + opts de particula do burst; duration (ms) desliga sozinho; follow () => {x,y} (null pula o quadro). */
        emitter(o: {
            x?: number; y?: number; rate?: number; duration?: number;
            follow?: () => { x: number; y: number } | null;
            color?: number; colors?: number[]; speed?: number; speed2?: number;
            angle?: number; spread?: number; life?: number; size?: number;
            grav?: number; drag?: number; shape?: 'dot' | 'spark' | 'ring';
        }): Emitter;
        /** Rastro que segue getXY () => {x, y} (coords de mundo); parado nao deixa rastro. */
        trail(getXY: () => { x: number; y: number }, o?: {
            rate?: number; life?: number; size?: number;
            color?: number; colors?: number[]; grav?: number;
        }): Emitter;
        interface Parallax {
            /** tela inteira (1a linha do draw) ou so as celulas do rect (painter da camada suja) */
            draw(x?: number, y?: number, w?: number, h?: number): void;
        }
        /** Camadas de fundo com rolagem pela camera: [{speed, gap, rowH, paint(x, y)}]. */
        parallax(layers: {
            speed?: number; gap?: number; rowH?: number;
            paint: (x: number, y: number) => void;
        }[]): Parallax;
        /** Desenha particulas/floaters/flash — chame na ultima linha do draw da cena. */
        draw(): void;
    };
}
