#!/usr/bin/env python3
"""
benchmark_median_quality.py - Compare medianBlur kernel 3 vs 5 detection quality

Loads recorded IR night frames from /tmp/night_collect/*.nv12,
applies medianBlur(k=3) and medianBlur(k=5) + CLAHE, runs YOLO inference,
and compares detection results.

Usage:
    uv run scripts/benchmark_median_quality.py [--model v11n] [--frames-dir /tmp/night_collect]
"""

import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np

# Add project paths
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "common" / "src"))

from detection.yolo_detector import YoloDetector

FRAME_W = 1280
FRAME_H = 720
ROI_W = 640
ROI_H = 640

# 3 ROIs with 50% overlap (same as detector daemon)
ROIS = [
    (0, 40, 640, 640),       # left
    (320, 40, 640, 640),     # center
    (640, 40, 640, 640),     # right
]


def load_nv12_y_plane(path: Path) -> np.ndarray:
    """Load NV12 file and return full buffer."""
    data = path.read_bytes()
    return np.frombuffer(data, dtype=np.uint8)


def apply_clahe_variant(
    nv12_array: np.ndarray,
    width: int,
    height: int,
    median_kernel: int,
    clahe: cv2.CLAHE,
) -> np.ndarray:
    """Apply medianBlur(k) + CLAHE + UV=128 to NV12 data."""
    result = nv12_array.copy()
    y_size = width * height
    y_plane = result[:y_size].reshape(height, width)

    y_plane = cv2.medianBlur(y_plane, median_kernel)
    y_enhanced = clahe.apply(y_plane)

    result[:y_size] = y_enhanced.flatten()
    result[y_size:] = 128
    return result


def main():
    parser = argparse.ArgumentParser(description="Compare medianBlur kernel 3 vs 5")
    parser.add_argument("--model", default="v11n", help="Model variant (default: v11n)")
    parser.add_argument("--frames-dir", default="/tmp/night_collect",
                        help="Directory with .nv12 frames")
    parser.add_argument("--score-threshold", type=float, default=0.10,
                        help="Score threshold (default: 0.10, same as night mode)")
    args = parser.parse_args()

    frames_dir = Path(args.frames_dir)
    nv12_files = sorted(frames_dir.glob("*.nv12"))
    if not nv12_files:
        print(f"No .nv12 files found in {frames_dir}")
        return 1

    print(f"Found {len(nv12_files)} NV12 frames in {frames_dir}")

    # Model path
    model_map = {
        "v11n": "models/yolo11n_detect_bayese_640x640_nv12.bin",
        "v8n": "models/yolov8n_detect_bayese_640x640_nv12.bin",
    }
    model_path = model_map.get(args.model, args.model)
    print(f"Model: {model_path}")
    print(f"Score threshold: {args.score_threshold}")

    # Initialize detector
    detector = YoloDetector(
        model_path=model_path,
        score_threshold=args.score_threshold,
        clahe_enabled=False,  # We apply CLAHE manually
    )

    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))

    # Results accumulators
    k3_detections_all = []
    k5_detections_all = []
    k3_times = []
    k5_times = []

    print(f"\n{'='*80}")
    print(f"{'Frame':<40} {'k=3 dets':>10} {'k=5 dets':>10} {'k=3 ms':>8} {'k=5 ms':>8}")
    print(f"{'='*80}")

    for nv12_path in nv12_files:
        nv12_data = load_nv12_y_plane(nv12_path)
        fname = nv12_path.name

        k3_frame_dets = []
        k5_frame_dets = []

        for roi_x, roi_y, roi_w, roi_h in ROIS:
            # Crop ROI
            cropped_raw = detector._crop_nv12_roi(
                nv12_data, FRAME_W, FRAME_H, roi_x, roi_y, roi_w, roi_h
            )

            # --- kernel 3 ---
            t0 = time.perf_counter()
            processed_k3 = apply_clahe_variant(cropped_raw, roi_w, roi_h, 3, clahe)
            k3_prep_ms = (time.perf_counter() - t0) * 1000

            dets_k3 = detector.detect_nv12(processed_k3, roi_w, roi_h)
            # Offset back to frame coords
            for d in dets_k3:
                d.bbox.x += roi_x
                d.bbox.y += roi_y
            k3_frame_dets.extend(dets_k3)
            k3_times.append(k3_prep_ms)

            # --- kernel 5 ---
            t0 = time.perf_counter()
            processed_k5 = apply_clahe_variant(cropped_raw, roi_w, roi_h, 5, clahe)
            k5_prep_ms = (time.perf_counter() - t0) * 1000

            dets_k5 = detector.detect_nv12(processed_k5, roi_w, roi_h)
            for d in dets_k5:
                d.bbox.x += roi_x
                d.bbox.y += roi_y
            k5_frame_dets.extend(dets_k5)
            k5_times.append(k5_prep_ms)

        k3_detections_all.append(k3_frame_dets)
        k5_detections_all.append(k5_frame_dets)

        print(f"{fname:<40} {len(k3_frame_dets):>10} {len(k5_frame_dets):>10} "
              f"{np.mean(k3_times[-3:]):>7.1f} {np.mean(k5_times[-3:]):>7.1f}")

        # Show individual detections if different
        k3_classes = sorted([(str(d.class_name), f"{d.confidence:.2f}") for d in k3_frame_dets])
        k5_classes = sorted([(str(d.class_name), f"{d.confidence:.2f}") for d in k5_frame_dets])
        if k3_classes != k5_classes:
            print(f"  k=3: {k3_classes}")
            print(f"  k=5: {k5_classes}")

    # Summary
    print(f"\n{'='*80}")
    print("SUMMARY")
    print(f"{'='*80}")

    total_k3 = sum(len(d) for d in k3_detections_all)
    total_k5 = sum(len(d) for d in k5_detections_all)

    # Class breakdown
    k3_by_class: dict[str, list[float]] = {}
    k5_by_class: dict[str, list[float]] = {}
    for frame_dets in k3_detections_all:
        for d in frame_dets:
            k3_by_class.setdefault(str(d.class_name), []).append(d.confidence)
    for frame_dets in k5_detections_all:
        for d in frame_dets:
            k5_by_class.setdefault(str(d.class_name), []).append(d.confidence)

    all_classes = sorted(set(list(k3_by_class.keys()) + list(k5_by_class.keys())))

    print(f"\n{'Class':<20} {'k=3 count':>10} {'k=3 conf':>10} {'k=5 count':>10} {'k=5 conf':>10}")
    print(f"{'-'*60}")
    for cls in all_classes:
        k3_confs = k3_by_class.get(cls, [])
        k5_confs = k5_by_class.get(cls, [])
        k3_avg = np.mean(k3_confs) if k3_confs else 0
        k5_avg = np.mean(k5_confs) if k5_confs else 0
        print(f"{cls:<20} {len(k3_confs):>10} {k3_avg:>10.3f} {len(k5_confs):>10} {k5_avg:>10.3f}")

    print(f"\nTotal detections: k=3={total_k3}, k=5={total_k5}")
    print(f"Preprocessing time: k=3 avg={np.mean(k3_times):.1f}ms, k=5 avg={np.mean(k5_times):.1f}ms")
    print(f"Speedup: {np.mean(k5_times) / np.mean(k3_times):.1f}x faster with k=3")

    diff = abs(total_k3 - total_k5)
    if diff <= max(total_k3, total_k5) * 0.1:
        print("\nVERDICT: No significant quality difference. kernel 3 recommended.")
    else:
        print(f"\nVERDICT: {diff} detection difference ({diff/max(total_k3,total_k5)*100:.0f}%). Review class breakdown above.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
