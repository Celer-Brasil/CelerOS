// celeros.hw.encoder.d.ts — tipos da dep celeros.hw.encoder (encoder
// incremental A/B no PCNT). Dep do hub: "celeros.hw.encoder": "^1.0.0".
// API 55 + permissao "gpio".
//
// A contagem e do hardware; read()/speed()/rpm() nao bloqueiam.

declare namespace E {
    const version: string;

    interface Opts {
        pinA?: number;
        pinB?: number;
        /** aliases de pinA/pinB */
        a?: number;
        b?: number;
        pullup?: boolean;   // default true (encoder open-collector)
        invert?: boolean;   // troca o sinal da contagem
        scale?: number;     // multiplica a contagem (reducao 1:20 => 20)
    }

    interface Encoder {
        /** id PCNT 0..3 (-1 depois de free) */
        id: number;
        pinA: number;
        pinB: number;
        /** contagem acumulada (com invert/scale) ou null */
        read(): number | null;
        counts(): number | null;
        reset(): boolean;
        /** pulsos/s desde a ultima chamada (dt real em ms) */
        speed(now?: number): number;
        /** RPM a partir dos pulsos por volta (efetivos, ja com scale) */
        rpm(countsPerRev: number, now?: number): number;
        /** devolve a unidade PCNT */
        free(): void;
    }

    function create(opts: Opts): Encoder;
    function available(): boolean;
}
