// Servidores — carrossel. Cada pagina e uma maquina (sistema, memoria,
// processador, temperatura, placa de video e, se houver, containers).
// A leitura chega de um JSON no aparelho, renovado a cada 30 s. O fonte
// nao guarda endereco nenhum. ES5 puro.

var A = require("celeros.app");
require("celeros.app.kit");
require("celeros.app.style");

A.init();
var T = A.style.T;

var ROW = 40;
var PAGE_PADRAO = 15;
var POLL_PADRAO = 60;

var servers = [];
var statusUrl = "";
var docAt = 0;
var pollMs = POLL_PADRAO * 1000;
var pageMs = PAGE_PADRAO * 1000;
var page = 0;
var origin = 0;
var pageAt = 0;
var gesture = null;
var pendente = false;
var want = false;
var nextAt = 0;
var falhou = false;
var selSrv = 0;
var selIdx = -1;
var vista = null;
var vistaPage = -1;

function faixa(n, def, lo, hi) {
    if (typeof n !== "number" || !isFinite(n)) return def;
    n = n | 0;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}
function httpUrl(s) {
    if (typeof s !== "string" || s.length < 8 || s.length > 180) return "";
    if (s.indexOf("https://") !== 0 && s.indexOf("http://") !== 0) return "";
    return s;
}
function txt(s, n) {
    if (typeof s !== "string") return "";
    var o = "";
    var i, ch;
    for (i = 0; i < s.length && o.length < n; i++) {
        ch = s.charAt(i);
        if (ch >= " " && ch <= "\u00ff") o += ch;
    }
    return o;
}
function num(v) {
    if (typeof v !== "number" || !isFinite(v)) return null;
    return v | 0;
}
function saude(h) {
    if (h === "healthy") return { kind: "ok", word: "Saudável" };
    if (h === "running") return { kind: "ok", word: "No ar" };
    if (h === "unhealthy") return { kind: "bad", word: "Doente" };
    if (h === "exited") return { kind: "dim", word: "Parado" };
    return { kind: "dim", word: "Sem leitura" };
}
function cor(kind) {
    if (kind === "ok") return A.list.badge("ok");
    if (kind === "bad") return A.list.badge("warn");
    if (kind === "down") return A.list.badge("err");
    return A.list.badge("dim");
}
function ponto(x, y, kind) {
    var c = cor(kind);
    if (System.fillSmoothCircle) System.fillSmoothCircle(x, y, 6, c);
    else System.fillCircle(x, y, 6, c);
}
function gb(mb) {
    if (mb === null || typeof mb !== "number") return "";
    if (mb >= 10240) return Math.round(mb / 1024) + " GB";
    if (mb >= 1024) {
        var d = Math.round(mb / 102.4);
        var w = Math.floor(d / 10);
        var f = d % 10;
        if (!f) return w + " GB";
        return w + "." + f + " GB";
    }
    return mb + " MB";
}
function prepGpu(g) {
    if (!g) return null;
    return {
        name: txt(g.name, 22) || "GPU",
        kind: g.kind === "integrada" ? "integrada" : "dedicada",
        tempC: num(g.tempC),
        util: num(g.util),
        memUsedMb: num(g.memUsedMb),
        memTotalMb: num(g.memTotalMb)
    };
}
function prepCtr(c) {
    var h = c && c.health;
    if (h !== "healthy" && h !== "running" && h !== "unhealthy" && h !== "exited") h = "exited";
    return {
        name: txt(c && c.name, 40) || "container",
        health: h,
        disk: txt(c && c.disk, 28)
    };
}
function prepServer(raw) {
    var gpus = [];
    var ctrs = [];
    var i;
    if (raw.gpus && raw.gpus.length) {
        for (i = 0; i < raw.gpus.length && gpus.length < 6; i++) {
            var g = prepGpu(raw.gpus[i]);
            if (g) gpus.push(g);
        }
    }
    if (raw.containers && raw.containers.length) {
        for (i = 0; i < raw.containers.length && ctrs.length < 40; i++) ctrs.push(prepCtr(raw.containers[i]));
    }
    return {
        name: txt(raw.name, 28) || "Servidor",
        os: txt(raw.os, 40),
        cpu: txt(raw.cpu, 28),
        cores: num(raw.cores),
        ramUsedMb: num(raw.ramUsedMb),
        ramTotalMb: num(raw.ramTotalMb),
        diskUsedMb: num(raw.diskUsedMb),
        diskTotalMb: num(raw.diskTotalMb),
        tempC: num(raw.tempC),
        load: txt(raw.load, 8),
        up: raw.up !== false,
        docker: !!raw.docker,
        gpus: gpus,
        containers: ctrs
    };
}
function aplica(doc) {
    if (!doc || !doc.servers || !doc.servers.length) return false;
    var lista = [];
    var i;
    for (i = 0; i < doc.servers.length && lista.length < 12; i++) lista.push(prepServer(doc.servers[i]));
    servers = lista;
    if (typeof doc.at === "number") docAt = doc.at | 0;
    if (typeof doc.pageSec === "number") pageMs = faixa(doc.pageSec, PAGE_PADRAO, 3, 120) * 1000;
    if (typeof doc.pollSec === "number") pollMs = faixa(doc.pollSec, POLL_PADRAO, 10, 300) * 1000;
    if (page >= servers.length) page = 0;
    return true;
}
function prende() {
    if (!servers.length) {
        vista = null;
        vistaPage = -1;
        return;
    }
    if (page < 0 || page >= servers.length) page = 0;
    var s = servers[page];
    var cs = [];
    var gs = [];
    var i;
    for (i = 0; i < s.containers.length; i++) cs.push(s.containers[i]);
    for (i = 0; i < s.gpus.length; i++) gs.push(s.gpus[i]);
    vista = {
        name: s.name, os: s.os, cpu: s.cpu, cores: s.cores,
        ramUsedMb: s.ramUsedMb, ramTotalMb: s.ramTotalMb,
        diskUsedMb: s.diskUsedMb, diskTotalMb: s.diskTotalMb,
        tempC: s.tempC, load: s.load, up: s.up, docker: s.docker,
        gpus: gs, containers: cs
    };
    vistaPage = page;
}
function carrega() {
    var raw = A.data.load(A.data.file("config.json"), null);
    pollMs = faixa(raw && raw.pollSec, POLL_PADRAO, 10, 300) * 1000;
    pageMs = faixa(raw && raw.pageSec, PAGE_PADRAO, 3, 120) * 1000;
    statusUrl = httpUrl(raw && raw.url);
    if (raw) aplica(raw);
}
function busca() {
    var ok = false;
    var r = null;
    if (statusUrl) {
        try {
            r = Net.fetch({ url: statusUrl, method: "GET", timeoutMs: 8000 });
        } catch (e) { r = null; }
        if (r && r.status === 200 && r.body) {
            try { if (aplica(JSON.parse(r.body))) ok = true; } catch (e2) { ok = false; }
        }
    }
    var raw = A.data.load(A.data.file("config.json"), null);
    if (raw && typeof raw.at === "number" && (raw.at | 0) !== docAt) {
        if (aplica(raw)) ok = true;
    }
    falhou = !ok;
    if (!ok && docAt) {
        var agora = 0;
        try { agora = System.epoch(); } catch (e3) { agora = 0; }
        if (agora && (agora - docAt) < (pollMs / 1000) + 20) falhou = false;
    }
}
function passoRede(now, t) {
    if (!statusUrl) return;
    if (t && t.down) return;
    if (pendente) {
        pendente = false;
        busca();
        return;
    }
    if (!want && now < nextAt) return;
    want = false;
    pendente = true;
    nextAt = now + pollMs;
}
function resumo(srv) {
    if (!srv.up) return "sem leitura nesta rodada";
    if (!srv.docker) return "sem Docker";
    var n = srv.containers.length;
    var s = 0;
    var i, h;
    for (i = 0; i < n; i++) {
        h = srv.containers[i].health;
        if (h === "healthy" || h === "running") s++;
    }
    if (!n) return "nenhum container";
    var ns = n === 1 ? "1 container" : (n + " containers");
    var ss = s === 1 ? "1 no ar" : (s + " no ar");
    return ns + " · " + ss;
}
function gpuLinha(g) {
    var t = g.name || "GPU";
    if (g.kind === "integrada") t += " integrada";
    if (typeof g.tempC === "number") t += " " + g.tempC + "°C";
    if (typeof g.util === "number") t += " " + g.util + "%";
    return t;
}
function gpuResumo(s) {
    if (!s.gpus.length) return "sem placa de vídeo";
    var ded = [];
    var integ = null;
    var i, g, igual, nome, t;
    for (i = 0; i < s.gpus.length; i++) {
        g = s.gpus[i];
        if (g.kind === "integrada") integ = g;
        else ded.push(g);
    }
    if (!ded.length) return (integ.name || "GPU") + " integrada";
    if (ded.length === 1) {
        t = gpuLinha(ded[0]);
        if (integ) t += " + integrada";
        return t;
    }
    nome = ded[0].name;
    igual = true;
    for (i = 1; i < ded.length; i++) if (ded[i].name !== nome) igual = false;
    t = igual ? (ded.length + "x " + nome) : (ded.length + " placas");
    for (i = 0; i < ded.length; i++) {
        if (typeof ded[i].tempC === "number") t += " " + ded[i].tempC + "°C";
    }
    if (integ) t += " + integrada";
    return t;
}
function linhasHost(s) {
    var o = [];
    if (!s.up) {
        o.push("Sem leitura nesta rodada.");
        return o;
    }
    if (s.os) o.push(s.os);
    var cpu = s.cpu || "";
    if (typeof s.cores === "number" && s.cores > 0) {
        cpu = cpu ? (cpu + " · " + s.cores + " núcleos") : (s.cores + " núcleos");
    }
    if (cpu) o.push(cpu);
    var ram = "";
    if (typeof s.ramTotalMb === "number") ram = gb(s.ramUsedMb) + " / " + gb(s.ramTotalMb);
    if (typeof s.tempC === "number") ram = ram ? (ram + " · " + s.tempC + "°C") : (s.tempC + "°C");
    else if (ram) ram += " · sem sensor";
    if (ram) o.push(ram);
    if (typeof s.diskTotalMb === "number") {
        o.push("disco " + gb(s.diskUsedMb) + " / " + gb(s.diskTotalMb));
    }
    o.push(gpuResumo(s));
    o.push(resumo(s));
    return o;
}
function nivel(used, total) {
    if (typeof used !== "number" || typeof total !== "number" || total <= 0) return 0;
    var f = used / total;
    if (f < 0) return 0;
    if (f > 1) return 1;
    return f;
}
function corBarra(f) {
    if (f >= 0.9) return T.err;
    if (f >= 0.75) return T.warn;
    return T.ok;
}
function barra(x, y, w, h, f, color) {
    System.fillRoundRect(x, y, w, h, 3, T.raised || T.stroke);
    var fw = Math.round(w * f);
    if (fw > 0 && fw < 4) fw = 4;
    if (fw > w) fw = w;
    if (fw > 0) System.fillRoundRect(x, y, fw, h, 3, color);
}
function srvAberto() {
    if (vista && vistaPage === selSrv) return vista;
    if (selSrv >= 0 && selSrv < servers.length) return servers[selSrv];
    return null;
}
function clampOrigin(v, count, vis) {
    var m = count - vis;
    if (m < 0) m = 0;
    if (v < 0) return 0;
    if (v > m) return m;
    return v;
}
function geom() {
    var L = A.L;
    var multi = servers.length > 1;
    var dots = multi ? 14 : 0;
    var cardY = L.top;
    var cardH = (multi ? L.bottom - 22 : L.bottom - 8) - cardY;
    if (cardH < 168) cardH = 168;
    var listY = cardY + cardH + 4;
    var listH = (L.bottom - dots) - 4 - listY;
    if (listH < ROW) listH = ROW;
    return {
        x: L.x, w: L.w, cx: L.cx, top: L.top, bottom: L.bottom,
        cardY: cardY, cardH: cardH,
        listY: listY, listH: listH, dotY: L.bottom - 8, multi: multi,
        vis: Math.floor(listH / ROW)
    };
}
function troca(dir) {
    var n = servers.length;
    if (n < 2) return;
    var np = page + dir;
    if (np >= n) np = 0;
    else if (np < 0) return;
    page = np;
    origin = 0;
    pageAt = System.millis();
    UI.invalidate();
}
function gesto(t, count, vis) {
    if (!t) return null;
    if (t.released) {
        var g = gesture;
        gesture = null;
        return {
            dx: t.x - (g ? g.sx : t.sx),
            dy: t.y - (g ? g.sy : t.sy),
            x: t.x,
            y: t.y,
            sy: g ? g.sy : t.sy,
            ms: System.millis() - (g ? g.t0 : System.millis()),
            origin0: g ? g.origin0 : origin
        };
    }
    if (t.down) {
        if (!gesture) gesture = { sx: t.sx, sy: t.sy, origin0: origin, t0: System.millis() };
        var dx = t.x - gesture.sx;
        var dy = t.y - gesture.sy;
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
            var novo = clampOrigin(gesture.origin0 - Math.round(dy / ROW), count, vis);
            if (novo !== origin) {
                origin = novo;
                UI.invalidate();
            }
        } else if (origin !== gesture.origin0) {
            origin = gesture.origin0;
            UI.invalidate();
        }
    } else gesture = null;
    return null;
}
function pintaPontos(g) {
    var n = servers.length;
    if (n < 2) return;
    System.fillRect(g.x, g.dotY - 6, g.w, 14, T.bg);
    var d = 3;
    var activeW = 16;
    var gap = 6;
    var total = (n - 1) * (d * 2 + gap) + activeW;
    var x = g.cx - Math.floor(total / 2);
    var i, w;
    for (i = 0; i < n; i++) {
        w = i === page ? activeW : d * 2;
        System.fillRoundRect(x, g.dotY - d, w, d * 2, d, i === page ? T.accent : T.stroke);
        x += w + gap;
    }
}

