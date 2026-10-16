#!/usr/bin/env python3
"""Testes do celerctl contra um device simulado (protocolo HostLink).

Sem hardware: um FakeDevice espelha o comportamento do firmware (parser
v1/v2 com CRC, ACK seq/total dos chunks, READ com offset) e responde na
hora. Valida o lado host — o lado device e coberto pelos testes C++ do
HostFrame.h (test/cpp/run_tests.cpp) e pela bancada.

    python3 -m unittest test.test_celerctl -v
"""

import io
import json
import re
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
import zlib
import hashlib
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import celerctl as C  # noqa: E402

KL = C.KL
MAGIC = 0x43


def frame_v2(cmd, payload=b"", status=None):
    if status is not None:
        payload = bytes([status]) + payload
    head = struct.pack("<BH", cmd, len(payload))
    return (bytes([MAGIC]) + head + struct.pack("<I", zlib.crc32(head + payload) & 0xFFFFFFFF)
            + payload)


def frame_v1(cmd, payload=b"", status=None):
    if status is not None:
        payload = bytes([status]) + payload
    return bytes([MAGIC, cmd]) + struct.pack("<H", len(payload)) + payload


# ---- fotos de profiling (KL_STATS) sinteticas: A e B separadas por uma
# janela de ~300ms. Runtime por task e cumulativo; total_rt em 2 nucleos
# avanca ~2x a janela. Deltas esperados: IDLE0 +1.000.000us, main +50.000us,
# "nova" nasceu na janela (base 0, rt inteiro).
STATS_SNAP_A = {
    "uptime_us": 60_000_000, "cpu_mhz": 240,
    "heap": {"free": 200_000, "min": 150_000, "largest": 90_000,
             "int_free": 100_000, "int_min": 80_000, "int_largest": 60_000,
             "psram_free": 4_000_000, "psram_total": 8_000_000,
             "psram_min": 3_900_000, "psram_largest": 3_000_000},
    "js": {"active": 1, "launch_free": 180_000, "now_free": 160_000,
           "allocs": 500, "allocs_peak": 700},
    "loop": {"busy_us": 1_000_000, "total_us": 10_000_000},
    "ui": {"frames": 100, "presents": 200, "us": 400_000, "us_max": 8_000},
    "total_rt_us": 55_000_000,
    "tasks": [
        {"n": "main", "s": "R", "p": 1, "stk": 12_000, "rt": 20_000_000},
        {"n": "IDLE0", "s": "r", "p": 0, "stk": 900, "rt": 30_000_000},
        {"n": "wifi", "s": "B", "p": 23, "stk": 4_000, "rt": 5_000_000},
    ],
    "trunc": 0,
}
STATS_SNAP_B = {
    "uptime_us": 60_300_000, "cpu_mhz": 240,
    "heap": {"free": 195_000, "min": 150_000, "largest": 88_000,
             "int_free": 98_000, "int_min": 80_000, "int_largest": 60_000,
             "psram_free": 3_900_000, "psram_total": 8_000_000,
             "psram_min": 3_900_000, "psram_largest": 3_000_000},
    "js": {"active": 1, "launch_free": 180_000, "now_free": 155_000,
           "allocs": 560, "allocs_peak": 700},
    "loop": {"busy_us": 1_050_000, "total_us": 10_100_000},
    "ui": {"frames": 107, "presents": 215, "us": 431_000, "us_max": 9_500},
    "total_rt_us": 56_060_000,
    "tasks": [
        {"n": "main", "s": "R", "p": 1, "stk": 11_800, "rt": 20_050_000},
        {"n": "IDLE0", "s": "r", "p": 0, "stk": 890, "rt": 31_000_000},
        {"n": "wifi", "s": "B", "p": 23, "stk": 4_000, "rt": 5_000_000},
        {"n": "nova", "s": "B", "p": 2, "stk": 2_048, "rt": 10_000},
    ],
    "trunc": 0,
}


