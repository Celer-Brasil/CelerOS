// celeros.hid.d.ts — tipos da dep celeros.hid (teclado e mouse Bluetooth LE
// HID/HOGP). Dep do hub: "celeros.hid": "^0.1.0". API 62 + permissao
// "input". Requer o global BT (placas com CELEROS_BLE_HID) e a dep
// celeros.gamepad (parser do Report Map reusado). Fones BT nao existem: o
// radio do S3 nao tem Bluetooth Classic (A2DP) nem ISO/LE Audio.

declare namespace H {
    const version: string;

    type DeviceKind = 'kbd' | 'mouse' | 'combo' | 'pad' | '';

    interface BtReport {
        id: number;
        data: number[];
    }

    interface BtState {
        phase: 'off' | 'idle' | 'scanning' | 'connecting' | 'ready' | 'error';
        addr: string;
        name: string;
        rssi: number;
        battery: number;
        mtu: number;
        /** tipo do device conectado (classificado do Report Map) */
        kind: DeviceKind;
        reports: { id: number; type: number; size: number }[];
        queued: number;
        dropped: number;
        err: string;
    }

    interface HidInfo {
        addr: string;
        name: string;
        rssi: number;
        kind: DeviceKind;
        appearance: number;
    }

    interface ConnResult {
        ok: boolean;
        err?: string;
    }

    interface KeyState {
        /** byte de modificadores HID (bit0 LCtrl .. bit7 RGUI) */
        mods: number;
        /** usage IDs abertos neste report (0x04 = A .. 0x38 = /) */
        keys: number[];
        /** usages que passaram de soltos para abertos desde o feed anterior */
        pressed: number[];
        /** usages que fecharam desde o feed anterior */
        released: number[];
    }

    interface MouseState {
        dx: number;
        dy: number;
        wheel: number;
        /** bit0 esquerdo, bit1 direito, bit2 meio (1..8 botoes) */
        buttons: number;
        pressed: number[];
        released: number[];
    }

    interface KeyboardParser {
        readonly id: number;
        accepts(reportId: number): boolean;
        feed(report: BtReport): KeyState | null;
    }

    interface MouseParser {
        readonly id: number;
        accepts(reportId: number): boolean;
        feed(report: BtReport): MouseState | null;
    }

    interface Device {
        kind: DeviceKind;
        keyboard: KeyboardParser | null;
        mouse: MouseParser | null;
        feed(report: BtReport | null): { kbd?: KeyState; mouse?: MouseState } | null;
    }

    function keyboard(map: number[]): KeyboardParser | null;
    function mouse(map: number[]): MouseParser | null;
    function attach(map: number[], kind?: DeviceKind): Device | null;
    function setup(): Device | null;

    function devices(): HidInfo[];
    function scan(ms?: number): HidInfo[];
    function connect(addr: string): ConnResult;
    function disconnect(): boolean;
    function device(): BtState | null;
    function kind(): DeviceKind;
    function kindOfAppearance(appearance: number): DeviceKind;
}
