// app.updater.d.ts — tipos do CelerKit UPDATER (celeros.app.updater), que
// decora o core (celeros.app.d.ts) com A.updater. Inclua os dois no editor.

declare namespace A {
    interface CatalogEntry {
        version: string;
        changelog?: string;
        zip?: { url: string; size: number; md5: string };
        files?: StageFile[];
        json?: string;
    }
    const updater: {
        version: string;
        /** entrada do catalogo se desatualizado; null = em dia/ausente */
        check(pkg: string, localVer: string, catalog: { [pkg: string]: CatalogEntry }): CatalogEntry | null;
        /**
         * Resolve as deps no indice do hub, baixa o que falta p/
         * /local/modules e devolve o fecho {"dep":"ver"} (ou null).
         */
        promoteDeps(directDeps: { [nome: string]: string }, hubIndex: DepIndex,
                    onProg?: (got: number, total: number) => void): { [nome: string]: string } | null;
        /**
         * Fluxo completo BLOQUEANTE (overlays do core; erro ja mostrado).
         * app = { pkg, name }; upd = saida do check;
         * o = { deps?, hubIndex?, depsResolved? }.
         */
        flow(app: { pkg: string; name: string }, upd: CatalogEntry, o?: {
            deps?: { [nome: string]: string };
            hubIndex?: DepIndex;
            depsResolved?: { [nome: string]: string };
        }): boolean;
    };
}
