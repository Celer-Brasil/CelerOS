'use strict';
// UI (API 22) no host: espelho JS do main/Runtime/JsUi.cpp para o harness
// (test/js_harness) e o emulador (celer.js emu). Mesma semantica do device:
//   - UI.begin le o toque UMA vez (System.getTouch) e devolve true no frame
//     de redesenho total; tap marca o proximo frame como total;
//   - widgets SEMPRE fazem hit-test e so desenham no frame total ou quando a
//     propria assinatura visual muda (limpando o proprio retangulo);
//   - estado por widget em slots (id = geometria ou id explicito).
// `opts.extras` espelha CONFIG_CELEROS_UI_EXTRAS (API 52): com ele o objeto
// ganha UI.custom (area pintada pelo app, limpa/recortada e redesenhada so
// no frame total ou quando a assinatura muda) e UI.clip/UI.unclip (pilha de
// recorte). Sem ele, UI.extras=false e os tres ficam undefined — igual ao
// firmware da CYD. O desenho sai pelas primitivas de env.System resolvidas NA HORA da chamada:
// no harness viram no-op/log (drawString), no emulador pintam o framebuffer.
// Aproximacoes: papeis de fonte -> fontes numericas do emulador (caption 1,
// body/title 2, display 4).

// datum de texto LovyanGFX (coluna = d&3: 0 esq/1 centro/2 dir; linha = d&12:
// 0 topo/4 meio/8 base) — mesmos valores do lgfx vendorado e do renderer
const ML = 4, MC = 5, MR = 6;
const SLOP = 18;
const TAP_MAX_MS = 800;
const HEADER_H = 40;
const SLOTS_MAX = 48;   // kSlots do JsUi.cpp

