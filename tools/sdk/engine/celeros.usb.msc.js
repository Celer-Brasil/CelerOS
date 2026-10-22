// celeros.usb.msc — pendrive USB em JS: Bulk-Only Transport + SCSI + leitura
// de FAT32/exFAT. O firmware so entrega bulk transfers e descritores; este
// modulo implementa o driver de armazenamento em massa.
//
//   var msc = require("celeros.usb.msc");
//   var dev = usb.find({ cls: 8 });            // mass storage
//   var vol = msc.openVolume(dev);
//   if (vol) {
//       System.print(vol.info().type + " " + vol.info().label);
//       var fs = vol.list("/");
//       var bytes = vol.read("/README.TXT", 4096);
//       vol.close();
//   }
//
// LEITURA apenas nesta versao (listar, stat e ler arquivo). Escrita na
// unidade (writeBlocks) existe como primitiva, mas formatar/alocar FAT fica
// para o proximo driver — o protocolo nao muda.
//
// Limites: 4 KB por transfer USB (8 setores de 512 B); arquivos lidos em
// pedacos de no maximo 64 KB (heap do Duktape e apertado). exFAT e FAT32
// sao reconhecidos; FAT12/16 e NTFS nao.

var usb = require("celeros.usb");

var msc = { version: '1.0.0' };

var SECTOR = 512;
var MAX_XFER = 4096;
var EOC = 0x0FFFFFFF;

msc.available = function () {
    return usb.available();
};

// ---- leitores little/big-endian -------------------------------------------
function u8(b, o) { return b[o] & 0xFF; }
function le16(b, o) { return (b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8); }
function le32(b, o) {
    return (b[o] & 0xFF) + (b[o + 1] & 0xFF) * 0x100 +
           (b[o + 2] & 0xFF) * 0x10000 + (b[o + 3] & 0xFF) * 0x1000000;
}
function be32(b, o) {
    return (b[o] & 0xFF) * 0x1000000 + (b[o + 1] & 0xFF) * 0x10000 +
           (b[o + 2] & 0xFF) * 0x100 + (b[o + 3] & 0xFF);
}
function le64(b, o) {
    return le32(b, o) + le32(b, o + 4) * 4294967296;
}
function ascii(b, o, n) {
    var s = "";
    for (var i = 0; i < n; i++) {
        var c = b[o + i] & 0xFF;
        if (!c) break;
        s += String.fromCharCode(c);
    }
    return s;
}
function utf16(b, o, n) {
    var s = "";
    for (var i = 0; i < n; i++) {
        var c = le16(b, o + i * 2);
        if (!c || c === 0xFFFF) break;
        s += String.fromCharCode(c);
    }
    return s;
}

// ---- Bulk-Only Transport (CBW/CSW) ---------------------------------------
function cbw(tag, dataLen, dirIn, cdb) {
    var out = [0x55, 0x53, 0x42, 0x43,                        // "USBC"
               tag & 0xFF, (tag >> 8) & 0xFF, (tag >> 16) & 0xFF, (tag >> 24) & 0xFF,
               dataLen & 0xFF, (dataLen >> 8) & 0xFF, (dataLen >> 16) & 0xFF, (dataLen >> 24) & 0xFF,
               dirIn ? 0x80 : 0x00, 0, cdb.length & 0xFF];
    for (var i = 0; i < 16; i++) out.push(i < cdb.length ? (cdb[i] & 0xFF) : 0);
    return out;
}

