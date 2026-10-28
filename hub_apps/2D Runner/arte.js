// arte.js — metadados da arte de IA do Neon Surfer (celeros.game.spr 1.6+).
// A folha ai_atlas e uma grade 4x4 de 64 px (fundo magenta = cor-chave):
// ai0 heroi na prancha, ai1 trem, ai2 moeda. O E.spr.meta monta a grade e
// descreve os clipes; o main.js so pede E.spr.animOf("atlas", "heroi").
// Modulo de dados (module.exports) para nao exigir a permissao "fs".

module.exports = {
    atlas: {
        file: "ai_atlas",
        cols: 4, rows: 4, tw: 64, th: 64, prefix: "ai",
        ax: 0.5, ay: 0.5,          // ancora default: centro do quadro
        anims: { heroi: [0], trem: [1], moeda: [2] },
        fps: { heroi: 6, trem: 4, moeda: 8 },
        loop: { heroi: true, trem: true, moeda: true },
        hitbox: [14, 6, 36, 52]    // dentro do quadro de 64 px (heroi)
    }
};
