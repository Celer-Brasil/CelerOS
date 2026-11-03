// celeros.hw.dht.d.ts — tipos da dep celeros.hw.dht (DHT11/DHT22 nativo).
// Dep do hub: "celeros.hw.dht": "^1.0.0". API 55 + permissao "gpio".
//
// O driver do firmware cacheia 1 s (DHT11) / 2 s (DHT22) por (pino, tipo).

declare namespace D {
    const version: string;

    interface Reading {
        ok: boolean;
        /** temperatura em graus Celsius (0 quando !ok) */
        temp: number;
        /** umidade relativa em % (0 quando !ok) */
        humidity: number;
        /** "sem resposta" | "timeout" | "checksum" | "" */
        error: string;
    }

    interface Opts {
        pin: number;
        /** 11 = DHT11, 22 = DHT22 (default 22) */
        type?: 11 | 22;
    }

    interface Dht {
        pin: number;
        type: number;
        last: Reading;
        read(): Reading;
        temp(): number | null;
        humidity(): number | null;
        ok(): boolean;
        error(): string;
    }

    function create(opts: Opts): Dht;
    /** leitura pontual, sem instancia */
    function read(opts: Opts): Reading;
    function available(): boolean;
}
