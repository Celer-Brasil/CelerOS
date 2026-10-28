// Quiz IA — perguntas geradas na hora pelo assistente do aparelho
// (AI.chat, API 18: DeepSeek/OpenRouter — a chave fica no firmware, nunca
// no app). CelerKit UI 2.0: configuracao em lista + segmented, progresso em
// anel, alternativas em cards 2x2 que acendem verde/vermelho, sequencia e
// recorde no celeros.app.data. Sem chave (ou se a IA falhar) o jogo cai no
// banco offline embutido e avisa o motivo. ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.net");       // online(): estado sem estourar
require("celeros.app.data");      // recorde no NVS (migra do hi.txt antigo)
require("celeros.app.text");      // Latin-1 do que a IA devolve
require("celeros.app.style");     // cards/botoes tokenizados
require("celeros.app.widgets");   // header, anel de progresso, segmented

A.init();
var T = A.style.T;
var L = A.L, LX = L.x, LW = L.w;

var TOPICS = ["Geral", "Ciências", "História", "Geografia", "Esportes", "Tecnologia"];
var DIFS = ["fácil", "média", "difícil"];
var TOTAL = 8;

// recorde: NVS do kit; quem tinha o hi.txt antigo e migra na primeira abertura
var hi = 0;
(function leRecorde() {
    var st = A.data.loadState("recorde", null);
    if (st && typeof st.hi === "number") { hi = st.hi; return; }
    try {
        var raw = FS.readTextFile(FS.appData() + "hi.txt");
        var v = parseInt(raw, 10);
        if (!isNaN(v)) { hi = v; A.data.saveState("recorde", { hi: hi }); }
    } catch (e) { /* sem recorde antigo */ }
})();

// som pelo System.sfx (API 32, nao trava); firmware antigo cai no playTone
var somFn = typeof System.sfx === "function" ? System.sfx :
            (typeof System.playTone === "function" ? System.playTone : null);
function tone(hz, ms) {
    if (somFn) { try { somFn([[hz, ms]]); } catch (e) { } }
}

// ---- banco offline (sem chave de IA ou quando a chamada falha) -------------
var BANK = {
    "Geral": [
        { q: "Qual é o maior oceano da Terra?", a: ["Atlântico", "Índico", "Pacífico", "Ártico"], c: 2 },
        { q: "Quantos lados tem um hexágono?", a: ["5", "6", "7", "8"], c: 1 },
        { q: "Qual é a moeda do Japão?", a: ["Yuan", "Won", "Iene", "Dólar"], c: 2 }
    ],
    "Ciências": [
        { q: "Qual gás as plantas absorvem na fotossíntese?", a: ["Oxigênio", "Nitrogênio", "CO2", "Hélio"], c: 2 },
        { q: "Qual o osso mais longo do corpo humano?", a: ["Úmero", "Fêmur", "Tíbia", "Rádio"], c: 1 },
        { q: "Qual é a fórmula da água?", a: ["CO2", "H2O", "O2", "NaCl"], c: 1 }
    ],
    "História": [
        { q: "Em que ano o Brasil foi descoberto?", a: ["1492", "1500", "1522", "1549"], c: 1 },
        { q: "Quem pintou a Mona Lisa?", a: ["Van Gogh", "Picasso", "Da Vinci", "Michelangelo"], c: 2 },
        { q: "Qual tratado encerrou a Guerra dos 30 anos?", a: ["Versalhes", "Vestfália", "Tordesilhas", "Utrecht"], c: 1 }
    ],
    "Geografia": [
        { q: "Qual a capital da Austrália?", a: ["Sidney", "Melbourne", "Canberra", "Perth"], c: 2 },
        { q: "Qual o rio mais extenso do Brasil?", a: ["São Francisco", "Amazonas", "Paraná", "Tocantins"], c: 1 },
        { q: "Em qual continente fica o Egito?", a: ["Ásia", "África", "Europa", "Oceania"], c: 1 }
    ],
    "Esportes": [
        { q: "Quantos jogadores tem um time de futebol em campo?", a: ["9", "10", "11", "12"], c: 2 },
        { q: "Em que esporte se usa uma peteca (shuttlecock)?", a: ["Tênis", "Badminton", "Squash", "Pingue-pongue"], c: 1 },
        { q: "Quantos pontos vale a cesta de três na NBA?", a: ["2", "3", "4", "1"], c: 1 }
    ],
    "Tecnologia": [
        { q: "O que significa 'www'?", a: ["World Wide Web", "Web Wide World", "World Web Wide", "Wide World Web"], c: 0 },
        { q: "Quantos bits tem um byte?", a: ["4", "8", "16", "32"], c: 1 },
        { q: "Quem criou a World Wide Web?", a: ["Bill Gates", "Steve Jobs", "Tim Berners-Lee", "Alan Turing"], c: 2 }
    ]
};
var usedOffline = [];

