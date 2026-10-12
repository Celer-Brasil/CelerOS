'use strict';
// Renderer headless do emulador: framebuffer 240x320 RGB565 em Node puro
// (sem canvas nativo) com o subconjunto de desenho da API JS. Instalado como
// `wire` do runApp (test/js_harness): sobrepoe os stubs no-op do makeEnv, que
// continua sendo a fonte de System/FS/Net/CelerLink — zero duplicacao.
//
// Aproximacoes conscientes (preview, nao pixel-perfect com o device):
//   - texto: glifos 8x8 (font8x8 public domain), metrica {1:6, 2:8, 4:16}px
//     por caractere (textWidth coerente com o desenho — layouts centrados
//     batem entre si, nao com a fonte real do firmware);
//   - drawPNG/drawIcon renderizam a arte DE VERDADE (decodePng: color types
//     0/2/3/4/6, alfa composto no RGB565; caminhos /local|/sd/apps/<pasta>/
//     sao resolvidos para as pastas do repo); drawJPG/drawBMP seguem no-op.

const { glyph } = require('./font8x8.js');
const { encodePng, decodePng } = require('./png.js');
const fs = require('fs');
const path = require('path');

const W = 240, H = 320;
const ADVANCE = { 1: 6, 2: 8, 4: 16 };   // px por caractere por tamanho de fonte

class Renderer {
    constructor() {
        // tamanho do vidro emulado: 240x320 virtual; o canvas nativo
        // (setNativeCanvas, API 28) troca para o do harness (480x480) — antes
        // ficava fixo e os jogos nativos saiam cortados no quarto de cima
        this.w = W;
        this.h = H;
        this.fb = new Uint16Array(W * H);  // RGB565
        this.fg = 0xFFFF;
        this.bg = 0x0000;
        this.textSize = 1;
        this.textDatum = 0;    // TL (ancoras 0..10 do LovyanGFX)
        this.sprite = null;     // sprite CORRENTE ({ w, h, fb }): createSprite/useSprite o definem
        this.sprites = [];      // pool por id 1-based como o firmware: sprites[id-1] (null = livre)
        this.bound = false;     // useSprite(id)/bindSprite(true): draws vao ao sprite (contrato do firmware)
        this.unsupported = new Set();
        this.clip = null;       // {x,y,w,h} de setClip (null = alvo inteiro)
    }

    // ------------------------------------------------------------ pixgrade
    target() { return (this.bound && this.sprite) ? this.sprite.fb : this.fb; }
    targetW() { return (this.bound && this.sprite) ? this.sprite.w : this.w; }
    targetH() { return (this.bound && this.sprite) ? this.sprite.h : this.h; }

    // novo tamanho de tela (fb limpo, como o quadro recriado no firmware)
    resize(w, h) {
        w = Math.max(1, w | 0); h = Math.max(1, h | 0);
        if (w === this.w && h === this.h) return;
        this.w = w; this.h = h;
        this.fb = new Uint16Array(w * h);
        this.clip = null;
    }

    px(x, y, c) {
        x |= 0; y |= 0;
        if (x < 0 || y < 0 || x >= this.targetW() || y >= this.targetH()) return;
        const k = this.clip;
        if (k && (x < k.x || y < k.y || x >= k.x + k.w || y >= k.y + k.h)) return;
        this.target()[y * this.targetW() + x] = c & 0xFFFF;
    }

    hLine(x, y, w, c) { for (let i = 0; i < w; i++) this.px(x + i, y, c); }
    vLine(x, y, h, c) { for (let i = 0; i < h; i++) this.px(x, y + i, c); }

