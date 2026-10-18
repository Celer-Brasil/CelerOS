// CelerOS Watchface — relogio de pulso / relogio de mesa (API 30)
// ES5 puro (Duktape). Tela cheia (topbar:false): o canvas virtual 240x320
// escala para o vidro de cada placa (412x502 do watch, 480x480 da 4", ou a
// faixa da CYD).
//
// Migrado para o CelerKit (deps celeros.app + fmt + data): o laco, o ritmo
// e o frame sao do A.run do kit (o app NAO chama UI.begin/UI.end) e o toque
// do frame chega por UI.touch (o UI.begin do kit ja consome o pump — um
// consumidor por loop). O DESENHO do mostrador segue cru e fps-sensivel:
// assinatura de estado decide o redesenho, papel de parede desenha uma vez
// (e redesenha quando o vidro pede frame total, c.full — antes o fundo
// ficava apagado ate reiniciar o relogio), ritmo de ~7 fps como o delay(150)
// de antes.
//
// Tres estilos (toque longo troca; guardado no Storage do app):
//   0 digital  — hora grande, data, bateria, passos com meta, complicacoes;
//   1 analogico — mostrador com ponteiros (compensa a escala nao uniforme
//                 com getInfo().screenW/H);
//   2 minimo   — so hora e data, quase nada aceso (AMOLED agradece).
//
// Complicacoes (feature-detect, firmware antigo segue funcionando): bateria
// em % e carregando (batteryInfo), passos x meta (System.setting
// "step_goal"), proximo alarme / timer (System.alarms/getTimer), nao lidas
// (unreadNotifications), clima do celular com temperatura (Phone.weather,
// Gadgetbridge), musica tocando (Phone.musicInfo) e estado do link com o
// celular (Phone.status). O rodape alterna: timer > musica > clima > "sem
// celular". A trilha de segundos ganhou o numero do segundo. O analogico
// ganhou arcos de bateria e de progresso de passos (sem plugin na banda).
//
// Plugins de watchface (API 16): apps instalados podem registrar um widget
// — um arquivo watchface.js na pasta do app OU no appData dele
// (/local/data/<pkg>/watchface.js; a loja instala so main.js/app.json, entao
// o app escreve o plugin no proprio appData na primeira execucao). O
// watchface reescaneia a cada 30 s, avalia cada arquivo dentro de funcao
// (o plugin termina em "return {...}") e da a ele uma linha na banda de
// widgets (estilos digital e analogico; o minimo fica limpo de proposito).
// Plugin com erro de avaliacao/desenho e dispensado ate o proximo scan —
// nunca derruba o relogio. Toque na linha com "open" abre o app do plugin
// (System.launchApp). Com plugin ativo, o clima do celular sai da rodape.
//
// Wallpaper: com /sd/wallpaper.png o estilo digital desenha o PNG UMA vez e
// redesenha so os elementos em "pills" opacas por cima (frame total do
// vidro redesenha a parede — c.full).
//
// Gestos: arrastar para cima no meio da tela abre o launcher. No relogio as
// bordas sao do sistema (cima: ajustes rapidos; baixo: notificacoes).

var A = require("celeros.app");
require("celeros.app.fmt");
require("celeros.app.data");
A.init();

var INFO = {};
try { INFO = System.getInfo() || {}; } catch (e) { INFO = {}; }
var INS = INFO.inset || 0;
var TOPY = 10 + Math.round(INS / 2);
// vidro grande (watch/4"): digitos de 75 px (fonte 8); senao a 24 px (4)
var BIGF = (INFO.screenW || 240) >= 400 ? 8 : 4;
var BOTY = 310 - Math.round(INS / 2);

var HAS_BATI = typeof System.batteryInfo === "function";
var HAS_ALARMS = typeof System.alarms === "function";
var HAS_TIMER = typeof System.getTimer === "function";
var HAS_UNREAD = typeof System.unreadNotifications === "function";
var HAS_PHONE = typeof Phone !== "undefined" && Phone && typeof Phone.weather === "function";
var HAS_LAUNCH = typeof System.launchApp === "function";
var hasImu = false;
try { hasImu = (typeof Sensors !== "undefined") && Sensors && Sensors.steps() >= 0; } catch (e) { hasImu = false; }

