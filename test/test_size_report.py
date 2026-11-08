#!/usr/bin/env python3
"""Testes do teto de crescimento do size_report.py (host, sem build).

    python3 test/test_size_report.py -v

Cobre a funcao pura que o CI usa: baseline ausente, placa sem medida, bin
stale e crescimento acima do teto. Nao mede firmware nenhum.
"""

import sys
import tempfile
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


class LedgerProblemsTest(unittest.TestCase):
    """Orcamento por objeto: o gate que cada onda C++->JS tem que passar."""

    def test_dentro_do_teto(self):
        self.assertEqual(
            S.ledger_problems({"cyd": {"JsAi.cpp.obj": 9_000}},
                              {"cyd": {"JsAi.cpp.obj": 9_000}}, ["cyd"], 512),
            [],
        )

    def test_crescimento_no_limite_passa(self):
        self.assertEqual(
            S.ledger_problems({"cyd": {"A.obj": 512}}, {"cyd": {"A.obj": 0}}, ["cyd"], 512),
            [],
        )

    def test_crescimento_acima_do_teto_falha(self):
        p = S.ledger_problems({"cyd": {"A.obj": 513}}, {"cyd": {"A.obj": 0}}, ["cyd"], 512)
        self.assertEqual(len(p), 1)
        self.assertEqual(p[0][1], "A.obj")
        self.assertIn("cresceu", p[0][2])

    def test_migracao_para_js_passa(self):
        # o caso do plano: o objeto encolhe 8 KB
        self.assertEqual(
            S.ledger_problems({"cyd": {"JsAi.cpp.obj": 1_200}},
                              {"cyd": {"JsAi.cpp.obj": 9_290}}, ["cyd"], 512),
            [],
        )

    def test_objeto_novo_acima_do_teto_falha(self):
        p = S.ledger_problems({"cyd": {"Novo.cpp.obj": 700}}, {"cyd": {}}, ["cyd"], 512)
        self.assertEqual(len(p), 1)
        self.assertIn("objeto novo", p[0][2])

    def test_objeto_novo_pequeno_passa(self):
        self.assertEqual(
            S.ledger_problems({"cyd": {"Novo.cpp.obj": 400}}, {"cyd": {}}, ["cyd"], 512),
            [],
        )

    def test_placa_sem_entrada_no_ledger_nao_bloqueia(self):
        # catraca por placa: cada board entra no commit em que e medido com
        # build fresco; o baseline da imagem ja cobre a presenca
        self.assertEqual(S.ledger_problems({"cyd": {"A.obj": 9_000}}, {}, ["cyd"], 512), [])

    def test_placa_do_ledger_sem_medida_falha(self):
        p = S.ledger_problems({}, {"cyd": {"A.obj": 1}}, ["cyd"], 512)
        self.assertEqual(len(p), 1)
        self.assertIn("nao foi medido", p[0][2])

    def test_placa_do_ledger_sem_dados_por_objeto_falha(self):
        # mediu a imagem mas o --files voltou vazio (esp_idf_size ausente no
        # PATH ou JSON em outro formato): com `cur` vazio o laco de objetos
        # nao roda e o gate passava calado, desligando a catraca do CI para
        # quem esta no ledger sem ninguem ver
        p = S.ledger_problems({"cyd": {}}, {"cyd": {"A.obj": 9_000}}, ["cyd"], 512)
        self.assertEqual(len(p), 1)
        self.assertIn("sem dados por objeto", p[0][2])

    def test_placa_fora_do_ledger_com_medida_vazia_passa(self):
        self.assertEqual(S.ledger_problems({"devkit": {}}, {}, ["devkit"], 512), [])

    def test_placa_selecionada_sem_build_e_sem_ledger_passa(self):
        self.assertEqual(S.ledger_problems({}, {}, ["devkit"], 512), [])


class LedgerMergeTest(unittest.TestCase):
    """--save-ledger mescla: placa medida SEM dados por objeto (esp_idf_size
    ausente: `--files` volta {}) NAO pode entrar — gravar {} apagava a
    entrada da placa calado e o check-ledger seguinte a tratava como "fora
    do ledger" (catraca desligada sem ninguem ver)."""

    def test_medida_vazia_nao_apaga_a_entrada(self):
        prev = {"cyd": {"A.obj": 100}}
        results = {"cyd": {"files": {}}, "smartdisplay": {"files": {"B.obj": 7}}}
        out = S.ledger_merge(dict(prev), results)
        self.assertEqual(out["cyd"], {"A.obj": 100})      # intacta
        self.assertEqual(out["smartdisplay"], {"B.obj": 7})  # adotada

    def test_placa_sem_build_nao_toca_o_ledger(self):
        prev = {"cyd": {"A.obj": 100}}
        out = S.ledger_merge(dict(prev), {})   # nada medido nesta rodada
        self.assertEqual(out, {"cyd": {"A.obj": 100}})

    def test_remontagem_atualiza_a_entrada(self):
        out = S.ledger_merge({}, {"cyd": {"files": {"A.obj": 512}}})
        self.assertEqual(out, {"cyd": {"A.obj": 512}})


class BuildBoardTest(unittest.TestCase):
    """Identidade do build dir (6dcc17df): o gate do slot/ledger nao pode
    pesar o binario de OUTRA placa — o dir diz a placa no CMakeCache."""

    def test_le_celeros_board_do_cache(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "CMakeCache.txt").write_text(
                "CELEROS_BOARD:STRING=cyd\nCMAKE_HOME_DIRECTORY:INTERNAL=/x\n",
                encoding="utf-8",
            )
            self.assertEqual(S.build_board(td), "cyd")

    def test_sem_cache_e_none(self):
        # sem CMakeCache nao ha identidade: o measure mantem o comportamento
        # antigo (mede), porque recusar exigiria inventar criterio novo
        with tempfile.TemporaryDirectory() as td:
            self.assertIsNone(S.build_board(td))

    def test_cache_sem_a_chave_e_none(self):
        # cache de projeto estranho ao CelerOS (nunca configurado por ele):
        # None, e nao um chute de placa
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "CMakeCache.txt").write_text(
                "CMAKE_HOME_DIRECTORY:INTERNAL=/x\n", encoding="utf-8"
            )
            self.assertIsNone(S.build_board(td))


if __name__ == "__main__":
    unittest.main()
