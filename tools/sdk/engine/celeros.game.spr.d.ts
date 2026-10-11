// game.spr.d.ts — tipos do modulo CelerGame SPRITES (celeros.game.spr),
// que decora o core (celeros.game.d.ts) com E.spr/E.anim. Inclua os dois.

declare namespace E {
    interface SpriteDef {
        name: string;
        file?: string;        // <base>/<file>.png (bases do init)
        w: number;
        h: number;
        paint?: (w: number, h: number, x: number, y: number) => void;
    }
    interface SpriteSlot { id: number; w: number; h: number; paint: SpriteDef['paint'] | null }
    const spr: {
        version: string;
        bases: string[];
        load(defs: SpriteDef[], opts?: { bases?: string[] }): Record<string, SpriteSlot>;
        has(name: string): boolean;
        /** true se esta num slot real (blit com cor-chave); false = painter */
        backed(name: string): boolean;
        blit(name: string, x: number, y: number,
             opts?: { key?: number; cx?: boolean; cy?: boolean }): void;
        free(name: string): void;
        freeAll(): void;
    };
    interface Anim {
        i: number;
        done: boolean;
        tick(dt: number): void;
        draw(x: number, y: number, opts?: { key?: number }): void;
    }
    function anim(frames: (string | ((x: number, y: number) => void))[],
                  fps?: number, loop?: boolean): Anim;
}
