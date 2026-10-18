// game.steer.d.ts — tipos do modulo CelerGame STEER (celeros.game.steer),
// que decora o core (celeros.game.d.ts) com E.steer. Inclua os dois.

declare namespace E {
    interface Mover { x: number; y: number; vx?: number; vy?: number; dead?: boolean; [k: string]: any }
    /** cada comportamento soma uma forca ponderada (w); update() integra e zera */
    interface SteerAgent {
        obj: Mover;
        /** px/s maximo */
        speed: number;
        /** px/s2 maximo */
        force: number;
        /** resposta (default 4) */
        agility: number;
        fx: number; fy: number;
        /** radianos (ultima direcao com velocidade) */
        heading: number;
        seek(x: number, y: number, w?: number): SteerAgent;
        flee(x: number, y: number, w?: number, radius?: number): SteerAgent;
        /** freia dentro de slow px */
        arrive(x: number, y: number, slow?: number, w?: number): SteerAgent;
        /** mira onde o alvo vai estar */
        pursue(t: Mover, w?: number): SteerAgent;
        evade(t: Mover, w?: number, radius?: number): SteerAgent;
        wander(w?: number, o?: { dist?: number; r?: number; jitter?: number; rnd?: () => number }): SteerAgent;
        separate(list: Mover[], radius: number, w?: number): SteerAgent;
        align(list: Mover[], radius: number, w?: number): SteerAgent;
        cohere(list: Mover[], radius: number, w?: number): SteerAgent;
        /** volta para dentro do rect a margin px da borda */
        within(rect: Rect, margin?: number, w?: number): SteerAgent;
        update(dt: number): SteerAgent;
        stop(): SteerAgent;
    }
    const steer: {
        version: string;
        agent(obj: Mover, o?: { speed?: number; force?: number; agility?: number }): SteerAgent;
    };
}
