#!/usr/bin/env python3
"""Multi-pattern YOLO detection test.

Tests the same image through different code paths to isolate
why daemon HTTP /detect returns empty while standalone works.

Usage (on RDK X5, camera daemon stopped):
    PYTHONPATH=src/common/src python3 src/detector/test_detect_jpeg.py URL
"""
import ssl
import sys
import time
import numpy as np
from urllib.request import urlopen, Request
from detection.image_utils import jpeg_to_yolo_nv12
from detection.yolo_detector import YoloDetector

MODEL = "/tmp/yolo_models/yolov13n_detect_bayese_640x640_nv12.bin"
THRESHOLD = 0.01

url = sys.argv[1]

# --- Fetch ---
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
with urlopen(Request(url, headers={"Accept": "image/jpeg"}), timeout=10, context=ctx) as r:
    jpeg_bytes = r.read()
print(f"Downloaded: {len(jpeg_bytes)} bytes\n")

# --- NV12 conversion ---
nv12, orig_w, orig_h, scale, pad_x, pad_y = jpeg_to_yolo_nv12(jpeg_bytes)
print(f"NV12: {orig_w}x{orig_h} → 640x640, scale={scale:.4f}, pad=({pad_x},{pad_y})\n")

# --- Load model ---
detector = YoloDetector(model_path=MODEL, score_threshold=THRESHOLD)
print(f"Model loaded: {detector.input_h}x{detector.input_w}, th={THRESHOLD}\n")


def show(dets: list) -> None:
    print(f"  → {len(dets)} detections")
    for d in dets:
        print(f"    {d.class_name.label}: {d.confidence:.3f} @ ({d.bbox.x},{d.bbox.y},{d.bbox.w},{d.bbox.h})")
    print()


# --- Pattern 1: detect_nv12_readonly (minimal, known working) ---
print("=== P1: detect_nv12_readonly ===")
nv12_array = np.frombuffer(nv12, dtype=np.uint8)
outputs = detector._forward(nv12_array)
dets = detector._postprocess(outputs, (1.0, 1.0), (0.0, 0.0), (640, 640))
show(dets)

# --- Pattern 2: detect_nv12_readonly via method ---
print("=== P2: detect_nv12_readonly (method call) ===")
dets = detector.detect_nv12_readonly(nv12, 640, 640)
show(dets)

# --- Pattern 3: detect_nv12 (640x640 direct path, CLAHE disabled) ---
print("=== P3: detect_nv12 (clahe_enabled=False) ===")
detector.clahe_enabled = False
dets = detector.detect_nv12(nv12, 640, 640)
show(dets)

# --- Pattern 4: detect_nv12 with .copy() (simulates CLAHE branch) ---
print("=== P4: detect_nv12 on nv12.copy() ===")
nv12_copy = nv12.copy()
dets = detector.detect_nv12(nv12_copy, 640, 640)
show(dets)

# --- Pattern 5: detect_nv12 called twice (state accumulation?) ---
print("=== P5: detect_nv12 called 3x in sequence ===")
for i in range(3):
    dets = detector.detect_nv12(nv12, 640, 640)
    print(f"  call {i+1}: {len(dets)} dets", end="")
    if dets:
        print(f" (top: {dets[0].class_name.label} {dets[0].confidence:.3f})")
    else:
        print()
print()

# --- Pattern 6: simulate daemon — run live-like detect_nv12 then HTTP ---
print("=== P6: simulate daemon (360p letterbox then 640x640) ===")
# Create a fake 640x360 NV12 (black frame, like camera idle)
fake_360 = np.zeros(640 * 360 * 3 // 2, dtype=np.uint8)
try:
    dets_fake = detector.detect_nv12(fake_360, 640, 360)
    print(f"  fake 360p: {len(dets_fake)} dets")
except Exception as e:
    print(f"  fake 360p: error: {e}")
# Now try our image
dets = detector.detect_nv12(nv12, 640, 640)
print(f"  after 360p, 640x640: {len(dets)} dets")
if dets:
    print(f"    top: {dets[0].class_name.label} {dets[0].confidence:.3f}")
print()

# --- Pattern 7: _forward + _postprocess with conf_thres_raw check ---
print("=== P7: raw model output inspection ===")
nv12_array = np.frombuffer(nv12, dtype=np.uint8)
outputs = detector._forward(nv12_array)
print(f"  outputs: {len(outputs)} tensors")
for i, o in enumerate(outputs):
    print(f"    [{i}] shape={o.shape} min={o.min():.4f} max={o.max():.4f} mean={o.mean():.4f}")
print(f"  conf_thres_raw={detector.conf_thres_raw:.4f} (th={detector.score_threshold})")
