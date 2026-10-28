#!/usr/bin/env python3
"""Ferramenta de publicacao no CelerOS Hub (os.celer.tec.br).

Subcomandos:
  publish      <pasta> [pasta...]      valida e publica pacotes (app.json+main.js[+icon.png])
  publish-dep  <arquivo.js>            publica dependencia JS no repo do hub
                                       (nome = arquivo; versao lida do modulo)
  list                               lista o catalogo do hub e compara com o repo
  delete       <packageName>           remove um app do hub
  whoami                              confere o token/escopo

Autenticacao: CELER_HUB_TOKEN no ambiente (veja CelerOS-Server/env/env.sh).
Hub: --hub ou CELER_HUB (padrao https://os.celer.tec.br).

Exemplos:
  source ../CelerOS-Server/env/env.sh
  python3 tools/celerhub.py publish data/apps/Terminal hub_apps/2048
  python3 tools/celerhub.py publish-dep tools/sdk/engine/celeros.engine.js --min-api 28
  python3 tools/celerhub.py list
  python3 tools/celerhub.py delete celeros.minhaapp --yes
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from urllib import error, request


def _read_api_level():
    # API level maximo que os devices entendem — fonte unica: main/CMakeLists.txt
    cmake = Path(__file__).resolve().parent.parent / "main" / "CMakeLists.txt"
    m = re.search(r"CELEROS_API_LEVEL=(\d+)", cmake.read_text(encoding="utf-8"))
    if not m:
        die(f"{cmake}: CELEROS_API_LEVEL nao encontrado")
    return int(m.group(1))


MAX_API_LEVEL = _read_api_level()
# Teto do hub (download streaming via Net.download, sem limite de 32KB).
# Acima de STREAM_SAFE o app precisa declarar api >= 6: firmwares antigos
# instalavam via Net.get, que trunca o corpo em 32KB.
# Teto em 2 niveis: sem PSRAM o main.js inteiro (mais o heap Duktape e os
# temporarios do compile) tem que caber na RAM interna — medido na CYD
# (ENGINE_NOTES rodada 4): 61KB cru (52KB enxuto) roda, 82KB cru nao
# compila. A migracao C++->JS da rodada 2 liberou ~20KB na CYD, entao o
# teto passou de 48KB para 64KB (2026-10-28) — apps perto do teto devem
# ser validados no aparelho.
# Declarando
# "psram" em requires o app sobe para MAX_MAIN_JS_PSRAM: as placas S3
# com PSRAM (smartdisplay, dog, watch) compilam sem limite runtime
# (dukHeapBudgetOk passa direto; o fonte cru vai num bloco so de PSRAM
# no launch, ~6-7MB contiguos livres). 1MB = 1/8 da PSRAM: cabe com
# folga — o preco de um app que use isso e a abertura (compile linear,
# ~12x o maior app de 2026-10) e ~30% da littlefs de 3,5MB do
# SmartDisplay. O teto e permissivo, nao um alvo.
MAX_MAIN_JS = 64 * 1024
# Espelha o SERVIDOR (CelerOS-Server stacks/.celeros-hub/api/app.py, hub
# 0.9.0+): 1MB com requires psram. Os dois sobem juntos — com o cliente em
# 1MB e o hub em 128KB o --dry passava e o upload voltava 413 (Detona 0.6.0,
# 2026-10-09). O publish manda os .js enxutos (jsstrip): a soma conta o que
# o aparelho compila de fato.
MAX_MAIN_JS_PSRAM = 1024 * 1024
STREAM_SAFE_MAIN_JS = 30 * 1024
VALID_REQUIRES = ("psram",)
# Pacote multi-arquivo (modulos .js + assets): flat, sem subpastas; mesmas
# regras do servidor (CelerOS-Server app.py). O hub computa o campo gerenciado
# "files" {nome: {size, md5}} no publish — nunca setar a mao. Modulos contam
# na SOMA do teto de compile; assets (nao-.js) tem tetos proprios.
# .sh = install.sh do Installer (API 42): roda 1x por versao no sh restrito.
ASSET_EXTS = (".js", ".png", ".wav", ".qoa", ".json", ".bin", ".sh")
# \Z e nao $: "$" casa antes de um \n final — "1.0.0\n" passaria como
# versao valida e "x\n.png" como nome de asset (app.json/hostil com
# nome armado no meio do publish)
FILE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}\Z")
MAX_ASSET_FILE = 128 * 1024
MAX_ASSETS_TOTAL = 256 * 1024
MAX_EXTRA_FILES = 16
REQUIRED = ("name", "packageName", "version", "author", "description")
PKG_RE = re.compile(r"^[a-z0-9]+(\.[a-z0-9]+)+\Z")
VER_RE = re.compile(r"^\d+\.\d+\.\d+\Z")
# Dependencias compartilhadas (mesmas regras do servidor): nome com ponto
# tipo celeros.engine, range "^x.y.z" (major) ou versao exata.
DEP_NAME_RE = re.compile(r"^[a-z0-9]+(\.[a-z0-9-]+)+\Z")
DEP_RANGE_RE = re.compile(r"^\^?\d+\.\d+\.\d+\Z")
MAX_APP_DEPS = 8


def vtuple(v):
    return tuple(int(p) for p in v.split("."))


def read_dep_version(text, origin="modulo"):
    """Versao semver declarada no modulo (`var X = { version: 'x.y.z' }` ou
    atribuicao `E.version = 'x.y.z'` no shim de compatibilidade). Aceita
    aspas simples OU dupla; versoes DISTINTAS no mesmo arquivo sao
    ambiguidade — antes a primeira `version: '...'` vencia calada e o
    publish subia a versao errada."""
    found = re.findall(r"version\s*[:=]\s*(['\"])(\d+\.\d+\.\d+)\1", text)
    if not found:
        die(f"{origin}: sem `version: 'x.y.z'` declarado (ou use --version)")
    vers = sorted({v for _, v in found}, key=vtuple)
    if len(vers) > 1:
        die(f"{origin}: versoes distintas no arquivo ({', '.join(vers)}) — "
            f"deixe so a do objeto exportado")
    return vers[0]


def local_engine_deps(engine_dir=None):
    """({nome: (versao, Path)}, [Path sem versao]) de cada tools/sdk/engine/
    *.js — a arvore local canonica das deps compartilhadas. Modulo sem
    `version:` (WIP em construcao) NAO mata o deps-status: entra na segunda
    lista e o chamador mostra como nota — morrer aqui escondia o drift das
    outras deps atras de um arquivo pela metade."""
    d = Path(engine_dir) if engine_dir else \
        Path(__file__).resolve().parent / "sdk" / "engine"
    out, sem_versao = {}, []
    for f in sorted(d.glob("*.js")):
        try:
            ver = read_dep_version(f.read_text(encoding="utf-8"), f.name)
        except SystemExit:
            sem_versao.append(f)
            continue
        out[f.stem] = (ver, f)
    return out, sem_versao


def deps_status_report(local, hub, divergent=None):
    """Drift repo x hub, logica pura (testavel): devolve (linhas, drift).
    `local` = {nome: versao}; `hub` = {nome: {versao: meta}} do indice
    /store/deps.json; `divergent` = nomes com mesma versao no hub mas
    conteudo diferente — set (divergencia REAL: edicao sem bump) ou dict
    {nome: "wip"|"real"} (o cmd_deps_status tria pelo HEAD: quando o HEAD
    bate com o hub, a diferenca e WIP nao commitado na arvore e o remendio
    e COMMITAR — --force substituiria o hub pelo WIP).
    Vereditos: REPO NAO PUBLICADO (a versao do repo nunca foi ao hub — o
    resolve do install segue servindo a antiga), REPO ATRASADO, CONTEUDO
    DIVERGE (edicao sem bump; so --force cobre), WIP NAO COMMITADO, ok."""
    div = dict(divergent) if isinstance(divergent, dict) \
        else {n: "real" for n in (divergent or set())}
    linhas, drift = [], 0
    for name in sorted(local):
        lv = local[name]
        versions = hub.get(name) or {}
        if not versions:
            linhas.append(f"{name:22} {lv:8} {'-':8} NAO PUBLICADA no hub")
            drift += 1
            continue
        hv = max(versions, key=vtuple)
        if vtuple(lv) > vtuple(hv):
            linhas.append(f"{name:22} {lv:8} {hv:8} REPO NAO PUBLICADO "
                          f"(hub serve a {hv}): publish-dep {name}.js")
            drift += 1
        elif vtuple(lv) < vtuple(hv):
            linhas.append(f"{name:22} {lv:8} {hv:8} REPO ATRASADO (hub na frente)")
            drift += 1
        elif name in div:
            if div[name] == "wip":
                linhas.append(f"{name:22} {lv:8} {hv:8} WIP NAO COMMITADO em "
                              f"arvore (o HEAD bate com o hub {hv}): commite — "
                              "NAO use --force (substituiria o hub pelo WIP)")
            else:
                linhas.append(f"{name:22} {lv:8} {hv:8} CONTEUDO DIVERGE na mesma "
                              f"versao (edicao sem bump): publish-dep --force")
            drift += 1
        else:
            linhas.append(f"{name:22} {lv:8} {hv:8} ok")
    for name in sorted(set(hub) - set(local)):
        linhas.append(f"{name:22} {'-':8} {max(hub[name], key=vtuple):8} "
                      f"sem fonte local em tools/sdk/engine")
    return linhas, drift


def range_satisfies(rng, version):
    """'^x.y.z' = mesma major, >= base; sem '^' = exata."""
    if not DEP_RANGE_RE.match(rng) or not VER_RE.match(version):
        return False
    if not rng.startswith("^"):
        return rng == version
    b, v = vtuple(rng[1:]), vtuple(version)
    return v[0] == b[0] and v >= b


def _passada_fecho(sementes, hub_deps):
    """Uma passada do fecho: BFS semeando {nome: [ranges]}, re-escolhendo o
    pick a cada visita e enfileirando as arestas do pick corrente. Devolve
    (wanted, picks); die() se algo nao satisfaz. O re-pick por visita e o
    que garante "maior satisfazendo todos os caminhos" dentro da passada."""
    wanted, seen, queue = {}, set(), list(sementes.items())
    while queue:
        n, rs = queue.pop(0)
        novo = [r for r in rs if (n, r) not in seen]
        if not novo:
            continue
        for r in novo:
            seen.add((n, r))
        wanted.setdefault(n, []).extend(novo)
        versions = hub_deps.get(n) or {}
        ok = [v for v in versions
              if all(range_satisfies(r, v) for r in wanted[n])]
        if not ok:
            die(f"dep '{n}' sem versao que satisfaca {' / '.join(wanted[n])} no hub")
        for d, rr in (versions[max(ok, key=vtuple)].get("deps") or {}).items():
            queue.append((str(d), [str(rr)]))
    picks = {}
    for n, rs in wanted.items():
        versions = hub_deps.get(n) or {}
        ok = [v for v in versions if all(range_satisfies(r, v) for r in rs)]
        if not ok:
            die(f"dep '{n}' sem versao que satisfaca {' / '.join(rs)} no hub")
        picks[n] = max(ok, key=vtuple)
    return wanted, picks


def resolve_dep_ranges(app_deps, hub_deps):
    """nome -> versao resolvida (maior satisfazendo TODOS os ranges que
    chegam ao nome, diretos ou transitivos). die() se algo nao resolve ou
    o fecho nao converge.

    E um ponto fixo, nao um BFS unico: no meio do caminho um range que
    chega depois pode SUBIR o pick de um nome, e as arestas coletadas do
    pick velho vazavam no grafo — sobrava pino de versao que o pick final
    nem usa e FALTAVA aresta que so o pick novo traz (modulo nunca baixado,
    require quebra em runtime). Converge repetindo a passada com diretas +
    arestas dos picks finais, ate os ranges que cada pick exige serem
    EXATAMENTE os que o limitaram (pino de pick vencido nao fica para
    tras). 32 passadas e teto de seguranca; grafos reais convergem em 2."""
    direct = {str(n): str(r) for n, r in app_deps.items()}
    sementes = {n: [r] for n, r in direct.items()}
    for _ in range(32):
        wanted, picks = _passada_fecho(sementes, hub_deps)
        exigidas, prox = {}, {}
        for n, v in picks.items():
            for d, rr in (hub_deps.get(n, {}).get(v, {}).get("deps") or {}).items():
                exigidas.setdefault(str(d), set()).add(str(rr))
                prox.setdefault(str(d), []).append(str(rr))
        exato = True
        for n in set(wanted) | set(exigidas):
            base = set(exigidas.get(n, set()))
            if n in direct:
                base.add(direct[n])
            if sorted(wanted.get(n, [])) != sorted(base):
                exato = False
                break
        if exato:
            return picks
        sementes = {n: list(rs) for n, rs in prox.items()}
        for n, r in direct.items():
            sementes.setdefault(n, [])
            if r not in sementes[n]:
                sementes[n].append(r)
    die("fecho de deps nao convergiu (ranges em briga entre versoes do grafo)")


def die(msg, code=1):
    print(f"erro: {msg}", file=sys.stderr)
    sys.exit(code)


def hub_url(args):
    return (args.hub or os.environ.get("CELER_HUB") or "https://os.celer.tec.br").rstrip("/")


def token_or_die(args):
    tok = args.token or os.environ.get("CELER_HUB_TOKEN") or ""
    if not tok:
        die("sem token: export CELER_HUB_TOKEN=... (CelerOS-Server/env/env.sh)")
    return tok


def http(method, url, token=None, data=None, headers=None, timeout=30):
    req = request.Request(url, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    # Cloudflare na frente do hub bloqueia o UA default do urllib (erro 1010)
    req.add_header("User-Agent", "celeroshub-cli/1.0 (celeros tools)")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode()
            try:
                return resp.status, json.loads(body)
            except ValueError:
                return resp.status, body
    except error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail)
        except ValueError:
            pass
        die(f"servidor recusou ({e.code}): {detail}")
    except error.URLError as e:
        die(f"falha de rede: {e.reason}")


# --------------------------------------------------------------- validacao -
def strip_js(path: Path, code: bytes | None = None, reserved=None, legacy=False) -> bytes:
    """Fonte enxuto do jeito que o aparelho compila (tools/sdk/lib/jsstrip.js).
    Sem comentarios/indentacao e, agora, MINIFICADO (jsmin: mangle de locais +
    espacamento minimo, quebras de linha preservadas — a linha do erro no
    device continua batendo com o repo). O strip do firmware e idempotente
    nessa saida, entao o custo que o hub mede e o custo real de compile.
    `code`: enxuta ESSES bytes (arquivo temporario) em vez de reler `path`.
    `reserved`: nomes globais que OUTROS .js do pacote leem — o main.js nao
    pode renomear esses (o topo de um main.js e o escopo global do app).
    Modulos (qualquer arquivo != main.js) sao embrulhados pelo loader em
    function(module,exports,require): o topo deles e local e pode manglar."""
    tool = Path(__file__).resolve().parent / "sdk" / "lib" / "jsstrip.js"
    alvo = path
    td = None
    if code is not None:
        td = tempfile.TemporaryDirectory()
        alvo = Path(td.name) / path.name
        alvo.write_bytes(code)
    cmd = ["node", str(tool), str(alvo)]
    if not legacy:
        cmd.append("--min")
        if path.name != "main.js":
            cmd.append("--top")
        if reserved:
            cmd.extend(["--reserved", ",".join(sorted(reserved))])
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=60)
    except FileNotFoundError:
        die("node nao encontrado no PATH: necessario para enxugar o .js (ou --sem-strip)")
    finally:
        if td is not None:
            td.cleanup()
    if out.returncode != 0 or (not out.stdout and (code if code is not None else path.stat().st_size) > 0):
        die(f"jsstrip falhou em {path.name}: {out.stderr.decode('utf-8', 'replace').strip()}")
    if out.stderr:
        # aviso de fallback (jsmin recusou) nao pode virar silencio
        print(out.stderr.decode("utf-8", "replace").strip())
    return out.stdout


def free_names(paths) -> set:
    """Nomes que os .js dados LEEM sem declarar (resolvem no escopo global).
    Um main.js nao pode renomear um top-level que um irmao le por esse nome."""
    files = [str(p) for p in paths if p and Path(p).is_file()]
    if not files:
        return set()
    tool = Path(__file__).resolve().parent / "sdk" / "lib" / "jsstrip.js"
    try:
        out = subprocess.run(["node", str(tool), "--free-names"] + files,
                             capture_output=True, timeout=60)
    except FileNotFoundError:
        return set()
    if out.returncode != 0:
        return set()
    try:
        return set(json.loads(out.stdout.decode("utf-8") or "[]"))
    except ValueError:
        return set()


def git_dirty_files(paths) -> list:
    """Paths com conteudo NAO commitado no repo (WIP em arvore) — exatamente
    o que um publish subiria sem nunca ter passado por commit/CI. Nasceu do
    incidente real: a engine 1.2.3 foi ao hub com 2 linhas do WIP do autor
    (salvas na arvore entre o `git status` do operador e o upload).
    IGNORADOS contam junto (--ignored=matching): arquivo do pacote que o
    .gitignore esconde nunca sera commitado — publica-lo e subir WIP
    disfarcado (o filtro de extensoes do publish nao salva ninguem sozinho).
    Fora de um repo git (ou sem git no PATH) devolve [] — o fluxo nao
    trava."""
    alvos = [Path(p).expanduser().resolve() for p in paths if p]
    if not alvos:
        return []
    try:
        probe = subprocess.run(
            ["git", "-C", str(alvos[0].parent), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    if probe.returncode != 0:
        return []
    try:
        st = subprocess.run(
            ["git", "-C", probe.stdout.strip(), "status", "--porcelain",
             "--ignored=matching", "--"] + [str(p) for p in alvos],
            capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    if st.returncode != 0:
        return []
    sujas = []
    for linha in st.stdout.splitlines():
        parte = linha[3:].strip() if len(linha) > 3 else ""
        if " -> " in parte:               # renomeado: o destino e o que sobe
            parte = parte.split(" -> ", 1)[1]
        parte = parte.strip('"').strip()
        if parte:
            sujas.append(parte)
    return sujas


def strip_md5s(path: Path, code: bytes | None = None) -> set:
    """md5 do .js nos dois modos (strip legado e minificado). O hub guarda o
    md5 do que subiu; deps publicadas antes do jsmin tem o md5 do strip
    antigo, entao a comparacao aceita os dois."""
    out = set()
    for legacy in (False, True):
        try:
            out.add(hashlib.md5(strip_js(path, code, legacy=legacy)).hexdigest())
        except SystemExit:
            raise
        except Exception:
            pass
    return out


def head_strip_md5(path: Path):
    """md5 do ENXUTO do arquivo como esta no HEAD (None se o repo/git nao
    tiver o arquivo — novo, ainda sem commit). O deps-status usa para
    distinguir divergencia REAL (HEAD != hub) de WIP nao commitado na
    arvore (HEAD == hub: o remendio certo e commitar, NAO --force)."""
    try:
        rel = subprocess.run(
            ["git", "-C", str(path.parent), "rev-parse", "--show-prefix"],
            capture_output=True, text=True, timeout=10)
        if rel.returncode != 0:
            return None
        blob = subprocess.run(
            ["git", "-C", str(path.parent), "show", f"HEAD:{rel.stdout.strip()}{path.name}"],
            capture_output=True, timeout=10)
        if blob.returncode != 0:
            return None
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / path.name
            tmp.write_bytes(blob.stdout)
            return strip_md5s(tmp)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


def run_app_lint(folder: Path):
    """Lint estatico do app (tools/app_lint): parser ES5 de verdade + checagem
    da API do firmware (funcoes, aridades, permissoes, niveis). Erros bloqueiam.
    Requer Node no PATH (mesmo do harness). Devolve avisos como strings."""
    lint = Path(__file__).resolve().parent / "app_lint" / "lint.js"
    if not lint.is_file():
        die("tools/app_lint/lint.js ausente")
    try:
        out = subprocess.run(
            ["node", str(lint), "--json", str(folder)],
            capture_output=True, text=True, timeout=120,
        )
    except FileNotFoundError:
        die("node nao encontrado no PATH: necessario para o lint do app")
    except subprocess.TimeoutExpired:
        die("lint do app demorou demais (120s)")
    if out.returncode == 2:
        die(f"lint falhou: {(out.stderr or out.stdout).strip()}")
    try:
        r = json.loads(out.stdout)
    except ValueError:
        die(f"saida inesperada do lint: {out.stdout[:200]!r}")
    diags = [d for a in r.get("apps", []) for d in a.get("diagnostics", [])]
    erros = [d for d in diags if d.get("severity") == "erro"]
    if erros:
        for d in erros:
            print(f"erro: {d['file']}:{d['line']}:{d['col']} {d['message']}", file=sys.stderr)
        die(f"{folder}: {len(erros)} erro(s) no lint — node tools/app_lint/lint.js {folder}")
    return [f"lint: {d['file']}:{d['line']} {d['message']}" for d in diags]


def package_files(folder: Path):
    """Extras do pacote (modulos .js + assets), FLAT: tudo na raiz da pasta
    que passa nome/extensao e nao e dev-only ou lixo de editor. Devolve
    {nome: Path}. app.json/main.js/icon.png ficam de fora (tem tratamento
    proprio); o celerctl apps install e o app_lint excluem os mesmos nomes."""
    out = {}
    for p in sorted(folder.iterdir()):
        n = p.name
        if not p.is_file() or n in ("app.json", "main.js", "icon.png", "test.js"):
            continue
        # artefatos do scaffold do SDK (celer.js new): dev-only
        if n in ("README.md", "jsconfig.json") or n.endswith(".d.ts"):
            continue
        if n.startswith(".") or n.endswith((".dev", ".part", ".new", "~", ".swp")):
            continue
        out[n] = p
    return out


def validate(folder: Path, strip=True, snapshot=None):
    """Confere o pacote localmente; devolve (meta, avisos, size, extras).
    Devolve erros via die. `strip`: a soma dos .js (e os tetos de
    stream-safe) contam o tamanho ENXUTO, como o publish sobe e o aparelho
    compila — o cru tem comentario/indentacao e bloqueava com mensagem
    errada ANTES do strip provar o contrario (main.js de 60KB cru que vira
    40KB enxuto morria com "acima de 64KB").
    `snapshot`: {"app.json": bytes, "main.js": bytes} — quando dado, meta e
    teto saem DESSES bytes e nao de uma segunda leitura do disco: o publish
    valida exatamente o conteudo que vai no zip (app.json trocado no meio
    do publish nao valida uma versao e sobe outra)."""
    snap = snapshot or {}
    avisos = []
    meta_path, code_path, icon_path = (folder / "app.json", folder / "main.js", folder / "icon.png")
    if not meta_path.is_file() or not code_path.is_file():
        die(f"{folder}: precisa conter app.json e main.js")
    meta_text = snap["app.json"].decode("utf-8") if "app.json" in snap \
        else meta_path.read_text(encoding="utf-8")
    try:
        meta = json.loads(meta_text)
    except ValueError as e:
        die(f"{folder}: app.json invalido: {e}")
    for f in REQUIRED:
        if not str(meta.get(f) or "").strip():
            die(f"{folder}: app.json sem campo obrigatorio: {f}")
    if not PKG_RE.match(meta["packageName"]):
        die(f"{folder}: packageName invalido (ex.: celeros.meuapp)")
    if not VER_RE.match(meta["version"]):
        die(f"{folder}: version deve ser semver x.y.z")
    if "files" in meta:
        die(f"{folder}: campo \"files\" e computado pelo hub: nunca setar a mao")
    try:
        api = int(meta.get("api") or 1)
    except (TypeError, ValueError):
        die(f"{folder}: api deve ser um numero inteiro no app.json "
            f"(veio {meta.get('api')!r})")
    if api > MAX_API_LEVEL:
        die(f"{folder}: api {api} > {MAX_API_LEVEL} (device nao instala)")
    main_src = snap["main.js"].decode("utf-8", "replace") if "main.js" in snap \
        else code_path.read_text(encoding="utf-8", errors="replace")
    if api == 5 and "keypad" not in main_src:
        avisos.append("declara api 5 mas nao usa keypad*")

    # Lint estatico (ES5 real + API do firmware): erros bloqueiam o publish
    avisos.extend(run_app_lint(folder))

    # Requisitos de hardware declarados (o app_lint e o servidor validam os
    # mesmos valores; a loja usa o campo p/ badge "Requer PSRAM" + bloqueio).
    requires = meta.get("requires") or []
    if not isinstance(requires, list) or any(r not in VALID_REQUIRES for r in requires):
        die(f"{folder}: requires invalido (valores: {', '.join(VALID_REQUIRES)})")

    # Teto em 2 niveis pela SOMA dos .js (main.js + modulos): e a soma que
    # ocupa a RAM de compile no device. Contada pelo tamanho ENXUTO (como o
    # publish sobe e o aparelho compila) — ver docstring. Assets (nao-.js)
    # tem tetos proprios.
    extras = package_files(folder)
    if len(extras) > MAX_EXTRA_FILES:
        die(f"{folder}: {len(extras)} arquivos extras (max {MAX_EXTRA_FILES})")
    js_sizes = {}
    main_fonte = snap["main.js"] if "main.js" in snap else code_path
    # globais que os modulos do pacote leem: o main.js nao pode renomea-los
    reserved = free_names([p for n, p in extras.items() if n.endswith(".js")]) if strip else set()
    for f in [main_fonte] + [p for n, p in extras.items() if n.endswith(".js")]:
        if isinstance(f, bytes):  # snapshot do publish: enxuta esses bytes
            js_sizes[f] = len(strip_js(code_path, f, reserved=reserved)) if strip else len(f)
        else:
            js_sizes[f] = len(strip_js(f, reserved=reserved)) if strip else f.stat().st_size
    main_enxuto = js_sizes[main_fonte]
    js_sum = sum(js_sizes.values())
    assets_total = 0
    for n, p in extras.items():
        if not FILE_NAME_RE.match(n) or p.suffix.lower() not in ASSET_EXTS:
            die(f"{folder}: arquivo extra invalido: {n} "
                f"(nome [A-Za-z0-9._-], extensoes: {', '.join(ASSET_EXTS)})")
        size_n = p.stat().st_size
        if size_n > MAX_ASSET_FILE:
            die(f"{folder}: {n} tem {size_n}B (max {MAX_ASSET_FILE}B)")
        if n.endswith(".js"):
            if js_sizes[p] > STREAM_SAFE_MAIN_JS and api < 6:
                die(f"{folder}: {n} enxuto > {STREAM_SAFE_MAIN_JS}B exige api >= 6 "
                    f"(firmware antigo trunca o download em 32KB)")
        else:
            assets_total += size_n
    if assets_total > MAX_ASSETS_TOTAL:
        die(f"{folder}: assets somam {assets_total}B (max {MAX_ASSETS_TOTAL}B)")

    # Dependencias compartilhadas (API 30): formato local; existencia no hub
    # e a soma das deps no teto sao checadas no cmd_publish com o indice
    # real (o servidor refaz a validacao no upload).
    deps = meta.get("deps")
    if deps is not None:
        if not isinstance(deps, dict) or not deps:
            die(f"{folder}: deps deve ser objeto {{nome: \"^x.y.z\"}} nao-vazio")
        if api < 30:
            die(f"{folder}: deps exige api >= 30 no app.json (o require so "
                f"resolve dependencia na API 30)")
        if len(deps) > MAX_APP_DEPS:
            die(f"{folder}: deps com {len(deps)} entradas (max {MAX_APP_DEPS})")
        for d, r in deps.items():
            if not DEP_NAME_RE.match(str(d)):
                die(f"{folder}: dep com nome invalido: {d} (use prefixo.nome)")
            if not DEP_RANGE_RE.match(str(r)):
                die(f"{folder}: dep {d}: versao deve ser \"^1.0.0\" ou \"1.0.0\"")
            if f"{d}.js" in extras:
                avisos.append(f"deps declara {d} mas {d}.js esta na pasta: "
                              f"a copia local vence no require (vendoring desnecessario)")

    if js_sum > MAX_MAIN_JS_PSRAM:
        die(f"{folder}: soma dos .js enxutos ({js_sum}B) acima do teto absoluto "
            f"({MAX_MAIN_JS_PSRAM}B)")
    if js_sum > MAX_MAIN_JS and "psram" not in requires:
        die(f"{folder}: soma dos .js enxutos ({js_sum}B): acima de {MAX_MAIN_JS}B exige "
            f"\"psram\" em requires no app.json (sem PSRAM a RAM interna "
            f"nao fecha o compile)")
    if main_enxuto > STREAM_SAFE_MAIN_JS and api < 6:
        die(f"{folder}: main.js enxuto > {STREAM_SAFE_MAIN_JS}B exige api >= 6 no "
            f"app.json (firmware antigo trunca o download em 32KB)")
    if icon_path.is_file():
        isz = icon_path.stat().st_size
        if isz > 10 * 1024:
            avisos.append(f"icon.png grande ({isz}B); o pipeline gera ~2-5KB")
    else:
        avisos.append("sem icon.png (o launcher usa gradiente+inicial)")
    return meta, avisos, js_sum, extras


# ------------------------------------------------------------- deps-status -
def cmd_deps_status(args):
    """Drift das deps compartilhadas: tools/sdk/engine/*.js (canonica do
    repo) x o indice do hub. Nasceu do buraco real: engine 1.2.2 commitada
    no repo (d4e4d53) enquanto o hub resolve ^1.2.0 para a 1.2.1 — nenhum
    comando apontava, e a bancada testava uma engine que os devices nunca
    recebiam. Exit 1 quando ha drift (servivel de CI/gate)."""
    local, sem_versao = local_engine_deps(args.engine_dir)
    if not local:
        die("tools/sdk/engine sem *.js versionado — nada a comparar")
    if sem_versao:
        nomes = ", ".join(f.name for f in sem_versao)
        print(f"nota: sem version: (WIP?): {nomes} — fora do drift ate "
              "declararem versao")
    if args.index:
        idx = json.loads(Path(args.index).read_text(encoding="utf-8"))
    else:
        _, idx = http("GET", f"{hub_url(args)}/store/deps.json")
    hub = idx.get("deps", {})
    # mesma versao no hub mas bytes diferentes: o md5 do hub e do .js
    # ENXUTO (e assim que o publish-dep sobe). Triagem pelo HEAD: HEAD
    # bate com o hub -> a diferenca e WIP nao commitado na arvore (commite
    # em vez de --force); HEAD diverge -> edicao sem bump de verdade
    divergent = {}
    for name, (lv, f) in local.items():
        dmeta = (hub.get(name) or {}).get(lv)
        if not dmeta or not dmeta.get("md5"):
            continue
        if dmeta["md5"] in strip_md5s(f):
            continue
        head = head_strip_md5(f)
        # HEAD igual ao hub -> WIP nao commitado (commite). HEAD SEM o
        # arquivo (novo, nunca commitado; git ausente da None igual) tambem
        # pede COMMIT — sugerir --force aqui subiria o nao-commitado
        head_ok = head is None or dmeta["md5"] in head
        divergent[name] = "wip" if head_ok else "real"
    linhas, drift = deps_status_report({n: v for n, (v, _) in local.items()},
                                       hub, divergent)
    print(f"{'dep':22} {'local':8} {'hub':8} veredito")
    for l in linhas:
        print(l)
    total = len(local)
    if drift:
        print(f"drift: {drift} de {total} dep(s) — publish-dep resolve")
        sys.exit(1)
    print(f"ok: {total} dep(s) em paridade com o hub")


# ----------------------------------------------------------------- publish -
def cmd_publish(args):
    tok = "" if args.dry else token_or_die(args)  # dry roda offline
    # versao publicada no hub: base do anti-downgrade local (o hub reforca)
    hub_ver = {}
    hub_deps = None
    if not args.dry:
        _, data = http("GET", f"{hub_url(args)}/store/all.json")
        hub_ver = {pkg: a.get("version", "0.0.0")
                   for pkg, a in data.get("apps", {}).items()}
    rc = 0
    for folder in args.folders:
        folder = Path(folder).expanduser().resolve()
        # SNAPSHOT de app.json/main.js: UMA leitura cada, ANTES de tudo —
        # validate, guarda de arvore suja, tetos e zip trabalham sobre os
        # MESMOS bytes (a bancada anda em voo: app.json trocado no meio do
        # publish nao pode validar uma versao e subir outra)
        raw_meta = (folder / "app.json").read_bytes()
        raw_main = (folder / "main.js").read_bytes()
        meta, avisos, js_sum, extras = validate(folder, strip=not args.no_strip,
                                                snapshot={"app.json": raw_meta,
                                                          "main.js": raw_main})
        # fecha o TOCTOU: qualquer mutacao entre a leitura e aqui (bancada
        # paralela, editor salvando) aborta — o que sobe e o que foi checado
        raw_extras = {n: p.read_bytes() for n, p in extras.items()}
        if (folder / "app.json").read_bytes() != raw_meta or \
                (folder / "main.js").read_bytes() != raw_main or \
                any(p.read_bytes() != raw_extras[n] for n, p in extras.items()):
            die(f"{folder.name}: app.json/main.js/extras mudaram durante o publish — rode de novo")
        # enxuto sai do SNAPSHOT, nao de nova leitura do arquivo
        enxutos = {}
        if not args.no_strip:
            enxutos["main.js"] = strip_js(
                folder / "main.js", code=raw_main,
                reserved=free_names([p for n, p in extras.items() if n.endswith(".js")]))
            for n, p in extras.items():
                if n.endswith(".js"):
                    enxutos[n] = strip_js(p, code=raw_extras[n])
            js_sum = sum(len(b) for b in enxutos.values())
        blobs = {"app.json": raw_meta,
                 "main.js": raw_main}
        # --private/--tenant: o app.json versionado continua publico (o repo
        # publico nao carrega visibilidade de vertical); a CLI injeta na
        # COPIA que sobe — o hub grava em content/private e exige token.
        private = bool(getattr(args, "private", False))
        tenant = getattr(args, "tenant", "") or ""
        if tenant and not private:
            die(f"{folder.name}: --tenant exige --private")
        if private:
            # Hub antigo ignora "visibility" e publicaria o pacote como
            # publico — confere a versao minima antes de subir.
            if not args.dry:
                _, info = http("GET", f"{hub_url(args)}/api/info")
                hv = str(info.get("version") or "0.0.0")
                if vtuple(hv) < (0, 14, 0):
                    die(f"{folder.name}: hub {hv} nao suporta app privado "
                        f"(minimo 0.14.0) — atualize o hub")
            try:
                doc = json.loads(blobs["app.json"])
            except ValueError:
                die(f"{folder.name}: app.json invalido")
            doc["visibility"] = "private"
            if tenant:
                doc["tenant"] = tenant
            blobs["app.json"] = (
                json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode()
        if (folder / "icon.png").is_file():
            blobs["icon.png"] = (folder / "icon.png").read_bytes()
        for n, p in extras.items():
            if n not in enxutos:
                blobs[n] = raw_extras[n]
        # guarda de arvore suja (mesma do publish-dep): so sobe conteudo
        # COMMITADO — publish de app com WIP no main.js embarcaria trabalho
        # que o autor nem terminou (quase aconteceu com o Arrasa 1.0.0)
        sobem = [folder / "app.json", folder / "main.js"] + \
                [folder / n for n in extras] + \
                ([folder / "icon.png"] if (folder / "icon.png").is_file() else [])
        suja = git_dirty_files(sobem)
        if suja:
            if args.dry:
                print(f"aviso: {folder.name}: edicao NAO commitada em "
                      f"{', '.join(suja[:3])} — o upload seria do WIP")
            elif not args.force:
                die(f"{folder.name}: edicao NAO commitada ({', '.join(suja[:3])}"
                    f"{' e mais' if len(suja) > 3 else ''}) — commite antes, ou "
                    "use --force consciente (a loja receberia o WIP)")
        deps = meta.get("deps") or {}
        # deps: resolve contra o indice do hub (existencia + teto com a soma
        # das deps — o mesmo calculo que o servidor faz no upload)
        if deps:
            if args.dry:
                for a in [f"deps {d} {r}: existencia no hub nao checada (dry)"
                          for d, r in deps.items()]:
                    avisos.append(a)
            else:
                if hub_deps is None:
                    _, idx = http("GET", f"{hub_url(args)}/store/deps.json")
                    hub_deps = idx.get("deps", {})
                resolved = resolve_dep_ranges(deps, hub_deps)
                for dname, dver in resolved.items():
                    dmeta = hub_deps[dname][dver]
                    js_sum += int(dmeta.get("size") or 0)
                    dmin = int(dmeta.get("minApi") or 1)
                    if int(meta.get("api") or 1) < dmin:
                        die(f"{folder}: dep {dname}@{dver} exige api >= {dmin} "
                            f"(app declara {meta.get('api')})")
        requires = meta.get("requires") or []
        if js_sum > MAX_MAIN_JS_PSRAM:
            die(f"{folder}: soma dos .js + deps ({js_sum}B) acima do teto "
                f"absoluto ({MAX_MAIN_JS_PSRAM}B)")
        if js_sum > MAX_MAIN_JS and "psram" not in requires:
            die(f"{folder}: soma dos .js + deps ({js_sum}B): acima de "
                f"{MAX_MAIN_JS}B exige \"psram\" em requires no app.json")
        for a in avisos:
            print(f"aviso: {folder.name}: {a}")
        hv = hub_ver.get(meta["packageName"])
        if hv and vtuple(meta["version"]) <= vtuple(hv) and not args.force:
            die(f"{folder}: v{meta['version']} <= publicada no hub (v{hv}); "
                f"suba a version ou use --force")
        if args.dry:
            nextra = f" + {len(extras)} extra(s)" if extras else ""
            ndeps = f" + {len(deps)} dep(s)" if deps else ""
            print(f"[dry] {meta['packageName']} v{meta['version']} "
                  f"({js_sum}B de .js{ndeps}{nextra}) ok")
            continue

        with tempfile.TemporaryDirectory() as td:
            zpath = Path(td) / "app.zip"
            with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
                # tudo do SNAPSHOT (blobs/enxutos): nada relido da arvore
                zf.writestr("app.json", blobs["app.json"])
                if "main.js" in enxutos:
                    zf.writestr("main.js", enxutos["main.js"])
                else:
                    zf.writestr("main.js", blobs["main.js"])
                if "icon.png" in blobs:
                    zf.writestr("icon.png", blobs["icon.png"])
                for n in extras:
                    if n in enxutos:
                        zf.writestr(n, enxutos[n])
                    else:
                        zf.writestr(n, blobs[n])
            blob = zpath.read_bytes()

        boundary = "----celeroshub7d1f2c"
        part = (
            f"--{boundary}\r\n"
            "Content-Disposition: form-data; name=\"file\"; filename=\"app.zip\"\r\n"
            "Content-Type: application/zip\r\n\r\n"
        ).encode()
        force_part = (
            f"--{boundary}\r\n"
            "Content-Disposition: form-data; name=\"force\"\r\n\r\n"
            f"{'1' if args.force else '0'}\r\n"
        ).encode()
        _, out = http("POST", f"{hub_url(args)}/admin/apps", token=tok,
                      data=part + blob + b"\r\n" + force_part +
                      f"--{boundary}--\r\n".encode(),
                      headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        print(f"ok: {out.get('package')} v{out.get('version')} publicado "
              f"({out.get('size', '?')}B, md5 {str(out.get('md5', '?'))[:8]}..., "
              f"{out.get('store', {}).get('apps')} apps no catalogo)")
    sys.exit(rc)


# ------------------------------------------------------------- publish-dep -
def cmd_publish_dep(args):
    """Publica um modulo JS como dependencia compartilhada do hub.

    Nome = nome do arquivo sem .js (tools/sdk/engine/celeros.engine.js ->
    dep "celeros.engine"); versao lida do `version: 'x.y.z'` do modulo;
    --min-api e o CELEROS_API_LEVEL minimo do device que roda a dep.
    Transitivas: --dep nome=range (repetivel).

    Sobe o modulo ENXUTO (tools/sdk/lib/jsstrip.js, porte 1:1 do JsStripper
    do firmware): sem comentarios/indentacao, com as quebras de linha
    preservadas (o "line N" do erro bate com o fonte do repo). O hub mede o
    .js recebido no teto de compile e o aparelho enxuga do mesmo jeito antes
    de compilar — o tamanho medido vira o custo real em RAM (a engine 1.2
    cai de 54 KB crus para 32 KB). --sem-strip sobe o fonte como esta.
    --dry roda offline (valida sintaxe/versao e mostra o que subiria)."""
    tok = "" if args.dry else token_or_die(args)  # dry roda offline
    private = bool(getattr(args, "private", False))
    tenant = getattr(args, "tenant", "") or ""
    if tenant and not private:
        die("--tenant exige --private")
    if private and not args.dry:
        _, info = http("GET", f"{hub_url(args)}/api/info")
        hv = str(info.get("version") or "0.0.0")
        if vtuple(hv) < (0, 14, 0):
            die(f"hub {hv} nao suporta dep privada (minimo 0.14.0) — atualize o hub")
    src = Path(args.file).expanduser().resolve()
    if not src.is_file():
        die(f"{src}: arquivo nao encontrado")
    name = args.name or src.stem
    if not DEP_NAME_RE.match(name):
        die(f"nome de dep invalido: {name} (use prefixo.nome, ex: celeros.engine)")
    # SNAPSHOT: uma unica leitura do arquivo — versao, lint, enxuto e upload
    # saem todos dos MESMOS bytes (a arvore anda em voo na bancada: reler
    # depois da guarda de git sujo e como o incidente da 1.2.3 renasce)
    code = src.read_bytes()
    text = code.decode("utf-8", "replace")
    version = args.version or read_dep_version(text, src.name)
    if not VER_RE.match(version or ""):
        die(f"versao invalida: {version!r} (declare no modulo "
            f"version: 'x.y.z' ou use --version)")
    sub = {}
    for pair in args.dep or []:
        if "=" not in pair:
            die(f"--dep deve ser nome=range (veio {pair!r})")
        d, r = pair.split("=", 1)
        if not DEP_NAME_RE.match(d) or not DEP_RANGE_RE.match(r):
            die(f"--dep invalida: {pair}")
        sub[d] = r
    # sem --dep, modulo da engine herda as arestas do tools/sdk/engine/
    # index.json (a fonte que o harness e o celerctl --deps-local usam):
    # a world 1.0.1 subiu sem --dep, o hub serviu deps {} e o install da
    # Lenda de Celer perdeu o celeros.game.level do fecho (require quebrado)
    if not args.dep:
        idx_p = Path(__file__).resolve().parent / "sdk" / "engine" / "index.json"
        if src.parent == idx_p.parent and idx_p.is_file():
            try:
                arestas = (json.loads(idx_p.read_text()).get(name) or {}).get("deps") or {}
            except ValueError:
                arestas = {}
            if arestas:
                sub = dict(arestas)
                print(f"{name}: arestas do index.json -> {json.dumps(sub)}")
    # guarda de arvore suja: o upload tem que ser de conteudo COMMITADO —
    # a engine 1.2.3 foi ao hub uma vez com 2 linhas do WIP do autor (o
    # git status do operador era de minutos antes; a arvore andou)
    suja = git_dirty_files([src])
    if suja:
        if args.dry:
            print(f"aviso: {src.name} tem edicao NAO commitada — o upload "
                  "seria do WIP, nao do HEAD")
        elif not args.force:
            die(f"{src.name}: edicao NAO commitada ({', '.join(suja[:3])}"
                f"{' e mais' if len(suja) > 3 else ''}) — commite antes, ou "
                "use --force consciente (o hub receberia o WIP)")
    # sintaxe de verdade antes de subir: dep quebrada quebra TODOS os apps
    # que a require (cache publico compartilhado). O app_lint parseia com
    # acorn ES5 (mesmo perfil do Duktape do device); o node --check aceitava
    # ES6 que o aparelho rejeitaria na hora de compilar a dep. Linta o
    # SNAPSHOT (arquivo temp), nao a arvore viva
    lint_js = Path(__file__).resolve().parent / "app_lint" / "lint.js"
    with tempfile.TemporaryDirectory() as td:
        snap = Path(td) / src.name
        snap.write_bytes(code)
        chk = subprocess.run(["node", str(lint_js), str(snap)], capture_output=True, text=True)
        if chk.returncode != 0:
            erros = [l.strip() for l in (chk.stdout or chk.stderr or "").splitlines()
                     if " erro[" in l]
            die(f"{src.name}: sintaxe invalida no lint ES5 (app_lint): "
                f"{erros[0] if erros else 'sem detalhe'}")
        # pre-flight contra o indice, MESMA regra do servidor (409): versao
        # ja existente so passa com --force; versao <= topo do hub tambem
        # exige --force (anti-rebaixamento) — antes o cliente so via a
        # "ja existente" e um publish mais antigo que o topo passava aqui e
        # morria la com mensagem vazia
        if not args.dry and not args.force:
            _, idx = http("GET", f"{hub_url(args)}/store/deps.json")
            vers = (idx.get("deps", {}).get(name) or {})
            if vers.get(version):
                die(f"dep {name} v{version} ja esta no hub — suba a version no "
                    f"modulo ou use --force para substituir")
            topo = max(vers, key=vtuple) if vers else None
            if topo is not None and vtuple(version) <= vtuple(topo):
                die(f"dep {name} v{version} nao passa do topo do hub (v{topo}) "
                    f"— suba a version ou use --force (rebaixamento)")
        # enxuta o SNAPSHOT: o que sobe e o que foi lintado
        if not args.no_strip:
            enxuto = strip_js(snap)
            print(f"{name}: {len(code)}B -> {len(enxuto)}B minificado (linhas preservadas)")
            code = enxuto
    md5_local = hashlib.md5(code).hexdigest()

    if args.dry:
        sub_s = json.dumps(sub) if sub else "-"
        print(f"[dry] dep {name} v{version}: {len(code)}B, md5 {md5_local[:8]}..., "
              f"minApi {args.min_api}, deps {sub_s}")
        print(f"      iria para {hub_url(args)}/admin/deps (token dispensado no dry)")
        return

    with tempfile.TemporaryDirectory() as td:
        zpath = Path(td) / "dep.zip"
        dmeta = {"name": name, "version": version,
                 "minApi": args.min_api, "deps": sub}
        if private:
            dmeta["visibility"] = "private"
            if tenant:
                dmeta["tenant"] = tenant
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("dep.json", json.dumps(dmeta))
            zf.writestr(f"{name}.js", code)
        blob = zpath.read_bytes()  # depois do with: zip fechado tem o central directory

    boundary = "----celeroshub7d1f2c"
    part = (
        f"--{boundary}\r\n"
        "Content-Disposition: form-data; name=\"file\"; filename=\"dep.zip\"\r\n"
        "Content-Type: application/zip\r\n\r\n"
    ).encode()
    force_part = (
        f"--{boundary}\r\n"
        "Content-Disposition: form-data; name=\"force\"\r\n\r\n"
        f"{'1' if args.force else '0'}\r\n"
    ).encode()
    # CRLF entre o corpo do arquivo e a proxima fronteira (sem ele o campo
    # force chegava fundido ao zip e o --force nunca valia: o 409 da
    # republicacao — mesmo bug do publish de app, corrigido la em 0981e32)
    _, out = http("POST", f"{hub_url(args)}/admin/deps", token=tok,
                  data=part + blob + b"\r\n" + force_part + f"--{boundary}--\r\n".encode(),
                  headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    print(f"ok: dep {out.get('dep')} v{out.get('version')} publicada "
          f"({out.get('size', '?')}B, md5 {str(out.get('md5', '?'))[:8]}...)")
    if str(out.get("md5", "")) != md5_local:
        print(f"aviso: md5 do hub diverge do enviado — republice ou investigue")
    print(f"    {out.get('url')}")


# -------------------------------------------------------------------- list -
def local_packages():
    out = {}
    root = Path(__file__).resolve().parent.parent
    for base in ("data/apps", "hub_apps"):
        d = root / base
        if not d.is_dir():
            continue
        for pkg in sorted(d.iterdir()):
            mp = pkg / "app.json"
            if not mp.is_file():
                continue
            try:
                meta = json.loads(mp.read_text(encoding="utf-8"))
                out[meta["packageName"]] = meta["version"]
            except (ValueError, KeyError):
                continue
    return out


def cmd_list(args):
    _, cats = http("GET", f"{hub_url(args)}/store/index.json")
    _, data = http("GET", f"{hub_url(args)}/store/all.json")
    _, info = http("GET", f"{hub_url(args)}/api/info")
    apps = data.get("apps", {})
    downloads = info.get("downloads", {})
    local = local_packages()
    print(f"CelerOS Hub ({hub_url(args)}) - {len(apps)} apps em "
          f"{len(cats.get('categories', {}))} categorias\n")
    print(f"{'pacote':40} {'v':8} {'api':4} {'tam':7} {'down':5} {'categoria':12} local")
    for pkg in sorted(apps):
        a = apps[pkg]
        lv = local.get(pkg)
        hv = a.get("version", "?")
        if lv is None:
            mark = "-"
        elif lv == hv:
            mark = "igual"
        elif vtuple(lv) > vtuple(hv):
            mark = f"local v{lv} (hub atrasado)"
        else:
            mark = f"hub v{hv} (device tem update)"
        size = a.get("size")
        size_s = f"{size // 1024}KB" if size else "-"
        print(f"{pkg:40} {hv:8} {a.get('api', '?'):4} {size_s:7} "
              f"{downloads.get(pkg, 0):<5} {a.get('category', '?'):12} {mark}")
    # pacotes locais que ainda nao estao no hub
    for pkg, lv in sorted(local.items()):
        if pkg not in apps:
            print(f"{pkg:40} {'-':8} {'-':4} {'-':7} {'-':5} {'-':12} "
                  f"local v{lv} (nao publicado)")


# ------------------------------------------------------------------- delete -
def cmd_delete(args):
    tok = token_or_die(args)
    if not args.yes:
        die(f"delete e destrutivo: confirme com --yes (alvo: {args.package})")
    _, out = http("DELETE", f"{hub_url(args)}/admin/apps/{args.package}", token=tok)
    print(f"ok: {out.get('deleted', args.package)} removido "
          f"({out.get('store', {}).get('apps')} apps no catalogo)")


# ------------------------------------------------------------------ whoami -
def cmd_whoami(args):
    tok = token_or_die(args)
    _, out = http("GET", f"{hub_url(args)}/admin/whoami", token=tok)
    print(f"agente: {out.get('name')}  escopos: {', '.join(out.get('scopes', []))}")


# -------------------------------------------------------------------- main -
def main():
    ap = argparse.ArgumentParser(description="publicacao no CelerOS Hub")
    ap.add_argument("--hub", default=None, help="URL do hub (ou CELER_HUB)")
    ap.add_argument("--token", default=None, help="bearer (ou CELER_HUB_TOKEN)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("publish", help="publica um ou mais pacotes")
    p.add_argument("folders", nargs="+", help="pastas com app.json + main.js")
    p.add_argument("--dry", action="store_true", help="so valida, nao envia")
    p.add_argument("--force", action="store_true",
                   help="republica mesmo com version <= a do hub")
    p.add_argument("--sem-strip", action="store_true", dest="no_strip",
                   help="sobe os .js com comentarios (padrao: enxutos como o aparelho compila)")
    p.add_argument("--private", action="store_true",
                   help="app privado: fora do catalogo publico, leitura exige token")
    p.add_argument("--tenant", default="",
                   help="tenant do app privado (ex.: vertical1)")
    p.set_defaults(fn=cmd_publish)

    p = sub.add_parser("publish-dep", help="publica dependencia JS no repo do hub")
    p.add_argument("file", help="arquivo <nome>.js da dep (ex: tools/sdk/engine/celeros.engine.js)")
    p.add_argument("--name", default=None, help="nome da dep (default: arquivo sem .js)")
    p.add_argument("--version", default=None, help="versao semver (default: lida do modulo)")
    p.add_argument("--min-api", type=int, default=1, dest="min_api",
                   help="CELEROS_API_LEVEL minimo do device (default: 1)")
    p.add_argument("--dep", action="append", metavar="NOME=RANGE",
                   help="dep transitiva (repetivel)")
    p.add_argument("--dry", action="store_true",
                   help="mostra o que subiria (nome/versao/tamanho/md5), sem enviar")
    p.add_argument("--force", action="store_true", help="republica a versao")
    p.add_argument("--sem-strip", action="store_true", dest="no_strip",
                   help="sobe o fonte com comentarios (padrao: enxuto como o aparelho compila)")
    p.add_argument("--private", action="store_true",
                   help="dep privada: fora do indice publico, leitura exige token")
    p.add_argument("--tenant", default="",
                   help="tenant da dep privada (ex.: vertical1)")
    p.set_defaults(fn=cmd_publish_dep)

    p = sub.add_parser("deps-status", help="drift tools/sdk/engine x hub (exit 1 se houver)")
    p.add_argument("--index", default=None,
                   help="deps.json local em vez do hub (offline/testes)")
    p.add_argument("--engine-dir", default=None, dest="engine_dir",
                   help="diretorio de fontes (default: tools/sdk/engine)")
    p.set_defaults(fn=cmd_deps_status)

    p = sub.add_parser("list", help="lista o catalogo e compara com o repo")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("delete", help="remove um app do hub")
    p.add_argument("package", help="packageName")
    p.add_argument("--yes", action="store_true")
    p.set_defaults(fn=cmd_delete)

    p = sub.add_parser("whoami", help="confere token/escopo")
    p.set_defaults(fn=cmd_whoami)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
