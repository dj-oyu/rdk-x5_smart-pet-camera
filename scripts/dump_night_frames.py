#!/usr/bin/env python3
"""
dump_night_frames.py - 夜間カメラ YOLO 検出改善の診断ツール

夜間カメラのフレームに対して複数のデノイズ+CLAHE パターンを適用し、
各パターンで YOLO 推論を実行して検出数・confidence を比較する。

Usage:
    uv run scripts/dump_night_frames.py [--num-frames 10] [--output-dir /tmp/night_test]
"""

import sys
import time
import argparse
from pathlib import Path
from collections import defaultdict

import cv2
import numpy as np

# プロジェクトルートをパスに追加
SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
CAPTURE_DIR = PROJECT_ROOT / "src" / "capture"
COMMON_SRC = PROJECT_ROOT / "src" / "common" / "src"

sys.path.insert(0, str(CAPTURE_DIR))
sys.path.insert(0, str(COMMON_SRC))

from real_shared_memory import (
    ZeroCopySharedMemory,
    CameraControlSharedMemory,
    SHM_NAME_ZEROCOPY_NIGHT,
)
from hb_mem_bindings import init_module as hb_mem_init, import_nv12_graph_buf
from detection.yolo_detector import YoloDetector

DEFAULT_MODEL = "/app/smart-pet-camera/models/yolo26n_det_bpu_bayese_640x640_nv12.bin"


def prepare_nv12_variant(
    nv12_data: np.ndarray,
    width: int,
    height: int,
    denoise_fn=None,
    clahe_clip: float = 3.0,
    neutralize_uv: bool = True,
) -> np.ndarray:
    """NV12 データにデノイズ + CLAHE + UV無彩色化を適用"""
    nv12_copy = nv12_data.copy()
    y_size = width * height
    y_plane = nv12_copy[:y_size].reshape(height, width)

    if denoise_fn is not None:
        y_plane = denoise_fn(y_plane)

    if clahe_clip > 0:
        clahe = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(8, 8))
        y_plane = clahe.apply(y_plane)

    nv12_copy[:y_size] = y_plane.flatten()
    if neutralize_uv:
        nv12_copy[y_size:] = 128

    return nv12_copy


