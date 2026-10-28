// Sonar — o instrumento da malha (CelerNet, API 27). Tres abas:
//   Radar: a vizinhanca em aneis de SALTOS (1..4), cada no com o papel
//          (cor) e o sinal do ultimo salto (mais perto do anel = mais forte);
//          uma varredura girando mostra que o radio esta ouvindo.
//   Ping:  RTT e perda de verdade para um no escolhido — 10 pings de 1 quadro
//          (unicast sem copias: perda medida, nao mascarada).
//   Censo: chama todo mundo com o Sonar aberto e monta a tabela de quem
//          respondeu (saltos, RTT, bateria, tempo ligado).
// Enquanto aberto, o Sonar RESPONDE pings e censos dos outros.
//
// CelerKit UI 2.0: header com acoes, segmented de abas, radar animado no
// redesenho parcial (S3) ou frame total (CYD), cards de RTT/perda e lista
// rica do censo. Roda na CYD (sem BT): o portao explica e o app nao chama
// nada de malha.
//
// O protocolo no ar NAO mudou (compativel com Sonar 1.0..1.2.1):
//   s?<seq>               ping (unicast)        -> s!<seq> (unicast)
//   s*<nonce>             censo (broadcast)     -> s=<nonce>|<bat%>|<min ligado>
// A recepcao continua no CelerNet.poll cru, fora do A.mesh.each: o dedup
// de replay do kit (_fresh) aceita UM quadro "=" por nonce, e o censo e uma
// pergunta em broadcast com N respostas para o MESMO nonce — cada no
// responde com o nonce da pergunta, so a primeira passaria.

var A = require("celeros.app");
require("celeros.app.style");
require("celeros.app.icons");
require("celeros.app.widgets");
require("celeros.app.list");
require("celeros.app.caps");
require("celeros.app.mesh");

A.init();
A.style.preset("soft");
A.mesh.family("s");

var T = A.style.T;
var tab = 0;
var nodes = [];
var nodesRev = 0;          // muda quando a presenca muda (carimbo do cache)
// CelerNet so existe em placa com Bluetooth: o drain roda no quadro e nao
// pode depender do gate estar antes dele na ordem do desenho
var TEM_MALHA = typeof CelerNet !== "undefined";
var caps = A.caps.probe();
var lastSig = {};          // assinaturas do desenho base (sem UI.custom)

// desenho animado: redesenho parcial nas S3, frame total + assinatura na CYD
function custom(id, x, y, w, h, sig, full, draw) {
    if (A.custom && A.style && A.style.custom) { A.style.custom(id, x, y, w, h, sig, draw); return; }
    if (lastSig[id] !== sig) { lastSig[id] = sig; UI.invalidate(); }
    if (full) draw(x, y, w, h);
}

// ---- ping ----------------------------------------------------------------
var PING_N = 10, PING_GAP = 1500, PING_TIMEOUT = 6000;
var pingTarget = null;     // {id, name}
var pingSel = -1;
var ping = null;           // sessao em curso/terminada
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
            ping.fail++;          // destino sumiu da presenca ou fila cheia
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
    if (c & 8) return T.warn;      // patas
    if (c & 1) return T.accent;    // alto-falante
    if (c & 4) return T.ok;        // tela
    return T.textDim;
}
function hash(id) {
    var h = 7;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xFFFF;
    return h;
}
function label(s, x, y, color) {
    System.setTextColor(color === undefined ? T.text : color);
    System.setTextDatum(1);
    System.drawString(String(s), x, y, 1);
    System.setTextDatum(0);
    System.setTextSize(1);
}

// Radar desenhado SO com primitivas: o mesmo desenho vale dentro do
// UI.custom (S3) e no frame total (CYD), sem slots de texto no caminho.
function drawRadar(x, y, w, h, now) {
    var cx = Math.round(x + w / 2), cy = Math.round(y + 100);
    var R = [0, 24, 46, 68, 88];
    for (var i = 4; i >= 1; i--) System.fillSmoothCircle(cx, cy, R[i], i % 2 ? T.card : T.raised);
    for (var k = 1; k <= 4; k++) System.drawCircle(cx, cy, R[k], T.stroke);
    // varredura girando (o radio continua ouvindo)
    var a = (now / 25) % 360 * Math.PI / 180;
    System.drawWideLine(cx, cy, Math.round(cx + Math.cos(a) * R[4]),
                        Math.round(cy + Math.sin(a) * R[4]), 2, T.accentD);
    System.fillSmoothCircle(cx, cy, 6, T.accent);
    for (var n = 0; n < nodes.length; n++) {
        var it = nodes[n];
        var hops = Math.max(1, Math.min(4, it.hops));
        // sinal forte puxa para dentro do anel (-40 dBm) e fraco para fora (-95)
        var f = Math.max(0, Math.min(1, (-40 - it.rssi) / 55));
        var rr = R[hops - 1] + 8 + f * (R[hops] - R[hops - 1] - 12);
        var ang = (hash(it.id) % 360) * Math.PI / 180;
        var px = Math.round(cx + Math.cos(ang) * rr), py = Math.round(cy + Math.sin(ang) * rr);
        System.fillSmoothCircle(px, py, 6, roleColor(it.caps));
        label(it.name || it.id, px, py + 8, T.text);
    }
}

