// Coral — orquestra de aparelhos pela malha CelerNet (API 27). Abra o Coral
// em varios CelerOS com alto-falante; quem toca "Reger" vira maestro: as
// vozes da musica (melodia, harmonia, baixo, bateria) viram INSTRUMENTOS
// divididos entre os musicos e todo mundo entra JUNTO — o "ja!" sai com uma
// contagem e cada musico desconta o tempo que a mensagem levou pelos saltos
// da malha. Cada aparelho toca so a sua parte: a musica inteira so existe na
// sala.
//
// CelerKit UI 2.0: header com acoes, segmented de arranjos, card de sessao
// (estado, maestro, anel de progresso e equalizador), lista rica de musicos
// com o instrumento de cada um e botao de acao. Roda na CYD (sem BT): o gate
// explica e o app nao chama nada de malha.
//
// O protocolo no ar NAO mudou (compativel com Coral 1.0..1.2.0); um quadro
// cada:
//   ch<1|0>                      musico presente (com/sem alto-falante), 3 s
//   ca<sessao>.<musica>.<vozes>  sua parte (unicast, urgente; vozes = bits)
//   cg<sessao>.<ms>              ja! a musica comeca daqui a <ms> (2 vias)
//   cx<sessao>                   parar

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.list");
require("celeros.app.caps");
require("celeros.app.mesh");

A.init();
A.style.preset("soft");
A.mesh.family("c");

var T = A.style.T;
var LEAD = 3500;                 // contagem ate a entrada
// latencia estimada por salto de 1 quadro (fila + jitter do relay); calibre
// com o RTT/2 do app Sonar se a sua casa tiver muitos saltos
var HOP0 = 150, HOPN = 280;
var VOICES = ["melodia", "harmonia", "baixo", "bateria"];
var ICONS = ["star", "heart", "dot", "play"];

var SONGS = [
    { name: "Ciranda", bpm: 112, loops: 2, tracks: [
        { wave: "sq", vol: 80, notes: [[60,2],[62,2],[64,2],[65,2],[67,4],[67,4],[69,2],[69,2],[69,2],[69,2],[67,8],
                                       [65,2],[65,2],[65,2],[65,2],[64,4],[64,4],[62,2],[62,2],[62,2],[62,2],[60,8]] },
        { wave: "sq25", vol: 55, notes: [[64,8],[62,8],[65,8],[64,8],[62,8],[60,8],[59,8],[60,8]] },
        { wave: "tri", vol: 90, notes: [[48,8],[43,8],[45,8],[43,8],[41,8],[48,8],[43,8],[48,8]] },
        { drum: true, vol: 85, notes: [[36,4],[42,4],[38,4],[42,4],[36,4],[42,4],[38,4],[42,4],
                                       [36,4],[42,4],[38,4],[42,4],[36,4],[42,4],[38,4],[42,4]] }
    ] },
    { name: "Pulo do Gato", bpm: 140, loops: 3, tracks: [
        { wave: "sq", vol: 80, notes: [[69,2],[72,2],[76,4],[74,2],[72,2],[71,4],[69,2],[71,2],[72,2],[74,2],[76,8],
                                       [77,2],[76,2],[74,4],[72,2],[71,2],[69,4],[68,2],[69,2],[71,2],[68,2],[69,8]] },
        { wave: "sq25", vol: 55, notes: [[60,8],[59,8],[57,8],[64,8],[60,8],[59,8],[56,8],[57,8]] },
        { wave: "tri", vol: 90, notes: [[45,4],[45,4],[52,4],[45,4],[50,4],[50,4],[52,4],[52,4],
                                        [45,4],[45,4],[52,4],[45,4],[52,4],[52,4],[45,8]] },
        { drum: true, vol: 85, notes: [[36,2],[42,2],[38,2],[42,2],[36,2],[42,2],[38,2],[42,2],
                                       [36,2],[42,2],[38,2],[42,2],[36,2],[42,2],[38,2],[42,2],
                                       [36,2],[42,2],[38,2],[42,2],[36,2],[42,2],[38,2],[42,2],
                                       [36,2],[42,2],[38,2],[42,2],[36,2],[42,2],[38,2],[42,2]] }
    ] }
];

