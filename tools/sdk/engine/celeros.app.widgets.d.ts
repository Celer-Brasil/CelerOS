// app.widgets.d.ts — tipos do CelerKit WIDGETS (celeros.app.widgets): header
// com acoes, botao com icone, iconButton, anel/medidor, sheet inferior e
// segmented. Requer celeros.app.style + celeros.app.icons.

declare namespace A {
    interface WidgetsButtonOpts {
        variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
        primary?: boolean;
        icon?: string;
        disabled?: boolean;
        bg?: number;
        textColor?: number;
        r?: number;
        stroke?: boolean;
        role?: 'caption' | 'body' | 'title' | 'display';
    }
    interface WidgetsHeaderAction {
        icon: string;
        id?: any;
    }
    interface WidgetsHeaderResult {
        back: boolean;
        action: any;
    }
    interface WidgetsHeaderOpts {
        h?: number;
        bg?: number;
        back?: boolean;
        sub?: string;
        actions?: WidgetsHeaderAction[];
        /** c.full: gradiente/linha inferior so no frame cheio */
        full?: boolean;
    }
    interface WidgetsRingOpts {
        th?: number;
        bg?: number;
        color?: number;
        label?: string | number;
        textColor?: number;
        font?: number;
    }
    interface WidgetsSheetContent extends StyleContent {
        /** cor de fundo do sheet (passe em UI.text { bg }) */
        bg: number;
    }
    interface WidgetsSheetOpts {
        open?: boolean;
        h?: number;
        title?: string;
        dim?: number;
        pad?: number;
        /** c.full: veu/card so no frame cheio (o app deve passar) */
        full?: boolean;
    }
    const widgets: {
        version: string;
        /** botao com icone (o style.button delega para ca quando ha icone) */
        button(label: string, x: number, y: number, w: number, h: number,
               o?: WidgetsButtonOpts): boolean;
        iconButton(icon: string, x: number, y: number, size: number,
                   o?: { bg?: number; color?: number; r?: number; disabled?: boolean }): boolean;
        header(title: string, o?: WidgetsHeaderOpts): WidgetsHeaderResult;
        /** anel/medidor (frac 0..1); devolve a fracao limitada */
        ring(cx: number, cy: number, r: number, frac: number, o?: WidgetsRingOpts): number;
        /** sheet inferior nao bloqueante: 'close' no toque fora, ou null */
        sheet(id: string, o?: WidgetsSheetOpts,
              draw?: (content: WidgetsSheetContent) => void): 'close' | null;
        segmented(x: number, y: number, w: number, h: number,
                  labels: string[], sel: number): number;
    };
}
