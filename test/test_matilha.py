#!/usr/bin/env python3
"""Testes da matilha (tools/matilha) sem radio e sem bleak.

Camadas:
  - netframe: vetores CRUZADOS com o encoder C++ (main/Bluetooth/NetFrame.h)
    e com o testNetFrame do test/cpp - round-trip, rejeicoes, dedup e
    remontagem de 434 B fora de ordem
  - MeshNode: motor da malha com radio/relogio/rng falsos (presenca, BEAT,
    unicast, copias com seq novo, token bucket, relay com jitter)
  - CLI: `mesh send --dry`, --caps, bonds
  - pair_flow: pareamento por codigo + bond v2 contra um FakeLink

    python3 test/test_matilha.py -v
"""

import asyncio
import contextlib
import hashlib
import os
import random
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools" / "matilha"))
import netframe as N  # noqa: E402
import matilha as M  # noqa: E402


def io(answers):
    it = iter(answers)
    return lambda prompt="": next(it)


# ----------------------------------------------------------------- codec --

class TestFnv16(unittest.TestCase):
    # valores-ouro extraidos compilando o NetFrame.h no host (g++)
    def test_goldens(self):
        self.assertEqual(N.fnv16("celer"), 0xFF84)
        self.assertEqual(N.fnv16("matilha"), 0xA58A)
        self.assertEqual(N.fnv16("casa"), 0xA1D8)


class TestEncodeGolden(unittest.TestCase):
    """Hex exato do encoder C++: compatibilidade binaria com o firmware."""

    def test_data_unicast(self):
        f = N.Frame(N.TYPE_DATA, N.fnv16("celer"), 0x4848, 0x9F2A, 0x1234, 4, 0,
                    b"ola matilha")
        self.assertEqual(N.encode(f).hex(),
                         "434e0201ff8448489f2a123404000b6f6c61206d6174696c6861")

    def test_beat_com_nul(self):
        # um BEAT com NUL no nome decodifica normal no firmware (tolerancia)
        data = bytes([0x25]) + b"Celer-4848" + b"\0"
        f = N.Frame(N.TYPE_BEAT, N.fnv16("celer"), 0x4848, N.DST_BROADCAST,
                    0x00AA, 4, 0, data)
        self.assertEqual(N.encode(f).hex(),
                         "434e0200ff844848ffff00aa04000c2543656c65722d3438343800")

    def test_frag(self):
        data = bytes([2, 31]) + bytes(range(0xA0, 0xAE))
        f = N.Frame(N.TYPE_FRAG, N.fnv16("celer"), 0xD001, N.DST_BROADCAST,
                    0x0BBB, 8, 0, data)
        self.assertEqual(N.encode(f).hex(),
                         "434e0202ff84d001ffff0bbb080010021fa0a1a2a3a4a5a6a7a8a9aaabacad")


class TestCodec(unittest.TestCase):
    def test_roundtrip(self):
        for tipo, data in [(N.TYPE_BEAT, bytes([0x25]) + b"Celer-4848"),
                           (N.TYPE_DATA, b"x" * 16),
                           (N.TYPE_FRAG, bytes([0, 31]) + b"c" * 14)]:
            enc = N.encode(N.Frame(tipo, 0xFF84, 0x1111, 0x2222, 7, 5, 2, data))
            f = N.decode(enc)
            self.assertIsNotNone(f)
            self.assertEqual((f.type, f.net_id, f.src, f.dst, f.seq, f.ttl,
                              f.hops, f.data), (tipo, 0xFF84, 0x1111, 0x2222, 7, 5, 2, data))

    def test_rejeicoes(self):
        # encode: dlen > 16, ttl 0/9
        self.assertIsNone(N.encode(N.Frame(N.TYPE_DATA, 1, 1, 2, 3, 4, 0, b"y" * 17)))
        self.assertIsNone(N.encode(N.Frame(N.TYPE_DATA, 1, 1, 2, 3, 0, 0, b"ok")))
        self.assertIsNone(N.encode(N.Frame(N.TYPE_DATA, 1, 1, 2, 3, 9, 0, b"ok")))
        # decode: magic errado, versao 1, tamanho mentiroso, > 31, ttl fora
        enc = N.encode(N.Frame(N.TYPE_DATA, 1, 1, 2, 3, 4, 0, b"ok"))
        self.assertIsNone(N.decode(b"XX" + enc[2:]))
        self.assertIsNone(N.decode(b"CN\x01" + enc[3:]))
        self.assertIsNone(N.decode(enc[:-1]))
        self.assertIsNone(N.decode(enc + b"\x00" * 20))
        mau_ttl = bytearray(enc)
        mau_ttl[12] = 0
        self.assertIsNone(N.decode(bytes(mau_ttl)))
        mau_ttl[12] = 9
        self.assertIsNone(N.decode(bytes(mau_ttl)))

    def test_fnv16_distingue_redes(self):
        self.assertNotEqual(N.fnv16("celer"), N.fnv16("matilha"))


