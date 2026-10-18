// app.data.d.ts — tipos do CelerKit DATA (celeros.app.data), que decora o
// core (celeros.app.d.ts) com A.data. Inclua os dois no editor.

declare namespace A {
    interface Cache<T> {
        /** carimbo System.millis() da gravacao */
        at: number;
        v: T;
    }
    const data: {
        version: string;
        /** JSON de arquivo; qualquer erro cai no fallback */
        load<T = any>(file: string, fallback: T): T;
        save(file: string, v: any): boolean;
        /** blob JSON no Storage (NVS privado do pacote) */
        loadState<T = any>(key: string, fallback: T): T;
        saveState(key: string, v: any): boolean;
        /** true se o cache nao existe ou passou de maxAgeMs */
        stale<T>(cache: Cache<T> | null, maxAgeMs: number): boolean;
        /** caminho na pasta privada do app (FS.appData()) */
        file(name: string): string;
    };
}