// Uma transferencia completa: CBW -> data (se houver) -> CSW.
function botCmd(t, cdb, dataLen, dirIn, data) {
    if (typeof USB === "undefined") return { ok: false, status: "gone", data: [] };
    var tag = t.tag;
    t.tag = (t.tag + 1) & 0x7FFFFFFF;
    var r = USB.out(t.addr, t.epOut, cbw(tag, dataLen, dirIn, cdb), t.timeoutMs);
    if (!r.ok) return { ok: false, status: r.status, data: [] };

    var got = [];
    var done = 0;
    while (done < dataLen) {
        var n = dataLen - done;
        if (n > MAX_XFER) n = MAX_XFER;
        if (dirIn) {
            var ri = USB.in(t.addr, t.epIn, n, t.timeoutMs);
            if (!ri.ok) return { ok: false, status: ri.status, data: got };
            var k;
            for (k = 0; k < ri.data.length; k++) got.push(ri.data[k]);
            done += n;
            if (ri.data.length < n) break;  // device enviou menos: CSW decide
        } else {
            var part = [];
            for (var j = 0; j < n; j++) part.push(data[done + j] || 0);
            var ro = USB.out(t.addr, t.epOut, part, t.timeoutMs);
            if (!ro.ok) return { ok: false, status: ro.status, data: got };
            done += n;
        }
    }

    var c = USB.in(t.addr, t.epIn, 13, t.timeoutMs);
    if (!c.ok || c.data.length < 13) return { ok: false, status: c.status || "csw", data: got };
    var d = c.data;
    var sigOk = d[0] === 0x55 && d[1] === 0x53 && d[2] === 0x42 && d[3] === 0x53;
    if (!sigOk) return { ok: false, status: "csw", data: got };
    t.residue = le32(d, 8);
    if (d[12] !== 0) {
        // falha: limpa o halt dos dois endpoints e guarda o sense
        USB.flush(t.addr, t.epIn);
        USB.flush(t.addr, t.epOut);
        msc._sense(t);
        return { ok: false, status: d[12] === 1 ? "stall" : "error", data: got };
    }
    return { ok: true, status: "ok", data: got };
}

function cdb10(op, lba, count) {
    return [op, 0,
            Math.floor(lba / 16777216) & 0xFF, Math.floor(lba / 65536) & 0xFF,
            Math.floor(lba / 256) & 0xFF, lba & 0xFF,
            0, (count >> 8) & 0xFF, count & 0xFF, 0];
}

msc._sense = function (t) {
    var c = botCmd(t, [0x03, 0, 0, 0, 18, 0], 18, true, null);
    t.sense = c.ok ? { key: c.data[2] & 0x0F, code: c.data[12], qual: c.data[13] } : null;
    return t.sense;
};

