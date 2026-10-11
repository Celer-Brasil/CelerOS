#!/usr/bin/env python3
"""matilha - o PC entra na matilha: CelerNet (malha BLE) + CelerLink (GATT).

Duas caras, dois papeis de radio:

  mesh *  o PC vira um NO da malha CelerNet (main/Bluetooth/CelerNet.cpp):
          escuta o flooding por advertising, anuncia presenca (BEAT), envia
          mensagens (broadcast ou unicast, fragmentando ate 434 B) e pode
          repetir quadros (--relay). Os quadros viajam CRUS no advertising
          data (magic 'C''N', sem estrutura AD) - o bleak/BlueZ nao ve nem
          transmite isso; a tool fala direto com o controlador por um socket
          HCI cru. Requer sudo (CAP_NET_RAW).
  link *  cliente CelerLink (main/Bluetooth/CelerLink.cpp) sobre bleak:
          scan, pareamento pelo codigo de 6 digitos, bond v2 (reconecta sem
          digitar o codigo de novo) e chat/send com o app que esta aberto no
          device (Dog Face: telemetria/comandos JSON; veja o Celer Remote).

Exemplos:

    # malha: ouvir o bando e anunciar presenca (Ctrl-C sai com o resumo)
    sudo python3 tools/matilha/matilha.py mesh listen
    sudo python3 tools/matilha/matilha.py mesh listen --relay --raw

    # fotografia da matilha; ping/unicenso contra o app Sonar
    sudo python3 tools/matilha/matilha.py mesh nodes
    sudo python3 tools/matilha/matilha.py mesh ping Celer-4848 --count 5
    sudo python3 tools/matilha/matilha.py mesh census

    # mensagens (1..434 bytes; sem radio, so imprime os quadros)
    sudo python3 tools/matilha/matilha.py mesh send "bom dia, bando!"
    sudo python3 tools/matilha/matilha.py mesh send "avanca" --to Celer-D001
    python3 tools/matilha/matilha.py mesh send "teste" --dry

    # link: parear uma vez (codigo no device) e conversar pelo GATT
    python3 tools/matilha/matilha.py link scan
    python3 tools/matilha/matilha.py link pair Celer-D001
    python3 tools/matilha/matilha.py link chat Celer-D001
    python3 tools/matilha/matilha.py link send Celer-D001 '{"type":"tel"}'

Notas de bancada:
  - mesh e link nao rodam JUNTOS no mesmo adaptador: o mesh quer o radio
    cru (e o bluetoothd pode disputa-lo) e o link precisa do bluetoothd.
    Use um dongle dedicado para o mesh (--hci 1) ou sessoes separadas.
  - "Command Disallowed" costuma ser o bluetoothd com o radio: pare o
    servico (`sudo systemctl stop bluetooth`) ou use outro dongle.
  - o app do device precisa ter o CelerLink ligado (Dog Face, Celer
    Remote...); o mesh chega a qualquer device com a malha no ar.

Requer bleak apenas para `link *` (pip install -r tools/requirements.txt).
Exit codes: 2 sem bleak, 3 pareamento, 4 sem root, 5 radio/HCI.
"""

import argparse
import asyncio
import errno
import fcntl
import hashlib
import json
import os
import random
import select
import socket
import struct
import sys
import time
from collections import deque
from pathlib import Path

from netframe import (ADV_MAX, CAPS_HUB, CAPS_NAMES, CHUNK_MAX, DATA_MAX, FRAG_COPY_SHIFT,
                      DST_BROADCAST, DedupRing, Frame, MSG_MAX, Reassembler,
                      TTL_DEFAULT, TTL_MAX, TYPE_BEAT, TYPE_DATA, TYPE_FRAG,
                      caps_str, decode, encode, fnv16)

EX_BLEAK = 2
EX_PAIR = 3
EX_ROOT = 4
EX_RADIO = 5

# UUIDs do Celer Link (main/Bluetooth/CelerLink.cpp: kSvcUuid/kChrUuid/kPairUuid)
SVC_UUID = "b3a667a2-fdac-5298-8c13-89c980f2d1f1"
CHR_MSG = "b3a667a2-fdac-5298-8c13-89c980f2d1f2"   # write (mensagem) + notify
CHR_PAIR = "b3a667a2-fdac-5298-8c13-89c980f2d1f3"  # read estado / write codigo
PAIR_OPEN, PAIR_WAIT, PAIR_OK = 0x00, 0x01, 0x02
MAX_MSG = 240    # firmware: MTU-3 com MTU 256


def die(msg, code=1):
    print("erro: %s" % msg, file=sys.stderr)
    sys.exit(code)


# ------------------------------------------------------------------ bonds --
# Bond v2 do CelerLink.cpp: na 1a conexao o central digita o codigo e ambos
# derivam K = SHA256("CLK2" || codigo || desafio)[0:16]; nas voltas seguintes
# o periferico manda desafio novo e o central responde R = SHA256(K ||
# desafio)[0:8] - prova que conhece K sem manda-lo pelo ar.

BOND_LABEL = b"CLK2"


def bond_key_from_code(code, challenge):
    return hashlib.sha256(BOND_LABEL + code.encode() + challenge).digest()[:16]


def bond_response(key, challenge):
    return hashlib.sha256(key + challenge).digest()[:8]


def bonds_path():
    return Path(os.environ.get("MATILHA_BONDS",
                               Path.home() / ".config/matilha/bonds.json"))


def load_bonds(path=None):
    p = Path(path) if path else bonds_path()
    try:
        data = json.loads(p.read_text())
        return {a.upper(): bytes.fromhex(k) for a, k in data.items()}
    except (OSError, ValueError):
        return {}


def save_bonds(bonds, path=None):
    p = Path(path) if path else bonds_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({a: k.hex() for a, k in sorted(bonds.items())}))
    os.chmod(p, 0o600)   # a chave e credencial: so o dono le


# ------------------------------------------------------------- motor malha --

class RadioError(Exception):
    pass


