#!/usr/bin/env python3
"""
test_integration.py - Integration test for camera daemon and shared memory

This script tests the full pipeline:
1. Camera daemon (C) captures frames via V4L2
2. Frames are written to POSIX shared memory
3. Python reads frames from shared memory
4. Frames are decoded and optionally saved

Usage:
    # Terminal 1: Start camera daemon
    ./build/camera_daemon -d /dev/video0 -w 640 -h 480

    # Terminal 2: Run this test
    python3 src/capture/test_integration.py

    # Or with frame saving
    python3 src/capture/test_integration.py --save-frames --output-dir /tmp/frames
"""

import argparse
import time
from pathlib import Path
import sys

# Add src/capture to path
sys.path.insert(0, str(Path(__file__).parent))

from real_shared_memory import RealSharedMemory


def main():
    parser = argparse.ArgumentParser(
        description="Integration test for camera daemon and shared memory"
    )
    parser.add_argument(
        "--save-frames",
        action="store_true",
        help="Save frames to disk",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="/tmp/frames",
        help="Output directory for saved frames (default: /tmp/frames)",
    )
    parser.add_argument(
        "--max-frames",
        type=int,
        default=0,
        help="Maximum number of frames to capture (0 = unlimited)",
    )
    parser.add_argument(
        "--fps-stats",
        action="store_true",
        help="Display FPS statistics",
    )

    args = parser.parse_args()

    output_path = Path(args.output_dir)

    # Create output directory if saving frames
    if args.save_frames:
        output_path.mkdir(parents=True, exist_ok=True)
        print(f"[Info] Saving frames to: {output_path}")

    # Open shared memory
    shm = RealSharedMemory()

    frame_count = 0
    start_time = time.time()
    last_fps_time = start_time
    last_fps_count = 0

    try:
        shm.open()
        print("[Info] Connected to shared memory")
        print("[Info] Waiting for frames (Ctrl+C to stop)...\n")

        while True:
            # Get latest frame
            frame = shm.get_latest_frame()

            if frame:
                frame_count += 1

                # Display frame info
                print(
                    f"Frame {frame.frame_number:6d}: "
                    f"{frame.width:4d}x{frame.height:4d}, "
                    f"{len(frame.data):7d} bytes, "
                    f"camera_id={frame.camera_id}, "
                    f"format={frame.format}"
                )

                # Save frame if requested
                if args.save_frames:
                    try:
                        if frame.format == 0:  # JPEG
                            filename = output_path / f"frame_{frame.frame_number:06d}.jpg"
                            with open(filename, "wb") as f:
                                f.write(frame.data)
                            print(f"  Saved: {filename}")
                        else:
                            print(f"  Warning: Unsupported format {frame.format}")
                    except Exception as e:
                        print(f"  Error saving frame: {e}")

                # FPS statistics
                if args.fps_stats:
                    current_time = time.time()
                    if current_time - last_fps_time >= 1.0:
                        fps = (frame_count - last_fps_count) / (
                            current_time - last_fps_time
                        )
                        print(f"  FPS: {fps:.2f}")
                        last_fps_time = current_time
                        last_fps_count = frame_count

                # Check max frames
                if args.max_frames > 0 and frame_count >= args.max_frames:
                    print(f"\n[Info] Reached maximum frame count: {args.max_frames}")
                    break

            # Check for detections
            det_result = shm.get_latest_detections()
            if det_result:
                version, detections = det_result
                print(f"\nDetections (v{version}): {len(detections)} objects")
                for det in detections:
                    print(
                        f"  - {det.class_name:12s}: {det.confidence:.2f} "
                        f"at ({det.bbox.x:4d}, {det.bbox.y:4d}) "
                        f"size ({det.bbox.w:4d}, {det.bbox.h:4d})"
                    )
                print()

            # Sleep briefly to avoid busy-waiting
            time.sleep(0.01)

    except FileNotFoundError as e:
        print(f"\n[Error] {e}")
        print(
            "\nMake sure the camera daemon is running:"
            "\n  ./build/camera_daemon -d /dev/video0"
        )
        return 1
    except KeyboardInterrupt:
        print("\n\n[Info] Stopped by user")
    except Exception as e:
        print(f"\n[Error] {e}")
        import traceback

        traceback.print_exc()
        return 1
    finally:
        shm.close()

        # Print summary
        elapsed = time.time() - start_time
        if frame_count > 0:
            avg_fps = frame_count / elapsed
            print(f"\n=== Summary ===")
            print(f"Total frames: {frame_count}")
            print(f"Elapsed time: {elapsed:.2f} seconds")
            print(f"Average FPS: {avg_fps:.2f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
