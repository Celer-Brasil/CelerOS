// Matilha — painel do bando de CelerOS (API 27). A malha BLE (CelerNet)
// carrega a presença com o PAPEL de cada um (som, mic, tela, patas, leds,
// rede) e os envelopes do OS: mensagem direta por membro e a FESTA que
// viaja — a música chiptune em curso continua no vizinho com alto-falante,
// do mesmo ponto. Em placa sem Bluetooth mostra um aviso e sai.
//
// API 40: a tela "Entrar" junta os tres pilares — a matilha privada por
// nome+senha (Pack.join), o CONVITE pelo CelerLink (o aparelho novo mostra
// o codigo de 6 digitos; quem ja e membro conecta, digita e manda a chave
// selada com Pack.invite) e o status da rede. O cabo (celerctl mesh join) e
// a terceira porta, fora do app.

var hasMesh = typeof CelerNet !== "undefined" && typeof Pack !== "undefined";
var rx = [];               // log do que chega (mais novo primeiro)
var members = [];
var membersAt = -10000;
var me = null;
var tela = "painel";       // painel | entrar | aguardar | convidar
var achados = [];          // scan do CelerLink na tela convidar
var sairAt = 0;            // 2 toques para sair da matilha
var entrarSig = "";        // estado desenhado da tela Aguardar (repaint so na mudanca)
var convSig = "";          // idem na tela Convidar
var hasJoin = hasMesh && typeof CelerLink !== "undefined" &&
              typeof Pack.join === "function";  // firmware API 40+

function pushRx(quem, texto) {
    rx.unshift(quem + ": " + texto);
    if (rx.length > 3) rx.pop();
}

function drainRx() {
    var got = false, m;
    while ((m = CelerNet.poll()) !== null) {
        // broadcast livre (sem envelope): texto do app
        var t = "" + m.msg;
        try { var o = JSON.parse(t); if (o && o.texto) t = o.texto; } catch (e) {}
        pushRx(m.fromName || m.from, t);
        got = true;
    }
    while ((m = Pack.poll()) !== null) {
        var d = "" + m.data;
        try { var p = JSON.parse(d); if (p && p.texto) d = p.texto; } catch (e) {}
        pushRx((m.fromName || m.from) + " (direta)", d);
        got = true;
    }
    if (got) UI.invalidate();
}

