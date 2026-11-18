#!/usr/bin/env python3
"""Testes do sdkconfig_check.py (host, sem build).

    python3 test/test_sdkconfig_check.py -v

O gate roda no CI sobre o sdkconfig que o PROPRIO build gerou: se o kconfig
ignorou uma chave escrita no defaults da placa, a opcao nao vale e ninguem
fica sabendo (foi o caso do CONFIG_LV_USE_BTNMATRIX do LVGL 8 sobrevivendo ao
LVGL 9). Estes testes fixam a distincao entre chave morta da PLACA (erro) e
do defaults da RAIZ (aviso: carrega opcoes de todas as placas).
"""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import sdkconfig_check as S  # noqa: E402


class Tree:
    """Arvore minima de um build dir, montada num tmp."""

    def __init__(self, board="cyd", root_defaults="CONFIG_A=y\n",
                 board_defaults="", generated=None, touch_order=True):
        self._td = tempfile.TemporaryDirectory()
        self.root = Path(self._td.name)
        (self.root / "boards" / board).mkdir(parents=True)
        (self.root / "sdkconfig.defaults").write_text(root_defaults)
        (self.root / "boards" / board / "sdkconfig.defaults").write_text(
            board_defaults or f'CONFIG_CELEROS_SDKCONFIG_BOARD="{board}"\n')
        self.build = self.root / "build"
        self.build.mkdir()
        (self.build / "CMakeCache.txt").write_text(
            f"CELEROS_BOARD:STRING={board}\n")
        gen = generated if generated is not None else \
            'CONFIG_A=y\nCONFIG_CELEROS_SDKCONFIG_BOARD="%s"\n' % board
        (self.build / "sdkconfig").write_text(gen)

    def close(self):
        self._td.cleanup()


