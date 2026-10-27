// app.icons.d.ts — tipos do CelerKit ICONS (celeros.app.icons): 12 icones
// vetoriais (System.*), sem PNG/sprite.

declare namespace A {
    interface IconRect {
        x: number; y: number; w: number; h: number;
    }
    const icons: {
        version: string;
        /** nome -> funcao(x, y, size, color, strokeWidth) */
        map: Record<string, (x: number, y: number, s: number, c: number, w: number) => void>;
        /** back close check gear wifi star play search menu heart info alert (ou dot) */
        draw(name: string, x: number, y: number, size?: number,
             o?: { color?: number; w?: number }): IconRect;
    };
}
