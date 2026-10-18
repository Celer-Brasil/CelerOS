// Celer Remote — controle remoto via Celer Link (Bluetooth), sobre o
// CelerKit (deps celeros.app.*): o laco de frames e a pilha de telas sao do
// A.run (celeros.app) — scan / D-pad / WiFi do robo / truques / afino sao
// telas na pilha, e as esperas usam o overlay A.busy; as barras de RSSI sao
// do celeros.app.list (A.list.bars, a curva que nasceu aqui) e as linhas da
// lista de pares ficam cacheadas por carimbo (A.list.make). O D-pad em si
// continua desenhado a mao (circulo + setas suavizadas).
//
// Pareamento (API 11): robo com {pairing:true} mostra um codigo de 6
// digitos na tela dele — o Remote pede o codigo via System.prompt e verifica
// no firmware. Robo memoriza controles pareados: reconexao cai direto no
// D-pad sem pedir nada.
//
// Seguranca do robo: segurar uma seta repete o move a cada 250 ms (o robo
// para sozinho se a repeticao some) e soltar manda stop. Se o link cai, o
// app tenta reconectar no mesmo par antes de voltar para a lista.
//
// Mensagens JSON: {type:"move",dir} / {type:"stop"}; o lado do robo
// responde com {type:"tel",...}.

var A = require("celeros.app");
require("celeros.app.list");

A.init();
var T = A.T;
var W = 240;
var LX = A.L.x, LW = A.L.w;

var peers = [];
var target = null;      // par conectado (para reconectar)
var tel = null;
var ctrlVisivel = false; // false quando o fluxo deixou o D-pad (pareamento cancelou)

var REPEAT_MS = 250;    // repeticao do move (o robo tem keepalive de ~900 ms)
var RECONNECT_TRIES = 3;

// ---- helpers ----------------------------------------------------------------
// Avisos da tela de controle (say do cao, truque, IP do WiFi): fila mostrada
// numa linha sob o status — um por vez, cada um pelo seu tempo; sobrevivem
// aos redesenhos da telemetria
var notes = [], noteUntil = 0;
function note(msg, ms) {
    notes.push({ t: msg, ms: ms || 6000 });
    if (notes.length > 4) notes.shift();
    if (notes.length === 1) noteUntil = System.millis() + notes[0].ms;
}
function curNote() {
    while (notes.length && System.millis() >= noteUntil) {
        notes.shift();
        if (notes.length) noteUntil = System.millis() + notes[0].ms;
    }
    return notes.length ? notes[0].t : "";
}
function inR(t, r) { return t.x >= r[0] && t.x < r[0] + r[2] && t.y >= r[1] && t.y < r[1] + r[3]; }

// Espera com o overlay do kit (A.busy). GAP DE MODULO: A.busy so aceita a
// mensagem do header (sem linha de detalhe), e o frame que ele abre/fecha
// apaga a tela — entao todo spin() pede frame cheio e a tela que chamou so
// volta a desenhar no frame seguinte.
function spin(msg) {
    A.busy(msg);
    UI.invalidate();
}

// Esvazia a fila do link: telemetria nova, respostas do cao (say) e, se
// pedido, devolve a primeira mensagem do tipo `want`. Ecos do afino
// ({type:"hop"} / {type:"stance"}) alimentam o painel de afino.
var lastHop = null, lastStance = null;
function pollLink(want) {
    for (var k = 0; k < 8; k++) {
        var m = CelerLink.poll();
        if (m === null) break;
        var v = null;
        try { v = JSON.parse(m); } catch (e) {}
        if (!v) continue;
        if (v.type === "tel") tel = v;
        else if (v.type === "say") note("cão: " + String(v.text || "").substring(0, 60), 6000);
        else if (v.type === "hop") lastHop = v;
        else if (v.type === "stance") lastStance = v;
        if (want && v.type === want) return v;
    }
    return null;
}

// Espera uma mensagem do tipo pedido (a telemetria segue atualizando)
function waitMsg(type, ms) {
    var t0 = System.millis();
    while (System.millis() - t0 < ms) {
        var v = pollLink(type);
        if (v) return v;
        if (!CelerLink.status().connected) return null;
        System.delay(50);
    }
    return null;
}

