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

interface CelerCloudHeartbeatExtra {
    kind?: 'display' | 'totem' | 'camera' | 'sensor' | 'watch' | 'generic';
    label?: string;
    board?: string;
    firmware?: string;
    apiLevel?: number;
    uptimeS?: number;
    rssi?: number;
    apps?: Array<{ pkg: string; version: string }>;
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
    /** Drena os comandos recebidos no ultimo heartbeat. */
    commands(): CelerCloudCommand[];
    /** Confirma comando(s) no proximo heartbeat. Devolve o tamanho da fila. */
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
