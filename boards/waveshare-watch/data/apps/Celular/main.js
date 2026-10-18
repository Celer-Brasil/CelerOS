// Celular — o link com o Gadgetbridge (Phone Link) no CelerKit.
// ES5 puro (Duktape). Mostra o estado, o codigo de pareamento (grande) e
// as acoes: ligar/desligar, achar celular, esquecer o pareamento.
// O loop e o header vem do core (A.run); os botoes sao os nativos do
// toolkit (UI.button) — o indicador de estado e o codigo sao conteudo proprio.

var A = require("celeros.app");
A.init();

var INFO = {};
try { INFO = System.getInfo() || {}; } catch (e) { INFO = {}; }
var M = 12 + Math.round((INFO.inset || 0) / 2);
var HAS = typeof Phone !== "undefined" && Phone && typeof Phone.status === "function";

function ctext(s, y, f, col) {
    System.setTextColor(col);
    System.drawString(s, Math.round((240 - System.textWidth(s, f)) / 2), y, f);
}
function pad6(n) { var s = String(n); while (s.length < 6) s = "0" + s; return s; }

var W = 240 - 2 * M;
var B1 = [M, 176, W, 36], B2 = [M, 220, W, 36], B3 = [M, 264, W, 36];
var finding = false, confirmForget = false;
var last = "";

function draw(st) {
    if (!HAS) { ctext("Sem Phone Link nesta placa", 150, 2, A.T.warn); return; }
    if (st.passkey) {
        ctext("Código", 90, 2, A.T.textDim);
        ctext(pad6(st.passkey), 140, 4, A.T.text);
        ctext("digite no celular", 210, 1, A.T.textDim);
        return;
    }
    var stTxt = !st.enabled ? "Desligado" : st.connected ? "Conectado" : "Aguardando celular";
    System.fillCircle(M + 8, 64, 5, !st.enabled ? A.T.stroke : st.connected ? A.T.ok : A.T.warn);
    System.setTextColor(A.T.text);
    System.drawString(stTxt, M + 20, 56, 2);
    if (st.enabled && !st.connected) {
        System.setTextColor(A.T.textDim);
        System.drawString("Gadgetbridge > + > Bangle.js", M, 96, 1);
        System.drawString("aparece como:", M, 114, 1);
        System.setTextColor(A.T.accent);
        System.drawString(st.name || "", M, 130, 2);
    } else if (st.connected) {
        System.setTextColor(A.T.textDim);
        System.drawString("Notificações, hora, música,", M, 96, 1);
        System.drawString("clima e chamadas chegam aqui.", M, 112, 1);
    }
}

A.run({
    main: function (c) {
        if (A.header("Celular")) return A.BACK;
        var st = HAS ? Phone.status() : null;
        if (A.every(200, "st")) {
            var sig = JSON.stringify(st) + finding + confirmForget;
            if (sig !== last) { last = sig; UI.invalidate(); }
        }
        if (HAS && st) {
            draw(st);
            if (!st.passkey) {
                if (UI.button(st.enabled ? "Desligar" : "Ligar", B1[0], B1[1], B1[2], B1[3],
                        { style: st.enabled ? "ghost" : "primary" })) {
                    Phone.setEnabled(!st.enabled);
                    confirmForget = false;
                    UI.invalidate();
                }
                if (st.connected && UI.button(finding ? "Parar de tocar" : "Achar celular",
                        B2[0], B2[1], B2[2], B2[3],
                        finding ? { color: A.T.warn, textColor: A.T.text } : { style: "ghost" })) {
                    finding = !finding;
                    Phone.find(finding);
                    UI.invalidate();
                }
                // fonte caption: o rotulo longo cabe sem cortar
                if (UI.button(confirmForget ? "Confirmar: esquecer" : "Esquecer pareamento",
                        B3[0], B3[1], B3[2], B3[3],
                        { style: confirmForget ? "danger" : "ghost", role: "caption" })) {
                    if (!confirmForget) { confirmForget = true; UI.invalidate(); }
                    else {
                        confirmForget = false;
                        Phone.forget();
                        A.toast("Esqueça o relógio no Android também");
                    }
                }
            }
        } else {
            draw(st || {});
        }
        // toque fora dos botoes desfaz o braco de confirmacao
        var t = UI.touch();
        if (t.tap) confirmForget = false;
    }
}, "main", { fps: 5 });
