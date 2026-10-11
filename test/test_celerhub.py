#!/usr/bin/env python3
"""Testes do celerhub.py (lado host, sem rede): leitor de versao das deps,
relatorio de drift repo x hub, pre-flight do publish-dep e o teto de
compile contado pelo tamanho ENXUTO.

    python3 -m unittest test.test_celerhub -v
"""

import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import celerhub as H  # noqa: E402


def die_saida(fn):
    """Roda fn esperando o SystemExit do die(); devolve a mensagem (stderr)."""
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            fn()
        except SystemExit:
            return err.getvalue()
    raise AssertionError("esperava SystemExit (die)")


class TestReadDepVersion(unittest.TestCase):
    def test_aspas_simples_e_duplas(self):
        self.assertEqual(H.read_dep_version("var E = { version: '1.2.3' };"), "1.2.3")
        self.assertEqual(H.read_dep_version('var E = { version: "1.2.3" };'), "1.2.3")

    def test_sem_versao_morre(self):
        with self.assertRaises(SystemExit):
            H.read_dep_version("var E = {};")

    def test_versoes_distintas_morre(self):
        # antes: a primeira `version: '...'` vencia calada
        msg = die_saida(lambda: H.read_dep_version(
            "var a = { version: '1.0.0' }; var E = { version: '1.2.3' };"))
        self.assertIn("distintas", msg)

    def test_repetida_igual_passa(self):
        src = "// version: '1.2.3' no comentario\nvar E = { version: '1.2.3' };"
        self.assertEqual(H.read_dep_version(src), "1.2.3")


class TestDepsStatusReport(unittest.TestCase):
    def test_vereditos(self):
        local = {"celeros.engine": "1.2.2", "celeros.physics": "1.4.0",
                 "celeros.nova": "0.1.0", "celeros.sfx": "1.0.1"}
        hub = {"celeros.engine": {"1.1.0": {}, "1.2.0": {}, "1.2.1": {}},
               "celeros.physics": {"1.4.0": {}, "1.5.0": {}},
               "celeros.sfx": {"1.0.1": {}},
               "celeros.antiga": {"2.0.0": {}}}
        linhas, drift = H.deps_status_report(local, hub)
        texto = "\n".join(linhas)
        self.assertEqual(drift, 3)  # engine + physics + nova
        self.assertIn("celeros.engine         1.2.2    1.2.1    REPO NAO PUBLICADO", texto)
        self.assertIn("celeros.physics        1.4.0    1.5.0    REPO ATRASADO", texto)
        self.assertIn("celeros.nova           0.1.0    -        NAO PUBLICADA", texto)
        self.assertIn("celeros.sfx            1.0.1    1.0.1    ok", texto)
        self.assertIn("celeros.antiga         -        2.0.0    sem fonte local", texto)

    def test_conteudo_diverge(self):
        local = {"celeros.engine": "1.2.2"}
        hub = {"celeros.engine": {"1.2.2": {"md5": "abc"}}}
        linhas, drift = H.deps_status_report(local, hub, divergent={"celeros.engine"})
        self.assertEqual(drift, 1)
        self.assertIn("CONTEUDO DIVERGE", "\n".join(linhas))

    def test_tudo_ok_zero_drift(self):
        local = {"celeros.engine": "1.2.2"}
        hub = {"celeros.engine": {"1.2.2": {"md5": "x"}}}
        _, drift = H.deps_status_report(local, hub)
        self.assertEqual(drift, 0)


class TestPublishDepPreflight(unittest.TestCase):
    """O pre-flight de mesma-versao morre com a receita, nao com o 409."""

    def _mod(self, td, versao="1.2.3", corpo=None):
        p = Path(td) / "celeros.teste.js"
        p.write_text(corpo or f"var T = {{ version: '{versao}' }};\nmodule.exports = T;\n",
                     encoding="utf-8")
        return p

    def test_dry_roda_offline(self):
        with tempfile.TemporaryDirectory() as td:
            p = self._mod(td)
            args = H.argparse.Namespace(
                dry=True, force=False, file=str(p), name=None, version=None,
                min_api=1, dep=None, no_strip=False, hub=None, token=None)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                H.cmd_publish_dep(args)
            self.assertIn("[dry] dep celeros.teste v1.2.3", out.getvalue())
            self.assertIn("md5", out.getvalue())

    def test_versao_ambigua_morre_antes_do_upload(self):
        with tempfile.TemporaryDirectory() as td:
            p = self._mod(td, corpo="var a = { version: '9.9.9' };\n"
                                    "var T = { version: '1.2.3' };\nmodule.exports = T;\n")
            args = H.argparse.Namespace(
                dry=True, force=False, file=str(p), name=None, version=None,
                min_api=1, dep=None, no_strip=False, hub=None, token=None)
            with self.assertRaises(SystemExit):
                H.cmd_publish_dep(args)

    def test_sintaxe_invalida_morre(self):
        with tempfile.TemporaryDirectory() as td:
            p = self._mod(td, corpo="var T = { version: '1.2.3' }}};\nmodule.exports = T;\n")
            args = H.argparse.Namespace(
                dry=True, force=False, file=str(p), name=None, version=None,
                min_api=1, dep=None, no_strip=False, hub=None, token=None)
            msg = die_saida(lambda: H.cmd_publish_dep(args))
            self.assertIn("sintaxe invalida", msg)


