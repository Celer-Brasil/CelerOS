// Alarmes — lista e edicao dos alarmes do sistema no CelerKit.
// ES5 puro (Duktape). Os alarmes vivem no firmware (System.alarms/addAlarm/
// updateAlarm/removeAlarm): tocam com o app fechado, a tela apagada ou o
// relogio em deep sleep. Edicao sem teclado: +/- na hora e no minuto e os
// dias da semana em bolinhas. O loop, o header e a pilha de telas vem do
// core (A.run); pad2 vem do celeros.app.fmt; a lista rola no scroll nativo
// (UI.scrollBegin) com a chave on/off nativa (UI.toggle) dentro do cartao
// da linha (UI.card) — o resto e conteudo proprio do app.

var A = require("celeros.app");
require("celeros.app.fmt");
A.init();

var INFO = {};
try { INFO = System.getInfo() || {}; } catch (e) { INFO = {}; }
var M = 10 + Math.round((INFO.inset || 0) / 2);
var DLET = ["D", "S", "T", "Q", "Q", "S", "S"];
var ROW_H = 46, TOP = 48, LIST_BOT = 258;

var list = [];
var ed = null;          // {id, hour, minute, days, label, enabled}
var last = "";

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
function ctext(s, y, f, col) {
    System.setTextColor(col);
    System.drawString(s, Math.round((240 - System.textWidth(s, f)) / 2), y, f);
}

// ---- tela: lista ------------------------------------------------------------

function linha(i, off, full) {
    var a = list[i];
    var y = TOP + i * ROW_H - off;
    if (y + ROW_H < TOP || y > LIST_BOT) return;
    var w = 240 - 2 * M;
    // cartao nativo: a chave on/off (UI.toggle) limpa o proprio retangulo
    // com a cor de fundo certa quando muda de estado fora do frame cheio
    UI.card(M, y + 3, w, ROW_H - 6);
    if (full) {
        System.setTextColor(a.enabled ? A.T.text : A.T.textDim);
        System.drawString(A.fmt.pad2(a.hour) + ":" + A.fmt.pad2(a.minute), M + 10, y + 9, 4);
        System.setTextColor(A.T.textDim);
        var sub = daysText(a.days) + (a.label ? "  " + a.label : "");
        System.drawString(sub.length > 22 ? sub.substring(0, 21) + "." : sub, M + 86, y + 18, 1);
    }
    // chave on/off (44x24, hit com folga; devolve o estado novo no toque)
    if (UI.toggle(240 - M - 48, y + 14, a.enabled, { id: a.id }) !== !!a.enabled) {
        System.updateAlarm(a.id, { hour: a.hour, minute: a.minute, days: a.days,
                                   label: a.label, enabled: !a.enabled });
        reload();
        UI.invalidate();
    }
    UI.cardEnd();
}

var lista = function (c) {
    if (A.header("Alarmes", { sub: list.length + " de 8" })) return A.BACK;
    // alarme novo/disparado enquanto o app esta aberto: poll leve
    if (A.every(2000, "al")) {
        var sig = JSON.stringify(list);
        reload();
        if (JSON.stringify(list) !== sig) UI.invalidate();
    }
    var off = UI.scrollBegin("alarmes", 0, TOP, 240, LIST_BOT - TOP,
                             Math.max(LIST_BOT - TOP, list.length * ROW_H));
    for (var i = 0; i < list.length; i++) linha(i, off, c.full);
    UI.scrollEnd();
    if (list.length === 0 && c.full) ctext("Nenhum alarme", 140, 2, A.T.textDim);
    if (list.length < 8 && UI.button("+ Novo", M + 30, 272, 240 - 2 * M - 60, 36, {})) {
        ed = { id: -1, hour: 7, minute: 0, days: 0x3E, label: "", enabled: true };
        return "editar";
    }
    // toque numa linha abre a edicao (a chave consome o toque dela)
    var t = UI.touch();
    if (t.tap && t.y >= TOP && t.y < LIST_BOT && t.x < 240 - M - 52) {
        var j = Math.floor((t.y - TOP + off) / ROW_H);
        if (j >= 0 && j < list.length) {
            var a = list[j];
            ed = { id: a.id, hour: a.hour, minute: a.minute, days: a.days,
                   label: a.label, enabled: !!a.enabled };
            return "editar";
        }
    }
};
lista.fps = 20;

