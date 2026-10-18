// game.world.d.ts — tipos do modulo CelerGame WORLD (celeros.game.world),
// que decora o core (celeros.game.d.ts) com E.world. Inclua os dois (e
// celeros.game.level.d.ts).

declare namespace E {
    /** sala: linhas ASCII ou {lines, legend, meta} */
    type WorldRoomDef = string[] | string | { lines: string[] | string; legend?: Record<string, any>; meta?: any };
    interface WorldArea { w: number; h: number; legend?: Record<string, any>; rooms: Record<string, WorldRoomDef> }
    interface WorldRoom {
        id: string; area: string; c: number; r: number;
        lv: Level;
        /** valores por celula (mutaveis; W.set) */
        data: any[];
        meta: any;
    }
    interface World {
        version: string;
        cols: number; rows: number; cell: number; cw: number; ch: number; ox: number; oy: number;
        /** tamanho da sala em px */
        pw: number; ph: number;
        area: string | null;
        room: WorldRoom | null;
        sliding: boolean;
        slideDir: string | null;
        /** 0..1 do slide */
        slideP: number;
        slideMs: number;
        visited: Record<string, boolean>;
        flags: Record<string, Record<string, any>>;
        global: Record<string, any>;
        /** sala gravada num sprite (drawSprite) */
        baked: boolean;
        outside: boolean;
        onEnter: ((room: WorldRoom, w: World) => void) | null;
        onExit: ((room: WorldRoom, w: World) => void) | null;
        has(area: string, c: number, r: number): boolean;
        flag(k: string, v?: any): any;
        flagIn(roomId: string, k: string, v?: any): any;
        gflag(k: string, v?: any): any;
        /** spawns da sala menos os ja tomados (take) */
        spawns(): (Spawn & { i: number })[];
        take(spawn: Spawn & { i: number }): void;
        get(c: number, r: number): any;
        /** muda a celula (repinta); persist grava na sala */
        set(c: number, r: number, v: any, persist?: boolean): boolean;
        /** mudanca persistente numa celula de OUTRA sala (area, sala c/r, celula c/r) */
        setIn(area: string, rc: number, rr: number, c: number, r: number, v: any): boolean;
        cellRect(c: number, r: number): Rect;
        toCell(x: number, y: number): { c: number; r: number } | null;
        find(v: any): { c: number; r: number }[];
        solidAt(x: number, y: number): boolean;
        rectSolid(x: number, y: number, w: number, h: number): boolean;
        /** a mesma colisao com a borda da sala solida (monstros e tiros nao saem pelas aberturas) */
        fechado: { cw: number; ch: number; ox: number; oy: number;
                   solidAt(x: number, y: number): boolean;
                   rectSolid(x: number, y: number, w: number, h: number): boolean };
        /** custo para o E.path (parede -1) */
        cost(c: number, r: number): number;
        /** painter da camada suja (E.dirty.enable(W.painter)) */
        painter(x: number, y: number, w: number, h: number): void;
        drawRoom(): void;
        /** entra direto (corte seco) */
        go(area: string, c: number, r: number): WorldRoom;
        neighbor(dir: string): { area: string; c: number; r: number } | null;
        /** desliza para a vizinha; false se nao ha */
        move(dir: 'left' | 'right' | 'up' | 'down'): boolean;
        /** deslocamento de quem esta na sala nova durante o slide */
        slideShift(): { x: number; y: number };
        /** borda cruzada pelo centro da entidade */
        edge(ent: { x: number; y: number; w?: number; h?: number }): 'left' | 'right' | 'up' | 'down' | null;
        /** poe a entidade na borda oposta */
        wrapEnt(ent: { x: number; y: number; w?: number; h?: number }, dir: string): void;
        /** no draw da cena, antes das entidades */
        draw(): void;
        minimap(x: number, y: number, o?: { size?: number; gap?: number; color?: number; here?: number;
                                            dim?: number; reveal?: boolean }): { w: number; h: number };
        toJSON(): { flags: any; global: any; visited: any };
        load(v: { flags?: any; global?: any; visited?: any }): World;
        save(): void;
        restore(): boolean;
        reset(): void;
        free(): void;
    }
    /** Mundo em salas do tamanho da tela (overworld/masmorra), slide e estado por sala. */
    const world: {
        version: string;
        (o: {
            cols?: number; rows?: number; cell?: number; ox?: number; oy?: number;
            legend?: Record<string, any>;
            areas: Record<string, WorldArea>;
            /** desenha UMA celula (tambem no sprite gravado: use E.spr.stamp) */
            paint: (v: any, x: number, y: number, w: number, h: number, c: number, r: number) => void;
            solid?: (v: any, c: number, r: number) => boolean;
            anim?: { ms?: number; frames: Record<string, any[]> };
            /** cor de fora da sala no sprite gravado */
            bg?: number;
            /** por cima dos tiles, na gravacao */
            decor?: (room: WorldRoom, w: World) => void;
            /** false: sem sprite gravado (desenho por celula) */
            bake?: boolean;
            slideMs?: number;
            /** chave do E.save para flags/visitas */
            save?: string;
            autosave?: boolean;
            outside?: boolean;
            onEnter?: (room: WorldRoom, w: World) => void;
            onExit?: (room: WorldRoom, w: World) => void;
        }): World;
    };
}
