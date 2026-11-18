#!/usr/bin/env python3
"""Instala o `celerctl` como comando no PATH (Windows; Linux/macOS via symlink).

Sem isto, todo comando exige `python tools/celerctl.py ...` de dentro do repo.
Com os shims, `celerctl monitor COM5 --reset` funciona de qualquer pasta — que
e o que o `rbesp` do outro projeto ja faz (install-rb-command.ps1).

O caminho do repo e o do Python ficam GRAVADOS no shim: o comando funciona de
qualquer diretorio, mas continua apontando para ESTE clone. Rodar de novo
depois de mover o repo reescreve os shims.

    python tools/celerctl_install.py              # instala (PATH do usuario)
    python tools/celerctl_install.py --session    # + o terminal atual
    python tools/celerctl_install.py --show       # estado atual, sem mexer
    python tools/celerctl_install.py --uninstall  # remove os shims e o PATH

Windows: %LOCALAPPDATA%\\CelerOS\\bin com celerctl.cmd + celerctl.ps1 (e o
alias cctl). O .cmd e o que o cmd.exe/PowerShell resolvem primeiro; o .ps1
existe para quem chama por caminho absoluto num script PowerShell.

Linux/macOS: ~/.local/bin/celerctl como symlink para tools/celerctl.py (com o
shebang do proprio arquivo). Pede para o usuario garantir ~/.local/bin no PATH
em vez de editar o ~/.profile calado.
"""

import argparse
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tools" / "celerctl.py"
# nomes instalados: o principal e o alias curto (o rbesp faz rb/rbesp)
NAMES = ("celerctl", "cctl")


