// Sonar — o instrumento da malha (CelerNet, API 27). Tres abas:
//   Radar: a vizinhanca em aneis de SALTOS (1..4), cada no com o papel
//          (cor) e o sinal do ultimo salto (mais perto do anel = mais forte).
//   Ping:  RTT e perda de verdade para um no escolhido — 10 pings de 1 quadro
//          (unicast sem copias: perda medida, nao mascarada).
//   Censo: chama todo mundo com o Sonar aberto e monta a tabela de quem
//          respondeu (saltos, RTT, bateria, tempo ligado).
// Enquanto aberto, o Sonar RESPONDE pings e censos dos outros.
//
// Migrado para o CelerKit: o casco do loop e o tema vieram do celeros.app
// (A.run/A.T/A.header), as barras de sinal e o cache de linhas do
// celeros.app.list e o porteiro/presenca/envio do celeros.app.mesh (A.mesh,
// familia "s" — a letra do Sonar na malha). O protocolo no ar NAO mudou
// (compativel com Sonar 1.0/1.1):
//   s?<seq>               ping (unicast)        -> s!<seq> (unicast)
//   s*<nonce>             censo (broadcast)     -> s=<nonce>|<bat%>|<min ligado>
// A recepcao continua no CelerNet.poll cru, fora do A.mesh.each: o dedup
// de replay do kit (_fresh) aceita UM quadro "=" por nonce, e o censo e uma
// pergunta em broadcast com N respostas para o MESMO nonce — cada no
// responde com o nonce da pergunta, so a primeira passaria.

var A = require("celeros.app");
require("celeros.app.mesh");
require("celeros.app.list");

A.init();
A.mesh.family("s");

var tab = 0;
var nodes = [];
var nodesRev = 0;          // muda quando a presenca muda (carimbo do cache)
// CelerNet so existe em placa com Bluetooth: o drain roda no quadro e nao
// pode depender do gate estar antes dele na ordem do desenho
var TEM_MALHA = typeof CelerNet !== "undefined";

// ---- ping ----------------------------------------------------------------
var PING_N = 10, PING_GAP = 1500, PING_TIMEOUT = 6000;
var pingTarget = null;     // {id, name}
var pingSel = -1;
var ping = null;           // sessão em curso/terminada
function pingStart(tgt) {
    ping = { target: tgt, sent: 0, got: 0, dup: 0, fail: 0, nextAt: System.millis(),
             out: {}, rtts: [], running: true, seqBase: Math.floor(Math.random() * 80) };
}
function pingTick(now) {
    if (!ping || !ping.running) return;
    if (ping.sent < PING_N && now >= ping.nextAt) {
        var seq = ping.seqBase + ping.sent;
        if (A.mesh.send(ping.target.id, "?", "" + seq, { copies: 1, urgent: true })) {
            ping.out[seq] = now;
        } else {
            ping.fail++;          // destino sumiu da presença ou fila cheia
        }
        ping.sent++;
        ping.nextAt = now + PING_GAP;
    }
    // acabou quando nenhum ping segue no prazo (respondeu ou venceu)
    var open = 0;
    for (var k in ping.out) {
        if (ping.out.hasOwnProperty(k) && ping.out[k] > 0 && now - ping.out[k] < PING_TIMEOUT) open++;
    }
    if (ping.sent >= PING_N && open === 0) {
        ping.running = false;
        UI.invalidate();
    }
}
function pingReply(seq, now) {
    if (!ping || !ping.out.hasOwnProperty(seq)) return;
    if (ping.out[seq] <= 0) { ping.dup++; return; }
    if (now - ping.out[seq] > PING_TIMEOUT) return;   // venceu: ja contou como perda
    ping.rtts.push(now - ping.out[seq]);
    ping.out[seq] = -1;
    ping.got++;
}
function pingStats() {
    var p = ping, mn = 0, mx = 0, sum = 0;
    for (var i = 0; i < p.rtts.length; i++) {
        var r = p.rtts[i];
        if (i === 0 || r < mn) mn = r;
        if (r > mx) mx = r;
        sum += r;
    }
    var avg = p.rtts.length ? Math.round(sum / p.rtts.length) : 0;
    var done = p.sent - p.fail;
    var loss = done > 0 && !p.running ? Math.round(100 * (done - p.got) / done) : 0;
    return { min: mn, max: mx, avg: avg, loss: loss };
}

