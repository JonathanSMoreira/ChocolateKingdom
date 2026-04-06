# -*- coding: utf-8 -*-
"""Re-encode carousel PNGs so Android AAPT2 accepts them (RGB 8-bit, standard PNG)."""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = [
    ROOT / "assets" / "lojas-bg.png",
    ROOT / "assets" / "atracoes-bg.png",
]


def main() -> None:
    for path in ASSETS:
        if not path.is_file():
            print("skip (missing):", path)
            continue
        im = Image.open(path)
        print(path.name, "in:", im.mode, im.size, im.format)
        rgb = im.convert("RGB")
        # Standard PNG; avoid problematic color profiles / 16-bit / odd modes
        rgb.save(path, format="PNG", optimize=True, compress_level=6)
        im2 = Image.open(path)
        print(path.name, "out:", im2.mode, im2.size, im2.format)
        print("OK:", path)


if __name__ == "__main__":
    main()