class MeshNode:
    """Motor da malha no PC - porte fiel dos ritmos do CelerNet.cpp:
    presenca por BEAT (3 s / TTL 15 s), dedup por (src, seq, idx), fila TX
    com token bucket (8/s, rajada 16) e respiro de 25 ms, copias de unicast
    com seq NOVO espacadas 1,5 s, relay com jitter (frag espera a rajada).
    O radio e o relogio entram injetados - os testes rodam sem ar.
    """

    K_BEAT_MS = 3000
    K_NODE_TTL_MS = 15000
    K_REASM_TTL_MS = 6000
    K_TOKEN_PER_S = 8
    K_TOKEN_MAX = 16
    K_SLOT_MS = 25
    K_COPY_GAP_MS = 1500
    PENDING_DEPTH = 96   # como o firmware: cabe 434 B x 2 copias + relays
    RX_DEPTH = 8
    NODES_MAX = 16

    def __init__(self, node, name, net="celer", caps=0, relay=False, radio=None,
                 now_ms=None, rng=None, on_message=None, on_member=None):
        self.node = node & 0xFFFF
        self.name = name[:15]
        self.net = net
        self.net_id = fnv16(net)
        self.caps = caps
        self.relay = relay
        self.radio = radio if radio is not None else PrintRadio()
        self._now_ms = now_ms if now_ms is not None else \
            (lambda: int(time.monotonic() * 1000))
        self.rng = rng if rng is not None else random.Random()
        self.on_message = on_message
        self.on_member = on_member
        self.seq = self.rng.randrange(0x10000)
        self.dedup = DedupRing()
        self.reasm = Reassembler()
        self.nodes_tbl = {}      # id -> {name, caps, rssi, hops, last_ms}
        self.rx = deque()        # entregues (firmware: fila de 8 do JS)
        self.pending = []        # [{frame, due_ms, prio}]
        self.tokens = self.K_TOKEN_MAX
        self.last_refill_ms = None
        self.last_beat_ms = None
        self.next_slot_ms = 0
        self.counters = {"frames": 0, "relayed": 0, "relayDropped": 0, "rxDropped": 0,
                         "txDropped": 0, "txStarted": 0, "txFail": 0, "txNoToken": 0}

    # ------------------------------------------------------------------ tick
    def tick(self):
        now = self._now_ms()
        if self.last_refill_ms is None:
            self.last_refill_ms = now
        add = (now - self.last_refill_ms) // (1000 // self.K_TOKEN_PER_S)
        if add > 0:
            self.last_refill_ms += add * (1000 // self.K_TOKEN_PER_S)
            self.tokens = min(self.K_TOKEN_MAX, self.tokens + add)
        # BEAT imediato no 1o tick: presenca aparece logo nos vizinhos
        if self.last_beat_ms is None or now - self.last_beat_ms >= self.K_BEAT_MS:
            self.last_beat_ms = now
            self._enqueue_beat(now)
        self._sweep(now)
        self.reasm.prune(now, self.K_REASM_TTL_MS)
        self._burst(now)

    def _push_pending(self, frame, due_ms, prio):
        if len(self.pending) >= self.PENDING_DEPTH:
            return False
        self.pending.append({"frame": frame, "due_ms": due_ms, "prio": prio})
        return True

    def _enqueue_beat(self, now):
        data = bytes([self.caps]) + self.name.encode("utf-8", "replace")[:DATA_MAX - 1]
        self.seq = (self.seq + 1) & 0xFFFF
        if self.seq == 0:   # 0 reservado ("novo" no enqueue), como o firmware
            self.seq = (self.seq + 1) & 0xFFFF
        enc = encode(Frame(TYPE_BEAT, self.net_id, self.node, DST_BROADCAST,
                           self.seq, TTL_DEFAULT, 0, data))
        if enc is None:   # fila cheia: o proximo BEAT (3 s) tenta de novo
            self.counters["txDropped"] += 1
        else:
            self._push_pending(enc, now, 0)

    def _frames_for(self, n):
        return 1 if n <= DATA_MAX else (n + CHUNK_MAX - 1) // CHUNK_MAX

    def enqueue_message(self, dst, data, ttl=0, urgent=False, due_delay_ms=0, seq=None, copy=0):
        """Mensagem -> quadros (DATA unico ou FRAGs). seq None = novo; senao o
        seq da copia anterior (FRAG com a copia no idx). Tudo ou nada."""
        if not data or len(data) > MSG_MAX or ttl == 0:
            return False
        if self._frames_for(len(data)) > self.PENDING_DEPTH - len(self.pending):
            return False
        now = self._now_ms()
        if seq is None:
            self.seq = (self.seq + 1) & 0xFFFF
            seq = self.seq
        prio = 1 if urgent else 0
        if len(data) <= DATA_MAX:
            enc = encode(Frame(TYPE_DATA, self.net_id, self.node, dst, seq,
                               ttl, 0, data))
            return enc is not None and self._push_pending(enc, now + due_delay_ms, prio)
        total = (len(data) + CHUNK_MAX - 1) // CHUNK_MAX
        if total > 31:
            return False
        for i in range(total):
            chunk = data[i * CHUNK_MAX:(i + 1) * CHUNK_MAX]
            enc = encode(Frame(TYPE_FRAG, self.net_id, self.node, dst, seq, ttl, 0,
                               bytes([i | ((copy & 3) << FRAG_COPY_SHIFT), total]) + chunk))
            if enc is None or not self._push_pending(enc, now + due_delay_ms, prio):
                return False
        return True

    def broadcast(self, data, ttl=0):
        if not data:
            return False
        ttl = ttl or TTL_DEFAULT
        ok = self.enqueue_message(DST_BROADCAST, data, min(ttl, TTL_MAX))
        if not ok:
            self.counters["txDropped"] += 1
        return ok

    def send(self, dst, data, ttl=0, urgent=False, copies=1):
        """Unicast com copias espacadas ~1,5 s. Quadro unico: seq NOVO por copia
        (a entrega pode duplicar). Fragmentada: as copias DIVIDEM o seq (copia
        no idx) e o destino junta frags de qualquer uma - entrega uma vez.
        Todas as copias cabem na fila ou nenhuma sai (como o firmware)."""
        if not data or dst == 0 or dst == self.node:
            return False
        ttl = ttl or TTL_DEFAULT
        copies = max(1, min(3, copies))
        frag = len(data) > DATA_MAX
        ok = self._frames_for(len(data)) * copies <= self.PENDING_DEPTH - len(self.pending)
        msg_seq = None
        for c in range(copies if ok else 0):
            if not self.enqueue_message(dst, data, min(ttl, TTL_MAX), urgent,
                                        c * self.K_COPY_GAP_MS,
                                        msg_seq if frag else None, c if frag else 0):
                ok = False
                break
            if c == 0 and frag:
                msg_seq = self.seq
        if not ok:
            self.counters["txDropped"] += 1
        return ok

    def _burst(self, now):
        if now < self.next_slot_ms:
            return
        best = bi = None
        for i, p in enumerate(self.pending):
            if p["due_ms"] > now:
                continue
            # urgente (handoff) primeiro, depois o mais antigo (FIFO ~due)
            if best is None or p["prio"] > best["prio"] or \
                    (p["prio"] == best["prio"] and p["due_ms"] < best["due_ms"]):
                best, bi = p, i
        if best is None:
            return
        if self.tokens < 1:
            self.counters["txNoToken"] += 1
            return
        if not self.radio.tx(best["frame"]):
            self.counters["txFail"] += 1   # radio ocupado: fica na fila
            return
        self.pending.pop(bi)
        self.tokens -= 1
        self.counters["txStarted"] += 1
        self.next_slot_ms = now + self.K_SLOT_MS

    # -------------------------------------------------------------------- rx
    def on_adv_report(self, raw, rssi):
        """Report cru do scanner: quase tudo para no magic/versao/tamanho."""
        if len(raw) < 15 or len(raw) > ADV_MAX or raw[:2] != b"CN":
            return
        f = decode(raw)
        if f is None or f.net_id != self.net_id:
            return
        self.handle_frame(f, rssi)

    def handle_frame(self, f, rssi):
        now = self._now_ms()
        if f.src == self.node:
            return   # eco do nosso proprio quadro
        # unicast: so o DESTINATARIO entrega; o relay segue o flood inteiro
        mine = f.dst == DST_BROADCAST or f.dst == self.node
        idx = f.data[0] if f.type == TYPE_FRAG and len(f.data) >= 2 else 0
        if self.dedup.seen(f.src, f.seq, idx):
            return
        self.counters["frames"] += 1
        hops = f.hops + 1   # saltos dados: vizinho direto = 1 (como o firmware)

        if f.type == TYPE_BEAT:
            caps = f.data[0] if f.data else 0
            name = f.data[1:].split(b"\0", 1)[0].decode("latin-1", "replace") \
                if len(f.data) > 1 else ""
            self._node_touch(f.src, name, caps, rssi, hops, now)
        elif f.type == TYPE_DATA and mine:
            self._node_touch(f.src, "", None, rssi, hops, now)
            self._deliver(f, f.data, rssi, hops)
        elif f.type == TYPE_FRAG and mine and len(f.data) >= 2:
            self._node_touch(f.src, "", None, rssi, hops, now)
            msg = self.reasm.feed(f.src, f.seq, f.data[0], f.data[1],
                                  f.data[2:], now)
            if msg is not None:
                self._deliver(f, msg, rssi, hops)

        # repeticao (flood): ttl-1/hops+1, jitter escalando com o ttl restante;
        # FRAG ganha jitter LARGO - repetir frag cedo faz o repetidor transmitir
        # (scanner desligado) exatamente quando o frag SEGUINTE chega
        if self.relay and f.ttl > 1:
            enc = encode(Frame(f.type, f.net_id, f.src, f.dst, f.seq,
                               f.ttl - 1, f.hops + 1, f.data))
            if enc is not None:
                jitter = 40 + f.ttl * 40 + self.rng.randrange(200)
                if f.type == TYPE_FRAG:
                    jitter += 700 + self.rng.randrange(900)
                if self._push_pending(enc, now + jitter, 0):
                    self.counters["relayed"] += 1
                else:
                    # anel cheio: conta — relay perdido em serie e sintoma de
                    # fila atolada (paridade com o relayDropped do firmware)
                    self.counters["relayDropped"] += 1

    def _node_touch(self, nid, name, caps, rssi, hops, now):
        e = self.nodes_tbl.get(nid)
        if e is None:
            if not name:
                return   # sem BEAT: nao inventa no
            if len(self.nodes_tbl) >= self.NODES_MAX:
                return   # tabela cheia: no novo fica de fora
            e = self.nodes_tbl[nid] = {"name": "", "caps": 0, "rssi": rssi,
                                       "hops": hops, "last_ms": now}
            if self.on_member:
                self.on_member("join", self._node_view(nid, e, now))
        if name:
            e["name"] = name
        if caps is not None:
            e["caps"] = caps   # caps so do BEAT (DATA nao zera o papel do no)
        # caminho mais curto fresco vence (BEAT repetido nao troca o direto)
        if now - e["last_ms"] >= 2 * self.K_BEAT_MS or hops <= e["hops"]:
            e["rssi"] = rssi
            e["hops"] = hops
        e["last_ms"] = now

    def _node_view(self, nid, e, now):
        return {"id": nid, "name": e["name"], "caps": e["caps"],
                "rssi": e["rssi"], "hops": e["hops"],
                "last_seen_s": (now - e["last_ms"]) / 1000.0}

    def _node_expired(self, e, now):
        """No vencido? Mesmo criterio do nodeExpired do firmware: com fila de
        TX pendente o proprio no esta SURDO (cada burst desliga o scanner) e
        nao expira par pelo TTL normal — so no teto duro de 4x TTL."""
        age = now - e["last_ms"]
        if age <= self.K_NODE_TTL_MS:
            return False
        return not self.pending or age > 4 * self.K_NODE_TTL_MS

    def _sweep(self, now):
        for nid in [n for n, e in self.nodes_tbl.items()
                    if self._node_expired(e, now)]:
            e = self.nodes_tbl.pop(nid)
            if self.on_member:
                self.on_member("leave", self._node_view(nid, e, now))

    def _deliver(self, f, payload, rssi, hops):
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        entry = {"from": f.src,
                 "from_name": self.nodes_tbl.get(f.src, {}).get("name", ""),
                 "dst": f.dst, "unicast": f.dst != DST_BROADCAST,
                 "hops": hops, "rssi": rssi, "data": payload, "text": text}
        if len(self.rx) >= self.RX_DEPTH:
            self.rx.popleft()   # comando novo vale mais que o velho
            self.counters["rxDropped"] += 1
        self.rx.append(entry)
        if self.on_message:
            self.on_message(entry)

    def poll_msg(self):
        return self.rx.popleft() if self.rx else None

    def nodes_list(self):
        now = self._now_ms()
        self._sweep(now)
        out = [self._node_view(nid, e, now) for nid, e in self.nodes_tbl.items()]
        out.sort(key=lambda v: -v["rssi"])   # mais forte primeiro
        return out

    def resolve(self, to):
        """Hex de 4 digitos ou nome ouvido (duplicados pegam o mais forte)."""
        to = to.strip()
        if len(to) == 4 and all(c in "0123456789abcdefABCDEF" for c in to):
            return int(to, 16)
        for n in self.nodes_list():
            if n["name"] and n["name"].casefold() == to.casefold():
                return n["id"]
        return None

    def status(self):
        return {"node": self.node, "name": self.name, "net": self.net,
                "net_id": self.net_id, "relay": self.relay, "caps": self.caps,
                "queued": len(self.pending), "nodes": len(self.nodes_tbl),
                **self.counters}


class PrintRadio:
    """Radio de bateria seca: imprime cada quadro em hex (opcoes --dry)."""

    def __init__(self, out=None):
        self.sent = []
        self.out = out or sys.stdout

    def tx(self, frame):
        frame = bytes(frame)
        self.sent.append(frame)
        print("TX %s" % frame.hex(), file=self.out)
        return True

    def start(self):
        pass

    def close(self):
        pass

    def poll(self, timeout=0.0):
        return []


# ------------------------------------------------------------------ radio --

class HciRadio:
    """Socket HCI cru: fala advertising/scan direto com o controlador.

    O CelerNet viaja no payload do ADV_NONCONN sem estrutura AD - fora do
    alcance do bleak/BlueZ. Aqui e a danca do firmware (CelerNet.cpp):
    scanner passivo 10/10 ms sempre que a fila esta seca; para transmitir,
    desliga o scan, carrega o quadro no advertising data, liga por ~150 ms
    (1 evento de adv a 100 ms) e devolve o scanner. Requer root.
    """

    HCI_DEV_UP = 0x400448C9   # ioctl HCIDEVUP (EALREADY = ja ligado)
    OGF_LE = 0x08
    ERR_HINTS = {
        0x0C: "Command Disallowed - o bluetoothd esta com o radio: pare o "
              "servico (`sudo systemctl stop bluetooth`) ou use um dongle "
              "dedicado (--hci 1)",
        0x11: "comando nao suportado pelo controlador",
        0x12: "parametros invalidos para o controlador",
    }

    def __init__(self, dev=0):
        self.dev = dev
        self.reports = []        # [(rssi, raw, addr)] do poll()
        self._cmd_status = {}
        self.scan_on = False
        try:
            self.sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_RAW,
                                      socket.BTPROTO_HCI)
            self.sock.bind((dev,))
        except PermissionError:
            raise RadioError("sem permissao no hci%d: o socket HCI cru exige "
                             "root (rode com sudo)" % dev)
        except OSError as e:
            raise RadioError("hci%d: %s (adaptador presente? `ls /sys/class/"
                             "bluetooth`)" % (dev, e))
        self._dev_up()
        # ADV_NONCONN a 100 ms (o piso da especificacao; o firmware usa 160
        # unidades de 0,625 ms = 100 ms), canais 37/38/39
        self._cmd(0x0006, struct.pack("<HHBB", 160, 160, 3, 0) + b"\x00" * 6 +
                  bytes([0x07, 0x00]))

    def _dev_up(self):
        try:
            fcntl.ioctl(self.sock.fileno(), self.HCI_DEV_UP,
                        struct.pack("i", self.dev))
        except OSError as e:
            if e.errno != errno.EALREADY:
                raise RadioError("hci%d nao liga (%s) - rfkill? `rfkill list`"
                                 % (self.dev, e))

    def _cmd(self, ocf, payload=b"", wait=True):
        opcode = (self.OGF_LE << 10) | ocf
        self.sock.send(b"\x01" + struct.pack("<HB", opcode, len(payload)) + payload)
        if not wait:
            return 0
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            self._pump(0.05)
            if opcode in self._cmd_status:
                st = self._cmd_status.pop(opcode)
                if st != 0:
                    hint = self.ERR_HINTS.get(st, "status HCI 0x%02X" % st)
                    raise RadioError("comando HCI 0x%04X: %s" % (opcode, hint))
                return st
        raise RadioError("controlador nao respondeu (opcode 0x%04X)" % opcode)

    def _pump(self, timeout=0.0):
        r, _, _ = select.select([self.sock], [], [], timeout)
        if not r:
            return
        self._on_pkt(self.sock.recv(4096))

    def _on_pkt(self, pkt):
        if len(pkt) < 3 or pkt[0] != 0x04:   # so eventos
            return
        evt, plen = pkt[1], pkt[2]
        if evt == 0x0E and len(pkt) >= 7:            # Command Complete
            self._cmd_status[pkt[4] | (pkt[5] << 8)] = pkt[6]
        elif evt == 0x0F and len(pkt) >= 6:          # Command Status
            self._cmd_status[pkt[4] | (pkt[5] << 8)] = pkt[3]
        elif evt == 0x3E and len(pkt) >= 5 and pkt[3] == 0x02:
            self._adv_report(pkt)                    # LE Advertising Report

    def _adv_report(self, pkt):
        num, i = pkt[4], 5
        for _ in range(num):
            if i + 10 > len(pkt):
                return
            dl = pkt[i + 8]
            if i + 10 + dl > len(pkt):
                return
            data = pkt[i + 9:i + 9 + dl]
            rssi = struct.unpack_from("b", pkt, i + 9 + dl)[0]
            addr = pkt[i + 2:i + 8][::-1].hex(":").upper()
            if dl >= 2 and data[:2] == b"CN":
                self.reports.append((rssi, bytes(data), addr))
            i += 10 + dl

    def _scan(self, en):
        self._cmd(0x000C, bytes([1 if en else 0, 0x00]))   # dups: software dedup
        self.scan_on = en

    def start(self):
        # passivo (o quadro cru chega inteiro, sem scan response), 10/10 ms
        self._cmd(0x000B, struct.pack("<BHHBB", 0, 16, 16, 0, 0))
        self._scan(True)

    def tx(self, frame):
        if len(frame) > ADV_MAX:
            raise RadioError("quadro de %d bytes (maximo %d)" % (len(frame), ADV_MAX))
        for tent in range(3):
            try:
                if self.scan_on:
                    self._scan(False)   # scanner e burst NUNCA juntos
                self._cmd(0x0008, bytes([len(frame)]) + frame.ljust(31, b"\x00"))
                self._cmd(0x000A, b"\x01")
                time.sleep(0.15)        # ~1 evento de adv (itvl 100 ms) + folga
                self._cmd(0x000A, b"\x00")
                if not self.scan_on:
                    self._scan(True)
                return True
            except RadioError:
                # o bluetoothd pode dar um tranco no radio no meio da danca
                if tent == 2:
                    raise
                time.sleep(0.05)
        return False

    def poll(self, timeout=0.0):
        self._pump(timeout)
        out, self.reports = self.reports, []
        return out

    def close(self):
        for cmd in (b"\x00",):
            try:
                self._cmd(0x000A, cmd, wait=False)   # adv off
                self._cmd(0x000C, b"\x00\x00", wait=False)  # scan off
            except OSError:
                pass
        try:
            self.sock.close()
        except OSError:
            pass


