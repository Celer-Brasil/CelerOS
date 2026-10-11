// QrNode - no-sensor de QR da CelerNet (esp32-cam, headless).
//
// NAO e app de fabrica: e o lado "sensor" da demo do modulo de camera na
// malha (API 35). Roda sem vidro: a interface e o LED de flash (GPIO4), o
// log em /sd/qrlog.txt e, desde a 0.2, o canal de administracao remota da
// Bilheteria (comandos {t:'cmd'} + telemetria {t:'stat'}).
//
// LED: 1 flash de 240 ms = QR lido; 3 curtos = valido, 6 curtos = invalido,
// nada = gateway nao respondeu; 1 curto = comando remoto aceito.
//
// Protocolo (envelopes Pack, JSON com t:):
//   entra: {t:'ok'} veredito | {t:'pong'} | {t:'cmd', n, cmd, ...args}
//   sai:   {t:'qr'} | {t:'ping'} | {t:'ack', n, cmd, ok, info} |
//          {t:'stat'} heartbeat 30 s + sob demanda | {t:'log', i, n, s}
// Seguranca (demo): cmd so vale de no ouvido AGORA com caps.hub (mesma
// ancora de confianca da entrega do QR). Canal selado/token: futuro.
//
// Deploy: celerctl dev --sd + `grant QrNode` (headless nao tem dialogo de
// consentimento - o shell grants o que o app.json declara).

var WAIT_MS = 4000;    // espera do veredito por tentativa
var RETRY = 2;         // reenvios do {t:'qr'}
var STAT_MS = 30000;   // heartbeat {t:'stat'} p/ o gateway
var MESHLOG_MS = 60000; // dump da malha no log/ring

// ---- estado (cfg persiste em Storage: sobrevive a reboot) ----
function num(key, def, min, max) {
    var v = parseInt(Storage.get(key, ""), 10);
    if (isNaN(v)) v = def;
    if (v < min) v = min;
    if (v > max) v = max;
    return v;
}
var cfg = {
    to: num("to", 2000, 250, 8000),    // janela de scan (ms) por ciclo
    vga: num("vga", 1, 0, 1),          // VGA no decode (QR pequeno/longe)
    led: num("led", 0, 0, 1),          // flash aceso durante o scan
    iv: num("iv", 200, 0, 5000),       // respiro entre ciclos (ms)
    paused: num("paused", 0, 0, 1),
};
var counters = { scans: 0, reads: 0, dl: 0, lk: 0, ck: 0, cx: 0 };
var lastCode = "";
var ring = [];          // ultimas 24 notas: alimenta o cmd 'log' sem reler FS
var g_verdict = null;   // {t:'ok'} do deliver em voo
var g_pong = -1;        // ms do pong em voo (-1 = sem resposta ainda)

function note(s) {
    System.notify("qrnode", s);
    var line = System.getTime() + " " + s;
    FS.appendTextFile("/sd/qrlog.txt", line + "\n");
    ring.push(line);
    if (ring.length > 24) ring.shift();
}

// Malha multi-hub (bancada 2026-10-11: Celer-1CAE, Celer-AB3E e o watch, os
// tres com caps.hub): o gateway de verdade e quem RODA a Bilheteria, e ele
// nem e o hub mais forte. gwId trava no hub que respondeu ({t:'ok'} ou
// pong); quando o alvo cala, rotateGateway troca para o proximo hub ouvido.
var gwId = "";

function hubs() {
    var ms = Pack.members(), out = [];
    for (var i = 0; i < ms.length; i++) {
        if (ms[i].caps && ms[i].caps.hub) out.push(ms[i]);
    }
    return out;
}

function gateway() {
    var hs = hubs();
    for (var i = 0; i < hs.length; i++) {
        if (hs[i].id === gwId) return hs[i];  // preferencial: quem respondeu
    }
    return hs.length > 0 ? hs[0] : null;
}

function rotateGateway() {
    var hs = hubs();
    if (hs.length < 2) return;
    for (var i = 0; i < hs.length; i++) {
        if (hs[i].id === gwId) {
            gwId = hs[(i + 1) % hs.length].id;
            return;
        }
    }
    gwId = hs[0].id;
}

function memberIsHub(id) {
    var ms = Pack.members();
    for (var i = 0; i < ms.length; i++) {
        if (ms[i].id === id) return !!(ms[i].caps && ms[i].caps.hub);
    }
    return false;
}

