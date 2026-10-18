// game.pad.d.ts — tipos do modulo CelerGame PAD (celeros.game.pad), que
// decora o core (celeros.game.d.ts) com E.pad. Inclua os dois.
// TOQUE UNICO: segurar o stick e apertar um botao juntos nao existe.

declare namespace E {
    interface PadStick {
        /** -1..1 por eixo (zona morta aplicada) */
        x: number; y: number;
        mag: number; angle: number;
        active: boolean;
        dir: string | null;
        /** tap seco na zona neste quadro (acao "A" do toque unico) */
        tap: boolean;
        cx: number; cy: number; r: number;
        zone: Rect; float: boolean; dead: number; dirs: 4 | 8; visible: boolean;
    }
    interface PadButton {
        x: number; y: number; r?: number; w?: number; h?: number;
        label: string; color?: number;
        down: boolean; pressed: boolean; released: boolean; visible: boolean;
    }
    const pad: {
        version: string;
        stick(o?: { zone?: Rect; x?: number; y?: number; r?: number; float?: boolean;
                    dead?: number; dirs?: 4 | 8; visible?: boolean }): PadStick;
        button(o: { x: number; y: number; r?: number; w?: number; h?: number;
                    label?: string; color?: number; visible?: boolean }): PadButton;
        /** remove sticks e botoes (troca de cena) */
        clear(): void;
        /** desenha tudo (screen) */
        draw(): void;
    };
}