def adapter_addr(dev=0):
    try:
        return Path("/sys/class/bluetooth/hci%d/address" % dev).read_text().strip()
    except OSError:
        return None


def default_node_id(dev=0):
    """2 ultimos bytes da MAC do adaptador - a mesma identidade do firmware."""
    a = adapter_addr(dev)
    if a and a != "00:00:00:00:00:00":
        return int(a.replace(":", "")[-4:], 16)
    return None


# ------------------------------------------------------------------- link --

class PairFail(Exception):
    pass


class LinkClient:
    """Celer Link sobre bleak (import tardio - os testes injetam um link
    falso; o modulo roda sem bleak instalado)."""

    def __init__(self):
        self.addr = None
        self.client = None
        self.rx = []

    async def scan(self, timeout=3.0):
        from bleak import BleakScanner
        found = await BleakScanner.discover(timeout=timeout, return_adv=True)
        out = [{"nome": d.name, "addr": d.address, "rssi": adv.rssi}
               for d, adv in found.values()
               if d.name and d.name.startswith("Celer-")]
        return sorted(out, key=lambda d: -d["rssi"])

    async def find(self, nome, timeout=5.0):
        devs = await self.scan(timeout)
        alvo = nome.casefold()
        for d in devs:
            if d["nome"].casefold() == alvo or d["nome"].casefold().endswith("-" + alvo):
                return d["addr"]
        return None

    async def connect(self, addr, timeout=8.0):
        from bleak import BleakClient
        self.addr = addr
        self.client = BleakClient(addr, timeout=timeout)
        await self.client.connect()
        await self.client.start_notify(CHR_MSG, self._on_notify)

    def _on_notify(self, _h, data):
        try:
            self.rx.append(json.loads(data.decode()))
        except (ValueError, UnicodeDecodeError):
            self.rx.append(data.decode("latin-1", "replace"))

    async def pair_read(self):
        b = await self.client.read_gatt_char(CHR_PAIR)
        if not b:
            return PAIR_OPEN, None
        state = b[0]
        challenge = bytes(b[1:9]) if state == PAIR_WAIT and len(b) >= 9 else None
        return state, challenge

    async def pair_write(self, data):
        await self.client.write_gatt_char(CHR_PAIR, bytes(data), response=True)

    async def send(self, text):
        data = text.encode() if isinstance(text, str) else bytes(text)
        if len(data) > MAX_MSG:
            raise ValueError("payload > %d bytes" % MAX_MSG)
        await self.client.write_gatt_char(CHR_MSG, data, response=False)

    async def drain(self, timeout=1.0):
        out = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.rx:
                out.append(self.rx.pop(0))
            else:
                await asyncio.sleep(0.05)
        return out

    async def close(self):
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
            self.client = None


