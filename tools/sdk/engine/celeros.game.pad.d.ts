// game.pad.d.ts — tipos do modulo CelerGame PAD (celeros.game.pad), que
// decora o core (celeros.game.d.ts) com E.pad. Inclua os dois.
// Multitoque (API 43): cada controle segue o seu dedo; toque unico (CYD): stick.tap e a acao.

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
        /** geracao da cena dona (null = global) */
        gen: number | null;
        /** id do dedo dono (multitoque) ou null */
        finger: number | null;
        /** centro persegue o dedo alem da borda */
        follow: boolean;
    }
    interface PadButton {
        x: number; y: number; r?: number; w?: number; h?: number;
        label: string; color?: number;
        down: boolean; pressed: boolean; released: boolean; visible: boolean;
        /** ms segurando (0 solto) */
        heldMs: number;
        /** soltou em < 250 ms neste quadro */
        tap: boolean;
        /** id do dedo dono (multitoque) ou null */
        finger: number | null;
        /** geracao da cena dona (null = global) */
        gen: number | null;
    }
    const pad: {
        version: string;
        stick(o?: { zone?: Rect; x?: number; y?: number; r?: number; float?: boolean;
                    dead?: number; dirs?: 4 | 8; visible?: boolean;
                    /** sobrevive a troca de cena (criado fora de cena ja e global) */
                    global?: boolean;
                    /** centro persegue o dedo alem da borda */
                    follow?: boolean }): PadStick;
        button(o: { x: number; y: number; r?: number; w?: number; h?: number;
                    label?: string; color?: number; visible?: boolean; global?: boolean }): PadButton;
        /** remove sticks e botoes (troca de cena) */
        clear(): void;
        /** desenha tudo (screen) */
        draw(): void;
    };
}
