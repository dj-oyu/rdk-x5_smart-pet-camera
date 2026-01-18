#!/usr/bin/env python3
"""
src/capture/mock_camera_daemon.py - Mock Camera Daemon writing to Real Shared Memory

This script simulates a camera daemon by writing mock JPEG/NV12 frames 
to POSIX shared memory (/dev/shm/pet_camera_frames).
"""

import argparse
import os
import struct
import time
from ctypes import sizeof

import numpy as np

try:
    from real_shared_memory import (
        CSharedFrameBuffer, 
        CFrame, 
        RING_BUFFER_SIZE, 
        MAX_FRAME_SIZE,
        SHM_NAME_ACTIVE_FRAME
    )
except ImportError:
    # Handle sys.path
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent))
    from real_shared_memory import (
        CSharedFrameBuffer, 
        CFrame, 
        RING_BUFFER_SIZE, 
        MAX_FRAME_SIZE,
        SHM_NAME_ACTIVE_FRAME
    )

import mmap

def main():
    parser = argparse.ArgumentParser(description="Mock Camera Daemon (Real SHM)")
    parser.add_argument("--shm-name", type=str, default=SHM_NAME_ACTIVE_FRAME)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--format", type=int, default=1, help="0=JPEG, 1=NV12, 2=RGB")
    
    args = parser.parse_args()

    shm_path = f"/dev/shm{args.shm_name}"
    
    # Create/Open shared memory
    fd = os.open(shm_path, os.O_CREAT | os.O_RDWR, 0o666)
    os.ftruncate(fd, sizeof(CSharedFrameBuffer))
    
    shm_mmap = mmap.mmap(fd, sizeof(CSharedFrameBuffer), mmap.MAP_SHARED, mmap.PROT_WRITE)
    
    print(f"Mock camera daemon started. Writing to {shm_path}")
    print(f"Settings: {args.width}x{args.height}, {args.fps} FPS, format={args.format}")

    frame_number = 1
    write_index = 0
    
    # Pre-generate a base frame (NV12)
    if args.format == 1:
        # NV12 size: width * height * 1.5
        frame_size = int(args.width * args.height * 1.5)
    elif args.format == 0:
        # Dummy JPEG
        frame_size = 1024
    else:
        frame_size = args.width * args.height * 3

    try:
        while True:
            start_time = time.time()
            
            # Update frame data (slight change to simulate video)
            if args.format == 1:
                # NV12: Create a moving bar
                y_plane = np.zeros((args.height, args.width), dtype=np.uint8)
                bar_pos = (frame_number * 5) % args.width
                y_plane[:, bar_pos:bar_pos+10] = 255
                uv_plane = np.full((args.height // 2, args.width), 128, dtype=np.uint8)
                data = y_plane.tobytes() + uv_plane.tobytes()
            else:
                data = os.urandom(frame_size)
            
            # Create CFrame
            c_frame = CFrame()
            c_frame.frame_number = frame_number
            c_frame.timestamp.tv_sec = int(start_time)
            c_frame.timestamp.tv_nsec = int((start_time - int(start_time)) * 1e9)
            c_frame.camera_id = 0
            c_frame.width = args.width
            c_frame.height = args.height
            c_frame.format = args.format
            c_frame.data_size = len(data)
            
            # Copy data
            import ctypes
            ctypes.memmove(c_frame.data, data, len(data))
            
            # Write frame to ring buffer
            idx = write_index % RING_BUFFER_SIZE
            frame_offset = sizeof(ctypes.c_uint32) * 2 + sizeof(CFrame) * idx
            
            shm_mmap.seek(frame_offset)
            shm_mmap.write(bytes(c_frame))
            
            # Update write_index
            write_index += 1
            shm_mmap.seek(0)
            shm_mmap.write(struct.pack("I", write_index))
            
            frame_number += 1
            
            # Sleep to maintain FPS
            elapsed = time.time() - start_time
            sleep_time = max(0, (1.0 / args.fps) - elapsed)
            time.sleep(sleep_time)

    except KeyboardInterrupt:
        print("\nStopping mock camera daemon...")
    finally:
        shm_mmap.close()
        os.close(fd)

if __name__ == "__main__":
    main()