// ---- lista de pares (celeros.app.list) ---------------------------------------
// Linhas reconstruidas so quando o scan muda (carimbo = tamanho + 1o par);
// as barras de sinal sao a curva de RSSI do proprio kit
var peerRows = A.list.make(
    function () {
        return peers.length + ":" + (peers.length ? peers[0].id + peers[0].rssi : "");
    },
    function () {
        var rows = [];
        for (var i = 0; i < peers.length; i++) {
            rows.push({ label: peers[i].name || "(sem nome)", sub: peers[i].id,
                        right: peers[i].rssi + " dBm", bars: A.list.bars(peers[i].rssi) });
        }
        return rows;
    }
);

function doScan() {
    spin("procurando CelerOS por perto...");
    peers = CelerLink.scan(3000);
    // o firmware ja ordena por RSSI; ordena de novo por garantia (fw antigo).
    // Sort numerico: A.list.sort e por chave de string, nao serve aqui.
    peers.sort(function (a, b) { return b.rssi - a.rssi; });
    peerRows.drop();
    UI.resetScroll("peers");
    UI.invalidate();
}

// ---- tela de scan --------------------------------------------------------------
function scanFrame(c) {
    UI.header("Celer Remote", { sub: peers.length ? peers.length + " por perto" : "" });
    if (peers.length === 0) {
        UI.card(LX, 56, LW, 120);
        UI.text("Nenhum CelerOS por perto", 120, 76, { role: "title", align: "center", color: T.textDim, w: LW - 16 });
        UI.text("Ligue o robô (ou outro aparelho com Celer Link) e procure de novo.", 120, 116,
                { role: "caption", align: "center", color: T.textDim, w: LW - 24, lines: 3 });
        UI.cardEnd();
    } else {
        var k = UI.list("peers", LX, 48, LW, 214, peerRows.rows(), { rowH: 48 });
        if (k >= 0) return connectTo(peers[k]) ? "ctrl" : undefined;
    }
    if (UI.button("Procurar de novo", LX, 272, LW, 40, { style: peers.length ? "ghost" : "primary" })) {
        doScan();                     // spin dentro; nada mais desenha no frame
    }
}

function connectTo(p) {
    spin("conectando " + (p.name || p.id) + "...");
    if (!CelerLink.connect(p.id, 5000)) {
        UI.toast("falha ao conectar: " + (p.name || p.id), 4000);
        UI.invalidate();
        return false;
    }
    if (!afterConnect(p)) return false;   // pareamento cancelado: leaveLink ja avisou
    enterCtrl(p, "pareado!");
    return true;
}

// ---- pareamento ------------------------------------------------------------------
// Robo com pareamento (status().pairing): pede o codigo ao usuario e verifica
// no firmware. "ok"/"cancel"/"fail" — em cancel/fail a sessao ja voltou pro
// scan (o robo derruba sozinho em 3 erros ou 60 s sem digitar).
//
// O card de instrucao e pintado no frame aberto (widgets diretos, sem
// UI.begin) antes de cada prompt: o dialogo do teclado abre por cima e, ao
// voltar, o erro da tentativa entra no lugar do subtitulo. O prompt e
// direto (fora do A.form.askText) porque o card mistura o fluxo de
// pareamento com o resultado da tentativa.
function pairCard(name, err) {
    UI.card(20, 80, 200, 150);
    UI.text("Digite o código", 120, 96, { role: "title", align: "center" });
    UI.text("código na tela do robô", 120, 128, { align: "center", color: T.accent });
    UI.text("6 dígitos, válido por 60 s", 120, 156, { role: "caption", align: "center", color: T.textDim });
    UI.cardEnd();
    UI.text(name || "robô", 120, 60, { role: "caption", align: "center", color: T.textDim });
    if (err) UI.text(err, 120, 186, { align: "center", color: T.err, w: LW });
}
function ensurePairing(name) {
    var err = null;
    for (var wrong = 0; wrong < 3; ) {
        pairCard(name, err);
        var c = System.prompt("codigo do robo (6 digitos)", "", { hint: "num" });
        if (!c) {
            leaveLink("pareamento cancelado");
            return "cancel";
        }
        if (!/^[0-9]{6}$/.test(c)) { err = "só números, 6 dígitos"; continue; }
        if (CelerLink.verify(c)) return "ok";
        wrong++;
        err = "código errado (" + wrong + "/3)";
    }
    leaveLink("código errado 3x");
    return "fail";
}

// Pos-conexao (novo ou reconexao): peer com pareamento pede codigo antes
// do D-pad. true = link pronto para controlar.
function afterConnect(p) {
    if (!CelerLink.status().pairing) return true;
    return ensurePairing(p && (p.name || p.id)) === "ok";
}

