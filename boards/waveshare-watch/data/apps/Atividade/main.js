// Atividade — passos do dia x meta e historico de 7 dias no CelerKit.
// ES5 puro (Duktape). Dados do pedometro do firmware: Sensors.steps() (dia
// corrente) e Sensors.stepHistory() (dias fechados, mais recente primeiro).
// Meta em System.setting("step_goal") — editavel em Ajustes > Relogio.
// O loop, o header e o polling vem do core (A.run/A.every); o cartao do
// grafico e conteudo proprio (primitivas cruas dentro do if full).

var A = require("celeros.app");
A.init();

var INFO = {};
try { INFO = System.getInfo() || {}; } catch (e) { INFO = {}; }
// margem lateral pelo inset do vidro (canto arredondado do relogio)
var M = 12 + Math.round((INFO.inset || 0) / 2);
var DIA = ["D", "S", "T", "Q", "Q", "S", "S"];
var PASSO_M = 0.75;      // passada media (m)
var KCAL_PASSO = 0.04;

function ctext(s, y, f, col) {
    System.setTextColor(col);
    System.drawString(s, Math.round((240 - System.textWidth(s, f)) / 2), y, f);
}
function goal() {
    var g = 0;
    try { g = parseInt(System.setting("step_goal"), 10); } catch (e) { g = 0; }
    return g > 0 ? g : 8000;
}
// yyyymmdd -> dia da semana (Zeller simplificado via Date UTC)
function weekday(ymd) {
    var y = Math.floor(ymd / 10000), m = Math.floor(ymd / 100) % 100, d = ymd % 100;
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// "12,34 km" (passada media; virgula decimal por ser texto de tela pt-BR)
function fmtKm(steps) {
    var km = steps * PASSO_M / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)).replace(".", ",") + " km";
}

var hasHist = typeof Sensors !== "undefined" && Sensors && typeof Sensors.stepHistory === "function";
var hist = hasHist ? Sensors.stepHistory() : [];
var g = goal();

function draw(steps) {
    if (steps < 0) {
        ctext("Sem sensor de movimento", 150, 2, A.T.warn);
        return;
    }
    // hoje
    ctext("Hoje", 56, 1, A.T.textDim);
    ctext(String(steps), 76, 4, steps >= g ? A.T.ok : A.T.text);
    ctext("de " + g + " passos", 122, 1, A.T.textDim);
    var bw = 240 - 2 * M, pw = Math.min(bw, Math.round(bw * steps / g));
    System.fillRoundRect(M, 140, bw, 10, 5, A.T.card);
    if (pw > 8) System.fillRoundRect(M, 140, pw, 10, 5, steps >= g ? A.T.ok : A.T.accent);
    System.setTextColor(A.T.textDim);
    System.drawString(fmtKm(steps), M, 160, 2);
    var kc = Math.round(steps * KCAL_PASSO) + " kcal";
    System.drawString(kc, 240 - M - System.textWidth(kc, 2), 160, 2);

    // 7 dias: hoje + ate 6 fechados (mais antigo a esquerda)
    var days = [];
    for (var i = Math.min(hist.length, 6) - 1; i >= 0; i--) days.push(hist[i]);
    days.push({ date: 0, steps: steps });
    var max = g;
    for (i = 0; i < days.length; i++) if (days[i].steps > max) max = days[i].steps;
    var top = 192, bot = 280, n = 7, colW = Math.floor((240 - 2 * M) / n);
    ctext("Últimos dias", 172, 1, A.T.textDim);
    // linha da meta
    var gy = bot - Math.round((bot - top) * g / max);
    System.drawFastHLine(M, gy, 240 - 2 * M, A.T.stroke);
    var off = n - days.length;
    for (i = 0; i < days.length; i++) {
        var x = M + (off + i) * colW + 4, w = colW - 8;
        var h = Math.max(2, Math.round((bot - top) * days[i].steps / max));
        var isToday = i === days.length - 1;
        System.fillRoundRect(x, bot - h, w, h, 3,
            isToday ? A.T.accent : (days[i].steps >= g ? A.T.ok : A.T.raised));
        var lab = isToday ? "H" : DIA[weekday(days[i].date)];
        System.setTextColor(isToday ? A.T.accent : A.T.textDim);
        System.drawString(lab, x + Math.round((w - System.textWidth(lab, 1)) / 2), bot + 6, 1);
    }
    if (hist.length) ctext("meta batida em " + metaOk() + " de " + hist.length + " dias", 300, 1, A.T.textDim);
}

// quantas vezes a meta caiu no historico (vai no sub do header)
function metaOk() {
    var ok = 0;
    for (var i = 0; i < hist.length; i++) if (hist[i].steps >= g) ok++;
    return ok;
}

var lastSig = "";

A.run({
    main: function (c) {
        if (A.header("Atividade")) return A.BACK;
        var steps = (typeof Sensors !== "undefined" && Sensors) ? Sensors.steps() : -1;
        // ~20 s: virada do dia / meta nova
        if (A.every(20000, "dia")) {
            hist = hasHist ? Sensors.stepHistory() : [];
            g = goal();
            UI.invalidate();
        }
        var sig = steps + "|" + g + "|" + hist.length;
        if (sig !== lastSig) { lastSig = sig; UI.invalidate(); }
        if (c.full) draw(steps);
    }
}, "main", { fps: 5 });