    // imagem RGBA ({w,h,rgba}) no ponto, alfa straight composto no RGB565 do
    // alvo corrente (como o drawPNG do firmware compoe)
    blitRGBA(img, x, y) {
        x |= 0; y |= 0;
        const tw = this.targetW(), th = this.targetH(), tgt = this.target();
        for (let j = 0; j < img.h; j++) {
            const yy = y + j;
            if (yy < 0 || yy >= th) continue;
            for (let i = 0; i < img.w; i++) {
                const k = (j * img.w + i) * 4;
                const a = img.rgba[k + 3];
                if (a === 0) continue;
                const xx = x + i;
                if (xx < 0 || xx >= tw) continue;
                const r = img.rgba[k], g = img.rgba[k + 1], b = img.rgba[k + 2];
                if (a === 255) {
                    this.px(xx, yy, ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
                } else {
                    const d = tgt[yy * tw + xx];
                    const dr = (d >> 8) & 0xF8, dg = (d >> 3) & 0xFC, db = (d << 3) & 0xF8;
                    const mix = (s, t) => Math.round((s * a + t * (255 - a)) / 255);
                    this.px(xx, yy, ((mix(r, dr) & 0xF8) << 8) | ((mix(g, dg) & 0xFC) << 3) | (mix(b, db) >> 3));
                }
            }
        }
    }

    rect(x, y, w, h, c, filled) {
        if (filled) {
            for (let j = 0; j < h; j++) this.hLine(x, y + j, w, c);
        } else {
            this.hLine(x, y, w, c);
            this.hLine(x, y + h - 1, w, c);
            this.vLine(x, y, h, c);
            this.vLine(x + w - 1, y, h, c);
        }
    }

    // cantos de circulo para roundRect: quadrantes (cx,cy,r)
    // qx/qy (-1/1) restringem ao quadrante do canto (0 = circulo inteiro)
    corner(cx, cy, r, c, filled, qx = 0, qy = 0) {
        for (let dy = -r; dy <= r; dy++) {
            if (qy && dy * qy < 0) continue;
            for (let dx = -r; dx <= r; dx++) {
                if (qx && dx * qx < 0) continue;
                const d2 = dx * dx + dy * dy;
                if (filled ? d2 <= r * r : (d2 <= r * r && d2 >= (r - 1) * (r - 1))) {
                    this.px(cx + dx, cy + dy, c);
                }
            }
        }
    }

    roundRect(x, y, w, h, r, c, filled) {
        const r2 = Math.max(0, Math.min(r, Math.floor(Math.min(w, h) / 2)));
        // miolo + faixas (sem os cantos)
        if (filled) {
            for (let j = r2; j < h - r2; j++) this.hLine(x, y + j, w, c);
            for (let j = 0; j < r2; j++) {
                const dy = r2 - j;
                const half = Math.round(Math.sqrt(Math.max(0, r2 * r2 - dy * dy)));
                this.hLine(x + r2 - half, y + j, (w - 2 * r2) + 2 * half, c);
                this.hLine(x + r2 - half, y + h - 1 - j, (w - 2 * r2) + 2 * half, c);
            }
        } else {
            this.hLine(x + r2, y, w - 2 * r2, c);
            this.hLine(x + r2, y + h - 1, w - 2 * r2, c);
            this.vLine(x, y + r2, h - 2 * r2, c);
            this.vLine(x + w - 1, y + r2, h - 2 * r2, c);
            this.corner(x + r2, y + r2, r2, c, false, -1, -1);
            this.corner(x + w - 1 - r2, y + r2, r2, c, false, 1, -1);
            this.corner(x + r2, y + h - 1 - r2, r2, c, false, -1, 1);
            this.corner(x + w - 1 - r2, y + h - 1 - r2, r2, c, false, 1, 1);
        }
    }

    line(x0, y0, x1, y1, c) {
        x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
        const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
            this.px(x0, y0, c);
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
        }
    }

