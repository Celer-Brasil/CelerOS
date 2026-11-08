// celeros.hw.servo.d.ts — tipos da dep celeros.hw.servo (servo de posicao
// com calibracao, rampa e poses). Dep do hub: "celeros.hw": "^1.0.0" ou
// "celeros.hw.servo": "^1.0.0". API 10 + permissao "gpio".

declare namespace S {
    const version: string;

    interface Opts {
        /** GPIO do servo (backend nativo). */
        pin?: number;
        /** Faixa de pulso calibrada (default 500..2500 us). */
        minUs?: number;
        maxUs?: number;
        minAngle?: number;
        maxAngle?: number;
        /** Ajuste fino em graus, somado antes do clamp. */
        offset?: number;
        invert?: boolean;
        /** Servo de rotacao continua: speed() em volta de stopUs. */
        continuous?: boolean;
        stopUs?: number;
        /** Backend alternativo: recebe o pulso em us e devolve boolean. */
        write?: (us: number) => boolean;
        off?: () => boolean;
    }

    interface Servo {
        pin: number;
        minUs: number;
        maxUs: number;
        minAngle: number;
        maxAngle: number;
        write(angle: number): boolean;
        writeUs(us: number): boolean;
        /** Angulo logico -> pulso em us (com offset/invert e clamp). */
        usOf(angle: number): number;
        /** Pulso em us -> angulo logico (leitura apos writeUs). */
        angleOf(us: number): number;
        /** Rampa nao bloqueante (S.tick/HW.tick aplica os passos). */
        to(angle: number, ms?: number): boolean;
        /** Rotacao continua: -100..100 em volta do stopUs (false no servo de posicao). */
        speed(pct: number): boolean;
        /** Sequencia [[angulo, ms], ...] (um passo por vez no tick). */
        play(frames: Array<[number, number] | { angle: number; ms: number }>): boolean;
        stop(): Servo;
        /** Para o PWM e libera o canal (servo sem forca). */
        detach(): boolean;
        angle(): number;
        us(): number;
        attached(): boolean;
        moving(): boolean;
    }

    interface Group {
        pose(angles: number[], ms?: number): number;
        write(angles: number[]): number;
        home(ms?: number): number;
        detach(): void;
    }

    function create(opts: Opts): Servo;
    function group(list: Servo[]): Group;
    /** Tick global dos servos com rampa. */
    function tick(now?: number): void;
    function available(): boolean;
}
