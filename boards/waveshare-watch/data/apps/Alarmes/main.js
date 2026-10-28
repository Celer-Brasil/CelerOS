// Alarmes — lista e edicao dos alarmes do sistema no CelerKit UI 2.0.
// ES5 puro (Duktape). Os alarmes vivem no firmware (System.alarms/addAlarm/
// updateAlarm/removeAlarm): tocam com o app fechado, a tela apagada ou o
// relogio em deep sleep. A lista mostra ate 8 alarmes com dias, rotulo e a
// chave on/off; o editor e SEM TECLADO (passos de hora/minuto, dias em
// bolinhas e rotulo ciclado numa lista curta). Layout no A.L/A.style.content
// (margem segura do vidro redondo do watch), cartoes/botoes do
// celeros.app.style e icones do celeros.app.icons; o loop/header/pilha de
// telas vem do core (A.run). O alarme novo ou disparado pelo sistema entra
// na lista por um poll leve (2 s).

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
A.init();
var T = A.style.preset("soft");

// area segura do vidro (x/w/bottom encolhem no relogio redondo)
var L = A.style.content();
var X = L.x, W = L.w, CX = A.L.cx, BOT = L.y + L.h;
var TOP = L.y, LIST_BOT = BOT - 44;
var DLET = ["D", "S", "T", "Q", "Q", "S", "S"];
var LBL = ["Sem rótulo", "Acordar", "Remédio", "Reunião", "Academia", "Soneca"];
var ROW_H = 52, ROW_GAP = 4;

var list = [];
var ed = null;          // {id, hour, minute, days, label, enabled, opts, li}
var last = "";

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function reload() { list = System.alarms(); }
function daysText(d) {
    if (!d) return "uma vez";
    if (d === 0x7F) return "todo dia";
    if (d === 0x3E) return "seg a sex";
    if (d === 0x41) return "fim de semana";
    var s = "";
    for (var i = 0; i < 7; i++) if (d & (1 << i)) s += DLET[i];
    return s;
}
// rotulo guardado fora da lista curta vira uma opcao extra (nao se perde)
function labelOpts(cur) {
    var o = LBL.slice(0);
    if (cur) {
        var found = false;
        for (var i = 1; i < o.length; i++) if (o[i] === cur) found = true;
        if (!found) o.splice(1, 0, cur);
    }
    return o;
}
function labelIdx(opts, cur) {
    cur = cur || "";
    for (var i = 0; i < opts.length; i++) {
        if ((i === 0 ? "" : opts[i]) === cur) return i;
    }
    return 0;
}

// ---- tela: lista ------------------------------------------------------------

function linha(i, off, full) {
    var a = list[i];
    var y = TOP + i * (ROW_H + ROW_GAP) - off;
    if (y + ROW_H < TOP || y > LIST_BOT) return;
    var nv = null;
    A.style.card(X, y, W, ROW_H, { full: full, pad: 8, r: T.radius, elev: 1,
        draw: function (q) {
            A.icons.draw(a.enabled ? "check" : "dot", q.x, q.y + 9, 16,
                         { color: a.enabled ? T.ok : T.textDim });
            UI.text(pad2(a.hour) + ":" + pad2(a.minute), q.x + 22, q.y + 1,
                    { role: "title", color: a.enabled ? T.text : T.textDim,
                      bg: q.bg, id: "t" + a.id, w: q.w - 74, lines: 1 });
            var sub = daysText(a.days) + (a.label ? " · " + a.label : "");
            UI.text(sub, q.x + 22, q.y + 25,
                    { role: "caption", color: T.textDim, bg: q.bg,
                      id: "s" + a.id, w: q.w - 60, lines: 1 });
            // a chave dentro do cartao limpa o proprio retangulo com o bg certo
            nv = UI.toggle(X + W - 52, y + 14, !!a.enabled, { id: a.id });
        }});
    if (nv !== null && nv !== !!a.enabled) {
        System.updateAlarm(a.id, { hour: a.hour, minute: a.minute, days: a.days,
                                   label: a.label, enabled: nv });
        reload();
        UI.invalidate();
        return;
    }
    // toque fora da chave abre a edicao
    var t = UI.touch();
    if (t.tap && t.x >= X && t.x <= X + W - 56 && t.y >= y && t.y <= y + ROW_H) {
        ed = { id: a.id, hour: a.hour, minute: a.minute, days: a.days,
               label: a.label, enabled: !!a.enabled };
        ed.opts = labelOpts(ed.label);
        ed.li = labelIdx(ed.opts, ed.label);
        return true;
    }
    return false;
}