// Pack.poll() entrega data como STRING (o JSON cru do envelope): sem o parse
// o d.t era sempre undefined e o veredito do gateway nunca era aceito
function envData(r) {
    var d = r.data;
    if (typeof d === "string") {
        try { d = JSON.parse(d); } catch (e) { d = null; }
    }
    return d;
}

// ---- telemetria ----
function sendStat() {
    var gw = gateway();
    if (gw === null) return;
    var info = System.getInfo();
    var last = lastCode;
    if (last.length > 40) last = last.slice(0, 40);
    // ~250 B tipicos: folga no teto de 430 B do envelope
    Pack.send(gw.id, {
        t: "stat", v: "0.2.0", up: Math.round(info.uptimeMs / 1000),
        ram: info.freeRAM, ps: info.freePSRAM, ip: System.getIPAddress() || "",
        sc: counters.scans, rd: counters.reads, dl: counters.dl, lk: counters.lk,
        ck: counters.ck, cx: counters.cx,
        st: cfg.paused, to: cfg.to, vga: cfg.vga, led: cfg.led, iv: cfg.iv,
        last: last, gw: gw.name + "@" + gw.id, rssi: gw.rssi,
        os: System.getOSVersion(), api: System.getAPILevel(),
    }, { urgent: true });
}

function meshDump() {
    var ms = Pack.members();
    var parts = [];
    for (var i = 0; i < ms.length; i++) {
        parts.push(ms[i].name + "(" + ms[i].id + (ms[i].caps && ms[i].caps.hub ? ",hub" : "") +
                   ",rssi " + ms[i].rssi + ",hops " + ms[i].hops + ")");
    }
    note("malha: " + (parts.length ? parts.join(" ") : "ninguem ouvido"));
}

// ---- comandos remotos (Bilheteria) ----
function ack(env, n, cmd, ok, info, extra) {
    var m = { t: "ack", n: n, cmd: cmd, ok: ok ? 1 : 0, info: info || "" };
    if (extra) for (var k in extra) m[k] = extra[k];
    Pack.send(env.from, m, { urgent: true });
}

function sendLogTail(env, d) {
    if (ring.length === 0) {
        ack(env, d.n, "log", 1, "log vazio");
        return;
    }
    // chunks de <= 380 B (n linhas por chunk conforme caber)
    var chunks = [], cur = "";
    for (var i = 0; i < ring.length; i++) {
        if (cur.length + ring[i].length + 1 > 380) { chunks.push(cur); cur = ""; }
        if (cur !== "") cur += "\n";
        cur += ring[i];
    }
    if (cur !== "") chunks.push(cur);
    ack(env, d.n, "log", 1, chunks.length + " partes");
    for (var c = 0; c < chunks.length; c++) {
        Pack.send(env.from, { t: "log", i: c, n: chunks.length, s: chunks[c] }, { urgent: true });
        System.delay(120);  // da tempo ao radio entre envelopes grandes
    }
}

function takePhoto() {
    var f = Camera.capture();  // troca o sensor p/ JPEG e volta no proximo scan
    if (f === null) return null;
    var path = "/sd/img_" + System.millis() + ".jpg";
    var w = Camera.save(f.id, path);
    Camera.free(f.id);
    if (w <= 0) return null;
    return { path: path, bytes: w, w: f.w, h: f.h };
}