// Abre o device MSC (classe 8, subclasse 6, protocolo 0x50 = BOT/SCSI).
// Devolve o transporte {addr, read, write, capacity, vendor, product, close}
// ou null. Leitura do INQUIRY/READ CAPACITY pode falhar logo apos o plug:
// chame de novo depois de alguns ms (o app faz isso no hotplug).
msc.open = function (dev, opts) {
    opts = opts || {};
    if (!dev) return null;
    var iface = null;
    for (var i = 0; i < dev.ifs.length; i++) {
        var f = dev.ifs[i];
        if (f.cls === 8 && f.subcls === 6 && f.proto === 0x50) { iface = f; break; }
    }
    if (!iface) return null;
    var h = usb.open(dev, { iface: iface });
    if (!h || h.epIn < 0 || h.epOut < 0) {
        if (h) usb.close(h);
        return null;
    }
    var t = {
        addr: h.addr, epIn: h.epIn, epOut: h.epOut, iface: h.iface, h: h,
        tag: 1, timeoutMs: opts.timeoutMs || 2000, residue: 0, sense: null,
        blockSize: SECTOR, blocks: 0, vendor: "", product: ""
    };

    var inq = botCmd(t, [0x12, 0, 0, 0, 36, 0], 36, true, null);
    if (inq.ok && inq.data.length >= 36) {
        t.vendor = ascii(inq.data, 8, 8).replace(/ +$/, "");
        t.product = ascii(inq.data, 16, 16).replace(/ +$/, "");
    }
    var cap = botCmd(t, [0x25, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8, true, null);
    if (cap.ok && cap.data.length >= 8) {
        t.blocks = be32(cap.data, 0) + 1;
        t.blockSize = be32(cap.data, 4) || SECTOR;
        if (t.blockSize !== SECTOR) {
            // O SCSI fala no blockSize do device; o FAT usa o seu. So 512 e
            // suportado (todo pendrive de bancada e 512).
            t.blockSize = SECTOR;
        }
    }

    t.read = function (lba, count) {
        var out = [];
        var done = 0;
        while (done < count) {
            var n = count - done;
            if (n > 8) n = 8;
            var r = botCmd(t, cdb10(0x28, lba + done, n), n * SECTOR, true, null);
            if (!r.ok) return null;
            for (var k = 0; k < r.data.length; k++) out.push(r.data[k]);
            done += n;
        }
        return out;
    };

    t.write = function (lba, bytes) {
        var sectors = Math.ceil(bytes.length / SECTOR);
        var padded = bytes.slice();
        while (padded.length < sectors * SECTOR) padded.push(0);
        var r = botCmd(t, cdb10(0x2A, lba, sectors), sectors * SECTOR, false, padded);
        return r.ok;
    };

    t.close = function () {
        var ok = usb.close(h);
        t.addr = 0;
        return ok;
    };

    return t;
};

// Monta um volume a partir de um leitor {read(lba, count) -> bytes|null}.
// Devolve {type, label, list, read, stat, info, close} ou null.
msc.mount = function (reader) {
    if (!reader) return null;
    var bs = reader.read(0, 1);
    if (!bs || bs.length < SECTOR) return null;
    if (ascii(bs, 3, 8) === "EXFAT   ") return mountExfat(reader, bs);
    return mountFat32(reader, bs);
};

msc.openVolume = function (dev, opts) {
    var t = msc.open(dev, opts);
    if (!t) return null;
    var vol = msc.mount(t);
    if (!vol) {
        t.close();
        return null;
    }
    vol.msc = t;
    vol.info = (function (base) {
        return function () {
            var i = base();
            i.vendor = t.vendor;
            i.product = t.product;
            return i;
        };
    })(vol.info);
    return vol;
};

// ===========================================================================
// FAT32 (leitura)
// ===========================================================================
function mountFat32(reader, bs) {
    if (le16(bs, 11) !== SECTOR) return null;
    var spc = u8(bs, 13);
    var reserved = le16(bs, 14);
    var nfats = u8(bs, 16);
    var fatSize = le32(bs, 36);
    var root = le32(bs, 44);
    if (!spc || !fatSize || root < 2) return null;

    var v = {
        type: "fat32",
        label: ascii(bs, 71, 11).replace(/ +$/, ""),
        bytesPerSector: SECTOR,
        sectorsPerCluster: spc,
        totalSectors: le32(bs, 32) || le16(bs, 19),
        rootCluster: root,
        dataLba: reserved + nfats * fatSize,
        fatLba: reserved,
        clusterCount: 0,
        reader: reader,
        _fatSec: -1,
        _fatBuf: null
    };
    v.clusterCount = Math.floor((v.totalSectors - v.dataLba) / spc);
    return makeVolume(v, fat32Dir, fat32Chain);
}

function fat32Fat(v, cluster) {
    var byteOff = cluster * 4;
    var sec = v.fatLba + Math.floor(byteOff / SECTOR);
    if (sec !== v._fatSec) {
        var b = v.reader.read(sec, 1);
        if (!b) return EOC;
        v._fatSec = sec;
        v._fatBuf = b;
    }
    var val = le32(v._fatBuf, byteOff % SECTOR) & 0x0FFFFFFF;
    if (val >= 0x0FFFFFF8) return EOC;
    return val;
}

function fat32Chain(v, start) {
    return contiguousChain(start, function (c) { return fat32Fat(v, c); });
}

function fat32Dir(v, node) {
    var out = [];
    var cluster = node.cluster;
    var guard = 0;
    var lfn = [];
    while (cluster !== EOC && cluster >= 2 && guard++ < 8192) {
        var data = v.reader.read(v.dataLba + (cluster - 2) * v.sectorsPerCluster,
                                 v.sectorsPerCluster);
        if (!data) return out;
        for (var off = 0; off + 32 <= data.length; off += 32) {
            var b0 = u8(data, off);
            if (b0 === 0x00) return out;          // fim da pasta
            if (b0 === 0xE5) { lfn = []; continue; }  // apagado
            var attr = u8(data, off + 11);
            if (attr === 0x0F) {                  // entrada LFN
                // 13 chars em 3 grupos (1..10, 14..25, 28..31); os bytes
                // 11..13 no meio sao attr/tipo/checksum, nao texto
                var part = utf16(data, off + 1, 5) +
                           utf16(data, off + 14, 6) +
                           utf16(data, off + 28, 2);
                lfn.unshift(part);
                continue;
            }
            if (attr & 0x08) { lfn = []; continue; }  // rotulo do volume
            var name = lfn.length ? lfn.join("") : shortName(data, off);
            lfn = [];
            if (name === "." || name === "..") continue;
            var cl = (le16(data, off + 20) << 16) | le16(data, off + 26);
            var size = le32(data, off + 28);
            out.push({ name: name, dir: (attr & 0x10) !== 0, size: size, cluster: cl });
        }
        cluster = fat32Fat(v, cluster);
    }
    return out;
}

function shortName(b, off) {
    var base = ascii(b, off, 8).replace(/ +$/, "");
    var ext = ascii(b, off + 8, 3).replace(/ +$/, "");
    var caseFlags = u8(b, off + 12);
    if (caseFlags & 0x08) base = base.toLowerCase();
    if (caseFlags & 0x10) ext = ext.toLowerCase();
    return ext ? base + "." + ext : base;
}

// ===========================================================================
// exFAT (leitura)
// ===========================================================================
function mountExfat(reader, bs) {
    var bps = 1 << u8(bs, 108);
    if (bps !== SECTOR) return null;
    var spc = 1 << u8(bs, 109);
    var part = le64(bs, 64);
    var fatOffset = le32(bs, 80);
    var fatLength = le32(bs, 84);
    var heap = le32(bs, 88);
    var clusters = le32(bs, 92);
    var root = le32(bs, 96);
    if (!spc || !fatLength || !root) return null;

    var v = {
        type: "exfat",
        label: "",
        bytesPerSector: bps,
        sectorsPerCluster: spc,
        totalSectors: le64(bs, 72),
        rootCluster: root,
        dataLba: part + heap,
        fatLba: part + fatOffset,
        clusterCount: clusters,
        reader: reader,
        _fatSec: -1,
        _fatBuf: null
    };
    v.label = exfatLabel(v);
    return makeVolume(v, exfatDir, exfatChain);
}

// Rotulo do volume: entrada 0x83 no diretorio raiz (nao ha label no boot).
function exfatLabel(v) {
    var cluster = v.rootCluster;
    var guard = 0;
    while (cluster !== EOC && cluster >= 2 && guard++ < 4) {
        var data = v.reader.read(v.dataLba + (cluster - 2) * v.sectorsPerCluster,
                                 v.sectorsPerCluster);
        if (!data) break;
        for (var off = 0; off + 32 <= data.length; off += 32) {
            var type = u8(data, off);
            if (type === 0x00) return "";
            if (type !== 0x83) continue;
            return utf16(data, off + 2, 11);
        }
        cluster = exfatFat(v, cluster);
    }
    return "";
}

function exfatFat(v, cluster) {
    var byteOff = cluster * 4;
    var sec = v.fatLba + Math.floor(byteOff / SECTOR);
    if (sec !== v._fatSec) {
        var b = v.reader.read(sec, 1);
        if (!b) return 0xFFFFFFFF;
        v._fatSec = sec;
        v._fatBuf = b;
    }
    var val = le32(v._fatBuf, byteOff % SECTOR);
    return val >= 0xFFFFFFF8 ? EOC : val;
}

function exfatChain(v, start) {
    return contiguousChain(start, function (c) { return exfatFat(v, c); });
}

function exfatDir(v, node) {
    var out = [];
    var cluster = node.cluster;
    var guard = 0;

    // Junta ate 16 clusters (8 KB) para que um conjunto de entradas (0x85 +
    // secundarias 0xC0/0xC1) nunca seja cortado na fronteira do cluster.
    // Diretorio maior que isso e truncado na listagem (leitura por caminho
    // continua funcionando: cada arquivo e resolvido pelo proprio cluster).
    var data = [];
    var contiguous = node.noFatChain === true;
    var cur = cluster;
    while (cur !== EOC && cur >= 2 && guard++ < 16) {
        var chunk = v.reader.read(v.dataLba + (cur - 2) * v.sectorsPerCluster,
                                  v.sectorsPerCluster);
        if (!chunk) break;
        for (var i = 0; i < chunk.length; i++) data.push(chunk[i]);
        if (contiguous) cur++;
        else cur = exfatFat(v, cur);
    }
    if (!data.length) return out;

    var off = 0;
    while (off + 32 <= data.length) {
        var type = u8(data, off);
        if (type === 0x00) return out;
        if (type !== 0x85) { off += 32; continue; }

        var secs = u8(data, off + 1);
        var attr = le16(data, off + 4);
        var stream = null;
        var name = "";
        for (var s = 1; s <= secs; s++) {
            var o2 = off + s * 32;
            if (o2 + 32 > data.length) break;
            var t2 = u8(data, o2);
            if (t2 === 0xC0) {
                stream = {
                    flags: u8(data, o2 + 1),
                    nameLen: u8(data, o2 + 3),
                    validLen: le64(data, o2 + 8),
                    cluster: le32(data, o2 + 20),
                    size: le64(data, o2 + 24)
                };
            } else if (t2 === 0xC1) {
                name += utf16(data, o2 + 2, 15);
            }
        }
        off += (secs + 1) * 32;
        if (stream && name.length > stream.nameLen) name = name.substr(0, stream.nameLen);
        if (!name) continue;
        out.push({
            name: name,
            dir: (attr & 0x10) !== 0,
            size: stream ? stream.size : 0,
            cluster: stream ? stream.cluster : 0,
            noFatChain: stream ? ((stream.flags & 0x02) !== 0) : false
        });
    }
    return out;
}

// ===========================================================================
// Volume comum (FAT32/exFAT)
// ===========================================================================
function contiguousChain(start, next) {
    // Encadeado: next(cluster) ate EOC. Devolve o proximo cluster ou EOC.
    return next(start);
}

function makeVolume(v, dirFn, chainFn) {
    function readCluster(cluster, noFatChain) {
        var lba = v.dataLba + (cluster - 2) * v.sectorsPerCluster;
        return v.reader.read(lba, v.sectorsPerCluster);
    }

    function node(path) {
        var parts = String(path || "/").split("/");
        var cur = { name: "/", dir: true, cluster: v.rootCluster, size: 0, noFatChain: false };
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            if (!cur.dir) return null;
            var list = dirFn(v, cur);
            var found = null;
            for (var k = 0; k < list.length; k++) {
                if (list[k].name.toLowerCase() === parts[i].toLowerCase()) { found = list[k]; break; }
            }
            if (!found) return null;
            cur = found;
        }
        return cur;
    }

    var vol = {
        type: v.type,
        label: v.label,
        bytesPerSector: v.bytesPerSector,
        sectorsPerCluster: v.sectorsPerCluster,
        clusterCount: v.clusterCount,
        ms: null,
        mountPoint: "/",
        list: function (path) {
            var n = node(path || "/");
            if (!n || !n.dir) return [];
            var list = dirFn(v, n);
            var out = [];
            for (var i = 0; i < list.length; i++) {
                out.push({
                    name: list[i].name,
                    dir: list[i].dir,
                    size: list[i].size
                });
            }
            return out;
        },
        stat: function (path) {
            var n = node(path);
            if (!n) return null;
            return { name: n.name, dir: n.dir, size: n.size, cluster: n.cluster };
        },
        read: function (path, maxBytes) {
            var n = node(path);
            if (!n || n.dir) return null;
            var cap = maxBytes || 65536;
            if (cap > 262144) cap = 262144;
            var want = n.size < cap ? n.size : cap;
            var out = [];
            var cluster = n.cluster;
            var noChain = n.noFatChain === true;
            var guard = 0;
            while ((cluster !== EOC && cluster >= 2) && out.length < want && guard++ < 65536) {
                var data = readCluster(cluster, noChain);
                if (!data) break;
                for (var i = 0; i < data.length && out.length < want; i++) out.push(data[i]);
                if (noChain) {
                    cluster++;
                } else {
                    cluster = chainFn(v, cluster);
                }
            }
            return out;
        },
        info: function () {
            return {
                type: v.type,
                label: v.label,
                bytesPerSector: v.bytesPerSector,
                sectorsPerCluster: v.sectorsPerCluster,
                clusterCount: v.clusterCount,
                totalBytes: v.clusterCount * v.sectorsPerCluster * v.bytesPerSector,
                rootCluster: v.rootCluster
            };
        },
        close: function () {
            if (vol.msc) {
                vol.msc.close();
                vol.msc = null;
            }
        }
    };
    return vol;
}

module.exports = msc;