// ---- estado ---------------------------------------------------------------
var state = "menu";        // menu | wait | quiz | end
var topic = 0, dif = 0;
var q = null;              // {q, a[4], c}
var qIndex = 0, score = 0, streak = 0, bestStreak = 0;
var answered = -1;
var lastOrigin = "";
var aiCount = 0;
var novoRec = false;
var aviso = "";            // motivo do fallback ("sem Wi-Fi", "IA: erro 502"...)

function goState(s) { state = s; UI.invalidate(); }

function pickOffline() {
    var pool = BANK[TOPICS[topic]];
    var fresh = [];
    for (var i = 0; i < pool.length; i++)
        if (usedOffline.indexOf(pool[i]) < 0) fresh.push(pool[i]);
    if (!fresh.length) { usedOffline = []; fresh = pool.slice(0); }
    var p = fresh[Math.floor(Math.random() * fresh.length)];
    usedOffline.push(p);
    return { q: p.q, a: p.a.slice(0), c: p.c };
}

// extrai o primeiro objeto JSON da resposta (o modelo as vezes cerca com texto)
function parseQuestion(s) {
    if (!s) return null;
    var i = s.indexOf("{"), j = s.lastIndexOf("}");
    if (i < 0 || j <= i) return null;
    var obj = null;
    try { obj = JSON.parse(s.substring(i, j + 1)); } catch (e) { return null; }
    if (!obj || typeof obj.q !== "string" || !obj.a || obj.a.length !== 4) return null;
    var c = parseInt(obj.c, 10);
    if (isNaN(c) || c < 0 || c > 3) return null;
    var a = [];
    for (var k = 0; k < 4; k++) {
        if (typeof obj.a[k] !== "string" || !obj.a[k].length) return null;
        a.push(A.text.fit(obj.a[k]));
    }
    return { q: A.text.fit(obj.q), a: a, c: c };
}

var aiOk = (typeof AI !== "undefined") && typeof AI.chat === "function";
function iaLigada() {
    try { return aiOk && AI.configured(); } catch (e) { return false; }
}

function nextQuestion() {
    answered = -1;
    q = null;
    if (!iaLigada() || !A.net.online()) {
        aviso = iaLigada() ? "sem Wi-Fi: banco offline" : "IA sem chave: banco offline";
        q = pickOffline();
        goState("quiz");
        return;
    }
    goState("wait");
    var sys = "Você gera perguntas de quiz em português do Brasil. Responda SOMENTE com um objeto JSON exato, sem texto ao redor, no formato {\"q\":\"pergunta curta\",\"a\":[\"alternativa 1\",\"alternativa 2\",\"alternativa 3\",\"alternativa 4\"],\"c\":índice_da_correta_0_a_3}. As 4 alternativas devem ser plausíveis e embaralhadas; a pergunta deve ser curta.";
    var ok = false;
    try {
        ok = AI.chat({
            messages: [{ role: "system", content: sys },
                       { role: "user", content: "Tema: " + TOPICS[topic] + ". Dificuldade: " + DIFS[dif] + ". Gere UMA pergunta." }],
            max_tokens: 400
        }, function (r) {
            if (state !== "wait") return;        // saiu/cancelou: nao atropela
            var parsed = (r && r.ok && r.content) ? parseQuestion(r.content) : null;
            if (parsed) { q = parsed; aiCount++; aviso = ""; }
            else {
                q = pickOffline();
                aviso = r && !r.ok ? "IA: erro " + (r.status || r.error || "?") : "IA: resposta inválida";
            }
            goState("quiz");
        });
    } catch (e) {
        ok = false;
        aviso = "IA: " + (e && e.message ? e.message : "falhou");
    }
    if (!ok) {
        q = pickOffline();
        goState("quiz");
    }
}