var DIA = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SAB"];
var WALL = "/sd/wallpaper.png";
var hasWall = false;

// estilo guardado via celeros.app.data (valores antigos "0"/"1"/"2" no
// Storage continuam validos: JSON.parse aceita o numero cru)
var style = A.data.loadState("style", 0);
if (!(style >= 0 && style <= 2)) style = 0;

function stepGoal() {
    var g = 0;
    try { g = parseInt(System.setting("step_goal"), 10); } catch (e) { g = 0; }
    return g > 0 ? g : 8000;
}
var goal = stepGoal();

// ---- plugins de watchface (API 16) ------------------------------------------
// Contrato do watchface.js do app (avaliado dentro de funcao):
//   return {
//     id: "celeros.previsao",               // unico; dedup entre as origens
//     sig: function () { return "..."; },   // op.; string barata, muda=redesenha
//     line: function () { return "..."; },  // texto simples (ou draw abaixo)
//     draw: function (x, y, w, h, bg) {},   // desenha a linha; bg=pill ou null
//     open: "celeros.previsao"              // op.; toque na linha abre o app
//   };

var PLUG_MAX = 2;                 // linhas na banda (digital: 258..280, 232..254)
var plugins = [];                 // descritores ativos, na ordem desenhada
var plugDead = {};                // ids que erraram nesta sessao (ate o proximo scan)
var plugAt = 0;                   // ultimo scan
var plugKey = "";                 // ids carregados; mudou = repaint cheio
var plugDirty = false;            // plugin morto em voo: repaint na proxima volta

function killPlugin(p) {
    if (p.dead) return;
    p.dead = true;
    if (p.id) plugDead[p.id] = 1;
    plugDirty = true;
}

function loadPluginFile(path) {
    try {
        if (!FS.exists(path) || FS.isDirectory(path)) return null;
        var src = FS.readTextFile(path);
        if (!src || src.length > 8192) return null;
        // "return {...}" no topo do arquivo: eval dentro de funcao
        var obj = eval("(function(){\n" + src + "\n})()");
        if (!obj || !obj.id || (typeof obj.draw !== "function" && typeof obj.line !== "function"))
            return null;
        return obj;
    } catch (e) { return null; }
}

function scanPlugins() {
    plugins = [];
    var seen = {};
    var roots = ["/local/apps", "/sd/apps", "/local/data"];
    for (var ri = 0; ri < roots.length && plugins.length < PLUG_MAX; ri++) {
        var dirs = [];
        try { dirs = FS.listDir(roots[ri]); } catch (e) { dirs = []; }
        for (var i = 0; i < dirs.length && plugins.length < PLUG_MAX; i++) {
            var d = loadPluginFile(dirs[i] + "/watchface.js");
            if (d && !seen[d.id] && !plugDead[d.id]) {
                seen[d.id] = 1;
                plugins.push(d);
            }
        }
    }
    var key = "";
    for (var k = 0; k < plugins.length; k++) key += plugins[k].id + "~";
    var changed = key !== plugKey;
    plugKey = key;
    return changed;
}

function pluginRect(i) {
    return { x: 36, y: BOTY - 52 - i * 26, w: 168, h: 22 };
}

function drawPlugin(p, i, bg) {
    var r = pluginRect(i);
    if (bg !== null) System.fillRoundRect(r.x, r.y, r.w, r.h, 8, bg);
    if (typeof p.draw === "function") {
        try { p.draw(r.x, r.y, r.w, r.h, bg); } catch (e) { killPlugin(p); }
        return;
    }
    var s = "";
    try { s = p.line() || ""; } catch (e) { killPlugin(p); s = ""; }
    if (s) {
        System.setTextColor(A.T.textDim);
        System.drawString(s, Math.round((240 - System.textWidth(s, 2)) / 2), r.y + 3, 2);
    }
}

function drawPlugins(bg) {
    for (var i = 0; i < plugins.length; i++) drawPlugin(plugins[i], i, bg);
}

