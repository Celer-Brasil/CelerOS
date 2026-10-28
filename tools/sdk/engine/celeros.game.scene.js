// game.scene.js — CelerGame SCENE (dep "celeros.game.scene"): cena e prefab
// como DADO — entidades descritas em objetos ES5 (tipicamente num modulo de
// dados do app, ex. fase1.js) em vez de codigo de spawn espalhado. Decora o
// core no require:
//
//   var E = require("celeros.game");
//   require("celeros.game.scene");
//   E.scene.def("goblin", { campos: ["hp", "vel"], defaults: { hp: 3 },
//                           create: criaGoblin, start: armaGoblin });
//   var INIMIGOS = [ { tipo: "goblin", x: 100, y: 80, hp: 5, nome: "chefe" },
//                    { tipo: "bau",    x: 200, y: 80, abre: "#chefe" } ];
//   var entes = E.scene.instantiate(INIMIGOS, grupo);   // prefab = lista
//
// O que a cena como dado resolve (e que o spawn espalhado nao dava):
//   - identidade e REFERENCIA entre entidades: um campo com "#nome" (ou
//     "#id") e' resolvido para a entidade ANTES de qualquer start() rodar —
//     ninguem ve referencia nula, e a referencia e' por NOME (estavel entre
//     salvar e carregar), nao por indice;
//   - prefab: a mesma lista instanciada em (x, y) com deslocamento;
//   - save/load do mundo: E.scene.save(grupo) devolve um objeto JSON-safe
//     com versao; load remapeia ids e re-resolve as referencias;
//   - compatibilidade: campo desconhecido no dado sobrevive ao save (um
//     arquivo mais novo nao perde dados ao passar por esta engine) e
//     renomear campo tem caminho (def.rename, { novo: "antigo" }).
//
// Formato (E.scene.formato, versao do ARQUIVO):
//   { version: 1, entidades: [ { tipo, x, y, nome?, ...campos } ] }
// Chaves de topo desconhecidas sao ignoradas; versao MAIOR que a suportada
// e' recusada inteira (load devolve null e avisa) em vez de corromper.
//
// 1.1.0: campo `pai: "#nome"` (+ ox/oy/rot/sx/sy) — o registro vira FILHO
// de outra entidade pelo celeros.game.node (opt-in: a cena nao arrasta o no
// como dep). O parentesco e' ligado na fase 2b do instantiate (depois das
// refs, antes do start) e o save reemite os offsets VIVOS.
//
// 1.1.1: refs "#nome" e "#id" moravam no MESMO objeto (chaves de objeto sao
// strings): uma entidade nomeada "2" era atingida pela ref "#2" da de id 2
// (ou o contrario, pela ordem) — mapas separados, nome vence.
//
// Custo: so quem adota paga; o core nao muda. Uma cena de 30 entidades
// custa um JSON pequeno (o parse e' do Duktape, nao da engine).

var E = require('celeros.game');
var S = System;
var EMPTY = {};
// chaves do registro que NAO sao dado da entidade
var META = { tipo: 1, x: 1, y: 1, id: 1 };

