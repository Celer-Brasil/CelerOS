#!/usr/bin/env python3
"""Monta o pacote de release de uma placa (firmware + data + flash.json + zip).

Fonte de verdade dos offsets: build-<board>/flasher_args.json (gerado pelo
IDF; bootloader/partition/otadata/app) e o CSV de particoes da placa
(particao littlefs). A imagem LittleFS segue a MESMA logica do
tools/flash_data.sh: data/ + overlay boards/<board>/data, tamanho vindo do
CSV, empacotada com o mklittlefs.bin vendorado.

Uso (dentro do repo, com o build da placa pronto):
    python3 tools/release/package.py --board smartdisplay [--version 1.4.1]

Saida: dist/CelerOS_<ver>_<board>/{firmware/,flash.json,README.txt} e
dist/CelerOS_<ver>_<board>.zip. Multi-plataforma na medida do possivel
(mklittlefs.bin e linux x86_64: empacote no CI linux).
"""

import argparse
import csv
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # repo

# CSV por placa (mesma tabela do tools/flash_data.sh)
PART_CSV = {
    "smartdisplay": "partitions_16MB.csv",
    "spotpear-dog": "partitions_16MB.csv",
    "cyd": "partitions_4MB.csv",
    "waveshare-watch": "partitions_32MB.csv",
}

# apelido "de vitrine" no pacote (o nome interno do build se mantem)
BOARD_LABEL = {
    "smartdisplay": "smartdisplay",
    "cyd": "cyd",
    "spotpear-dog": "spotpear-dog",
    "waveshare-watch": "waveshare-watch",
}


def die(msg: str) -> None:
    print(f"erro: {msg}", file=sys.stderr)
    sys.exit(1)


def repo_version() -> str:
    txt = (ROOT / "CMakeLists.txt").read_text(encoding="utf-8")
    m = re.search(r"project\(CelerOS\s+VERSION\s+(\S+)\)", txt)
    if not m:
        die("versao nao encontrada em CMakeLists.txt")
    return m.group(1)


def littlefs_partition(board: str) -> tuple[str, str]:
    """(offset, size) da particao littlefs no CSV da placa."""
    csv_path = ROOT / PART_CSV[board]
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.reader(line for line in f if not line.lstrip().startswith("#")):
            cells = [c.strip() for c in row]
            if cells and cells[0] == "littlefs":
                return cells[3], cells[4]
    die(f"particao littlefs nao encontrada em {csv_path.name}")


def build_data_image(board: str, out: Path) -> None:
    """Imagem LittleFS de data/ + overlay da placa (espelho do flash_data.sh)."""
    size = littlefs_partition(board)[1]
    stage = Path(tempfile.mkdtemp(prefix="celeros-data-"))
    try:
        shutil.copytree(ROOT / "data", stage, dirs_exist_ok=True)
        overlay = ROOT / "boards" / board / "data"
        if overlay.is_dir():
            shutil.copytree(overlay, stage, dirs_exist_ok=True)
            print(f"  overlay: boards/{board}/data somado")
        # Exclusao da placa: boards/<board>/data-exclude.txt, mesma receita do
        # flash_data.sh (um caminho relativo a data/ por linha, # comenta).
        # A fabrica inteira nao cabe na littlefs de 768 KB da CYD desde que
        # data/modules passou a viajar na imagem.
        excl = ROOT / "boards" / board / "data-exclude.txt"
        if excl.is_file():
            for linha in excl.read_text(encoding="utf-8").splitlines():
                rel = linha.strip()
                if not rel or rel.startswith("#"):
                    continue
                if ".." in rel or rel.startswith("/"):
                    die(f"data-exclude: caminho invalido: {rel}")
                alvo = stage / rel
                if not alvo.exists():
                    die(f"data-exclude: nao existe: {rel}")
                if alvo.is_dir():
                    shutil.rmtree(alvo)
                else:
                    alvo.unlink()
                print(f"  excluido: {rel}")
        mklfs = ROOT / "tools" / "bin" / "mklittlefs.bin"
        if not mklfs.is_file():
            die(f"mklittlefs nao encontrado: {mklfs}")
        mklfs.chmod(0o755)
        res = subprocess.run(
            [str(mklfs), "-c", str(stage), "-s", size, str(out)],
            capture_output=True, text=True)
        if res.returncode != 0:
            die(f"mklittlefs falhou: {res.stderr.strip() or res.stdout.strip()}")
        print(f"  data.img: {out.stat().st_size} bytes ({size} de particao)")
    finally:
        shutil.rmtree(stage, ignore_errors=True)


