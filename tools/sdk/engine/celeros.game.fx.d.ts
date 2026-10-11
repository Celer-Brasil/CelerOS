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
        /** Desenha particulas/floaters/flash — chame na ultima linha do draw da cena. */
        draw(): void;
    };
}