E.scene = {
    version: '1.1.1',
    formato: 1,
    _tipos: {},
    _prefabs: {},
    _migra: {},
    _id: 0,

    // def(tipo, { campos, defaults, rename, create(props), apply(ent, props),
    //             start(ent) })
    //   campos: nomes que viram propriedade da entidade e voltam no save
    //   defaults: valor quando o dado nao traz o campo
    //   rename: { novo: "antigo" } — le a chave antiga quando a nova falta
    //           (dado de versao anterior continua carregando)
    //   create(props) -> objeto base da entidade (update/draw/arte...)
    //   apply(ent, props): depois dos campos, para o que so o tipo sabe
    //   start(ent): depois de TODAS as refs resolvidas (fase 3)
    def: function (tipo, d) {
        d = d || EMPTY;
        // inverso do rename ({vida: "hp"}), para o save nao reemitir a chave
        // antiga junto da nova
        if (d.rename && !d._antigo) {
            var inv = {};
            for (var novo in d.rename) inv[d.rename[novo]] = novo;
            d._antigo = inv;
        }
        E.scene._tipos[tipo] = d;
        return E.scene;
    },
    tipo: function (t) { return E.scene._tipos[t] || null; },

    // cria UMA entidade do tipo; null = tipo nao registrado (avisa 1x)
    spawn: function (tipo, x, y, props) {
        var d = E.scene._tipos[tipo];
        if (!d) { E._warn('cena: tipo nao registrado ' + tipo); return null; }
        props = props || EMPTY;
        var e = d.create ? d.create(props) : {};
        if (!e) return null;
        e.tipo = tipo;
        e.x = x !== undefined ? x : (props.x !== undefined ? props.x : 0);
        e.y = y !== undefined ? y : (props.y !== undefined ? props.y : 0);
        e.id = ++E.scene._id;
        if (props.nome !== undefined) e.nome = props.nome;
        // campos declarados: dado > default do def; rename le a chave antiga
        var cam = d.campos, i, k, v;
        if (cam) {
            for (i = 0; i < cam.length; i++) {
                k = cam[i];
                v = props[k];
                if (v === undefined && d.rename) {
                    var antigo = d.rename[k];
                    if (antigo !== undefined) v = props[antigo];
                }
                if (v !== undefined) e[k] = v;
                else if (d.defaults && d.defaults[k] !== undefined && e[k] === undefined) {
                    e[k] = d.defaults[k];
                }
            }
        }
        // o dado cru fica na entidade (refs por resolver + extras do save)
        e.props = props;
        if (d.apply) d.apply(e, props);
        return e;
    },

    // registra uma lista nomeada (prefab); prefab(nome) devolve a lista
    prefab: function (nome, lista) {
        if (lista === undefined) return E.scene._prefabs[nome] || null;
        E.scene._prefabs[nome] = lista;
        return lista;
    },

    // instancia uma lista (ou um prefab por nome). TRES fases:
    //   1. cria todas (ids novos) e indexa nome/id;
    //   2. resolve as refs "#nome" / "#id" — nenhum start ve ref nula;
    //   3. chama start, na ordem da lista.
    // o = {x, y}: deslocamento (prefab posicionado no mapa).
    instantiate: function (lista, grupo, o) {
        o = o || EMPTY;
        if (typeof lista === 'string') lista = E.scene._prefabs[lista];
        if (!lista) return [];
        var dx = o.x || 0, dy = o.y || 0;
        var criados = [], mapaN = {}, mapaI = {}, i, e, rec, props;
        for (i = 0; i < lista.length; i++) {
            rec = lista[i];
            if (!rec || !rec.tipo) continue;
            props = propsDe(rec);
            e = E.scene.spawn(rec.tipo,
                              rec.x !== undefined ? rec.x + dx : undefined,
                              rec.y !== undefined ? rec.y + dy : undefined, props);
            if (!e) continue;
            if (e.nome !== undefined) mapaN[e.nome] = e;
            mapaI[e.id] = e;
            criados.push(e);
            if (grupo && grupo.add) grupo.add(e);
        }
        // refs "#nome" e "#id" em mapas SEPARADOS: um mapa so (chaves de
        // objeto sao strings) fazia nome "2" e id 2 se sobrescrever — a ref
        // "#2" ia para a entidade errada
        for (i = 0; i < criados.length; i++) resolveRefs(criados[i], mapaN, mapaI);
        // fase 2b: PARENTESCO (pai: "#nome" + ox/oy/rot/sx/sy) — depois das
        // refs e antes do start, para o start ja ler x/y de mundo. Exige o
        // modulo celeros.game.node (opt-in: a cena nao o arrasta como dep)
        for (i = 0; i < criados.length; i++) {
            var f2 = criados[i], pf = f2.props;
            if (!pf || typeof pf.pai !== 'string') continue;
            var chave = pf.pai.charAt(0) === '#' ? pf.pai.substring(1) : pf.pai;
            var pai2 = mapaN[chave] !== undefined ? mapaN[chave] : mapaI[chave];
            if (!pai2 || pai2 === f2) continue;
            if (!E.node) { E._warn('scene: campo pai exige celeros.game.node'); continue; }
            E.node.attach(f2, pai2, { ox: pf.ox, oy: pf.oy, rot: pf.rot, sx: pf.sx, sy: pf.sy });
        }
        for (i = 0; i < criados.length; i++) {
            var d = E.scene._tipos[criados[i].tipo];
            if (d && d.start) d.start(criados[i]);
        }
        return criados;
    },

    // mundo -> dado JSON-safe: campos vivos da entidade + nome + o que veio
    // no dado original e nao e campo conhecido (refs, extras de versao nova).
    // grupo OU array (aceita grupo.items), pula mortos e sem tipo.
    save: function (grupo) {
        var a = grupo && grupo.items ? grupo.items : grupo;
        if (!a) return { version: E.scene.formato, entidades: [] };
        var out = [], i, e, d, rec, cam, k, kk, p, antigo;
        for (i = 0; i < a.length; i++) {
            e = a[i];
            if (!e || e.dead || !e.tipo) continue;
            d = E.scene._tipos[e.tipo] || EMPTY;
            rec = { tipo: e.tipo, x: Math.round(e.x || 0), y: Math.round(e.y || 0) };
            if (e.nome !== undefined) rec.nome = e.nome;
            cam = d.campos;
            if (cam) {
                for (k = 0; k < cam.length; k++) {
                    kk = cam[k];
                    if (e[kk] !== undefined) rec[kk] = refDe(e[kk]);
                }
            }
            p = e.props;
            antigo = d._antigo;
            if (p) {
                for (kk in p) {
                    if (META[kk] || rec[kk] !== undefined) continue;
                    if (antigo && antigo[kk] !== undefined) continue;  // chave ja migrada
                    rec[kk] = refDe(p[kk]);
                }
            }
            // filho de no: reemite o parentesco com os offsets VIVOS (o
            // setPos pode ter mudado desde o dado original; o x/y acima e'
            // de mundo e o load recalcula pelo pai)
            var no = e._no;
            if (no && no.p) {
                rec.pai = no.p.nome !== undefined ? '#' + no.p.nome : '#' + no.p.id;
                rec.ox = no.ox;
                rec.oy = no.oy;
                if (no.rot) rec.rot = no.rot;
                if (no.sx !== 1) rec.sx = no.sx;
                if (no.sy !== 1) rec.sy = no.sy;
            }
            out.push(rec);
        }
        return { version: E.scene.formato, entidades: out };
    },

    // dado -> entities. Versao maior que a suportada e' RECUSADA (null +
    // aviso); versao menor passa pelas migracoes registradas (migra()).
    load: function (dados, grupo, o) {
        if (!dados || !dados.entidades) return null;
        var v = dados.version || 0;
        if (v > E.scene.formato) {
            E._warn('cena: dado versao ' + v + ' > suportada ' + E.scene.formato);
            return null;
        }
        var lista = dados.entidades, i, k;
        if (v < E.scene.formato) {
            // migracoes em ordem crescente de versao (chaves inteiras saem
            // ordenadas; cada fn recebe UM registro e muta)
            for (k in E.scene._migra) {
                if (+k >= v) {
                    for (i = 0; i < lista.length; i++) E.scene._migra[k](lista[i], i);
                }
            }
        }
        return E.scene.instantiate(lista, grupo, o);
    },

    // registra a migracao de DADOS de `versao` para versao+1
    migra: function (versao, fn) {
        E.scene._migra[versao] = fn;
        return E.scene;
    },

    // re-resolve as refs "#nome" de uma entidade contra um grupo vivo — para
    // quem nasce DEPOIS do instantiate (spawn em runtime). Devolve quantas
    // resolveu
    resolve: function (e, grupo) {
        var a = grupo && grupo.items ? grupo.items : grupo;
        if (!e || !a) return 0;
        var mapaN = {}, mapaI = {}, i, o;
        for (i = 0; i < a.length; i++) {
            o = a[i];
            if (!o || o.dead) continue;
            if (o.nome !== undefined) mapaN[o.nome] = o;
            mapaI[o.id] = o;
        }
        return resolveRefs(e, mapaN, mapaI);
    }
};

