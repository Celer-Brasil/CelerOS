#!/usr/bin/env python3
"""Le o cabecalho e o app_desc de um .bin do ESP-IDF (host, sem build).

Um .bin de aplicacao carrega, nos primeiros 24 bytes, o esp_image_header_t —
que diz para QUAL chip a imagem foi compilada - e, logo depois do cabecalho
do primeiro segmento (0x20), o esp_app_desc_t - que diz QUAL versao ela
anuncia ao se apresentar. As duas coisas sao a diferenca entre uma OTA que
grava e uma que deixa a placa sem boot:

- chip errado: o bootloader recusa a imagem e, se ela ja tiver sido marcada
  como slot de boot, o aparelho fica em rollback ou em loop de reset;
- versao errada: o CMake le o version.json sem criar dependencia de
  configure, entao um binario velho pode sair com o numero novo (ou o
  contrario) e o OTA entra em laco - a placa baixa, reinicia e continua se
  dizendo na versao anterior.

Layout (IDF 6.1, components/bootloader_support/include/esp_app_format.h e
components/esp_app_format/include/esp_app_desc.h):

    +0    magic 0xE9        +1  segment_count    +2  spi_mode
    +3    spi_speed/spi_size +4 entry_addr (u32)  +12 chip_id (u16)
    +24   esp_image_segment_header_t {load_addr, data_len}
    +32   esp_app_desc_t: magic 0xABCD5432 (u32)
          +16 version[32]  +48 project_name[32]
          +80 time[16]     +96 date[16]      +112 idf_ver[32]

O app_desc aparece no 0x20 do arquivo (e nao do segmento do app) porque o
IDF coloca o bloco .rodata descritor como primeiro segmento; o mesmo vale
para imagens com secure boot (a assinatura vai no FIM do arquivo).

Uso:
    python3 tools/fw_image.py build/CelerOS.bin            # resumo legivel
    python3 tools/fw_image.py build-cyd/CelerOS.bin --json

    from fw_image import read_image, check_target
"""

import argparse
import json
import struct
import sys
from pathlib import Path

IMAGE_MAGIC = 0xE9
APP_DESC_MAGIC = 0xABCD5432
APP_DESC_OFFSET = 0x20   # 24 B do header de imagem + 8 B do header de segmento

# esp_chip_id_t do IDF 6.1. So os alvos que o CelerOS compila precisam estar
# aqui, mas a tabela inteira evita "chip 0x0009" na mensagem de erro.
CHIP_NAMES = {
    0x0000: "esp32",
    0x0002: "esp32s2",
    0x0005: "esp32c3",
    0x0009: "esp32s3",
    0x000C: "esp32c2",
    0x000D: "esp32c6",
    0x0010: "esp32h2",
    0x0012: "esp32p4",
    0x0014: "esp32c61",
    0x0017: "esp32c5",
}

# target do CMake (-DCELEROS_BOARD / boards.json) -> chip_id
TARGET_CHIP = {
    "esp32": 0x0000,
    "esp32s2": 0x0002,
    "esp32c3": 0x0005,
    "esp32s3": 0x0009,
    "esp32c2": 0x000C,
    "esp32c6": 0x000D,
}


class ImageError(Exception):
    """Binario que nao e imagem de app do ESP-IDF."""


def _asciiz(raw):
    """Campo char[N] com terminador opcional; bytes nao-UTF8 viram '?'."""
    end = raw.find(b"\x00")
    if end >= 0:
        raw = raw[:end]
    return raw.decode("utf-8", "replace").strip()


class Image:
    """Resultado da leitura. `error` preenchido = arquivo nao e imagem valida."""

    def __init__(self):
        self.path = None
        self.size = 0
        self.magic = None
        self.segments = None
        self.chip_id = None
        self.chip = None
        self.hash_appended = None
        self.version = None
        self.project = None
        self.built_time = None
        self.built_date = None
        self.idf_ver = None
        self.elf_sha256 = None
        self.error = None

    @property
    def ok(self):
        return self.error is None

    def as_dict(self):
        return {
            "path": str(self.path) if self.path else None,
            "size": self.size,
            "chip_id": self.chip_id,
            "chip": self.chip,
            "segments": self.segments,
            "version": self.version,
            "project": self.project,
            "built": " ".join(x for x in (self.built_date, self.built_time) if x) or None,
            "idf": self.idf_ver,
            "elf_sha256": self.elf_sha256,
            "error": self.error,
        }

    def __str__(self):
        if not self.ok:
            return f"{self.path}: {self.error}"
        built = " ".join(x for x in (self.built_date, self.built_time) if x)
        return (f"{self.path}: {self.version} ({self.project}), "
                f"chip {self.chip}, IDF {self.idf_ver}, build {built}")