function tapPlugins(x, y) {
    for (var i = 0; i < plugins.length; i++) {
        var p = plugins[i];
        var r = pluginRect(i);
        if (p.open && HAS_LAUNCH && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
            System.launchApp(p.open);  // sai pelo caminho limpo; launcher abre o alvo
            return true;
        }
    }
    return false;
}

// assinatura dos plugins para o sigOf (o plugin controla o custo do sig())
function plugSig() {
    var out = [];
    for (var i = 0; i < plugins.length; i++) {
        var v = "";
        try {
            if (typeof plugins[i].sig === "function") v = String(plugins[i].sig() || "");
        } catch (e) { killPlugin(plugins[i]); v = "x"; }
        out.push(v);
    }
    return out.join("~");
}

function ctext(s, y, font, color) {
    System.setTextColor(color);
    System.drawString(s, Math.round((240 - System.textWidth(s, font)) / 2), y, font);
}

// ---- leitura do estado (uma "assinatura" decide o redesenho) ---------------

var S = {};
function readState() {
    var n = {};
    n.time = System.getTime();
    n.sec = System.getSeconds();
    n.date = System.getDate();
    n.wd = System.getWeekday ? System.getWeekday() : -1;
    n.pct = -1;
    n.chg = false;
    if (HAS_BATI) {
        var b = System.batteryInfo();
        if (b) { n.pct = b.pct; n.chg = b.charging; }
    } else {
        var mv = System.battery ? System.battery() : -1;
        if (mv > 3000) n.pct = Math.max(0, Math.min(100, Math.round((mv - 3300) / 9)));
    }
    n.steps = hasImu ? Sensors.steps() : -1;
    n.unread = HAS_UNREAD ? System.unreadNotifications() : 0;
    n.alarm = "";
    if (HAS_ALARMS) {
        var l = System.alarms(), best = 0;
        for (var i = 0; i < l.length; i++) {
            if (l[i].next > 0 && (best === 0 || l[i].next < best)) {
                best = l[i].next;
                n.alarm = A.fmt.pad2(l[i].hour) + ":" + A.fmt.pad2(l[i].minute);
            }
        }
    }
    n.timer = "";
    if (HAS_TIMER) {
        var t = System.getTimer();
        if (t && t.remaining > 0) n.timer = Math.floor(t.remaining / 60) + ":" + A.fmt.pad2(t.remaining % 60);
    }
    n.wx = "";
    n.music = "";
    n.link = "";
    if (HAS_PHONE) {
        try {
            var w = Phone.weather();
            if (w && typeof w.temp === "number") n.wx = Math.round(w.temp) + "°C " + (w.txt || "");
        } catch (e) { n.wx = ""; }
        try {
            if (typeof Phone.musicInfo === "function") {
                var mi = Phone.musicInfo();
                if (mi && mi.state === "play" && mi.track) n.music = mi.track;
            }
            if (typeof Phone.status === "function") {
                var st = Phone.status();
                if (st && st.enabled && !st.connected) n.link = "sem celular";
            }
        } catch (e) { n.music = ""; n.link = ""; }
    }
    n.plug = plugSig();
    return n;
}

// Hora em numeros (getTime pode vir "07:05" ou "7:05 PM")
function hm(s) {
    var p = s.split(":");
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    if (s.indexOf("PM") >= 0 && h < 12) h += 12;
    if (s.indexOf("AM") >= 0 && h === 12) h = 0;
    return [h, m];
}

// ---- pecas comuns -----------------------------------------------------------

function batteryText(n) {
    if (n.pct < 0) return "";
    return (n.chg ? "+" : "") + n.pct + "%";
}
function batteryColor(n) {
    if (n.chg) return A.T.ok;
    return n.pct <= 15 ? A.T.err : A.T.textDim;
}

// Linha de status no topo: bateria, nao lidas, alarme
function drawStatus(n, bg) {
    var bt = batteryText(n);
    if (bg !== null) System.fillRoundRect(40, TOPY, 160, 20, 8, bg);
    var x = 120;
    var items = [];
    if (bt) items.push([bt, batteryColor(n)]);
    if (n.unread > 0) items.push([n.unread + (n.unread === 1 ? " nova" : " novas"), A.T.accent]);
    if (n.alarm) items.push(["AL " + n.alarm, A.T.textDim]);
    var total = 0, i;
    for (i = 0; i < items.length; i++) total += System.textWidth(items[i][0], 1) + (i ? 10 : 0);
    x = Math.round(120 - total / 2);
    for (i = 0; i < items.length; i++) {
        System.setTextColor(items[i][1]);
        System.drawString(items[i][0], x, TOPY + 6, 1);
        x += System.textWidth(items[i][0], 1) + 10;
    }
}

