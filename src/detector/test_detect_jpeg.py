#!/usr/bin/env python3
"""Minimal YOLO BPU test: JPEG → NV12 → detect.

Usage (on RDK X5, camera daemon stopped):
    python3 test_detect_jpeg.py /tmp/detect_input.jpg
    python3 test_detect_jpeg.py https://host:8082/api/photos/comic.jpg/panel/2
"""
import ssl
import sys
import numpy as np
from common.src.detection.image_utils import jpeg_to_yolo_nv12
from common.src.detection.yolo_detector import YoloDetector

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/detect_input.jpg"

if src.startswith("http"):
    from urllib.request import urlopen, Request
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urlopen(Request(src, headers={"Accept": "image/jpeg"}), timeout=10, context=ctx) as r:
        jpeg_bytes = r.read()
else:
    with open(src, "rb") as f:
        jpeg_bytes = f.read()

nv12, w, h, scale, px, py = jpeg_to_yolo_nv12(jpeg_bytes)
print(f"Input: {w}x{h}, NV12: {len(nv12)} bytes")

detector = YoloDetector(
    model_path="/tmp/yolo_models/yolov13n_detect_bayese_640x640_nv12.bin",
    score_threshold=0.01,
)

dets = detector.detect_nv12_readonly(nv12, 640, 640)
print(f"Detections (th=0.01): {len(dets)}")
for d in dets:
    print(f"  {d.class_name.value}: {d.confidence:.3f} @ ({d.bbox.x},{d.bbox.y},{d.bbox.w},{d.bbox.h})")
