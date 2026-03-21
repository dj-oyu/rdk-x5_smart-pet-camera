#!/usr/bin/env python3
"""Analyze color features of calico vs tabby test images to find a discriminator.

Computes HSV color histograms from the center crop (proxy for YOLO bbox)
and identifies features that separate calico (mike) from tabby (chatora).

Usage:
    python3 tests/vlm/analyze_color.py
"""

import json
import math
from pathlib import Path
from PIL import Image

SCRIPT_DIR = Path(__file__).parent
IMAGES_DIR = SCRIPT_DIR / "images"


def center_crop(img: Image.Image, ratio: float = 0.6) -> Image.Image:
    """Crop center region (simulating YOLO bbox area)."""
    w, h = img.size
    cw, ch = int(w * ratio), int(h * ratio)
    left = (w - cw) // 2
    top = (h - ch) // 2
    return img.crop((left, top, left + cw, top + ch))


def rgb_to_hsv(r: int, g: int, b: int) -> tuple[float, float, float]:
    """Convert RGB (0-255) to HSV (H: 0-360, S: 0-1, V: 0-1)."""
    r, g, b = r / 255.0, g / 255.0, b / 255.0
    mx, mn = max(r, g, b), min(r, g, b)
    diff = mx - mn
    v = mx
    s = diff / mx if mx > 0 else 0
    if diff == 0:
        h = 0
    elif mx == r:
        h = 60 * (((g - b) / diff) % 6)
    elif mx == g:
        h = 60 * (((b - r) / diff) + 2)
    else:
        h = 60 * (((r - g) / diff) + 4)
    return h, s, v


def analyze_image(path: Path) -> dict:
    """Extract color features from an image."""
    img = Image.open(path).convert("RGB")
    crop = center_crop(img)
    pixels = list(crop.getdata())
    total = len(pixels)

    # Convert to HSV
    hsv_pixels = [rgb_to_hsv(r, g, b) for r, g, b in pixels]

    # --- Feature 1: Color zone ratios ---
    # Define zones in HSV space
    n_white = 0   # low saturation, high value
    n_black = 0   # low value
    n_orange = 0  # warm hue, saturated
    n_other = 0

    for h, s, v in hsv_pixels:
        if v < 0.2:
            n_black += 1
        elif s < 0.15 and v > 0.6:
            n_white += 1
        elif 10 <= h <= 45 and s > 0.2 and v > 0.2:
            n_orange += 1
        else:
            n_other += 1

    white_ratio = n_white / total
    black_ratio = n_black / total
    orange_ratio = n_orange / total

    # --- Feature 2: Saturation statistics ---
    sats = [s for _, s, _ in hsv_pixels]
    mean_sat = sum(sats) / total
    sat_var = sum((s - mean_sat) ** 2 for s in sats) / total
    sat_std = math.sqrt(sat_var)

    # --- Feature 3: Hue diversity (only for saturated pixels) ---
    sat_hues = [h for h, s, v in hsv_pixels if s > 0.15 and v > 0.2]
    if sat_hues:
        mean_hue = sum(sat_hues) / len(sat_hues)
        hue_var = sum((h - mean_hue) ** 2 for h in sat_hues) / len(sat_hues)
        hue_std = math.sqrt(hue_var)
    else:
        mean_hue = 0
        hue_std = 0

    # --- Feature 4: Color cluster count ---
    # Simple: count how many of the 3 zones are present (>5% threshold)
    zones_present = sum(1 for r in [white_ratio, black_ratio, orange_ratio] if r > 0.05)

    # --- Derived features ---
    color_total = white_ratio + black_ratio + orange_ratio
    # Orange dominance: how much of the "interesting" color is orange
    orange_dom = orange_ratio / color_total if color_total > 0.05 else 0

    # Tricolor balance: calico has 3 colors, tabby has orange-dominant
    has_white = white_ratio > 0.08
    has_black = black_ratio > 0.08
    has_orange = orange_ratio > 0.10
    n_colors = sum([has_white, has_black, has_orange])

    # Calico: white+orange co-occurrence (tabby rarely has white patches on body)
    white_orange_copresence = min(white_ratio, orange_ratio)

    calico_score = (
        white_orange_copresence * 5 +  # white+orange together = strong calico signal
        (1.5 if n_colors >= 3 else 0.0) +  # all 3 colors present
        (1.0 if has_white and white_ratio > 0.15 else 0.0) +  # substantial white
        sat_std * 2 +  # patchy colors have high sat variance
        (min(hue_std / 60, 1.0))  # hue diversity
    )

    tabby_score = (
        orange_dom * 3 +  # orange-dominant = tabby
        (orange_ratio * 4 if orange_ratio > 0.30 else 0) +  # strong orange
        (1.5 if not has_white else 0.0) +  # tabby body has no big white patches
        (0.5 if orange_ratio > black_ratio * 2 else 0)  # orange >> black
    )

    return {
        "white_ratio": round(white_ratio, 3),
        "black_ratio": round(black_ratio, 3),
        "orange_ratio": round(orange_ratio, 3),
        "mean_sat": round(mean_sat, 3),
        "sat_std": round(sat_std, 3),
        "mean_hue": round(mean_hue, 1),
        "hue_std": round(hue_std, 1),
        "zones_present": zones_present,
        "calico_score": round(calico_score, 2),
        "tabby_score": round(tabby_score, 2),
        "predicted": "mike" if calico_score > tabby_score else "chatora",
    }