// ---- tela de controle (D-pad) -------------------------------------------------
// D-pad: [x, y, w, h, dir] — areas de toque (o desenho e o circulo por cima)
var CX = 120, CY = 168, PR = 80;
var PAD = [
    [88, 92, 64, 50, "up"],
    [88, 196, 64, 50, "down"],
    [36, 140, 54, 56, "left"],
    [150, 140, 54, 56, "right"],
    [94, 144, 52, 48, "stop"]
];
var STOP_IDX = 4;
var MODE_BTN = [LX, 256, 92, 30];
var TRICK_BTN = [LX + 96, 256, 62, 30];
var TUNE_BTN = [LX + 162, 256, 70, 30];
var WIFI_BTN = [W - 62, 4, 56, 32];
var held = -1;
var padDrawn = -2;      // seta desenhada por ultimo (-2 = redesenhar)
var lastSend = 0;
var chromeSig = "";     // muda quando botoes aparecem/somem (tel.modes/tricks/wifi)

function wifiAvailable() {
    return !!(tel && tel.wifi && typeof CelerLink.sendSealed === "function");
}
function hasModes() { return !!(tel && tel.mode && tel.modes && tel.modes.length > 1); }
function hasTricks() { return !!(tel && tel.tricks && tel.tricks.length); }
function hasTune() { return !!(tel && tel.tune); }

// Desenho proprio do D-pad: so quando a seta segurada muda ou frame total
function drawPad(full) {
    if (!full && padDrawn === held) return;
    padDrawn = held;
    System.fillSmoothCircle(CX, CY, PR, T.card);
    System.fillSmoothCircle(CX, CY, PR - 2, T.raised);
    var a = 16;  // meia largura da seta
    var tris = [
        [CX, CY - 64, CX - a, CY - 40, CX + a, CY - 40],   // up
        [CX, CY + 64, CX - a, CY + 40, CX + a, CY + 40],   // down
        [CX - 64, CY, CX - 40, CY - a, CX - 40, CY + a],   // left
        [CX + 64, CY, CX + 40, CY - a, CX + 40, CY + a]    // right
    ];
    for (var i = 0; i < 4; i++) {
        var t = tris[i];
        if (held === i) {
            var hx = (t[0] + t[2] + t[4]) / 3, hy = (t[1] + t[3] + t[5]) / 3;
            System.fillSmoothCircle(Math.round(hx), Math.round(hy), 26, T.accentD);
        }
        System.fillTriangle(t[0], t[1], t[2], t[3], t[4], t[5], held === i ? T.accent : T.text);
    }
    System.fillSmoothCircle(CX, CY, 24, held === STOP_IDX ? T.err : T.bg);
    System.fillSmoothRoundRect(CX - 8, CY - 8, 16, 16, 3, held === STOP_IDX ? T.text : T.err);
}

function hitPad(t) {
    for (var i = 0; i < PAD.length; i++) if (inR(t, PAD[i])) return i;
    return -1;
}

function sendDir(i) {
    var dir = PAD[i][4];
    CelerLink.send(dir === "stop" ? {type: "stop"} : {type: "move", dir: dir});
    lastSend = System.millis();
}

function enterCtrl(p, msg) {
    target = p;
    tel = null;
    held = -1;
    padDrawn = -2;
    chromeSig = "";
    ctrlVisivel = true;
    if (msg) note(msg, 2500);
    UI.invalidate();
}

// Sai do D-pad: para o robo, derruba o link e volta para a lista de pares
// (a navegacao em si e o A.BACK que a tela devolve ao A.run)
function leaveLink(msg) {
    var st = CelerLink.status();
    if (st.connected || st.pairing) {
        // pendente (pairing) nao tem canal de dados: so desconecta
        if (st.connected) CelerLink.send({type: "stop"});
        CelerLink.disconnect();
    }
    target = null;
    held = -1;
    ctrlVisivel = false;
    if (msg) UI.toast(msg, 4000);
    UI.invalidate();
}

// Link caiu: tenta o mesmo par algumas vezes (o robo segue anunciando)
function reconnect() {
    for (var k = 1; k <= RECONNECT_TRIES; k++) {
        spin("reconectando (" + k + "/" + RECONNECT_TRIES + ")...");
        if (CelerLink.connect(target.id, 4000) && afterConnect(target)) {
            UI.invalidate();
            return true;
        }
        if (!ctrlVisivel) return false;  // pareamento cancelado: ja foi pro scan
        System.delay(300);
    }
    return false;
}

