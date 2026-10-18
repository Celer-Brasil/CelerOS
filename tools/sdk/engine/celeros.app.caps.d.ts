// app.caps.d.ts — tipos do CelerKit CAPS (celeros.app.caps), que decora o
// core (celeros.app.d.ts) com A.caps. Inclua os dois no editor.

declare namespace A {
    interface Caps {
        /** CELEROS_API_LEVEL do firmware */
        api: number;
        /** id da placa (System.getInfo().board; "host" no harness) */
        board: string;
        /** vidro fisico (o espaco JS continua 240x320) */
        w: number;
        h: number;
        inset: number;
        shape: string;
        /** PSRAM presente (totalPSRAM > 0) */
        psram: boolean;
        battery: boolean;
        speaker: boolean;
        led: boolean;
        light: boolean;
        /** toolkit UI no firmware (CONFIG_CELEROS_UI) */
        touch: boolean;
        /** global Mic (permissao/build) */
        mic: boolean;
        /** global Camera (esp32-cam) */
        camera: boolean;
        /** CelerNet+Pack (placa com BT) */
        bt: boolean;
        /** global Phone (Gadgetbridge, watch) */
        phone: boolean;
        /** 4 MB sem PSRAM (CYD/devkit): encolha caches e pule arte pesada */
        small: boolean;
    }
    const caps: {
        version: string;
        /** sondado na 1a chamada e cacheado */
        probe(): Caps;
        has(name: string): boolean;
    };
}
