#!/usr/bin/env python3
"""
calibrate_uv_scatter.py - Measure UV scatter for mike/chatora from test data

Extracts frames from recordings and iPhone images, computes UV scatter
values, and recommends an optimal threshold for pet_color.go.

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


def rgb_to_nv12(img_bgr: np.ndarray) -> np.ndarray:
    """Convert BGR image to NV12 byte array."""
    h, w = img_bgr.shape[:2]
    # Ensure even dimensions
    h = h & ~1
    w = w & ~1
    img_bgr = img_bgr[:h, :w]

    yuv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2YUV_I420)
    # I420: Y (w*h) + U (w/2 * h/2) + V (w/2 * h/2)
    # NV12: Y (w*h) + UV interleaved (w * h/2)
    y_plane = yuv[:h, :]
    u_plane = yuv[h : h + h // 4].reshape(h // 2, w // 2)
    v_plane = yuv[h + h // 4 :].reshape(h // 2, w // 2)

    nv12 = np.empty(w * h * 3 // 2, dtype=np.uint8)
    nv12[: w * h] = y_plane.flatten()
    uv_interleaved = np.empty((h // 2, w), dtype=np.uint8)
    uv_interleaved[:, 0::2] = u_plane
    uv_interleaved[:, 1::2] = v_plane
    nv12[w * h :] = uv_interleaved.flatten()
    return nv12, w, h


def compute_uv_scatter(nv12: np.ndarray, w: int, h: int,
                        bbox_x: int, bbox_y: int, bbox_w: int, bbox_h: int) -> float:
    """Compute UV scatter (std(U) + std(V)) matching pet_color.go logic."""
    uv_base = w * h
    x0 = max(0, bbox_x)
    y0 = max(0, bbox_y)
    x1 = min(w, bbox_x + bbox_w)
    y1 = min(h, bbox_y + bbox_h)

    # Sample UV values
    samples_u = []
    samples_v = []
    for py in range(y0, y1, 2):
        for px in range(x0, x1, 2):
            uv_row = py // 2
            uv_col = (px // 2) * 2
            idx = uv_base + uv_row * w + uv_col
            if idx + 1 >= len(nv12):
                continue
            samples_u.append(int(nv12[idx]))
            samples_v.append(int(nv12[idx + 1]))

    if len(samples_u) < 16:
        return 0.0

    u = np.array(samples_u)
    v = np.array(samples_v)

    # Background filter: 16x16 UV histogram, remove bins < 2%
    hist = np.zeros((16, 16), dtype=int)
    for su, sv in zip(u, v):
        bu = min(su >> 4, 15)
        bv = min(sv >> 4, 15)
        hist[bu, bv] += 1

    min_count = max(1, len(u) * 2 // 100)
    mask = np.ones(len(u), dtype=bool)
    for i, (su, sv) in enumerate(zip(u, v)):
        bu = min(su >> 4, 15)
        bv = min(sv >> 4, 15)
        if hist[bu, bv] < min_count:
            mask[i] = False

    u_filtered = u[mask]
    v_filtered = v[mask]
    if len(u_filtered) < 8:
        return 0.0

    return float(np.std(u_filtered) + np.std(v_filtered))


def extract_frames_from_video(video_path: str, num_frames: int = 5) -> list[np.ndarray]:
    """Extract evenly-spaced frames from a video file."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"  Cannot open {video_path}")
        return []

    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total <= 0:
        # Try reading duration
        cap.release()
        return []

    indices = np.linspace(total * 0.2, total * 0.8, num_frames, dtype=int)
    frames = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret:
            frames.append(frame)
    cap.release()
    return frames


def load_image(path: str) -> np.ndarray | None:
    """Load image (supports HEIC via pillow-heif)."""
    img = cv2.imread(path)
    if img is not None:
        return img

    # HEIC fallback via Pillow + pillow-heif
    try:
        pil_img = Image.open(path).convert("RGB")
        return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    except Exception as e:
        print(f"  Cannot load {path}: {e}")
        return None


def measure_scatter_from_bgr(img_bgr: np.ndarray, label: str) -> list[float]:
    """Convert image to NV12 and measure scatter with multiple bbox sizes."""
    nv12, w, h = rgb_to_nv12(img_bgr)

    # Try several bbox sizes: center crop at different scales
    scatters = []
    for scale in [0.3, 0.5, 0.7]:
        bw = int(w * scale)
        bh = int(h * scale)
        bx = (w - bw) // 2
        by = (h - bh) // 2
        s = compute_uv_scatter(nv12, w, h, bx, by, bw, bh)
        scatters.append(s)
    return scatters


