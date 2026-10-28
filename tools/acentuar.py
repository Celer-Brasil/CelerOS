#!/usr/bin/env python3
"""Restaura acentos do portugues nas STRINGS de apps JS (e de fontes C++).

O CelerOS escrevia a UI sem acentos porque as fontes eram so ASCII; desde as
fontes Latin-1 (tools/make_fonts.py) o texto acentuado aparece na tela. Este
script troca "configuracoes" -> "configurações" etc. apenas dentro de
literais de string — comentarios, identificadores e logs ficam como estao.

Regra conservadora (lista /usr/share/dict/brazilian): so troca quando a forma
sem acento NAO e palavra valida e existe UMA unica forma acentuada. Por isso
"e"/"é", "esta"/"está", "ha"/"há", "sabia"/"sábia" nunca mudam sozinhas —
reveja essas a mao. Strings sem espaco e todas minusculas (chaves, caminhos,
nomes de arquivo) tambem ficam de fora.

Uso:
    python3 tools/acentuar.py arquivo.js [...]          # mostra as trocas (ensaio)
    python3 tools/acentuar.py --write arquivo.js [...]  # aplica
    python3 tools/acentuar.py --cpp --write main/x.cpp  # so dentro de i18n::TR("pt", ...)
    python3 tools/acentuar.py --cpp-ui --write main/x.cpp  # toda string, menos linhas de log
"""
import argparse
import re
import sys
import unicodedata

DICT = "/usr/share/dict/brazilian"


def strip(w):
    return "".join(c for c in unicodedata.normalize("NFD", w) if unicodedata.category(c) != "Mn")


def load_map():
    words = set()
    with open(DICT, encoding="utf-8") as f:
        for line in f:
            w = line.strip()
            if w:
                words.add(w.lower())
    cands = {}
    for w in words:
        k = strip(w)
        if k != w:
            cands.setdefault(k, set()).add(w)
    # so quando a forma sem acento nao existe e ha uma unica acentuada
    return {k: next(iter(v)) for k, v in cands.items() if len(v) == 1 and k not in words}


def match_case(src, dst):
    if src.isupper() and len(src) > 1:
        return dst.upper()
    if src[:1].isupper():
        return dst[:1].upper() + dst[1:]
    return dst


def fix_text(s, mapping, changes):
    if " " not in s and s == s.lower():
        return s  # chave/caminho/identificador: nao mexe
    def rep(m):
        w = m.group(0)
        if m.start() > 0 and s[m.start() - 1] == "\\":
            return w  # sequencia de escape (\\xA0, \\n...), nao palavra
        new = mapping.get(w.lower())
        if not new:
            return w
        out = match_case(w, new)
        changes.append((w, out))
        return out
    return re.sub(r"[A-Za-z]+", rep, s)


JS_STR = re.compile(r'"((?:[^"\\\n]|\\.)*)"|\'((?:[^\'\\\n]|\\.)*)\'')
CPP_TR = re.compile(r'(i18n::TR\(\s*)"((?:[^"\\\n]|\\.)*)"')


def process_js(src, mapping, changes):
    out, i = [], 0
    n = len(src)
    while i < n:
        c = src[i]
        # comentarios ficam intactos
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(src[i:j]); i = j; continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(src[i:j]); i = j; continue
        if c in "\"'":
            m = JS_STR.match(src, i)
            if m:
                body = m.group(1) if m.group(1) is not None else m.group(2)
                out.append(c + fix_text(body, mapping, changes) + c)
                i = m.end(); continue
        out.append(c); i += 1
    return "".join(out)


def process_cpp(src, mapping, changes):
    # so o lado pt de i18n::TR("pt", "en"): logs e comentarios seguem sem acento
    return CPP_TR.sub(lambda m: m.group(1) + '"' + fix_text(m.group(2), mapping, changes) + '"', src)


LOG_LINE = re.compile(r"celer_log|ESP_LOG|printf\(|print\(ctx|#include|respondError|snprintf")
CPP_STR = re.compile(r'"((?:[^"\\\n]|\\.)*)"')


def process_cpp_ui(src, mapping, changes):
    # UI nativa: toda string de linha que nao e log/protocolo; comentarios
    # de linha inteira ficam intactos
    out = []
    for line in src.split("\n"):
        code = line.split("//", 1)
        if LOG_LINE.search(code[0]) or line.lstrip().startswith(("//", "*", "/*")):
            out.append(line)
            continue
        head = CPP_STR.sub(lambda m: '"' + fix_text(m.group(1), mapping, changes) + '"', code[0])
        out.append(head + ("//" + code[1] if len(code) > 1 else ""))
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--write", action="store_true", help="aplica (sem isto: so mostra)")
    ap.add_argument("--cpp", action="store_true", help="fonte C++: so i18n::TR")
    ap.add_argument("--cpp-ui", action="store_true", help="fonte C++ de UI: toda string fora de log")
    args = ap.parse_args()
    mapping = load_map()
    total = 0
    for path in args.files:
        # newline="": le e grava sem traduzir quebras (um arquivo CRLF nao
        # pode sair todo reescrito em LF — isso viraria diff fantasma)
        with open(path, encoding="utf-8", newline="") as f:
            src = f.read()
        changes = []
        proc = process_cpp_ui if args.cpp_ui else (process_cpp if args.cpp else process_js)
        new = proc(src, mapping, changes)
        if changes:
            total += len(changes)
            uniq = sorted(set(changes))
            print("%s: %d trocas  %s" % (path, len(changes), ", ".join("%s>%s" % p for p in uniq)))
            if args.write:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(new)
    print("total: %d trocas%s" % (total, "" if args.write else " (ensaio; use --write)"))


if __name__ == "__main__":
    main()
