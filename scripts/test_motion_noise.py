#!/usr/bin/env python3
"""
Motion detection noise pipeline comparison.
Simulates base_diff pipeline on a night recording.

Usage:
    uv run scripts/test_motion_noise.py [video.mp4] [--roi 0|1] [--kernel N] [--thresh F]
    uv run scripts/test_motion_noise.py --sweep  # parameter sweep over all 3 videos
"""
import argparse
import sys
import cv2
import numpy as np
from pathlib import Path

VIDEOS = {
    "v1_easy":   "/app/smart-pet-camera/recordings/recording_20260323_005128.mp4",
    "v2_hard":   "/app/smart-pet-camera/recordings/recording_20260323_190626.mp4",
    "v3_quiet":  "/app/smart-pet-camera/recordings/recording_20260323_005616.mp4",
}
# Video3: detect at 32-39s; quiet zone is 39-48s (post-feeder).
# 20-31s contains a separate approach motion, excluded from quiet scoring.
V3_DETECT_START = 32  # seconds
V3_DETECT_END   = 39  # seconds
V3_QUIET_START  = 39  # seconds (true quiet: post-feeder period)
V3_QUIET_END    = 48  # seconds

VSE_ROI_VIDEO = [
    (159, 346, 320, 320),
    (96,  80,  640, 640),
]

BASE_INIT_FRAMES = 50


def crop_roi(frame_gray: np.ndarray, roi_idx: int) -> np.ndarray:
    x, y, w, h = VSE_ROI_VIDEO[roi_idx]
    crop = frame_gray[y:y+h, x:x+w]
    if roi_idx == 0:
        return crop
    return cv2.resize(crop, (320, 320), interpolation=cv2.INTER_AREA)


def run_video(video_path: str, roi_idx: int, kernel: int, thresh: float,
              noise_floor: int = 20, verbose: bool = True):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    base: np.ndarray | None = None
    base_count = 0
    base_valid = False
    morph_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel, kernel))

    nz_vals: list[float] = []
    triggers: list[bool] = []
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        y_small = crop_roi(gray, roi_idx)
        y_small = cv2.medianBlur(y_small, 3)

        if not base_valid:
            if base is None:
                base = y_small.astype(np.float32)
                base_count = 1
            else:
                cv2.accumulateWeighted(y_small, base, 0.02)
                base_count += 1
            if base_count >= BASE_INIT_FRAMES:
                base_valid = True
            frame_idx += 1
            continue

        bdiff_raw = cv2.absdiff(y_small, cv2.convertScaleAbs(base))
        bdiff_raw = cv2.GaussianBlur(bdiff_raw, (5, 5), 0)
        bdiff = bdiff_raw.copy()
        bdiff[bdiff < noise_floor] = 0
        b = 16
        bdiff[:b,:]=0; bdiff[-b:,:]=0; bdiff[:,:b]=0; bdiff[:,-b:]=0

        if kernel >= 3:
            bdiff = cv2.morphologyEx(bdiff, cv2.MORPH_OPEN, morph_k)

        nz = cv2.countNonZero(bdiff) / (bdiff.shape[0] * bdiff.shape[1])
        nz_vals.append(nz)
        triggers.append(nz > thresh)
        frame_idx += 1

    cap.release()
    if not nz_vals:
        return None

    fps_f = fps
    n = len(nz_vals)

    # For video 3: detect-window and true quiet window
    v3_start_f = int(V3_DETECT_START * fps_f) - BASE_INIT_FRAMES
    v3_end_f   = int(V3_DETECT_END   * fps_f) - BASE_INIT_FRAMES
    v3_quiet_s = int(V3_QUIET_START  * fps_f) - BASE_INIT_FRAMES
    v3_quiet_e = int(V3_QUIET_END    * fps_f) - BASE_INIT_FRAMES

    return {
        "n": n, "fps": fps_f,
        "nz": nz_vals, "triggers": triggers,
        "v3_window": (v3_start_f, v3_end_f),
        "v3_quiet":  (v3_quiet_s, v3_quiet_e),
    }


def score_v1(res) -> tuple[bool, str]:
    """Video1: majority of frames should trigger."""
    rate = sum(res["triggers"]) / res["n"]
    ok = rate >= 0.80
    return ok, f"trigger={rate*100:.0f}% (need ≥80%)"


