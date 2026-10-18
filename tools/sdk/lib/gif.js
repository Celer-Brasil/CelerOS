'use strict';
// Encoder GIF animado sem dependencias — o `celer.js emu --gif` grava a
// rodada do jogo num arquivo que qualquer visualizador/chat abre. Paleta
// fixa RGB332 (256 cores, 3 bits R, 3 G, 2 B): arte de jogo e chapada, entao
// o banding e aceitavel e a codificacao fica barata e deterministica.
//
// frames: [{ rgb: Buffer(w*h*3), delayMs }] — quadros consecutivos iguais sao
// fundidos (soma do delay no anterior), o que corta cena parada.

const PALETTE = (() => {
    const p = Buffer.alloc(256 * 3);
    for (let i = 0; i < 256; i++) {
        const r = (i >> 5) & 7, g = (i >> 2) & 7, b = i & 3;
        p[i * 3] = Math.round(r * 255 / 7);
        p[i * 3 + 1] = Math.round(g * 255 / 7);
        p[i * 3 + 2] = Math.round(b * 255 / 3);
    }
    return p;
})();

function rgbToIndices(rgb, w, h, out) {
    out = out || new Uint8Array(w * h);
    for (let i = 0, k = 0; i < w * h; i++, k += 3) {
        out[i] = (rgb[k] & 0xE0) | ((rgb[k + 1] >> 3) & 0x1C) | (rgb[k + 2] >> 6);
    }
    return out;
}

// LZW do GIF89a (min code size 8). O encoder anda um codigo a frente do
// decoder: a troca de largura acontece quando o PROXIMO codigo ainda cabe
// exatamente em (1 << codeSize) + 1 — verificado contra o decoder do PIL.
function lzwEncode(indices, minCodeSize) {
    const clear = 1 << minCodeSize, eoi = clear + 1;
    let codeSize = minCodeSize + 1;
    let next = eoi + 1;
    let dict = new Map();
    const bytes = [];
    let bitBuf = 0, bitCnt = 0;

    function emit(code, size) {
        bitBuf |= code << bitCnt;
        bitCnt += size;
        while (bitCnt >= 8) {
            bytes.push(bitBuf & 0xFF);
            bitBuf >>>= 8;
            bitCnt -= 8;
        }
    }

    emit(clear, codeSize);
    if (indices.length) {
        let prefix = indices[0];
        for (let i = 1; i < indices.length; i++) {
            const k = indices[i];
            const key = (prefix << 8) | k;
            const hit = dict.get(key);
            if (hit !== undefined) { prefix = hit; continue; }
            emit(prefix, codeSize);
            if (next < 4096) {
                dict.set(key, next++);
                if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
            } else {
                emit(clear, codeSize);   // tabela cheia: reinicia o dicionario
                dict = new Map();
                next = eoi + 1;
                codeSize = minCodeSize + 1;
            }
            prefix = k;
        }
        emit(prefix, codeSize);
    }
    emit(eoi, codeSize);
    if (bitCnt > 0) bytes.push(bitBuf & 0xFF);
    return bytes;
}

function subBlocks(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 255) {
        const n = Math.min(255, bytes.length - i);
        out.push(n);
        for (let k = 0; k < n; k++) out.push(bytes[i + k]);
    }
    out.push(0);
    return out;
}

function sameRgb(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function encodeGif(w, h, frames) {
    if (!frames || !frames.length) throw new Error('GIF: nenhum quadro');
    // funde quadros identicos preservando o tempo total
    const uniq = [];
    for (const f of frames) {
        const last = uniq[uniq.length - 1];
        if (last && sameRgb(last.rgb, f.rgb)) last.delayMs += f.delayMs;
        else uniq.push({ rgb: f.rgb, delayMs: f.delayMs });
    }
    const out = [];
    const u16 = (v) => { out.push(v & 0xFF, (v >> 8) & 0xFF); };
    out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);   // GIF89a
    u16(w); u16(h);
    out.push(0xF7, 0, 0);              // GCT 256, resolucao 8 bits, fundo 0
    for (let i = 0; i < PALETTE.length; i++) out.push(PALETTE[i]);
    // Netscape: loop infinito
    out.push(0x21, 0xFF, 0x0B, 0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50,
             0x45, 0x32, 0x2E, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00);
    const idx = new Uint8Array(w * h);
    for (const f of uniq) {
        rgbToIndices(f.rgb, w, h, idx);
        let delay = Math.round(f.delayMs / 10);
        delay = Math.max(2, Math.min(0xFFFF, delay));   // 2 centesimos = 50 fps
        // GCE: disposal 1 (nao descarta), sem transparencia
        out.push(0x21, 0xF9, 0x04, 0x04);
        u16(delay); out.push(0, 0);
        out.push(0x2C); u16(0); u16(0); u16(w); u16(h); out.push(0);
        out.push(8);   // min code size
        const data = lzwEncode(idx, 8);
        const blocks = subBlocks(data);
        for (let i = 0; i < blocks.length; i++) out.push(blocks[i]);
    }
    out.push(0x3B);
    return Buffer.from(out);
}

module.exports = { encodeGif, lzwEncode, rgbToIndices };
