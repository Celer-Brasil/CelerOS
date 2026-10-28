// CelerOS Calculator — calculadora de toque no tema do OS (CelerKit UI 2.0).
// Visor em card com previa ao vivo e chip do ANS (tocar insere o ultimo
// resultado), teclado grande no A.style (tokens + press nativo), historico
// em sheet (tocar numa conta reaproveita o resultado) e seletor de tema
// salvo no aparelho. O ANS e o historico persistem no FS do app. Sem cor
// fixa: tudo sai de A.style.T (segue o tema do sistema). ES5 (Duktape).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
A.init();

// ---- tema: "" segue o sistema; o resto e um preset do A.style ---------------
var PRESETS = ["soft", "flat", "neon", "paper"];
var PNAMES = ["Sistema", "Suave", "Plano", "Neon", "Papel"];
var preset = "";
try { preset = Storage.get("preset", "") || ""; } catch (e) { preset = ""; }
if (preset) A.style.preset(preset);
var T = A.style.T;

// layout na area segura (no watch redondo A.L encolhe a largura/rodape)
var LX = A.L.x, LW = A.L.w, BOT = A.L.bottom;
var CARD_Y = A.L.top - 4, CARD_H = 88;          // 44/88 no retangular
var HIW = LW - 96;                             // linha do historico
var CHIP_W = 66, CHIP_X = LX + LW - CHIP_W - 8;
var KEY_Y = CARD_Y + CARD_H + 6;
var KEY_GAP = 5;
var KEY_W = Math.floor((LW - 3 * KEY_GAP) / 4);
var KEY_H = Math.floor((BOT - KEY_Y - 4 * KEY_GAP) / 5);

// ---- estado ----------------------------------------------------------------
var expr = "";
var result = "";
var prevVal = null;      // previa ao vivo (recalcula so quando a conta muda)
var ans = 0;
var hist = [];           // {e: conta, r: resultado}, mais nova primeiro
var MAXH = 9;
var SHOWH = 4;           // linhas visiveis no sheet

var DIR = "/local/";
try { DIR = FS.appData() || "/local/"; } catch (e) { DIR = "/local/"; }
var ANSF = DIR + "ans.txt";
var HISTF = DIR + "hist.txt";

(function load() {
    try {
        var v = parseFloat(FS.readTextFile(ANSF));
        if (!isNaN(v)) ans = v;
    } catch (e) { /* sem arquivo: ANS 0 */ }
    try {
        var h = JSON.parse(FS.readTextFile(HISTF));
        if (h && h.length) hist = h.slice(0, MAXH);
    } catch (e) { /* sem historico salvo */ }
})();
function saveAns() { try { FS.writeTextFile(ANSF, String(ans)); } catch (e) { /* sem fs */ } }
function saveHist() { try { FS.writeTextFile(HISTF, JSON.stringify(hist)); } catch (e) { /* sem fs */ } }

