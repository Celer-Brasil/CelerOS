// app.ai.d.ts — tipos do CelerKit AI (celeros.app.ai), que decora o core
// (celeros.app.d.ts) com A.ai. Inclua os dois no editor.

declare namespace A {
    interface AiMsg {
        r: 'user' | 'assistant';
        s: string;
    }
    interface AiClient {
        /** pedido em voo (retry dos 502/504/429 em curso) */
        busy: boolean;
        /** [{r,s}] persistido em appData */
        hist: AiMsg[];
        /** false = firmware sem o objeto AI */
        ok: boolean;
        /** false = busy/sem AI/sem chave/sem rede (o motivo saiu no err) */
        send(text: string): boolean;
        cancel(): boolean;
        clear(): void;
    }
    const ai: {
        version: string;
        /**
         * o.system = prompt de sistema; o.ctx = mensagens de contexto (12);
         * o.max = guardadas (20); o.maxTokens (400); o.file ("historico.json").
         * Callbacks: onmsg(papel, s), note(s), err(s).
         */
        client(o?: {
            system?: string;
            ctx?: number;
            max?: number;
            maxTokens?: number;
            file?: string;
            onmsg?: (papel: string, s: string) => void;
            note?: (s: string) => void;
            err?: (s: string) => void;
        }): AiClient;
    };
}
