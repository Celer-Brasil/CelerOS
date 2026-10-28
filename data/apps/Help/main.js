// CelerOS Help 2.0 (Central de Ajuda) — app de sistema. Conteudo offline em
// secoes com topicos (CelerOS, gestos, Wi-Fi, apps, API, notas de versao e
// problemas comuns), busca por texto e a ajuda online do hub. UI kit 2.0
// (celeros.app.style/icons/list): hero card, botoes tokenizados e listas
// ricas; o leitor rolavel e o A.text.viewer (saneamento Latin-1) e a rede e
// o A.net (getJSON que nunca estoura + espera de Wi-Fi), com o indice online
// cacheado na sessao. A.run e dono do frame.

var A = require("celeros.app");
require("celeros.app.net");
require("celeros.app.text");
require("celeros.app.list");
require("celeros.app.style");
require("celeros.app.icons");

A.init();
var T = A.T;
var L = A.L;

// ---- conteudo offline -------------------------------------------------------
var SEC = [
    { n: "Primeiros Passos", i: "play", t: [
        { t: "O que é o CelerOS", d: "Visão do sistema",
          c: "O CelerOS é um sistema rápido e leve para o ESP32, com loja de apps, apps JavaScript no cartão SD ou na memória interna e interface fluida no toque." },
        { t: "Como começar", d: "Wi-Fi e cartão SD",
          c: "Abra Configurações > Wi-Fi para conectar. Para instalar apps de usuário, use um cartão SD em FAT32 com a pasta apps/." },
        { t: "Tipos de app", d: "Sistema e usuário",
          c: "Apps de sistema (Ajustes, Launcher) rodam em C++ integrado. Apps de usuário rodam no runtime JavaScript, do cartão SD ou da memória local." }
    ]},
    { n: "Gestos e Navegação", i: "menu", t: [
        { t: "Tela inicial", d: "Apps e launcher",
          c: "Os apps de sistema ficam no topo e os de usuário abaixo. Toque para abrir e arraste a lista para navegar." },
        { t: "Abrir e fechar", d: "Toque e botão X",
          c: "Toque no nome de um app para abri-lo. Para fechar, toque no X do canto superior direito e volte ao launcher." },
        { t: "Bordas da tela", d: "Painéis rápidos",
          c: "Arraste do topo: à esquerda os ajustes rápidos, no centro as notificações (X no cabeçalho) e à direita a barra superior do app." }
    ]},
    { n: "Wi-Fi e Rede", i: "wifi", t: [
        { t: "Conectar Wi-Fi", d: "Configurações > Wi-Fi",
          c: "Em Configurações > Wi-Fi o aparelho escaneia as redes. Toque numa rede, digite a senha e confirme. O ESP32 usa 2,4 GHz." },
        { t: "Sem rede", d: "Modo offline",
          c: "Sem Wi-Fi continuam funcionando apps, relógio, alarmes e arquivos locais. Loja, ajuda online e atualizações precisam de rede." },
        { t: "Servidor web", d: "Arquivos pelo navegador",
          c: "O app Web Server liga um servidor na porta 80 com file manager, upload e OTA, protegido por login e senha. Abra http://IP-do-aparelho na mesma rede." }
    ]},
    { n: "Loja e Apps", i: "star", t: [
        { t: "App Store", d: "Instalar e atualizar",
          c: "A App Store lista os apps do hub. Toque para ver descrição, changelog e tamanho; apps instalados ganham Atualizar quando há versão nova." },
        { t: "Instalar do cartão SD", d: "App Installer",
          c: "Copie a pasta do app para /sd/apps e abra o Installer: ele mostra versão, tamanho e espaço livre, instala na memória ou no cartão e confere o MD5." },
        { t: "Criar seus apps", d: "SDK celer.js",
          c: "O SDK (npm celer) cria o projeto, roda o lint, testa no emulador e publica na loja. Apps são JavaScript ES5 no espaço virtual 240x320." }
    ]},
    { n: "API e Recursos", i: "gear", t: [
        { t: "Timers e notificações", d: "API 12",
          c: "setTimeout/setInterval, Storage (NVS do app), sprites fora da tela, System.notify (centro de notificações) e System.playTone." },
        { t: "Sons e áudio", d: "API 12 e 13",
          c: "playTone toca melodias; playWav toca WAV PCM 16-bit de /local ou /sd; setVolume ajusta o volume. Placas sem áudio digital tocam só tons." },
        { t: "Sensores e relógio", d: "API 13",
          c: "No watch, Sensors.accel, steps e temp. System.getWeekday dá o dia da semana e keepAwake(ms) mantém a tela ligada." }
    ]},
    { n: "Notas de Versão", i: "info", t: [
        { t: "CelerOS 2026.10", d: "UI 2.0 e CelerKit",
          c: "Traz o CelerKit UI 2.0 (tokens, cards, listas ricas e ícones) nos apps de sistema, o Celer Studio, USB Host no devkit-S3 e o agente de frota. A CYD ganhou o perfil lite." },
        { t: "Como atualizar", d: "OTA e cartão",
          c: "Configurações > Atualização baixa o firmware pelo hub. O OTA troca só o sistema: para os apps use a App Store ou o flash_data.sh." }
    ]},
    { n: "Problemas Comuns", i: "alert", t: [
        { t: "Tela preta", d: "App travado",
          c: "Se um app travar, o sistema mostra uma tela de erro: toque para voltar ao launcher. Em placas sem PSRAM, apps grandes podem não caber." },
        { t: "App não instala", d: "Pacote ou espaço",
          c: "Confira o espaço livre no destino e o packageName no app.json (minúsculas, com ponto). Apps com dependências precisam do deps.json no pacote." }
    ]}
];

