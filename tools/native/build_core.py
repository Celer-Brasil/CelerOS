#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Constroi um blob nativo CLRN (v2, relocavel) para o carregador de apps.

Fluxo: compila UM fonte (C ou C++ freestanding) com a toolchain Xtensa do
IDF, liga em base 0 com linker script proprio, EXTRAI as relocacoes
absolutas (R_XTENSA_32) e monta o arquivo: cabecalho + imagem plana
[code][data] + tabela de relocacoes. O loader do firmware
(main/Runtime/JsNative.cpp) copia a imagem para a PSRAM, zera o .bss,
aplica +base em cada site da tabela e executa.

Formato v2 (cabecalho de 128 B, little-endian):
   0 magic "CLRN"      4 headerSize=128   8 imageSize      12 chip
  16 api              20 entryCount      24 entries[8] (offsets no blob)
  56 bssOff           60 bssSize         64 relocOff       68 relocCount
  72 relocKind (1 = bit31 do site marca dados)
  76 fastSize: os ULTIMOS fastSize bytes do .bss (secao .clrn_fast) podem
     ir para a RAM INTERNA — o loader que entende aloca ali e redireciona
     as relocacoes de dados que caem na faixa; o antigo ignora o campo e a
     regiao segue no .bss (PSRAM): o mesmo binario roda nos dois
  80 sha256[32]      112 reservado[16]
imagem = code+data planos (VMA 0..); tabela = relocCount u32 de offsets
RELATIVOS ao inicio da imagem onde aplicar +base (4 B alinhados).

V1 (cabecalho 96 B, sem data/bss/reloc) continua aceito pelo loader; este
builder so emite v2.

Gates (qualquer desvio barra o build):
  1. sem -mlongcalls (call8 direto; o link falha se o blob passar de
     ~256 KB de texto — reduza o core ou habilite longcalls com reloc);
  2. -G0: sem .sdata/.sbss (acesso GP-relativo exigiria registrar o gp,
     que o loader nao faz);
  3. apenas R_XTENSA_32 na tabela de relocacoes (branches SLOT0_OP ja
     sao PC-relative e sao ignorados; qualquer outro tipo barra);
  4. entradas = funcoes core_* em ORDEM DE ENDERECO (nm -n), maximo 8.

