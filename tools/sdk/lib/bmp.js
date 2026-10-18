'use strict';
// Decoder BMP para o emulador (drawBMP do preview): BI_RGB 8/16/24/32 e
// BI_BITFIELDS com mascaras — o que os exportadores/geradores do repo
// emitem. RLE (BI_RLE8/BI_RLE4) devolve erro claro: o preview prefere
// acusar a primitiva nao renderizada a pintar lixo.
//
// Devolve { w, h, rgba } com alfa straight, como decodePng (o blitRGBA do
// renderer compoe no RGB565 do alvo).

function maskInfo(m) {
    if (!m) return null;
    let shift = 0;
    while (shift < 32 && !((m >>> shift) & 1)) shift++;
    if (shift >= 32) return null;
    let bits = 0;
    while (bits < 32 && ((m >>> (shift + bits)) & 1)) bits++;
    return { shift: shift, max: (m >>> shift) >>> 0 };
}

function scale(v, info) {
    if (!info) return 0;
    if (!info.max) return 0;
    return Math.round(v * 255 / info.max);
}

function decodeBmp(buf) {
    if (!buf || buf.length < 30 || buf[0] !== 0x42 || buf[1] !== 0x4D)
        throw new Error('BMP: assinatura invalida');
    const dataOff = buf.readUInt32LE(10);
    const hdr = buf.readUInt32LE(14);
    if (hdr < 12 || 14 + hdr > buf.length) throw new Error('BMP: cabecalho DIB invalido');
    const w = buf.readInt32LE(18);
    const hRaw = buf.readInt32LE(22);
    const topDown = hRaw < 0;
    const h = Math.abs(hRaw);
    const bpp = buf.readUInt16LE(28);
    const comp = hdr >= 40 ? buf.readUInt32LE(30) : 0;
    if (w <= 0 || h <= 0) throw new Error('BMP: dimensoes ' + w + 'x' + h);
    if (bpp !== 1 && bpp !== 4 && bpp !== 8 && bpp !== 16 && bpp !== 24 && bpp !== 32)
        throw new Error('BMP: ' + bpp + ' bpp nao suportado');
    if (comp === 1 || comp === 2) throw new Error('BMP: RLE nao suportado no preview');
    if (comp !== 0 && comp !== 3 && comp !== 6) throw new Error('BMP: compressao ' + comp);

    // paleta (1/4/8 bpp): entradas BGRA logo apos o cabecalho
    let palette = null;
    if (bpp <= 8) {
        const n = Math.max(0, Math.floor((dataOff - (14 + hdr)) / 4));
        palette = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) {
            const o = 14 + hdr + i * 4;
            if (o + 2 >= buf.length) break;
            palette[i * 3] = buf[o + 2];
            palette[i * 3 + 1] = buf[o + 1];
            palette[i * 3 + 2] = buf[o];
        }
    }

    // mascaras de canal: BI_BITFIELDS (3 ou 4 uint32 apos o cabecalho) ou
    // BITMAPV4/V5 (mascaras dentro do cabecalho, offset fixo 54)
    let mr = null, mg = null, mb = null, ma = null;
    if (comp === 3 || comp === 6) {
        const mo = 14 + 40;
        if (mo + 12 > buf.length) throw new Error('BMP: mascaras ausentes');
        mr = maskInfo(buf.readUInt32LE(mo));
        mg = maskInfo(buf.readUInt32LE(mo + 4));
        mb = maskInfo(buf.readUInt32LE(mo + 8));
        if (hdr >= 56 && mo + 16 <= buf.length) ma = maskInfo(buf.readUInt32LE(mo + 12));
    }

    const stride = Math.floor((bpp * w + 31) / 32) * 4;
    if (dataOff + stride * h > buf.length)
        throw new Error('BMP: dados truncados (esperado ' + (dataOff + stride * h) + ', tem ' + buf.length + ')');

    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const row = dataOff + (topDown ? y : h - 1 - y) * stride;
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0, a = 255;
            if (bpp === 1 || bpp === 4 || bpp === 8) {
                const bit = x * bpp;
                const byte = buf[row + (bit >> 3)];
                const idx = bpp === 8 ? byte : (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
                const p = idx * 3;
                if (palette && p + 2 < palette.length) {
                    r = palette[p]; g = palette[p + 1]; b = palette[p + 2];
                }
            } else if (bpp === 24) {
                const o = row + x * 3;
                b = buf[o]; g = buf[o + 1]; r = buf[o + 2];
            } else if (bpp === 32) {
                const o = row + x * 4;
                b = buf[o]; g = buf[o + 1]; r = buf[o + 2];
                a = buf[o + 3];
                // BI_RGB nao define o byte alfa (muitos gravadores deixam 0):
                // so confia nele com mascara explicita
                if (comp === 0 && !ma) a = 255;
            } else {  // 16
                const v = buf.readUInt16LE(row + x * 2);
                if (mr || mg || mb) {
                    r = mr ? scale((v >>> mr.shift) & mr.max, mr) : 0;
                    g = mg ? scale((v >>> mg.shift) & mg.max, mg) : 0;
                    b = mb ? scale((v >>> mb.shift) & mb.max, mb) : 0;
                } else {   // BI_RGB 16 = X1R5G5B5
                    r = Math.round(((v >> 10) & 31) * 255 / 31);
                    g = Math.round(((v >> 5) & 31) * 255 / 31);
                    b = Math.round((v & 31) * 255 / 31);
                }
            }
            const k = (y * w + x) * 4;
            rgba[k] = r; rgba[k + 1] = g; rgba[k + 2] = b; rgba[k + 3] = a;
        }
    }
    return { w: w, h: h, rgba: rgba };
}

module.exports = { decodeBmp };
