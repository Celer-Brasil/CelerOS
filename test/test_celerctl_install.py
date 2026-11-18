#!/usr/bin/env python3
"""Testes do instalador do celerctl (tools/celerctl_install.py) — host.

    python3 test/test_celerctl_install.py -v

Nao instala nada no PATH real: cada teste monta uma pasta temporaria como
"bin" e um PATH falso. O que importa provar e a escolha do INTERPRETADOR
(um shim apontando para o venv do IDF para de funcionar quando o IDF e
atualizado) e o formato dos shims.
"""

import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import celerctl_install as I  # noqa: E402


class ShimContentTest(unittest.TestCase):
    def test_cmd_repassa_todos_os_argumentos(self):
        txt = I.cmd_shim(r"C:\Python314\python.exe", r"C:\repo\tools\celerctl.py")
        self.assertIn("@echo off", txt)
        # %* preserva a linha inteira (aspas inclusas): refazer a juncao
        # perderia espaco em "C:\meus apps"
        self.assertIn("%*", txt)
        self.assertIn("exit /b %ERRORLEVEL%", txt)
        self.assertIn("celerctl.py", txt)

    def test_cmd_com_caminho_espaçado_entre_aspas(self):
        txt = I.cmd_shim(r"C:\Program Files\Python\python.exe",
                         r"C:\meu repo\tools\celerctl.py")
        self.assertIn('"C:\\Program Files\\Python\\python.exe"', txt)
        self.assertIn('"C:\\meu repo\\tools\\celerctl.py"', txt)

    def test_ps1_espalha_args(self):
        txt = I.ps1_shim(r"C:\Python314\python.exe", r"C:\repo\tools\celerctl.py")
        self.assertIn("@args", txt)
        self.assertIn("$LASTEXITCODE", txt)

    def test_cmd_usa_crlf(self):
        # o cmd.exe engasga com LF puro em alguns casos
        txt = I.cmd_shim("py", "s.py")
        self.assertIn("\r\n", txt)

    def test_shims_fixam_utf8(self):
        # as mensagens sao em portugues; o console do Windows nasce em
        # cp850/cp1252 e sem isto o "-" vira "?" e nome com acento corrompe
        self.assertIn("PYTHONIOENCODING=utf-8", I.cmd_shim("py", "s.py"))
        self.assertIn("PYTHONUTF8=1", I.cmd_shim("py", "s.py"))
        self.assertIn("PYTHONIOENCODING", I.ps1_shim("py", "s.py"))
        self.assertIn("PYTHONUTF8", I.ps1_shim("py", "s.py"))


class PythonChoiceTest(unittest.TestCase):
    def test_env_do_idf_e_instavel(self):
        for p in (r"C:\Users\x\.espressif\python_env\idf6.1_py3.14_env\Scripts\python.exe",
                  r"/home/x/esp/idf/python_env/idf6.1_py3.14_env/bin/python",
                  r"C:\proj\.venv\Scripts\python.exe",
                  r"/home/x/proj/venv/bin/python"):
            self.assertTrue(I._instavel(p), p)

    def test_python_do_sistema_e_estavel(self):
        for p in (r"C:\Python314\python.exe",
                  "/usr/bin/python3",
                  "/usr/local/bin/python3.12"):
            self.assertFalse(I._instavel(p), p)

    def test_prefere_python_estavel_com_pyserial(self):
        instavel = r"C:\Users\x\.espressif\python_env\idf6.1_py3.14_env\Scripts\python.exe"
        estavel = r"C:\Python314\python.exe"
        with patch.object(I.sys, "executable", instavel), \
             patch.object(I.shutil, "which", lambda n: None), \
             patch.object(I, "_has_pyserial", lambda py: py == estavel), \
             patch.object(I.os.path, "isfile", lambda p: p == estavel):
            self.assertEqual(I.python_exe(), estavel)

    def test_sem_candidato_estavel_nao_grava_launcher_py(self):
        # `py.exe` e launcher, nao interpretador: nunca vai para o shim
        with patch.object(I.sys, "executable", r"C:\Python314\python.exe"), \
             patch.object(I.shutil, "which",
                          lambda n: r"C:\WINDOWS\py.exe" if n == "py" else None), \
             patch.object(I, "_has_pyserial",
                          lambda py: not py.lower().endswith("py.exe")), \
             patch.object(I.os.path, "isfile", lambda p: False), \
             patch.object(I.subprocess, "run",
                          lambda *a, **k: type("R", (), {"returncode": 1,
                                                         "stdout": ""})()):
            escolhido = I.python_exe()
        self.assertFalse(escolhido.lower().endswith("py.exe"), escolhido)

    def test_nenhum_com_pyserial_cai_no_que_rodou(self):
        with patch.object(I.sys, "executable", r"C:\Python314\python.exe"), \
             patch.object(I.shutil, "which", lambda n: None), \
             patch.object(I, "_has_pyserial", lambda py: False), \
             patch.object(I.os.path, "isfile", lambda p: False):
            self.assertEqual(I.python_exe(), r"C:\Python314\python.exe")


