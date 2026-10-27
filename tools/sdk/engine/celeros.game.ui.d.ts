// game.ui.d.ts — tipos do modulo CelerGame UI 1.3 (celeros.game.ui), que
// decora o core (celeros.game.d.ts) com E.ui. Inclua os dois.

declare namespace E {
    interface MenuItem {
        label: string;
        /** devolvido no pick (default: o label) */
        value?: any;
        danger?: boolean;
        disabled?: boolean;
        /** nome em E.ui.icon */
        icon?: string;
        /** primary|secondary|ghost|danger|success */
        variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
    }

    interface ListItem {
        label?: string;
        value?: any;
        /** segunda linha (linha mais alta) */
        sub?: string;
        /** nome em E.ui.icon */
        icon?: string;
        /** texto a direita */
        right?: string | number;
        badge?: string | number;
        badgeColor?: number;
        disabled?: boolean;
        danger?: boolean;
        color?: number;
        /** linha de cabecalho (nao selecionavel) */
        section?: boolean | string;
        header?: boolean | string;
    }

    interface ListState {
        items: (string | ListItem)[];
        row: number;
        onPick: ((value: any, index: number) => void) | null;
        scroll: number;
        /** rola ate a linha index ficar no topo */
        scrollTo(index: number): void;
        scrollBy(dy: number): void;
        /** ultimo valor pego (polling); o retorno do draw so vale no quadro do tap */
        picked: any;
        /** indice da ultima linha pega */
        index: number;
        /** desenha em coords de TELA e devolve o item do tap (ou null); arrastar rola */
        draw(x: number, y: number, w: number, h: number): any;
    }

    interface Dialog {
        done: boolean;
        closed: boolean;
        /** pagina corrente (texto em array) */
        page: number;
        pages: string[];
        text: string;
        /** indice da escolha tocada (o.choices), -1 = nenhuma */
        choice: number;
        /** completa / proxima pagina / fecha (o botao A do pad); false = fechou */
        next(): boolean;
        /** desenha a caixa e avanca o texto; tap completa / fecha (false = fechou) */
        draw(x: number, y: number, w?: number): boolean;
        skip(): void;
        close(): void;
    }

    /** tokens vivos do E.ui (os widgets leem daqui) */
    interface UiTokens {
        preset: 'soft' | 'flat' | 'neon' | 'paper';
        bg: number; surface: number; surface2: number; surface3: number;
        outline: number; text: number; textDim: number;
        accent: number; accent2: number; onAccent: number;
        ok: number; warn: number; err: number; glow: number;
        /** raio/gap/pad em px do PROJETO (multiplicados por E.U) */
        radius: number; gap: number; pad: number;
        /** camadas de sombra, usa gradiente, espessura da borda, glow neon */
        shadow: number; grad: boolean; bw: number; glowOn: boolean;
        _src: any; _custom: any;
    }

    interface UiButtonOpts {
        variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
        primary?: boolean;
        icon?: string;
        disabled?: boolean;
        r?: number;
        ts?: 'tiny' | 'small' | 'body' | 'label' | 'big' | 'title' | 'huge';
        align?: 'left' | 'center';
        grad?: boolean;
        elev?: number;
        shadow?: ShadowOpts | false;
    }

    interface UiStack {
        x: number; y: number; w: number;
        dir: 'v' | 'h';
        gap: number; pad: number; cursor: number;
        /** proximo rect (scratch: use na hora) */
        next(h: number, w?: number): Rect;
        reset(): void;
        /** altura/largura total usada */
        end(): number;
    }

    interface UiGrid {
        cols: number; cw: number; gap: number; rowH: number;
        cell(i: number, h?: number): Rect;
        height(n: number): number;
    }

    interface UiListOpts {
        items: (string | ListItem)[];
        row?: number;
        onPick?: (value: any, index: number) => void;
        pad?: number;
        r?: number;
        bg?: number;
        bw?: number;
        elev?: number;
        shadow?: ShadowOpts | false;
        /** false esconde a barra de rolagem */
        scrollbar?: boolean;
        /** painter de linha inteira: paintRow(item, x, y, w, h, state) */
        paintRow?: (item: string | ListItem, x: number, y: number, w: number, h: number,
                    state: { pressed: boolean; disabled: boolean; selected: boolean }) => void;
    }