class FakeDevice:
    """Espelho minimo do firmware para os testes do host.

    Cada write() do celerctl e um frame completo (o host nunca parte
    frames). `drop_chunk`/`corrupt_chunk` simulam o canal ruim: o frame
    some ou chega com um bit virado (CRC nao fecha — device descarta).
    """

    def __init__(self, serial, proto=2, chunk=4096, win=4):
        self.ser = serial
        self.proto = proto
        self.chunk = chunk
        self.win = win
        self.files = {}           # path -> bytes (conteudo para READ)
        self.dirs = {}            # path -> [nomes] (conteudo para LS)
        self.page_size = 4096     # entradas por pagina de LS (forcar poucas no teste)
        self.wr_path = None
        self.wr_data = None
        self.wr_seq = 0
        self.wr_crc = 0
        self.drop_chunk = []      # seqs cujo WRITE_CHUNK some no caminho (1x cada)
        self.corrupt_chunk = []   # seqs que chegam com 1 byte virado (1x cada)
        self.execs = []           # linhas EXEC recebidas (o "rescan" do install)
        # fila de fotos de profiling: cada KL_STATS devolve a proxima (a
        # ultima repete — o celerctl top pede 2+ seguidas)
        self.stats_q = [STATS_SNAP_A]

    # ---- envio de resposta
    def reply(self, cmd, payload=b"", status=0):
        self.ser.rx += frame_v2(cmd, payload, status) if self.proto == 2 \
            else frame_v1(cmd, payload, status)

    # ---- recepcao
    def _lost_in_transit(self, data):
        """True se o frame nao chega integro ao device (drop/corrupt)."""
        if data[0] != MAGIC or data[1] != KL["WRITE_CHUNK"] or self.proto != 2:
            return False
        (seq,) = struct.unpack("<H", data[8:10])
        if seq in self.drop_chunk:
            self.drop_chunk.remove(seq)
            return True  # sumiu: nenhum ACK, host reenvia no timeout
        if seq in self.corrupt_chunk:
            self.corrupt_chunk.remove(seq)
            return True  # bit virado: CRC do frame nao fecha, device descarta
        return False

    def on_bytes(self, data):
        if self._lost_in_transit(data):
            return
        cmd, payload, ok = self.parse(data)
        if not ok:
            return  # CRC invalido: firmware descarta e espera reenvio
        getattr(self, "op_%02x" % cmd, lambda p: self.reply(cmd, b"opcode?", 1))(payload)

    def parse(self, data):
        if data[0] != MAGIC:
            return None, None, False
        cmd = data[1]
        (ln,) = struct.unpack("<H", data[2:4])
        off = 4
        if self.proto == 2:
            (crc,) = struct.unpack("<I", data[4:8])
            off = 8
            if crc != zlib.crc32(data[1:4] + data[off:off + ln]) & 0xFFFFFFFF:
                # fallback do firmware (HostFrame.h): HELLO v1 de um host
                # que ainda nao conhece a versao chega com "CELE" no lugar
                # do crc — devolve os bytes ao payload e cai para proto 1
                if cmd == 0x01 and struct.pack("<I", crc) == b"CELE":
                    self.proto = 1
                    return cmd, b"CELE" + data[off:off + ln], True
                return None, None, False
        return cmd, data[off:off + ln], True

    # ---- OTA (espelho do HostLink.cpp): injecao das quedas vistas na bancada
    def op_13(self, p):  # OTA_BEGIN
        self.ota = bytearray()
        self.ota_seq = 0
        self.ota_crc = 0
        self.ota_open = True
        self.ota_ops = getattr(self, "ota_ops", []) + ["BEGIN"]
        self.reply(KL["OTA_BEGIN"], b"app1")

    def op_14(self, p):  # OTA_CHUNK [seq][dados]
        (seq,) = struct.unpack("<H", p[:2])
        if seq in getattr(self, "ota_noise_at", []):
            # bytes perdidos na UART: o parser ressincroniza em lixo e responde
            # a rejeicao com um cmd inventado; o chunk nao vale
            self.ota_noise_at.remove(seq)
            self.reply(0xA6, b"payload grande demais", 1)
            return
        if seq != self.ota_seq:
            self.reply(KL["OTA_CHUNK"], struct.pack("<HI", self.ota_seq, len(self.ota)))
            return
        self.ota += p[2:]
        self.ota_crc = zlib.crc32(bytes(p[2:]), self.ota_crc) & 0xFFFFFFFF
        self.ota_seq += 1
        self.reply(KL["OTA_CHUNK"], struct.pack("<HI", self.ota_seq, len(self.ota)))

    def op_15(self, p):  # OTA_END [crc][tamanho]
        self.ota_ops = getattr(self, "ota_ops", []) + ["END"]
        crc, size = struct.unpack("<II", p[:8])
        if not getattr(self, "ota_open", False):
            if getattr(self, "end_idempotent", True) and getattr(self, "ota_done", None) == (crc, size):
                self.reply(KL["OTA_END"], struct.pack("<I", size))   # reenvio confirmado
            else:
                self.reply(KL["OTA_END"], b"OTA nao iniciada", 1)
            return
        if (crc, size) != (self.ota_crc, len(self.ota)):
            self.ota_open = False
            self.reply(KL["OTA_END"], b"crc/tamanho divergem no fim da OTA", 1)
            return
        self.ota_open = False
        self.ota_done = (crc, size)
        if getattr(self, "end_reply_lost", 0) > 0:
            self.end_reply_lost -= 1   # aplicou e marcou o boot; a resposta se perdeu
            return
        self.reply(KL["OTA_END"], struct.pack("<I", size))

    def op_16(self, p):  # OTA_ABORT
        self.ota_ops = getattr(self, "ota_ops", []) + ["ABORT"]
        self.ota_open = False
        self.reply(KL["OTA_ABORT"])

    # ---- handlers
    def op_01(self, p):  # HELLO
        v2 = p == b"CELERCTL2"
        if v2:
            ident = f"CelerOS 9.9|test|api 99|proto 2|chunk {self.chunk}|win {self.win}"
        else:
            ident = "CelerOS 9.9|test|api 99|proto 1"
        # resposta sai no formato VIGENTE da sessao; a troca para v2 vale
        # para o frame SEGUINTE (espelho do handleHello do firmware)
        self.reply(KL["HELLO"], ident.encode())
        self.proto = 2 if v2 else 1

    def op_21(self, p):  # RES_CTL: gateway USB (espelho do Resources::usbCtl)
        sub, req, ln = p[0], p[1], (p[2] << 8) | p[3]
        body = bytes(p[4:4 + ln])
        S = C.SUB
        net = getattr(self, "net", {"net": "celer", "prov": 0})
        out = None
        if sub == S["DESCRIBE"]:
            out = json.dumps({"id": "1CAE", "name": "Celer-1CAE", "board": "test", "api": 40,
                              "prov": net["prov"], "usb": 1, "relay": 0}).encode()
        elif sub in (S["LIST"], S["MESH"]):
            out = b"\x00"
        elif sub == S["JOIN"]:
            nl = body[0]
            nome, pl = body[1:1 + nl], body[1 + nl]
            senha = body[2 + nl:]
            if 1 <= nl <= 15 and 8 <= pl <= 64 and len(senha) == pl:
                self.net = {"net": nome.decode(), "prov": 1}
                self.joined = (nome, senha)
                out = b""
        elif sub == S["LEAVE"]:
            self.net = {"net": "celer", "prov": 0}
            out = b""
        elif sub == S["NET"]:
            out = json.dumps(dict(net, node="1CAE", name="Celer-1CAE", pc="FFAE")).encode()
        elif sub == S["SEND"]:
            self.sent = getattr(self, "sent", []) + [((body[0] << 8) | body[1], body[2:])]
            out = b""
        elif sub == S["OPEN_AT"]:
            node, nl = (body[0] << 8) | body[1], body[2]
            nome = body[3:3 + nl].decode()
            h = 3
            self.opened = (node, nome, body[4 + nl:].decode())
            out = bytes((h,))
            # o EV_STATE do tick chega depois da resposta
            self.reply(KL["RES_CTL"], bytes((req, 0, 1)) + out)
            self.push_event(bytes((2, h, 1, 0, node >> 8, node & 0xFF)))   # opening
            ok = nome != "ocupado"
            self.push_event(bytes((2, h, 2 if ok else 3, 0 if ok else 2, node >> 8, node & 0xFF)))
            return
        elif sub == S["HWRITE"]:
            h, d = body[0], body[1:]
            self.relay_ops = getattr(self, "relay_ops", []) + [d]
            if d[:1] == b"\x01":
                self.relay_state = d[1]
            elif d[:1] == b"\x02":
                self.push_event(bytes((3, h, 2, getattr(self, "relay_state", 0))))
            out = b""
        elif sub == S["ACCEPT"]:
            self.accepting = body[:1] == b"\x01"
            out = b""
        elif sub == S["INVITE"]:
            self.invited = body[1:].decode()
            out = b"\x01" if getattr(self, "bonded", False) else b"\x00"
        elif sub == S["INVITE_CODE"]:
            out = b"" if body == b"123456" else None
            self.code_used = body
        elif sub in (S["SNAP_AT"], S["REC_AT"], S["PLAY_AT"]):
            node = (body[0] << 8) | body[1]
            self.media = (sub, node, body[2:])
            h = 4
            self.reply(KL["RES_CTL"], bytes((req, 0, 1, h)))
            caminho = {S["SNAP_AT"]: C.PC_PATHS["PC_SNAP_PATH"], S["REC_AT"]: C.PC_PATHS["PC_REC_PATH"]}.get(sub)
            if caminho:
                self.files[caminho] = b"JPEGouWAV" * 10
            self.push_event(bytes((2, h, 1, 0, node >> 8, node & 0xFF)))
            self.push_event(bytes((2, h, 7, 0, node >> 8, node & 0xFF)))   # done
            return
        elif sub == S["HCLOSE"]:
            self.closed = body[0]
            out = b""
        if out is None:
            self.reply(KL["RES_CTL"], b"recusado", 1)
            return
        self.reply(KL["RES_CTL"], bytes((req, len(out) >> 8, len(out) & 0xFF)) + out)

    def push_event(self, ev, seq=0):
        """KL_RES_DATA nao-solicitado com sid 0 (evento do no virtual)."""
        payload = bytes((0, 0, seq >> 8, seq & 0xFF)) + ev
        self.ser.rx += frame_v2(KL["RES_DATA"], payload) if self.proto == 2 \
            else frame_v1(KL["RES_DATA"], payload)

    def op_20(self, p):  # STATS: foto de profiling (JSON)
        snap = self.stats_q.pop(0) if len(self.stats_q) > 1 else self.stats_q[0]
        self.reply(KL["STATS"], json.dumps(snap).encode())

    def op_06(self, p):  # WRITE_BEGIN
        self.wr_path = p.rstrip(b"\0").decode()
        self.wr_data = bytearray()
        self.wr_seq = 0
        self.wr_crc = 0
        self.reply(KL["WRITE_BEGIN"])

    def op_07(self, p):  # WRITE_CHUNK
        if self.wr_data is None:
            self.reply(KL["WRITE_CHUNK"], b"escrita nao iniciada", 1)
            return
        if self.proto == 2:
            (seq,) = struct.unpack("<H", p[:2])
            if seq != self.wr_seq:
                # duplicado/atrasado: ACK aponta o proximo esperado, sem aplicar
                self.reply(KL["WRITE_CHUNK"], struct.pack("<HI", self.wr_seq, len(self.wr_data)))
                return
            data = p[2:]
            self.wr_seq += 1
        else:
            data = p
        self.wr_data += data
        self.wr_crc = zlib.crc32(bytes(data), self.wr_crc) & 0xFFFFFFFF
        if self.proto == 2:
            self.reply(KL["WRITE_CHUNK"], struct.pack("<HI", self.wr_seq, len(self.wr_data)))
        else:
            self.reply(KL["WRITE_CHUNK"])

    def op_08(self, p):  # WRITE_END
        if self.wr_data is None:
            self.reply(KL["WRITE_END"], b"escrita nao iniciada", 1)
            return
        total = len(self.wr_data)
        if self.proto == 2:
            crc_host, size_host = struct.unpack("<II", p[:8]) if len(p) >= 8 else (0, 0xFFFFFFFF)
            if crc_host != self.wr_crc or size_host != total:
                self.wr_data = None
                self.reply(KL["WRITE_END"], b"crc/tamanho divergem no fim da escrita", 1)
                return
            self.files[self.wr_path] = bytes(self.wr_data)
            self.wr_data = None
            self.reply(KL["WRITE_END"], struct.pack("<II", total, self.wr_crc))
        else:
            self.files[self.wr_path] = bytes(self.wr_data)
            self.wr_data = None
            self.reply(KL["WRITE_END"], struct.pack("<I", total))

    def op_05(self, p):  # READ: path\0 + u32 offset + u32 want
        if getattr(self, "event_on_read", False):
            # o gateway empurra um evento do no virtual no meio do pull
            self.push_event(b"\x01\xbb\x02\x01W\x00ping")
        z = p.index(b"\0")
        path = p[:z].decode()
        off, want = struct.unpack("<II", p[z + 1:z + 9])
        data = self.files.get(path, b"")
        body = data[off:off + want]
        if self.proto == 2:
            self.reply(KL["READ"], struct.pack("<I", off) + body)
        else:
            self.reply(KL["READ"], body)

    def op_04(self, p):  # STAT: path -> exists,isDir,u32 size,u32 mtime
        path = p.rstrip(b"\0").decode()
        data = self.files.get(path)
        if data is None:
            self.reply(KL["STAT"], b"\x00")
        else:
            self.reply(KL["STAT"], struct.pack("<BBI", 1, 0, len(data)) + b"\0" * 4)

    def op_03(self, p):  # LS: path\0 [u32 cursor] -> [u32 next] u16 n + entradas
        z = p.index(b"\0")
        path = p[:z].decode()
        rest = p[z + 1:]
        names = sorted(self.dirs.get(path, []))
        if len(rest) >= 4:  # paginado
            (cursor,) = struct.unpack("<I", rest[:4])
            page = names[cursor:cursor + self.page_size]
            nxt = 0 if cursor + len(page) >= len(names) else cursor + len(page)
            head = struct.pack("<IH", nxt, len(page))
        else:  # pedido antigo: tudo num frame
            page = names
            head = struct.pack("<H", len(page))
        body = b""
        for name in page:
            data = self.files.get(f"{path}/{name}")
            rec = struct.pack("<BIIB", 0 if data is not None else 1,
                              len(data or b""), 0, len(name))
            body += rec + name.encode()
        self.reply(KL["LS"], head + body)

    def op_09(self, p):  # DELETE: path\0 [u8 1=recursivo]
        z = p.index(b"\0")
        path = p[:z].decode()
        recursive = p[z + 1:] == b"\x01"
        if recursive:
            for k in [k for k in self.files if k.startswith(path + "/")]:
                del self.files[k]
            for k in [k for k in self.dirs if k == path or k.startswith(path + "/")]:
                del self.dirs[k]
        else:
            self.files.pop(path, None)
            self.dirs.pop(path, None)
        self.reply(KL["DELETE"])

    def op_0a(self, p):  # MKDIR: path\0 — cria a cadeia inteira no modelo
        path = p.rstrip(b"\0").decode().strip("/")
        partes = path.split("/") if path else []
        for i in range(1, len(partes) + 1):
            d = "/" + "/".join(partes[:i])
            self.dirs.setdefault(d, [])
            if i > 1:
                pai = "/" + "/".join(partes[:i - 1])
                if partes[i - 1] not in self.dirs[pai]:
                    self.dirs[pai].append(partes[i - 1])
        self.reply(KL["MKDIR"])

    def op_0c(self, p):  # EXEC: cmdline -> u8 exit + u32 len + saida
        self.execs.append(p.rstrip(b"\0").decode())
        # payload: [status u8][exit u8][len u32] — o link.exec pula o 1o byte
        self.reply(KL["EXEC"], b"\x00\x00" + struct.pack("<I", 0))


