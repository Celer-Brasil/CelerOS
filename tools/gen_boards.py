#!/usr/bin/env python3
"""Manifest unico das placas: valida os 5+ lugares que uma placa toca.

Uma placa hoje vive em boards/<b>/sdkconfig.defaults, main/Boards/<b>/Board.cpp,
um CSV de particoes, a matrix do CI, o BOARDS do size_report, o case do
flash_data.sh e um canal em updates/. O manifest (boards/boards.json) diz o que
e verdade; este script confere o resto e falha apontando a divergencia.

    python3 tools/gen_boards.py --check     # validador (CI/test)
    python3 tools/gen_boards.py --matrix    # bloco da matrix do CI p/ conferir

Nao reescreve arquivo nenhum: YAML e shell gerados sao faceis de quebrar sem
revisao; a validacao e o gate. sdkconfig.defaults continua manual (tem tuning
medido e comentado).
"""

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_REL = Path("boards") / "boards.json"

PSRAM_MODES = {"none", "quad", "octal"}


def load(root=ROOT):
    """id -> config da placa (dict do boards.json)."""
    path = Path(root) / MANIFEST_REL
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["boards"]


def read_text(path):
    """Leitura tolerante: arquivo ausente vira '' (o validador reporta)."""
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def matrix_boards(text):
    """id -> target do bloco include da matrix do build.yml."""
    return dict(
        re.findall(r"-\s*board:\s*([\w-]+)\s*\n\s*target:\s*([\w-]+)", text)
    )


def flash_data_boards(text):
    """id -> csv dos cases PART_CSV do flash_data.sh.

    O primeiro case do script (porta default) nao tem PART_CSV e fica de fora;
    o catch-all '*') tambem (o regex exige 'PART_CSV=' depois do ')').
    """
    out = {}
    for ids, csv in re.findall(
        r'^\s*([a-z0-9|_-]+)\)\s*PART_CSV="([^"]+)"', text, re.MULTILINE
    ):
        for b in ids.split("|"):
            out[b] = csv
    return out


def cmake_boards(text):
    """ids com if(CELEROS_BOARD STREQUAL "<id>") no main/CMakeLists.txt."""
    return set(re.findall(r'CELEROS_BOARD STREQUAL "([^"]+)"', text))


def sdkconfig_flash_mb(text):
    """CONFIG_ESPTOOLPY_FLASHSIZE_<n>MB=y -> n (None se nao declarado)."""
    m = re.search(r"CONFIG_ESPTOOLPY_FLASHSIZE_(\d+)MB=y", text)
    return int(m.group(1)) if m else None


def sdkconfig_psram(text):
    """'none' | 'quad' | 'octal' conforme o sdkconfig da placa.

    Le so o defaults da placa; o root nao liga SPIRAM (se um dia ligar, o
    check acusa porque a placa sem PSRAM passaria a declarar '?').
    """
    if not re.search(r"^CONFIG_SPIRAM=y", text, re.MULTILINE):
        return "none"
    m = re.search(r"^CONFIG_SPIRAM_MODE_(OCT|QUAD)=y", text, re.MULTILINE)
    if not m:
        return "?"
    return {"oct": "octal", "quad": "quad"}[m.group(1).lower()]


