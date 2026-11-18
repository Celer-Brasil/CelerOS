#!/usr/bin/env python3
"""Confere em TERRA o manifesto OTA que a placa vai consumir.

O firmware so instala um update vindo por HTTPS depois de verificar o sha256
do corpo e a assinatura ECDSA P-256 do manifesto contra a chave publica
embutida em main/OTA/OtaPublicKey.h. Quando algo desse par sai errado o
sintoma chega tarde e enganoso: a placa mostra "manifesto sem assinatura
valida" e a causa pode ser a chave publica compilada, o campo assinado, o
sha do binario publicado ou o arquivo errado no canal. Este modulo refaz os
mesmos passos no PC, antes de publicar:

  1. o texto canonico assinado (prefixo + version + api_version +
     firmware_sha256 + variant, um por linha): extraido do PROPRIO
     OtaManager.cpp, que e a fonte unica;
  2. a assinatura r||s de 64 bytes contra a chave do header do firmware;
  3. o sha256 do .bin baixado;
  4. o app_desc do .bin (versao e chip) contra o manifesto e o alvo.

Sem dependencia externa: P-256 em Python puro (e uma verificacao por
execucao, nao um caminho quente).

    from ota_manifest import verify_manifest, canonical_of
    problemas = verify_manifest(meta, fw_bytes, pubkey65)
"""

import hashlib
import re
import struct
from pathlib import Path

# --------------------------------------------------------------- P-256 (SECP256R1)
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5


def _inv(a, m):
    """Inverso modular (m primo)."""
    return pow(a, m - 2, m)


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + A) * _inv(2 * y1, P) % P
    else:
        lam = (y2 - y1) * _inv(x2 - x1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)


def _mul(k, pt):
    out = None
    addend = pt
    while k:
        if k & 1:
            out = _add(out, addend)
        addend = _add(addend, addend)
        k >>= 1
    return out


def ecdsa_verify(pub65, msg, sig_raw):
    """Verifica ECDSA P-256. `sig_raw` = r||s (64 B), formato do firmware
    (PSA_ECDSA_SIGNATURE_SIZE(256)), nao DER. False em qualquer anomalia."""
    if len(pub65) != 65 or pub65[0] != 0x04:
        return False
    if len(sig_raw) != 64:
        return False
    qx = int.from_bytes(pub65[1:33], "big")
    qy = int.from_bytes(pub65[33:65], "big")
    if not (0 < qx < P and 0 < qy < P):
        return False
    if (qy * qy - (qx * qx * qx + A * qx + B)) % P != 0:
        return False          # ponto fora da curva
    r = int.from_bytes(sig_raw[:32], "big")
    s = int.from_bytes(sig_raw[32:], "big")
    if not (0 < r < N and 0 < s < N):
        return False
    z = int.from_bytes(hashlib.sha256(msg).digest(), "big")
    w = _inv(s, N)
    pt = _add(_mul(z * w % N, (GX, GY)), _mul(r * w % N, (qx, qy)))
    if pt is None:
        return False
    return pt[0] % N == r


# ------------------------------------------------------- texto canonico (firmware)
DEFAULT_PREFIX = "CelerOS-OTA-v1"
DEFAULT_FIELDS = ("version", "api_version", "firmware_sha256", "variant")


def _cxx_unescape(s):
    """Interpreta os escapes de um literal C++ ("\\n" -> newline).

    O prefixo do texto canonico e escrito em C++ como "CelerOS-OTA-v1\\n": o
    regex le o texto do FONTE (com a barra dupla literal), nao o valor que o
    compilador produz. Sem decodificar, o prefixo ganharia um "\\n" no meio e
    nenhuma assinatura conferiria.
    """
    return (s.replace("\\n", "\n").replace("\\r", "\r")
             .replace("\\t", "\t").replace('\\"', '"').replace("\\\\", "\\"))


def canonical_format(firmware_dir=None):
    """(prefixo, campos) do manifestCanonical() de main/OTA/OtaManager.cpp.

    O firmware e a fonte unica: mudar o texto assinado la sem mudar o
    publicador (CelerOS-Server/tools/ota_sign.py) faz todo OTA morrer em
    "assinatura". Este leitor reproduz a ORDEM dos campos do C++.
    """
    root = Path(firmware_dir) if firmware_dir else \
        Path(__file__).resolve().parent.parent / "main" / "OTA"
    src = root / "OtaManager.cpp"
    try:
        txt = src.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return DEFAULT_PREFIX, DEFAULT_FIELDS
    m = re.search(r"manifestCanonical\s*\([^)]*\)\s*\{(.*?)\n\}", txt, re.S)
    if not m:
        return DEFAULT_PREFIX, DEFAULT_FIELDS
    body = m.group(1)
    pref = re.search(r'std::string\("([^"]+)"\)', body)
    prefix = _cxx_unescape(pref.group(1)) if pref else DEFAULT_PREFIX
    # A ordem dos campos no corpo: cada um entra por concatenacao no return.
    order = re.findall(r"info\.(version|apiVersion|firmwareSha256)|\bvariant\b", body)
    fields = []
    for kind in order:
        if kind == "apiVersion":
            fields.append("api_version")
        elif kind == "firmwareSha256":
            fields.append("firmware_sha256")
        elif kind == "version":
            fields.append("version")
        elif not fields or fields[-1] != "variant":
            fields.append("variant")
    if len(fields) != 4:
        return prefix, DEFAULT_FIELDS
    # O C++ escreve o prefixo JA com o separador ("CelerOS-OTA-v1\n"); aqui ele
    # volta sem o newline final porque canonical_of insere um por campo — sem
    # isto o texto ganharia uma linha vazia na frente e nada conferiria.
    return prefix.rstrip("\n"), tuple(fields)


