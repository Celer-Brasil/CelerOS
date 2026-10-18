// Quiz IA — perguntas geradas na hora pelo assistente do aparelho
// (AI.chat, API 18: DeepSeek/OpenRouter — a chave fica no firmware, nunca
// no app). Chrome todo no toolkit UI (API 22): categoria + dificuldade em
// abas, pergunta em cartao com quebra de linha, alternativas em botoes
// que acendem verde/vermelho. Sem chave configurada (ou se a IA falhar) o
// jogo cai num banco offline embutido. Placar e recorde no appData.

var T = System.theme();
var W = 240, H = 320;

var TOPICS = ["Geral", "Ciências", "História", "Geografia", "Esportes", "Tecnologia"];
var DIFS = ["fácil", "média", "difícil"];
var TOTAL = 8;

var DATA = (FS.appData ? FS.appData() : "/local/");
var HI_FILE = DATA + "hi.txt";
var hi = 0;
var raw = FS.readTextFile(HI_FILE);
if (raw) {
    var hv = parseInt(raw, 10);
    if (!isNaN(hv)) hi = hv;
}

// Som: System.sfx (API 32) mistura o efeito por cima da trilha e NAO trava
// o loop do jogo; firmware antigo cai no playTone (bloqueante)
var somFn = typeof System.sfx === "function" ? System.sfx :
            (typeof System.playTone === "function" ? System.playTone : null);
var hasTone = somFn !== null;
function tone(hz, ms) {
    if (hasTone) { try { somFn && somFn([[hz, ms]]); } catch (e) {} }
}