function startRound() {
    qIndex = 0; score = 0; streak = 0; bestStreak = 0;
    usedOffline = []; aiCount = 0; novoRec = false; aviso = "";
    nextQuestion();
}

function responde(i) {
    if (answered >= 0) return;
    answered = i;
    if (i === q.c) {
        streak++;
        if (streak > bestStreak) bestStreak = streak;
        score++;
        tone(880, 60);
    } else {
        streak = 0;
        tone(220, 160);
    }
    UI.invalidate();     // acende o feedback e libera a proxima
}

function proxima() {
    if (qIndex + 1 >= TOTAL) {
        lastOrigin = aiCount === TOTAL ? "perguntas geradas pela IA" :
                     aiCount ? aiCount + " de " + TOTAL + " perguntas da IA" : "banco offline";
        novoRec = score > hi;
        if (novoRec) { hi = score; A.data.saveState("recorde", { hi: hi }); }
        goState("end");
        return;
    }
    qIndex++;
    nextQuestion();
}

// ---- menu -----------------------------------------------------------------
function menu(c) {
    var h = A.widgets.header("Quiz IA", { full: c.full, back: true });
    if (h.back) return A.BACK;
    var rows = [];
    for (var i = 0; i < TOPICS.length; i++) rows.push({ label: TOPICS[i] });
    var k = UI.list("topicos", LX, 48, LW, 166, rows, { rowH: 27, selected: topic });
    if (k >= 0 && k !== topic) { topic = k; UI.invalidate(); }
    var nd = A.widgets.segmented(LX, 220, LW, 30, DIFS, dif);
    if (nd !== dif) { dif = nd; UI.invalidate(); }
    var ia = iaLigada(), net = A.net.online();
    UI.badge(ia ? (net ? "IA conectada" : "sem Wi-Fi") : "banco offline", LX + 2, 258,
             { color: ia && net ? T.ok : T.accentD, textColor: ia && net ? T.onAccent : T.text });
    UI.text("recorde " + hi + "/" + TOTAL, LX + LW, 262,
            { role: "caption", align: "right", color: T.textDim, w: 110 });
    if (A.style.button("Começar", LX, 278, LW, 34)) {
        startRound();
        return "jogo";
    }
}

// ---- jogo (wait / quiz / end na mesma tela) --------------------------------
var ringSig = "";
function progressRing(c) {
    var sig = qIndex + "|" + TOTAL;
    if (!c.full && sig === ringSig) return;
    ringSig = sig;
    A.widgets.ring(44, 80, 22, (qIndex + 1) / TOTAL,
                   { th: 5, label: (qIndex + 1) + "/" + TOTAL, font: 1 });
}

function altCard(i, x, y, w, h, t) {
    var done = answered >= 0;
    var right = done && i === q.c;
    var wrong = done && i === answered && i !== q.c;
    var bg = right ? T.ok : wrong ? T.err : T.card;
    var fg = right || wrong ? T.onAccent : (done ? T.textDim : T.text);
    UI.card(x, y, w, h, { color: bg, radius: 8, stroke: !done });
    var ty = y + Math.round((h - 16) / 2);   // bloco de 2 linhas centrado
    UI.text(String.fromCharCode(65 + i), x + 7, ty,
            { role: "caption", color: fg, w: 12, lines: 2 });
    UI.text(q.a[i], x + 19, ty, { role: "caption", color: fg, w: w - 25, lines: 2 });
    UI.cardEnd();
    if (!done && t.tap && t.x >= x && t.x <= x + w && t.y >= y && t.y <= y + h) responde(i);
}