class TestDedupRing(unittest.TestCase):
    def test_repetido_e_novos(self):
        d = N.DedupRing()
        self.assertFalse(d.seen(0x1111, 10, 0))
        self.assertTrue(d.seen(0x1111, 10, 0))      # repetido
        self.assertFalse(d.seen(0x1111, 10, 1))     # outro frag
        self.assertFalse(d.seen(0x1111, 11, 0))     # outro seq
        self.assertFalse(d.seen(0x2222, 10, 0))     # outro no
        d.clear()
        self.assertFalse(d.seen(0x1111, 10, 0))

    def test_ring_envolve(self):
        d = N.DedupRing(4)
        for i in range(4):
            d.seen(1, i, 0)
        self.assertTrue(d.seen(1, 0, 0))            # ainda dentro
        d.seen(1, 4, 0)                              # empurra (1,0) fora
        self.assertFalse(d.seen(1, 0, 0))            # esqueceu o antigo


class TestReassembler(unittest.TestCase):
    def test_434_fora_de_ordem(self):
        payload = bytes((i * 7) % 256 for i in range(N.MSG_MAX))
        r = N.Reassembler()
        total = 31
        for i in range(total):                       # passo 7 e coprimo de 31
            idx = (i * 7) % total
            chunk = payload[idx * 14:(idx + 1) * 14]
            msg = r.feed(0x4848, 99, idx, total, chunk, 1000)
            if i == total - 1:
                self.assertEqual(msg, payload)
            else:
                self.assertIsNone(msg)

    def test_frag_repetido(self):
        r = N.Reassembler()
        self.assertIsNone(r.feed(1, 1, 0, 2, b"a" * 14, 1000))
        self.assertIsNone(r.feed(1, 1, 0, 2, b"a" * 14, 1000))   # repetido

    def test_chunk_curto_no_meio(self):
        r = N.Reassembler()
        self.assertIsNone(r.feed(1, 1, 0, 3, b"a" * 14, 1000))
        self.assertIsNone(r.feed(1, 1, 1, 3, b"curto", 1000))    # so o ultimo

    def test_total_e_idx_invalidos(self):
        r = N.Reassembler()
        self.assertIsNone(r.feed(1, 1, 0, 0, b"x", 1000))
        self.assertIsNone(r.feed(1, 1, 0, 32, b"x" * 14, 1000))
        self.assertIsNone(r.feed(1, 1, 5, 3, b"x" * 14, 1000))
        self.assertIsNone(r.feed(1, 1, 0, 3, b"x" * 15, 1000))

    def test_colisao_de_seq(self):
        r = N.Reassembler()
        self.assertIsNone(r.feed(1, 1, 0, 2, b"a" * 14, 1000))
        self.assertIsNone(r.feed(1, 1, 1, 3, b"a" * 14, 1000))   # total != 2

    def test_quatro_slots_e_prune(self):
        r = N.Reassembler()
        for s in range(1, 5):                        # 4 mensagens paradas
            self.assertIsNone(r.feed(1, s, 0, 2, b"a" * 14, 1000))
        self.assertIsNone(r.feed(1, 6, 0, 2, b"a" * 14, 1000))   # sem slot
        r.prune(1000 + 6001, 6000)                   # slot vence
        self.assertIsNone(r.feed(1, 6, 0, 2, b"a" * 14, 8000))
        self.assertEqual(r.feed(1, 6, 1, 2, b"ab", 8000), b"a" * 14 + b"ab")