// ---- censo ---------------------------------------------------------------
var census = null;         // {nonce, at, rows: {id: {...}}, order: []}
var replyQ = [];           // respostas de censo agendadas (espalhadas no tempo)
function censusStart() {
    var nonce = "" + (10 + Math.floor(Math.random() * 89));
    census = { nonce: nonce, at: System.millis(), rows: {}, order: [] };
    if (!A.mesh.send(null, "*", nonce, { ttl: 4 })) UI.toast("Malha desligada ou fila cheia");
}
function myBat() {
    if (typeof System.batteryInfo === "function") {
        var b = System.batteryInfo();
        if (b && typeof b.pct === "number") return b.pct;
    }
    return -1;
}

// ---- recepcao (sempre: o Sonar aberto responde aos outros) ---------------
// CelerNet.poll cru (ver cabecalho: o A.mesh.each engole "=" alheio a req()).
function drain(now) {
    if (!TEM_MALHA) return;
    var m, got = false;
    while ((m = CelerNet.poll()) !== null) {
        var s = "" + m.msg;
        if (s.length < 3 || s.charAt(0) !== "s") continue;
        var op = s.charAt(1), arg = s.substring(2);
        if (op === "?") {
            A.mesh.send(m.from, "!", arg, { copies: 1, urgent: true });
        } else if (op === "!") {
            pingReply(parseInt(arg, 10), now);
            got = true;
        } else if (op === "*") {
            // espalha as respostas: todos ouviram o mesmo censo ao mesmo tempo
            replyQ.push({ to: m.from, at: now + 200 + Math.floor(Math.random() * 1800), nonce: arg });
        } else if (op === "=") {
            var f = arg.split("|");
            if (census && f[0] === census.nonce && !census.rows[m.from]) {
                census.rows[m.from] = { name: m.fromName || m.from, hops: m.hops, rssi: m.rssi,
                                        rtt: now - census.at, bat: parseInt(f[1], 10),
                                        up: parseInt(f[2], 10) };
                census.order.push(m.from);
                got = true;
            }
        }
    }
    for (var i = 0; i < replyQ.length; i++) {
        if (now >= replyQ[i].at) {
            var r = replyQ.splice(i--, 1)[0];
            A.mesh.send(r.to, "=", r.nonce + "|" + myBat() + "|" + Math.floor(now / 60000),
                        { copies: 1 });
        }
    }
    if (got) UI.invalidate();
}

// ---- desenho -------------------------------------------------------------
function roleColor(c) {
    if (c & 8) return A.T.warn;      // patas
    if (c & 1) return A.T.accent;    // alto-falante
    if (c & 4) return A.T.ok;        // tela
    return A.T.textDim;
}
function hash(id) {
    var h = 7;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xFFFF;
    return h;
}
function drawRadar(y0) {
    var cx = 120, cy = y0 + 104;
    var R = [0, 28, 52, 76, 100];
    for (var h = 4; h >= 1; h--) {
        System.fillSmoothCircle(cx, cy, R[h], h % 2 ? A.T.card : A.T.raised);
    }
    for (var k = 1; k <= 4; k++) System.drawCircle(cx, cy, R[k], A.T.stroke);
    System.fillSmoothCircle(cx, cy, 7, A.T.accent);
    for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var hops = Math.max(1, Math.min(4, n.hops));
        // sinal forte puxa para dentro do anel (-40 dBm) e fraco para fora (-95)
        var f = Math.max(0, Math.min(1, (-40 - n.rssi) / 55));
        var r = R[hops - 1] + 8 + f * (R[hops] - R[hops - 1] - 12);
        var a = (hash(n.id) % 360) * Math.PI / 180;
        var x = Math.round(cx + Math.cos(a) * r), y = Math.round(cy + Math.sin(a) * r);
        System.fillSmoothCircle(x, y, 6, roleColor(n.caps));
        UI.text(n.name || n.id, x, y + 8, { role: "caption", align: "center", w: 70 });
    }
    UI.text(nodes.length ? nodes.length + " nós · anel = saltos" : "Ouvindo o ar...",
            120, y0 + 214, { role: "caption", align: "center", color: A.T.textDim, id: "radarcap" });
}