var lista = function (c) {
    if (A.header("Alarmes", { sub: list.length + " de 8" })) return A.BACK;
    // alarme criado/disparado fora do app: poll leve
    if (A.every(2000, "al")) {
        var sig = JSON.stringify(list);
        reload();
        if (JSON.stringify(list) !== sig) UI.invalidate();
    }
    var ch = Math.max(LIST_BOT - TOP, list.length * (ROW_H + ROW_GAP) - ROW_GAP);
    var off = UI.scrollBegin("alarmes", X, TOP, W, LIST_BOT - TOP, ch);
    var open = false;
    for (var i = 0; i < list.length; i++) if (linha(i, off, c.full)) open = true;
    UI.scrollEnd();
    if (open) return "editar";
    if (list.length === 0) {
        A.icons.draw("alert", CX - 9, TOP + 44, 18, { color: T.warn });
        UI.text("Nenhum alarme", CX, TOP + 72,
                { role: "title", align: "center", color: T.text, w: W, lines: 1 });
        UI.text("Toque em + Novo alarme", CX, TOP + 96,
                { role: "caption", align: "center", color: T.textDim, w: W, lines: 1 });
    }
    var by = BOT - 36;
    if (list.length < 8) {
        if (A.style.button("+ Novo alarme", X, by, W, 32, { variant: "primary" })) {
            ed = { id: -1, hour: 7, minute: 0, days: 0x3E, label: "", enabled: true };
            ed.opts = labelOpts("");
            ed.li = 0;
            return "editar";
        }
    } else {
        A.style.button("8 de 8 alarmes", X, by, W, 32, { variant: "ghost", disabled: true });
    }
};
lista.fps = 20;

// ---- tela: editor (sem teclado) --------------------------------------------

var TY = TOP;                 // cartao da hora
var RY = TOP + 80;            // cartao de repeticao
var LY = RY + 102;            // cartao do rotulo
var BY = BOT - 34;            // botoes

function chipCx(i) { return X + 23 + i * Math.floor((W - 46) / 6); }

