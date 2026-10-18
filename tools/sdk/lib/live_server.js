'use strict';
// Emulador ao vivo (`celer.js emu PASTA --serve`): servidor HTTP local com a
// tela do app num <img> (PNG por quadro via SSE), toque de verdade (mouse/
// dedo no navegador), teclado (setas/WASD viram swipe, espaco toca), pause/
// passo/velocidade, hot reload ao salvar e console do app.
//
// O app NAO roda no processo do servidor: um Worker roda o harness (que e
// sincrono) e o pacing/interacao passam por SharedArrayBuffer + Atomics.wait
// — o worker dorme entre quadros e acorda no input, sem busy-wait.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');

const RING = 256, PTR_BASE = 8;

function readName(appDir) {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
        return j.name || path.basename(appDir);
    } catch (e) { return path.basename(appDir); }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
                                                   '"': '&quot;', "'": '&#39;' }[c]));
}

// literal JS seguro para inline no <script> (nao fecha a tag nem quebra aspas)
function jsString(s) {
    return JSON.stringify(String(s)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function startLive(opts) {
    const appDir = path.resolve(opts.appDir);
    const appName = readName(appDir);
    const frameMs = Math.max(8, Math.round(1000 / (opts.fps || 30)));
    const seed = opts.seed;
    const port0 = opts.port != null ? (opts.port | 0) : 8420;

    const ctlSAB = new SharedArrayBuffer(8 * 4);
    const ctl = new Int32Array(ctlSAB);
    const ptrSAB = new SharedArrayBuffer((PTR_BASE + RING * 3) * 4);
    const ptr = new Int32Array(ptrSAB);
    ctl[3] = 100;   // velocidade 1x

    const clients = new Set();
    let worker = null, latest = null, lastMs = 0, lastW = 240, lastH = 320;
    let running = false, lastErr = null, watchTimer = null;
    let recording = false, rec = [];   // toques gravados p/ --input (tempo do app)

    function broadcast(msg) {
        if (!clients.size) return;
        const data = 'data: ' + JSON.stringify(msg) + '\n\n';
        for (const c of clients) {
            if (c.writableLength > 3 * 1024 * 1024) continue;   // aba travada: pula quadro
            try { c.write(data); } catch (e) { clients.delete(c); }
        }
    }

    function onMessage(msg) {
        if (msg.type === 'frame') {
            latest = Buffer.from(new Uint8Array(msg.png));
            lastMs = msg.ms; lastW = msg.w; lastH = msg.h;
            broadcast({ type: 'frame', ms: msg.ms, w: msg.w, h: msg.h,
                        png: latest.toString('base64') });
        } else if (msg.type === 'log') {
            broadcast(msg);
        } else if (msg.type === 'end') {
            running = false;
            lastErr = msg.err || null;
            if (msg.log && msg.log.length) broadcast({ type: 'log', lines: msg.log, ms: msg.ms });
            broadcast({ type: 'end', err: lastErr, ms: msg.ms });
            updateClients();
        }
    }

    function updateClients() { Atomics.store(ctl, 4, clients.size); }

    function spawnWorker() {
        if (worker) {
            Atomics.store(ctl, 5, 1);   // pede para sair se estiver num pace
            try { worker.terminate(); } catch (e) {}
            worker = null;
        }
        Atomics.store(ctl, 0, 0);
        Atomics.store(ctl, 1, 0);
        Atomics.store(ctl, 2, 0);
        Atomics.store(ctl, 5, 0);
        Atomics.store(ctl, 6, 0);
        Atomics.store(ctl, 7, 0);
        Atomics.store(ctl, 4, clients.size);
        Atomics.store(ptr, 0, 0);
        running = true;
        lastErr = null;
        const w = new Worker(path.join(__dirname, 'live_worker.js'), {
            workerData: { appDir: appDir, frameMs: frameMs, seed: seed, ctl: ctlSAB, ptr: ptrSAB },
        });
        worker = w;
        w.on('message', (m) => { if (worker === w) onMessage(m); });
        w.on('error', (e) => {
            if (worker !== w) return;
            running = false;
            lastErr = String((e && e.stack) || e);
            broadcast({ type: 'end', err: lastErr, ms: lastMs });
        });
        w.on('exit', () => {
            if (worker !== w) return;
            if (!running) return;
            running = false;
            broadcast({ type: 'end', err: lastErr, ms: lastMs });
        });
        broadcast({ type: 'reload', ms: 0 });
    }

    // entrada do navegador -> ring no SAB: [down, x, y] por evento
    let wasDown = false;
    function pushInput(ev) {
        const x = Math.max(-4096, Math.min(8192, Math.round(Number(ev.x) || 0)));
        const y = Math.max(-4096, Math.min(8192, Math.round(Number(ev.y) || 0)));
        const down = ev.down ? 1 : 0;
        if (recording && rec.length < 5000) {
            rec.push({ t: Math.max(0, Atomics.load(ctl, 7) - 1000),
                       kind: down ? (wasDown ? 'move' : 'down') : 'up', x: x, y: y });
        }
        wasDown = !!down;
        const head = Atomics.load(ptr, 0);
        const i = PTR_BASE + (head % RING) * 3;
        Atomics.store(ptr, i, down);
        Atomics.store(ptr, i + 1, x);
        Atomics.store(ptr, i + 2, y);
        Atomics.store(ptr, 0, head + 1);
        Atomics.add(ctl, 0, 1);
        Atomics.notify(ctl, 0);
    }

    // script no formato do --input, na ordem gravada
    function recScript() {
        const out = ['# gravado no emulador: tempo em ms do app, depois o gesto'];
        for (const e of rec) {
            out.push(String(e.t).padEnd(6, ' ') + e.kind.padEnd(5, ' ') + ' ' + e.x + ',' + e.y);
        }
        return out.join('\n') + '\n';
    }

    function control(c) {
        if (!c || typeof c !== 'object') return;
        if (c.reload) { spawnWorker(); return; }
        if (c.record != null) {
            recording = !!c.record;
            if (recording) rec = [];
        }
        if (c.step) {
            Atomics.store(ctl, 1, 1);   // passo implica pausado
            Atomics.store(ctl, 2, Math.max(1, Math.min(5000, c.step | 0)));
        }
        if (c.paused != null) {
            Atomics.store(ctl, 1, c.paused ? 1 : 0);
            Atomics.store(ctl, 2, 0);
        }
        if (c.speed) Atomics.store(ctl, 3, Math.max(25, Math.min(400, Math.round(c.speed * 100))));
        Atomics.add(ctl, 0, 1);
        Atomics.notify(ctl, 0);
    }

    // ------------------------------------------------------------ HTTP ----
    function sendJson(res, code, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                              'Cache-Control': 'no-store' });
        res.end(body);
    }

    function readBody(req, cb) {
        let size = 0;
        const parts = [];
        req.on('data', (d) => {
            size += d.length;
            if (size > 16384) { req.destroy(); return; }
            parts.push(d);
        });
        req.on('end', () => {
            try { cb(null, JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); }
            catch (e) { cb(e); }
        });
    }

    const server = http.createServer((req, res) => {
        const url = req.url.split('?')[0];
        if (req.method === 'GET' && url === '/favicon.ico') {
            res.writeHead(204); res.end(); return;
        }
        if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(PAGE.replace('__NAME__', escapeHtml(appName)).replace('__APPJ__', jsString(appName)));
            return;
        }
        if (req.method === 'GET' && url === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
                                 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
            res.write(': ola\n\n');
            res.write('data: ' + JSON.stringify({ type: 'hello', app: appName, ms: lastMs,
                                                  w: lastW, h: lastH, running: running }) + '\n\n');
            if (latest) {
                res.write('data: ' + JSON.stringify({ type: 'frame', ms: lastMs, w: lastW, h: lastH,
                                                      png: latest.toString('base64') }) + '\n\n');
            }
            clients.add(res);
            updateClients();
            req.on('close', () => { clients.delete(res); updateClients(); });
            return;
        }
        if (req.method === 'GET' && url === '/frame.png') {
            if (!latest) { res.writeHead(404); res.end('sem quadro'); return; }
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            res.end(latest);
            return;
        }
        if (req.method === 'GET' && url === '/record') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
                                 'Content-Disposition': 'attachment; filename="toques.txt"',
                                 'Cache-Control': 'no-store' });
            res.end(recScript());
            return;
        }
        if (req.method === 'GET' && url === '/state') {
            const clock = Math.max(Atomics.load(ctl, 7), lastMs);
            sendJson(res, 200, { app: appName, ms: clock, w: lastW, h: lastH, running: running,
                                 err: lastErr, clients: clients.size, fps: Math.round(1000 / frameMs),
                                 paused: !!Atomics.load(ctl, 1), speed: Atomics.load(ctl, 3) / 100,
                                 recording: recording, recorded: rec.length });
            return;
        }
        if (req.method === 'POST' && url === '/input') {
            readBody(req, (err, body) => {
                if (err) { sendJson(res, 400, { error: 'json invalido' }); return; }
                pushInput(body);
                sendJson(res, 200, { ok: true });
            });
            return;
        }
        if (req.method === 'POST' && url === '/control') {
            readBody(req, (err, body) => {
                if (err) { sendJson(res, 400, { error: 'json invalido' }); return; }
                control(body);
                sendJson(res, 200, { ok: true });
            });
            return;
        }
        res.writeHead(404); res.end('nao encontrado');
    });

    // hot reload: qualquer arquivo do app (fora .dev/) reinicia o worker
    function startWatch() {
        try {
            fs.watch(appDir, { recursive: true }, (ev, file) => {
                const f = String(file || '');
                if (/(^|[\\/])\.dev([\\/]|$)/.test(f) || !/\.(js|json|png|bmp|jpg|txt|wav|qoa)$/i.test(f)) return;
                clearTimeout(watchTimer);
                watchTimer = setTimeout(() => {
                    broadcast({ type: 'log', lines: ['[live] recarregado: ' + f], ms: lastMs });
                    spawnWorker();
                }, 180);
            });
        } catch (e) { /* FS sem watch: o botao Reiniciar continua */ }
    }

    // porta ocupada: tenta as 20 seguintes (o --port 0 deixa o SO escolher)
    let tries = 0;
    function listen(port) {
        const onErr = (e) => {
            if (e && e.code === 'EADDRINUSE' && tries < 20) {
                tries++;
                listen(port + 1);
            } else {
                console.error('erro: nao consegui abrir a porta: ' + (e && e.message));
                process.exit(1);
            }
        };
        server.once('error', onErr);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', onErr);
            const p = server.address().port;
            const url = 'http://127.0.0.1:' + p;
            console.log('emulador ao vivo de "' + appName + '": ' + url + '  (Ctrl+C para sair)');
            spawnWorker();
            startWatch();
            if (opts.open) {
                execFile('xdg-open', [url], () => {});
            }
        });
    }
    server.on('error', (e) => console.error('erro no servidor: ' + (e && e.message)));
    listen(port0);

    const ping = setInterval(() => {
        for (const c of clients) { try { c.write(': ping\n\n'); } catch (e) {} }
    }, 15000);
    ping.unref();

    process.on('SIGINT', () => {
        if (worker) { Atomics.store(ctl, 5, 1); try { worker.terminate(); } catch (e) {} }
        console.log('\nemulador encerrado');
        process.exit(0);
    });
    return { server: server, ctl: ctl, appName: appName };
}

