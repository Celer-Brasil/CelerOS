#!/usr/bin/env python3
"""Bancada de marcha do Dog Face pela BLE (Celer Link).

Cliente do protocolo Celer Link do cachorro (main/Bluetooth/CelerLink.cpp):
conecta, pareia pelo codigo de 6 digitos que aparece no OLED, manda JSON e
le a telemetria/avisos pelo notify. O "sweep" roda a bateria de afinamento
(lean x speed, knobs fieis ao servo_dog_ctrl) com o operador dando a nota
de deslocamento de cada combinacao — o operador e o sensor, o CSV e a prova.

    python3 tools/dog/dogtune.py scan
    python3 tools/dog/dogtune.py send '{"type":"calib"}'
    python3 tools/dog/dogtune.py tel
    python3 tools/dog/dogtune.py sweep                      # grade lean x speed
    python3 tools/dog/dogtune.py sweep --plan plano.json    # combos com "tune"

Plano JSON = lista de combos; cada combo pode trazer "tune" literal (vale
para qualquer knob: hop, trim, flip...) alem de gait/walk_ms. Exemplo (varre
a inclinacao inicial das traseiras do hop):

    [{"tune":{"hop":{"rear":30}},"gait":"hop","walk_ms":4000},
     {"tune":{"hop":{"rear":40}},"gait":"hop","walk_ms":4000}]

Requer bleak (pip install bleak / tools/requirements.txt). Pareamento: o
primeiro connect pede o codigo do vidro; depois o bond guarda (hold 5 s no
touch pad do cao esquece todos os pareados).
"""

import argparse
import asyncio
import csv
import json
import os
import sys
import time
from pathlib import Path

# UUIDs do Celer Link (CelerLink.cpp, kSvcUuid/kChrUuid/kPairUuid)
SVC_UUID = "b3a667a2-fdac-5298-8c13-89c980f2d1f1"
CHR_MSG = "b3a667a2-fdac-5298-8c13-89c980f2d1f2"   # write (JSON) + notify (respostas)
CHR_PAIR = "b3a667a2-fdac-5298-8c13-89c980f2d1f3"  # read estado / write codigo

PAIR_OPEN, PAIR_WAIT, PAIR_OK = 0x00, 0x01, 0x02
MAX_MSG = 240   # firmware: MTU-3 com MTU 256

DEFAULT_LEANS = [0, 10, 20, 30]
DEFAULT_SPEEDS = [50, 80, 120, 160]


# ------------------------------------------------------------- link ---------
class BleakLink:
    """Celer Link sobre bleak. bleak e importado na conexao (modulo roda sem
    ele — os testes injetam um link falso)."""

    def __init__(self, addr=None):
        self.addr = addr
        self.client = None
        self.rx = []

    async def scan(self, timeout=5.0):
        from bleak import BleakScanner  # import tardio: so na bancada
        devs = await BleakScanner.discover(timeout=timeout)
        return sorted([d for d in devs if d.name and d.name.startswith("Celer-")],
                      key=lambda d: d.name)

    async def connect(self, addr):
        from bleak import BleakScanner, BleakClient
        if not addr:
            found = await self.scan()
            if not found:
                raise RuntimeError("nenhum Celer-* no ar (o cao anuncia 'Celer-XXXX')")
            addr = found[0].address
        self.addr = addr
        self.client = BleakClient(addr)
        await self.client.connect()
        await self.client.start_notify(CHR_MSG, self._on_notify)

    def _on_notify(self, _h, data):
        try:
            self.rx.append(json.loads(data.decode()))
        except (ValueError, UnicodeDecodeError):
            self.rx.append({"type": "raw", "data": data.hex()})

    async def pair_state(self):
        b = await self.client.read_gatt_char(CHR_PAIR)
        return b[0] if b else PAIR_OPEN

    async def write_pair_code(self, code):
        await self.client.write_gatt_char(CHR_PAIR, str(code).encode(), response=True)

    async def send(self, obj):
        data = json.dumps(obj).encode()
        if len(data) > MAX_MSG:
            raise ValueError("payload > %d bytes: %r" % (MAX_MSG, data[:60]))
        await self.client.write_gatt_char(CHR_MSG, data, response=False)

    async def read(self, timeout=1.0):
        # espera uma mensagem nova: drena self.rx com prazo
        deadline = time.monotonic() + timeout
        while not self.rx and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        return self.rx.pop(0) if self.rx else None

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


