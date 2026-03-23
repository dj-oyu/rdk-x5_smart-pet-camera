#!/usr/bin/env python3
"""
calibrate_uv_scatter.py - Measure UV scatter with YOLO bbox from all test sources

Extracts frames from recordings and iPhone images, runs YOLO to get cat/dog
bboxes, computes UV scatter within each bbox, and recommends a threshold.

Usage:
    uv run --with pillow-heif scripts/calibrate_uv_scatter.py
"""

import sys
from pathlib import Path

import cv2
import numpy as np
import pillow_heif
from PIL import Image

pillow_heif.register_heif_opener()

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "common" / "src"))

from detection.yolo_detector import YoloDetector

# ── Test data ──────────────────────────────────────────────

RECORDINGS = [
    ("mike", "recordings/recording_20260205_171631.mp4"),
    ("chatora", "recordings/recording_20260205_173334.mp4"),
]

IPHONE_IMAGES = [
    ("chatora", "/tmp/iphone-cat-img/IMG_3860.HEIC"),
    ("mike", "/tmp/iphone-cat-img/IMG_5652.HEIC"),
    ("chatora", "/tmp/iphone-cat-img/IMG_5683.HEIC"),
    ("mike", "/tmp/iphone-cat-img/IMG_5686.HEIC"),
]

COMIC_TESTDATA = [
    ("mike", "src/streaming_server/internal/webmonitor/testdata/mike.jpg"),
    ("chatora", "src/streaming_server/internal/webmonitor/testdata/chatora.jpg"),
]

NUM_VIDEO_FRAMES = 10


# ── NV12 conversion ───────────────────────────────────────

