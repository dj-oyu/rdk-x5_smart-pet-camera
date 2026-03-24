#!/usr/bin/env python3
"""Watch detection SHM for motion entries (day camera motion detection verification)."""
import mmap
import os
import sys
import time
from ctypes import Structure, c_uint8, c_float, c_int, c_uint32, c_uint64, c_double, sizeof

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent / "src" / "capture"))

MAX_DETECTIONS = 10

class CBoundingBox(Structure):
    _fields_ = [("x", c_int), ("y", c_int), ("w", c_int), ("h", c_int)]

class CDetection(Structure):
    _fields_ = [("class_name", c_uint8 * 32), ("confidence", c_float), ("bbox", CBoundingBox)]

class CLatestDetectionResult(Structure):
    _fields_ = [
        ("frame_number", c_uint64), ("timestamp", c_double),
        ("num_detections", c_int), ("detections", CDetection * MAX_DETECTIONS),
        ("version", c_uint32), ("detection_update_sem", c_uint8 * 32),
    ]

SHM_PATH = "/dev/shm/pet_camera_detections"
last_version = -1

fd = os.open(SHM_PATH, os.O_RDONLY)
mm = mmap.mmap(fd, sizeof(CLatestDetectionResult), mmap.MAP_SHARED, mmap.PROT_READ)

print("Watching /pet_camera_detections for motion entries... (Ctrl+C to stop)")
try:
    while True:
        mm.seek(0)
        det = CLatestDetectionResult.from_buffer_copy(mm.read(sizeof(CLatestDetectionResult)))
        if det.version != last_version:
            last_version = det.version
            classes = []
            for i in range(det.num_detections):
                d = det.detections[i]
                name = bytes(d.class_name).split(b"\0")[0].decode()
                bb = d.bbox
                classes.append(f"{name}({bb.x},{bb.y},{bb.w},{bb.h} c={d.confidence:.2f})")
            has_motion = any("motion" in c for c in classes)
            if has_motion:
                print(f"\033[33m[motion]\033[0m v={det.version} frame={det.frame_number} {' | '.join(classes)}")
            elif classes:
                print(f"  v={det.version} frame={det.frame_number} {' | '.join(classes)}")
        time.sleep(0.1)
except KeyboardInterrupt:
    print("\nDone")
finally:
    mm.close()
    os.close(fd)
