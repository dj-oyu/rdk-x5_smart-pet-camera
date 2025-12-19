#!/usr/bin/env python3
"""Test script to read detection results from shared memory"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src" / "capture"))

from real_shared_memory import RealSharedMemory

def main():
    print("=== Detection Shared Memory Reader ===")
    print()

    try:
        shm = RealSharedMemory()
        shm.open()
        print("[OK] Opened shared memory")
        print()
    except Exception as e:
        print(f"[ERROR] Failed to open shared memory: {e}")
        return 1

    try:
        # Get stats
        stats = shm.get_stats()
        print(f"Stats: {stats}")
        print()

        # Read detection
        detection_result, version = shm.read_detection()
        print(f"Version: {version}")
        print(f"Detection result type: {type(detection_result)}")
        print(f"Detection result: {detection_result}")
        print()

        if detection_result:
            print(f"Frame number: {detection_result.get('frame_number')}")
            print(f"Timestamp: {detection_result.get('timestamp')}")
            print(f"Num detections: {len(detection_result.get('detections', []))}")
            print()

            for i, det in enumerate(detection_result.get('detections', [])):
                print(f"Detection {i+1}:")
                print(f"  Class: {det.get('class_name')}")
                print(f"  Confidence: {det.get('confidence')}")
                print(f"  BBox: {det.get('bbox')}")
        else:
            print("[WARN] No detection result")

    except Exception as e:
        print(f"[ERROR] Failed to read detection: {e}")
        import traceback
        traceback.print_exc()
        return 1
    finally:
        shm.close()

    return 0

if __name__ == "__main__":
    sys.exit(main())
