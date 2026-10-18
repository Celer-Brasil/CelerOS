// app.kit.d.ts — tipos do CelerKit KIT (celeros.app.kit): apenas selo de
// versao — o pacote requer os modulos (cada um traz seu proprio d.ts sobre
// o core, celeros.app.d.ts). Inclua os d.ts dos modulos do fecho.

declare namespace A {
    const kit: {
        version: string;
    };
}
