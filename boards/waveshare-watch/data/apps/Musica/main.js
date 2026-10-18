// Musica — controle do player do celular (Phone Link/Gadgetbridge) no CelerKit.
// ES5 puro (Duktape). Phone.musicInfo() traz faixa/estado; Phone.music(cmd)
// manda play/pause/next/previous/volume. O loop e o header vem do core
// (A.run); os botoes sao os nativos do toolkit (UI.button, eles mesmos
// hit-testam todo frame e so desenham quando precisa) e o texto que chega
// do celular passa pelo celeros.app.text (fora do Latin-1 some).

var A = require("celeros.app");
require("celeros.app.text");
A.init();

var M = 12;
var HAS = typeof Phone !== "undefined" && Phone && typeof Phone.music === "function";

function ctext(s, y, f, col) {
    System.setTextColor(col);
    System.drawString(s, Math.round((240 - System.textWidth(s, f)) / 2), y, f);
}

// faixa/artista/album: UI.text corta com ".." na largura dada (fim do
// truncate caseiro); os botoes ficam numa grade 3 + 2
var PREV = [M, 192, 64, 52], PLAY = [88, 192, 64, 52], NEXT = [228 - M - 64, 192, 64, 52];
var VDN = [M, 258, 104, 40], VUP = [228 - M - 104, 258, 104, 40];

var last = "";
var st = { connected: false }, mi = null;

// os botoes hit-testam E desenham (so quando precisa); o toque devolve o cmd
function botoes(playing) {
    var r = "";
    if (UI.button("<<", PREV[0], PREV[1], PREV[2], PREV[3], { style: "ghost" })) r = "previous";
    else if (UI.button(playing ? "||" : ">", PLAY[0], PLAY[1], PLAY[2], PLAY[3], {})) r = "playpause";
    else if (UI.button(">>", NEXT[0], NEXT[1], NEXT[2], NEXT[3], { style: "ghost" })) r = "next";
    else if (UI.button("Vol -", VDN[0], VDN[1], VDN[2], VDN[3], { style: "ghost" })) r = "volumedown";
    else if (UI.button("Vol +", VUP[0], VUP[1], VUP[2], VUP[3], { style: "ghost" })) r = "volumeup";
    return r;
}

A.run({
    main: function (c) {
        if (A.header("Música")) return A.BACK;
        if (A.every(200, "mi")) {
            st = HAS ? Phone.status() : { connected: false };
            mi = HAS ? Phone.musicInfo() : null;
            var sig = JSON.stringify(st) + JSON.stringify(mi);
            if (sig !== last) { last = sig; UI.invalidate(); }
        }
        if (!HAS) {
            if (c.full) ctext("Sem Phone Link nesta placa", 150, 2, A.T.warn);
        } else if (!st.connected) {
            if (c.full) {
                ctext("Celular desconectado", 120, 2, A.T.textDim);
                ctext("Pareie no Gadgetbridge", 148, 1, A.T.textDim);
                ctext("(adicionar como Bangle.js)", 166, 1, A.T.textDim);
            }
        } else {
            // texto que veio do celular: saneia antes de desenhar
            UI.text(A.text.fit(mi && mi.track ? mi.track : "Nada tocando"), 120, 88,
                { align: "center", w: 224, role: "title" });
            UI.text(A.text.fit(mi && mi.artist ? mi.artist : ""), 120, 122,
                { align: "center", w: 224, color: A.T.textDim });
            UI.text(A.text.fit(mi && mi.album ? mi.album : ""), 120, 148,
                { align: "center", w: 224, role: "caption", color: A.T.stroke });
            var cmdr = botoes(mi && mi.state === "play");
            if (cmdr) {
                Phone.music(cmdr);
                if (System.beep) System.beep(1500, 20);
            }
        }
    }
}, "main", { fps: 5 });
