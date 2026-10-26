// game.node.d.ts — tipos do modulo CelerGame NODE (celeros.game.node), que
// decora o core (celeros.game.d.ts) com E.node. Inclua os dois.
//
// Hierarquia leve: o filho SEGUE o pai e tem x/y de MUNDO (o tick escreve
// e.x/e.y e _wx/_wy). Posicao de filho se muda por E.node.setPos, nao
// escrevendo e.x a mao.

declare namespace E {
    /** No de hierarquia (campos internos gravados no proprio objeto). */
    interface NodeInfo {
        p: object | null;
        ox: number;
        oy: number;
        /** rotacao local em graus */
        rot: number;
        sx: number;
        sy: number;
        ch: object[];
    }
    const node: {
        version: string;
        /** filho passa a seguir pai; o = {ox, oy, rot (graus), sx, sy}.
         *  false em ciclo (avisa 1x no log) ou entidade invalida */
        attach(filho: object, pai: object, o?: { ox?: number; oy?: number; rot?: number; sx?: number; sy?: number }): boolean;
        /** solta o filho; ele fica onde esta (x/y ja sao de mundo) */
        detach(filho: object): boolean;
        /** offset local (e rotacao opcional) — setter combinado; o pai se
         *  move escrevendo e.x/e.y */
        setPos(e: object, ox?: number, oy?: number, rot?: number): boolean;
        /** recalcula o mundo (pai antes de filho). O E.run ja chama antes do
         *  update; para zero atraso chame depois de mover o pai */
        tick(): void;
        /** x/y de mundo (fora de um no, o proprio e.x/e.y) */
        wx(e: object): number;
        wy(e: object): number;
        /** rotacao de mundo em graus */
        rotOf(e: object): number;
        scaleXOf(e: object): number;
        scaleYOf(e: object): number;
        parentOf(e: object): object | null;
        childrenOf(e: object): object[] | null;
        /** quantos nos estao registrados (diagnostico) */
        count(): number;
    };
}