var editar = function (c) {
    if (A.header(ed.id < 0 ? "Novo alarme" : "Editar alarme")) return A.BACK;

    // -- hora/minuto por passos (sem teclado) --
    var bw = 26, vw = 34;
    var x0 = X + Math.round((W - (bw * 4 + vw * 2 + 14)) / 2);
    var xh = x0 + bw + 2;            // valor da hora
    var xhp = xh + vw + 2;           // + hora
    var xm = xhp + bw + 6;           // - minuto
    var xmv = xm + bw + 2;           // valor do minuto
    var xmp = xmv + vw + 2;          // + minuto
    A.style.card(X, TY, W, 74, { full: c.full, grad: false, elev: 0,
        draw: function (q) {
            var cy = TY + 8;
            if (UI.button("-", x0, cy, bw, 36, { style: "ghost" }))
                ed.hour = (ed.hour + 23) % 24;
            else if (UI.button("+", xhp, cy, bw, 36, { style: "ghost" }))
                ed.hour = (ed.hour + 1) % 24;
            UI.text(pad2(ed.hour), xh + vw / 2, cy + 4,
                    { role: "display", align: "center", color: T.text,
                      bg: q.bg, id: "hh", w: vw, lines: 1 });
            if (UI.button("-", xm, cy, bw, 36, { style: "ghost" }))
                ed.minute = ed.minute % 5 ? ed.minute - ed.minute % 5 : (ed.minute + 55) % 60;
            else if (UI.button("+", xmp, cy, bw, 36, { style: "ghost" }))
                ed.minute = (ed.minute - ed.minute % 5 + 5) % 60;
            UI.text(pad2(ed.minute), xmv + vw / 2, cy + 4,
                    { role: "display", align: "center", color: T.text,
                      bg: q.bg, id: "mm", w: vw, lines: 1 });
            UI.text("hora", xh + vw / 2, TY + 56,
                    { role: "caption", align: "center", color: T.textDim,
                      bg: q.bg, w: vw + 8, lines: 1 });
            UI.text("minuto", xmv + vw / 2, TY + 56,
                    { role: "caption", align: "center", color: T.textDim,
                      bg: q.bg, w: vw + 8, lines: 1 });
        }});

    // -- repetir: chips dos dias + atalhos --
    A.style.card(X, RY, W, 102, { full: c.full, grad: false, elev: 0,
        draw: function (q) {
            UI.text("Repetir", q.x, q.y + 2,
                    { role: "body", color: T.text, bg: q.bg, w: 100, lines: 1 });
            UI.text(daysText(ed.days), q.x + q.w, q.y + 3,
                    { role: "caption", align: "right", color: T.accent,
                      bg: q.bg, w: q.w - 70, lines: 1 });
        }});
    if (c.full) {
        for (var i = 0; i < 7; i++) {
            var on = (ed.days & (1 << i)) !== 0;
            System.fillCircle(chipCx(i), RY + 42, 12, on ? T.accent : T.raised);
            if (on) System.drawCircle(chipCx(i), RY + 42, 12, T.accentD);
            System.setTextColor(on ? T.onAccent : T.textDim);
            System.drawString(DLET[i],
                chipCx(i) - (System.textWidth(DLET[i], 2) >> 1), RY + 34, 2);
        }
    }
    var py = RY + 62, pw = Math.floor((W - 26) / 4);
    var PR = [[0x7F, "Diário"], [0x3E, "2ª-6ª"], [0x41, "Fds"], [0, "1x"]];
    for (var k = 0; k < 4; k++) {
        var sel = ed.days === PR[k][0];
        if (UI.button(PR[k][1], X + 10 + k * (pw + 2), py, pw, 26,
                sel ? { color: T.accentD, textColor: T.text, role: "caption" }
                    : { style: "ghost", role: "caption" })) {
            ed.days = PR[k][0];
            UI.invalidate();
        }
    }
    // toque num chip alterna aquele dia
    var t = UI.touch();
    if (t.tap && t.y >= RY + 28 && t.y <= RY + 56) {
        for (var j = 0; j < 7; j++) {
            if (Math.abs(t.x - chipCx(j)) <= 14) {
                ed.days ^= (1 << j);
                UI.invalidate();
                break;
            }
        }
    }

    // -- rotulo: lista curta ciclada (sem teclado) --
    var lr = A.style.card(X, LY, W, 36, { full: c.full, grad: false, elev: 0,
        draw: function (q) {
            UI.text("Rótulo", q.x, q.y + 7,
                    { role: "body", color: T.text, bg: q.bg, w: 70, lines: 1 });
            UI.text(ed.li === 0 ? "nenhum" : ed.opts[ed.li], q.x + q.w, q.y + 8,
                    { role: "caption", align: "right", color: T.accent,
                      bg: q.bg, w: q.w - 80, lines: 1 });
        }});
    var lt = UI.touch();
    if (lr && lt.tap && lt.y >= LY && lt.y <= LY + 36) {
        ed.li = (ed.li + 1) % ed.opts.length;
        ed.label = ed.li === 0 ? "" : ed.opts[ed.li];
        UI.invalidate();
    }

    // -- acoes --
    if (ed.id >= 0) {
        var half = Math.round((W - 6) / 2);
        if (A.style.button("Apagar", X, BY, half, 30, { variant: "danger", role: "caption" })) {
            System.removeAlarm(ed.id);
            reload();
            A.toast("Alarme apagado");
            return A.BACK;
        }
        if (A.style.button("Salvar", X + half + 6, BY, W - half - 6, 30, { variant: "primary" })) {
            return salvar();
        }
    } else if (A.style.button("Salvar", X, BY, W, 32, { variant: "primary" })) {
        return salvar();
    }
};
editar.fps = 12;

function salvar() {
    // enabled PRESERVADO: editar nao religa um alarme desligado
    var spec = { hour: ed.hour, minute: ed.minute, days: ed.days,
                 label: ed.label, enabled: !!ed.enabled };
    var ok = ed.id >= 0 ? System.updateAlarm(ed.id, spec) : System.addAlarm(spec) >= 0;
    A.toast(ok ? "Alarme " + pad2(ed.hour) + ":" + pad2(ed.minute) : "Falha ao salvar");
    reload();
    return A.BACK;
}

reload();
A.run({ lista: lista, editar: editar }, "lista");
