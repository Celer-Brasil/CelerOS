// game.kit.d.ts — tipos do modulo CelerGame KIT (celeros.game.kit): carrega
// collide, level, fsm, events, path, steer, stats, inv e script (inclua os
// d.ts deles) e pendura a biblioteca de sons em E.sfx (celeros.sfx.d.ts).

declare namespace E {
    const kit: { version: string };
    /** a dep celeros.sfx (tabela, transpor, via, combo...) */
    const sfx: typeof SFX;
}
