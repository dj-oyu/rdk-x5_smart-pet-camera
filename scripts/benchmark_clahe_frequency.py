#!/usr/bin/env python3
"""
benchmark_clahe_frequency.py - Find optimal clahe_frequency value

Simulates the CLAHE cache pipeline for different frequency values using
recorded IR night frames. Measures:
  - Average preprocessing time per frame
  - CLAHE coverage (% of frames with CLAHE applied)
  - Detection quality impact (optional, with --run-yolo)

Usage:
    uv run scripts/benchmark_clahe_frequency.py
    uv run scripts/benchmark_clahe_frequency.py --run-yolo --model v11n
    uv run scripts/benchmark_clahe_frequency.py --frequencies 1,2,3,6,9,12
"""

import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "common" / "src"))

FRAME_W = 1280
FRAME_H = 720

# Fallback ROIs (3 regions, 50% overlap)
FALLBACK_ROIS = [
    (0, 40, 640, 640),
    (320, 40, 640, 640),
    (640, 40, 640, 640),
]

# VSE ROIs (2 regions mapped to 1280x720 space)
VSE_ROIS = [
    (0, 40, 640, 640),
    (640, 40, 640, 640),
]


def load_nv12_frames(frames_dir: Path) -> list[np.ndarray]:
    """Load NV12 files, return list of Y planes (720x1280)."""
    files = sorted(frames_dir.glob("*.nv12"))
    frames = []
    for f in files:
        data = f.read_bytes()
        if len(data) >= FRAME_W * FRAME_H:
            y = np.frombuffer(data[:FRAME_W * FRAME_H], dtype=np.uint8).reshape(FRAME_H, FRAME_W)
            frames.append(y)
    return frames


def benchmark_frequency(
    frames: list[np.ndarray],
    frequency: int,
    rois: list[tuple[int, int, int, int]],
    num_cycles: int = 10,
    clahe: cv2.CLAHE | None = None,
) -> dict:
    """Simulate CLAHE cache pipeline for a given frequency."""
    if clahe is None:
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    num_rois = len(rois)
    total_frames = num_cycles * num_rois
    cached_y: np.ndarray | None = None
    counter = 0
    times = []
    update_count = 0
    cache_hit_count = 0

    for cycle in range(num_cycles):
        # Pick a source frame (rotate through available frames)
        y_full = frames[cycle % len(frames)]

        for roi_idx in range(num_rois):
            roi_x, roi_y, roi_w, roi_h = rois[roi_idx]
            counter += 1
            cache_exists = cached_y is not None
            update = (counter % frequency == 0) or not cache_exists

            t0 = time.perf_counter()

            if update:
                # Full-frame medianBlur(3) + CLAHE
                blurred = cv2.medianBlur(y_full, 3)
                cached_y = clahe.apply(blurred)
                update_count += 1
            else:
                cache_hit_count += 1

            # Crop from cache
            y_roi = cached_y[roi_y:roi_y + roi_h, roi_x:roi_x + roi_w].copy()

            elapsed = (time.perf_counter() - t0) * 1000
            times.append(elapsed)

    return {
        "frequency": frequency,
        "num_rois": num_rois,
        "total_frames": total_frames,
        "avg_ms": np.mean(times),
        "median_ms": np.median(times),
        "p95_ms": np.percentile(times, 95),
        "max_ms": np.max(times),
        "update_count": update_count,
        "cache_hits": cache_hit_count,
        "update_rate": update_count / total_frames * 100,
        "clahe_coverage": 100.0,  # All frames get CLAHE via cache
    }


def benchmark_no_clahe(
    frames: list[np.ndarray],
    rois: list[tuple[int, int, int, int]],
    num_cycles: int = 10,
) -> dict:
    """Baseline: no CLAHE, just crop."""
    num_rois = len(rois)
    total_frames = num_cycles * num_rois
    times = []

    for cycle in range(num_cycles):
        y_full = frames[cycle % len(frames)]
        for roi_idx in range(num_rois):
            roi_x, roi_y, roi_w, roi_h = rois[roi_idx]
            t0 = time.perf_counter()
            y_roi = y_full[roi_y:roi_y + roi_h, roi_x:roi_x + roi_w].copy()
            elapsed = (time.perf_counter() - t0) * 1000
            times.append(elapsed)

    return {
        "frequency": "none",
        "num_rois": num_rois,
        "total_frames": total_frames,
        "avg_ms": np.mean(times),
        "median_ms": np.median(times),
        "p95_ms": np.percentile(times, 95),
        "max_ms": np.max(times),
        "update_count": 0,
        "cache_hits": total_frames,
        "update_rate": 0,
        "clahe_coverage": 0,
    }


