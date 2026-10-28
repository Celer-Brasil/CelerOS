#!/usr/bin/env python3
r"""
celerctl - ferramenta de depuracao/manutencao do CelerOS via USB ou WiFi (estilo adb).

Conversa com o firmware pelo canal HostLink: na pratica a UART do CH340
(USB do PC -> /dev/ttyUSB*), a CDC1 nas placas de USB nativo, ou o Celer
Debug Bridge por TCP/WiFi ("-p IP" — mesmos comandos, token de pareamento).
Os opcodes sao lidos diretamente de main/USBDevice/HostLink.h para manter os
dois lados em sincronia.

Comandos:
  devices [-l]                lista placas CelerOS conectadas (USB e WiFi)
  pair IP[:PORTA] [--token T] pareia com o bridge WiFi e guarda o token
  provision [--wifi SSID SENHA] [--grant APP]  WiFi + token + permissoes (1a vez)
  info                        versao/board/heap/rede/filesystems
  top [-w] [--sort cpu|stack|name]  profiling: CPU% por task em janela,
                              heap interna/PSRAM, consumo do app JS, fps e a
                              linha svchost (giros/overrun/pior) quando o
                              firmware anuncia o bloco "svc" no KL_STATS
  stats [--json]              uma foto de profiling (taxas desde o boot)
  svc list                    servicos de app em 2o plano: estado por servico
  svc info PKG                detalhe do servico (estado, reinicios, pump)
  svc stop|start|setup PKG    para / religa / roda o setup de novo (API 42)
  crash [n]                   ultimo crash (lastcrash) + tail do apps.log
  shell [cmd...]              shell interativo (ou executa um comando; o shell
                              do device NAO trata aspas: escreva sem '...')
  mesh status|join|leave      a matilha pelo cabo (API 40): entra por nome+senha
  res ls|relay|sensor|...     recursos da matilha pelo cabo (gateway USB)
  ls [-l] CAMINHO             lista diretorio (/local ou /sd)
  cat ARQUIVO                 escreve conteudo no stdout
  rm / mkdir / mv             operacoes de arquivo
  push LOCAL REMOTO           envia arquivo para o dispositivo
  pull REMOTO [LOCAL]         baixa arquivo do dispositivo
  reboot                      reinicia a placa
  logcat [--dump] [--since TS] [--grep REGEX] [--json] [--ts]
                              logs: stream ao vivo ou copia o buffer (--dump);
                              filtro por timestamp do device (I (1234)) e regex
  ota push FW.bin [--no-reboot]  grava firmware pela conexao (sem esptool)
  coredump [--out ARQ]        baixa coredump ELF do ultimo crash nativo
  debug [APP] [--app APP] [--serve]  debugger Duktape: breakpoints, step,
                              eval (REPL neste terminal); --eval sem app falha
                              na hora em vez de esperar o attach
  screencap [SAIDA.png]       captura da tela do dispositivo
  tap X Y [ms]                injeta um toque (navegar pela UI via USB)
  swipe X0 Y0 X1 Y1 [ms]      injeta um arrasto (scroll/troca de pagina)
  dev PASTA                   loop de desenvolvimento: assiste a pasta, reinstala
                              o que mudou e relanca o app (exit+run), com logs
                              ao vivo (Ctrl-C sai)
  apps list                   lista apps instalados
  apps install PASTA [--run]  instala (lint antes); --run abre o app ao final
  apps pull NOME [DESTINO]    baixa um app instalado para o PC (backup)
  apps rm NOME                remove um app instalado

Exemplos:
  python3 tools/celerctl.py devices
  python3 tools/celerctl.py shell ls /local
  python3 tools/celerctl.py -b 921600 push firmware.bin /sd/fw.bin
  python3 tools/celerctl.py dev hub_apps/Celer Remote
  python3 tools/celerctl.py pair 192.168.0.50            # bridge WiFi (1x)
  python3 tools/celerctl.py -p 192.168.0.50 ota push build-x/CelerOS.bin

Dependencias: pyserial (pip install -r tools/requirements.txt)
"""

import argparse
import getpass
import hashlib
import json
import os
import re
import secrets
import select
import socket
import struct
import sys
import tempfile
import threading
import time
import zlib
from pathlib import Path
from urllib import request as _urlreq
from urllib.parse import quote as _urlquote

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    print("erro: pyserial nao instalado (pip install -r tools/requirements.txt)")
    sys.exit(1)

# Porta USB nativa que some no meio de uma chamada (o device reiniciou: OTA,
# reboot) levanta termios.error, que NAO e OSError nem SerialException — sem
# isto o `ota push` do relogio terminava em traceback com o OTA ja aplicado.
try:
    import termios
    PORT_GONE = (serial.SerialException, OSError, termios.error)
except ImportError:  # Windows
    PORT_GONE = (serial.SerialException, OSError)

# VIDs que podem hospedar o canal: CDC nativa do ESP32-S3 ou bridges USB-UART
# comuns (CH340 do SmartDisplay/CYD). A identificacao real e por probing HELLO.
USB_VIDS = (0x303A, 0x1A86, 0x10C4)
CHUNK = 4096  # tamanho maximo de payload HostLink (proto 1)
DEFAULT_BAUD = 115200
BRIDGE_PORT = 5555  # porta default do Celer Debug Bridge (TCP e UDP)
FORCE_PROTO1 = False  # --proto 1: valida o caminho legado sem CRC/janela
WIN_CAP = 0  # --win: teto manual da janela anunciada (OTA de firmware antigo)


class CelerError(Exception):
    pass


class OtaEndUnknown(CelerError):
    """OTA_END sem confirmacao: o boot pode ou nao estar marcado."""


def load_opcodes():
    """Extrai os opcodes KL_* do header do firmware (fonte unica)."""
    header = Path(__file__).resolve().parent.parent / "main" / "USBDevice" / "HostLink.h"
    ops = {}
    for name, value in re.findall(r"KL_(\w+)\s*=\s*(0x[0-9A-Fa-f]+)", header.read_text()):
        ops[name] = int(value, 16)
    missing = {"HELLO", "INFO", "LS", "STAT", "READ", "WRITE_BEGIN", "WRITE_CHUNK",
               "WRITE_END", "DELETE", "MKDIR", "RENAME", "EXEC", "REBOOT", "EXEC_CONT",
               "SET_BAUD", "TOUCH"} - set(ops)
    if missing:
        raise CelerError(f"opcodes ausentes em {header}: {missing}")
    return ops


KL = load_opcodes()

# Frames que o device manda SEM pedido (logcat, espelho de tela, debugger,
# gateway de recursos / eventos do no virtual): qualquer laco que espera uma
# resposta guarda estes na push_queue em vez de abortar ("frame inesperado").
PUSH_CMDS = frozenset(KL[k] for k in ("LOG_DATA", "SCR_DATA", "DEBUG_DATA", "RES_DATA") if k in KL)


def load_usbres_subops():
    """Subops do gateway USB (KL_RES_CTL) do UsbRes.h do firmware (fonte unica,
    como os KL_* do HostLink.h)."""
    header = Path(__file__).resolve().parent.parent / "main" / "USBDevice" / "UsbRes.h"
    subs = {name: int(v) for name, v in
            re.findall(r"constexpr uint8_t SUB_(\w+)\s*=\s*(\d+)\s*;", header.read_text())}
    missing = {"DESCRIBE", "LIST", "MESH", "OPEN", "KEEP", "CLOSE", "WRITE"} - set(subs)
    if missing:
        raise CelerError(f"subops ausentes em {header}: {missing}")
    return subs


SUB = load_usbres_subops()
# flag do SUB_NET: o PC entra como no virtual (mesh listen)
NET_ENTER = int(re.search(r"constexpr uint8_t NET_ENTER\s*=\s*(\w+)\s*;",
                          (Path(__file__).resolve().parent.parent / "main" / "USBDevice" /
                           "UsbRes.h").read_text()).group(1), 0)


def load_usbres_paths():
    """Arquivos de troca da midia pelo cabo (PC_*_PATH do UsbRes.h)."""
    header = Path(__file__).resolve().parent.parent / "main" / "USBDevice" / "UsbRes.h"
    return dict(re.findall(r'constexpr const char\* (PC_\w+_PATH) = "([^"]+)"', header.read_text()))


PC_PATHS = load_usbres_paths()


def read_exact(ser, n, timeout):
    """Le exatamente n bytes (bloqueando ate timeout)."""
    buf = b""
    deadline = time.monotonic() + timeout
    original = getattr(ser, "timeout", None)
    try:
        while len(buf) < n:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CelerError("timeout lendo do dispositivo")
            ser.timeout = min(remaining, 1.0)
            chunk = ser.read(n - len(buf))
            if chunk:
                buf += chunk
    finally:
        # o timeout mutavel e o relogio da leitura, nao um ajuste permanente:
        # sem o restore o ser.timeout ficava <= 1.0 para sempre (o set_baud
        # reabria a porta com 1.0 s em vez do timeout configurado)
        if original is not None:
            ser.timeout = original
    return buf


# ------------------------------------------------- Celer Debug Bridge (WiFi)
# O firmware hospeda o HostLink num servidor TCP (porta 5555): banner
# "CELERBRIDGE 1 ..." + "AUTH <token>" e depois um pipe binario de frames.
# Aqui embaixo vive so o transporte — o protocolo HostLink em cima e o mesmo
# da serial. Descoberta: sonda UDP broadcast ("celerctl devices").
#
# Identidade: o banner (5o campo) e a sonda UDP ("|id") carregam o MAC do
# device, ANTES do auth. O cache de tokens guarda "ip:porta" E "id:<mac>";
# DHCP pode mudar o IP que o token da identidade re-autentica e o cache se
# re-escreve sozinho (bancada 2026-10-11: duas placas trocaram de IP e o
# cache por IP virou lockout com recuperacao so por USB).

_BRIDGE_ID_RE = re.compile(r"\|id ([0-9a-fA-F]{6,16})")
_BANNER_ID_RE = re.compile(r"[0-9a-fA-F]{6,16}")


def probe_devid(ident):
    """Id do device na resposta da sonda UDP ("...|id aabbccddeeff") ou None."""
    m = _BRIDGE_ID_RE.search(ident or "")
    return m.group(1).lower() if m else None


def banner_devid(banner):
    """Id do device no banner TCP ("CELERBRIDGE 1 board ip porta <id>") ou None."""
    f = (banner or "").split()
    if len(f) >= 6 and _BANNER_ID_RE.fullmatch(f[5]):
        return f[5].lower()
    return None

def is_net_addr(s):
    """"192.168.0.10" (porta default) ou "host:5555"."""
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", s):
        return True
    return bool(re.match(r"^[A-Za-z0-9._-]+:\d{1,5}$", s))


def split_net_addr(addr):
    host, _, port = addr.rpartition(":")
    if not host or not port.isdigit():
        return addr, BRIDGE_PORT
    return host, int(port)


def normalize_net_addr(addr):
    if not is_net_addr(addr):
        die(f"{addr} nao e um endereco do bridge (IP ou host:porta)")
    host, port = split_net_addr(addr)
    return f"{host}:{port}"


def token_store_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(base) / "celerctl" / "tokens.json"


def load_token_cache():
    try:
        return json.loads(token_store_path().read_text())
    except (OSError, ValueError):
        return {}


def save_token(addr, token, devid=None):
    """Token no cache pela chave do endereco E pela identidade do device
    ("id:<mac>", firmware novo): o endereco cura sozinho quando o DHCP muda."""
    p = token_store_path()
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        cache = load_token_cache()
        cache[addr] = token
        if devid:
            cache["id:" + devid] = token
        # 0600: o token abre o bridge (OTA/shell) para qualquer processo local
        if p.exists():
            os.chmod(p, 0o600)
        elif hasattr(os, "open"):
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps(cache, indent=1, sort_keys=True))
            return
        p.write_text(json.dumps(cache, indent=1, sort_keys=True))
    except OSError:
        pass  # cache e conveniencia: sem ele, --token/env continuam valendo


def forget_token(addr, token=None, devid=None):
    """Tira do cache o token recusado (pelo endereco, pela identidade e por
    qualquer chave que guarde o MESMO valor). Proximo comando volta a
    perguntar/renovar em vez de repetir o token velho depois de um reflash
    ou de um "bridge reset" no device."""
    p = token_store_path()
    try:
        cache = load_token_cache()
        gone = False
        for key in (addr, ("id:" + devid) if devid else None):
            if key and key in cache:
                del cache[key]
                gone = True
        if token:
            for key, val in list(cache.items()):
                if val == token:
                    del cache[key]
                    gone = True
        if gone:
            p.write_text(json.dumps(cache, indent=1, sort_keys=True))
    except OSError:
        pass  # cache e conveniencia


def net_token(addr, prompt=True):
    """Token do bridge: --token (caller) > env CELEROS_BRIDGE_TOKEN > cache."""
    tok = os.environ.get("CELEROS_BRIDGE_TOKEN")
    if tok:
        return tok
    tok = load_token_cache().get(addr)
    if tok:
        return tok
    if not prompt:
        raise CelerError(f"token do bridge ausente para {addr} (celerctl pair, "
                         "--token ou env CELEROS_BRIDGE_TOKEN)")
    try:
        return input(f"token do bridge {addr} (comando 'bridge' no device): ").strip()
    except EOFError:
        raise CelerError(f"token do bridge ausente para {addr}") from None


