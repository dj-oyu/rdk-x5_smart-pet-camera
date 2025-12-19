#!/usr/bin/env python3
"""
test_daemon_python.py - Test reading frames from camera daemon using Python

This script reads frames from the shared memory created by camera_daemon_drobotics
and verifies that the daemon is working correctly.

Usage:
    python3 test_daemon_python.py [--num-frames N] [--save] [--verbose]

Options:
    --num-frames N  Number of frames to read (default: 100, 0 = infinite)
    --save          Save frames to ./frames_py/ directory
    --verbose       Show detailed frame info
"""

import argparse
import time
import sys
import os
from pathlib import Path

# Add parent directory to path to import real_shared_memory
sys.path.insert(0, str(Path(__file__).parent))

try:
    from real_shared_memory import RealSharedMemory
except ImportError as e:
    print(f"[Error] Failed to import real_shared_memory: {e}")
    print("[Error] Make sure you're in the src/capture directory")
    sys.exit(1)


def save_frame_to_file(frame_data: bytes, frame_number: int, output_dir: Path) -> bool:
    """Save frame to JPEG file"""
    try:
        filename = output_dir / f"frame_{frame_number:06d}.jpg"
        with open(filename, 'wb') as f:
            f.write(frame_data)
        return True
    except Exception as e:
        print(f"[Error] Failed to save frame: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Read frames from camera daemon via shared memory'
    )
    parser.add_argument(
        '--num-frames', '-n',
        type=int,
        default=100,
        help='Number of frames to read (default: 100, 0 = infinite)'
    )
    parser.add_argument(
        '--save', '-s',
        action='store_true',
        help='Save frames to ./frames_py/ directory'
    )
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='Show detailed frame info'
    )
    args = parser.parse_args()

    print("=== Camera Daemon Python Reader Test ===")
    print(f"Settings:")
    print(f"  Frames to read: {'infinite' if args.num_frames == 0 else args.num_frames}")
    print(f"  Save frames: {'yes' if args.save else 'no'}")
    print(f"  Verbose: {'yes' if args.verbose else 'no'}")
    print()

    # Create output directory if saving frames
    output_dir = None
    if args.save:
        output_dir = Path("frames_py")
        output_dir.mkdir(exist_ok=True)
        print(f"[Info] Saving frames to {output_dir}/")

    # Open shared memory
    print("[Info] Opening shared memory...")
    try:
        shm = RealSharedMemory()
        shm.open()
    except Exception as e:
        print(f"[Error] Failed to open shared memory: {e}")
        print("[Error] Make sure camera daemon is running:")
        print("[Error]   cd src/capture")
        print("[Error]   make run-daemon")
        return 1

    print("[Info] Successfully connected to shared memory")

    # Statistics
    frames_read = 0
    frames_saved = 0
    last_frame_number = None
    dropped_frames = 0
    start_time = time.time()

    print("\n[Info] Starting to read frames... (Press Ctrl+C to stop)\n")

    try:
        while args.num_frames == 0 or frames_read < args.num_frames:
            frame = shm.get_latest_frame()

            if frame is None:
                # No frames available yet
                if frames_read == 0 and args.verbose:
                    print("[Info] Waiting for first frame...")
                time.sleep(0.01)  # Sleep 10ms
                continue

            # Check for dropped frames
            if last_frame_number is not None and frame.frame_number > last_frame_number + 1:
                dropped = frame.frame_number - last_frame_number - 1
                dropped_frames += dropped
                if args.verbose:
                    print(f"[Warning] Dropped {dropped} frames "
                          f"(jump from {last_frame_number} to {frame.frame_number})")

            last_frame_number = frame.frame_number
            frames_read += 1

            # Print frame info
            if args.verbose:
                print(f"[Frame {frame.frame_number:06d}] "
                      f"Camera {frame.camera_id}, "
                      f"{frame.width}x{frame.height}, "
                      f"{len(frame.data)} bytes")
            elif frames_read % 30 == 0:
                # Print progress every 30 frames
                elapsed = time.time() - start_time
                fps = frames_read / elapsed if elapsed > 0 else 0
                print(f"[Progress] Read {frames_read} frames "
                      f"({fps:.1f} fps, {dropped_frames} dropped)")

            # Save frame if requested
            if args.save and output_dir:
                if save_frame_to_file(frame.data, frame.frame_number, output_dir):
                    frames_saved += 1
                    if args.verbose:
                        print(f"  -> Saved as {output_dir}/frame_{frame.frame_number:06d}.jpg")

            # Small sleep to avoid busy-waiting
            time.sleep(0.001)  # 1ms

    except KeyboardInterrupt:
        print("\n[Signal] Shutting down...")

    # Calculate statistics
    total_time = time.time() - start_time
    avg_fps = frames_read / total_time if total_time > 0 else 0

    print("\n=== Test Results ===")
    print(f"Total frames read: {frames_read}")
    print(f"Total time: {total_time:.2f} seconds")
    print(f"Average FPS: {avg_fps:.2f}")
    print(f"Dropped frames: {dropped_frames}")
    if args.save:
        print(f"Frames saved: {frames_saved}")

    if last_frame_number is not None:
        frame = shm.get_latest_frame()
        if frame:
            print("\nLast frame info:")
            print(f"  Frame number: {frame.frame_number}")
            print(f"  Camera ID: {frame.camera_id}")
            print(f"  Resolution: {frame.width}x{frame.height}")
            print(f"  Data size: {len(frame.data)} bytes")
            print(f"  Format: {'JPEG' if frame.format == 0 else 'Unknown'}")

    # Cleanup
    shm.close()
    print("\n[Info] Test completed successfully")
    return 0


if __name__ == '__main__':
    sys.exit(main())
