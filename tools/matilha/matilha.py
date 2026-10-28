#!/usr/bin/env python3
"""matilha - cliente CelerLink (GATT) do PC: o pilar de CONFIANCA da matilha.

  link *  cliente CelerLink (main/Bluetooth/CelerLink.cpp) sobre bleak:
          scan, pareamento pelo codigo de 6 digitos, bond v2 (reconecta sem
          digitar o codigo de novo) e chat/send com o app que esta aberto no
          device (Dog Face: telemetria/comandos JSON; veja o Celer Remote).

O PC na MALHA (presenca, mensagens, recursos de outros nos, entrar na
matilha) e o pilar do gateway: um aparelho CelerOS no cabo poe o PC como
membro virtual pc-XXXX — `celerctl mesh status|join|send|listen` e
`celerctl res ...` (Documentation/CelerNet_Design.pt-BR.md §8.5). O antigo
`matilha mesh` (no BLE cru por HCI, NetFrame v2 em claro) saiu na API 41:
a malha e cifrada desde a v3 e ele nao falava mais com nenhum firmware.

Exemplos:

    python3 tools/matilha/matilha.py link scan
    python3 tools/matilha/matilha.py link pair Celer-D001
    python3 tools/matilha/matilha.py link chat Celer-D001
    python3 tools/matilha/matilha.py link send Celer-D001 '{"type":"tel"}'

Requer bleak (pip install -r tools/requirements.txt).
Exit codes: 2 sem bleak, 3 pareamento.
"""

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
from pathlib import Path
EX_BLEAK = 2
EX_PAIR = 3

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
    # cria JA privado (0600 na criacao): gravar primeiro e chmod depois
    # deixava a chave legivel para outros usuarios na janela entre os dois
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps({a: k.hex() for a, k in sorted(bonds.items())}))


# ------------------------------------------------------------- motor malha --


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
    try:
        await link.send(args.msg)
    except ValueError:
        # payload grande: traceback bruto deixava o link BLE aberto no exit
        await link.close()
        print("erro: payload > %d bytes (limite MTU do firmware)" % MAX_MSG,
              file=sys.stderr)
        return 1
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
                try:
                    await link.send(line)
                except ValueError:
                    print("erro: linha > %d bytes, nao enviada" % MAX_MSG,
                          file=sys.stderr)
                    continue
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
        description="cliente CelerLink (GATT, bleak): pareamento por codigo e mensagens")
    sub = p.add_subparsers(dest="cmd", required=True)

    mesh = sub.add_parser("mesh", help="(saiu na API 41) o PC na malha e o gateway: celerctl mesh")
    mesh.add_argument("resto", nargs=argparse.REMAINDER)
    mesh.set_defaults(func=cmd_mesh_saiu)

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

def cmd_mesh_saiu(args):
    print("o PC entra na malha pelo gateway (um aparelho no cabo): "
          "celerctl mesh status|join|send|listen e celerctl res ... "
          "(o no BLE cru deste script falava NetFrame v2, sem a cripto da v3)", file=sys.stderr)
    return 2


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        return args.func(args) or 0
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