function waitFrame(c) {
    UI.spinner(120, 128, 16);
    UI.text("pergunta " + (qIndex + 1) + " de " + TOTAL, 120, 84,
            { role: "title", align: "center", color: T.text });
    UI.text("consultando o assistente...", 120, 156,
            { role: "caption", align: "center", color: T.textDim });
    if (A.style.button("Cancelar", 70, 280, 100, 32, { variant: "ghost" })) {
        if (aiOk) { try { AI.cancel(); } catch (e) { } }
        state = "menu";
        return A.BACK;
    }
}

function quizFrame(c) {
    progressRing(c);
    UI.text("sequência x" + streak, 78, 62, { role: "body", color: streak >= 3 ? T.warn : T.text });
    UI.text("acertos " + score + "/" + TOTAL, 78, 82, { role: "caption", color: T.textDim });
    A.style.card(LX, 108, LW, 64, { full: c.full, elev: 1, grad: true,
        draw: function (r) {
            var hgt = UI.measureWrap(q.q, r.w, "body");
            UI.text(q.q, r.x, r.y + Math.max(0, Math.round((r.h - hgt) / 2)),
                    { role: "body", color: T.text, w: r.w, lines: 3 });
        }
    });
    // uma leitura de toque por frame (os 4 cards compartilham o mesmo estado)
    var t = UI.touch();
    altCard(0, LX, 178, 108, 46, t);
    altCard(1, LX + 116, 178, 108, 46, t);
    altCard(2, LX, 228, 108, 46, t);
    altCard(3, LX + 116, 228, 108, 46, t);
    if (answered >= 0) {
        var ok = answered === q.c;
        UI.text(ok ? (streak >= 3 ? "certo! sequência x" + streak : "certo!")
                   : "a certa é a letra " + String.fromCharCode(65 + q.c),
                120, 280, { role: "caption", align: "center", id: 9,
                            color: ok ? T.ok : T.err, w: LW });
        if (A.style.button(qIndex + 1 >= TOTAL ? "Ver resultado" : "Próxima",
                           70, 292, 100, 24, { role: "caption" })) {
            proxima();
        }
    } else if (aviso) {
        UI.text(aviso, 120, 284, { role: "caption", align: "center",
                color: T.textDim, w: LW, lines: 1, id: 8 });
    }
}

function endFrame(c) {
    A.widgets.ring(120, 108, 52, score / TOTAL,
                   { th: 8, color: score >= TOTAL / 2 ? T.ok : T.err,
                     label: score + "/" + TOTAL, font: 2 });
    UI.text("Fim do quiz", 120, 168, { role: "title", align: "center", color: T.text });
    UI.text("melhor sequência: " + bestStreak, 120, 190,
            { role: "caption", align: "center", color: T.textDim });
    if (novoRec) UI.badge("novo recorde!", LX + 2, 206, { color: T.warn, textColor: T.onAccent });
    else UI.text("recorde " + hi + "/" + TOTAL, 120, 212,
                 { role: "caption", align: "center", color: T.textDim });
    UI.text(lastOrigin, 120, 232, { role: "caption", align: "center",
            color: T.textDim, w: LW, lines: 1 });
    if (A.style.button("Jogar de novo", LX, 250, LW, 34)) {
        startRound();
        return undefined;
    }
    if (A.style.button("Menu", LX, 290, LW, 24, { variant: "ghost", role: "caption" })) {
        state = "menu";
        return A.BACK;
    }
}

function jogo(c) {
    // cancelar a espera da IA volta para o menu pelo A.run; sem esta guarda o
    // quadro seguinte cairia no quizFrame com q === null (a tela nao tinha
    // saido da pilha: waitFrame devolve A.BACK mas quem chama e o jogo)
    if (state === "menu") return A.BACK;
    var h = A.widgets.header(TOPICS[topic], { full: c.full, back: true,
        sub: score + " pts" });
    if (h.back) { state = "menu"; return A.BACK; }
    if (state === "wait") return waitFrame(c);
    if (state === "end") return endFrame(c);
    quizFrame(c);
}

A.run({ menu: menu, jogo: jogo }, "menu", { fps: 15 });
