// celeros.hw.motor.d.ts — tipos da dep celeros.hw.motor (ponte H EN+2IN:
// L298N, TB6612, DRV8871). Dep do hub: "celeros.hw": "^1.0.0" ou
// "celeros.hw.motor": "^1.0.0". API 1 + permissao "gpio".
//
// 1 motor = 1 analogWrite (8 bits, 5 kHz, 3 canais no total) + 2 GPIOs.

declare namespace M {
    const version: string;

    interface Opts {
        /** Modo EN + IN1/IN2 (1 PWM + 2 GPIOs). */
        pwm?: number;
        in1?: number;
        in2?: number;
        /** Modo 2 PWM (BTS7960/IBT-2): dois canais analogWrite. */
        pwmA?: number;
        pwmB?: number;
        invert?: boolean;
        /** Compensacao do ponto morto (0..255): 1% ja sai do lugar. */
        minDuty?: number;
        /** Tempo da reversao suave em ms (0 = inverte na hora). */
        reverseMs?: number;
    }

    interface Motor {
        pwm: number;
        in1: number;
        in2: number;
        pwmA: number;
        pwmB: number;
        speed(pct: number): Motor;
        forward(pct: number): Motor;
        reverse(pct: number): Motor;
        /** Rampa ate a velocidade (ms; 0 = imediato). */
        rampTo(pct: number, ms: number): Motor;
        /** Freio curto: IN1=IN2=1, PWM 0. */
        brake(): Motor;
        /** Roda livre: IN1=IN2=0, PWM 0. */
        coast(): Motor;
        stop(): Motor;
        isMoving(): boolean;
        speedNow(): number;
        target(): number;
    }

    interface Pair {
        left: Motor;
        right: Motor;
        tank(l: number, r: number): Pair;
        arcade(speed: number, turn: number): Pair;
        stop(): Pair;
        tick(now?: number): void;
    }

    function create(opts: Opts): Motor;
    function pair(left: Motor, right: Motor): Pair;
    function tick(now?: number): void;
    function available(): boolean;
}