var me = null;
var songSel = 0;
var musos = {};                  // id -> {name, speaker, at}
var sess = 0;                    // sessao corrente (a que estou tocando/esperando)
var part = null;                 // {song, bits} minha parte na sessao
var startAt = 0;                 // relogio local da entrada (0 = nada agendado)
var playing = false;
var maestro = "";                // nome de quem rege a sessao
var lineup = [];                 // (maestro) [{id, name, bits}]
var goResend = 0;
var goResend2 = false;
var frameNow = 0;                // relogio do quadro corrente (os handlers usam)
var caps = A.caps.probe();
var lastSig = {};                // assinaturas do desenho base (sem UI.custom)
var selM = null;                 // musico aberto no sheet de detalhe (id)
var sheetOpen = false;
var sheetJust = false;           // abriu neste quadro: o toque nao fecha

// desenho animado: usa o redesenho parcial quando a placa tem (S3) e cai no
// frame total + assinatura na CYD/hub antigo. draw pinta TUDO na area.
function custom(id, x, y, w, h, sig, full, draw) {
    if (A.custom && A.style && A.style.custom) { A.style.custom(id, x, y, w, h, sig, draw); return; }
    if (lastSig[id] !== sig) { lastSig[id] = sig; UI.invalidate(); }
    if (full) draw(x, y, w, h);
}

function bitsText(bits) {
    var v = [];
    for (var i = 0; i < VOICES.length; i++) if (bits & (1 << i)) v.push(VOICES[i]);
    return v.length ? v.join(" + ") : "ouvinte";
}
function voiceIcon(bits) {
    for (var i = 0; i < VOICES.length; i++) if (bits & (1 << i)) return ICONS[i];
    return "dot";
}
function present(now) {
    var out = [];
    for (var id in musos) {
        if (musos.hasOwnProperty(id) && musos[id].speaker && now - musos[id].at < 10000) out.push(id);
    }
    return out;
}
function presentCount(now) {
    var n = 0;
    for (var id in musos) {
        if (musos.hasOwnProperty(id) && musos[id].speaker && now - musos[id].at < 10000) n++;
    }
    return n;
}
function mixStr(h, s) {
    s = String(s);
    for (var i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
    return h;
}
function loopMs(s) {
    var tot = 0;
    for (var n = 0; n < s.tracks[0].notes.length; n++) tot += s.tracks[0].notes[n][1];
    return tot * 15000 / s.bpm;
}

function conduct(now) {
    sess = 1 + Math.floor(Math.random() * 98);
    var ids = present(now);
    if (me.caps.speaker) ids.push(me.id);
    ids.sort();
    if (!ids.length) { UI.toast("Ninguém com alto-falante"); return; }
    var bits = {};
    for (var v = 0; v < VOICES.length; v++) {
        var who = ids[v % ids.length];
        bits[who] = (bits[who] || 0) | (1 << v);
    }
    lineup = [];
    for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        lineup.push({ id: id, name: id === me.id ? "Você" : musos[id].name, bits: bits[id] });
        if (id !== me.id) A.mesh.send(id, "a", sess + "." + songSel + "." + bits[id], { urgent: true });
    }
    // a contagem so sai depois das partes (o "ja!" leva ~1,5 s para cruzar)
    maestro = "Você";
    part = { song: songSel, bits: bits[me.id] || 0 };
    goResend = now + 1800;
    startAt = now + 1800 + LEAD;
    UI.invalidate();
}

function go(now) {
    var left = startAt - now;
    if (left > 200) A.mesh.send(null, "g", sess + "." + left, { ttl: 8 });
}

function stopAll() {
    A.mesh.send(null, "x", "" + sess, { ttl: 8 });
    stopLocal();
}
function stopLocal() {
    if (playing) System.musicStop();
    playing = false;
    startAt = 0;
    part = null;
    lineup = [];
    UI.invalidate();
}

function begin() {
    startAt = 0;
    if (!part || !part.bits) return;     // maestro sem alto-falante so rege
    var s = SONGS[part.song];
    var tr = [];
    for (var i = 0; i < s.tracks.length; i++) if (part.bits & (1 << i)) tr.push(s.tracks[i]);
    playing = System.playMusic({ bpm: s.bpm, loops: s.loops, tracks: tr });
    if (!playing) UI.toast("Alto-falante ocupado");
    UI.invalidate();
}

