// CelerOS Qwen 2.0 — assistente de voz (Mic.* + provider openrouter do AI)
// sobre o CelerKit (deps celeros.app.*): bolhas/rolagem no celeros.app.chat,
// linha de digitacao com teclado dockado no celeros.app.input e saneamento
// Latin-1 no celeros.app.text. O PEDIDO de IA segue feito aqui: o
// celeros.app.ai nao aceita provider nem content part de audio
// (input_audio) nem reasoning.effort — e a voz e bench-sensitiva. O historico
// mora no mesmo arquivo de sempre (appData/historico.json).
//
// 2.0.0: UI kit 2.0 (celeros.app.style/icons/caps): cabecalho com acoes
// (ABC/engrenagem), botao de voz com anel de tempo e medidor de nivel,
// sheet de modelo/conversa e estados claros de sem microfone/sem rede.
// ES5 puro (Duktape). A chave fica no aparelho (/local/openrouter_key.txt) -
// o app nunca a ve. topbar: false — o chrome e daqui (o cao nao tem touch
// para o X da faixa e cada face precisa do vidro inteiro).
//
// Duas caras:
//  - placas com touch: transcript rolavel + cabecalho + botao redondo de
//    segurar-para-falar + teclado ancorado; sem microfone vira chat de texto
//    puro (mesmo servidor).
//  - cao robotico (spotpear-dog): OLED 128x64 sem touch — o canvas virtual
//    240x320 escala x0.53/y0.20 e texto comum fica ilegivel, entao esta
//    versao desenha com fonte propria 4x6 em pixels FISICOS (helper P()),
//    como o Dog Face. Entrada: pad capacitivo (System.touchPad) — segurar
//    fala, tocar rola a resposta, 3 toques rapidos saem.

var A = require("celeros.app");
require("celeros.app.text");
require("celeros.app.caps");

A.init();
var T = A.T;
var INFO = System.getInfo();
var W = 240, H = 320;
var IS_DOG = (INFO.board === "spotpear-dog");
var CAPS = A.caps.probe();
var HAS_MIC = !!CAPS.mic && (typeof Mic !== "undefined") && typeof Mic.start === "function";
var hasAI = (typeof AI !== "undefined" && typeof AI.chat === "function");
var VER = System.getOSVersion();

var PROV = "openrouter";
var SYSTEM_PROMPT = "Você é o Qwen, assistente de voz do CelerOS, sistema " +
    "para dispositivos ESP32 com tela pequena. As perguntas podem chegar " +
    "como áudio: ouça e responda por texto em português, de forma curta e " +
    "direta, sem usar emojis.";
var CTX_MSGS = 12;               // mensagens de contexto enviadas
var MAX_MSGS = 20;              // mensagens guardadas no historico
var busy = false;               // requisicao em curso
var t = null;                   // transcript do touch (null no cao)
var answerSink = null;
var questionSink = null;

// ------------------------------------------------------------ historico ---
// Conversa: {r: "user"|"assistant", s}. Persistencia best-effort: historico
// nunca derruba o chat; o arquivo e o mesmo da versao anterior.
var APP_DATA = "";
try { APP_DATA = FS.appData() || ""; } catch (e) { APP_DATA = ""; }
if (!APP_DATA) APP_DATA = "/local/data/celeros.qwen/";
if (APP_DATA.charAt(APP_DATA.length - 1) !== "/") APP_DATA += "/";
var HIST_PATH = APP_DATA + "historico.json";

function loadHist() {
    try {
        var raw = FS.readTextFile(HIST_PATH) || "";
        if (!raw) return [];
        var v = JSON.parse(raw);
        if (!v || typeof v.length !== "number") return [];
        var out = [];
        for (var i = 0; i < v.length; i++) {
            var m = v[i];
            if (!m || typeof m.s !== "string") continue;
            if (m.r !== "user" && m.r !== "assistant") continue;
            out.push({ r: m.r, s: m.s });
        }
        return out;
    } catch (e) { return []; }
}
function saveHist() {
    try { FS.writeTextFile(HIST_PATH, JSON.stringify(msgs)); } catch (e) { /* sem fs */ }
}
var msgs = loadHist();
if (!msgs || typeof msgs.length !== "number") msgs = [];