def validate(root=ROOT):
    """Lista de erros (vazia = manifest e os 5 lugares concordam)."""
    root = Path(root)
    errors = []
    try:
        boards = load(root)
    except (OSError, ValueError) as exc:
        return [f"boards/boards.json ilegivel: {exc}"]

    for board, cfg in boards.items():
        bdir = root / "boards" / board
        defaults = bdir / "sdkconfig.defaults"
        if not defaults.is_file():
            errors.append(f"{board}: falta boards/{board}/sdkconfig.defaults")
        if not (root / "main" / "Boards" / board / "Board.cpp").is_file():
            errors.append(f"{board}: falta main/Boards/{board}/Board.cpp")

        csv = cfg.get("partitions")
        if not csv or not (root / csv).is_file():
            errors.append(f"{board}: particao {csv!r} nao existe na raiz")

        channel = cfg.get("ota_channel")
        if not channel or not (root / "updates" / channel).is_dir():
            errors.append(f"{board}: canal de OTA {channel!r} nao existe em updates/")

        psram = cfg.get("psram")
        if psram not in PSRAM_MODES:
            errors.append(f"{board}: psram={psram!r} invalido (use none/quad/octal)")

        text = read_text(defaults) if defaults.is_file() else ""
        flash_mb = sdkconfig_flash_mb(text)
        if flash_mb is not None and cfg.get("flash_mb") != flash_mb:
            errors.append(
                f"{board}: flash_mb={cfg.get('flash_mb')} != sdkconfig {flash_mb}"
            )
        psram_cfg = sdkconfig_psram(text)
        if psram != psram_cfg:
            errors.append(f"{board}: psram={psram} != sdkconfig {psram_cfg}")

        has_overlay = (bdir / "data").is_dir()
        if bool(cfg.get("data_overlay")) != has_overlay:
            errors.append(
                f"{board}: data_overlay={cfg.get('data_overlay')} mas "
                f"boards/{board}/data {'existe' if has_overlay else 'nao existe'}"
            )
        has_exclude = (bdir / "data-exclude.txt").is_file()
        if bool(cfg.get("data_exclude")) != has_exclude:
            errors.append(
                f"{board}: data_exclude={cfg.get('data_exclude')} mas "
                f"boards/{board}/data-exclude.txt "
                f"{'existe' if has_exclude else 'nao existe'}"
            )

    # Pastas em boards/ com defaults que nao estao no manifest.
    extras = sorted(
        d.name
        for d in (root / "boards").iterdir()
        if d.is_dir()
        and (d / "sdkconfig.defaults").is_file()
        and d.name not in boards
    )
    for name in extras:
        errors.append(f"boards/{name}: tem defaults mas nao esta no manifest")

    # Matrix do CI.
    matrix = matrix_boards(read_text(root / ".github" / "workflows" / "build.yml"))
    for board, target in matrix.items():
        if board not in boards:
            errors.append(f"CI: {board} nao esta no manifest")
        elif boards[board].get("target") != target:
            errors.append(
                f"CI: {board} target={target} != manifest {boards[board].get('target')}"
            )
    for board in boards:
        if board not in matrix:
            errors.append(f"CI: falta {board} na matrix do build.yml")

    # flash_data.sh.
    flash = flash_data_boards(read_text(root / "tools" / "flash_data.sh"))
    for board, cfg in boards.items():
        if board not in flash:
            errors.append(f"flash_data: falta caso PART_CSV para {board}")
        elif flash[board] != cfg.get("partitions"):
            errors.append(
                f"flash_data: {board} usa {flash[board]} != manifest {cfg.get('partitions')}"
            )
    for board in flash:
        if board not in boards:
            errors.append(f"flash_data: {board} nao esta no manifest")

    # Selecao de placa no CMake.
    cmake = cmake_boards(read_text(root / "main" / "CMakeLists.txt"))
    for board in boards:
        if board not in cmake:
            errors.append(f'CMake: falta CELEROS_BOARD STREQUAL "{board}"')
    for board in cmake:
        if board not in boards:
            errors.append(f"CMake: {board} nao esta no manifest")

    return errors


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="valida manifest x CI/flash/CMake/sdkconfig")
    ap.add_argument("--matrix", action="store_true", help="imprime o bloco da matrix do CI")
    args = ap.parse_args()

    if args.matrix:
        for board, cfg in load().items():
            print(f"          - board: {board}")
            print(f"            target: {cfg['target']}")
        return 0

    if not args.check:
        ap.print_help()
        return 2

    errors = validate()
    if errors:
        print("FALHAS:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"OK: manifest consistente para {len(load())} placas")
    return 0


if __name__ == "__main__":
    sys.exit(main())
