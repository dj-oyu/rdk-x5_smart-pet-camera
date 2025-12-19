#!/usr/bin/env python3
"""
mock_detector_daemon.py - Dummy detector that writes to real shared memory

This daemon reads frames from camera daemon and writes dummy detection results
to the detection shared memory for testing the monitor overlay.
"""

import sys
import time
import random
import signal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from real_shared_memory import RealSharedMemory

# Detection classes
CLASSES = ["cat", "food_bowl", "water_bowl"]

# Class probabilities (cat is more common)
CLASS_PROBS = {
    "cat": 0.7,
    "food_bowl": 0.15,
    "water_bowl": 0.15,
}


def generate_dummy_detections(frame_width: int, frame_height: int, num_detections: int = None):
    """Generate dummy detection results with random variations"""
    if num_detections is None:
        # Randomly decide number of detections (0-3)
        # 検出なし/1個/2個/3個の確率を調整（より変化が見えるように）
        num_detections = random.choices([0, 1, 2, 3], weights=[0.2, 0.5, 0.2, 0.1])[0]

    detections = []

    for _ in range(num_detections):
        # Choose class based on probability
        class_name = random.choices(list(CLASS_PROBS.keys()),
                                    weights=list(CLASS_PROBS.values()))[0]

        # Generate random bounding box with more variation
        if class_name == "cat":
            # Cat: medium to large size, anywhere
            w = random.randint(60, 250)
            h = random.randint(60, 250)
        elif class_name == "food_bowl":
            # Food bowl: small to medium
            w = random.randint(30, 100)
            h = random.randint(30, 100)
        else:  # water_bowl
            # Water bowl: small to medium
            w = random.randint(30, 100)
            h = random.randint(30, 100)

        # Position varies across the entire frame for visibility
        x = random.randint(0, max(0, frame_width - w))

        if class_name in ["food_bowl", "water_bowl"]:
            # Bowls are usually in bottom 2/3
            y = random.randint(frame_height // 3, max(frame_height // 3, frame_height - h))
        else:
            # Cat can be anywhere
            y = random.randint(0, max(0, frame_height - h))

        # Vary confidence more dramatically
        confidence = random.uniform(0.65, 0.99)

        detections.append({
            "class_name": class_name,
            "confidence": confidence,
            "bbox": {"x": x, "y": y, "w": w, "h": h}
        })

    return detections


def main():
    print("=== Mock Detector Daemon ===")
    print("Reading frames from camera daemon and writing dummy detections")
    print()

    # Open shared memory
    try:
        shm = RealSharedMemory()
        shm.open()
        shm.open_detection_write()
        print("[Info] Connected to shared memory")
    except Exception as e:
        print(f"[Error] Failed to open shared memory: {e}")
        print("[Error] Make sure camera daemon is running")
        return 1

    # Setup signal handler
    running = [True]
    def signal_handler(signum, frame):
        print("\n[Info] Shutting down...")
        running[0] = False

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    last_frame_number = -1
    detection_count = 0

    print("[Info] Starting detection loop (Press Ctrl+C to stop)")
    print()

    try:
        while running[0]:
            # Read latest frame
            frame = shm.get_latest_frame()

            if frame is None:
                time.sleep(0.01)
                continue

            # Skip if same frame
            if frame.frame_number == last_frame_number:
                time.sleep(0.01)
                continue

            last_frame_number = frame.frame_number

            # Generate dummy detections
            detections = generate_dummy_detections(frame.width, frame.height)

            # Write to shared memory (ALWAYS, even if no detections)
            # This ensures the monitor sees the change
            shm.write_detection_result(
                frame_number=frame.frame_number,
                timestamp_sec=frame.timestamp_sec,
                detections=detections
            )
            detection_count += 1

            # Log periodically with detection info
            if detection_count % 10 == 0:
                num_dets = len(detections)
                classes = [d["class_name"] for d in detections]
                print(f"[Info] Frame #{detection_count}: {num_dets} detections {classes if classes else '(none)'}")

            # Simulate detection processing time (10-15 fps)
            # Random delay between 0.067s (15fps) and 0.1s (10fps) for variation
            time.sleep(random.uniform(0.067, 0.1))

    except KeyboardInterrupt:
        print("\n[Info] Interrupted")
    finally:
        shm.close()
        print(f"[Info] Total detections written: {detection_count}")
        print("[Info] Detector daemon stopped")

    return 0


if __name__ == "__main__":
    sys.exit(main())