# ------------------------------------------------------------------- no ---

class FakeRadio:
    def __init__(self):
        self.sent = []

    def tx(self, frame):
        self.sent.append(bytes(frame))
        return True

    def start(self):
        pass

    def close(self):
        pass

    def poll(self, timeout=0.0):
        return []


class Clock:
    def __init__(self, t=1000):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, ms):
        self.t += ms


def make_node(**kw):
    radio, clk = FakeRadio(), Clock()
    node = M.MeshNode(0x1111, "PC", net="celer", radio=radio, now_ms=clk,
                      rng=random.Random(42), **kw)
    return node, radio, clk


def beat_raw(src, name, caps=0, seq=1, ttl=4, hops=0, net="celer"):
    return N.encode(N.Frame(N.TYPE_BEAT, N.fnv16(net), src, N.DST_BROADCAST,
                            seq, ttl, hops, bytes([caps]) + name.encode()))


def data_raw(src, payload, dst=N.DST_BROADCAST, seq=100, ttl=4, hops=1):
    return N.encode(N.Frame(N.TYPE_DATA, N.fnv16("celer"), src, dst, seq, ttl,
                            hops, payload))


def flushar(node, clk, guarda=500):
    """Esvazia a fila TX avancando o relogio aos passos."""
    i = 0
    while node.pending and i < guarda:
        clk.advance(30)
        node.tick()
        i += 1


class TestPresenca(unittest.TestCase):
    def test_beat_preenche_e_expira(self):
        eventos = []
        node, _, clk = make_node(on_member=lambda k, n: eventos.append((k, n["id"])))
        node.on_adv_report(beat_raw(0x4848, "Celer-4848", 0x25), -58)
        self.assertEqual(node.nodes_tbl[0x4848]["name"], "Celer-4848")
        self.assertEqual(node.nodes_tbl[0x4848]["caps"], 0x25)
        self.assertEqual(eventos, [("join", 0x4848)])
        clk.advance(15001)
        node.tick()   # BEAT proprio entra na fila ANTES da varredura: a
        # histerese (fila pendente = no surdo, criterio do nodeExpired do
        # firmware) segura o par neste giro
        self.assertIn(0x4848, node.nodes_tbl)
        node.tick()   # fila drenada: varredura expira no TTL normal
        self.assertNotIn(0x4848, node.nodes_tbl)
        self.assertEqual(eventos, [("join", 0x4848), ("leave", 0x4848)])

    def test_no_sumido_sai_no_teto_4xttl_com_fila_cheia(self):
        # par que foi embora DE VERDADE: pressao continua de fila segura a
        # presenca alem do TTL (no surdo nao dita morte), mas o teto duro
        # de 4x TTL derruba mesmo assim (paridade com o CelerNet.cpp)
        eventos = []
        node, radio, clk = make_node(on_member=lambda k, n: eventos.append((k, n["id"])))
        radio.tx = lambda frame: False   # radio sempre ocupado: fila nunca drena
        node.on_adv_report(beat_raw(0x4848, "Celer-4848"), -58)
        clk.advance(30000)               # 29 s sem BEAT: histerese segura
        node.tick()
        self.assertIn(0x4848, node.nodes_tbl)
        clk.advance(31001)               # 60 s sem BEAT: teto 4x TTL
        node.tick()
        self.assertNotIn(0x4848, node.nodes_tbl)
        self.assertEqual(eventos[-1], ("leave", 0x4848))

    def test_beat_outra_rede_ignorado(self):
        node, _, _ = make_node()
        node.on_adv_report(beat_raw(0x4848, "Celer-4848", 0, net="matilha"), -58)
        self.assertEqual(node.nodes_tbl, {})

    def test_resolv_nome_e_hex(self):
        node, _, _ = make_node()
        node.on_adv_report(beat_raw(0x4848, "Celer-4848"), -58)
        node.on_adv_report(beat_raw(0xD001, "Celer-D001"), -80)
        self.assertEqual(node.resolve("celer-4848"), 0x4848)   # case-insensitive
        self.assertEqual(node.resolve("ABCD"), 0xABCD)
        self.assertIsNone(node.resolve("ninguem"))

    def test_resolv_duplicado_pega_mais_forte(self):
        node, _, _ = make_node()
        node.on_adv_report(beat_raw(0x0001, "Clone"), -80)
        node.on_adv_report(beat_raw(0x0002, "Clone"), -50)
        self.assertEqual(node.resolve("clone"), 0x0002)


