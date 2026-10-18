// game.combat.d.ts — tipos do modulo CelerGame COMBAT (celeros.game.combat),
// que decora o core (celeros.game.d.ts) com E.combat. Inclua os dois (e
// celeros.game.stats.d.ts / celeros.game.collide.d.ts).

declare namespace E {
    interface CombatEnt { x: number; y: number; w?: number; h?: number; vx?: number; vy?: number;
                          hp?: number; dead?: boolean; [k: string]: any }
    interface CombatBody {
        ent: CombatEnt; team: string; stats: Stats | null;
        ox: number; oy: number; w?: number; h?: number;
        /** 0..1 (1 = nao recua) */
        knockRes: number;
        /** ms invencivel apos golpe (corpo sem stats) */
        iframes: number;
        dead: boolean;
        remove(): void;
    }
    interface HitOpts {
        /** default: o time do dono; '*' fere todos */
        team?: string;
        dmg?: number;
        /** px/s de empurrao */
        knock?: number;
        /** ms que o empurrao dura (180) */
        knockMs?: number;
        /** vida da hitbox (100) */
        ms?: number;
        /** cada alvo 1x por hitbox (default true) */
        once?: boolean;
        /** ms atordoado (sem andar) */
        stun?: number;
        /** hitstop ms (0 desliga; default E.combat.hitstop) */
        stop?: number;
        onHit?: (alvo: CombatEnt, h: Hitbox) => void;
    }
    interface Hitbox { owner: any; team: string; dmg: number; t: number; ms: number; dead: boolean }
    interface Shot {
        owner: any; x: number; y: number; vx: number; vy: number; r: number;
        team: string; dmg: number; t: number; life: number; dead: boolean;
        /** bumerangue voltando */
        back: boolean;
        /** px percorridos */
        dist: number;
    }
    const combat: {
        version: string;
        /** ms de congelamento por golpe que acerta (0 desliga) */
        hitstop: number;
        body(ent: CombatEnt, o?: {
            team?: string; stats?: Stats; ox?: number; oy?: number; w?: number; h?: number;
            knockRes?: number; iframes?: number;
            /** true = ignora o golpe (escudo, invulneravel de frente) */
            immune?: (src: any, hit: any) => boolean;
            onHit?: (ent: CombatEnt, dano: number, src: any) => void;
            onKill?: (ent: CombatEnt, src: any) => void;
        }): CombatBody;
        /** hitbox viva por ms: shape de mundo ou fn() -> shape (segue o dono) */
        hit(owner: any, shape: Shape | (() => Shape), o?: HitOpts): Hitbox;
        /** golpe a frente do dono (dir 'up'|'down'|'left'|'right' ou vetor) */
        sword(owner: CombatEnt, dir: string | { x: number; y: number },
              o?: HitOpts & { reach?: number; width?: number }): Hitbox;
        /** explosao circular por 1 tick (team '*' por padrao) */
        blast(x: number, y: number, r: number, o?: HitOpts & { owner?: any }): Hitbox;
        /** projetil; boomerang {range, speed} vai e volta ao dono */
        shot(owner: any, o: {
            x: number; y: number; vx?: number; vy?: number; r?: number; dmg?: number; knock?: number;
            life?: number; team?: string; pierce?: boolean; stun?: number;
            map?: { solidAt(x: number, y: number): boolean };
            boomerang?: { range?: number; speed?: number };
            onWall?: (s: Shot) => void;
            onHit?: (alvo: CombatEnt, s: Shot, dano: number) => void;
            onBack?: (s: Shot) => void;
        }): Shot;
        /** empurra ent com (kx, ky) px/s decaindo em ms */
        knock(ent: CombatEnt, kx: number, ky: number, ms?: number): void;
        knocked(ent: CombatEnt): boolean;
        stunned(ent: CombatEnt): boolean;
        /** anda (vx, vy) + knockback em dt; com map desliza na parede (collide.move) */
        move(ent: CombatEnt, dt: number, map?: { rectSolid(x: number, y: number, w: number, h: number): boolean;
                                                  cw?: number; ch?: number } | null): MoveResult | null;
        count(): { bodies: number; hits: number; shots: number };
        clear(): void;
        /** entidades vivas de um time */
        team(name: string): CombatEnt[];
        /** desenha os projeteis (fn por projetil ou circulo na cor) */
        drawShots(fn?: ((s: Shot) => void) | null, color?: number): void;
        shots(): Shot[];
    };
}
