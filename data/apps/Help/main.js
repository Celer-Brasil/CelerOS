// CelerOS Help (Central de Ajuda) — app de sistema. Porte do HelpCenterUI.cpp
// (commit 64ccfc8): menu Offline/Online, categorias e topicos offline (textos
// originais resumidos em PT-BR) e ajuda online buscada no hub. Migrado para o
// CelerKit (deps celeros.app.*): o leitor rolavel com saneamento Latin-1
// virou A.text.viewer, a rede virou A.net (getJSON que nunca estoura) e as
// listas usam cache por carimbo do A.list. A.run e dono do frame; X do
// topbar sai.

var A = require("celeros.app");
require("celeros.app.net");
require("celeros.app.text");
require("celeros.app.list");

A.init();

// ---- conteudo offline (porte do HelpCenterUI.cpp, PT-BR resumido) ----------
var CATS = [
    { name: "Primeiros Passos", topics: [
        { t: "O que é o CelerOS", d: "Visão do sistema",
          c: "O CelerOS é um sistema operacional rápido e leve, feito para o ESP32. Traz loja de apps integrada, execução de apps JavaScript pelo cartão SD e uma interface fluida no toque." },
        { t: "Como começar", d: "WiFi e cartão SD",
          c: "Vá em Configurações > WiFi para conectar o aparelho. Se for instalar novos apps de usuário, insira um cartão SD formatado em FAT32." },
        { t: "Tipos de app", d: "Sistema vs usuário",
          c: "Apps de sistema (Configurações, Launcher) rodam em C++ integrado, com máxima velocidade. Apps de usuário rodam no runtime JavaScript, do cartão SD ou da memória local." }
    ]},
    { name: "Navegação Básica", topics: [
        { t: "Tela inicial", d: "Visão da home",
          c: "A tela inicial mostra os apps de sistema no topo e os seus apps de usuário instalados abaixo. Toque ou arraste a lista para navegar." },
        { t: "Abrir e fechar", d: "Toque e botão X",
          c: "Toque no nome de um app para abri-lo. Para fechar um app em execução, toque no X do canto superior direito e volte ao launcher." }
    ]},
    { name: "Conectividade", topics: [
        { t: "Conectar WiFi", d: "Config > WiFi",
          c: "Vá em Configurações > WiFi. O aparelho escaneia as redes. Toque numa rede, digite a senha no teclado na tela e toque em Conectar. O aparelho reinicia para aplicar." }
    ]},
    { name: "Loja e Apps", topics: [
        { t: "App Store", d: "Instalar e atualizar",
          c: "A App Store lista os apps do CelerOS Hub. Toque num app para ver a descrição, o changelog e o tamanho antes de instalar. Apps instalados mostram a versão local e ganham o botão Atualizar quando o hub tem versão nova." },
        { t: "Criar seus apps", d: "SDK celer.js",
          c: "O SDK do CelerOS (npm celer) cria o projeto, roda o lint, testa no emulador e publica na loja: celer.js new meuapp, depois dev, test e publish. Apps são JavaScript ES5 no espaço virtual 240x320." }
    ]},
    { name: "APIs Recentes", topics: [
        { t: "Timers e notificações", d: "API 12",
          c: "Apps podem usar setTimeout e setInterval, gravar dados no Storage (NVS privado do app), desenhar em sprites fora da tela e avisar o usuário com System.notify (aparece no centro de notificações e na faixa do sistema) e System.playTone (melodia [[freq,ms],...])." },
        { t: "Sons e áudio", d: "API 12 e 13",
          c: "System.playTone toca melodias curtas no alto-falante. System.playWav toca arquivos WAV PCM 16-bit (8 a 48 kHz) de /local ou /sd. System.setVolume e getVolume ajustam o volume geral (API 13)." },
        { t: "Sensores e relógio", d: "API 13",
          c: "No watch, Sensors.accel le o acelerômetro, Sensors.steps conta passos e Sensors.temp a temperatura. System.getWeekday devolve o dia da semana, System.keepAwake(ms) segura a tela acordada por ms milissegundos (ou true/false) e o RTC mantém a hora entre reboots." }
    ]},
    { name: "Problemas Comuns", topics: [
        { t: "Tela preta", d: "Travamento em apps",
          c: "Se um app travar ou ficar sem memória, o sistema mostra uma tela de erro: toque para voltar ao launcher. Em placas sem PSRAM (como a CYD), apps muito grandes podem não caber; a loja marca esses apps como Requer PSRAM." }
    ]}
];

