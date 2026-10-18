// game.stats.d.ts — tipos do modulo CelerGame STATS (celeros.game.stats),
// que decora o core (celeros.game.d.ts) com E.stats. Inclua os dois.

declare namespace E {
    interface StatMod { stat: string; add: number; mul: number; until: number; id?: any; remove(): void }
    interface Stats {
        base: Record<string, number>;
        /** vida corrente (teto = get('hp')) */
        hp: number;
        dead: boolean;
        mods: StatMod[];
        /** ms invencivel apos levar dano */
        iframes: number;
        lastHit: number;
        level: number;
        xp: number;
        onHit: ((s: Stats, dano: number, fonte?: any, dir?: { x: number; y: number } | null) => void) | null;
        /** direcao do ultimo golpe (damage {dir}) */
        lastDir: { x: number; y: number } | null;
        onDeath: ((s: Stats, fonte?: any) => void) | null;
        onLevel: ((s: Stats, nivel: number) => void) | null;
        /** (base + soma add) x produto mul */
        get(name: string): number;
        /** bonus; mesmo id substitui; sem ms = permanente */
        mod(name: string, o?: { add?: number; mul?: number; ms?: number; id?: any }): StatMod;
        unmod(id: any): void;
        hasMod(id: any): boolean;
        maxHp(): number;
        hpMax(): number;
        full(): boolean;
        /** true = NAO desenhe neste quadro (pisca nos iframes; periodo ms, 80) */
        blink(ms?: number): boolean;
        invuln(): boolean;
        /** - def (pierce ignora), minimo 1; 0 nos iframes (force fura). Devolve o aplicado */
        damage(n: number, o?: { pierce?: boolean; force?: boolean; source?: any; dir?: { x: number; y: number } | null }): number;
        heal(n: number): number;
        revive(hp?: number): void;
        /** vida 0..1 */
        frac(): number;
        /** true (e comeca a recarga) se pronta */
        cool(name: string, ms: number): boolean;
        ready(name: string): boolean;
        coolLeft(name: string): number;
        /** 0..1 ja recarregado */
        coolFrac(name: string): number;
        resetCool(name?: string): void;
        xpNeed(): number;
        /** devolve quantos niveis subiu */
        addXp(n: number): number;
        toJSON(): { base: Record<string, number>; hp: number; level: number; xp: number };
        load(v: { base?: Record<string, number>; hp?: number; level?: number; xp?: number }): Stats;
    }
    /** Atributos, bonus temporarios, vida com iframes, recargas e XP (relogio do jogo). */
    const stats: {
        version: string;
        (base: Record<string, number>, o?: {
            iframes?: number;
            onHit?: (s: Stats, dano: number, fonte?: any, dir?: { x: number; y: number } | null) => void;
            onDeath?: (s: Stats, fonte?: any) => void;
            onLevel?: (s: Stats, nivel: number) => void;
            /** custo do nivel: base * grow^(nivel-1) */
            xp?: { base?: number; grow?: number };
        }): Stats;
        /** ms do relogio de jogo */
        now(): number;
    };
}
