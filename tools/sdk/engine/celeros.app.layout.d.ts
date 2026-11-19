declare namespace A {
    interface LayoutRect { x: number; y: number; w: number; h: number; }
    const layout: {
        version: string;
        /** Área útil. top e bottom reservam faixas, pad vale 4 por padrão. */
        bounds(o?: { top?: number; bottom?: number; pad?: number }): LayoutRect;
        /** Quantas colunas cabem com a largura física solicitada (mínimo 1). */
        columns(rect: LayoutRect, minWidthPx: number, gap?: number): number;
        /** Célula em coordenadas virtuais, índice por linha a partir de zero. */
        cell(rect: LayoutRect, cols: number, rows: number, index: number, gap?: number): LayoutRect;
    };
}