class TestTetoPosStrip(unittest.TestCase):
    """A soma do teto conta o ENXUTO: main.js gordo de comentarios que
    enxuga abaixo do teto passa (antes morria com mensagem errada antes do
    strip rodar)."""

    def _app(self, td, api=30, requires=None):
        d = Path(td) / "Gordo"
        d.mkdir()
        (d / "app.json").write_text(
            '{"name":"Gordo","packageName":"celeros.gordo","version":"1.0.0",'
            '"api":%d,"author":"t","description":"d","permissions":["fs"]%s}' %
            (api, ',"requires":["psram"]' if requires else ""), encoding="utf-8")
        # ~70KB crus de comentario + uma linha de codigo (enxuga a ~30B)
        corpo = ("// " + "x" * 96 + "\n") * 700 + "System.delay(100);\n"
        (d / "main.js").write_text(corpo, encoding="utf-8")
        return d

    def test_cru_gordo_enxuto_magro_passa(self):
        with tempfile.TemporaryDirectory() as td:
            d = self._app(td)
            meta, avisos, js_sum, extras = H.validate(d, strip=True)
            cru = (d / "main.js").stat().st_size
            self.assertGreater(cru, H.MAX_MAIN_JS)          # ~70KB cru
            self.assertLess(js_sum, H.MAX_MAIN_JS)          # enxuto passa
            self.assertEqual(meta["packageName"], "celeros.gordo")

    def test_sem_strip_o_mesmo_app_morre(self):
        with tempfile.TemporaryDirectory() as td:
            d = self._app(td)
            msg = die_saida(lambda: H.validate(d, strip=False))
            self.assertIn("psram", msg)


class TestGitDirtyGuard(unittest.TestCase):
    """A guarda de arvore suja do publish: o upload tem que ser de conteudo
    COMMITADO. Nasceu do incidente real da engine 1.2.3 no hub com 2 linhas
    do WIP do autor (salvas na arvore entre o git status do operador e o
    upload — a arvore anda em voo na bancada)."""

    def _repo(self):
        import shutil
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td, ignore_errors=True)
        for cmd in (["git", "-C", td, "init", "-q"],
                    ["git", "-C", td, "config", "user.email", "t@t"],
                    ["git", "-C", td, "config", "user.name", "t"]):
            subprocess.run(cmd, check=True, capture_output=True)
        f = Path(td) / "celeros.mod.js"
        f.write_text("var M = { version: '1.0.0' };\nmodule.exports = M;\n",
                     encoding="utf-8")
        subprocess.run(["git", "-C", td, "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", td, "commit", "-qm", "x"], check=True,
                       capture_output=True)
        return td, f

    def test_limpo_vazio(self):
        _, f = self._repo()
        self.assertEqual(H.git_dirty_files([f]), [])

    def test_modificado_aparece(self):
        _, f = self._repo()
        f.write_text("var M = { version: '1.1.0' };\nmodule.exports = M;\n",
                     encoding="utf-8")
        suja = H.git_dirty_files([f])
        self.assertEqual(len(suja), 1)
        self.assertIn("celeros.mod.js", suja[0])

    def test_novo_arquivo_aparece(self):
        td, _ = self._repo()
        novo = Path(td) / "celeros.novo.js"
        novo.write_text("x = 1;\n", encoding="utf-8")
        suja = H.git_dirty_files([novo])
        self.assertEqual(len(suja), 1)
        self.assertIn("celeros.novo.js", suja[0])

    def test_fora_de_repo_nao_trava(self):
        f = Path(tempfile.mkdtemp()) / "solto.js"
        f.write_text("x", encoding="utf-8")
        self.assertEqual(H.git_dirty_files([f]), [])

    def test_publish_dep_recusa_wip_e_dry_avisa(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        _, f = self._repo()
        f.write_text("var M = { version: '1.1.0' };\nmodule.exports = M;\n",
                     encoding="utf-8")
        base = dict(file=str(f), name=None, version=None, min_api=1,
                    dep=None, no_strip=False, token=None, hub=None)
        # real (sem --dry): morre com a receita ANTES de tocar a rede (token
        # de mentira no env so para passar do token_or_die)
        with patch.dict(os.environ, {"CELER_HUB_TOKEN": "fake"}):
            msg = die_saida(lambda: H.cmd_publish_dep(SimpleNamespace(
                dry=False, force=False, **base)))
        self.assertIn("NAO commitada", msg)
        self.assertIn("--force", msg)
        # dry: aviso, nao trava (explorar WIP offline continua valido)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            H.cmd_publish_dep(SimpleNamespace(dry=True, force=False, **base))
        self.assertIn("NAO commitada", out.getvalue())

    def test_deps_status_triage_wip_vs_real(self):
        # mesmo veredito de versao, remedios opostos: WIP pede COMMIT,
        # divergencia real pede --force — o conselho errado custa caro
        local = {"celeros.engine": "1.2.3"}
        hub = {"celeros.engine": {"1.2.3": {"md5": "abc"}}}
        linhas, drift = H.deps_status_report(local, hub,
                                             divergent={"celeros.engine": "wip"})
        texto = "\n".join(linhas)
        self.assertEqual(drift, 1)
        self.assertIn("WIP NAO COMMITADO", texto)
        self.assertIn("commite", texto)
        self.assertNotIn("--force: publish-dep", texto)
        linhas, _ = H.deps_status_report(local, hub,
                                         divergent={"celeros.engine": "real"})
        self.assertIn("CONTEUDO DIVERGE", "\n".join(linhas))
        # set (compat) continua sendo divergencia real
        linhas, _ = H.deps_status_report(local, hub, divergent={"celeros.engine"})
        self.assertIn("CONTEUDO DIVERGE", "\n".join(linhas))


if __name__ == "__main__":
    unittest.main()
