"""
Measures a reference photograph into tools/reference-metrics.json.

Every "does it match?" question in this project reduces to four numbers, and up to now
they were produced by throwaway scripts and pasted into the fitter by hand. This
consolidates them so each iteration is one command.

    python tools/measure_reference.py Reference/kazmos.jpg --exclude-x 0.72 1.0

What it extracts:

  skyline      grass/sky boundary at 21 columns, 0 = top of frame. The fitter
               (tools/fit-hill.mjs) hill-climbs the hill + camera against this.
  palette      grass-region mean and percentiles, used to fit the albedo bake so the
               *rendered* result matches rather than the source texture.
  edgeFreq     blade edge frequency along horizontal scanlines — a proxy for blade
               width. Independent of camera height.
  raggedness   detrended std of the topmost grass pixel — a proxy for blade height in
               frame. Together with edgeFreq this separates "blades are the wrong size"
               from "the camera is at the wrong height", which look identical otherwise.

--exclude-x takes fractions of frame width to ignore, for foreground objects that are
not grass and not sky (the cabin in the Kazmos frame). Without it they read as a
skyline spike and drag the whole fit sideways.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

COLUMNS = 21


def load(path):
    image = Image.open(path).convert("RGB")
    return np.asarray(image).astype(float) / 255.0


def grass_mask(rgb):
    """Grass is green-dominant; sky is blue-dominant. One channel difference separates
    them far more reliably than any luminance threshold, because the scene's sky and its
    grass overlap heavily in brightness."""
    return (rgb[:, :, 1] - rgb[:, :, 2]) > 0.02


def column_included(x, width, exclusions):
    f = x / width
    return not any(lo <= f <= hi for lo, hi in exclusions)


def skyline(rgb, exclusions):
    """
    Two different "top of the grass" per column, because the two metrics want opposite
    things:

      solid  first row where grass persists for 18 rows. Rejects butterflies and drifting
             petals, so it tracks the landform. This is what the hill fit matches.
      raw    first grass pixel at all, including individual blade tips. Noisy by
             construction — that noise *is* the raggedness signal.

    Using the persistent version for both would erase exactly the wispy tips that
    raggedness exists to measure.
    """
    mask = grass_mask(rgb)
    height, width = mask.shape
    solid = np.full(width, np.nan)
    raw = np.full(width, np.nan)

    for x in range(width):
        if not column_included(x, width, exclusions):
            continue
        column = mask[:, x]
        hit = np.flatnonzero(column)
        if len(hit):
            raw[x] = hit[0]
        for y in range(height):
            if column[y] and column[y:min(y + 18, height)].mean() > 0.85:
                solid[x] = y
                break

    return solid, raw, height, width


def smooth(values, window=25):
    valid = ~np.isnan(values)
    if valid.sum() == 0:
        return values
    filled = np.interp(np.arange(len(values)), np.flatnonzero(valid), values[valid])
    kernel = np.ones(window) / window
    padded = np.pad(filled, (window // 2, window // 2), mode="edge")
    return np.convolve(padded, kernel, mode="valid")[:len(values)]


def sample_columns(profile, height, width, exclusions):
    out = []
    for i in range(COLUMNS):
        x = min(width - 1, int(i / (COLUMNS - 1) * width))
        if not column_included(x, width, exclusions):
            out.append(None)
        else:
            out.append(round(float(profile[x]) / height, 4))
    return out


def raggedness(tops, height, window=81):
    """Detrend with a wide median so only blade-scale variation survives."""
    valid = ~np.isnan(tops)
    t = tops[valid]
    if len(t) < window:
        return None

    half = window // 2
    padded = np.pad(t, (half, half), mode="edge")
    trend = np.array([np.median(padded[i:i + window]) for i in range(len(t))])
    residual = t - trend

    return {
        "std": round(float(residual.std()) / height, 5),
        "p90p10": round(float(np.percentile(residual, 90) - np.percentile(residual, 10)) / height, 5),
    }


def edge_frequency(rgb, exclusions, bands):
    luminance = rgb.mean(2)
    height, width = luminance.shape
    keep = np.array([column_included(x, width, exclusions) for x in range(width)])

    result = {}
    for name, (y0, y1) in bands.items():
        counts = []
        for fraction in np.linspace(y0, y1, 25):
            y = min(height - 1, int(fraction * height))
            row = luminance[y][keep]
            if len(row) < 3:
                continue
            d = np.diff(row)
            d[np.abs(d) < 0.004] = 0        # ignore compression noise
            signs = np.sign(d)
            signs = signs[signs != 0]
            if len(signs) < 2:
                continue
            counts.append(np.sum(signs[1:] != signs[:-1]) / len(row))
        result[name] = round(float(np.median(counts)), 4) if counts else None
    return result


def palette(rgb, exclusions, y0=0.55):
    height, width, _ = rgb.shape
    keep = np.array([column_included(x, width, exclusions) for x in range(width)])
    region = rgb[int(y0 * height):, keep, :].reshape(-1, 3)
    mask = (region[:, 1] - region[:, 2]) > 0.02
    grass = region[mask] if mask.sum() > 100 else region

    to8 = lambda v: [int(round(c * 255)) for c in v]
    return {
        "mean": to8(grass.mean(0)),
        "p05": to8(np.percentile(grass, 5, axis=0)),
        "p50": to8(np.percentile(grass, 50, axis=0)),
        "p95": to8(np.percentile(grass, 95, axis=0)),
        "greenMinusBlue": round(float((grass[:, 1] - grass[:, 2]).mean() * 255), 1),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--exclude-x", nargs=2, type=float, action="append", default=[],
                        metavar=("LO", "HI"),
                        help="fraction-of-width range to ignore, repeatable")
    parser.add_argument("--out", default="tools/reference-metrics.json")
    args = parser.parse_args()

    if not os.path.exists(args.image):
        sys.exit("no such image: " + args.image)

    exclusions = [tuple(e) for e in args.exclude_x]
    rgb = load(args.image)

    solid, raw, height, width = skyline(rgb, exclusions)
    profile = smooth(solid)

    metrics = {
        "source": args.image.replace("\\", "/"),
        "size": [width, height],
        "aspect": round(width / height, 3),
        "excludeX": exclusions,
        "skyline": sample_columns(profile, height, width, exclusions),
        "raggedness": raggedness(raw, height),
        "edgeFrequency": edge_frequency(rgb, exclusions, {
            "upper": (0.58, 0.70), "mid": (0.70, 0.85), "lower": (0.85, 0.98)
        }),
        "palette": palette(rgb, exclusions),
    }

    with open(args.out, "w", encoding="utf8") as f:
        json.dump(metrics, f, indent=1)

    print("wrote", args.out)
    print(json.dumps(metrics, indent=1))


if __name__ == "__main__":
    main()
