#!/usr/bin/env python3
# pyright: reportPrivateUsage=false
"""Test BPU buffer safety under concurrent _forward calls.

Runs two threads calling _forward simultaneously to check if
output buffers are overwritten by the other thread's call.

Usage (on RDK X5, camera daemon stopped):
    PYTHONPATH=src/common/src python3 src/detector/test_concurrent_bpu.py URL
"""

import ssl
import sys
import threading
import numpy as np
from urllib.request import urlopen, Request
from detection.image_utils import jpeg_to_yolo_nv12
from detection.yolo_detector import YoloDetector
from common.types import Detection, DetectionClass

MODEL = "/tmp/yolo_models/yolov13n_detect_bayese_640x640_nv12.bin"
url = sys.argv[1]

# --- Fetch image ---
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
with urlopen(
    Request(url, headers={"Accept": "image/jpeg"}), timeout=10, context=ctx
) as r:
    jpeg_bytes = r.read()
nv12_cat, _, _, _, _, _ = jpeg_to_yolo_nv12(jpeg_bytes)

# Black frame (no objects)
nv12_black = np.zeros(640 * 640 * 3 // 2, dtype=np.uint8)

detector = YoloDetector(model_path=MODEL, score_threshold=0.01)

# --- Baseline: single thread ---
print("=== Baseline (single thread) ===")
dets = detector.detect_nv12_readonly(nv12_cat, 640, 640)
cat_count = sum(1 for d in dets if d.class_name is DetectionClass.CAT)
print(f"Cat image: {len(dets)} dets, {cat_count} cats")
print(
    f"  top: {dets[0].class_name.label} {dets[0].confidence:.3f}"
    if dets
    else "  (none)"
)

dets_black = detector.detect_nv12_readonly(nv12_black, 640, 640)
print(f"Black image: {len(dets_black)} dets")
print()

# --- Test: concurrent _forward, check buffer corruption ---
print("=== Concurrent test (100 rounds) ===")
errors = 0
barrier = threading.Barrier(2)


def thread_cat(results: list[list[np.ndarray]]) -> None:
    """Detect on cat image, store raw outputs."""
    barrier.wait()
    outputs = detector._forward(np.frombuffer(nv12_cat, dtype=np.uint8))
    # Immediately snapshot the buffer values
    results.append([o.copy() for o in outputs])


def thread_black(results: list[list[np.ndarray]]) -> None:
    """Detect on black image concurrently."""
    barrier.wait()
    outputs = detector._forward(np.frombuffer(nv12_black, dtype=np.uint8))
    results.append([o.copy() for o in outputs])


# Get reference outputs (single thread, no interference)
ref_outputs = detector._forward(np.frombuffer(nv12_cat, dtype=np.uint8))
ref_snapshots = [o.copy() for o in ref_outputs]

for i in range(100):
    cat_results: list[list[np.ndarray]] = []
    black_results: list[list[np.ndarray]] = []
    barrier = threading.Barrier(2)

    t1 = threading.Thread(target=thread_cat, args=(cat_results,))
    t2 = threading.Thread(target=thread_black, args=(black_results,))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    if not cat_results:
        print(f"  round {i}: cat thread failed")
        errors += 1
        continue

    # Compare cat outputs with reference
    cat_outputs = cat_results[0]
    for j, (ref, got) in enumerate(zip(ref_snapshots, cat_outputs)):
        if not np.array_equal(ref, got):
            max_diff = np.max(np.abs(ref.astype(float) - got.astype(float)))
            print(f"  round {i}: tensor[{j}] MISMATCH max_diff={max_diff:.4f}")
            errors += 1
            break

if errors == 0:
    print("  All 100 rounds: outputs match reference (no corruption)")
else:
    print(f"\n  {errors}/100 rounds had buffer corruption!")

# --- Test: concurrent detect_nv12_readonly, check detection results ---
print()
print("=== Concurrent detect_nv12_readonly (100 rounds) ===")
detect_errors = 0


def detect_cat(results: list[list[Detection]]) -> None:
    barrier.wait()
    dets = detector.detect_nv12_readonly(nv12_cat, 640, 640)
    results.append(dets)


def detect_black_loop() -> None:
    """Rapid-fire black frame detection to simulate camera loop."""
    barrier.wait()
    for _ in range(5):
        detector.detect_nv12_readonly(nv12_black, 640, 640)


for i in range(100):
    cat_dets: list[list[Detection]] = []
    barrier = threading.Barrier(2)

    t1 = threading.Thread(target=detect_cat, args=(cat_dets,))
    t2 = threading.Thread(target=detect_black_loop)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    if not cat_dets or not cat_dets[0]:
        detect_errors += 1
    else:
        cats = sum(1 for d in cat_dets[0] if d.class_name is DetectionClass.CAT)
        if cats == 0:
            detect_errors += 1

if detect_errors == 0:
    print("  All 100 rounds: cat detected every time")
else:
    print(f"  {detect_errors}/100 rounds: cat NOT detected (expected ~0)")
