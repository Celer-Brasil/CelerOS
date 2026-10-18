// celeros.sfx.d.ts — tipos da dep celeros.sfx (biblioteca de sfx chiptune).
// Dep do hub (app.json "deps"): "celeros.sfx": "^1.0.0".

declare namespace SFX {
    const version: string;
    /** Melodia = [[freq, ms], ...] (formato do playTone). */
    type Mel = number[][];
    /** Tabela por intencao: ui, ok, back, erro, hit, zap, soco, bicho, coin,
     *  power, vida, boomPeq, boomGra, boomBoss, chute, escudo, tick, alerta,
     *  planta, morte, vitoria, derrota, recorde. */
    const tabela: Record<string, number[] | Mel>;
    /** Copia a melodia nomeada (ou null). */
    function mel(nome: string): Mel | null;
    /** Desloca em semitons (freq 0/pausa preservada). */
    function transpor(mel: Mel, semi: number): Mel;
    /** Estica (fator > 1) ou encurta as duracoes (min 15 ms). */
    function tempo(mel: Mel, fator: number): Mel;
    /** Transpoe por um sorteio inteiro em [-semi, +semi] (default 2); rnd opcional. */
    function varia(mel: Mel, semi?: number, rnd?: () => number): Mel;
    /** Melodias/nomes em fila; ultima arg {pausa: ms} entre elas. */
    function junta(...partes: (string | number[] | Mel | { pausa?: number })[]): Mel;
    /** Notas base*2^(s/12) em fila (null = pausa). */
    function arpejo(base: number, semis: (number | null)[], ms?: number): Mel;
    /** Toca pelo E.audio: opts {duck ms (abafa a trilha), oitava, velocidade, varia (semitons)}. */
    function via(audio: { sfx(what: any): void; duck?(ms: number): boolean } | null,
                 nome: string, opts?: { duck?: number; oitava?: number; velocidade?: number;
                                        varia?: number; rnd?: () => number }): boolean;
}