class TestEntrega(unittest.TestCase):
    def test_broadcast_entrega(self):
        node, _, _ = make_node()
        node.on_adv_report(data_raw(0x4848, b"ola bando"), -58)
        m = node.poll_msg()
        self.assertIsNotNone(m)
        self.assertEqual(m["text"], "ola bando")
        self.assertFalse(m["unicast"])
        self.assertEqual(m["from"], 0x4848)

    def test_unicast_para_mim_entrega(self):
        node, _, _ = make_node()
        node.on_adv_report(data_raw(0x4848, b"segredo", dst=0x1111), -58)
        m = node.poll_msg()
        self.assertIsNotNone(m)
        self.assertTrue(m["unicast"])

    def test_unicast_para_outro_nao_entrega(self):
        node, radio, clk = make_node(relay=True)
        node.on_adv_report(data_raw(0x4848, b"nao e comigo", dst=0x9999), -58)
        self.assertIsNone(node.poll_msg())
        # ...mas o relay segue o flood: ttl-1/hops+1, src original (fora o BEAT)
        flushar(node, clk)
        dados = [N.decode(x) for x in radio.sent if N.decode(x).type == N.TYPE_DATA]
        self.assertEqual(len(dados), 1)
        f = dados[0]
        self.assertEqual((f.src, f.dst, f.ttl, f.hops, f.data),
                         (0x4848, 0x9999, 3, 2, b"nao e comigo"))

    def test_frag_434_remonta(self):
        node, _, _ = make_node()
        payload = bytes((i * 3) % 256 for i in range(N.MSG_MAX))
        total = 31
        for i in range(total):
            idx = (i * 7) % total
            chunk = payload[idx * 14:(idx + 1) * 14]
            raw = N.encode(N.Frame(N.TYPE_FRAG, N.fnv16("celer"), 0x4848,
                                   N.DST_BROADCAST, 55, 4, 1,
                                   bytes([idx, total]) + chunk))
            node.on_adv_report(raw, -60)
        m = node.poll_msg()
        self.assertIsNotNone(m)
        self.assertEqual(m["data"], payload)

    def test_fila_rx_descarta_mais_antiga(self):
        node, _, _ = make_node()
        for s in range(9):
            node.on_adv_report(data_raw(0x4848, b"m%d" % s, seq=200 + s), -58)
        self.assertEqual(len(node.rx), M.MeshNode.RX_DEPTH)
        self.assertEqual(node.counters["rxDropped"], 1)
        self.assertEqual(node.rx[-1]["text"], "m8")

    def test_eco_proprio_ignorado(self):
        node, _, _ = make_node()
        node.on_adv_report(data_raw(0x1111, b"eco"), -40)
        self.assertIsNone(node.poll_msg())


