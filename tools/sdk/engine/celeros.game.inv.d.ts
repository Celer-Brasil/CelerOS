// game.inv.d.ts — tipos do modulo CelerGame INV (celeros.game.inv), que
// decora o core (celeros.game.d.ts) com E.inv. Inclua os dois.

declare namespace E {
    interface ItemDef {
        name?: string;
        /** pilha maxima (default 99) */
        max?: number;
        /** devolva true para gastar 1 */
        use?: (item: ItemStack, bag: Bag) => boolean | void;
        [k: string]: any;
    }
    interface ItemStack { id: string; n: number }
    interface Bag {
        slots: (ItemStack | null)[];
        size: number;
        onChange: ((b: Bag) => void) | null;
        /** devolve a SOBRA que nao coube (0 = tudo entrou) */
        add(id: string, n?: number): number;
        /** cabe inteiro? */
        fits(id: string, n?: number): boolean;
        /** devolve quantos saiu */
        remove(id: string, n?: number): number;
        count(id: string): number;
        has(id: string, n?: number): boolean;
        slot(i: number): ItemStack | null;
        set(i: number, id: string | null, n?: number): boolean;
        /** arrasta i -> j: mesmo item junta, outro troca */
        move(i: number, j: number): boolean;
        /** divide n para o 1o slot vazio; indice novo ou -1 */
        split(i: number, n: number): number;
        /** def.use(item, bag) true gasta 1 */
        use(i: number): boolean;
        /** slots vazios */
        free(): number;
        isEmpty(): boolean;
        each(fn: (s: ItemStack, i: number) => void): void;
        clear(): void;
        /** junta pilhas e ordena pela ordem do registro */
        sort(): void;
        toJSON(): ([string, number] | null)[];
        load(arr: ([string, number] | null)[]): Bag;
        save(key: string): void;
        /** false se nao havia save */
        restore(key: string): boolean;
    }
    const inv: {
        version: string;
        defs: Record<string, ItemDef>;
        items(table: Record<string, ItemDef>): Record<string, ItemDef>;
        def(id: string): ItemDef | null;
        bag(o?: { slots?: number; onChange?: (b: Bag) => void }): Bag;
    };
}
