// CelerOS Chat IA — assistente DeepSeek (API 18: objeto AI)
// ES5 puro (Duktape). Teclado do OS ancorado no rodape; cada OK envia a
// mensagem para a IA e a resposta chega pelo callback enquanto o app
// bombeia o loop (o framework faz o HTTPS em task propria). A chave fica
// no aparelho (/local/deepseek_key.txt) — o app nunca a ve.
// Conversa em baloes no toolkit UI (API 22): area rolavel com inercia que
// segue o fim quando chega mensagem nova.

var T = System.theme();
var W = 240;

var hasAI = (typeof AI !== "undefined") && (typeof AI.chat === "function");
var VER = System.getOSVersion();

// Personalidade curta: resposta curta gasta menos token, latencia e tela
var SYSTEM_PROMPT = "Você é o assistente do CelerOS, um sistema para " +
    "dispositivos ESP32 com tela pequena. Responda em português, de forma " +
    "curta e direta, sem usar emojis.";
var CTX_MSGS = 12;               // quantas mensagens enviar de contexto
var MAX_MSGS = 20;               // quantas guardar no historico
var MAX_VIEW = 60;               // baloes na tela (conversa + avisos)

var msgs = [];                   // conversa: {r: "user"|"assistant", s: texto}
var view = [];                   // baloes: {k: "user"|"assistant"|"note", s, c, h}
var busy = false;
var histFile = (typeof FS.appData === "function" ? FS.appData() : "");
histFile += "historico.json";

var kbTop = 320;
var useKeypad = false;
var hasChips = (typeof System.topbarButtons === "function");
var contentH = 0;                // altura da conversa (soma dos baloes)
var BW = 180;                    // largura maxima do balao
var PAD = 8;

// ------------------------------------------------------------- historico ---
(function loadHist() {
    if (!histFile || histFile === "historico.json") return;
    var raw = FS.readTextFile(histFile);
    if (!raw) return;
    try {
        var arr = JSON.parse(raw);
        if (arr && arr.length) msgs = arr;
    } catch (e) { msgs = []; }
})();

function saveHist() {
    if (!histFile || histFile === "historico.json") return;
    try {
        FS.writeTextFile(histFile, JSON.stringify(msgs.slice(-MAX_MSGS)));
    } catch (e) { /* historico e melhor esforco: nunca derruba o chat */ }
}
// ---------------------------------------------------------------- saida ----
// As fonts so desenham Latin-1: emoji/simbolos da IA viram nada
function fit(s) {
    return String(s === null || s === undefined ? "" : s)
        .replace(/[^\u0000-ÿ\n]/g, "");
}

// Novo balao: mede uma vez (altura e largura) e segue o fim da conversa
function pushView(k, s, c) {
    var it = { k: k, s: s, c: c };
    if (k === "note") {
        it.h = UI.measureWrap(s, W - 24, "caption");
    } else {
        var oneLine = UI.measure(s, "body") + 2 * PAD;
        it.bw = oneLine < BW ? Math.max(oneLine, 40) : BW;
        it.h = UI.measureWrap(s, it.bw - 2 * PAD, "body") + 2 * 6;
    }
    view.push(it);
    if (view.length > MAX_VIEW) view.shift();
    UI.scrollTo("chat", 1e6);
}
function pushMsg(role, text) {
    msgs.push({ r: role, s: text });
    if (msgs.length > MAX_MSGS) msgs.shift();
    pushView(role, text);
    saveHist();
}
function pushHint(s) { pushView("note", s, T.textDim); }
function pushErr(s) { pushView("note", s, T.err); }

// ------------------------------------------------------------------ envio --
// Um pedido em voo. 502/504/429 do gateway sao transientes: uma retentativa
// silenciosa (2 s) evita o erro na cara do dono, como no Qwen.
function ask(payload, isRetry) {
    if (busy) return false;   // retry atrasado nao atropela uma pergunta nova
    busy = true;
    var started = false;
    // AI.chat LANCA quando o WiFi cai entre o check e a chamada (ou a chave
    // sumiu): sem o catch, busy ficava preso e o app morria com erro
    try {
        started = AI.chat({ messages: payload, max_tokens: 400 }, function (r) {
            busy = false;
            if (!isRetry && r && !r.ok &&
                (r.status === 502 || r.status === 504 || r.status === 429)) {
                pushHint("repetindo...");
                setTimeout(function () { ask(payload, true); }, 2000);
                return;
            }
            try { if (typeof System.beep === "function") System.beep(1320, 60); } catch (e) {}
            if (r && r.ok && r.content) {
                pushMsg("assistant", fit(r.content));
                if (r.usage && r.usage.total_tokens) {
                    pushHint("(" + r.usage.total_tokens + " tokens)");
                }
            } else if (r && r.ok) {
                pushErr("IA: resposta vazia");
            } else {
                pushErr("IA: erro " + (r && r.error ? r.error : "HTTP " + (r ? r.status : 0)));
                if (r && r.detail) pushHint("detalhe: " + fit(r.detail));
            }
            UI.invalidate();
        });
    } catch (e) {
        busy = false;
        pushErr("IA: " + (e && e.message ? e.message : e));
        UI.invalidate();
        return false;
    }
    if (!started) {
        busy = false;
        pushErr("IA: ocupado, tente de novo");
    }
    UI.invalidate();
    return started;
}