// barras de sinal e cache de linhas vieram do celeros.app.list: o build so
// roda quando a presenca muda (carimbo nodesRev)
function nodeItems() {
    var items = [];
    for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        items.push({ label: n.name || n.id, sub: n.hops + (n.hops === 1 ? " salto" : " saltos") +
                     " · " + n.rssi + " dBm", bars: A.list.bars(n.rssi) });
    }
    if (!items.length) items.push({ label: "Ninguém ouvido ainda", enabled: false });
    return items;
}
var nodeList = A.list.make(function () { return nodesRev; }, nodeItems);

function censusItems() {
    var items = [];
    if (census) {
        for (var c = 0; c < census.order.length; c++) {
            var r = census.rows[census.order[c]];
            items.push({ label: r.name, sub: r.hops + (r.hops === 1 ? " salto · " : " saltos · ") + r.rtt +
                         " ms · " + r.up + " min",
                         right: r.bat >= 0 ? r.bat + "%" : "USB" });
        }
        if (!items.length) items.push({ label: "Esperando respostas...", enabled: false });
    } else {
        items.push({ label: "Toque para chamar quem tem o Sonar aberto", enabled: false });
    }
    return items;
}
var censusList = A.list.make(function () { return census ? census.order.length : -1; }, censusItems);

// ---- app -----------------------------------------------------------------
A.run({
    main: function (c) {
        if (A.header("Sonar", { sub: A.mesh.available() ? CelerNet.status().name : "" })) return A.BACK;
        if (!A.mesh.gate("O Sonar mede a malha CelerNet: ligue para ouvir os vizinhos.")) return;

        var now = c.now;
        if (A.every(1000, "nos")) {
            var fresh = CelerNet.nodes();
            if (JSON.stringify(fresh) !== JSON.stringify(nodes)) { nodesRev++; UI.invalidate(); }
            nodes = fresh;
        }
        var nt = UI.tabs(10, 48, 220, 30, ["Radar", "Ping", "Censo"], tab);
        if (nt !== tab) { tab = nt; UI.invalidate(); }

        if (tab === 0) {
            if (c.full) drawRadar(84);
        } else if (tab === 1) {
            var hit = UI.list("pingNodes", 10, 86, 220, 104, nodeList.rows(), { rowH: 34, selected: pingSel });
            if (hit >= 0 && nodes[hit]) {
                pingSel = hit;
                pingTarget = { id: nodes[hit].id, name: nodes[hit].name || nodes[hit].id };
                UI.invalidate();
            }
            UI.card(10, 198, 220, 80);
            if (ping) {
                var st = pingStats();
                UI.text(ping.target.name + ": " + ping.got + "/" + ping.sent +
                        (ping.running ? " ..." : " · perda " + st.loss + "%"), 20, 206, { w: 200, id: "p1" });
                UI.text(ping.rtts.length ? "RTT " + st.min + " / " + st.avg + " / " + st.max + " ms" : "RTT -",
                        20, 228, { role: "caption", w: 200, id: "p2" });
                UI.progress(20, 252, 200, 8, Math.round(100 * ping.sent / PING_N));
                if (ping.dup) UI.text(ping.dup + " dup", 200, 228, { role: "caption", align: "right", id: "p3" });
            } else {
                UI.text(pingTarget ? "Alvo: " + pingTarget.name : "Escolha um nó acima", 20, 206, { w: 200, id: "p1" });
                UI.text("10 pings de 1 quadro, sem cópias", 20, 228,
                        { role: "caption", color: A.T.textDim, w: 200, id: "p2" });
            }
            UI.cardEnd();
            var busy = ping && ping.running;
            if (UI.button(busy ? "Parar" : "Pingar 10x", 10, 284, 220, 30,
                          { disabled: !pingTarget && !busy, style: busy ? "danger" : "primary" })) {
                if (busy) ping.running = false;
                else pingStart(pingTarget);
            }
        } else {
            if (UI.button("Chamar todos", 10, 86, 220, 32)) censusStart();
            UI.list("census", 10, 126, 220, 188, censusList.rows(), { rowH: 46 });
        }

        drain(now);
        pingTick(now);
    }
}, "main");
