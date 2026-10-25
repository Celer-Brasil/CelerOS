'use strict';
// Icone 64x64 placeholder: quadrado arredondado no tom accent do tema com a
// inicial do app em glifo 8x8 escalado. Extraido do celer.js para o Studio
// poder usa-lo sem cair em dependencia circular.

const { encodePng } = require('./png.js');
const { glyph } = require('./font8x8.js');

function makeIconPng(letter) {
    const S = 64, R = 14;
    const bg = [0x38, 0xBC, 0xF8];   // accent do tema (RGB888)
    const fg = [0x08, 0x10, 0x20];   // onAccent
    const px = new Uint8Array(S * S * 3);
    const inside = (x, y) => {
        const cx = Math.min(Math.max(x, R), S - 1 - R), cy = Math.min(Math.max(y, R), S - 1 - R);
        return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R;
    };
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const i = (y * S + x) * 3;
            if (!inside(x, y)) continue;
            px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2];
        }
    }
    const bm = glyph(String(letter || 'C').toUpperCase().charCodeAt(0));
    if (bm) {
        const scale = 6, gw = 8 * scale, ox = (S - gw) / 2 | 0, oy = (S - gw) / 2 | 0;
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if (!((bm[row] >> col) & 1)) continue;
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) {
                        const x = ox + col * scale + sx, y = oy + row * scale + sy;
                        if (x < 0 || y < 0 || x >= S || y >= S) continue;
                        const i = (y * S + x) * 3;
                        px[i] = fg[0]; px[i + 1] = fg[1]; px[i + 2] = fg[2];
                    }
                }
            }
        }
    }
    return encodePng(S, S, Buffer.from(px), false);
}

module.exports = { makeIconPng };
