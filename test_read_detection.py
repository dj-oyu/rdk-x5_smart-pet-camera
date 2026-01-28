#!/usr/bin/env python3
"""Test script to read detection results from shared memory.

Modes:
  (default)  One-shot: read and print current detection state
  --poll     Continuous: poll every 100ms, report version changes for 10s
"""

import sys
import time
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src" / "capture"))

from real_shared_memory import RealSharedMemory


def print_detection(detection_result: dict | None, version: int) -> None:
    """Print a single detection snapshot."""
    print(f"  version={version}", end="")
    if detection_result is None:
        print("  (no data)")
        return
    n = len(detection_result.get("detections", []))
    print(
        f"  frame={detection_result.get('frame_number')}"
        f"  num_detections={n}"
    )
    for i, det in enumerate(detection_result.get("detections", [])):
        print(
            f"    [{i}] {det.get('class_name')}"
            f"  conf={det.get('confidence'):.3f}"
            f"  bbox={det.get('bbox')}"
        )


def one_shot(shm: RealSharedMemory) -> int:
    """Read and display current state once."""
    stats = shm.get_stats()
    print(f"Stats: {stats}")
    print()

    detection_result, version = shm.read_detection()
    print("Latest detection:")
    print_detection(detection_result, version)
    return 0


def poll(shm: RealSharedMemory, duration: float) -> int:
    """Poll detection SHM and report changes."""
    print(f"Polling detection SHM for {duration:.0f}s (100ms interval)...")
    print()

    prev_version = -1
    updates = 0
    non_empty = 0
    start = time.monotonic()

    while time.monotonic() - start < duration:
        detection_result, version = shm.read_detection()

        if version != prev_version:
            elapsed = time.monotonic() - start
            n = 0
            if detection_result:
                n = len(detection_result.get("detections", []))
            tag = f"[+{elapsed:5.1f}s]"

            if n > 0:
                non_empty += 1
                print(f"{tag} version={version}  frame={detection_result.get('frame_number')}"
                      f"  detections={n}")
                for i, det in enumerate(detection_result.get("detections", [])):
                    print(f"         [{i}] {det.get('class_name')}"
                          f"  conf={det.get('confidence'):.3f}"
                          f"  bbox={det.get('bbox')}")
            else:
                frame = detection_result.get("frame_number") if detection_result else "?"
                print(f"{tag} version={version}  frame={frame}  detections=0")

            prev_version = version
            updates += 1

        time.sleep(0.1)

    elapsed = time.monotonic() - start
    print()
    print(f"--- Summary ({elapsed:.1f}s) ---")
    print(f"  Version updates: {updates}")
    print(f"  Non-empty detections: {non_empty}")
    if updates > 0:
        rate = updates / elapsed
        print(f"  Update rate: {rate:.1f}/s")
    else:
        print("  [WARN] No version changes detected - detector may not be writing to SHM")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Detection SHM observer")
    parser.add_argument("--poll", action="store_true", help="Continuous polling mode")
    parser.add_argument("--duration", type=float, default=10.0, help="Poll duration in seconds (default: 10)")
    args = parser.parse_args()

    print("=== Detection Shared Memory Observer ===")
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
        if args.poll:
            return poll(shm, args.duration)
        else:
            return one_shot(shm)
    except KeyboardInterrupt:
        print("\nInterrupted")
        return 0
    except Exception as e:
        print(f"[ERROR] {e}")
        import traceback
        traceback.print_exc()
        return 1
    finally:
        shm.close()


if __name__ == "__main__":
    sys.exit(main())