// Barra de passos x meta
function drawSteps(n, y, bg) {
    if (n.steps < 0) return;
    if (bg !== null) System.fillRoundRect(36, y - 4, 168, 34, 10, bg);
    ctext(n.steps + " / " + goal + " passos", y, 1, A.T.textDim);
    var w = Math.min(150, Math.round(150 * n.steps / goal));
    System.fillRoundRect(45, y + 14, 150, 8, 4, A.T.card);
    if (w > 6) System.fillRoundRect(45, y + 14, w, 8, 4, n.steps >= goal ? A.T.ok : A.T.accent);
}

// Corta com ".." para caber em maxW (rodape com faixa/musica longas)
function trunc(s, font, maxW) {
    if (System.textWidth(s, font) <= maxW) return s;
    while (s.length > 1 && System.textWidth(s + "..", font) > maxW) s = s.substring(0, s.length - 1);
    return s + "..";
}

// Linha de baixo: timer > musica tocando > clima do celular > sem celular
// (o clima sai quando ha plugin, que ocupa a banda de widgets logo acima).
// Tudo passa pelo trunc(): texto maior que a pilula vazava nas bordas.
function drawFooter(n, bg) {
    var s = "", col = A.T.textDim;
    if (n.timer) { s = trunc("Timer " + n.timer, 2, 152); col = A.T.warn; }
    else if (n.music) { s = trunc(n.music, 2, 152); col = A.T.accent; }
    else if (!plugins.length && n.wx) { s = trunc(n.wx, 2, 152); }
    else if (n.link) { s = trunc(n.link, 2, 152); }
    if (bg !== null && s) System.fillRoundRect(40, BOTY - 26, 160, 22, 8, bg);
    if (s) ctext(s, BOTY - 22, 2, col);
}

// ---- estilo 0: digital ------------------------------------------------------

function digitalAll(n) {
    if (!hasWall) System.fillRect(0, 0, 240, 320, A.T.bg);
    // com hasWall a parede JA esta no vidro (repaintFull desenhou agora):
    // so os elementos, em pills opacas
    var bg = hasWall ? A.T.bg : null;
    drawStatus(n, bg);
    digitalClock(n, bg);
    drawSteps(n, 206, bg);
    if (plugins.length < 2) digitalBar(n, bg);  // 2 plugins ocupam a faixa da trilha
    drawFooter(n, bg);
    if (plugins.length) drawPlugins(bg);
}
function digitalClock(n, bg) {
    if (bg !== null) System.fillRoundRect(26, 70, 188, 110, 12, bg);
    var t = n.time, suf = "";
    var sp = t.indexOf(" ");
    if (sp > 0) { suf = t.substring(sp + 1); t = t.substring(0, sp); }
    ctext(t, BIGF === 8 ? 84 : 96, BIGF, A.T.text);
    if (suf) ctext(suf, 134, 1, A.T.textDim);
    var d = (n.wd >= 0 ? DIA[n.wd] + "  " : "") + n.date.substring(0, 5);
    ctext(d, 150, 2, A.T.accent);
}
// Trilha de segundos virou pilula: progresso + o numero do segundo a direita
function digitalBar(n, bg) {
    System.fillRoundRect(46, 238, 148, 20, 10, bg !== null ? bg : A.T.card);
    System.fillRoundRect(52, 244, 94, 8, 4, hasWall && bg !== null ? A.T.card : A.T.bg);
    var prog = Math.round(94 * n.sec / 60);
    if (prog > 0) System.fillRoundRect(52, 244, prog, 8, 4, A.T.accent);
    var ss = A.fmt.pad2(n.sec);
    System.setTextColor(A.T.textDim);
    System.drawString(ss, Math.round(146 + (44 - System.textWidth(ss, 2)) / 2), 240, 2);
}