// ---- estado ----------------------------------------------------------------
var gato = 0;        // categoria offline aberta
var ocats = null;    // indice online (cache da sessao): [{name,url}]
var oarts = null;    // artigos da categoria online aberta
var ocat = 0;

// ---- listas com cache por carimbo (celeros.app.list) ------------------------
// getStamp e barato (referencia/indice); build so roda quando muda.
var linhasCat = A.list.make(function () { return CATS; }, function () {
    var out = [];
    for (var i = 0; i < CATS.length; i++) {
        var n = CATS[i].topics.length;
        out.push({ label: CATS[i].name, sub: n + (n === 1 ? " tópico" : " tópicos") });
    }
    return out;
});
var linhasTop = A.list.make(function () { return gato; }, function () {
    var tp = CATS[gato].topics, out = [];
    for (var i = 0; i < tp.length; i++) out.push({ label: tp[i].t, sub: tp[i].d });
    return out;
});
var linhasOcat = A.list.make(function () { return ocats; }, function () {
    var out = [];
    for (var i = 0; i < ocats.length; i++) out.push({ label: ocats[i].name });
    return out;
});
var linhasOart = A.list.make(function () { return oarts; }, function () {
    var out = [];
    for (var i = 0; i < oarts.length; i++) out.push({ label: oarts[i].title });
    return out;
});

// ---- busca online -----------------------------------------------------------
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
        var T = A.T;
        A.header("Central de Ajuda", { back: false });
        UI.card(A.L.x, A.L.top, A.L.w, 64);
        UI.text("Como usar o CelerOS:", A.L.x + 12, A.L.top + 10, { role: "title" });
        UI.text("gestos, Wi-Fi, apps e mais.", A.L.x + 12, A.L.top + 38, { role: "caption", color: T.textDim });
        UI.cardEnd();
        if (UI.button("Ajuda Offline", A.L.x, A.L.top + 80, A.L.w, 44)) return "offline";
        if (UI.button("Ajuda Online", A.L.x, A.L.top + 134, A.L.w, 44, { style: "ghost" })) return "online";
        UI.text("A ajuda online lê a central no hub (precisa de Wi-Fi).", 120, A.L.top + 192,
                { role: "caption", align: "center", color: T.textDim, w: A.L.w, lines: 2 });
    },
    offline: function (c) {
        if (c.entered) UI.resetScroll("cat");
        if (A.header("Ajuda Offline")) return A.BACK;
        var i = UI.list("cat", A.L.x, A.L.top, A.L.w, A.L.bottom - A.L.top, linhasCat.rows());
        if (i >= 0) { gato = i; return "topicos"; }
    },
    topicos: function (c) {
        if (c.entered) UI.resetScroll("top");
        if (A.header(CATS[gato].name)) return A.BACK;
        var tp = CATS[gato].topics;
        var i = UI.list("top", A.L.x, A.L.top, A.L.w, A.L.bottom - A.L.top, linhasTop.rows());
        if (i >= 0) {
            var topico = tp[i];
            // o viewer do kit nao invalida a 1a moldura (gap contornado
            // aqui): sem isso, o spinner de um A.busy anterior queima no
            // frame parcial de entrada
            UI.invalidate();
            A.text.viewer(topico.t, function () { return topico.c; });   // bloqueante
        }
    },
    online: function (c) {
        if (c.entered) UI.resetScroll("ocat");
        if (A.header("Ajuda Online")) return A.BACK;
        if (!ocats) {
            // indice com cache de sessao: voltar de uma categoria nao refaz
            // as tres buscas (o menu refetchava a cada entrada)
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
        var i2 = UI.list("ocat", A.L.x, A.L.top, A.L.w, A.L.bottom - A.L.top, linhasOcat.rows());
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
        var i = UI.list("oart", A.L.x, A.L.top, A.L.w, A.L.bottom - A.L.top, linhasOart.rows());
        if (i >= 0) {
            var art = buscar(oarts[i].url, "Carregando artigo...");
            if (!art) return;
            var conteudo = (art.content === undefined || art.content === null)
                ? "Conteúdo não encontrado." : String(art.content);
            var titulo = oarts[i].title;
            UI.invalidate();   // ver nota do gap no leitor (topicos)
            A.text.viewer(titulo, function () { return conteudo; });     // bloqueante
        }
    }
}, "menu", { fps: 15 });