async def pair_flow(link, ask=input, code=None, bonds=None):
    """Pareamento do CelerLink (dogtune generalizado + bond v2).

    Devolve "ok" (ja liberado), "bond" (desafio respondido com a chave
    guardada), "code" (pareou pelo codigo e guardou a chave), "aberto"
    (link sem gate) ou "fail"."""
    if bonds is None:
        bonds = load_bonds()
    state, challenge = await link.pair_read()
    if state == PAIR_OK:
        return "ok"
    if state != PAIR_WAIT:
        return "aberto"
    key = bonds.get((link.addr or "").upper())
    if challenge and key:
        await link.pair_write(bond_response(key, challenge))
        await asyncio.sleep(0.3)
        state, _ = await link.pair_read()
        if state == PAIR_OK:
            return "bond"
        # desafio recusado: o device mostra o codigo - cai pro pareamento
    tentativas = 2 if key else 3   # o desafio falho ja contou la no device
    for _ in range(tentativas):
        if code is None:
            code = ask("codigo de 6 digitos no device: ").strip()
        if len(code) == 6 and code.isdigit():
            await link.pair_write(code.encode())
            await asyncio.sleep(0.3)
            state, _ = await link.pair_read()
            if state == PAIR_OK:
                if challenge:
                    bonds[(link.addr or "").upper()] = \
                        bond_key_from_code(code, challenge)
                    save_bonds(bonds)
                return "code"
        code = None
    return "fail"


