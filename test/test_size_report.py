#!/usr/bin/env python3
"""Testes do teto de crescimento do size_report.py (host, sem build).

    python3 test/test_size_report.py -v

Cobre a funcao pura que o CI usa: baseline ausente, placa sem medida, bin
stale e crescimento acima do teto. Nao mede firmware nenhum.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import size_report as S  # noqa: E402


def med(image, stale=None):
    return {"image": image, "slot": 1_638_400, "archives": {}, "stale": stale}


class BudgetProblemsTest(unittest.TestCase):
    def test_dentro_do_teto(self):
        self.assertEqual(
            S.budget_problems({"cyd": med(1_000)}, {"cyd": med(900)}, ["cyd"], 8),
            [],
        )

    def test_crescimento_no_limite_passa(self):
        # 8 KB exatos: a comparacao e "maior que", nao "maior ou igual"
        self.assertEqual(
            S.budget_problems({"cyd": med(8 * 1024)}, {"cyd": med(0)}, ["cyd"], 8),
            [],
        )

    def test_crescimento_acima_do_teto(self):
        problemas = S.budget_problems(
            {"cyd": med(8 * 1024 + 1)}, {"cyd": med(0)}, ["cyd"], 8
        )
        self.assertEqual(len(problemas), 1)
        self.assertEqual(problemas[0][0], "cyd")
        self.assertIn("cresceu", problemas[0][1])

    def test_encolher_nao_e_problema(self):
        self.assertEqual(
            S.budget_problems({"cyd": med(500)}, {"cyd": med(900)}, ["cyd"], 8),
            [],
        )

    def test_sem_entrada_no_baseline(self):
        problemas = S.budget_problems({"cyd": med(500)}, {}, ["cyd"], 8)
        self.assertEqual(len(problemas), 1)
        self.assertIn("sem entrada no baseline", problemas[0][1])

    def test_bin_stale_falha(self):
        problemas = S.budget_problems(
            {"cyd": med(500, stale="main/Runtime/JsSystemApps.cpp")},
            {"cyd": med(500)},
            ["cyd"],
            8,
        )
        self.assertEqual(len(problemas), 1)
        self.assertIn("stale", problemas[0][1])

    def test_placa_do_baseline_sem_medida(self):
        # CI roda uma placa por job: o baseline tem as 8, mas so a selecionada
        # precisa ser medida. A que esta no baseline e nao foi medida e falha
        # apenas quando ela e a selecionada.
        baseline = {"cyd": med(500), "smartdisplay": med(2_000)}
        self.assertEqual(
            S.budget_problems({"cyd": med(500)}, baseline, ["cyd"], 8),
            [],
        )
        self.assertEqual(
            S.budget_problems({}, baseline, ["smartdisplay"], 8)[0][0],
            "smartdisplay",
        )

    def test_placa_selecionada_sem_build_e_sem_baseline_passa(self):
        # Rodada local parcial (--board inexistente no baseline) nao deve
        # bloquear; a placa nova entra no baseline num commit proprio e o CI
        # a mede na matrix.
        self.assertEqual(S.budget_problems({}, {}, ["devkit"], 8), [])


if __name__ == "__main__":
    unittest.main()
