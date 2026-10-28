// Matilha — painel do bando de CelerOS sobre o CelerKit (deps
// celeros.app.*). A malha BLE (CelerNet) carrega a presenca com o PAPEL de
// cada um (som, mic, tela, patas, leds, rede) e os envelopes do OS:
// mensagem direta por membro e a FESTA que viaja — a musica chiptune em
// curso continua no vizinho com alto-falante, do mesmo ponto.
//
// 2.0.0 — UI 2.0 do CelerKit: cabecalho do kit, cartao de estado da malha
// (toggle + Entrar + Atalhos), bando em A.list.view (linhas ricas com papel,
// idade e RSSI; cache por carimbo e sort estavel) e botoes tokenizados. A
// tela Atalhos manda uma mensagem pronta para a matilha. A sonda
// celeros.app.caps decide o caminho: placa sem Bluetooth abre um cartao
// explicando, nunca estoura.
//
// Protocolo PRESERVADO (test/meshsim): familia "b" (A.mesh.family), broadcast
// de texto no quadro "b*texto" com ttl 4, mensagem direta no envelope selado
// do Pack ({de, texto}) e drenagem de Pack.poll(). A tela Entrar mantem os
// tres pilares: matilha por nome+senha (Pack.join), convite pelo CelerLink
// (codigo de 6 digitos + Pack.invite) e saida da matilha.

var A = require("celeros.app");
require("celeros.app.mesh");
require("celeros.app.list");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.caps");

A.init();
var T = A.style.T;
var L = A.L, LX = L.x, LW = L.w;

A.mesh.family("b");    // 1a letra dos quadros DESTE app (c/m/s/a ja tem dono)

// a sonda unica da placa (celeros.app.caps) + os typeof de sempre: firmware
// sem a malha nao quebra no probe
var cap = A.caps.probe();
var hasMesh = (typeof CelerNet !== "undefined" && typeof Pack !== "undefined") && cap.bt;
var hasJoin = hasMesh && typeof CelerLink !== "undefined" &&
              typeof Pack.join === "function";  // firmware API 40+

var rx = [];               // log do que chega (mais novo primeiro)
var members = [];          // presenca crua (Pack.members, ordenada no cache)
var bando = [];            // copia ordenada (indice da lista -> membro)
var membersAt = 0;         // carimbo da ultima coleta (stamp do cache)
var me = { name: "?", caps: {}, provisioned: false, net: "celer" };
var st = { active: false, net: "celer", heard: 0 };
if (hasMesh) st = CelerNet.status();
var achados = [];          // scan do CelerLink na tela convidar
var sairAt = 0;            // 2 toques para sair da matilha
var entrarSig = "";        // estado desenhado da tela Aguardar (repaint so na mudanca)
var convSig = "";          // idem na tela Convidar

var PRESETS = ["bora!", "chegando", "au au", "festa!", "tudo bem?", "olha isso"];

function pushRx(quem, texto) {
    rx.unshift(quem + ": " + texto);
    if (rx.length > 3) rx.pop();
}

// quadros da familia "b" (broadcast "*": texto cru) + envelopes do OS
// (mensagem direta selada pelo Pack, fila propria)
function drenaMesh() {
    var got = false;
    A.mesh.each(function (from, op, rest, m) {
        if (op !== "*") return;   // pedido/quadro de outra familia: ignora
        pushRx(m.fromName || m.from, rest);
        got = true;
    });
    var m;
    while (hasMesh && (m = Pack.poll()) !== null) {
        var d = "" + m.data;
        try { var p = JSON.parse(d); if (p && p.texto) d = p.texto; } catch (e) {}
        pushRx((m.fromName || m.from) + " (direta)", d);
        got = true;
    }
    if (got) UI.invalidate();
}

function roleStr(c) {
    c = c || {};
    var r = [];
    if (c.speaker) r.push("som");
    if (c.mic) r.push("mic");
    if (c.display) r.push("tela");
    if (c.motors) r.push("patas");
    if (c.leds) r.push("leds");
    if (c.hub) r.push("rede");
    return r.length ? r.join(" · ") : "?";
}

function sendDirect(name) {
    var txt = System.prompt("Mensagem para " + name, "");
    if (txt === "") return;
    if (!Pack.send(name, { de: Pack.me().name, texto: txt })) {
        UI.toast("Não deu: malha desligada ou destino sumiu");
    }
}

