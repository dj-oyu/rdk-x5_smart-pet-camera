#!/usr/bin/env python3
import sys
from pathlib import Path
sys.path.insert(0, str(Path('src/capture')))

from real_shared_memory import RealSharedMemory

shm = RealSharedMemory()
shm.open()

frame = shm.read_latest_frame()
if frame:
    format_names = {0: "JPEG", 1: "NV12", 2: "RGB", 3: "H.264"}
    print(f"✅ Frame format: {frame.format} ({format_names.get(frame.format, 'Unknown')})")
    print(f"   Frame number: {frame.frame_number}")
    print(f"   Size: {len(frame.data)} bytes")
    print(f"   Resolution: {frame.width}x{frame.height}")
else:
    print("❌ No frame available in shared memory")
