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
        /** 1 PNG num UNICO slot + regioes nomeadas ([cx, cy] em celulas tw x th, ou [x, y, w, h] livre). Regioes viram nomes de sprite de 1a classe (blit/anim). */
        sheet(name: string, o: {
            file?: string; w: number; h: number; tw?: number; th?: number;
            regions: Record<string, number[]>;
            /** fallback procedural por regiao: paint(nome, x, y) — usado sem slot ou sem setClip */
            paint?: (nome: string, x: number, y: number) => void;
        }): Record<string, SpriteSlot>;
        /** sheet em grade: celulas viram prefix+indice (0.., em linhas) num slot so */
        grid(name: string, o: { file?: string; cols?: number; rows?: number; tw?: number; th?: number;
                                w?: number; h?: number; prefix?: string;
                                paint?: (nome: string, x: number, y: number) => void }): Record<string, SpriteSlot>;
        /** nomes prefix+a .. prefix+b (inclusivo; a > b conta para tras) */
        frames(prefix: string, a: number, b: number): string[];
        /** libera o slot do sheet e todas as regioes dele */
        freeSheet(name: string): void;
        has(name: string): boolean;
        /** true se esta num slot real (blit com cor-chave); false = painter */
        backed(name: string): boolean;
        /** Blit do sprite/regiao. Sem slot E sem painter (PNG falhou e a def
         *  nao trouxe paint) e no-op seco — nada desenha, nada entra na camada. */
        blit(name: string, x: number, y: number,
             opts?: { key?: number; cx?: boolean; cy?: boolean;
                      /** ancora 0..1 (ax 0.5 + ay 1 = x,y e o pe) */
                      ax?: number; ay?: number }): void;
        /** {w, h} do sprite/regiao, ou null */
        size(name: string): { w: number; h: number } | null;
        free(name: string): void;
        freeAll(): void;
    };
    type AnimFrame = string | ((x: number, y: number) => void);
    type AnimLoop = boolean | 'pingpong';
    interface Anim {
        frames: AnimFrame[];
        fps: number;
        loop: AnimLoop;
        /** tempo acumulado (s) */
        t: number;
        i: number;
        done: boolean;
        /** fim de cada volta (loop/pingpong) ou fim unico (sem loop) */
        onEnd: ((a: Anim) => void) | null;
        tick(dt: number): void;
        reset(): Anim;
        /** troca o clipe; o MESMO frames nao recomeca (seguro por quadro) */
        play(frames: AnimFrame[], fps?: number, loop?: AnimLoop): Anim;
        draw(x: number, y: number, opts?: { key?: number; cx?: boolean; cy?: boolean;
                                             ax?: number; ay?: number }): void;
    }
    function anim(frames: AnimFrame[], fps?: number, loop?: AnimLoop): Anim;
}