# -------------------------------------------------------------------- CLI --

def parse_caps(s):
    s = (s or "").strip()
    if not s:
        return CAPS_HUB
    try:
        return int(s, 0) & 0xFF
    except ValueError:
        pass
    caps = 0
    names = dict(CAPS_NAMES)
    for part in s.split(","):
        bit = names.get(part.strip().lower())
        if bit is None:
            die("--caps: nome \"%s\" desconhecido (use hub, speaker, mic, "
                "display, motors, leds)" % part.strip())
        caps |= bit
    return caps


def is_hex4(s):
    return len(s) == 4 and all(c in "0123456789abcdefABCDEF" for c in s)


def build_node(args, dry=False, on_message=None, on_member=None):
    node_id = None
    sid = getattr(args, "id", None)
    if sid:
        if not is_hex4(sid):
            die("--id espera 4 hexadecimais (ex.: a1b2)")
        node_id = int(sid, 16)
    else:
        node_id = default_node_id(getattr(args, "hci", 0))
        if node_id is None and not dry:
            die("sem MAC do hci%d para derivar o id: use --id XXXX"
                % getattr(args, "hci", 0))
        node_id = node_id if node_id is not None else 0x0000
    name = getattr(args, "nome", None) or ("PC-%04X" % node_id)
    radio = PrintRadio() if dry else HciRadio(getattr(args, "hci", 0))
    return MeshNode(node_id, name, net=getattr(args, "net", "celer"),
                    caps=parse_caps(getattr(args, "caps", None)),
                    relay=getattr(args, "relay", False), radio=radio,
                    on_message=on_message, on_member=on_member)


