// ui.icons.d.ts — tipos do modulo compartilhado celeros.ui.icons (12 icones
// vetoriais comuns a apps e jogos + dot). Usa SO System; nao depende de
// celeros.app nem celeros.game.

declare namespace UIAtoms {
    interface IconRect {
        x: number; y: number; w: number; h: number;
    }
    interface IconOpts {
        color?: number;
        w?: number;
    }
    /** nome -> funcao(x, y, size, color, strokeWidth) */
    type IconFn = (x: number, y: number, s: number, c: number, w: number) => void;
}

declare module "celeros.ui.icons" {
    export const version: string;
    export const map: Record<string, UIAtoms.IconFn>;
    /** back close check gear wifi star play search menu heart info alert (ou dot) */
    export function draw(name: string, x: number, y: number, size?: number,
                         o?: UIAtoms.IconOpts): UIAtoms.IconRect;
}
