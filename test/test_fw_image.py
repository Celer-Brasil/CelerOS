#!/usr/bin/env python3
"""Testes do leitor de imagem do IDF (tools/fw_image.py) — host, sem build.

    python3 test/test_fw_image.py -v

As imagens sao SINTETICAS (montadas byte a byte no layout do IDF 6.1): o
teste tem que falhar quando o layout mudar, sem depender de um build de
firmware para rodar no CI.
"""

import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import fw_image as F  # noqa: E402


def _asciiz(text, size):
    raw = text.encode("utf-8")[: size - 1]
    return raw + b"\x00" * (size - len(raw))


def make_image(version="1.18.0", project="CelerOS", chip_id=0x0009,
               idf="v6.1.0", magic=F.IMAGE_MAGIC, desc_magic=F.APP_DESC_MAGIC,
               size=4096):
    """Imagem minima no layout do IDF: header 24 B + segmento + app_desc."""
    buf = bytearray(b"\x00" * size)
    buf[0] = magic
    buf[1] = 3                       # segment_count
    buf[2] = 0                       # spi_mode
    struct.pack_into("<I", buf, 4, 0x42000020)   # entry_addr
    struct.pack_into("<H", buf, 12, chip_id)
    struct.pack_into("<I", buf, 24, 0x3C000020)  # segment load_addr
    struct.pack_into("<I", buf, 28, 256)         # segment data_len
    b = F.APP_DESC_OFFSET
    struct.pack_into("<I", buf, b, desc_magic)
    struct.pack_into("<I", buf, b + 4, 0)        # secure_version
    buf[b + 16:b + 48] = _asciiz(version, 32)
    buf[b + 48:b + 80] = _asciiz(project, 32)
    buf[b + 80:b + 96] = _asciiz("10:49:00", 16)
    buf[b + 96:b + 112] = _asciiz("Nov 12 2026", 16)
    buf[b + 112:b + 144] = _asciiz(idf, 32)
    buf[b + 144:b + 176] = bytes(range(32))      # app_elf_sha256
    return bytes(buf)


class ParseTest(unittest.TestCase):
    def test_le_versao_e_chip(self):
        img = F.parse(make_image())
        self.assertTrue(img.ok, img.error)
        self.assertEqual(img.version, "1.18.0")
        self.assertEqual(img.project, "CelerOS")
        self.assertEqual(img.chip_id, 0x0009)
        self.assertEqual(img.chip, "esp32s3")
        self.assertEqual(img.idf_ver, "v6.1.0")
        self.assertEqual(img.built_date, "Nov 12 2026")

    def test_esp32_classico(self):
        img = F.parse(make_image(chip_id=0x0000))
        self.assertTrue(img.ok)
        self.assertEqual(img.chip, "esp32")

    def test_magic_errado(self):
        img = F.parse(make_image(magic=0x00))
        self.assertFalse(img.ok)
        self.assertIn("nao e imagem de app", img.error)

    def test_bootloader_nao_serve(self):
        # bootloader tem o magic de imagem mas NAO tem app_desc
        img = F.parse(make_image(desc_magic=0x00000000))
        self.assertFalse(img.ok)
        self.assertIn("app_desc ausente", img.error)

    def test_arquivo_curto(self):
        img = F.parse(make_image()[:100])
        self.assertFalse(img.ok)
        self.assertIn("curto demais", img.error)

    def test_versao_vazia_e_erro(self):
        img = F.parse(make_image(version=""))
        self.assertFalse(img.ok)
        self.assertIn("sem version", img.error)

    def test_sem_acento_na_mensagem(self):
        # as mensagens de ferramenta do repo sao PT sem acento
        for err in (F.parse(make_image(magic=0)).error,
                    F.parse(make_image()[:50]).error,
                    F.parse(make_image(desc_magic=0)).error):
            self.assertEqual(err, err.encode("ascii", "ignore").decode())


class CheckTargetTest(unittest.TestCase):
    def test_alvo_certo(self):
        img = F.parse(make_image(chip_id=0x0009))
        self.assertEqual(F.check_target(img, "esp32s3"), [])

    def test_alvo_errado(self):
        img = F.parse(make_image(chip_id=0x0000))   # imagem de ESP32 classico
        p = F.check_target(img, "esp32s3")
        self.assertEqual(len(p), 1)
        self.assertIn("compilada para esp32", p[0])
        self.assertIn("aparelho e esp32s3", p[0])

    def test_alvo_desconhecido_nao_opina(self):
        img = F.parse(make_image())
        self.assertEqual(F.check_target(img, "placa-inventada"), [])

    def test_imagem_ilegivel_reprova(self):
        p = F.check_target(F.parse(make_image(magic=0)), "esp32s3")
        self.assertEqual(len(p), 1)


class ReadFileTest(unittest.TestCase):
    def test_arquivo_inexistente(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            img = F.read_image(Path(td) / "nao-existe.bin")
        self.assertFalse(img.ok)
        self.assertIn("nao consegui ler", img.error)


if __name__ == "__main__":
    unittest.main()
