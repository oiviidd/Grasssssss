"""
Cuts the sample product pictures for the shop out of the cabin's own day painting, so the
placeholders are in the site's art style until real photographs replace them.

    python tools/cut-samples.py            writes assets/shop/<id>.webp
    python tools/cut-samples.py --sheet    also a contact sheet to check the crops

Boxes are in assets/interior/day.webp pixels (1672 x 941): x0, y0, x1, y1. Each crop is
scaled up 2x and its edges feathered into transparency, so it reads as a cut-out vignette
of the painting rather than a hard rectangle.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets/interior/day.webp'
OUT = ROOT / 'assets/shop'

BOXES = {
    # the shelf
    'cap-meadow':    (480, 170, 640, 300),
    'cap-moss':      (610, 170, 760, 300),
    'beanie-stack':  (738, 180, 878, 300),
    'beanie-dusk':   (856, 190, 994, 300),
    'beanie-summit': (970, 168, 1090, 300),
    'beanie-alpine': (1060, 190, 1184, 300),
    # the rack: shoulders to chest, centred on each garment
    'parka-night':     (554, 505, 746, 760),
    'jacket-fern':     (642, 505, 834, 760),
    'overshirt-sand':  (784, 505, 976, 760),
    'shirt-cloud':     (864, 505, 1056, 760),
    'coat-heather':    (1004, 505, 1196, 760),
    'jacket-ember':    (1094, 505, 1286, 760),
}


def cut(image, box):
    crop = image.crop(box).resize(((box[2] - box[0]) * 2, (box[3] - box[1]) * 2), Image.LANCZOS)
    w, h = crop.size
    # a soft rounded vignette, wider than it is feathered
    mask = Image.new('L', (w, h), 0)
    inset = round(min(w, h) * 0.08)
    ImageDraw.Draw(mask).rounded_rectangle((inset, inset, w - inset, h - inset), radius=min(w, h) * 0.22, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(min(w, h) * 0.05))
    crop.putalpha(mask)
    return crop


def main():
    image = Image.open(SRC).convert('RGB')
    OUT.mkdir(parents=True, exist_ok=True)
    crops = {}
    for name, box in BOXES.items():
        crops[name] = cut(image, box)
        crops[name].save(OUT / f'{name}.webp', quality=86, method=6)
    print(f'{len(crops)} pictures in {OUT}')

    if '--sheet' in sys.argv:
        cell = 220
        sheet = Image.new('RGB', (cell * 7, cell * 2), (40, 28, 18))
        for i, (name, crop) in enumerate(crops.items()):
            c = crop.copy()
            c.thumbnail((cell - 10, cell - 10))
            x, y = (i % 7) * cell, (i // 7) * cell
            sheet.paste(c, (x + (cell - c.width) // 2, y + (cell - c.height) // 2), c)
        sheet.save(sys.argv[sys.argv.index('--sheet') + 1])


if __name__ == '__main__':
    main()
