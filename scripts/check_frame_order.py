#!/usr/bin/env python3
"""Check H.264 frame ordering from shared memory."""

import time
import mmap
import struct
from pathlib import Path

SHM_PATH = "/dev/shm/pet_camera_stream"
RING_BUFFER_SIZE = 30
FRAME_SIZE = 1920 * 1080 * 3 // 2
MAX_FRAME_SIZE = FRAME_SIZE

# SharedFrameBuffer layout
# uint32_t write_index (4 bytes)
# uint32_t frame_interval_ms (4 bytes)
# sem_t new_frame_sem (32 bytes)
# Frame frames[30]

# Frame struct layout
# uint64_t frame_number (8 bytes)
# struct timespec timestamp (16 bytes)
# int camera_id (4 bytes)
# int width (4 bytes)
# int height (4 bytes)
# int format (4 bytes)
# size_t data_size (8 bytes)
# uint8_t data[MAX_FRAME_SIZE]

HEADER_SIZE = 4 + 4 + 32  # write_index + frame_interval_ms + semaphore
FRAME_STRUCT_SIZE = 8 + 16 + 4 + 4 + 4 + 4 + 8 + MAX_FRAME_SIZE


def read_frame_number(shm_data, frame_idx):
    """Read frame_number from specific ring buffer index."""
    offset = HEADER_SIZE + frame_idx * FRAME_STRUCT_SIZE
    frame_number = struct.unpack_from('Q', shm_data, offset)[0]
    return frame_number


def main():
    shm_path = Path(SHM_PATH)
    if not shm_path.exists():
        print(f"Shared memory not found: {SHM_PATH}")
        return

    with open(shm_path, 'rb') as f:
        shm_data = mmap.mmap(f.fileno(), 0, prot=mmap.PROT_READ)

        print("Monitoring frame order for 10 seconds...")
        print("frame_number changes:")

        last_write_index = None
        frame_numbers = []

        start_time = time.time()
        while time.time() - start_time < 10:
            # Read write_index
            write_index = struct.unpack_from('I', shm_data, 0)[0]

            if last_write_index != write_index:
                # New frame available
                ring_idx = (write_index - 1) % RING_BUFFER_SIZE
                frame_num = read_frame_number(shm_data, ring_idx)

                frame_numbers.append(frame_num)

                # Check for ordering issues
                if len(frame_numbers) >= 2:
                    prev = frame_numbers[-2]
                    curr = frame_numbers[-1]
                    diff = int(curr) - int(prev)

                    if diff < 0:
                        print(f"⚠️  BACKWARD: {prev} → {curr} (diff={diff})")
                    elif diff > 1:
                        print(f"⚠️  JUMP: {prev} → {curr} (diff={diff})")
                    elif diff == 1:
                        # Normal increment, only print every 30 frames
                        if len(frame_numbers) % 30 == 0:
                            print(f"✓ {curr} (OK)")
                    else:
                        print(f"⚠️  DUPLICATE: {prev} → {curr}")

                last_write_index = write_index

            time.sleep(0.01)  # 10ms polling

        shm_data.close()

        print(f"\n=== Summary ===")
        print(f"Total frames captured: {len(frame_numbers)}")
        if len(frame_numbers) >= 2:
            print(f"First frame_number: {frame_numbers[0]}")
            print(f"Last frame_number: {frame_numbers[-1]}")
            print(f"Expected count: {frame_numbers[-1] - frame_numbers[0] + 1}")

            # Check for issues
            issues = 0
            for i in range(1, len(frame_numbers)):
                diff = int(frame_numbers[i]) - int(frame_numbers[i-1])
                if diff != 1:
                    issues += 1

            print(f"Ordering issues: {issues}")


if __name__ == "__main__":
    main()
