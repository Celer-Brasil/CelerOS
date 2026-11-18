#!/usr/bin/env python3
"""Testes do verificador de manifesto OTA (tools/ota_manifest.py) — host.

    python3 test/test_ota_manifest.py -v

Dois blocos:
  1. ECDSA P-256: vetor GOLDEN gerado com `openssl dgst -sha256 -sign` (o
     mesmo caminho que o CelerOS-Server usa para assinar), para o teste nao
     depender de openssl instalado no CI;
  2. manifesto: o texto canonico e os veredictos de verify_manifest, incluindo
     os casos que o firmware recusa (sem assinatura, sha errado, versao do
     app_desc diferente do manifesto).
"""

import hashlib
import struct
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import ota_manifest as O  # noqa: E402
import fw_image as F  # noqa: E402

# Par gerado para este teste (chave privada descartada): a assinatura cobre
# exatamente o texto canonico do firmware para o FW sintetico abaixo —
# "CelerOS-OTA-v1\n1.18.0\n62\n<sha256 do FW>\n\n".
PUB = bytes.fromhex(
    "04cf7176cf665603777f3a5e6f7f79999f6a246586b4e0222ef7a492ab43b8de41"
    "91aff1a3f6203a11a90dea5a05b68b09f71a2592565e4bda2470bdfbc7dd9fcf")


def _fw(version="1.18.0", chip_id=0x0009, size=4096):
    """Imagem sintetica no layout do IDF (ver test/test_fw_image.py)."""
    def az(t, n):
        raw = t.encode()[: n - 1]
        return raw + b"\x00" * (n - len(raw))

    buf = bytearray(size)
    buf[0] = 0xE9
    buf[1] = 3
    struct.pack_into("<H", buf, 12, chip_id)
    b = F.APP_DESC_OFFSET
    struct.pack_into("<I", buf, b, F.APP_DESC_MAGIC)
    buf[b + 16:b + 48] = az(version, 32)
    buf[b + 48:b + 80] = az("CelerOS", 32)
    buf[b + 112:b + 144] = az("v6.1.0", 32)
    return bytes(buf)


FW = _fw()
FW_SHA = hashlib.sha256(FW).hexdigest()
SIG = bytes.fromhex(
    "9800adc1b19d05180f3c6f216542741ddc807d86457ee4e16f59813c7629fd54"
    "fc1ba09e1498ab0cc6ac4bba3bf4a46fc0d32d3ad4ea2a607b2fc393d25c5792")
# Mensagem que o SIG cobre, montada como o manifestCanonical() do firmware.
GOLDEN_MSG = O.canonical_of(
    {"version": "1.18.0", "api_version": 62, "firmware_sha256": FW_SHA,
     "variant": ""}, "CelerOS-OTA-v1",
    ("version", "api_version", "firmware_sha256", "variant"))


def meta(**kw):
    base = {
        "version": "1.18.0",
        "api_version": 62,
        "firmware_sha256": FW_SHA,
        "variant": "",
        "firmware_url": "firmware.bin",
        "firmware_signature": SIG.hex(),
    }
    base.update(kw)
    return base


class EcdsaTest(unittest.TestCase):
    def test_golden_aceita(self):
        self.assertTrue(O.ecdsa_verify(PUB, GOLDEN_MSG, SIG))

    def test_r_adulterado(self):
        bad = bytearray(SIG)
        bad[0] ^= 0x01
        self.assertFalse(O.ecdsa_verify(PUB, GOLDEN_MSG, bytes(bad)))

    def test_s_adulterado(self):
        bad = bytearray(SIG)
        bad[40] ^= 0x80
        self.assertFalse(O.ecdsa_verify(PUB, GOLDEN_MSG, bytes(bad)))

    def test_mensagem_trocada(self):
        self.assertFalse(O.ecdsa_verify(PUB, GOLDEN_MSG.replace(b"62", b"63"), SIG))

    def test_pubkey_curta(self):
        self.assertFalse(O.ecdsa_verify(PUB[:60], GOLDEN_MSG, SIG))

    def test_pubkey_sem_prefixo_uncompressed(self):
        self.assertFalse(O.ecdsa_verify(b"\x02" + PUB[1:], GOLDEN_MSG, SIG))

    def test_ponto_fora_da_curva(self):
        # y zerado nao pertence a curva: a verificacao tem que recusar ANTES
        # de fazer aritmetica (senao aceitaria pontos fabricados)
        bad = PUB[:33] + bytes(32)
        self.assertFalse(O.ecdsa_verify(bad, GOLDEN_MSG, SIG))

    def test_sig_formato_errado(self):
        self.assertFalse(O.ecdsa_verify(PUB, GOLDEN_MSG, SIG[:63]))
        self.assertFalse(O.ecdsa_verify(PUB, GOLDEN_MSG, SIG + b"\x00"))

    def test_r_ou_s_zero(self):
        self.assertFalse(O.ecdsa_verify(PUB, GOLDEN_MSG, bytes(64)))
        self.assertFalse(O.ecdsa_verify(PUB, GOLDEN_MSG, SIG[:32] + bytes(32)))


