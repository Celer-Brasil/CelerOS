// app.mesh.d.ts — tipos do CelerKit MESH (celeros.app.mesh), que decora o
// core (celeros.app.d.ts) com A.mesh e puxa celeros.mesh. Inclua os tres
// d.ts no editor.

declare namespace A {
    interface MeshFrame {
        from: string;
        msg: string;
        hops: number;
        unicast: boolean;
    }
    const mesh: {
        version: string;
        /** 1a letra dos quadros DESTE app (unica na malha; "s" e do Sonar) */
        family(ch: string): void;
        available(): boolean;
        active(): boolean;
        /** portao do celeros.mesh (false = desenhou o card; so falta UI.end) */
        gate(msg?: string, o?: { noRam?: string }): boolean;
        me(): { name: string; caps?: any };
        nodes(): any[];
        /** send(to, op, payload, {copies, urgent}) ou broadcast com o.ttl */
        send(to: string, op: string, payload?: string,
             o?: { copies?: number; urgent?: boolean; ttl?: number }): boolean;
        /**
         * Pedido com resposta: cb(data, from) no quadro "FAM=" com o nonce;
         * data === null = timeout (default 4 s). true se entrou na fila.
         */
        req(to: string, op: string, payload: string,
            cb: (data: string | null, from: string | null) => void,
            timeoutMs?: number): boolean;
        /** drena 1x por frame: respostas + handler(from, op, rest, m) */
        each(handler: (from: string, op: string, rest: string, m: MeshFrame) => void): number;
        /** cache TTL de leituras da malha */
        cache<T>(k: string, ms: number, fill: () => T): T;
    };
}