// handler do A.mesh.each: (de, op, resto, quadro). op "" = familia alheia.
function onMesh(from, op, rest, m) {
    if (!op) return;
    var a = rest.split(".");
    if (op === "h") {
        if (!musos[from]) UI.invalidate();
        musos[from] = { name: m.fromName || from, speaker: a[0] === "1", at: frameNow };
    } else if (op === "a") {
        var ns = parseInt(a[0], 10);
        if (ns === sess && part) return;                     // copia
        if (playing) System.musicStop();
        playing = false;
        sess = ns;
        part = { song: parseInt(a[1], 10) % SONGS.length, bits: parseInt(a[2], 10) };
        maestro = m.fromName || from;
        startAt = 0;
        UI.invalidate();
    } else if (op === "g") {
        if (parseInt(a[0], 10) !== sess || startAt || playing) return;   // 2a via ou sessao alheia
        var hops = Math.max(1, m.hops);
        startAt = frameNow + parseInt(a[1], 10) - (HOP0 + (hops - 1) * HOPN);
        UI.invalidate();
    } else if (op === "x") {
        if (parseInt(a[0], 10) === sess) stopLocal();
    }
}

// ---- portao da malha (2.0) -------------------------------------------------
// Mantem o contrato do celeros.mesh.gate: card + botao "Ligar a malha" na
// mesma area (o harness e a bancada tocam ali) e o aviso de placa sem BT.
function gate(full) {
    if (typeof CelerNet === "undefined" || typeof Pack === "undefined") {
        A.style.card(10, 56, 220, 108, { full: full, draw: function (r) {
            UI.text("Esta placa não tem Bluetooth no firmware.", r.x, r.y,
                    { w: r.w, lines: 2, role: "body", color: T.text, bg: r.bg });
            UI.text("A orquestra precisa da malha CelerNet (app Matilha).",
                    r.x, r.y + 30, { w: r.w, lines: 3, role: "caption", color: T.textDim, bg: r.bg });
        }});
        return false;
    }
    if (CelerNet.status().active) return true;
    A.style.card(10, 56, 220, 96, { full: full, draw: function (r) {
        UI.text("Ligue a malha (app Matilha) para tocar junto com os aparelhos ao redor.",
                r.x, r.y, { w: r.w, lines: 4, role: "body", color: T.text, bg: r.bg });
    }});
    if (A.widgets.button("Ligar a malha", 10, 168, 220, 36,
                         { icon: "wifi", bg: T.accent, textColor: T.onAccent })) {
        if (!CelerNet.start({})) UI.toast("Sem RAM para o rádio agora");
    }
    return false;
}

// ---- linhas da lista -------------------------------------------------------
function buildRows(c) {
    var now = c.now;
    var items = [];
    if (lineup.length) {
        for (var i = 0; i < lineup.length; i++) {
            var l = lineup[i];
            items.push({ label: l.name, sub: bitsText(l.bits), icon: voiceIcon(l.bits),
                         id: l.id,
                         right: l.id === me.id ? "você" : undefined,
                         rightColor: T.accent });
        }
    } else {
        var ids = present(now);
        if (me.caps.speaker) items.push({ label: "Você", sub: "músico", icon: "dot", id: me.id, right: "aqui" });
        for (var k = 0; k < ids.length; k++) {
            items.push({ label: musos[ids[k]].name, sub: "músico", icon: "dot", id: ids[k] });
        }
        if (part) items.unshift({ label: "Você", sub: bitsText(part.bits),
                                  icon: voiceIcon(part.bits), id: me.id,
                                  right: "sua voz", rightColor: T.accent });
    }
    if (!items.length) items.push({ label: "Esperando músicos", sub: "abra o Coral em outros aparelhos",
                                    icon: "dot", disabled: true });
    return items;
}