// ---- estilo 1: analogico ----------------------------------------------------

var KX = (INFO.screenW || 240) / 240, KY = (INFO.screenH || 320) / 320;
var KM = Math.min(KX, KY);
var FX = KM / KX, FY = KM / KY;   // fatores para ponto no circulo "redondo"
var CX = 120, CY = 160, R = 92;

function polar(a, r) {
    // a em graus a partir das 12h, sentido horario
    var rad = a * Math.PI / 180;
    return [CX + Math.sin(rad) * r * FX, CY - Math.cos(rad) * r * FY];
}
function hand(a, len, tail, wid, col) {
    var tip = polar(a, len), back = polar(a + 180, tail);
    var l = polar(a - 90, wid), r = polar(a + 90, wid);
    var dl = [l[0] - CX, l[1] - CY], dr = [r[0] - CX, r[1] - CY];
    System.fillTriangle(Math.round(back[0] + dl[0]), Math.round(back[1] + dl[1]),
        Math.round(back[0] + dr[0]), Math.round(back[1] + dr[1]),
        Math.round(tip[0]), Math.round(tip[1]), col);
}
// Arco de pontos (0..1 a partir das 12h, sentido horario): bateria e
// progresso de passos ao redor do mostrador
function ringArc(frac, r, col) {
    var total = 90, dots = Math.round(total * frac);
    for (var i = 0; i <= dots; i++) {
        var p = polar(-90 + (i / total) * 360, r);
        System.fillCircle(Math.round(p[0]), Math.round(p[1]), 2, col);
    }
}
function analogAll(n) {
    System.fillRect(0, 0, 240, 320, A.T.bg);
    drawStatus(n, null);
    if (!plugins.length) {  // com plugin a banda pisca sobre o arco de baixo
        if (n.steps >= 0) ringArc(Math.min(1, n.steps / goal), R + 9, A.T.accent);
        if (n.pct >= 0) ringArc(n.pct / 100, R + 15, batteryColor(n));
    }
    System.fillCircle(CX, CY, R + 6, A.T.card);
    for (var i = 0; i < 12; i++) {
        var o = polar(i * 30, R), p = polar(i * 30, i % 3 === 0 ? R - 14 : R - 7);
        System.drawLine(Math.round(o[0]), Math.round(o[1]), Math.round(p[0]), Math.round(p[1]),
            i % 3 === 0 ? A.T.text : A.T.textDim);
    }
    var d = (n.wd >= 0 ? DIA[n.wd] + " " : "") + n.date.substring(0, 2);
    System.setTextColor(A.T.accent);
    System.drawString(d, CX + 28, CY - 6, 1);
    if (n.steps >= 0) ctext(n.steps + " passos", CY + 40, 1, A.T.textDim);
    if (n.unread > 0) ctext(n.unread + (n.unread === 1 ? " nova" : " novas"), CY + 56, 1, A.T.accent);
    var x = hm(n.time);
    hand((x[0] % 12) * 30 + x[1] * 0.5, R * 0.55, 10, 5, A.T.text);
    hand(x[1] * 6 + n.sec * 0.1, R * 0.82, 12, 3, A.T.text);
    hand(n.sec * 6, R * 0.88, 16, 1, A.T.accent);
    System.fillCircle(CX, CY, 5, A.T.accent);
    drawFooter(n, null);
    if (plugins.length) drawPlugins(null);
}

// ---- estilo 2: minimo -------------------------------------------------------

function minimalAll(n) {
    System.fillRect(0, 0, 240, 320, 0);
    var t = n.time, sp = t.indexOf(" ");
    if (sp > 0) t = t.substring(0, sp);
    ctext(t, 120, 7, A.T.textDim);
    var d = (n.wd >= 0 ? DIA[n.wd] + "  " : "") + n.date.substring(0, 5);
    ctext(d, 180, 2, A.T.stroke);
    if (n.unread > 0) ctext(n.unread + (n.unread === 1 ? " nova" : " novas"), 208, 1, A.T.accent);
    var bt = batteryText(n);
    if (bt && (n.pct <= 20 || n.chg)) ctext(bt, BOTY - 18, 1, batteryColor(n));
}