function makeUI(env, opts) {
    const extras = !!(opts && opts.extras);
    const S = () => env.System;
    const T = () => S().theme();

    const t = { down: false, moved: false, released: false, tap: false, x: 0, y: 0, px: 0, py: 0, sx: 0, sy: 0, t0: 0 };
    let slots = new Map();
    let frameNo = 0;
    let full = true;
    let drawFull = true;
    let tapUsed = false;
    let bgStack = [];
    let scroll = null;   // {x,y,w,h,slot,contentH}
    let toastMsg = '', toastUntil = 0;
    let lastEndMs = 0;   // pacing do UI.end (js_uiEnd: espera o que falta, nao o intervalo cheio)
    let clipStack = [];  // pilha de UI.clip (recortes anteriores; null = sem clip)
    let curClip = null;  // {x,y,w,h} do recorte corrente setado por nos

    // intersecao de dois retangulos (recorte de UI.clip/custom)
    function isect(a, b) {
        const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
        const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
        return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
    }
    function setClipRect(r) {
        curClip = r;
        const Sys = S();
        if (Sys.setClip) Sys.setClip(r.x, r.y, r.w, r.h);
    }
    function clearClipRect() {
        curClip = null;
        const Sys = S();
        if (Sys.clearClip) Sys.clearClip();
    }

    const inR = (px, py, x, y, w, h) => px >= x && px < x + w && py >= y && py < y + h;
    const startOk = () => !scroll || inR(t.sx, t.sy, scroll.x, scroll.y, scroll.w, scroll.h);
    const pressedIn = (x, y, w, h) => t.down && !t.moved && startOk() && inR(t.sx, t.sy, x, y, w, h) && inR(t.x, t.y, x, y, w, h);
    function tapIn(x, y, w, h) {
        if (!t.tap || tapUsed || !startOk()) return false;
        if (!inR(t.sx, t.sy, x, y, w, h) || !inR(t.x, t.y, x, y, w, h)) return false;
        tapUsed = true;
        full = true;
        return true;
    }
    // LRU: o acesso move o slot para o fim do Map; o despejo leva o mais
    // antigo (slots de texto de quadros passados), nunca o da rolagem viva.
    // Mesmo teto do firmware: 48 slots (o 49o despeja o de quadro mais antigo)
    function slot(id) {
        let s = slots.get(id);
        if (s) {
            slots.delete(id);
        } else {
            s = { vis: null, drawn: false, scroll: 0, vel: 0, drag: false, lastMs: 0, box: null };
            if (slots.size >= SLOTS_MAX) slots.delete(slots.keys().next().value);
        }
        slots.set(id, s);
        s.frame = frameNo;
        return s;
    }
    function needDraw(s, vis) {
        const d = drawFull || !s.drawn || s.vis !== vis;
        s.vis = vis;
        s.drawn = true;
        return d ? { clear: !drawFull } : null;
    }
    const bg = () => bgStack.length ? bgStack[bgStack.length - 1] : T().bg;
    const opt = (o, k, def) => (o && typeof o === 'object' && o[k] !== undefined && o[k] !== null) ? o[k] : def;
    const str = (v) => (v === undefined || v === null) ? '' : String(v);
    const roleFont = (role) => role === 'caption' ? 1 : role === 'display' ? 4 : 2;

    // texto com datum LovyanGFX (TL=0 TC=1 TR=2 ML=4 MC=5 MR=6 BL=8 — o
    // renderer e o firmware decodificam coluna = d&3, linha = d&12)
    function text(s, x, y, font, color, datum) {
        const Sys = S();
        if (Sys.setTextDatum) Sys.setTextDatum(datum || 0);
        Sys.setTextColor(color);  // transparente, como o Canvas::text do firmware
        Sys.drawString(s, x, y, font);
        if (Sys.setTextDatum) Sys.setTextDatum(0);
    }
    function ellipsize(s, font, maxW) {
        const Sys = S();
        if (Sys.textWidth(s, font) <= maxW) return s;
        let out = s;
        while (out.length) {
            out = out.slice(0, -1).replace(/ +$/, '');
            if (Sys.textWidth(out + '..', font) <= maxW) return out + '..';
        }
        return '..';
    }
    function wrap(s, font, maxW, maxLines) {
        const Sys = S();
        const out = [];
        let rest = s;
        for (let ln = 0; ln < maxLines && rest.length; ln++) {
            let cut = rest.length;
            while (cut > 0 && Sys.textWidth(rest.slice(0, cut), font) > maxW) {
                const sp = rest.lastIndexOf(' ', cut - 1);
                cut = (sp <= 0) ? cut - 1 : sp;
            }
            if (cut <= 0) cut = 1;
            let line = rest.slice(0, cut);
            rest = rest.slice(cut).replace(/^ +/, '');
            if (ln === maxLines - 1 && rest.length) line = ellipsize(line + ' ' + rest, font, maxW);
            out.push(line);
        }
        return out;
    }

    // ------------------------------------------------------- pintores (Kui)
    function paintButton(x, y, w, h, label, style, pressed, font) {
        const th = T(), Sys = S();
        let fill, tc, stroke = null;
        if (style === 'danger') { fill = pressed ? Sys.mixColor(th.err, 0, 27) : th.err; tc = 0xFFFF; }
        else if (style === 'ghost') { fill = pressed ? th.raised : th.card; tc = th.text; stroke = pressed ? th.accent : th.stroke; }
        else { fill = pressed ? Sys.mixColor(th.accent, 0, 27) : th.accent; tc = th.onAccent; }
        Sys.fillRoundRect(x, y, w, h, 8, fill);
        if (stroke !== null) Sys.drawRoundRect(x, y, w, h, 8, stroke);
        bgStack.push(fill);
        const f = font || 2;
        text(ellipsize(label, f, w - 8), x + (w >> 1), y + (h >> 1), f, tc, MC);
        bgStack.pop();
    }

    function scrollPhysics(s, x, y, w, h, contentH) {
        const now = S().millis();
        const dt = s.lastMs ? now - s.lastMs : 0;
        s.lastMs = now;
        const mine = inR(t.sx, t.sy, x, y, w, h);
        if (t.down && mine) {
            if (t.moved) {
                const dy = t.y - t.py;
                s.scroll -= dy;
                if (dt > 0) s.vel = 0.6 * s.vel + 0.4 * (-dy / dt);
                s.drag = true;
            } else s.vel = 0;
        } else if (t.released && mine && s.drag) {
            s.drag = false;
            s.vel = Math.max(-3, Math.min(3, s.vel));
        } else if (!t.down) {
            s.drag = false;
            if (Math.abs(s.vel) >= 0.02 && dt > 0) {
                const d = Math.min(dt, 50);
                s.scroll += s.vel * d;
                s.vel *= Math.pow(0.995, d);
            } else s.vel = 0;
        }
        const maxS = Math.max(0, contentH - h);
        if (s.scroll < 0) { s.scroll = 0; s.vel = 0; }
        if (s.scroll > maxS) { s.scroll = maxS; s.vel = 0; }
    }

    function itemOf(v) {
        if (v && typeof v === 'object') {
            return { label: str(v.label), sub: str(v.sub), right: str(v.right),
                      bars: typeof v.bars === 'number' ? v.bars : -1, enabled: v.enabled === undefined ? true : !!v.enabled,
                      rightColor: typeof v.rightColor === 'number' ? v.rightColor : null };
        }
        return { label: str(v), sub: '', right: '', bars: -1, enabled: true, rightColor: null };
    }

    function runDialog(title, body, labels, styles) {
        const th = T(), Sys = S();
        const n = labels.length;
        const cw = 200, ch = 150, cx = 20, cy = (320 - ch) >> 1;
        const gap = 10, bw = Math.floor((cw - gap * (n + 1)) / n), by = cy + ch - 44;
        const btn = (i) => ({ x: cx + gap + i * (bw + gap), y: by, w: bw, h: 34 });
        if (typeof env.__uiDialog === 'function') {
            const r = env.__uiDialog(title, body, labels);
            if (typeof r === 'number') { full = true; return r; }
        }
        let down = false, moved = false, sx = 0, sy = 0, last = -2;
        for (;;) {
            const p = Sys.getTouch();
            let hit = -1;
            if (p.touched) {
                if (!down) { sx = p.x; sy = p.y; moved = false; }
                if (Math.abs(p.x - sx) > SLOP || Math.abs(p.y - sy) > SLOP) moved = true;
            }
            for (let i = 0; i < n; i++) { const b = btn(i); if (inR(sx, sy, b.x, b.y, b.w, b.h)) hit = i; }
            const pressed = (p.touched && !moved && hit >= 0) ? hit : -1;
            if (!p.touched && down && !moved && hit >= 0) {
                t.down = false; t.tap = false; t.released = false;
                full = true;
                return hit;
            }
            down = !!p.touched;
            if (pressed !== last) {
                last = pressed;
                Sys.fillRoundRect(cx, cy, cw, ch, 12, th.card);
                Sys.drawRoundRect(cx, cy, cw, ch, 12, th.stroke);
                bgStack.push(th.card);
                text(ellipsize(title, 2, cw - 24), cx + (cw >> 1), cy + 24, 2, th.text, MC);
                const lines = wrap(body, 2, cw - 20, 2);
                for (let i = 0; i < lines.length; i++) text(lines[i], cx + (cw >> 1), cy + 56 + i * 12, 2, th.textDim, MC);
                bgStack.pop();
                for (let i = 0; i < n; i++) { const b = btn(i); paintButton(b.x, b.y, b.w, b.h, labels[i], styles[i], i === pressed); }
            }
            Sys.delay(16);
        }
    }

    const UI = {
        extras: extras,
        begin(bgc) {
            const p = S().getTouch();
            const now = S().millis();
            const was = t.down;
            t.px = t.x; t.py = t.y;
            t.released = false; t.tap = false;
            if (p && p.touched) {
                if (!was) { t.sx = t.px = p.x; t.sy = t.py = p.y; t.t0 = now; t.moved = false; }
                t.x = p.x; t.y = p.y;
                if (Math.abs(p.x - t.sx) > SLOP || Math.abs(p.y - t.sy) > SLOP) t.moved = true;
                t.down = true;
            } else {
                t.released = was;
                t.down = false;
                t.tap = was && !t.moved && (now - t.t0) < TAP_MAX_MS;
            }
            frameNo++;
            tapUsed = false;
            drawFull = full;
            full = false;
            bgStack = [typeof bgc === 'number' ? bgc : T().bg];
            scroll = null;
            // frame novo: clip deixado aberto por um throw nao vale mais
            if (clipStack.length || curClip) { clipStack = []; clearClipRect(); }
            if (drawFull) S().fillScreen(bgStack[0]);
            return drawFull;
        },
        end(fps) {
            if (toastUntil) {
                if (S().millis() < toastUntil) {
                    const th = T(), Sys = S();
                    const m = ellipsize(toastMsg, 2, 208);
                    const tw = Sys.textWidth(m, 2) + 32;
                    Sys.fillRoundRect((240 - tw) >> 1, 266, tw, 32, 16, th.raised);
                    Sys.drawRoundRect((240 - tw) >> 1, 266, tw, 32, 16, th.accent);
                    bgStack.push(th.raised);
                    text(m, 120, 282, 2, th.text, MC);
                    bgStack.pop();
                } else {
                    toastUntil = 0;
                    full = true;
                }
            }
            fps = typeof fps === 'number' ? Math.max(1, Math.min(60, fps | 0)) : 30;
            // js_uiEnd: espera so o QUE FALTA para o periodo (o quadro demorado
            // nao adiciona drift) e o PRIMEIRO end nao espera (s_lastEndMs = 0)
            const now = S().millis();
            let wait = Math.floor(1000 / fps) - (now - lastEndMs);
            if (wait < 0 || lastEndMs === 0) wait = 0;
            if (wait > 1000) wait = 1000;
            S().delay(wait);
            lastEndMs = S().millis();
        },
        invalidate() { full = true; },
        toast(msg, ms) {
            ms = typeof ms === 'number' ? Math.max(300, Math.min(10000, ms)) : 1800;
            if (toastUntil) full = true;
            toastMsg = str(msg);
            toastUntil = S().millis() + ms;
        },
        touch() {
            return { down: t.down, x: t.x, y: t.y, tap: t.tap && !tapUsed, released: t.released, moved: t.moved,
                     sx: t.sx, sy: t.sy };
        },

        text(s, x, y, o) {
            s = str(s);
            const font = roleFont(opt(o, 'role', 'body'));
            const color = opt(o, 'color', T().text);
            const align = opt(o, 'align', 'left');
            const maxW = opt(o, 'w', 0) | 0;
            const lines = Math.max(1, Math.min(64, opt(o, 'lines', 1) | 0));
            const bgc = opt(o, 'bg', bg());
            const datum = align === 'center' ? 1 : align === 'right' ? 2 : 0;
            const lh = S().fontHeight(font);
            const sl = slot('text:' + x + ':' + y + ':' + opt(o, 'id', 0));
            const d = needDraw(sl, [s, color, font, maxW, lines, datum].join('|'));
            if (!d) return sl.box ? sl.box.h : lh;
            if (d.clear && sl.box) S().fillRect(sl.box.x, sl.box.y, sl.box.w, sl.box.h, bgc);
            let ls;
            if (maxW > 0 && lines > 1) ls = wrap(s, font, maxW, lines);
            else if (maxW > 0) ls = [ellipsize(s, font, maxW)];
            else ls = [s];
            if (!ls.length) ls = [''];
            let widest = 0;
            bgStack.push(bgc);
            for (let i = 0; i < ls.length; i++) {
                text(ls[i], x, y + i * lh, font, color, datum);
                widest = Math.max(widest, S().textWidth(ls[i], font));
            }
            bgStack.pop();
            const bx = datum === 1 ? x - (widest >> 1) : datum === 2 ? x - widest : x;
            sl.box = { x: bx - 1, y: y, w: widest + 2, h: ls.length * lh };
            return sl.box.h;
        },
        measure(s, role) { return S().textWidth(str(s), roleFont(role || 'body')); },
        lineHeight(role) { return S().fontHeight(roleFont(role || 'body')); },
        measureWrap(s, w, role) {
            const f = roleFont(role || 'body');
            return Math.max(1, wrap(str(s), f, w, 64).length) * S().fontHeight(f);
        },

        header(title, o) {
            title = str(title);
            const sub = str(opt(o, 'sub', ''));
            const back = !!opt(o, 'back', false);
            const tapped = back && tapIn(0, 0, HEADER_H + 8, HEADER_H);
            const pressed = back && pressedIn(0, 0, HEADER_H + 8, HEADER_H);
            const sl = slot('header');
            if (needDraw(sl, [title, sub, back, pressed].join('|'))) {
                const th = T(), Sys = S();
                Sys.fillRect(0, 0, 240, HEADER_H, th.card);
                Sys.drawFastHLine(0, HEADER_H - 1, 240, th.stroke);
                bgStack.push(th.card);
                let tx = 24;
                if (back) {
                    if (pressed) Sys.fillRoundRect(4, 4, HEADER_H - 8, HEADER_H - 8, 8, th.raised);
                    const c = HEADER_H >> 1, a = Math.round(HEADER_H / 6), col = pressed ? th.text : th.accent;
                    for (let k = -1; k <= 1; k++) {
                        Sys.drawLine(c + (a >> 1) + k, c - a, c - (a >> 1) + k, c, col);
                        Sys.drawLine(c - (a >> 1) + k, c, c + (a >> 1) + k, c + a, col);
                    }
                    tx = HEADER_H;
                } else {
                    const mh = Math.round(HEADER_H / 3);
                    Sys.fillRoundRect(12, (HEADER_H - mh) >> 1, 4, mh, 2, th.accent);
                }
                let right = 228;
                if (sub) { text(sub, right, HEADER_H >> 1, 1, th.textDim, MR); right -= Sys.textWidth(sub, 1) + 8; }
                text(ellipsize(title, 2, right - tx), tx, HEADER_H >> 1, 2, th.text, ML);
                bgStack.pop();
            }
            return tapped;
        },

        button(label, x, y, w, h, o) {
            label = str(label);
            const disabled = !!opt(o, 'disabled', false);
            let style = opt(o, 'style', 'primary');
            if (disabled) style = 'ghost';
            const tapped = !disabled && tapIn(x, y, w, h);
            const pressed = !disabled && pressedIn(x, y, w, h);
            const sl = slot('btn:' + [x, y, w, h, opt(o, 'id', 0)].join(':'));
            const cFill = opt(o, 'color', -1), cText = opt(o, 'textColor', T().text), role = opt(o, 'role', 'body');
            const d = needDraw(sl, [label, style, pressed, disabled, cFill, cText, role].join('|'));
            if (d) {
                if (d.clear) S().fillRect(x, y, w, h, bg());
                if (cFill >= 0 && !disabled) {
                    const fill = pressed ? S().mixColor(cFill, 0, 27) : cFill;
                    S().fillRoundRect(x, y, w, h, 8, fill);
                    if (pressed) S().drawRoundRect(x, y, w, h, 8, T().accent);
                    bgStack.push(fill);
                    text(ellipsize(label, roleFont(role), w - 8), x + (w >> 1), y + (h >> 1), roleFont(role), cText, MC);
                    bgStack.pop();
                } else {
                    paintButton(x, y, w, h, label, style, pressed, roleFont(role));
                }
                if (disabled) {
                    const th = T();
                    S().fillRoundRect(x + 1, y + 1, w - 2, h - 2, 8, th.card);
                    bgStack.push(th.card);
                    text(ellipsize(label, 2, w - 8), x + (w >> 1), y + (h >> 1), 2, th.textDim, MC);
                    bgStack.pop();
                }
            }
            return tapped;
        },

        toggle(x, y, on, o) {
            on = !!on;
            const w = 44, h = 24, pad = 6;
            if (tapIn(x - pad, y - pad, w + 2 * pad, h + 2 * pad)) on = !on;
            const pressed = pressedIn(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
            const sl = slot('tgl:' + [x, y, opt(o, 'id', 0)].join(':'));
            const d = needDraw(sl, (on ? 1 : 0) | (pressed ? 2 : 0));
            if (d) {
                const th = T(), Sys = S();
                if (d.clear) Sys.fillRect(x, y, w, h, bg());
                Sys.fillRoundRect(x, y, w, h, h >> 1, on ? th.accent : (pressed ? th.raised : th.card));
                Sys.drawRoundRect(x, y, w, h, h >> 1, th.stroke);
                const k = h - 6;
                Sys.fillCircle(on ? x + w - (k >> 1) - 3 : x + (k >> 1) + 3, y + (h >> 1), k >> 1, pressed ? th.textDim : th.text);
            }
            return on;
        },

        slider(x, y, w, v, o) {
            const mn = opt(o, 'min', 0), mx0 = opt(o, 'max', 100), step = Math.max(1, opt(o, 'step', 1));
            const mx = mx0 <= mn ? mn + 1 : mx0;
            const h = 28;
            v = +v || 0;
            const active = t.down && startOk() && inR(t.sx, t.sy, x - 8, y, w + 16, h);
            if (active) {
                const rel = Math.max(0, Math.min(w, t.x - x));
                let nv = mn + rel * (mx - mn) / (w || 1);
                nv = mn + Math.floor((nv - mn) / step + 0.5) * step;
                v = Math.min(mx, nv);
            }
            v = Math.max(mn, Math.min(mx, v));
            const pct = Math.round((v - mn) * 100 / (mx - mn));
            const sl = slot('sld:' + [x, y, w, opt(o, 'id', 0)].join(':'));
            const d = needDraw(sl, pct + (active ? 1000 : 0));
            if (d) {
                const th = T(), Sys = S();
                if (d.clear) Sys.fillRect(x - 10, y, w + 20, h, bg());
                const bh = 12, by = y + ((h - bh) >> 1);
                Sys.fillRoundRect(x, by, w, bh, bh >> 1, th.card);
                Sys.drawRoundRect(x, by, w, bh, bh >> 1, th.stroke);
                const fw = Math.round(w * pct / 100);
                if (fw > bh) Sys.fillRoundRect(x, by, fw, bh, bh >> 1, active ? th.accentD : th.accent);
                Sys.fillCircle(x + fw, by + (bh >> 1), 9, th.text);
            }
            return v;
        },

        progress(x, y, w, h, pct) {
            pct = Math.max(0, Math.min(100, pct | 0));
            const sl = slot('prg:' + [x, y, w, h].join(':'));
            const d = needDraw(sl, pct);
            if (d) {
                const th = T(), Sys = S();
                if (d.clear) Sys.fillRect(x, y, w, h, bg());
                const bh = Math.min(10, h), by = y + ((h - bh) >> 1);
                Sys.fillRoundRect(x, by, w, bh, bh >> 1, th.card);
                Sys.drawRoundRect(x, by, w, bh, bh >> 1, th.stroke);
                const fw = Math.round(w * pct / 100);
                if (fw > bh) Sys.fillRoundRect(x, by, fw, bh, bh >> 1, th.accent);
            }
        },

        spinner(cx, cy, r, color) {
            if (!(r > 0)) return;
            const Sys = S();
            Sys.fillRect(cx - r, cy - r, 2 * r, 2 * r, bg());
            const a = (Sys.millis() % 1000) * 360 / 1000;
            if (Sys.fillArc) Sys.fillArc(cx, cy, r - 3, r, a, a + 90, typeof color === 'number' ? color : T().accent);
        },

        list(id, x, y, w, h, items, o) {
            items = Array.isArray(items) ? items : [];
            const n = items.length;
            let rowH = opt(o, 'rowH', 0) | 0;
            const selected = opt(o, 'selected', -1);
            if (rowH <= 0) {
                rowH = 36;
                for (let i = 0; i < n && i < 32; i++) if (itemOf(items[i]).sub) { rowH = 48; break; }
            }
            const sl = slot('list:' + str(id));
            const contentH = n * rowH;
            // lista nova com item selecionado: abre rolada ate ele (centrado)
            if (!sl.drawn && sl.scroll === 0 && selected > 0 && selected * rowH + rowH > h) {
                sl.scroll = selected * rowH - Math.floor((h - rowH) / 2);
            }
            scrollPhysics(sl, x, y, w, h, contentH);
            const sc = Math.floor(sl.scroll);
            let result = -1;
            if (!sl.drag && tapIn(x, y, w, h)) {
                const idx = Math.floor((t.sy - y + sc) / rowH);
                if (idx >= 0 && idx < n && itemOf(items[idx]).enabled) result = idx;
            }
            const pressedRow = (!sl.drag && pressedIn(x, y, w, h)) ? Math.floor((t.sy - y + sc) / rowH) : -1;
            const first = Math.floor(sc / rowH);
            const sigParts = [sc, pressedRow, selected, n];
            for (let i = first; i < n && (i - first) * rowH < h + rowH; i++) {
                const it = itemOf(items[i]);
                sigParts.push(it.label, it.sub, it.right, it.bars, it.enabled, it.rightColor);
            }
            const d = needDraw(sl, sigParts.join('|'));
            if (d) {
                const th = T(), Sys = S();
                if (d.clear) Sys.fillRect(x, y, w, h, bg());
                Sys.fillRoundRect(x, y, w, h, 10, th.card);
                bgStack.push(th.card);
                if (Sys.setClip) Sys.setClip(x, y + 2, w, h - 4);
                for (let i = first; i < n; i++) {
                    const ry = y + i * rowH - sc;
                    if (ry >= y + h) break;
                    const it = itemOf(items[i]);
                    if (i === selected) Sys.fillRoundRect(x + 4, ry + 2, w - 8, rowH - 4, 6, th.accentD);
                    else if (it.enabled && i === pressedRow) Sys.fillRoundRect(x + 4, ry + 2, w - 8, rowH - 4, 6, th.raised);
                    if (i + 1 < n) Sys.drawFastHLine(x + 12, ry + rowH - 1, w - 24, th.bg);
                    let rx = x + w - 12;
                    if (it.bars >= 0) {
                        for (let b = 0; b < 4; b++) {
                            const bh = Math.round(14 * (b + 1) / 4);
                            Sys.fillRect(rx - 18 + b * 5, ry + (rowH >> 1) + 7 - bh, 3, bh, b < it.bars ? th.accent : th.stroke);
                        }
                        rx -= 26;
                    }
                    if (it.right) {
                        text(it.right, rx, ry + (rowH >> 1), 1, it.rightColor !== null ? it.rightColor : th.textDim, MR);
                        rx -= Sys.textWidth(it.right, 1) + 8;
                    }
                    const col = it.enabled ? th.text : th.textDim;
                    if (it.sub) {
                        text(ellipsize(it.label, 2, rx - x - 12), x + 12, ry + (rowH >> 1) - 9, 2, col, 0);
                        text(ellipsize(it.sub, 1, rx - x - 12), x + 12, ry + (rowH >> 1) + 2, 1, th.textDim, 0);
                    } else {
                        text(ellipsize(it.label, 2, rx - x - 12), x + 12, ry + (rowH >> 1), 2, col, ML);
                    }
                }
                if (Sys.clearClip) Sys.clearClip();
                bgStack.pop();
                if (contentH > h) {
                    const trackH = h - 20, barH = Math.max(16, Math.round(trackH * h / contentH));
                    const barY = y + 10 + Math.round((trackH - barH) * sc / (contentH - h));
                    Sys.fillRoundRect(x + w - 5, barY, 3, barH, 1, th.stroke);
                }
            }
            return result;
        },

        tabs(x, y, w, h, labels, sel) {
            labels = Array.isArray(labels) ? labels.slice(0, 8).map(str) : [];
            const n = labels.length;
            if (!n) return sel;
            const segW = Math.floor(w / n);
            if (t.tap && inR(t.sx, t.sy, x, y, w, h)) {
                const i = Math.min(n - 1, Math.floor((t.sx - x) / segW));
                if (tapIn(x, y, w, h)) sel = i;
            }
            const pressed = pressedIn(x, y, w, h) ? Math.floor((t.sx - x) / segW) : -1;
            const sl = slot('tabs:' + [x, y, w, h].join(':'));
            const d = needDraw(sl, [sel, pressed].concat(labels).join('|'));
            if (d) {
                const th = T(), Sys = S();
                if (d.clear) Sys.fillRect(x, y, w, h, bg());
                Sys.fillRoundRect(x, y, w, h, h >> 1, th.card);
                Sys.drawRoundRect(x, y, w, h, h >> 1, th.stroke);
                const pad = 3, sw = Math.floor((w - 2 * pad) / n);
                for (let i = 0; i < n; i++) {
                    const sx = x + pad + i * sw, sy = y + pad, sh = h - 2 * pad;
                    let tc = th.textDim, fill = th.card;
                    if (i === sel) { fill = th.accent; tc = th.onAccent; Sys.fillRoundRect(sx, sy, sw, sh, sh >> 1, fill); }
                    else if (i === pressed) { fill = th.raised; tc = th.text; Sys.fillRoundRect(sx, sy, sw, sh, sh >> 1, fill); }
                    bgStack.push(fill);
                    text(ellipsize(labels[i], 2, sw - 6), sx + (sw >> 1), sy + (sh >> 1), 2, tc, MC);
                    bgStack.pop();
                }
            }
            return sel;
        },

        card(x, y, w, h, o) {
            const th = T();
            const color = opt(o, 'color', th.card);
            const radius = opt(o, 'radius', 10);
            if (drawFull) {
                S().fillRoundRect(x, y, w, h, radius, color);
                if (opt(o, 'stroke', false)) S().drawRoundRect(x, y, w, h, radius, th.stroke);
            }
            bgStack.push(color);
        },
        cardEnd() { if (bgStack.length > 1) bgStack.pop(); },

        scrollBegin(id, x, y, w, h, contentH) {
            const sl = slot('scroll:' + str(id));
            const before = Math.floor(sl.scroll);
            scrollPhysics(sl, x, y, w, h, contentH | 0);
            const off = Math.floor(sl.scroll);
            if (off !== before) full = true;
            scroll = { x, y, w, h, slot: sl, contentH: contentH | 0, prevClip: curClip };
            setClipRect(curClip ? isect(curClip, { x, y, w, h }) : { x, y, w, h });
            return off;
        },
        scrollEnd() {
            if (!scroll) return;
            const sc = scroll;
            scroll = null;
            if (sc.prevClip) setClipRect(sc.prevClip); else clearClipRect();
            if (drawFull && sc.contentH > sc.h) {
                const barH = Math.max(16, Math.round(sc.h * sc.h / sc.contentH));
                const maxS = sc.contentH - sc.h;
                const barY = sc.y + Math.round((sc.h - barH) * sc.slot.scroll / maxS);
                S().fillRoundRect(sc.x + sc.w - 4, barY, 3, barH, 1, T().stroke);
            }
        },
        scrollTo(id, y) {
            y = Math.max(0, Math.min(1e6, +y || 0));
            for (const k of ['list:' + str(id), 'scroll:' + str(id)]) {
                const sl = slot(k);
                if (Math.floor(sl.scroll) !== Math.floor(y)) full = true;
                sl.scroll = y; sl.vel = 0; sl.drawn = false;
            }
        },
        resetScroll(id) {
            for (const k of ['list:' + str(id), 'scroll:' + str(id)]) {
                const s = slots.get(k);
                if (s) { s.scroll = 0; s.vel = 0; s.drag = false; s.drawn = false; }
            }
        },

        badge(s, x, y, o) {
            s = str(s);
            const th = T(), Sys = S();
            const color = opt(o, 'color', th.accentD), tc = opt(o, 'textColor', th.text);
            const sl = slot('badge:' + x + ':' + y);
            const d = needDraw(sl, [s, color, tc].join('|'));
            if (d) {
                if (d.clear && sl.box) Sys.fillRect(sl.box.x, sl.box.y, sl.box.w, sl.box.h, bg());
                const h = Sys.fontHeight(1) + 6, w = Sys.textWidth(s, 1) + 14;
                Sys.fillRoundRect(x, y, w, h, h >> 1, color);
                bgStack.push(color);
                text(s, x + (w >> 1), y + (h >> 1), 1, tc, MC);
                bgStack.pop();
                sl.box = { x, y, w, h };
            }
            return sl.box ? sl.box.w : 0;
        },

        confirm(title, body, o) {
            const labels = [str(opt(o, 'no', 'Cancelar')), str(opt(o, 'yes', 'OK'))];
            const styles = ['ghost', opt(o, 'danger', false) ? 'danger' : 'primary'];
            return runDialog(str(title), str(body), labels, styles) === 1;
        },
        alert(title, body, ok) {
            runDialog(str(title), str(body), [typeof ok === 'string' ? ok : 'OK'], ['primary']);
        },
    };

    if (extras) {
        // UI.custom: area PINTADA PELO APP. O slot limpa o retangulo no frame
        // parcial, recorta e chama draw(x, y, w, h) quando o frame e' total ou
        // a assinatura muda. O callback pinta TUDO com System.* (nao use
        // UI.text/UI.card dentro: os slots deles pulariam no parcial e o
        // clear apagaria o que ficou do quadro anterior). Nao consome tap.
        UI.custom = function (id, x, y, w, h, sig, draw, o) {
            if (typeof draw !== 'function') return false;
            const sl = slot('custom:' + str(id) + ':' + x + ':' + y + ':' + w + ':' + h);
            const d = needDraw(sl, sig);
            if (!d) return false;
            const Sys = S();
            const bgc = opt(o, 'bg', bg());
            const paint = opt(o, 'clear', true) !== false;
            const saved = curClip;
            const r = saved ? isect(saved, { x, y, w, h }) : { x, y, w, h };
            if (d.clear && paint) Sys.fillRect(x, y, w, h, bgc);
            setClipRect(r);
            try {
                draw(x, y, w, h);
            } finally {
                if (saved) setClipRect(saved); else clearClipRect();
            }
            return true;
        };
        // UI.clip/unclip: pilha de recortes (coords virtuais), par com o
        // begin que cura um clip deixado aberto.
        UI.clip = function (x, y, w, h) {
            clipStack.push(curClip);
            setClipRect(curClip ? isect(curClip, { x, y, w, h }) : { x, y, w, h });
        };
        UI.unclip = function () {
            if (!clipStack.length) return;
            const prev = clipStack.pop();
            if (prev) setClipRect(prev); else clearClipRect();
        };
    }
    return UI;
}

module.exports = { makeUI };
