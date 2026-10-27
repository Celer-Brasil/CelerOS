// app.style.d.ts — tipos do CelerKit STYLE (celeros.app.style): tokens,
// presets, safe area, card, divider e botao. Icones em celeros.app.icons;
// header/ring/sheet em celeros.app.widgets.

declare namespace A {
    interface StyleRect {
        x: number; y: number; w: number; h: number;
    }
    interface StyleContent extends StyleRect {
        /** cor de fundo do card (passe em UI.text { bg }) */
        bg: number;
    }
    interface StyleTokens {
        preset: 'soft' | 'flat' | 'neon' | 'paper';
        bg: number; card: number; raised: number; stroke: number;
        accent: number; accentD: number; onAccent: number;
        text: number; textDim: number; ok: number; warn: number; err: number;
        /** raio/gap/pad em px do projeto (nao escalam) */
        radius: number; gap: number; pad: number;
        /** camadas de sombra, usa gradiente */
        shadow: number; grad: boolean;
        _src: any;
    }
    interface StyleCardOpts {
        pad?: number; r?: number; bg?: number; stroke?: boolean;
        /** sombra (default T.shadow) e gradiente (default T.grad) so no frame cheio */
        elev?: number; grad?: boolean;
        /** c.full: sombra/gradiente/gradiente so no frame cheio */
        full?: boolean;
        /** desenha o conteudo e fecha o card sozinho (senao chame cardEnd) */
        draw?: (content: StyleContent) => void;
    }
    interface StyleStack {
        x: number; y: number; w: number;
        dir: 'v' | 'h';
        gap: number;
        cursor: number;
        next(h: number, w?: number): StyleRect;
        reset(): void;
        end(): number;
    }
    const style: {
        version: string;
        /** tokens vivos (leia/mute direto; prefira preset/reset) */
        T: StyleTokens;
        preset(name: 'soft' | 'flat' | 'neon' | 'paper'): StyleTokens;
        reset(): StyleTokens;
        /** margem segura do vidro em px virtuais (0 no retangular) */
        inset(): number;
        /** area de conteudo dentro da margem segura (top/bottom = y) */
        content(top?: number, bottom?: number): StyleRect;
        stack(x: number, y: number, w: number,
              o?: { dir?: 'v' | 'h'; gap?: number }): StyleStack;
        /** icone via celeros.app.icons quando adotado; senao um ponto */
        icon(name: string, x: number, y: number, size?: number,
             o?: { color?: number; w?: number }): StyleRect | void;
        /** card: chame TODO frame; o UI.card empilha o bg */
        card(x: number, y: number, w: number, h: number, o?: StyleCardOpts): StyleContent;
        cardEnd(): void;
        divider(x: number, y: number, w: number,
                o?: { h?: number; color?: number }): void;
        /** botao texto (UI.button nativo); com icone usa widgets se adotado */
        button(label: string, x: number, y: number, w: number, h: number, o?: {
            variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
            primary?: boolean; icon?: string; disabled?: boolean;
            role?: 'caption' | 'body' | 'title' | 'display';
            color?: number; textColor?: number;
        }): boolean;
    };
}
