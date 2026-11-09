"""
Warps one of the room's paintings onto another, so the three lights (day, sunset, night)
line up and cross-fade without the room doubling. Each light is a separately generated
picture, and no two of them agree exactly on where the shelf, the rack and the windows are.

    python tools/align-paintings.py <reference> <painting> <out> [--check]

e.g.
    python tools/align-paintings.py assets/interior/day.webp assets/interior/sunset.webp assets/interior/sunset.webp

How: blocks of the reference's edges are matched in the painting's (within SEARCH pixels),
then one smooth displacement — a cubic in x and y, fitted with weights for how sure each
match is and refitted to shrug off the bad ones — is applied to the whole painting. Smooth on
purpose: following every match would bend the log walls. The painting's own content outside
the overlap is pulled in from its edge.
"""
import sys
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates

BLOCK, SEARCH, STEP = 72, 40, 36


def edges(rgb):
    g = gaussian_filter(rgb.mean(-1), 1.2)
    gy, gx = np.gradient(g)
    m = np.hypot(gx, gy)
    return m / (gaussian_filter(m, 15) + 2.0)


def basis(x, y):
    return np.stack([np.ones_like(x), x, y, x * x, x * y, y * y, x ** 3, x * x * y, x * y * y, y ** 3], -1)


def match(ref, img):
    """(centres, displacement, confidence) of each block of ref found in img."""
    H, W = ref.shape
    half = BLOCK // 2
    pts, disp, conf = [], [], []
    for y in range(half + SEARCH, H - half - SEARCH, STEP):
        for x in range(half + SEARCH, W - half - SEARCH, STEP):
            a = ref[y - half:y + half, x - half:x + half]
            if a.std() < 0.15:
                continue
            a = (a - a.mean()) / a.std()
            window = img[y - half - SEARCH:y + half + SEARCH, x - half - SEARCH:x + half + SEARCH]
            best = (-2.0, 0, 0)
            for dy in range(-SEARCH, SEARCH + 1, 2):
                for dx in range(-SEARCH, SEARCH + 1, 2):
                    b = window[SEARCH + dy:SEARCH + dy + BLOCK, SEARCH + dx:SEARCH + dx + BLOCK]
                    sd = b.std()
                    if sd < 1e-3:
                        continue
                    score = float(((b - b.mean()) * a).mean() / sd)
                    if score > best[0]:
                        best = (score, dx, dy)
            pts.append((x / W, y / H))
            disp.append(best[1:])
            conf.append(max(best[0], 0) ** 2)
    return np.array(pts, np.float32), np.array(disp, np.float32), np.array(conf, np.float32)


def fit(pts, disp, conf):
    A = basis(pts[:, 0], pts[:, 1])
    w = conf.copy()
    for _ in range(6):
        sw = np.sqrt(w)[:, None]
        cx = np.linalg.lstsq(A * sw, disp[:, 0] * sw[:, 0], rcond=None)[0]
        cy = np.linalg.lstsq(A * sw, disp[:, 1] * sw[:, 0], rcond=None)[0]
        residual = np.hypot(A @ cx - disp[:, 0], A @ cy - disp[:, 1])
        w = conf / (1 + (residual / 3.0) ** 2)
    return cx, cy, float(np.median(residual[conf > 0.05]))


def main():
    ref_path, src_path, out_path = sys.argv[1:4]
    ref = np.asarray(Image.open(ref_path).convert('RGB'), np.float32)
    src = np.asarray(Image.open(src_path).convert('RGB'), np.float32)
    if src.shape != ref.shape:
        src = np.asarray(Image.fromarray(src.astype(np.uint8)).resize(ref.shape[1::-1], Image.LANCZOS), np.float32)
    H, W = ref.shape[:2]

    pts, disp, conf = match(edges(ref), edges(src))
    cx, cy, residual = fit(pts, disp, conf)

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    B = basis(xx / W, yy / H)
    dx, dy = B @ cx, B @ cy
    print(f'{len(pts)} matches, fit residual {residual:.1f}px, shift mean {np.hypot(dx, dy).mean():.1f}px max {np.hypot(dx, dy).max():.1f}px')

    out = np.stack([map_coordinates(src[..., c], [yy + dy, xx + dx], order=3, mode='nearest') for c in range(3)], -1)
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(out_path, quality=90, method=6)

    if '--check' in sys.argv:
        after = edges(out)
        before_pts, before_disp, before_conf = match(edges(ref), after)
        keep = before_conf > 0.05
        print(f'after: remaining shift median {np.median(np.hypot(*before_disp[keep].T)):.1f}px')


if __name__ == '__main__':
    main()