function sendAll() {
    var txt = System.prompt("Mensagem para a matilha", "");
    if (txt === "") return;
    // broadcast do app: quadro "b*" + texto cru (o remetente viaja no frame)
    if (!A.mesh.send(null, "*", txt, { ttl: 4 })) {
        UI.toast("Malha desligada ou fila cheia");
    }
}

function entrarComSenha() {
    var nome = System.prompt("Nome da matilha (1 a 15)", "", { nullOnCancel: true });
    if (nome === null || nome === "") return;
    var senha = System.prompt("Senha de " + nome + " (8+)", "", { mask: true, nullOnCancel: true });
    if (senha === null) return;
    if (senha.length < 8) { UI.toast("Senha curta: use 8 ou mais"); return; }
    if (Pack.join(nome, senha)) UI.toast("Na matilha " + nome);
    else UI.toast("Não deu (sem permissão ou erro)");
}

// lado do membro: escolhe o aparelho que esta aguardando, conecta, pede o
// codigo que aparece na tela DELE e manda o convite selado
function convidar(peer) {
    if (!CelerLink.connect(peer.id, 6000)) { UI.toast("Não conectou"); return; }
    // ja pareados antes (bond): a reconexao dispensa o codigo
    var c = CelerLink.status().verified ? "" :
            System.prompt("Código na tela de " + peer.name, "", { hint: "num", nullOnCancel: true });
    if (c === null || (c !== "" && !CelerLink.verify(c))) {
        CelerLink.disconnect();
        UI.toast("Código recusado");
        return;
    }
    if (!Pack.invite()) {
        CelerLink.disconnect();
        UI.toast("Convite não saiu");
    }
}

// linhas do bando: cache por carimbo (celeros.app.list) — sort estavel e
// montagem das linhas so rodam quando a coleta de 1 s muda o carimbo
var listaBando = A.list.make(
    function () { return membersAt; },
    function () {
        bando = [];
        for (var i = 0; i < members.length; i++) bando.push(members[i]);
        A.list.sort(bando, function (m) { return String(m.name || m.id); });
        var rows = [];
        for (var k = 0; k < bando.length; k++) {
            var mb = bando[k];
            rows.push({ label: mb.name || mb.id,
                        sub: roleStr(mb.caps) + " · há " + mb.lastSeen + " s",
                        right: mb.rssi + " dBm",
                        icon: "dot",
                        color: mb.id === me.id ? T.accent : T.text,
                        rightColor: mb.rssi > -60 ? T.ok : T.textDim });
        }
        if (rows.length === 0) {
            rows.push({ label: "Ninguém ouvido ainda", icon: "search", disabled: true,
                        sub: "ligue a malha e aproxime os aparelhos" });
        }
        return rows;
    }
);

// ------------------------------------------------------------------ telas ---
// A.run e dono do UI.begin/UI.end; a tela desenha e DEVOLVE
// (A.BACK = volta na pilha, "nome" = empilha, undefined = fica).