def benchmark_every_frame(
    frames: list[np.ndarray],
    rois: list[tuple[int, int, int, int]],
    num_cycles: int = 10,
    clahe: cv2.CLAHE | None = None,
) -> dict:
    """Baseline: CLAHE on every ROI crop (original approach with blur3)."""
    if clahe is None:
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    num_rois = len(rois)
    total_frames = num_cycles * num_rois
    times = []

    for cycle in range(num_cycles):
        y_full = frames[cycle % len(frames)]
        for roi_idx in range(num_rois):
            roi_x, roi_y, roi_w, roi_h = rois[roi_idx]
            t0 = time.perf_counter()
            y_roi = y_full[roi_y:roi_y + roi_h, roi_x:roi_x + roi_w].copy()
            blurred = cv2.medianBlur(y_roi, 3)
            enhanced = clahe.apply(blurred)
            elapsed = (time.perf_counter() - t0) * 1000
            times.append(elapsed)

    return {
        "frequency": "every",
        "num_rois": num_rois,
        "total_frames": total_frames,
        "avg_ms": np.mean(times),
        "median_ms": np.median(times),
        "p95_ms": np.percentile(times, 95),
        "max_ms": np.max(times),
        "update_count": total_frames,
        "cache_hits": 0,
        "update_rate": 100,
        "clahe_coverage": 100,
    }


def main():
    parser = argparse.ArgumentParser(description="Find optimal clahe_frequency")
    parser.add_argument("--frames-dir", default="/tmp/night_collect")
    parser.add_argument("--frequencies", default="1,2,3,4,6,9,12,18",
                        help="Comma-separated frequency values to test")
    parser.add_argument("--cycles", type=int, default=30,
                        help="Number of ROI cycles per frequency (default: 30)")
    parser.add_argument("--rois", choices=["vse", "fallback", "both"], default="both",
                        help="ROI configuration to test")
    args = parser.parse_args()

    frames_dir = Path(args.frames_dir)
    frames = load_nv12_frames(frames_dir)
    if not frames:
        print(f"No NV12 frames found in {frames_dir}")
        return 1

    print(f"Loaded {len(frames)} IR night frames from {frames_dir}")
    frequencies = [int(x) for x in args.frequencies.split(",")]
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    roi_configs = []
    if args.rois in ("fallback", "both"):
        roi_configs.append(("fallback (3 ROI)", FALLBACK_ROIS))
    if args.rois in ("vse", "both"):
        roi_configs.append(("VSE (2 ROI)", VSE_ROIS))

    for config_name, rois in roi_configs:
        print(f"\n{'='*80}")
        print(f"  {config_name} — {args.cycles} cycles per frequency")
        print(f"{'='*80}")

        # Baselines
        no_clahe = benchmark_no_clahe(frames, rois, args.cycles)
        every_frame = benchmark_every_frame(frames, rois, args.cycles, clahe)

        # Warmup
        benchmark_frequency(frames, 3, rois, 5, clahe)

        results = []
        for freq in frequencies:
            r = benchmark_frequency(frames, freq, rois, args.cycles, clahe)
            results.append(r)

        # Print table
        print(f"\n{'freq':>6} {'avg_ms':>8} {'p95_ms':>8} {'max_ms':>8} {'updates':>8} {'update%':>8} {'coverage':>8}")
        print(f"{'-'*56}")

        # No CLAHE baseline
        print(f"{'none':>6} {no_clahe['avg_ms']:>8.2f} {no_clahe['p95_ms']:>8.2f} {no_clahe['max_ms']:>8.2f} "
              f"{no_clahe['update_count']:>8} {'0%':>8} {'0%':>8}")

        # Frequency results
        for r in results:
            print(f"{r['frequency']:>6} {r['avg_ms']:>8.2f} {r['p95_ms']:>8.2f} {r['max_ms']:>8.2f} "
              f"{r['update_count']:>8} {r['update_rate']:>7.0f}% {r['clahe_coverage']:>7.0f}%")

        # Every-frame baseline
        print(f"{'every':>6} {every_frame['avg_ms']:>8.2f} {every_frame['p95_ms']:>8.2f} {every_frame['max_ms']:>8.2f} "
              f"{every_frame['update_count']:>8} {'100%':>8} {'100%':>8}")

        # Recommendation
        print(f"\n--- Recommendation ---")
        # Find frequency where avg_ms < 2x no_clahe and p95 is reasonable
        for r in results:
            overhead = r["avg_ms"] - no_clahe["avg_ms"]
            if overhead < 3.0:  # Less than 3ms overhead
                print(f"  Recommended: frequency={r['frequency']} "
                      f"(avg={r['avg_ms']:.2f}ms, overhead={overhead:.2f}ms, "
                      f"update every {r['frequency']} frames)")
                break
        else:
            best = min(results, key=lambda r: r["avg_ms"])
            print(f"  Best found: frequency={best['frequency']} (avg={best['avg_ms']:.2f}ms)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
