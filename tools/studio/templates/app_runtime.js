// Runtime de PROGRAMAS do Celer Studio (ES5, Duktape). Este arquivo NAO e um
// modulo: o build concatena este corpo dentro do main.js gerado e chama
// studioAppBoot(require("app.data"), BASES).
//
// Modelo: cada *.scene.json e uma TELA. Entidades sao widgets posicionados no
// espaco virtual 240x320 (x/y = canto superior esquerdo, z = ordem de desenho).
// O estado da tela (scene.settings.data) e um objeto plano que os widgets
// leem/escrevem por chave e que os scripts mutam livremente. Nada de
// reatividade magica: o widget le o estado a cada quadro.
//
// Contrato do Kui: UI.begin() uma vez por quadro; todo widget e CHAMADO em
// todo quadro (o hit-test e sempre feito, o desenho e que e parcial). Widgets
// customizados (campo de texto e microfone) rodam numa segunda passada porque
// dependem de UI.touch() saber se um widget nativo ja consumiu o toque.
//
// Ciclo de vida dos scripts: create(ctx), start(ctx), update(dt, ctx),
// draw(ctx), event(nome, valor, ctx), destroy(ctx). Vale para o script da
// TELA (settings.scripts) e para o script preso a uma entidade. Eventos vao
// para os scripts da tela e para os scripts da propria entidade que o gerou.