def nv12_to_bgr(nv12_data: np.ndarray, width: int, height: int) -> np.ndarray:
    yuv_img = nv12_data[: width * height * 3 // 2].reshape((height * 3 // 2, width))
    return cv2.cvtColor(yuv_img, cv2.COLOR_YUV2BGR_NV12)


def main() -> int:
    parser = argparse.ArgumentParser(description="Night camera YOLO detection benchmark")
    parser.add_argument("--num-frames", type=int, default=10, help="Number of frames to test")
    parser.add_argument("--output-dir", type=str, default="/tmp/night_test", help="Output directory")
    parser.add_argument("--skip", type=int, default=5, help="Frames to skip between captures")
    parser.add_argument("--model-path", type=str, default=DEFAULT_MODEL, help="YOLO model path")
    parser.add_argument("--score-threshold", type=float, default=0.25, help="YOLO score threshold")
    parser.add_argument("--save-images", action="store_true", help="Save comparison images")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Initialize hb_mem
    if not hb_mem_init():
        print("ERROR: hb_mem module initialization failed")
        return 1

    # Open night camera SHM
    shm = ZeroCopySharedMemory(SHM_NAME_ZEROCOPY_NIGHT)
    if not shm.open():
        print(f"ERROR: Cannot open night camera SHM: {SHM_NAME_ZEROCOPY_NIGHT}")
        return 1

    ctrl = CameraControlSharedMemory()
    if ctrl.open():
        active = ctrl.get_active()
        print(f"Active camera: {active} ({'night' if active == 1 else 'day'})")

    # Load YOLO model
    print(f"Loading YOLO model: {Path(args.model_path).name}")
    detector = YoloDetector(
        model_path=args.model_path,
        score_threshold=args.score_threshold,
        nms_threshold=0.7,
        clahe_enabled=False,  # We handle CLAHE ourselves
    )
    print(f"Model loaded (score_threshold={args.score_threshold})")

    # Define preprocessing variants to test
    variants = {
        "raw":           {"denoise_fn": None, "clahe_clip": 0, "neutralize_uv": False},
        "uv128":         {"denoise_fn": None, "clahe_clip": 0, "neutralize_uv": True},
        "clahe3":        {"denoise_fn": None, "clahe_clip": 3.0, "neutralize_uv": False},
        "clahe3+uv128":  {"denoise_fn": None, "clahe_clip": 3.0, "neutralize_uv": True},
        "med3+clahe3+uv128": {
            "denoise_fn": lambda y: cv2.medianBlur(y, 3),
            "clahe_clip": 3.0, "neutralize_uv": True,
        },
        "med5+clahe3+uv128": {
            "denoise_fn": lambda y: cv2.medianBlur(y, 5),
            "clahe_clip": 3.0, "neutralize_uv": True,
        },
        "gauss3+clahe3+uv128": {
            "denoise_fn": lambda y: cv2.GaussianBlur(y, (3, 3), 0),
            "clahe_clip": 3.0, "neutralize_uv": True,
        },
        "bilat5+clahe3+uv128": {
            "denoise_fn": lambda y: cv2.bilateralFilter(y, 5, 50, 50),
            "clahe_clip": 3.0, "neutralize_uv": True,
        },
    }

    # False positive labels (objects not present in the scene)
    FALSE_LABELS = {"toilet", "person", "dog", "cat"}

    # Stats accumulators
    stats: dict[str, dict] = {name: {"det_count": 0, "total_conf": 0.0, "frames_with_det": 0, "prep_ms": 0.0, "fp_count": 0} for name in variants}

    print(f"\nTesting {len(variants)} variants on {args.num_frames} frames (skip={args.skip})...\n")

    captured = 0
    skipped = 0
    last_version = -1

    while captured < args.num_frames:
        zc_frame = shm.get_frame()
        if zc_frame is None or zc_frame.plane_cnt != 2:
            time.sleep(0.03)
            continue

        if zc_frame.version == last_version:
            time.sleep(0.03)
            continue
        last_version = zc_frame.version

        hb_mem_buffer = None
        try:
            y_arr, uv_arr, hb_mem_buffer = import_nv12_graph_buf(
                raw_buf_data=zc_frame.hb_mem_buf_data,
                expected_plane_sizes=zc_frame.plane_size,
            )
            nv12_data = np.concatenate([y_arr, uv_arr])
        except Exception as e:
            print(f"  import failed: {e}")
            if hb_mem_buffer:
                hb_mem_buffer.release()
            continue

        width = zc_frame.width
        height = zc_frame.height
        frame_num = zc_frame.frame_number
        hb_mem_buffer.release()

        # Skip frames for diversity
        if skipped < args.skip:
            skipped += 1
            continue
        skipped = 0

        # Run each variant
        frame_results = {}
        for name, cfg in variants.items():
            t0 = time.perf_counter()
            nv12_variant = prepare_nv12_variant(
                nv12_data, width, height,
                denoise_fn=cfg["denoise_fn"],
                clahe_clip=cfg["clahe_clip"],
                neutralize_uv=cfg["neutralize_uv"],
            )
            prep_ms = (time.perf_counter() - t0) * 1000

            # Run YOLO on each ROI and collect all detections
            rois = detector.get_roi_regions_720p()
            all_dets = []
            for roi_idx in range(len(rois)):
                dets = detector.detect_nv12_roi_720p(
                    nv12_data=nv12_variant,
                    roi_index=roi_idx,
                    brightness_avg=-1.0,  # CLAHE already applied
                )
                all_dets.extend(dets)

            det_labels = [d.class_name.value for d in all_dets]
            fp_count = sum(1 for lbl in det_labels if lbl in FALSE_LABELS)
            tp_dets = [d for d in all_dets if d.class_name.value not in FALSE_LABELS]
            tp_count = len(tp_dets)
            avg_conf = sum(d.confidence for d in tp_dets) / tp_count if tp_count > 0 else 0.0

            stats[name]["det_count"] += tp_count
            stats[name]["total_conf"] += sum(d.confidence for d in tp_dets)
            stats[name]["frames_with_det"] += 1 if tp_count > 0 else 0
            stats[name]["fp_count"] += fp_count
            stats[name]["prep_ms"] += prep_ms
            for lbl in det_labels:
                stats[name].setdefault("labels", defaultdict(int))
                stats[name]["labels"][lbl] += 1

            frame_results[name] = (tp_count, avg_conf, det_labels, prep_ms)

        captured += 1

        # Per-frame summary
        line = f"  [{captured:2d}/{args.num_frames}] f={frame_num}: "
        parts = []
        for name in variants:
            dc, ac, labels, _ = frame_results[name]
            label_str = ",".join(labels) if labels else ""
            parts.append(f"{name}={dc}d" + (f"({ac:.2f} {label_str})" if dc > 0 else ""))
        print(line + " | ".join(parts))

        # Save comparison image for first frame
        if args.save_images and captured == 1:
            panels = []
            labels = []
            for name, cfg in variants.items():
                nv12_v = prepare_nv12_variant(
                    nv12_data, width, height,
                    denoise_fn=cfg["denoise_fn"],
                    clahe_clip=cfg["clahe_clip"],
                    neutralize_uv=cfg["neutralize_uv"],
                )
                bgr = nv12_to_bgr(nv12_v, width, height)
                dc, ac, _, _ = frame_results[name]
                panels.append(bgr)
                labels.append(f"{name} det={dc}")

            # Resize to manageable width
            target_w = 320
            resized = []
            for p in panels:
                scale = target_w / p.shape[1]
                resized.append(cv2.resize(p, (target_w, int(p.shape[0] * scale))))

            combined = np.hstack(resized)
            h = resized[0].shape[0]
            for i, label in enumerate(labels):
                cv2.putText(combined, label, (i * target_w + 5, 20),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1)
            cv2.imwrite(str(output_dir / "variants_compare.png"), combined)
            print(f"  -> Saved comparison image: {output_dir}/variants_compare.png")

    ctrl.close()
    shm.close()

    # Summary
    print(f"\n{'='*85}")
    print(f"{'Variant':<28} {'TP':>3} {'FP':>3} {'TP/f':>5} {'Hit%':>5} {'Conf':>6} {'Prep':>7}  Labels")
    print(f"{'='*85}")
    for name in variants:
        s = stats[name]
        n = args.num_frames
        det_per_f = s["det_count"] / n if n > 0 else 0
        frames_pct = s["frames_with_det"] / n * 100 if n > 0 else 0
        avg_conf = s["total_conf"] / s["det_count"] if s["det_count"] > 0 else 0
        avg_prep = s["prep_ms"] / n if n > 0 else 0
        label_summary = ", ".join(f"{k}:{v}" for k, v in sorted(s.get("labels", {}).items())) if s.get("labels") else "-"
        print(f"  {name:<26} {s['det_count']:>3} {s['fp_count']:>3} {det_per_f:>5.1f} {frames_pct:>4.0f}% {avg_conf:>6.3f} {avg_prep:>6.1f}ms  {label_summary}")
    print(f"{'='*85}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
