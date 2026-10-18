// app.fsx.d.ts — tipos do CelerKit FSX (celeros.app.fsx), que decora o core
// (celeros.app.d.ts) com A.fsx. Inclua os dois no editor.

declare namespace A {
    interface StageFile {
        name: string;
        url: string;
        md5?: string;
    }
    const fsx: {
        version: string;
        free(drive?: string): number;
        hasRoom(bytes: number, drive?: string): boolean;
        /** mkdir -p: cria a arvore; false no primeiro erro */
        ensureDir(p: string): boolean;
        /** bytes da arvore (pastas recursivas) */
        treeSize(dir: string): number;
        copy(src: string, dst: string): boolean;
        /** "" se nao deu */
        md5(file: string): string;
        /**
         * Pacote por arquivos: .new + MD5 + rename em LOTE (app.json por
         * ultimo). Falha apaga os .new; a versao antiga segue. true/false.
         */
        stage(dir: string, files: StageFile[], json?: string,
              onStep?: (nome: string, got: number, total: number) => void): boolean;
        /**
         * Pacote unico (API 42): null = firmware sem suporte (use stage),
         * false = erro, true = instalou.
         */
        zipBlob(url: string, appName: string, md5: string,
                onProg?: (got: number, total: number) => void): boolean | null;
    };
}
