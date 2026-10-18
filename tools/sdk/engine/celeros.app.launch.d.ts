// app.launch.d.ts — tipos do CelerKit LAUNCH (celeros.app.launch), que
// decora o core (celeros.app.d.ts) com A.launch. Inclua os dois no editor.

declare namespace A {
    interface InstalledApp {
        pkg: string;
        ver: string;
        /** pasta do app ("/local/apps/Loja") */
        dir: string;
        /** raiz do scan ("/local/apps" | "/sd/apps") */
        root: string;
        name: string;
        system: boolean;
        desc: string;
        sd: boolean;
    }
    const launch: {
        version: string;
        /** 1a vista vence (/local antes de /sd); ordenado por nome; cacheado */
        scan(force?: boolean): InstalledApp[];
        refresh(): void;
        installed(pkg: string): InstalledApp | null;
        /** troca para o app (System.launchApp) */
        open(app: InstalledApp | string): void;
        /** linhas p/ UI.list; hub = {pkg: versao} marca atualizacao */
        rows(apps: InstalledApp[], hub?: { [pkg: string]: string }): any[];
    };
}
