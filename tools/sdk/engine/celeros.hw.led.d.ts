// celeros.hw.led.d.ts — tipos da dep celeros.hw.led (LED simples/PWM, LED
// RGB de status e fita WS2812). Dep do hub: "celeros.hw": "^1.0.0" ou
// "celeros.hw.led": "^1.0.0". API 10 + permissao "gpio".
//
// Cores de fita em 0x00RRGGBB (System.neopixel). O analogWrite tem 3 canais.

declare namespace L {
    const version: string;

    interface Opts {
        pin: number;
        activeLow?: boolean;
        /** Usa analogWrite (brilho/breathe) em vez de digitalWrite. */
        pwm?: boolean;
    }

    interface Led {
        set(level: number): Led;
        level(): number;
        on(): Led;
        off(): Led;
        toggle(): Led;
        blink(ms?: number, opts?: { on?: number; off?: number }): Led;
        breathe(ms?: number): Led;
        pattern(frames: { level: number; ms: number }[]): Led;
        stop(): Led;
    }

    interface StripOpts {
        index?: number;
        count?: number;   // 1..8 (default 8)
    }

    interface Strip {
        set(i: number, color: number): Strip;
        fill(color: number): Strip;
        clear(): Strip;
        show(): boolean;
        rainbow(ms?: number): Strip;
        stop(): Strip;
    }

    function create(opts: Opts): Led;
    function strip(opts?: StripOpts): Strip;
    function tick(now?: number): void;
    function hasStatus(): boolean;
    function status(r: number, g: number, b: number): boolean;
    function statusOff(): boolean;
    function rgb(r: number, g: number, b: number): number;
    function hex(n: number): number;
    function hsv(h: number, s?: number, v?: number): number;
    function mix(a: number, b: number, t?: number): number;
    function gamma(v: number): number;
    function available(): boolean;
}
