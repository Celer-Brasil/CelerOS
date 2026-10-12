'use strict';
// Encoder PNG minimalista (truecolor 8-bit, sem dependencias) — usado pelo
// scaffold (icone placeholder) e pelo emulador (snapshots do framebuffer).
// O DECODIFICADOR (decodePng) serve o emulador: drawPNG/drawIcon renderizam
// a arte de verdade no preview (apps de jogo sao todos PNG hoje).

const zlib = require('zlib');

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

// pixels: Buffer RGBA (w*h*4, hasAlpha=true) ou RGB (w*h*3, hasAlpha=false)
function encodePng(w, h, pixels, hasAlpha) {
    const bpp = hasAlpha ? 4 : 3;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;                       // bit depth
    ihdr[9] = hasAlpha ? 6 : 2;        // color type: RGBA | RGB
    // scanlines com filtro "none" (nivel 9 do deflate compensa)
    const raw = Buffer.alloc((w * bpp + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * bpp + 1)] = 0;
        pixels.copy(raw, y * (w * bpp + 1) + 1, y * w * bpp, (y + 1) * w * bpp);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}


// ------------------------------------------------- decodificador ---------
// Suficiente para a arte do repo (geradores IA/exportadores): color types
// 0 (cinza), 2 (RGB), 3 (paleta+tRNS), 4 (cinza+alfa), 6 (RGBA); bit depth
// 8 e 16 (16 cai no byte alto) e 1/2/4 em paleta/cinza; sem entrelacamento
// (Adam7 rejeitado com erro claro — nenhum gerador do repo emite). Devolve
// { w, h, rgba } com alfa straight (0..255).

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

function decodePng(buf) {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504E47) throw new Error('PNG: assinatura');
    let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
    let palette = null, trns = null;
    const idat = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.slice(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            depth = data[8]; ctype = data[9]; interlace = data[12];
        } else if (type === 'PLTE') palette = data;
        else if (type === 'tRNS') trns = data;
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (!w || !h) throw new Error('PNG: IHDR ausente');
    if (interlace) throw new Error('PNG: entrelacado (Adam7) nao suportado');
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
    if (!channels) throw new Error('PNG: color type ' + ctype);
    const sub = depth < 8;
    if (depth !== 8 && depth !== 16 && !(sub && (ctype === 0 || ctype === 3)))
        throw new Error('PNG: bit depth ' + depth);

    // desfiltra as scanlines (bpp do filtro = 1 byte em sub-byte)
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpl = sub ? Math.ceil(w * channels * depth / 8) : w * channels * (depth / 8);
    const out = Buffer.alloc(bpl * h);
    let rp = 0;
    for (let y = 0; y < h; y++) {
        const f = raw[rp++];
        const off = y * bpl;
        for (let i = 0; i < bpl; i++) {
            const cur = raw[rp + i];
            const left = i >= (sub ? 1 : channels * (depth / 8)) ? out[off + i - (sub ? 1 : channels * (depth / 8))] : 0;
            const up = y > 0 ? out[off - bpl + i] : 0;
            const ul = (y > 0 && i >= (sub ? 1 : channels * (depth / 8))) ? out[off - bpl + i - (sub ? 1 : channels * (depth / 8))] : 0;
            out[off + i] = cur + (f === 1 ? left : f === 2 ? up : f === 3 ? ((left + up) >> 1)
                                     : f === 4 ? paeth(left, up, ul) : 0);
        }
        rp += bpl;
    }

    // amostra o pixel (x, y) -> [r, g, b, a]
    const per = depth < 8 ? depth : depth; // bits por amostra
    const samples = new Array(channels);
    function pixel(x, y) {
        const off = y * bpl;
        if (sub) {
            const perRow = w * channels;                 // amostras por linha
            for (let c = 0; c < channels; c++) {
                const idx = x * channels + c;
                const bit = idx * depth;
                const byte = out[off + (bit >> 3)];
                const shift = 8 - depth - (bit & 7);
                let v = (byte >> shift) & ((1 << depth) - 1);
                if (ctype === 3) samples[c] = v;         // indice de paleta
                else {                                    // cinza: escala p/ 8 bits
                    const max = (1 << depth) - 1;
                    samples[c] = Math.round(v * 255 / max);
                }
            }
        } else {
            const step = depth / 8;
            for (let c = 0; c < channels; c++) {
                const o = off + (x * channels + c) * step;
                samples[c] = depth === 16 ? out[o] : out[o]; // 16: byte alto
            }
        }
        if (ctype === 0) return [samples[0], samples[0], samples[0], 255];
        if (ctype === 4) return [samples[0], samples[0], samples[0], samples[1]];
        if (ctype === 2) return [samples[0], samples[1], samples[2], 255];
        if (ctype === 6) return [samples[0], samples[1], samples[2], samples[3]];
        // paleta (indice fora da tabela: preto, como o firmware cala)
        const i = samples[0] * 3;
        const r = palette && i + 2 < palette.length ? palette[i] : 0;
        const g = palette && i + 2 < palette.length ? palette[i + 1] : 0;
        const b = palette && i + 2 < palette.length ? palette[i + 2] : 0;
        const a = trns && samples[0] < trns.length ? trns[samples[0]] : 255;
        return [r, g, b, a];
    }

    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = pixel(x, y), k = (y * w + x) * 4;
            rgba[k] = p[0]; rgba[k + 1] = p[1]; rgba[k + 2] = p[2]; rgba[k + 3] = p[3];
        }
    }
    return { w, h, rgba };
}

module.exports = { encodePng, decodePng };