function roleStr(c) {
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

function sendAll(myName) {
    var txt = System.prompt("Mensagem para a matilha", "");
    if (txt === "") return;
    if (!CelerNet.broadcast({ type: "msg", de: myName, texto: txt })) {
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

function telaEntrar() {
    if (UI.header("Entrar na matilha", { back: true })) { tela = "painel"; return; }
    var y = 56;
    UI.card(10, y, 220, 50);
    UI.text(me.provisioned ? "Matilha " + me.net : "Rede aberta (sem matilha)", 20, y + 8,
            { w: 200, lines: 1 });
    UI.text(me.provisioned ? "mic, câmera e relés podem ser compartilhados"
                           : "entre numa matilha para compartilhar recursos",
            20, y + 28, { role: "caption", w: 200, lines: 1 });
    UI.cardEnd();
    y += 60;
    if (UI.button("Nome e senha", 10, y, 220, 34, { style: "primary" })) entrarComSenha();
    y += 42;
    if (UI.button("Aguardar convite", 10, y, 220, 34, { style: "solid" })) {
        if (Pack.acceptInvite(true)) tela = "aguardar";
        else UI.toast("Bluetooth indisponível");
    }
    y += 42;
    if (UI.button("Convidar aparelho", 10, y, 220, 34,
                  { style: me.provisioned ? "solid" : "ghost", disabled: !me.provisioned })) {
        achados = [];
        tela = "convidar";
    }
    y += 42;
    if (me.provisioned) {
        var confirma = System.millis() - sairAt < 3000;
        if (UI.button(confirma ? "Toque de novo para sair" : "Sair da matilha", 10, y, 220, 30,
                      { style: "ghost" })) {
            if (confirma) {
                Pack.leave();
                sairAt = 0;
                UI.toast("De volta à rede aberta");
            } else {
                sairAt = System.millis();
            }
        }
    }
}

function telaAguardar() {
    if (UI.header("Aguardar convite", { back: true })) {
        Pack.acceptInvite(false);
        tela = "entrar";
        return;
    }
    var est = Pack.inviteStatus();
    var lk = CelerLink.status();
    UI.card(10, 56, 220, 120);
    if (est === "joined") {
        UI.text("Entrou na matilha " + me.net + "!", 20, 70, { w: 200, lines: 2 });
    } else if (lk.pairing && lk.code) {
        UI.text("Digite no outro aparelho:", 20, 66, { role: "caption" });
        UI.text(lk.code, 120, 104, { role: "display", align: "center" });
    } else if (est === "waiting") {
        UI.text("Visível como " + lk.name + ". No aparelho da matilha: Entrar > Convidar.",
                20, 70, { w: 200, lines: 4 });
    } else {
        UI.text("Janela fechada. Volte e abra de novo.", 20, 70, { w: 200, lines: 2 });
    }
    UI.cardEnd();
    // o codigo e o estado mudam sem toque: repinta so quando a assinatura
    // muda (invalidate por frame forcava redesenho total a 30 fps)
    var sig = est + "|" + (lk.pairing ? 1 : 0) + "|" + (lk.code || "") + "|" + (lk.name || "");
    if (sig !== entrarSig) { entrarSig = sig; UI.invalidate(); }
}

function telaConvidar() {
    if (UI.header("Convidar", { back: true })) {
        CelerLink.disconnect();
        tela = "entrar";
        return;
    }
    var est = Pack.inviteStatus();
    if (est !== convSig) { convSig = est; UI.invalidate(); }
    if (est === "sent") {
        UI.text("Enviando a chave...", 10, 60);
        return;
    }
    if (est === "ok") UI.text("Convidado entrou!", 10, 60, { role: "caption" });
    else if (est === "fail") UI.text("Convite falhou", 10, 60, { role: "caption" });
    if (UI.button("Procurar aparelhos", 10, 80, 220, 32, { style: "primary" })) {
        achados = CelerLink.scan(3000);
    }
    var it = [];
    for (var i = 0; i < achados.length; i++) {
        it.push({ label: achados[i].name, right: achados[i].rssi + " dBm" });
    }
    if (it.length === 0) it.push({ label: "Abra \"Aguardar convite\" no novo", enabled: false });
    var h = UI.list("achados", 10, 120, 220, 150, it, { rowH: 32 });
    if (h >= 0 && achados[h]) convidar(achados[h]);
}

while (true) {
    UI.begin();

    if (hasMesh && tela !== "painel") {
        me = Pack.me();
        if (tela === "entrar") telaEntrar();
        else if (tela === "aguardar") telaAguardar();
        else telaConvidar();
        UI.end();
        continue;
    }

    if (UI.header("Matilha", { back: true })) {
        System.exitApp();
    }

    if (!hasMesh) {
        UI.card(10, 56, 220, 90);
        UI.text("Esta placa não tem Bluetooth no firmware.", 22, 70,
                { role: "body", w: 196, lines: 3 });
        UI.cardEnd();
        UI.text("A matilha existe nas placas com BLE (SmartDisplay, cachorro e relógio).", 10, 160,
                { role: "caption", w: 220, lines: 3 });
        UI.end();
        continue;
    }

    var st = CelerNet.status();
    me = Pack.me();
    var y = 56;

    // liga/desliga + quem sou eu
    UI.card(10, y, 220, 64);
    var on = UI.toggle(20, y + 8, st.active);
    UI.text("Malha " + (on ? "ativa" : "desligada"), 74, y + 8);
    if (hasJoin && UI.button("Entrar", 168, y + 6, 54, 24, { style: "ghost" })) {
        tela = "entrar";
        UI.invalidate();
    }
    if (on !== st.active) {
        var ok = on ? CelerNet.start({}) : CelerNet.stop();
        if (!ok && on) UI.toast("Sem RAM para o rádio agora");
        UI.invalidate();
    }
    st = CelerNet.status();
    UI.text(me.name + " · " + roleStr(me.caps), 20, y + 32, { role: "caption", w: 200, lines: 1 });
    UI.text((me.provisioned ? "matilha " : "rede ") + st.net + " · " + st.heard + " ouvidos", 20, y + 46,
            { role: "caption", w: 200, lines: 1 });
    UI.cardEnd();
    y += 72;

    // bando (atualiza 1x/s): tap = mensagem direta pra aquele membro
    if (System.millis() - membersAt > 1000) {
        membersAt = System.millis();
        members = Pack.members();
        UI.invalidate();
    }
    var items = [];
    for (var i = 0; i < members.length; i++) {
        var mb = members[i];
        items.push({ label: mb.name || mb.id,
                     sub: roleStr(mb.caps) + " · há " + mb.lastSeen + " s",
                     right: mb.rssi + " dBm" });
    }
    if (items.length === 0) items.push({ label: "Ninguém ouvido ainda", enabled: false });
    var hit = UI.list("members", 10, y, 220, 96, items, { rowH: 32 });
    if (hit >= 0 && members[hit]) sendDirect(members[hit].name || members[hit].id);
    y += 104;

    // a festa viaja: passa a música em curso pro vizinho com speaker
    var tocando = System.musicPlaying();
    if (UI.button(tocando ? "Passar a música" : "Passar a música (nada tocando)",
                  10, y, 220, 30,
                  { style: tocando && st.active ? "primary" : "ghost",
                    disabled: !tocando || !st.active })) {
        if (Pack.handoffMusic()) UI.toast("A festa seguiu viagem");
        else UI.toast("Ninguém com alto-falante por perto");
    }
    y += 38;

    if (UI.button("Mensagem para todos", 10, y, 220, 30,
                  { style: st.active ? "solid" : "ghost", disabled: !st.active })) {
        sendAll(me.name);
    }
    y += 38;

    // log do que chega
    UI.text("Chegou:", 10, y, { role: "caption" });
    for (var k = 0; k < rx.length; k++) {
        UI.text(rx[k], 10, y + 16 + k * 16, { role: "caption", w: 220, lines: 1 });
    }

    drainRx();
    UI.end();
}