// ---- laco (A.run do kit: dono do frame; a tela so desenha) ------------------

function sigOf(n) {
    // o que muda o desenho; analogico redesenha a cada segundo
    return [n.time, style === 2 ? "" : n.sec, n.date, n.pct, n.chg, n.steps, n.unread,
        n.alarm, n.timer, style === 2 ? "" : n.wx, n.music, n.link, n.plug].join("|");
}

function drawAll(n) {
    if (style === 1) analogAll(n);
    else if (style === 2) minimalAll(n);
    else digitalAll(n);
}

// frame total (entrada, troca de estilo, vidro pediu): parede incluida —
// o estilo digital re-sonda o wallpaper e desenha ele ANTES dos elementos
function repaintFull(n) {
    if (style === 0) {
        try { hasWall = FS.exists(WALL) && System.drawPNG(WALL, 0, 0); } catch (e) { hasWall = false; }
    }
    drawAll(n);
    S = n;
    lastSig = sigOf(n);
}

// troca de estilo: so estado + invalidar — o desenho acontece no proximo
// frame (o UI.begin do A.run e quem limpa a tela no frame total)
function setStyle(s) {
    style = s;
    A.data.saveState("style", s);
    hasWall = false;
    needFull = true;
    UI.invalidate();
}

scanPlugins();
var lastSig = "";
var goalAt = System.millis();
var needFull = true;                      // primeiro frame e total

var touchOn = false, downAt = 0, longDone = false;

// repaint cheio (papel de parede incluido): plugins entraram/sairam ou
// algum morreu em voo
function plugRepaint() {
    for (var di = plugins.length - 1; di >= 0; di--)
        if (plugins[di].dead) plugins.splice(di, 1);
    plugKey = "";
    for (var dk = 0; dk < plugins.length; dk++) plugKey += plugins[dk].id + "~";
    needFull = true;
    UI.invalidate();
}

A.run({
    relogio: function (c) {
        if (plugDirty) {
            plugDirty = false;
            plugRepaint();
        }
        if (System.millis() - plugAt > 30000) {  // apps instalam/desinstalam: reescaneia
            plugAt = System.millis();
            if (scanPlugins()) plugRepaint();
        }

        var n = readState();
        if (System.millis() - goalAt > 30000) {  // meta mudada no Settings
            goalAt = System.millis();
            goal = stepGoal();
        }

        if (c.full || needFull) {
            needFull = false;
            repaintFull(n);
        } else {
            var sig = sigOf(n);
            if (sig !== lastSig) {
                if (style === 0 && hasWall) {
                    // com wallpaper: so o que mudou, em pills opacas
                    if (n.time !== S.time || n.date !== S.date) digitalClock(n, A.T.bg);
                    if (n.sec !== S.sec && plugins.length < 2) digitalBar(n, A.T.bg);
                    if (n.pct !== S.pct || n.chg !== S.chg || n.unread !== S.unread || n.alarm !== S.alarm) drawStatus(n, A.T.bg);
                    if (n.steps !== S.steps) drawSteps(n, 206, A.T.bg);
                    if (n.timer !== S.timer || n.wx !== S.wx || n.music !== S.music || n.link !== S.link)
                        drawFooter(n, A.T.bg);
                    if (n.plug !== S.plug) drawPlugins(A.T.bg);
                } else {
                    drawAll(n);
                }
                S = n;
                lastSig = sig;
            }
        }

        // gestos: o toque do frame foi consumido pelo UI.begin do A.run
        var t = UI.touch();
        var now = System.millis();
        if (t.down) {
            if (!touchOn) { touchOn = true; downAt = now; longDone = false; }
            // toque longo parado: proximo estilo
            if (!t.moved && !longDone && now - downAt > 700) {
                longDone = true;
                setStyle((style + 1) % 3);
                if (System.beep) System.beep(1600, 30);
            }
        } else if (touchOn) {
            if (!longDone && t.sy - t.y > 25) System.exitApp();
            else if (!longDone && !t.moved) tapPlugins(t.x, t.y);
            touchOn = false;
        }
    }
}, "relogio", { fps: 7 });   // era System.delay(150): ~6.7 fps; 7 = 143 ms
