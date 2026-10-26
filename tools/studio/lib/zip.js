'use strict';
// ZIP deterministico do Celer Studio: sem dependencias, arquivos planos,
// timestamp fixo e deflate nivel 9. O layout e o mesmo que o installzip do
// firmware espera (app.json na raiz).

const zlib = require('zlib');

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xFFFF, 0);
    return b;
}
function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

// 1980-01-01 00:00:00 (DOS): zip reproduzivel, sem clock do host
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function createZip(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('zip sem arquivos');
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    const seen = new Set();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const e of sorted) {
        if (!e.name || /(^|\/)\.\.(\/|$)/.test(e.name) || e.name.indexOf('\\') >= 0) {
            throw new Error('nome de zip invalido: ' + e.name);
        }
        if (seen.has(e.name)) throw new Error('arquivo repetido no zip: ' + e.name);
        seen.add(e.name);
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
        const crc = crc32(data);
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        const method = deflated.length < data.length ? 8 : 0;
        const payload = method ? deflated : data;
        const name = Buffer.from(e.name, 'utf8');

        const local = Buffer.concat([
            u32(0x04034B50), u16(20), u16(0x0800), u16(method),
            u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(payload.length),
            u32(data.length), u16(name.length), u16(0), name,
        ]);
        locals.push(local, payload);

        centrals.push(Buffer.concat([
            u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(method),
            u16(DOS_TIME), u16(DOS_DATE), u32(crc), u32(payload.length),
            u32(data.length), u16(name.length), u16(0), u16(0), u16(0),
            u16(0), u32(0), u32(offset), name,
        ]));
        offset += local.length + payload.length;
    }

    const central = Buffer.concat(centrals);
    const end = Buffer.concat([
        u32(0x06054B50), u16(0), u16(0), u16(sorted.length), u16(sorted.length),
        u32(central.length), u32(offset), u16(0),
    ]);
    return Buffer.concat(locals.concat([central, end]));
}

// Leitor minimo para verificacao/teste (sem zip64). Devolve [{name,data,method}].
function readZip(buf) {
    let eocd = -1;
    const min = Math.max(0, buf.length - 0xFFFF - 22);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip sem EOCD');
    const count = buf.readUInt16LE(eocd + 10);
    const cdOff = buf.readUInt32LE(eocd + 16);
    const out = [];
    let p = cdOff;
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014B50) throw new Error('central directory invalido');
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nlen = buf.readUInt16LE(p + 28);
        const elen = buf.readUInt16LE(p + 30);
        const clen = buf.readUInt16LE(p + 32);
        const lho = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nlen);
        const lnlen = buf.readUInt16LE(lho + 26);
        const lelen = buf.readUInt16LE(lho + 28);
        const start = lho + 30 + lnlen + lelen;
        const payload = buf.subarray(start, start + csize);
        let data;
        if (method === 0) data = Buffer.from(payload);
        else if (method === 8) data = zlib.inflateRawSync(payload);
        else throw new Error('metodo zip nao suportado: ' + method);
        if (data.length !== usize || crc32(data) !== crc) throw new Error('CRC/tamanho invalido: ' + name);
        out.push({ name, data, method });
        p += 46 + nlen + elen + clen;
    }
    return out;
}

module.exports = { createZip, readZip, crc32 };