class FakeSerial:
    def __init__(self, device):
        self.dev = device
        self.rx = b""
        self.timeout = 3.0
        self.port = "FAKE"
        self.baudrate = C.DEFAULT_BAUD

    def write(self, data):
        self.dev.on_bytes(data)
        return len(data)

    def read(self, n):
        out, self.rx = self.rx[:n], self.rx[n:]
        return out

    def reset_input_buffer(self):
        self.rx = b""

    def close(self):
        pass


def make_link(proto=2, chunk=4096, win=4):
    ser = FakeSerial(None)
    dev = FakeDevice(ser, proto=proto, chunk=chunk, win=win)
    ser.dev = dev
    link = C.HostLink.__new__(C.HostLink)  # sem porta real
    link.ser = ser
    link.timeout = 3.0
    link.push_queue = []
    link.proto = 1
    link.max_chunk = C.CHUNK
    link.win = 1
    link.exec_timeout = 5.0     # EXEC do "rescan" no caminho do install
    return link, dev


def tmpfile(payload):
    f = tempfile.NamedTemporaryFile(delete=False)
    f.write(payload)
    f.close()
    return f.name


class TestProto2(unittest.TestCase):
    def test_hello_negocia_v2(self):
        link, dev = make_link()
        ident = link.hello()
        self.assertEqual(link.proto, 2)
        self.assertEqual(link.max_chunk, 4096)
        self.assertEqual(link.win, 4)
        self.assertIn("proto 2", ident)

    def test_push_completo_e_crc(self):
        link, dev = make_link()
        link.hello()
        payload = bytes(range(256)) * 700  # 179200 bytes ~ 44 chunks
        path = tmpfile(payload)
        try:
            link.write_file(path, "/local/x.bin", progress=False)
        finally:
            os.unlink(path)
        self.assertEqual(dev.files["/local/x.bin"], payload)

    def test_push_com_chunk_perdido_recupera(self):
        link, dev = make_link()
        link.hello()
        payload = b"z" * 40000  # ~10 chunks
        path = tmpfile(payload)
        try:
            dev.drop_chunk = [3]  # o chunk 3 some no caminho (1x)
            link.write_file(path, "/local/y.bin", progress=False)
        finally:
            os.unlink(path)
        self.assertEqual(dev.files["/local/y.bin"], payload)  # sem buraco/duplicacao

    def test_push_com_corrupcao_cai_no_crc(self):
        link, dev = make_link()
        link.hello()
        payload = b"q" * 12000
        path = tmpfile(payload)
        try:
            dev.corrupt_chunk = [1]  # byte virado: CRC do frame rejeita, host reenvia
            link.write_file(path, "/local/z.bin", progress=False)
        finally:
            os.unlink(path)
        self.assertEqual(dev.files["/local/z.bin"], payload)

    def test_pull_pipelined(self):
        link, dev = make_link()
        link.hello()
        payload = bytes((i * 13) & 0xFF for i in range(60000))
        dev.files["/local/big.bin"] = payload
        fd, path = tempfile.mkstemp()
        os.close(fd)
        try:
            link.read_file("/local/big.bin", path, progress=False)
            with open(path, "rb") as f:
                self.assertEqual(f.read(), payload)
        finally:
            os.unlink(path)

    def test_pull_com_evento_do_no_virtual_no_meio(self):
        # bancada 2026-10-16: o gateway empurra KL_RES_DATA a qualquer hora e
        # os lacos de pull/screencap abortavam com "frame inesperado"
        link, dev = make_link()
        link.hello()
        dev.event_on_read = True
        payload = bytes((i * 7) & 0xFF for i in range(20000))
        dev.files["/local/x.bin"] = payload
        fd, path = tempfile.mkstemp()
        os.close(fd)
        try:
            link.read_file("/local/x.bin", path, progress=False)
            with open(path, "rb") as f:
                self.assertEqual(f.read(), payload)
            self.assertTrue(any(c == KL["RES_DATA"] for c, _ in link.push_queue))
        finally:
            os.unlink(path)

    def test_hold_mantem_a_sessao(self):
        link, dev = make_link()
        link.hello()
        n0 = getattr(dev, "hellos", 0)
        orig = dev.op_01

        def contando(p):
            dev.hellos = getattr(dev, "hellos", 0) + 1
            orig(p)
        dev.op_01 = contando
        link.KEEPALIVE_S = 0.2
        link.hold(1.0)
        self.assertGreaterEqual(getattr(dev, "hellos", 0) - n0, 3)

    def test_caminho_legado_proto1(self):
        # --proto 1 do CLI: host fala v1 de proposito com firmware novo
        C.FORCE_PROTO1 = True
        try:
            link, dev = make_link()
            link.hello()
            self.assertEqual(link.proto, 1)
            self.assertEqual(link.win, 1)
            payload = b"a" * 9000
            path = tmpfile(payload)
            try:
                link.write_file(path, "/local/v1.bin", progress=False)  # stop-and-wait
            finally:
                os.unlink(path)
            self.assertEqual(dev.files["/local/v1.bin"], payload)
            # pull v1 (stop-and-wait) tambem fecha
            dev.files["/local/b.bin"] = payload
            fd, path = tempfile.mkstemp()
            os.close(fd)
            try:
                link.read_file("/local/b.bin", path, progress=False)
                with open(path, "rb") as f:
                    self.assertEqual(f.read(), payload)
            finally:
                os.unlink(path)
        finally:
            C.FORCE_PROTO1 = False


    def test_ls_paginado_e_rm_recursivo(self):
        link, dev = make_link()
        link.hello()
        dev.page_size = 5  # forca 3 paginas
        names = [f"app{i:02d}" for i in range(12)]
        dev.dirs["/local/apps"] = list(names)
        for i, n in enumerate(names):
            dev.files[f"/local/apps/{n}"] = b"x" * i
        entries = link.ls("/local/apps")
        self.assertEqual([e["name"] for e in entries], names)
        self.assertTrue(all(not e["dir"] for e in entries))
        # rm -r: um comando apaga a arvore inteira
        link.delete("/local/apps", recursive=True)
        self.assertNotIn("/local/apps", dev.dirs)
        self.assertEqual([k for k in dev.files if k.startswith("/local/apps/")], [])


class TestOta(unittest.TestCase):
    """Quedas da OTA vistas na bancada (2026-10-07/08) contra o FakeDevice."""

    def _ota(self, dev_setup=None, size=20000):
        link, dev = make_link()
        link.hello()
        link.ota_end_timeout = 0.3
        if dev_setup:
            dev_setup(dev)
        img = bytes((i * 7) % 251 for i in range(size))
        path = tmpfile(img)
        try:
            out = link.ota_write(path, progress=False)
        finally:
            os.unlink(path)
        return out, dev, img

    def test_ota_completa(self):
        (part, written), dev, img = self._ota()
        self.assertEqual((part, written), ("app1", len(img)))
        self.assertEqual(bytes(dev.ota), img)

    def test_ruido_do_parser_reenvia_e_nao_aborta(self):
        def setup(dev):
            dev.ota_noise_at = [2]   # a 2a janela ve o frame de lixo (cmd 0xa6)
        (part, written), dev, img = self._ota(setup)
        self.assertEqual(bytes(dev.ota), img)              # imagem intacta
        self.assertNotIn("ABORT", dev.ota_ops)

    def test_resposta_do_end_perdida_e_confirmada_no_reenvio(self):
        def setup(dev):
            dev.end_reply_lost = 1
        (part, written), dev, img = self._ota(setup)
        self.assertEqual(written, len(img))
        self.assertEqual(dev.ota_ops.count("END"), 2)      # reenviou o END
        self.assertNotIn("ABORT", dev.ota_ops)

    def test_end_perdido_em_firmware_antigo_nao_aborta(self):
        def setup(dev):
            dev.end_reply_lost = 1
            dev.end_idempotent = False
        with self.assertRaises(C.OtaEndUnknown):
            self._ota(setup)

    def test_stable_port_resolve_by_id(self):
        self.assertEqual(C.stable_port("192.168.0.9"), "192.168.0.9")
        self.assertEqual(C.stable_port("/dev/nao-existe-xyz"), "/dev/nao-existe-xyz")