function desenhaRefresh(x, y, s, cor) {
    if (System.fillArc) {
        System.fillArc(x + s * 0.5, y + s * 0.5, s * 0.28, s * 0.36, -60, 240, cor);
    }
    System.fillTriangle(x + s * 0.62, y + s * 0.10, x + s * 0.86, y + s * 0.22,
                        x + s * 0.68, y + s * 0.34, cor);
}
function botaoAtualizar(full) {
    var x = 206, y = 6, s = 28;
    if (full) {
        System.fillRoundRect(x, y, s, s, 14, T.raised || T.card);
        desenhaRefresh(x + 4, y + 4, 20, pendente ? T.accent : T.text);
    }
    var t = UI.touch();
    if (!t || !t.released) return false;
    if (t.x < x || t.y < y || t.x >= x + s || t.y >= y + s) return false;
    if (Math.abs(t.x - t.sx) >= 18 || Math.abs(t.y - t.sy) >= 18) return false;
    pageAt = System.millis();
    if (!A.net.online()) {
        if (!A.wifiWait("Ligue o Wi-Fi para atualizar a leitura.")) return true;
    }
    want = true;
    nextAt = 0;
    return false;
}

function scrPage(c) {
    if (c.entered) {
        pageAt = c.now;
        origin = 0;
        gesture = null;
    }
    var t = UI.touch();
    passoRede(c.now, t);
    if (!servers.length) {
        A.header("Servidores", { back: false });
        botaoAtualizar(c.full);
        var L0 = A.L;
        UI.text("Nenhuma leitura no aparelho.", L0.x, L0.top + 8, { w: L0.w, lines: 2 });
        UI.text("O painel consulta a cada 1 minuto.",
                L0.x, L0.top + 56, { role: "caption", color: T.textDim, w: L0.w, lines: 3 });
        return;
    }
    if (page < 0 || page >= servers.length) page = 0;
    if (c.entered || vistaPage !== page) prende();
    var srv = vista || servers[page];
    var g = geom();
    A.header("Servidores", { back: false });
    if (botaoAtualizar(c.full)) return;

    var st = srv.up ? { kind: "ok", word: "No ar" } : { kind: "down", word: "Sem resposta" };
    var cpu = srv.cpu || "";
    if (typeof srv.cores === "number" && srv.cores > 0) {
        cpu = cpu ? (cpu + " · " + srv.cores + " núcleos") : (srv.cores + " núcleos");
    }
    if (typeof srv.tempC === "number") cpu = cpu ? (cpu + " · " + srv.tempC + "°C") : (srv.tempC + "°C");
    else if (cpu) cpu += " · sem sensor";
    var frRam = nivel(srv.ramUsedMb, srv.ramTotalMb);
    var frDisco = nivel(srv.diskUsedMb, srv.diskTotalMb);
    var count = srv.containers.length;
    var linhaCtr = !srv.up ? "" : (!srv.docker ? "Sem Docker" : (count ? resumo(srv) : "Nenhum container."));
    A.style.card(g.x, g.cardY, g.w, g.cardH, {
        full: c.full, elev: 1,
        draw: function (r) {
            var altTitulo = UI.lineHeight("title");
            var yOs = altTitulo + 6;
            var yCorpo = yOs + UI.lineHeight("caption") + 10;
            var fim = r.h - 18;
            var vao = fim - yCorpo;
            if (vao < 96) vao = 96;
            var yRam = yCorpo;
            var yDisk = yCorpo + Math.floor(vao * 0.30);
            var yCpu = yCorpo + Math.floor(vao * 0.58);
            var yGpu = yCorpo + Math.floor(vao * 0.78);
            UI.text(srv.name, r.x, r.y, { role: "title", w: r.w - 22, lines: 1, bg: r.bg });
            ponto(r.x + r.w - 8, r.y + Math.floor(altTitulo / 2), st.kind);
            if (srv.os) {
                UI.text(srv.os, r.x, r.y + yOs, {
                    role: "caption", color: T.textDim, w: r.w, lines: 1, bg: r.bg
                });
            }
            if (typeof srv.ramTotalMb === "number") {
                UI.text("RAM  " + gb(srv.ramUsedMb) + " / " + gb(srv.ramTotalMb),
                        r.x, r.y + yRam, { role: "caption", w: r.w, lines: 1, bg: r.bg });
                if (c.full) barra(r.x, r.y + yRam + 16, r.w, 10, frRam, corBarra(frRam));
            }
            if (typeof srv.diskTotalMb === "number") {
                UI.text("Disco  " + gb(srv.diskUsedMb) + " / " + gb(srv.diskTotalMb),
                        r.x, r.y + yDisk, { role: "caption", w: r.w, lines: 1, bg: r.bg });
                if (c.full) barra(r.x, r.y + yDisk + 16, r.w, 10, frDisco, corBarra(frDisco));
            }
            if (cpu) {
                UI.text(cpu, r.x, r.y + yCpu, {
                    role: "caption", color: T.textDim, w: r.w, lines: 1, bg: r.bg
                });
            }
            UI.text(gpuResumo(srv), r.x, r.y + yGpu, {
                role: "caption", color: T.textDim, w: r.w, lines: 1, bg: r.bg
            });
            if (linhaCtr) {
                UI.text(linhaCtr, r.x, r.y + fim, {
                    role: "caption", color: T.text, w: r.w, lines: 1, bg: r.bg
                });
            }
        }
    });

    pintaPontos(g);

    var ev = gesto(t, 0, 1);
    if (ev) {
        var adx = Math.abs(ev.dx);
        var ady = Math.abs(ev.dy);
        var horiz = adx > ady && (adx >= 60 || (ev.ms <= 700 && adx >= 36));
        if (horiz && ev.sy >= g.top) {
            origin = 0;
            pageAt = c.now;
            if (ev.dx < 0) troca(1);
            else if (ev.dx > 0) troca(-1);
        } else if (adx < 18 && ady < 18 && count && ev.y >= g.cardY && ev.y < g.cardY + g.cardH) {
            selSrv = page;
            selIdx = -1;
            origin = 0;
            return "lista";
        }
    }
    if (t && (t.down || t.released)) pageAt = c.now;
    if (servers.length > 1 && !(t && t.down) && !gesture) {
        if (c.now - pageAt >= pageMs) {
            page = (page + 1) % servers.length;
            origin = 0;
            pageAt = c.now;
            UI.invalidate();
        }
    }
}