async def pair_flow(link, ask=input, code=None):
    """Pareamento pelo codigo do vidro. Estado 0x02 = liberado (bond do
    central guarda; reconexoes caem direto aqui). Devolve True se liberado."""
    st = await link.pair_state()
    if st == PAIR_OK:
        return True
    if st != PAIR_WAIT:
        # K_PAIR_OFF (CelerLink.cpp): link ABERTO (s_pairRequired=0 ou char
        # ausente) — nao existe gate, escrever direto. Tratar como falha
        # recusava o cao sem pareamento exigido com "codigo errado 3x?"
        # (matilha.py, o generalizado deste fluxo, devolve "aberto")
        return True
    for _ in range(3):
        if code is None:
            code = ask("codigo de 6 digitos no OLED do cao: ").strip()
        await link.write_pair_code(code)
        await asyncio.sleep(0.3)
        if await link.pair_state() == PAIR_OK:
            return True
        code = None   # errou: pergunta de novo (3 tentativas derrubam)
    return False


# ------------------------------------------------------------- sweep --------
def build_plan(leans=None, speeds=None, gait="walk", walk_ms=3000):
    leans = leans if leans is not None else DEFAULT_LEANS
    speeds = speeds if speeds is not None else DEFAULT_SPEEDS
    return [{"lean": l, "speed": s, "gait": gait, "walk_ms": walk_ms}
            for l in leans for s in speeds]


def parse_score(ans, ask=input):
    """0..3 = nota; 'r' = repete a combinacao; 's' = encerra a bateria."""
    ans = ans.strip().lower()
    if ans in ("s", "sair"):
        return "stop"
    if ans in ("r", "de novo", "repetir"):
        return "repeat"
    if ans in ("", "0", "1", "2", "3"):
        try:
            v = int(ans) if ans else 0
        except ValueError:
            v = -1
        if 0 <= v <= 3:
            return v
    return parse_score(ask("nota 0-3 (r=repetir, s=sair): "), ask)


def combo_tune(c):
    """Tune a mandar pela combinacao: objeto "tune" literal (ex.: hop) ou o
    par lean/speed da grade classica."""
    if "tune" in c:
        msg = {"type": "tune"}
        msg.update(c["tune"])
        return msg
    return {"type": "tune", "lean": c["lean"], "speed": c["speed"]}


def combo_label(c):
    if "tune" in c:
        return json.dumps(c["tune"], ensure_ascii=False)
    return "lean=%s speed=%s" % (c["lean"], c["speed"])


async def run_sweep(link, plan, ask=input, out=None, quiet=0.6):
    """Para cada combinacao: tune -> andar -> stop -> nota do operador.
    Devolve a lista de linhas {**combo, score}."""
    rows = []
    f = None
    w = None
    if out:
        f = open(out, "w", newline="")
        w = csv.writer(f)
        w.writerow(["combo", "score"])
    i = 0
    while i < len(plan):
        c = plan[i]
        print("\n[%d/%d] %s (%s por %d ms) — prepare o cao"
              % (i + 1, len(plan), combo_label(c), c["gait"], c["walk_ms"]))
        await link.send(combo_tune(c))
        rep = await link.read(timeout=2.0)
        if not (rep and rep.get("type") in ("tune", "hop")):
            print("  ! sem reply do tune — conferindo link")
        await link.send({"type": "gait", "name": c["gait"], "repeat": True})
        await asyncio.sleep(c["walk_ms"] / 1000.0)
        await link.send({"type": "stop"})
        await link.drain(quiet)
        score = parse_score(ask("  deslocamento? (0=parado 1=ensaia 2=anda 3=anda bem; r/s): "), ask)
        if score == "stop":
            print("  bateria encerrada pelo operador")
            break
        if score == "repeat":
            print("  repetindo combinacao")
            continue
        rows.append({"combo": combo_label(c), "score": score})
        if w:
            w.writerow([combo_label(c), score])
        i += 1
    if f:
        f.close()
    return rows