function onCmd(env, d) {
    if (!memberIsHub(env.from)) {  // so confia em no com internet agora
        counters.cx += 1;
        note("cmd '" + d.cmd + "' de no sem caps.hub: ignorado");
        return;
    }
    counters.ck += 1;
    Camera.led(true); System.delay(60); Camera.led(false);  // 1 curto = cmd
    if (d.cmd === "status") {
        ack(env, d.n, d.cmd, 1, "stat a caminho");
        sendStat();
    } else if (d.cmd === "pause") {
        cfg.paused = 1; Storage.set("paused", "1");
        ack(env, d.n, d.cmd, 1, "pausado");
        note("cmd pause (por " + env.fromName + ")");
    } else if (d.cmd === "resume") {
        cfg.paused = 0; Storage.set("paused", "");
        ack(env, d.n, d.cmd, 1, "retomado");
        note("cmd resume (por " + env.fromName + ")");
    } else if (d.cmd === "blink") {
        var n = (d.times >= 1 && d.times <= 10) ? d.times : 3;  // d.n e o nonce
        ack(env, d.n, d.cmd, 1, n + " piscadas");
        for (var i = 0; i < n; i++) {
            Camera.led(true); System.delay(120); Camera.led(false); System.delay(160);
        }
    } else if (d.cmd === "led") {
        if (d.on) { Camera.led(true); System.delay(800); Camera.led(false); }
        else Camera.led(false);
        ack(env, d.n, d.cmd, 1, d.on ? "flash 800 ms (teto termico)" : "apagado");
    } else if (d.cmd === "cfg") {
        // clamps identicos aos do boot: janela de scan, VGA, flash no scan,
        // respiro entre ciclos. Tudo persiste: cfg sobrevive a reboot.
        if (d.to !== undefined) cfg.to = Math.max(250, Math.min(8000, parseInt(d.to, 10) || cfg.to));
        if (d.vga !== undefined) cfg.vga = d.vga ? 1 : 0;
        if (d.led !== undefined) cfg.led = d.led ? 1 : 0;
        if (d.iv !== undefined) cfg.iv = Math.max(0, Math.min(5000, parseInt(d.iv, 10) || 0));
        Storage.set("to", "" + cfg.to);
        Storage.set("vga", "" + cfg.vga);
        Storage.set("led", "" + cfg.led);
        Storage.set("iv", "" + cfg.iv);
        ack(env, d.n, d.cmd, 1, "cfg aplicada");
        note("cmd cfg: to=" + cfg.to + " vga=" + cfg.vga + " led=" + cfg.led + " iv=" + cfg.iv);
    } else if (d.cmd === "log") {
        sendLogTail(env, d);
    } else if (d.cmd === "photo") {
        var p = takePhoto();
        if (p !== null) {
            note("foto: " + p.path + " (" + p.bytes + " B, " + p.w + "x" + p.h + ")");
            ack(env, d.n, d.cmd, 1, p.path, { bytes: p.bytes, w: p.w, h: p.h });
        } else {
            ack(env, d.n, d.cmd, 0, "capture/save falhou");
        }
    } else if (d.cmd === "clearlog") {
        FS.deleteFile("/sd/qrlog.txt");
        ring = [];
        ack(env, d.n, d.cmd, 1, "log limpo");
        note("cmd clearlog");
    } else if (d.cmd === "reboot") {
        ack(env, d.n, d.cmd, 1, "reiniciando");
        note("cmd reboot (por " + env.fromName + ")");
        System.delay(300);  // deixa o ack e o TX irem embora
        System.restart();
    } else {
        counters.cx += 1;
        ack(env, d.n, d.cmd, 0, "cmd desconhecido");
    }
}

// Ponto unico de espera: drena a fila e despacha tudo que chega. Usado no
// loop principal, dentro do deliver (veredito nao para os comandos) e nos
// waits de boot - a cam nunca fica surda por causa de um scan/entrega.
function pump(ms) {
    var t0 = System.millis();
    do {
        var r = Pack.poll();
        while (r !== null) {
            var d = envData(r);
            if (d !== null) {
                if (d.t === "cmd") onCmd(r, d);
                else if (d.t === "ok") { g_verdict = d; gwId = r.from; }
                else if (d.t === "pong") { g_pong = System.millis(); gwId = r.from; }
                else if (d.t === "ping")  // RTT medido pelo painel (Bilheteria)
                    Pack.send(r.from, { t: "pong" }, { urgent: true });
            }
            r = Pack.poll();
        }
        if (ms > 0 && System.millis() - t0 < ms) System.delay(100);
    } while (ms > 0 && System.millis() - t0 < ms);
}

function blink(times) {
    for (var i = 0; i < times; i++) {
        Camera.led(true);
        System.delay(90);
        Camera.led(false);
        System.delay(140);
    }
}

function deliver(code) {
    var gw = gateway();
    if (gw === null) {
        counters.lk += 1;
        note("sem gateway na malha (nenhum no com caps.hub)");
        return null;
    }
    g_verdict = null;
    for (var attempt = 0; attempt <= RETRY; attempt++) {
        var gw = gateway();  // re-avaliado por tentativa (rotateGateway abaixo)
        if (gw === null) break;
        Pack.send(gw.id, { t: "qr", code: code }, { urgent: true });
        var t0 = System.millis();
        while (System.millis() - t0 < WAIT_MS) {
            pump(120);  // cede ao radio E aos comandos enquanto espera
            if (g_verdict !== null) return g_verdict;
        }
        note("sem resposta de " + gw.name + " (tentativa " + (attempt + 1) + ") - trocando de hub");
        rotateGateway();
    }
    counters.lk += 1;
    return null;
}

