// celeros.hw.d.ts — tipos do kit celeros.hw (servo, motor, LED, botao e
// PCA9685). Dep do hub: "celeros.hw": "^1.0.0". API 54 + permissao "gpio".
//
// Declare as tipos dos modulos do fecho (celeros.hw.*.d.ts) junto deste
// arquivo: o kit so reexporta os mesmos objetos.

declare namespace HW {
    const version: string;
    const servo: typeof S;
    const motor: typeof M;
    const led: typeof L;
    const button: typeof B;
    const pca9685: typeof PCA;
    /** Tick de todas as rampas/efeitos/botoes (uma vez por quadro). */
    function tick(now?: number): void;
    /** UM setInterval para todos; devolve o id (0 se ja iniciado). */
    function start(ms?: number): number;
    function stop(): void;
}
