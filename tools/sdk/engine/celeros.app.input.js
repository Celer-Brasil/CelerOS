// app.input.js — CelerKit INPUT (dep "celeros.app.input"): o teclado do OS
// ancorado no rodape com a linha de digitacao por cima (o par drawInput/
// keypadPoll que o Chat IA e o Terminal reescrevem). Decora o core:
//
//   var A = require("celeros.app");
//   require("celeros.app.input");
//   var kb = A.input.open({ maxLen: 256, chips: ["Limpar"] });
//   A.run({
//       tela: function (c) {
//           var ev = A.input.poll();
//           if (ev && ev.type === "enter" && ev.text) enviar(ev.text);
//           if (A.header("Chat")) return A.BACK;
//           conversa.draw(c.full, kb ? A.input.top() - 44 : 268);
//           if (kb) A.input.line("Mensagem");   // card + caret + cauda
//       }
//   }, "tela");
//
// cancel do teclado REABRE a sessao sozinho (o firmware fecha no X) e
// devolve {type:"cancel"} — o app so limpa o estado se quiser.

var A = require('celeros.app');

A.input = {
    version: '1.0.1',
    _kb: false,
    _top: 320,
    _last: null,     // opts da sessao corrente (o cancel reabre com elas)

    // abre a sessao dockada; chips = labels da faixa superior (API 6).
    // false = placa/sem teclado acoplado (app roda so com prompt).
    open: function (o) {
        o = o || {};
        A.input._last = o;
        var ok = false;
        try { ok = !!System.keypadOpen({ field: false, maxLen: o.maxLen || 256 }); }
        catch (e) { ok = false; }
        A.input._kb = ok;
        A.input._top = 320;
        if (ok) {
            try {
                var r = System.keypadRect();
                if (r && r.y) A.input._top = r.y;
            } catch (e2) { /* fica 320 */ }
            if (o.chips && typeof System.topbarButtons === 'function') {
                System.topbarButtons(o.chips);
            }
        }
        return ok;
    },

    // y onde o teclado comeca (o conteudo do app termina aqui)
    top: function () { return A.input._top; },
    ativo: function () { return A.input._kb; },

    // texto corrente da linha
    text: function () {
        try { return System.keypadText() || ''; } catch (e) { return ''; }
    },

    // drena 1 evento do teclado: {type:"enter",text}|{type:"cancel"}|null.
    // cancel reabre a sessao (o firmware fechou) e devolve o evento.
    poll: function () {
        if (!A.input._kb) return null;
        var ev = null;
        try { ev = System.keypadPoll(); } catch (e) { return null; }
        if (!ev) return null;
        if (ev.type === 'cancel') {
            A.input.open(A.input._last || {});   // mesma sessao (maxLen etc.)
            UI.invalidate();
        }
        return ev;
    },

    // frame total apaga o teclado acoplado: redesenha por cima. Chame logo
    // apos o UI.begin (o Chat IA faz isso direto).
    redraw: function (full) {
        if (full && A.input._kb) {
            try { System.keypadDraw(); } catch (e) { /* sem teclado */ }
        }
    },

    // a linha de digitacao acima do teclado: card, caret piscando, cauda
    // visivel e placeholder quando vazio
    line: function (placeholder) {
        var T = A.T || System.theme();
        var y = A.input._top - 36;
        UI.card(6, y, 228, 30, { radius: 15, stroke: true });
        var s = System.keypadText() || '';
        var cur = (Math.floor(System.millis() / 500) % 2) ? '_' : ' ';
        var shown = s;
        while (shown.length && UI.measure(shown + '_', 'body') > 200) shown = shown.substring(1);
        if (s.length || cur === '_') {
            UI.text(shown + cur, 18, y + 7, { color: s.length ? T.text : T.textDim, id: 1 });
        } else {
            UI.text(placeholder || 'Mensagem', 18, y + 7, { color: T.textDim, id: 1 });
        }
        UI.cardEnd();
    },

    // chips da faixa (setar no open) e o dreno do toque neles
    chips: function (labels) {
        if (typeof System.topbarButtons === 'function') System.topbarButtons(labels);
    },
    chip: function () {
        if (typeof System.topbarPop !== 'function') return null;
        try { return System.topbarPop(); } catch (e) { return null; }
    },

    close: function () {
        A.input._kb = false;
        try { if (System.keypadClose) System.keypadClose(); } catch (e) { /* ja fechado */ }
    }
};

A._mods.push('input');

module.exports = A;