// ---- estado ----------------------------------------------------------------
var gato = 0;        // secao offline aberta
var ocats = null;    // indice online (cache da sessao): [{name,url}]
var oarts = null;    // artigos da categoria online aberta
var ocat = 0;
var buscaQ = "";
var buscaRes = [];
var stampBusca = 0;

// ---- listas com cache por carimbo ------------------------------------------
function plural(n) { return n + (n === 1 ? " tópico" : " tópicos"); }
var linhasSec = A.list.make(function () { return SEC; }, function () {
    var out = [];
    for (var i = 0; i < SEC.length; i++) {
        out.push({ label: SEC[i].n, sub: plural(SEC[i].t.length), icon: SEC[i].i });
    }
    return out;
});
var linhasTop = A.list.make(function () { return gato; }, function () {
    var tp = SEC[gato].t, out = [];
    for (var i = 0; i < tp.length; i++) {
        out.push({ label: tp[i].t, sub: tp[i].d, icon: SEC[gato].i });
    }
    return out;
});
var linhasRes = A.list.make(function () { return stampBusca; }, function () {
    var out = [];
    for (var i = 0; i < buscaRes.length; i++) {
        out.push({ label: buscaRes[i].t, sub: buscaRes[i].s, icon: "search" });
    }
    return out;
});
var linhasOcat = A.list.make(function () { return ocats; }, function () {
    var out = [];
    for (var i = 0; i < ocats.length; i++) out.push({ label: ocats[i].name, icon: "star" });
    return out;
});
var linhasOart = A.list.make(function () { return oarts; }, function () {
    var out = [];
    for (var i = 0; i < oarts.length; i++) out.push({ label: oarts[i].title, icon: "info" });
    return out;
});

// ---- busca offline ----------------------------------------------------------
function buscarTudo() {
    var termo = System.prompt("Buscar na ajuda", "", { nullOnCancel: true });
    if (!termo) return false;
    buscaQ = String(termo).toLowerCase();
    buscaRes = [];
    for (var i = 0; i < SEC.length && buscaRes.length < 20; i++) {
        for (var j = 0; j < SEC[i].t.length && buscaRes.length < 20; j++) {
            var tp = SEC[i].t[j];
            var alvo = (tp.t + " " + tp.d + " " + tp.c).toLowerCase();
            if (alvo.indexOf(buscaQ) >= 0) {
                buscaRes.push({ t: tp.t, s: SEC[i].n, c: tp.c });
            }
        }
    }
    stampBusca++;
    return true;
}

// ---- ajuda online -----------------------------------------------------------
// UM frame de ocupado, Wi-Fi conferido (A.wifiWait deixa o usuario ligar a
// rede) e getJSON que nunca estoura; null = aviso ja mostrado.
var IDX_URL = "https://os.celer.tec.br/help/index.json";
function buscar(url, msg) {
    A.busy(msg);
    if (!A.net.online() && !A.wifiWait("A ajuda online precisa de Wi-Fi.")) return null;
    var d = A.net.getJSON(url);
    if (!d) A.error("Ajuda Online", "Sem conexão. Use a Ajuda Offline.");
    return d;
}

