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
        /** desenha no alvo CORRENTE (quadro ou sprite do useSprite), com escala
         *  (drawSprite, API 33); key null = opaco. false se nada desenhavel */
        stamp(name: string, x: number, y: number,
              o?: { scale?: number; key?: number | null; cx?: boolean; cy?: boolean;
                    ax?: number; ay?: number }): boolean;
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
        /** ao trocar de quadro (passo com som, golpe que acerta no quadro 3) */
        onFrame: ((a: Anim, i: number) => void) | null;
        /** multiplicador do tempo (2 = o dobro) */
        speed: number;
        tick(dt: number): void;
        reset(): Anim;
        /** troca o clipe; o MESMO frames nao recomeca (so ajusta fps/loop — seguro por quadro) */
        play(frames: AnimFrame[], fps?: number, loop?: AnimLoop): Anim;
        /** opts.scale (1.4) desenha pelo stamp (escala e alvo corrente) */
        draw(x: number, y: number, opts?: { key?: number; cx?: boolean; cy?: boolean;
                                             ax?: number; ay?: number; scale?: number }): void;
    }
    function anim(frames: AnimFrame[], fps?: number, loop?: AnimLoop): Anim;
    interface DirAnim extends Anim {
        clips: Record<string, AnimFrame[]>;
        facing: string;
        walking: boolean;
        /** troca o clipe da direcao sem zerar o passo */
        face(dir: string): DirAnim;
        /** false para no quadro 0 (parado) */
        walk(on: boolean): DirAnim;
    }
    namespace anim {
        /** clipes por direcao {down, up, left, right} */
        function dir(clips: { down?: AnimFrame[]; up?: AnimFrame[]; left?: AnimFrame[]; right?: AnimFrame[] },
                     fps?: number, loop?: AnimLoop): DirAnim;
    }
}