def pump(node, timeout=0.02):
    """Um ciclo do no: drena o ar e roda o tick (o celerLoop daqui)."""
    for rssi, raw, _addr in node.radio.poll(timeout):
        node.on_adv_report(raw, rssi)
    node.tick()


def warmup(node, secs):
    """BEATs no ar e coleta de presenca: quem vai receber unicast do PC
    precisa conhecer o PC (a resposta volta por dst = id do PC)."""
    t0 = time.monotonic()
    while time.monotonic() - t0 < secs:
        pump(node)


def stamp():
    return time.strftime("%H:%M:%S")


def print_msg(m):
    who = m["from_name"] or ("%04X" % m["from"])
    dest = "pc" if m["unicast"] else "todos"
    body = '"%s"' % m["text"] if m["text"] is not None else "hex " + m["data"].hex()
    print("%s  %s > %s  hops=%d rssi=%d  %s" % (stamp(), who, dest, m["hops"],
                                                m["rssi"], body))


def print_member(kind, n):
    if kind == "join":
        print("%s  + %s (%04X)  %s  rssi=%d hops=%d"
              % (stamp(), n["name"] or "?", n["id"], caps_str(n["caps"]),
                 n["rssi"], n["hops"]))
    else:
        print("%s  - %s (%04X) saiu da presenca" % (stamp(), n["name"] or "?", n["id"]))


def print_nodes(node):
    rows = node.nodes_list()
    if not rows:
        print("nenhum no ouvido")
        return
    print("%-6s %-16s %-26s %5s %5s %7s" % ("ID", "NOME", "CAPS", "RSSI", "HOPS", "IDADE"))
    for n in rows:
        print("%-6s %-16s %-26s %5d %5d %6.1fs"
              % ("%04X" % n["id"], n["name"], caps_str(n["caps"]), n["rssi"],
                 n["hops"], n["last_seen_s"]))


def print_status(node):
    s = node.status()
    print("quadros=%(frames)d relay=%(relayed)d tx=%(txStarted)d "
          "txFail=%(txFail)d noToken=%(txNoToken)d rxDrop=%(rxDropped)d "
          "txDrop=%(txDropped)d fila=%(queued)d" % s)