function ctrlFrame(c) {
    if (c.entered) { held = -1; padDrawn = -2; chromeSig = ""; }
    if (c.full) padDrawn = -2;
    var st = CelerLink.status();
    if (!st.connected) {
        // caiu: tenta o mesmo par; sem sucesso, de volta a lista
        held = -1;
        if (!reconnect()) {
            if (ctrlVisivel) leaveLink("conexão perdida: " + (target ? (target.name || target.id) : "?"));
            return A.BACK;
        }
        return undefined;   // o spin fechou o frame: repinta no proximo
    }
    // esvazia a fila: so a telemetria mais nova importa; botoes que
    // aparecem/somem com a telemetria pedem frame total
    pollLink(null);
    var sig = (hasModes() ? "m" : "") + (hasTricks() ? "t" : "") + (hasTune() ? "a" : "") + (wifiAvailable() ? "w" : "");
    if (sig !== chromeSig) {
        chromeSig = sig;
        UI.invalidate();
    }

    var name = (target && target.name) || st.peer || "?";
    if (UI.header(name, { back: true, sub: wifiAvailable() ? "" : (st.rssi ? st.rssi + " dBm" : "") })) {
        leaveLink(null);
        return A.BACK;
    }
    // WiFi do robo (API 21): verde = robo ja online
    if (wifiAvailable() && UI.button("WiFi", WIFI_BTN[0], WIFI_BTN[1], WIFI_BTN[2], WIFI_BTN[3],
                                     { color: tel.net ? T.ok : T.accentD, textColor: tel.net ? T.onAccent : T.text,
                                       role: "caption" })) {
        held = -1;
        return "wifi";
    }

    // estado: conexao + telemetria
    UI.badge(st.connected ? "conectado" : "desconectado", LX + 2, 48,
             { color: st.connected ? T.ok : T.err, textColor: T.onAccent });
    UI.text(tel ? "batt " + tel.batt + " mV" + (tel.state ? "  ·  " + tel.state : "") : "aguardando telemetria...",
            W - LX - 2, 50, { role: "caption", align: "right", color: T.textDim, w: 140 });
    UI.text(curNote(), 120, 66,
            { role: "caption", align: "center", color: T.accent, w: LW, lines: 2 });

    drawPad(c.full);

    // Troca de marcha: so com robo que lista os modos dele (tel.modes) E ha
    // mais de um — o destino vai por nome, escolhido da lista do proprio
    // robo (um ciclo as cegas salvava no robo uma marcha que nao anda)
    if (hasModes() && UI.button("marcha: " + tel.mode, MODE_BTN[0], MODE_BTN[1], MODE_BTN[2], MODE_BTN[3],
                                { style: "ghost", role: "caption" })) {
        var next = tel.modes[(tel.modes.indexOf(tel.mode) + 1) % tel.modes.length];
        CelerLink.send({type: "mode", walk: next});
    }
    // Truques que o ROBO anunciou (tel.tricks): robo velho/sem truques nao mostra
    if (hasTricks() && UI.button("truques", TRICK_BTN[0], TRICK_BTN[1],
                                 TRICK_BTN[2], TRICK_BTN[3], { style: "ghost", role: "caption" })) {
        held = -1;
        return "tricks";
    }
    // Afino de bancada (Dog Face 1.9.7 anuncia tel.tune): ajusta o hop do
    // robo ao vivo pelo BLE — sem cabo
    if (hasTune() && UI.button("afinar", TUNE_BTN[0], TUNE_BTN[1],
                               TUNE_BTN[2], TUNE_BTN[3], { style: "ghost", role: "caption" })) {
        held = -1;
        return "tune";
    }
    UI.text("segure para andar · solte para parar", 120, 298,
            { role: "caption", align: "center", color: T.textDim });

    // D-pad: segurar repete o move; soltar a seta manda stop
    var t = UI.touch();
    var h2 = t.down ? hitPad(t) : -1;
    if (h2 !== held) {
        var was = held;
        held = h2;
        if (held >= 0) sendDir(held);
        else if (was >= 0 && was !== STOP_IDX) CelerLink.send({type: "stop"});  // soltou a seta
    } else if (held >= 0 && held !== STOP_IDX && System.millis() - lastSend > REPEAT_MS) {
        sendDir(held);  // segurar a seta: repete o comando (anda enquanto segura)
    }
}