function pintaContainer(box, x, y, w, full) {
    var hs = saude(box.health);
    A.style.card(x, y, w, 64, {
        full: full, elev: 1,
        draw: function (r) {
            var altNome = UI.lineHeight("body");
            UI.text(box.name, r.x, r.y, { w: r.w - 22, lines: 1, bg: r.bg });
            ponto(r.x + r.w - 8, r.y + Math.floor(altNome / 2), hs.kind);
            UI.text(box.disk || "dinâmico", r.x, r.y + altNome + 4, {
                role: "caption", color: T.textDim, w: r.w, lines: 1, bg: r.bg
            });
        }
    });
}

function scrLista(c) {
    if (c.entered) {
        origin = 0;
        gesture = null;
    }
    var srv = srvAberto();
    if (!srv) return A.BACK;
    var n = srv.containers.length;
    var sub = n === 1 ? "1 container" : (n + " containers");
    if (A.header(srv.name, { sub: sub })) return A.BACK;
    var t = UI.touch();
    if (t && (t.down || t.released)) pageAt = System.millis();
    passoRede(c.now, t);
    var L = A.L;
    var listY = L.top;
    var passo = 72;
    var vis = Math.floor((L.bottom - listY) / passo);
    if (vis < 1) vis = 1;
    origin = clampOrigin(origin, n, vis);
    var i, y;
    if (!n) {
        UI.text(srv.docker ? "Nenhum container." : "Sem Docker nesta máquina.",
                L.x, listY + 8, { role: "caption", color: T.textDim, w: L.w, lines: 2 });
    }
    for (i = 0; i < vis && origin + i < n; i++) {
        y = listY + i * passo;
        pintaContainer(srv.containers[origin + i], L.x, y, L.w, c.full);
    }
    var ev = gesto(t, n, vis);
    if (ev) {
        var adx = Math.abs(ev.dx);
        var ady = Math.abs(ev.dy);
        if (adx < 18 && ady < 18 && n && ev.y >= listY && ev.y < listY + vis * passo) {
            var idx = origin + Math.floor((ev.y - listY) / passo);
            if (idx >= 0 && idx < n) {
                selIdx = idx;
                return "det";
            }
        }
    }
}

