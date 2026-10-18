// app.semver.d.ts — tipos do CelerKit SEMVER (celeros.app.semver), que
// decora o core (celeros.app.d.ts) com A.semver. Inclua os dois no editor.

declare namespace A {
    interface DepIndex {
        [nome: string]: { [versao: string]: { deps?: { [nome: string]: string } } };
    }
    const semver: {
        version: string;
        /** numerico parte a parte: "1.10.0" > "1.9.0" */
        cmp(v1: string, v2: string): number;
        gt(a: string, b: string): boolean;
        eq(a: string, b: string): boolean;
        /** "^1.2.3" = mesma major e >= base; sem "^" = exata */
        rangeOk(ver: string, rng: string): boolean;
        /** maior versao de index[nome] que satisfaca TODOS os ranges */
        pick(vers: DepIndex[string] | null, ranges: string[]): string | null;
        /** fecho transitivo sobre o indice do hub; null se nao resolve */
        resolve(want: { [nome: string]: string }, index: DepIndex): { [nome: string]: string } | null;
    };
}