// ---- tela WiFi do robo (API 21) -----------------------------------------------
// O robo nao tem teclado: ele escaneia as redes que ELE ve e devolve a lista
// ({type:"wifi_scan"} -> {type:"wifi_list"}); a senha vai SELADA
// (CelerLink.sendSealed: AES-GCM com a chave do pareamento — no ar, quem nao
// gravou o proprio pareamento nao le) e ele responde {type:"wifi_res"}.
var wifiNets = [];
function wifiFrame(c) {
    if (c.entered) {
        wifiNets = [];
        spin("WiFi: procurando redes...");
        if (!CelerLink.send({type: "wifi_scan"})) { note("falha ao pedir o scan", 6000); return A.BACK; }
        var res = waitMsg("wifi_list", 9000);
        if (!res) { note("robô não respondeu ao scan", 6000); return A.BACK; }
        wifiNets = res.nets || [];
        return undefined;   // o spin fechou o frame: a lista pinta no proximo
    }
    if (UI.header("WiFi do robô", { back: true, sub: wifiNets.length ? "" : "nenhuma rede vista" })) {
        note("WiFi: cancelado", 6000);
        return A.BACK;
    }
    var rows = [];
    for (var i = 0; i < wifiNets.length; i++) {
        rows.push({ label: wifiNets[i][0], sub: wifiNets[i][2] ? "protegida" : "aberta",
                    right: wifiNets[i][1] + " dBm", bars: A.list.bars(wifiNets[i][1]) });
    }
    rows.push({ label: "Outra rede...", sub: "digitar o nome (SSID)" });

    var k = UI.list("wifi", LX, 48, LW, 264, rows, { rowH: 40 });
    if (k === rows.length - 1) {
        var nm = System.prompt("nome da rede (SSID)", "", {nullOnCancel: true});
        if (!nm) { note("WiFi: cancelado", 6000); return A.BACK; }
        return wifiSend(nm, true);
    } else if (k >= 0) {
        return wifiSend(wifiNets[k][0], wifiNets[k][2] === 1);
    }
    pollLink(null);
    if (!CelerLink.status().connected) { note("conexão perdida", 6000); return A.BACK; }
}

// manda a credencial selada e espera o veredito do robo; sempre termina em
// A.BACK com o resultado na fila de notas
function wifiSend(ssid, secure) {
    var pass = "";
    if (secure) {
        pass = System.prompt("senha de " + ssid, "", {mask: true, nullOnCancel: true});
        if (pass === null || pass === undefined) { note("WiFi: cancelado", 6000); return A.BACK; }
    }
    spin("WiFi: enviando (cifrado)...");
    var ok = CelerLink.sendSealed({type: "wifi", ssid: ssid, pass: pass});
    pass = null;
    if (!ok) { note("falha ao enviar (pareie de novo pelo código)", 6000); return A.BACK; }
    spin("WiFi: robô conectando em " + ssid + "...");
    var r2 = waitMsg("wifi_res", 25000);
    if (!r2) note("sem resposta do robô", 6000);
    else note(r2.ok ? "robô online: " + r2.ip : "robô não conectou em " + ssid + " (senha?)", 8000);
    return A.BACK;
}

// ---- tela de truques do cao ---------------------------------------------------------
// Lista com os truques que o ROBO anunciou na telemetria (tel.tricks: os
// nativos + os que o dono ensinou). Toque manda {type:"trick",name} e o
// robo responde {type:"trick_res",ok} — ok:false = recusou (bateria fraca
// recusa truque pesado com ganido: o robo faz drama, o controle conta).
function tricksFrame(c) {
    var names = (tel && tel.tricks) || [];
    if (UI.header("Truques do cão", { back: true, sub: names.length + " no robô" })) return A.BACK;
    var k = UI.list("tricks", LX, 48, LW, 264, names, { rowH: 36 });
    if (k >= 0) {
        var nm = names[k];
        if (!CelerLink.send({ type: "trick", name: nm })) { note("falha ao enviar " + nm, 6000); return A.BACK; }
        spin("truque: rodando " + nm + "...");
        var res = waitMsg("trick_res", 6000);
        note(nm + (!res ? ": sem resposta" : (res.ok ? "!" : " recusou (bateria?)")), 6000);
        return A.BACK;
    }
    pollLink(null);
    if (!CelerLink.status().connected) { note("conexão perdida", 6000); return A.BACK; }
}

