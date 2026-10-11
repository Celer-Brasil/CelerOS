#!/usr/bin/env python3
"""Relatorio de tamanho do firmware CelerOS + orcamento do slot OTA.

Uso (com o ambiente ESP-IDF exportado, apos `idf.py build`):
  python3 tools/size_report.py                       # as duas placas
  python3 tools/size_report.py --board cyd --top 20
  python3 tools/size_report.py --save-baseline .omo/size_baseline.json
  python3 tools/size_report.py --baseline .omo/size_baseline.json

Sai com codigo 1 se alguma placa ficar com menos de --min-free-kb livres no
slot OTA (padrao 64 KB): toda feature nova passa a ter custo visivel.
"""
import argparse
import csv
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BOARDS = {
    "smartdisplay": {"build": "build", "csv": "partitions_16MB.csv"},
    "cyd": {"build": "build-cyd", "csv": "partitions_4MB.csv"},
    "cyd-vspi": {"build": "build-cyd-vspi", "csv": "partitions_4MB.csv"},
    "spotpear-dog": {"build": "build-dog", "csv": "partitions_16MB.csv"},
    "waveshare-watch": {"build": "build-watch", "csv": "partitions_32MB.csv"},
    "devkit": {"build": "build-devkit", "csv": "partitions_4MB.csv"},
    "esp32-cam": {"build": "build-esp32-cam", "csv": "partitions_4MB_cam.csv"},
}


def slot_size(csv_name):
    with open(os.path.join(ROOT, csv_name)) as f:
        for row in csv.reader(f):
            if row and row[0].strip() == "app0":
                return int(row[4].strip(), 0)
    raise SystemExit(f"app0 nao encontrada em {csv_name}")


def archive_sizes(map_path):
    cmd = [sys.executable, "-m", "esp_idf_size", "--format", "json2", "--archives", map_path]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"  (esp_idf_size indisponivel: {e}; exporte o ambiente do IDF)")
        return {}
    data = json.loads(out)
    return {os.path.basename(k): v.get("size", 0) for k, v in data.items()}


def measure(board):
    cfg = BOARDS[board]
    # Local usa apelidos curtos (build-cyd, build-dog...); o CI constroi em
    # build-<board>. Procura o apelido primeiro e cai no padrao do CI — sem
    # isso o gate do slot OTA pulava silenciosamente ("sem build") no CI.
    bdir = None
    for cand in (cfg["build"], f"build-{board}"):
        p = os.path.join(ROOT, cand)
        if os.path.exists(os.path.join(p, "CelerOS.bin")):
            bdir = p
            break
    if bdir is None:
        return None
    return {
        "image": os.path.getsize(os.path.join(bdir, "CelerOS.bin")),
        "slot": slot_size(cfg["csv"]),
        "archives": archive_sizes(os.path.join(bdir, "CelerOS.map")),
        "stale": stale_source(bdir),
    }


def stale_source(bdir):
    """Fonte rastreado pelo git mais novo que o CelerOS.bin daquele build.

    Pega exatamente o caso do build morto no meio (SIGPIPE num pipe com
    grep -m1, Ctrl-C...): o size_report media o binario VELHO e o delta
    mentia sem aviso. None = binario fresco (ou sem git/fonte).
    """
    try:
        bin_mtime = os.path.getmtime(os.path.join(bdir, "CelerOS.bin"))
    except OSError:
        return None
    try:
        out = subprocess.run(
            ["git", "-C", ROOT, "ls-files", "main", "components"],
            capture_output=True, text=True, check=True, timeout=10,
        ).stdout.splitlines()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return None
    newest, newest_t = None, 0.0
    for p in out:
        if not p.endswith((".cpp", ".h", ".c")):
            continue
        try:
            t = os.path.getmtime(os.path.join(ROOT, p))
        except OSError:
            continue
        if t > newest_t:
            newest, newest_t = p, t
    if newest is not None and newest_t > bin_mtime:
        return newest
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", choices=[*BOARDS, "all"], default="all")
    ap.add_argument("--top", type=int, default=12, help="bibliotecas listadas por placa")
    ap.add_argument("--min-free-kb", type=int, default=64)
    ap.add_argument("--baseline", help="JSON salvo antes; mostra o delta por biblioteca")
    ap.add_argument("--save-baseline", help="grava as medidas atuais neste JSON")
    args = ap.parse_args()

    boards = list(BOARDS) if args.board == "all" else [args.board]
    base = {}
    if args.baseline:
        with open(args.baseline) as f:
            base = json.load(f)

    results, failed = {}, False
    for b in boards:
        m = measure(b)
        if m is None:
            print(f"[{b}] sem build ({BOARDS[b]['build']}/CelerOS.bin)")
            continue
        results[b] = m
        free = m["slot"] - m["image"]
        pct = 100.0 * m["image"] / m["slot"]
        line = f"[{b}] imagem {m['image']:,} B / slot {m['slot']:,} B ({pct:.1f}%) livre {free // 1024} KB"
        old = base.get(b)
        if old:
            line += f"  delta {m['image'] - old['image']:+,} B"
        print(line)
        if m["stale"]:
            print(f"  (ATENCAO: bin mais velho que {m['stale']} — build interrompido? remonte antes de confiar)")
        arch = m["archives"]
        names = sorted(set(arch) | set(old["archives"] if old else {}), key=lambda k: -arch.get(k, 0))
        for name in names[: args.top]:
            s = f"    {arch.get(name, 0):>9,}  {name}"
            if old:
                d = arch.get(name, 0) - old["archives"].get(name, 0)
                if d:
                    s += f"  ({d:+,})"
            print(s)
        if old:
            moved = [(n, arch.get(n, 0) - old["archives"].get(n, 0)) for n in names[args.top:]]
            moved = [x for x in moved if abs(x[1]) >= 1024]
            for n, d in sorted(moved, key=lambda x: x[1]):
                print(f"    {'':>9}  {n}  ({d:+,})")
        if free < args.min_free_kb * 1024:
            print(f"  ORCAMENTO ESTOURADO: menos de {args.min_free_kb} KB livres no slot OTA")
            failed = True

    if args.save_baseline:
        os.makedirs(os.path.dirname(os.path.abspath(args.save_baseline)), exist_ok=True)
        with open(args.save_baseline, "w") as f:
            json.dump(results, f, indent=1)
        print(f"baseline gravada em {args.save_baseline}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