// ------------------------------------------------------------- pagina -----
// Template minimo (sem dependencia): a tela vem por SSE como PNG base64.
// Setas/WASD sintetizam swipe do centro (Snake/2048/menus), espaco toca no
// ultimo ponto do mouse (ou centro), P pausa, R reinicia.
const PAGE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>emulador CelerOS</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#070a12;color:#e8eefc;font:14px/1.4 system-ui,Segoe UI,sans-serif;
       display:flex;flex-direction:column;height:100vh;overflow:hidden}
  header{display:flex;gap:10px;align-items:center;padding:8px 12px;background:#111827;
         border-bottom:1px solid #26314c;flex-wrap:wrap}
  header b{font-size:15px}
  .pill{background:#1b2740;border:1px solid #2c3850;border-radius:999px;padding:2px 10px;
        font-size:12px;color:#9fb0cc;font-variant-numeric:tabular-nums}
  .ok{color:#7ee2a8}.err{color:#ff8b8b}.warn{color:#ffd479}
  .tools{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  button,select{background:#1c2640;color:#e8eefc;border:1px solid #33415e;border-radius:7px;
        padding:5px 10px;font:inherit;cursor:pointer}
  button:hover{background:#273a5e}
  button:active{transform:translateY(1px)}
  .stage{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:10px}
  #screen{image-rendering:pixelated;image-rendering:crisp-edges;background:#000;cursor:crosshair;
          touch-action:none;user-select:none;-webkit-user-select:none;
          box-shadow:0 0 0 1px #2c3850,0 16px 50px #000}
  #pos{font-variant-numeric:tabular-nums;color:#9fb0cc;font-size:12px}
  #logs{max-height:30vh;border-top:1px solid #26314c;background:#0b1020}
  #logs summary{padding:6px 12px;cursor:pointer;color:#9fb0cc;font-size:12px}
  #log{margin:0;padding:0 12px 10px;max-height:24vh;overflow:auto;font:12px/1.35 ui-monospace,monospace;
       color:#b8c6de;white-space:pre-wrap}
  #err{position:fixed;inset:auto 12px 12px auto;max-width:min(720px,90vw);max-height:50vh;overflow:auto;
       background:#3a1218;border:1px solid #7f2430;border-radius:10px;padding:12px 14px;display:none;
       font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;color:#ffd7d7;z-index:9}
  .hint{color:#6f7f9c;font-size:12px}
</style></head>
<body>
<header>
  <b id="name">__NAME__</b>
  <span class="pill" id="stat">conectando...</span>
  <span class="pill" id="clock">0 ms</span>
  <span class="pill" id="fps">0 fps</span>
  <span id="pos"></span>
  <div class="tools">
    <button id="bpause" title="P (pausa/continua)">Pausar</button>
    <button id="bstep" title="avanca 100 ms de jogo">Passo</button>
    <button id="breload" title="R (reinicia o app)">Reiniciar</button>
    <button id="brec" title="grava os toques e baixa um toques.txt para --input">Gravar</button>
    <button id="bshot" title="baixa o PNG do quadro atual">Screenshot</button>
    <select id="speed" title="velocidade do relogio do app">
      <option value="0.25">0.25x</option><option value="0.5">0.5x</option>
      <option value="1" selected>1x</option><option value="2">2x</option>
    </select>
    <span class="hint">setas/WASD = swipe · espaco = toque · clique/arraste = toque real</span>
  </div>
</header>
<div class="stage"><img id="screen" alt="tela do app" draggable="false"></div>
<details id="logs"><summary>Console do app</summary><pre id="log"></pre></details>
<div id="err"></div>
<script>
(function(){
  var APP = __APPJ__;
  document.title = APP + ' — emulador CelerOS';
  var img = document.getElementById('screen');
  var stat = document.getElementById('stat'), clock = document.getElementById('clock');
  var fpsEl = document.getElementById('fps'), posEl = document.getElementById('pos');
  var logEl = document.getElementById('log'), errEl = document.getElementById('err');
  var bpause = document.getElementById('bpause'), speedSel = document.getElementById('speed');
  var W = 240, H = 320, paused = false, ms = 0, lastX = -1, lastY = -1;
  var frames = 0, fpsT0 = performance.now();

  function post(url, obj) {
    fetch(url, { method:'POST', headers:{'Content-Type':'application/json'},
                 body: JSON.stringify(obj) }).catch(function(){});
  }
  function setStat(text, cls) {
    stat.textContent = text;
    stat.className = 'pill ' + (cls || '');
  }
  function appendLog(lines) {
    if (!lines || !lines.length) return;
    var atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
    for (var i = 0; i < lines.length; i++) {
      logEl.appendChild(document.createTextNode(String(lines[i]) + '\\n'));
    }
    while (logEl.childNodes.length > 600) logEl.removeChild(logEl.firstChild);
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }
  function showErr(e) {
    errEl.style.display = e ? 'block' : 'none';
    errEl.textContent = e || '';
  }

  // tela fisica -> pixels: escala inteira para o pixel ficar nitido
  function layout() {
    var stage = document.querySelector('.stage');
    var sw = stage.clientWidth - 20, sh = stage.clientHeight - 20;
    var s = Math.min(sw / W, sh / H);
    s = s >= 1 ? Math.floor(s) : Math.max(0.1, s);
    img.style.width = (W * s) + 'px';
    img.style.height = (H * s) + 'px';
  }
  window.addEventListener('resize', layout);

  function coords(ev) {
    var r = img.getBoundingClientRect();
    return { x: Math.max(0, Math.min(W - 1, Math.round((ev.clientX - r.left) * W / r.width))),
             y: Math.max(0, Math.min(H - 1, Math.round((ev.clientY - r.top) * H / r.height))) };
  }
  img.addEventListener('pointerdown', function(ev){
    ev.preventDefault();
    img.setPointerCapture(ev.pointerId);
    var p = coords(ev); lastX = p.x; lastY = p.y;
    post('/input', { down:1, x:p.x, y:p.y });
  });
  img.addEventListener('pointermove', function(ev){
    var p = coords(ev);
    posEl.textContent = p.x + ',' + p.y;
    lastX = p.x; lastY = p.y;
    if (ev.buttons) post('/input', { down:1, x:p.x, y:p.y });
  });
  function release(ev) {
    var p = coords(ev); lastX = p.x; lastY = p.y;
    post('/input', { down:0, x:p.x, y:p.y });
  }
  img.addEventListener('pointerup', release);
  img.addEventListener('pointercancel', release);

  function tapAt(x, y) {
    post('/input', { down:1, x:x, y:y });
    setTimeout(function(){ post('/input', { down:0, x:x, y:y }); }, 40);
  }
  function swipe(dx, dy) {
    var cx = Math.round(W/2), cy = Math.round(H/2), d = Math.round(Math.min(W,H) * 0.16);
    var ex = cx + dx*d, ey = cy + dy*d, i = 0, n = 4;
    post('/input', { down:1, x:cx, y:cy });
    var t = setInterval(function(){
      i++;
      var k = i/n;
      post('/input', { down:1, x:Math.round(cx + (ex-cx)*k), y:Math.round(cy + (ey-cy)*k) });
      if (i >= n) {
        clearInterval(t);
        setTimeout(function(){ post('/input', { down:0, x:ex, y:ey }); }, 30);
      }
    }, 24);
  }

  window.addEventListener('keydown', function(ev){
    if (ev.repeat) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    var k = ev.key;
    // teclado nativo do controle focado: Enter/espaco no botao, setas no select
    if (tag === 'SELECT' && (k === 'ArrowUp' || k === 'ArrowDown')) return;
    if ((tag === 'BUTTON' || tag === 'INPUT') && (k === ' ' || k === 'Enter')) return;
    var dirs = { ArrowUp:[0,-1], ArrowDown:[0,1], ArrowLeft:[-1,0], ArrowRight:[1,0],
                             w:[0,-1], s:[0,1], a:[-1,0], d:[1,0], W:[0,-1], S:[0,1], A:[-1,0], D:[1,0] };
    if (dirs[k]) { ev.preventDefault(); swipe(dirs[k][0], dirs[k][1]); return; }
    if (k === ' ' || k === 'Enter') {
      ev.preventDefault();
      tapAt(lastX >= 0 ? lastX : Math.round(W/2), lastY >= 0 ? lastY : Math.round(H/2));
      return;
    }
    if (k === 'p' || k === 'P') { togglePause(); return; }
    if (k === 'r' || k === 'R') { post('/control', { reload:true }); return; }
  });

  function togglePause() {
    paused = !paused;
    post('/control', { paused: paused });
    bpause.textContent = paused ? 'Continuar' : 'Pausar';
    if (!paused) setStat('rodando', 'ok');
  }
  bpause.onclick = togglePause;
  document.getElementById('bstep').onclick = function(){ post('/control', { step:100 }); paused = true;
    bpause.textContent = 'Continuar'; setStat('pausado', 'warn'); };
  document.getElementById('breload').onclick = function(){ post('/control', { reload:true }); };
  var brec = document.getElementById('brec'), recording = false;
  brec.onclick = function(){
    recording = !recording;
    post('/control', { record: recording });
    brec.textContent = recording ? 'Parar' : 'Gravar';
    brec.style.background = recording ? '#7f2430' : '';
    if (recording) { appendLog(['[live] gravando toques...']); return; }
    // parou: baixa o script no formato do --input
    fetch('/record').then(function(r){ return r.text(); }).then(function(txt){
      var n = Math.max(0, txt.trim().split('\\n').length - 1);
      appendLog(['[live] gravacao: ' + n + ' eventos']);
      if (!n) return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
      a.download = 'toques.txt';
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
    });
  };
  document.getElementById('bshot').onclick = function(){
    fetch('/frame.png').then(function(r){ return r.blob(); }).then(function(b){
      var a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = APP.replace(/[^A-Za-z0-9_-]+/g, '_') + '.png';
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
    });
  };
  speedSel.onchange = function(){ post('/control', { speed: Number(speedSel.value) }); };

  var es = new EventSource('/events');
  es.onopen = function(){ setStat('conectado', 'ok'); };
  es.onerror = function(){ setStat('reconectando...', 'warn'); };
  es.onmessage = function(ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'hello') {
      setStat(m.running ? 'rodando' : 'app parado', m.running ? 'ok' : 'warn');
      if (m.w && m.h) { W = m.w; H = m.h; layout(); }
      return;
    }
    if (m.type === 'reload') { appendLog(['[live] app reiniciado']); showErr(''); return; }
    if (m.type === 'log') { appendLog(m.lines); return; }
    if (m.type === 'end') {
      setStat('app saiu' + (m.err ? ' com erro' : ''), m.err ? 'err' : 'warn');
      showErr(m.err || '');
      return;
    }
    if (m.type !== 'frame') return;
    ms = m.ms;
    if (m.w !== W || m.h !== H) { W = m.w; H = m.h; layout(); }
    img.src = 'data:image/png;base64,' + m.png;
    clock.textContent = ms + ' ms';
    frames++;
    var now = performance.now();
    if (now - fpsT0 >= 1000) {
      fpsEl.textContent = Math.round(frames * 1000 / (now - fpsT0)) + ' fps';
      frames = 0; fpsT0 = now;
    }
  };
  // o primeiro layout precisa da tela com tamanho (o hello/frame ajusta de novo)
  setTimeout(layout, 0);
})();
</script>
</body></html>`;

module.exports = { startLive };
