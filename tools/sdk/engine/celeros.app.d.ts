// app.d.ts — tipos do CelerKit APP core (celeros.app): loop de telas com
// pilha, overlays, ticker, tema/layout. Os modulos da familia
// (celeros.app.*) adicionam seus proprios d.ts sobre este. Vendorize com
// `celer.js new --appkit`.

declare namespace A {
    const version: string;
    /** Modulos CelerKit carregados (["fmt", "path", ...]). */
    const _mods: string[];
    /** Devolve a tela anterior (na raiz: encerra o app). */
    const BACK: string;
    /** Encerra o app na hora. */
    const EXIT: string;
    /** Tema cacheado no init() (mesmo objeto de System.theme()). */
    const T: CelerTheme | null;
    interface Layout {
        x: number;
        y: number;
        w: number;
        top: number;
        bottom: number;
        cx: number;
    }
    /** Layout virtual fixo (240x320): x=8, w=224, top=48, bottom=312. */
    const L: Layout | null;
    /** Ctx que o run() passa a cada tela. */
    interface Ctx {
        /** frame e de redesenho total (UI.begin devolveu true) */
        full: boolean;
        /** System.millis() do frame */
        now: number;
        /** true so no 1o frame da tela (lazy load, reset de scroll) */
        entered: boolean;
    }
    interface RunOpts {
        /** fps default do loop (uma tela pode ter .fps proprio) */
        fps?: number;
    }
    type Screen = ((c: Ctx) => any) & { fps?: number };
    /**
     * Loop principal. A tela desenha (UI.* direto) e DEVOLVE:
     * undefined = fica; "nome" = empilha e abre; A.BACK = volta (raiz sai);
     * A.EXIT = encerra.
     */
    function run(screens: { [nome: string]: Screen }, first: string, opts?: RunOpts): void;
    /** Cacheia tema+layout; chame de novo para re-ler o tema. */
    function init(): void;
    /** Header com voltar; true = toque no voltar (a tela devolve A.BACK). */
    function header(title: string, o?: { back?: boolean; sub?: string }): boolean;
    /** UM frame de "ocupado" antes de uma chamada bloqueante. */
    function busy(msg?: string): void;
    /** UM frame com barra de progresso (p 0..100; <0 = spinner). */
    function progress(p: number, msg?: string): void;
    /** Card de erro que espera o toque em OK. */
    function error(title: string, lines?: string | string[]): void;
    /** Card de sucesso que espera o toque em OK. */
    function ok(title: string, lines?: string | string[]): void;
    /** Espera o Wi-Fi voltar; false se o usuario cancelou. */
    function wifiWait(msg?: string): boolean;
    /** true quando passou ms desde a ultima marca da chave (polling). */
    function every(ms: number, key?: string): boolean;
    /** System.millis(). */
    function now(): number;
    function toast(msg: string, ms?: number): void;
    function exit(): void;
}