def canonical_of(meta, prefix=None, fields=None):
    """Bytes exatamente como o OtaManager monta (uma linha por campo)."""
    if prefix is None or fields is None:
        p, f = canonical_format()
        prefix = prefix or p
        fields = fields or f
    vals = []
    for name in fields:
        v = meta.get(name)
        if name == "api_version":
            v = str(int(v)) if v is not None and str(v) != "" else ""
        elif name == "firmware_sha256":
            v = str(v or "").lower()
        else:
            v = str(v or "")
        vals.append(v)
    return (prefix + "\n" + "\n".join(vals) + "\n").encode("utf-8")


# ------------------------------------------------------------------ verificacao
SHA_RE = re.compile(r"^[0-9a-f]{64}\Z")
SIG_RE = re.compile(r"^[0-9a-f]{128}\Z")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+\Z")


def verify_manifest(meta, fw_bytes=None, pubkey=None, firmware_dir=None):
    """Lista de problemas (vazia = o manifesto e instalavel).

    meta: dict do update.json. fw_bytes: corpo do firmware (opcional: sem ele
    os testes de sha/chip/app_desc sao pulados). pubkey: os 65 B de
    kOtaPublicKey (None = le do header do firmware).
    """
    problems = []
    if not isinstance(meta, dict):
        return ["manifesto nao e um objeto JSON"]

    version = str(meta.get("version") or "")
    if not SEMVER_RE.match(version):
        problems.append(f"version {version!r} nao e semver x.y.z")

    api = meta.get("api_version")
    try:
        api_i = int(api)
    except (TypeError, ValueError):
        problems.append(f"api_version {api!r} ausente/invalido (a assinatura cobre o campo)")
        api_i = None

    sha = str(meta.get("firmware_sha256") or "").lower()
    has_fw_url = bool(meta.get("firmware_url") or meta.get("url"))
    if not SHA_RE.match(sha):
        problems.append("firmware_sha256 ausente/invalido (64 hex): o firmware "
                        "confere o sha do stream antes de marcar o boot")
    sig = str(meta.get("firmware_signature") or "").lower()
    if not SIG_RE.match(sig):
        problems.append("firmware_signature ausente/invalida (128 hex = r||s de "
                        "64 B): HTTPS recusa o manifesto sem ela")

    # Assinatura: so faz sentido com os campos de texto ja validados.
    if pubkey is None and not problems:
        pubkey = _pubkey_from_header(firmware_dir)
    if pubkey and SIG_RE.match(sig) and not any("semver" in p or "api_version" in p
                                                or "firmware_sha256" in p for p in problems):
        msg = canonical_of(meta, *canonical_format(firmware_dir))
        if not ecdsa_verify(pubkey, msg, bytes.fromhex(sig)):
            problems.append("assinatura NAO confere com a chave publica do firmware "
                            "(main/OTA/OtaPublicKey.h): a placa responderia "
                            "'manifesto sem assinatura valida'")

    if fw_bytes is not None:
        if SHA_RE.match(sha):
            got = hashlib.sha256(fw_bytes).hexdigest()
            if got != sha:
                problems.append(f"sha256 do .bin ({got[:16]}...) nao bate com o "
                                f"manifesto ({sha[:16]}...)")
        if has_fw_url or fw_bytes:
            problems.extend(_check_image(fw_bytes, version, api_i))
    elif not has_fw_url:
        problems.append("manifesto sem firmware_url: a placa cai no fluxo legado "
                        "(mostra o changelog, sem botao INSTALL)")
    return problems


def _check_image(fw_bytes, version, api_i):
    """app_desc do binario contra o manifesto (versao anunciada)."""
    import fw_image
    img = fw_image.parse(fw_bytes)
    if not img.ok:
        return [f"o firmware publicado nao e uma imagem valida: {img.error}"]
    out = []
    if version and img.version != version:
        out.append(f"o binario se identifica como {img.version} e o manifesto diz "
                   f"{version}: depois do OTA a placa anunciaria a versao errada e "
                   "baixaria em laco")
    if api_i is not None and img.version and version and img.version == version:
        pass  # a API nao vai dentro do .bin; o app_desc so carrega a versao
    return out


def _pubkey_from_header(firmware_dir=None):
    root = Path(firmware_dir) if firmware_dir else \
        Path(__file__).resolve().parent.parent / "main" / "OTA"
    header = root / "OtaPublicKey.h"
    try:
        txt = header.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    m = re.search(r"kOtaPublicKey\s*\[[^\]]*\]\s*=\s*\{([^}]*)\}", txt)
    if not m:
        return None
    raw = bytes(int(v, 0) for v in re.findall(r"0x[0-9A-Fa-f]{2}", m.group(1)))
    return raw if len(raw) == 65 and raw[0] == 0x04 else None


def parse_update_json(payload):
    """update.json cru -> dict, aceitando o formato v2 do hub."""
    import json
    try:
        doc = json.loads(payload.decode("utf-8") if isinstance(payload, bytes) else payload)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f"update.json ilegivel: {exc}")
    if not isinstance(doc, dict):
        raise ValueError("update.json nao e um objeto")
    return doc