class TestDebugProxy(unittest.TestCase):
    """split_frames: o leitor nao-bloqueante do `celerctl debug`."""

    def test_frames_inteiros_e_lixo_de_console(self):
        dbg = KL["DEBUG_DATA"]
        wire = b"I (123) wifi: texto do console\r\n" + frame_v2(dbg, b"\x04\x81\x01\x00") + frame_v2(dbg, b"abc")
        frames, rest = C.split_frames(wire, 2)
        self.assertEqual(frames, [(dbg, b"\x04\x81\x01\x00"), (dbg, b"abc")])
        self.assertEqual(rest, b"")

    def test_frame_pela_metade_espera_o_resto(self):
        dbg = KL["DEBUG_DATA"]
        full = frame_v2(dbg, bytes(range(200)))
        got, buf = [], b""
        for i in range(len(full)):  # byte a byte: nada se perde no meio
            buf += full[i:i + 1]
            frames, buf = C.split_frames(buf, 2)
            got += frames
        self.assertEqual(got, [(dbg, bytes(range(200)))])

    def test_crc_errado_descarta_e_resincroniza(self):
        dbg = KL["DEBUG_DATA"]
        bad = bytearray(frame_v2(dbg, b"xyz"))
        bad[-1] ^= 0xFF
        frames, rest = C.split_frames(bytes(bad) + frame_v2(dbg, b"ok"), 2)
        self.assertEqual(frames, [(dbg, b"ok")])

    def test_keep_push_nao_perde_frames_do_debugger(self):
        # attach do app chega ENTRE dois comandos: o xfer seguinte nao pode
        # limpar a entrada/fila, e a resposta velha do keepalive e descartada
        link, dev = make_link()
        link.hello()
        link.keep_push = True
        dbg = frame_v2(KL["DEBUG_DATA"], b"2 20700 v2.7.0 alvo\n")
        stale = frame_v2(KL["HELLO"], b"proto 2", status=0)
        link.ser.rx += dbg + stale
        link.xfer(KL["WRITE_BEGIN"], b"/local/x\0")
        self.assertEqual(link.push_queue, [(KL["DEBUG_DATA"], b"2 20700 v2.7.0 alvo\n")])

    def test_sem_keep_push_continua_limpando(self):
        link, dev = make_link()
        link.hello()
        link.ser.rx += frame_v2(KL["DEBUG_DATA"], b"x")
        link.xfer(KL["WRITE_BEGIN"], b"/local/x\0")
        self.assertEqual(link.push_queue, [])

    def test_proto1(self):
        frames, _ = C.split_frames(frame_v1(KL["LOG_DATA"], b"\x00linha\n"), 1)
        self.assertEqual(frames, [(KL["LOG_DATA"], b"\x00linha\n")])


class TestStats(unittest.TestCase):
    """KL_STATS (celerctl top/stats): round-trip do protocolo e a matematica
    de delta (CPU% por task, fps, busy%) feita no host."""

    def test_stats_round_trip(self):
        link, dev = make_link()
        link.hello()
        snap = link.stats()
        self.assertEqual(snap["uptime_us"], 60_000_000)
        self.assertEqual(snap["heap"]["psram_total"], 8_000_000)
        self.assertEqual(len(snap["tasks"]), 3)
        self.assertEqual(snap["tasks"][0]["n"], "main")

    def test_delta_cpu_por_task(self):
        rows, total = C._task_rows(STATS_SNAP_A, STATS_SNAP_B)
        self.assertEqual(total, 1_060_000)  # 56.060.000 - 55.000.000
        by_name = {r["n"]: r for r in rows}
        self.assertEqual(by_name["IDLE0"]["drt"], 1_000_000)
        self.assertAlmostEqual(by_name["IDLE0"]["cpu"], 100.0 * 1_000_000 / 1_060_000)
        self.assertEqual(by_name["main"]["drt"], 50_000)
        self.assertEqual(by_name["wifi"]["drt"], 0)  # nada rodou na janela
        self.assertEqual(by_name["nova"]["drt"], 10_000)  # nasceu: base 0
        # soma das taxas ~ nucleos x 100 (2 cores)
        self.assertAlmostEqual(sum(r["cpu"] for r in rows), 100.0 * 1_060_000 / 1_060_000)

    def test_render_top(self):
        text = C._render_top(STATS_SNAP_A, STATS_SNAP_B, 0.3)
        self.assertIn("CPU 240 MHz", text)
        self.assertIn("janela 300 ms", text)
        self.assertIn("PSRAM", text)
        self.assertIn("app JS", text)  # js.active
        # ordenado por CPU: IDLE0 (janela dominante) antes de main
        self.assertLess(text.index("IDLE0"), text.index("main"))
        # taxa da UI na janela: 7 quadros em 300ms ~ 23 fps
        self.assertIn("23 fps", text)
        # task nascida na janela aparece
        self.assertIn("nova", text)

    def test_render_top_limite_e_ordenacao(self):
        text = C._render_top(STATS_SNAP_A, STATS_SNAP_B, 0.3, sort="stack", limit=2)
        self.assertNotIn("main", text)  # maior stack: cortada pelo -n 2
        # stack crescente: IDLE0 (890) antes de nova (2048)
        self.assertLess(text.index("IDLE0"), text.index("nova"))

    def test_resumo_loop_parado_sem_app(self):
        # sem foto anterior e sem app: nao renderiza linhas de taxa
        a = dict(STATS_SNAP_A, js={"active": 0, "launch_free": 0, "now_free": 0,
                                  "allocs": 0, "allocs_peak": 0})
        lines = C._summary_lines(a)
        self.assertTrue(any("heap" in ln for ln in lines))
        self.assertFalse(any("app JS" in ln for ln in lines))

    def test_firmware_antigo_recusado_com_mensagem(self):
        link, dev = make_link()
        link.hello()
        # firmware anterior a rodada: responde "opcode desconhecido"
        dev.op_20 = lambda p: dev.reply(KL["STATS"], b"opcode desconhecido", 1)
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit):
            C._poll_stats(link)
        self.assertIn("firmware antigo", err.getvalue())


