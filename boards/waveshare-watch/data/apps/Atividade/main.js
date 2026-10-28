// Atividade — passos do dia x meta e historico de 7 dias no CelerKit UI 2.0.
// ES5 puro (Duktape). Dados do pedometro do firmware: Sensors.steps() (dia
// corrente) e Sensors.stepHistory() (dias fechados, mais recente primeiro).
// Meta em System.setting("step_goal") — editavel em Ajustes > Relogio.
// A UI 2.0 traz o anel de progresso e as barras como areas pintadas pelo
// A.custom (nas S3 so repintam quando o numero muda; na CYD o mesmo contrato
// pelo frame total) e os cartoes/rotulos do celeros.app.style. O layout sai
// do A.L/A.style.content: no vidro redondo do watch nada encosta na borda.
// O loop e o header vem do core (A.run); os dados re-poll de 20 s.

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
A.init();
var T = A.style.preset("soft");

var L = A.style.content();
var X = L.x, W = L.w, CX = A.L.cx, BOT = L.y + L.h;
var HY = L.y, HH = 150;                     // cartao do anel/hoje
var BY = HY + HH + 6;                       // cartao das barras
var BH = BOT - BY - 2;
var DIA = ["D", "S", "T", "Q", "Q", "S", "S"];
var PASSO_M = 0.75;                          // passada media (m)
var KCAL_PASSO = 0.04;

var hasS = typeof Sensors !== "undefined" && Sensors &&
           typeof Sensors.steps === "function";
var hasH = hasS && typeof Sensors.stepHistory === "function";

var steps = -1, goal = 8000, hist = [], days = [], maxStep = 1;
var hsig = "", lastSig = "";
// A.custom so existe no kit local (1.1.x); no kit antigo do hub pinta no frame total
var CUSTOM = !!(A.custom && A.custom.call);

function goalOf() {
    var g = 0;
    try { g = parseInt(System.setting("step_goal"), 10); } catch (e) { g = 0; }
    return g > 0 ? g : 8000;
}
// yyyymmdd -> dia da semana (0 = domingo)
function weekday(ymd) {
    var y = Math.floor(ymd / 10000), m = Math.floor(ymd / 100) % 100, d = ymd % 100;
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// 6543 -> "6.543" (milhar pt-BR)
function grp(n) {
    var s = String(n), o = "", c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
        o = s.charAt(i) + o;
        if (++c % 3 === 0 && i > 0 && i > s.length - 4) o = "." + o;
    }
    return o;
}
function fmtKm(st) {
    var v = st * PASSO_M / 1000;
    return (v < 10 ? v.toFixed(2) : v.toFixed(1)).replace(".", ",") + " km";
}
function fmtKcal(st) { return Math.round(st * KCAL_PASSO) + " kcal"; }

function buildDays() {
    days = [];
    var n = Math.min(hist.length, 6);
    for (var i = n - 1; i >= 0; i--) days.push(hist[i]);
    days.push({ date: 0, steps: steps < 0 ? 0 : steps });
    maxStep = goal;
    hsig = "";
    for (i = 0; i < days.length; i++) {
        if (days[i].steps > maxStep) maxStep = days[i].steps;
        hsig += days[i].date + ":" + days[i].steps + "|";
    }
}
function refresh() {
    steps = hasS ? Sensors.steps() : -1;
    goal = goalOf();
    hist = hasH ? Sensors.stepHistory() : [];
    buildDays();
}
// quantos dias (fechados) bateram a meta
function metaOk() {
    var ok = 0;
    for (var i = 0; i < hist.length; i++) if (hist[i].steps >= goal) ok++;
    return ok;
}

// ---- anel do dia (area pintada; assinatura = passos|meta) -------------------
function anel(x, y, w, h, full) {
    var paint = function () {
        var cx = x + Math.round(w / 2), cy = y + Math.round(h / 2);
        var r = Math.round(Math.min(w, h) / 2) - 4, th = 9;
        var f = steps / goal;
        if (f < 0) f = 0;
        var pct = Math.round(f * 100);
        if (f > 1) f = 1;
        System.fillArc(cx, cy, r - th, r, 0, 360, T.raised);
        if (f > 0.004) {
            var col = steps >= goal ? T.ok : T.accent;
            var a1 = -90 + 360 * f, rad = Math.PI / 180, rm = r - th / 2;
            System.fillArc(cx, cy, r - th, r, -90, a1, col);
            // pontas arredondadas (o setor cru termina em degrau)
            System.fillCircle(Math.round(cx + Math.cos(-90 * rad) * rm),
                              Math.round(cy + Math.sin(-90 * rad) * rm),
                              Math.round(th / 2), col);
            System.fillCircle(Math.round(cx + Math.cos(a1 * rad) * rm),
                              Math.round(cy + Math.sin(a1 * rad) * rm),
                              Math.round(th / 2), col);
        }
        System.setTextDatum(5);
        System.setTextColor(steps >= goal ? T.ok : T.text);
        System.drawString(pct + "%", cx, cy, 2);
        System.setTextColor(T.textDim);
        System.drawString("meta", cx, cy + 18, 1);
        System.setTextDatum(0);
    };
    if (CUSTOM) A.custom("anel", x, y, w, h, steps + "|" + goal, paint, { bg: T.card });
    else if (full) paint();
}