def rank(rows):
    by = {}
    for r in rows:
        by.setdefault(r["combo"], []).append(r["score"])
    return sorted(((sum(v) / len(v), k) for k, v in by.items()), reverse=True)


# ------------------------------------------------------------- cli ----------
def main(argv=None):
    ap = argparse.ArgumentParser(description="bancada de marcha do cao (Dog Face) pela BLE")
    ap.add_argument("--addr", help="endereco BLE (default: primeiro Celer-* do scan)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan", help="lista os Celer-* no ar")
    sp = sub.add_parser("send", help="manda um JSON pelo Celer Link")
    sp.add_argument("json")
    tp = sub.add_parser("tel", help="espera UMA telemetria e imprime")
    wp = sub.add_parser("sweep", help="bateria guiada lean x speed com nota do operador")
    wp.add_argument("--lean", type=int, nargs="*", help="lista de leans (default %s)" % DEFAULT_LEANS)
    wp.add_argument("--speed", type=int, nargs="*", help="lista de speeds (default %s)" % DEFAULT_SPEEDS)
    wp.add_argument("--gait", default="walk", help="marcha da bateria (default walk)")
    wp.add_argument("--walk-ms", type=int, default=3000)
    wp.add_argument("--plan", help="JSON com a lista de combos (vence --lean/--speed)")
    wp.add_argument("--out", default="dogtune.csv")
    wp.add_argument("--dry", action="store_true", help="so imprime o plano")
    args = ap.parse_args(argv)

    async def run():
        link = BleakLink(args.addr)
        if args.cmd == "scan":
            for d in await link.scan():
                print("%-20s %s" % (d.name, d.address))
            return
        plan = None
        if args.cmd == "sweep":
            plan = (json.loads(Path(args.plan).read_text()) if args.plan
                    else build_plan(args.lean, args.speed, args.gait, args.walk_ms))
            if not isinstance(plan, list) or not plan:
                ap.error("--plan deve ser uma lista nao vazia de combos")
            if args.dry:
                for c in plan:
                    print("%s | %s %sms" % (combo_label(c), c["gait"], c["walk_ms"]))
                return
        try:
            await link.connect(args.addr)
        except ImportError:
            print("sem bleak: pip install bleak (ou tools/requirements.txt)", file=sys.stderr)
            return 2
        try:
            if not await pair_flow(link):
                print("pareamento nao liberou (codigo errado 3x? expira em 60 s)", file=sys.stderr)
                return 3
            if args.cmd == "send":
                await link.send(json.loads(args.json))
                for m in await link.drain(2.0):
                    print(json.dumps(m, ensure_ascii=False))
            elif args.cmd == "tel":
                m = await link.read(timeout=6.0)
                print(json.dumps(m, ensure_ascii=False) if m else "(sem telemetria)")
            elif args.cmd == "sweep":
                rows = await run_sweep(link, plan, out=args.out)
                print("\nranking (media das notas):")
                for media, combo in rank(rows):
                    print("  %-44s nota=%.1f" % (combo, media))
                best = rank(rows)[0] if rows else None
                if best:
                    print("\nmelhor: tune %s — reenviando pra salvar no cao" % best[1])
                    await link.send(combo_tune({"tune": json.loads(best[1])}))
                    await asyncio.sleep(0.5)
        finally:
            await link.close()
    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main() or 0)