Uso: python3 tools/native/build_core.py --src ARQ [--out ARQ]
"""

import argparse
import glob
import hashlib
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "core_hello.c")

MAGIC = 0x4E524C43  # "CLRN" (little-endian)
CHIP_ID = 1         # 0 = esp32, 1 = esp32s3
API_LEVEL = 58      # CELEROS_API_LEVEL que o loader exige no maximo
HEADER_SIZE = 128
ENTRY_COUNT_MAX = 8
MAX_RELOCS = 16384  # teto de sanidade da tabela (64 KB de u32)
# magic, hsize, imageSize, chip, api, entryCount, entries[8], bssOff,
# bssSize, relocOff, relocCount, r4, r5, sha256[32], pad[16]
HEADER_FMT = "<6I8I6I32s16s"  # 128 bytes exatos
RE_V2 = True
VERBOSE_RELOCS = os.environ.get("CLRN_VERBOSE_RELOCS") == "1"

# Flags C++ freestanding: sem excecoes/RTTI, sem guardas de static, sem
# unwind. Tabelas de salto LIGADAS: o switch de 256 opcodes do 6502 sem elas
# vira arvore de ~8 comparacoes por instrucao; cada entrada e R_XTENSA_32
# contra .text (kind = exec no v3), que o loader ja reloca. .sdata/.sbss
# sao barrados no link: sao acessados por GP, que o loader nao registra.
CXX_FLAGS = ["-std=c++17", "-fno-exceptions", "-fno-rtti",
             "-fno-threadsafe-statics", "-fno-use-cxa-atexit",
             "-fno-unwind-tables", "-fno-asynchronous-unwind-tables"]
COMMON_FLAGS = ["-O2", "-ffreestanding", "-fno-builtin", "-fno-pic",
                "-fno-pie", "-fno-stack-protector", "-fomit-frame-pointer",
                "-fno-tree-loop-distribute-patterns",
                "-mtext-section-literals", "-mno-longcalls"]


def find_toolchain():
    """xtensa-esp32s3-elf-{gcc,g++,readelf,objdump,nm}."""
    names = ("gcc", "g++", "readelf", "objdump", "objcopy", "nm")
    prefix = shutil.which("xtensa-esp32s3-elf-gcc")
    if prefix:
        base = os.path.dirname(prefix)
        return {n: os.path.join(base, "xtensa-esp32s3-elf-" + n) for n in names}
    candidates = glob.glob(os.path.expanduser(
        "~/.espressif/tools/xtensa-esp-elf/*/*/bin/xtensa-esp32s3-elf-gcc"))
    candidates += glob.glob(os.path.expanduser(
        "~/.espressif/tools/xtensa-esp32s3-elf/*/*/bin/xtensa-esp32s3-elf-gcc"))
    if not candidates:
        sys.exit("ERRO: toolchain xtensa-esp32s3-elf nao encontrada "
                 "(ative o IDF ou instale em ~/.espressif)")
    base = os.path.dirname(sorted(candidates)[-1])
    return {n: os.path.join(base, "xtensa-esp32s3-elf-" + n) for n in names}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def die(msg, detail=""):
    sys.exit("ERRO: %s\n%s" % (msg, detail[-3000:] if detail else ""))


def sections(rd, elf):
    """{nome: (addr, size)} das secoes SHF_ALLOC do ELF linkado."""
    r = run([rd, "-S", "-W", elf])
    if r.returncode != 0:
        die("readelf -S falhou", r.stderr)
    out = {}
    for line in r.stdout.splitlines():
        p = line.split()
        # [Nr] Name Type Address Off Size ES Flg Lk Inf Al
        if len(p) < 9 or not p[0].startswith("["):
            continue
        try:
            name = p[2]
            addr = int(p[4], 16)
            size = int(p[6], 16)
            flg = p[8]
        except (IndexError, ValueError):
            continue
        if "A" in flg:  # SHF_ALLOC
            out[name] = (addr, size)
    return out


def absolute_relocs(rd, elf, secs, nmbin):
    """Sites de R_XTENSA_32 (endereco absoluto) nas secoes ALOCADAS do ELF
    linkado, como offset na IMAGEM (VMA da secao + offset da relocacao —
    .rela.data offsets sao relativos a .data, nao a imagem!). SLOT0_OP
    (branches PC-relative) ja resolvidos sao ignorados; QUALQUER outro tipo
    nas secoes alocadas e erro. .rela.xt.prop/.rela.xt.lit sao metadado do
    linker (relaxador), NAO relocacoes de runtime — fora."""
    # Tipos de simbolo no nm: T/t = funcao; D/d/B/b = dados; R/r = rodata.
    sym_type = {}
    rn = run([nmbin, elf])
    if rn.returncode == 0:
        for line in rn.stdout.splitlines():
            mm = re.match(r"[0-9a-f]+\s+(\w)\s+(\S+)$", line.strip())
            if mm:
                sym_type[mm.group(2)] = mm.group(1)
    r = run([rd, "-r", "-W", elf])
    if r.returncode != 0:
        die("readelf -r falhou", r.stderr)
    per_sec = {}  # secao-alvo -> [(off bruto, kind)]; resolve no fim
    bad = []
    cur = None  # secao-alvo (nome sem o prefixo .rela)
    for line in r.stdout.splitlines():
        msec = re.search(r"Relocation section '\.rela(\S*)'", line)
        if msec:
            cur = msec.group(1)
            continue
        if cur is None or cur not in secs:
            continue  # xt.prop/xt.lit e afins: metadado, nao alocado
        m = re.match(r"([0-9a-f]{8})\s+[0-9a-f]+\s+(R_XTENSA_\w+)"
                     r"\s+[0-9a-f]+\s+(\S+)", line.strip())
        if not m:
            m = re.match(r"([0-9a-f]{8})\s+[0-9a-f]+\s+(R_XTENSA_\w+)",
                         line.strip())
            if not m:
                continue
            off, typ, sym = int(m.group(1), 16), m.group(2), ""
        else:
            off, typ, sym = int(m.group(1), 16), m.group(2), m.group(3)
        if typ == "R_XTENSA_32":
            # Funcao alvo vai para o ALIAS EXECUTAVEL; data/rodata para o
            # endereco de dados. Simbolo de secao ".text" e funcao (ponteiro
            # de codigo). Desconhecido => dados (acesso errado por alias exec
            # faulta; por dados num ponteiro de codigo o callx falha — a
            # escolha segura e o caso dominante: literais apontam p/ dados).
            st = sym_type.get(sym, "")
            is_code = (st in ("T", "t")) or sym == ".text"
            per_sec.setdefault(cur, []).append((off, 0 if is_code else 1, sym))
            if VERBOSE_RELOCS:
                sys.stderr.write("[reloc] %s@%x kind=%d (%s)\n"
                                 % (cur, off, 0 if is_code else 1, sym))
        elif typ in ("R_XTENSA_SLOT0_OP", "R_XTENSA_NONE"):
            continue  # branch PC-relative resolvido / relocacao no-op
        else:
            bad.append((off, typ))
    if bad:
        die("relocacoes inesperadas (%d): %s — o formato v2 so aplica "
            "R_XTENSA_32" % (len(bad),
                             ", ".join("%s@%x" % (t, o) for o, t in bad[:8])))
    # r_offset vem como VMA (bancada: .rela.data com .data em 0x7d1c imprime
    # 0x7d1c) OU como offset-dentro-da-secao. Antes o discriminante era
    # "off < size = offset" — com secao@VMA nao nula e size > VMA (ex.:
    # texto minimo + 64 KB de tabelas em .rodata@0x64) os PRIMEIROS sites da
    # secao caem no ramo errado e a tabela sai deslocada (+VMA): o site real
    # nunca recebe +base e um byte de tabela leva +base (blob que crasha no
    # device, com sha proprio conferido pelo loader). Regra robusta: um
    # r_offset valido SEMPRE aponta dentro da secao — usa VMA se todos os
    # sites cabem em [vma, vma+size); senao offset (todos em [0, size));
    # nenhum dos dois = ELF hostil, barra.
    sites = {}
    for sec, raws in per_sec.items():
        vma, ssz = secs[sec]
        if all(vma <= o < vma + ssz for o, _k, _s in raws):
            conv = lambda o: o
        elif all(0 <= o < ssz for o, _k, _s in raws):
            conv = lambda o: vma + o
        else:
            die("relocacoes fora da secao %s (%d sites, secao @0x%x +0x%x)"
                % (sec, len(raws), vma, ssz))
        for o, k, _s in raws:
            sites[conv(o)] = k
    return sorted(sites.items())


def build():
    tc = find_toolchain()
    src = args.src
    is_cxx = src.lower().endswith((".cpp", ".cc", ".cxx"))
    cc = tc["g++"] if is_cxx else tc["gcc"]
    with tempfile.TemporaryDirectory(prefix="celeros-native-") as tmp:
        obj = os.path.join(tmp, "core.o")
        elf = os.path.join(tmp, "core.elf")
        binf = os.path.join(tmp, "core.bin")
        lds = os.path.join(tmp, "blob.ld")

        # 1. compilar o TU unico (freestanding; o blob nao chama libc —
        #    quem precisa de mem* usa tools/native/runtime.c incluido no TU).
        cmd = [cc] + COMMON_FLAGS + (CXX_FLAGS if is_cxx else ["-std=c11"])
        for inc in args.include or []:
            cmd += ["-I", os.path.abspath(inc)]
        cmd += ["-c", src, "-o", obj]
        r = run(cmd)
        if r.returncode != 0:
            die("compilacao falhou", r.stderr)

        # 2. ligar em base 0 mantendo as relocacoes (--emit-relocs): a
        #    tabela vira dado do blob e o loader soma a base no destino.
        #    .bss fica fora da imagem (loader zera); .data entra na imagem.
        with open(lds, "w") as f:
            # .rodata em SECAO PROPRIA logo apos o codigo: as relocacoes
            # contra o simbolo de secao dizem se o alvo e codigo (".text",
            # alias EXEC) ou rodata/dados (alias de dados). Mergida no .text
            # (script antigo), todo ponteiro de rodata virava "funcao" e o
            # load pelo alias executavel faultava (StoreProhibited/
            # LoadStoreProhibited na bancada). A imagem segue plana: text ->
            # rodata -> data -> bss.
            f.write("SECTIONS\n{\n  . = 0;\n"
                    "  .text : { *(.literal*) *(.text*) }\n"
                    "  .rodata : ALIGN(4) { *(.rodata*) }\n"
                    "  .data : ALIGN(4) { *(.data*) *(.ctors) *(.dtors) }\n"
                    "  .bss  : ALIGN(4) { *(.bss*) *(COMMON) }\n"
                    # estado QUENTE do core (CLRN_FAST): fim do .bss, para o
                    # loader mover inteiro para a RAM interna
                    "  .clrn_fast : ALIGN(16) { *(.clrn_fast*) }\n}\n")
        r = run([tc["gcc"], "-nostdlib", "-Wl,--emit-relocs",
                 "-Wl,--build-id=none", "-Wl,-T," + lds, "-o", elf, obj])
        if r.returncode != 0:
            die("link falhou (simbolo externo = blob nao autocontido; "
                "mem*/malloc vem do runtime freestanding)", r.stderr)

        secs = sections(tc["readelf"], elf)
        # GP-relativo: .sdata/.sbss sao acessados via gp e o loader nao o
        # registra — qualquer conteudo ali e inexecutavel no formato.
        for gp_sec in (".sdata", ".sbss", ".sdata2", ".sbss2"):
            s = secs.get(gp_sec)
            if s and s[1] > 0:
                die("blob tem %s (%d B): acesso GP-relativo nao suportado "
                    "(evite variaveis pequenas/const locais)" % (gp_sec, s[1]))
        text = secs.get(".text")
        data = secs.get(".data")
        bss = secs.get(".bss")
        if text is None:
            die("ELF sem .text")
        image_end = 0
        if data is not None:
            image_end = data[0] + data[1]
        bss_off, bss_size = (bss[0], bss[1]) if bss else (image_end, 0)
        if bss_size and bss_off < image_end:
            die("layout inesperado: .bss dentro da imagem")
        fast = secs.get(".clrn_fast")
        fast_size = fast[1] if fast else 0
        if fast_size:
            # a regiao fast e o FIM do .bss: estende o .bss ate cobri-la (o
            # loader antigo zera e usa tudo junto, na PSRAM)
            if not bss_size:
                bss_off = (image_end + 3) & ~3
            if fast[0] < bss_off:
                die("layout inesperado: .clrn_fast antes do .bss")
            bss_size = fast[0] + fast_size - bss_off

        # 3. imagem plana code+data (VMA 0..image_end) e tabela de relocs.
        r = run([tc["objcopy"], "-O", "binary", elf, binf])
        if r.returncode != 0:
            die("objcopy falhou", r.stderr)
        with open(binf, "rb") as f:
            image = f.read()
        if len(image) > image_end:
            die("imagem %d B > fim do .data %d B (secoes nao mapeadas?)"
                % (len(image), image_end))
        # ALIGN entre secoes deixa buraco no meio da imagem: o loader copia
        # a imagem como memoria plana, entao o vao vira zeros.
        image += b"\x00" * (image_end - len(image))
        sites = absolute_relocs(tc["readelf"], elf, secs, tc["nm"])
        if len(sites) > MAX_RELOCS:
            die("tabela de relocacoes com %d sites (max %d)"
                % (len(sites), MAX_RELOCS))
        for o, _kind in sites:
            if o % 4 or o + 4 > image_end or o >= (1 << 31):
                die("site de relocacao invalido: 0x%x (imagem 0x%x)"
                    % (o, image_end))

        # 4. entradas: todo core_* em ordem de endereco (o loader recebe
        #    so indices + offsets; o nome nunca chega ao firmware).
        r = run([tc["nm"], "-n", elf])
        if r.returncode != 0:
            die("nm falhou", r.stderr)
        entry_names, entries = [], []
        for line in r.stdout.splitlines():
            m = re.match(r"([0-9a-f]+)\s+\w+\s+(core_\w+)$", line.strip())
            if m:
                entry_names.append(m.group(2))
                entries.append(int(m.group(1), 16))
        if not entry_names:
            die("blob sem entrada: defina funcoes core_* (extern \"C\")")
        if len(entry_names) > ENTRY_COUNT_MAX:
            die("%d entradas core_* (max %d)"
                % (len(entry_names), ENTRY_COUNT_MAX))

        # 5. cabecalho v2 + imagem + tabela.
        digest = hashlib.sha256(image + b"".join(
            struct.pack("<I", o | (k << 31)) for o, k in sites)).digest()
        header = struct.pack(
            HEADER_FMT, MAGIC, HEADER_SIZE, len(image), CHIP_ID, API_LEVEL,
            len(entries), *(entries + [0] * (ENTRY_COUNT_MAX - len(entries))),
            # relocOff e offset no ARQUIVO (header + imagem): a tabela vem
            # logo depois da imagem
            bss_off, bss_size, HEADER_SIZE + len(image), len(sites),
            1, fast_size,  # r4=1: relocs com KIND; r5 = regiao fast
            digest, b"\x00" * 16)
        assert len(header) == HEADER_SIZE, "cabecalho != 128 bytes"
        out = os.path.abspath(args.out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as f:
            f.write(header)
            f.write(image)
            for o, k in sites:
                f.write(struct.pack("<I", o | (k << 31)))

        print("blob nativo OK: %s" % out)
        print("  imagem %d B (%s) + %d relocs + cabecalho %d B = %d B"
              % (len(image), "C++" if is_cxx else "C", len(sites),
                 HEADER_SIZE, HEADER_SIZE + len(image) + 4 * len(sites)))
        print("  bss %d B @ 0x%x (fast %d B no fim) | chip=esp32s3(%d) api=%d "
              "sha256=%s" % (bss_size, bss_off, fast_size, CHIP_ID, API_LEVEL,
                             digest.hex()[:16]))
        for i, (name, off) in enumerate(zip(entry_names, entries)):
            print("  [%d] %-10s offset %5d" % (i, name, off))
        if args.keep_elf:
            shutil.copyfile(elf, args.keep_elf)
            print("  elf: %s" % args.keep_elf)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--src", default=SRC,
                   help="fonte unico do blob (C ou C++; default hello de teste)")
    p.add_argument("--out", default=os.path.join(
        HERE, "..", "..", "hub_apps", "Bench Nativo", "core_native_test.bin"))
    p.add_argument("--include", action="append",
                   help="diretorio de include extra (repetivel)")
    p.add_argument("--keep-elf", metavar="ARQ",
                   help="copia o ELF intermediario para ARQ (addr2line dos "
                        "offsets do crash.txt: pc - nexec)")
    args = p.parse_args()
    args.src = os.path.abspath(args.src)
    build()