class CheckTest(unittest.TestCase):
    def setUp(self):
        self._orig = S.ROOT

    def tearDown(self):
        S.ROOT = self._orig

    def run_check(self, tree):
        S.ROOT = tree.root
        return S.check(tree.build)

    def test_sem_build_configurado(self):
        t = Tree()
        try:
            (t.build / "CMakeCache.txt").unlink()
            self.assertIsNone(self.run_check(t))
        finally:
            t.close()

    def test_sem_sdkconfig_gerado(self):
        t = Tree()
        try:
            (t.build / "sdkconfig").unlink()
            self.assertIsNone(self.run_check(t))
        finally:
            t.close()

    def test_ok(self):
        t = Tree()
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            self.assertEqual(board, "cyd")
            self.assertEqual(diffs, [])
            self.assertEqual(dead, [])
            self.assertEqual(stamp, "cyd")
        finally:
            t.close()

    def test_chave_morta_da_placa(self):
        # escrito no defaults DA PLACA, inexistente no kconfig gerado
        t = Tree(board_defaults='CONFIG_CELEROS_SDKCONFIG_BOARD="cyd"\n'
                                "CONFIG_LV_USE_BTNMATRIX=y\n")
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            self.assertEqual(dead, ["CONFIG_LV_USE_BTNMATRIX"])
            self.assertEqual(unknown, [])
        finally:
            t.close()

    def test_n_da_placa_de_simbolo_inexistente_e_aviso(self):
        # "# CONFIG_X is not set" de simbolo que nao existe e sujeira: nao
        # pode reprovar o CI de todas as placas
        t = Tree(board_defaults='CONFIG_CELEROS_SDKCONFIG_BOARD="cyd"\n'
                                "# CONFIG_FANTASMA is not set\n")
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            self.assertEqual(dead, [])
            self.assertEqual(unknown, ["CONFIG_FANTASMA"])
        finally:
            t.close()

    def test_valor_da_placa_de_simbolo_inexistente_reprova(self):
        t = Tree(board_defaults='CONFIG_CELEROS_SDKCONFIG_BOARD="cyd"\n'
                                'CONFIG_STR_QUE_NAO_EXISTE="x"\n')
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            self.assertEqual(dead, ["CONFIG_STR_QUE_NAO_EXISTE"])
        finally:
            t.close()

    def test_chave_desconhecida_da_raiz_e_aviso(self):
        # o defaults da raiz carrega opcoes de todas as placas: uma que este
        # alvo nao conhece e esperada
        t = Tree(root_defaults="CONFIG_A=y\nCONFIG_SO_DA_S3=y\n")
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            self.assertEqual(unknown, ["CONFIG_SO_DA_S3"])
            self.assertEqual(dead, [])
        finally:
            t.close()

    def test_valor_divergente(self):
        t = Tree(root_defaults="CONFIG_A=n\n",
                 generated='CONFIG_A=y\nCONFIG_CELEROS_SDKCONFIG_BOARD="cyd"\n')
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            self.assertEqual(diffs, [("CONFIG_A", "n", "y")])
        finally:
            t.close()

    def test_carimbo_de_outra_placa(self):
        t = Tree(generated='CONFIG_A=y\nCONFIG_CELEROS_SDKCONFIG_BOARD="smartdisplay"\n')
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            self.assertEqual(stamp, "smartdisplay")
        finally:
            t.close()

    def test_sem_carimbo(self):
        t = Tree(generated="CONFIG_A=y\n")
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            self.assertIsNone(stamp)
        finally:
            t.close()

    def test_a_placa_vence_a_raiz(self):
        t = Tree(root_defaults="CONFIG_A=y\nCONFIG_B=y\n",
                 board_defaults='CONFIG_CELEROS_SDKCONFIG_BOARD="cyd"\nCONFIG_B=n\n',
                 generated='CONFIG_A=y\nCONFIG_B=n\nCONFIG_CELEROS_SDKCONFIG_BOARD="cyd"\n')
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            self.assertEqual(diffs, [], "a placa sobrescreve a raiz: sem divergencia")
        finally:
            t.close()

    def test_o_carimbo_nao_e_comparado_como_chave(self):
        # o STAMP tem diagnostico proprio: nao pode aparecer em diffs/unknown
        t = Tree()
        try:
            board, diffs, unknown, stamp, dead = self.run_check(t)
            chaves = [k for k, _, _ in diffs] + unknown + dead
            self.assertNotIn(S.STAMP, chaves)
        finally:
            t.close()


class MainExitTest(unittest.TestCase):
    """O codigo de saida e o gate do CI: chave morta tem que sair 1."""

    def setUp(self):
        self._orig = S.ROOT

    def tearDown(self):
        S.ROOT = self._orig

    def test_sai_1_com_chave_morta(self):
        t = Tree(board_defaults='CONFIG_CELEROS_SDKCONFIG_BOARD="cyd"\n'
                                "CONFIG_NAO_EXISTE_Q3=y\n")
        try:
            S.ROOT = t.root
            import contextlib
            import io
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                code = S.main([str(t.build)])
            self.assertEqual(code, 1)
            self.assertIn("CHAVE MORTA", buf.getvalue())
            self.assertIn("CONFIG_NAO_EXISTE_Q3", buf.getvalue())
        finally:
            t.close()

    def test_sai_0_quando_ok(self):
        t = Tree()
        try:
            S.ROOT = t.root
            import contextlib
            import io
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(S.main([str(t.build)]), 0)
        finally:
            t.close()


class ParseTest(unittest.TestCase):
    def test_parse_is_not_set(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "sdkconfig"
            p.write_text("CONFIG_A=y\n# CONFIG_B is not set\n")
            got = S.parse(p)
        self.assertEqual(got, {"CONFIG_A": "y", "CONFIG_B": "n"})

    def test_parse_aspas(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "sdkconfig"
            p.write_text('CONFIG_S="valor"\n')
            got = S.parse(p)
        self.assertEqual(S.unquote(got["CONFIG_S"]), "valor")


if __name__ == "__main__":
    unittest.main()