class CanonicalTest(unittest.TestCase):
    def test_le_do_firmware(self):
        prefix, fields = O.canonical_format()
        self.assertEqual(prefix, "CelerOS-OTA-v1")
        self.assertEqual(fields, ("version", "api_version",
                                  "firmware_sha256", "variant"))

    def test_monta_o_texto_do_firmware(self):
        m = {"version": "1.18.0", "api_version": 62,
             "firmware_sha256": "ABC".lower(), "variant": ""}
        self.assertEqual(O.canonical_of(m, "CelerOS-OTA-v1",
                                        ("version", "api_version",
                                         "firmware_sha256", "variant")),
                         b"CelerOS-OTA-v1\n1.18.0\n62\nabc\n\n")

    def test_sha_em_maiuscula_vira_minuscula(self):
        # o firmware compara o sha em minusculo; um manifesto com maiuscula
        # assinaria um texto que a placa nao reconstroi
        m = {"version": "1.0.0", "api_version": 1,
             "firmware_sha256": "AB" * 32, "variant": ""}
        out = O.canonical_of(m, "CelerOS-OTA-v1",
                             ("version", "api_version", "firmware_sha256", "variant"))
        self.assertIn(b"\n" + b"ab" * 32 + b"\n", out)

    def test_variant_entra_vazio(self):
        m = {"version": "1.0.0", "api_version": 1, "firmware_sha256": "aa" * 32}
        out = O.canonical_of(m, "CelerOS-OTA-v1",
                             ("version", "api_version", "firmware_sha256", "variant"))
        self.assertTrue(out.endswith(b"\n\n"))


class VerifyManifestTest(unittest.TestCase):
    def test_manifesto_limpo_com_imagem(self):
        # o caminho FELIZ: assinatura valida, sha batendo, app_desc igual
        self.assertEqual(O.verify_manifest(meta(), FW, PUB), [])

    def test_sem_assinatura(self):
        m = meta(firmware_signature="")
        p = O.verify_manifest(m, None, PUB)
        self.assertTrue(any("firmware_signature" in x for x in p))

    def test_assinatura_curta(self):
        m = meta(firmware_signature="ab" * 63)
        p = O.verify_manifest(m, None, PUB)
        self.assertTrue(any("firmware_signature" in x for x in p))

    def test_assinatura_de_outro_conteudo(self):
        m = meta(version="1.17.0")
        p = O.verify_manifest(m, None, PUB)
        self.assertTrue(any("assinatura NAO confere" in x for x in p))

    def test_sem_sha(self):
        m = meta(firmware_sha256="")
        p = O.verify_manifest(m, None, PUB)
        self.assertTrue(any("firmware_sha256" in x for x in p))

    def test_api_ausente(self):
        m = meta()
        del m["api_version"]
        p = O.verify_manifest(m, None, PUB)
        self.assertTrue(any("api_version" in x for x in p))

    def test_api_nao_numerica(self):
        p = O.verify_manifest(meta(api_version="sessenta"), None, PUB)
        self.assertTrue(any("api_version" in x for x in p))

    def test_versao_nao_semver(self):
        p = O.verify_manifest(meta(version="1.18"), None, PUB)
        self.assertTrue(any("semver" in x for x in p))

    def test_sha_do_bin_errado(self):
        fw = _fw(version="1.18.0", size=8192)   # outro conteudo, mesmo manifesto
        p = O.verify_manifest(meta(), fw, PUB)
        self.assertTrue(any("sha256 do .bin" in x for x in p), p)

    def test_sha_do_bin_certo(self):
        self.assertEqual(O.verify_manifest(meta(), FW, PUB), [])

    def test_app_desc_com_versao_diferente(self):
        # binario velho num manifesto novo: o classico laco de OTA
        fw = _fw(version="1.17.0")
        m = meta(firmware_sha256=hashlib.sha256(fw).hexdigest())
        p = O.verify_manifest(m, fw, PUB)
        self.assertTrue(any("1.17.0" in x and "1.18.0" in x for x in p), p)

    def test_bin_que_nao_e_imagem(self):
        junk = b"\x00" * 2048
        m = meta(firmware_sha256=hashlib.sha256(junk).hexdigest())
        p = O.verify_manifest(m, junk, PUB)
        self.assertTrue(any("nao e uma imagem valida" in x for x in p), p)

    def test_manifesto_sem_firmware(self):
        m = meta(variant="")
        for k in ("firmware_url", "url"):
            m.pop(k, None)
        p = O.verify_manifest(m, None, PUB)
        self.assertTrue(any("sem firmware_url" in x for x in p))

    def test_nao_e_objeto(self):
        self.assertEqual(O.verify_manifest([], None, PUB), ["manifesto nao e um objeto JSON"])

    def test_pubkey_do_header(self):
        # a chave de verdade do firmware tem que ser legivel e um ponto valido
        pub = O._pubkey_from_header()
        self.assertIsNotNone(pub)
        self.assertEqual(len(pub), 65)
        self.assertEqual(pub[0], 0x04)

    def test_mensagens_sem_acento(self):
        for p in O.verify_manifest(meta(firmware_signature=""), None, PUB):
            self.assertEqual(p, p.encode("ascii", "ignore").decode())


class ParseUpdateJsonTest(unittest.TestCase):
    def test_aceita_bytes(self):
        self.assertEqual(O.parse_update_json(b'{"version":"1.0.0"}'),
                         {"version": "1.0.0"})

    def test_aceita_str(self):
        self.assertEqual(O.parse_update_json('{"a":1}'), {"a": 1})

    def test_lixo(self):
        with self.assertRaises(ValueError):
            O.parse_update_json(b"<html>404</html>")

    def test_array_nao_serve(self):
        with self.assertRaises(ValueError):
            O.parse_update_json(b"[1,2]")


if __name__ == "__main__":
    unittest.main()