function studioAppBoot(data, bases) {
    var S = System;
    // AI/FS/Mic sao opcionais (permissao + placa). O alias local deixa o
    // guard `typeof` explicito e evita que o app_lint acuse um runtime
    // generico de usar API sem permissao: quem declara a permissao e o
    // componente que o projeto realmente tem (validate.js cobra).
    var AIC = (typeof AI !== 'undefined') ? AI : null;
    var FSC = (typeof FS !== 'undefined') ? FS : null;
    var MIC = (typeof Mic !== 'undefined') ? Mic : null;
    var A = data.assets || {};
    var SC = data.scenes || {};
    var NAME = data.names || {};
    var BASES = bases || ['/local/apps/', '/sd/apps/'];
    var T = {};
    try { T = S.theme ? S.theme() : {}; } catch (eTheme) { T = {}; }

    var states = {};       // chave da tela -> estado (sobrevive a navegacao)
    var stack = [];        // telas empilhadas
    var cur = null;        // tela atual
    var quit = false;
    var pendingGo = null;
    var pendingBack = false;
    var events = [];
    var baseCache = {};    // nome do asset -> base path que funcionou

    function firstKey(obj) {
        for (var k in obj) return k;
        return '';
    }

    function isObj(v) { return !!v && typeof v === 'object'; }

    function str(v) {
        if (v === undefined || v === null) return '';
        return String(v);
    }

    function clone(v) {
        if (!isObj(v)) return v;
        if (v.length !== undefined) {
            var arr = [];
            for (var i = 0; i < v.length; i++) arr.push(clone(v[i]));
            return arr;
        }
        var out = {};
        for (var k in v) if (v.hasOwnProperty(k)) out[k] = clone(v[k]);
        return out;
    }

    // ---------------------------------------------------------- assets ----
    function assetBySlot(n) {
        for (var g in A) if (A[g] && A[g].n === n) return A[g];
        return null;
    }

    // drawPNG devolve false quando o caminho nao existe (o device sempre tem
    // /local/apps/<pkg>/; o cartao usa /sd/apps/<pkg>/). Resolve a base uma
    // vez por asset e cacheia: tentar 8 caminhos por quadro custa caro.
    function drawImage(a, x, y) {
        if (!a || !a.f || typeof S.drawPNG !== 'function') return false;
        var b = baseCache[a.n];
        if (b !== undefined) return S.drawPNG(b + a.f, x, y);
        for (var i = 0; i < BASES.length; i++) {
            if (S.drawPNG(BASES[i] + a.f, x, y)) {
                baseCache[a.n] = BASES[i];
                return true;
            }
        }
        baseCache[a.n] = '';
        return false;
    }

    function b64(bytes) {
        var B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var out = '', i, c1, c2, c3;
        for (i = 0; i < bytes.length; i += 3) {
            c1 = bytes.charCodeAt(i) & 255;
            c2 = (i + 1 < bytes.length) ? (bytes.charCodeAt(i + 1) & 255) : -1;
            c3 = (i + 2 < bytes.length) ? (bytes.charCodeAt(i + 2) & 255) : -1;
            out += B.charAt(c1 >> 2);
            out += B.charAt(((c1 & 3) << 4) | (c2 < 0 ? 0 : (c2 >> 4)));
            out += c2 < 0 ? '=' : B.charAt(((c2 & 15) << 2) | (c3 < 0 ? 0 : (c3 >> 6)));
            out += c3 < 0 ? '=' : B.charAt(c3 & 63);
        }
        return out;
    }

    // ----------------------------------------------------------- estado ----
    function persistKey(s) {
        return 'studio.' + String(s.key) + '.' + s.persist;
    }

    function stateFor(s) {
        var st = states[s.key];
        if (!st) {
            st = clone(s.def.data || {});
            s.dirtyPersist = false;
            if (s.persist && typeof Storage !== 'undefined' && Storage.get) {
                var raw = Storage.get(persistKey(s), '');
                if (raw) {
                    try {
                        var saved = JSON.parse(raw);
                        if (isObj(saved)) for (var k in saved) if (saved.hasOwnProperty(k)) st[k] = saved[k];
                    } catch (e) { /* estado velho/corrompido: fica o default */ }
                }
            }
            states[s.key] = st;
        }
        return st;
    }

    function saveState(s) {
        if (!s.persist || !s.dirtyPersist) return;
        if (typeof Storage === 'undefined' || !Storage.set) return;
        try { Storage.set(persistKey(s), JSON.stringify(s.st)); s.dirtyPersist = false; }
        catch (e) { /* NVS cheia/valor grande: nao derruba o app */ }
    }

    function setSt(s, k, v) {
        if (!k) return;
        s.st[k] = v;
        s.dirtyPersist = true;
    }

    function makeCtx(s, ent) {
        return {
            scene: s, app: data, entity: ent, st: s.st,
            arg: s.arg, full: false,
            get: function (k) { return s.st[k]; },
            set: function (k, v) { setSt(s, k, v); },
            go: function (n, a) { pendingGo = { key: n, arg: a }; },
            back: function () { pendingBack = true; },
            exit: function () { quit = true; },
            asset: function (n) { return assetBySlot(n); },
            toast: function (m, ms) { if (S.toast) S.toast(m, ms); },
            store: {
                get: function (k, d) {
                    if (typeof Storage === 'undefined' || !Storage.get) return d;
                    return Storage.get('app.' + k, d);
                },
                set: function (k, v) {
                    if (typeof Storage === 'undefined' || !Storage.set) return false;
                    return Storage.set('app.' + k, String(v));
                },
                remove: function (k) {
                    if (typeof Storage === 'undefined' || !Storage.remove) return false;
                    return Storage.remove('app.' + k);
                }
            }
        };
    }

    // -------------------------------------------------------- entidades ----
    function buildEntity(s, d) {
        var ent = {
            fid: d.fid, name: d.name, active: d.active !== false,
            x: d.x || 0, y: d.y || 0, z: d.z || 0,
            comps: d.comps || [], scripts: [], ai: [], fields: {}
        };
        var i, c;
        for (i = 0; i < ent.comps.length; i++) {
            c = ent.comps[i];
            if (c.t === 'script') {
                var mod = null;
                try { mod = require(c.m); }
                catch (eReq) {
                    try { S.print('[studio] script ' + c.m + ' falhou: ' + eReq); } catch (e2) {}
                }
                if (mod) {
                    var ctx = makeCtx(s, ent);
                    var inst = mod.create ? mod.create(ctx) : {};
                    if (!inst) inst = {};
                    inst.fields = c.fields || {};
                    inst.entity = ent;
                    inst._mod = mod;
                    inst._ctx = ctx;
                    ent.scripts.push(inst);
                }
            } else if (c.t === 'data') {
                ent.data = c.fields || {};
            } else if (c.t === 'ai') {
                ent.ai.push({ k: c.k, f: c.f || {}, busy: false, t0: 0 });
            }
        }
        return ent;
    }

    // ------------------------------------------------- widgets (Kui) ------
    function opt(v) { return v === '' || v === undefined || v === null ? undefined : v; }

    function widgetId(c, ent) { return c.f.id || c.id || ent.fid; }

    function drawTextComp(s, ent, c) {
        var f = c.f;
        var txt = f.bind ? str(s.st[f.bind]) : str(f.text);
        var o = { align: f.align || 'left' };
        if (f.role) o.role = f.role;
        if (f.color !== undefined) o.color = f.color;
        if (f.w) o.w = f.w;
        if (f.lines) o.lines = f.lines;
        if (f.bg !== undefined) o.bg = f.bg;
        if (f.id) o.id = f.id;
        UI.text(txt, ent.x, ent.y, o);
    }

    function widgetButton(s, ent, c) {
        var f = c.f;
        var o = { style: f.style || 'primary' };
        var dis = !!f.disabled;
        if (f.disabledBind) dis = !!s.st[f.disabledBind];
        if (dis) o.disabled = true;
        if (f.id) o.id = f.id;
        if (UI.button(str(f.label), ent.x, ent.y, f.w || 200, f.h || 32, o)) {
            if (f.event) events.push({ name: f.event, value: undefined, source: ent.fid });
            if (f.go) pendingGo = { key: f.go, arg: undefined };
        }
    }

    function widgetToggle(s, ent, c) {
        var f = c.f;
        var on = !!s.st[f.key];
        var o = f.id ? { id: f.id } : undefined;
        var now = UI.toggle(ent.x, ent.y, on, o);
        if (now !== on) {
            setSt(s, f.key, now);
            if (f.event) events.push({ name: f.event, value: now, source: ent.fid });
        }
    }

    function widgetSlider(s, ent, c) {
        var f = c.f;
        var v = Number(s.st[f.key]);
        if (isNaN(v)) v = f.min !== undefined ? f.min : 0;
        var o = { min: f.min !== undefined ? f.min : 0, max: f.max !== undefined ? f.max : 100 };
        if (f.step) o.step = f.step;
        if (f.id) o.id = f.id;
        var now = UI.slider(ent.x, ent.y, f.w || 200, v, o);
        if (now !== v) {
            setSt(s, f.key, now);
            if (f.event) events.push({ name: f.event, value: now, source: ent.fid });
        }
    }

    function widgetProgress(s, ent, c) {
        var f = c.f;
        var v = f.key ? Number(s.st[f.key]) : Number(f.value);
        if (isNaN(v)) v = 0;
        UI.progress(ent.x, ent.y, f.w || 200, f.h || 8, v);
    }

    function widgetList(s, ent, c) {
        var f = c.f;
        var items = f.itemsBind ? s.st[f.itemsBind] : f.items;
        if (!items || !items.length) return;
        var sel = f.key ? Number(s.st[f.key]) : -1;
        if (isNaN(sel)) sel = -1;
        var o = { rowH: f.rowH || 40, selected: sel };
        var i = UI.list(widgetId(c, ent), ent.x, ent.y, f.w || 224, f.h || 160, items, o);
        if (i >= 0 && i !== sel) {
            if (f.key) setSt(s, f.key, i);
            if (f.event) events.push({ name: f.event, value: i, source: ent.fid });
        }
    }

    function widgetTabs(s, ent, c) {
        var f = c.f;
        var labels = f.labels || [];
        if (!labels.length) return;
        var sel = f.key ? Number(s.st[f.key]) : 0;
        if (isNaN(sel)) sel = 0;
        var now = UI.tabs(ent.x, ent.y, f.w || 224, f.h || 30, labels, sel);
        if (now !== sel) {
            if (f.key) setSt(s, f.key, now);
            if (f.event) events.push({ name: f.event, value: now, source: ent.fid });
        }
    }

    // Card do Kui nao e um retangulo solto: ele EMPILHA a cor de fundo para os
    // widgets desenhados depois limparem o proprio retangulo com a cor do
    // card no redesenho parcial. Por isso o card e um "intervalo": abre no
    // componente ui.card e fecha no proximo ui.card (ou no fim da tela).
    // Pintar por fora com fillRect apagava o texto a cada quadro parcial.
    function widgetCard(s, ent, c) {
        var f = c.f;
        var o = { radius: f.radius !== undefined ? f.radius : 10 };
        if (f.color !== undefined) o.color = f.color;
        if (f.stroke !== undefined) o.stroke = true;
        UI.card(ent.x, ent.y, f.w || 224, f.h || 80, o);
    }

    // drawPNG decodifica o arquivo: nunca por quadro. Redesenha so no frame
    // total ou quando a entidade se move.
    function widgetImage(s, ent, c) {
        var f = c.f;
        if (!s._fullFrame && ent._imgX === ent.x && ent._imgY === ent.y) return;
        ent._imgX = ent.x;
        ent._imgY = ent.y;
        drawImage(f.asset, ent.x, ent.y);
    }

    function widgetBadge(s, ent, c) {
        var f = c.f;
        var txt = f.bind ? str(s.st[f.bind]) : str(f.text);
        if (!txt) return;
        var o;
        if (f.color !== undefined || f.textColor !== undefined) {
            o = {};
            if (f.color !== undefined) o.color = f.color;
            if (f.textColor !== undefined) o.textColor = f.textColor;
        }
        UI.badge(txt, ent.x, ent.y, o);
    }

    function widgetSpinner(s, ent, c) {
        var f = c.f;
        var r = f.r || 8;
        UI.spinner(ent.x + r, ent.y + r, r, opt(f.color));
    }

    function drawWidget(s, ent, c) {
        var k = c.k;
        if (k === 'text') drawTextComp(s, ent, c);
        else if (k === 'card') widgetCard(s, ent, c);
        else if (k === 'image') widgetImage(s, ent, c);
        else if (k === 'progress') widgetProgress(s, ent, c);
        else if (k === 'spinner') widgetSpinner(s, ent, c);
        else if (k === 'badge') widgetBadge(s, ent, c);
        else if (k === 'button') widgetButton(s, ent, c);
        else if (k === 'toggle') widgetToggle(s, ent, c);
        else if (k === 'slider') widgetSlider(s, ent, c);
        else if (k === 'list') widgetList(s, ent, c);
        else if (k === 'tabs') widgetTabs(s, ent, c);
    }

    // ------------------------------------------------- widgets custom -----
    function customField(s, ent, c, tr) {
        var f = c.f;
        var label = str(f.label);
        var val = str(s.st[f.key]);
        var y = ent.y;
        if (label) UI.text(label, ent.x, y, { role: 'caption', color: T.textDim });
        UI.text(val || str(f.hint), ent.x, y + 20, { color: val ? T.text : T.textDim, w: 200 });
        if (tr.tap && tr.x >= ent.x && tr.x < ent.x + 220 && tr.y >= y && tr.y < y + 44) {
            if (typeof S.prompt === 'function') {
                var o = { nullOnCancel: true };
                if (f.mask) o.mask = f.mask;
                if (f.hint) o.hint = f.hint;
                var got = S.prompt(label || 'Valor', val, o);
                if (got !== null && got !== undefined) {
                    setSt(s, f.key, got);
                    events.push({ name: 'change', value: { key: f.key, value: got }, source: ent.fid });
                }
            }
            return true;
        }
        return false;
    }

    function customMic(s, ent, c, tr) {
        var f = c.f;
        var has = (!!MIC && !!MIC.start && !!MIC.stop);
        var x = ent.x, y = ent.y, w = f.w || 120, h = f.h || 44;
        var rec = !!s.recording;
        var col = has ? (rec ? (T.err !== undefined ? T.err : 0xF008) : (T.accent !== undefined ? T.accent : 0x3DF1))
                      : (T.raised !== undefined ? T.raised : 0x1318);
        if (S.fillRoundRect) S.fillRoundRect(x, y, w, h, h / 2, col);
        else S.fillRect(x, y, w, h, col);
        var label = rec ? 'Gravando...' : str(f.label);
        var tc = rec ? 0xFFFF : (has ? (T.onAccent !== undefined ? T.onAccent : 0x0841) : T.textDim);
        try { S.setTextColor(tc); } catch (e) {}
        S.drawString(label, x + 10, y + h / 2 - 4, 1);
        if (!has) return false;

        var inside = tr.x >= x && tr.x < x + w && tr.y >= y && tr.y < y + h;
        var mode = f.mode || 'hold';
        if (mode === 'hold') {
            if (rec && tr.released) { stopMic(s, ent, f); return true; }
            if (!rec && tr.down && inside && !s._micDown) {
                s._micDown = true;
                startMic(s, f);
                return true;
            }
            if (!tr.down) s._micDown = false;
        } else if (tr.tap && inside) {
            if (rec) stopMic(s, ent, f);
            else startMic(s, f);
            return true;
        }
        return false;
    }

    function startMic(s, f) {
        try { s.recording = !!MIC.start({ ms: f.maxMs || 8000 }); } catch (e) { s.recording = false; }
    }

    function stopMic(s, ent, f) {
        var out = null;
        try { out = MIC.stop(); } catch (e2) { out = null; }
        s.recording = false;
        s._micDown = false;
        if (out) {
            setSt(s, f.key, out);
            // source = fid da entidade (como nos outros eventos): o dispatch
            // filtra script por e.fid, e uma chave de tela nunca casa
            events.push({ name: f.event || 'mic:done', value: { bytes: out.length }, source: ent.fid });
        }
    }

    function drawCustom(s, ent, c, tr, used) {
        if (used) return true;
        if (c.k === 'field') return customField(s, ent, c, tr);
        if (c.k === 'mic.record') return customMic(s, ent, c, tr);
        return false;
    }

    // ------------------------------------------------------------- IA ------
    function aiOut(s, ent, a, ok, content, detail) {
        var f = a.f;
        a.busy = false;
        a.t0 = 0;
        if (f.busyKey) setSt(s, f.busyKey, false);
        if (f.outKey && ok) setSt(s, f.outKey, content || '');
        if (f.errorKey) setSt(s, f.errorKey, ok ? '' : (detail || 'falha'));
        if (f.history && f.histKey && ok && content) {
            var h = s.st[f.histKey];
            if (!h || h.length === undefined) h = s.st[f.histKey] = [];
            h.push({ role: 'assistant', content: content });
            // historico em NVS/pacote tem teto: guarda as 20 ultimas falas
            while (h.length > 20) h.shift();
        }
        events.push({ name: 'ai:done', value: { ok: ok, content: content || '', detail: detail || '' }, source: ent.fid });
    }

    function aiChat(s, ent, a) {
        var f = a.f;
        if (!AIC || !AIC.chat) {
            aiOut(s, ent, a, false, '', 'AI indisponivel (permissao net/placa)');
            return;
        }
        if (a.busy) return;
        var text = f.promptKey ? str(s.st[f.promptKey]) : str(f.prompt);
        var msgs = [];
        if (f.system) msgs.push({ role: 'system', content: str(f.system) });
        if (f.history && f.histKey) {
            var h = s.st[f.histKey];
            if (h && h.length) for (var i = 0; i < h.length; i++) msgs.push(h[i]);
        }
        var content = text;
        if (f.attach === 'mic' && s.st.audio) {
            content = [
                { type: 'text', text: text },
                { type: 'input_audio', input_audio: { data: s.st.audio, format: 'wav' } }
            ];
        }
        msgs.push({ role: 'user', content: content });
        if (f.history && f.histKey) {
            var hh = s.st[f.histKey];
            if (!hh || hh.length === undefined) hh = s.st[f.histKey] = [];
            hh.push({ role: 'user', content: text });
        }
        var opts = { provider: f.provider || 'openrouter', messages: msgs,
                     max_tokens: f.maxTokens || 1024 };
        if (f.model) opts.model = f.model;
        a.busy = true;
        if (f.busyKey) setSt(s, f.busyKey, true);
        var started = false;
        try {
            started = AIC.chat(opts, function (r) {
                aiOut(s, ent, a, !!(r && r.ok), r && r.content,
                      r && (r.detail || r.error));
            });
        } catch (e) {
            aiOut(s, ent, a, false, '', String(e));
            return;
        }
        if (!started) aiOut(s, ent, a, false, '', 'IA ocupada');
    }

    function aiSpeak(s, ent, a) {
        var f = a.f;
        if (!AIC || !AIC.speak) {
            aiOut(s, ent, a, false, '', 'TTS indisponivel');
            return;
        }
        var text = f.textKey ? str(s.st[f.textKey]) : str(f.text);
        if (!text) return;
        if (f.busyKey) setSt(s, f.busyKey, true);
        a.busy = true;
        try {
            AIC.speak({ text: text, voice: f.voice || 'Charon', play: true }, function (r) {
                aiOut(s, ent, a, !!(r && r.ok), '', r && (r.detail || r.error));
            });
        } catch (e2) {
            aiOut(s, ent, a, false, '', String(e2));
        }
    }

    function aiVision(s, ent, a) {
        var f = a.f;
        if (!AIC || !AIC.chat) {
            aiOut(s, ent, a, false, '', 'IA indisponivel (permissao net/placa)');
            return;
        }
        var path = str(s.st[f.imageKey]);
        if (!path) { aiOut(s, ent, a, false, '', 'sem imagem'); return; }
        if (!FSC || !FSC.readFile) {
            aiOut(s, ent, a, false, '', 'FS indisponivel (permissao fs)');
            return;
        }
        var raw = FSC.readFile(path, 65536);
        if (!raw) { aiOut(s, ent, a, false, '', 'imagem nao lida: ' + path); return; }
        var mime = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
        var msgs = [{
            role: 'user',
            content: [
                { type: 'text', text: str(f.prompt) || 'Descreva a imagem.' },
                { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64(raw) } }
            ]
        }];
        if (a.busy) return;
        a.busy = true;
        try {
            AIC.chat({ provider: f.provider || 'openrouter', model: f.model, messages: msgs,
                      max_tokens: f.maxTokens || 512 }, function (r) {
                aiOut(s, ent, a, !!(r && r.ok), r && r.content, r && (r.detail || r.error));
            });
        } catch (e3) {
            aiOut(s, ent, a, false, '', String(e3));
        }
    }

    function tickAi(s, ent) {
        for (var i = 0; i < ent.ai.length; i++) {
            var a = ent.ai[i];
            var f = a.f;
            if (!f.trigger) continue;
            var t = s.st[f.trigger];
            if (!t) continue;
            // o disparo e de uso unico: limpa antes de chamar (o script pode
            // setar de novo no evento ai:done)
            s.st[f.trigger] = false;
            // watchdog: callback do firmware que nunca chega nao pode prender
            // a.busy para sempre (o trigger e single-shot, a tela morria muda)
            if (a.busy) {
                if (a.t0 && S.millis && S.millis() - a.t0 > 60000) {
                    aiOut(s, ent, a, false, '', 'IA timeout (60s sem resposta)');
                }
                continue;
            }
            a.t0 = S.millis ? S.millis() : 0;
            if (a.k === 'chat') aiChat(s, ent, a);
            else if (a.k === 'speak') aiSpeak(s, ent, a);
            else if (a.k === 'vision') aiVision(s, ent, a);
        }
    }

    // ------------------------------------------------------------ telas ----
    function buildScreen(key, def) {
        var s = {
            key: key, def: def,
            title: def.title || key,
            sub: def.sub || '',
            header: def.header === undefined ? true : !!def.header,
            persist: def.persist || '',
            fps: def.fps || (data.fps || 20),
            bg: def.bg === undefined ? (T.bg === undefined ? 0x0000 : T.bg) : def.bg,
            music: def.music || null,
            ents: [], scripts: [], st: null, arg: undefined,
            dirtyPersist: false, recording: false, _micDown: false,
            lastSave: 0
        };
        return s;
    }

    function enter(s, arg) {
        s.arg = arg;
        s.st = stateFor(s);
        var i, j;
        s.ents = [];
        s.scripts = [];
        var list = s.def.entities || [];
        for (i = 0; i < list.length; i++) {
            if (list[i].active === false) continue;
            s.ents.push(buildEntity(s, list[i]));
        }
        s.ents.sort(function (a, b) { return (a.z || 0) - (b.z || 0); });

        var sids = s.def.scripts || [];
        for (i = 0; i < sids.length; i++) {
            var entry = sids[i];
            var modName = typeof entry === 'string' ? entry : entry.m;
            var mod = null;
            try { mod = require(modName); }
            catch (eReq) {
                try { S.print('[studio] script de tela ' + modName + ' falhou: ' + eReq); } catch (e2) {}
            }
            if (!mod) continue;
            var ctx = makeCtx(s, null);
            var inst = mod.create ? mod.create(ctx) : {};
            if (!inst) inst = {};
            inst.fields = (typeof entry === 'string' ? null : entry.f) || {};
            inst._mod = mod;
            inst._ctx = ctx;
            s.scripts.push(inst);
        }
        // start depois de entidades e scripts existirem
        for (i = 0; i < s.scripts.length; i++) {
            if (s.scripts[i]._mod.start) s.scripts[i]._mod.start.call(s.scripts[i], s.scripts[i]._ctx);
        }
        for (i = 0; i < s.ents.length; i++) {
            for (j = 0; j < s.ents[i].scripts.length; j++) {
                var si = s.ents[i].scripts[j];
                if (si._mod.start) si._mod.start.call(si, si._ctx);
            }
        }
        // musica da tela (uma vez na entrada, como no runtime de jogo)
        if (s.music && A[s.music] && typeof S.playWav === 'function') {
            var a = A[s.music];
            for (var b = 0; b < BASES.length; b++) {
                try { S.playWav(BASES[b] + a.f); baseCache[a.n] = BASES[b]; break; }
                catch (ePlay) { /* tenta a proxima base */ }
            }
        }
    }

    function leave(s) {
        var i, j;
        for (i = 0; i < s.ents.length; i++) {
            for (j = 0; j < s.ents[i].scripts.length; j++) {
                var si = s.ents[i].scripts[j];
                if (si._mod.destroy) si._mod.destroy.call(si, si._ctx);
            }
        }
        for (i = 0; i < s.scripts.length; i++) {
            if (s.scripts[i]._mod.destroy) s.scripts[i]._mod.destroy.call(s.scripts[i], s.scripts[i]._ctx);
        }
        if (s.recording && MIC && MIC.stop) {
            try { MIC.stop(); } catch (e) {}
            s.recording = false;
        }
        saveState(s);
        s.ents.length = 0;
        s.scripts.length = 0;
    }

    function resolveKey(n) {
        if (!n) return null;
        if (SC[n]) return n;
        if (NAME[n]) return NAME[n];
        return null;
    }

    function go(n, arg) {
        var key = resolveKey(n);
        if (!key) {
            try { S.print('[studio] tela inexistente: ' + n); } catch (e) {}
            return;
        }
        // a tela que sai roda destroy ANTES da nova entrar (o ctx dela ainda
        // e valido; sem isto scripts de tela vazavam timers/estado)
        if (cur) leave(cur);
        if (cur) stack.push(cur);
        cur = buildScreen(key, SC[key]);
        enter(cur, arg);
    }

    function back() {
        if (!cur) return;
        leave(cur);
        if (stack.length) {
            cur = stack.pop();
            enter(cur, cur.arg);
        } else {
            cur = null;
            quit = true;
        }
    }

    // --------------------------------------------------------- por quadro --
    function runUpdate(s, dt) {
        var i, j;
        for (i = 0; i < s.scripts.length; i++) {
            var si = s.scripts[i];
            if (si._mod.update) si._mod.update.call(si, dt, si._ctx);
        }
        for (i = 0; i < s.ents.length; i++) {
            var e = s.ents[i];
            tickAi(s, e);
            for (j = 0; j < e.scripts.length; j++) {
                var se = e.scripts[j];
                if (se._mod.update) se._mod.update.call(se, dt, se._ctx);
            }
        }
    }

    function drawFrame(s, full) {
        var i, j, c;
        s._fullFrame = full;
        var cardOpen = false;
        // passada 1: widgets nativos + visuais (por z). ui.card abre o
        // intervalo de fundo do Kui e fecha no proximo card.
        for (i = 0; i < s.ents.length; i++) {
            var e = s.ents[i];
            for (j = 0; j < e.comps.length; j++) {
                c = e.comps[j];
                if (c.t !== 'ui') continue;
                if (c.k === 'field' || c.k === 'mic.record') continue;
                if (c.k === 'card') {
                    if (cardOpen) { UI.cardEnd(); cardOpen = false; }
                    widgetCard(s, e, c);
                    cardOpen = true;
                } else {
                    drawWidget(s, e, c);
                }
            }
            for (j = 0; j < e.scripts.length; j++) {
                var se = e.scripts[j];
                if (se._ctx) se._ctx.full = full;
                if (se._mod.draw) se._mod.draw.call(se, se._ctx);
            }
        }
        if (cardOpen) { UI.cardEnd(); cardOpen = false; }
        // passada 2: widgets customizados (dependem de UI.touch nao consumido)
        var tr = (UI.touch ? UI.touch() : null) ||
                 { down: false, tap: false, released: false, moved: false, x: -1, y: -1 };
        var used = false;
        for (i = 0; i < s.ents.length; i++) {
            var ent2 = s.ents[i];
            for (j = 0; j < ent2.comps.length; j++) {
                c = ent2.comps[j];
                if (c.t === 'ui' && (c.k === 'field' || c.k === 'mic.record')) {
                    if (drawCustom(s, ent2, c, tr, false) && !used) {
                        // o toque foi consumido, mas os widgets DEPOIS deste
                        // continuam sendo desenhados: o curto-circuito antigo
                        // apagava todo widget custom seguinte no quadro do
                        // toque (piscada a cada tap com 2+ campos)
                        used = true;
                        tr = { down: false, tap: false, released: false,
                               moved: false, x: -1, y: -1 };
                    }
                }
            }
        }
        // script da TELA desenha por cima de tudo (overlay/HUD do programa)
        for (i = 0; i < s.scripts.length; i++) {
            var si = s.scripts[i];
            if (si._ctx) si._ctx.full = full;
            if (si._mod.draw) si._mod.draw.call(si, si._ctx);
        }
    }

    function dispatch(s, evs) {
        var i, j;
        for (i = 0; i < s.scripts.length; i++) {
            var si = s.scripts[i];
            if (si._mod.event) si._mod.event.call(si, evs.name, evs.value, si._ctx);
        }
        for (i = 0; i < s.ents.length; i++) {
            var e = s.ents[i];
            if (evs.source && e.fid !== evs.source) continue;
            for (j = 0; j < e.scripts.length; j++) {
                var se = e.scripts[j];
                if (se._mod.event) se._mod.event.call(se, evs.name, evs.value, se._ctx);
            }
        }
    }

    // ------------------------------------------------------------ boot ----
    var startKey = resolveKey(data.start);
    if (!startKey) {
        for (var k in SC) { startKey = k; break; }
    }
    if (!startKey) return;
    go(startKey, undefined);

    while (!quit && cur) {
        events.length = 0;
        pendingGo = null;
        pendingBack = false;

        var full = UI.begin(cur.bg);
        if (cur.header && UI.header(cur.title, { sub: cur.sub, back: stack.length > 0 })) {
            pendingBack = true;
        }
        // relogio do app: dt do proprio System (o Kui ja faz o pacing)
        var now = S.millis ? S.millis() : 0;
        var dt = cur._last ? Math.min(100, now - cur._last) : 16;
        cur._last = now;

        runUpdate(cur, dt);
        drawFrame(cur, full);

        if (events.length) {
            for (var ei = 0; ei < events.length; ei++) dispatch(cur, events[ei]);
        }
        // persistencia debounced: NVS nao pode levar escrita por quadro
        if (cur.persist && cur.dirtyPersist && now - cur.lastSave > 1000) {
            cur.lastSave = now;
            saveState(cur);
        }

        UI.end(cur.fps);

        if (pendingBack) {
            pendingBack = false;
            back();
        } else if (pendingGo) {
            var g = pendingGo;
            pendingGo = null;
            go(g.key, g.arg);
        }
    }
    if (cur) leave(cur);
}
