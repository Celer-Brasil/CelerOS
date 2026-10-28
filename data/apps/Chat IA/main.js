// CelerOS Chat IA 2.0 - assistente DeepSeek sobre o CelerKit (deps celeros.app.*).
// O app continua sendo a cola fina do par transcript+cliente: bolhas/rolagem
// no celeros.app.chat, retry/busy/historico no celeros.app.ai, teclado dockado
// no celeros.app.input. A 2.0 veste o conjunto com o UI kit: cabecalho com
// acoes (historico e configuracao), sheet de modelo/conversa, tela de historico
// e estado de rede/pensamento no proprio cabecalho.
//
// ES5 puro (Duktape). A chave fica no aparelho - o app nunca a ve. topbar:false:
// o cabecalho e do app (mesmo padrao do Qwen/Celer Remote) e o X do sistema
// continua no gesto de borda.
//
// 2.0.0: UI kit 2.0 (celeros.app.style/icons): cabecalho com acoes, sheet de
// modelo/conversa (DeepSeek, contexto, chave, limpar/cancelar) e tela de
// historico; status (online/pensando/sem chave) no cabecalho; o transcript
// segue no celeros.app.chat. 1.3.0: migrado para o CelerKit.

var A = require("celeros.app");

A.init();
var T = null;
var W = 240, H = 320;
var HEADER = 40;

var SYSTEM_PROMPT = "Você é o assistente do CelerOS, um sistema para " +
    "dispositivos ESP32 com tela pequena. Responda em português, de forma " +
    "curta e direta, sem usar emojis.";

function inRect(t, x, y, w, h) {
    return t.x >= x && t.x < x + w && t.y >= y && t.y < y + h;
}
function netOnline() {
    try {
        if (A.net && typeof A.net.online === "function") return !!A.net.online();
        return !!Net.isConnected();
    } catch (e) { return false; }
}
function keyOk() {
    try { return !!AI.configured(); } catch (e) { return false; }
}
function fit(s) {
    try { return A.text.fit(s); } catch (e) { return String(s || ""); }
}

// ---------------------------------------------------------------------------
// Placas sem vidro (devkit/esp32-cam): o app nao tem como conversar. Sai com
// uma linha clara no serial em vez de estourar em UI.begin.
// ---------------------------------------------------------------------------
if (typeof UI === "undefined") {
    System.print("[chatai] esta placa nao tem tela: o Chat IA precisa de display e toque");
} else {
    // os modulos do kit tocam UI no proprio load: so entram com vidro
    require("celeros.app.text");
    require("celeros.app.style");
    require("celeros.app.icons");
    require("celeros.app.input");
    require("celeros.app.chat");
    require("celeros.app.ai");
    runChat();
}

