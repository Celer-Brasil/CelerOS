// game.ui.d.ts — tipos do modulo CelerGame UI (celeros.game.ui), que
// decora o core (celeros.game.d.ts) com E.ui. Inclua os dois.

declare namespace E {
    interface MenuItem {
        label: string;
        /** devolvido no pick (default: o label) */
        value?: any;
        danger?: boolean;
        disabled?: boolean;
    }
    const ui: {
        version: string;
        /** Menu vertical immediate-mode: devolve o value/label tocado neste quadro, ou null. */
        menu(items: (string | MenuItem)[], o?: {
            x?: number; y?: number; w?: number; row?: number;
        }): any;
        interface List {
            scroll: number;
            /** ultimo valor pego (polling); o retorno do draw so vale no quadro do tap */
            picked: any;
            /** desenha em coords de TELA e devolve o item do tap (ou null); arrastar rola */
            draw(x: number, y: number, w: number, h: number): any;
        }
        /** Lista com rolagem por arrasto (o arrasto comeca no PRESSIONAR
         *  dentro dela — dedo que atravessou o rect nao a salta); onPick
         *  dispara no tap seco. */
        list(o: {
            items: (string | MenuItem)[];
            row?: number;
            onPick?: (value: any, index: number) => void;
        }): List;
        interface Dialog {
            done: boolean;
            closed: boolean;
            /** desenha a caixa e avanca o texto; tap completa / fecha (false = fechou) */
            draw(x: number, y: number, w?: number): boolean;
            skip(): void;
            close(): void;
        }
        /** Texto datilografado (speed chars/s): reveal avanca no draw — cena
         *  comum, nao static. A quebra de linhas e calculada 1x e a ALTURA do
         *  painel cresce com o texto. */
        dialog(text: string, o?: {
            speed?: number; name?: string; px?: number;
        }): Dialog;
        /** Tela de titulo: 'start' | 'extra' | null no tap. */
        title(o?: {
            game?: string; subtitle?: string; start?: string;
            extra?: string; best?: number;
        }): 'start' | 'extra' | null;
        /** Veu de pausa sobre o jogo congelado: 'resume' | 'restart' | 'quit' | null. */
        pause(o?: { title?: string; labels?: [string, string, string] }): string | null;
        /** Tela de fim: 'again' | 'quit' | null. */
        gameOver(o?: {
            title?: string; score?: number; best?: number; isNew?: boolean;
            labels?: [string, string];
        }): 'again' | 'quit' | null;
    };
}
