// game.scene.d.ts — tipos do modulo CelerGame SCENE (celeros.game.scene),
// que decora o core (celeros.game.d.ts) com E.scene. Inclua os dois.

declare namespace E {
    /** Entidade da cena: objeto comum do core (x, y) com tipo/id/nome. */
    interface SceneEnt {
        id: number;
        tipo: string;
        /** nome estavel — alvo das referencias "#nome" e preservado no save */
        nome?: string;
        x: number;
        y: number;
        /** o dado original da entidade (referencias cruas + extras do save) */
        props: Record<string, any>;
        dead?: boolean;
        [k: string]: any;
    }
    /** Registro de tipo do E.scene.def. */
    interface SceneDef {
        /** campos que viram propriedade da entidade e voltam no save */
        campos?: string[];
        /** valor quando o dado nao traz o campo */
        defaults?: Record<string, any>;
        /** { novo: 'antigo' } — le a chave antiga quando a nova falta */
        rename?: Record<string, string>;
        /** objeto base da entidade (update/draw/arte); recebe o dado cru */
        create?: (props: Record<string, any>) => any;
        /** depois dos campos, para o que so o tipo sabe */
        apply?: (ent: SceneEnt, props: Record<string, any>) => void;
        /** roda na fase 3, com TODAS as referencias ja resolvidas */
        start?: (ent: SceneEnt) => void;
    }
    /** Dado de cena (JSON-safe): versao do formato + registros. */
    interface SceneData {
        version: number;
        entidades: Array<Record<string, any>>;
    }
    const scene: {
        version: string;
        /** versao do FORMATO de arquivo (hoje 1); dado mais novo e recusado */
        formato: number;
        def(tipo: string, d: SceneDef): any;
        tipo(tipo: string): SceneDef | null;
        /** cria UMA entidade; null = tipo nao registrado (avisa 1x no log) */
        spawn(tipo: string, x?: number, y?: number,
              props?: Record<string, any>): SceneEnt | null;
        /** registra uma lista nomeada; prefab(nome) devolve a lista */
        prefab(nome: string, lista?: Array<Record<string, any>>): any;
        /** cria todas -> resolve as referencias "#nome"/"#id" -> chama start.
         *  o = {x, y} desloca (prefab posicionado no mapa). Devolve as criadas. */
        instantiate(lista: string | Array<Record<string, any>>, grupo?: any,
                    o?: { x?: number; y?: number }): SceneEnt[];
        /** mundo -> dado JSON-safe (campos vivos + nome + extras); pula mortos */
        save(grupo: any): SceneData;
        /** dado -> entidades, com gate de versao e migracoes; null se recusar */
        load(dados: SceneData, grupo?: any,
             o?: { x?: number; y?: number }): SceneEnt[] | null;
        /** registra a migracao dos DADOS da versao para a seguinte */
        migra(versao: number, fn: (rec: Record<string, any>, i: number) => void): any;
        /** re-resolve as referencias de uma entidade contra o grupo vivo
         *  (para quem nasce depois do instantiate); devolve quantas resolveu */
        resolve(ent: SceneEnt, grupo: any): number;
    };
}