function scrDet(c) {
    var srv = srvAberto();
    if (!srv) return A.BACK;
    var box = selIdx < 0 ? null : srv.containers[selIdx];
    if (selIdx >= 0 && !box) return A.BACK;
    var sub = selIdx < 0 ? "Máquina" : srv.name;
    var titulo = box ? box.name : srv.name;
    if (A.header(titulo, { sub: sub })) return A.BACK;
    var t = UI.touch();
    passoRede(c.now, t);
    var g = geom();
    if (!box) {
        var linhas = linhasHost(srv);
        if (srv.load) linhas.push("carga " + srv.load);
        var gi;
        for (gi = 0; gi < srv.gpus.length; gi++) linhas.push(gpuLinha(srv.gpus[gi]));
        A.style.card(g.x, g.top, g.w, 200, {
            full: c.full, elev: 1,
            draw: function (r) {
                var i;
                for (i = 0; i < linhas.length && i < 10; i++) {
                    UI.text(linhas[i], r.x, r.y + i * 16, {
                        role: "caption", color: i === 0 ? T.text : T.textDim,
                        w: r.w, lines: 1, bg: r.bg
                    });
                }
            }
        });
        return;
    }
    var hs = saude(box.health);
    A.style.card(g.x, g.top, g.w, 120, {
        full: c.full, elev: 1,
        draw: function (r) {
            ponto(r.x + r.w - 8, r.y + 8, hs.kind);
            UI.text(srv.docker ? "Container Docker" : "Processo", r.x, r.y + 28, {
                role: "caption", color: T.textDim, w: r.w, bg: r.bg
            });
            UI.text(box.disk || "dinâmico", r.x, r.y + 48, {
                w: r.w, lines: 2, bg: r.bg
            });
        }
    });
}

carrega();
pageAt = System.millis();
nextAt = 0;
want = !!statusUrl;
A.run({ page: scrPage, lista: scrLista, det: scrDet }, "page", { fps: 20 });
