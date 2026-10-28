#!/usr/bin/env python3
"""Servidor OTA de desenvolvimento para o CelerOS.

Serve o firmware.bin de uma build local + um update.json dinamico para a
placa testar o fluxo de OTA over-the-air na LAN, sem precisar pushar nada
para o GitHub.

Uso tipico:

    idf.py -B build build
    python3 tools/ota_server.py --board smartdisplay

A versao publicada e lida do CMakeLists.txt raiz (project(CelerOS VERSION
x.y.z); --version sobrepoe); para testar a atualizacao, suba a versao la,
rebuild e reinicie o servidor. No dispositivo, grave em /local/ota_url.txt
a URL impressa no inicio:

    http://<ip-do-pc>:10234/update.json

(coloque o arquivo pelo web file manager ou pelo cartao SD). Remova o
arquivo para voltar a usar o canal do GitHub.
"""

import argparse
import json
import os
import re
import socket
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def read_version(repo_root: str, override: str | None) -> str:
    if override:
        return override
    # project(CelerOS VERSION x.y.z) no CMakeLists.txt raiz
    with open(os.path.join(repo_root, "CMakeLists.txt")) as f:
        for line in f:
            m = re.search(r"project\(\s*CelerOS\s+VERSION\s+(\S+)", line)
            if m:
                return m.group(1).strip(")")
    return "0.0.0"


def read_api_level(repo_root: str) -> int:
    # CELEROS_API_LEVEL=N no main/CMakeLists.txt — o manifest tem que
    # declarar o nivel real (desde 2026-10 o aparelho recusa api_version
    # ausente/lixo/menor que o atual)
    try:
        with open(os.path.join(repo_root, "main", "CMakeLists.txt")) as f:
            for line in f:
                m = re.search(r"CELEROS_API_LEVEL\s*=\s*(\d+)", line)
                if m:
                    return int(m.group(1))
    except OSError:
        pass
    return 0


class Handler(BaseHTTPRequestHandler):
    bin_path: str = ""
    version: str = "0.0.0"
    api_level: int = 0
    drop_at: list = []      # offsets onde a conexao cai (1x cada) — teste de retomada
    no_range: bool = False  # ignora Range (servidor "burro": devolve 200 inteiro)

    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/", "/update.json"):
            doc = {
                "version": self.version,
                "api_version": self.api_level,
                "major_update": True,
                "minor_update": False,
                "security_update": False,
                "changelog": "- OTA dev build served by tools/ota_server.py",
                "guide": "Tap INSTALL to flash this build.",
                # Relativa: o dispositivo resolve contra o diretorio do update.json
                "firmware_url": "firmware.bin",
            }
            body = json.dumps(doc, indent=2).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if self.command != "HEAD":  # HEAD: so os headers (como no /firmware.bin)
                self.wfile.write(body)
        elif path == "/firmware.bin":
            try:
                size = os.path.getsize(self.bin_path)
            except OSError:
                self.send_error(404, "firmware.bin not found (build first)")
                return
            # Range "bytes=N-" (a OTA do firmware retoma de onde a conexao caiu)
            start = 0
            m = re.match(r"bytes=(\d+)-$", self.headers.get("Range", "") or "")
            if m and not self.no_range and int(m.group(1)) < size:
                start = int(m.group(1))
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{size - 1}/{size}")
            else:
                self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size - start))
            self.send_header("Accept-Ranges", "none" if self.no_range else "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            if self.command == "HEAD":
                return
            print(f"[ota] firmware: de {start} ({'206' if start else '200'})")
            with open(self.bin_path, "rb") as f:
                f.seek(start)
                pos = start
                while chunk := f.read(16 * 1024):
                    cut = next((d for d in self.drop_at if pos <= d < pos + len(chunk)), None)
                    if cut is not None:
                        self.drop_at.remove(cut)
                        self.wfile.write(chunk[:cut - pos])
                        self.wfile.flush()
                        print(f"[ota] derrubando a conexao no byte {cut} (teste de retomada)")
                        self.connection.shutdown(2)
                        self.close_connection = True
                        return
                    self.wfile.write(chunk)
                    pos += len(chunk)
        else:
            self.send_error(404)

    def do_HEAD(self):  # noqa: N802
        self.do_GET()

    def log_message(self, fmt, *args):
        print(f"[ota] {self.address_string()} {fmt % args}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", default="smartdisplay", help="board do ESP-IDF: smartdisplay|cyd (para achar o CelerOS.bin)")
    ap.add_argument("--bin", help="caminho direto do CelerOS.bin (sobrepoe --board)")
    ap.add_argument("--port", type=int, default=10234)
    ap.add_argument("--version", help="versao a publicar (default: project(VERSION) do CMakeLists.txt)")
    ap.add_argument("--drop-at", type=int, action="append", default=[],
                    help="derruba a conexao do firmware.bin neste byte (1x; repita a opcao) — testa a retomada")
    ap.add_argument("--no-range", action="store_true",
                    help="ignora Range e responde 200 inteiro (servidor sem retomada)")
    args = ap.parse_args()

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    build_dir = "build-cyd" if args.board == "cyd" else "build"
    bin_path = args.bin or os.path.join(repo_root, build_dir, "CelerOS.bin")
    if not os.path.isfile(bin_path):
        raise SystemExit(f"firmware nao encontrado: {bin_path} (rode idf.py -B <dir> build antes)")

    version = read_version(repo_root, args.version)
    Handler.bin_path = bin_path
    Handler.version = version
    Handler.api_level = read_api_level(repo_root)
    Handler.drop_at = list(args.drop_at)
    Handler.no_range = args.no_range
    print(f"[ota] api level: {Handler.api_level}")

    ip = lan_ip()
    print(f"[ota] firmware : {bin_path} ({os.path.getsize(bin_path)} bytes)")
    print(f"[ota] version  : {version}")
    print(f"[ota] no device: escreva em /local/ota_url.txt ->")
    print(f"[ota]            http://{ip}:{args.port}/update.json")
    print(f"[ota] servindo em http://{ip}:{args.port} (Ctrl+C para sair)")

    HTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