def score_v2(res) -> tuple[bool, str]:
    """Video2: at least some frames should trigger."""
    rate = sum(res["triggers"]) / res["n"]
    ok = rate >= 0.10
    return ok, f"trigger={rate*100:.0f}% (need ≥10%)"


def score_v3(res) -> tuple[bool, str]:
    """Video3: quiet in true-quiet window (39-48s), detect inside 32-39s.
    20-31s is a separate approach motion, excluded from quiet scoring."""
    s, e = res["v3_window"]
    qs, qe = res["v3_quiet"]
    t = res["triggers"]
    n = res["n"]
    inside  = [t[i] for i in range(max(0,s), min(n,e))]
    quiet   = [t[i] for i in range(max(0,qs), min(n,qe))]
    in_rate  = sum(inside) / max(1, len(inside))
    out_rate = sum(quiet)  / max(1, len(quiet))
    ok = in_rate >= 0.30 and out_rate <= 0.10
    return ok, f"inside={in_rate*100:.0f}%(need≥30%) quiet={out_rate*100:.0f}%(need≤10%)"


def sweep():
    kernels     = [1, 3, 5, 7]
    thresholds  = [0.003, 0.005, 0.007, 0.010, 0.015]
    noise_floors = [15, 20]
    roi_idx = 1

    print(f"{'kernel':>7} {'thresh':>7} {'nfloor':>7}  {'V1':>20}  {'V2':>20}  {'V3':>40}  {'ALL':>5}")
    print("-" * 120)

    best = []
    for k in kernels:
        for th in thresholds:
            for nf in noise_floors:
                results = {}
                for name, path in VIDEOS.items():
                    results[name] = run_video(path, roi_idx, k, th, nf, verbose=False)

                if any(v is None for v in results.values()):
                    continue

                ok1, s1 = score_v1(results["v1_easy"])
                ok2, s2 = score_v2(results["v2_hard"])
                ok3, s3 = score_v3(results["v3_quiet"])
                all_ok = ok1 and ok2 and ok3
                mark = "✓✓✓" if all_ok else f"{'✓' if ok1 else '✗'}{'✓' if ok2 else '✗'}{'✓' if ok3 else '✗'}"
                print(f"{k:>7} {th:>7.3f} {nf:>7}  {s1:>20}  {s2:>20}  {s3:>40}  {mark:>5}")
                if all_ok:
                    best.append((k, th, nf))

    print()
    if best:
        print(f"✓✓✓ Passing combinations: {best}")
    else:
        print("No combination passed all 3 criteria.")


def single(args):
    res = run_video(args.video, args.roi, args.kernel, args.thresh, args.noise_floor)
    if res is None:
        print("Failed"); return
    n, fps = res["n"], res["fps"]
    s, e = res["v3_window"]
    qs, qe = res.get("v3_quiet", (0, 0))

    print(f"{'Frame':>7} {'sec':>5} {'nz':>8} {'trigger':>8}")
    step = max(1, n // 60)
    for i in range(0, n, step):
        sec = (i + BASE_INIT_FRAMES) / fps
        if s <= i < e:   tag = " ← WINDOW"
        elif qs <= i < qe: tag = " ← QUIET"
        else:              tag = ""
        print(f"{i+BASE_INIT_FRAMES:>7} {sec:>5.1f} {res['nz'][i]:>8.4f} {'YES' if res['triggers'][i] else 'no':>8}{tag}")

    print()
    rate = sum(res["triggers"]) / n
    print(f"Overall trigger rate: {rate*100:.1f}%  nz_mean={np.mean(res['nz']):.4f}  nz_p90={np.percentile(res['nz'],90):.4f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", nargs="?", default=VIDEOS["v1_easy"])
    parser.add_argument("--roi", type=int, default=1, choices=[0, 1])
    parser.add_argument("--kernel", type=int, default=5)
    parser.add_argument("--thresh", type=float, default=0.010)
    parser.add_argument("--noise-floor", type=int, default=20)
    parser.add_argument("--sweep", action="store_true")
    args = parser.parse_args()

    if args.sweep:
        sweep()
    else:
        single(args)


if __name__ == "__main__":
    main()
