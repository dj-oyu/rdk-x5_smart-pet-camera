#!/usr/bin/env python3
"""
scripts/profile_shm.py - Shared Memory Profiler Tool

This tool samples shared memory for a specified duration and outputs
statistical health metrics in JSON format.
"""

import argparse
import asyncio
import json
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional
from urllib.request import urlopen
from urllib.error import URLError

import numpy as np

# Add src/capture to sys.path
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "capture"))
try:
    from real_shared_memory import RealSharedMemory, SHM_NAME_ACTIVE_FRAME, SHM_NAME_STREAM
except ImportError:
    print("Error: Could not import RealSharedMemory. Ensure src/capture is in PYTHONPATH.")
    sys.exit(1)


async def check_http_endpoint(url: str, timeout: float = 2.0) -> Dict:
    """
    Check if an HTTP endpoint is responsive.
    """
    start_time = time.time()
    try:
        # Use run_in_executor for blocking I/O
        loop = asyncio.get_running_loop()
        status_code = await loop.run_in_executor(
            None, 
            lambda: urlopen(url, timeout=timeout).getcode()
        )
        latency_ms = (time.time() - start_time) * 1000
        return {
            "url": url,
            "available": True,
            "status_code": status_code,
            "latency_ms": round(latency_ms, 2)
        }
    except Exception as e:
        return {
            "url": url,
            "available": False,
            "error": str(e)
        }