def parse(data, path=None):
    """Bytes -> Image. Nunca levanta por conteudo: preenche `error`."""
    img = Image()
    img.path = path
    img.size = len(data)
    if len(data) < APP_DESC_OFFSET + 256:
        img.error = ("arquivo curto demais para uma imagem de app "
                     f"({len(data)} B): nao e o .bin do IDF?")
        return img
    img.magic = data[0]
    if img.magic != IMAGE_MAGIC:
        img.error = (f"magic 0x{img.magic:02x} (esperado 0x{IMAGE_MAGIC:02x}): "
                     "nao e imagem de app do ESP-IDF (bootloader/particao nao servem)")
        return img
    img.segments = data[1]
    img.chip_id = struct.unpack_from("<H", data, 12)[0]
    img.chip = CHIP_NAMES.get(img.chip_id, f"0x{img.chip_id:04x}")
    img.hash_appended = bool(data[23])

    magic = struct.unpack_from("<I", data, APP_DESC_OFFSET)[0]
    if magic != APP_DESC_MAGIC:
        img.error = (f"app_desc ausente em 0x{APP_DESC_OFFSET:X} "
                     f"(magic 0x{magic:08x}, esperado 0x{APP_DESC_MAGIC:08x})")
        return img
    base = APP_DESC_OFFSET
    img.version = _asciiz(data[base + 16:base + 48])
    img.project = _asciiz(data[base + 48:base + 80])
    img.built_time = _asciiz(data[base + 80:base + 96])
    img.built_date = _asciiz(data[base + 96:base + 112])
    img.idf_ver = _asciiz(data[base + 112:base + 144])
    img.elf_sha256 = data[base + 144:base + 176].hex()
    if not img.version:
        img.error = "app_desc sem version"
    return img


def read_image(path):
    """Le o arquivo inteiro (um .bin tem ~1-4 MB) e devolve a Image."""
    p = Path(path)
    try:
        return parse(p.read_bytes(), p)
    except OSError as exc:
        img = Image()
        img.path = p
        img.error = f"nao consegui ler: {exc}"
        return img


def check_target(img, target):
    """Lista de problemas para gravar esta imagem num aparelho `target`.

    target = "esp32" / "esp32s3" (o mesmo nome de -DCELEROS_BOARD). Devolve
    lista vazia quando o chip da imagem e o do aparelho. Texto em portugues
    sem acento, como o resto das mensagens de ferramenta do repo.
    """
    if not img.ok:
        return [str(img.error)]
    want = TARGET_CHIP.get(target)
    if want is None:
        return []  # alvo desconhecido: nao da para afirmar nada
    if img.chip_id != want:
        return [
            f"a imagem foi compilada para {img.chip} e o aparelho e {target}: "
            "o bootloader recusa (ou o aparelho entra em rollback). "
            "Grave o .bin do build desta placa."
        ]
    return []


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bin", nargs="+", help="caminho do .bin (app, nao bootloader)")
    ap.add_argument("--json", action="store_true", help="JSON em vez de linha legivel")
    ap.add_argument("--target", default=None,
                    help="confere o chip contra este alvo (esp32|esp32s3|...)")
    args = ap.parse_args(argv)

    bad = 0
    for path in args.bin:
        img = read_image(path)
        problems = check_target(img, args.target) if args.target else []
        if args.json:
            doc = img.as_dict()
            if args.target:
                doc["target"] = args.target
                doc["target_problems"] = problems
            print(json.dumps(doc, ensure_ascii=False, indent=2))
        else:
            print(img)
            for p in problems:
                print(f"  [!!] {p}")
        if not img.ok or problems:
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