function telaSemBt(c) {
    if (A.header("Matilha")) return A.BACK;
    A.style.card(LX, 56, LW, 128, { full: c.full, draw: function (r) {
        var col = r.x, y = r.y;
        A.icons.draw("alert", col, y, 24, { color: T.warn });
        UI.text("Esta placa não tem Bluetooth", col + 32, y - 2,
                { role: "title", color: T.text, bg: r.bg, w: r.w - 32, lines: 2 });
        UI.text("A matilha precisa do rádio CelerNet. Ela existe nas placas com BLE: SmartDisplay, cachorro e relógio.",
                col, y + 42, { role: "body", color: T.textDim, bg: r.bg, w: r.w, lines: 5 });
    }});
    A.style.card(LX, 196, LW, 70, { full: c.full, draw: function (r) {
        UI.text("Placa: " + (cap.board || "?"), r.x, r.y,
                { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
        UI.text("Sem rádio, mensagens, presets e a festa da música ficam offline.", r.x, r.y + 20,
                { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 2 });
    }});
}

function telaPainel(c) {
    if (!hasMesh) return telaSemBt(c);
    if (A.header("Matilha", { sub: st.active ? st.net : "off" })) return A.BACK;

    // coleta de presenca 1x/s (o carimbo manda reconstruir as linhas)
    if (A.every(1000, "bando")) {
        me = Pack.me();
        members = Pack.members();
        membersAt = System.millis();
    }
    if (A.every(500, "st")) st = CelerNet.status();

    var go = "", toggled = -1;
    A.style.card(LX, 44, LW, 78, { full: c.full, draw: function (r) {
        var on = UI.toggle(r.x, r.y, st.active, { id: "mesh" });
        if (on !== st.active) toggled = on ? 1 : 0;
        UI.text(st.active ? "Malha ativa" : "Malha desligada", r.x + 52, r.y + 3,
                { role: "body", color: st.active ? T.text : T.textDim, bg: r.bg,
                  w: r.w - 116, lines: 1 });
        if (hasJoin && A.style.button("Entrar", r.x + r.w - 60, r.y - 4, 60, 26,
                                      { variant: "ghost", role: "caption" })) go = "entrar";
        if (A.style.button("Atalhos", r.x + r.w - 60, r.y + 24, 60, 22,
                           { variant: "ghost", role: "caption" })) go = "presets";
        UI.text((me.name || "?") + " · " + roleStr(me.caps), r.x, r.y + 28,
                { role: "caption", color: T.textDim, bg: r.bg, w: r.w - 66, lines: 1 });
        UI.text((me.provisioned ? "matilha " : "rede ") + st.net + " · " +
                st.heard + " ouvidos", r.x, r.y + 46,
                { role: "caption", color: T.textDim, bg: r.bg, w: r.w - 66, lines: 1 });
    }});
    if (toggled >= 0) {
        var ok = toggled ? CelerNet.start({}) : CelerNet.stop();
        if (!ok && toggled) UI.toast("Sem RAM para o rádio agora");
        st = CelerNet.status();
        UI.invalidate();
    }

    // bando: tap = mensagem direta pra aquele membro
    var rows = listaBando.rows();
    var hit = A.list.view("members", LX, 128, LW, 96, rows, { row: 31, r: 10 });
    if (hit >= 0 && bando[hit]) sendDirect(bando[hit].name || bando[hit].id);

    // a festa viaja: passa a musica em curso pro vizinho com speaker
    var tocando = false;
    try { tocando = System.musicPlaying(); } catch (e) {}
    if (A.style.button(tocando ? "Passar a música" : "Passar a música (nada tocando)",
                       LX, 226, LW, 30,
                       { variant: "primary", disabled: !tocando || !st.active })) {
        if (Pack.handoffMusic()) UI.toast("A festa seguiu viagem");
        else UI.toast("Ninguém com alto-falante por perto");
    }

    if (A.style.button("Mensagem para todos", LX, 260, LW, 30,
                       { variant: "primary", disabled: !st.active })) {
        sendAll();
    }

    // log do que chega (as 3 linhas ficam dentro do vidro)
    if (!rx.length) UI.text("Chegou: nada ainda", LX, 292,
                            { role: "caption", color: T.textDim, w: LW, lines: 1 });
    else for (var k = 0; k < rx.length; k++) {
        UI.text(rx[k], LX, 292 + k * 9, { role: "caption", color: T.textDim, w: LW, lines: 1 });
    }

    drenaMesh();
    if (go) return go;
}

function telaPresets(c) {
    if (A.header("Atalhos")) return A.BACK;
    var rows = [];
    for (var i = 0; i < PRESETS.length; i++) {
        rows.push({ label: PRESETS[i], icon: "play", right: "enviar" });
    }
    var hit = A.list.view("presets", LX, 48, LW, L.bottom - 62, rows, { row: 36, r: 10 });
    if (hit >= 0) {
        if (!st.active) UI.toast("Ligue a malha primeiro");
        else if (A.mesh.send(null, "*", PRESETS[hit], { ttl: 4 })) UI.toast("Enviado: " + PRESETS[hit]);
        else UI.toast("Fila cheia");
    }
    UI.text("Vão para a matilha inteira.", LX, L.bottom - 10,
            { role: "caption", color: T.textDim, w: LW, lines: 1 });
}

function telaEntrar(c) {
    if (A.header("Entrar na matilha")) return A.BACK;
    me = Pack.me();
    A.style.card(LX, 50, LW, 66, { full: c.full, draw: function (r) {
        UI.text(me.provisioned ? "Matilha " + me.net : "Rede aberta (sem matilha)", r.x, r.y,
                { role: "body", color: T.text, bg: r.bg, w: r.w, lines: 1 });
        UI.text(me.provisioned ? "mic, câmera e relés podem ser compartilhados"
                               : "entre numa matilha para compartilhar recursos",
                r.x, r.y + 24, { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 2 });
    }});
    var y = 126;
    if (A.style.button("Nome e senha", LX, y, LW, 34)) entrarComSenha();
    y += 42;
    if (A.style.button("Aguardar convite", LX, y, LW, 34, { variant: "secondary" })) {
        if (Pack.acceptInvite(true)) return "aguardar";
        UI.toast("Bluetooth indisponível");
    }
    y += 42;
    if (A.style.button("Convidar aparelho", LX, y, LW, 34,
                       { variant: "secondary", disabled: !me.provisioned })) {
        achados = [];
        return "convidar";
    }
    y += 42;
    if (me.provisioned) {
        var confirma = sairAt > 0 && System.millis() - sairAt < 3000;
        if (A.style.button(confirma ? "Toque de novo para sair" : "Sair da matilha", LX, y, LW, 30,
                           { variant: "ghost" })) {
            if (confirma) {
                Pack.leave();
                sairAt = 0;
                UI.toast("De volta à rede aberta");
            } else {
                sairAt = System.millis();
            }
        }
    }
    UI.text("Terceira porta: celerctl mesh join.", LX, L.bottom - 10,
            { role: "caption", color: T.textDim, w: LW, lines: 1 });
}

function telaAguardar(c) {
    if (A.header("Aguardar convite")) {
        Pack.acceptInvite(false);
        return A.BACK;
    }
    me = Pack.me();
    var est = Pack.inviteStatus();
    var lk = CelerLink.status();
    A.style.card(LX, 54, LW, 128, { full: c.full, draw: function (r) {
        if (est === "joined") {
            UI.text("Entrou na matilha " + me.net + "!", r.x, r.y,
                    { role: "title", color: T.ok, bg: r.bg, w: r.w, lines: 2 });
        } else if (lk.pairing && lk.code) {
            UI.text("Digite no outro aparelho:", r.x, r.y,
                    { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1 });
            UI.text(lk.code, r.x, r.y + 36,
                    { role: "display", align: "center", color: T.accent, bg: r.bg, w: r.w, lines: 1 });
        } else if (est === "waiting") {
            UI.text("Visível como " + lk.name + ". No aparelho da matilha: Entrar > Convidar.",
                    r.x, r.y, { role: "body", color: T.text, bg: r.bg, w: r.w, lines: 4 });
        } else {
            UI.text("Janela fechada. Volte e abra de novo.", r.x, r.y,
                    { role: "body", color: T.textDim, bg: r.bg, w: r.w, lines: 2 });
        }
    }});
    // o codigo e o estado mudam sem toque: repinta so quando a assinatura
    // muda (invalidate por frame forcava redesenho total a 30 fps)
    var sig = est + "|" + (lk.pairing ? 1 : 0) + "|" + (lk.code || "") + "|" + (lk.name || "");
    if (sig !== entrarSig) { entrarSig = sig; UI.invalidate(); }
}

function telaConvidar(c) {
    if (A.header("Convidar")) {
        CelerLink.disconnect();
        return A.BACK;
    }
    var est = Pack.inviteStatus();
    if (est !== convSig) { convSig = est; UI.invalidate(); }
    if (est === "sent") {
        UI.text("Enviando a chave...", LX, 50, { role: "body", color: T.text, w: LW, lines: 1 });
    } else if (est === "ok") {
        UI.text("Convidado entrou!", LX, 50, { role: "body", color: T.ok, w: LW, lines: 1 });
    } else if (est === "fail") {
        UI.text("Convite falhou", LX, 50, { role: "body", color: T.err, w: LW, lines: 1 });
    }
    if (A.style.button("Procurar aparelhos", LX, 74, LW, 32)) {
        achados = CelerLink.scan(3000);
    }
    var it = [];
    for (var i = 0; i < achados.length; i++) {
        it.push({ label: achados[i].name, right: achados[i].rssi + " dBm", icon: "wifi" });
    }
    if (it.length === 0) {
        it.push({ label: "Abra \"Aguardar convite\" no novo", icon: "info", disabled: true });
    }
    var h = A.list.view("achados", LX, 116, LW, L.bottom - 122, it, { row: 34, r: 10 });
    if (h >= 0 && achados[h]) convidar(achados[h]);
}

A.run({
    painel: telaPainel,
    presets: telaPresets,
    entrar: telaEntrar,
    aguardar: telaAguardar,
    convidar: telaConvidar
}, "painel", { fps: 20 });