// ---- tela de afino do cao (Dog Face 1.9.7) -------------------------------------------
// Bancada SEM CABO: cada toque manda um {type:"tune"} — o cao aplica NA
// HORA (postura/defasagem) ou no proximo pulo (esperas) e persiste no
// dogtune dele; o eco ({type:"hop"} / {type:"stance"}) e a verdade. O
// vencedor da sessao vira default no Dog Face na proxima gravada por cabo.
var TUNE_ROWS = [
    { k: "air",    lbl: "abertura",  min: -200, max: 800,  stp: 10, grp: "hop" },
    { k: "leanR",  lbl: "traseira",  min: 0,    max: 40,   stp: 5,  grp: "stance" },
    { k: "spin",   lbl: "giro",      min: 40,   max: 110,  stp: 10, grp: "hop" },
    { k: "fall",   lbl: "queda",     min: 0,    max: 1200, stp: 20, grp: "hop" },
    { k: "land",   lbl: "pouso",     min: 0,    max: 600,  stp: 10, grp: "hop" },
    { k: "settle", lbl: "deslize",   min: 0,    max: 800,  stp: 10, grp: "hop" },
    { k: "rest",   lbl: "descanso",  min: 0,    max: 2000, stp: 25, grp: "hop" }
];
function tuneVal(r) {
    var src = r.grp === "hop" ? lastHop : lastStance;
    var v = src ? src[r.k] : null;
    return (typeof v === "number") ? v : 0;
}
function tuneBump(r, delta) {
    var v = Math.max(r.min, Math.min(r.max, tuneVal(r) + delta));
    var msg = { type: "tune" };
    if (r.grp === "hop") { msg.hop = {}; msg.hop[r.k] = v; } else msg[r.k] = v;
    if (CelerLink.send(msg)) {
        var eco = waitMsg(r.grp === "hop" ? "hop" : "stance", 2000);
        if (eco) note("afinado: " + r.lbl + " = " + v, 2500);
        else note("mandado (sem eco)", 2500);
    } else note("falha ao enviar", 3000);
}
function tuneFrame(c) {
    if (c.entered) {
        if (!CelerLink.send({ type: "tune" })) { note("afino: falha ao pedir estado", 6000); return A.BACK; }
        lastHop = waitMsg("hop", 3000);
        lastStance = waitMsg("stance", 1500);
        if (!lastHop) { note("afino: robo não respondeu (Dog Face 1.9.7+)", 6000); return A.BACK; }
    }
    var back = UI.header("Afinar marcha", { back: true, sub: "vale na hora · fica salvo no robô" });
    var y = 50;
    for (var i = 0; i < TUNE_ROWS.length; i++) {
        var r = TUNE_ROWS[i];
        UI.text(r.lbl, LX + 2, y + 19, { role: "caption", color: T.textDim, w: 92 });
        UI.text("" + tuneVal(r), 158, y + 19,
                { role: "caption", align: "right", w: 54, color: T.text });
        if (UI.button("-", 162, y, 30, 30, { style: "ghost", role: "caption" })) { tuneBump(r, -r.stp); UI.invalidate(); }
        if (UI.button("+", 198, y, 30, 30, { style: "ghost", role: "caption" })) { tuneBump(r, r.stp); UI.invalidate(); }
        y += 34;
    }
    UI.text("abertura < 0: dianteira lidera o chute", 120, y + 4,
            { role: "caption", align: "center", color: T.textDim, w: LW });
    if (UI.button("testar: andar 3 s", LX, y + 20, LW, 36)) {
        spin("andando 3 s (solto o robô!)...");
        CelerLink.send({ type: "gait", name: "walk", repeat: true });
        System.delay(3000);
        CelerLink.send({ type: "stop" });
        return undefined;   // o spin fechou o frame: repinta no proximo
    }
    if (back) { CelerLink.send({ type: "stop" }); return A.BACK; }
    pollLink(null);
    if (!CelerLink.status().connected) { note("conexão perdida", 6000); return A.BACK; }
}

// ---- sem Celer Link (placa sem BT) ---------------------------------------
// UI.alert e dialogo bloqueante do proprio toolkit (nao precisa de frame)
if (typeof CelerLink === "undefined") {
    UI.alert("Sem Celer Link", "Esta placa não tem Bluetooth (desativado no build).", "Sair");
    System.exitApp();
}

// ---- laco principal (A.run) ------------------------------------------------
doScan();  // primeiro scan automatico
A.run({
    scan: scanFrame,
    ctrl: ctrlFrame,
    wifi: wifiFrame,
    tricks: tricksFrame,
    tune: tuneFrame
}, "scan", { fps: 30 });