class NetTransport:
    """Socket TCP com a aparencia do pyserial (duck-typed no lugar de ser).

    Faz o handshake do bridge (banner + AUTH <token>) e vira pipe binario
    de frames HostLink. O token vem de --token/env/cache — ou do terminal,
    se interativo. Com o firmware novo (id no banner), o cache da IDENTIDADE
    do device tambem e candidato: IP novo por DHCP autentica do mesmo jeito
    e o cache re-escreve o endereco na hora.
    """

    def __init__(self, addr, timeout=3.0, token=None, prompt=True):
        host, port = split_net_addr(addr)
        self.addr = f"{host}:{port}"
        self.port = self.addr        # pyserial: identificador para reabrir
        self.baudrate = None         # sem baud: o set_baud do HostLink pula
        self._timeout = timeout
        self.devid = None            # identidade do banner (firmware novo)
        self.sock = socket.create_connection((host, port), timeout=timeout)
        try:
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            banner = self._line(timeout)
            if not banner.startswith("CELERBRIDGE"):
                if "busy" in banner.lower():
                    raise CelerError(f"{addr}: bridge ocupado por outra sessao "
                                     "celerctl (uma por vez) — aguarde alguns "
                                     "segundos e tente de novo")
                raise CelerError(f"{addr} nao e um Celer Debug Bridge "
                                 f"(banner: {banner!r})")
            self.devid = banner_devid(banner)
            cache = load_token_cache()
            id_tok = cache.get("id:" + self.devid) if self.devid else None
            cands = []  # (token, veio_do_cache)
            if token is not None:
                cands.append((token, False))
            else:
                for t in (cache.get(self.addr), id_tok):
                    if t and t not in [c[0] for c in cands]:
                        cands.append((t, True))
                if not cands:
                    cands.append((net_token(self.addr, prompt=prompt), False))
            # 2 tentativas no maximo: o device corta a conexao na 3a falha
            ok = False
            last = ""
            for t, _from_cache in cands[:2]:
                self.sock.sendall(f"AUTH {t}\n".encode())
                try:
                    last = self._line(timeout)
                except CelerError as e:
                    if "timeout" in str(e):
                        # sem resposta ao AUTH: token velho pos-reflash tambem
                        # chega assim (o bridge nao devolve NO quando nao ouve)
                        raise CelerError(
                            f"{e}: token velho? rode no device: shell bridge "
                            f"(e renove com celerctl pair {self.addr})") from None
                    raise
                if last == "OK":
                    ok = True
                    if token is None:
                        save_token(self.addr, t, self.devid)  # IP novo: re-key
                    break
            if not ok:
                # token do CACHE recusado (reflash/bridge reset): limpa para o
                # proximo comando pedir o atual em vez de repetir o velho
                for t, from_cache in cands[:2]:
                    if from_cache:
                        forget_token(self.addr, t, self.devid)
                hint = ("" if any(fc for _, fc in cands[:2]) else
                        " (token do --token/env tambem e conferido no device)")
                raise CelerError(f"auth do bridge recusada ({last}): token velho? "
                                 f"rode no device: shell bridge; depois celerctl "
                                 f"pair {self.addr}{hint}")
        except BaseException:
            self.sock.close()
            raise

    def _line(self, timeout):
        buf = b""
        deadline = time.monotonic() + timeout
        while b"\n" not in buf:
            if time.monotonic() > deadline:
                raise CelerError("timeout no handshake do bridge")
            self.sock.settimeout(max(0.05, deadline - time.monotonic()))
            chunk = self.sock.recv(64)
            if not chunk:
                raise CelerError("conexao fechada pelo device no handshake")
            buf += chunk
        return buf.split(b"\n", 1)[0].decode("utf-8", "replace").strip()

    # ---- aparencia pyserial usada pelo HostLink
    @property
    def timeout(self):
        return self._timeout

    @timeout.setter
    def timeout(self, v):
        self._timeout = v
        try:
            self.sock.settimeout(v)
        except OSError:
            pass

    def read(self, n=1):
        try:
            return self.sock.recv(n)  # pode voltar curto (stream), como a serial
        except socket.timeout:
            return b""                # mesma semantica do pyserial no timeout
        except OSError as e:
            # reset/refused viram SerialException: os handlers de reconexao
            # e retry do celerctl ja sabem o que fazer com ela
            raise serial.SerialException(f"bridge TCP: {e}") from None

    def write(self, data):
        try:
            self.sock.sendall(data)
        except socket.timeout:
            raise CelerError("timeout escrevendo no bridge") from None
        except OSError as e:
            raise serial.SerialException(f"bridge TCP: {e}") from None

    def reset_input_buffer(self):
        try:
            while self.in_waiting:
                self.sock.recv(65536)
        except OSError:
            pass

    @property
    def in_waiting(self):
        return 65536 if select.select([self.sock], [], [], 0)[0] else 0

    def fileno(self):
        return self.sock.fileno()

    def setblocking(self, flag):
        self.sock.setblocking(flag)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class HostLink:
    """Cliente do protocolo HostLink sobre a CDC1, a UART do CH340 ou o
    Celer Debug Bridge TCP/WiFi ("-p IP": banner+AUTH ficam no transporte).

    Dois formatos por sessao (ver main/USBDevice/HostFrame.h):
      proto 1: [43][cmd][len u16][payload]
      proto 2: [43][cmd][len u16][crc32 u32][payload]   crc sobre cmd+len+payload
    O hello() negocia: "CELERCTL2" ativa proto 2 (resposta traz
    "proto 2|chunk W|win K"); firmware antigo responde "proto 1" e a
    sessao segue em v1 (sem CRC, stop-and-wait — como sempre funcionou).
    """

    # Fluxo continuo (celerctl debug): o xfer NAO limpa a entrada nem a fila —
    # frames do debugger que chegam entre comandos sao o proprio protocolo — e
    # descarta respostas velhas (HELLO do keepalive) em vez de toma-las pela
    # resposta esperada
    keep_push = False

    def __init__(self, port, timeout=3.0, baud=DEFAULT_BAUD, token=None, prompt=True):
        if is_net_addr(port):
            self.ser = NetTransport(port, timeout=timeout, token=token, prompt=prompt)
        else:
            self.ser = open_serial(port, baud, timeout)
        self.timeout = timeout
        self.push_queue = []  # frames nao-solicitados (logs) que chegaram no meio de um xfer
        # teto de espera por comando EXEC (saida grande = mais continuacoes)
        self.exec_timeout = 15.0
        # preenchidos pelo hello() a partir do que o device anuncia
        self.proto = 1
        self.max_chunk = CHUNK
        self.win = 1

    def close(self):
        self.ser.close()

    def _frame(self, cmd, payload=b""):
        if self.proto == 2:
            head = struct.pack("<BH", cmd, len(payload))
            crc = zlib.crc32(head + payload) & 0xFFFFFFFF
            return b"\x43" + head + struct.pack("<I", crc) + payload
        return bytes([0x43, cmd]) + struct.pack("<H", len(payload)) + payload

    def _read_frame(self, expect_cmd=None, timeout=None):
        timeout = timeout or self.timeout
        # procura o magic 0x43 um byte por vez (resincroniza se houver lixo)
        while True:
            first = read_exact(self.ser, 1, timeout)
            if first[0] != 0x43:
                continue
            head = first + read_exact(self.ser, 3, timeout)
            cmd, length = head[1], struct.unpack("<H", head[2:4])[0]
            if self.proto == 2:
                crc = struct.unpack("<I", read_exact(self.ser, 4, timeout))[0]
                payload = read_exact(self.ser, length, timeout) if length else b""
                want = zlib.crc32(head[1:4] + payload) & 0xFFFFFFFF
                if crc != want:
                    continue  # frame corrompido: descarta e caca o proximo magic
            else:
                payload = read_exact(self.ser, length, timeout) if length else b""
            return cmd, payload

    # comandos que podem ser reenviados sem efeito colateral (retry do xfer)
    _IDEMPOTENT = {"HELLO", "INFO", "STATS", "LS", "STAT", "READ", "MKDIR", "DELETE", "RENAME",
                   "LOG_ON", "LOG_OFF", "LOG_DUMP", "TOUCH", "SCREENSHOT", "COREDUMP"}

    def xfer(self, cmd, payload=b"", timeout=None, retries=None):
        """Envia um comando e retorna (cmd_resposta, payload_resposta).

        Frames nao-solicitados (logs do logcat) que chegarem no meio do
        caminho sao guardados em push_queue em vez de confundir a resposta.
        Comandos idempotentes ganham retry com re-hello (sessao pode ter
        caido no idle de 8s da UART entre uma chamada e outra).
        """
        name = next((k for k, v in KL.items() if v == cmd and not k.endswith("_DATA")
                     and k != "EXEC_CONT"), None)
        if retries is None:
            retries = 1 if name in self._IDEMPOTENT else 0
        last_err = None
        for attempt in range(retries + 1):
            if attempt > 0:
                time.sleep(0.2)
                try:
                    self.hello(force_v1=self.proto == 1)
                except (CelerError, serial.SerialException):
                    continue
            frame = self._frame(cmd, payload)
            try:
                if not self.keep_push:
                    self.ser.reset_input_buffer()
                    self.push_queue = []
                self.ser.write(frame)
                cmd_r, payload_r = self._read_frame(timeout=timeout)
                while cmd_r != cmd:
                    if cmd_r in PUSH_CMDS:
                        self.push_queue.append((cmd_r, payload_r))
                    elif not (self.keep_push and cmd_r != 0x00):
                        break  # resposta de erro (0x00) ou inesperada: decide abaixo
                    cmd_r, payload_r = self._read_frame(timeout=timeout)
                if cmd_r == 0x00 or (payload_r and payload_r[0] == 1):
                    raise CelerError(payload_r[1:].decode("utf-8", "replace") or
                                     "erro no dispositivo")
                return cmd_r, payload_r
            except CelerError as e:
                last_err = e
                if "timeout" not in str(e):
                    raise
        raise last_err if last_err else CelerError("timeout lendo do dispositivo")

    # -------------------------------------------------- gateway USB (Onda B)
    # Formatos no UsbRes.h do firmware (subops e o fio do ResProto).

    def res_ctl(self, subop, body=b"", reqid=0, timeout=None):
        """KL_RES_CTL: req [subop][reqid][len u16 BE][corpo] ->
        [status][reqid][len u16 BE][corpo]; devolve o corpo."""
        payload = bytes((subop, reqid & 0xFF, (len(body) >> 8) & 0xFF, len(body) & 0xFF)) + body
        _, p = self.xfer(KL["RES_CTL"], payload, timeout=timeout)
        if len(p) < 4:
            raise CelerError("resposta RES_CTL curta")
        blen = (p[2] << 8) | p[3]
        return p[4:4 + blen]

    def res_open(self, nome, opts=None):
        """Abre um recurso LOCAL do gateway; devolve dict com sid/lease/transp.
        Levanta CelerError com o motivo do ResProto na recusa."""
        nome_b = nome.encode()
        if not 1 <= len(nome_b) <= 255:
            raise CelerError("nome do recurso: 1 a 255 bytes")
        if isinstance(opts, dict):
            params = json.dumps(opts).encode()
        else:
            params = (opts or "").encode()
        if len(params) > 48:
            raise CelerError("opts acima de 48 bytes")
        # corpo do OPEN sem o [op]: [req][nlen][nome][plen][params][link 8]
        # (link sintetico: o gateway sobrescreve com o dele)
        corpo = bytes((1, len(nome_b))) + nome_b + bytes((len(params),)) + params + \
                bytes((0x03, 0)) + bytes((0x02, ord("U"), ord("S"), ord("B"), 0, 0))
        r = self.res_ctl(SUB["OPEN"], corpo)
        if r[0] == 5:  # REFUSE [req][motivo]
            raise CelerError("recusado: " + RES_REASONS.get(r[2], str(r[2])))
        if r[0] != 4:  # ACCEPT [req][sid u16][lease u16][transp][chan][mac 6][token u32]
            raise CelerError("resposta de OPEN desconhecida (op %d)" % r[0])
        return {"sid": (r[2] << 8) | r[3], "lease_ds": (r[4] << 8) | r[5],
                "transp": r[6], "chan": r[7]}

    def res_write(self, sid, data, seq=1):
        """SUB_WRITE: DATA host->gateway (ops do gpio, leitura por pedido)."""
        corpo = bytes(((sid >> 8) & 0xFF, sid & 0xFF, (seq >> 8) & 0xFF, seq & 0xFF)) + data
        self.res_ctl(SUB["WRITE"], corpo)

    def res_close(self, sid):
        self.res_ctl(SUB["CLOSE"], bytes(((sid >> 8) & 0xFF, sid & 0xFF)))

    def res_data_wait(self, sid, timeout=3.0):
        """Espera um KL_RES_DATA do sid (resposta de READ, amostra de
        sensor, publish); drena logs que aparecerem no caminho."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.keep_session()
            for c, p in list(self.push_queue):
                if c != KL["RES_DATA"]:
                    continue
                rsid = (p[0] << 8) | p[1]
                if rsid == 0:
                    continue  # evento do no virtual: fica para res_event_wait
                self.push_queue.remove((c, p))
                if rsid == sid:
                    return p[4:]
                # sessao velha: descartada
            try:
                c, p = self._read_frame(timeout=0.4)
                self.push_queue.append((c, p))
            except CelerError as e:
                if "timeout" not in str(e):
                    raise
        return None

    # ------------------------------------------- no virtual (API 41)
    # Eventos chegam como KL_RES_DATA com sid 0 (UsbRes.h EV_*).

    # A UART/USJ encerra a sessao HostLink com 8 s sem frames do host (e com
    # ela o no virtual e os leases do PC): quem so ESPERA (listen, --segura)
    # manda um pedido barato a cada KEEPALIVE_S.
    KEEPALIVE_S = 3.0

    def keep_session(self):
        """keepalive() (o HELLO de sempre) no maximo a cada KEEPALIVE_S, sem
        descartar DATA/eventos que ja chegaram."""
        if time.time() - getattr(self, "_last_ka", 0) < self.KEEPALIVE_S:
            return
        self._last_ka = time.time()
        keep = self.keep_push
        self.keep_push = True
        try:
            self.keepalive()
        finally:
            self.keep_push = keep

    def hold(self, seconds):
        """Dorme mantendo a sessao viva (o gateway segue renovando os leases)."""
        fim = time.time() + seconds
        while time.time() < fim:
            self.keep_session()
            time.sleep(min(0.25, max(0.0, fim - time.time())))

    def res_event_wait(self, match=None, timeout=3.0):
        """Proximo evento do no virtual que casa com match(ev) (None = qualquer)."""
        deadline = time.time() + timeout
        while True:
            self.keep_session()
            for c, p in list(self.push_queue):
                if c != KL["RES_DATA"] or (p[0] << 8) | p[1] != 0:
                    continue
                ev = parse_res_event(p[4:])
                self.push_queue.remove((c, p))
                if ev is not None and (match is None or match(ev)):
                    return ev
            if time.time() >= deadline:
                return None
            try:
                c, p = self._read_frame(timeout=min(0.4, max(0.05, deadline - time.time())))
                self.push_queue.append((c, p))
            except CelerError as e:
                if "timeout" not in str(e):
                    raise

    def mesh_send(self, to, data):
        """SUB_SEND: envelope custom do PC (no virtual) para o membro `to` (u16)."""
        if not 1 <= len(data) <= 430:
            raise CelerError("mensagem: 1 a 430 bytes")
        try:
            self.res_ctl(SUB["SEND"], bytes(((to >> 8) & 0xFF, to & 0xFF)) + data)
        except CelerError as e:
            raise CelerError("%s: o PC so e membro com a malha ligada e res_share_usb=1 "
                             "(celerctl shell cfg res_share_usb 1)" % e)

    def res_open_at(self, node, nome, opts=None, timeout=15.0):
        """SUB_OPEN_AT: recurso de OUTRO no por procuracao do gateway; espera o
        EV_STATE aberto (o OPEN da malha tem retry de 2,5 s x 5). Devolve o handle."""
        nome_b = nome.encode()
        params = json.dumps(opts).encode() if isinstance(opts, dict) else (opts or "").encode()
        if not 1 <= len(nome_b) <= 15 or len(params) > 48:
            raise CelerError("nome 1..15 bytes e opts ate 48 bytes")
        corpo = bytes(((node >> 8) & 0xFF, node & 0xFF, len(nome_b))) + nome_b + \
            bytes((len(params),)) + params
        h = self.res_ctl(SUB["OPEN_AT"], corpo)[0]
        ev = self.res_event_wait(lambda e: e["ev"] == "state" and e["h"] == h and
                                 e["state"] not in ("free", "opening"), timeout)
        if ev is None:
            self.res_hclose(h)
            raise CelerError("sem resposta do dono em %.0fs" % timeout)
        if ev["state"] != "open":
            raise CelerError("recusado: %s (%s)" % (ev["reason"] or ev["state"], ev["state"]))
        return h

    def res_media(self, subop, node, arg=None, timeout=30.0):
        """SUB_SNAP_AT/REC_AT/PLAY_AT: abre por procuracao e espera o fim
        (EV_STATE done). Levanta CelerError com o motivo se nao terminou."""
        corpo = bytes(((node >> 8) & 0xFF, node & 0xFF)) + (bytes((arg,)) if arg is not None else b"")
        h = self.res_ctl(subop, corpo)[0]
        ev = self.res_event_wait(lambda e: e["ev"] == "state" and e["h"] == h and
                                 e["state"] not in ("free", "opening", "open"), timeout)
        if ev is None:
            self.res_hclose(h)
            raise CelerError("sem fim em %.0fs" % timeout)
        if ev["state"] != "done":
            raise CelerError("recusado: %s (%s)" % (ev["reason"] or ev["state"], ev["state"]))

    def res_hwrite(self, h, data):
        self.res_ctl(SUB["HWRITE"], bytes((h,)) + data)

    def res_hclose(self, h):
        try:
            self.res_ctl(SUB["HCLOSE"], bytes((h,)))
        except CelerError:
            pass  # ja liberado (terminal avisado)

    def res_hdata_wait(self, h, timeout=3.0):
        ev = self.res_event_wait(lambda e: e["ev"] == "data" and e["h"] == h, timeout)
        return ev["data"] if ev else None

    # ---------------------------------------------------------------- comandos

    def hello(self, force_v1=False):
        magic = b"CELERCTL1" if (force_v1 or FORCE_PROTO1) else b"CELERCTL2"
        cmd, payload = self.xfer(KL["HELLO"], magic, timeout=1.0, retries=0)
        if cmd != KL["HELLO"]:
            raise CelerError("resposta inesperada ao HELLO")
        ident = payload[1:].decode("utf-8", "replace")
        self.proto = 1
        self.max_chunk = CHUNK
        self.win = 1
        for field in ident.split("|"):
            key, _, value = field.partition(" ")
            if key == "proto" and value == "2":
                self.proto = 2
            elif key == "chunk":
                self.max_chunk = max(64, min(int(value), 0xFFFF))
            elif key == "win":
                self.win = max(1, min(int(value), 64))
        # --win: teto manual — para OTA de um firmware cuja janela anunciada
        # transborda o buffer RX do proprio device (perda silenciosa no CDC:
        # a ferramenta mandava rajada de 8x8190 num stream buffer de 16 KB e
        # o parser via "payload grande demais"). Nao aumenta a janela, so corta.
        if WIN_CAP > 0:
            self.win = min(self.win, WIN_CAP)
        return ident

    def keepalive(self):
        """HELLO no formato da sessao vigente (dev loop)."""
        self.xfer(KL["HELLO"], b"CELERCTL1" if self.proto == 1 else b"CELERCTL2",
                  timeout=1.0, retries=0)

    def info(self):
        _, payload = self.xfer(KL["INFO"])
        return json.loads(payload[1:].decode())

    def stats(self):
        """Foto de profiling (KL_STATS): heap interna/PSRAM, tasks com
        watermark de stack e runtime acumulado, carga do loop/present e
        consumo do app JS. Contadores cumulativos: taxas (CPU%, fps) sao
        deltas entre duas fotos, calculados aqui no host."""
        _, payload = self.xfer(KL["STATS"])
        return json.loads(payload[1:].decode())

    def ls(self, path):
        entries = []
        cursor = 0
        while True:
            req = path.encode() + b"\0"
            if self.proto == 2:
                req += struct.pack("<I", cursor)  # paginacao: dirs grandes de graça
            _, payload = self.xfer(KL["LS"], req)
            body = payload[1:]
            if self.proto == 2:
                (cursor,) = struct.unpack("<I", body[:4])
                body = body[4:]
            (count,) = struct.unpack("<H", body[:2])
            off = 2
            for _ in range(count):
                is_dir = body[off]
                size, mtime = struct.unpack("<II", body[off + 1:off + 9])
                name_len = body[off + 9]
                name = body[off + 10:off + 10 + name_len].decode("utf-8", "replace")
                entries.append({"dir": bool(is_dir), "size": size, "mtime": mtime, "name": name})
                off += 10 + name_len
            if self.proto == 1 or cursor == 0:
                return entries  # 0 = fim (ou v1: tudo num frame)

    def delete(self, path, recursive=False):
        payload = path.encode() + b"\0"
        if recursive and self.proto == 2:
            payload += b"\x01"  # device apaga a arvore em um comando
        self.xfer(KL["DELETE"], payload)

    def stat(self, path):
        _, payload = self.xfer(KL["STAT"], path.encode() + b"\0")
        body = payload[1:]
        if body[0] == 0:
            return None
        size, mtime = struct.unpack("<II", body[2:10])
        return {"dir": bool(body[1]), "size": size, "mtime": mtime}

    def read_chunk(self, path, offset, want):
        req = path.encode() + b"\0" + struct.pack("<II", offset, want)
        _, payload = self.xfer(KL["READ"], req, timeout=10.0)
        body = payload[1:]
        if self.proto == 2:
            # resposta prefixada com o offset (casa mesmo fora de ordem)
            (got_off,) = struct.unpack("<I", body[:4])
            if got_off != offset:
                raise CelerError(f"READ voltou offset {got_off}, pedi {offset}")
            body = body[4:]
        return body

    def exec(self, line):
        _, payload = self.xfer(KL["EXEC"], line.encode(), timeout=self.exec_timeout)
        body = payload[1:]
        exit_code = body[0]
        (out_len,) = struct.unpack("<I", body[1:5])
        out = body[5:]
        # saida grande chega em frames de continuacao (logs do logcat que
        # intercalam sao guardados, nao abortam — mesmo tratamento do
        # screenshot/coredump)
        while len(out) < out_len:
            cmd, more = self._read_frame(timeout=self.exec_timeout)
            if cmd in PUSH_CMDS:
                self.push_queue.append((cmd, more))
                continue
            if cmd != KL["EXEC_CONT"]:
                raise CelerError("frame inesperado durante EXEC")
            out += more[1:]
        return exit_code, out.decode("utf-8", "replace")

    # ------------------------------------------------------------ janela de chunk

    def _pump_chunks(self, f, total, chunk_cmd, timeout, label):
        """Envia o conteudo de `f` em chunks com janela deslizante (proto 2).

        ACK do device: [u16 proximo seq esperado][u32 total aplicado] — o
        total e a verdade: chunks confirmados saem da janela, os que faltam
        sao reenviados. Em proto 1 cai para stop-and-wait (janela 1, payload
        sem seq), byte a byte como antes. Retorna (total_aplicado, crc32).
        """
        chunk = self.max_chunk - (2 if self.proto == 2 else 0)  # seq u16 desconta
        win = self.win if self.proto == 2 else 1
        crc = 0
        pendings = {}   # seq -> (start, tamanho)
        next_seq = 0
        applied = 0
        last_ack = time.monotonic()
        tries = 0
        noise = 0

        def frame_for(seq, start):
            f.seek(start)
            data = f.read(min(chunk, total - start))
            payload = (struct.pack("<H", seq) + data) if self.proto == 2 else data
            return self._frame(chunk_cmd, payload)

        while applied < total or pendings:
            # enche a janela (crc calculado uma vez por faixa unica do arquivo)
            while len(pendings) < win and next_seq * chunk < total:
                start = next_seq * chunk
                f.seek(start)
                crc = zlib.crc32(f.read(min(chunk, total - start)), crc) & 0xFFFFFFFF
                self.ser.write(frame_for(next_seq, start))
                pendings[next_seq] = (start, min(chunk, total - start))
                next_seq += 1
            if not pendings:
                break

            # espera ACK (logs que intercalam vao para a fila)
            try:
                cmd_r, payload_r = self._read_frame(timeout=timeout)
            except CelerError:
                cmd_r = None
            if cmd_r == chunk_cmd and payload_r and payload_r[0] == 1 and \
                    b"payload grande demais" not in payload_r:
                raise CelerError(payload_r[1:].decode("utf-8", "replace") or "erro no chunk")
            if cmd_r == chunk_cmd and payload_r and payload_r[0] == 1:
                cmd_r = 0xFF  # rejeicao do parser com o cmd de lixo = o nosso: ruido
            if cmd_r == chunk_cmd and payload_r and payload_r[0] == 0 and \
                    self.proto == 2 and len(payload_r) >= 7:
                ack_seq, ack_total = struct.unpack("<HI", payload_r[1:7])
                if ack_total > applied:
                    applied = ack_total
                    tries = 0
                    # ruido perdoado quando o canal segue entregando: o
                    # contador acumulava desyncs antigos e abortava pushes
                    # longos no 50o mesmo com progresso saudavel
                    noise = 0
                for seq in [s for s, (st, n) in pendings.items() if st + n <= applied]:
                    del pendings[seq]
                last_ack = time.monotonic()
            elif cmd_r == chunk_cmd and payload_r and payload_r[0] == 0:
                # proto 1: ACK vazio confirma o chunk mais antigo em voo
                seq = min(pendings)
                start, n = pendings.pop(seq)
                applied = start + n
                last_ack = time.monotonic()
            elif cmd_r in PUSH_CMDS:
                self.push_queue.append((cmd_r, payload_r))
                last_ack = time.monotonic()
            elif cmd_r is not None:
                # Frame de outro comando no meio da rajada = o parser do device
                # ressincronizou em lixo (bytes perdidos na UART: ele "le" um
                # tamanho absurdo e responde 'payload grande demais' com um cmd
                # inventado — bancada 2026-10-08, cmd=0xa6 a 37%). Os chunks
                # daquele trecho nao valeram: reenvia a janela ja, sem abortar.
                noise += 1
                if noise > 50:
                    raise CelerError(f"frame inesperado durante {label} (canal ruidoso demais): "
                                     f"cmd=0x{cmd_r:02x} payload={payload_r[:24].hex() if payload_r else '-'}")
                time.sleep(0.05)
                self.ser.reset_input_buffer()
                for seq, (start, n) in list(pendings.items()):
                    self.ser.write(frame_for(seq, start))
                last_ack = time.monotonic()
            elif time.monotonic() - last_ack > min(1.5 * (tries + 1), 6.0):
                # sem ACK: reenvia a janela nao confirmada, com espera crescente
                # (o device pode estar apagando setores da flash: 64 KB levam
                # centenas de ms) — 8 rodadas antes de desistir
                tries += 1
                if tries > 8:
                    raise CelerError(f"sem ACK do device em {label} (reenvios esgotados)")
                for seq, (start, n) in list(pendings.items()):
                    self.ser.write(frame_for(seq, start))
                last_ack = time.monotonic()
            if label:  # write_file(progress=False) passa label None
                show_progress(label, applied, total)
        return applied, crc

    def write_file(self, local_path, remote_path, progress=True):
        total = os.path.getsize(local_path)
        self.xfer(KL["WRITE_BEGIN"], remote_path.encode() + b"\0")
        with open(local_path, "rb") as f:
            try:
                applied, crc = self._pump_chunks(f, total, KL["WRITE_CHUNK"], 15.0,
                                                 f"push {os.path.basename(remote_path)}" if progress else None)
                end_payload = struct.pack("<II", crc, total) if self.proto == 2 else b""
                _, payload = self.xfer(KL["WRITE_END"], end_payload, timeout=10.0)
            except (CelerError, serial.SerialException):
                # aborta a escrita: o device remove o arquivo parcial
                try:
                    self.xfer(KL["WRITE_ABORT"], b"", timeout=2.0, retries=0)
                except (CelerError, serial.SerialException):
                    pass
                raise
        if progress:
            print()
        body = payload[1:]
        if self.proto == 2:
            if len(body) >= 8:
                written, dev_crc = struct.unpack("<II", body[:8])
                if written != total or dev_crc != crc:
                    raise CelerError(f"crc/tamanho divergem: enviado {total}/{crc:08x}, "
                                     f"gravado {written}/{dev_crc:08x}")
        else:
            (written,) = struct.unpack("<I", body[:4])
            if written != total:
                raise CelerError(f"escrito {written} de {total} bytes")

    def read_file(self, remote_path, local_path, progress=True):
        st = self.stat(remote_path)
        if st is None or st["dir"]:
            raise CelerError(f"{remote_path} nao existe ou e diretorio")
        total = st["size"]
        # proto 2: resposta = status + offset u32 + dados -> sobra 5 bytes
        want = min(self.max_chunk - 1 - (4 if self.proto == 2 else 0), 0xFFFF)
        win = self.win if self.proto == 2 else 1
        label = f"pull {os.path.basename(remote_path)}"
        # offsets alvo conhecidos de antemao: a janela pede varios e casa
        # cada resposta pelo offset — fora de ordem nao confunde
        targets = [(off, min(want, total - off)) for off in range(0, total, want)] or [(0, 0)]
        done = set()
        pend = {}   # offset -> n pedido
        inflight = []  # v1: [off, n, enviados, recebidos] — respostas sem offset
        idx = 0
        last_frame = time.monotonic()
        tries = 0
        with open(local_path, "wb") as f:
            while len(done) < len(targets) or pend:
                while len(pend) < win and idx < len(targets):
                    off, n = targets[idx]
                    if off not in done:
                        req = remote_path.encode() + b"\0" + struct.pack("<II", off, n)
                        self.ser.write(self._frame(KL["READ"], req))
                        pend[off] = n
                        if self.proto == 1:
                            inflight.append([off, n, 1, 0])
                    idx += 1
                if not pend:
                    break
                try:
                    cmd, payload = self._read_frame(timeout=10.0)
                except CelerError:
                    cmd = None
                if cmd == KL["READ"] and payload and payload[0] == 0:
                    body = payload[1:]
                    if self.proto == 2:
                        (off,) = struct.unpack("<I", body[:4])
                        body = body[4:]
                        if off not in pend:
                            if off in done:
                                continue  # resposta duplicada (reenvio apos timeout): descarta
                            raise CelerError(f"READ voltou offset {off} fora da janela")
                    else:
                        # v1 sem offset na resposta: as respostas chegam na
                        # ORDEM dos pedidos (dispatch serializado no device),
                        # entao a resposta vale sempre para o pedido mais
                        # antigo em voo. A copia atrasada de um pedido reenviado
                        # reescreve o MESMO trecho (inofensivo) — atribui-la ao
                        # proximo offset gravaria dado errado.
                        if not inflight:
                            continue  # duplicata de um chunk ja concluido
                        ent = inflight[0]
                        off = ent[0]
                        ent[3] += 1
                    pend.pop(off, None)
                    f.seek(off)
                    f.write(body)
                    done.add(off)
                    tries = 0
                    last_frame = time.monotonic()
                    if self.proto == 1 and inflight and inflight[0][3] >= inflight[0][2]:
                        inflight.pop(0)
                elif cmd in PUSH_CMDS:
                    self.push_queue.append((cmd, payload))
                    last_frame = time.monotonic()
                elif cmd is not None:
                    raise CelerError("frame inesperado durante pull")
                elif time.monotonic() - last_frame > 2.0:
                    # timeout: repede tudo que falta (max 3 rodadas)
                    tries += 1
                    if tries > 3:
                        raise CelerError("pull travado (repedidos esgotados)")
                    if self.proto == 1:
                        # repete o MESMO pedido em voo (a copia atrasada do
                        # device continua valida); nova copia de resposta
                        # reescreve o mesmo trecho
                        for ent in inflight:
                            req = remote_path.encode() + b"\0" + struct.pack("<II", ent[0], ent[1])
                            self.ser.write(self._frame(KL["READ"], req))
                            ent[2] += 1
                    else:
                        pend = {}
                        idx = 0
                    last_frame = time.monotonic()
                if progress:
                    show_progress(label, sum(n for o, n in targets if o in done), total)
        if progress:
            print()
        got = sum(n for o, n in targets if o in done)
        if got != total:
            raise CelerError(f"pull incompleto: {got} de {total} bytes")

    def verify_file(self, local_path, remote_path):
        """Rele o arquivo no device e confere tamanho + CRC32 contra o local.

        O CRC do WRITE_END (proto 2) prova o que o stdio do device escreveu,
        nao o que o filesystem passa a SERVIR depois: na bancada (2026-10-09)
        um push reportou ok, o `ls` mostrava tamanho/mtime novos e o `cat`/run
        devolviam o conteudo antigo (inode velho no LittleFS). So a releitura
        pega esse fantasma — e funciona com firmware antigo (leitura pura).
        """
        with open(local_path, "rb") as f:
            local_data = f.read()
        st = self.stat(remote_path)
        if st is None or st["dir"]:
            raise CelerError(f"verificacao: {remote_path} sumiu apos a escrita")
        if st["size"] != len(local_data):
            raise CelerError(
                f"verificacao FALHOU: {remote_path} tem {st['size']} B no device, "
                f"enviei {len(local_data)} B — tente `rm` + push de novo; se persistir, reboot")
        crc = 0
        want = self.max_chunk - 1 - (4 if self.proto == 2 else 0)
        for off in range(0, len(local_data), want):
            data = self.read_chunk(remote_path, off, min(want, len(local_data) - off))
            if len(data) != min(want, len(local_data) - off):
                raise CelerError(f"verificacao: leitura curta em {remote_path}+{off}")
            crc = zlib.crc32(data, crc)
        if crc != zlib.crc32(local_data):
            raise CelerError(
                f"verificacao FALHOU: conteudo de {remote_path} no device difere do enviado "
                f"(push fantasma) — `shell rm {remote_path}` + push de novo; se persistir, reboot")
        return len(local_data), crc

    def simple(self, op, payload=b""):
        self.xfer(KL[op], payload)

    def reboot(self):
        self.xfer(KL["REBOOT"])

    def set_baud(self, baud):
        """Negocia a troca de baud e reabre a porta no novo valor.

        Canais sem baud (CDC nativa do S3, bridge TCP) respondem erro ou
        nem sequer chegam aqui: vira aviso, a sessao segue como esta.
        """
        if self.ser.baudrate is None:  # bridge TCP: nao existe baud
            return
        try:
            self.xfer(KL["SET_BAUD"], struct.pack("<I", baud), retries=0)
        except CelerError as e:
            if "nao suportada" in str(e):
                print("aviso: canal sem baud (USB nativo); seguindo na velocidade do USB",
                      file=sys.stderr)
                return
            raise
        port, timeout = self.ser.port, self.ser.timeout
        self.ser.close()
        time.sleep(0.15)  # firmware troca o baud apos o ACK
        self.ser = open_serial(port, baud, timeout)
        self.hello()  # re-sincroniza a sessao no novo baud

    # ------------------------------------------------------------- logcat/ota

    def logcat_on(self):
        self.xfer(KL["LOG_ON"])

    def logcat_off(self):
        self.xfer(KL["LOG_OFF"])

    def read_push_frame(self, timeout=60.0):
        """Le um frame nao-solicitado (log/screenshot), consumindo a fila."""
        if self.push_queue:
            return self.push_queue.pop(0)
        return self._read_frame(timeout=timeout)

    def ota_write(self, local_path, progress=True):
        # 12 s: o primeiro esp_ota_begin apos o boot (particao fria, erase
        # inicial) passa com folga dos 3 s do timeout comum (bancada
        # 2026-10-05: primeira OTA WiFi por placa falhava nele) — e o begin
        # agora pode segurar ate ~2 s extras encerrando um app aberto antes
        # da gravacao (evictRunningApp, 2026-10-10)
        _, payload = self.xfer(KL["OTA_BEGIN"], timeout=12.0)
        part = payload[1:].decode("utf-8", "replace")
        total = os.path.getsize(local_path)
        try:
            with open(local_path, "rb") as f:
                applied, crc = self._pump_chunks(f, total, KL["OTA_CHUNK"], 30.0,
                                                 f"ota {os.path.basename(local_path)} -> {part}")
                end_payload = struct.pack("<II", crc, total) if self.proto == 2 else b""
                payload = self._ota_end(end_payload)
        except OtaEndUnknown:
            raise  # o END pode ter sido aplicado: NAO aborta (marcaria nada, mas confunde)
        except (CelerError, serial.SerialException):
            # cancela a escrita da particao: um begin futuro tambem aborta,
            # mas o estado nao fica pendurado ate lah
            try:
                self.xfer(KL["OTA_ABORT"], b"", timeout=2.0, retries=0)
            except (CelerError, serial.SerialException):
                pass
            raise
        if progress:
            print()
        (written,) = struct.unpack("<I", payload[1:5])
        return part, written

    def _ota_end(self, end_payload):
        """OTA_END com reenvio. O device valida a imagem (SHA de ~2,5 MB) e
        marca o boot; se a RESPOSTA se perde (USB-JTAG, cabo), o reenvio cai
        no END idempotente do firmware novo, que confirma de novo. Firmware
        antigo responde 'OTA nao iniciada' ao reenvio: ai o resultado e
        desconhecido (o boot provavelmente JA esta marcado) — OtaEndUnknown,
        sem ABORT."""
        for attempt in range(3):
            try:
                _, payload = self.xfer(KL["OTA_END"], end_payload,
                                       timeout=getattr(self, "ota_end_timeout", 30.0))
                return payload
            except CelerError as e:
                msg = str(e)
                if "timeout" in msg:
                    continue
                if attempt > 0 and "nao iniciada" in msg:
                    raise OtaEndUnknown("resposta do OTA_END se perdeu e o firmware nao "
                                        "confirma o reenvio: o boot provavelmente ja esta "
                                        "marcado — reinicie e confira com 'celerctl info'")
                raise
        raise OtaEndUnknown("OTA_END sem resposta apos 3 tentativas: o boot pode ja estar "
                            "marcado — reinicie e confira com 'celerctl info' (app_part)")

    def screenshot(self):
        # pede RLE (firmware antigo ignora o byte e manda cru, sem o 5o byte
        # de formato no cabecalho)
        _, payload = self.xfer(KL["SCREENSHOT"], bytes([1]), timeout=30.0)
        w, h = struct.unpack("<HH", payload[1:5])
        rle = len(payload) >= 6 and payload[5] == 1
        need = w * h * 2
        data = bytearray()
        pending = bytearray()
        while len(data) < need:
            cmd, more = self._read_frame(timeout=30.0)
            if cmd in PUSH_CMDS and cmd != KL["SCR_DATA"]:  # log/evento no meio: guarda e segue
                self.push_queue.append((cmd, more))
                continue
            if cmd != KL["SCR_DATA"]:
                raise CelerError("frame inesperado durante screenshot")
            if not rle:
                data += more[1:]
                continue
            pending += more[1:]
            n = len(pending) // 4 * 4
            for i in range(0, n, 4):
                count, px = struct.unpack_from("<HH", pending, i)
                data += struct.pack("<H", px) * count
            del pending[:n]
        return w, h, bytes(data[:need])


    def coredump(self, keep=False):
        """Baixa o coredump ELF da particao dedicada (b'' se vazio)."""
        _, payload = self.xfer(KL["COREDUMP"], b"\x01" if keep else b"", timeout=30.0)
        if len(payload) < 5:  # [0]=status, [1:5]=u32 tamanho
            raise CelerError("resposta de coredump sem cabecalho")
        (size,) = struct.unpack("<I", payload[1:5])
        if size == 0:
            return b""
        data = bytearray(payload[5:])
        while len(data) < size:
            cmd, more = self._read_frame(timeout=30.0)
            if cmd in PUSH_CMDS:  # log/evento no meio: guarda e segue
                self.push_queue.append((cmd, more))
                continue
            if cmd != KL["COREDUMP_DATA"]:
                raise CelerError("frame inesperado durante coredump")
            data += more[1:]
        return bytes(data[:size])

    def touch(self, samples):
        """Enfileira amostras de touch sinteticas: (down, x, y, delay_ms) ou
        (down, x, y, delay_ms, finger). O payload de 8 bytes (com dedo) so
        sai quando ha finger != 0 — firmware velho entende o de 7."""
        if not 1 <= len(samples) <= 16:
            raise CelerError("gesto deve ter 1..16 amostras")
        multi = any(len(s) > 4 and s[4] for s in samples)
        payload = bytes([len(samples)])
        for s in samples:
            down, x, y, delay = s[0], s[1], s[2], s[3]
            payload += bytes([1 if down else 0]) + struct.pack("<HHH", x, y, delay)
            if multi:
                payload += bytes([s[4] if len(s) > 4 else 0])
        self.xfer(KL["TOUCH"], payload)


# ------------------------------------------------------------------ utilidades

# --linhas-baixas: abre com DTR/RTS em 0. Placas cujo adaptador segura o EN/IO0
# com as linhas no estado padrao do pyserial (ambas ativas) — a esp32-cam no
# CH340 clone da bancada so fala HostLink assim. A 1a abertura reseta a placa
# (o open_link espera o boot).
LOW_LINES = False


def open_serial(port, baud, timeout):
    """Abre a porta em modo EXCLUSIVO (flock): dois celerctl na mesma porta
    (um terminal com logcat + uma OTA, um monitor em loop) intercalavam bytes
    e a OTA morria em 'device reports readiness to read but returned no data'
    no meio da gravacao. Agora o segundo falha logo, com mensagem clara."""
    try:
        if LOW_LINES:
            s = serial.Serial(timeout=timeout, write_timeout=timeout, exclusive=True)
            s.port, s.baudrate = port, baud
            s.dtr = False
            s.rts = False
            for tentativa in range(5):  # CH340 clone: Errno 71 aleatorio no ioctl
                try:
                    s.open()
                    return s
                except OSError:
                    if tentativa == 4:
                        raise
                    time.sleep(1)
        return serial.Serial(port, baud, timeout=timeout, write_timeout=timeout, exclusive=True)
    except serial.SerialException as e:
        if "lock" in str(e).lower() or "busy" in str(e).lower() or "Resource temporarily" in str(e):
            raise CelerError(f"{port} em uso por outro processo (outro celerctl/monitor?) — "
                             "feche-o antes; uma OTA com dois donos na porta corrompe o stream")
        raise


def show_progress(label, current, total):
    width = 24
    if total > 0:
        frac = min(current / total, 1.0)
        bar = "#" * int(width * frac)
        sys.stdout.write(f"\r{label}: [{bar:{width}}] {current}/{total} bytes ")
    else:
        sys.stdout.write(f"\r{label}: {current} bytes ")
    sys.stdout.flush()


def human_size(n):
    for unit in ("B", "K", "M", "G"):
        if n < 1024 or unit == "G":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024


def probe(port, fast=False):
    """Abre a porta e verifica se e o canal HostLink (CDC1/UART).

    Tenta tambem 921600: uma sessao anterior morta ha menos de 8s deixa a
    UART do device em baud alto (o restore so acontece no idle timeout).
    """
    t = 0.6 if fast else 1.5
    if isinstance(port, str) and is_net_addr(port):
        try:
            link = HostLink(port, timeout=t, prompt=False)
            try:
                return link.hello()
            finally:
                link.close()
        except (CelerError, OSError):
            return None
    for baud in (DEFAULT_BAUD, 921600):
        try:
            link = HostLink(port.device, timeout=t, baud=baud)
            try:
                return link.hello()
            finally:
                link.close()
        except (CelerError, serial.SerialException, OSError):
            continue
    return None


def probe_bounded(port, fast=False):
    """probe() com coleira: o open() da UART pode ficar PRESO no kernel
    quando a placa e (re)plugada no meio da sonda (bancada 2026-10-11: um
    "devices -l" ficou minutos assim com o CH340 re-enumerando). A sonda
    morre no watchdog e a porta entra como ausente — o comando sempre volta.
    """
    box = {}

    def run():
        try:
            box["ident"] = probe(port, fast)
        except BaseException as e:  # erro da thread nao vaza: quem chama ve None
            box["err"] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join((0.6 if fast else 1.5) * 2 + 1.0)
    if t.is_alive():
        print(f"aviso: sonda de {getattr(port, 'device', port)} nao voltou "
              "(porta presa no open? replug)", file=sys.stderr)
        return None
    if "err" in box:
        raise box["err"]
    return box.get("ident")


def find_devices(verbose=False):
    """Varre portas USB candidatas e identifica o canal celerctl por HELLO."""
    found = []
    for port in list_ports.comports():
        if port.vid not in USB_VIDS:
            continue
        ident = probe_bounded(port)
        if ident:
            found.append((port, ident))
            if verbose:
                desc = port.description or "-"
                serial = port.serial_number or "-"
                print(f"{port.device:<14} {serial:<14} {desc}")
                print(f'{"":14} {ident}')
    return found


def find_net_devices(timeout=1.5):
    """Descobre CelerOS na LAN: sonda UDP broadcast do Celer Debug Bridge.

    O device responde unicast "CELEROS <ver>|<board>|api N|proto 2|tcp P"
    (o IP dele e o endereco de origem da resposta). Nao precisa de token —
    a mesma informacao do HELLO, sem autenticacao.
    """
    found = {}
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                sock.sendto(b"CELERPROBE1\n", ("255.255.255.255", BRIDGE_PORT))
            except OSError:
                pass  # interface sem broadcast (loopback only?): segue p/ recv
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock.settimeout(min(0.4, remaining))
            try:
                data, addr = sock.recvfrom(256)
            except socket.timeout:
                continue
            except OSError:
                break
            text = data.decode("utf-8", "replace").strip()
            if text.startswith("CELEROS"):
                found.setdefault(addr[0], text)
    finally:
        sock.close()
    return sorted(found.items())


# Recusas que explicam a falha melhor que "nao responde": o device disse por
# que (OTA viva em outro canal) ou a porta tem outro dono no PC
_REASONS = ("OTA em curso", "em uso por outro processo", "sessao ativa em outro canal")


def open_link(args):
    reason = []

    def try_open(port):
        """Abre e faz hello; cai para o baud alto se a sessao anterior
        (<8s) ainda estiver viva no device (TCP nao tem baud: 1 tentativa)."""
        try:
            link = HostLink(port, timeout=3.0, token=getattr(args, "token", None))
        except CelerError as e:
            reason.append(str(e))
            return None
        try:
            if LOW_LINES and not is_net_addr(port):
                # a abertura com as linhas baixas pode ter resetado a placa:
                # HELLO ate o boot terminar (~8 s na esp32-cam)
                fim = time.time() + 12
                while True:
                    try:
                        link.hello()
                        break
                    except (CelerError, serial.SerialException, OSError):
                        if time.time() > fim:
                            raise
                        time.sleep(1)
            else:
                link.hello()
            return link
        except (CelerError, serial.SerialException, OSError) as e:
            if any(r in str(e) for r in _REASONS):
                reason.append(str(e))
                link.close()
                return None
            link.close()
        if is_net_addr(port):
            return None
        fallback = getattr(args, "baud", None) or 921600
        link = HostLink(port, timeout=3.0, baud=fallback)
        try:
            link.hello()
            return link
        except (CelerError, serial.SerialException):
            link.close()
            return None

    if args.port:
        port = resolve_port(args.port)
        link = try_open(port)
        if link is None:
            die(reason[0] if reason else f"{args.port} nao responde ao protocolo HostLink")
    else:
        devices = find_devices()
        if devices:
            if len(devices) > 1:
                # 2+ placas e nenhum -p: pegar a primeira calado e o erro
                # classico de bancada (a outra placa "nao pegou a mudanca")
                portas = ", ".join(d[0].device for d in devices)
                die(f"{len(devices)} placas USB conectadas ({portas}); escolha "
                    "com -p PORTA (celerctl devices -l identifica cada uma)")
            link = try_open(devices[0][0].device)
        else:
            # sem USB: 1 device na LAN serve (varios: use -p IP)
            net = find_net_devices()
            if not net:
                die("nenhum CelerOS encontrado (USB ou WiFi; usar -p PORTA/IP)")
            link = try_open(f"{net[0][0]}:{BRIDGE_PORT}")
        if link is None:
            # o motivo da recusa ("OTA em curso", "em uso por outro processo",
            # "sessao ativa em outro canal") e a mensagem acionavel: sem ela
            # o usuario procurava um problema de protocolo que nao existia
            die(reason[0] if reason else
                f"{devices[0][0].device if devices else 'device'} nao responde "
                "ao protocolo HostLink")
    if getattr(args, "baud", None) and args.baud != DEFAULT_BAUD and link.ser.baudrate == DEFAULT_BAUD:
        link.set_baud(args.baud)
    if getattr(args, "exec_timeout", None):
        link.exec_timeout = args.exec_timeout
    return link


def die(msg, code=1):
    print(f"erro: {msg}", file=sys.stderr)
    sys.exit(code)


# ------------------------------------------------------------------- comandos

def resolve_port(selector):
    """-p aceita caminho de porta, prefixo do serial number USB (a MAC
    "K..." que o firmware S3 define) ou endereco do bridge WiFi (IP /
    host:porta) — varias placas na mesma maquina."""
    if is_net_addr(selector):
        return selector  # Celer Debug Bridge (TCP): o resto nao se aplica
    if selector.startswith("/") or ":" in selector:
        return selector  # caminho (ou COM3: estilo windows)
    for port in list_ports.comports():
        sn = port.serial_number or ""
        if sn.upper().startswith(selector.upper()):
            return port.device
    die(f"nenhuma placa com serial comecando por {selector!r} "
        f"(celerctl devices lista os seriais)")


def _cached_token_state(addr, devid=None):
    """Valida o token guardado contra o bridge: 'ok', 'velho' (auth recusada;
    o NetTransport ja limpou o cache), 'timeout'/'erro' — ou None sem cache.
    Um token velho apos reflash e o caso que mais confunde: o `devices` avisa
    na propria linha em vez de deixar o proximo comando morrer no AUTH."""
    cache = load_token_cache()
    if addr not in cache and not (devid and "id:" + devid in cache):
        return None
    try:
        link = HostLink(addr, timeout=1.5, prompt=False)
        link.close()
        return "ok"
    except CelerError as e:
        msg = str(e).lower()
        if "auth" in msg:
            return "velho"
        if "timeout" in msg:
            return "timeout"
        return "erro"
    except (OSError, serial.SerialException):
        return "erro"


def cmd_devices(args):
    # verbose so no -l: no modo curto o bloco de detalhe + a linha curta
    # imprimiam a MESMA placa USB duas vezes
    found = find_devices(verbose=bool(args.long))
    net = find_net_devices()
    cache = load_token_cache()
    for ip, ident in net:
        devid = probe_devid(ident)
        addr = f"{ip}:{BRIDGE_PORT}"
        mark = ""
        has_cache = bool(devid and "id:" + devid in cache) or addr in cache
        if has_cache:
            if devid and cache.get("id:" + devid) and cache.get(addr) != cache["id:" + devid]:
                # DHCP mudou o IP de um device ja pareado: cura o cache ja
                # na listagem (conectar tambem cura, pelo banner)
                save_token(addr, cache["id:" + devid], devid)
            state = _cached_token_state(addr, devid)
            if state == "ok":
                mark = " (pareado)"
            elif state == "velho":
                mark = (" (token VELHO: rode no device: shell bridge; "
                        "depois celerctl pair)")
            elif state == "timeout":
                mark = (" (sem resposta ao token: token velho? shell bridge / "
                        "celerctl pair)")
            else:
                mark = " (pareado?)"
        # o "|id ..." e maquiaria de casamento: fora do display
        ident = _BRIDGE_ID_RE.sub("", ident)
        print(f"{addr:<14} {'wifi':<14} {ident}{mark}")
    if not found and not net:
        # com -l tambem: saida vazia na bancada parecia travamento do comando
        print("nenhum dispositivo encontrado (USB ou WiFi)")
    elif found and not args.long:
        for port, ident in found:
            serial = port.serial_number or "-"
            print(f"{port.device}  {serial:<14} {ident}")


def cmd_pair(args):
    """Pareia com o Celer Debug Bridge: valida o token e guarda no cache
    (pelo endereco E pela identidade do device, quando o banner traz o id).

    Token do cache recusado (reflash, "bridge reset") nao e beco sem saida:
    limpa a entrada velha e pede o token atual uma vez — `pair` e justamente
    o comando de renovacao."""
    sel = args.addr or getattr(args, "port_sel", None)
    if not sel:
        die("uso: celerctl pair [--token X] IP_OU_HOST:PORTA (ou -p)")
    addr = normalize_net_addr(sel)
    fixed = args.token if args.token is not None else os.environ.get("CELEROS_BRIDGE_TOKEN")
    token = fixed or net_token(addr, prompt=True)
    try:
        link = HostLink(addr, timeout=3.0, token=token)
    except CelerError as e:
        if fixed or "auth" not in str(e).lower():
            raise
        forget_token(addr, token)
        print("aviso: token do cache recusado — pedindo o token atual do device "
              "(shell bridge)", file=sys.stderr)
        token = net_token(addr, prompt=True)
        link = HostLink(addr, timeout=3.0, token=token)
    try:
        ident = link.hello()
        info = link.info()
    finally:
        link.close()
    devid = getattr(link.ser, "devid", None)
    save_token(addr, token, devid)
    extra = f", id {devid}" if devid else ""
    print(f"pareado: {addr}  {ident}")
    print(f"board {info.get('board')}, versao {info.get('version')}{extra}; "
          f"token salvo em {token_store_path()}")


def cmd_provision(args):
    """Provisiona a placa pelo canal aberto (USB na 1a vez): credenciais
    WiFi, token do bridge (OTA por WiFi) e permissoes de apps — e ja deixa
    o token no cache pelo IP, para o '-p IP' funcionar na hora.

    O token do bridge e gravado com "bridge set" (o device aceita o valor
    escolhido); sem --token, um novo e gerado aqui. Sem --wifi, so espera a
    rede ja salva conectar (caso da placa que ja tem credenciais).
    """
    link = open_link(args)
    try:
        if args.wifi:
            code, out = link.exec("wifi %s %s" % tuple(args.wifi))
            print((out or "").strip())
            if code != 0:
                die("falha ao salvar as credenciais WiFi")
        token = args.token or "".join(
            secrets.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(8))
        code, out = link.exec(f"bridge set {token}")
        if code != 0:
            die(f"bridge set recusado: {(out or '').strip()}")
        print(f"token do bridge gravado: {token}")
        for app in args.grant or []:
            code, out = link.exec(f"grant {app}")
            print(f"grant {app}: {(out or '').strip()}")
        # WiFi novo conecta em segundo plano: espera o IP aparecer
        ip = None
        for _ in range(15):  # ~45 s
            code, out = link.exec("bridge")
            m = re.search(r"ip\s+:\s+(\d+\.\d+\.\d+\.\d+)", out or "")
            if m:
                ip = m.group(1)
                break
            time.sleep(3)
        if ip is None:
            die("WiFi nao subiu a tempo (conferir credenciais/sinal) — o token "
                "ja esta gravado; repita quando a rede conectar")
        addr = f"{ip}:{BRIDGE_PORT}"
        save_token(addr, token)
        print(f"provisionado: {addr} (token no cache)")
        print(f"ota wifi: python3 tools/celerctl.py -p {addr} ota push build/CelerOS.bin")
    finally:
        link.close()


def cmd_info(args):
    link = open_link(args)
    try:
        info = link.info()
    finally:
        link.close()
    print(json.dumps(info, indent=2, ensure_ascii=False))


# --------------------------------------------------------------- top / stats

def _poll_stats(link):
    try:
        return link.stats()
    except CelerError as e:
        if "opcode" in str(e):
            die("firmware antigo sem KL_STATS: atualize primeiro (celerctl ota push)")
        raise


def _task_rows(a, b):
    """CPU% por task na janela entre duas fotos: runtime e cumulativo no
    device, a taxa e o delta (tasks pareadas pelo nome; task que nasceu na
    janela entra com o runtime todo — base 0)."""
    base = {}
    for t in a["tasks"]:
        base.setdefault(t["n"], t["rt"])  # nomes duplicados: parea 1 a 1
    rows = []
    matched = set()
    for t in b["tasks"]:
        prev = base.get(t["n"], 0)
        if t["n"] in matched:
            prev = t["rt"]  # 2a task com o mesmo nome: sem par, delta 0
        matched.add(t["n"])
        rows.append(dict(t, drt=t["rt"] - prev))
    total = b["total_rt_us"] - a["total_rt_us"]
    for r in rows:
        r["cpu"] = 100.0 * r["drt"] / total if total > 0 else 0.0
    return rows, total


def _summary_lines(b, a=None, window_s=None):
    """Cabecalho do top/stats: heap, PSRAM, app JS e carga. Com `a` (foto
    anterior) calcula taxas da janela; sem ela, o acumulado do boot."""
    lines = []
    secs = b["uptime_us"] / 1e6
    up = f"{int(secs // 3600)}h{int(secs % 3600 // 60)}m{int(secs % 60)}s"
    win = f"  janela {window_s * 1000:.0f} ms" if window_s else ""
    trunc = "  (tasks truncadas)" if b.get("trunc") else ""
    lines.append(f"up {up}  CPU {b['cpu_mhz']} MHz{win}{trunc}")
    h = b["heap"]
    psram = ""
    if h["psram_total"]:
        psram = (f"  PSRAM {human_size(h['psram_free'])}/{human_size(h['psram_total'])}"
                 f" (min {human_size(h['psram_min'])}, maior {human_size(h['psram_largest'])})")
    # heap.low vem do MemWatch (firmware >= Onda 2); firmware antigo nao manda.
    low = "  RAM INTERNA BAIXA" if h.get("low") else ""
    lines.append(f"heap {human_size(h['free'])} (min {human_size(h['min'])}, "
                 f"maior {human_size(h['largest'])})  "
                 f"interna {human_size(h['int_free'])} (min {human_size(h['int_min'])})"
                 f"{psram}{low}")
    js = b["js"]
    if js["active"]:
        uso = max(0, js["launch_free"] - js["now_free"])
        lines.append(f"app JS: heap {human_size(uso)} desde o lancamento  "
                     f"aloc Duktape {js['allocs']} (pico {js['allocs_peak']})")
    if a is not None:
        d_total = b["loop"]["total_us"] - a["loop"]["total_us"]
        d_busy = b["loop"]["busy_us"] - a["loop"]["busy_us"]
        loop = (f"{100.0 * d_busy / d_total:.1f}% busy" if d_total > 0
                else "parado (com app aberto quem bombeia e o present)")
        ui_txt = ""
        d_pres = b["ui"]["presents"] - a["ui"]["presents"]
        if d_pres > 0:
            avg_us = (b["ui"]["us"] - a["ui"]["us"]) / d_pres
            fps = (b["ui"]["frames"] - a["ui"]["frames"]) / window_s if window_s else 0
            ui_txt = (f"  UI {fps:.0f} fps (present medio {avg_us / 1000:.1f} ms, "
                      f"pico {b['ui']['us_max'] / 1000:.1f} ms)")
        lines.append(f"loop OS: {loop}{ui_txt}")
    return lines


def _svc_line(a, b):
    """Linha do svchost a partir do bloco "svc" do KL_STATS (API 42).

    Contadores do pump sao cumulativos desde o boot: a janela e o delta entre
    as duas fotos e `max_ms` e o pior giro do boot. Firmware antigo nao manda
    o bloco (o DEVICESTATS faz rollback se nao couber) — devolve None e o top
    segue sem a linha."""
    sb = (b or {}).get("svc")
    if not sb:
        return None
    sa = (a or {}).get("svc") or {}
    dticks = sb.get("ticks", 0) - sa.get("ticks", 0)
    dovr = sb.get("overruns", 0) - sa.get("overruns", 0)
    dsum = sb.get("sum_ms", 0) - sa.get("sum_ms", 0)
    pior = sb.get("max_ms", 0)
    if dticks <= 0:
        return f"svchost: sem giros na janela (pior do boot {pior}ms, {dovr} overrun)"
    media = dsum / dticks
    return (f"svchost: {dticks} giro(s) na janela (media {media:.1f}ms, "
            f"{dovr} overrun, pior do boot {pior}ms)")


def _render_top(a, b, window_s, sort="cpu", limit=0):
    lines = _summary_lines(b, a, window_s)
    svc = _svc_line(a, b)
    if svc:
        lines.append(svc)
    lines.append("")
    rows, _total = _task_rows(a, b)
    if sort == "stack":
        rows.sort(key=lambda r: r["stk"])
    elif sort == "name":
        rows.sort(key=lambda r: r["n"])
    else:
        rows.sort(key=lambda r: -r["drt"])
    if limit:
        rows = rows[:limit]
    lines.append(f"{'TAREFA':<16} {'EST':>3} {'PRIO':>4} {'STACK':>7} {'CPU%':>6}")
    for r in rows:
        lines.append(f"{r['n']:<16.16} {r['s']:>3} {r['p']:>4} {r['stk']:>7} {r['cpu']:>6.1f}")
    return "\n".join(lines)


def cmd_top(args):
    if "STATS" not in KL:
        die("HostLink.h deste tree nao define KL_STATS")
    link = open_link(args)
    ansi = sys.stdout.isatty() and not args.plain
    try:
        prev = _poll_stats(link)
        while True:
            # one-shot: 2 fotos separadas por --window; watch: cada refresh e
            # a propria janela (--interval). O poll em si mantem a UART viva
            # (idle de 8s) — nada de keepalive manual.
            time.sleep(args.interval if args.watch else args.window)
            snap = _poll_stats(link)
            window = args.interval if args.watch else args.window
            text = _render_top(prev, snap, window, args.sort, args.n)
            if args.watch:
                if ansi:
                    sys.stdout.write("\x1b[H\x1b[2J")
                else:
                    print()
            print(text)
            sys.stdout.flush()
            if not args.watch:
                break
            prev = snap
    except KeyboardInterrupt:
        print()
    finally:
        link.close()


def cmd_stats(args):
    link = open_link(args)
    try:
        snap = _poll_stats(link)
    finally:
        link.close()
    if args.json:
        print(json.dumps(snap, indent=2))
        return
    # foto unica: taxas de CPU vem do acumulado desde o boot
    lines = _summary_lines(snap)
    lines.append("")
    total = snap["total_rt_us"]
    rows = sorted(snap["tasks"], key=lambda t: -t["rt"])
    lines.append(f"{'TAREFA':<16} {'EST':>3} {'PRIO':>4} {'STACK':>7} {'CPU%':>6}  (desde o boot)")
    for t in rows:
        cpu = 100.0 * t["rt"] / total if total > 0 else 0.0
        lines.append(f"{t['n']:<16.16} {t['s']:>3} {t['p']:>4} {t['stk']:>7} {cpu:>6.1f}")
    print("\n".join(lines))


# ------------------------------------------------------ svc / crash (API 42)
# Atalhos para o shell do device. O shell NAO trata aspas: os argumentos vao
# separados por espaco, como digitados (pkg e um token simples).

def _exec_print(link, line):
    """Roda `line` no shell do device e imprime a saida; devolve o exit code."""
    code, out = link.exec(line)
    if out:
        sys.stdout.write(out if out.endswith("\n") else out + "\n")
        sys.stdout.flush()
    return code


def cmd_svc(args):
    """Servicos de app em segundo plano (API 42): `svc list` mostra estado,
    reinicios e ultimo erro por servico; `svc info PKG` o detalhe; stop/start
    param e religam; setup reroda o install.sh. Tudo pelo EXEC do HostLink,
    sem aspas (o parser do device nao as remove)."""
    pkg = getattr(args, "pkg", None)
    if pkg is not None and (not pkg or re.search(r"\s", pkg)):
        die(f"nome de servico invalido: {pkg!r} (o shell do device nao "
            "trata aspas)")
    line = "svc " + args.svc_cmd + (f" {pkg}" if pkg else "")
    link = open_link(args)
    try:
        code = _exec_print(link, line)
    finally:
        link.close()
    if code != 0:
        sys.exit(code)


def cmd_crash(args):
    """Triagem do ultimo erro de app: `crash [n]` no shell devolve o header
    do /local/lastcrash.txt + as ultimas n linhas do apps.log (o `lasterror`
    segue com a stack inteira)."""
    if args.n is not None and not 1 <= args.n <= 200:
        die("crash: n entre 1 e 200")
    line = "crash" + (f" {args.n}" if args.n is not None else "")
    link = open_link(args)
    try:
        code = _exec_print(link, line)
    finally:
        link.close()
    if code != 0:
        sys.exit(code)


# ---------------------------------------------------------------- gateway USB
# Subops em SUB (extraidos do UsbRes.h); opcodes KL_RES_* vem de KL.
RES_TYPES = {0: "data", 1: "mic", 2: "speaker", 3: "camera", 4: "gpio", 5: "sensor"}
RES_REASONS = {1: "notFound", 2: "busy", 3: "denied", 4: "unsupported", 5: "full",
               6: "local", 7: "gone", 8: "expired", 9: "noLink"}


def _decode_meta_tlvs(e, mlen, body, i):
    j = 0
    while j < mlen:
        tag, tl = body[i], body[i + 1]
        v = body[i + 2:i + 2 + tl]
        if tag == 1:
            e["unit"] = v.decode("utf-8", "replace")
        elif tag == 2 and tl == 8:
            e["min"], e["max"] = struct.unpack("<ff", v)
        elif tag == 3:
            e["schema"] = v.decode("utf-8", "replace")
        elif tag == 4 and tl == 1:
            e["ver"] = v[0]
        i += 2 + tl
        j += 2 + tl
    return i


def decode_list_meta(body):
    """LIST_META (ResProto.h): [n][type][flags][nlen][nome][mlen][tlvs]."""
    n = body[0]
    i = 1
    out = []
    for _ in range(n):
        t, fl, nl = body[i], body[i + 1], body[i + 2]
        i += 3
        nome = body[i:i + nl].decode("utf-8", "replace")
        i += nl
        e = {"type": RES_TYPES.get(t, "data"), "flags": fl, "name": nome}
        mlen = body[i]
        i += 1
        i = _decode_meta_tlvs(e, mlen, body, i)
        out.append(e)
    return out


RES_STATES = ("free", "opening", "open", "refused", "revoked", "lost", "closed", "done")


def parse_res_event(b):
    """Evento do no virtual (UsbRes.h): EV_MSG/EV_STATE/EV_DATA -> dict."""
    if not b:
        return None
    if b[0] == 1 and len(b) >= 5:
        nn = b[3]
        return {"ev": "msg", "from": "%04X" % ((b[1] << 8) | b[2]),
                "fromName": b[4:4 + nn].decode("utf-8", "replace"), "raw": bool(b[4 + nn]),
                "data": bytes(b[5 + nn:])}
    if b[0] == 2 and len(b) >= 6:
        return {"ev": "state", "h": b[1],
                "state": RES_STATES[b[2]] if b[2] < len(RES_STATES) else str(b[2]),
                "reason": RES_REASONS.get(b[3], "") if b[3] else "",
                "node": "%04X" % ((b[4] << 8) | b[5])}
    if b[0] == 3 and len(b) >= 2:
        return {"ev": "data", "h": b[1], "data": bytes(b[2:])}
    return None


def wav_to_pcm16k(path):
    """WAV PCM (8/16 bits, mono/estereo, qualquer taxa) -> PCM16 LE mono 16 kHz,
    o formato do stream de audio da matilha. O device nao parseia WAV: um
    parser so (o do PC)."""
    import wave
    import array
    try:
        with wave.open(path, "rb") as w:
            ch, sw, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            # teto ANTES de decodificar: um WAV de 10 min viraria GB de ints
            # no PC so para o device recusar
            if rate <= 0 or (n and n / rate > 30.5):
                dur = (n / rate) if rate > 0 else 0
                raise CelerError("audio com %.1f s: o teto do play e 30 s" % dur)
            raw = w.readframes(n)
    except CelerError:
        raise
    except (wave.Error, EOFError, ValueError) as e:
        raise CelerError("WAV invalido ou nao-PCM (%s): use PCM 8/16 bits" % e)
    if sw == 2:
        a = array.array("h")
        a.frombytes(raw)
        if sys.byteorder == "big":
            a.byteswap()
        s = list(a)
    elif sw == 1:
        s = [(b - 128) << 8 for b in raw]
    else:
        raise CelerError("WAV de %d bits: use 8 ou 16" % (sw * 8))
    if ch > 1:
        s = [sum(s[i:i + ch]) // ch for i in range(0, len(s) - ch + 1, ch)]
    if rate != 16000 and s:
        out_n = max(1, int(len(s) * 16000 / rate))
        step = rate / 16000.0
        r = []
        for i in range(out_n):
            x = i * step
            j = int(x)
            f = x - j
            a0 = s[j] if j < len(s) else s[-1]
            a1 = s[j + 1] if j + 1 < len(s) else a0
            r.append(int(a0 + (a1 - a0) * f))
        s = r
    out = array.array("h", [max(-32768, min(32767, v)) for v in s])
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()


def _codigo_do_novo(args):
    """Le o codigo do convite pelo cabo do aparelho NOVO (sem tela)."""
    sub = argparse.Namespace(**vars(args))
    sub.port = args.de
    novo = open_link(sub)
    try:
        fim = time.time() + 10
        while time.time() < fim:
            st = json.loads(novo.res_ctl(SUB["NET"]).decode("utf-8", "replace"))
            if st.get("code"):
                print("codigo lido de %s: %s" % (args.de, st["code"]))
                return st["code"]
            time.sleep(0.5)
        raise CelerError("%s sem codigo pendente (rodou 'mesh accept' nele?)" % args.de)
    finally:
        novo.close()


def _node_id(link, quem):
    """No por id hex (A1B2) ou pelo nome no catalogo da malha do gateway."""
    if re.fullmatch(r"[0-9A-Fa-f]{4}", quem):
        return int(quem, 16)
    # o catalogo enche sob demanda: a 1a consulta dispara o DESCRIBE dos
    # vizinhos e volta sem eles — reconsulta como os apps fazem
    for tentativa in range(4):
        for e in decode_mesh_list(link.res_ctl(SUB["MESH"])):
            if e["nodeName"].lower() == quem.lower():
                return e["node"]
        if tentativa < 3:
            link.hold(1.5)
    raise CelerError("no \"%s\" fora do catalogo da malha (use o id, ou res ls primeiro)" % quem)


def decode_mesh_list(body):
    """Catalogo da malha (UsbRes.h): [n][node u16][nn][nodeName][entry+meta]."""
    n = body[0]
    i = 1
    out = []
    for _ in range(n):
        node = (body[i] << 8) | body[i + 1]
        nn = body[i + 2]
        i += 3
        node_name = body[i:i + nn].decode("utf-8", "replace")
        i += nn
        t, fl, nl = body[i], body[i + 1], body[i + 2]
        i += 3
        nome = body[i:i + nl].decode("utf-8", "replace")
        i += nl
        e = {"node": node, "nodeName": node_name, "type": RES_TYPES.get(t, "data"),
             "flags": fl, "name": nome}
        mlen = body[i]
        i += 1
        i = _decode_meta_tlvs(e, mlen, body, i)
        out.append(e)
    return out


def _fmt_res(e):
    s = "%s/%s %s%s%s" % (e.get("nodeName", "-"), e["name"], e["type"],
                          " compartilhado" if e["flags"] & 0x02 else "",
                          " sem-provedor" if not e["flags"] & 0x04 else "")
    if e["flags"] & 0x01:
        s += " OCUPADO"
    if e.get("unit"):
        s += " [%s %s..%s]" % (e["unit"], e.get("min", "?"), e.get("max", "?"))
    if e.get("schema"):
        s += " %s" % e["schema"]
    return s


def cmd_res(args):
    link = open_link(args)
    try:
        sub = args.res_cmd
        if sub == "ls":
            ident = json.loads(link.res_ctl(SUB["DESCRIBE"]).decode("utf-8", "replace"))
            print("%s (%s) %s api %d | privada=%s usb=%s reles=%d" % (
                ident["name"], ident["id"], ident["board"], ident["api"],
                "sim" if ident.get("prov") else "NAO",
                "on" if ident.get("usb") else "OFF", ident.get("relay", 0)))
            print("locais:")
            for e in decode_list_meta(link.res_ctl(SUB["LIST"])):
                print("  " + _fmt_res(e))
            print("malha (cache; repita o comando para descobrir nos novos):")
            for e in decode_mesh_list(link.res_ctl(SUB["MESH"])):
                print("  " + _fmt_res(e))
        elif sub == "relay" and args.no:
            # rele de OUTRO no: o gateway abre por procuracao (no virtual, API 41)
            link.keep_push = True  # EV_STATE/EV_DATA chegam entre os pedidos
            h = link.res_open_at(_node_id(link, args.no), args.nome,
                                 {"off": 1} if args.op != "state" else None)
            try:
                if args.op != "state":
                    link.res_hwrite(h, b"\x01\x01" if args.op == "on" else b"\x01\x00")
                link.res_hwrite(h, b"\x02")
                d = link.res_hdata_wait(h, 5.0)
                print("rele %s@%s -> %s (leitura: %s)" % (
                    args.nome, args.no, args.op, ("estado %d" % d[1]) if d and len(d) > 1 else "sem resposta"))
                if args.segura > 0:
                    print("segurando %ds (auto-off ao soltar)..." % args.segura)
                    link.hold(args.segura)
            finally:
                link.res_hclose(h)
        elif sub in ("snap", "rec", "play"):
            # midia de OUTRO no pelo cabo (API 41): por arquivo no gateway
            link.keep_push = True
            node = _node_id(link, args.no)
            if sub == "snap":
                if not 5 <= args.q <= 63:
                    raise CelerError("q fora do teto do device (5..63): %d" % args.q)
                print("foto de %s (q %d)..." % (args.no, args.q))
                link.res_media(SUB["SNAP_AT"], node, args.q, timeout=40)
                remoto, local = PC_PATHS["PC_SNAP_PATH"], args.saida
            elif sub == "rec":
                if not 1 <= args.segundos <= 10:
                    raise CelerError("segundos fora do teto do device (1..10): %d" % args.segundos)
                print("gravando %d s do mic de %s..." % (args.segundos, args.no))
                link.res_media(SUB["REC_AT"], node, args.segundos, timeout=args.segundos + 25)
                remoto, local = PC_PATHS["PC_REC_PATH"], args.saida
            else:
                pcm = wav_to_pcm16k(args.arquivo)
                if len(pcm) > 30 * 32000:
                    raise CelerError("audio acima de 30 s")
                fd, tmp = tempfile.mkstemp(suffix=".pcm")
                os.write(fd, pcm)
                os.close(fd)
                try:
                    link.write_file(tmp, PC_PATHS["PC_PLAY_PATH"], progress=False)
                finally:
                    os.unlink(tmp)
                print("tocando %.1f s em %s..." % (len(pcm) / 32000.0, args.no))
                try:
                    link.res_media(SUB["PLAY_AT"], node, None, timeout=len(pcm) / 32000.0 + 20)
                finally:
                    link.delete(PC_PATHS["PC_PLAY_PATH"])
                print("tocou")
                remoto = None
            if remoto:
                try:
                    link.read_file(remoto, local, progress=False)
                except Exception:
                    # pull caiu no meio: o arquivo do gateway morre tambem (o
                    # padrao do play), senao 320 KB ficam no /local do no
                    try:
                        link.delete(remoto)
                    except Exception:
                        pass
                    raise
                link.delete(remoto)
                print("salvo em %s (%d bytes)" % (local, os.path.getsize(local)))
        elif sub == "relay":
            r = link.res_open(args.nome, {"off": 1} if args.op != "state" else None)
            sid = r["sid"]
            try:
                if args.op == "state":
                    link.res_write(sid, b"\x02")
                    d = link.res_data_wait(sid, 3.0)
                    print("rele %s: %s" % (args.nome, "ligado" if d and len(d) > 1 and d[1] else
                                           "desligado" if d else "sem resposta"))
                else:
                    link.res_write(sid, b"\x01\x01" if args.op == "on" else b"\x01\x00")
                    link.res_write(sid, b"\x02")
                    d = link.res_data_wait(sid, 3.0)
                    print("rele %s -> %s (leitura: %s)" % (
                        args.nome, args.op,
                        ("estado %d" % d[1]) if d and len(d) > 1 else "sem resposta"))
            finally:
                if args.segura <= 0:
                    link.res_close(sid)
            if args.segura > 0:
                # segura a sessao: o auto-KEEP do gateway renova ate o teto;
                # ao sair, o fim do processo derruba o cabo e o auto-off age
                print("segurando %ds (auto-off ao soltar)..." % args.segura)
                try:
                    link.hold(args.segura)
                finally:
                    link.res_close(sid)
        elif sub == "sensor":
            r = link.res_open(args.nome, {"rate": args.rate} if args.rate else None)
            sid = r["sid"]
            print("sensor %s sessao %d (lease %d.%ds, transp %d)" % (
                args.nome, sid, r["lease_ds"] // 10, r["lease_ds"] % 10, r["transp"]))
            fim = time.time() + args.segundos
            try:
                while time.time() < fim:
                    d = link.res_data_wait(sid, min(2.0, max(0.5, args.segundos)))
                    if d is None:
                        continue
                    if args.rate and len(d) >= 8:
                        ts = struct.unpack("<I", d[:4])[0]
                        v = struct.unpack("<f", d[4:8])[0]
                        print("t=%u %.1f" % (ts, v))
                    elif not args.rate:
                        print(" ".join("%02x" % b for b in d))
            finally:
                link.res_close(sid)
        elif sub == "pulse":
            # API 47: o dono liga e desliga sozinho; a sessao precisa viver
            # durante o pulso (o fim do lease cancela)
            if not 1 <= args.ms <= 65535:
                raise CelerError("ms fora da faixa 1..65535: %d" % args.ms)
            cmd = struct.pack("<BH", 3, args.ms)
            if args.no:
                link.keep_push = True
                h = link.res_open_at(_node_id(link, args.no), args.nome, {"off": 1})
                try:
                    link.res_hwrite(h, cmd)
                    link.hold(args.ms / 1000.0 + 0.5)
                finally:
                    link.res_hclose(h)
            else:
                r = link.res_open(args.nome, {"off": 1})
                sid = r["sid"]
                try:
                    link.res_write(sid, cmd)
                    time.sleep(args.ms / 1000.0 + 0.5)
                finally:
                    link.res_close(sid)
            print("pulso de %d ms em %s%s" % (args.ms, args.nome,
                                              "@" + args.no if args.no else ""))
        elif sub == "pwm":
            # pino livre do gateway: [4][duty]. A sessao segura o LEDC; sem
            # --segura o PWM fica so enquanto o comando roda (2 s)
            if not 0 <= args.pct <= 100:
                raise CelerError("pct fora de 0..100: %d" % args.pct)
            r = link.res_open("gpio", {"pin": args.pino})
            sid = r["sid"]
            try:
                link.res_write(sid, struct.pack("<BB", 4, args.pct))
                seg = args.segura if args.segura > 0 else 2
                print("pwm %d%% no pino %d (sessao %d, %ds)" % (args.pct, args.pino, sid, seg))
                link.hold(seg)
            finally:
                link.res_close(sid)
        elif sub == "rule":
            # reflexos nativos (API 47) no NVS do no do cabo
            code, out = link.exec("svc reflex " + " ".join(args.rule_args))
            sys.stdout.write(out)
            if code != 0:
                raise CelerError("svc reflex saiu %d" % code)
        elif sub == "acl":
            # ACL por recurso (Fase 4): mora no NVS do dono, editada localmente
            code, out = link.exec("res acl " + " ".join(args.acl_args))
            sys.stdout.write(out)
            if code != 0:
                raise CelerError("res acl saiu %d" % code)
        elif sub == "open":
            opts = json.loads(args.opts) if args.opts else None
            r = link.res_open(args.nome, opts)
            print("sessao %d (lease %d.%ds, transp %d, canal %d)" % (
                r["sid"], r["lease_ds"] // 10, r["lease_ds"] % 10, r["transp"], r["chan"]))
        elif sub == "write":
            dados = args.dados.encode("utf-8").decode("unicode_escape").encode("latin-1")
            link.res_write(args.sid, dados)
            print("escrito (%d bytes); resposta sai como RES_DATA" % len(dados))
        elif sub == "read":
            d = link.res_data_wait(args.sid, args.timeout)
            if d is None:
                print("nada em %.1fs" % args.timeout)
            else:
                print(" ".join("%02x" % b for b in d))
        elif sub == "close":
            link.res_close(args.sid)
            print("fechada (auto-off no dono se o OPEN pediu)")
    finally:
        link.close()


def mesh_join_body(nome, senha):
    """Corpo do SUB_JOIN: [nlen][nome][plen][senha] (regras do UsbRes.h)."""
    n, s = nome.encode("utf-8"), senha.encode("utf-8")
    if not 1 <= len(n) <= 15:
        raise CelerError("nome da matilha: 1 a 15 bytes")
    if not 8 <= len(s) <= 64:
        raise CelerError("senha da matilha: 8 a 64 bytes")
    return bytes((len(n),)) + n + bytes((len(s),)) + s


def cmd_mesh(args):
    """A matilha pelo cabo (API 40/41): status, join/leave e o PC como no
    virtual (send/listen)."""
    link = open_link(args)
    # eventos do no virtual (KL_RES_DATA sid 0) chegam a qualquer hora: nao
    # descartar entre um pedido e outro
    link.keep_push = True
    try:
        try:
            if args.mesh_cmd == "join":
                senha = args.senha if args.senha is not None else getpass.getpass("senha da matilha: ")
                link.res_ctl(SUB["JOIN"], mesh_join_body(args.nome, senha), timeout=10)
            elif args.mesh_cmd == "leave":
                link.res_ctl(SUB["LEAVE"])
            elif args.mesh_cmd == "accept":
                link.res_ctl(SUB["ACCEPT"], b"\x00" if args.off else b"\x01")
            elif args.mesh_cmd == "invite":
                alvo_b = args.alvo.encode()
                if not 1 <= len(alvo_b) <= 255:
                    die("alvo do convite: 1 a 255 bytes")
                print("conectando em %s pelo CelerLink..." % args.alvo)
                r = link.res_ctl(SUB["INVITE"], bytes((len(alvo_b),)) + alvo_b, timeout=30)
                if r[:1] == b"\x01":
                    print("convite aceito: %s ja era pareado (bond), entrou sem codigo" % args.alvo)
                else:
                    codigo = args.codigo or (_codigo_do_novo(args) if args.de else
                                             input("codigo na tela do novo: ").strip())
                    # die direto (SystemExit): erro de digitacao do codigo
                    # nao pode virar a dica de "firmware anterior a API 40"
                    if not re.fullmatch(r"\d{6}", str(codigo)):
                        die("codigo do convite sao 6 digitos (veio %r)" % codigo)
                    print("enviando a chave (codigo %s)..." % codigo)
                    link.res_ctl(SUB["INVITE_CODE"], codigo.encode(), timeout=20)
                    print("convite aceito: %s entrou na matilha" % args.alvo)
            # listen so espera: pede para entrar como no virtual
            entra = bytes([NET_ENTER]) if args.mesh_cmd == "listen" else b""
            st = json.loads(link.res_ctl(SUB["NET"], entra).decode("utf-8", "replace"))
        except CelerError as e:
            die("%s (firmware anterior a API 40? use: celerctl shell mesh join ...)" % e)
        if args.mesh_cmd == "send":
            to = int(st["node"], 16) if args.no.lower() == "gw" else _node_id(link, args.no)
            link.mesh_send(to, args.msg.encode("utf-8"))
            print("enviado como pc-%s" % st["node"])
            return
        if args.mesh_cmd == "listen":
            print("ouvindo como pc-%s (%s) por %ds; nos apps: Pack.send(\"pc-%s\", ...)" % (
                st["node"], st["pc"], args.segundos, st["node"]))
            fim = time.time() + args.segundos
            while time.time() < fim:
                ev = link.res_event_wait(lambda e: e["ev"] == "msg", fim - time.time())
                if ev:
                    print("%s (%s)%s: %s" % (ev["fromName"] or ev["from"], ev["from"],
                                             " [cru]" if ev["raw"] else "",
                                             ev["data"].decode("utf-8", "replace")))
            return
        if args.json:
            print(json.dumps(st))
            return
        if st.get("invite", "idle") != "idle":
            print("convite: %s%s" % (st["invite"], ("  codigo " + st["code"]) if st.get("code") else ""))
        print("%s (%s) na %s \"%s\" | PC aqui = %s" % (
            st["name"], st["node"], "matilha" if st.get("prov") else "rede aberta",
            st["net"], st["pc"]))
    finally:
        link.close()


def cmd_shell(args):
    link = open_link(args)
    try:
        if args.cmd:
            code, out = link.exec(" ".join(args.cmd))
            sys.stdout.write(out)
            sys.exit(code)
        # modo interativo
        print('CelerOS shell (Ctrl-D para sair)')
        while True:
            try:
                line = input("celer> ").strip()
            except EOFError:
                print()
                return
            if not line:
                continue
            if line in ("exit", "quit"):
                return
            code, out = link.exec(line)
            sys.stdout.write(out if out.endswith("\n") or not out else out + "\n")
    finally:
        link.close()


def cmd_ls(args):
    link = open_link(args)
    try:
        entries = link.ls(args.path)
    finally:
        link.close()
    if args.long:
        import datetime
        for e in sorted(entries, key=lambda e: (not e["dir"], e["name"].lower())):
            when = datetime.datetime.fromtimestamp(e["mtime"]).strftime("%Y-%m-%d %H:%M")
            print(f"{'d' if e['dir'] else '-'} {human_size(e['size']):>7}  {when}  {e['name']}")
    else:
        for e in sorted(entries, key=lambda e: (not e["dir"], e["name"].lower())):
            print(("/" if e["dir"] else "") + e["name"])


def cmd_cat(args):
    link = open_link(args)
    try:
        st = link.stat(args.path)
        if st is None or st["dir"]:
            die(f"{args.path} nao existe ou e diretorio")
        got = 0
        while got < st["size"]:
            data = link.read_chunk(args.path, got, min(CHUNK, st["size"] - got))
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            got += len(data)
        if got < st["size"]:
            # o device prometeu st["size"] e calou no meio: entregar metade do
            # arquivo no stdout (scripting) e pior que falhar ruidoso
            die(f"cat incompleto: {got} de {st['size']} bytes de {args.path}")
    finally:
        link.close()


def cmd_push(args):
    local = Path(args.local)
    # Pasta de app p/ raiz de apps e um install: deps do hub, deps.json,
    # poda e rescan — push cru de app deixava o require quebrado no
    # primeiro run ("dependencia ausente"). --raw devolve o transporte
    # puro (arquivo a arquivo, sem tratar nada).
    if (not args.raw and local.is_dir() and (local / "app.json").is_file()
            and args.remote.rstrip("/").endswith("/apps")):
        raiz = args.remote.rstrip("/")
        print(f"push: pasta de app ({local.name}) -> caminho de apps install "
              f"(deps inclusas); --raw empurra cru")
        args.sd = raiz.endswith("/sd/apps")
        args.pula_lint = False
        args.pula_verify = args.no_verify
        args.run = False
        link = open_link(args)
        try:
            _install_app_folder(link, local, args)
        finally:
            link.close()
        return
    if not local.is_file():
        die(f"{args.local} nao existe")
    link = open_link(args)
    try:
        link.write_file(args.local, args.remote)
        # verify por padrão: rele e confere o crc — o transporte dizer ok
        # nao prova que o filesystem vai SERVIR o conteudo novo (bancada
        # 2026-10-09: ls novo, cat antigo). --no-verify pula (scripting).
        if args.no_verify:
            return
        n, crc = link.verify_file(args.local, args.remote)
        print(f"verificado: {args.remote} ({n} B, crc32 {crc:08x})")
    finally:
        link.close()


def cmd_pull(args):
    link = open_link(args)
    try:
        link.read_file(args.remote, args.local)
    finally:
        link.close()


def cmd_rm(args):
    link = open_link(args)
    try:
        link.delete(args.path, recursive=args.recursive)
    finally:
        link.close()


def cmd_simple(op):
    def handler(args):
        payload = b""
        if op == "RENAME":
            payload = args.src.encode() + b"\0" + args.dst.encode() + b"\0"
        elif op in ("DELETE", "MKDIR"):
            payload = args.path.encode() + b"\0"
        link = open_link(args)
        try:
            link.simple(op, payload)
        finally:
            link.close()
    return handler


def cmd_reboot(args):
    link = open_link(args)
    try:
        link.reboot()
    finally:
        link.close()
    print("reiniciando...")


# ------------------------------------------------------------------- logcat

# Timestamp do ESP-IDF: "I (1234) tag: mensagem" (ms desde o boot).
_LOG_TS_RE = re.compile(r"^\s*([IWEDV]) \((\d+)\)")


def parse_log_ts(line):
    """(nivel, ms desde o boot) de "I (1234) wifi: ..."; (None, None) se a
    linha nao tem o prefixo do ESP-IDF (continuacao de stack, print cru)."""
    m = _LOG_TS_RE.match(line)
    if not m:
        return None, None
    return m.group(1), int(m.group(2))


def parse_since(spec):
    """--since: ms desde o boot ("1234", "1234ms", "90s", "2m") ou relativo ao
    log mais novo do conjunto ("-30s"). Devolve ms; negativo = relativo."""
    s = (spec or "").strip().lower()
    rel = s.startswith("-")
    if rel:
        s = s[1:].strip()
    m = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*(ms|s|m|min)?", s)
    if not m:
        raise CelerError(f"--since invalido: {spec!r} (use 1234, 1234ms, 90s, "
                         "2m ou -30s para os ultimos 30 s do buffer)")
    v = float(m.group(1).replace(",", "."))
    unit = m.group(2) or "ms"
    ms = int(round(v * {"ms": 1, "s": 1000, "m": 60000, "min": 60000}[unit]))
    return -ms if rel else ms


def _grep_re(pattern):
    try:
        return re.compile(pattern, re.IGNORECASE) if pattern else None
    except re.error as e:
        raise CelerError(f"--grep invalido ({e}): use uma REGEX, ex: "
                         '"wifi|crash"') from None


def filter_log_lines(lines, since=None, grep=None):
    """Filtro client-side, puro (testavel no host): --since absoluto ou
    relativo ao log mais novo do CONJUNTO (o --dump fecha tudo antes) e
    --grep REGEX (ignora caixa). Linhas de continuacao (stack traces, que
    comecam com espaco) acompanham a decisao da anterior: grep no cabecalho
    nao perde a stack."""
    since_ms = parse_since(since) if since else None
    pat = _grep_re(grep)
    newest = None
    for line in lines:
        _, ts = parse_log_ts(line)
        if ts is not None and (newest is None or ts > newest):
            newest = ts
    bound = None
    if since_ms is not None:
        bound = since_ms if since_ms >= 0 else (newest or 0) + since_ms
    out = []
    keep_prev = True
    for line in lines:
        _, ts = parse_log_ts(line)
        if ts is not None:
            keep = bound is None or ts >= bound
            if keep and pat is not None and not pat.search(line):
                keep = False
            keep_prev = keep
        elif line[:1].isspace():
            keep = keep_prev  # continuacao: segue o cabecalho
        else:
            keep = keep_prev
            if keep and pat is not None and not pat.search(line):
                keep = False
            keep_prev = keep
        if keep:
            out.append(line)
    return out


def _ring_rolled(lines):
    """Heuristica de ring rolado: o dump comecou no MEIO de uma linha (nao ha
    contador de descarte no firmware; o ring sobrescreve byte a byte). Se a
    1a linha nao tem o prefixo "I (1234)" e logo depois aparecem linhas com
    ele, o comeco mais antigo foi perdido."""
    head = next((ln for ln in lines if ln.strip()), None)
    if head is None or parse_log_ts(head)[1] is not None:
        return False
    return any(parse_log_ts(ln)[1] is not None for ln in lines[:6])


def _emit_log(line, args):
    if args.json:
        level, ts = parse_log_ts(line)
        rec = {"ts": ts, "level": level, "text": line}
        if args.ts:
            t = time.time()
            rec["host_ts"] = (time.strftime("%H:%M:%S", time.localtime(t))
                              + f".{int((t % 1) * 1000):03d}")
        print(json.dumps(rec, ensure_ascii=False))
        return
    if args.ts:
        t = time.time()
        stamp = time.strftime("%H:%M:%S", time.localtime(t))
        line = f"[{stamp}.{int((t % 1) * 1000):03d}] {line}"
    print(line)


class _LogFilter:
    """Filtro incremental do stream. O --since relativo usa o maior timestamp
    visto ate agora (no --dump o filter_log_lines conhece o conjunto todo)."""

    def __init__(self, since=None, grep=None):
        self.since = parse_since(since) if since else None
        self.pat = _grep_re(grep)
        self.newest = None
        self.keep_prev = True

    def keep(self, line):
        _, ts = parse_log_ts(line)
        if ts is not None:
            if self.newest is None or ts > self.newest:
                self.newest = ts
            if self.since is None:
                keep = True
            elif self.since >= 0:
                keep = ts >= self.since
            else:
                keep = ts >= self.newest + self.since
            if keep and self.pat is not None and not self.pat.search(line):
                keep = False
            self.keep_prev = keep
        elif line[:1].isspace():
            keep = self.keep_prev
        else:
            keep = self.keep_prev
            if keep and self.pat is not None and not self.pat.search(line):
                keep = False
            self.keep_prev = keep
        return keep


def _log_chunks(raw):
    """Decodifica e costura os chunks do ring em linhas completas."""
    text = raw.decode("utf-8", "replace")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def cmd_logcat(args):
    flt = _LogFilter(args.since, args.grep)  # valida --since/--grep ja
    link = open_link(args)
    try:
        if args.dump:
            # firmware atual: KL_LOG_DUMP copia o ring SEM consumir (dump
            # repetivel) e anuncia o total — le exatamente isso, sem janela
            # de silencio. Firmware antigo recusa o opcode: cai no fallback
            # abaixo (LOG_ON, que drena o ring, + janela de silencio)
            raw = bytearray()
            dumped = False
            if "LOG_DUMP" in KL:
                try:
                    _, payload = link.xfer(KL["LOG_DUMP"], b"", timeout=10.0)
                    if payload and payload[0] == 0 and len(payload) >= 5:
                        (total,) = struct.unpack("<I", payload[1:5])
                        got = 0
                        while got < total:
                            cmd, pl = link.read_push_frame(timeout=10.0)
                            if cmd == KL["LOG_DATA"]:
                                raw += pl[1:]
                                got += len(pl) - 1
                        dumped = True
                except CelerError:
                    pass  # opcode desconhecido = firmware antigo
            if not dumped:
                link.logcat_on()
                quiet = args.quiet_ms / 1000.0
                last = time.monotonic()
                while time.monotonic() - last < quiet:
                    try:
                        cmd, payload = link.read_push_frame(timeout=0.15)
                    except Exception:
                        continue
                    if cmd == KL["LOG_DATA"]:
                        raw += payload[1:]
                        last = time.monotonic()
            lines = _log_chunks(bytes(raw))
            if _ring_rolled(lines):
                print("aviso: o ring de logs pode ter rolado — o dump comecou "
                      "no meio de uma linha e as mais antigas foram perdidas",
                      file=sys.stderr)
            for line in filter_log_lines(lines, args.since, args.grep):
                _emit_log(line, args)
            return
        if args.since and parse_since(args.since) < 0:
            print("aviso: --since relativo so recorta o buffer no --dump; no "
                  "stream vale a partir do anexo", file=sys.stderr)
        link.logcat_on()
        print("aguardando logs do dispositivo (Ctrl-C para sair; --dump copia o buffer e sai)",
              file=sys.stderr)
        buf = ""
        while True:
            cmd, payload = link.read_push_frame(timeout=3600.0)
            if cmd == KL["LOG_DATA"]:
                buf += payload[1:].decode("utf-8", "replace")
                *done, buf = buf.split("\n")
                for line in done:
                    if flt.keep(line):
                        _emit_log(line, args)
    except KeyboardInterrupt:
        print()
    finally:
        try:
            link.logcat_off()
        except Exception:
            pass
        link.close()


def cmd_ota(args):
    if args.ota_cmd != "push":
        die("uso: celerctl ota push FIRMWARE.bin")
    if not os.path.isfile(args.file):
        die(f"{args.file} nao existe")
    if getattr(args, "port", None):
        args.port = stable_port(args.port)  # antes do reboot: ttyACMn renumera
    link = open_link(args)
    try:
        part, written = link.ota_write(args.file)
        print(f"OTA ok: {written} bytes em '{part}'")
        if not args.no_reboot:
            try:
                link.reboot()
            except PORT_GONE + (CelerError,):
                # o device reiniciou antes de responder (USB nativo some na
                # hora): o reboot aconteceu — a conferencia abaixo decide
                pass
            print("reiniciando para o novo firmware...")
    finally:
        try:
            link.close()
        except PORT_GONE:
            pass
    if not args.no_reboot:
        verify_ota_boot(args, part)


def stable_port(port):
    """/dev/ttyACMn renumera no reboot (USB nativo do watch): devolve o link
    estavel de /dev/serial/by-id que aponta para a porta, se houver."""
    if not port or is_net_addr(port) or not port.startswith("/dev/"):
        return port
    byid = Path("/dev/serial/by-id")
    try:
        real = os.path.realpath(port)
        for link in sorted(byid.iterdir()):
            if os.path.realpath(link) == real:
                return str(link)
    except OSError:
        pass
    return port


def verify_ota_boot(args, part, wait_s=60):
    """Confere que o device SUBIU na particao gravada (info.app_part). Sem
    isso 'OTA ok' podia esconder um rollback do bootloader (imagem que nao
    sobe volta ao slot antigo) ou um reboot que nao aconteceu. Firmware sem
    app_part no info: so avisa que nao da para conferir."""
    deadline = time.monotonic() + wait_s
    time.sleep(3)
    last = None
    said = False
    while time.monotonic() < deadline:
        try:
            link = open_link(args)
            try:
                info = link.info()
            finally:
                link.close()
        except PORT_GONE + (CelerError,) as e:
            last = e
            time.sleep(2)
            continue
        running = info.get("app_part")
        if running is None:
            print("aviso: firmware sem app_part no info — nao da para conferir a troca")
            return
        if running == part and info.get("app_state") == "pending":
            # slot novo ainda sem os 30 s de boot sao: um crash agora faz o
            # bootloader voltar ao antigo — espera a confirmacao do firmware
            if not said:
                print(f"subiu em '{running}'; aguardando a confirmacao (30 s de boot sao)...")
                said = True
            deadline = max(deadline, time.monotonic() + 15)
            time.sleep(5)
            continue
        if running == part:
            print(f"conferido: rodando em '{running}' (uptime {info.get('uptime_s')} s"
                  f"{', imagem confirmada' if info.get('app_state') == 'valid' else ''})")
            return
        die(f"o device subiu em '{running}', nao em '{part}': rollback do bootloader "
            f"(imagem nao bootou) ou reboot que nao aconteceu — veja 'celerctl coredump'")
    print(f"aviso: device nao respondeu em {wait_s} s depois do reboot ({last}) — "
          "confira com 'celerctl info' (app_part)")



def cmd_coredump(args):
    link = open_link(args)
    try:
        data = link.coredump(keep=args.keep)
    finally:
        link.close()
    if not data:
        die("nao ha coredump gravado (nenhum crash desde o ultimo reset)")
    Path(args.out).write_bytes(data)
    # o device manda a imagem CRUA da particao (header de 12 B do IDF + ELF):
    # o espcoredump espera esse formato com -t raw (-t elf rejeita o header)
    print(f"{args.out}: {len(data)} bytes (coredump cru da particao) — analise com:")
    print(f"  python -m esp_coredump info_corefile -t raw -c {args.out} build/CelerOS.elf")
    print("  (SHA invalido no -t raw = dump escrito pela metade: crash duro")
    print("   no meio da propria gravacao do coredump)")


def split_frames(buf, proto):
    """Extrai os frames completos de um buffer acumulado da serial, sem
    bloquear: devolve ([(cmd, payload)], resto). Lixo antes do magic (texto
    do console) e frame com CRC errado sao descartados; frame pela metade
    fica no resto esperando os bytes seguintes — nunca se perde um pedaco do
    fluxo do debugger por timeout no meio do frame."""
    frames = []
    head_len = 8 if proto == 2 else 4
    while True:
        i = buf.find(b"\x43")
        if i < 0:
            return frames, b""
        buf = buf[i:]
        if len(buf) < head_len:
            return frames, buf
        cmd, length = buf[1], struct.unpack("<H", buf[2:4])[0]
        if len(buf) < head_len + length:
            return frames, buf
        payload = bytes(buf[head_len:head_len + length])
        if proto == 2:
            crc = struct.unpack("<I", buf[4:8])[0]
            if crc != zlib.crc32(bytes(buf[1:4]) + payload) & 0xFFFFFFFF:
                buf = buf[1:]  # magic falso ou frame corrompido: caca o proximo
                continue
        frames.append((cmd, payload))
        buf = buf[head_len + length:]


def _roteiro_eval(stdin, expr, sleep=time.sleep):
    """Roteiro one-shot do `debug --eval` no stdin do cliente dbg.js: pausa
    (p) -> avalia EXPR no escopo do app (pausado, o eval ve vars de modulo:
    E, D, M...; rodando, so alcancaria os globais) -> continua (c) -> sai
    (q). Pausa e evento de pausa sao assincronos: os sleeps cobrem o ciclo.
    O app pesado decodifica PNGs/cria mundo nos primeiros segundos — pausar
    cedo demais avalia num frame onde os vars do app ainda nao existem
    (ReferenceError no require inicial)."""
    sleep(4.0)
    try:
        stdin.write(b"p\n")
        stdin.flush()
        sleep(2.0)
        stdin.write(f"e {expr}\n".encode())
        stdin.flush()
        sleep(0.6)
        stdin.write(b"c\nq\n")
        stdin.flush()
    except (OSError, ValueError):
        pass  # cliente saiu antes (pipe fechado): o proxy cuida do resto


def _app_running(link):
    """Ha app JS aberto? Le js.active do KL_STATS; None se o firmware nao
    responde ao STATS (ai o debug segue o caminho antigo, sem a guarda)."""
    if "STATS" not in KL:
        return None
    try:
        snap = link.stats()
    except CelerError:
        return None
    return bool((snap.get("js") or {}).get("active"))


def _debug_target(link, args):
    """App alvo do `debug` (posicional ou --app) e a guarda do --eval.

    O debugger so anexa a um app ABERTO: com --eval e sem app, abrir os
    sockets e esperar o attach pende o terminal para sempre (o cliente nao
    fala primeiro). Falha aqui, antes de qualquer socket, com a receita."""
    app = getattr(args, "app", None) or getattr(args, "app_opt", None)
    if getattr(args, "eval", None) and getattr(args, "serve", False):
        die("--eval precisa do cliente neste terminal (nao combine com --serve)")
    if getattr(args, "eval", None) and not app and _app_running(link) is False:
        die("debug --eval: nenhum app aberto — o debugger so anexa a um app. "
            "abra um (celerctl apps run NOME) ou use: "
            "celerctl debug --app NOME --eval EXPR")
    return app


def cmd_debug(args):
    """Debugger do Duktape pela serial. Abre dois TCP locais — o protocolo
    dmsg cru (porta) e as linhas de log do device (porta+1) — e faz o proxy
    com frames KL_DEBUG_DATA. Por padrao ja abre o cliente (node
    tools/debug/dbg.js) neste terminal; com --serve so o proxy fica no ar
    (cliente em outro terminal, ou qualquer cliente do Duktape debugger).

    Ordem: o cliente conecta ANTES do app rodar — a linha de versao que o
    alvo manda no attach so tem para onde ir. O cliente NAO fala primeiro;
    o DEBUG_CTL 1 depois do accept e o gate do attach no device."""
    import select
    import shutil
    import signal
    import subprocess

    link = open_link(args)
    if "DEBUG_CTL" not in KL:
        die("celerctl sem KL_DEBUG_CTL: firmware muito antigo para o debugger")
    # --eval sem app (e sem --app): falha ANTES de abrir sockets/cliente
    app = _debug_target(link, args)

    def _terminate(*_):
        raise KeyboardInterrupt  # kill/terminal fechado: roda a limpeza (DEBUG_CTL 0)
    signal.signal(signal.SIGTERM, _terminate)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, _terminate)

    def listen(port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
        except OSError as e:
            die(f"porta TCP {port} ocupada ({e}): outro celerctl debug? use --tcp-port")
        s.listen(1)
        return s

    srv = listen(args.tcp_port)
    log_srv = listen(args.tcp_port + 1)
    log_srv.setblocking(False)

    client = None
    node = shutil.which("node")
    if not args.serve and node is None:
        print("debug: node nao encontrado; seguindo so com o proxy (--serve)")
    spawn = not args.serve and node is not None
    if spawn:
        cli = [node, str(Path(__file__).resolve().parent / "debug" / "dbg.js"),
               "--port", str(args.tcp_port)]
        if args.src:
            cli += ["--src", args.src]
        # Ctrl-C e do cliente (pausa o app); o proxy so sai quando ele sair
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        # --eval: stdin pipeado — o roteiro (p/e/c/q) entra depois do launch
        client = subprocess.Popen(cli, stdin=subprocess.PIPE if args.eval else None)
    else:
        port_arg = f" --port {args.tcp_port}" if args.tcp_port != 9092 else ""
        print(f"debug: proxy em 127.0.0.1:{args.tcp_port} (logs em :{args.tcp_port + 1}) — em outro terminal:")
        print(f"  node tools/debug/dbg.js{port_arg}")

    srv.settimeout(1.0)
    conn = None
    while conn is None:
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            if client is not None and client.poll() is not None:
                die("cliente saiu antes de conectar")
    conn.setblocking(False)
    if not spawn:
        print("debug: cliente conectado" + (f"; abrindo {app}" if app else " (abra o app no device)"))

    # logs ao vivo, mas sem o historico do ring (boot inteiro): o LOG_ON
    # drena o ring de uma vez — descarta ate a serial sossegar
    link.logcat_on()
    link.push_queue.clear()
    link.keep_push = True  # daqui em diante frames do debugger nunca se perdem
    quiet_since = time.monotonic()
    deadline = quiet_since + 6.0
    while time.monotonic() - quiet_since < 0.3 and time.monotonic() < deadline:
        if link.ser.in_waiting:
            link.ser.read(link.ser.in_waiting)
            quiet_since = time.monotonic()
        else:
            time.sleep(0.02)

    log_conns = []
    if spawn:
        # o cliente abre a porta de logs logo apos a principal: espera por
        # ele para o que o app imprimir no attach ja cair no REPL
        log_srv.settimeout(2.0)
        try:
            lc, _ = log_srv.accept()
            log_conns.append(lc)
        except OSError:
            pass
        log_srv.setblocking(False)

    # Armar SO DEPOIS do accept: o canal do device cai para o console apos
    # 8s sem frames do host, e o accept pode demorar minutos esperando o
    # cliente — um DEBUG_CTL cedo morre no idle e o run seguinte vira lixo
    # no console do shell (o frame nem chega ao dispatch)
    try:
        _, payload = link.xfer(KL["DEBUG_CTL"], b"\x01", timeout=5.0)
        if len(payload) < 2 or payload[1] != 1:
            die("firmware sem o debugger compilado (Kconfig CELEROS_JS_DEBUGGER; "
                "padrao so nas placas S3)")
    except CelerError as e:
        die(f"firmware sem suporte ao debugger ({e})")
    if app:
        # sem `exit` antes: sem app rodando o pedido fica pendente e mataria
        # o app recem-aberto no primeiro delay. Com outro app no ar o run
        # espera ele sair (a mensagem do device diz)
        code, out = link.exec(f"run {app}")
        if code != 0 or not spawn:
            print(("debug: " if code == 0 else f"debug: run {app} falhou: ") + out.strip())

    if args.eval and spawn:
        # one-shot: o roteiro (p/e/c/q) entra pelo stdin do cliente depois do
        # launch — thread separada, o proxy segue bombeando os frames
        import threading
        threading.Thread(target=_roteiro_eval, args=(client.stdin, args.eval),
                         daemon=True).start()

    def emit_log(text):
        # logs vao para o cliente (porta lateral); sem cliente de logs, aqui
        dead = []
        for lc in log_conns:
            try:
                lc.sendall(text.encode("utf-8", "replace"))
            except OSError:
                dead.append(lc)
        for lc in dead:
            log_conns.remove(lc)
        if not log_conns:
            sys.stdout.write(text)
            sys.stdout.flush()

    # `r` no cliente: sincroniza o fonte local com o device antes de relancar
    # (pedido "sync <pasta no device>" pela porta de logs, que e bidirecional;
    # resposta numa linha com prefixo \x01 que o cliente nao imprime)
    synced = {}
    log_bufs = {}

    def local_app_dir(dev_dir):
        if args.src:
            p = Path(args.src)
            return p if p.is_dir() else p.parent
        name = dev_dir.rstrip("/").rsplit("/", 1)[-1]
        root = Path(__file__).resolve().parent.parent
        cands = [root / "data" / "apps" / name, root / "hub_apps" / name]
        cands += sorted(root.glob(f"boards/*/data/apps/{name}"))
        return next((c for c in cands if (c / "app.json").is_file()), None)

    def do_sync(dev_dir):
        src = local_app_dir(dev_dir)
        if src is None:
            return "skip sem fonte local (use --src)"
        if not _lint_app_folder(src, fatal=False):
            return "erro lint com erros (detalhes no terminal do celerctl)"
        snap = _snapshot(src)
        # 1o sync empurra a pasta inteira (cria subpastas; o device pode ter
        # outra versao); os seguintes, so o que mudou desde o anterior
        only = None if not synced else [rel for rel, st in sorted(snap.items()) if synced.get(rel) != st]
        pushed = _push_app_files(link, src, dev_dir.rstrip("/"), only=only, progress=False)
        synced.clear()
        synced.update(snap)
        return f"ok {len(pushed)} {' '.join(pushed) if only is not None else '(pasta inteira)'}".rstrip()

    def handle(cmd_, payload):
        if cmd_ == KL["DEBUG_DATA"]:
            # conn e nao-bloqueante: cliente lento (REPL imprimindo) enchia o
            # buffer e o BlockingIOError encerrava o proxy como "serial caiu"
            try:
                conn.sendall(payload)
            except (BlockingIOError, InterruptedError):
                select.select([], [conn], [], 2.0)
                conn.sendall(payload)
        elif cmd_ == KL["LOG_DATA"]:
            emit_log(payload[1:].decode("utf-8", "replace"))

    # frames que o xfer/exec acima enfileiraram (attach rapido)
    while link.push_queue:
        handle(*link.push_queue.pop(0))

    rxbuf = b""
    last_keepalive = time.monotonic()
    reason = "cliente desconectou"
    try:
        while True:
            if client is not None and client.poll() is not None:
                reason = "cliente saiu"
                break
            rlist, _, _ = select.select([conn, log_srv, link.ser.fileno()] + log_conns, [], [], 0.05)
            if log_srv in rlist:
                try:
                    lc, _ = log_srv.accept()
                    log_conns.append(lc)
                except OSError:
                    pass
            for lc in [c for c in log_conns if c in rlist]:
                try:
                    chunk = lc.recv(4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    log_conns.remove(lc)
                    continue
                log_bufs[lc] = log_bufs.get(lc, b"") + chunk
                while b"\n" in log_bufs[lc]:
                    line, log_bufs[lc] = log_bufs[lc].split(b"\n", 1)
                    req = line.decode("utf-8", "replace").strip()
                    if req.startswith("sync "):
                        try:
                            res = do_sync(req[5:].strip())
                        except (CelerError, OSError) as e:
                            res = f"erro {e}"
                        lc.sendall(("\x01sync " + res + "\n").encode())
                        # xfer do push guarda frames do debugger/logs na fila
                        while link.push_queue:
                            handle(*link.push_queue.pop(0))
            # cliente -> device: emoldura os bytes dmsg em KL_DEBUG_DATA
            if conn in rlist:
                try:
                    data = conn.recv(8192)
                except (BlockingIOError, InterruptedError):
                    data = None
                except OSError:
                    data = b""
                if data == b"":
                    break
                if data:
                    for i in range(0, len(data), link.max_chunk):
                        link.ser.write(link._frame(KL["DEBUG_DATA"], data[i:i + link.max_chunk]))
            # device -> cliente: tudo o que a serial tiver, em frames inteiros
            waiting = link.ser.in_waiting
            if waiting:
                rxbuf += link.ser.read(waiting)
                frames, rxbuf = split_frames(rxbuf, link.proto)
                for f in frames:
                    handle(*f)
            # canal cai para console apos 8s sem bytes do host. Keepalive
            # PASSIVO: so escreve o HELLO (a resposta e descartada acima) —
            # o xfer comum limparia o buffer de entrada e apagaria frames do
            # debugger que ainda nao foram lidos
            if time.monotonic() - last_keepalive > 4.0:
                last_keepalive = time.monotonic()
                magic = b"CELERCTL1" if link.proto == 1 else b"CELERCTL2"
                link.ser.write(link._frame(KL["HELLO"], magic))
    except (serial.SerialException, OSError) as e:
        reason = f"serial caiu ({e}) — device reiniciou ou cabo saiu?"
    except KeyboardInterrupt:
        reason = "interrompido"
    finally:
        for s in [conn, srv, log_srv] + log_conns:
            try:
                s.close()
            except Exception:
                pass
        # DEBUG_CTL 0 = cliente saiu: o read do transporte no device devolve
        # 0, o Duktape desattacha e um app pausado no breakpoint volta a rodar
        try:
            link.xfer(KL["DEBUG_CTL"], b"\x00", timeout=3.0)
        except Exception:
            pass
        try:
            link.close()
        except Exception:
            pass
        if client is not None:
            try:
                client.wait(timeout=3.0)
            except Exception:
                client.kill()
        print(f"debug: encerrado ({reason})")

def _v2phys(vx, vy, w, h):
    """Coordenada VIRTUAL do app (240x320) -> fisica do vidro (w x h).
    Os apps desenham no espaco 240x320 escalado pelo toolkit; dirigir a UI
    por tap exigia essa conta de cabeca em toda placa (480x480: x2 e y1,5)."""
    return round(vx * w / 240.0), round(vy * h / 320.0)


def _screencap_to(link, out):
    """Captura o vidro para `out` (PNG); devolve (w, h, md5_do_arquivo) —
    o md5 fecha o loop tap->tela em um comando (diff de hash em vez de
    analise visual da tela)."""
    w, h, data = link.screenshot()
    try:
        from PIL import Image
    except ImportError:
        die("Pillow nao instalado (pip install Pillow)")
    # RGB565 little-endian -> RGB888
    pixels = struct.unpack(f"<{w * h}H", data)
    outb = bytearray(w * h * 3)
    for i, p in enumerate(pixels):
        # replica os bits altos nos baixos de cada canal (sem mascarar, o
        # (p >> 9) do verde arrastava os bits do VERMELHO para o G)
        outb[i * 3] = ((p >> 8) & 0xF8) | (p >> 13)
        outb[i * 3 + 1] = ((p >> 3) & 0xFC) | ((p >> 9) & 0x03)
        outb[i * 3 + 2] = ((p << 3) & 0xF8) | ((p >> 2) & 0x07)
    Image.frombytes("RGB", (w, h), bytes(outb)).save(out)
    return w, h, hashlib.md5(Path(out).read_bytes()).hexdigest()


def cmd_screencap(args):
    link = open_link(args)
    try:
        w, h, md5 = _screencap_to(link, args.out)
    finally:
        link.close()
    print(f"{args.out}: {w}x{h} md5 {md5[:10]}")


def cmd_tap(args):
    link = open_link(args)
    try:
        x, y = args.x, args.y
        if args.v:
            if args.glass:
                try:
                    w, h = (int(v) for v in args.glass.lower().split("x", 1))
                except ValueError:
                    die("--glass espera LARGURAxALTURA (ex: 480x480)")
            else:
                # o protocolo do screenshot ja traz o vidro: 1 rodada e
                # serve para qualquer placa, sem tabela hardcoded
                w, h, _ = link.screenshot()
            x, y = _v2phys(args.x, args.y, w, h)
            print(f"tap virtual ({args.x},{args.y}) -> vidro ({x},{y}) [{w}x{h}]")
        link.touch([(True, x, y, 0, args.finger), (False, 0, 0, args.hold, args.finger)])
    finally:
        link.close()
    # deixa o gesto completar no dispositivo antes de um screencap seguinte
    time.sleep((args.hold + 150) / 1000.0)
    if args.shot:
        # tap + espera + captura em UM comando: dirigir UI as cegas era um
        # baile de 3 comandos com sleeps manuais entre eles
        time.sleep(max(0, args.wait - (args.hold + 150)) / 1000.0)
        link2 = open_link(args)
        try:
            w, h, md5 = _screencap_to(link2, args.shot)
        finally:
            link2.close()
        print(f"{args.shot}: {w}x{h} md5 {md5[:10]}")


def cmd_swipe(args):
    steps = 8
    step_ms = max(1, args.duration // (steps + 1))
    samples = [(True, args.x0, args.y0, 0, args.finger)]
    for i in range(1, steps + 1):
        t = i / (steps + 1)
        x = round(args.x0 + (args.x1 - args.x0) * t)
        y = round(args.y0 + (args.y1 - args.y0) * t)
        samples.append((True, x, y, step_ms, args.finger))
    samples.append((False, 0, 0, 20, args.finger))
    link = open_link(args)
    try:
        link.touch(samples)
    finally:
        link.close()
    time.sleep((args.duration + 200) / 1000.0)


def cmd_mtap(args):
    """Dois dedos simultaneos (bench multitouch): pousam no mesmo ciclo,
    seguram MS e levantam juntos. --v/--glass valem como no tap."""
    link = open_link(args)
    try:
        p0, p1 = (args.x0, args.y0), (args.x1, args.y1)
        if args.v:
            if args.glass:
                try:
                    w, h = (int(v) for v in args.glass.lower().split("x", 1))
                except ValueError:
                    die("--glass espera LARGURAxALTURA (ex: 480x480)")
            else:
                w, h, _ = link.screenshot()
            p0 = _v2phys(args.x0, args.y0, w, h)
            p1 = _v2phys(args.x1, args.y1, w, h)
            print(f"mtap virtual {p0} {p1} -> vidro [{w}x{h}]")
        samples = [
            (True, p0[0], p0[1], 0, 0),
            (True, p1[0], p1[1], 0, 1),
            (False, 0, 0, args.hold, 0),
            (False, 0, 0, 0, 1),
        ]
        link.touch(samples)
    finally:
        link.close()
    time.sleep((args.hold + 150) / 1000.0)


# ------------------------------------------------------------------- apps ---

def _sync_app_deps(link, src, dest, args):
    """Deps compartilhadas do app.json da pasta: resolve contra o indice do
    hub (ou tools/sdk/engine com --deps-local), poe os modulos em
    /local/modules e grava <dest>/deps.json no device. Caminho unico de
    `apps install`, `dev` e do push de pasta de app — nenhum caminho que
    instala app pode deixar o require sem o cache (o classico
    "dependencia ausente" so aparece depois, no primeiro run). Nao faz nada
    sem `deps` no app.json. Devolve {nome: versao} resolvido ou None."""
    try:
        meta = json.loads((Path(src) / "app.json").read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None
    if not meta.get("deps"):
        # app que deixou de usar deps: um deps.json velho na pasta faria o
        # require apontar para modulos que talvez nao existam mais
        try:
            link.delete(f"{dest}/deps.json")
            print("deps: app sem deps; deps.json antigo removido")
        except CelerError:
            pass
        return None
    hub = (getattr(args, "hub", None) or
           os.environ.get("CELER_HUB") or "https://os.celer.tec.br").rstrip("/")
    resolved = _install_shared_deps(link, meta["deps"], hub,
                                    local=getattr(args, "deps_local", False),
                                    token=_hub_token(args, link))
    with tempfile.TemporaryDirectory() as td:
        dj = Path(td) / "deps.json"
        dj.write_text(json.dumps(resolved), encoding="utf-8")
        link.write_file(str(dj), f"{dest}/deps.json")
        if not getattr(args, "pula_verify", False):
            # deps.json aponta o require para o cache: se o FS servir lixo
            # aqui, o app nem acha a dep em runtime
            link.verify_file(str(dj), f"{dest}/deps.json")
    return resolved


def _install_app_folder(link, src, args):
    """Instala a PASTA local no device: lint, push com verificacao, poda de
    obseletos, deps do hub (args.hub vence; default CELER_HUB/producao) e
    rescan. Caminho unico de `apps install` (pasta local) e `apps store`
    (pasta baixada do hub) — os dois entram exatamente igual no device."""
    if not (src / "app.json").is_file():
        die(f"{src} nao tem app.json")
    if not args.pula_lint:
        _lint_app_folder(src)
    base = "/sd/apps" if args.sd else "/local/apps"
    dest = f"{base}/{src.name}"
    files = [f for f in sorted(src.rglob("*"))
             if f.is_file() and ".dev" not in f.parts and not _is_junk(f)]
    # app.json e o ULTIMO arquivo: se um modulo falhar no meio, o device
    # continua anunciando a versao ANTIGA (antes o app.json ia primeiro por
    # ordem alfabetica e um push perdido deixava "app.json 1.2.0 + modulo
    # 1.0.0" — o apps list mentia e o app rodava misto)
    files.sort(key=lambda f: (f.name == "app.json", f.as_posix()))
    link.simple("MKDIR", dest.encode() + b"\0")
    for f in files:
        rel = f.relative_to(src).parent
        if str(rel) != ".":
            d = dest + "/" + rel.as_posix()
            link.simple("MKDIR", d.encode() + b"\0")
    verificados = 0
    for f in files:
        dest_f = f"{dest}/{f.relative_to(src).as_posix()}"
        try:
            link.write_file(str(f), dest_f)
            if not args.pula_verify:
                # rele cada arquivo: o push dizer ok nao prova que o
                # filesystem vai servir o conteudo novo (push fantasma
                # calado quebra o app so em runtime)
                link.verify_file(str(f), dest_f)
                verificados += 1
        except CelerError as e:
            # o app.json NAO foi (vai por ultimo): o device segue com a
            # versao antiga e o install pode ser repetido. Deixar o erro
            # subir cru fazia o celerctl sair com traceback e a pasta
            # misturada sem ninguem saber o estado.
            dica = ("" if f.name == "app.json" else
                    "  app.json e gravado por ultimo: a versao no device "
                    "continua a antiga ate reinstalar.\n")
            die(f"install interrompido em {f.name}: {e}\n"
                f"  {dica}"
                f"  se o app estava aberto, `celerctl shell \"exit\"` libera "
                f"o canal (o ACK do device falha com ele rodando) e repita.")
    # poda o que ficou para tras: modulos que sairam do app entre
    # versoes seguem no device e o require ainda os acha — app misto
    # (main novo + fx velho) quebra em runtime (Supernova 2.0:
    # "doFlash undefined" com o fx.js da 1.0 sobrando na pasta)
    remote = _remote_tree(link, dest)
    local = {f.relative_to(src).as_posix() for f in files}
    stale = []
    for r, e_dir in remote.items():
        if e_dir:
            # dir remoto so e obsoleto se NENHUM arquivo local vive
            # sob ele (a pasta assets/ nunca esta no conjunto de
            # arquivos — so os pngs de dentro)
            if not any(l.startswith(r + "/") for l in local):
                stale.append(r)
        # deps.json e do INSTALLER (versao resolvida), nunca do pacote:
        # a poda imprimia "1 obsoleto" em todo install e o _sync_app_deps
        # reescrevia no passo seguinte. Quem decide o destino dele e o app
        # ter deps ou nao (_sync_app_deps).
        elif r not in local and r != "deps.json":
            stale.append(r)
    raizes = _poda_raizes(stale, remote)
    falhas = []
    for rel in raizes:
        try:
            link.delete(f"{dest}/{rel}", recursive=remote[rel])
        except CelerError as e:
            # best-effort: o device responde status 1 ate para
            # caminho ja inexistente — nao aborta o install por
            # limpeza; a proxima install re-tenta
            falhas.append(rel)
    if raizes:
        nota = f"; falharam: {', '.join(falhas)} (re-tenta na proxima)" if falhas else ""
        amostra = ", ".join(r + ("/" if remote[r] else "") for r in raizes[:6])
        if len(raizes) > 6:
            amostra += f", +{len(raizes) - 6}"
        print(f"poda: {len(raizes)} obsoleto(s) removido(s) ({amostra}){nota}")
    # deps compartilhadas (API 30) DEPOIS da poda: deps.json e do
    # installer (versao resolvida), nao do pacote — a poda nao o ve
    # e o require do device le ele p/ cair em /local/modules
    _sync_app_deps(link, src, dest, args)
    link.exec("rescan")
    nota_v = f", {verificados} verificados" if verificados else ""
    print(f"instalado: {dest} ({len(files)} arquivos{nota_v})")
    if args.run:
        _relaunch(link, src.name)
        print(f"abrindo: {src.name}")


def _http_get(url, timeout=30):
    """GET binario cru (icon/png, main.js) — o celerhub.http decodifica e
    parseia JSON, inutil para asset."""
    req = _urlreq.Request(url, headers={"User-Agent": "celerosctl/1.0"})
    with _urlreq.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _hub_url(hub, u, token=""):
    """URL do catalogo: relativa (hub + path) ou ja absoluta (o hub passou a
    servir meta/app/icon com o host) — concatenar as duas quebrava o DNS.

    `token` vira ?token= (o hub aceita Bearer e query; a query serve tambem
    para os GETs crus de asset, que nao mandam header)."""
    u = str(u)
    full = u if u.startswith(("http://", "https://")) else hub + u
    if token:
        sep = "&" if "?" in full else "?"
        full += sep + "token=" + _urlquote(token, safe="")
    return full


def _hub_token(args, link=None):
    """Token de LEITURA do hub, para ver/baixar app privado.

    Ordem: --hub-token, CELER_HUB_TOKEN e por fim o /local/hub_token.txt do
    PROPRIO device (o mesmo arquivo que a loja do aparelho usa). Sem ele o PC
    so enxerga o catalogo publico: `apps store celeros.park.*` dizia "nao
    esta no hub" com o app publicado, so que privado."""
    tok = (getattr(args, "hub_token", None) or
           os.environ.get("CELER_HUB_TOKEN") or "").strip()
    if tok or link is None:
        return tok
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix="hubtoken-")
        os.close(fd)
        link.read_file("/local/hub_token.txt", tmp, progress=False)
        tok = Path(tmp).read_text(encoding="utf-8", errors="replace").strip()
    except (CelerError, OSError):
        tok = ""
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return tok