class TestProtocolo18(unittest.TestCase):
    """Alinhamento com o firmware 1.8: copias de mensagem fragmentada dividem
    o seq (copia nos bits 5-6 do idx), entrega unica, fila tudo-ou-nada e
    hops contando saltos (vizinho direto = 1)."""

    def test_remontador_junta_copias_e_entrega_uma_vez(self):
        r = N.Reassembler()
        msg = bytes(range(40))                       # 3 frags
        c1 = 1 << N.FRAG_COPY_SHIFT
        self.assertIsNone(r.feed(7, 50, 0, 3, msg[0:14], 0))          # copia 0
        self.assertIsNone(r.feed(7, 50, 2, 3, msg[28:], 10))          # (frag 1 perdido)
        self.assertEqual(r.feed(7, 50, 1 | c1, 3, msg[14:28], 20), msg)  # copia 1 completa
        self.assertIsNone(r.feed(7, 50, 2 | c1, 3, msg[28:], 30))     # sem 2a entrega

    def test_send_fragmentado_copias_com_mesmo_seq(self):
        node, radio, clk = make_node()
        self.assertTrue(node.send(0x4848, b"x" * 40, copies=2))
        flushar(node, clk)
        frags = [N.decode(x) for x in radio.sent if N.decode(x).type == N.TYPE_FRAG]
        self.assertEqual(len(frags), 6)
        self.assertEqual(len({f.seq for f in frags}), 1)
        copias = sorted({f.data[0] >> N.FRAG_COPY_SHIFT for f in frags})
        self.assertEqual(copias, [0, 1])
        self.assertEqual(len(frags[-1].data), 2 + 40 - 28)          # ultimo frag curto

    def test_send_quadro_unico_copias_com_seq_novo(self):
        node, radio, clk = make_node()
        self.assertTrue(node.send(0x4848, b"oi", copies=2))
        flushar(node, clk)
        dados = [N.decode(x) for x in radio.sent if N.decode(x).type == N.TYPE_DATA]
        self.assertEqual(len({f.seq for f in dados}), 2)

    def test_fila_tudo_ou_nada(self):
        node, _, _ = make_node()
        self.assertTrue(node.send(0x4848, b"x" * 434, copies=2))     # 62 de 96
        antes = len(node.pending)
        self.assertFalse(node.send(0x4848, b"y" * 434, copies=2))    # nao cabe
        self.assertEqual(len(node.pending), antes)                  # nada pela metade

    def test_hops_vizinho_direto_e_um(self):
        node, _, _ = make_node()
        node.on_adv_report(data_raw(0x4848, b"oi", hops=0), -50)
        self.assertEqual(node.poll_msg()["hops"], 1)

    def test_beat_repetido_nao_troca_caminho_direto(self):
        node, _, clk = make_node()
        node.on_adv_report(beat_raw(0x4848, "Dog", seq=1, hops=0), -40)
        node.on_adv_report(beat_raw(0x4848, "Dog", seq=2, hops=1), -70)   # via repetidor
        self.assertEqual((node.nodes_tbl[0x4848]["hops"], node.nodes_tbl[0x4848]["rssi"]), (1, -40))