    interface UiModalButton {
        label: string;
        value?: any;
        variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
        icon?: string;
        disabled?: boolean;
    }

    interface UiModalOpts {
        /** default true; false anima a saida e depois devolve null */
        open?: boolean;
        id?: string;
        w?: number; h?: number; x?: number; y?: number;
        title?: string;
        body?: string;
        buttons?: UiModalButton[];
        dim?: number;
        bg?: number;
        ms?: number;
        ease?: 'linear' | 'inQuad' | 'outQuad' | 'inOutQuad' | 'outCubic' | 'outBack';
        dismiss?: boolean;
        dismissValue?: any;
        contentH?: number;
    }

    interface UiSheetOpts {
        open?: boolean;
        h?: number;
        title?: string;
        dim?: number;
        bg?: number;
        cardBg?: number;
        ms?: number;
        ease?: 'linear' | 'inQuad' | 'outQuad' | 'inOutQuad' | 'outCubic' | 'outBack';
        dismiss?: boolean;
    }

    interface UiHudItem {
        icon?: string;
        text?: string | number;
        color?: number;
    }

    interface UiHudOpts {
        y?: number; h?: number; x?: number; w?: number;
        bg?: number;
        key?: string;
        score?: string | number;
        best?: string | number;
        lives?: number; maxLives?: number;
        coins?: string | number;
        time?: string | number;
        level?: string | number;
        lifeColor?: number;
        coinColor?: number;
        scoreColor?: number;
        timeColor?: number;
        left?: UiHudItem[];
        right?: UiHudItem[];
    }