if (typeof Camera === "undefined") {
    System.notify("qrnode", "objeto Camera ausente - conferir firmware/permissoes");
} else if (typeof Pack === "undefined" || typeof CelerNet === "undefined") {
    System.notify("qrnode", "build sem Bluetooth (malha) - sem pra quem entregar");
} else {
    // rede padrao "celer" EXPLICITA: no sem vidro nao tem Matilha para trocar
    // a rede, e um net antigo persistido (bancada usou "bench") o isolaria
    //
    // Uplink ANTES da malha: no ESP32 classico WiFi e NimBLE dividem o radio
    // e, no boot frio com credenciais validas, a associacao WiFi perde a
    // corrida se a malha (e a camera) sobem junto (bancada 2026-10-11: a cam
    // nunca associava com o app antigo subindo tudo de uma vez). Espera ate
    // 45 s; sem AP o no segue so na malha depois do timeout.
    var tw0 = System.millis();
    while (!System.isWiFiActive() && System.millis() - tw0 < 45000) System.delay(1000);
    note("wifi " + (System.isWiFiActive() ? "ok (" + System.getIPAddress() + ")" : "ausente apos 45 s - sigo na malha"));
    CelerNet.start({ name: "qrnode", net: "celer" });
    note("QrNode 0.2 no ar (id " + Pack.me().id + ", cfg to=" + cfg.to +
         " vga=" + cfg.vga + " iv=" + cfg.iv + (cfg.paused ? " PAUSADO" : "") + ")");
    // o BEAT do gateway leva ~3 s para chegar: espera ate 10 s por ele
    // (pump: comandos ja sao aceitos durante a espera)
    var tw = System.millis();
    while (gateway() === null && System.millis() - tw < 10000) pump(250);
    meshDump();
    // ping de boas-vindas em CADA hub ouvido: o que responder roda a
    // Bilheteria (so ela faz pong) e vira o gateway preferencial (gwId)
    var hs = hubs();
    for (var hi = 0; hi < hs.length; hi++) {
        g_pong = -1;
        var t0 = System.millis();
        Pack.send(hs[hi].id, { t: "ping" }, { urgent: true });
        while (g_pong === -1 && System.millis() - t0 < 3000) pump(120);
        note("ping " + hs[hi].name + ": " + (g_pong === -1 ? "sem resposta" : (g_pong - t0) + " ms") +
             (g_pong === -1 ? "" : " -> gateway"));
        if (g_pong !== -1) break;
    }
    var lastStat = System.millis();
    var lastMesh = System.millis();
    // Watchdog de uplink: se o WiFi caiu (AP sumiu, coexistencia perdeu o
    // radio p/ NimBLE+camera), a REASSOCIACAO com a malha no ar nao vence
    // (bancada 2026-10-11: no ficou offline ate um reboot manual). Sem
    // uplink por 90 s tendo associado antes = reboot: o boot wifi-first
    // (45 s de radio exclusivo) recupera.
    var lastWifiOk = System.millis();
    var everWifi = false;
    while (true) {
        pump(0);
        if (System.isWiFiActive()) { lastWifiOk = System.millis(); everWifi = true; }
        else if (everWifi && System.millis() - lastWifiOk > 90000) {
            note("uplink caiu ha 90 s - reboot para recuperar (wifi-first)");
            System.delay(300);
            System.restart();
        }
        if (System.millis() - lastStat > STAT_MS) {
            sendStat();
            lastStat = System.millis();
        }
        if (System.millis() - lastMesh > MESHLOG_MS) {
            meshDump();
            lastMesh = System.millis();
        }
        if (cfg.paused) {
            pump(300);  // pausado: so obedece comandos/telemetria
            continue;
        }
        counters.scans += 1;
        var code = Camera.scanQR({ timeoutMs: cfg.to, led: cfg.led !== 0, vga: cfg.vga !== 0 });
        if (code !== null) {
            // 1 flash de 240 ms = "li": separa camera de malha sem log nenhum
            // (abaixo dos 250 ms o teto termico do LED nao impoe resfriamento,
            // entao o veredito pisca logo depois)
            Camera.led(true);
            System.delay(240);
            Camera.led(false);
            counters.reads += 1;
            lastCode = code;
            note("qr lido: " + code);
            System.delay(400);
            var v = deliver(code);
            if (v !== null) {
                counters.dl += 1;
                note("veredito: " + (v.valid ? "VALIDO" : "INVALIDO") + " - " + (v.info || ""));
                blink(v.valid ? 3 : 6);  // sem piscada extra = gateway nao respondeu
            }
        }
        System.delay(cfg.iv);  // respiro entre leituras (e ponto de cedida)
    }
}