class TestMeshPeloCabo(unittest.TestCase):
    """API 40: a matilha pelo cabo (KL_RES_CTL SUB_JOIN/LEAVE/NET) e os
    subops lidos do UsbRes.h (fonte unica, como os KL_*)."""

    def test_subops_do_header(self):
        self.assertEqual(C.SUB["DESCRIBE"], 1)
        self.assertEqual(C.SUB["WRITE"], 7)
        self.assertEqual((C.SUB["JOIN"], C.SUB["LEAVE"], C.SUB["NET"]), (8, 9, 10))

    def test_corpo_do_join(self):
        self.assertEqual(C.mesh_join_body("ab", "12345678"), b"\x02ab\x0812345678")
        with self.assertRaises(C.CelerError):
            C.mesh_join_body("", "12345678")
        with self.assertRaises(C.CelerError):
            C.mesh_join_body("x" * 16, "12345678")
        with self.assertRaises(C.CelerError):
            C.mesh_join_body("ab", "curta")

    def _run(self, link, argv):
        args = C.build_parser().parse_args(argv)
        orig = C.open_link
        C.open_link = lambda a: link
        try:
            out = io.StringIO()
            from contextlib import redirect_stdout
            with redirect_stdout(out):
                args.func(args)
            return out.getvalue()
        finally:
            C.open_link = orig

    def test_join_status_leave(self):
        link, dev = make_link()
        link.hello()
        out = self._run(link, ["mesh", "join", "bancada", "senha-forte-1"])
        self.assertEqual(dev.joined, (b"bancada", b"senha-forte-1"))
        self.assertIn('matilha "bancada"', out)
        self.assertIn("PC aqui = FFAE", out)
        st = json.loads(self._run(link, ["mesh", "--json", "status"]))
        self.assertEqual((st["net"], st["prov"]), ("bancada", 1))
        out = self._run(link, ["mesh", "leave"])
        self.assertIn('rede aberta "celer"', out)

    def test_res_ls_usa_os_subops(self):
        link, dev = make_link()
        link.hello()
        out = self._run(link, ["res", "ls"])
        self.assertIn("Celer-1CAE (1CAE) test api 40", out)

    def test_evento_parse(self):
        ev = C.parse_res_event(b"\x01\xbb\x02\x01W\x00oi")
        self.assertEqual(ev, {"ev": "msg", "from": "BB02", "fromName": "W", "raw": False, "data": b"oi"})
        ev = C.parse_res_event(b"\x02\x03\x03\x02\x1c\xae")
        self.assertEqual((ev["state"], ev["reason"], ev["node"]), ("refused", "busy", "1CAE"))
        self.assertEqual(C.parse_res_event(b"\x03\x01\x02\x01")["data"], b"\x02\x01")
        self.assertIsNone(C.parse_res_event(b""))

    def test_mesh_send_para_o_gateway_e_id(self):
        link, dev = make_link()
        link.hello()
        self._run(link, ["mesh", "send", "gw", "oi"])
        self._run(link, ["mesh", "send", "BB02", "ola"])
        self.assertEqual(dev.sent, [(0x1CAE, b"oi"), (0xBB02, b"ola")])

    def test_mesh_listen_mostra_eventos(self):
        link, dev = make_link()
        link.hello()
        dev.push_event(b"\x01\xbb\x02\x01W\x00oi pc")
        dev.push_event(b"\x01\xbb\x02\x01W\x01cru")
        out = self._run(link, ["mesh", "listen", "1"])
        self.assertIn("W (BB02): oi pc", out)
        self.assertIn("W (BB02) [cru]: cru", out)

    def test_rele_de_outro_no_por_procuracao(self):
        link, dev = make_link()
        link.hello()
        out = self._run(link, ["res", "relay", "-n", "BB02", "rele1", "on"])
        self.assertEqual(dev.opened, (0xBB02, "rele1", '{"off": 1}'))
        self.assertEqual(dev.relay_ops, [b"\x01\x01", b"\x02"])
        self.assertIn("leitura: estado 1", out)
        self.assertEqual(dev.closed, 3)

    def test_recusa_do_dono_vira_erro(self):
        link, dev = make_link()
        link.hello()
        with self.assertRaises(C.CelerError) as cm:
            link.res_open_at(0xBB02, "ocupado")
        self.assertIn("busy", str(cm.exception))

    def test_convite_com_codigo(self):
        link, dev = make_link()
        link.hello()
        out = self._run(link, ["mesh", "invite", "Celer-AB3E", "--codigo", "123456"])
        self.assertEqual((dev.invited, dev.code_used), ("Celer-AB3E", b"123456"))
        self.assertIn("entrou na matilha", out)

    def test_convite_com_bond_dispensa_codigo(self):
        # bancada 2026-10-16: 2o convite entre as mesmas placas (bond do 1o)
        link, dev = make_link()
        link.hello()
        dev.bonded = True
        out = self._run(link, ["mesh", "invite", "Celer-AB3E"])  # sem --codigo: nao pergunta
        self.assertIn("sem codigo", out)
        self.assertFalse(hasattr(dev, "code_used"))

    def test_codigo_errado_vira_erro(self):
        link, dev = make_link()
        link.hello()
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit):
            self._run(link, ["mesh", "invite", "X", "--codigo", "000000"])

    def test_accept(self):
        link, dev = make_link()
        link.hello()
        self._run(link, ["mesh", "accept"])
        self.assertTrue(dev.accepting)
        self._run(link, ["mesh", "accept", "off"])
        self.assertFalse(dev.accepting)

    def test_snap_por_procuracao_baixa_e_apaga(self):
        link, dev = make_link()
        link.hello()
        fd, saida = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        try:
            self._run(link, ["res", "snap", "-n", "5C26", saida, "-q", "20"])
            self.assertEqual(dev.media, (C.SUB["SNAP_AT"], 0x5C26, b"\x14"))
            with open(saida, "rb") as f:
                self.assertEqual(f.read(), b"JPEGouWAV" * 10)
        finally:
            os.unlink(saida)

    def test_wav_vira_pcm16k_mono(self):
        import wave
        fd, path = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            with wave.open(path, "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(32000)
                w.writeframes(struct.pack("<" + "hh" * 320, *([1000, 3000] * 320)))
            pcm = C.wav_to_pcm16k(path)
            amostras = struct.unpack("<%dh" % (len(pcm) // 2), pcm)
            self.assertEqual(len(amostras), 160)          # 32 kHz -> 16 kHz
            self.assertTrue(all(a == 2000 for a in amostras))  # media do estereo
        finally:
            os.unlink(path)

    def test_firmware_antigo_orienta_o_shell(self):
        link, dev = make_link()
        link.hello()
        dev.op_21 = lambda p: dev.reply(KL["RES_CTL"], b"recusado", 1)
        err = io.StringIO()
        with redirect_stderr(err), self.assertRaises(SystemExit):
            self._run(link, ["mesh", "status"])
        self.assertIn("shell mesh join", err.getvalue())


# ---------------------------------------------------------------- bridge WiFi
# Celer Debug Bridge: servidor TCP de verdade em 127.0.0.1 fazendo o
# handshake do firmware (banner + AUTH por token) e casando com o FakeDevice
# — valida o NetTransport do celerctl sem hardware.

class SockSerial:
    """FakeSerial conversando por socket: o reply() do device vira sendall."""

    def __init__(self, conn):
        self.conn = conn
        self.dev = None
        self.port = "FAKE_TCP"
        self.baudrate = None  # como o bridge: sem baud
        self.timeout = 3.0
        self.rx = b""

    def write(self, data):
        self.dev.on_bytes(data)
        if self.rx:
            out, self.rx = self.rx, b""
            self.conn.sendall(out)
        return len(data)

    def read(self, n):
        return self.conn.recv(n)

    def reset_input_buffer(self):
        pass

    def close(self):
        try:
            self.conn.close()
        except OSError:
            pass


class FakeBridge(threading.Thread):
    """Espelho do main/USBDevice/DebugBridge.cpp: banner "CELERBRIDGE 1",
    AUTH com 3 tentativas (NO/NO/ERR) e pipe binario para o FakeDevice.
    O 5o campo do banner e a identidade do device (MAC; devid=None emula
    firmware antigo, sem o campo)."""

    TOKEN = "tok12345"
    DEVID = "aabbccddeeff"

    def __init__(self, proto=2, chunk=4096, win=4, devid=DEVID):
        super().__init__(daemon=True)
        self.proto = proto
        self.chunk = chunk
        self.win = win
        self.devid = devid
        self.auth_fails = []
        self.dev = None
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(2)
        self.srv.settimeout(10.0)
        self.port = self.srv.getsockname()[1]

    def run(self):
        try:
            conn, _ = self.srv.accept()
        except OSError:
            return
        with conn:
            banner = f"CELERBRIDGE 1 test 127.0.0.1 {self.port}"
            if self.devid:
                banner += f" {self.devid}"
            conn.sendall((banner + "\n").encode())
            if not self._auth(conn):
                return
            ser = SockSerial(conn)
            dev = FakeDevice(ser, proto=self.proto, chunk=self.chunk, win=self.win)
            ser.dev = dev
            self.dev = dev
            self._pipe(conn, ser)

    def _auth(self, conn):
        buf = b""
        fails = 0
        deadline = time.monotonic() + 5.0
        conn.settimeout(0.25)
        while time.monotonic() < deadline:
            try:
                data = conn.recv(64)
            except socket.timeout:
                continue
            if not data:
                return False
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                text = line.decode().strip()
                if text == f"AUTH {self.TOKEN}":
                    conn.sendall(b"OK\n")
                    return True
                self.auth_fails.append(text)
                fails += 1
                if fails >= 3:
                    conn.sendall(b"ERR\n")
                    return False
                conn.sendall(b"NO\n")
        return False

    def _pipe(self, conn, ser):
        # frames chegam inteiros no loopback (1 sendall = 1 recv), mas o
        # remontador custa pouco e cobre o caso de o kernel partir mesmo assim
        pending = b""
        first = True
        conn.settimeout(10.0)
        while True:
            try:
                data = conn.recv(65536)
            except OSError:
                return
            if not data:
                return
            pending += data
            while len(pending) >= 4:
                (ln,) = struct.unpack("<H", pending[2:4])
                v2 = (not first) and ser.dev.proto == 2
                total = (8 if v2 else 4) + ln
                if len(pending) < total:
                    break
                frame, pending = pending[:total], pending[total:]
                first = False
                ser.write(frame)


class TestNetBridge(unittest.TestCase):

    def setUp(self):
        # cache de tokens num tmp: nao suja o ~/.config de quem roda o teste
        self.tmp = tempfile.mkdtemp()
        self.old_xdg = os.environ.get("XDG_CONFIG_HOME")
        os.environ["XDG_CONFIG_HOME"] = self.tmp
        self.old_env_tok = os.environ.get("CELEROS_BRIDGE_TOKEN")
        os.environ.pop("CELEROS_BRIDGE_TOKEN", None)

    def tearDown(self):
        if self.old_xdg is None:
            os.environ.pop("XDG_CONFIG_HOME", None)
        else:
            os.environ["XDG_CONFIG_HOME"] = self.old_xdg
        if self.old_env_tok is not None:
            os.environ["CELEROS_BRIDGE_TOKEN"] = self.old_env_tok

    def start(self, **kw):
        br = FakeBridge(**kw)
        br.start()
        return br

    def test_endereco(self):
        self.assertTrue(C.is_net_addr("192.168.0.10"))
        self.assertTrue(C.is_net_addr("10.0.0.2:5555"))
        self.assertFalse(C.is_net_addr("/dev/ttyUSB0"))
        self.assertFalse(C.is_net_addr("K303AE"))  # serial-prefixo do S3
        self.assertEqual(C.split_net_addr("192.168.0.10"), ("192.168.0.10", 5555))
        self.assertEqual(C.normalize_net_addr("192.168.0.10"), "192.168.0.10:5555")

    def test_token_cache(self):
        addr = "192.168.0.10:5555"
        C.save_token(addr, "cache123")
        self.assertEqual(C.load_token_cache().get(addr), "cache123")
        self.assertEqual(C.net_token(addr, prompt=False), "cache123")
        os.environ["CELEROS_BRIDGE_TOKEN"] = "env123"
        self.assertEqual(C.net_token(addr, prompt=False), "env123")  # env vence
        os.environ.pop("CELEROS_BRIDGE_TOKEN", None)
        with self.assertRaises(C.CelerError):
            C.net_token("10.9.9.9:5555", prompt=False)  # sem cache, sem prompt

    def test_auth_e_hello_proto2(self):
        br = self.start()
        link = C.HostLink(f"127.0.0.1:{br.port}", token=FakeBridge.TOKEN)
        try:
            ident = link.hello()
            self.assertIn("proto 2", ident)
            self.assertIn("win 4", ident)
        finally:
            link.close()

    def test_token_errado_recusado(self):
        br = self.start()
        with self.assertRaises(C.CelerError) as ctx:
            C.HostLink(f"127.0.0.1:{br.port}", token="token-errado")
        self.assertIn("auth", str(ctx.exception))
        self.assertEqual(br.auth_fails, ["AUTH token-errado"])

    def test_banner_de_outro_servico(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        srv.settimeout(5.0)
        port = srv.getsockname()[1]

        def say_hi():
            conn, _ = srv.accept()
            conn.sendall(b"SSH-2.0-OpenSSH\r\n")
            conn.close()

        threading.Thread(target=say_hi, daemon=True).start()
        with self.assertRaises(C.CelerError):
            C.HostLink(f"127.0.0.1:{port}", token="x")

    # ---- identidade no banner (id do device; ver DebugBridge.cpp macId) ----

    def test_parse_do_id(self):
        self.assertEqual(C.banner_devid("CELERBRIDGE 1 b 10.0.0.5 5555 aabbccddeeff"),
                         "aabbccddeeff")
        self.assertIsNone(C.banner_devid("CELERBRIDGE 1 b 10.0.0.5 5555"))  # fw antigo
        self.assertEqual(C.probe_devid("CELEROS 1.8.2|b|api 36|proto 2|tcp 5555|id AA1122334455"),
                         "aa1122334455")
        self.assertIsNone(C.probe_devid("CELEROS 1.8.2|b|api 36|proto 2|tcp 5555"))

    def test_fw_antigo_sem_id_continua_pelo_token_do_endereco(self):
        br = self.start(devid=None)
        addr = f"127.0.0.1:{br.port}"
        C.save_token(addr, FakeBridge.TOKEN)
        link = C.HostLink(addr)  # sem --token: so existe a chave do endereco
        try:
            self.assertIn("proto 2", link.hello())
        finally:
            link.close()

    def test_ip_mudou_autentica_pela_identidade_e_rekey(self):
        # device pareado no endereco antigo; DHCP mudou o IP (porta nova aqui)
        C.save_token("192.168.0.99:5555", FakeBridge.TOKEN, FakeBridge.DEVID)
        br = self.start()
        addr = f"127.0.0.1:{br.port}"
        link = C.HostLink(addr, prompt=False)  # cache do endereco novo: vazio
        try:
            self.assertIn("proto 2", link.hello())
        finally:
            link.close()
        cache = C.load_token_cache()
        self.assertEqual(cache.get(addr), FakeBridge.TOKEN)        # re-key
        self.assertEqual(cache.get("id:" + FakeBridge.DEVID), FakeBridge.TOKEN)

    def test_token_do_endereco_errado_cai_no_da_identidade(self):
        br = self.start()
        addr = f"127.0.0.1:{br.port}"
        C.save_token(addr, "digitado-trocado")                     # o typo da bancada
        C.save_token("id:" + FakeBridge.DEVID, FakeBridge.TOKEN)   # e a cura
        link = C.HostLink(addr)
        try:
            self.assertIn("proto 2", link.hello())
        finally:
            link.close()
        self.assertEqual(br.auth_fails, ["AUTH digitado-trocado"])  # 1 falha, 2a valendo
        self.assertEqual(C.load_token_cache().get(addr), FakeBridge.TOKEN)

    def test_token_rotacionado_no_device_orienta_o_pair(self):
        # "bridge reset" no device: o cache inteiro (endereco e identidade)
        # ficou velho — a mensagem tem que apontar para o pair
        br = self.start()
        addr = f"127.0.0.1:{br.port}"
        C.save_token(addr, "velho", FakeBridge.DEVID)
        with self.assertRaises(C.CelerError) as ctx:
            C.HostLink(addr)
        self.assertIn("celerctl pair", str(ctx.exception))
        self.assertEqual(br.auth_fails, ["AUTH velho"])

    def test_push_e_pull_por_tcp(self):
        br = self.start()
        link = C.HostLink(f"127.0.0.1:{br.port}", token=FakeBridge.TOKEN)
        try:
            link.hello()
            payload = os.urandom(9000)  # ~2 chunks com janela 4
            src = tmpfile(payload)
            link.write_file(src, "/local/arquivo.bin", progress=False)
            self.assertEqual(br.dev.files["/local/arquivo.bin"], payload)
            dest = os.path.join(self.tmp, "volta.bin")
            link.read_file("/local/arquivo.bin", dest, progress=False)
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), payload)
        finally:
            link.close()

    def test_sem_token_nao_pergunta_em_probe(self):
        br = self.start()
        # probe (devices): prompt=False -> falha limpa, sem travar no input()
        self.assertIsNone(C.probe(f"127.0.0.1:{br.port}", fast=True))


class TestAppsDeps(unittest.TestCase):
    """apps deps: o plano de GC do cache /local/modules e a listagem E2E
    contra o FakeDevice (LS/STAT/READ/DELETE)."""

    def test_poda_so_raizes(self):
        # dir obsoleto sai inteiro: filhos nao viram tentativa (nem "falha")
        remote = {"velho": True, "velho/a.png": False, "velho/sub": True,
                  "velho/sub/b.png": False, "lixo.js": False, "assets": True}
        stale = ["velho", "velho/a.png", "velho/sub", "velho/sub/b.png", "lixo.js"]
        self.assertEqual(C._poda_raizes(stale, remote), ["lixo.js", "velho"])
        # prefixo de nome nao e filho: "velhona" nao cai junto com "velho"
        remote2 = {"velho": True, "velhona.js": False}
        self.assertEqual(C._poda_raizes(["velho", "velhona.js"], remote2), ["velho", "velhona.js"])

    def test_deps_local_do_sdk(self):
        # --deps-local: tools/sdk/engine entra no indice com a versao do modulo
        # (forma objeto `version: 'x'` OU atribuicao `E.version = 'x'` do shim)
        loc = C._local_sdk_deps()
        eng = (Path(C.__file__).resolve().parent / "sdk" / "engine" / "celeros.engine.js").read_text()
        ver = re.search(r"version\s*[:=]\s*'([0-9.]+)'", eng).group(1)
        self.assertIn(ver, loc["celeros.engine"])
        self.assertTrue(loc["celeros.engine"][ver]["_local"].endswith("celeros.engine.js"))
        # familia CelerGame: as arestas do index.json viajam no indice local
        # (o resolve do install instala as transitivas junto)
        self.assertEqual(loc["celeros.engine"][ver]["deps"].get("celeros.game"), "^1.0.0")
        fxv = re.search(r"version\s*[:=]\s*'([0-9.]+)'",
                        (Path(C.__file__).resolve().parent / "sdk" / "engine" /
                         "celeros.game.fx.js").read_text()).group(1)
        self.assertEqual(loc["celeros.game.fx"][fxv]["deps"], {"celeros.game": "^1.0.0"})
        self.assertIn("celeros.game", loc)
        # local mais novo vence o hub na mesma resolucao; mais velho nao
        # (indice com a familia INTEIRA do SDK local: o resolve segue as
        # arestas do engine e acha celeros.game* no indice)
        import celerhub
        idx = {"celeros.engine": {"1.0.0": {"url": "x", "deps": {}}}}
        for name, vers in loc.items():
            for v, m in vers.items():
                idx.setdefault(name, {}).setdefault(v, m)
        self.assertEqual(celerhub.resolve_dep_ranges({"celeros.engine": "^1.0.0"}, idx)["celeros.engine"], ver)
        # e o fecho transitivo do engine traz a familia junto (a versao e a
        # do proprio modulo do repo — nao fixar na mao: o bump da engine
        # quebra a expectativa chumbada)
        game = (Path(C.__file__).resolve().parent / "sdk" / "engine" / "celeros.game.js").read_text()
        gver = re.search(r"version\s*[:=]\s*'([0-9.]+)'", game).group(1)
        self.assertEqual(celerhub.resolve_dep_ranges({"celeros.engine": "^1.0.0"}, idx)["celeros.game"], gver)
        idx["celeros.engine"]["1.99.0"] = {"url": "y", "deps": {}}
        self.assertEqual(celerhub.resolve_dep_ranges({"celeros.engine": "^1.0.0"}, idx)["celeros.engine"], "1.99.0")

    def test_gc_plan_puro(self):
        modules = {"celeros.engine": {"1.2.1": 32000, "1.2.2": 32000},
                   "celeros.physics": {"1.4.0": 15000}}
        refs = {"Meu Jogo": {"celeros.engine": "1.2.1"},
                "Fisica": {"celeros.physics": "1.4.0", "celeros.engine": "9.9.9"}}
        orfas, ausentes, em_uso = C._gc_plan(modules, refs)
        # 1.2.2 nao tem dono; 9.9.9 nao esta no cache
        self.assertEqual(orfas, [("celeros.engine", "1.2.2")])
        self.assertEqual(ausentes, [("Fisica", "celeros.engine", "9.9.9")])
        self.assertEqual(em_uso, [("celeros.engine", "1.2.1"), ("celeros.physics", "1.4.0")])
        # sem orfas e sem ausentes: so o em_uso
        o2, a2, u2 = C._gc_plan({"m": {"1": 5}}, {"App": {"m": "1"}})
        self.assertEqual((o2, a2, u2), ([], [], [("m", "1")]))
        # app sem deps.json (refs vazio): tudo orfao
        o3, _, _ = C._gc_plan({"m": {"1": 5}}, {})
        self.assertEqual(o3, [("m", "1")])

    def _populate(self, dev):
        dev.dirs["/local/modules"] = ["celeros.engine"]
        dev.dirs["/local/modules/celeros.engine"] = ["1.2.1", "1.2.2"]
        dev.dirs["/local/apps"] = ["Meu Jogo"]
        js = b"var E = { version: 'x' };"
        dev.files["/local/modules/celeros.engine/1.2.1/celeros.engine.js"] = js
        dev.files["/local/modules/celeros.engine/1.2.2/celeros.engine.js"] = js
        dev.files["/local/apps/Meu Jogo/deps.json"] = b'{"celeros.engine": "1.2.1"}'

    def test_apps_deps_lista_uso_e_orfa(self):
        from types import SimpleNamespace
        import contextlib
        link, dev = make_link()
        link.hello()
        self._populate(dev)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            C._apps_deps(link, SimpleNamespace(gc=False, yes=False))
        texto = out.getvalue()
        self.assertIn("em uso: Meu Jogo", texto)
        self.assertIn("1.2.2", texto)
        self.assertIn("ORFA", texto)
        self.assertIn("--gc --yes", texto)

    def test_apps_deps_gc_remove_so_a_orfa(self):
        from types import SimpleNamespace
        import contextlib
        link, dev = make_link()
        link.hello()
        self._populate(dev)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            C._apps_deps(link, SimpleNamespace(gc=True, yes=True))
        self.assertIn("removida: celeros.engine 1.2.2", texto := out.getvalue())
        self.assertIn("/local/modules/celeros.engine/1.2.1/celeros.engine.js", dev.files)
        self.assertNotIn("/local/modules/celeros.engine/1.2.2/celeros.engine.js", dev.files)
        # a pasta do nome segue (ainda tem a 1.2.1 em uso)
        self.assertIn("/local/modules/celeros.engine", dev.dirs)

    def test_apps_deps_gc_sem_yes_recusa(self):
        from types import SimpleNamespace
        import contextlib
        link, dev = make_link()
        link.hello()
        self._populate(dev)
        err = io.StringIO()
        with redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                C._apps_deps(link, SimpleNamespace(gc=True, yes=False))
        self.assertIn("--yes", err.getvalue())
        # nada foi apagado
        self.assertIn("/local/modules/celeros.engine/1.2.2/celeros.engine.js", dev.files)


class TestV2Phys(unittest.TestCase):
    """tap --v: coordenada virtual do app (240x320) -> fisica do vidro —
    a conta que era feita de cabeca em toda placa da bancada."""

    def test_480x480(self):
        self.assertEqual(C._v2phys(120, 292, 480, 480), (240, 438))

    def test_320x240_cyd(self):
        self.assertEqual(C._v2phys(120, 160, 320, 240), (160, 120))

    def test_quinas_e_inteiro(self):
        self.assertEqual(C._v2phys(0, 0, 480, 480), (0, 0))
        self.assertEqual(C._v2phys(240, 320, 480, 480), (480, 480))
        x, y = C._v2phys(113, 199, 480, 480)
        self.assertIsInstance(x, int)
        self.assertIsInstance(y, int)


class TestAppsStore(unittest.TestCase):
    """`apps store PKG`: o caminho da loja sem UI — catalogo -> arquivos ->
    lint/push/deps — contra um hub HTTP local e o FakeDevice."""

    def setUp(self):
        main = b"var app = 1;\n"
        lib = b"var lib = 2;\n"
        dep = b"var E = { version: '9.9.9' };\nmodule.exports = E;\n"
        icon = b"\x89PNG-fake\x00"
        appjson = {
            "name": "Demo", "packageName": "celeros.demo", "version": "1.0.0",
            "api": 33, "deps": {"celeros.engine": "^9.9.0"},
        }
        rota = {
            "/store/all.json": json.dumps({"apps": {
                "celeros.demo": {
                    "name": "Demo!", "version": "1.0.0", "api": 33,
                    "size": len(main),
                    "meta": "/store/apps/celeros.demo/app.json",
                    "app": "/store/apps/celeros.demo/main.js",
                    "md5": hashlib.md5(main).hexdigest(),
                    "icon": "/store/apps/celeros.demo/icon.png",
                    "files": {"lib.js": {"size": len(lib),
                                          "md5": hashlib.md5(lib).hexdigest()}},
                }}}).encode(),
            "/store/apps/celeros.demo/app.json": json.dumps(appjson).encode(),
            "/store/apps/celeros.demo/main.js": main,
            "/store/apps/celeros.demo/lib.js": lib,
            "/store/apps/celeros.demo/icon.png": icon,
        }
        dep_base = "http://127.0.0.1:%d" % 0  # remontado abaixo com a porta
        dep_entry = {"9.9.9": {"size": len(dep), "md5": hashlib.md5(dep).hexdigest(),
                               "url": "PENDING"}}
        rota["/store/deps.json"] = json.dumps({"deps": {"celeros.engine": dep_entry}}).encode()
        self.rota = rota
        self.main, self.lib, self.dep, self.icon = main, lib, dep, icon

        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        rota_ref = self.rota

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                # url absoluta da dep precisa da porta real: remonta na hora
                if self.path.startswith("/dep/celeros.engine.js"):
                    corpo = rota_ref["/dep/celeros.engine.js"]
                else:
                    corpo = rota_ref.get(self.path)
                if corpo is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(corpo)))
                self.end_headers()
                self.wfile.write(corpo)

            def log_message(self, *a):  # silencia o stderr do servidor
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        porta = self.httpd.server_address[1]
        rota["/store/deps.json"] = json.dumps({"deps": {"celeros.engine": {
            "9.9.9": {"size": len(dep), "md5": hashlib.md5(dep).hexdigest(),
                      "url": f"http://127.0.0.1:{porta}/dep/celeros.engine.js"}}}}).encode()
        rota["/dep/celeros.engine.js"] = dep
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.httpd.shutdown)
        self.env = {"CELER_HUB": f"http://127.0.0.1:{porta}"}

    def test_instala_pacote_e_deps_do_hub(self):
        from types import SimpleNamespace
        import contextlib
        link, dev = make_link()
        link.hello()
        args = SimpleNamespace(pkg="celeros.demo", sd=False, pula_lint=True,
                               pula_verify=False, run=False, deps_local=False,
                               hub=None)
        out = io.StringIO()
        saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        try:
            with contextlib.redirect_stdout(out):
                C._apps_store(link, args)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        texto = out.getvalue()
        # pacote inteiro na pasta saneada ("Demo!" -> "Demo")
        for rel, corpo in [("app.json", None), ("main.js", self.main),
                           ("lib.js", self.lib), ("icon.png", self.icon)]:
            self.assertIn(f"/local/apps/Demo/{rel}", dev.files)
        self.assertEqual(dev.files["/local/apps/Demo/main.js"], self.main)
        self.assertEqual(dev.files["/local/apps/Demo/lib.js"], self.lib)
        # deps: modulo no cache publico + deps.json apontando a versao
        self.assertIn("/local/modules/celeros.engine/9.9.9/celeros.engine.js", dev.files)
        self.assertEqual(json.loads(dev.files["/local/apps/Demo/deps.json"]),
                         {"celeros.engine": "9.9.9"})
        # rescan no fim (o launcher re-le a pasta)
        self.assertIn("rescan", dev.execs)
        self.assertIn("instalado: /local/apps/Demo", texto)

    def test_pacote_desconhecido_morre_com_catalogo(self):
        from types import SimpleNamespace
        import contextlib
        link, dev = make_link()
        link.hello()
        args = SimpleNamespace(pkg="celeros.naoexiste", sd=False, pula_lint=True,
                               pula_verify=False, run=False, deps_local=False,
                               hub=None)
        saved = os.environ.get("CELER_HUB")
        os.environ.update(self.env)
        try:
            err = io.StringIO()
            with redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):
                    C._apps_store(link, args)
        finally:
            if saved is None:
                os.environ.pop("CELER_HUB", None)
            else:
                os.environ["CELER_HUB"] = saved
        self.assertIn("celeros.demo", err.getvalue())  # dica do catalogo


