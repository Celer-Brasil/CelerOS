#!/usr/bin/env python3
"""Relatorio de tamanho do firmware CelerOS + orcamento do slot OTA.

Uso (com o ambiente ESP-IDF exportado, apos `idf.py build`):
  python3 tools/size_report.py                       # as duas placas
  python3 tools/size_report.py --board cyd --top 20
  python3 tools/size_report.py --save-baseline .omo/size_baseline.json
  python3 tools/size_report.py --baseline .omo/size_baseline.json
  python3 tools/size_report.py --check-budget tools/size_baseline.json
  python3 tools/size_report.py --board cyd --per-object 20
  python3 tools/size_report.py --save-ledger tools/size_ledger.json
  python3 tools/size_report.py --check-ledger tools/size_ledger.json

Sai com codigo 1 se alguma placa ficar com menos de --min-free-kb livres no
slot OTA (padrao 64 KB) ou, com --check-budget, se a imagem crescer mais de
--max-growth-kb (padrao 8 KB) em relacao ao baseline. O baseline e o teto sao
deliberados: placa nova precisa entrar no JSON num commit proprio, senao o
check falha (crescimento nao passa despercebido).

O ledger (--save-ledger/--check-ledger) e o orcamento POR OBJETO: enquanto o
baseline olha a imagem inteira, o ledger olha os objetos de main/libmain.a,
que sao os que o CelerOS controla. Cada onda de migracao C++->JS grava o
ledger no MESMO commit em que mexe no tamanho; o gate falha se um objeto
crescer mais de --max-object-growth (padrao 512 B) sem essa atualizacao.
"""
import argparse
import csv
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Fonte unica do build por placa (validada por tools/gen_boards.py --check):
# o manifest evita a lista duplicada que deixou o cyd-vspi fora do flash_data.
BOARDS_JSON = os.path.join(ROOT, "boards", "boards.json")


def load_boards():
    with open(BOARDS_JSON, encoding="utf-8") as f:
        data = json.load(f)
    return {
        board: {"build": cfg["build_dir"], "csv": cfg["partitions"]}
        for board, cfg in data["boards"].items()
    }


BOARDS = load_boards()

# Archive cujo conteudo o repo controla: e o que o ledger vigia. Bibliotecas
# do IDF (wifi, TLS, Duktape) variam com a versao do IDF e nao entram.
LEDGER_ARCHIVES = ("libmain.a",)


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


def file_sizes(map_path, archives=LEDGER_ARCHIVES):
    """Tamanho por objeto, CONTANDO SO CODIGO + RAM (fora o Flash Data).

    O `--files` do esp_idf_size le o mapa do linker, e o mapa atribui ao
    primeiro objeto de um grupo o vao inteiro ate a proxima secao listada:
    no build da CYD o `.rodata.esp_stdio_register.str1.1` aparece com 91.496 B
    quando o objeto real tem 76 B (conferido com xtensa-esp32-elf-size). Ou
    seja, tamanho de rodata por objeto NAO e confiavel no mapa.

    Codigo (`.text`, IRAM) e DRAM sao por simbolo e batem com o objeto, entao
    o ledger vigia so eles. Dados grandes (fontes, tabelas, bundles) seguem
    cobertos pelo gate da imagem inteira (--check-budget).
    """
    cmd = [sys.executable, "-m", "esp_idf_size", "--format", "json2", "--files", map_path]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"  (esp_idf_size --files indisponivel: {e}; exporte o ambiente do IDF)")
        return {}
    data = json.loads(out)
    sizes = {}
    for key, val in data.items():
        archive, _, obj = key.rpartition(":")
        if not obj or os.path.basename(archive) not in archives:
            continue
        mem = val.get("memory_types") or {}
        code_ram = sum(int(v.get("size", 0)) for k, v in mem.items()
                       if k != "Flash Data")
        sizes[obj] = code_ram
    return sizes


def measure(board, want_files=False):
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
    map_path = os.path.join(bdir, "CelerOS.map")
    out = {
        "image": os.path.getsize(os.path.join(bdir, "CelerOS.bin")),
        "slot": slot_size(cfg["csv"]),
        "archives": archive_sizes(map_path),
        "stale": stale_source(bdir),
    }
    if want_files:
        out["files"] = file_sizes(map_path)
    return out


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


def budget_problems(measured, baseline, selected, max_growth_kb):
    """Problemas do teto de crescimento, um (placa, motivo) por falha.

    Funcao pura: `measured` e `baseline` sao {placa: {image, stale?}}, e
    `selected` e a lista de placas que ESTA execucao deveria medir (o CI
    roda uma por job). Baseline ausente, medida ausente e bin stale contam
    como falha: o teto so vale quando o numero e confiavel.
    """
    out = []
    for b in selected:
        m = measured.get(b)
        if m is None:
            if b in baseline:
                out.append((b, "esta no baseline e nao foi medido"))
            continue
        prev = baseline.get(b)
        if prev is None:
            out.append((b, "sem entrada no baseline (grave --save-baseline de proposito)"))
            continue
        if m.get("stale"):
            out.append((b, f"bin stale ({m['stale']}); remonte antes de confiar"))
        growth = m["image"] - int(prev["image"])
        if growth > max_growth_kb * 1024:
            out.append((b, f"cresceu {growth:+,} B (teto {max_growth_kb} KB)"))
    return out