// barras de sinal e cache de linhas vieram do celeros.app.list: o build so
// roda quando a presenca muda (carimbo nodesRev)
function nodeItems() {
    var items = [];
    for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        items.push({ label: n.name || n.id, sub: n.hops + (n.hops === 1 ? " salto" : " saltos") +
                     " · " + n.rssi + " dBm", icon: "dot", bars: A.list.bars(n.rssi) });
    }
    if (!items.length) items.push({ label: "Ninguém ouvido ainda", sub: "abra o Sonar nos outros aparelhos",
                                    icon: "dot", disabled: true });
    return items;
}
var nodeList = A.list.make(function () { return nodesRev * 1000 + (pingSel + 1); }, nodeItems);

function censusItems() {
    var items = [];
    if (census) {
        for (var c = 0; c < census.order.length; c++) {
            var r = census.rows[census.order[c]];
            items.push({ label: r.name, sub: r.hops + (r.hops === 1 ? " salto · " : " saltos · ") + r.rtt +
                         " ms · " + r.up + " min", icon: "dot",
                         right: r.bat >= 0 ? r.bat + "%" : "USB" });
        }
        if (!items.length) items.push({ label: "Esperando respostas...", icon: "dot", disabled: true });
    } else {
        items.push({ label: "Toque para chamar quem tem o Sonar aberto", icon: "dot", disabled: true });
    }
    return items;
}
var censusList = A.list.make(function () {
    return census ? (parseInt(census.nonce, 10) * 1000 + census.order.length) : -1;
}, censusItems);

// ---- portao da malha (2.0) -------------------------------------------------
function gate(full) {
    if (typeof CelerNet === "undefined" || typeof Pack === "undefined") {
        A.style.card(10, 56, 220, 108, { full: full, draw: function (r) {
            UI.text("Esta placa não tem Bluetooth no firmware.", r.x, r.y,
                    { w: r.w, lines: 2, role: "body", color: T.text, bg: r.bg });
            UI.text("O Sonar mede a malha CelerNet (app Matilha): sem rádio não há vizinhos para ouvir.",
                    r.x, r.y + 30, { w: r.w, lines: 3, role: "caption", color: T.textDim, bg: r.bg });
        }});
        return false;
    }
    if (CelerNet.status().active) return true;
    A.style.card(10, 56, 220, 96, { full: full, draw: function (r) {
        UI.text("O Sonar mede a malha CelerNet: ligue para ouvir os vizinhos.",
                r.x, r.y, { w: r.w, lines: 4, role: "body", color: T.text, bg: r.bg });
    }});
    if (A.widgets.button("Ligar a malha", 10, 168, 220, 36,
                         { icon: "wifi", bg: T.accent, textColor: T.onAccent })) {
        if (!CelerNet.start({})) UI.toast("Sem RAM para o rádio agora");
    }
    return false;
}