function runChat() {
    T = A.style.preset("soft");
    // transcript primeiro (o cliente de IA empurra as mensagens por callback)
    var t = A.chat.new({ top: 4, bw: 196 });
    var ia = A.ai.client({
        system: SYSTEM_PROMPT,
        onmsg: function (papel, s) {
            if (papel === "user") {
                t.user(s);
            } else {
                t.bot(s);
                try {
                    if (typeof System.beep === "function") System.beep(1320, 60);
                } catch (e) { /* placa sem buzzer */ }
            }
            UI.invalidate();
        },
        note: function (s) { t.note(s); UI.invalidate(); },
        err: function (s) { t.err(s); UI.invalidate(); }
    });

    var tapUsed = false;
    var online = netOnline();
    var cfgOpen = false;
    var kb = false;
    var histRows = null;

    // topo reservado: o cabecalho e desenhado POR CIMA do transcript (o teste
    // de arrasto do harness comeca em y=20, dentro da area rolavel). A nota
    // vazia de 40px garante que a primeira mensagem nasce abaixo do cabecalho.
    function addSpacer() {
        t.note("");
        if (t.view.length) t.view[0].h = HEADER;
    }
    function welcome() {
        t.note(fit("Pergunte algo. A chave DeepSeek fica no aparelho."));
    }
    function resetChat() {
        t.clear();
        addSpacer();
        welcome();
    }

    addSpacer();
    var i;
    for (i = 0; i < ia.hist.length; i++) {
        if (ia.hist[i].r === "user") t.user(ia.hist[i].s);
        else t.bot(ia.hist[i].s);
    }
    if (!ia.hist.length) welcome();
    if (!ia.ok) t.err("requer firmware com API >= 18");

    // teclado dockado no boot (o app nasceu como chat de teclado; o botao do
    // rodape devolve a sessao depois que o sheet fecha)
    kb = A.input.open({ maxLen: 256 });

    function statusText() {
        if (ia.busy) return "pensando...";
        if (!online) return "sem conexão";
        if (!ia.ok) return "sem IA no firmware";
        if (!keyOk()) return "sem chave configurada";
        if (ia.hist.length) return ia.hist.length + " mensagens - DeepSeek";
        return "DeepSeek - pronto";
    }
    function statusColor() {
        if (ia.busy) return T.accent;
        if (!online || !ia.ok || !keyOk()) return T.err;
        return T.textDim;
    }

    // ---------------------------------------------------------------- chrome
    // Cabecalho 2.0: voltar + titulo/status + acoes (historico e configuracao).
    // Desenhado depois do transcript para cobrir a nota espacadora.
    function iconCard(icon, x, y) {
        UI.card(x, y, 28, 28, { color: T.raised, radius: 14, stroke: false });
        A.icons.draw(icon, x + 6, y + 6, 16, { color: T.text });
        UI.cardEnd();
    }
    function bar(title, sub, subColor, c, tp, actions) {
        A.style.card(0, 0, W, HEADER, {
            full: c.full, r: 0, elev: 0, grad: true, pad: 0,
            draw: function (q) {
                A.icons.draw("back", 8, 11, 18, { color: T.accent });
                UI.text(title, 32, 4, { role: "title", color: T.text,
                                        bg: q.bg, w: 130, lines: 1, id: 1 });
                if (sub) {
                    UI.text(sub, 32, 23, { role: "caption", color: subColor,
                                           bg: q.bg, w: 132, lines: 1, id: 2 });
                }
                if (actions) {
                    iconCard("menu", 168, 6);
                    iconCard("gear", 202, 6);
                }
            }
        });
        var nav = null;
        if (tp.tap && !tapUsed) {
            if (inRect(tp, 0, 0, 40, HEADER)) { tapUsed = true; nav = "back"; }
            else if (actions && inRect(tp, 164, 4, 34, 32)) { tapUsed = true; nav = "hist"; }
            else if (actions && inRect(tp, 198, 4, 34, 32)) { tapUsed = true; nav = "cfg"; }
        }
        return nav;
    }

    // ------------------------------------------------------------ sheet cfg
    function infoRow(label, value, q, y, color) {
        UI.text(label, q.x, y, { role: "caption", color: T.textDim, bg: q.bg,
                                 w: 96, lines: 1, id: 20 });
        UI.text(value, q.x + q.w, y, { role: "caption", align: "right",
                                       color: color === undefined ? T.text : color,
                                       bg: q.bg, w: q.w - 96, lines: 1, id: 21 });
    }
    function drawCfg(c) {
        if (c.full) System.fillRect(0, 0, W, H, System.mixColor(T.bg, 0x0000, 55));
        var top = 140;
        A.style.card(6, top, 228, 174, {
            full: c.full,
            draw: function (q) {
                UI.text("Modelo e conversa", q.x, q.y,
                        { role: "title", color: T.text, bg: q.bg, w: q.w,
                          lines: 1, id: 30 });
                var y = q.y + 24;
                infoRow("Modelo", "DeepSeek Flash", q, y); y += 18;
                infoRow("Contexto", "12 mensagens", q, y); y += 18;
                infoRow("Histórico", ia.hist.length + " mensagens", q, y); y += 18;
                infoRow("Chave", keyOk() ? "configurada" : "ausente", q, y,
                        keyOk() ? T.ok : T.err);
                if (A.style.button(ia.busy ? "Cancelar resposta" : "Limpar conversa",
                                   q.x, q.y + 92, q.w, 30,
                                   { variant: ia.busy ? "secondary" : "danger" })) {
                    if (ia.busy) {
                        if (ia.cancel()) t.note("cancelado");
                    } else {
                        ia.clear();
                        resetChat();
                    }
                    cfgOpen = false;
                    UI.invalidate();
                }
                if (A.style.button("Fechar", q.x, q.y + 128, q.w, 30,
                                   { variant: "secondary" })) {
                    cfgOpen = false;
                    UI.invalidate();
                }
            }
        });
        var tp = UI.touch();
        if (!tp.tap) tapUsed = false;
        if (tp.tap && !tapUsed && tp.y < top) {
            tapUsed = true;
            cfgOpen = false;
            UI.invalidate();
        }
    }

    // ------------------------------------------------------------- historico
    function buildHist() {
        var rows = [];
        for (var k = ia.hist.length - 1; k >= 0; k--) {
            rows.push({
                label: ia.hist[k].r === "user" ? "Você" : "IA",
                sub: fit(ia.hist[k].s)
            });
        }
        return rows;
    }
    function histScreen(c) {
        var tp = UI.touch();
        if (!tp.tap) tapUsed = false;
        var nav = bar("Histórico", ia.hist.length + " mensagens", T.textDim,
                      c, tp, false);
        if (nav === "back") return A.BACK;
        if (c.entered || !histRows) {
            histRows = buildHist();
            UI.resetScroll("hist");
        }
        if (!histRows.length) {
            A.style.card(A.L.x, 56, A.L.w, 74, {
                full: c.full,
                draw: function (q) {
                    UI.text("Sem mensagens ainda", q.x, q.y + 8,
                            { role: "body", align: "center", color: T.textDim,
                              bg: q.bg, w: q.w, lines: 1 });
                    UI.text("A conversa aparece aqui.", q.x, q.y + 28,
                            { role: "caption", align: "center", color: T.textDim,
                              bg: q.bg, w: q.w, lines: 1 });
                }
            });
        } else {
            UI.list("hist", A.L.x, A.L.top, A.L.w, 320 - A.L.top - 56, histRows);
        }
        if (A.style.button("Limpar histórico", A.L.x, H - 44, A.L.w, 36,
                           { variant: "danger" })) {
            ia.clear();
            histRows = buildHist();
            resetChat();
            UI.invalidate();
        }
    }

    // ------------------------------------------------------------------ chat
    function chatScreen(c) {
        var tp = UI.touch();
        if (!tp.tap) tapUsed = false;
        if (A.every(1000, "net")) online = netOnline();

        if (kb) {
            var ev = A.input.poll();
            if (ev) {
                if (ev.type === "enter") {
                    if (ev.text) ia.send(ev.text);
                    UI.invalidate();
                } else if (ev.type === "cancel") {
                    // o poll reabre a sessao sozinho: aqui o X fecha de verdade
                    A.input.close();
                    kb = false;
                    UI.invalidate();
                }
            }
        }

        if (cfgOpen) {
            // primeiro frame do sheet: desenha a conversa e SO ENTAO o veu (o
            // sheet cobre o app dimmed, nao um fundo preto); nos frames
            // parciais so o proprio sheet redesenha
            if (c.full) {
                t.busy = ia.busy;
                A.input.redraw(c.full);
                t.draw(c.full, (H - 50) - 4);
                bar("Chat IA", statusText(), statusColor(), c,
                    { tap: false, x: 0, y: 0 }, true);
            }
            drawCfg(c);
            return;
        }

        t.busy = ia.busy;
        var bottom = kb ? A.input.top() - 44 : H - 50;
        A.input.redraw(c.full);                 // frame total apaga o teclado
        t.draw(c.full, bottom - 4);

        var nav = bar("Chat IA", statusText(), statusColor(), c, tp, true);
        if (kb) {
            A.input.line("Mensagem");
        } else if (A.style.button("Digite uma mensagem", A.L.x, H - 44, A.L.w, 36,
                                  { variant: "secondary" })) {
            kb = A.input.open({ maxLen: 256 });
            UI.invalidate();
        }

        if (nav === "cfg") {
            if (kb) { A.input.close(); kb = false; }
            cfgOpen = true;
            UI.invalidate();
        } else if (nav === "hist") {
            if (kb) { A.input.close(); kb = false; }
            UI.invalidate();
            return "hist";
        } else if (nav === "back") {
            return A.BACK;
        }
    }

    A.run({ chat: chatScreen, hist: histScreen }, "chat", { fps: 20 });
}
