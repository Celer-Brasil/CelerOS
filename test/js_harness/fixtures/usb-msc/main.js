// Fixture do celeros.usb.msc: monta imagens FAT32 e exFAT sinteticas e
// exercita list/read/stat SEM USB (o parser e puro sobre um leitor de setores).
// O run.js confere as linhas impressas.

var usb = require("celeros.usb");
var msc = require("celeros.usb.msc");

function put8(b, o, v) { b[o] = v & 0xFF; }
function put16(b, o, v) { b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF; }
function put32(b, o, v) {
  b[o] = v & 0xFF; b[o + 1] = (v >>> 8) & 0xFF;
  b[o + 2] = (v >>> 16) & 0xFF; b[o + 3] = (v >>> 24) & 0xFF;
}
function putStr(b, o, s) {
  for (var i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i) & 0xFF;
}
function putUtf16(b, o, s, n) {
  for (var i = 0; i < n; i++) put16(b, o + i * 2, i < s.length ? s.charCodeAt(i) : 0);
}

function entry(b, o, name, attr, cluster, size) {
  var i;
  for (i = 0; i < 32; i++) b[o + i] = 0;
  for (i = 0; i < 11; i++) b[o + i] = 0x20;
  for (i = 0; i < name.length && i < 11; i++) b[o + i] = name.charCodeAt(i);
  b[o + 11] = attr;
  put16(b, o + 20, (cluster >> 16) & 0xFFFF);
  put16(b, o + 26, cluster & 0xFFFF);
  put32(b, o + 28, size);
}

function blank(sectors) {
  var a = [];
  for (var i = 0; i < sectors * 512; i++) a.push(0);
  return a;
}

function reader(img) {
  return {
    read: function (lba, count) {
      if (lba < 0 || (lba + count) * 512 > img.length) return null;
      return img.slice(lba * 512, (lba + count) * 512);
    }
  };
}

// ---- FAT32: 64 setores, 1 setor/cluster, FAT dupla, raiz no cluster 2 ----
function fat32Image() {
  var b = blank(64);
  b[0] = 0xEB; b[1] = 0x3C; b[2] = 0x90;
  putStr(b, 3, "MSDOS5.0");
  put16(b, 11, 512);   // bytes/setor
  b[13] = 1;           // setores/cluster
  put16(b, 14, 1);     // reservados
  b[16] = 2;           // num FATs
  put16(b, 17, 0);     // root entries (0 = FAT32)
  put16(b, 19, 0);
  put32(b, 32, 64);    // total de setores
  put32(b, 36, 1);     // FAT em setores
  put32(b, 44, 2);     // cluster da raiz
  putStr(b, 71, "TESTE      ");
  putStr(b, 82, "FAT32   ");
  b[510] = 0x55; b[511] = 0xAA;

  // FAT (setor 1), copiada para o setor 2
  var fat = 512;
  put32(b, fat + 2 * 4, 0x0FFFFFFF);   // cluster 2 (raiz)
  put32(b, fat + 3 * 4, 0x0FFFFFFF);   // cluster 3 (HELLO.TXT)
  put32(b, fat + 4 * 4, 0x0FFFFFFF);   // cluster 4 (SUB)
  put32(b, fat + 5 * 4, 0x0FFFFFFF);   // cluster 5 (INNER.TXT)
  for (var i = 0; i < 512; i++) b[1024 + i] = b[512 + i];

  // Raiz: cluster 2 -> setor 3 (dataLba = 1 + 2*1 = 3)
  var root = 3 * 512;
  entry(b, root, ".", 0x10, 2, 0);
  entry(b, root + 32, "..", 0x10, 0, 0);
  entry(b, root + 64, "HELLO   TXT", 0x20, 3, 5);
  entry(b, root + 96, "SUB        ", 0x10, 4, 0);

  var hello = 4 * 512;   // cluster 3
  putStr(b, hello, "hello");

  var sub = 5 * 512;     // cluster 4
  entry(b, sub, ".", 0x10, 4, 0);
  entry(b, sub + 32, "..", 0x10, 2, 0);
  entry(b, sub + 64, "INNER   TXT", 0x20, 5, 5);

  var inner = 6 * 512;   // cluster 5
  putStr(b, inner, "inner");
  return b;
}

// ---- exFAT: 64 setores, 1 setor/cluster, heap no setor 8, raiz cluster 2 ----
function exfatImage() {
  var b = blank(64);
  putStr(b, 3, "EXFAT   ");
  put32(b, 64, 0); put32(b, 68, 0);     // partition offset
  put32(b, 72, 64); put32(b, 76, 0);    // volume length
  put32(b, 80, 1);                      // fat offset
  put32(b, 84, 1);                      // fat length
  put32(b, 88, 8);                      // cluster heap offset
  put32(b, 92, 56);                     // cluster count
  put32(b, 96, 2);                      // root dir cluster
  put16(b, 104, 0x0100);                // fs revision
  b[108] = 9;                           // 512 bytes/setor
  b[109] = 0;                           // 1 setor/cluster
  b[110] = 1;                           // num FATs
  b[111] = 0x80;
  b[510] = 0x55; b[511] = 0xAA;

  put32(b, 512 + 2 * 4, 0xFFFFFFFF);    // FAT[2] = EOC (raiz)

  var root = 8 * 512;
  // rotulo do volume (0x83): byte1 = numero de chars, UTF-16 a partir de +2
  b[root] = 0x83; b[root + 1] = 5;
  putUtf16(b, root + 2, "TESTE", 5);

  // README.TXT: arquivo 0x85 + stream 0xC0 (NoFatChain) + nome 0xC1
  var f = root + 32;
  b[f] = 0x85; b[f + 1] = 2;
  put16(b, f + 4, 0x20);
  var s = f + 32;
  b[s] = 0xC0;
  b[s + 1] = 0x03;                      // AllocationPossible | NoFatChain
  b[s + 3] = 10;                        // name length
  put32(b, s + 20, 3);                  // first cluster
  put32(b, s + 24, 5);                  // data length (lo)
  put32(b, s + 28, 0);
  var n = f + 64;
  b[n] = 0xC1;
  putUtf16(b, n + 2, "README.TXT", 10);

  var data = 9 * 512;                   // cluster 3
  putStr(b, data, "exfat");
  return b;
}

// ---- FAT32 ----
var v1 = msc.mount(reader(fat32Image()));
System.print("fat:" + v1.type + ":" + v1.label);
var l1 = v1.list("/");
var names1 = "";
for (var i = 0; i < l1.length; i++) names1 += (i ? "," : "") + l1[i].name + (l1[i].dir ? "/" : "");
System.print("fatlist:" + names1);
System.print("fatread:" + usb.str(v1.read("/hello.txt", 16)));
System.print("fatnested:" + usb.str(v1.read("/SUB/INNER.TXT", 16)));
System.print("fatstat:" + v1.stat("/hello.txt").size);

// ---- exFAT ----
var v2 = msc.mount(reader(exfatImage()));
System.print("exfat:" + v2.type + ":" + v2.label);
var l2 = v2.list("/");
var names2 = "";
for (var k = 0; k < l2.length; k++) names2 += (k ? "," : "") + l2[k].name;
System.print("exfatlist:" + names2);
System.print("exfatread:" + usb.str(v2.read("/readme.txt", 16)));
System.print("exfatsize:" + v2.stat("/README.TXT").size);