def ledger_problems(current, ledger, selected, max_growth):
    """Problemas do orcamento por objeto, um (placa, objeto, motivo) por falha.

    Funcao pura: `current` e `ledger` sao {placa: {objeto: bytes}}. Objeto novo
    acima do teto conta como falha: o ledger so vale quando alguem olhou o
    numero e o aprovou no mesmo commit. Encolher nunca e problema.

    Placa fora do ledger NAO falha: o ledger e um catraca por placa, adotada
    quando ela e medida com o build fresco (o baseline da imagem ja cobre a
    presenca). Assim o CI de uma placa recem-adicionada nao quebra antes de
    alguem gravar o numero dela.
    """
    out = []
    for b in selected:
        cur = current.get(b)
        if cur is None:
            if b in ledger:
                out.append((b, "-", "esta no ledger e nao foi medido"))
            continue
        prev = ledger.get(b)
        if prev is None:
            continue
        for obj in sorted(cur):
            size = cur[obj]
            old = prev.get(obj)
            if old is None:
                if size > max_growth:
                    out.append((b, obj, f"objeto novo de {size:,} B "
                                        f"(teto {max_growth} B; grave o ledger)"))
                continue
            d = size - old
            if d > max_growth:
                out.append((b, obj, f"cresceu {d:+,} B "
                                    f"(teto {max_growth} B; atualize o ledger)"))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", choices=[*BOARDS, "all"], default="all")
    ap.add_argument("--top", type=int, default=12, help="bibliotecas listadas por placa")
    ap.add_argument("--min-free-kb", type=int, default=64)
    ap.add_argument("--baseline", help="JSON salvo antes; mostra o delta por biblioteca")
    ap.add_argument("--save-baseline", help="grava as medidas atuais neste JSON")
    ap.add_argument("--check-budget",
                    help="JSON de baseline; falha se a imagem crescer acima do teto")
    ap.add_argument("--max-growth-kb", type=int, default=8,
                    help="teto de crescimento por placa em KB (com --check-budget)")
    ap.add_argument("--per-object", type=int, default=0, metavar="N",
                    help="lista os N maiores objetos de main/libmain.a (flash+RAM)")
    ap.add_argument("--save-ledger", help="grava o orcamento por objeto (main/libmain.a)")
    ap.add_argument("--check-ledger", help="JSON do orcamento por objeto; falha se um objeto crescer acima do teto")
    ap.add_argument("--max-object-growth", type=int, default=512,
                    help="teto de crescimento por objeto em bytes (com --check-ledger)")
    args = ap.parse_args()

    if args.check_budget and args.save_baseline:
        raise SystemExit("--check-budget e --save-baseline sao exclusivos: "
                         "grave o baseline num commit e confira contra ele no CI")

    boards = list(BOARDS) if args.board == "all" else [args.board]
    base = {}
    if args.baseline:
        with open(args.baseline) as f:
            base = json.load(f)
    budget = {}
    if args.check_budget:
        with open(args.check_budget) as f:
            budget = json.load(f)
    ledger = {}
    if args.check_ledger:
        with open(args.check_ledger) as f:
            ledger = json.load(f)
        ledger = {k: v for k, v in ledger.items() if not k.startswith("_")}
    want_files = bool(args.per_object or args.save_ledger or args.check_ledger)

    results, failed = {}, False
    for b in boards:
        m = measure(b, want_files=want_files)
        if m is None:
            print(f"[{b}] sem build ({BOARDS[b]['build']}/CelerOS.bin)")
            if b in budget:
                print(f"  ORCAMENTO SEM MEDIDA: {b} esta no baseline e nao foi medido")
                failed = True
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
        if args.check_budget:
            prev = budget.get(b)
            if prev is not None:
                growth = m["image"] - int(prev["image"])
                if growth > 0:
                    print(f"  crescimento {growth:+,} B (teto {args.max_growth_kb} KB)")
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
        files = m.get("files") or {}
        if args.per_object and files:
            prev_files = ledger.get(b, {})
            print(f"  objetos de main/libmain.a, codigo+RAM ({len(files)}):")
            for obj in sorted(files, key=lambda k: -files[k])[: args.per_object]:
                s = f"    {files[obj]:>9,}  {obj}"
                d = files[obj] - prev_files.get(obj, files[obj])
                if d:
                    s += f"  ({d:+,})"
                print(s)
        if free < args.min_free_kb * 1024:
            print(f"  ORCAMENTO ESTOURADO: menos de {args.min_free_kb} KB livres no slot OTA")
            failed = True

    if args.check_budget:
        problems = budget_problems(results, budget, boards, args.max_growth_kb)
        for b, why in problems:
            print(f"  ORCAMENTO [{b}]: {why}")
            failed = True

    if args.check_ledger:
        cur = {b: m["files"] for b, m in results.items() if "files" in m}
        problems = ledger_problems(cur, ledger, boards, args.max_object_growth)
        for b, obj, why in problems:
            print(f"  OBJETO [{b}] {obj}: {why}")
            failed = True

    if args.save_ledger:
        # Mescla: rodar `--board cyd --save-ledger` num build fresco adota so
        # aquela placa, sem apagar as outras ja medidas.
        out = {}
        if os.path.exists(args.save_ledger):
            with open(args.save_ledger) as f:
                out = json.load(f)
        out["_doc"] = ("Orcamento por objeto de main/libmain.a (flash+RAM). "
                       "Atualize no mesmo commit que mudar o tamanho.")
        for b, m in results.items():
            if "files" in m:
                out[b] = m["files"]
        os.makedirs(os.path.dirname(os.path.abspath(args.save_ledger)), exist_ok=True)
        with open(args.save_ledger, "w") as f:
            json.dump(out, f, indent=1, sort_keys=True)
        print(f"ledger gravado em {args.save_ledger}")

    if args.save_baseline:
        os.makedirs(os.path.dirname(os.path.abspath(args.save_baseline)), exist_ok=True)
        with open(args.save_baseline, "w") as f:
            json.dump(results, f, indent=1)
        print(f"baseline gravada em {args.save_baseline}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
