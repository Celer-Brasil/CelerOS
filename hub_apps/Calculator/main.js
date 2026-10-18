// CelerOS Calculator — calculadora de toque no tema do OS.
// Migrada para o CelerKit: o core celeros.app fica com o laco (A.run), o
// tema cacheado e o layout; o visor e o teclado de toque sao conteudo
// especifico do app e continuam desenhados aqui. Previa ao vivo enquanto
// digita, historico das ultimas contas e ANS reutiliza o ultimo resultado
// (persistido no FS do app). ES5 (Duktape).

var A = require("celeros.app");
A.init();

var expression = "";
var result = "";
var prevVal = null;            // previa ao vivo (recalcula so quando a conta muda)
var history = [];              // ultimas contas resolvidas (na memoria)
var MAXHIST = 3;
var ANS = 0;

// ---- persistencia leve: ultimo resultado sobrevive ao app --------------------
var ANS_FILE = (FS.appData ? FS.appData() : "/local/") + "ans.txt";
(function () {
    var raw = FS.readTextFile(ANS_FILE);
    if (raw) {
        var v = parseFloat(raw);
        if (!isNaN(v)) ANS = v;
    }
})();
function saveAns() {
    FS.writeTextFile(ANS_FILE, String(ANS));
}

// ---- botoes -------------------------------------------------------------------
var buttons = [
    { l: "C",   r: 0, c: 0, type: "clear" },
    { l: "(",   r: 0, c: 1, type: "op" },
    { l: ")",   r: 0, c: 2, type: "op" },
    { l: "/",   r: 0, c: 3, type: "op" },

    { l: "7",   r: 1, c: 0, type: "num" },
    { l: "8",   r: 1, c: 1, type: "num" },
    { l: "9",   r: 1, c: 2, type: "num" },
    { l: "*",   r: 1, c: 3, type: "op" },

    { l: "4",   r: 2, c: 0, type: "num" },
    { l: "5",   r: 2, c: 1, type: "num" },
    { l: "6",   r: 2, c: 2, type: "num" },
    { l: "-",   r: 2, c: 3, type: "op" },

    { l: "1",   r: 3, c: 0, type: "num" },
    { l: "2",   r: 3, c: 1, type: "num" },
    { l: "3",   r: 3, c: 2, type: "num" },
    { l: "+",   r: 3, c: 3, type: "op" },

    { l: "DEL", r: 4, c: 0, type: "del" },
    { l: "0",   r: 4, c: 1, type: "num" },
    { l: ".",   r: 4, c: 2, type: "num" },
    { l: "=",   r: 4, c: 3, type: "eq" }
];

var btnW = 52;
var btnH = 38;
var spacing = 4;
var startX = A.L.x + 2;    // (240 - 4*52 - 3*4)/2
var startY = 110;          // 5*38 + 4*4 = 206: ultima linha termina em 316 (< 320)

function fmtNum(v) {
    if (typeof v !== "number" || isNaN(v) || !isFinite(v)) return String(v);
    var s = String(Math.round(v * 1e8) / 1e8);
    if (s.length > 14) s = v.toExponential(6);
    return s;
}

function btnRect(b) {
    return {
        x: startX + b.c * (btnW + spacing),
        y: startY + b.r * (btnH + spacing)
    };
}

// cauda que cabe na largura (o fim da conta e o que importa)
function tail(s, role, maxW) {
    while (s.length > 0 && UI.measure(s, role) > maxW) s = s.substring(1);
    return s;
}

// ---- previa ao vivo (so avaliada quando a expressao muda) --------------------
// so previa se a expressao fecha: par balanceado e sem operador no fim
function recompute() {
    prevVal = null;
    if (expression === "") return;
    var bal = 0, lastCh = "";
    for (var i = 0; i < expression.length; i++) {
        var ch = expression.charAt(i);
        if (ch === "(") bal++;
        if (ch === ")") bal--;
        lastCh = ch;
    }
    if (bal !== 0 || "+-*/.".indexOf(lastCh) >= 0) return;
    try {
        var v = eval(expression);
        if (typeof v === "number" && !isNaN(v) && isFinite(v)) prevVal = v;
    } catch (e) { prevVal = null; }
}

// ---- visor em card -------------------------------------------------------------
function drawDisplay() {
    var T = A.T;
    var tx = A.L.x + 8;
    var tw = A.L.w - 24;
    UI.card(A.L.x, 8, A.L.w, 96);
    // historico: ultimas contas em cima, apagando
    var hs = history.slice(Math.max(0, history.length - MAXHIST));
    for (var i = 0; i < MAXHIST; i++) {
        UI.text(hs[i] || "", tx, 14 + i * 12, { role: "caption", color: T.textDim, w: tw, id: i });
    }
    // expressao corrente (cauda visivel)
    UI.text(tail(expression || "0", "body", tw), tx, 52, { w: tw });
    // resultado: fechado (accent, grande) ou previa viva (dim)
    var big = "", col = T.accent;
    if (result !== "") {
        big = tail(result, "display", tw);
        col = result === "erro" ? T.err : T.accent;
    } else if (prevVal !== null && expression !== "") {
        big = tail("= " + fmtNum(prevVal), "display", tw);
        col = T.textDim;
    }
    UI.text(big, A.L.x + A.L.w - 12, 70, { role: "display", color: col, align: "right" });
    UI.cardEnd();
}

// ---- logica --------------------------------------------------------------------
function handleButton(b) {
    if (b.type === "num" || b.type === "op") {
        // comecar por operador encadeia no resultado anterior (ex.: "+5")
        if (b.type === "op" && expression === "" && ANS !== 0) {
            expression = fmtNum(ANS) + b.l;
        } else {
            expression += b.l;
        }
        result = "";
    } else if (b.type === "clear") {
        expression = "";
        result = "";
    } else if (b.type === "del") {
        if (expression.length > 0) expression = expression.substring(0, expression.length - 1);
        result = "";
    } else if (b.type === "eq") {
        if (prevVal !== null) {
            result = fmtNum(prevVal);
            ANS = prevVal;
            saveAns();
            history.push(expression + " = " + result);
            if (history.length > 9) history.shift();
            expression = "";    // conta nova: digito comeca do zero, operador encadeia o ANS
        } else if (expression === "") {
            result = fmtNum(ANS);       // "=" vazio mostra o ultimo resultado
        } else {
            result = "erro";
        }
    }
    recompute();
}

// ---- laco: o A.run fica com o frame; tap no botao chama a logica ---------------
function keyColors(b) {
    var T = A.T;
    if (b.type === "eq") return { color: T.accent, textColor: T.onAccent };
    if (b.type === "op") return { color: T.raised, textColor: T.accent };
    if (b.type === "clear" || b.type === "del") return { color: T.raised, textColor: T.warn };
    return { color: T.card, textColor: T.text };
}

A.run({
    main: function () {
        drawDisplay();
        for (var i = 0; i < buttons.length; i++) {
            var b = buttons[i];
            var p = btnRect(b);
            var o = keyColors(b);
            o.role = b.l.length > 1 ? "body" : "title";
            if (UI.button(b.l, p.x, p.y, btnW, btnH, o)) handleButton(b);
        }
    }
}, "main", { fps: 30 });