// ---- barras dos ultimos dias (area pintada) --------------------------------
function barras(x, y, w, h, full) {
    var paint = function () {
        var n = 7, cw = Math.floor(w / n), bw = cw - 8;
        var top = y + 2, bot = y + h - 12;
        var gy = bot - Math.round((bot - top) * goal / maxStep);
        System.drawFastHLine(x, gy, w, T.stroke);
        var off = n - days.length;
        for (var i = 0; i < days.length; i++) {
            var bx = x + (off + i) * cw + 4;
            var bh = Math.max(2, Math.round((bot - top) * days[i].steps / maxStep));
            var today = i === days.length - 1;
            System.fillRoundRect(bx, bot - bh, bw, bh, 3,
                days[i].steps >= goal ? T.ok : (today ? T.accent : T.raised));
            var lab = today ? "H" : DIA[weekday(days[i].date)];
            System.setTextColor(today ? T.accent : T.textDim);
            System.drawString(lab, bx + ((bw - System.textWidth(lab, 1)) >> 1), bot + 3, 1);
        }
    };
    if (CUSTOM) A.custom("bars", x, y, w, h, hsig, paint, { bg: T.card });
    else if (full) paint();
}

function semSensor(c) {
    A.style.card(X, HY, W, 120, { full: c.full, draw: function (q) {
        A.icons.draw("alert", CX - 9, q.y + 12, 18, { color: T.warn });
        UI.text("Sem sensor de movimento", CX, q.y + 40,
                { role: "title", align: "center", color: T.warn, bg: q.bg, w: q.w, lines: 1 });
        UI.text("Este aparelho não tem pedômetro", CX, q.y + 66,
                { role: "caption", align: "center", color: T.textDim, bg: q.bg, w: q.w, lines: 2 });
    }});
    A.style.card(X, HY + 128, W, 52, { full: c.full, draw: function (q) {
        UI.text("A meta de passos fica em Ajustes > Relógio", CX, q.y + 12,
                { role: "caption", align: "center", color: T.textDim, bg: q.bg, w: q.w, lines: 2 });
    }});
}

var main = function (c) {
    if (A.header("Atividade", { sub: steps < 0 ? "sem sensor" : metaOk() + "/" + hist.length + " dias" }))
        return A.BACK;
    if (c.entered) refresh();
    if (A.every(20000, "dia")) {
        refresh();
        UI.invalidate();
    }
    var sg = steps + "|" + goal + "|" + hsig;
    if (sg !== lastSig) { lastSig = sg; UI.invalidate(); }

    if (steps < 0) { if (c.full) semSensor(c); return; }

    // -- hoje: anel + numeros --
    A.style.card(X, HY, W, HH, { full: c.full, pad: 10, draw: function (q) {
        UI.text("HOJE", X + 100, HY + 22,
                { role: "caption", color: T.textDim, bg: q.bg, w: W - 110, lines: 1 });
        UI.text(grp(steps), X + 100, HY + 34,
                { role: "display", color: steps >= goal ? T.ok : T.text,
                  bg: q.bg, id: "st", w: W - 110, lines: 1 });
        UI.text(fmtKm(steps), X + 100, HY + 72,
                { role: "caption", color: T.textDim, bg: q.bg, w: W - 110, lines: 1 });
        A.icons.draw("heart", X + 100, HY + 87, 12, { color: T.err });
        UI.text(fmtKcal(steps), X + 114, HY + 87,
                { role: "caption", color: T.textDim, bg: q.bg, w: W - 124, lines: 1 });
        UI.text("de " + goal + " passos", CX, HY + 120,
                { role: "caption", align: "center", color: T.textDim,
                  bg: q.bg, id: "goal", w: W - 20, lines: 1 });
        var msg = steps >= goal ? "meta batida" : "faltam " + grp(goal - steps) + " passos";
        var mw = UI.measure(msg, "caption");
        var tx = CX - Math.round((mw + 20) / 2);
        A.icons.draw(steps >= goal ? "check" : "dot", tx, HY + 133, 12,
                     { color: steps >= goal ? T.ok : T.textDim });
        UI.text(msg, tx + 18, HY + 135,
                { role: "caption", color: steps >= goal ? T.ok : T.textDim,
                  bg: q.bg, id: "msg", w: W - 40, lines: 1 });
    }});
    anel(X + 2, HY + 26, 92, 92, c.full);

    // -- ultimos 7 dias em barras --
    A.style.card(X, BY, W, BH, { full: c.full, pad: 10, draw: function (q) {
        UI.text("Últimos 7 dias", q.x, q.y + 2,
                { role: "body", color: T.text, bg: q.bg, w: q.w - 70, lines: 1 });
        UI.text(metaOk() + "/" + hist.length, q.x + q.w, q.y + 4,
                { role: "caption", align: "right", color: T.accent,
                  bg: q.bg, w: 60, lines: 1 });
    }});
    barras(X + 10, BY + 28, W - 20, BH - 36, c.full);
};
main.fps = 5;

refresh();
A.run({ main: main }, "main");
