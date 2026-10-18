#!/usr/bin/env python3
"""Arte da Lenda de Celer (hub_apps/Lenda de Celer) — geracao + masterizacao.

Pipeline (irmao do detona_sprites.py, cujos helpers de mascara reusa):
  1. text2d (FLUX.2 Klein local) gera personagens, objetos, itens e o
     titulo; texture2d (SD1.5 seamless) gera os MATERIAIS de chao/parede/
     agua (textura que emenda celula com celula). Renders nao sao
     reprodutiveis de verdade: o script e a documentacao dos prompts.
  2. Pillow masteriza:
     - sprite: fundo escuro conectado a borda vira preto puro (cor-chave
       do pushSprite/drawSprite), crop por conteudo, Lanczos para o
       tamanho final, RGB565 + Floyd-Steinberg, unblack (pretos internos
       viram (0,0,8) e ficam solidos);
     - texture: recorte central do material seamless, resize da celula;
     - objeto de cenario (arvore, rocha, bau...): sprite COMPOSTO sobre o
       material do chao na propria celula (tile opaco — o mapa nao paga
       cor-chave nem desenha duas camadas);
     - espelhos e rotacoes saem daqui (o firmware so gira sprite inteiro,
       e o jogo blita REGIOES de uma folha): heroi para a esquerda = a
       direita espelhada; a "andada" de frente/costas e o espelho do
       quadro (o truque classico de 8 bits); a espada em 4 direcoes.
  3. Folhas em GRADE de celulas de 32 px (E.spr.grid: 1 slot por folha):
     tileset.png, heroi.png, inimigos.png, itens.png, chefe.png (96 px),
     titulo.png (wide) e icon.png 64x64 RGBA na raiz do app (pacote do
     hub e flat).

Vive DENTRO do app, em hub_apps/Lenda de Celer/_dev/ (fonte dev-only
versionada): o celerctl install/dev nao envia _dev e o pacote do hub e
flat (so a raiz do app).

Uso: python3 "hub_apps/Lenda de Celer/_dev/lenda_sprites.py" [--regen] [--only id ...] [--master]
     --master so remonta as folhas a partir dos renders ja gerados.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

APP = Path(__file__).resolve().parent.parent      # hub_apps/Lenda de Celer
ROOT = APP.parent.parent                            # raiz do repo
sys.path.insert(0, str(ROOT / "tools"))
from make_icons import rgb565_dither  # noqa: E402  quantizacao da casa
from detona_sprites import (snap_black, content_square, bg_mask_of,  # noqa: E402
                            unblack, alpha_from_lum, sheet)

SRC = APP / "_dev" / "src"
OUT = APP
CELL = 32

NO_TEXT = ", no text, no letters, no watermark, no border"
STYLE = "16-bit fantasy adventure game pixel style, crisp clean edges, vivid colors"
TOPDOWN = "top-down three-quarter view from above, single centered sprite filling most of the frame, on pure solid black background"


def spr(prompt, seed, final=(30, 30)):
    return {"prompt": prompt + ", " + TOPDOWN + ", " + STYLE + NO_TEXT,
            "seed": seed, "final": final, "kind": "sprite"}


def obj(prompt, seed, base, final=(30, 30)):
    """objeto composto sobre o material `base` (tile opaco)."""
    d = spr(prompt, seed, final)
    d["kind"] = "obj"
    d["base"] = base
    return d


def tex(prompt, seed, preset=None):
    return {"prompt": prompt, "seed": seed, "final": (CELL, CELL), "kind": "texture",
            "preset": preset}


# id -> definicao. Personagem ORIGINAL (nada da Nintendo): Celer, jovem
# aventureira de capuz azul-petroleo e cachecol laranja.
HERO = ("young adventurer girl hero, teal blue hooded cloak, orange scarf, "
        "brown leather boots, small round shield on the back, chibi proportions")
ITEMS = {
    # ---------------------------------------------------------- heroi
    "heroi_baixo": spr(HERO + ", facing the viewer walking down", 8101),
    "heroi_cima": spr(HERO + ", seen from behind walking away, hood and cloak visible", 8102),
    "heroi_lado": spr(HERO + ", side view facing right walking", 8103),
    "espada": spr("short steel sword pointing straight up, golden crossguard, "
                  "blue leather grip, bright blade highlight", 8104, (14, 30)),
    # ------------------------------------------------------- inimigos
    "polvo": spr("small angry red rock-spitting crab creature with round body and "
                 "tube mouth, beady eyes", 8201),
    "morcego": spr("purple cave bat monster with spread wings and glowing yellow eyes", 8202),
    "esqueleto": spr("small skeleton warrior with rusty sword and cracked bone shield", 8203),
    "geleia": spr("translucent green jelly slime blob with two shiny eyes", 8204),
    "sabio": spr("friendly old sage with long white beard, brown robe and wooden staff", 8205),
    "chama": spr("small magical blue flame floating", 8206, (24, 28)),
    # ---------------------------------------------------------- itens
    "coracao": spr("glossy red heart pickup with white shine", 8301, (20, 20)),
    "cristal": spr("green faceted crystal gem currency pickup with sparkle", 8302, (16, 24)),
    "cristal_azul": spr("blue faceted crystal gem currency pickup with sparkle", 8303, (16, 24)),
    "chave": spr("small golden dungeon key", 8304, (16, 26)),
    "bomba": spr("round dark blue bomb with short lit fuse spark", 8305, (24, 24)),
    "bumerangue": spr("classic curved wooden boomerang weapon, banana shaped V boomerang "
                      "with red painted tips, flat lying", 8316, (24, 24)),
    "mapa": spr("rolled parchment dungeon map with red ribbon", 8307, (24, 24)),
    "bussola": spr("round brass compass with red needle", 8308, (24, 24)),
    "conteiner": spr("big golden framed heart container, glowing", 8309, (28, 28)),
    "pedra": spr("small round grey stone projectile", 8310, (12, 12)),
    # ----------------------------------------------------------- chefe
    "chefe": spr("giant ancient stone golem guardian with glowing cyan crystal core in its "
                 "chest, mossy boulders for arms, menacing glowing eyes", 8401, (92, 92)),
    # --------------------------------------------------------- tileset
    "t_grama": tex("seamless lush green grass texture, short grass blades, top-down, "
                   "flat even lighting, game ground tile", 8501, "grass"),
    "t_areia": tex("seamless light brown dirt path texture with tiny pebbles, top-down, "
                   "flat even lighting, game ground tile", 8502, "dirt"),
    "t_agua": tex("seamless clear blue water surface texture with soft ripples, top-down, "
                  "flat even lighting, game tile", 8503),
    "t_chao": tex("seamless dark grey dungeon stone floor tiles texture, square flagstones "
                  "with thin seams, top-down, flat even lighting", 8504, "stone"),
    "t_parede": tex("seamless dark blue-grey castle stone brick wall texture, top-down, "
                    "flat even lighting", 8505, "brick"),
    "t_madeira": tex("seamless wooden bridge planks texture, horizontal planks, top-down, "
                     "flat even lighting", 8506, "wood"),
    "arvore": obj("round dense green tree crown seen from directly above", 8601, "t_grama", (32, 32)),
    "rocha": obj("grey boulder rock", 8602, "t_grama"),
    "arbusto": obj("small round leafy green bush", 8603, "t_grama", (28, 28)),
    "flores": obj("small cluster of white and yellow flowers", 8604, "t_grama", (24, 24)),
    "lapide": obj("old grey gravestone with cross carving", 8605, "t_grama"),
    "estatua": obj("stone gargoyle statue", 8606, "t_chao"),
    "bloco": obj("heavy carved stone push block with spiral rune", 8607, "t_chao", (32, 32)),
    "bau": obj("closed wooden treasure chest with golden trim", 8608, "t_chao", (28, 26)),
    "bau_aberto": obj("open empty wooden treasure chest with golden trim", 8609, "t_chao", (28, 26)),
    "porta": obj("open stone archway doorway, pitch black dark opening inside a stone frame, "
                 "front view", 8620, "escuro", (32, 32)),
    "porta_chave": obj("closed iron door with big golden keyhole", 8611, "t_parede", (32, 32)),
    "porta_grade": obj("closed iron portcullis bars gate", 8612, "t_parede", (32, 32)),
    "rachada": obj("cracked damaged stone wall section with fissures", 8613, "t_parede", (32, 32)),
    "escada": obj("stone stairs going down into darkness", 8614, "t_chao", (30, 30)),
    "caverna": obj("dark cave entrance in a rocky cliff", 8615, "t_grama", (32, 32)),
    "tocha": obj("lit wall torch with orange flame", 8616, "t_parede", (20, 30)),
    # -------------------------------------------------------- telas
    "titulo": {"prompt": ("wide fantasy adventure game title backdrop, green hills, a small "
                          "stone temple with a glowing sword stuck in a rock in the center, "
                          "sunset sky with warm orange clouds, rich contrast, bottom third "
                          "darker and empty for menu buttons" + NO_TEXT),
               "seed": 8901, "gen": (1024, 512), "final": (480, 240), "kind": "wide"},
    "icon": {"prompt": ("game app icon, glowing steel sword with golden crossguard over a "
                        "teal blue shield, dark background, bold simple shapes readable at "
                        "small size" + NO_TEXT),
             "seed": 8902, "final": (64, 64), "kind": "icon"},
}

# folhas: nome -> (celula, lista de quadros). Quadro = id do ITEMS ou
# (id, transformacao). A ORDEM e o contrato com arte.js (indice = nome+i).
FLIP = "flip"
SHEETS = {
    "heroi": (CELL, ["heroi_baixo", ("heroi_baixo", FLIP), "heroi_cima", ("heroi_cima", FLIP),
                     "heroi_lado", ("heroi_lado", FLIP),
                     ("espada", "up"), ("espada", "right"), ("espada", "down"), ("espada", "left")]),
    "inimigos": (CELL, ["polvo", ("polvo", FLIP), "morcego", ("morcego", FLIP),
                        "esqueleto", ("esqueleto", FLIP), "geleia", ("geleia", "squash"),
                        "sabio", "chama", ("chama", FLIP), "pedra"]),
    "itens": (CELL, ["coracao", "cristal", "cristal_azul", "chave", "bomba", "bumerangue",
                     "mapa", "bussola", "conteiner", ("espada", "up")]),
    "tileset": (CELL, ["t_grama", "t_areia", "t_agua", ("t_agua", "shift"), "t_chao", "t_parede",
                       "t_madeira", "arvore", "rocha", "arbusto", "flores", "lapide",
                       "estatua", "bloco", "bau", "bau_aberto", "porta", "porta_chave",
                       "porta_grade", "rachada", "escada", "caverna", "tocha"]),
    "chefe": (96, ["chefe", ("chefe", "hurt")]),
}
SHEET_COLS = {"heroi": 10, "inimigos": 12, "itens": 10, "tileset": 8, "chefe": 2}


def master_sprite(src: Path, final):
    """sprite com cor-chave: RGB com fundo (0,0,0) e conteudo unblack."""
    img = Image.open(src).convert("RGB")
    bg = bg_mask_of(img, 26)
    a = np.asarray(img, dtype=np.uint8).copy()
    a[np.asarray(bg) > 0] = 0
    img = content_square(Image.fromarray(a, "RGB"), 0.04)
    # mantem a proporcao dentro do final (espada fina, item baixo)
    w, h = img.size
    k = min(final[0] / w, final[1] / h)
    nw, nh = max(1, round(w * k)), max(1, round(h * k))
    img = img.resize((nw, nh), Image.LANCZOS)
    m = bg_mask_of(img, 20).resize((nw, nh), Image.NEAREST)
    img = unblack(rgb565_dither(img))
    ia = np.asarray(img, dtype=np.uint8).copy()
    ia[np.asarray(m) > 0] = 0
    return Image.fromarray(ia, "RGB")


def master_texture(src: Path, final):
    img = Image.open(src).convert("RGB")
    w, h = img.size
    side = int(min(w, h) * 0.86)
    img = img.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
    return unblack(rgb565_dither(img.resize(final, Image.LANCZOS)))


def paste_center(dst: Image.Image, im: Image.Image, key=True):
    """cola centralizado; preto puro do im e transparente (cor-chave)."""
    x = (dst.width - im.width) // 2
    y = (dst.height - im.height) // 2
    if key:
        a = np.asarray(im.convert("RGB"), dtype=np.uint8)
        mask = Image.fromarray(np.where(a.max(axis=2) == 0, 0, 255).astype(np.uint8), "L")
        dst.paste(im, (x, y), mask)
    else:
        dst.paste(im, (x, y))
    return dst


def frame_of(fid, tf, cell, cache):
    """quadro final cell x cell (preto = transparente) com a transformacao."""
    base = cache[fid]
    im = base.copy()
    if tf == FLIP:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    elif tf in ("up", "right", "down", "left"):
        rot = {"up": 0, "right": -90, "down": 180, "left": 90}[tf]
        im = im.rotate(rot, expand=True)
    elif tf == "shift":
        # 2o quadro da agua: o material deslocado meia celula (ondula)
        a = np.asarray(im, dtype=np.uint8)
        im = Image.fromarray(np.roll(np.roll(a, cell // 2, axis=1), cell // 4, axis=0), "RGB")
    elif tf == "squash":
        im = im.resize((min(cell, int(im.width * 1.15)), max(1, int(im.height * 0.82))), Image.NEAREST)
    elif tf == "hurt":
        a = np.asarray(im, dtype=np.int32)
        on = a.max(axis=2) > 0
        a[on, 0] = np.minimum(255, a[on, 0] + 110)
        a[on, 1] = a[on, 1] // 2
        a[on, 2] = a[on, 2] // 2
        im = unblack(rgb565_dither(Image.fromarray(a.astype(np.uint8), "RGB")))
        a2 = np.asarray(im, dtype=np.uint8).copy()
        a2[~on] = 0
        im = Image.fromarray(a2, "RGB")
    cellim = Image.new("RGB", (cell, cell), (0, 0, 0))
    opaque = ITEMS.get(fid, {}).get("kind") in ("texture", "obj")
    return paste_center(cellim, im, key=not opaque)


def build_cache():
    cache = {}
    for k, it in ITEMS.items():
        src = SRC / f"{k}_src.png"
        if it["kind"] in ("wide", "icon"):
            continue
        if not src.exists():
            print(f"aviso: falta {src.name} (rode sem --master com a GPU livre)")
            continue
        if it["kind"] == "texture":
            cache[k] = master_texture(src, it["final"])
    for k, it in ITEMS.items():
        src = SRC / f"{k}_src.png"
        if it["kind"] == "sprite" and src.exists():
            cache[k] = master_sprite(src, it["final"])
        elif it["kind"] == "obj" and src.exists() and (it["base"] in cache or it["base"] == "escuro"):
            # "escuro": vao de porta — o miolo preto do render e tomado como
            # fundo pela mascara; sobre quase-preto a passagem fica escura
            tile = (Image.new("RGB", (CELL, CELL), (10, 10, 16)) if it["base"] == "escuro"
                    else cache[it["base"]].copy())
            cache[k] = paste_center(tile, master_sprite(src, it["final"]))
    return cache


def build_sheets(cache):
    feitos = []
    for name, (cell, frames) in SHEETS.items():
        cols = SHEET_COLS[name]
        rows = (len(frames) + cols - 1) // cols
        img = Image.new("RGB", (cols * cell, rows * cell), (0, 0, 0))
        for i, f in enumerate(frames):
            fid, tf = (f, None) if isinstance(f, str) else f
            if fid not in cache:
                continue
            img.paste(frame_of(fid, tf, cell, cache), ((i % cols) * cell, (i // cols) * cell))
        out = OUT / f"{name}.png"
        img.save(out, optimize=True)
        feitos.append(out)
        print(f"ok  {out.relative_to(ROOT)} ({len(frames)} quadros, {out.stat().st_size // 1024} KB)")
    # titulo e icone
    t = SRC / "titulo_src.png"
    if t.exists():
        img = snap_black(Image.open(t).convert("RGB"), 12).resize(ITEMS["titulo"]["final"], Image.LANCZOS)
        rgb565_dither(img).save(OUT / "titulo.png", optimize=True)
        feitos.append(OUT / "titulo.png")
    ic = SRC / "icon_src.png"
    if ic.exists():
        img = snap_black(Image.open(ic).convert("RGB"), 26)
        img = content_square(img, 0.06).resize((64, 64), Image.LANCZOS)
        alpha_from_lum(img).save(OUT / "icon.png")
    # folha de contato para conferencia
    sheet(feitos, SRC / "sheet.png")
    print(f"ok  {SRC / 'sheet.png'}")
    # contrato com arte.js: indices por nome (gerado, nao a mao)
    mapa = {n: [f if isinstance(f, str) else f[0] + ":" + f[1] for f in fr]
            for n, (c, fr) in SHEETS.items()}
    (SRC / "indices.json").write_text(json.dumps(mapa, indent=1))


def generate(todo):
    texto = {k: v for k, v in todo.items() if v["kind"] != "texture"}
    if texto:
        SRC.mkdir(parents=True, exist_ok=True)
        man = SRC / "manifest.json"
        lote = []
        for k, v in texto.items():
            w, h = v.get("gen", (512, 512))
            lote.append({"id": k, "prompt": v["prompt"], "seed": v["seed"],
                         "output": f"{k}_src.png", "width": w, "height": h})
        man.write_text(json.dumps(lote, indent=2))
        # --force: o lote so tem o que precisa ser (re)gerado — sem ele o
        # text2d pula o que ja tem arquivo e o --regen nao regeraria nada
        subprocess.run(["text2d", "generate-batch", str(man), "--output-dir", str(SRC),
                        "--width", "512", "--height", "512", "--steps", "8", "--force"], check=False)
    for k, v in todo.items():
        if v["kind"] != "texture":
            continue
        SRC.mkdir(parents=True, exist_ok=True)
        cmd = ["texture2d", "generate", v["prompt"], "-o", str(SRC / f"{k}_src.png"),
               "--width", "512", "--height", "512", "--seed", str(v["seed"])]
        if v.get("preset"):
            cmd += ["--preset", v["preset"]]
        subprocess.run(cmd, check=False)


def main():
    argv = sys.argv[1:]
    if "--master" not in argv:
        regen = "--regen" in argv
        only = argv[argv.index("--only") + 1:] if "--only" in argv else []
        todo = {k: v for k, v in ITEMS.items()
                if (regen or not (SRC / f"{k}_src.png").exists()) and (not only or k in only)}
        if todo:
            generate(todo)
    OUT.mkdir(parents=True, exist_ok=True)
    build_sheets(build_cache())


if __name__ == "__main__":
    main()
