#!/usr/bin/env python3
"""Testes do manifest de placas (host, sem build).

    python3 test/test_boards.py -v

Cobre os parsers do gen_boards.py (matrix do CI, flash_data.sh, CMake,
sdkconfig) e roda o validador na arvore real. Um caso negativo monta uma
arvore minima para garantir que o validador nao e um no-op.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import gen_boards as G  # noqa: E402
import size_report as S  # noqa: E402


class ParsersTest(unittest.TestCase):
    def test_matrix(self):
        text = """
        include:
          - board: smartdisplay
            target: esp32s3
          - board: cyd
            target: esp32
        """
        self.assertEqual(
            G.matrix_boards(text), {"smartdisplay": "esp32s3", "cyd": "esp32"}
        )

    def test_flash_data_ignora_porta_e_catch_all(self):
        text = """
case "$BOARD" in
  spotpear-dog|waveshare-watch) DEFAULT_PORT="/dev/ttyACM0" ;;
  *)            DEFAULT_PORT="/dev/ttyUSB0" ;;
esac

case "$BOARD" in
  smartdisplay|spotpear-dog) PART_CSV="partitions_16MB.csv" ;;
  cyd|cyd-vspi|devkit) PART_CSV="partitions_4MB.csv" ;;
  *) echo "board invalida"; exit 1 ;;
esac
"""
        self.assertEqual(
            G.flash_data_boards(text),
            {
                "smartdisplay": "partitions_16MB.csv",
                "spotpear-dog": "partitions_16MB.csv",
                "cyd": "partitions_4MB.csv",
                "cyd-vspi": "partitions_4MB.csv",
                "devkit": "partitions_4MB.csv",
            },
        )

    def test_cmake(self):
        text = """
if(CELEROS_BOARD STREQUAL "smartdisplay")
elseif(CELEROS_BOARD STREQUAL "esp32-cam")
else()
endif()
"""
        self.assertEqual(G.cmake_boards(text), {"smartdisplay", "esp32-cam"})

    def test_flashsize(self):
        self.assertEqual(
            G.sdkconfig_flash_mb("CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y\n"), 16
        )
        self.assertIsNone(G.sdkconfig_flash_mb("CONFIG_SPIRAM=y\n"))

    def test_psram(self):
        self.assertEqual(G.sdkconfig_psram("CONFIG_SPIRAM=y\n"), "?")
        self.assertEqual(
            G.sdkconfig_psram("CONFIG_SPIRAM=y\nCONFIG_SPIRAM_MODE_OCT=y\n"), "octal"
        )
        self.assertEqual(
            G.sdkconfig_psram("CONFIG_SPIRAM=y\nCONFIG_SPIRAM_MODE_QUAD=y\n"), "quad"
        )
        self.assertEqual(G.sdkconfig_psram("CONFIG_SPIRAM_MODE_OCT=y\n"), "none")


class ManifestTest(unittest.TestCase):
    def test_arvore_real_consistente(self):
        self.assertEqual(G.validate(ROOT), [])

    def test_size_report_le_o_manifest(self):
        manifest = G.load(ROOT)
        self.assertEqual(set(S.BOARDS), set(manifest))
        for board, cfg in manifest.items():
            self.assertEqual(S.BOARDS[board]["build"], cfg["build_dir"])
            self.assertEqual(S.BOARDS[board]["csv"], cfg["partitions"])

    def test_validador_nao_e_no_op(self):
        # Arvore minima: so o manifest e um defaults vazio. Tudo o resto falta,
        # entao o validador precisa acumular erros (nao estourar excecao).
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "boards" / "bogus").mkdir(parents=True)
            (root / "boards" / "bogus" / "sdkconfig.defaults").write_text("")
            (root / "boards" / "boards.json").write_text(
                json.dumps(
                    {
                        "boards": {
                            "bogus": {
                                "target": "esp32",
                                "flash_mb": 4,
                                "psram": "none",
                                "partitions": "partitions_4MB.csv",
                                "ota_channel": "esp32",
                                "build_dir": "build-bogus",
                                "data_overlay": False,
                                "data_exclude": False,
                            }
                        }
                    }
                )
            )
            errors = G.validate(root)
            self.assertTrue(errors)
            joined = "\n".join(errors)
            for expected in (
                "main/Boards/bogus/Board.cpp",
                "particao",
                "canal de OTA",
                "matrix",
                "flash_data",
                "CMake",
            ):
                self.assertIn(expected, joined)


if __name__ == "__main__":
    unittest.main()
