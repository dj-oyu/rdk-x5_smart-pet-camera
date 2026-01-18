#!/usr/bin/env python3
"""Test real_shared_memory.py read performance"""

import sys
import time
from pathlib import Path

# Add src/capture to sys.path
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "capture"))

from real_shared_memory import RealSharedMemory

def main():
    shm = RealSharedMemory(frame_shm_name="/pet_camera_active_frame")
    shm.open()

    start_time = time.time()
    duration = 5.0
    end_time = start_time + duration

    frames_read = 0
    same_frame_count = 0
    last_frame_number = -1
    frame_numbers = []

    print(f"Reading from /pet_camera_active_frame for {duration} seconds...")
    print(f"Initial write_index: {shm.get_write_index()}")

    while time.time() < end_time:
        frame = shm.get_latest_frame()

        if frame:
            if frame.frame_number != last_frame_number:
                frames_read += 1
                frame_numbers.append(frame.frame_number)
                last_frame_number = frame.frame_number
                if frames_read % 10 == 0:
                    print(f"  Read frame #{frame.frame_number} (total unique: {frames_read})")
            else:
                same_frame_count += 1

        time.sleep(0.001)  # 1ms poll

    final_write_index = shm.get_write_index()
    shm.close()

    elapsed = time.time() - start_time
    fps = frames_read / elapsed if elapsed > 0 else 0

    print(f"\n=== Results ===")
    print(f"Duration: {elapsed:.2f}s")
    print(f"Unique frames read: {frames_read}")
    print(f"Same frame count: {same_frame_count}")
    print(f"FPS: {fps:.2f}")
    print(f"Write index change: {final_write_index - shm.get_write_index()}")
    print(f"Frame numbers: {frame_numbers[:10]}... (first 10)")

    if len(frame_numbers) > 1:
        gaps = [frame_numbers[i] - frame_numbers[i-1] for i in range(1, len(frame_numbers))]
        print(f"Frame gaps (first 10): {gaps[:10]}")
        print(f"Max gap: {max(gaps) if gaps else 0}")

if __name__ == "__main__":
    main()
