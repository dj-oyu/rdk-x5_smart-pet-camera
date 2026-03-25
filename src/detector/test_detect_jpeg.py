#!/usr/bin/env python3
"""Minimal YOLO BPU test: URL → JPEG → NV12 → detect.

Usage (on RDK X5, camera daemon stopped):
    python3 test_detect_jpeg.py https://m5stack-ai-pyramid.tail848eb5.ts.net:8082/api/photos/comic_20260325_014639_chatora.jpg/panel/2
"""
import ssl
import sys
import numpy as np
from urllib.request import urlopen, Request
from common.src.detection.image_utils import jpeg_to_yolo_nv12
from common.src.detection.yolo_detector import YoloDetector

url = sys.argv[1]

# Fetch JPEG
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
with urlopen(Request(url, headers={"Accept": "image/jpeg"}), timeout=10, context=ctx) as r:
    jpeg_bytes = r.read()
print(f"Downloaded: {len(jpeg_bytes)} bytes from {url}")

# JPEG → NV12
nv12, w, h, scale, px, py = jpeg_to_yolo_nv12(jpeg_bytes)
print(f"Original: {w}x{h}, scale={scale:.4f}, pad=({px},{py}), NV12={len(nv12)} bytes")

# Load model & detect
detector = YoloDetector(
    model_path="/tmp/yolo_models/yolov13n_detect_bayese_640x640_nv12.bin",
    score_threshold=0.01,
)
dets = detector.detect_nv12_readonly(nv12, 640, 640)
print(f"Detections (th=0.01): {len(dets)}")
for d in dets:
    print(f"  {d.class_name.value}: {d.confidence:.3f} @ ({d.bbox.x},{d.bbox.y},{d.bbox.w},{d.bbox.h})")