// ---- tela: editor -----------------------------------------------------------

var HM = [M, 64, 44, 40], HP = [M + 70, 64, 44, 40];               // hora - +
var MM = [240 - M - 114, 64, 44, 40], MP = [240 - M - 44, 64, 44, 40];  // minuto - +
var DAY_Y = 146;
var DEL = [M, 262, 112 - M, 40], SAVE = [128, 262, 240 - M - 128, 40];

function dayCx(i) { return Math.round(M + 14 + i * (240 - 2 * M - 28) / 6); }

var editar = function (c) {
    if (A.header(ed.id < 0 ? "Novo alarme" : "Editar alarme")) return A.BACK;
    if (UI.button("-", HM[0], HM[1], HM[2], HM[3], { style: "ghost" })) ed.hour = (ed.hour + 23) % 24;
    else if (UI.button("+", HP[0], HP[1], HP[2], HP[3], { style: "ghost" })) ed.hour = (ed.hour + 1) % 24;
    else if (UI.button("-", MM[0], MM[1], MM[2], MM[3], { style: "ghost" }))
        ed.minute = ed.minute % 5 ? ed.minute - ed.minute % 5 : (ed.minute + 55) % 60;
    else if (UI.button("+", MP[0], MP[1], MP[2], MP[3], { style: "ghost" }))
        ed.minute = (ed.minute - ed.minute % 5 + 5) % 60;
    // Apagar so existe para alarme ja salvo
    if (ed.id >= 0 && UI.button("Apagar", DEL[0], DEL[1], DEL[2], DEL[3], { style: "danger" })) {
        System.removeAlarm(ed.id);
        reload();
        return A.BACK;
    }
    if (UI.button("Salvar",
            ed.id >= 0 ? SAVE[0] : M + 30, SAVE[1], ed.id >= 0 ? SAVE[2] : 240 - 2 * M - 60, SAVE[3], {})) {
        // enabled PRESERVADO (novo nasce ativo; editar nao religa o desligado)
        var spec = { hour: ed.hour, minute: ed.minute, days: ed.days,
                     label: ed.label, enabled: ed.enabled };
        var ok = ed.id >= 0 ? System.updateAlarm(ed.id, spec) : System.addAlarm(spec) >= 0;
        A.toast(ok ? "Alarme " + A.fmt.pad2(ed.hour) + ":" + A.fmt.pad2(ed.minute) : "Falha ao salvar");
        reload();
        return A.BACK;
    }
    if (c.full) {
        ctext(A.fmt.pad2(ed.hour) + ":" + A.fmt.pad2(ed.minute), 110, 4, A.T.text);
        for (var i = 0; i < 7; i++) {
            var on = (ed.days & (1 << i)) !== 0;
            System.fillCircle(dayCx(i), DAY_Y + 30, 13, on ? A.T.accent : A.T.card);
            System.setTextColor(on ? A.T.onAccent : A.T.textDim);
            System.drawString(DLET[i], dayCx(i) - (System.textWidth(DLET[i], 2) >> 1), DAY_Y + 23, 2);
        }
        ctext(daysText(ed.days), DAY_Y + 56, 1, A.T.textDim);
        ctext(ed.label ? ed.label : "(toque aqui p/ rótulo)", 228, 1, A.T.textDim);
    }
    // dias da semana e rotulo: toque cru (conteudo proprio do app)
    var t = UI.touch();
    if (t.tap) {
        if (t.y >= DAY_Y + 14 && t.y < DAY_Y + 48) {
            for (var k = 0; k < 7; k++) if (Math.abs(t.x - dayCx(k)) <= 15) ed.days ^= (1 << k);
            UI.invalidate();
        } else if (t.y >= 218 && t.y < 248) {
            var l = System.prompt("Rótulo do alarme", ed.label || "");
            if (l !== null && l !== undefined) {
                ed.label = String(l).substring(0, 40);
                UI.invalidate();
            }
        }
    }
};
editar.fps = 10;

reload();
A.run({ lista: lista, editar: editar }, "lista");