    circle(cx, cy, r, c, filled) {
        cx |= 0; cy |= 0; r = Math.max(0, r | 0);
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const d2 = dx * dx + dy * dy;
                if (filled ? d2 <= r * r : (d2 <= r * r && d2 >= (r - 1) * (r - 1))) {
                    this.px(cx + dx, cy + dy, c);
                }
            }
        }
    }

    // triângulo cheio por scanline (interpola as duas arestas ate o vertice
    // medio); contorno por tres linhas
    triangle(x0, y0, x1, y1, x2, y2, c, filled) {
        if (!filled) {
            this.line(x0, y0, x1, y1, c);
            this.line(x1, y1, x2, y2, c);
            this.line(x2, y2, x0, y0, c);
            return;
        }
        const pts = [[x0, y0], [x1, y1], [x2, y2]].sort((a, b) => a[1] - b[1]);
        const ax = pts[0][0], ay = pts[0][1];
        const bx = pts[1][0], by = pts[1][1];
        const cx = pts[2][0], cy2 = pts[2][1];
        for (let y = ay; y <= cy2; y++) {
            const t1 = cy2 === ay ? 0 : (y - ay) / (cy2 - ay);
            let xl = ax + (cx - ax) * t1;
            let xr;
            if (y <= by) {
                const t2 = by === ay ? 0 : (y - ay) / (by - ay);
                xr = ax + (bx - ax) * t2;
            } else {
                const t3 = cy2 === by ? 0 : (y - by) / (cy2 - by);
                xr = bx + (cx - bx) * t3;
            }
            if (xl > xr) { const t = xl; xl = xr; xr = t; }
            this.hLine(Math.round(xl), y, Math.max(1, Math.round(xr) - Math.round(xl) + 1), c);
        }
    }

    // ------------------------------------------------- primitivas API 22
    // mistura RGB565 (pct 0 = a, 100 = b) — mesma conta do js_mixColor
    static mix(a, b, p) {
        p = Math.max(0, Math.min(100, p | 0));
        const ch = (sh, m) => {
            const ca = (a >> sh) & m, cb = (b >> sh) & m;
            return ((ca + Math.trunc((cb - ca) * p / 100)) & m) << sh;
        };
        return ch(11, 0x1F) | ch(5, 0x3F) | ch(0, 0x1F);
    }

    // gradiente vertical em retangulo (arredondado quando r > 0)
    gradient(x, y, w, h, top, bottom, r) {
        const r2 = Math.max(0, Math.min(r | 0, Math.floor(Math.min(w, h) / 2)));
        for (let j = 0; j < h; j++) {
            const c = Renderer.mix(top, bottom, h > 1 ? Math.round(j * 100 / (h - 1)) : 0);
            let inset = 0;
            const dy = j < r2 ? r2 - j : (j >= h - r2 ? j - (h - 1 - r2) : 0);
            if (dy > 0) inset = r2 - Math.round(Math.sqrt(Math.max(0, r2 * r2 - dy * dy)));
            this.hLine(x + inset, y + j, w - 2 * inset, c);
        }
    }

    // arco cheio: angulos em graus, 0 = 3h, sentido horario (LovyanGFX)
    arc(cx, cy, r0, r1, a0, a1, c) {
        const rin = Math.min(r0, r1), rout = Math.max(r0, r1);
        let span = a1 - a0;
        while (span < 0) span += 360;
        for (let dy = -rout; dy <= rout; dy++) {
            for (let dx = -rout; dx <= rout; dx++) {
                const d2 = dx * dx + dy * dy;
                if (d2 > rout * rout || d2 < rin * rin) continue;
                let a = Math.atan2(dy, dx) * 180 / Math.PI;
                let rel = a - a0;
                while (rel < 0) rel += 360;
                while (rel >= 360) rel -= 360;
                if (rel <= span || span >= 360) this.px(cx + dx, cy + dy, c);
            }
        }
    }

    // linha grossa (sem AA no preview): discos ao longo do segmento
    wideLine(x0, y0, x1, y1, wd, c) {
        const r = Math.max(0.5, wd / 2);
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
        for (let i = 0; i <= n; i++) {
            this.circle(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), Math.round(r), c, true);
        }
    }

    // ---------------------------------------------------------------- texto
    // Metrica por tamanho de fonte (aproximacao; textWidth e drawString usam
    // a MESMA tabela para layouts centrados baterem entre si)
    glyphW(font) { return (ADVANCE[font] || 8 * Math.max(1, font)) * Math.max(1, this.textSize); }
    glyphH(font) { return 8 * Math.max(1, Math.round(this.glyphW(font) / 8)); }

    drawString(s, x, y, font) {
        s = String(s);
        font = font || 1;
        const g = this.glyphW(font);
        const h = this.glyphH(font);
        const w = s.length * g;
        // datum no layout do LovyanGFX (o do firmware, nao o do TFT_eSPI):
        // coluna = d & 3 (0 esq, 1 centro, 2 dir), linha = d & 12 (0 topo,
        // 4 meio, 8 base) — 0=TL 1=TC 2=TR 4=ML 5=MC 6=MR 8=BL 9=BC 10=BR
        const d = this.textDatum;
        const col = d & 3, row = d & 12;
        if (col === 1) x -= w / 2;
        else if (col === 2) x -= w;
        if (row === 4) y -= h / 2;
        else if (row === 8) y -= h;
        const src = Math.max(1, Math.round(g / 8));      // escala do glifo 8x8
        const cols = Math.min(8, Math.round(g / src));   // font1: 6 colunas
        for (let i = 0; i < s.length; i++) {
            const code = s.charCodeAt(i);
            const bm = glyph(code) || glyph(0x7F);  // fora da cobertura: bloco
            const gx = x + i * g;
            for (let row = 0; row < 8; row++) {
                for (let col = 0; col < cols; col++) {
                    const on = (bm[row] >> col) & 1;
                    if (!on && this.bg === null) continue;   // setTextColor(fg): fundo transparente
                    const c = on ? this.fg : this.bg;
                    // pinta o bloco escalado do pixel do glifo
                    for (let sy = 0; sy < src; sy++) {
                        for (let sx = 0; sx < src; sx++) {
                            this.px(gx + col * src + sx, y + row * src + sy, c);
                        }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ snapshot
    rgb888() {
        const out = Buffer.alloc(this.w * this.h * 3);
        for (let i = 0; i < this.w * this.h; i++) {
            const p = this.fb[i];
            out[i * 3] = ((p >> 11) & 0x1F) * 255 / 31 | 0;
            out[i * 3 + 1] = ((p >> 5) & 0x3F) * 255 / 63 | 0;
            out[i * 3 + 2] = (p & 0x1F) * 255 / 31 | 0;
        }
        return out;
    }

    png() { return encodePng(this.w, this.h, this.rgb888(), false); }

    // ---------------------------------------------------------------- wire
    // Sobrepoe os stubs de desenho do makeEnv (mantem o resto: touch, FS,
    // relógio, etc). wire de teste do usuario roda DEPOIS e pode ajustar.
    wire(env) {
        const r = this;
        const S = env.System;
        S.fillScreen = (c) => { r.target().fill((c == null ? 0 : c) & 0xFFFF); };
        // canvas nativo: o harness passa a informar o vidro (screenWidth/
        // Height) e o fb acompanha
        const origNative = S.setNativeCanvas;
        if (typeof origNative === 'function') {
            S.setNativeCanvas = (on) => {
                const ok = origNative(on);
                if (ok) r.resize(S.screenWidth(), S.screenHeight());
                return ok;
            };
        }
        S.fillRect = (x, y, w, h, c) => r.rect(x, y, w, h, c, true);
        S.drawRect = (x, y, w, h, c) => r.rect(x, y, w, h, c, false);
        S.drawLine = (x0, y0, x1, y1, c) => r.line(x0, y0, x1, y1, c);
        S.drawPixel = (x, y, c) => r.px(x, y, c);
        S.drawFastHLine = (x, y, w, c) => r.hLine(x, y, w, c);
        S.drawFastVLine = (x, y, h, c) => r.vLine(x, y, h, c);
        S.drawCircle = (x, y, rad, c) => r.circle(x, y, rad, c, false);
        S.fillCircle = (x, y, rad, c) => r.circle(x, y, rad, c, true);
        S.drawTriangle = (x0, y0, x1, y1, x2, y2, c) => r.triangle(x0, y0, x1, y1, x2, y2, c, false);
        S.fillTriangle = (x0, y0, x1, y1, x2, y2, c) => r.triangle(x0, y0, x1, y1, x2, y2, c, true);
        S.drawRoundRect = (x, y, w, h, rad, c) => r.roundRect(x, y, w, h, rad, c, false);
        S.fillRoundRect = (x, y, w, h, rad, c) => r.roundRect(x, y, w, h, rad, c, true);
        // como o LovyanGFX: sem cor de fundo o texto e transparente
        S.setTextColor = (fg, bg) => { r.fg = fg; r.bg = (bg == null ? null : bg); };
        S.setTextSize = (sz) => { r.textSize = Math.max(1, sz | 0); };
        S.setTextDatum = (d) => { d = d | 0; r.textDatum = d < 0 || d > 10 ? 0 : d; };   // firmware: fora de 0..10 vira TL
        S.drawString = (s, x, y, font) => r.drawString(s, x, y, font);
        S.setClip = (x, y, w, h) => { r.clip = { x: x | 0, y: y | 0, w: Math.max(0, w | 0), h: Math.max(0, h | 0) }; };
        S.clearClip = () => { r.clip = null; };
        S.fillGradient = (x, y, w, h, top, bottom, rad) => r.gradient(x, y, w, h, top, bottom, rad || 0);
        S.fillArc = (cx, cy, r0, r1, a0, a1, c) => r.arc(cx, cy, r0, r1, a0, a1, c);
        S.fillSmoothCircle = (x, y, rad, c) => r.circle(x, y, rad, c, true);
        S.fillSmoothRoundRect = (x, y, w, h, rad, c) => r.roundRect(x, y, w, h, rad, c, true);
        S.drawWideLine = (x0, y0, x1, y1, wd, c) => r.wideLine(x0, y0, x1, y1, wd, c);
        S.mixColor = (a, b, p) => Renderer.mix(a, b, p);
        S.textWidth = (s, font) => String(s).length * r.glyphW(font || 1);
        S.fontHeight = (font) => r.glyphH(font || 1);
        // sprites por id (contrato do firmware, JsGfx.cpp: pool de ids
        // 1..16 — createSprite devolve o id e o novo vira o CORRENTE sem
        // bindar; useSprite(id) seleciona E binda o alvo, useSprite(0)
        // volta ao quadro/display; pushSprite(x, y, key?) blita o sprite
        // corrente na TELA com cor-chave opcional)
        S.createSprite = (w, h) => {
            w = Math.max(1, w | 0); h = Math.max(1, h | 0);
            let slot = -1;
            for (let i = 0; i < 16; i++) if (!r.sprites[i]) { slot = i; break; }
            if (slot < 0) {   // pool cheio: recicla o corrente (compat do firmware)
                for (let j = 0; j < 16; j++) if (r.sprites[j] === r.sprite) { slot = j; break; }
                if (slot < 0) return 0;
            }
            const sp = { w: w, h: h, fb: new Uint16Array(w * h) };
            r.sprites[slot] = sp;
            r.sprite = sp;    // novo sprite vira o corrente
            r.bound = false;  // createSprite nao binda: quem desenha chama bind/use
            return slot + 1;
        };
        S.useSprite = (id) => {
            id |= 0;
            if (id === 0) { r.bound = false; return true; }
            const sp = id >= 1 && id <= 16 ? r.sprites[id - 1] : null;
            if (!sp) { r.bound = false; return false; }
            r.sprite = sp;
            r.bound = true;
            return true;
        };
        S.bindSprite = (enable) => { r.bound = !!enable && !!r.sprite; };
        S.pushSprite = (x, y, key) => {
            const sp = r.sprite;
            if (!sp) return;
            const chroma = key != null, kk = key & 0xFFFF;
            const wasBound = r.bound;
            r.bound = false;  // destino e sempre a tela (quadro/display no firmware)
            for (let j = 0; j < sp.h; j++) {
                for (let i = 0; i < sp.w; i++) {
                    const col = sp.fb[j * sp.w + i];
                    if (chroma && col === kk) continue;
                    r.px(x + i, y + j, col);  // px ja recusa fora do fb
                }
            }
            r.bound = wasBound;
        };
        S.deleteSprite = (id) => {
            let victim = r.sprite;
            if (id != null) {   // sem arg: apaga o corrente (compat)
                victim = (id | 0) >= 1 && (id | 0) <= 16 ? r.sprites[(id | 0) - 1] : null;
                if (!victim) return;
            }
            if (!victim) { r.bound = false; return; }
            for (let i = 0; i < r.sprites.length; i++) {
                if (r.sprites[i] === victim) r.sprites[i] = null;
            }
            if (r.sprite === victim) { r.sprite = null; r.bound = false; }
        };
        // API 33: sprite girado/escalado com o centro em (x, y) — amostragem
        // inversa por vizinho mais proximo no alvo corrente (com useSprite
        // pode ser outro sprite; nunca o sprite sobre si mesmo)
        S.drawSprite = (id, x, y, ang, zx, zy, key) => {   // smooth (8o arg) ignorado: preview
            const sp = r.sprites[(id | 0) - 1];
            if (!sp || (r.bound && r.sprite === sp)) return;
            zx = zx == null ? 1 : zx;
            zy = zy == null ? zx : zy;
            if (!zx || !zy) return;
            const a = (ang || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
            const hw = sp.w / 2, hh = sp.h / 2;
            const ext = Math.ceil(Math.hypot(hw * Math.abs(zx), hh * Math.abs(zy)));
            for (let py = -ext; py <= ext; py++) {
                for (let px = -ext; px <= ext; px++) {
                    // destino -> origem: desfaz a rotacao e a escala
                    const u = (c * px + s * py) / zx + hw, v = (-s * px + c * py) / zy + hh;
                    const ix = Math.floor(u), iy = Math.floor(v);
                    if (ix < 0 || iy < 0 || ix >= sp.w || iy >= sp.h) continue;
                    const col = sp.fb[iy * sp.w + ix];
                    if (key != null && col === (key & 0xFFFF)) continue;
                    r.px(Math.round(x + px), Math.round(y + py), col);
                }
            }
        };
        // API 34: o retangulo (x, y, w, h) do sprite id volta a MESMA posicao
        // do alvo corrente (sprite cobrindo o canvas a partir de 0,0); o
        // recorte do alvo nao muda
        S.blitSprite = (id, x, y, w, h) => {
            const sp = r.sprites[(id | 0) - 1];
            if (!sp || (r.bound && r.sprite === sp)) return;
            x |= 0; y |= 0; w |= 0; h |= 0;
            const x0 = Math.max(0, x), y0 = Math.max(0, y);
            const x1 = Math.min(sp.w, x + w), y1 = Math.min(sp.h, y + h);
            for (let j = y0; j < y1; j++) {
                for (let i = x0; i < x1; i++) r.px(i, j, sp.fb[j * sp.w + i]);
            }
        };
        // PNG de arquivo no framebuffer do emulador: caminho do APP
        // ("/local|/sd/apps/<pasta>/...") resolve para as pastas do repo
        // (irma do appDir, data/apps, hub_apps e a propria pasta do app);
        // caminho host valido passa direto (testes com fixture em tmp)
        const REPO = path.join(__dirname, '..', '..', '..');
        const resolveAsset = (p) => {
            if (typeof p !== 'string' || !p) return null;
            if (p[0] !== '/') return fs.existsSync(p) ? p : null;
            const APP = /^\/(?:local|sd)\/apps\/([^/]+)\/(.*)$/.exec(p);
            if (APP) {
                const cands = [
                    path.join(r.appDir || '.', '..', APP[1], APP[2]),
                    path.join(REPO, 'data', 'apps', APP[1], APP[2]),
                    path.join(REPO, 'hub_apps', APP[1], APP[2]),
                    path.join(r.appDir || '.', APP[2]),
                ];
                for (const c of cands) if (fs.existsSync(c)) return c;
                return null;
            }
            return fs.existsSync(p) ? p : null;
        };
        S.drawPNG = (p, x, y) => {
            const f = resolveAsset(p);
            if (!f) return false;
            try { r.blitRGBA(decodePng(fs.readFileSync(f)), x, y); }
            catch (e) { return false; }
            return true;
        };
        // icone do sistema (data/icons do repo; void como o firmware)
        S.drawIcon = (name, x, y) => {
            const f = path.join(REPO, 'data', 'icons', String(name) + '.png');
            if (!fs.existsSync(f)) return;
            try { r.blitRGBA(decodePng(fs.readFileSync(f)), x, y); } catch (e) {}
        };
        // ainda nao renderizados no emulador (mesmo comportamento do harness + aviso)
        for (const name of ['drawJPG', 'drawBMP']) {
            const orig = S[name];
            S[name] = (...args) => { r.unsupported.add(name); return orig(...args); };
        }
        return this;
    }
}

// funcoes que o wire substitui (o `celer.js check` cruza com o manifest
// para acusar primitive nova no firmware sem render no emulador)
const RENDERED = [
    'fillScreen', 'fillRect', 'drawRect', 'drawLine', 'drawPixel',
    'drawFastHLine', 'drawFastVLine', 'drawCircle', 'fillCircle',
    'drawTriangle', 'fillTriangle', 'drawRoundRect', 'fillRoundRect',
    'setTextColor', 'setTextSize', 'setTextDatum', 'drawString', 'textWidth',
    'fontHeight', 'createSprite', 'bindSprite', 'useSprite', 'pushSprite', 'deleteSprite',
    'setClip', 'clearClip', 'fillGradient', 'fillArc', 'fillSmoothCircle',
    'fillSmoothRoundRect', 'drawWideLine', 'mixColor', 'drawSprite', 'blitSprite',
    'drawPNG', 'drawIcon',
];

module.exports = { Renderer, W, H, RENDERED };