# --------------------------------------------------- push-dep / deps-status
# Comandos novos do cache de deps (Round 4): resolucao de versao do
# push-dep, vereditos do deps-status e a forma CANONICA (o enxuto do
# jsstrip — o mesmo bytes que o publish-dep sobe e o install grava) que os
# dois comandos compartilham entre si e com o caminho normal do hub.

class TestPushDep(unittest.TestCase):
    """apps push-dep: versao do cache resolvida, push verificado por releitura."""

    ENGINE = Path(C.__file__).resolve().parent / "sdk" / "engine"

    def setUp(self):
        # forma canonica sem depender do node: o cru do repo (a variacao com
        # o jsstrip real tem teste proprio em TestEngineCanonical)
        self._canon = C._engine_deploy_bytes
        C._engine_deploy_bytes = lambda p: Path(p).read_bytes()

    def tearDown(self):
        C._engine_deploy_bytes = self._canon

    def _link(self, versoes, conteudo=b"velho"):
        link, dev = make_link()
        link.hello()
        dev.dirs["/local/modules/celeros.game"] = list(versoes)
        for v in versoes:
            dev.files[f"/local/modules/celeros.game/{v}/celeros.game.js"] = conteudo
        return link, dev

    def _run(self, link, name="celeros.game", ver=None):
        from types import SimpleNamespace
        import contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            C._apps_push_dep(link, SimpleNamespace(name=name, ver=ver))
        return out.getvalue()

    def _die(self, link, **kw):
        import contextlib
        err = io.StringIO()
        with redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                self._run(link, **kw)
        return err.getvalue()

    def test_versao_unica_automatica(self):
        link, dev = self._link(["1.0.0"])
        texto = self._run(link)
        cru = (self.ENGINE / "celeros.game.js").read_bytes()
        self.assertEqual(dev.files["/local/modules/celeros.game/1.0.0/celeros.game.js"], cru)
        self.assertIn("push-dep celeros.game 1.0.0", texto)
        self.assertIn("verificado", texto)

    def test_varias_versoes_exigem_ver(self):
        link, dev = self._link(["1.0.0", "1.2.0"])
        err = self._die(link)
        self.assertIn("use --ver", err)
        self.assertIn("1.0.0", err)
        self.assertIn("1.2.0", err)
        # nada foi sobrescrito
        self.assertEqual(dev.files["/local/modules/celeros.game/1.0.0/celeros.game.js"], b"velho")
        self.assertEqual(dev.files["/local/modules/celeros.game/1.2.0/celeros.game.js"], b"velho")

    def test_versao_desconhecida_recusada(self):
        link, dev = self._link(["1.0.0"])
        err = self._die(link, ver="9.9.9")
        self.assertIn("9.9.9", err)
        self.assertIn("1.0.0", err)  # lista as existentes na dica
        self.assertEqual(dev.files["/local/modules/celeros.game/1.0.0/celeros.game.js"], b"velho")

    def test_dep_ausente_no_repo(self):
        link, dev = make_link()
        link.hello()
        dev.dirs["/local/modules"] = ["celeros.naoexiste"]
        dev.dirs["/local/modules/celeros.naoexiste"] = ["1.0.0"]
        dev.files["/local/modules/celeros.naoexiste/1.0.0/celeros.naoexiste.js"] = b"x"
        err = self._die(link, name="celeros.naoexiste")
        self.assertIn("repo", err)

    def test_cache_da_dep_nao_existe_no_device(self):
        link, dev = make_link()
        link.hello()
        dev.dirs["/local/modules"] = ["celeros.outra"]
        err = self._die(link)
        self.assertIn("instale um app que usa a dep", err)

    def test_ver_escolhida_dentro_das_varias(self):
        link, dev = self._link(["1.0.0", "1.2.0"])
        self._run(link, ver="1.2.0")
        cru = (self.ENGINE / "celeros.game.js").read_bytes()
        self.assertEqual(dev.files["/local/modules/celeros.game/1.2.0/celeros.game.js"], cru)
        self.assertEqual(dev.files["/local/modules/celeros.game/1.0.0/celeros.game.js"], b"velho")