function fmt(v) {
    if (typeof v !== "number" || isNaN(v) || !isFinite(v)) return String(v);
    var s = String(Math.round(v * 1e8) / 1e8);
    return s.length > 14 ? v.toExponential(6) : s;
}
function pretty(s) { return String(s).replace(/\*/g, "×").replace(/\//g, "÷"); }
// cauda que cabe na largura (o fim da conta e o que importa)
function tail(s, role, maxW) {
    s = String(s);
    while (s.length > 0 && UI.measure(s, role) > maxW) s = s.substring(1);
    return s;
}

// ---- previa ao vivo (so avalia quando a expressao fecha ---------------------
function recompute() {
    prevVal = null;
    if (!expr) return;
    var bal = 0, lastCh = "";
    for (var i = 0; i < expr.length; i++) {
        var ch = expr.charAt(i);
        if (ch === "(") bal++;
        else if (ch === ")") bal--;
        lastCh = ch;
    }
    if (bal !== 0 || "+-*/.".indexOf(lastCh) >= 0) return;
    if (!/^[0-9+\-*/(). ]+$/.test(expr)) return;
    try {
        var v = eval(expr);
        if (typeof v === "number" && !isNaN(v) && isFinite(v)) prevVal = v;
    } catch (e) { prevVal = null; }
}

// ---- acoes ------------------------------------------------------------------
// t: "d" digito, "o"/"i" operador/abre-fecha, "c" limpa, "x" apaga, "=" resolve
function press(ins, t) {
    if (t === "c") {
        expr = "";
        result = "";
    } else if (t === "x") {
        if (expr) expr = expr.substring(0, expr.length - 1);
        result = "";
    } else if (t === "=") {
        if (prevVal !== null) {
            result = fmt(prevVal);
            ans = prevVal;
            saveAns();
            hist.unshift({ e: pretty(expr), r: result });
            if (hist.length > MAXH) hist.pop();
            saveHist();
            expr = "";   // conta nova: digito comeca do zero, operador encadeia o ANS
        } else if (!expr) {
            result = fmt(ans);   // "=" vazio devolve o ultimo resultado
        } else {
            result = "erro";
        }
    } else {
        // comecar por operador encadeia no resultado anterior (ex.: "+5"):
        // a conta recem-fechada no "=" manda (0 tambem encadeia); sem ela o
        // ANS responde, e ANS 0 (primeira conta) nao encadeia nada
        if (t === "o" && !expr) {
            var base = result !== "" && result !== "erro" ? result
                     : (ans !== 0 ? fmt(ans) : "");
            if (base) expr = base + ins;
        } else {
            expr += ins;
        }
        result = "";
    }
    recompute();
}

function useVal(v) {
    if (/[0-9)]$/.test(expr)) expr += "*";   // nao cola dois numeros
    expr += String(v);
    result = "";
    recompute();
    UI.invalidate();
}

// ---- sheets: 1 historico, 2 tema ---------------------------------------------
var shKind = 0, shOpen = false, shUntil = 0;
function openSheet(k) { shKind = k; shOpen = true; UI.invalidate(); }
function closeSheet() { shOpen = false; shUntil = System.millis() + 260; UI.invalidate(); }

function histSheet(c) {
    return A.widgets.sheet("calc-hist",
        { open: shOpen, full: c.full && shOpen, h: 228, title: "Histórico" },
        function (r) {
            var bg = r.bg, tp = UI.touch();
            if (!hist.length) {
                UI.text("Nenhuma conta ainda.", r.x, r.y + 8,
                        { role: "caption", color: T.textDim, bg: bg, w: r.w });
            }
            var n = Math.min(hist.length, SHOWH);
            for (var i = 0; i < n; i++) {
                var y = r.y + 2 + i * 32, h = hist[i];
                A.style.divider(r.x, y + 29, r.w);
                UI.text(tail(h.e, "body", r.w - 88), r.x, y + 2,
                        { role: "body", color: T.text, bg: bg, w: r.w - 88, lines: 1 });
                UI.text(tail(h.r, "title", 78), r.x + r.w, y + 2,
                        { role: "title", align: "right", color: T.accent, bg: bg, w: 78 });
                // a linha so age com o sheet aberto (na saida ele so desliza)
                if (shOpen && tp.tap && tp.y >= y && tp.y <= y + 30 &&
                    tp.x >= r.x && tp.x <= r.x + r.w) {
                    useVal(h.r);
                    closeSheet();
                }
            }
            var clr = A.style.button("Limpar histórico", r.x, r.y + 136, r.w, 34,
                                     { variant: "secondary", textColor: T.warn });
            if (shOpen && clr) {
                hist = [];
                saveHist();
                UI.invalidate();
            }
        });
}

function themeSheet(c) {
    return A.widgets.sheet("calc-theme",
        { open: shOpen, full: c.full && shOpen, h: 224, title: "Tema" },
        function (r) {
            for (var i = 0; i < 5; i++) {
                var on = i === 0 ? preset === "" : preset === PRESETS[i - 1];
                var hit = A.style.button(PNAMES[i] + (on ? "  ·  atual" : ""),
                                         r.x, r.y + i * 34, r.w, 30,
                                         { variant: on ? "primary" : "secondary" });
                if (shOpen && hit) {
                    preset = i === 0 ? "" : PRESETS[i - 1];
                    A.style.preset(preset || "soft");
                    try { Storage.set("preset", preset); } catch (e) { /* sem nvs */ }
                    closeSheet();
                }
            }
        });
}

// ---- teclado ----------------------------------------------------------------
// [rotulo, tipo, o que insere]
var KEYS = [
    ["C", "c", ""],   ["(", "i", "("], [")", "i", ")"], ["÷", "o", "/"],
    ["7", "d", "7"],  ["8", "d", "8"], ["9", "d", "9"], ["×", "o", "*"],
    ["4", "d", "4"],  ["5", "d", "5"], ["6", "d", "6"], ["-", "o", "-"],
    ["1", "d", "1"],  ["2", "d", "2"], ["3", "d", "3"], ["+", "o", "+"],
    ["DEL", "x", ""], ["0", "d", "0"], [".", "d", "."], ["=", "=", ""]
];

function keyOpt(k) {
    var t = k[1];
    if (t === "=") return { variant: "primary", role: "title" };
    if (t === "d") return { variant: "secondary", role: "title" };
    if (t === "o" || t === "i")
        return { variant: "secondary", role: "title", textColor: T.accent };
    return { variant: "secondary", role: t === "x" ? "body" : "title",
             textColor: T.warn };
}

// ---- visor ------------------------------------------------------------------
function visor(c) {
    A.style.card(LX, CARD_Y, LW, CARD_H, { full: c.full, draw: function (r) {
        var bg = r.bg;
        // chip do ANS (desenhado no frame cheio; o texto tem slot proprio)
        if (c.full) {
            System.fillRoundRect(CHIP_X, r.y - 2, CHIP_W, 20, 10, T.raised);
            System.drawRoundRect(CHIP_X, r.y - 2, CHIP_W, 20, 10, T.stroke);
        }
        // ultimas contas
        UI.text(hist.length ? tail(hist[0].e, "caption", HIW) : "pronto",
                r.x, r.y, { role: "caption", color: T.textDim, bg: bg, w: HIW, id: "h0" });
        if (hist.length > 1) {
            UI.text(tail(hist[1].e, "caption", HIW), r.x, r.y + 11,
                    { role: "caption", color: T.textDim, bg: bg, w: HIW, id: "h1" });
        }
        UI.text("ANS " + fmt(ans), CHIP_X + CHIP_W / 2, r.y + 1,
                { role: "caption", align: "center", color: T.accent, bg: T.raised,
                  w: CHIP_W - 4, id: "ans" });
        // expressao corrente (cauda visivel)
        UI.text(tail(pretty(expr) || "0", "body", r.w), r.x, r.y + 24,
                { role: "body", color: T.text, bg: bg, w: r.w, id: "expr" });
        // resultado fechado (accent) ou previa viva (dim)
        var big = "", col = T.accent;
        if (result !== "") {
            big = result;
            col = result === "erro" ? T.err : T.accent;
        } else if (prevVal !== null && expr) {
            big = "= " + fmt(prevVal);
            col = T.textDim;
        }
        UI.text(tail(big, "display", r.w), r.x + r.w, r.y + 44,
                { role: "display", align: "right", color: col, bg: bg, w: r.w, id: "big" });
    }});
}

// ---- tela -------------------------------------------------------------------
function tela(c) {
    // durante a saida do sheet a base e redesenhada sob o veu (senao o
    // quadro fica limpo e a tela "pisca" preta); sem aceitar toque
    var dead = shKind !== 0 && !shOpen;
    var h = A.widgets.header("Calculadora", {
        full: c.full,
        actions: [{ icon: "menu", id: "hist" }, { icon: "gear", id: "theme" }]
    });
    if (!dead && h.back) return A.BACK;
    if (!dead && h.action === "hist") { openSheet(1); return; }
    if (!dead && h.action === "theme") { openSheet(2); return; }

    visor(c);

    // toque no chip do ANS insere o ultimo resultado
    var tp = UI.touch();
    if (!dead && tp.tap && tp.x >= CHIP_X && tp.x <= CHIP_X + CHIP_W &&
        tp.y >= CARD_Y + 8 && tp.y <= CARD_Y + 28) {
        useVal(fmt(ans));
    }

    for (var i = 0; i < KEYS.length; i++) {
        var k = KEYS[i], col = i % 4, row = (i / 4) | 0;
        if (A.style.button(k[0], LX + col * (KEY_W + KEY_GAP),
                           KEY_Y + row * (KEY_H + KEY_GAP),
                           KEY_W, KEY_H, keyOpt(k))) {
            if (!dead) press(k[2], k[1]);
        }
    }
}

A.run({
    main: function (c) {
        // sheet e modal: desenha so ele (o veu cobre o resto)
        if (shKind) {
            if (!shOpen) tela(c);      // base sob a animacao de saida
            var r = shKind === 1 ? histSheet(c) : themeSheet(c);
            if (r === "close") closeSheet();
            if (!shOpen && System.millis() > shUntil) {
                shKind = 0;
                UI.invalidate();
            }
            return;
        }
        return tela(c);
    }
}, "main", { fps: 30 });