function pushMsg(role, s) {
    msgs.push({ r: role, s: A.text.fit(s) });
    if (msgs.length > MAX_MSGS) msgs.shift();
    saveHist();
}
function online() {
    try { return !!(typeof Net !== "undefined" && Net.isConnected()); } catch (e) { return false; }
}

// ------------------------------------------------------------------ envio --
// Payload: system + contexto de texto; a pergunta atual pode ser texto ou o
// content part de audio (a voz nao entra no historico — vira "(voz)")
function buildPayload(audioB64) {
    var payload = [{ role: "system", content: SYSTEM_PROMPT }];
    var end = msgs.length;
    if (audioB64) end -= 1;  // a "(voz)" recem empilhada sai do contexto
    var start = Math.max(0, end - CTX_MSGS);
    for (var i = start; i < end; i++) {
        payload.push({ role: msgs[i].r, content: msgs[i].s });
    }
    if (audioB64) {
        payload.push({ role: "user", content: [
            { type: "input_audio", input_audio: { data: audioB64, format: "wav" } }
        ]});
    }
    return payload;
}

function cue(freq, ms) {
    try { if (typeof System.beep === "function") System.beep(freq, ms); } catch (e) {}
}

// Envia a pergunta empilhada em msgs (texto ou voz). answerSink(r) recebe o
// resultado no present — cada interface desenha do seu jeito.
function request(audioB64, isRetry) {
    if (busy) return false;
    if (!hasAI) { if (answerSink) answerSink({ ok: false, error: "sem AI no firmware (requer API >= 18)" }); return true; }
    var conf = false;
    try { conf = AI.configured(PROV); } catch (e) { conf = false; }
    if (!conf) {
        if (answerSink) answerSink({ ok: false, error: "sem chave (tools/push_ai_key.py " + PROV + ")" });
        return true;
    }
    if (!online()) { if (answerSink) answerSink({ ok: false, error: "sem WiFi" }); return true; }
    busy = true;
    if (t) { t.busy = true; UI.invalidate(); }
    var opts = {
        provider: PROV,
        messages: buildPayload(audioB64),
        max_tokens: 300,               // teto curto: resposta rapida, longe do timeout do gateway
        reasoning: { effort: "low" }   // omni e raciocinador: low corta latencia
    };
    var started = false;
    // AI.chat LANCA (WiFi caiu entre o check e a chamada, chave sumiu):
    // sem o catch o app morria na tela de erro com busy preso
    try {
        started = AI.chat(opts, function (r) {
            busy = false;
            if (t) { t.busy = false; UI.invalidate(); }
            if (!isRetry && r && !r.ok &&
                (r.status === 502 || r.status === 504 || r.status === 429)) {
                if (answerSink) answerSink({ ok: false, retrying: true });
                setTimeout(function () { request(audioB64, true); }, 2000);
                return;
            }
            cue(1320, 60);
            if (r && r.ok && r.content) pushMsg("assistant", r.content);
            if (answerSink) answerSink(r || { ok: false, error: "sem resposta" });
        });
    } catch (e) {
        busy = false;
        if (t) { t.busy = false; UI.invalidate(); }
        if (answerSink) answerSink({ ok: false, error: String(e) });
        return true;
    }
    if (!started) {
        busy = false;
        if (t) { t.busy = false; UI.invalidate(); }
        // slot ocupado: quase sempre uma requisicao orfa (app fechado no
        // meio) ou o retry da pergunta anterior ainda no ar — nao e erro do
        // dono, e "espere a resposta chegar"
        if (!isRetry && answerSink) answerSink({ ok: false, error: "ainda processando a pergunta anterior..." });
    }
    return true;
}

function sendText(text) {
    if (!text) return;
    pushMsg("user", text);
    if (questionSink) questionSink(text);
    request(null);
}

function sendRecording(b64) {
    // o stop do Mic devolve o base64 do WAV pronto para o input_audio
    if (!b64) { if (answerSink) answerSink({ ok: false, error: "não capturou áudio" }); return; }
    pushMsg("user", "(voz)");
    if (questionSink) questionSink("(voz)");  // a pergunta aparece na conversa
    request(b64);
}