def main():
    mike_scatters = []
    chatora_scatters = []

    print("=" * 70)
    print("UV Scatter Calibration")
    print("=" * 70)

    # 1. Comic test images
    print("\n--- Comic test images ---")
    for label, path in COMIC_TESTDATA:
        if not Path(path).exists():
            print(f"  SKIP: {path}")
            continue
        img = cv2.imread(path)
        if img is None:
            continue

        # Extract panels 1-3 (same as pet_color_test.go)
        for panel_idx in range(1, 4):
            margin, gap, border = 12, 8, 2
            panel_w, panel_h = 404, 228
            cell_w, cell_h = panel_w + 2 * border, panel_h + 2 * border
            col, row = panel_idx % 2, panel_idx // 2
            x0 = margin + border + col * (cell_w + gap)
            y0 = margin + border + row * (cell_h + gap)
            panel = img[y0:y0 + panel_h, x0:x0 + panel_w]

            nv12, pw, ph = rgb_to_nv12(panel)
            s = compute_uv_scatter(nv12, pw, ph, 0, 0, pw, ph)
            print(f"  {label} panel {panel_idx}: scatter={s:.2f}")
            if label == "mike":
                mike_scatters.append(s)
            else:
                chatora_scatters.append(s)

    # 2. iPhone images
    print("\n--- iPhone images ---")
    for label, path in IPHONE_IMAGES:
        img = load_image(path)
        if img is None:
            continue
        scatters = measure_scatter_from_bgr(img, label)
        mean_s = np.mean(scatters)
        print(f"  {label} {Path(path).name}: scatter={mean_s:.2f} (range {min(scatters):.2f}-{max(scatters):.2f})")
        if label == "mike":
            mike_scatters.extend(scatters)
        else:
            chatora_scatters.extend(scatters)

    # 3. Video recordings
    print("\n--- Video recordings ---")
    for label, path in RECORDINGS:
        if not Path(path).exists():
            print(f"  SKIP: {path}")
            continue
        frames = extract_frames_from_video(path, num_frames=5)
        if not frames:
            continue
        for i, frame in enumerate(frames):
            scatters = measure_scatter_from_bgr(frame, label)
            mean_s = np.mean(scatters)
            print(f"  {label} frame {i}: scatter={mean_s:.2f}")
            if label == "mike":
                mike_scatters.extend(scatters)
            else:
                chatora_scatters.extend(scatters)

    # Summary
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)

    if not mike_scatters or not chatora_scatters:
        print("Insufficient data for calibration")
        return 1

    mike_arr = np.array(mike_scatters)
    chatora_arr = np.array(chatora_scatters)

    print(f"\nmike     (n={len(mike_arr):3d}): mean={mike_arr.mean():.2f}  std={mike_arr.std():.2f}  min={mike_arr.min():.2f}  max={mike_arr.max():.2f}")
    print(f"chatora  (n={len(chatora_arr):3d}): mean={chatora_arr.mean():.2f}  std={chatora_arr.std():.2f}  min={chatora_arr.min():.2f}  max={chatora_arr.max():.2f}")

    # Find optimal threshold (midpoint of closest pair)
    mike_min = mike_arr.min()
    chatora_max = chatora_arr.max()

    if mike_min > chatora_max:
        optimal = (mike_min + chatora_max) / 2
        margin = mike_min - chatora_max
        print(f"\nSeparable: mike_min={mike_min:.2f} > chatora_max={chatora_max:.2f}")
        print(f"Optimal threshold: {optimal:.2f} (margin={margin:.2f})")
    else:
        # Overlap — use mean of means
        optimal = (mike_arr.mean() + chatora_arr.mean()) / 2
        overlap_count = np.sum(mike_arr < optimal) + np.sum(chatora_arr > optimal)
        total = len(mike_arr) + len(chatora_arr)
        print(f"\nWARNING: Distributions overlap (mike_min={mike_min:.2f}, chatora_max={chatora_max:.2f})")
        print(f"Best threshold: {optimal:.2f} (misclassification: {overlap_count}/{total})")

    print(f"\n→ Update pet_color.go: scatterThreshold = {optimal:.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
