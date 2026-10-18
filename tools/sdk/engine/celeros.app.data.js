// app.data.js — CelerKit DATA (dep "celeros.app.data"): persistencia JSON
// sem ceremony — o par load/save com try/catch que ~6 apps reescrevem, o
// blob no Storage (NVS privado do app) e o cache com carimbo de idade
// (padrao Previsao/Loja: guarda a resposta da rede e so refresca quando velha).
//
//   var A = require("celeros.app");
//   require("celeros.app.data");
//   var cfg = A.data.load("/local/data/x/config.json", { tema: 1 });
//   A.data.save("/local/data/x/config.json", cfg);
//   A.data.saveState("recorde", { pts: 120 });   // Storage (NVS)
//   var hist = A.data.loadState("recorde", {});
//
// Cache com carimbo (a resposta da rede mora em ARQUIVO, nao so em RAM —
// sobrevive a saida do app):
//   var c = A.data.load(arq, null);
//   if (A.data.stale(c, 3600000)) { c = { at: A.now(), v: baixar() }; A.data.save(arq, c); }
//   usar(c.v);
//
// A.data.file("x.json") junta com a pasta privada do app (FS.appData()).

var A = require('celeros.app');

A.data = {
    version: '1.0.0',

    // JSON de arquivo; qualquer erro (arquivo ausente, JSON quebrado) cai no
    // fallback — igual ao try/catch que os apps fazem a mao
    load: function (file, fallback) {
        try {
            var s = FS.readTextFile(file);
            if (s) {
                var v = JSON.parse(s);
                if (v !== undefined && v !== null) return v;
            }
        } catch (e) { /* cai no fallback */ }
        return fallback;
    },

    save: function (file, v) {
        try { return FS.writeTextFile(file, JSON.stringify(v)); } catch (e) { return false; }
    },

    // blob JSON no Storage (NVS privado do pacote; valores grandes vao de
    // arquivo — o NVS tem teto)
    loadState: function (key, fallback) {
        try {
            var s = Storage.get(key);
            if (s) return JSON.parse(s);
        } catch (e) { /* cai no fallback */ }
        return fallback;
    },

    saveState: function (key, v) {
        try { return Storage.set(key, JSON.stringify(v)); } catch (e) { return false; }
    },

    // cache velho? (cache null/sem carimbo/mais velho que maxAgeMs = velho)
    stale: function (cache, maxAgeMs) {
        if (!cache || !cache.at) return true;
        return (System.millis() - cache.at) >= maxAgeMs;
    },

    // caminho dentro da pasta privada do app ("" sem permissao fs: cai no
    // diretorio corrente, o app sem "fs" ja vai falhar no write e o load
    // devolve o fallback)
    file: function (name) {
        var d = '';
        try { d = FS.appData() || ''; } catch (e) { d = ''; }
        return d ? d + name : String(name);
    }
};

A._mods.push('data');

module.exports = A;
