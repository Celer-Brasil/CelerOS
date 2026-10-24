#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CelerOS Flasher — gravacao de fabrica via USB (linux/windows).

Procura pacotes de placa (flash.json) ao lado do executavel (ou em
CelerOS_*_*/ uma pasta abaixo), lista as placas e as portas seriais,
oferece apagar o chip (recomendado na 1a gravacao — limpa NVS antiga) e
grava tudo com o esptool embutido (binario PyInstaller).

Sem acentos no output (console do windows em cp1252).

Build do executavel (PyInstaller; --collect-all embute os stubs do esptool):
    pip install "esptool==5.6.0" pyinstaller
    pyinstaller --onefile --console --clean --collect-all esptool \
        --name CelerOS_Flasher tools/release/flasher.py
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import serial.tools.list_ports

HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def find_boards() -> list[dict]:
    """flash.json no diretorio do executavel ou uma pasta abaixo."""
    roots = [HERE, Path.cwd()]
    found = []
    seen = set()
    for root in roots:
        candidates = [root / "flash.json"]
        candidates += sorted(root.glob("*/flash.json"))
        for fj in candidates:
            if not fj.is_file():
                continue
            try:
                m = json.loads(fj.read_text(encoding="utf-8"))
                m["_dir"] = fj.parent
                m["_path"] = fj
                if m.get("board") and m["board"] not in seen:
                    seen.add(m["board"])
                    found.append(m)
            except (ValueError, KeyError):
                pass  # pacote corrompido: ignora silenciosamente no menu
    return found


def list_ports() -> list:
    """So portas USB (CH340/CP210x/FTDI/USB-Serial-JTAG tem vid); se o
    filtro zerar (driver exotico), cai para todas."""
    ports = sorted(serial.tools.list_ports.comports(), key=lambda p: p.device)
    usb = [p for p in ports if p.vid is not None]
    return usb or ports


def pick(message: str, options: list[str], default: int = 1) -> int:
    for i, opt in enumerate(options, 1):
        print(f"  {i}) {opt}")
    while True:
        try:
            raw = input(f"{message} [{default}]: ").strip()
        except EOFError:
            print("\nentrada fechada — cancelado")
            raise SystemExit(1)
        if raw == "":
            return default
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return int(raw)
        print("  opcao invalida")


def run_esptool(argv: list[str]) -> None:
    """esptool como subprocesso de nos mesmos: o esptool.main() so roda
    limpo uma vez por processo (globals/argparse), e o PyInstaller onefile
    permite "re-executar" o exe com a flag --esptool."""
    cmd = [sys.executable, "--esptool"] + [str(a) for a in argv]
    res = subprocess.run(cmd)
    if res.returncode != 0:
        raise SystemExit(f"\nerro: esptool falhou (codigo {res.returncode})")


def esptool_mode(argv_tail: list[str]) -> int:
    """Modo interno: argv[1] == '--esptool' — repassa pro esptool.main()."""
    import esptool
    return esptool.main(argv_tail) or 0


def flash(board: dict, port: str, erase: bool) -> None:
    f = board["flash"]
    common = ["--chip", board.get("target") or "auto",
              "-p", port, "-b", "460800",
              "--before", "default_reset", "--after", "hard_reset"]
    if erase:
        print("\napagando o chip inteiro (isso demora um pouco)...")
        run_esptool(common + ["erase_flash"])
    files = [board["_dir"] / entry["file"] for entry in board["files"]]
    offsets = [entry["offset"] for entry in board["files"]]
    print(f"\ngravando {len(files)} imagens ({sum(p.stat().st_size for p in files) // 1024} KB)...")
    # mode/size/freq ficam nos headers das proprias imagens (build da placa):
    # nao reescrevemos aqui — evita as variacoes de CLI (v4 underscore, v5 dash)
    run_esptool(common + ["write_flash"]
                + [arg for pair in zip(offsets, files) for arg in pair])


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--esptool":
        return esptool_mode(sys.argv[2:])

    print("== CelerOS Flasher ==")
    print("(gravacao de fabrica; atualizacoes futuras chegam por OTA)\n")

    boards = find_boards()
    if not boards:
        print("nenhum pacote de placa encontrado (flash.json).")
        print("extraia o zip da sua placa na MESMA pasta deste executavel.")
        return 1

    labels = [f"{b['board']}  v{b.get('version', '?')}" for b in boards]
    b = boards[pick("placa", labels) - 1]
    print(f"\nplaca: {b['board']} ({len(b['files'])} imagens)")

    ports = list_ports()
    if not ports:
        print("\nnenhuma porta serial encontrada — conecte a placa por USB.")
        return 1
    port_labels = [f"{p.device} — {p.description}" for p in ports]
    port = ports[pick("porta", port_labels) - 1].device

    erase = pick("apagar o chip inteiro antes? (recomendado na 1a gravacao)",
                 ["nao (preserva NVS/wifi)", "sim, apagar tudo"], default=2) == 2

    print(f"\n{b['board']} em {port} — ENTER para comecar, Ctrl+C cancela")
    try:
        input()
    except EOFError:
        pass  # entrada piped: segue direto (uso em script)
    flash(b, port, erase)
    print("\nOK! A placa reiniciou no CelerOS.")
    print("Proximos passos no aparelho: idioma, WiFi e hora (Settings).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ncancelado")
        sys.exit(130)