def cmd_mesh_listen(args):
    node = build_node(args, on_message=print_msg, on_member=print_member)
    print("no %04X \"%s\" rede \"%s\" (%04X) caps=%s%s - Ctrl-C sai"
          % (node.node, node.name, node.net, node.net_id, caps_str(node.caps),
             ", repetidor" if node.relay else ""))
    if getattr(args, "raw", False):
        orig = node.on_adv_report

        def raw_hook(raw, rssi):
            if raw[:2] == b"CN":
                print("%s  RAW %s rssi=%d" % (stamp(), raw.hex(), rssi))
            orig(raw, rssi)
        node.on_adv_report = raw_hook
    node.radio.start()
    t0 = time.monotonic()
    try:
        while True:
            if args.secs and time.monotonic() - t0 >= args.secs:
                break
            pump(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.radio.close()
    print()
    print_nodes(node)
    print_status(node)
    return 0


def cmd_mesh_nodes(args):
    node = build_node(args)
    node.radio.start()
    t0 = time.monotonic()
    try:
        while time.monotonic() - t0 < args.secs:
            pump(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.radio.close()
    print_nodes(node)
    return 0


def _resolve_or_die(node, dest):
    if is_hex4(dest):
        return int(dest, 16)
    warmup(node, 4.0)   # presenca para resolver o nome
    nid = node.resolve(dest)
    if nid is None:
        conhecidos = ", ".join("%s(%04X)" % (n["name"], n["id"])
                               for n in node.nodes_list()) or "nenhum"
        die("no \"%s\" desconhecido (ouvidos: %s)" % (dest, conhecidos))
    return nid


def cmd_mesh_send(args):
    data = args.msg.encode("utf-8")
    if not 1 <= len(data) <= MSG_MAX:
        die("mensagem: 1..%d bytes (recebi %d)" % (MSG_MAX, len(data)))
    if args.dry:
        node = build_node(args, dry=True)
        # relogio virtual ANTES de enfileirar: os due_ms nascem nele
        passo = {"t": 0}
        node._now_ms = lambda: (passo.__setitem__("t", passo["t"] + 100)
                                or passo["t"])
        dst = int(args.to, 16) if args.to and is_hex4(args.to) else None
        ok = node.send(dst, data, ttl=args.ttl, urgent=args.urgent,
                       copies=args.copies) if dst else \
            node.broadcast(data, args.ttl)
        if not ok:
            die("recusado (fila cheia?)")
        guarda = 0
        while node.pending and guarda < 1000:
            node.tick()
            guarda += 1
        print("total: %d quadros" % len(node.radio.sent))
        return 0
    node = build_node(args, on_message=print_msg)
    node.radio.start()
    try:
        dst = _resolve_or_die(node, args.to) if args.to else None
        if dst is not None:
            ok = node.send(dst, data, ttl=args.ttl, urgent=args.urgent,
                           copies=args.copies)
            alvo = "%s(%04X)" % (next((n["name"] for n in node.nodes_list()
                                       if n["id"] == dst), ""), dst)
        else:
            ok = node.broadcast(data, args.ttl)
            alvo = "todos"
        if not ok:
            die("recusado (fila cheia?)")
        print("enviado para %s (%d bytes, %d quadro(s) na fila)"
              % (alvo, len(data), len(node.pending)))
        if args.wait > 0:
            t0 = time.monotonic()
            while time.monotonic() - t0 < args.wait:
                pump(node)
    finally:
        node.radio.close()
    return 0


def cmd_mesh_ping(args):
    node = build_node(args)
    node.radio.start()
    rtts = []
    try:
        warmup(node, 4.0)   # o Sonar so responde a quem ele ve no BEAT
        dst = _resolve_or_die(node, args.dest)
        nome = next((n["name"] for n in node.nodes_list() if n["id"] == dst),
                    "%04X" % dst)
        print("ping %s (%d x, \"s?<n>\" urgente)" % (nome, args.count))
        for n in range(1, args.count + 1):
            if not node.send(dst, ("s?%d" % n).encode(), urgent=True, copies=1):
                die("envio recusado (fila cheia?)")
            t0 = time.monotonic()
            got = None
            while time.monotonic() - t0 < 3.0 and got is None:
                pump(node)
                while True:
                    m = node.poll_msg()
                    if m is None:
                        break
                    if m["from"] == dst and m["text"] == "s!%d" % n:
                        got = m
            if got:
                ms = (time.monotonic() - t0) * 1000.0
                rtts.append(ms)
                print("  ping %d: %6.0f ms  hops=%d rssi=%d"
                      % (n, ms, got["hops"], got["rssi"]))
            else:
                print("  ping %d: timeout (3 s)" % n)
            # respiro entre pings sem fechar o BEAT
            t0 = time.monotonic()
            while time.monotonic() - t0 < args.interval:
                pump(node)
    finally:
        node.radio.close()
    if rtts:
        print("%d/%d respondidos - min %.0f ms, media %.0f ms, max %.0f ms"
              % (len(rtts), args.count, min(rtts), sum(rtts) / len(rtts),
                 max(rtts)))
    else:
        print("nenhuma resposta (o app Sonar esta aberto no destino?)")
        return 1
    return 0


def cmd_mesh_census(args):
    node = build_node(args, on_message=lambda m: None)
    node.radio.start()
    nonce = 10 + random.randrange(89)
    respostas = {}
    try:
        warmup(node, 3.0)
        if not node.broadcast(("s*%d" % nonce).encode(), 4):
            die("broadcast recusado (fila cheia?)")
        print("censo s*%d no ar - aguardando %d s..." % (nonce, args.wait))
        t0 = time.monotonic()
        while time.monotonic() - t0 < args.wait:
            pump(node)
            while True:
                m = node.poll_msg()
                if m is None:
                    break
                if m["text"] and m["text"].startswith("s=%d|" % nonce) \
                        and m["from"] not in respostas:
                    partes = m["text"].split("|")
                    respostas[m["from"]] = {
                        "nome": m["from_name"],
                        "bat": partes[1] if len(partes) > 1 else "?",
                        "min": partes[2] if len(partes) > 2 else "?"}
    finally:
        node.radio.close()
    if not respostas:
        print("nenhuma resposta (o app Sonar esta aberto nos nos?)")
        return 1
    print("%-6s %-16s %8s %10s" % ("ID", "NOME", "BATERIA", "LIGADO"))
    for nid in sorted(respostas):
        r = respostas[nid]
        print("%-6s %-16s %7s%% %9s min" % ("%04X" % nid, r["nome"], r["bat"],
                                            r["min"]))
    return 0


# ---------------------------------------------------------------- link CLI --

async def open_and_pair(link, target, code=None, ask=input):
    addr = target if ":" in target else await link.find(target)
    if not addr:
        raise PairFail("device nao encontrado: rode `link scan` primeiro")
    await link.connect(addr)
    res = await pair_flow(link, ask=ask, code=code)
    if res == "fail":
        await link.close()
        raise PairFail("pareamento recusado (codigo errado?)")
    return res


async def _link_scan(args):
    link = LinkClient()
    devs = await link.scan(args.timeout)
    if not devs:
        print("nenhum Celer-* no ar (o app do device liga o Celer Link?)")
        return 1
    for d in devs:
        print("%-20s %s  rssi=%d" % (d["nome"], d["addr"], d["rssi"]))
    return 0


async def _link_pair(args):
    link = LinkClient()
    res = await open_and_pair(link, args.alvo, code=args.code)
    print("pareado com %s (%s)" % (link.addr, res))
    await link.close()
    return 0


async def _link_send(args):
    link = LinkClient()
    await open_and_pair(link, args.alvo, code=args.code)
    await link.send(args.msg)
    print("> %s" % args.msg)
    t0 = time.monotonic()
    while time.monotonic() - t0 < args.wait:
        for m in await link.drain(0.5):
            print("< %s" % (json.dumps(m, separators=(",", ":"))
                            if isinstance(m, dict) else m))
    await link.close()
    return 0


async def _link_chat(args):
    link = LinkClient()
    await open_and_pair(link, args.alvo, code=args.code)
    print("chat aberto com %s - linhas digitadas seguem; ctrl-d/sair encerra"
          % link.addr)
    parar = False

    async def printer():
        while not parar:
            for m in await link.drain(0.5):
                print("< %s" % (json.dumps(m, separators=(",", ":"))
                                if isinstance(m, dict) else m))
    task = asyncio.ensure_future(printer())
    loop = asyncio.get_running_loop()
    try:
        while True:
            line = await loop.run_in_executor(None, input)
            if line.strip() in ("sair", "quit", "exit"):
                break
            if line.strip():
                await link.send(line)
                print("> %s" % line)
    except EOFError:
        pass
    finally:
        parar = True
        await task
        await link.close()
    return 0


def cmd_link_bonds(args):
    if args.rm:
        bonds = load_bonds()
        key = bonds.pop(args.rm.upper(), None)
        save_bonds(bonds)
        print("bond %s %s" % (args.rm, "apagado" if key else "nao existia"))
        return 0
    bonds = load_bonds()
    if not bonds:
        print("nenhum bond guardado em %s" % bonds_path())
        return 0
    for addr in sorted(bonds):
        print("%s  %s" % (addr, bonds[addr].hex()))
    return 0


LINK_CMDS = {"scan": _link_scan, "pair": _link_pair, "send": _link_send,
             "chat": _link_chat}


def cmd_link(args):
    if args.link_cmd == "bonds":
        return cmd_link_bonds(args)
    try:
        return asyncio.run(LINK_CMDS[args.link_cmd](args))
    except PairFail as e:
        print("erro: %s" % e, file=sys.stderr)
        return EX_PAIR


# ------------------------------------------------------------------ parser --

def _build_parser():
    p = argparse.ArgumentParser(
        prog="matilha.py",
        description="o PC entra na matilha: CelerNet (malha BLE, radio HCI "
                    "cru) + CelerLink (GATT, bleak)")
    sub = p.add_subparsers(dest="cmd", required=True)

    comum = argparse.ArgumentParser(add_help=False)
    comum.add_argument("--hci", type=int, default=0, metavar="N",
                       help="adaptador (default 0; dongle dedicado = --hci 1)")
    comum.add_argument("--net", default="celer", help="nome da rede (default celer)")
    comum.add_argument("--id", metavar="XXXX",
                       help="id do no em 4 hex (default: 2 ultimos bytes da MAC)")
    comum.add_argument("--nome", metavar="NOME", help="nome no BEAT (default PC-XXXX)")
    comum.add_argument("--caps", default="hub",
                       help="caps no BEAT: bitmask 0xNN ou nomes hub,speaker,"
                            "mic,display,motors,leds (default hub)")
    comum.add_argument("--relay", action="store_true",
                       help="repetir quadros (o PC como ponte do flood)")

    mesh = sub.add_parser("mesh", help="no CelerNet no PC (requer sudo)")
    msub = mesh.add_subparsers(dest="mesh_cmd", required=True)

    m = msub.add_parser("listen", parents=[comum],
                        help="ouvir a matilha + anunciar presenca")
    m.add_argument("--raw", action="store_true", help="imprimir todo quadro ouvido")
    m.add_argument("--secs", type=float, default=0.0,
                   help="sair apos N segundos (default: ate Ctrl-C)")
    m.set_defaults(func=cmd_mesh_listen)

    m = msub.add_parser("nodes", parents=[comum],
                        help="fotografia da presenca e sai")
    m.add_argument("--secs", type=float, default=16.0,
                   help="janela de escuta (default 16 s)")
    m.set_defaults(func=cmd_mesh_nodes)

    m = msub.add_parser("send", parents=[comum], help="mensagem na malha")
    m.add_argument("msg", help="texto (1..434 bytes)")
    m.add_argument("--to", metavar="ID|NOME", help="unicast (default broadcast)")
    m.add_argument("--ttl", type=int, default=TTL_DEFAULT,
                   help="saltos restantes (default %d, max 8)" % TTL_DEFAULT)
    m.add_argument("--copies", type=int, default=2,
                   help="copias do unicast, 1..3 (default 2)")
    m.add_argument("--urgent", action="store_true", help="furar a fila (handoff)")
    m.add_argument("--wait", type=float, default=0.0,
                   help="segundos ouvindo respostas apos o envio")
    m.add_argument("--dry", action="store_true",
                   help="sem radio: imprime os quadros em hex")
    m.set_defaults(func=cmd_mesh_send)

    m = msub.add_parser("ping", parents=[comum],
                        help="RTT unicast contra o app Sonar (s?/s!)")
    m.add_argument("dest", help="id XXXX ou nome ouvido")
    m.add_argument("--count", type=int, default=5, help="pings (default 5)")
    m.add_argument("--interval", type=float, default=1.0,
                   help="intervalo entre pings em s (default 1)")
    m.set_defaults(func=cmd_mesh_ping)

    m = msub.add_parser("census", parents=[comum],
                        help="censo broadcast contra o app Sonar (s*/s=)")
    m.add_argument("--wait", type=float, default=8.0,
                   help="janela de respostas em s (default 8)")
    m.set_defaults(func=cmd_mesh_census)

    link = sub.add_parser("link", help="cliente CelerLink sobre bleak")
    lsub = link.add_subparsers(dest="link_cmd", required=True)

    l = lsub.add_parser("scan", help="listar Celer-* no ar")
    l.add_argument("--timeout", type=float, default=3.0)
    l.set_defaults(func=cmd_link)

    l = lsub.add_parser("pair", help="conectar + parear (guarda o bond)")
    l.add_argument("alvo", help="nome Celer-XXXX ou endereco MAC")
    l.add_argument("--code", metavar="CCCCCC", help="codigo de 6 digitos")
    l.set_defaults(func=cmd_link)

    l = lsub.add_parser("send", help="uma mensagem (JSON/texto) e sai")
    l.add_argument("alvo", help="nome Celer-XXXX ou endereco MAC")
    l.add_argument("msg", help="conteudo (o app do device interpreta)")
    l.add_argument("--code", metavar="CCCCCC")
    l.add_argument("--wait", type=float, default=2.0,
                   help="segundos coletando respostas (default 2)")
    l.set_defaults(func=cmd_link)

    l = lsub.add_parser("chat", help="REPL: stdin envia, notify imprime")
    l.add_argument("alvo", help="nome Celer-XXXX ou endereco MAC")
    l.add_argument("--code", metavar="CCCCCC")
    l.set_defaults(func=cmd_link)

    l = lsub.add_parser("bonds", help="listar/apagar bonds guardados")
    l.add_argument("--rm", metavar="MAC", help="apagar o bond deste endereco")
    l.set_defaults(func=cmd_link)

    return p


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        return args.func(args) or 0
    except RadioError as e:
        print("erro: %s" % e, file=sys.stderr)
        return EX_RADIO
    except PermissionError:
        print("erro: sem permissao de radio - rode com sudo", file=sys.stderr)
        return EX_ROOT
    except ImportError as e:
        if "bleak" in str(e):
            print("erro: bleak ausente - pip install -r tools/requirements.txt",
                  file=sys.stderr)
            return EX_BLEAK
        raise
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