async def profile_shm(shm_name: str, duration: float, monitor_url: Optional[str] = None) -> Dict:
    """
    Sample shared memory and calculate metrics. Optionally check monitor URL.
    """
    shm = RealSharedMemory(frame_shm_name=shm_name)
    try:
        shm.open()
    except Exception as e:
        return {
            "status": "ERROR",
            "error": str(e),
            "target_shm": shm_name
        }

    # Start monitor check task if URL provided
    monitor_task = None
    if monitor_url:
        monitor_task = asyncio.create_task(check_http_endpoint(monitor_url))

    start_time = time.time()
    end_time = start_time + duration
    
    frame_timestamps: List[float] = []
    frame_numbers: List[int] = []
    frame_sizes: List[int] = []
    last_frame_number = -1
    
    # Metadata from first valid frame
    resolution = "unknown"
    frame_format = "unknown"
    
    # Content check samples
    luma_samples: List[float] = []
    
    print(f"Sampling {shm_name} for {duration} seconds...", file=sys.stderr)

    last_frame_obj = None

    while time.time() < end_time:
        frame = shm.get_latest_frame()
        
        if frame and frame.frame_number != last_frame_number:
            last_frame_obj = frame # Keep for integrity check
            now = time.time()
            frame_timestamps.append(now)
            frame_numbers.append(frame.frame_number)
            frame_sizes.append(len(frame.data))
            last_frame_number = frame.frame_number
            
            # Record metadata
            if resolution == "unknown":
                resolution = f"{frame.width}x{frame.height}"
                format_map = {0: "JPEG", 1: "NV12", 2: "RGB", 3: "H.264"}
                frame_format = format_map.get(frame.format, f"unknown({frame.format})")
            
            # Simple content check for NV12/RGB/JPEG
            if frame.format in (0, 1, 2) and len(frame.data) > 0:
                if frame.format == 1: # NV12: Y-plane is the first width*height bytes
                    y_plane = np.frombuffer(frame.data[:frame.width * frame.height], dtype=np.uint8)
                    luma_samples.append(float(np.mean(y_plane)))
                elif frame.format == 2: # RGB
                    rgb_data = np.frombuffer(frame.data, dtype=np.uint8).reshape((frame.height, frame.width, 3))
                    luma = 0.299 * rgb_data[:,:,0] + 0.587 * rgb_data[:,:,1] + 0.114 * rgb_data[:,:,2]
                    luma_samples.append(float(np.mean(luma)))

        await asyncio.sleep(0.005)  # 5ms poll interval

    # Integrity Checks (Before closing)
    write_index = shm.get_write_index()
    shm.close()

    # Get monitor result if available
    monitor_result = None
    if monitor_task:
        monitor_result = await monitor_task

    if not frame_timestamps:
        # Check if we at least opened it and saw a write_index
        is_stale = False
        if write_index > 0:
             # Even if no NEW frames, check if existing data is stale
             # (This part is tricky without a frame object, but we can assume NO_DATA if no frames arrived)
             pass

        return {
            "status": "NO_DATA",
            "target_shm": shm_name,
            "sampling_duration_sec": duration,
            "monitor_check": monitor_result,
            "integrity": {
                "write_index": write_index,
                "status": "OK" if write_index > 0 else "EMPTY"
            },
            "error": "No frames received during sampling period."
        }

    # Calculate statistics
    total_frames = len(frame_timestamps)
    actual_duration = frame_timestamps[-1] - frame_timestamps[0]
    fps = total_frames / actual_duration if actual_duration > 0 else 0
    
    intervals = [frame_timestamps[i] - frame_timestamps[i-1] for i in range(1, len(frame_timestamps))]
    interval_avg_ms = statistics.mean(intervals) * 1000 if intervals else 0
    interval_std_dev_ms = statistics.stdev(intervals) * 1000 if len(intervals) > 1 else 0
    
    # Estimate dropped frames by looking at frame number gaps
    gaps = [frame_numbers[i] - frame_numbers[i-1] - 1 for i in range(1, len(frame_numbers))]
    dropped_frames_estimated = sum(gaps)
    
    avg_luma = statistics.mean(luma_samples) if luma_samples else None
    is_black_screen = avg_luma is not None and avg_luma < 10.0 # Threshold for "black"

    # Integrity Checks
    integrity_status = "OK"
    if write_index > 1_000_000_000: # Arbitrary large number check for corruption
        integrity_status = "POSSIBLE_CORRUPTION"
    
    is_stale = False
    time_since_last_update = None
    if last_frame_obj:
        time_since_last_update = time.time() - last_frame_obj.timestamp_sec
        if time_since_last_update > 5.0:
            is_stale = True
            integrity_status = "STALE_DATA"

    # Status determination
    status = "HEALTHY"
    
    if integrity_status != "OK":
        status = "CRITICAL" if integrity_status == "POSSIBLE_CORRUPTION" else "WARNING"
    
    if fps < 15: # Critical drop
        status = "CRITICAL"
    elif fps < 25: # Slight drop
        if status == "HEALTHY": status = "DEGRADED"
        
    if dropped_frames_estimated > total_frames * 0.2:
        if status == "HEALTHY": status = "DEGRADED"

    if interval_std_dev_ms > 15.0: # High jitter (>15ms)
        if status == "HEALTHY": status = "UNSTABLE"
        
    if is_black_screen:
        # If it's healthy otherwise, call it WARNING
        if status == "HEALTHY":
            status = "WARNING"
            
    if total_frames == 0:
         if is_stale:
             status = "STALE"
         else:
             status = "NO_FRAMES"

    result = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "target_shm": shm_name,
        "sampling_duration_sec": duration,
        "stats": {
            "total_frames": total_frames,
            "fps": round(fps, 2),
            "frame_interval_avg_ms": round(interval_avg_ms, 2),
            "frame_interval_std_dev_ms": round(interval_std_dev_ms, 2),
            "dropped_frames_estimated": dropped_frames_estimated,
            "write_index": write_index
        },
        "content_check": {
            "format": frame_format,
            "resolution": resolution,
            "avg_frame_size_bytes": int(statistics.mean(frame_sizes)) if frame_sizes else 0,
            "avg_luma": round(avg_luma, 2) if avg_luma is not None else "N/A",
            "is_black_screen": is_black_screen
        },
        "integrity": {
            "status": integrity_status,
            "is_stale": is_stale,
            "time_since_last_update_sec": round(time_since_last_update, 2) if time_since_last_update is not None else None
        },
        "status": status
    }
    
    if monitor_result:
        result["monitor_check"] = monitor_result
        if not monitor_result.get("available"):
            result["status"] = "PARTIAL_OUTAGE" if result["status"] == "HEALTHY" else result["status"]

    return result


def main():
    parser = argparse.ArgumentParser(description="Profile shared memory frames.")
    parser.add_argument("--duration", type=float, default=5.0, help="Sampling duration in seconds")
    parser.add_argument("--shm-name", type=str, default=SHM_NAME_ACTIVE_FRAME, 
                        help=f"Shared memory name (default: {SHM_NAME_ACTIVE_FRAME})")
    parser.add_argument("--monitor-url", type=str, help="Optional HTTP URL to check (e.g. http://localhost:8080/api/status)")
    
    args = parser.parse_args()

    # Use a faster polling loop if needed, but for now 5ms is fine for most cases
    result = asyncio.run(profile_shm(args.shm_name, args.duration, args.monitor_url))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
