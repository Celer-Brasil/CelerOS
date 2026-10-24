// celeros.cloud.d.ts — tipos do cliente do plano de controle Celer
// (dep "celeros.cloud"): heartbeat, estado desejado, comandos e outbox.
//
// Config em /local/celercloud.json. Requer API 49 (Net.request) e as
// permissoes "net" (+ "fs" para outbox/config).

interface CelerCloudEvent {
    /** Idempotencia no servidor; se ausente o modulo gera. */
    id?: string;
    type: string;
    severity?: 'info' | 'warning' | 'error' | 'critical';
    payload?: Record<string, unknown>;
}

interface CelerCloudCommand {
    id: string;
    type: string;
    payload?: Record<string, unknown> | null;
    created_at?: string;
}

interface CelerCloudCaps {
    mic?: boolean;
    speaker?: boolean;
    display?: boolean;
    camera?: boolean;
    motors?: boolean;
    leds?: boolean;
    hub?: boolean;
    resources?: boolean;
    [key: string]: boolean | undefined;
}

interface CelerCloudResource {
    name: string;
    type: string;
    unit?: string;
    min?: number;
    max?: number;
    schema?: string;
    busy?: boolean;
    shared?: boolean;
    ready?: boolean;
}

interface CelerCloudHeartbeatExtra {
    kind?: 'display' | 'totem' | 'camera' | 'sensor' | 'watch' | 'generic';
    label?: string;
    board?: string;
    firmware?: string;
    apiLevel?: number;
    uptimeS?: number;
    rssi?: number;
    apps?: Array<{ pkg: string; version: string }>;
    /** Capacidades do device (CelerNet/GPIO/sensores). */
    caps?: CelerCloudCaps;
    /** Recursos expostos (reles, sensores, canais) ate 32 itens. */
    resources?: CelerCloudResource[];
}

interface CelerCloud {
    readonly version: string;
    /** Le /local/celercloud.json (ou `path`). false = sem provisionamento. */
    init(path?: string): boolean;
    configured(): boolean;
    /** Ultima falha (rede/HTTP/config); '' quando o ultimo beat deu certo. */
    lastError(): string;
    /** Estado desejado do ultimo heartbeat (cache em memoria/arquivo). */
    desired(): Record<string, unknown> | null;
    /** Comandos recebidos e ainda nao confirmados (persistidos no FS). */
    commands(): CelerCloudCommand[];
    /**
     * Confirma comando(s) no proximo heartbeat e remove da fila local.
     * Devolve o tamanho da fila de acks.
     */
    ack(id: string | string[]): number;
    /** Enfileira evento idempotente para o proximo heartbeat. */
    report(event: CelerCloudEvent): boolean;
    /** Eventos pendentes na outbox local. */
    pending(): number;
    /**
     * POST autenticado com outbox + acks. `force` ignora o throttle.
     * Devolve o desired em sucesso; null em falha (fila preservada).
     */
    heartbeat(
        extra?: CelerCloudHeartbeatExtra,
        force?: boolean,
    ): Record<string, unknown> | null;
    /** Limpa o estado em memoria (testes). */
    reset(): void;
}

declare const cloud: CelerCloud;
export = cloud;