// ---- app -----------------------------------------------------------------
A.run({
    main: function (c) {
        var h = A.widgets.header("Sonar", { full: c.full,
            sub: A.mesh.available() ? CelerNet.status().name : "",
            actions: [{ icon: "info", id: "sobre" }] });
        if (h.back) return A.BACK;
        if (h.action === "sobre") return "ajuda";
        if (!gate(c.full)) return;

        var now = c.now;
        if (A.every(1000, "nos")) {
            var fresh = CelerNet.nodes();
            if (JSON.stringify(fresh) !== JSON.stringify(nodes)) { nodesRev++; UI.invalidate(); }
            nodes = fresh;
        }
        var nt = A.widgets.segmented(8, 44, 224, 30, ["Radar", "Ping", "Censo"], tab);
        if (nt !== tab) { tab = nt; UI.invalidate(); }

        if (tab === 0) {
            A.style.card(8, 80, 224, 196, { full: c.full, draw: function (r) {
                // varredura a ~7 quadros/s: no S3 so a area do radar redesenha
                // (UI.custom); na CYD o caminho base redesenha o mesmo retangulo
                custom("radar", r.x, r.y, r.w, r.h, "r" + Math.floor(now / 150),
                       c.full, function (x, y, w2, h2) { drawRadar(x, y, w2, h2, now); });
            }});
            UI.text(nodes.length ? nodes.length + " nós · anel = saltos" : "Ouvindo o ar...",
                    120, 282, { role: "caption", align: "center", color: T.textDim,
                                w: 224, id: "radarcap" });
            if (nodes.length) {
                UI.text("ponto = papel · anel = saltos",
                        120, 296, { role: "caption", align: "center", color: T.textDim,
                                    w: 224, id: "radarleg" });
            }
        } else if (tab === 1) {
            var rows = nodeList.rows();
            var hit = A.list.view("pingNodes", 8, 80, 224, 106, rows,
                                  { row: 34, panel: true, rowR: 6, selected: pingSel });
            if (hit >= 0 && nodes[hit]) {
                pingSel = hit;
                pingTarget = { id: nodes[hit].id, name: nodes[hit].name || nodes[hit].id };
                UI.invalidate();
            }
            A.style.card(8, 192, 224, 86, { full: c.full, draw: function (r) {
                if (ping) {
                    var st = pingStats();
                    UI.text(ping.target.name + ": " + ping.got + "/" + ping.sent +
                            (ping.running ? " ..." : " · perda " + st.loss + "%"),
                            r.x, r.y, { w: r.w, bg: r.bg, lines: 1, id: "p1" });
                    UI.text(ping.rtts.length ? "RTT " + st.min + " / " + st.avg + " / " + st.max + " ms" : "RTT -",
                            r.x, r.y + 22, { role: "caption", w: r.w - 40, color: T.textDim,
                                             bg: r.bg, lines: 1, id: "p2" });
                    UI.progress(r.x, r.y + 50, r.w, 8, Math.round(100 * ping.sent / PING_N));
                    if (ping.dup) UI.text(ping.dup + " dup", r.x + r.w, r.y + 22,
                                          { role: "caption", align: "right", w: 40,
                                            color: T.warn, bg: r.bg, lines: 1, id: "p3" });
                } else {
                    UI.text(pingTarget ? "Alvo: " + pingTarget.name : "Escolha um nó acima",
                            r.x, r.y, { w: r.w, bg: r.bg, lines: 1, id: "p1" });
                    UI.text("10 pings de 1 quadro, sem cópias", r.x, r.y + 22,
                            { role: "caption", color: T.textDim, bg: r.bg, w: r.w, lines: 1, id: "p2" });
                    A.widgets.ring(r.x + r.w - 28, r.y + 46, 16, 0,
                                   { th: 4, bg: T.raised, color: T.accentD });
                }
            }});
            var busy = ping && ping.running;
            if (A.style.button(busy ? "Parar" : "Pingar 10x", 8, 282, 224, 30,
                               { icon: busy ? "close" : "play",
                                 bg: busy ? T.err : T.accent,
                                 textColor: busy ? 0xFFFF : T.onAccent,
                                 disabled: !pingTarget && !busy })) {
                if (busy) ping.running = false;
                else pingStart(pingTarget);
            }
        } else {
            if (A.style.button("Chamar todos", 8, 86, 224, 32,
                               { icon: "wifi", variant: "primary" })) censusStart();
            A.list.view("census", 8, 124, 224, 188, censusList.rows(),
                        { row: 40, panel: true, rowR: 7 });
        }

        drain(now);
        pingTick(now);
    },
    ajuda: function (c) {
        var h = A.widgets.header("Como medir", { full: c.full });
        if (h.back) return A.BACK;
        A.style.card(8, 48, 224, 252, { full: c.full, draw: function (r) {
            UI.text("Radar: cada anel é um salto até o vizinho. O ponto mais perto da borda é o sinal mais fraco.",
                    r.x, r.y, { w: r.w, lines: 4, bg: r.bg });
            UI.text("Ping: 10 quadros de 1 salto medem RTT e perda reais (sem cópias mascarando).",
                    r.x, r.y + 64, { w: r.w, lines: 3, bg: r.bg });
            UI.text("Censo: chama todos com o Sonar aberto e mostra saltos, RTT, bateria e tempo ligado.",
                    r.x, r.y + 120, { w: r.w, lines: 3, role: "caption", color: T.textDim, bg: r.bg });
            UI.text("Enquanto aberto, o Sonar responde aos outros aparelhos.",
                    r.x, r.y + 186, { w: r.w, lines: 2, role: "caption", color: T.accent, bg: r.bg });
        }});
    }
}, "main");