def bin_dir():
    """Pasta dos shims. %LOCALAPPDATA%\\CelerOS\\bin no Windows (por usuario,
    sem admin), ~/.local/bin no resto."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "CelerOS" / "bin"
    return Path.home() / ".local" / "bin"


def _limpo(env=None):
    """Ambiente sem as variaveis PYTHON* herdadas.

    `PYTHONUSERBASE` no ambiente (o env do IDF define) muda onde o Python do
    SISTEMA procura o site-packages do usuario: o `import serial` falha dentro
    de um subprocess deste shell e funciona no terminal limpo. O shim roda no
    terminal do usuario (sem essa heranca), entao a validacao tem que usar o
    ambiente que ele vai ter — senao o instalador rejeita um Python bom.
    """
    base = dict(os.environ if env is None else env)
    return {k: v for k, v in base.items() if not k.upper().startswith("PYTHON")}


def _has_pyserial(py):
    """O celerctl importa pyserial no topo: um shim apontando para um
    interpretador sem ele morre em "pyserial nao instalado" toda vez.

    Tambem prova que o caminho EXECUTA: o stub da Microsoft Store existe no
    disco e falha (ou abre a loja) quando chamado de um processo sem console.
    """
    try:
        r = subprocess.run([py, "-c", "import serial"], capture_output=True,
                           timeout=20, env=_limpo())
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _instavel(py):
    """Interpretador de ambiente descartavel ou STUB.

    Dois casos, ambos quebram o shim em silencio:
    - venv do IDF / .espressif / uv: o caminho some quando o ambiente e
      recriado;
    - o stub da Microsoft Store (WindowsApps\\...\\python.exe): e um
      redirector que abre a loja quando o Python real nao esta instalado, e
      o comportamento muda com o alias do usuario.
    O shim tem que apontar para um Python de VERDADE, do sistema.
    """
    baixo = str(py).lower().replace("/", "\\")
    if any(t in baixo for t in ("\\python_env\\", "\\.espressif\\", "\\envs\\",
                                "\\.venv\\", "\\venv\\", "\\uv\\")):
        return True
    return "\\windowsapps\\" in baixo


def python_exe():
    """Interprete gravado no shim.

    Preferencia: um Python ESTAVEL com pyserial, nao o `sys.executable`. O
    risco e concreto: rodar este instalador de dentro do env do IDF grava
    `...\\idf6.1_py3.14_env\\Scripts\\python.exe`, e esse env morre/renomeia
    quando o IDF e atualizado — os shims parariam de funcionar em silencio.
    Ordem: o que rodou o instalador (se for do sistema) -> `python`/`python3`
    do PATH (idem) -> candidatos conhecidos do sistema.
    """
    candidatos = []
    if os.name == "nt":
        # PRIMEIRO os caminhos canonicos do sistema: o PATH pode comecar pelo
        # stub da Microsoft Store (WindowsApps), que responde "python" e ate
        # importa serial, mas e um redirector — nao serve para um shim.
        for c in (r"C:\Python314\python.exe", r"C:\Python313\python.exe",
                  r"C:\Python312\python.exe", r"C:\Python311\python.exe"):
            if os.path.isfile(c):
                candidatos.append(c)
    exe = sys.executable
    if exe and not _instavel(exe):
        candidatos.append(exe)
    for nome in ("python", "python3"):
        achado = shutil.which(nome)
        if achado and not _instavel(achado):
            candidatos.append(achado)
    # `py`/`py.exe` e um LAUNCHER, nao um interpretador: `py script.py` escolhe
    # a versao sozinho e pode nao ser a que tem pyserial. Resolve o real por
    # tras dele e nunca grava o launcher no shim.
    if shutil.which("py"):
        try:
            r = subprocess.run(["py", "-3", "-c", "import sys;print(sys.executable)"],
                               capture_output=True, text=True, timeout=20)
            if r.returncode == 0 and r.stdout.strip():
                real = r.stdout.strip()
                if not _instavel(real):
                    candidatos.append(real)
        except (OSError, subprocess.SubprocessError):
            pass
    vistos = set()
    for c in candidatos:
        if not c or c in vistos:
            continue
        vistos.add(c)
        if _has_pyserial(c):
            return c
    # nenhum do sistema tem pyserial: usa o que rodou o instalador (o erro do
    # celerctl e explicito e manda instalar) — melhor do que um shim quebrado
    return exe or (shutil.which("python") or "python")


def cmd_shim(py, script):
    """Conteudo do <nome>.cmd: repassa TODOS os argumentos ao script.

    `%*` preserva a linha inteira como veio (aspas incluidas) — refazer a
    juncao com shift perderia espaco em argumento com caminho.

    `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`: as mensagens da ferramenta sao
    em portugues (com acento em algumas) e o console do Windows nasce em
    cp850/cp1252 — sem isto o "-" das mensagens vira "?" e um nome de app com
    acento sai corrompido. Fixar no shim e melhor do que depender do ambiente
    de quem abriu o terminal.
    """
    return (
        "@echo off\r\n"
        "setlocal\r\n"
        "set PYTHONIOENCODING=utf-8\r\n"
        "set PYTHONUTF8=1\r\n"
        f'"{py}" "{script}" %*\r\n'
        "exit /b %ERRORLEVEL%\r\n"
    )


def ps1_shim(py, script):
    """Conteudo do <nome>.ps1: `@args` espalha os argumentos como recebidos."""
    return (
        "$env:PYTHONIOENCODING = 'utf-8'\r\n"
        "$env:PYTHONUTF8 = '1'\r\n"
        f'& "{py}" "{script}" @args\r\n'
        "exit $LASTEXITCODE\r\n"
    )


def path_entries(value):
    """PATH em lista, sem entradas vazias (o Path do Windows costuma ter
    ';' sobrando no fim, que vira string vazia e confunde a comparacao)."""
    if not value:
        return []
    return [e.strip() for e in value.split(os.pathsep) if e.strip()]


def has_entry(entries, target):
    alvo = os.path.normcase(os.path.normpath(str(target)))
    return any(os.path.normcase(os.path.normpath(e)) == alvo for e in entries)


def user_path():
    """PATH persistente do usuario (Windows: registro; resto: None)."""
    if os.name != "nt":
        return None
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            return winreg.QueryValueEx(k, "Path")[0]
    except FileNotFoundError:
        return ""
    except OSError:
        return ""


def set_user_path(value):
    if os.name != "nt":
        return False
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0,
                        winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, "Path", 0, winreg.REG_EXPAND_SZ, value)
    # avisa o Explorer/novos processos; ignora falha (sem shell32, sandbox)
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        "[Environment]::GetEnvironmentVariable('Path','User') | Out-Null"],
                       capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        pass
    return True


def _write(path, text, unicode_ps1=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    # UTF-8 sem BOM no .cmd (o cmd.exe le ANSI; BOM viraria lixo no 1o comando)
    path.write_text(text, encoding="utf-16" if unicode_ps1 else "utf-8",
                    newline="")


def session_refresh_command():
    """Comando que faz o terminal ATUAL ver o PATH novo.

    O Windows nao propaga mudanca de PATH para processos ja abertos: quem
    nasceu antes da instalacao (o terminal do IDE, o Cursor que o gerou)
    continua com o ambiente antigo e responde "celerctl nao e reconhecido"
    mesmo com tudo instalado. O PowerShell nao tem como o processo filho
    alterar o pai — o jeito e colar isto no terminal:
    """
    return ("$env:PATH = [Environment]::GetEnvironmentVariable('Path','User')"
            " + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')")


def session_sees(alvo):
    """O terminal desta sessao ja enxerga a pasta dos shims?"""
    return has_entry(path_entries(os.environ.get("PATH", "")), alvo)


def install(session=False, quiet=False):
    py, script = python_exe(), str(SCRIPT)
    alvo = bin_dir()
    criados = []
    if os.name == "nt":
        for nome in NAMES:
            c = alvo / f"{nome}.cmd"
            p = alvo / f"{nome}.ps1"
            _write(c, cmd_shim(py, script))
            _write(p, ps1_shim(py, script), unicode_ps1=True)
            criados += [c, p]
    else:
        alvo.mkdir(parents=True, exist_ok=True)
        for nome in NAMES:
            dest = alvo / nome
            if dest.exists() or dest.is_symlink():
                dest.unlink()
            dest.symlink_to(SCRIPT)
            SCRIPT.chmod(SCRIPT.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            criados.append(dest)

    # PATH: usuario (persistente) e, com --session, o terminal atual
    mudou_path = False
    if os.name == "nt":
        atual = user_path() or ""
        entradas = path_entries(atual)
        if not has_entry(entradas, alvo):
            novo = (atual.rstrip(os.pathsep) + os.pathsep + str(alvo)) if atual else str(alvo)
            if set_user_path(novo):
                mudou_path = True
    if session or os.name != "nt":
        if not has_entry(path_entries(os.environ.get("PATH", "")), alvo):
            os.environ["PATH"] = str(alvo) + os.pathsep + os.environ.get("PATH", "")
            mudou_path = True

    if not quiet:
        for f in criados:
            print(f"  shim: {f}")
        if mudou_path:
            print(f"  PATH: {alvo}")
        else:
            print(f"  PATH: {alvo} (ja estava)")
        print()
        print(f"pronto: {NAMES[0]} — ex.: {NAMES[0]} monitor COM5 --reset")
        # O aviso que evita o "instalei e nao funciona": se o PATH persistente
        # foi alterado mas ESTE terminal nao o ve, o Windows nao vai avisar —
        # o comando simplesmente nao existe para ele.
        if os.name == "nt" and not session_sees(alvo):
            print()
            print("ATENCAO: este terminal e anterior a instalacao e ainda nao ve o PATH.")
            print("Abra um terminal NOVO, ou cole isto neste:")
            print(f"  {session_refresh_command()}")
    return criados, mudou_path


def uninstall(quiet=False):
    alvo = bin_dir()
    removidos = []
    for nome in NAMES:
        for suf in (".cmd", ".ps1", ""):
            f = alvo / f"{nome}{suf}"
            if f.exists() or f.is_symlink():
                f.unlink()
                removidos.append(f)
    entradas = path_entries(user_path() or "")
    if has_entry(entradas, alvo):
        filtradas = [e for e in entradas
                     if os.path.normcase(os.path.normpath(e)) !=
                     os.path.normcase(os.path.normpath(str(alvo)))]
        set_user_path(os.pathsep.join(filtradas))
    if not quiet:
        for f in removidos:
            print(f"  removido: {f}")
        print("PATH do usuario: entrada removida (terminal atual segue com ela ate reabrir)")
    return removidos


def show():
    alvo = bin_dir()
    py = python_exe()
    print(f"repo    : {ROOT}")
    print(f"script  : {SCRIPT} (existe: {SCRIPT.is_file()})")
    print(f"python  : {py}")
    print(f"shims em: {alvo}")
    for nome in NAMES:
        for suf in (".cmd", ".ps1", ""):
            f = alvo / f"{nome}{suf}"
            if f.exists() or f.is_symlink():
                print(f"  [OK] {f.name}")
    if os.name == "nt":
        print(f"PATH do usuario: {'sim' if has_entry(path_entries(user_path() or ''), alvo) else 'NAO'}")
    ve = session_sees(alvo)
    print(f"PATH desta sessao: {'sim' if ve else 'NAO'}")
    if os.name == "nt" and not ve:
        print()
        print("este terminal e anterior a instalacao (o Windows nao propaga PATH")
        print("para processos ja abertos). Abra um terminal NOVO, ou cole isto:")
        print(f"  {session_refresh_command()}")


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--session", action="store_true",
                    help="tambem poe no PATH deste terminal (nao so no persistente)")
    ap.add_argument("--show", action="store_true", help="mostra o estado, sem mexer")
    ap.add_argument("--uninstall", action="store_true", help="remove shims e a entrada do PATH")
    args = ap.parse_args(argv)

    if not SCRIPT.is_file():
        print(f"erro: {SCRIPT} nao existe (rode de dentro do repo)", file=sys.stderr)
        return 1
    if args.show:
        show()
        return 0
    if args.uninstall:
        uninstall()
        return 0
    install(session=args.session)
    return 0


if __name__ == "__main__":
    sys.exit(main())