def main():
    categories = ["calico", "tabby", "other_cat"]
    all_results = {}

    for cat in categories:
        cat_dir = IMAGES_DIR / cat
        if not cat_dir.exists():
            continue
        imgs = sorted(f for f in cat_dir.iterdir() if f.suffix.lower() in (".jpg", ".jpeg", ".png"))

        print(f"\n{'=' * 70}")
        print(f"  {cat.upper()} ({len(imgs)} images)")
        print(f"{'=' * 70}")
        print(f"  {'File':32s} {'W%':>5s} {'B%':>5s} {'O%':>5s} {'SatSD':>6s} {'HueSD':>6s} {'Zones':>5s} {'Cscore':>7s} {'Tscore':>7s} {'Pred':>8s}")

        correct = 0
        for img_path in imgs:
            feat = analyze_image(img_path)
            all_results[f"{cat}/{img_path.name}"] = feat

            expected = "mike" if cat == "calico" else ("chatora" if cat == "tabby" else "other")
            is_correct = feat["predicted"] == expected if cat in ("calico", "tabby") else True
            if is_correct:
                correct += 1
            marker = " OK" if is_correct else " XX"

            name = img_path.name[:30]
            print(f"  {name:32s} {feat['white_ratio']:>5.1%} {feat['black_ratio']:>5.1%} {feat['orange_ratio']:>5.1%}"
                  f" {feat['sat_std']:>6.3f} {feat['hue_std']:>6.1f} {feat['zones_present']:>5d}"
                  f" {feat['calico_score']:>7.2f} {feat['tabby_score']:>7.2f} {feat['predicted']:>8s}{marker}")

        if cat in ("calico", "tabby"):
            print(f"  Accuracy: {correct}/{len(imgs)} ({correct/len(imgs)*100:.0f}%)")

    # Summary: find best threshold
    print(f"\n{'=' * 70}")
    print("  SEPARATION ANALYSIS: calico_score - tabby_score")
    print(f"{'=' * 70}")

    calico_diffs = []
    tabby_diffs = []
    for k, v in all_results.items():
        diff = v["calico_score"] - v["tabby_score"]
        if k.startswith("calico/"):
            calico_diffs.append(diff)
        elif k.startswith("tabby/"):
            tabby_diffs.append(diff)

    if calico_diffs and tabby_diffs:
        print(f"  Calico (mike)  diff range: [{min(calico_diffs):.2f}, {max(calico_diffs):.2f}]  mean={sum(calico_diffs)/len(calico_diffs):.2f}")
        print(f"  Tabby (chatora) diff range: [{min(tabby_diffs):.2f}, {max(tabby_diffs):.2f}]  mean={sum(tabby_diffs)/len(tabby_diffs):.2f}")

        overlap_low = max(min(calico_diffs), min(tabby_diffs))
        overlap_high = min(max(calico_diffs), max(tabby_diffs))
        if overlap_low < overlap_high:
            print(f"  OVERLAP ZONE: [{overlap_low:.2f}, {overlap_high:.2f}]")
        else:
            print(f"  NO OVERLAP — clean separation possible!")

        # Try thresholds
        print(f"\n  Threshold sweep (diff = calico_score - tabby_score):")
        print(f"  {'Threshold':>10s}  {'Calico(mike)':>14s}  {'Tabby(chatora)':>16s}  {'Combined':>10s}")
        for thresh in [-1.0, -0.5, -0.2, 0.0, 0.2, 0.5, 1.0]:
            cal_ok = sum(1 for d in calico_diffs if d > thresh)
            tab_ok = sum(1 for d in tabby_diffs if d <= thresh)
            cal_acc = cal_ok / len(calico_diffs)
            tab_acc = tab_ok / len(tabby_diffs)
            combined = (cal_ok + tab_ok) / (len(calico_diffs) + len(tabby_diffs))
            print(f"  {thresh:>10.1f}  {cal_ok:>3d}/{len(calico_diffs):>2d} ({cal_acc:>5.0%})  "
                  f"{tab_ok:>3d}/{len(tabby_diffs):>2d} ({tab_acc:>5.0%})  {combined:>9.0%}")


if __name__ == "__main__":
    main()