def _apps_store(link, args):
    """`apps store PKG`: instala o pacote DO HUB pelo mesmo caminho da loja
    (catalogo -> app.json/main.js/files/icon -> lint/push/deps) sem tocar na
    UI do device. Nasceu da sessao de bancada que dirigia a App Store por
    taps as cegas para validar um install. CELER_HUB aponta para um hub
    local (default producao) — as deps saem do MESMO hub do pacote."""
    hub = (os.environ.get("CELER_HUB") or "https://os.celer.tec.br").rstrip("/")
    import celerhub
    # token de leitura: sem ele o catalogo vem so publico e o app privado
    # "nao existe" (o celerctl nao tinha token nenhum; o device tem o dele em
    # /local/hub_token.txt)
    token = _hub_token(args, link)
    _, cat = celerhub.http("GET", _hub_url(hub, "/store/all.json", token))
    entry = (cat.get("apps") or {}).get(args.pkg)
    if not entry:
        nomes = ", ".join(sorted((cat.get("apps") or {}))[:10])
        dica = "" if token else (
            "\n  app privado? passe --hub-token, exporte CELER_HUB_TOKEN ou "
            "grave /local/hub_token.txt no device")
        die(f"pacote '{args.pkg}' nao esta no hub {hub} (catalogo: {nomes}...){dica}")
    nome = entry.get("name") or args.pkg
    tamanho = (entry.get("size") or 0) + sum(
        (f or {}).get("size") or 0 for f in (entry.get("files") or {}).values())
    print(f"hub {hub}: {nome} v{entry.get('version', '?')} "
          f"(api {entry.get('api', '?')}, ~{tamanho // 1024} KB)")

    # pasta de destino: reusa a pasta de um app instalado com o mesmo
    # packageName (update no lugar, launcher sem duplicar); senao o nome de
    # exibicao saneado ("Arrasa!" -> "Arrasa")
    dir_name = None
    for base in ("/local/apps", "/sd/apps"):
        try:
            entradas = link.ls(base)
        except CelerError:
            continue
        for e in entradas:
            if not e["dir"]:
                continue
            m = _app_meta(link, base, e["name"])
            if m and m.get("packageName") == args.pkg:
                dir_name = e["name"]
                break
        if dir_name:
            break
    if not dir_name:
        dir_name = re.sub(r"[^A-Za-z0-9 ._-]", "", nome).strip() or args.pkg

    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / dir_name
        src.mkdir()
        # o app.json servido pelo hub leva os campos COMPUTADOS (size, md5,
        # published_at, publisher, zip): o lint local os recusa ("nunca
        # setar a mao"), entao o install tira antes de gravar
        meta_raw = _http_get(_hub_url(hub, entry["meta"], token))
        try:
            meta = json.loads(meta_raw.decode("utf-8"))
        except ValueError:
            die("app.json do hub invalido")
        for k in ("md5", "size", "published_at", "publisher", "zip"):
            meta.pop(k, None)
        (src / "app.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        main = _http_get(_hub_url(hub, entry["app"], token))
        if entry.get("md5") and hashlib.md5(main).hexdigest() != entry["md5"]:
            die(f"main.js: md5 divergente do catalogo do hub")
        (src / "main.js").write_bytes(main)
        base_url = entry["app"].rsplit("/", 1)[0] + "/"
        for n, fi in (entry.get("files") or {}).items():
            if n in ("app.json", "main.js", "icon.png") or "/" in n or ".." in n:
                continue  # o que tem tratamento proprio (ou nao e caminho)
            data = _http_get(_hub_url(hub, fi.get("url") or base_url + n, token))
            if fi.get("md5") and hashlib.md5(data).hexdigest() != fi["md5"]:
                die(f"{n}: md5 divergente do catalogo do hub")
            dst = src / n
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
        if entry.get("icon"):
            try:
                (src / "icon.png").write_bytes(
                    _http_get(_hub_url(hub, entry["icon"], token)))
            except Exception as e:  # noqa: BLE001 — icon e nao-fatal na loja
                print(f"aviso: icon.png nao veio ({e})")
        args.hub = hub
        # as deps do pacote tambem podem ser privadas: o token segue adiante
        args.hub_token = token or getattr(args, "hub_token", None)
        _install_app_folder(link, src, args)


def _app_meta(link, base, dirname):
    """Le <base>/<dirname>/app.json no dispositivo; None se invalido."""
    import json as _json
    path = f"{base}/{dirname}/app.json"
    try:
        st = link.stat(path)
    except CelerError:
        return None
    if st is None or st["dir"] or st["size"] > 16384:
        return None
    raw = b""
    while len(raw) < st["size"]:
        chunk = link.read_chunk(path, len(raw), min(CHUNK, st["size"] - len(raw)))
        if not chunk:
            return None
        raw += chunk
    try:
        meta = _json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return None
    meta.setdefault("name", dirname)
    meta.setdefault("version", "?")
    meta["_base"] = base
    meta["_dir"] = dirname
    return meta


APP_BASES = ("/local/apps", "/sd/apps")


def _norm_app_name(name):
    """Normaliza para casar pasta x nome de exibicao x sufixo do packageName:
    "WebPass" == "webpass", "Arrasa!" == "Arrasa"."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _pc_quote(name):
    """Aspas do shell do PC (nao do device) so quando a pasta tem espaco: a
    linha sugerida no terminal precisa chegar como UM argumento."""
    return f'"{name}"' if any(c.isspace() for c in name) else name


def _installed_apps(link):
    """[(base, pasta, meta|None)] dos dois roots — so no caminho de erro."""
    out = []
    for base in APP_BASES:
        try:
            entries = link.ls(base)
        except CelerError:
            continue
        for e in entries:
            if e["dir"]:
                out.append((base, e["name"], _app_meta(link, base, e["name"])))
    return out


def _resolve_installed(link, name):
    """Acha o app instalado por pasta, sufixo do packageName, nome de
    exibicao ou packageName INTEIRO ("celeros.park.entrada" funcionava so
    depois de virar a pasta — `apps run celeros.park.entrada` dizia "nao
    encontrado" com o app instalado). Devolve (base, pasta, meta) ou None."""
    want = _norm_app_name(name)
    if not want:
        return None
    for base, dirname, meta in _installed_apps(link):
        meta = meta or {}
        pkg = str(meta.get("packageName") or "")
        sufixo = pkg.rsplit(".", 1)[-1] if pkg else ""
        for cand in (dirname, sufixo, str(meta.get("name") or ""), pkg):
            if _norm_app_name(cand) == want:
                return base, dirname, meta
    return None


def _app_not_found(link, name, action="run"):
    """Mensagem que ensina a pasta REAL do app: o install usa o sufixo do
    packageName (celeros.webpass -> pasta "webpass") e `apps run NOME` olha
    a PASTA, nao o nome de exibicao ("WebPass") — o erro classico de bancada."""
    apps = _installed_apps(link)
    achado = None
    hit = _resolve_installed(link, name)
    if hit:
        achado = (hit[0], hit[1], str((hit[2] or {}).get("packageName") or ""))
    msgs = [f"app '{name}' nao encontrado em /local/apps nem /sd/apps"]
    if achado:
        base, dirname, pkg = achado
        extra = f" (packageName {pkg})" if pkg else ""
        cmd = f"celerctl apps {action} {_pc_quote(dirname)}"
        if action == "rm" and base.startswith("/sd"):
            cmd += " --sd"
        msgs.append(f"a pasta instalada e '{dirname}'{extra} — use: {cmd}")
    elif apps:
        nomes = ", ".join(sorted(d for _, d, _ in apps)[:12])
        msgs.append(f"apps instalados: {nomes}")
        msgs.append("`apps run` usa o nome da PASTA (o sufixo do packageName: "
                    "celeros.webpass -> webpass), nao o nome de exibicao")
    else:
        msgs.append("nenhum app instalado — `apps list` / `apps install PASTA`")
    die("\n  ".join(msgs))


def _rm_tree(link, path):
    if link.proto == 2:
        link.delete(path, recursive=True)  # um comando no device
        return
    for e in link.ls(path):
        rpath = f"{path}/{e['name']}"
        if e["dir"]:
            _rm_tree(link, rpath)
        else:
            link.simple("DELETE", rpath.encode() + b"\0")
    link.simple("DELETE", path.encode() + b"\0")


def _remote_tree(link, path):
    """Arvore remota como {caminho relativo: e_diretorio} (ls recursivo)."""
    out = {}
    try:
        entries = link.ls(path)
    except CelerError:
        return out
    for e in entries:
        rpath = f"{path}/{e['name']}"
        rel = rpath[len(path) + 1:]
        if e["dir"]:
            out[rel] = True
            out.update(_remote_tree(link, rpath))
        else:
            out[rel] = False
    return out


def _lint_app_folder(folder, fatal=True):
    """Lint estatico (tools/app_lint) antes de empurrar o app ao dispositivo:
    parse ES5 + checagem contra a API do firmware. Sem Node no PATH so avisa e
    segue (celerctl roda em maquinas variadas); erros abortam o install (ou
    apenas avisam com fatal=False, usado pelo loop `dev`). Retorna True se o
    app esta apto a instalar."""
    import subprocess
    lint = Path(__file__).resolve().parent / "app_lint" / "lint.js"
    if not lint.is_file():
        print("AVISO: tools/app_lint/lint.js ausente — SEM LINT (erros so aparecem no device)")
        return True
    try:
        out = subprocess.run(["node", str(lint), "--json", str(folder)],
                             capture_output=True, text=True, timeout=120)
    except FileNotFoundError:
        print("AVISO: node ausente no PATH — SEM LINT: erros de ES5/API so vao "
              "aparecer no device; instale Node ou rode tools/app_lint/lint.js na mao")
        return True
    except subprocess.TimeoutExpired:
        if fatal:
            die("lint do app demorou demais (120s)")
        print("aviso: lint do app demorou demais; instalando sem lint")
        return True
    if out.returncode == 2:
        msg = f"lint falhou: {(out.stderr or out.stdout).strip()}"
        if fatal:
            die(msg)
        print(f"aviso: {msg}")
        return False
    try:
        import json as _json
        r = _json.loads(out.stdout)
    except ValueError:
        print("aviso: saida inesperada do lint; instalando sem lint")
        return True
    diags = [d for a in r.get("apps", []) for d in a.get("diagnostics", [])]
    for d in diags:
        print(f"{d.get('severity')}: {d['file']}:{d['line']}:{d['col']} {d['message']}")
    erros = sum(1 for d in diags if d.get("severity") == "erro")
    if erros and fatal:
        die(f"{erros} erro(s) no app — corrija ou force com --pula-lint")
    return erros == 0


# Lixo de editor/SO que nao sobe para o device: o push e o watcher do dev
# usam a MESMA lista (senao o dev fica empurrando/deletando arquivo que o
# install nunca mandou)
_JUNK_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
_JUNK_SUFFIX = (".swp", ".swo", ".bak", ".tmp", "~")
# test.js e dev-only (wire do harness): o publish do hub exclui e o
# data/AGENTS.md promete que nunca embarca — o install/dev filtram igual
_DEV_ONLY = {"test.js"}


# pastas que nunca sobem: .dev (telas do `celerctl dev`, fora do git) e
# _dev (fonte dev-only VERSIONADA ao lado do app: pipeline de arte, renders
# brutos — ex. studio_games/<jogo>/_dev). O hub ja e flat (so a raiz)
_DEV_DIRS = (".dev", "_dev")


def _is_junk(p):
    name = p.name
    if any(d in p.parts for d in _DEV_DIRS):
        return True
    if name in _JUNK_NAMES or name in _DEV_ONLY or name.startswith(".#") or ".git" in p.parts:
        return True
    return name.endswith(_JUNK_SUFFIX)


def _push_app_files(link, src, dest, only=None, progress=True, verify=True):
    """Empurra os arquivos da pasta de app para <dest> no dispositivo.
    `only` limita aos caminhos relativos dados (reload do `dev`); None = tudo
    (install completo, cria a arvore de diretorios). `verify` re-le cada
    arquivo gravado (crc32): push fantasma no loop de dev vira "minha
    mudanca nao pegou" — melhor falhar aqui com a receita do que depurar
    o runtime."""
    if only is None:
        link.simple("MKDIR", dest.encode() + b"\0")
        files = [f for f in sorted(src.rglob("*"))
                 if f.is_file() and ".dev" not in f.parts and not _is_junk(f)]
        for f in files:
            rel = f.relative_to(src).parent
            if str(rel) != ".":
                d = dest + "/" + rel.as_posix()
                link.simple("MKDIR", d.encode() + b"\0")
    else:
        files = [src / rel for rel in only if (src / rel).is_file()]
    for f in files:
        dest_f = f"{dest}/{f.relative_to(src).as_posix()}"
        link.write_file(str(f), dest_f, progress=progress)
        if verify:
            link.verify_file(str(f), dest_f)
    return [f.relative_to(src).as_posix() for f in files]


def _relaunch(link, app_name):
    """Encerra o app em execucao (shell `exit`) e abre de novo (`run`).
    Firmware sem o comando `exit` apenas avisa — o run entao espera o app
    atual sair sozinho."""
    try:
        code, out = link.exec("exit")
        if code != 0:
            print(f"aviso: 'exit' recusado ({out.strip()}) — firmware antigo? "
                  "o run abre quando o app atual sair")
    except CelerError as e:
        print(f"aviso: exit falhou ({e}); tentando run mesmo assim")
    link.exec(f"run {app_name}")


def _snapshot(src):
    """Mapa caminho_relativo -> (mtime_ns, size) dos arquivos da pasta de app
    (a subpasta .dev/, onde o dev guarda screenshots, e o lixo de editor
    ficam de fora — mesma regra do _push_app_files)."""
    out = {}
    for f in src.rglob("*"):
        if f.is_file() and ".dev" not in f.parts and not _is_junk(f):
            st = f.stat()
            out[f.relative_to(src).as_posix()] = (st.st_mtime_ns, st.st_size)
    return out


def _pull_tree(link, remote_dir, local_dir):
    count = 0
    for e in sorted(link.ls(remote_dir), key=lambda e: e["name"]):
        rpath = f"{remote_dir}/{e['name']}"
        lpath = Path(local_dir) / e["name"]
        if e["dir"]:
            lpath.mkdir(parents=True, exist_ok=True)
            count += _pull_tree(link, rpath, lpath)
        else:
            lpath.parent.mkdir(parents=True, exist_ok=True)
            link.read_file(rpath, str(lpath), progress=False)
            count += 1
    return count


def cmd_dev(args):
    """Loop de desenvolvimento: instala a pasta de app, abre o app no
    dispositivo e assiste aos arquivos — a cada mudanca roda o lint, empurra
    so o que mudou, encerra o app em execucao (shell `exit`) e abre de novo,
    com os logs do dispositivo ao vivo. Ctrl-C encerra (o app segue aberto).

    Detalhes do protocolo que sustentam este loop:
      - o canal HostLink cai para CONSOLE apos 8s sem bytes DO HOST, entao o
        loop manda um HELLO de keepalive a cada 5s;
      - logs chegam como frames LOG_DATA nao-solicitados entre comandos.
    """
    src = Path(args.folder).resolve()
    if not (src / "app.json").is_file():
        die(f"{src} nao tem app.json")
    if args.baud == DEFAULT_BAUD:
        args.baud = 921600  # push/pull no dev ganham muito; -b explicito vence

    base = "/sd/apps" if args.sd else "/local/apps"
    dest = f"{base}/{src.name}"
    shots_dir = src / ".dev"

    link = open_link(args)
    state = {}
    last_keepalive = time.monotonic()
    print(f"dev: {src} -> {dest} (Ctrl-C para sair)")
    try:
        link.logcat_on()
        first = True
        while True:
            snap = _snapshot(src)
            primeira = first
            if first:
                first = False
                changed = sorted(snap)  # primeira passada: instala tudo
            else:
                changed = [rp for rp, sig in snap.items() if state.get(rp) != sig]
            removed = [rp for rp in state if rp not in snap]
            if changed or removed:
                stamp = time.strftime("%H:%M:%S")
                print(f"\n== [{stamp}] mudou: {', '.join(changed + removed)}")
                for rp in removed:
                    link.simple("DELETE", f"{dest}/{rp}".encode() + b"\0")
                    state.pop(rp, None)
                ok = args.no_lint or _lint_app_folder(src, fatal=False)
                if ok:
                    sent = _push_app_files(link, src, dest, only=changed or None,
                                           progress=False, verify=not args.pula_verify)
                    for rp, sig in snap.items():
                        if rp in sent:
                            state[rp] = sig
                    if primeira or "app.json" in changed:
                        # deps antes do relaunch: o require le deps.json no
                        # load do app e nao ha segunda chance
                        _sync_app_deps(link, src, dest, args)
                    if any(rp == "app.json" or rp.endswith(".bin") or rp.endswith(".png")
                           for rp in changed):
                        link.exec("rescan")
                    _relaunch(link, src.name)
                    if args.shots:
                        time.sleep(1.0)  # rescan+launch assincronos: da a largada
                        _dev_screenshot(link, shots_dir)
                else:
                    print("== lint com erros; corriga e salve para tentar de novo")
                    # assume estado atual mesmo assim (nao reenvia ate mudar)
                    for rp in changed:
                        state[rp] = snap.get(rp)
                print("== aguardando mudancas...", flush=True)

            # drena logs acumulados durante os comandos acima
            while link.push_queue:
                cmd, payload = link.push_queue.pop(0)
                if cmd == KL["LOG_DATA"]:
                    sys.stdout.write(payload[1:].decode("utf-8", "replace"))
            sys.stdout.flush()

            # logs ao vivo + keepalive do canal (idle de 8s no firmware)
            try:
                cmd, payload = link._read_frame(timeout=0.3)
                if cmd == KL["LOG_DATA"]:
                    sys.stdout.write(payload[1:].decode("utf-8", "replace"))
                    sys.stdout.flush()
            except CelerError:
                pass  # sem frame neste tick
            if time.monotonic() - last_keepalive > 5.0:
                last_keepalive = time.monotonic()
                try:
                    link.keepalive()  # HELLO no formato da sessao (v2 cai para v1 se vier)
                except (CelerError, serial.SerialException):
                    print("\ndev: conexao caiu (placa reiniciou?); tentando reconectar...")
                    link = _reconnect(link)
                    link.logcat_on()
                    _relaunch(link, src.name)
    except KeyboardInterrupt:
        print("\ndev: encerrando (app segue aberto no dispositivo)")
    finally:
        try:
            link.logcat_off()
        except Exception:
            pass
        link.close()


def _reconnect(old):
    """Reabre a porta apos a conexao cair (placa reiniciou)."""
    port = old.ser.port
    baud = old.ser.baudrate
    old.close()
    for _ in range(20):  # ~20s: boot + montagens
        time.sleep(1.0)
        try:
            link = HostLink(port, timeout=3.0)
            link.hello()
            if baud is not None and baud != DEFAULT_BAUD:
                link.set_baud(baud)
            print("dev: reconectado")
            return link
        except PORT_GONE + (CelerError,):
            continue
    die("dev: nao conseguiu reconectar")


def _dev_screenshot(link, shots_dir, settle_timeout=5.0):
    """Captura a tela DEPOIS dela parar de mudar: duas capturas consecutivas
    identicas fecham o poll (o fixo de 2.5s pegava tela de transicao do
    rescan/launch e app lento de boot saia furado). Teto de settle_timeout —
    relogio da topbar piscando nao segura o loop para sempre."""
    shots_dir.mkdir(exist_ok=True)
    out = shots_dir / "last.png"
    t0 = time.monotonic()
    last = None
    size = None
    try:
        while True:
            w, h, data = link.screenshot()
            size = (w, h)
            if data == last or time.monotonic() - t0 >= settle_timeout:
                break
            last = data
        from PIL import Image
        w, h = size
        pixels = struct.unpack(f"<{w * h}H", data)
        rgb = bytearray(w * h * 3)
        for i, p in enumerate(pixels):
            rgb[i * 3] = ((p >> 8) & 0xF8) | (p >> 13)
            rgb[i * 3 + 1] = ((p >> 3) & 0xFC) | ((p >> 9) & 0x03)
            rgb[i * 3 + 2] = (p << 3) & 0xF8 | ((p >> 2) & 0x07)
        Image.frombytes("RGB", (w, h), bytes(rgb)).save(out)
        print(f"== tela: {out} ({w}x{h}, estabilizou em {time.monotonic() - t0:.1f}s)")
    except ImportError:
        print("== tela: pip install Pillow para --shots")
    except CelerError as e:
        print(f"== tela: falhou ({e})")


def _local_sdk_deps():
    """Modulos do tools/sdk/engine como entradas de indice {nome: {versao:
    {"_local": caminho}}} — a versao sai do `version: 'x.y.z'` (ou
    `E.version = 'x.y.z'`) do proprio modulo (o mesmo que o publish-dep
    le). As arestas de deps do index.json entram junto: a familia
    CelerGame se compoe (celeros.engine require celeros.game*), o mesmo
    grafo que o publish-dep declara com --dep."""
    out = {}
    eng = Path(__file__).resolve().parent / "sdk" / "engine"
    edges = {}
    idx = eng / "index.json"
    if idx.is_file():
        try:
            edges = json.loads(idx.read_text(encoding="utf-8"))
        except ValueError:
            edges = {}
    for js in sorted(eng.glob("*.js")):
        m = re.search(r"version\s*[:=]\s*['\"](\d+\.\d+\.\d+)['\"]", js.read_text(encoding="utf-8"))
        if m:
            deps = (edges.get(js.stem) or {}).get("deps") or {}
            out.setdefault(js.stem, {})[m.group(1)] = {"_local": str(js), "deps": deps}
    return out


def _push_dep_module(link, name, ver, meta, hub="", token=""):
    """Baixa (ou tira do SDK local, meta["_local"]) o modulo <name> <ver> e
    poe no cache /local/modules com escrita verificada por releitura (crc32):
    /local/modules e o caminho mais historico de push fantasma (cache
    compartilhado entre apps — um modulo servindo lixo quebra todo mundo que
    o require)."""
    import celerhub
    if meta.get("_local"):
        # enxuto como o publish-dep sobe (jsstrip): o aparelho recebe
        # o mesmo arquivo que viria do hub
        print(f"dep {name} {ver}: do SDK local (tools/sdk/engine)")
        blob = celerhub.strip_js(Path(meta["_local"]))
    else:
        print(f"dep {name} {ver}: baixando do hub...")
        req = _urlreq.Request(_hub_url(hub, meta["url"], token),
                              headers={"User-Agent": "celerosctl/1.0"})
        with _urlreq.urlopen(req, timeout=30) as resp:
            blob = resp.read()
        if meta.get("md5") and hashlib.md5(blob).hexdigest() != meta["md5"]:
            die(f"dep {name} {ver}: md5 divergente do indice do hub")
    mod_dir = f"/local/modules/{name}/{ver}"
    for d in (f"/local/modules", f"/local/modules/{name}", mod_dir):
        try:
            link.simple("MKDIR", d.encode() + b"\0")
        except CelerError:
            pass  # ja existe
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / f"{name}.js"
        tmp.write_bytes(blob)
        # o cache e versionado (nome/versao): reinstalar um app quase sempre
        # acha o modulo JA la. A releitura com crc32 (a mesma da verificacao)
        # custa metade do push e poupa a escrita na flash — o install da
        # Lenda empurrava as ~18 deps inteiras a cada vez
        try:
            link.verify_file(str(tmp), f"{mod_dir}/{name}.js")
            print(f"dep {name} {ver}: ja no cache do device ({len(blob)} B, conferida)")
            return
        except CelerError:
            pass  # ausente ou diferente: escreve
        link.write_file(str(tmp), f"{mod_dir}/{name}.js")
        link.verify_file(str(tmp), f"{mod_dir}/{name}.js")
    print(f"dep {name} {ver}: no cache do device ({len(blob)} B, verificada)")


def _install_shared_deps(link, deps, hub, local=False, token=""):
    """Deps compartilhadas (API 30): resolve os ranges contra o indice do
    hub (mesma semantica do celerhub.py), baixa cada modulo no PC e empurra
    para /local/modules/<nome>/<versao>/ — o cache publico do require.
    Devolve {nome: versao} resolvido (o chamador grava o deps.json na
    pasta do app)."""
    import celerhub  # mesma pasta tools/; so funcoes, main() e guardado
    try:
        status, idx = celerhub.http("GET", _hub_url(hub, "/store/deps.json", token))
    except (Exception, SystemExit) as e:  # noqa: BLE001 — offline vale com --deps-local
        # celerhub.http falha de rede com die() (SystemExit): so Exception
        # deixava o fallback do --deps-local morto (offline abortava)
        if not local:
            raise
        print(f"deps: hub indisponivel ({e}); so as do SDK local")
        idx = None
    index = (idx or {}).get("deps", {})
    if local:
        # --deps-local: as versoes do tools/sdk/engine entram no indice; a
        # resolucao segue a mesma (maior que satisfaz), entao a dep do repo
        # vence quando e mais nova que a do hub — testar engine/physics no
        # aparelho antes do publish-dep sem montar um hub falso
        for name, vers in _local_sdk_deps().items():
            for ver, meta in vers.items():
                index.setdefault(name, {}).setdefault(ver, meta)
    if not index:
        die(f"deps: indice do hub indisponivel ({hub}/store/deps.json)")
    resolved = celerhub.resolve_dep_ranges(deps, index)
    for name, ver in resolved.items():
        _push_dep_module(link, name, ver, index[name][ver], hub=hub, token=token)
    return resolved


def _poda_raizes(stale, remote):
    """So as RAIZES do que a poda apaga (logica pura, testavel no host): dir
    obsoleto sai inteiro (delete recursivo) e os filhos dele nao viram
    tentativa. Apagar o dir primeiro e depois cada filho ja inexistente
    contava como "falha" — o install do Detona dizia "30 removidos; 29
    falharam" com a poda perfeita, e o aviso parecia apontar a assets/.
    `remote` = {caminho relativo: e_diretorio}."""
    raizes = []
    for rel in sorted(stale):
        if not any(rel.startswith(r + "/") for r in raizes if remote[r]):
            raizes.append(rel)
    return raizes


def _gc_plan(modules, refs):
    """Plano de GC do cache /local/modules (logica pura, testavel no host).
    `modules` = {nome: {versao: tamanho}} (arvore lida no device);
    `refs` = {app: {nome: versao}} (deps.json de cada app instalado).
    Devolve (orfas, ausentes, em_uso):
      orfas   = [(nome, versao)] instalado sem NENHUM app apontando
      ausentes= [(app, nome, versao)] referenciado e fora do cache
      em_uso  = [(nome, versao)] referenciado por pelo menos um app
    """
    used = {}
    for deps in refs.values():
        for name, ver in deps.items():
            used.setdefault(name, set()).add(ver)
    installed = {(n, v) for n, vers in modules.items() for v in vers}
    orfas = sorted(p for p in installed if p[1] not in used.get(p[0], set()))
    ausentes = sorted((app, n, v) for app, deps in refs.items()
                      for n, v in deps.items() if v not in modules.get(n, {}))
    return orfas, ausentes, sorted(installed - set(orfas))


def _read_remote_json(link, path, teto=16384):
    """Le um JSON pequeno no device (deps.json: fecho de ate 32 deps, 1-2 KB;
    app.json com changelog fica perto de 16 KB); None se ausente/invalido.
    Acima do teto NAO le, mas AVISA: em silencio o chamador tratava o app
    como sem refs e o GC via celerctl marcava orfas falsas no cache todo."""
    try:
        st = link.stat(path)
    except CelerError:
        return None
    if st is None or st["dir"]:
        return None
    if st["size"] > teto:
        print(f"! {path}: {st['size']} B acima do teto de leitura ({teto} B) "
              f"— arquivo ignorado")
        return None
    raw = b""
    while len(raw) < st["size"]:
        chunk = link.read_chunk(path, len(raw), min(CHUNK, st["size"] - len(raw)))
        if not chunk:
            return None
        raw += chunk
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return None


def _modules_tree(link):
    """{nome: {versao: tamanho_do_js}} lido de /local/modules; {} se o cache
    ainda nao existe (app sem deps instalado)."""
    tree = {}
    try:
        names = link.ls("/local/modules")
    except CelerError:
        return tree
    for n in names:
        if not n["dir"]:
            continue
        try:
            versions = link.ls(f"/local/modules/{n['name']}")
        except CelerError:
            continue
        for v in versions:
            if not v["dir"]:
                continue
            js = f"/local/modules/{n['name']}/{v['name']}/{n['name']}.js"
            size = None
            try:
                st = link.stat(js)
                if st is not None and not st["dir"]:
                    size = st["size"]
            except CelerError:
                pass
            tree.setdefault(n["name"], {})[v["name"]] = size
    return tree


def _engine_deploy_bytes(path):
    """Bytes CANONICOS de um modulo do repo para o cache do device: o fonte
    enxuto do jsstrip — o mesmo arquivo que o publish-dep sobe para o hub e
    que o `apps install --deps-local` grava. push-dep e deps-status usam ESTA
    forma: comparar (ou gravar) o cru do repo chamaria de DRIFT um cache
    instalado direitinho pelo caminho normal (o enxuto e ~metade do cru)."""
    import celerhub
    try:
        return celerhub.strip_js(Path(path))
    except (SystemExit, OSError, ValueError):
        # node/jsstrip indisponivel ou fonte que nao passa: compara/empurra o
        # cru — push-dep e deps-status seguem CONSISTENTES entre si do mesmo
        # jeito (o JS com comentarios e legal para o Duktape)
        return Path(path).read_bytes()


def _apps_push_dep(link, args):
    """Deploy de uma dep do repo (tools/sdk/engine) direto no cache de modulos
    do device (/local/modules/<dep>/<ver>/), na forma canonica (enxuto do
    jsstrip, igual ao que o hub/publish entrega). O caminho da noite dos
    "blocos pretos": o fix da engine tinha que chegar ao aparelho e o push
    manual exigia saber o caminho de cabeca. Relance o app depois (apps run)."""
    repo = Path(__file__).resolve().parent / "sdk" / "engine" / f"{args.name}.js"
    if not repo.is_file():
        die(f"dep nao encontrada no repo: {repo}")
    base = f"/local/modules/{args.name}"
    try:
        vers = [e["name"] for e in link.ls(base) if e["dir"]]
    except CelerError:
        vers = []
    if not vers:
        die(f"{base} nao existe no device (instale um app que usa a dep)")
    ver = args.ver or (vers[0] if len(vers) == 1 else None)
    if ver is None:
        die(f"varias versoes no cache ({', '.join(sorted(vers))}): use --ver")
    if ver not in vers:
        die(f"versao {ver} nao esta no cache (existentes: {', '.join(sorted(vers))})")
    dst = f"{base}/{ver}/{args.name}.js"
    blob = _engine_deploy_bytes(repo)
    with tempfile.NamedTemporaryFile(delete=False) as tf:
        tf.write(blob)
        tmp = tf.name
    try:
        link.write_file(tmp, dst)
        link.verify_file(tmp, dst)
    finally:
        Path(tmp).unlink(missing_ok=True)
    print(f"push-dep {args.name} {ver}: verificado -> {dst} ({len(blob)} B)")


def _apps_deps_status(link, args):
    """Drift repo x DEVICE do cache de dependencias: tamanho e crc32 do arquivo
    no aparelho contra o tools/sdk/engine do repo para a MESMA versao (na forma
    canonica — o enxuto do jsstrip, que e o que o hub/publish/install grava).
    A versao da engine nao bumpou numa tarde inteira de mudancas e o 4848
    rodou um celeros.game '1.0.0' velho por horas (bug dos blocos pretos) sem
    nada apontar a divergencia."""
    engine = Path(__file__).resolve().parent / "sdk" / "engine"
    try:
        deps = sorted(e["name"] for e in link.ls("/local/modules") if e["dir"])
    except CelerError:
        die("/local/modules nao existe neste device")
    if not deps:
        print("cache de deps vazio")
        return
    drift = 0
    print(f"{'dep':<22} {'ver':<8} {'device':>10} {'repo':>10}  veredito")
    for dep in deps:
        for v in sorted(e["name"] for e in link.ls(f"/local/modules/{dep}") if e["dir"]):
            remote = f"/local/modules/{dep}/{v}/{dep}.js"
            local = engine / f"{dep}.js"
            try:
                entries = link.ls(f"/local/modules/{dep}/{v}")
                dev_b = next((e["size"] for e in entries if e["name"] == f"{dep}.js"), None)
            except CelerError:
                dev_b = None
            if dev_b is None:
                print(f"{dep:<22} {v:<8} {'?':>10} {'':>10}  SEM O ARQUIVO NO CACHE")
                continue
            if not local.is_file():
                print(f"{dep:<22} {v:<8} {dev_b:>10} {'':>10}  sem no repo")
                continue
            # crc do lado do device: le o arquivo e confere (37 KB pela serial ~1 s)
            with tempfile.NamedTemporaryFile(delete=False) as tf:
                tmp = tf.name
            try:
                link.read_file(remote, tmp, progress=False)
                dev_crc = zlib.crc32(Path(tmp).read_bytes()) & 0xFFFFFFFF
            except CelerError as e:
                dev_crc = None
                erro_leitura = str(e)
            finally:
                Path(tmp).unlink(missing_ok=True)
            rep_blob = _engine_deploy_bytes(local)
            rep_b = len(rep_blob)
            rep_crc = zlib.crc32(rep_blob) & 0xFFFFFFFF
            if dev_crc is None:
                # leitura falhou (conexao caiu no meio): NAO e drift nem da
                # para cravar igualdade — antes aqui crashava no {None:08x}
                print(f"{dep:<22} {v:<8} {dev_b:>10} {rep_b:>10}  FALHA NA LEITURA ({erro_leitura})")
                continue
            if dev_crc == rep_crc:
                vdt = "ok"
            else:
                vdt = f"DRIFT (crc {dev_crc:08x} x {rep_crc:08x}) — push-dep {dep}"
                drift += 1
            print(f"{dep:<22} {v:<8} {dev_b:>10} {rep_b:>10}  {vdt}")
    if drift:
        print(f"\ndrift: {drift} arquivo(s) — apps push-dep <dep> [--ver V] + apps run <app>")
    else:
        print("\ncache em sincronia com o repo")


def _apps_installzip(link, args):
    """apps installzip: sobe o pacote unico .zip e instala com o comando
    `installzip` do shell (extracao com tetos + troca com rollback no
    device). O nome da pasta vem do campo name do app.json (convencao do
    launcher: nome da pasta = display name), a menos que venha na linha."""
    zp = Path(args.zipfile)
    if not zp.is_file():
        die(f"{zp} nao existe")
    import zipfile
    meta = {}
    try:
        with zipfile.ZipFile(zp) as z:
            meta = json.loads(z.read("app.json").decode("utf-8"))
    except (KeyError, ValueError, OSError, zipfile.BadZipFile) as e:
        if not args.name:
            die(f"zip sem app.json valido: {e}")
    nome = args.name or str(meta.get("name") or "")
    if not nome or "/" in nome or "\\" in nome or ".." in nome or len(nome) > 40:
        die(f"nome de pasta invalido: {nome!r}")
    remote = "/local/celeros_install.zip"
    link.write_file(str(zp), remote)
    link.verify_file(str(zp), remote)
    rc, out = link.exec(f"installzip {remote} {nome}")
    try:
        link.exec(f"rm {remote}")
    except CelerError:
        pass
    print(out.rstrip())
    if rc != 0:
        die(f"installzip falhou no device (rc={rc})")
    # O installzip nativo e dep-cego (AppPackage nao toca em /local/modules
    # nem grava deps.json): resolve no PC e grava o lock no destino — sem
    # ele o require do app nao acha o cache no primeiro run.
    if meta.get("deps"):
        hub = (os.environ.get("CELER_HUB") or "https://os.celer.tec.br").rstrip("/")
        dest = f"/local/apps/{nome}"
        resolved = _install_shared_deps(link, meta["deps"], hub, local=False)
        with tempfile.TemporaryDirectory() as td:
            dj = Path(td) / "deps.json"
            dj.write_text(json.dumps(resolved), encoding="utf-8")
            link.write_file(str(dj), f"{dest}/deps.json")
            link.verify_file(str(dj), f"{dest}/deps.json")
        print(f"deps: {len(resolved)} modulo(s) no cache + {dest}/deps.json")
    print(f"instalado: /local/apps/{nome} (rescan pedido)")
    # a pasta e o que `apps run` acha — o packageName pode ter sufixo
    # diferente do nome de exibicao (celeros.webpass -> "WebPass" no zip)
    pkg = str(meta.get("packageName") or "")
    sufixo = pkg.rsplit(".", 1)[-1] if pkg else ""
    if sufixo and sufixo != nome:
        print(f"nota: packageName {pkg}; a pasta no device e '{nome}' — "
              f"para abrir: celerctl apps run {_pc_quote(nome)}")
    else:
        print(f"para abrir: celerctl apps run {_pc_quote(nome)}")


def _apps_deps(link, args):
    """apps deps: o que vive no cache publico /local/modules, quem usa e o
    que sobrou sem dono (versoes antigas acumulam para sempre sem isso).
    --gc --yes remove as orfas."""
    modules = _modules_tree(link)
    if not modules:
        print("cache de deps vazio (nenhum app com deps instalado)")
        return
    refs = {}
    for base in ("/local/apps", "/sd/apps"):
        try:
            apps = link.ls(base)
        except CelerError:
            continue
        for a in apps:
            if not a["dir"]:
                continue
            deps = _read_remote_json(link, f"{base}/{a['name']}/deps.json")
            if isinstance(deps, dict) and deps:
                refs[a["name"]] = {str(n): str(v) for n, v in deps.items()}
    orfas, ausentes, em_uso = _gc_plan(modules, refs)
    users = {}
    for app, deps in refs.items():
        for n, v in deps.items():
            users.setdefault((n, v), []).append(app)
    for name in sorted(modules):
        for ver in sorted(modules[name]):
            size = modules[name][ver]
            quem = users.get((name, ver))
            if quem:
                print(f"{name} {ver:<10} {str(size or '?'):>8} B  em uso: {', '.join(sorted(quem))}")
            else:
                print(f"{name} {ver:<10} {str(size or '?'):>8} B  ORFA (nenhum app aponta)")
    for app, n, v in ausentes:
        print(f"! {app} quer {n} {v} e ela NAO esta no cache — reinstale o app")
    if ausentes:
        print("(deps ausentes voltam com `apps install` do app que as pede)")
    if not orfas and not ausentes:
        total = sum(s or 0 for vers in modules.values() for s in vers.values())
        print(f"({len(em_uso)} versoes em uso, {total} B no cache — nada a fazer)")
        return
    if args.gc:
        if not args.yes:
            die("apps deps --gc remove versoes orfas do device; confirme com --yes")
        removed = 0
        for name, ver in orfas:
            link.delete(f"/local/modules/{name}/{ver}", recursive=True)
            print(f"removida: {name} {ver}")
            removed += 1
            # nome sem versoes sobrando: tira a pasta vazia junto
            if set(modules.get(name, {})) == {ver}:
                try:
                    link.delete(f"/local/modules/{name}", recursive=True)
                except CelerError:
                    pass
        print(f"gc: {removed} versao(oes) orfa(s) removida(s) de /local/modules")
    else:
        print(f"({len(orfas)} orfa(s); limpe com: apps deps --gc --yes)")


def _apps_deps_upgrade(link, args):
    """apps deps --upgrade: re-resolve as deps de CADA app instalado contra
    o indice ATUAL do hub (maior satisfazendo; o caret nunca pula major),
    poe os modulos novos no cache e regrava o deps.json de cada app. E o
    `pub upgrade` do device: sem isso as versoes congeladas no install so
    saiam da estiva abrindo a Loja (fluxo 'Atualizar engine'). Nao destrói
    nada — versao velha fica no cache ate o GC recolher."""
    import celerhub
    hub = (os.environ.get("CELER_HUB") or "https://os.celer.tec.br").rstrip("/")
    try:
        status, idx = celerhub.http("GET", f"{hub}/store/deps.json")
    except Exception as e:  # noqa: BLE001
        die(f"deps: indice do hub indisponivel ({e})")
    index = (idx or {}).get("deps", {})
    if not index:
        die(f"deps: indice vazio ({hub}/store/deps.json)")
    mods = _modules_tree(link)
    planos = []    # (app, base, lock_atual, novo)
    pendentes = {}  # (nome, versao) -> meta (baixa 1x mesmo com N apps)
    for base in ("/local/apps", "/sd/apps"):
        try:
            apps = link.ls(base)
        except CelerError:
            continue  # /sd sem cartao
        for a in apps:
            if not a["dir"]:
                continue
            meta = _read_remote_json(link, f"{base}/{a['name']}/app.json")
            if not isinstance(meta, dict) or not meta.get("deps"):
                continue
            try:
                novo = celerhub.resolve_dep_ranges(meta["deps"], index)
            except SystemExit as e:
                # resolve_dep_ranges die() com o motivo; o app fica de fora
                # da rodada (lock atual continua valendo) sem abortar os outros
                print(f"! {a['name']}: {e}")
                continue
            atual = _read_remote_json(link, f"{base}/{a['name']}/deps.json")
            atual = {str(k): str(v) for k, v in atual.items()} \
                if isinstance(atual, dict) else {}
            planos.append((a["name"], base, atual, novo))
            for n, v in novo.items():
                if mods.get(n, {}).get(v) is None:
                    if n not in index or v not in index[n]:
                        die(f"dep {n} {v}: indice do hub sem o arquivo")
                    pendentes[(n, v)] = index[n][v]
    if not planos:
        print("nenhum app com deps instalado")
        return
    for (n, v), meta in sorted(pendentes.items()):
        _push_dep_module(link, n, v, meta)
    alterados = 0
    for app, base, atual, novo in planos:
        if atual == novo:
            print(f"{app}: em dia ({len(novo)} dep(s))")
            continue
        diffs = [f"{n} {atual.get(n, '-')}>{v}"
                 for n, v in sorted(novo.items()) if atual.get(n) != v]
        with tempfile.TemporaryDirectory() as td:
            dj = Path(td) / "deps.json"
            dj.write_text(json.dumps(novo), encoding="utf-8")
            link.write_file(str(dj), f"{base}/{app}/deps.json")
            link.verify_file(str(dj), f"{base}/{app}/deps.json")
        print(f"{app}: {'; '.join(diffs)}")
        alterados += 1
    if not pendentes and not alterados:
        print("todos os apps em dia com o hub")


def _apps_run(link, args):
    """apps run: abre um app instalado pelo nome da pasta (exit + run; o
    nome vai re-juntado no device, espaco nao precisa de aspas)."""
    target = None
    for candidate_base in ("/local/apps", "/sd/apps"):
        st = link.stat(f"{candidate_base}/{args.name}")
        if st is not None and st["dir"]:
            target = f"{candidate_base}/{args.name}"
            break
    if target is None:
        hit = _resolve_installed(link, args.name)
        if hit:
            # o exit/run do device falam com a PASTA: troca o nome resolvido
            args.name = hit[1]
            target = f"{hit[0]}/{hit[1]}"
    if target is None:
        _app_not_found(link, args.name, "run")
    _relaunch(link, args.name)
    print(f"abrindo: {target}")


def _sd_note(montado, apps_ok):
    """Rodape da origem SD: "sem cartao" (raiz /sd ausente) nao e o mesmo
    caso de "montado sem /sd/apps" (o 4848 vive montado e vazio) — a
    mensagem certa poupa o debug do falso-positivo (2026-10-09)."""
    if apps_ok:
        return ""
    if not montado:
        return " — sd: sem cartao"
    return " — sd: montado, /sd/apps ausente (apps install --sd cria)"


def cmd_apps(args):
    link = open_link(args)
    try:
        if args.action == "list":
            found = []
            sd_montado = False
            sd_apps_ok = False
            sd_root = None
            try:
                sd_root = link.stat("/sd")
            except CelerError:
                pass
            sd_montado = bool(sd_root and sd_root["dir"])
            for base in ("/local/apps", "/sd/apps"):
                try:
                    entries = link.ls(base)
                except CelerError:
                    continue  # /sd sem cartao ou /sd/apps ausente
                sd_apps_ok = sd_apps_ok or base.startswith("/sd")
                for e in entries:
                    if not e["dir"]:
                        continue
                    meta = _app_meta(link, base, e["name"]) or {"name": e["name"], "_base": base}
                    found.append(meta)
            if not found:
                print("nenhum app instalado" + _sd_note(sd_montado, sd_apps_ok))
                return
            # sombreado local/SD: o launcher deduplica pelo packageName
            # (fallback nome) e a copia LOCAL vence — a copia do cartao
            # sombreada continua na listagem, mas marcada: editar la e
            # "nao pegar" e o classico (bancada 2026-10-09)
            def _chave(m):
                return m.get("packageName") or m.get("_dir") or m.get("name", "?")
            locais = {_chave(m) for m in found if m["_base"].startswith("/local")}
            found.sort(key=lambda m: (not m.get("system"), m.get("name", "").lower()))
            tag_width = 7
            n_local = n_sd = 0
            sombreada = False
            for m in found:
                sd = m["_base"].startswith("/sd")
                n_local += not sd
                n_sd += sd
                onde = "sd" if sd else "local"
                if sd and _chave(m) in locais:
                    onde += " *"
                    sombreada = True
                nome = m.get("name", "?")
                extra = " [sistema]" if m.get("system") else ""
                pkg = m.get("packageName") or m.get("_dir") or nome
                print(f"{onde:<{tag_width}} {nome:<18} v{m.get('version', '?'):<10} "
                      f"api {m.get('api', '?'):<4}{pkg}{extra}")
            rodape = f"({len(found)} apps: local {n_local}, sd {n_sd})" + _sd_note(sd_montado, sd_apps_ok)
            print(rodape)
            if sombreada:
                print("* sombreada: a copia em /local/apps e a que abre")
        elif args.action == "install":
            _install_app_folder(link, Path(args.folder).resolve(), args)
        elif args.action == "store":
            _apps_store(link, args)
        elif args.action == "pull":
            # procura o app em /local/apps e depois /sd/apps
            target = None
            for candidate_base in ("/local/apps", "/sd/apps"):
                st = link.stat(f"{candidate_base}/{args.name}")
                if st is not None and st["dir"]:
                    target = f"{candidate_base}/{args.name}"
                    break
            if target is None:
                _app_not_found(link, args.name, "pull")
            out_dir = Path(args.dest) if args.dest else Path(args.name)
            if out_dir.exists() and any(out_dir.iterdir()):
                die(f"{out_dir} ja existe e nao esta vazia")
            out_dir.mkdir(parents=True, exist_ok=True)
            n = _pull_tree(link, target, out_dir)
            print(f"baixado: {target} -> {out_dir} ({n} arquivos)")
        elif args.action == "rm":
            base = "/sd/apps" if args.sd else "/local/apps"
            target = f"{base}/{args.name}"
            st = link.stat(target)
            if st is None or not st["dir"]:
                _app_not_found(link, args.name, "rm")
            meta = _app_meta(link, base, args.name)
            if meta and meta.get("system") and not args.force:
                die(f"'{args.name}' e app do sistema; use --force para remover")
            _rm_tree(link, target)
            link.exec("rescan")
            print(f"removido: {target}")
        elif args.action == "installzip":
            _apps_installzip(link, args)
        elif args.action == "deps":
            if args.upgrade:
                _apps_deps_upgrade(link, args)
            else:
                _apps_deps(link, args)
        elif args.action == "push-dep":
            _apps_push_dep(link, args)
        elif args.action == "deps-status":
            _apps_deps_status(link, args)
        elif args.action == "run":
            _apps_run(link, args)
    finally:
        link.close()


# ---------------------------------------------------------------------- main

def build_parser():
    parser = argparse.ArgumentParser(prog="celerctl", description="ferramenta USB do CelerOS (estilo adb)")
    parser.add_argument("-p", "--port",
                        help="porta serial do canal celerctl (ex: /dev/ttyUSB0), "
                             "prefixo do serial USB da placa ou IP do Celer Debug "
                             "Bridge (celerctl devices lista os tres)")
    parser.add_argument("--token", default=None,
                        help="token do Celer Debug Bridge (default: env "
                             "CELEROS_BRIDGE_TOKEN ou o cache do 'celerctl pair')")
    parser.add_argument("-b", "--baud", type=int, default=DEFAULT_BAUD,
                        help="negocia este baud com o firmware (ex: 921600 acelera push/pull)")
    parser.add_argument("--linhas-baixas", dest="low_lines", action="store_true",
                        help="abre a serial com DTR/RTS em 0 (adaptadores que seguram o EN/IO0, "
                             "ex.: esp32-cam no CH340 clone); a 1a abertura reseta a placa")
    parser.add_argument("--proto", type=int, choices=(1, 2), default=2,
                        help="forca o formato do protocolo (default 2 = CRC32 + janela;"
                             " 1 valida o caminho legado)")
    parser.add_argument("--win", type=int, default=0,
                        help="limita a janela de chunks anunciada pelo firmware (0 = usa"
                             " a anunciada). Use 2 para atualizar por OTA um firmware"
                             " cuja janela transborda o buffer RX do proprio device")
    parser.add_argument("--exec-timeout", type=float, default=15.0, metavar="S",
                        help="teto de espera por comando shell em segundos, para saida"
                             " grande (default 15)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("res", help="recursos da matilha pelo cabo (gateway USB, Onda B)")
    p.set_defaults(func=cmd_res)
    rr = p.add_subparsers(dest="res_cmd", required=True)
    rr.add_parser("ls", help="identidade do gateway + catalogo local e da malha")
    p = rr.add_parser("relay", help="aciona um rele LOCAL do gateway")
    p.add_argument("nome", help='"rele1".. (o do catalogo)')
    p.add_argument("op", choices=("on", "off", "state"))
    p.add_argument("-n", "--no", default=None, metavar="NO",
                   help="rele de OUTRO no da matilha (id A1B2 ou nome; o gateway abre por procuracao)")
    p.add_argument("--segura", type=int, default=0, metavar="S",
                   help="mantem a sessao N s (auto-KEEP do gateway; ao soltar, auto-off)")
    p = rr.add_parser("snap", help="foto da camera de OUTRO no (procuracao do gateway)")
    p.add_argument("-n", "--no", required=True, metavar="NO", help="id A1B2 ou nome do no com camera")
    p.add_argument("saida", nargs="?", default="foto.jpg")
    p.add_argument("-q", type=int, default=12, help="qualidade JPEG 5..63 (menor = melhor)")
    p = rr.add_parser("rec", help="grava o mic de OUTRO no (WAV 16 kHz)")
    p.add_argument("-n", "--no", required=True, metavar="NO")
    p.add_argument("segundos", type=int, help="1..10")
    p.add_argument("saida", nargs="?", default="mic.wav")
    p = rr.add_parser("play", help="toca um WAV no alto-falante de OUTRO no (ate 30 s)")
    p.add_argument("-n", "--no", required=True, metavar="NO")
    p.add_argument("arquivo", help="WAV PCM 8/16 bits, qualquer taxa (vira 16 kHz mono)")
    p = rr.add_parser("sensor", help="assina um sensor LOCAL do gateway")
    p.add_argument("nome", help='"lum", "bat" (o do catalogo)')
    p.add_argument("rate", type=int, nargs="?", default=0, help="ms entre amostras (0 = por pedido)")
    p.add_argument("segundos", type=int, nargs="?", default=10)
    p = rr.add_parser("pulse", help="pulso no rele (liga e desliga sozinho, API 47)")
    p.add_argument("nome", help='"rele1"..')
    p.add_argument("ms", type=int, help="duracao do pulso (1..65535 ms)")
    p.add_argument("-n", "--no", default=None, metavar="NO",
                   help="rele de OUTRO no (procuracao do gateway)")
    p = rr.add_parser("pwm", help="PWM num pino livre do gateway (API 47, LEDC)")
    p.add_argument("pino", type=int)
    p.add_argument("pct", type=int, help="0..100")
    p.add_argument("--segura", type=int, default=0, metavar="S",
                   help="mantem o PWM N s (default 2)")
    p = rr.add_parser("rule", help="reflexos nativos do gateway (API 47, NVS)")
    p.add_argument("rule_args", nargs=argparse.REMAINDER,
                   help="ls | add <sensor> <gt|lt> <valor> <h> <no|local> <alvo> <on|off> | "
                        "notify <sensor> <gt|lt> <valor> <h> <texto> | del <id>")
    p = rr.add_parser("acl", help="ACL por recurso (API 47): quem pode abrir no gateway")
    p.add_argument("acl_args", nargs=argparse.REMAINDER,
                   help="ls | <recurso> open | <recurso> list <id>... | <recurso> del <id>")
    p = rr.add_parser("open", help="abre um recurso local (opts = JSON do schema)")
    p.add_argument("nome")
    p.add_argument("opts", nargs="?", default=None)
    p = rr.add_parser("write", help="DATA cru na sessao (\\xNN para bytes)")
    p.add_argument("sid", type=int)
    p.add_argument("dados")
    p = rr.add_parser("read", help="espera um RES_DATA da sessao")
    p.add_argument("sid", type=int)
    p.add_argument("--timeout", type=float, default=3.0)
    p = rr.add_parser("close", help="fecha a sessao")
    p.add_argument("sid", type=int)
    p.set_defaults(func=cmd_res)

    p = sub.add_parser("mesh", help="a matilha pelo cabo: status, join, leave (API 40)")
    p.set_defaults(func=cmd_mesh)
    p.add_argument("--json", action="store_true", help="status cru em JSON")
    mm = p.add_subparsers(dest="mesh_cmd", required=True)
    mm.add_parser("status", help="matilha do gateway, id e o id do PC")
    p = mm.add_parser("join", help="entra/cria a matilha (mesma porta do mesh join do shell)")
    p.add_argument("nome", help="1 a 15 bytes")
    p.add_argument("senha", nargs="?", default=None, help="8 a 64 bytes (omitida = pergunta)")
    mm.add_parser("leave", help="volta a rede aberta \"celer\"")
    p = mm.add_parser("accept", help="aparelho NOVO: abre a janela de convite (10 min)")
    p.add_argument("off", nargs="?", choices=("off",), help="fecha a janela")
    p = mm.add_parser("invite", help="membro convida o novo pelo CelerLink (pareamento por codigo)")
    p.add_argument("alvo", help="nome do anuncio do novo, id A1B2 ou AA:BB:CC:DD:EE:FF")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--codigo", help="codigo de 6 digitos da tela do novo")
    g.add_argument("--de", metavar="PORTA", help="le o codigo pelo cabo do novo (sem tela)")
    p = mm.add_parser("send", help="mensagem do PC (no virtual) para um membro: chega no Pack.poll")
    p.add_argument("no", help="id A1B2, nome do no ou \"gw\" (o proprio gateway)")
    p.add_argument("msg")
    p = mm.add_parser("listen", help="mostra o que a matilha manda ao PC (Pack.send(\"pc-XXXX\"))")
    p.add_argument("segundos", type=int, nargs="?", default=60)

    p = sub.add_parser("devices", help="lista placas conectadas (USB e WiFi)")
    p.add_argument("-l", "--long", action="store_true")
    p.set_defaults(func=cmd_devices)

    p = sub.add_parser("pair", help="pareia com o Celer Debug Bridge WiFi e "
                                    "guarda o token (conecta uma vez so)")
    p.add_argument("addr", nargs="?", help="IP ou host:porta do device "
                                           "(celerctl devices)")
    p.add_argument("-p", "--port", dest="port_sel", default=None,
                   help="alias do endereco (mesma sintaxe do -p dos outros "
                        "comandos)")
    p.add_argument("--token", default=None,
                   help="token do bridge (default: pergunta no terminal)")
    p.set_defaults(func=cmd_pair)

    p = sub.add_parser("provision", help="provisiona WiFi + token do bridge + "
                                         "permissoes (1a vez, geralmente por USB)")
    p.add_argument("--wifi", nargs=2, metavar=("SSID", "SENHA"),
                   help="credenciais WiFi a salvar (SSID sem espacos)")
    p.add_argument("--token", default=None,
                   help="token do bridge a gravar (default: gera um novo)")
    p.add_argument("--grant", action="append", metavar="APP",
                   help="concede as permissoes declaradas ao app (repetivel)")
    p.set_defaults(func=cmd_provision)

    p = sub.add_parser("info", help="informacoes do sistema")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("top", help="profiling: CPU%% por task, heap, app (estilo top)")
    p.add_argument("-w", "--watch", action="store_true",
                   help="atualiza continuamente a cada --interval (Ctrl-C sai)")
    p.add_argument("--interval", type=float, default=1.0, metavar="S",
                   help="periodo do --watch em segundos (default 1)")
    p.add_argument("--window", type=float, default=0.3, metavar="S",
                   help="janela de amostragem do one-shot (default 0.3s)")
    p.add_argument("--sort", choices=("cpu", "stack", "name"), default="cpu",
                   help="ordena a tabela (default cpu)")
    p.add_argument("-n", type=int, default=0, metavar="N",
                   help="mostra so as N primeiras tasks")
    p.add_argument("--plain", action="store_true",
                   help="sem ANSI (nao limpa a tela no --watch)")
    p.set_defaults(func=cmd_top)

    p = sub.add_parser("stats", help="uma foto de profiling (taxas desde o boot; --json cru)")
    p.add_argument("--json", action="store_true", help="JSON puro do device")
    p.set_defaults(func=cmd_stats)

    p = sub.add_parser("svc", help="servicos de app em 2o plano (API 42): estado, "
                                   "stop/start/setup")
    p.set_defaults(func=cmd_svc)
    sv = p.add_subparsers(dest="svc_cmd", required=True)
    sv.add_parser("list", help="estado, reinicios e ultimo erro de cada servico")
    for _nome, _ajuda in (("info", "detalhe do servico de um app"),
                          ("stop", "para o servico (ate `svc start` ou reboot)"),
                          ("start", "religa um servico parado"),
                          ("setup", "roda o setup/install.sh do servico de novo")):
        q = sv.add_parser(_nome, help=_ajuda)
        q.add_argument("pkg", help="packageName do app (ex: celeros.demo)")

    p = sub.add_parser("crash", help="resumo do ultimo crash + ultimas linhas do apps.log")
    p.add_argument("n", nargs="?", type=int, default=None,
                   help="linhas do apps.log a mostrar (1..200; default do device: 20)")
    p.set_defaults(func=cmd_crash)

    p = sub.add_parser("shell", help="shell interativo ou executa comando "
                                     "(o shell do device nao trata aspas)")
    p.add_argument("cmd", nargs="*", help="comando a executar")
    p.set_defaults(func=cmd_shell)

    p = sub.add_parser("ls", help="lista diretorio")
    p.add_argument("-l", "--long", action="store_true")
    p.add_argument("path", nargs="?", default="/local")
    p.set_defaults(func=cmd_ls)

    p = sub.add_parser("cat", help="mostra conteudo de arquivo")
    p.add_argument("path")
    p.set_defaults(func=cmd_cat)

    p = sub.add_parser("push", help="envia arquivo ao dispositivo (pasta de "
                                     "app com app.json p/ raiz de apps = install)")
    p.add_argument("local")
    p.add_argument("remote")
    p.add_argument("--raw", action="store_true",
                   help="pula o modo app: empurra cru mesmo sendo pasta de app")
    p.add_argument("--no-verify", action="store_true",
                   help="pula a releitura de verificacao (crc32) apos a escrita")
    p.set_defaults(func=cmd_push)

    p = sub.add_parser("pull", help="baixa arquivo do dispositivo")
    p.add_argument("remote")
    p.add_argument("local", nargs="?", default=None)
    p.set_defaults(func=cmd_pull)

    p = sub.add_parser("rm", help="apaga arquivo (ou pasta com -r)")
    p.add_argument("path")
    p.add_argument("-r", "--recursive", action="store_true",
                   help="apaga diretorio com todo o conteudo")
    p.set_defaults(func=cmd_rm)

    p = sub.add_parser("mkdir", help="cria diretorio")
    p.add_argument("path")
    p.set_defaults(func=cmd_simple("MKDIR"))

    p = sub.add_parser("mv", help="renomeia/move")
    p.add_argument("src")
    p.add_argument("dst")
    p.set_defaults(func=cmd_simple("RENAME"))

    p = sub.add_parser("reboot", help="reinicia a placa")
    p.set_defaults(func=cmd_reboot)

    p = sub.add_parser("logcat", help="stream de logs do dispositivo")
    p.add_argument("--dump", action="store_true",
                   help="copia o buffer acumulado no dispositivo e sai (dump repetivel)")
    p.add_argument("--quiet-ms", type=int, default=800,
                   help="janela de silencio do --dump em ms (so no firmware antigo)")
    p.add_argument("--since", metavar="TS",
                   help="so linhas a partir do timestamp do device (I (1234)): ms "
                        "desde o boot (1234, 1234ms, 90s, 2m) ou relativo ao log "
                        "mais novo (-30s = ultimos 30 s do buffer)")
    p.add_argument("--ts", action="store_true",
                   help="prefixa cada linha com hora do host (HH:MM:SS.mmm)")
    p.add_argument("--grep", metavar="REGEX",
                   help="mostra so as linhas que casam com a REGEX (ignora caixa; "
                        "o filtro e no PC — nada de aspas no shell do device)")
    p.add_argument("--json", action="store_true",
                   help="uma linha JSON por log (ts/level/text; com --ts inclui host_ts)")
    p.set_defaults(func=cmd_logcat)

    p = sub.add_parser("ota", help="grava firmware pela conexao (sem esptool)")
    ota_sub = p.add_subparsers(dest="ota_cmd", required=True)
    po = ota_sub.add_parser("push", help="envia e grava um firmware.bin")
    po.add_argument("file")
    po.add_argument("--no-reboot", action="store_true", help="nao reinicia apos gravar")
    p.set_defaults(func=cmd_ota)

    p = sub.add_parser("coredump", help="baixa o coredump do ultimo crash (ELF)")
    p.add_argument("--out", default="coredump.elf", help="arquivo de saida")
    p.add_argument("--keep", action="store_true",
                   help="nao apaga o dump apos baixar (reler depois)")
    p.set_defaults(func=cmd_coredump)

    p = sub.add_parser("debug", help="debugger Duktape do app (breakpoints/step/eval)")
    p.add_argument("app", nargs="?", help="app a abrir apos o cliente conectar (default: nenhum)")
    p.add_argument("--app", dest="app_opt", metavar="NOME", default=None,
                   help="abre este app antes de anexar (equivalente ao argumento "
                        "posicional; com --eval evita o 'nenhum app aberto')")
    p.add_argument("--tcp-port", type=int, default=9092, dest="tcp_port",
                   help="porta TCP local do proxy (default 9092; nao confundir com -p serial)")
    p.add_argument("--serve", action="store_true",
                   help="so o proxy (cliente em outro terminal: node tools/debug/dbg.js)")
    p.add_argument("--src", help="fonte local do app para o cliente (default: data/apps, hub_apps...)")
    p.add_argument("--eval", default=None, metavar="EXPR",
                   help="one-shot: pausa o app, avalia EXPR no escopo dele (ve vars de "
                        "modulo: E, D, M...), continua e sai — inspecionar estado vivo "
                        "sem sessao interativa")
    p.set_defaults(func=cmd_debug)

    p = sub.add_parser("screencap", help="captura da tela -> PNG")
    p.add_argument("out", nargs="?", default="celer_screencap.png")
    p.set_defaults(func=cmd_screencap)

    p = sub.add_parser("tap", help="injeta um toque na tela")
    p.add_argument("x", type=int,
                   help="X FISICO do vidro (raw do touch: 480x480 SmartDisplay,"
                        " 320x240 CYD, ~240x240 watch) — ou VIRTUAL 0..240 com --v")
    p.add_argument("y", type=int, help="Y FISICO do vidro (ou VIRTUAL 0..320 com --v)")
    p.add_argument("hold", nargs="?", type=int, default=80, help="ms pressionado (default 80)")
    p.add_argument("--finger", type=int, default=0,
                   help="dedo sintetico (0 = primario; 1..4 p/ multi, exige firmware novo)")
    p.add_argument("-v", "--virtual", dest="v", action="store_true",
                   help="coordenadas VIRTUAIS do app (240x320): escala pelo vidro"
                        " (descobre sozinho via screenshot; override com --glass)")
    p.add_argument("--glass", default=None, metavar="WxH",
                   help="vidro na mao (ex: 480x480) — pula a sonda do screenshot"
                        " (util em device ocupado, onde screencap da timeout)")
    p.add_argument("--shot", default=None, metavar="PNG",
                   help="captura a tela APOS o toque e imprime o md5 (tap+espera+"
                        "screencap em um comando — dirigir UI sem baile de 3 comandos)")
    p.add_argument("--wait", type=int, default=800,
                   help="ms de espera antes do --shot (default 800)")
    p.set_defaults(func=cmd_tap)

    p = sub.add_parser("swipe", help="injeta um arrasto (p0 -> p1)")
    p.add_argument("x0", type=int)
    p.add_argument("y0", type=int)
    p.add_argument("x1", type=int)
    p.add_argument("y1", type=int)
    p.add_argument("duration", nargs="?", type=int, default=250, help="duracao em ms (default 250)")
    p.add_argument("--finger", type=int, default=0,
                   help="dedo sintetico (0 = primario; 1..4 p/ multi, exige firmware novo)")
    p.set_defaults(func=cmd_swipe)

    p = sub.add_parser("mtap", help="dois dedos simultaneos (bench multitouch)")
    p.add_argument("x0", type=int, help="X do dedo 0 (FISICO, ou VIRTUAL com --v)")
    p.add_argument("y0", type=int, help="Y do dedo 0")
    p.add_argument("x1", type=int, help="X do dedo 1")
    p.add_argument("y1", type=int, help="Y do dedo 1")
    p.add_argument("hold", nargs="?", type=int, default=150, help="ms pressionado (default 150)")
    p.add_argument("-v", "--virtual", dest="v", action="store_true",
                   help="coordenadas VIRTUAIS do app (240x320), como no tap")
    p.add_argument("--glass", default=None, metavar="WxH",
                   help="vidro na mao (ex: 480x480) — pula a sonda do screenshot")
    p.set_defaults(func=cmd_mtap)

    p = sub.add_parser("dev", help="loop de desenvolvimento: watch + reload + logs")
    p.add_argument("folder", help="pasta do app (com app.json)")
    p.add_argument("--sd", action="store_true", help="instala no cartao (/sd/apps)")
    p.add_argument("--shots", action="store_true",
                   help="salva screenshot apos cada reload em PASTA/.dev/last.png")
    p.add_argument("--no-lint", action="store_true", help="pula o lint a cada reload")
    p.add_argument("--deps-local", action="store_true",
                   help="deps tambem do tools/sdk/engine (vence a do hub quando mais nova)")
    p.add_argument("--pula-verify", action="store_true",
                   help="pula a releitura de verificacao (crc32) de cada arquivo")
    p.set_defaults(func=cmd_dev)

    p = sub.add_parser("apps", help="gerencia apps instalados no dispositivo")
    apps_sub = p.add_subparsers(dest="action", required=True)
    a = apps_sub.add_parser("list", help="lista apps de /local/apps e /sd/apps")
    a = apps_sub.add_parser("install", help="instala uma pasta de app local")
    a.add_argument("folder", help="pasta com app.json + main.js (+ icon.bin)")
    a.add_argument("--sd", action="store_true", help="instala no cartao (/sd/apps)")
    a.add_argument("--pula-lint", action="store_true", help="instala mesmo com erros de lint")
    a.add_argument("--deps-local", action="store_true",
                   help="deps tambem do tools/sdk/engine (vence a do hub quando mais nova): "
                        "testa engine/physics no aparelho antes do publish-dep")
    a.add_argument("--pula-verify", action="store_true",
                   help="pula a releitura de verificacao (crc32) de cada arquivo")
    a.add_argument("--run", action="store_true",
                   help="abre o app ao final (exit + run; encerra o anterior)")
    a.add_argument("--hub-token", default=None, metavar="T",
                   help="token de leitura do hub para deps privadas; default: "
                        "CELER_HUB_TOKEN ou o /local/hub_token.txt do device")
    a = apps_sub.add_parser("store", help="baixa o pacote do hub e instala "
                                         "(o caminho da loja, sem dirigir a UI)")
    a.add_argument("pkg", help="pacote no hub (ex: celeros.arrasa — veja o "
                               "catalogo em /store/all.json)")
    a.add_argument("--sd", action="store_true", help="instala no cartao (/sd/apps)")
    a.add_argument("--pula-lint", action="store_true", help="instala mesmo com erros de lint")
    a.add_argument("--deps-local", action="store_true",
                   help="deps tambem do tools/sdk/engine (vence a do hub quando mais nova)")
    a.add_argument("--pula-verify", action="store_true",
                   help="pula a releitura de verificacao (crc32) de cada arquivo")
    a.add_argument("--run", action="store_true",
                   help="abre o app ao final (exit + run; encerra o anterior)")
    a.add_argument("--hub-token", default=None, metavar="T",
                   help="token de leitura do hub (app privado); default: "
                        "CELER_HUB_TOKEN ou o /local/hub_token.txt do device")
    a = apps_sub.add_parser("installzip", help="instala um pacote unico .zip no device "
                                                "(o mesmo layout que o hub publica)")
    a.add_argument("zipfile", help="caminho do .zip no PC (app.json na raiz)")
    a.add_argument("name", nargs="?", default=None,
                   help="nome da pasta no device (default: campo name do app.json)")
    a = apps_sub.add_parser("pull", help="baixa um app instalado para o PC")
    a.add_argument("name", help="nome da pasta do app no dispositivo")
    a.add_argument("dest", nargs="?", default=None, help="pasta de destino (default ./<nome>)")
    a = apps_sub.add_parser("rm", help="remove um app instalado")
    a.add_argument("name", help="nome da pasta do app")
    a.add_argument("--sd", action="store_true", help="remove de /sd/apps")
    a.add_argument("--force", action="store_true", help="permite remover app de sistema")
    a = apps_sub.add_parser("deps", help="deps compartilhadas em /local/modules: uso e orfas")
    a.add_argument("--gc", action="store_true",
                   help="remove as versoes orfas (exige --yes)")
    a.add_argument("--upgrade", action="store_true",
                   help="re-resolve as deps de cada app instalado contra o hub "
                        "(maior satisfazendo, nunca pula major) e regrava os deps.json")
    a.add_argument("--yes", action="store_true", help="confirma o --gc")
    a = apps_sub.add_parser("push-dep", help="deploy de uma dep do repo "
                         "(tools/sdk/engine) no cache do device — relance o app depois")
    a.add_argument("name", help="nome da dep (ex: celeros.game)")
    a.add_argument("--ver", default=None,
                   help="versao do cache (default: a unica instalada)")
    a = apps_sub.add_parser("deps-status", help="drift do cache de deps no DEVICE "
                            "contra o repo (tamanho + crc32 por versao)")
    a = apps_sub.add_parser("run", help="abre um app instalado (exit + run)")
    a.add_argument("name", help="nome da pasta do app (procura /local e /sd)")
    p.set_defaults(func=cmd_apps)
    return parser


def main():
    args = build_parser().parse_args()
    if args.command == "pull" and args.local is None:
        args.local = os.path.basename(args.remote) or "celer_pull.bin"
    global FORCE_PROTO1, LOW_LINES
    FORCE_PROTO1 = args.proto == 1
    LOW_LINES = bool(args.low_lines) or os.environ.get("CELEROS_LOW_LINES") == "1"
    global WIN_CAP
    WIN_CAP = args.win if args.win > 0 else 0

    try:
        args.func(args)
    except CelerError as e:
        die(str(e))
    except serial.SerialException as e:
        die(f"porta serial: {e}")
    except PORT_GONE[2:] as e:
        # termios.error e subclasse de OSError: tem que vir ANTES do except
        # OSError, senao este ramo era codigo morto e a CDC que sumia no meio
        # (reboot/re-enumeracao) saia como "conexao: ..." em vez da receita
        die(f"porta serial sumiu ({e}): o device reiniciou? tente de novo")
    except OSError as e:
        # bridge TCP fora do ar / reset no meio da sessao
        die(f"conexao: {e}")
    except KeyboardInterrupt:
        print()
        sys.exit(130)


if __name__ == "__main__":
    main()