class TestDepsStatus(unittest.TestCase):
    """apps deps-status: vereditos ok / DRIFT / sem no repo / SEM O ARQUIVO,
    crc calculado dos bytes lidos do device."""

    ENGINE = Path(C.__file__).resolve().parent / "sdk" / "engine"

    def setUp(self):
        self._canon = C._engine_deploy_bytes
        C._engine_deploy_bytes = lambda p: Path(p).read_bytes()
        self.cru = (self.ENGINE / "celeros.game.js").read_bytes()

    def tearDown(self):
        C._engine_deploy_bytes = self._canon

    def _run(self, populate):
        from types import SimpleNamespace
        import contextlib
        link, dev = make_link()
        link.hello()
        populate(dev)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            C._apps_deps_status(link, SimpleNamespace())
        return out.getvalue(), link

    def test_os_quatro_vereditos(self):
        velho = b"engine antiga dos blocos pretos"

        def populate(dev):
            dev.dirs["/local/modules"] = ["celeros.game", "celeros.zz", "celeros.sfx"]
            dev.dirs["/local/modules/celeros.game"] = ["1.0.0", "1.2.0"]
            dev.dirs["/local/modules/celeros.game/1.0.0"] = ["celeros.game.js"]
            dev.dirs["/local/modules/celeros.game/1.2.0"] = ["celeros.game.js"]
            dev.files["/local/modules/celeros.game/1.0.0/celeros.game.js"] = self.cru
            dev.files["/local/modules/celeros.game/1.2.0/celeros.game.js"] = velho
            dev.dirs["/local/modules/celeros.zz"] = ["1.0.0"]
            dev.dirs["/local/modules/celeros.zz/1.0.0"] = ["celeros.zz.js"]
            dev.files["/local/modules/celeros.zz/1.0.0/celeros.zz.js"] = b"x"
            dev.dirs["/local/modules/celeros.sfx"] = ["1.0.0"]  # pasta sem o .js

        texto, _ = self._run(populate)
        self.assertIn("ok", texto)
        # DRIFT carrega o crc real dos bytes do device (e o do repo)
        self.assertIn(f"crc {zlib.crc32(velho) & 0xFFFFFFFF:08x} x "
                      f"{zlib.crc32(self.cru) & 0xFFFFFFFF:08x}", texto)
        self.assertIn("push-dep celeros.game", texto)
        self.assertIn("sem no repo", texto)             # celeros.zz
        self.assertIn("SEM O ARQUIVO NO CACHE", texto)  # celeros.sfx
        self.assertIn("drift: 1 arquivo(s)", texto)

    def test_tudo_ok_fecha_em_sincronia(self):
        def populate(dev):
            dev.dirs["/local/modules"] = ["celeros.game"]
            dev.dirs["/local/modules/celeros.game"] = ["1.0.0"]
            dev.dirs["/local/modules/celeros.game/1.0.0"] = ["celeros.game.js"]
            dev.files["/local/modules/celeros.game/1.0.0/celeros.game.js"] = self.cru
        texto, _ = self._run(populate)
        self.assertNotIn("DRIFT", texto)
        self.assertIn("cache em sincronia com o repo", texto)

    def test_falha_na_leitura_nao_crasha(self):
        # read_file caiu no meio (conexao/perda): veredito proprio, sem contar
        # drift — antes o f"{None:08x}" derrubava o comando em TypeError
        from types import SimpleNamespace
        import contextlib
        link, dev = make_link()
        link.hello()
        dev.dirs["/local/modules"] = ["celeros.game"]
        dev.dirs["/local/modules/celeros.game"] = ["1.0.0"]
        dev.dirs["/local/modules/celeros.game/1.0.0"] = ["celeros.game.js"]
        dev.files["/local/modules/celeros.game/1.0.0/celeros.game.js"] = b"qualquer"

        def explode(*a, **kw):
            raise C.CelerError("timeout lendo do dispositivo")
        link.read_file = explode
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            C._apps_deps_status(link, SimpleNamespace())
        texto = out.getvalue()
        self.assertIn("FALHA NA LEITURA", texto)
        self.assertIn("timeout lendo", texto)
        self.assertNotIn("DRIFT", texto)

    def test_cache_vazio(self):
        from types import SimpleNamespace
        import contextlib
        link, dev = make_link()
        link.hello()
        dev.dirs["/local/modules"] = []
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            C._apps_deps_status(link, SimpleNamespace())
        self.assertIn("cache de deps vazio", out.getvalue())


