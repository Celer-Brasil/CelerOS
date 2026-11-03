// celeros.hw.pca9685.d.ts — tipos da dep celeros.hw.pca9685 (driver do PWM
// I2C de 16 canais). Dep do hub: "celeros.hw": "^1.0.0" ou
// "celeros.hw.pca9685": "^1.0.0". API 54 + permissao "gpio".
//
// Placa com bus de placa: PCA.create({ addr: 0x40 }). Sem bus de placa:
// PCA.create({ sda: 22, scl: 27 }). init() devolve false em NACK.

declare namespace PCA {
    const version: string;

    interface Opts {
        /** 0x40..0x7F (default 0x40). */
        addr?: number;
        /** 24..1526 Hz (default 50). */
        freq?: number;
        /** Pinos explicitos; omita os dois para usar o bus da placa. */
        sda?: number;
        scl?: number;
        hz?: number;
    }

    interface Pwm {
        on: number;
        off: number;
    }

    interface Pca {
        addr: number;
        freq: number;
        ready: boolean;
        lastError: string;
        bus: { port: number; sda: number; scl: number; hz: number };
        init(): boolean;
        setFreq(hz: number): boolean;
        setPwm(ch: number, on: number, off: number): boolean;
        setDuty(ch: number, duty: number): boolean;
        setServoUs(ch: number, us: number): boolean;
        setServo(ch: number, angle: number, opts?: {
            minUs?: number; maxUs?: number;
            minAngle?: number; maxAngle?: number;
            offset?: number; invert?: boolean;
        }): boolean;
        /** Servo de celeros.hw.servo apontando para este canal. */
        servo(ch: number, opts?: S.Opts): S.Servo;
        allOff(): boolean;
        sleep(): boolean;
        wake(): boolean;
        readPwm(ch: number): Pwm | null;
        /** Marca fechado; NAO chama System.i2c.end() (o app decide). */
        close(): boolean;
    }

    /** PRE_SCALE para a frequencia (3..255). */
    function prescale(freq: number): number;
    function available(): boolean;
    function create(opts?: Opts): Pca;
}