function send(text) {
    if (busy) { pushHint("(a IA ainda está respondendo)"); return; }
    if (!hasAI) { pushErr("sem AI no firmware (requer API >= 18)"); return; }
    if (!AI.configured()) { pushErr("sem chave: rode tools/push_deepseek_key.py"); return; }
    if (!Net.isConnected()) { pushErr("sem WiFi"); return; }

    pushMsg("user", text);
    var payload = [{ role: "system", content: SYSTEM_PROMPT }];
    var start = Math.max(0, msgs.length - CTX_MSGS);
    for (var i = start; i < msgs.length; i++) {
        payload.push({ role: msgs[i].r, content: msgs[i].s });
    }
    ask(payload, false);
}

// -------------------------------------------------------------- desenho ----
// Conversa: area rolavel; baloes so no frame total (rolar marca o proximo)
// altura total conhecida ANTES do scrollBegin (cada balao foi medido ao
// entrar): o scrollTo(fim) limita ao conteudo certo ja no primeiro frame
function chatHeight() {
    var y = 6;
    for (var i = 0; i < view.length; i++) y += view[i].h + 8;
    return y + (busy ? 36 : 0);
}
function drawChat(full) {
    var top = 4, h = kbTop - 44;
    contentH = chatHeight();
    var off = UI.scrollBegin("chat", 0, top, W, h, Math.max(h, contentH));
    if (typeof __harness !== "undefined") {
        __harness.chatOff = off;
        __harness.chatMax = Math.max(0, contentH - h);
    }
    var y = top + 6 - off;
    for (var i = 0; i < view.length; i++) {
        var it = view[i];
        var vis = y + it.h >= top && y < top + h;
        if (it.k === "note") {
            if (full && vis) UI.text(it.s, W / 2, y, { role: "caption", align: "center", color: it.c,
                                                       w: W - 24, lines: 64, id: i });
        } else {
            var mine = it.k === "user";
            var x = mine ? W - 8 - it.bw : 8;
            var bg = mine ? T.accentD : T.raised;
            if (full && vis) {
                System.fillRoundRect(x, y, it.bw, it.h, 12, bg);
                UI.text(it.s, x + PAD, y + 6, { w: it.bw - 2 * PAD, lines: 64, bg: bg, id: i });
            }
        }
        y += it.h + 8;
    }
    if (busy) {
        // balao "pensando" com spinner (anima a cada frame)
        if (full) System.fillRoundRect(8, y, 64, 28, 12, T.raised);
        UI.spinner(40, y + 14, 9);
        y += 36;
    } else if (!view.length && full) {
        UI.text("Pergunte algo ao assistente...", W / 2, top + h / 2 - 8,
                { role: "caption", align: "center", color: T.textDim });
    }
    UI.scrollEnd();
}

// Linha de digitacao acima do teclado (o campo do teclado e do app)
function drawInput() {
    var y = kbTop - 36;
    UI.card(6, y, W - 12, 30, { radius: 15, stroke: true });
    var s = System.keypadText();
    var cur = (Math.floor(System.millis() / 500) % 2) ? "_" : " ";
    var shown = s.length ? s : "";
    while (shown.length && UI.measure(shown + "_", "body") > W - 40) shown = shown.substring(1);  // cauda
    if (s.length || cur === "_") {
        UI.text(shown + cur, 18, y + 7, { color: s.length ? T.text : T.textDim, id: 1 });
    } else {
        UI.text("Mensagem", 18, y + 7, { color: T.textDim, id: 1 });
    }
    UI.cardEnd();
}

// ------------------------------------------------------------------ main ---
useKeypad = System.keypadOpen({ field: false, maxLen: 256 });
if (useKeypad) kbTop = System.keypadRect().y;

pushView("note", "Chat IA " + VER, T.accent);
if (hasAI) {
    pushHint("DeepSeek; histórico local; arraste para rever");
} else {
    pushErr("requer firmware com API >= 18");
}
// A conversa anterior aparece no boot (o arrasto tem o que rever)
for (var hi = 0; hi < msgs.length; hi++) pushView(msgs[hi].r, msgs[hi].s);

// chips da faixa (API 6): Limpar zera a conversa; Cancelar esquece a
// requisicao em curso
if (useKeypad && hasChips) System.topbarButtons(["Limpar", "Cancelar"]);

while (true) {
    if (useKeypad) {
        var ev = System.keypadPoll();
        if (ev) {
            if (ev.type === "enter") {
                if (ev.text) send(ev.text);
            } else if (ev.type === "cancel") {
                System.keypadOpen({ field: false, maxLen: 256 });
                kbTop = System.keypadRect().y;
                UI.invalidate();
            }
        }

        var chip = System.topbarPop ? System.topbarPop() : null;
        if (chip === "Limpar") {
            msgs = [];
            view = [];
            try { FS.deleteFile(histFile); } catch (e) {}
            pushHint("conversa apagada");
            UI.invalidate();
        } else if (chip === "Cancelar") {
            if (busy && hasAI && AI.cancel()) {
                busy = false;
                pushHint("cancelado");
            }
            UI.invalidate();
        }
    }

    var full = UI.begin(T.bg);
    // o fundo total apaga o teclado acoplado: redesenha por cima
    if (full && useKeypad) System.keypadDraw();
    drawChat(full);
    drawInput();
    UI.end();
}
