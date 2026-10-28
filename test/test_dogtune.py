#!/usr/bin/env python3
"""Testes do dogtune contra um Celer Link simulado (sem BLE/hardware).

Um FakeLink implementa a mesma interface do BleakLink (pair_state/
write_pair_code/send/read/drain): pareamento por codigo de 6 digitos,
reply do tune e fila de notify. Valida o lado host — a BLE real e bancada.

    python3 test/test_dogtune.py -v
"""

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools" / "dog"))
import dogtune as D  # noqa: E402


class FakeLink:
    def __init__(self):
        self.pair = D.PAIR_WAIT
        self.sent = []
        self.rx = []

    async def pair_state(self):
        return self.pair

    async def write_pair_code(self, code):
        if str(code) == "314159":
            self.pair = D.PAIR_OK

    async def send(self, obj):
        self.sent.append(obj)
        if obj.get("type") == "tune":
            self.rx.append({"type": "tune", "echo": obj})

    async def read(self, timeout=1.0):
        return self.rx.pop(0) if self.rx else None

    async def drain(self, timeout=1.0):
        out, self.rx = self.rx, []
        return out

    async def close(self):
        pass


def io(answers):
    it = iter(answers)
    return lambda prompt="": next(it)


class TestPair(unittest.TestCase):
    def test_codigo_certo_libera(self):
        async def go():
            lk = FakeLink()
            ok = await D.pair_flow(lk, ask=io(["314159"]))
            self.assertTrue(ok)
            self.assertEqual(lk.pair, D.PAIR_OK)
        asyncio.run(go())

    def test_codigo_errado_tres_vezes_nao_libera(self):
        async def go():
            lk = FakeLink()
            ok = await D.pair_flow(lk, ask=io(["000000"] * 3))
            self.assertFalse(ok)
            self.assertEqual(lk.sent, [])
        asyncio.run(go())

    def test_ja_pareado_entra_direto(self):
        async def go():
            lk = FakeLink()
            lk.pair = D.PAIR_OK
            self.assertTrue(await D.pair_flow(lk, ask=io([])))   # nao pergunta
        asyncio.run(go())


class TestPlan(unittest.TestCase):
    def test_default_e_cartesiano(self):
        p = D.build_plan()
        self.assertEqual(len(p), len(D.DEFAULT_LEANS) * len(D.DEFAULT_SPEEDS))
        self.assertEqual(p[0], {"lean": D.DEFAULT_LEANS[0], "speed": D.DEFAULT_SPEEDS[0],
                                "gait": "walk", "walk_ms": 3000})

    def test_custom(self):
        p = D.build_plan(leans=[5], speeds=[80, 90], gait="back", walk_ms=1000)
        self.assertEqual([(c["lean"], c["speed"]) for c in p], [(5, 80), (5, 90)])


class TestScore(unittest.TestCase):
    def test_notas(self):
        for a, want in [("", 0), ("0", 0), ("2", 2), ("3", 3)]:
            self.assertEqual(D.parse_score(a, ask=io([])), want)

    def test_r_e_s(self):
        self.assertEqual(D.parse_score("r", ask=io([])), "repeat")
        self.assertEqual(D.parse_score("sair", ask=io([])), "stop")

    def test_lixo_pergunta_de_novo(self):
        self.assertEqual(D.parse_score("x", ask=io(["1"])), 1)


class TestSweep(unittest.TestCase):
    def test_duas_notas_e_sair(self):
        async def go():
            lk = FakeLink()
            plan = D.build_plan(leans=[0, 10, 20], speeds=[80], walk_ms=5)
            with tempfile.TemporaryDirectory() as td:
                out = str(Path(td) / "res.csv")
                rows = await D.run_sweep(lk, plan, ask=io(["2", "1", "s"]), out=out)
                self.assertEqual([(r["combo"], r["score"]) for r in rows],
                                 [("lean=0 speed=80", 2), ("lean=10 speed=80", 1)])
                linhas = Path(out).read_text().strip().splitlines()
                self.assertEqual(linhas, ["combo,score", "lean=0 speed=80,2", "lean=10 speed=80,1"])
            # ordem por combinacao: tune -> gait(repeat) -> stop (a 3a roda
            # e o "s" so encerra a bateria, sem registrar a linha)
            tipos = [(m.get("type"), m.get("name")) for m in lk.sent]
            self.assertEqual(tipos, [("tune", None), ("gait", "walk"), ("stop", None)] * 3)
        asyncio.run(go())

    def test_combo_com_tune_literal(self):
        async def go():
            lk = FakeLink()
            plan = [{"tune": {"hop": {"rear": 40}}, "gait": "hop", "walk_ms": 5}]
            rows = await D.run_sweep(lk, plan, ask=io(["3"]))
            self.assertEqual(rows[0]["score"], 3)
            self.assertEqual(lk.sent[0], {"type": "tune", "hop": {"rear": 40}})
            self.assertEqual(lk.sent[1], {"type": "gait", "name": "hop", "repeat": True})
        asyncio.run(go())

    def test_repetir_nao_avanca(self):
        async def go():
            lk = FakeLink()
            plan = D.build_plan(leans=[0], speeds=[80], walk_ms=5)
            rows = await D.run_sweep(lk, plan, ask=io(["r", "3"]))
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["score"], 3)
            # 2 rodadas da MESMA combinacao
            self.assertEqual([m.get("type") for m in lk.sent],
                             ["tune", "gait", "stop", "tune", "gait", "stop"])
        asyncio.run(go())

    def test_rank(self):
        rows = [{"combo": "lean=0 speed=80", "score": 1},
                {"combo": "lean=20 speed=120", "score": 3},
                {"combo": "lean=0 speed=80", "score": 3}]
        self.assertEqual(D.rank(rows)[0], (3.0, "lean=20 speed=120"))
        self.assertEqual(D.rank(rows)[1], (2.0, "lean=0 speed=80"))


class TestCli(unittest.TestCase):
    def test_sweep_dry_imprime_plano_sem_ble(self):
        with tempfile.TemporaryDirectory() as td:
            rc = D.main(["sweep", "--dry", "--lean", "5", "--speed", "80",
                         "--out", str(Path(td) / "x.csv")])
            self.assertIsNone(rc)

    def test_sweep_plan_invalido_erro(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write('{"a": 1}')
            name = f.name
        with self.assertRaises(SystemExit):
            D.main(["sweep", "--plan", name, "--dry"])


if __name__ == "__main__":
    unittest.main()
