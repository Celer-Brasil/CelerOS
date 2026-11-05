// celeros.gamepad.d.ts — tipos da dep celeros.gamepad (gamepad Bluetooth LE
// HID/HOGP). Dep do hub: "celeros.gamepad": "^0.1.0". API 57 + permissao
// "input". Requer o global BT (placas com CELEROS_BLE_HID: SmartDisplay,
// watch). DualShock 4 nao funciona (Bluetooth Classic; o radio S3 nao tem).

declare namespace G {
    const version: string;

    interface PadInfo {
        addr: string;
        name: string;
        rssi: number;
        /** appearance GATT 0x03C4. */
        gamepad: boolean;
        hid: boolean;
    }

    interface BtState {
        phase: 'off' | 'idle' | 'scanning' | 'connecting' | 'ready' | 'error';
        addr: string;
        name: string;
        rssi: number;
        battery: number;
        mtu: number;
        reports: { id: number; type: number; size: number }[];
        queued: number;
        dropped: number;
    }

    interface BtReport {
        id: number;
        data: number[];
    }

    interface ConnResult {
        ok: boolean;
        err?: string;
    }

    interface PadState {
        lx: number; ly: number; rx: number; ry: number;
        l2: number; r2: number;
        dpad: string;
        buttons: { [k: string]: boolean };
        /** nomes de botoes apertados neste report. */
        b: string[];
        pressed: string[];
        released: string[];
        battery: number;
    }

    interface Gamepad {
        readonly profile: string;
        dead: number;
        connected: boolean;
        readonly name: string;
        setup(): boolean;
        poll(): PadState | null;
        state(): PadState | null;
        rumble(small: number, big: number, ms: number): boolean;
    }

    function parseMap(map: number[]): {
        reports: { [key: string]: unknown[] };
        ids: string[];
    };
    function axis(raw: number, dead: number): number;

    function pads(): PadInfo[];
    function scan(ms?: number): PadInfo[];
    function connect(addr: string): ConnResult;
    function disconnect(): void;
    function setup(): Gamepad | null;

    // --- globais BT expostos pela dep (docs: JS_API_Guide, API 57) ---
    function btState(): BtState;
    function btRead(): BtReport | null;
    function btWrite(data: number[]): ConnResult;
}
