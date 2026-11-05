#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Constroi o blob nativo de teste do spike de codigo carregavel (API 57).

Fluxo: compila tools/native/core_hello.c com a toolchain Xtensa do IDF,
liga num endereco-base 0 com linker script proprio, aplica os gates do
formato (autocontido) e prepende o cabecalho "CLRN" que o loader do
firmware (main/Runtime/JsNative.cpp) valida.

Gates do formato (qualquer desvio barra o build):
  1. ZERO relocations no .o (blob autocontido: nenhum endereco absoluto);
  2. ZERO l32r no desassembly final (constantes grandes virariam literais
     de endereco — so movi/imediato pequeno);
  3. .data/.bss vazios (sem globais: estado do core morre em buffers que o
     loader aloca, nunca dentro do blob).

Saida padrao: test/native/app/core_native_test.bin (o app de teste).

Uso: python3 tools/native/build_core.py [--out CAMINHO.bin]
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
CHIP_ID = 1         # 0 = esp32, 1 = esp32s3 (alvo unico do spike)
API_LEVEL = 57      # CELEROS_API_LEVEL que o loader exige no maximo
HEADER_SIZE = 96
ENTRY_COUNT_MAX = 8
# Entradas do blob: toda funcao core_* em ORDEM DE ENDERECO (nm -n) — o
# loader so recebe indices + offsets; o app conhece a ordem porque compila
# o proprio core.c. Nome nunca chega ao firmware.
HEADER_FMT = "<6I8I2I32s"  # 96 bytes exatos


def find_toolchain():
    """xtensa-esp32s3-elf-{gcc,objdump,objcopy,nm}: PATH ou ~/.espressif."""
    names = ("gcc", "objdump", "objcopy", "nm")
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
    sys.exit("ERRO: %s\n%s" % (msg, detail[-2000:] if detail else ""))