def bgr_to_nv12(img_bgr: np.ndarray) -> tuple[np.ndarray, int, int]:
    """Convert BGR image to NV12 byte array."""
    h, w = img_bgr.shape[:2]
    h, w = h & ~1, w & ~1
    img_bgr = img_bgr[:h, :w]

    yuv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2YUV_I420)
    y_plane = yuv[:h, :].flatten()
    u_plane = yuv[h : h + h // 4].reshape(h // 2, w // 2)
    v_plane = yuv[h + h // 4 :].reshape(h // 2, w // 2)

    nv12 = np.empty(w * h * 3 // 2, dtype=np.uint8)
    nv12[: w * h] = y_plane
    uv = np.empty((h // 2, w), dtype=np.uint8)
    uv[:, 0::2] = u_plane
    uv[:, 1::2] = v_plane
    nv12[w * h :] = uv.flatten()
    return nv12, w, h


def letterbox_640(img_bgr: np.ndarray) -> tuple[np.ndarray, int, int, float, int, int]:
    """Resize + letterbox to 640x640 NV12. Returns (nv12, 640, 640, scale, pad_x, pad_y)."""
    h, w = img_bgr.shape[:2]
    scale = 640 / max(w, h)
    new_w, new_h = int(w * scale) & ~1, int(h * scale) & ~1
    resized = cv2.resize(img_bgr, (new_w, new_h))

    canvas = np.zeros((640, 640, 3), dtype=np.uint8)
    pad_y = (640 - new_h) // 2
    pad_x = (640 - new_w) // 2
    canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = resized

    nv12, _, _ = bgr_to_nv12(canvas)
    return nv12, 640, 640, scale, pad_x, pad_y


# ── UV scatter ─────────────────────────────────────────────

def compute_uv_scatter(nv12: np.ndarray, w: int, h: int,
                        bx: int, by: int, bw: int, bh: int) -> float:
    """Compute UV scatter matching pet_color.go logic."""
    uv_base = w * h
    x0, y0 = max(0, bx), max(0, by)
    x1, y1 = min(w, bx + bw), min(h, by + bh)

    u_samples, v_samples = [], []
    for py in range(y0, y1, 2):
        for px in range(x0, x1, 2):
            uv_row = py // 2
            uv_col = (px // 2) * 2
            idx = uv_base + uv_row * w + uv_col
            if idx + 1 >= len(nv12):
                continue
            u_samples.append(int(nv12[idx]))
            v_samples.append(int(nv12[idx + 1]))

    if len(u_samples) < 16:
        return 0.0

    u, v = np.array(u_samples), np.array(v_samples)

    # Background filter: 16x16 histogram, remove bins < 2%
    hist = np.zeros((16, 16), dtype=int)
    for su, sv in zip(u, v):
        hist[min(su >> 4, 15), min(sv >> 4, 15)] += 1

    min_count = max(1, len(u) * 2 // 100)
    mask = np.array([hist[min(su >> 4, 15), min(sv >> 4, 15)] >= min_count
                      for su, sv in zip(u, v)])

    uf, vf = u[mask], v[mask]
    if len(uf) < 8:
        return 0.0

    return float(np.std(uf) + np.std(vf))


# ── Frame extraction ───────────────────────────────────────

def extract_video_frames(path: str, n: int) -> list[np.ndarray]:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return []
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total <= 0:
        cap.release()
        return []
    indices = np.linspace(total * 0.2, total * 0.8, n, dtype=int)
    frames = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret:
            frames.append(frame)
    cap.release()
    return frames


def load_image(path: str) -> np.ndarray | None:
    img = cv2.imread(path)
    if img is not None:
        return img
    try:
        pil_img = Image.open(path).convert("RGB")
        return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    except Exception as e:
        print(f"  Cannot load {path}: {e}")
        return None


# ── YOLO detection + scatter ───────────────────────────────

def detect_and_measure(detector: YoloDetector, img_bgr: np.ndarray,
                        label: str, source: str) -> list[dict]:
    """Run YOLO on image, measure UV scatter for each cat/dog bbox."""
    nv12_640, _, _, scale, pad_x, pad_y = letterbox_640(img_bgr)
    dets = detector.detect_nv12(nv12_640, 640, 640)

    # Also prepare full-resolution NV12 for scatter measurement
    nv12_full, fw, fh = bgr_to_nv12(img_bgr)

    results = []
    for d in dets:
        cls = d.class_name.value
        if cls not in ("cat", "dog"):
            continue

        # Map bbox from 640x640 back to original image coords
        ox = int((d.bbox.x - pad_x) / scale)
        oy = int((d.bbox.y - pad_y) / scale)
        ow = int(d.bbox.w / scale)
        oh = int(d.bbox.h / scale)

        # Clamp to image bounds
        ox = max(0, ox)
        oy = max(0, oy)
        ow = min(ow, fw - ox)
        oh = min(oh, fh - oy)

        if ow < 10 or oh < 10:
            continue

        scatter = compute_uv_scatter(nv12_full, fw, fh, ox, oy, ow, oh)
        results.append({
            "label": label,
            "source": source,
            "yolo_class": cls,
            "confidence": d.confidence,
            "bbox": (ox, oy, ow, oh),
            "scatter": scatter,
        })

    return results


def extract_comic_panels(img_bgr: np.ndarray) -> list[np.ndarray]:
    """Extract panels 1-3 from comic image."""
    margin, gap, border = 12, 8, 2
    pw, ph = 404, 228
    cw, ch = pw + 2 * border, ph + 2 * border
    panels = []
    for idx in range(1, 4):
        col, row = idx % 2, idx // 2
        x0 = margin + border + col * (cw + gap)
        y0 = margin + border + row * (ch + gap)
        panels.append(img_bgr[y0:y0 + ph, x0:x0 + pw])
    return panels


# ── Main ───────────────────────────────────────────────────

def main():
    print("Loading YOLO model...")
    detector = YoloDetector(
        model_path="models/yolo11n_detect_bayese_640x640_nv12.bin",
        score_threshold=0.15,
    )

    all_results: list[dict] = []

    # 1. Comic test images (panels = bbox-cropped, use full panel as bbox)
    print("\n--- Comic test images (panel = bbox crop) ---")
    for label, path in COMIC_TESTDATA:
        if not Path(path).exists():
            continue
        img = cv2.imread(path)
        if img is None:
            continue
        for i, panel in enumerate(extract_comic_panels(img)):
            nv12, pw, ph = bgr_to_nv12(panel)
            scatter = compute_uv_scatter(nv12, pw, ph, 0, 0, pw, ph)
            r = {"label": label, "source": f"comic_panel_{i+1}", "yolo_class": "cat",
                 "confidence": 1.0, "bbox": (0, 0, pw, ph), "scatter": scatter}
            all_results.append(r)
            print(f"  {label} panel {i+1}: scatter={scatter:.2f}")

    # 2. iPhone images (YOLO bbox)
    print("\n--- iPhone images (YOLO bbox) ---")
    for label, path in IPHONE_IMAGES:
        img = load_image(path)
        if img is None:
            continue
        results = detect_and_measure(detector, img, label, Path(path).name)
        for r in results:
            print(f"  {label} {r['source']}: {r['yolo_class']} conf={r['confidence']:.2f} "
                  f"bbox={r['bbox']} scatter={r['scatter']:.2f}")
        if not results:
            print(f"  {label} {Path(path).name}: no cat/dog detected")
        all_results.extend(results)

    # 3. Video recordings (YOLO bbox, N frames each)
    print(f"\n--- Video recordings ({NUM_VIDEO_FRAMES} frames each, YOLO bbox) ---")
    for label, path in RECORDINGS:
        if not Path(path).exists():
            continue
        frames = extract_video_frames(path, NUM_VIDEO_FRAMES)
        frame_results = []
        for i, frame in enumerate(frames):
            results = detect_and_measure(detector, frame, label, f"video_frame_{i}")
            frame_results.extend(results)
        for r in frame_results:
            print(f"  {label} {r['source']}: {r['yolo_class']} conf={r['confidence']:.2f} "
                  f"bbox={r['bbox']} scatter={r['scatter']:.2f}")
        if not frame_results:
            print(f"  {label}: no cat/dog detected in {len(frames)} frames")
        all_results.extend(frame_results)

    # ── Summary ────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("SUMMARY (bbox-based scatter measurements)")
    print("=" * 70)

    mike = [r["scatter"] for r in all_results if r["label"] == "mike" and r["scatter"] > 0]
    chatora = [r["scatter"] for r in all_results if r["label"] == "chatora" and r["scatter"] > 0]

    if not mike or not chatora:
        print("Insufficient data")
        return 1

    ma, ca = np.array(mike), np.array(chatora)
    print(f"\nmike     (n={len(ma):3d}): mean={ma.mean():.2f}  std={ma.std():.2f}  "
          f"min={ma.min():.2f}  max={ma.max():.2f}")
    print(f"chatora  (n={len(ca):3d}): mean={ca.mean():.2f}  std={ca.std():.2f}  "
          f"min={ca.min():.2f}  max={ca.max():.2f}")

    # Detail by source type
    print("\nBy source:")
    for src_prefix in ("comic_", "IMG_", "video_"):
        m = [r["scatter"] for r in all_results if r["label"] == "mike" and src_prefix in r["source"] and r["scatter"] > 0]
        c = [r["scatter"] for r in all_results if r["label"] == "chatora" and src_prefix in r["source"] and r["scatter"] > 0]
        if m or c:
            m_str = f"mean={np.mean(m):.2f} n={len(m)}" if m else "n/a"
            c_str = f"mean={np.mean(c):.2f} n={len(c)}" if c else "n/a"
            print(f"  {src_prefix:10s} mike=[{m_str}]  chatora=[{c_str}]")

    # Optimal threshold
    mike_min, chatora_max = ma.min(), ca.max()
    if mike_min > chatora_max:
        optimal = (mike_min + chatora_max) / 2
        print(f"\nSeparable: mike_min={mike_min:.2f} > chatora_max={chatora_max:.2f}")
        print(f"Optimal threshold: {optimal:.1f} (margin={mike_min - chatora_max:.2f})")
    else:
        # Sweep thresholds to find best accuracy
        best_acc, best_t = 0, 5.0
        for t in np.arange(3.0, 12.0, 0.1):
            correct = np.sum(ma > t) + np.sum(ca <= t)
            acc = correct / (len(ma) + len(ca))
            if acc > best_acc:
                best_acc, best_t = acc, t
        n_total = len(ma) + len(ca)
        n_wrong = n_total - int(best_acc * n_total)
        print(f"\nOverlap exists. Best threshold: {best_t:.1f} "
              f"(accuracy={best_acc:.1%}, {n_wrong}/{n_total} misclassified)")

    print(f"\n→ Update pet_color.go: scatterThreshold = {best_t if mike_min <= chatora_max else optimal:.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