// ---------------------------------------------------- banco offline -------
// fallback quando nao ha chave de IA (ou a chamada falha): 3 por tema
var BANK = {
    "Geral": [
        { q: "Qual é o maior oceano da Terra?", a: ["Atlântico", "Índico", "Pacífico", "Ártico"], c: 2 },
        { q: "Quantos lados tem um hexágono?", a: ["5", "6", "7", "8"], c: 1 },
        { q: "Qual é a moeda do Japão?", a: ["Yuan", "Won", "Iene", "Dólar"], c: 2 }
    ],
    "Ciências": [
        { q: "Qual gás as plantas absorvem na fotossíntese?", a: ["Oxigênio", "Nitrogênio", "CO2", "Hélio"], c: 2 },
        { q: "Qual o osso mais longo do corpo humano?", a: "Úmero,Fêmur,Tíbia,Rádio".split(","), c: 1 },
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

// ---------------------------------------------------------------- estado ---
var state = "menu";        // menu | wait | ask | end
var topic = 0, dif = 0;
var q = null;              // {q, a[4], c, offline}
var qIndex = 0, score = 0, streak = 0, bestStreak = 0;
var answered = -1;         // indice escolhido (-1 = nao respondida)
var lastOrigin = "";       // de onde vieram as perguntas da partida
var aiCount = 0;           // perguntas que vieram da IA nesta partida
var novoRec = false;       // o fim bateu o recorde (decidido 1x ao entrar)

function goState(s) {
    state = s;
    UI.invalidate();
}

function feedbackLine() {
    if (!q) return "";
    if (answered === q.c) return streak >= 3 ? "certo! sequência x" + streak : "certo!";
    return "a certa é a letra " + String.fromCharCode(65 + q.c);
}

function pickOffline() {
    var pool = BANK[TOPICS[topic]];
    var fresh = [];
    for (var i = 0; i < pool.length; i++) {
        if (usedOffline.indexOf(pool[i]) < 0) fresh.push(pool[i]);
    }
    if (!fresh.length) { usedOffline = []; fresh = pool.slice(0); }
    var p = fresh[Math.floor(Math.random() * fresh.length)];
    usedOffline.push(p);
    return { q: p.q, a: p.a.slice(0), c: p.c, offline: true };
}

// extrai o primeiro objeto JSON da resposta (o modelo as vezes cerca com
// texto ou cercas de codigo)
function parseQuestion(s) {
    if (!s) return null;
    var i = s.indexOf("{");
    var j = s.lastIndexOf("}");
    if (i < 0 || j <= i) return null;
    var obj = null;
    try { obj = JSON.parse(s.substring(i, j + 1)); } catch (e) { return null; }
    if (!obj || typeof obj.q !== "string" || !obj.a || obj.a.length !== 4) return null;
    var c = parseInt(obj.c, 10);
    if (isNaN(c) || c < 0 || c > 3) return null;
    for (var k = 0; k < 4; k++) {
        if (typeof obj.a[k] !== "string" || !obj.a[k].length) return null;
    }
    return { q: obj.q, a: obj.a, c: c, offline: false };
}

function nextQuestion() {
    answered = -1;
    q = null;

    var canAi = (typeof AI !== "undefined") && AI.configured();
    if (!canAi) {
        q = pickOffline();
        goState("ask");
        return;
    }

    goState("wait");
    var sys = "Você gera perguntas de quiz em português do Brasil. Responda SOMENTE com um objeto JSON exato, sem texto ao redor, no formato {\"q\":\"pergunta curta\",\"a\":[\"alternativa 1\",\"alternativa 2\",\"alternativa 3\",\"alternativa 4\"],\"c\":índice_da_correta_0_a_3}. As 4 alternativas devem ser plausíveis e embaralhadas; a pergunta deve ser curta.";
    var user = "Tema: " + TOPICS[topic] + ". Dificuldade: " + DIFS[dif] + ". Gere UMA pergunta.";
    var ok = AI.chat({
        messages: [
            { role: "system", content: sys },
            { role: "user", content: user }
        ],
        max_tokens: 400
    }, function (r) {
        if (state !== "wait") return;        // usuario saiu / ja nao espera
        var parsed = (r && r.ok && r.content) ? parseQuestion(r.content) : null;
        q = parsed || pickOffline();
        if (parsed) aiCount++;
        goState("ask");
    });
    if (!ok) {
        q = pickOffline();
        goState("ask");
    }
}

function startRound() {
    qIndex = 0;
    score = 0;
    streak = 0;
    bestStreak = 0;
    usedOffline = [];
    aiCount = 0;
    novoRec = false;
    nextQuestion();
}

// ------------------------------------------------------------------ main ---
while (true) {
    if (state === "menu") {
        UI.begin(T.bg);
        UI.text("Quiz IA", W / 2, 40, { role: "display", align: "center" });
        var sel = UI.list("temas", 16, 62, W - 32, 128,
                          [{ label: "Geral" }, { label: "Ciências" }, { label: "História" },
                           { label: "Geografia" }, { label: "Esportes" }, { label: "Tecnologia" }],
                          { rowH: 30, selected: topic });
        if (sel >= 0 && sel !== topic) { topic = sel; UI.invalidate(); }
        dif = UI.tabs(16, 200, W - 32, 32, DIFS, dif);
        var aiOn = (typeof AI !== "undefined") && AI.configured();
        UI.badge(aiOn ? "IA conectada" : "banco offline", 12, 244,
                 { color: aiOn ? T.ok : T.accentD, textColor: T.onAccent });
        UI.text("recorde " + hi + "/" + TOTAL, W - 12, 248,
                { role: "caption", align: "right", color: T.textDim });
        if (UI.button("Começar", 40, 270, 160, 42)) startRound();
        UI.end();
        System.delay(10);
        continue;
    }

    if (state === "wait") {
        UI.begin(T.bg);
        UI.text("pergunta " + (qIndex + 1) + " de " + TOTAL, W / 2, 90, { role: "title", align: "center" });
        UI.spinner(W / 2, 150, 16);
        UI.text("consultando o assistente...", W / 2, 190, { role: "caption", align: "center", color: T.textDim });
        if (UI.button("Cancelar", 70, 250, 100, 36, { style: "ghost" })) {
            if (typeof AI !== "undefined") AI.cancel();
            goState("menu");
        }
        UI.end();
        System.delay(20);
        continue;
    }

    if (state === "ask" && q) {
        UI.begin(T.bg);
        UI.header(TOPICS[topic],
                  { sub: (qIndex + 1) + "/" + TOTAL + "  ·  " + score + " pts" });
        UI.card(8, 46, W - 16, 68);
        UI.text(q.q, 16, 54, { w: W - 32, lines: 4, color: T.text });
        UI.cardEnd();

        var y = 122;
        for (var i = 0; i < 4; i++) {
            var label = String.fromCharCode(65 + i) + ")  " + q.a[i];
            var done = answered >= 0;
            var col = -1, tc = T.text, dis = done;
            if (done && i === q.c) { col = T.ok; tc = T.onAccent; dis = false; }
            else if (done && i === answered) { col = T.err; tc = T.onAccent; dis = false; }
            if (UI.button(label, 8, y, W - 16, 32, { color: col, textColor: tc, disabled: dis })) {
                if (answered < 0) {
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
                    UI.invalidate();   // acende as cores
                }
            }
            y += 38;
        }

        if (answered >= 0) {
            UI.text(feedbackLine(), W / 2, 276, { role: "caption", align: "center", id: 9,
                    color: answered === q.c ? T.ok : T.err });
            if (UI.button(qIndex + 1 >= TOTAL ? "Ver resultado" : "Próxima", 60, 290, 120, 28)) {
                if (qIndex + 1 >= TOTAL) {
                    lastOrigin = aiCount === TOTAL ? "perguntas geradas pela IA" :
                                 aiCount ? aiCount + " de " + TOTAL + " perguntas da IA" :
                                 "banco offline";
                    // recorde decidido AQUI: no draw ele virava hi no 1o
                    // quadro e o selo "novo recorde!" sumia no seguinte
                    novoRec = score > hi;
                    if (novoRec) {
                        hi = score;
                        FS.writeTextFile(HI_FILE, String(hi));
                    }
                    goState("end");
                } else {
                    qIndex++;
                    nextQuestion();
                }
            }
        }
        UI.end();
        System.delay(10);
        continue;
    }

    if (state === "end") {
        UI.begin(T.bg);
        UI.text("Fim do quiz", W / 2, 52, { role: "display", align: "center" });
        UI.badge(score + " de " + TOTAL + " certas", 12, 96,
                 { color: score >= TOTAL / 2 ? T.ok : T.accentD });
        UI.text("melhor sequência: " + bestStreak, W / 2, 136, { role: "title", align: "center" });
        if (novoRec) {
            UI.badge("novo recorde!", 12, 160, { color: T.warn, textColor: T.onAccent });
        } else {
            UI.text("recorde: " + hi + "/" + TOTAL, W / 2, 166,
                    { role: "caption", align: "center", color: T.textDim });
        }
        UI.text(lastOrigin, W / 2, 198, { role: "caption", align: "center", color: T.textDim, w: W - 24 });
        if (UI.button("Jogar de novo", 40, 222, 160, 44)) startRound();
        if (UI.button("Menu", 40, 272, 160, 34, { style: "ghost" })) goState("menu");
        UI.end();
        System.delay(10);
        continue;
    }

    System.delay(20);
}
