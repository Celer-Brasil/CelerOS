#!/usr/bin/env python3
"""Testes do celerhub.py (lado host, sem rede): leitor de versao das deps,
relatorio de drift repo x hub, pre-flight do publish-dep e o teto de
compile contado pelo tamanho ENXUTO.

    python3 -m unittest test.test_celerhub -v
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_arquivo_ignorado_conta_como_suja(self):
        # arquivo do pacote escondido pelo .gitignore NUNCA sera commitado:
        # publica-lo e subir WIP disfarcado — a guarda tem que ve-lo
        td, f = self._repo()
        (Path(td) / ".gitignore").write_text("celeros.secreto.js\n", encoding="utf-8")
        secreto = Path(td) / "celeros.secreto.js"
        secreto.write_text("var S = { version: '1.0.0' };\nmodule.exports = S;\n",
                           encoding="utf-8")
        suja = H.git_dirty_files([secreto])
        self.assertEqual(len(suja), 1, "ignorado deve contar como suja")
        self.assertIn("celeros.secreto.js", suja[0])

    def test_deps_status_sem_head_pede_commit_nao_force(self):
        # engine NOVA (nunca commitada) divergindo do hub: o remedio e
        # commitar — o veredito "--force" subiria o nao-commitado
        import shutil
        from types import SimpleNamespace
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td, ignore_errors=True)
        eng = Path(td) / "engine"
        eng.mkdir()
        # repo git COM commit anterior (a guarda de arvore nao interfere:
        # deps-status nao guarda, apenas TRIA) — arquivo novo fica sem HEAD
        for cmd in (["git", "-C", td, "init", "-q"],
                    ["git", "-C", td, "config", "user.email", "t@t"],
                    ["git", "-C", td, "config", "user.name", "t"],
                    ["git", "-C", td, "commit", "-q", "--allow-empty", "-m", "x"]):
            subprocess.run(cmd, check=True, capture_output=True)
        (eng / "celeros.wip.js").write_text(
            "var W = { version: '1.0.0' };\nmodule.exports = W;\n", encoding="utf-8")
        idx = Path(td) / "deps.json"
        idx.write_text(json.dumps({"deps": {"celeros.wip": {
            "1.0.0": {"md5": "md5-que-nao-bate", "url": "x"}}}}), encoding="utf-8")
        args = SimpleNamespace(index=str(idx), engine_dir=str(eng), hub=None)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as cm:
                H.cmd_deps_status(args)
        self.assertEqual(cm.exception.code, 1)
        self.assertIn("WIP NAO COMMITADO", out.getvalue())
        self.assertIn("commite", out.getvalue())

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


class TestPublishSnapshot(unittest.TestCase):
    """O publish real (nao-dry) empacota o SNAPSHOT lido ANTES da guarda de
    arvore suja: valida + sobe o mesmo zip mesmo que a arvore ande depois
    (http stubado; token falso no env)."""

    def _app_repo(self):
        import shutil
        import zipfile as zf
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td, ignore_errors=True)
        for cmd in (["git", "-C", td, "init", "-q"],
                    ["git", "-C", td, "config", "user.email", "t@t"],
                    ["git", "-C", td, "config", "user.name", "t"]):
            subprocess.run(cmd, check=True, capture_output=True)
        d = Path(td) / "Snap"
        d.mkdir()
        (d / "app.json").write_text(
            '{"name":"Snap","packageName":"celeros.snap","version":"1.0.0",'
            '"api":30,"author":"t","description":"d"}', encoding="utf-8")
        (d / "main.js").write_text("var A = 1;\nSystem.delay(10);\n", encoding="utf-8")
        subprocess.run(["git", "-C", td, "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", td, "commit", "-qm", "x"], check=True,
                       capture_output=True)
        return d

    def test_zip_sai_do_snapshot_nao_da_arvore_viva(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        d = self._app_repo()
        zips = []

        def fake_http(method, url, token=None, data=None, headers=None, timeout=30):
            if method == "GET":
                return 200, {"apps": {}, "deps": {}}
            # POST: guarda o zip e responde como o hub
            assert data is not None
            zips.append(data)
            return 200, {"package": "celeros.snap", "version": "1.0.0",
                         "size": 1, "md5": "x", "store": {"apps": 1}}

        args = SimpleNamespace(dry=False, force=False, folders=[str(d)],
                               no_strip=False, token="t", hub=None)
        with patch.dict(os.environ, {"CELER_HUB_TOKEN": "fake"}):
            with patch.object(H, "http", side_effect=fake_http):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    with self.assertRaises(SystemExit) as cm:
                        H.cmd_publish(args)
        self.assertEqual(cm.exception.code, 0)
        self.assertTrue(zips, "o POST deveria levar o zip")
        # a arvore ANDA depois do upload ter saido: irrelevante, o zip ja era
        import zipfile
        with tempfile.TemporaryDirectory() as tdz:
            zp = Path(tdz) / "a.zip"
            zp.write_bytes(zips[0])
            with zipfile.ZipFile(zp) as zf:
                nomes = sorted(zf.namelist())
                self.assertEqual(nomes, ["app.json", "main.js"])
                main = zf.read("main.js")
        # main.js sobe ENXUTO (jsmin: espaco minimo entre tokens, quebras de
        # linha preservadas para o "line N" do Duktape continuar valendo)
        self.assertIn(b"var A=1;", main)
        # e o conteudo e o do snapshot: mudar a arvore AGORA nao muda nada
        (d / "main.js").write_text("MUDOU DEPOIS\n", encoding="utf-8")
        self.assertIn(b"var A=1;", main)


class TestPublishPrivate(unittest.TestCase):
    """--private/--tenant injetam visibility/tenant na COPIA que sobe (o
    app.json do repo continua publico) e --tenant sem --private morre."""

    def _app_repo(self):
        import shutil
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td, ignore_errors=True)
        for cmd in (["git", "-C", td, "init", "-q"],
                    ["git", "-C", td, "config", "user.email", "t@t"],
                    ["git", "-C", td, "config", "user.name", "t"]):
            subprocess.run(cmd, check=True, capture_output=True)
        d = Path(td) / "Priv"
        d.mkdir()
        (d / "app.json").write_text(
            '{"name":"Priv","packageName":"celeros.priv","version":"1.0.0",'
            '"api":30,"author":"t","description":"d"}', encoding="utf-8")
        (d / "main.js").write_text("var P = 1;\n", encoding="utf-8")
        subprocess.run(["git", "-C", td, "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", td, "commit", "-qm", "x"], check=True,
                       capture_output=True)
        return d

    def _zip_in_body(self, body: bytes) -> bytes:
        import zipfile  # noqa: F401
        start = body.find(b"PK\x03\x04")
        eocd = body.rfind(b"PK\x05\x06")
        self.assertTrue(start >= 0 and eocd > start, "zip nao encontrado no multipart")
        return body[start:eocd + 22]

    def _publish(self, d, hub_version="0.14.1", **kw):
        from types import SimpleNamespace
        from unittest.mock import patch
        corpos = []

        def fake_http(method, url, token=None, data=None, headers=None, timeout=30):
            if method == "GET":
                if "/api/info" in url:
                    return 200, {"version": hub_version}
                return 200, {"apps": {}, "deps": {}}
            corpos.append(data)
            return 200, {"package": "celeros.priv", "version": "1.0.0",
                         "size": 1, "md5": "x", "store": {"apps": 1}}

        args = SimpleNamespace(dry=False, force=False, folders=[str(d)],
                               no_strip=False, token="t", hub=None, **kw)
        with patch.dict(os.environ, {"CELER_HUB_TOKEN": "fake"}):
            with patch.object(H, "http", side_effect=fake_http):
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as cm:
                        H.cmd_publish(args)
        self.assertEqual(cm.exception.code, 0)
        self.assertTrue(corpos, "o POST deveria levar o zip")
        return self._zip_in_body(corpos[0])

    def test_private_injeta_visibility_e_tenant(self):
        import zipfile
        d = self._app_repo()
        blob = self._publish(d, private=True, tenant="vertical1")
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            doc = json.loads(zf.read("app.json"))
        self.assertEqual(doc.get("visibility"), "private")
        self.assertEqual(doc.get("tenant"), "vertical1")
        # o arquivo versionado NAO muda (o repo publico nao leva visibilidade)
        self.assertNotIn("visibility", (d / "app.json").read_text())
        self.assertNotIn("tenant", (d / "app.json").read_text())

    def test_publico_nao_injeta(self):
        import zipfile
        d = self._app_repo()
        blob = self._publish(d, private=False, tenant="")
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            doc = json.loads(zf.read("app.json"))
        self.assertNotIn("visibility", doc)
        self.assertNotIn("tenant", doc)

    def test_tenant_sem_private_morre(self):
        from types import SimpleNamespace
        d = self._app_repo()
        args = SimpleNamespace(dry=False, force=False, folders=[str(d)],
                               no_strip=False, token="t", hub=None,
                               private=False, tenant="vertical1")
        msg = die_saida(lambda: H.cmd_publish(args))
        self.assertIn("--tenant exige --private", msg)

    def test_hub_antigo_recusa_private(self):
        # hub < 0.14 ignora o campo e publicaria o pacote como publico
        from types import SimpleNamespace
        from unittest.mock import patch
        d = self._app_repo()

        def fake_http(method, url, token=None, data=None, headers=None, timeout=30):
            return 200, ({"version": "0.13.0"} if "/api/info" in url
                         else {"apps": {}, "deps": {}})

        args = SimpleNamespace(dry=False, force=False, folders=[str(d)],
                               no_strip=False, token="t", hub=None,
                               private=True, tenant="vertical1")
        with patch.dict(os.environ, {"CELER_HUB_TOKEN": "fake"}):
            with patch.object(H, "http", side_effect=fake_http):
                msg = die_saida(lambda: H.cmd_publish(args))
        self.assertIn("nao suporta app privado", msg)

    def test_publish_dep_tenant_sem_private_morre(self):
        from types import SimpleNamespace
        args = SimpleNamespace(file="qualquer.js", dry=True, private=False,
                               tenant="vertical1")
        msg = die_saida(lambda: H.cmd_publish_dep(args))
        self.assertIn("--tenant exige --private", msg)


class TestPublishHostil(unittest.TestCase):
    """Estados hostis do publish offline: app.json trocado no meio, nome de
    arquivo/armadilha de versao, deps ciclicas no fecho."""

    def _app(self, td, version="1.0.0", extra=None):
        d = Path(td) / "App"
        d.mkdir()
        (d / "app.json").write_text(
            '{"name":"App","packageName":"celeros.app","version":"%s",'
            '"api":30,"author":"t","description":"d","permissions":["fs"]}' % version,
            encoding="utf-8")
        (d / "main.js").write_text("System.delay(1);\n", encoding="utf-8")
        for nome, conteudo in (extra or {}).items():
            (d / nome).write_text(conteudo, encoding="utf-8")
        return d

    def _publish_dry(self, d, validate_hook=None):
        from types import SimpleNamespace
        orig = H.validate
        if validate_hook:
            def com_hook(folder, strip=True, snapshot=None):
                return validate_hook(folder, strip=strip, snapshot=snapshot) or \
                    orig(folder, strip=strip, snapshot=snapshot)
            H.validate = com_hook
        try:
            args = SimpleNamespace(dry=True, force=False, folders=[str(d)],
                                   no_strip=False, hub=None, token=None)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                H.cmd_publish(args)
            return out.getvalue()
        finally:
            H.validate = orig

    def test_appjson_mutado_no_meio_do_publish_morre(self):
        # bancada em voo: o app.json e trocado DEPOIS da leitura do snapshot
        # e ANTES do zip — o publish tem que abortar, nao validar um e subir
        # o outro (era exatamente o buraco que o snapshot fechou pela metade)
        with tempfile.TemporaryDirectory() as td:
            d = self._app(td)

            def mutando(folder, strip=True, snapshot=None):
                (Path(folder) / "app.json").write_text(
                    '{"name":"App","packageName":"celeros.roubo","version":"9.9.9",'
                    '"api":30,"author":"t","description":"d"}', encoding="utf-8")
            msg = die_saida(lambda: self._publish_dry(d, validate_hook=mutando))
            self.assertIn("mudaram durante o publish", msg)

    def test_validate_consome_o_snapshot_nao_o_disco(self):
        # meta e teto saem dos bytes do snapshot: disco valido com snapshot
        # invalido tem que morrer no snapshot (packageName com espaco)
        with tempfile.TemporaryDirectory() as td:
            d = self._app(td)
            outro = json.dumps({"name": "App", "packageName": "celeros ruim",
                                "version": "1.0.0", "api": 30, "author": "t",
                                "description": "d"}).encode()
            msg = die_saida(lambda: H.validate(
                d, strip=True, snapshot={"app.json": outro, "main.js": b"System.delay(1);\n"}))
            self.assertIn("packageName invalido", msg)  # o snapshot venceu

    def test_teto_conta_o_main_do_snapshot(self):
        # main.js gordo no disco, magro no snapshot: a soma do teto e a do
        # conteudo que sobe (e o verify de mutacao cobre o resto)
        with tempfile.TemporaryDirectory() as td:
            d = self._app(td)
            gordo = ("// " + "x" * 96 + "\n") * 700 + "System.delay(100);\n"
            (d / "main.js").write_text(gordo, encoding="utf-8")
            _, _, js_sum_snap, _ = H.validate(
                d, strip=True, snapshot={"app.json": (d / "app.json").read_bytes(),
                                         "main.js": b"System.delay(1);\n"})
            _, _, js_sum_disco, _ = H.validate(d, strip=True)
            self.assertLess(js_sum_snap, 100)
            self.assertGreater(js_sum_disco, 500)  # jsstrip preserva as quebras

    def test_zip_com_nome_de_arquivo_estranho_morre(self):
        # \n no nome passava pela ancora "$" do FILE_NAME_RE e ia para o zip
        with tempfile.TemporaryDirectory() as td:
            d = self._app(td, extra={"x\n.png": "\x89PNG"})
            msg = die_saida(lambda: H.validate(d, strip=True))
            self.assertIn("arquivo extra invalido", msg)

    def test_versao_com_newline_morre(self):
        # "1.0.0\n" (via \u000a no JSON) passava no VER_RE: "$" casa antes
        # do \n final; com \Z morre no semver
        with tempfile.TemporaryDirectory() as td:
            d = self._app(td, version="1.0.0\\u000a")
            msg = die_saida(lambda: H.validate(d, strip=True))
            self.assertIn("semver", msg)

    def test_deps_ciclicas_resolvem(self):
        # A depende de B e B de A: o fecho tem que devolver o par, nao pendurar
        hub = {"celeros.a": {"1.0.0": {"deps": {"celeros.b": "^1.0.0"}}},
               "celeros.b": {"1.0.0": {"deps": {"celeros.a": "^1.0.0"}}}}
        picks = H.resolve_dep_ranges({"celeros.a": "^1.0.0"}, hub)
        self.assertEqual(picks, {"celeros.a": "1.0.0", "celeros.b": "1.0.0"})

    def test_deps_em_briga_morrem_sem_pendurar(self):
        # major em conflito sem versao que satisfaça os dois caminhos
        hub = {"celeros.a": {"1.0.0": {"deps": {"celeros.b": "^1.0.0"}},
                             "2.0.0": {"deps": {"celeros.b": "^2.0.0"}}},
               "celeros.b": {"1.0.0": {}, "2.0.0": {}}}
        with self.assertRaises(SystemExit):
            H.resolve_dep_ranges({"celeros.a": "^1.0.0", "celeros.b": "^2.0.0"}, hub)

    def test_diamante_de_deps_pega_o_maior_comum(self):
        # app -> (A ^1, B ^1); A 1.0 -> C ^1.2; B 1.0 -> C ^1.4: C fica 1.9
        hub = {"celeros.a": {"1.0.0": {"deps": {"celeros.c": "^1.2.0"}}},
               "celeros.b": {"1.0.0": {"deps": {"celeros.c": "^1.4.0"}}},
               "celeros.c": {"1.2.0": {}, "1.4.0": {}, "1.9.0": {}, "2.0.0": {}}}
        picks = H.resolve_dep_ranges({"celeros.a": "^1.0.0", "celeros.b": "^1.0.0"}, hub)
        self.assertEqual(picks["celeros.c"], "1.9.0")


class TestIconAviso(unittest.TestCase):
    """App que declara `icon` usa o icone do SISTEMA (data/icons/<id>.png):
    nao ter icon.png no pacote e o contrato, nao um aviso. O WiFi e os
    CelerPark caiam no aviso "sem icon.png" a cada publish."""

    def _app(self, extra=None):
        td = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, td, ignore_errors=True)
        d = Path(td) / "App"
        d.mkdir()
        meta = {"name": "App", "packageName": "celeros.app", "version": "1.0.0",
                "api": 30, "author": "t", "description": "d"}
        meta.update(extra or {})
        (d / "app.json").write_text(json.dumps(meta), encoding="utf-8")
        (d / "main.js").write_text("var a = 1;\n", encoding="utf-8")
        return d

    def test_icon_do_sistema_nao_avisa(self):
        _, avisos, _, _ = H.validate(self._app({"icon": "wifi_on"}))
        self.assertFalse([a for a in avisos if "sem icon.png" in a], avisos)

    def test_sem_icon_nem_icone_do_sistema_avisa(self):
        _, avisos, _, _ = H.validate(self._app())
        self.assertTrue([a for a in avisos if "sem icon.png" in a], avisos)


class TestListPrivados(unittest.TestCase):
    """`celerhub list` com token mostra os apps privados (marcados): antes o
    catalogo era lido sem credencial e a vertical ficava invisivel mesmo
    depois do publish --private."""

    def _run(self, token):
        from types import SimpleNamespace
        publico = {"apps": {"celeros.a": {"version": "1.0.0", "api": 30,
                                          "size": 2048, "category": "Utility"}}}
        com_token = {"apps": dict(publico["apps"], **{
            "celeros.segredo": {"version": "2.0.0", "api": 30, "size": 2048,
                                "category": "System"}})}

        def fake_http(method, url, token=None, data=None, headers=None, timeout=30):
            if url.endswith("/store/index.json"):
                return 200, {"categories": {}}
            if url.endswith("/store/all.json"):
                return 200, (com_token if token else publico)
            if url.endswith("/api/info"):
                return 200, {"downloads": {}}
            raise AssertionError("url inesperada: " + url)

        args = SimpleNamespace(token=token, hub="https://hub.teste")
        out = io.StringIO()
        with patch.object(H, "http", side_effect=fake_http), \
                patch.object(H, "local_packages", return_value={}), \
                contextlib.redirect_stdout(out):
            H.cmd_list(args)
        return out.getvalue()

    def test_sem_token_nao_lista_privado(self):
        texto = self._run(None)
        self.assertIn("celeros.a", texto)
        self.assertNotIn("celeros.segredo", texto)

    def test_com_token_lista_e_marca_privado(self):
        texto = self._run("tk")
        self.assertIn("celeros.segredo", texto)
        self.assertIn("1 privado(s) visiveis", texto)
        for linha in texto.splitlines():
            if "celeros.segredo" in linha:
                self.assertIn("privado", linha)
                break
        else:
            self.fail("linha do app privado ausente")


if __name__ == "__main__":
    unittest.main()
