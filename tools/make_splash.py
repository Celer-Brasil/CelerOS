#!/usr/bin/env python3
"""Gera o header da logo de boot do CelerOS (main/Assets/SplashLogo.h).

A splash roda antes do LittleFS, entao a logo vai embutida em flash como
PNG paletizado (ja composto sobre THEME_BG — sem alpha em runtime), e o boot
desenha com tft.drawPng (decoder pngle do LovyanGFX, ja linkado) escalando
por zoom = UI::W/240: basta uma unica resolucao na escala do design 240x320.

Uso:  python3 tools/make_splash.py            (usa Documentation/assets/celeros_logo.png)
      python3 tools/make_splash.py --src caminho.png --bg 0x080C18 --colors 64
"""
import argparse
import io
import pathlib

from PIL import Image

REPO = pathlib.Path(__file__).resolve().parent.parent

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--src", default=str(REPO / "Documentation/assets/celeros_logo.png"))
ap.add_argument("--out", default=str(REPO / "main/Assets/SplashLogo.h"))
ap.add_argument("--width", type=int, default=200, help="largura na escala do design 240 (default 200)")
ap.add_argument("--bg", default="0x080C18", help="cor de fundo THEME_BG (hex RRGGBB com ou sem 0x)")
ap.add_argument("--colors", type=int, default=64, help="cores da paleta PNG (default 64)")
args = ap.parse_args()

bg_hex = args.bg.replace("0x", "").replace("0X", "")
bg = tuple(int(bg_hex[i:i + 2], 16) for i in (0, 2, 4))

img = Image.open(args.src).convert("RGBA")
bbox = img.getchannel("A").getbbox()  # recorta margens transparentes (pelo alfa:
# getbbox() dos 4 canais conta pixel RGB colorido com alfa 0 como conteudo)
if bbox:
    img = img.crop(bbox)

w = args.width
h = round(img.height * w / img.width)
img = img.resize((w, h), Image.Resampling.LANCZOS)
flat = Image.alpha_composite(Image.new("RGBA", img.size, bg + (255,)), img).convert("RGB")

buf = io.BytesIO()
flat.quantize(args.colors).save(buf, "PNG", optimize=True)
png = buf.getvalue()

lines = []
for i in range(0, len(png), 16):
    lines.append("    " + " ".join("0x%02X," % b for b in png[i:i + 16]))

header = f"""\
// Gerado por tools/make_splash.py a partir de {pathlib.Path(args.src).name} — nao editar a mao.
// PNG {w}x{h} com {args.colors} cores, composto sobre THEME_BG ({args.bg}).
// Desenhar com tft.drawPng(kSplashLogoPng, sizeof(kSplashLogoPng), ...).
#ifndef CELEROS_ASSETS_SPLASH_LOGO_H
#define CELEROS_ASSETS_SPLASH_LOGO_H

#include <stdint.h>

#define SPLASH_LOGO_W {w}
#define SPLASH_LOGO_H {h}

static const uint8_t kSplashLogoPng[] = {{
{chr(10).join(lines)}
}};

#endif  // CELEROS_ASSETS_SPLASH_LOGO_H
"""

pathlib.Path(args.out).parent.mkdir(parents=True, exist_ok=True)
pathlib.Path(args.out).write_text(header)
print(f"{args.out}: {w}x{h}, {len(png) / 1024:.1f} KB de flash (RGB565 cru: {w * h * 2 / 1024:.1f} KB)")
