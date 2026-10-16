#!/usr/bin/env python3
"""Testes da matilha (tools/matilha) sem radio e sem bleak.

  - bonds: derivacao da chave do bond v2 (golden) e o CLI `link bonds`
  - pair_flow: pareamento por codigo + bond v2 contra um FakeLink
  - o `mesh` antigo (NetFrame v2) saiu na API 41: o PC na malha e o gateway
    (celerctl mesh ...) — so o aviso e coberto aqui

    python3 test/test_matilha.py -v
"""

import asyncio
import contextlib
import hashlib
import os
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools" / "matilha"))
import matilha as M  # noqa: E402


def io(answers):
    it = iter(answers)
    return lambda prompt="": next(it)


class TestMeshSaiu(unittest.TestCase):
    def test_mesh_aponta_para_o_gateway(self):
        err = StringIO()
        with contextlib.redirect_stderr(err):
            rc = M.main(["mesh", "listen"])
        self.assertEqual(rc, 2)
        self.assertIn("celerctl mesh", err.getvalue())


class TestBonds(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._path = Path(self._tmp.name) / "bonds.json"
        self._old = os.environ.get("MATILHA_BONDS")
        os.environ["MATILHA_BONDS"] = str(self._path)

    def tearDown(self):
        if self._old is None:
            os.environ.pop("MATILHA_BONDS", None)
        else:
            os.environ["MATILHA_BONDS"] = self._old
        self._tmp.cleanup()

    def test_derivacao_golden(self):
        chal = bytes(range(1, 9))
        # mesma construcao do CelerLink.cpp: SHA256("CLK2"||codigo||desafio)
        self.assertEqual(M.bond_key_from_code("314159", chal),
                         hashlib.sha256(b"CLK2" + b"314159" + chal).digest()[:16])
        self.assertEqual(M.bond_response(b"\x11" * 16, chal),
                         hashlib.sha256(b"\x11" * 16 + chal).digest()[:8])

    def test_cli_bonds_lista_apaga(self):
        buf = StringIO()
        with contextlib.redirect_stdout(buf):
            rc = M.main(["link", "bonds"])
        self.assertEqual(rc, 0)
        self.assertIn("nenhum bond", buf.getvalue())
        M.save_bonds({"AA:BB:CC:DD:EE:FF": b"\x01" * 16})
        self.assertEqual(M.load_bonds(), {"AA:BB:CC:DD:EE:FF": b"\x01" * 16})
        self.assertEqual(oct(os.stat(self._path).st_mode & 0o777), "0o600")
        buf = StringIO()
        with contextlib.redirect_stdout(buf):
            rc = M.main(["link", "bonds", "--rm", "aa:bb:cc:dd:ee:ff"])
        self.assertEqual(rc, 0)
        self.assertEqual(M.load_bonds(), {})


# ------------------------------------------------------------------ link --

class FakeLink:
    """Char pair do firmware (CelerLink.cpp onPairAccess): read = estado +
    desafio quando WAIT; write de 6 bytes = codigo, 8 bytes = resposta. A
    chave do bond (self.key) nasce do pareamento por codigo e persiste - o
    desafio de CADA conexao e novo, a chave nao."""

    def __init__(self, state=M.PAIR_WAIT, challenge=bytes(range(1, 9)),
                 code="314159", addr="AA:BB:CC:DD:EE:FF", key=None):
        self.addr, self.state, self.chal, self.code = addr, state, challenge, code
        self.key = key
        self.writes = []

    async def pair_read(self):
        return (self.state, self.chal if self.state == M.PAIR_WAIT else None)

    async def pair_write(self, data):
        data = bytes(data)
        self.writes.append(data)
        if self.state == M.PAIR_OK:
            return
        if len(data) == 6:
            if data.decode() == self.code:
                self.state = M.PAIR_OK
                self.key = M.bond_key_from_code(self.code, self.chal)
        elif len(data) == 8 and self.key is not None:
            if data == M.bond_response(self.key, self.chal):
                self.state = M.PAIR_OK


class TestPairFlow(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old = os.environ.get("MATILHA_BONDS")
        os.environ["MATILHA_BONDS"] = str(Path(self._tmp.name) / "bonds.json")

    def tearDown(self):
        if self._old is None:
            os.environ.pop("MATILHA_BONDS", None)
        else:
            os.environ["MATILHA_BONDS"] = self._old
        self._tmp.cleanup()

    def test_codigo_certo_guarda_bond(self):
        async def go():
            lk = FakeLink()
            res = await M.pair_flow(lk, ask=io(["314159"]))
            self.assertEqual(res, "code")
            self.assertEqual(lk.writes, [b"314159"])
            chave = M.load_bonds()["AA:BB:CC:DD:EE:FF"]
            self.assertEqual(chave, M.bond_key_from_code("314159", lk.chal))
        asyncio.run(go())

    def test_bond_reconecta_sem_codigo(self):
        async def go():
            chal1 = bytes(range(1, 9))
            chave = M.bond_key_from_code("314159", chal1)
            M.save_bonds({"AA:BB:CC:DD:EE:FF": chave})
            # desafio NOVO desta conexao (o periferico renova a cada connect),
            # chave do bond igual a guardada na 1a pareamento
            lk = FakeLink(challenge=b"\xAB" * 8, key=chave)
            res = await M.pair_flow(lk, ask=io([]))     # nao pergunta nada
            self.assertEqual(res, "bond")
            self.assertEqual(len(lk.writes), 1)
            self.assertEqual(lk.writes[0],
                             M.bond_response(chave, b"\xAB" * 8))
        asyncio.run(go())

    def test_ja_liberado_e_sem_gate(self):
        async def go():
            lk = FakeLink(state=M.PAIR_OK)
            self.assertEqual(await M.pair_flow(lk, ask=io([])), "ok")
            self.assertEqual(lk.writes, [])
            lk = FakeLink(state=M.PAIR_OPEN)
            self.assertEqual(await M.pair_flow(lk, ask=io([])), "aberto")
        asyncio.run(go())

    def test_codigo_errado_falha(self):
        async def go():
            lk = FakeLink()                              # sem bond guardado
            res = await M.pair_flow(lk, ask=io(["000000"] * 3))
            self.assertEqual(res, "fail")
            self.assertEqual(lk.writes, [b"000000"] * 3)
        asyncio.run(go())

    def test_bond_velho_cai_pro_codigo(self):
        async def go():
            M.save_bonds({"AA:BB:CC:DD:EE:FF": b"\x00" * 16})  # device esqueceu
            lk = FakeLink(key=None)
            res = await M.pair_flow(lk, ask=io(["314159"]))
            self.assertEqual(res, "code")
            # desafio tentado (1 falha) + 2 tentativas de codigo restantes
            self.assertEqual(len(lk.writes), 2)
            self.assertEqual(lk.writes[-1], b"314159")
        asyncio.run(go())


if __name__ == "__main__":
    unittest.main()
