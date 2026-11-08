// Controle BT — servico de fundo (API 61/62).
//
// Um device HID BLE pareado vira input do OS:
//   gamepad -> Input.pad (canal broadcast: o launcher navega por foco, o
//              guide sai do app, apps leem Input.padState) + ponteiro no
//              stick direito (R2 = clique)
//   teclado -> Input.key (usage HID cru; o KeyboardScreen nativo digita nos
//              campos de texto de qualquer app)
//   mouse   -> Input.move (ponteiro absoluto 240x320; botao 1 = clique)
//   combo   -> teclado e mouse do MESMO device (descriptor com duas colecoes)
//
// O device ativo e escolhido no Ajustes (System.setting "bt_dev"); o TIPO vem
// do firmware (BT.state().kind, classificado do Report Map no connect) — nao
// ha setting de tipo para dessincronizar. Sem escolha explicita (OTA de quem
// ja tinha um pad pareado) o servico adota um bond conhecido.
//
// NAO existe multi-link: o BleHid e single-link, conectar outro device
// derruba o anterior. O Ajustes mostra isso.
//
// Molde USB HID/devkit-s3: NAO desenha, NAO chama present() — so timers e
// BT/Input. Erro em callback PARA o servico: tudo em try/catch defensivo.

var G = require("celeros.gamepad");
var H = require("celeros.hid");
var drv = require("driver");   // modulo local da pasta (padrao policy.js do Nucleo)

var TICK_MS = 25;
var RELOAD_TICKS = 80;    // ~2 s: o Ajustes liga/desliga sem reiniciar
var BUSY_MS = 60000;      // janela do "Ajustes esta usando o radio"

var cfg = { on: true, dev: "", ptr: true, mouse: true, speed: 2 };
var ticks = 0;
var ultTent = -60000;
var ultPares = -60000;  // ultima olhada nos bonds (sem alvo: re-olha devagar)
var backoff = 15000;
var gp = null;            // parser do gamepad (celeros.gamepad)
var hd = null;            // decoder de teclado/mouse (celeros.hid)
var curAddr = "";         // device do decoder atual
var curKind = "";
var ativo = false;        // algum decoder montado
var cur = { x: 120, y: 160 };
var mouseButtons = 0;
var autoDev = "";         // alvo adotado quando nao ha escolha no Ajustes

function prefBool(k, def) {
    var v = null;
    try { v = System.setting(k); } catch (e) { v = null; }
    if (v === null || v === "") return def;
    return v === "1" || v === "true" || v === "on";
}

function prefStr(k, def) {
    var v = null;
    try { v = System.setting(k); } catch (e) { v = null; }
    return (v === null || v === "") ? def : v;
}

function relerPrefs() {
    cfg.on = prefBool("bt_on", true);
    cfg.ptr = prefBool("bt_ptr", true);
    cfg.mouse = prefBool("mouse_on", true);
    var sp = parseInt(prefStr("mouse_speed", "2"), 10);
    cfg.speed = (sp >= 1 && sp <= 3) ? sp : 2;
    cfg.dev = prefStr("bt_dev", "");
}
relerPrefs();

// true = o Ajustes esta no meio de um scan/connect: nao mexe no radio.
// O valor e o System.millis() da marcacao; a janela cobre o pior caso e um
// app que morreu sem limpar a chave nao trava o servico para sempre.
function busyFresh() {
    var t = parseInt(prefStr("bt_busy", ""), 10);
    if (!t) return false;
    var d = System.millis() - t;
    return d >= 0 && d < BUSY_MS;
}

// passou `ms` desde `desde` (wrap do millis conta como passou)
function passou(desde, ms) {
    var d = System.millis() - desde;
    return d < 0 || d >= ms;
}

// device alvo: escolha do Ajustes ou, na primeira vez, um bond conhecido.
// Sem alvo nenhum (nunca pareou nada) a olhada nos bonds e a 0,5 Hz: o
// BT.paired() anda no store do host e aloca em JS — a 40 Hz do tick era
// trabalho permanente no estado que devia ser OCIOSO (commit 4880216e).
function alvo() {
    if (cfg.dev) return cfg.dev;
    if (autoDev) return autoDev;
    if (!passou(ultPares, 2000)) return "";
    ultPares = System.millis();
    var pares = BT.paired();
    var i;
    for (i = 0; i < pares.length; i++) {          // prefere gamepad
        if (pares[i].kind === "pad") {
            autoDev = pares[i].addr;
            return autoDev;
        }
    }
    for (i = 0; i < pares.length; i++) {
        if (pares[i].kind) {                       // teclado/mouse ja conhecido
            autoDev = pares[i].addr;
            return autoDev;
        }
    }
    if (pares.length) autoDev = pares[0].addr;     // legado: bond sem registro
    return autoDev;
}