def build():
    tc = find_toolchain()
    with tempfile.TemporaryDirectory(prefix="celeros-native-") as tmp:
        obj = os.path.join(tmp, "core.o")
        elf = os.path.join(tmp, "core.elf")
        binf = os.path.join(tmp, "core.bin")
        lds = os.path.join(tmp, "blob.ld")

        # 1. compilar: freestanding, sem builtin (o blob nao chama libc),
        #    literais dentro do .text (uma secao so, blob plano). O fonte e
        #    o do app (--src); o default e o core_hello.c de teste.
        r = run([tc["gcc"], "-std=c11", "-Os", "-c", args.src, "-o", obj,
                 "-ffreestanding", "-fno-builtin", "-fno-pic", "-fno-pie",
                 "-fno-stack-protector", "-fomit-frame-pointer",
                 "-fno-unwind-tables", "-fno-asynchronous-unwind-tables",
                 "-fno-tree-loop-distribute-patterns", "-mtext-section-literals",
                 # toolchain do IDF defaulta -mlongcalls: chamada via literal
                 # de endereco absoluto (l32r+callx) — inexecutavel em base
                 # arbitraria. Blob pequeno usa call8 direto PC-relative.
                 "-mno-longcalls"])
        if r.returncode != 0:
            die("compilacao falhou", r.stderr)

        # 2. ligar em base 0 (linker script proprio; sem libc; se faltar
        #    simbolo externo o proprio link barra — prova de autocontido).
        #    Os gates do formato rodam sobre o ELF LINKADO: no .o os
        #    branches sempre carregam R_XTENSA_SLOT0_OP (operandos
        #    PC-relative, inofensivos — o linker resolve como deslocamento)
        #    e pode sobrar literal morto sem l32r nenhum que o leia.
        with open(lds, "w") as f:
            f.write("SECTIONS\n{\n  . = 0;\n"
                    "  .text : { *(.literal*) *(.text*) *(.rodata*) }\n"
                    "  .data : { *(.data*) }\n"
                    "  .bss  : { *(.bss*) *(COMMON) }\n}\n")
        r = run([tc["gcc"], "-nostdlib", "-Wl,--build-id=none",
                 "-Wl,-T," + lds, "-o", elf, obj])
        if r.returncode != 0:
            die("link falhou (simbolo externo = blob nao autocontido)", r.stderr)

        # Gates no ELF final:
        #   - l32r: carrega literal de 32b do pool — com base arbitraria o
        #     literal linkado teria endereco absoluto; proibido no formato;
        #   - callx: chamada indireta = endereco de funcao tomado ou
        #     dependencia externa — o spike nao tem nenhuma das duas.
        r = run([tc["objdump"], "-d", elf])
        if r.returncode != 0:
            die("objdump -d falhou", r.stderr)
        bad = [l.strip() for l in r.stdout.splitlines()
               if "l32r" in l or "callx" in l]
        if bad:
            die("blob nao e autocontido (%d instrucao(oes) com l32r/callx):\n%s"
                % (len(bad), "\n".join(bad[:5])))

        # Gate 3: sem globais — .data/.bss vazios (o loader nao zera nada).
        r = run([tc["objdump"], "-h", elf])
        if r.returncode != 0:
            die("objdump -h falhou", r.stderr)
        for line in r.stdout.splitlines():
            m = re.match(r"\s*\d+\s+(\.\w+)\s+\S+\s+([0-9a-f]+)", line)
            if m and m.group(1) in (".data", ".bss") and int(m.group(2), 16) != 0:
                die("blob tem global em %s (%s bytes) — proibido no formato"
                    % (m.group(1), m.group(2)))

        # Entradas por simbolo, na ordem fixa; base 0 => offset = endereco.
        r = run([tc["nm"], "-n", elf])  # -n: ordenado por endereco
        if r.returncode != 0:
            die("nm falhou", r.stderr)
        # Entradas do blob: TODO simbolo core_* em ORDEN DE ENDERECO (o
        # loader so recebe indices + offsets — o app sabe a ordem porque
        # compila o proprio core.c; o nome nunca chega ao firmware). O app
        # de teste e o scaffold seguem a mesma convensao.
        entry_names = []
        entries = []
        for line in r.stdout.splitlines():
            m = re.match(r"([0-9a-f]+)\s+\w+\s+(core_\w+)$", line.strip())
            if m:
                entry_names.append(m.group(2))
                entries.append(int(m.group(1), 16))
        if not entry_names:
            die("blob sem nenhuma entrada: nenhuma funcao core_* definida "
                "(cada entrada e uma funcao core_<nome>)")
        if len(entry_names) > ENTRY_COUNT_MAX:
            die("blob tem %d entradas (core_*), teto do formato e %d"
                % (len(entry_names), ENTRY_COUNT_MAX))
        for name, off in zip(entry_names, entries):
            if off & 0x3:
                die("entrada %s desalinhada (offset %d)" % (name, off))

        # 3. binario plano + cabecalho "CLRN".
        r = run([tc["objcopy"], "-O", "binary", elf, binf])
        if r.returncode != 0:
            die("objcopy falhou", r.stderr)
        with open(binf, "rb") as f:
            blob = f.read()
        digest = hashlib.sha256(blob).digest()
        header = struct.pack(HEADER_FMT, MAGIC, HEADER_SIZE, len(blob),
                             CHIP_ID, API_LEVEL, len(entries),
                             *(entries + [0] * (ENTRY_COUNT_MAX - len(entries))),
                             0, 0, digest)
        assert len(header) == HEADER_SIZE, "cabecalho != 96 bytes"

        out = os.path.abspath(args.out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as f:
            f.write(header + blob)

        print("blob nativo OK: %s" % out)
        print("  blob %d B + cabecalho %d B = %d B total"
              % (len(blob), HEADER_SIZE, HEADER_SIZE + len(blob)))
        print("  chip=esp32s3(%d) api=%d sha256=%s" % (CHIP_ID, API_LEVEL,
                                                       digest.hex()[:16]))
        for i, (name, off) in enumerate(zip(entry_names, entries)):
            print("  [%d] %-10s offset %4d" % (i,
                                               name, off))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--src", default=SRC,
                   help="fonte C do blob (default: core_hello.c de teste)")
    p.add_argument("--out", default=os.path.join(
        HERE, "..", "..", "test", "native", "bench-nativo",
        "core_native_test.bin"))
    args = p.parse_args()
    args.src = os.path.abspath(args.src)
    build()