// ===========================================================================
// Sem vidro (devkit/esp32-cam): nao ha teclado/toque nem como ouvir. Avisa.
// ===========================================================================
if (!IS_DOG && typeof UI === "undefined") {
    System.print("[qwen] esta placa nao tem tela nem microfone: use o Chat IA pelo terminal");
} else if (IS_DOG) {
    runDog();
} else {
    runTouch();
}

// ===========================================================================
// INTERFACE TOUCH (relogio, SmartDisplay, CYD): transcript + botao de voz
// ===========================================================================
function runTouch() {
// os modulos do kit tocam UI no proprio load: so entram com vidro/touch
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.chat");
require("celeros.app.input");
var ST = A.style.preset("soft");
var REC_MS = 8000;               // teto da captura no touch
var MIN_MS = 700;                // abaixo disso descarta (toque perdido)
var TOP = 44;                    // conversa abaixo do cabecalho
var MIC_CY = H - 44;
var MIC_R = 30;

var transcript = A.chat.new({ top: TOP, bw: 196 });
t = transcript;

var rec = false;                 // gravando (botao segurado)
var recStart = 0;
var kb = false;                  // teclado dockado aberto
var cfgOpen = false;             // sheet de modelo/conversa
var tapUsed = false;
var onlineState = online();

function inRect(tp, x, y, w, h) {
    return tp.x >= x && tp.x < x + w && tp.y >= y && tp.y < y + h;
}

// conversa anterior (o historico mora no appData; a vista, na transcript)
for (var hi = 0; hi < msgs.length; hi++) {
    if (msgs[hi].r === "user") transcript.user(msgs[hi].s);
    else transcript.bot(msgs[hi].s);
}

// resultado da IA: entra na conversa (o frame seguinte redesenha)
questionSink = function (text) { transcript.user(text); UI.invalidate(); };
answerSink = function (r) {
    if (r && r.retrying) {
        transcript.note("repetindo...");
    } else if (r && r.ok && r.content) {
        transcript.bot(r.content);
        if (r.usage && r.usage.total_tokens) {
            transcript.note("(" + r.usage.total_tokens + " tokens)");
        }
    } else if (r && r.ok) {
        transcript.err("Qwen: resposta vazia");
    } else {
        transcript.err("erro: " + (r && r.error ? r.error : "HTTP " + (r ? r.status : 0)));
        if (r && r.detail) transcript.note("detalhe: " + A.text.fit(r.detail));
    }
    UI.invalidate();
};

// ------------------------------------------------------------------- chrome
function ctext(s, cy, color, font) {
    System.setTextColor(color);
    System.setTextDatum(5);
    System.drawString(String(s), 120, cy, font || 1);
    System.setTextDatum(0);
    System.setTextSize(1);
}

function status() {
    if (rec) return "gravando";
    if (busy) return "pensando...";
    if (!HAS_MIC) return "sem microfone";
    if (!onlineState) return "sem rede";
    return "OpenRouter - pronto";
}
function statusColor() {
    if (rec) return ST.accent;
    if (busy) return ST.accent;
    if (!HAS_MIC || !onlineState) return ST.warn;
    return ST.textDim;
}

function toggleKb() {
    if (rec) cancelRec();
    if (kb) {
        A.input.close();
        kb = false;
    } else {
        kb = A.input.open({ maxLen: 256 });
    }
    UI.invalidate();
}

function bar(c, tp) {
    A.style.card(0, 0, W, 40, {
        full: c.full, r: 0, elev: 0, grad: true, pad: 0,
        draw: function (q) {
            A.icons.draw("back", 8, 11, 18, { color: ST.accent });
            UI.text("Qwen", 32, 4, { role: "title", color: ST.text,
                                     bg: q.bg, w: 118, lines: 1, id: 1 });
            UI.text(status(), 32, 23, { role: "caption", color: statusColor(),
                                        bg: q.bg, w: 118, lines: 1, id: 2 });
            if (A.style.button("ABC", 156, 6, 40, 28,
                               { variant: kb ? "primary" : "ghost", role: "caption" })) {
                toggleKb();
            }
            UI.card(204, 6, 28, 28, { color: ST.raised, radius: 14, stroke: false });
            A.icons.draw("gear", 210, 12, 16, { color: ST.text });
            UI.cardEnd();
        }
    });
    var nav = null;
    if (tp.tap && !tapUsed) {
        if (inRect(tp, 0, 0, 40, 40)) { tapUsed = true; nav = "back"; }
        else if (inRect(tp, 202, 4, 32, 32)) { tapUsed = true; nav = "cfg"; }
    }
    return nav;
}

// --------------------------------------------------------------- sheet cfg
function infoRow(label, value, q, y, color) {
    UI.text(label, q.x, y, { role: "caption", color: ST.textDim, bg: q.bg,
                             w: 92, lines: 1, id: 20 });
    UI.text(value, q.x + q.w, y, { role: "caption", align: "right",
                                   color: color === undefined ? ST.text : color,
                                   bg: q.bg, w: q.w - 92, lines: 1, id: 21 });
}
function clearChat() {
    msgs.length = 0;
    saveHist();
    transcript.clear();
    transcript.note("Qwen " + VER, ST.accent);
    transcript.note("conversa apagada");
    UI.invalidate();
}
function drawCfg(c) {
    if (c.full) System.fillRect(0, 0, W, H, System.mixColor(ST.bg, 0x0000, 55));
    var top = 140;
    A.style.card(6, top, 228, 174, {
        full: c.full,
        draw: function (q) {
            UI.text("Modelo e conversa", q.x, q.y,
                    { role: "title", color: ST.text, bg: q.bg, w: q.w,
                      lines: 1, id: 30 });
            var y = q.y + 24;
            infoRow("Modelo", "Qwen Omni", q, y); y += 18;
            infoRow("Provedor", "OpenRouter", q, y); y += 18;
            infoRow("Contexto", "12 mensagens", q, y); y += 18;
            infoRow("Histórico", msgs.length + " mensagens", q, y);
            if (A.style.button(busy ? "Cancelar resposta" : "Limpar conversa",
                               q.x, q.y + 92, q.w, 30,
                               { variant: busy ? "secondary" : "danger" })) {
                if (busy) {
                    if (hasAI && AI.cancel()) {
                        busy = false;
                        transcript.note("cancelado");
                    }
                } else {
                    clearChat();
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

// -------------------------------------------------------------- gravacao ---
function startRec() {
    if (rec || busy || !HAS_MIC) return;
    if (!Mic.start({ ms: REC_MS })) {
        transcript.note("microfone ocupado ou sem RAM", ST.err);
        return;
    }
    rec = true;
    recStart = System.millis();
    UI.invalidate();
}
function finishRec() {
    if (!rec) return;
    rec = false;
    var el = System.millis() - recStart;
    if (el < MIN_MS) {
        Mic.stop();  // descarta o pinguinho
        transcript.note("(muito curto, tente de novo)");
        return;
    }
    sendRecording(Mic.stop());
    UI.invalidate();
}
function cancelRec() {
    if (!rec) return;
    rec = false;
    Mic.stop();
    transcript.note("(cancelado)");
    UI.invalidate();
}

// Botao de voz: circulo + anel de tempo + nucleo pelo nivel. Desenho proprio
// em A.custom (assinatura muda com o estado), sem alocar no caminho de frame.
function area(id, x, y, w, h, sig, draw) {
    if (typeof A.custom === "function") {
        return A.custom(id, x, y, w, h, sig, draw, { bg: ST.bg });
    }
    if (!A.full) return false;   // nucleo antigo sem A.custom: so frame total
    System.fillRect(x, y, w, h, ST.bg);
    draw(x, y, w, h);
    return true;
}
function drawMicRaw(x, y, w, h, level, el) {
    var label, sub, color;
    if (rec) {
        label = "gravando";
        sub = "solte para enviar";
        color = ST.accent;
        System.fillArc(120, MIC_CY, 34, 38, 0, 360, ST.raised);
        var frac = Math.min(1, el / REC_MS);
        System.fillArc(120, MIC_CY, 34, 38, -90, -90 + 360 * frac, ST.accent);
    } else if (busy) {
        label = "pensando...";
        sub = "aguarde a resposta";
        color = ST.textDim;
    } else if (!HAS_MIC) {
        label = "sem microfone nesta placa";
        sub = "use o teclado (ABC)";
        color = ST.textDim;
    } else if (!onlineState) {
        label = "sem rede";
        sub = "conecte o Wi-Fi para falar";
        color = ST.warn;
    } else {
        label = "segure e fale";
        sub = "arraste para fora para cancelar";
        color = ST.textDim;
    }
    ctext(label, y + 6, color, 1);
    ctext(sub, y + 84, ST.textDim, 1);

    var active = HAS_MIC && onlineState && !busy;
    var bgc = active ? (rec ? ST.accent : ST.accentD) : ST.raised;
    System.fillSmoothCircle(120, MIC_CY, MIC_R, bgc);
    if (rec) {
        var lvl = level < 0 ? 0 : (level > 100 ? 100 : level);
        System.fillSmoothCircle(120, MIC_CY, 6 + Math.round(18 * lvl / 100), ST.accentD);
        ctext((el / 1000).toFixed(1) + "s", MIC_CY, ST.onAccent, 2);
    } else {
        var mg = active ? ST.accent : ST.textDim;
        System.fillSmoothRoundRect(113, MIC_CY - 16, 14, 22, 7, mg);
        System.drawWideLine(108, MIC_CY + 2, 108, MIC_CY + 6, 2, mg);
        System.drawWideLine(132, MIC_CY + 2, 132, MIC_CY + 6, 2, mg);
        System.drawWideLine(120, MIC_CY + 12, 120, MIC_CY + 18, 2, mg);
        if (!HAS_MIC || !onlineState) {
            System.drawWideLine(108, MIC_CY - 18, 132, MIC_CY + 18, 2, ST.err);
        }
    }
}
function drawMic() {
    var level = rec ? Math.max(0, Mic.level()) : 0;
    var el = rec ? System.millis() - recStart : 0;
    var sig = rec ? "r" + Math.floor(el / 100) + ":" + Math.round(level / 8)
            : busy ? "b" : !HAS_MIC ? "n" : !onlineState ? "o" : "i";
    area("mic", 0, H - 96, W, 96, sig, function (x, y, w, h) {
        drawMicRaw(x, y, w, h, level, el);
    });
}

// ------------------------------------------------------------------ main ---
transcript.note("Qwen " + VER, ST.accent);
if (!hasAI) transcript.err("requer firmware com API >= 18");
else {
    var conf = false;
    try { conf = AI.configured(PROV); } catch (e) { conf = false; }
    if (!conf) transcript.err("sem chave: rode tools/push_ai_key.py " + PROV);
}
if (!HAS_MIC) transcript.note("sem microfone aqui: use o teclado");
else if (!onlineState) transcript.note("sem rede: o microfone volta quando o Wi-Fi voltar");
else transcript.note("fale segurando o botão; arraste para rever");

// Sem microfone o teclado abre direto (chat de texto puro)
kb = HAS_MIC ? false : A.input.open({ maxLen: 256 });

A.run({
    chat: function (c) {
        var tp = UI.touch();
        if (!tp.tap) tapUsed = false;
        if (A.every(1000, "net")) onlineState = online();

        // eventos do teclado chegam antes do frame (o firmware entrega no present)
        if (kb) {
            var ev = A.input.poll();
            if (ev) {
                if (ev.type === "enter") {
                    if (ev.text) sendText(ev.text);
                    UI.invalidate();
                } else if (ev.type === "cancel") {
                    A.input.close();
                    kb = false;
                    UI.invalidate();
                }
            }
        }

        if (cfgOpen) {
            if (c.full) {
                transcript.busy = busy;
                A.input.redraw(c.full);
                transcript.draw(c.full, (H - 96) - TOP);
                bar(c, { tap: false, x: 0, y: 0 });
            }
            drawCfg(c);
            return;
        }

        // botao de voz: segurar dentro do circulo grava; soltar envia; arrastar
        // para fora cancela. O teclado aberto esconde o botao.
        if (!kb && HAS_MIC) {
            var dx = tp.x - 120, dy = tp.y - MIC_CY;
            var d2 = dx * dx + dy * dy;
            if (!rec) {
                if (tp.down && !busy && onlineState &&
                    d2 <= (MIC_R + 8) * (MIC_R + 8)) startRec();
            } else if (tp.down && d2 > (MIC_R + 26) * (MIC_R + 26)) {
                cancelRec();
            } else if (!tp.down) {
                finishRec();
            }
        }
        if (rec && typeof Mic !== "undefined" && !Mic.recording()) finishRec();

        transcript.busy = busy;
        var bottom = kb ? A.input.top() - 44 : H - 96;
        A.input.redraw(c.full);           // frame total apaga o teclado
        transcript.draw(c.full, bottom - TOP);
        var nav = bar(c, tp);
        if (kb) A.input.line("Mensagem");
        else drawMic();

        if (nav === "cfg") {
            if (rec) cancelRec();
            if (kb) { A.input.close(); kb = false; }
            cfgOpen = true;
            UI.invalidate();
        } else if (nav === "back") {
            return A.BACK;
        }
    }
}, "chat", { fps: 20 });
}  // fim da interface touch

// ===========================================================================
// INTERFACE DO CAO ROBOTICO (OLED 128x64, pad capacitivo, sem touch)
// ===========================================================================
function runDog() {
var PW = 128, PH = 64;  // vidro fisico do OLED

function PX(x) { return Math.round(x * 240 / PW); }
function PY(y) { return Math.round(y * 320 / PH); }
function PW_(w) { return Math.round(w * 240 / PW); }
function PH_(h) { return Math.round(h * 320 / PH); }

var REC_MS_D = 6000;
var MIN_MS_D = 800;
var HOLD_MS = 400;      // segurar este tempo comeca a gravar
var TAP_EXIT = 3;       // toques rapidos para sair (sem touch/botao no cao)
var CHARS = 25;         // 25 colunas de 5 px (4 de glifo + 1 de folga)
var ROWS = 7;           // 7 linhas de 8 px no corpo

// Fonte 4x6 propria: no OLED o drawString do canvas virtual (escala y0.20)
// e ilegivel — cada glifo e desenhado em pixels fisicos do vidro. O painel
// e 1-bit: toda cor vira tinta, barras usam moldura+preenchimento. Cada
// glifo = 6 linhas de 4 bits (nibble, bit mais alto = coluna da esquerda).
var FONT = {
    " ":"000000",
    "A":"69F999","B":"E9E99E","C":"788887","D":"E9999E","E":"F8E88F","F":"F8E888",
    "G":"78B997","H":"99F999","I":"E4444E","J":"311196","K":"9ACA99","L":"88888F",
    "M":"9FF999","N":"9DFB99","O":"699996","P":"E9E888","Q":"6999A5","R":"E9EA99",
    "S":"78611E","T":"E44444","U":"999996","V":"999966","W":"999FF9","X":"996699",
    "Y":"AA4444","Z":"F1688F",
    "0":"69BD96","1":"4C444E","2":"E1688F","3":"E6111E","4":"99F111","5":"F8E11E",
    "6":"78E996","7":"F12444","8":"696996","9":"69971E",
    ".":"000006",",":"000064","?":"E16404","!":"444404",":":"0C0C00","-":"000F00",
    "+":"04E400","/":"124488","'":"440000","(":"248842",")":"421124","=":"00F0F0",
    "%":"924890"
};

// acentos viram a base (a fonte 4x6 nao tem glifo acentuado)
var FOLD = {
    "Á":"A","À":"A","Â":"A","Ã":"A","Ä":"A","É":"E","Ê":"E","Í":"I",
    "Ó":"O","Ô":"O","Õ":"O","Ö":"O","Ú":"U","Ü":"U","Ç":"C"
};

function dogFold(s) {
    var out = "";
    s = String(s).toUpperCase();
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        if (FOLD[ch]) ch = FOLD[ch];
        if (FONT[ch] !== undefined) out += ch;
    }
    return out;
}

function dogChar(x, y, ch, color) {
    var g = FONT[ch];
    if (!g) return;
    for (var r = 0; r < 6; r++) {
        var bits = parseInt(g.charAt(r), 16);
        if (!bits) continue;
        for (var c = 0; c < 4; c++) {
            if (bits & (8 >> c)) System.fillRect(PX(x + c), PY(y + r), PW_(1), PH_(1), color);
        }
    }
}

function dogText(x, y, s, color) {
    s = dogFold(s);
    var cx = x;
    for (var i = 0; i < s.length; i++) {
        if (cx > PW - 4) return;
        dogChar(cx, y, s.charAt(i), color);
        cx += 5;
    }
}

function dogWrap(s) {
    var out = [];
    var words = dogFold(s).split(" ");
    var cur = "";
    for (var i = 0; i < words.length; i++) {
        var w = words[i];
        while (w.length > CHARS) {
            if (cur.length) { out.push(cur); cur = ""; }
            out.push(w.substring(0, CHARS));
            w = w.substring(CHARS);
        }
        var trial = cur.length ? cur + " " + w : w;
        if (trial.length > CHARS && cur.length) {
            out.push(cur);
            cur = w;
        } else {
            cur = trial;
        }
    }
    if (cur.length) out.push(cur);
    return out;
}

var stD = "idle";       // idle | rec | busy
var recStartD = 0;
var padDown = false;
var padDownAt = 0;
var holdFired = false;
var answerLines = [];   // resposta atual quebrada em linhas de ate 25 chars
var answerPage = 0;
var taps = [];
var hintIdx = 0;
var lastHint = 0;
var lastDraw = 0;
var dirtyD = true;
var HINTS = ["HOLD=FALA TOQUE=ROLA", "3 TOQUES SAEM", "SOLTE O PAD P/ ENVIAR"];

function pages() {
    return Math.max(1, Math.ceil(answerLines.length / ROWS));
}

function drawHeader() {
    var right;
    if (stD === "rec") {
        right = "REC " + ((System.millis() - recStartD) / 1000).toFixed(1) + "S";
    } else if (stD === "busy") {
        right = "ENVIANDO";
        var d = Math.floor(System.millis() / 400) % 4;
        for (var i = 0; i < d; i++) right += ".";
    } else {
        right = "PRONTO";
    }
    System.fillRect(0, 0, PW_(PW), PH_(8), T.text);
    dogText(1, 1, "QWEN", T.bg);
    dogText(PW - 2 - right.length * 5, 1, right, T.bg);
}

function drawBody() {
    System.fillRect(0, PY(9), PW_(PW), PH_(47), T.bg);
    if (stD === "rec") {
        dogText(2, 12, "OUVINDO VOCE", T.text);
        var lvl = Mic.level();
        if (lvl < 0) lvl = 0;
        // nivel: moldura + preenchimento (painel 1-bit nao tem cor de fundo)
        System.drawRect(PX(2), PY(21), PW_(124), PH_(8), T.text);
        System.fillRect(PX(4), PY(23), PW_(Math.round(120 * lvl / 100)), PH_(4), T.accent);
        // tempo restante
        var frac = (System.millis() - recStartD) / REC_MS_D;
        if (frac > 1) frac = 1;
        System.drawRect(PX(2), PY(33), PW_(124), PH_(6), T.text);
        System.fillRect(PX(4), PY(35), PW_(Math.round(120 * frac)), PH_(2), T.accent);
        dogText(2, 44, "SOLTE O PAD P/", T.textDim);
        dogText(2, 52, "ENVIAR", T.textDim);
    } else if (stD === "busy") {
        dogText(2, 20, "PENSANDO...", T.accent);
        dogText(2, 32, "A RESPOSTA VAI SAIR", T.textDim);
        dogText(2, 40, "AQUI EM TEXTO", T.textDim);
    } else {
        var p = Math.min(answerPage, pages() - 1);
        var y = 11;
        for (var i = p * ROWS; i < (p + 1) * ROWS && i < answerLines.length; i++) {
            dogText(2, y, answerLines[i], T.text);
            y += 8;
        }
        if (!answerLines.length) {
            dogText(2, 16, "QWEN PRONTO", T.accent);
            dogText(2, 30, "SEGURE O PAD NAS", T.textDim);
            dogText(2, 38, "COSTAS E FALE", T.textDim);
        }
    }
}

function drawFooter() {
    System.fillRect(0, PY(57), PW_(PW), PH_(7), T.bg);
    dogText(2, 58, HINTS[hintIdx % HINTS.length], T.textDim);
    if (stD === "idle" && answerLines.length && pages() > 1) {
        var pg = ((answerPage % pages()) + 1) + "/" + pages();
        dogText(PW - 2 - pg.length * 5, 58, pg, T.accent);
    }
}

function drawAllD() {
    drawHeader();
    drawBody();
    drawFooter();
    // o texto do cao e desenhado pixel a pixel (fillRect): o harness nao ve
    // nada no log — o estado vai por aqui para os testes
    if (typeof __harness !== "undefined") {
        __harness.qwenDog = { st: stD, lines: answerLines.length, page: answerPage };
    }
}

function registerTaps() {
    var now = System.millis();
    taps.push(now);
    if (taps.length > TAP_EXIT) taps.shift();
    if (taps.length === TAP_EXIT && now - taps[0] < 900) {
        cue(500, 40);
        System.exitApp();
    }
}

answerSink = function (r) {
    if (r && r.retrying) { stD = "busy"; dirtyD = true; return; }  // repete em silencio
    stD = "idle";
    if (r && r.ok && r.content) {
        answerLines = dogWrap(A.text.fit(r.content));
        answerPage = 0;
    } else {
        var msg = "ERRO: " + (r && r.error ? r.error : "HTTP " + (r ? r.status : 0));
        if (r && r.detail) msg += " " + A.text.fit(r.detail).substring(0, 40);
        answerLines = dogWrap(msg);
        answerPage = 0;
    }
    dirtyD = true;
};

function startRecD() {
    if (stD !== "idle" || busy || !HAS_MIC) return;
    if (!Mic.start({ ms: REC_MS_D })) {
        answerLines = dogWrap("MIC OCUPADO OU SEM RAM");
        answerPage = 0;
        dirtyD = true;
        return;
    }
    stD = "rec";
    recStartD = System.millis();
    dirtyD = true;
}

function finishRecD() {
    var el = System.millis() - recStartD;
    stD = "idle";
    if (el < MIN_MS_D) {
        Mic.stop();  // curtinho: descarta
        dirtyD = true;
        return;
    }
    var b64 = Mic.stop();
    if (b64) {
        sendRecording(b64);   // empilha "(voz)" e pede
        stD = busy ? "busy" : "idle";
    }
    dirtyD = true;
}

// a ultima resposta sobrevive ao reboot (historico)
if (msgs.length) {
    for (var mi = msgs.length - 1; mi >= 0; mi--) {
        if (msgs[mi].r === "assistant" && msgs[mi].s) {
            answerLines = dogWrap(msgs[mi].s);
            break;
        }
    }
}

while (true) {
    var pad = (typeof System.touchPad === "function") ? System.touchPad() : 0;
    var now = System.millis();

    if (pad && !padDown) {         // borda de descida
        padDown = true;
        padDownAt = now;
        holdFired = false;
    } else if (!pad && padDown) {  // borda de subida
        padDown = false;
        if (stD === "rec") {
            finishRecD();
        } else if (!holdFired) {
            registerTaps();
            if (answerLines.length) {  // toque rola a resposta
                answerPage++;
                dirtyD = true;
            }
        }
    } else if (padDown && !holdFired && stD === "idle" && !busy &&
               now - padDownAt >= HOLD_MS) {
        holdFired = true;
        startRecD();
    }

    // teto de tempo alcancado: encerra e envia sozinho
    if (stD === "rec" && HAS_MIC && !Mic.recording()) finishRecD();

    // dicas do rodape giram a cada 3 s
    if (now - lastHint > 3000) {
        lastHint = now;
        hintIdx++;
        dirtyD = true;
    }
    // rec/busy animam (tempo, nivel, pontos)
    if (stD !== "idle" && now - lastDraw > 150) dirtyD = true;

    if (dirtyD) {
        drawAllD();
        dirtyD = false;
        lastDraw = now;
    }
    System.delay(20);
}
}  // fim da interface do cao