function resetDecoder() {
    var was = ativo;
    gp = null;
    hd = null;
    curAddr = "";
    curKind = "";
    ativo = false;
    if (was) {
        // device trocado: o canal do pad guardava o ultimo estado — um botao
        // que estava apertado na troca continuaria "preso" no launcher
        try { Input.pad({ buttons: 0, dpad: 0, lx: 0, ly: 0, rx: 0, ry: 0 }); } catch (e) {}
        try { Input.move(cur.x, cur.y, 0); } catch (e2) {}
    }
    return was;
}

// devolve o barramento (driver desligado, sem device ou sem BT)
function solta() {
    if (resetDecoder()) {
        try { Input.move(cur.x, cur.y, 0); } catch (e) {}
        try { Input.clear(); } catch (e2) {}
        mouseButtons = 0;
    }
}

// monta o decoder do tipo do device conectado; true = pronto para drenar
function montaDecoder(st) {
    if (ativo && st.addr === curAddr && (st.kind || "") === curKind) return true;
    resetDecoder();
    curAddr = st.addr;
    curKind = st.kind || "";
    if (curKind === "pad") {
        gp = G.setup();
    } else {
        hd = H.setup();   // kbd/mouse/combo
    }
    // firmware < 62 nao publica kind (""), e um tipo errado nao pode deixar o
    // device sem driver: tenta o outro decoder antes de desistir
    if (!gp && !hd) {
        if (curKind === "pad") hd = H.setup();
        else gp = G.setup();
    }
    ativo = !!(gp || hd);
    if (ativo) {
        // ponteiro no centro a cada device novo (mouse e pad)
        cur.x = 120;
        cur.y = 160;
        mouseButtons = 0;
        try { Input.move(cur.x, cur.y, 0); } catch (e) {}
    }
    return ativo;
}

function drena() {
    var i;
    if (gp) {
        var s = gp.poll();
        if (!s) return;
        Input.pad(drv.toBus(s));
        if (cfg.ptr) {
            cur = drv.toPointer(s, cur, TICK_MS);
            Input.move(cur.x, cur.y, cur.click);
        }
        return;
    }
    if (!hd) return;
    var r;
    while ((r = BT.read()) !== null) {
        var out = hd.feed(r);
        if (!out) continue;
        if (out.kbd) {
            // solta antes de apertar: deixa o diff do campo na ordem certa
            for (i = 0; i < out.kbd.released.length; i++) {
                Input.key(out.kbd.released[i], out.kbd.mods, false);
            }
            for (i = 0; i < out.kbd.pressed.length; i++) {
                Input.key(out.kbd.pressed[i], out.kbd.mods, true);
            }
        }
        if (out.mouse && cfg.mouse) {
            var m = out.mouse;
            cur = drv.moveMouse(cur, m.dx, m.dy, drv.mouseSpeed(cfg.speed));
            if (m.dx || m.dy || m.buttons !== mouseButtons) {
                Input.move(cur.x, cur.y, m.buttons);
                mouseButtons = m.buttons;
            }
        }
    }
}

setInterval(function () {
    try {
        ticks++;
        if (ticks % RELOAD_TICKS === 0) relerPrefs();

        if (typeof Input === "undefined") return;   // superficie sem a perm
        if (typeof BT === "undefined") { solta(); return; }
        if (!cfg.on) { solta(); return; }
        if (busyFresh()) {
            // Ajustes/painel no radio: alem de pausar, SOLTA o canal — o
            // pareamento derruba o enlace e o pad podia deixar botao/dpad
            // "presos" no estado do bus (foco andando sozinho no launcher)
            // enquanto a janela de 60 s vale.
            resetDecoder();
            return;
        }

        var dev = alvo();
        if (!dev) { solta(); return; }

        var st = BT.state();
        if (st.phase !== "ready" || st.addr !== dev) {
            if (resetDecoder()) {
                try { Input.move(cur.x, cur.y, 0); } catch (e) {}
            }
            if (!passou(ultTent, backoff)) return;
            ultTent = System.millis();
            var r = BT.connect(dev);   // bloqueia (renova a janela do executor)
            if (r && r.ok) {
                backoff = 15000;
                montaDecoder(BT.state());
            } else {
                backoff = backoff < 60000 ? backoff * 2 : 60000;
            }
            return;
        }
        if (!montaDecoder(st)) return;
        drena();
    } catch (e) {
        // erro de callback para o servico: engole e segue no proximo tick
    }
}, TICK_MS);