class TestEngineCanonical(unittest.TestCase):
    """_engine_deploy_bytes: o cache do device vive na forma ENXUTO (jsstrip,
    o que o publish-dep sobe e o install grava) — push-dep e deps-status
    usam esta forma, nao o cru do repo."""

    ENGINE = Path(C.__file__).resolve().parent / "sdk" / "engine"

    def test_e_o_enxuto_do_jsstrip(self):
        import shutil
        import celerhub
        if shutil.which("node") is None:
            self.skipTest("sem node no PATH")
        cru = (self.ENGINE / "celeros.game.js").read_bytes()
        canon = C._engine_deploy_bytes(self.ENGINE / "celeros.game.js")
        self.assertEqual(canon, celerhub.strip_js(self.ENGINE / "celeros.game.js"))
        self.assertNotEqual(len(canon), len(cru))  # enxuto ~metade do cru

    def test_sem_node_cai_no_cru_sem_quebrar(self):
        # o die() do celerhub (node ausente/jsstrip falhando) vira SystemExit:
        # o fallback devolve o cru — push-dep e deps-status seguem consistentes
        import celerhub
        real = celerhub.strip_js

        def morre(path):
            raise SystemExit(1)
        celerhub.strip_js = morre
        try:
            cru = (self.ENGINE / "celeros.game.js").read_bytes()
            self.assertEqual(C._engine_deploy_bytes(self.ENGINE / "celeros.game.js"), cru)
        finally:
            celerhub.strip_js = real


class TestEvalRoteiro(unittest.TestCase):
    """debug --eval: a sequencia p/e/c/q no stdin do cliente, com as pausas
    que cobrem o ciclo assincrono de pausa/eval/continue do Duktape."""

    class Stdin:
        def __init__(self):
            self.writes = []

        def write(self, b):
            self.writes.append(b)

        def flush(self):
            pass

    def test_sequencia_e_tempos(self):
        sleeps = []
        stdin = self.Stdin()
        C._roteiro_eval(stdin, "E.score", sleep=sleeps.append)
        self.assertEqual(stdin.writes, [b"p\n", b"e E.score\n", b"c\nq\n"])
        # p -> 4s (boot do app pesado), eval -> 2s (evento de pausa), c/q
        self.assertEqual(sleeps, [4.0, 2.0, 0.6])

    def test_pipe_fechado_nao_propaga(self):
        class Fechado(self.Stdin):
            def write(self, b):
                raise OSError("broken pipe")
        # cliente saiu antes: o roteiro termina em silencio (o proxy cuida)
        C._roteiro_eval(Fechado(), "x", sleep=lambda s: None)


if __name__ == "__main__":
    unittest.main()