// carimbo barato (numero, sem alocar): a lista so muda quando a roda/sessao
// muda ou um musico entra/sai da janela de presenca
function rowsStamp(now) {
    var h = 5381;
    h = h * 7 + (me.caps.speaker ? 1 : 0);
    if (part) {
        h = h * 7 + part.bits;
        h = mixStr(h, maestro);
    }
    if (lineup.length) {
        h = h * 7 + 1;
        for (var i = 0; i < lineup.length; i++) {
            h = mixStr(h, lineup[i].id);
            h = mixStr(h, lineup[i].name);
            h = h * 7 + lineup[i].bits;
        }
    } else {
        for (var id in musos) {
            if (!musos.hasOwnProperty(id) || !musos[id].speaker || now - musos[id].at >= 10000) continue;
            h = mixStr(h, id);
            h = mixStr(h, musos[id].name);
            h = h * 7 + 1;
        }
    }
    return h;
}
var musoList = A.list.make(function () { return rowsStamp(System.millis()); },
                           function () { return buildRows({ now: System.millis() }); });

// ---- app -----------------------------------------------------------------
A.run({
    main: function (c) {
        var h = A.widgets.header("Coral", { full: c.full, actions: [{ icon: "info", id: "sobre" }] });
        if (h.back) {
            if (playing) System.musicStop();   // sai sem deixar a musica presa
            return A.BACK;
        }
        if (h.action === "sobre") return "ajuda";

        if (!gate(c.full)) return;

        me = A.mesh.me();
        var now = c.now;
        frameNow = now;
        A.mesh.each(onMesh);
        if (A.every(3000, "hello")) A.mesh.send(null, "h", me.caps.speaker ? "1" : "0", { ttl: 8 });
        // "ja!" em duas vias espacadas: a segunda cobre a primeira perdida
        if (goResend && now >= goResend) { goResend = goResend2 ? 0 : now + 700; go(now); goResend2 = !goResend2; }
        if (startAt && now >= startAt) begin();
        if (playing && !System.musicPlaying()) { playing = false; part = null; UI.invalidate(); }

        var busy = playing || startAt > 0;
        var ns = A.widgets.segmented(8, 44, 224, 30, [SONGS[0].name, SONGS[1].name], songSel);
        if (ns !== songSel && !busy) { songSel = ns; UI.invalidate(); }

        // card da sessao: estado, maestro e o anel/equalizador
        var st, sub;
        var frac = 0;
        if (startAt) {
            var left = Math.max(0, startAt - now);
            st = "Entrada em " + Math.ceil(left / 1000) + " s";
            sub = maestro + " rege · prepare o instrumento";
            frac = 1 - left / LEAD;
        } else if (playing) {
            st = "Tocando: " + bitsText(part ? part.bits : 0);
            var nm = lineup.length ? lineup.length : 1;
            sub = SONGS[part.song].name + " · " + nm + (nm === 1 ? " músico" : " músicos");
            var s = SONGS[part.song];
            frac = Math.min(1, System.musicPos() / (loopMs(s) * s.loops));
        } else if (part && !part.bits) {
            st = "Ouvindo " + maestro;
            sub = "você não tem voz nesta sessão";
        } else if (part) {
            st = "Sua voz: " + bitsText(part.bits);
            sub = maestro ? maestro + " rege" : "aguardando a contagem";
        } else {
            st = "Pronto para reger";
            var nmus = presentCount(now) + (me.caps.speaker ? 1 : 0);
            sub = nmus + (nmus === 1 ? " músico na sala" : " músicos na sala");
        }
        A.style.card(8, 80, 224, 104, { full: c.full, draw: function (r) {
            UI.text(st, r.x, r.y, { role: "title", color: T.text, bg: r.bg, w: 138, lines: 2, id: "st" });
            UI.text(sub, r.x, r.y + 40, { role: "caption", color: T.textDim, bg: r.bg,
                                          w: 138, lines: 2, id: "sub" });
            var sig = playing ? "p" + Math.floor(System.musicPos() / 120)
                              : startAt ? "e" + Math.floor((startAt - now) / 120) : "i" + (part ? 1 : 0);
            custom("eq", r.x, r.y + 72, 132, 20, sig, c.full, function (x, y, w2, h2) {
                var n = 9, bw = 6, gap = Math.floor((w2 - n * bw) / (n - 1));
                var ph = playing ? Math.floor(System.musicPos() / 90) : Math.floor((startAt ? startAt - now : now) / 180);
                for (var i = 0; i < n; i++) {
                    var amp = playing ? (0.25 + 0.75 * Math.abs(Math.sin((ph + i) * 0.7)))
                                      : (part ? 0.35 : 0.15 + 0.1 * (i % 3));
                    var bh = Math.max(3, Math.round(h2 * amp));
                    System.fillRect(x + i * (bw + gap), y + h2 - bh, bw, bh,
                                    i % 2 ? T.accentD : T.accent);
                }
            });
            if (frac > 0.001) A.widgets.ring(194, r.y + 40, 26, frac, { th: 5,
                bg: T.raised, color: T.accent, label: Math.round(frac * 100) + "%",
                textColor: T.text });
            else A.icons.draw("play", 182, r.y + 28, 24, { color: T.textDim });
        }});

        var rows = musoList.rows();
        var li = A.list.view("musos", 8, 190, 224, 88, rows,
                             { row: 28, panel: true, rowR: 6 });
        if (!sheetOpen && li >= 0 && rows[li] && !rows[li].disabled) {
            selM = rows[li].id || null;
            sheetOpen = true;
            sheetJust = true;
            UI.invalidate();
        }

        // sheet de detalhe do músico (2.0): instrumento, papel e sinal
        if (sheetJust) sheetJust = false;
        else {
            // full:false de proposito: o veu do sheet cobre os slots do
            // header/lista (eles nao redesenham no parcial) — o card sobe
            // sem escurecer o resto, que continua legivel e clicavel
            var sh = A.widgets.sheet("muso", { open: sheetOpen, full: false, h: 150,
                                               title: "Músico" }, function (r) {
                if (!selM) {
                    UI.text("Músico", r.x, r.y, { role: "caption", bg: r.bg, w: r.w });
                    return;
                }
                var nm2 = selM === me.id ? "Você" : (musos[selM] ? musos[selM].name : selM);
                var bits = 0;
                for (var i = 0; i < lineup.length; i++) if (lineup[i].id === selM) bits = lineup[i].bits;
                UI.text(nm2, r.x, r.y, { role: "title", bg: r.bg, w: r.w });
                UI.text(bitsText(bits), r.x, r.y + 24,
                        { role: "caption", color: T.textDim, bg: r.bg, w: r.w });
                UI.text("ID " + selM, r.x, r.y + 46,
                        { role: "caption", color: T.textDim, bg: r.bg, w: r.w });
            });
            if (sh === "close") { sheetOpen = false; UI.invalidate(); }
        }

        var label = busy ? "Parar" : "Reger " + SONGS[songSel].name;
        if (!sheetOpen) {
            if (A.style.button(label, 8, 280, 224, 32,
                               busy ? { icon: "close", bg: T.err, textColor: 0xFFFF }
                                    : { icon: "play", bg: T.accent, textColor: T.onAccent })) {
                if (busy) stopAll();
                else conduct(now);
            }
        } else {
            A.style.card(8, 280, 224, 32, { full: c.full, draw: function (r) {
                UI.text("Toque fora do músico para voltar", r.x, r.y + 2,
                        { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            }});
        }
    },
    ajuda: function (c) {
        var h = A.widgets.header("Como tocar", { full: c.full });
        if (h.back) return A.BACK;
        A.style.card(8, 48, 224, 250, { full: c.full, draw: function (r) {
            UI.text("1. Abra o Coral nos aparelhos com alto-falante.", r.x, r.y,
                    { w: r.w, lines: 2, bg: r.bg });
            UI.text("2. Escolha o arranjo e toque Reger em um deles.", r.x, r.y + 40,
                    { w: r.w, lines: 2, bg: r.bg });
            UI.text("3. As quatro vozes viram instrumentos divididos entre os músicos.",
                    r.x, r.y + 80, { w: r.w, lines: 3, role: "caption", color: T.textDim, bg: r.bg });
            UI.text("4. A contagem desconta a latência dos saltos: todos entram juntos.",
                    r.x, r.y + 120, { w: r.w, lines: 3, role: "caption", color: T.textDim, bg: r.bg });
            UI.text("Cada aparelho toca só a sua parte: a música inteira só existe na sala.",
                    r.x, r.y + 170, { w: r.w, lines: 4, role: "caption", color: T.accent, bg: r.bg });
        }});
    }
}, "main");