// props = o registro sem as chaves de controle (copia: o dado do app nao e'
// mutado, e o instantiate pode deslocar x/y sem tocar no original)
function propsDe(rec) {
    var p = {};
    for (var k in rec) {
        if (!Object.prototype.hasOwnProperty.call(rec, k) || META[k]) continue;
        p[k] = rec[k];
    }
    return p;
}

// valor de campo -> dado serializavel: uma entidade apontada por um campo
// vira a REFERENCIA dela ("#nome", ou "#id" sem nome) em vez de embutir o
// objeto inteiro; o resto vai como esta. E' o que faz o save ser JSON-safe e
// o load re-resolver sozinho.
function refDe(v) {
    if (v && typeof v === 'object' && v.tipo !== undefined && v.id !== undefined) {
        return v.nome !== undefined ? '#' + v.nome : '#' + v.id;
    }
    return v;
}

// "#nome" ou "#12" -> entidade. Devolve quantas resolveu; ref sem alvo fica
// como string (o dado sobrevive e o app decide: re-resolve ou ignora).
// Nome vence id na ambiguidade ("#2" com uma entidade NOMEADA "2" e outra de
// id 2 resolve pela nomeada — refs por nome sao o caminho documentado)
function resolveRefs(e, mapaN, mapaI) {
    var p = e.props;
    if (!p) return 0;
    var n = 0;
    for (var k in p) {
        var v = p[k];
        if (typeof v === 'string' && v.charCodeAt(0) === 35) {   // '#'
            var chave = v.substring(1);
            var alvo = mapaN[chave] !== undefined ? mapaN[chave] : mapaI[chave];
            if (alvo !== undefined) { e[k] = alvo; n++; }
        }
    }
    return n;
}

E._mods.push('scene');

module.exports = E;