class TestTx(unittest.TestCase):
    def test_beat_sem_nul_na_wire(self):
        node, radio, clk = make_node(caps=0x25)
        node.tick()
        flushar(node, clk)
        f = N.decode(radio.sent[0])
        self.assertEqual(f.type, N.TYPE_BEAT)
        self.assertEqual(f.data, bytes([0x25]) + b"PC")   # caps + nome, sem NUL
        self.assertEqual(f.src, 0x1111)

    def test_unicast_copias_seq_novo_espacadas(self):
        node, radio, clk = make_node()
        self.assertTrue(node.send(0x4848, b"oi", copies=2))
        self.assertEqual(len(node.pending), 2)
        flushar(node, clk)
        # o BEAT do 1o tick viaja junto; as copias sao os DATA unicast
        copias = [N.decode(x) for x in radio.sent
                  if N.decode(x).type == N.TYPE_DATA]
        self.assertEqual(len(copias), 2)
        self.assertEqual(copias[0].dst, 0x4848)
        self.assertNotEqual(copias[0].seq, copias[1].seq)   # dedup nao come a copia
        # segunda copia so vence 1,5 s depois: o relogio andou >= 1500
        self.assertGreaterEqual(clk.t - 1000, 1500)

    def test_urgente_fura_a_fila(self):
        node, radio, clk = make_node()
        node.broadcast(b"normal")
        node.send(0x4848, b"urgente", urgent=True)
        flushar(node, clk)
        f0 = N.decode(radio.sent[0])
        self.assertEqual(f0.data, b"urgente")

    def test_respiro_e_token_bucket(self):
        node, radio, clk = make_node()
        node.tick()
        self.assertEqual(len(radio.sent), 1)            # BEAT sai no 1o tick
        node.broadcast(b"n1")
        node.tick()                                     # mesmo instante: respiro 25 ms
        self.assertEqual(len(radio.sent), 1)
        clk.advance(26)
        node.tick()
        self.assertEqual(len(radio.sent), 2)
        # rajada maior que as fichas: espera o refill (8/s) e loga noToken
        for i in range(30):
            node.broadcast(b"m%d" % i)
        i = 0
        while node.pending and i < 2000:
            clk.advance(30)
            node.tick()
            i += 1
        self.assertFalse(node.pending)
        self.assertEqual(len(radio.sent), 2 + 30)       # BEAT + n1 + 30 msgs
        self.assertGreaterEqual(node.counters["txNoToken"], 1)

    def test_relay_frag_espera_rajada(self):
        node, _, clk = make_node(relay=True)
        # DATA: jitter 40+ttl*40+rand(200) <= 400; FRAG: +700..1600
        node.on_adv_report(data_raw(0x4848, b"xy", ttl=4), -60)
        due_data = node.pending[0]["due_ms"]
        chunk = bytes([0, 3]) + b"c" * 14
        raw = N.encode(N.Frame(N.TYPE_FRAG, N.fnv16("celer"), 0x4848,
                               N.DST_BROADCAST, 300, 4, 1, chunk))
        node.on_adv_report(raw, -60)
        due_frag = node.pending[1]["due_ms"]
        self.assertGreater(due_frag, due_data + 300)

    def test_relay_desligado_padrao(self):
        node, radio, clk = make_node()                  # sem --relay
        node.on_adv_report(data_raw(0x4848, b"xy"), -60)
        self.assertEqual(node.pending, [])
        flushar(node, clk)
        self.assertEqual(radio.sent, [])

    def test_relay_com_anel_cheio_conta_descarte(self):
        # anel de 96 lotado: a repeticao caida aparece CONTADA no status
        # (relayDropped), nunca silenciosa — paridade com o firmware
        node, _, _ = make_node(relay=True)
        node.pending = [{"frame": b"", "due_ms": 0, "prio": 0}] * M.MeshNode.PENDING_DEPTH
        node.on_adv_report(data_raw(0x4848, b"xy", ttl=4), -60)
        self.assertEqual(len(node.pending), M.MeshNode.PENDING_DEPTH)
        self.assertEqual(node.counters["relayDropped"], 1)
        self.assertEqual(node.counters["relayed"], 0)


# ------------------------------------------------------------------- CLI --

class TestCli(unittest.TestCase):
    def test_send_dry_imprime_quadros(self):
        buf = StringIO()
        with contextlib.redirect_stdout(buf):
            rc = M.main(["mesh", "send", "ola bando", "--dry"])
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn("TX 43", out)                     # magic CN no byte 0
        self.assertIn("total: 2 quadros", out)          # BEAT + 1 DATA

    def test_send_dry_unicast_frag(self):
        buf = StringIO()
        with contextlib.redirect_stdout(buf):
            rc = M.main(["mesh", "send", "x" * 100, "--dry", "--to", "abcd",
                         "--copies", "1"])
        self.assertEqual(rc, 0)
        self.assertIn("total: 9 quadros", out := buf.getvalue())  # BEAT + 8 frags

    def test_send_dry_maior_que_434_erro(self):
        with self.assertRaises(SystemExit):
            M.main(["mesh", "send", "x" * 435, "--dry"])

    def test_caps_nomes_hex_e_invalido(self):
        self.assertEqual(M.parse_caps("hub"), N.CAPS_HUB)
        self.assertEqual(M.parse_caps("0x25"), 0x25)
        self.assertEqual(M.parse_caps("speaker,leds"), N.CAPS_SPEAKER | N.CAPS_LEDS)
        self.assertEqual(M.parse_caps(""), N.CAPS_HUB)
        with self.assertRaises(SystemExit):
            M.parse_caps("camera")


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