    const ui: {
        version: string;
        /** tokens vivos (leia/escreva direto; prefira theme/preset) */
        tokens: UiTokens;
        /** patch de tokens; aceita '#rrggbb' */
        theme(patch: Partial<UiTokens> | Record<string, any>): UiTokens;
        /** soft (default), flat, neon, paper */
        preset(name: 'soft' | 'flat' | 'neon' | 'paper'): UiTokens;
        resetTheme(): UiTokens;
        /** icone vetorial (24 nomes); rect em scratch */
        icon(name: string, x: number, y: number, size?: number,
             o?: { color?: number; w?: number }): Rect;
        stack(x: number, y: number, w: number, o?: {
            dir?: 'v' | 'h'; gap?: number; pad?: number;
        }): UiStack;
        grid(x: number, y: number, w: number, cols: number, o?: {
            gap?: number; rowH?: number;
        }): UiGrid;
        /** card com elevacao/gradiente/borda; devolve o content rect */
        card(x: number, y: number, w: number, h: number, o?: DrawOpts & {
            bg?: number; pad?: number; flat?: boolean;
        }): Rect;
        divider(x: number, y: number, w: number,
                o?: { color?: number; h?: number; screen?: boolean }): void;
        section(title: string, x: number, y: number, w?: number,
                o?: { color?: number; line?: boolean }): number;
        /** botao immediate-mode: true no tap; registra em E._btns */
        button(label: string, x: number, y: number, w: number, h: number,
               o?: UiButtonOpts): boolean;
        iconButton(icon: string, x: number, y: number, size: number,
                   o?: UiButtonOpts): boolean;
        toggle(x: number, y: number, on: boolean,
               o?: { w?: number; h?: number; label?: string; ts?: string; lw?: number }): boolean;
        check(label: string, x: number, y: number, on: boolean,
              o?: { size?: number; w?: number; ts?: string }): boolean;
        radio(label: string, x: number, y: number, on: boolean,
              o?: { size?: number; w?: number; ts?: string }): boolean;
        slider(x: number, y: number, w: number, value: number, o?: {
            min?: number; max?: number; step?: number; id?: string;
            h?: number; th?: number; kr?: number;
            label?: string; fmt?: (v: number) => string;
        }): number;
        stepper(x: number, y: number, value: number, o?: {
            min?: number; max?: number; step?: number; w?: number; h?: number;
            ts?: string; fmt?: (v: number) => string;
        }): number;
        segmented(x: number, y: number, w: number, labels: string[], sel: number,
                  o?: { h?: number; gap?: number; ts?: string }): number;
        tabs(x: number, y: number, w: number, h: number, labels: string[], sel: number,
             o?: { ts?: string }): number;
        chip(label: string, x: number, y: number,
             o?: { on?: boolean; icon?: string; w?: number; h?: number; ts?: string }): boolean;
        badge(text: string | number, x: number, y: number,
              o?: { color?: number; textColor?: number; w?: number; h?: number; ts?: string }): number;
        progress(x: number, y: number, w: number, h: number, frac: number,
                 o?: { fg?: number; fg2?: number; bg?: number; r?: number; grad?: boolean }): number;
        ring(cx: number, cy: number, r: number, frac: number, o?: {
            th?: number; bg?: number; color?: number;
            label?: string | number; textColor?: number; ts?: string;
        }): number;
        /** scroll generico (clip + inercia + barra); devolve o offset */
        scroll(id: string, x: number, y: number, w: number, h: number, contentH: number,
               drawFn: (offset: number, x: number, y: number, w: number, h: number) => void): number;
        scrollTo(id: string, y: number): void;
        resetScroll(id: string): void;
        /** menu vertical immediate-mode: devolve o value/label tocado, ou null */
        menu(items: (string | MenuItem)[], o?: {
            x?: number; y?: number; w?: number; row?: number; primary?: boolean;
        }): any;
        /** lista com rolagem/inercia, secoes, icones e painter custom */
        list(o: UiListOpts): ListState;
        /** texto datilografado; choices viram botoes; sound = blip */
        dialog(text: string | string[], o?: {
            speed?: number; name?: string; speaker?: string; px?: number;
            realtime?: boolean; tap?: boolean;
            choices?: (string | { label: string; icon?: string })[];
            sound?: boolean; soundEvery?: number;
            bg?: number; r?: number; elev?: number;
        }): Dialog;
        /** modal centrado com veu + card + botoes; devolve o value/'dismiss'/null */
        modal(id: string, o: UiModalOpts,
              drawFn?: (content: Rect) => void): any;
        /** bottom sheet com veu/handle; devolve 'close' ou null */
        sheet(id: string, o: UiSheetOpts,
              drawFn?: (content: Rect) => void): 'close' | null;
        /** tela de titulo: 'start' | 'extra' | null */
        title(o?: {
            game?: string; subtitle?: string; start?: string | null | false;
            extra?: string; best?: number; bg?: number | boolean;
            startIcon?: string; extraIcon?: string;
        }): 'start' | 'extra' | null;
        /** veu de pausa: 'resume' | 'restart' | 'quit' | null */
        pause(o?: {
            title?: string; labels?: [string, string, string];
            clear?: boolean; veil?: number;
        }): string | null;
        /** tela de fim: 'again' | 'quit' | null */
        gameOver(o?: {
            title?: string; score?: number; best?: number; isNew?: boolean;
            detail?: string; labels?: [string, string];
            clear?: boolean; veil?: number;
        }): 'again' | 'quit' | null;
        /** sim/nao modal: 'yes' | 'no' | null */
        confirm(msg: string, o?: {
            title?: string; labels?: [string, string]; danger?: boolean;
        }): 'yes' | 'no' | null;
        /** aviso em FILA (ate 3) desenhado pela engine por cima da cena */
        toast(msg: any, o?: {
            ms?: number; color?: number; y?: number;
            type?: 'info' | 'ok' | 'warn' | 'err'; icon?: string;
        }): void;
        /** anima uma chave 0..1 (target omitido = le o valor) */
        anim(key: string, target?: number, ms?: number,
             ease?: 'linear' | 'inQuad' | 'outQuad' | 'inOutQuad' | 'outCubic' | 'outBack'): number;
        animReset(key: string): void;
        /** HUD de topo memoizado (score/vidas/moedas/tempo/nivel + left/right) */
        hud(o?: UiHudOpts): number;
        _toast: { msg: string | null; until: number; color?: number; y: number };
        _toasts: any[];
        _anims: Record<string, any>;
        _hudSig: string;
        _toastBox: number[];
    };
}