class PathTest(unittest.TestCase):
    def test_entradas_ignora_vazio(self):
        self.assertEqual(I.path_entries("a;;b;"), ["a", "b"])
        self.assertEqual(I.path_entries(""), [])
        self.assertEqual(I.path_entries(None), [])

    def test_has_entry_ignora_caixa_e_barra_final(self):
        ents = ["C:\\Foo\\bin", "/usr/local/bin"]
        self.assertTrue(I.has_entry(ents, "c:\\foo\\BIN"))
        self.assertTrue(I.has_entry(ents, "C:\\Foo\\bin\\"))
        self.assertFalse(I.has_entry(ents, "C:\\outra"))

    def test_bin_dir_por_sistema(self):
        if os.name == "nt":
            self.assertEqual(I.bin_dir().name, "bin")
            self.assertEqual(I.bin_dir().parent.name, "CelerOS")
        else:
            self.assertEqual(I.bin_dir().name, "bin")


class InstallTest(unittest.TestCase):
    """Instalacao completa numa pasta temporaria (nada toca o PATH real)."""

    def test_instala_e_desinstala(self):
        with tempfile.TemporaryDirectory() as td:
            alvo = Path(td) / "bin"
            with patch.object(I, "bin_dir", lambda: alvo), \
                 patch.object(I, "user_path", lambda: ""), \
                 patch.object(I, "set_user_path", lambda v: True):
                criados, mudou = I.install(quiet=True)
                nomes = {f.name for f in criados}
                self.assertIn("celerctl.cmd", nomes)
                self.assertIn("cctl.cmd", nomes)
                self.assertTrue(mudou)
                # o shim aponta para o SCRIPT deste repo
                txt = (alvo / "celerctl.cmd").read_text(encoding="utf-8")
                self.assertIn("celerctl.py", txt)
                self.assertTrue((alvo / "celerctl.cmd").is_file())
                removidos = I.uninstall(quiet=True)
                self.assertTrue(removidos)
                self.assertFalse((alvo / "celerctl.cmd").exists())

    def test_instalar_duas_vezes_nao_duplica_path(self):
        with tempfile.TemporaryDirectory() as td:
            alvo = Path(td) / "bin"
            guardado = {}

            def fake_set(v):
                guardado["path"] = v
                return True
            with patch.object(I, "bin_dir", lambda: alvo), \
                 patch.object(I, "user_path", lambda: guardado.get("path", "")), \
                 patch.object(I, "set_user_path", fake_set):
                I.install(quiet=True)
                primeiro = guardado["path"]
                criados, mudou = I.install(quiet=True)
                self.assertEqual(guardado["path"], primeiro)
                self.assertFalse(mudou, "a segunda instalacao nao muda o PATH")