README_PT = """CelerOS {version} — placa {board}
====================================

Conteudo
--------
  firmware/bootloader.bin          bootloader
  firmware/partition-table.bin     tabela de particoes
  firmware/ota_data_initial.bin    estado inicial do OTA (boota no app0)
  firmware/CelerOS.bin             firmware ({version})
  firmware/data.img                particao de dados (apps de sistema + icones)
  flash.json                       offsets/parametros usados pelo flasher

Como gravar (CelerOS Flasher)
-----------------------------
1. Baixe o CelerOS Flasher do release (linux ou windows) na MESMA pasta
   desta (ou de todas as placas que voce extraiu).
2. Execute o flasher, escolha a placa e a porta, e confirme.
3. Primeira gravacao recomenda "apagar tudo" (limpa NVS antiga).

Como gravar (manual, esptool)
-----------------------------
pip install esptool
esptool.py --chip {target} -p PORTA -b 460800 \\
    --before default-reset --after hard-reset write-flash \\
    {esptool_args}

Apos gravar
-----------
- Configure o WiFi e a hora no primeiro boot (Settings).
- Atualizacoes futuras chegam por OTA (Settings > Atualizacao).
"""


def main() -> None:
    ap = argparse.ArgumentParser(description="empacota o release de uma placa")
    ap.add_argument("--board", required=True, choices=sorted(PART_CSV))
    ap.add_argument("--build-dir", default=None,
                    help="default: build-<board>")
    ap.add_argument("--version", default=None, help="default: lida do CMakeLists.txt")
    ap.add_argument("--out", default=str(ROOT / "dist"))
    args = ap.parse_args()

    board = args.board
    version = args.version or repo_version()
    bdir = ROOT / (args.build_dir or f"build-{board}")
    args_json = bdir / "flasher_args.json"
    if not args_json.is_file():
        die(f"{args_json} nao existe — build a placa antes de empacotar")

    fa = json.loads(args_json.read_text(encoding="utf-8"))
    fs = fa.get("flash_settings", {})
    label = BOARD_LABEL.get(board, board)
    pkg = Path(args.out) / f"CelerOS_{version}_{label}"
    if pkg.exists():
        shutil.rmtree(pkg)
    (pkg / "firmware").mkdir(parents=True)

    print(f"empacotando {board} v{version} -> {pkg}")

    # binarios do build: offset vem do flasher_args (esp32: bootloader@0x1000)
    files = []
    for offset, rel in sorted(fa["flash_files"].items(), key=lambda kv: int(kv[0], 16)):
        src = bdir / rel
        if not src.is_file():
            die(f"binario do build nao encontrado: {src}")
        dst = pkg / "firmware" / src.name
        shutil.copy2(src, dst)
        files.append({"file": f"firmware/{src.name}", "offset": offset})
        print(f"  {src.name} @ {offset}")

    # particao de dados
    data_off, _ = littlefs_partition(board)
    build_data_image(board, pkg / "firmware" / "data.img")
    files.append({"file": "firmware/data.img", "offset": data_off})
    print(f"  data.img @ {data_off}")

    target = {"esp32s3": "esp32s3", "esp32": "esp32"} \
        .get(fa.get("extra_esptool_args", {}).get("chip", ""), "auto")
    manifest = {
        "board": board,
        "target": target,
        "version": version,
        "flash": {"mode": fs.get("flash_mode", "dio"),
                  "size": fs.get("flash_size", "keep"),
                  "freq": fs.get("flash_freq", "80m")},
        "files": files,
    }
    (pkg / "flash.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    esptool_args = " ".join(
        ["--flash-mode", manifest["flash"]["mode"],
         "--flash-size", manifest["flash"]["size"],
         "--flash-freq", manifest["flash"]["freq"]] +
        [f"{f['offset']} {f['file']}" for f in files])
    (pkg / "README.txt").write_text(
        README_PT.format(version=version, board=board, target=target,
                         esptool_args=esptool_args),
        encoding="utf-8")

    # nome + ".zip" (with_suffix comeria o ".1" da versao)
    zpath = pkg.parent / (pkg.name + ".zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(pkg.rglob("*")):
            z.write(p, p.relative_to(pkg.parent))
    print(f"ok: {zpath} ({zpath.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
