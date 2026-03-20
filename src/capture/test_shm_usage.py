#!/usr/bin/env python3
"""
test_shm_usage.py - Verify which SHM segments are actually being read

Monitors /dev/shm/pet_camera_* access patterns to determine if
active_frame SHM is truly unused for frame reads.

Approach:
1. Record write_index of each SharedFrameBuffer SHM
2. Wait and re-check to see if any consumer advanced read position
3. For active_frame: check if anyone reads frame data (vs just detection writes)

Usage:
    uv run src/capture/test_shm_usage.py          # snapshot mode
    uv run src/capture/test_shm_usage.py --watch   # continuous monitoring (10s)

Requires camera daemon to be running.
"""

import mmap
import os
import struct
import sys
import time

# SHM segment info
SHMS = [
    ("/dev/shm/pet_camera_active_frame", "active_frame (NV12 for YOLO?)"),
    ("/dev/shm/pet_camera_stream", "stream (H.264)"),
    ("/dev/shm/pet_camera_mjpeg_frame", "mjpeg_frame (640x480 NV12)"),
]

# Detection and brightness SHMs (small, just check existence)
SMALL_SHMS = [
    "/dev/shm/pet_camera_detections",
    "/dev/shm/pet_camera_brightness",
    "/dev/shm/pet_camera_control",
    "/dev/shm/pet_camera_zc_0",
    "/dev/shm/pet_camera_zc_1",
]

# After C1 padding: write_index is at offset 0 (4 bytes)
WRITE_INDEX_OFFSET = 0


def read_write_index(path):
    """Read the write_index (uint32 at offset 0) from a SharedFrameBuffer SHM."""
    try:
        fd = os.open(path, os.O_RDONLY)
        mm = mmap.mmap(fd, 4, mmap.MAP_SHARED, mmap.PROT_READ)
        mm.seek(WRITE_INDEX_OFFSET)
        write_index = struct.unpack("I", mm.read(4))[0]
        mm.close()
        os.close(fd)
        return write_index
    except Exception as e:
        return f"ERROR: {e}"


def get_file_atime(path):
    """Get last access time of SHM file (shows if anyone is reading it)."""
    try:
        stat = os.stat(path)
        return stat.st_atime, stat.st_mtime, stat.st_size
    except Exception:
        return None, None, None


def check_proc_maps(shm_name):
    """Check which processes have this SHM mapped."""
    short_name = shm_name.replace("/dev/shm/", "")
    pids = []
    for pid_dir in os.listdir("/proc"):
        if not pid_dir.isdigit():
            continue
        try:
            maps_path = f"/proc/{pid_dir}/maps"
            with open(maps_path, "r") as f:
                for line in f:
                    if short_name in line:
                        # Get process name
                        try:
                            with open(f"/proc/{pid_dir}/comm", "r") as cf:
                                comm = cf.read().strip()
                        except Exception:
                            comm = "?"
                        pids.append(f"{pid_dir}({comm})")
                        break
        except (PermissionError, FileNotFoundError):
            continue
    return pids


def snapshot():
    """Take a single snapshot of SHM state."""
    print("=== /dev/shm SHM Usage Analysis ===\n")

    # File sizes
    print("--- File sizes ---")
    total = 0
    for path, label in SHMS:
        if os.path.exists(path):
            size = os.path.getsize(path)
            total += size
            print(f"  {label:40s} {size / 1024 / 1024:6.1f} MB")
        else:
            print(f"  {label:40s} NOT FOUND")

    for path in SMALL_SHMS:
        if os.path.exists(path):
            size = os.path.getsize(path)
            total += size
            name = path.replace("/dev/shm/", "")
            print(f"  {name:40s} {size:6d} B")

    print(f"\n  Total: {total / 1024 / 1024:.1f} MB")

    # Write indices
    print("\n--- Write indices (frame counters) ---")
    for path, label in SHMS:
        idx = read_write_index(path)
        print(f"  {label:40s} write_index = {idx}")

    # Process mappings
    print("\n--- Processes with SHM mapped ---")
    for path, label in SHMS:
        pids = check_proc_maps(path)
        status = ", ".join(pids) if pids else "NONE"
        print(f"  {label:40s} {status}")

    for path in SMALL_SHMS:
        if os.path.exists(path):
            pids = check_proc_maps(path)
            name = path.replace("/dev/shm/", "")
            status = ", ".join(pids) if pids else "NONE"
            print(f"  {name:40s} {status}")


def watch(duration=10):
    """Monitor write_index changes over time to see activity."""
    print(f"=== Monitoring SHM write activity for {duration}s ===\n")

    # Initial snapshot
    initial = {}
    for path, label in SHMS:
        initial[path] = read_write_index(path)
        print(f"  {label:40s} start write_index = {initial[path]}")

    print(f"\n  Waiting {duration} seconds...\n")
    time.sleep(duration)

    # Final snapshot
    print("--- Results ---")
    for path, label in SHMS:
        final = read_write_index(path)
        start = initial[path]
        if isinstance(start, str) or isinstance(final, str):
            print(f"  {label:40s} ERROR reading")
            continue
        delta = final - start
        fps = delta / duration if duration > 0 else 0
        active = "ACTIVE" if delta > 0 else "IDLE (no writes)"
        print(f"  {label:40s} {start} -> {final} (+{delta} frames, ~{fps:.1f} fps) [{active}]")


def main():
    watch_mode = "--watch" in sys.argv
    snapshot()
    print()
    if watch_mode:
        watch(10)
    else:
        watch(5)


if __name__ == "__main__":
    main()