class SessionTest(unittest.TestCase):
    """O aviso que faltou na primeira instalacao: PATH gravado, mas o terminal
    atual nao o enxerga (o Windows nao propaga para processos ja abertos)."""

    def test_session_sees_quando_esta_no_path(self):
        with patch.dict(I.os.environ, {"PATH": r"C:\x;C:\Foo\bin"}, clear=False):
            self.assertTrue(I.session_sees(r"C:\FOO\BIN"))
            self.assertFalse(I.session_sees(r"C:\outra"))

    def test_comando_de_refresh_une_usuario_e_maquina(self):
        cmd = I.session_refresh_command()
        # precisa das duas raizes: o PATH do usuario sozinho perderia o que
        # vem da maquina (System32, Program Files...)
        self.assertIn("GetEnvironmentVariable('Path','User')", cmd)
        self.assertIn("GetEnvironmentVariable('Path','Machine')", cmd)
        self.assertTrue(cmd.startswith("$env:PATH"))

    def test_install_avisa_quando_a_sessao_nao_ve(self):
        with tempfile.TemporaryDirectory() as td:
            alvo = Path(td) / "bin"
            with patch.object(I, "bin_dir", lambda: alvo), \
                 patch.object(I, "user_path", lambda: ""), \
                 patch.object(I, "set_user_path", lambda v: True), \
                 patch.dict(I.os.environ, {"PATH": r"C:\so_isto"}, clear=False):
                out = io.StringIO()
                with redirect_stdout(out):
                    I.install()
            texto = out.getvalue()
        self.assertIn("anterior a instalacao", texto)
        self.assertIn("$env:PATH", texto)

    def test_install_com_session_nao_avisa(self):
        with tempfile.TemporaryDirectory() as td:
            alvo = Path(td) / "bin"
            with patch.object(I, "bin_dir", lambda: alvo), \
                 patch.object(I, "user_path", lambda: ""), \
                 patch.object(I, "set_user_path", lambda v: True), \
                 patch.dict(I.os.environ, {"PATH": r"C:\so_isto"}, clear=False):
                out = io.StringIO()
                with redirect_stdout(out):
                    I.install(session=True)
                # --session ja corrigiu esta sessao: nada a avisar
                self.assertIn(str(alvo), os.environ["PATH"])
                texto = out.getvalue()
        self.assertNotIn("anterior a instalacao", texto)

    def test_show_explica_quando_a_sessao_nao_ve(self):
        with tempfile.TemporaryDirectory() as td:
            alvo = Path(td) / "bin"
            with patch.object(I, "bin_dir", lambda: alvo), \
                 patch.object(I, "user_path", lambda: ""), \
                 patch.dict(I.os.environ, {"PATH": r"C:\so_isto"}, clear=False):
                out = io.StringIO()
                with redirect_stdout(out):
                    I.show()
        texto = out.getvalue()
        self.assertIn("PATH desta sessao: NAO", texto)
        self.assertIn("$env:PATH", texto)


class AmbienteLimpoTest(unittest.TestCase):
    """A heranca de PYTHONUSERBASE/IDF_PYTHON_ENV_PATH fazia o instalador
    REJEITAR um Python bom: dentro do shell do IDF o `import serial` falha,
    no terminal limpo do usuario funciona. A validacao tem que usar o
    ambiente que o shim vai encontrar."""

    def test_limpo_remove_todas_as_python(self):
        env = {"PATH": "x", "PYTHONUSERBASE": r"C:\idf", "PYTHONPATH": "y",
               "PYTHONIOENCODING": "utf-8", "HOME": "z"}
        limpo = I._limpo(env)
        self.assertEqual(limpo, {"PATH": "x", "HOME": "z"})

    def test_limpo_mantem_o_resto(self):
        env = {"PATH": "x", "IDF_PATH": "y"}
        self.assertEqual(I._limpo(env), env)

    def test_stub_da_store_e_instavel(self):
        stub = (r"C:\Users\x\AppData\Local\Microsoft\WindowsApps"
                r"\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\python.exe")
        self.assertTrue(I._instavel(stub), "o stub e um redirector, nao um Python")


class MainTest(unittest.TestCase):
    def test_script_inexistente_falha(self):
        with patch.object(I, "SCRIPT", Path("/nao/existe/celerctl.py")), \
             patch("sys.stderr"):
            self.assertEqual(I.main(["--show"]), 1)


if __name__ == "__main__":
    unittest.main()