// ---- telas ------------------------------------------------------------------
A.run({
    menu: function (c) {
        A.header("Central de Ajuda", { back: false });
        A.style.card(L.x, L.top, L.w, 64, {
            full: c.full, elev: 2, grad: true,
            draw: function (r) {
                A.icons.draw("info", r.x, r.y + 1, 20, { color: T.accent });
                UI.text("Como usar o CelerOS", r.x + 28, r.y,
                        { role: "title", color: T.text, bg: r.bg, lines: 1 });
                UI.text("Gestos, Wi-Fi, apps e mais",
                        r.x, r.y + 26,
                        { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            }
        });
        if (A.style.button("Tópicos de ajuda", L.x, 124, L.w, 40)) return "secoes";
        if (A.style.button("Ajuda Online", L.x, 172, L.w, 40, { variant: "secondary" })) return "online";
        if (A.style.button("Buscar na ajuda", L.x, 220, L.w, 36, { variant: "ghost" })) {
            if (buscarTudo()) return "resultados";
        }
        UI.text("Este conteúdo funciona offline; a ajuda online precisa de Wi-Fi.",
                L.cx, 268, { role: "caption", align: "center", color: T.textDim, w: L.w, lines: 3 });
    },
    secoes: function (c) {
        if (c.entered) UI.resetScroll("sec");
        if (A.header("Tópicos de ajuda")) return A.BACK;
        var i = A.list.view("sec", L.x, L.top, L.w, L.bottom - L.top, linhasSec.rows(),
                            { row: 44 });
        if (i >= 0) { gato = i; return "topicos"; }
    },
    topicos: function (c) {
        if (c.entered) UI.resetScroll("top");
        if (A.header(SEC[gato].n)) return A.BACK;
        var tp = SEC[gato].t;
        var i = A.list.view("top", L.x, L.top, L.w, L.bottom - L.top, linhasTop.rows(),
                            { row: 48 });
        if (i >= 0) {
            var topico = tp[i];
            // o viewer do kit nao invalida a 1a moldura (spinner de um busy
            // anterior queimaria no frame parcial de entrada)
            UI.invalidate();
            A.text.viewer(topico.t, function () { return topico.c; });
        }
    },
    resultados: function (c) {
        if (c.entered) UI.resetScroll("res");
        if (A.header("Resultados", { sub: buscaRes.length + " de \"" + buscaQ + "\"" })) return A.BACK;
        if (buscaRes.length === 0) {
            A.style.card(L.x, L.top + 8, L.w, 112, {
                full: c.full, elev: 1, grad: true,
                draw: function (r) {
                    A.icons.draw("search", L.cx - 11, r.y + 2, 22, { color: T.textDim });
                    UI.text("Nada encontrado", L.cx, r.y + 34,
                            { role: "title", align: "center", color: T.warn, bg: r.bg, w: r.w, lines: 1 });
                    UI.text("Tente outra palavra. A busca cobre títulos, resumos e o texto dos tópicos.",
                            L.cx, r.y + 66,
                            { role: "caption", align: "center", color: T.textDim, bg: r.bg, w: r.w, lines: 2 });
                }
            });
            return;
        }
        var i = A.list.view("res", L.x, L.top, L.w, L.bottom - L.top, linhasRes.rows(),
                            { row: 48 });
        if (i >= 0) {
            var r = buscaRes[i];
            UI.invalidate();
            A.text.viewer(r.t, function () { return r.c; });
        }
    },
    online: function (c) {
        if (c.entered) UI.resetScroll("ocat");
        if (A.header("Ajuda Online")) return A.BACK;
        if (!ocats) {
            // indice com cache de sessao: voltar de uma categoria nao refaz
            // as buscas
            var d = buscar(IDX_URL, "Buscando índice...");
            if (!d) return A.BACK;
            var cs = d.categories || [], out = [];
            for (var i = 0; i < cs.length && i < 25; i++) {
                out.push({ name: String(cs[i].name), url: String(cs[i].url) });
            }
            if (!out.length) { A.error("Ajuda Online", "Índice vazio."); return A.BACK; }
            ocats = out;
            UI.invalidate();
        }
        var i2 = A.list.view("ocat", L.x, L.top, L.w, L.bottom - L.top, linhasOcat.rows(),
                             { row: 44 });
        if (i2 >= 0) {
            var a = buscar(ocats[i2].url, "Carregando tópicos...");
            if (!a) return;
            var arts = a.articles || [], tps = [];
            for (var j = 0; j < arts.length && j < 25; j++) {
                tps.push({ title: String(arts[j].title), url: String(arts[j].url) });
            }
            if (!tps.length) { A.error("Ajuda Online", "Nenhum artigo."); return; }
            oarts = tps;
            ocat = i2;
            UI.invalidate();
            return "otopicos";
        }
    },
    otopicos: function (c) {
        if (c.entered) UI.resetScroll("oart");
        if (A.header(ocats[ocat].name)) return A.BACK;
        var i = A.list.view("oart", L.x, L.top, L.w, L.bottom - L.top, linhasOart.rows(),
                            { row: 44 });
        if (i >= 0) {
            var art = buscar(oarts[i].url, "Carregando artigo...");
            if (!art) return;
            var conteudo = (art.content === undefined || art.content === null)
                ? "Conteúdo não encontrado." : String(art.content);
            var titulo = oarts[i].title;
            UI.invalidate();
            A.text.viewer(titulo, function () { return conteudo; });
        }
    }
}, "menu", { fps: 15 });
