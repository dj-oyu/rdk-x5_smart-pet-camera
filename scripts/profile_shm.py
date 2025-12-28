#!/usr/bin/env python3
"""
scripts/profile_shm.py - Shared Memory Profiler Tool

This tool samples shared memory for a specified duration and outputs
statistical health metrics in JSON format.
"""

import argparse
import asyncio
import json
import os
import signal
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional
from urllib.request import urlopen
from urllib.error import URLError

import cv2
import numpy as np

# Add src/capture to sys.path
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "capture"))
try:
    from real_shared_memory import RealSharedMemory, SHM_NAME_ACTIVE_FRAME, SHM_NAME_STREAM
except ImportError:
    print("Error: Could not import RealSharedMemory. Ensure src/capture is in PYTHONPATH.")
    sys.exit(1)

# New shared memory names (Option B design)
SHM_NAME_PROBE_FRAME = "/pet_camera_probe_frame"


def find_switcher_daemon_pid() -> Optional[int]:
    """Find the PID of camera_switcher_daemon using pgrep"""
    try:
        result = subprocess.run(
            ["pgrep", "-f", "camera_switcher_daemon"],
            capture_output=True,
            text=True,
            timeout=2
        )
        if result.returncode == 0 and result.stdout.strip():
            pid = int(result.stdout.strip().split('\n')[0])
            return pid
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError) as e:
        print(f"[Error] Failed to find camera_switcher_daemon PID: {e}", file=sys.stderr)
    return None


def nv12_to_bgr(nv12_data: bytes, width: int, height: int) -> np.ndarray:
    """Convert NV12 format to BGR for OpenCV"""
    y_plane_size = width * height
    uv_plane_size = width * height // 2

    if len(nv12_data) < y_plane_size + uv_plane_size:
        raise ValueError(f"NV12 data size mismatch: expected {y_plane_size + uv_plane_size}, got {len(nv12_data)}")

    nv12 = np.frombuffer(nv12_data[:y_plane_size + uv_plane_size], dtype=np.uint8)
    yuv = nv12.reshape((height * 3 // 2, width))
    bgr = cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR_NV12)

    return bgr


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


async def profile_shm(shm_name: str, duration: float, monitor_url: Optional[str] = None,
                      save_iframes: bool = False, output_dir: Optional[Path] = None,
                      test_switching: bool = False) -> Dict:
    """
    Sample shared memory and calculate metrics. Optionally check monitor URL and save I-frames.
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

    # Camera switching detection
    camera_ids: List[int] = []
    switch_events: List[Dict] = []
    last_camera_id = None

    # I-frame saving
    saved_iframe_count = 0
    if save_iframes and output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
        print(f"Saving I-frames to: {output_dir}", file=sys.stderr)

    if test_switching:
        print(f"[Info] Camera switching test mode enabled", file=sys.stderr)
        print(f"[Info] To trigger switches: adjust lighting (turn lights on/off)", file=sys.stderr)
        print(f"[Info] Expected: Camera 0 (DAY) in bright light, Camera 1 (NIGHT) in darkness", file=sys.stderr)

    # Record initial write_index for accurate FPS calculation
    initial_write_index = shm.get_write_index()

    print(f"Sampling {shm_name} for {duration} seconds...", file=sys.stderr)
    print(f"Initial write_index: {initial_write_index}", file=sys.stderr)

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

            # Camera switching detection
            if test_switching:
                camera_ids.append(frame.camera_id)
                if last_camera_id is not None and frame.camera_id != last_camera_id:
                    # Camera switch detected!
                    # Calculate frame gap (should be 1 for smooth transition)
                    prev_frame_num = frame_numbers[-2] if len(frame_numbers) >= 2 else 0
                    gap = frame.frame_number - prev_frame_num - 1 if prev_frame_num > 0 else 0
                    switch_event = {
                        "time_offset_sec": round(now - start_time, 3),
                        "frame_number": frame.frame_number,
                        "from_camera": last_camera_id,
                        "to_camera": frame.camera_id,
                        "frame_gap": gap
                    }
                    switch_events.append(switch_event)
                    gap_str = f", gap={gap}" if gap > 0 else ""
                    print(f"[Switch] Camera {last_camera_id} → {frame.camera_id} at frame #{frame.frame_number} (t={switch_event['time_offset_sec']}s{gap_str})", file=sys.stderr)
                last_camera_id = frame.camera_id

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

                    # Save I-frame as JPEG if enabled
                    if save_iframes and output_dir:
                        try:
                            bgr = nv12_to_bgr(frame.data, frame.width, frame.height)
                            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
                            filename = f"iframe_{timestamp}_frame{frame.frame_number:06d}.jpg"
                            filepath = output_dir / filename
                            cv2.imwrite(str(filepath), bgr, [cv2.IMWRITE_JPEG_QUALITY, 95])
                            saved_iframe_count += 1
                            print(f"[{saved_iframe_count}] Saved: {filename}", file=sys.stderr)
                        except Exception as e:
                            print(f"[Error] Failed to save frame #{frame.frame_number}: {e}", file=sys.stderr)

                elif frame.format == 2: # RGB
                    rgb_data = np.frombuffer(frame.data, dtype=np.uint8).reshape((frame.height, frame.width, 3))
                    luma = 0.299 * rgb_data[:,:,0] + 0.587 * rgb_data[:,:,1] + 0.114 * rgb_data[:,:,2]
                    luma_samples.append(float(np.mean(luma)))

        await asyncio.sleep(0.005)  # 5ms poll interval

    # Integrity Checks (Before closing)
    write_index = shm.get_write_index()
    write_index_delta = write_index - initial_write_index
    actual_write_fps = write_index_delta / duration if duration > 0 else 0

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

    avg_luma = statistics.mean(luma_samples) if luma_samples else None
    is_black_screen = avg_luma is not None and avg_luma < 10.0 # Threshold for "black"

    # Integrity Checks
    integrity_status = "OK"
    if write_index > 1_000_000_000: # Arbitrary large number check for corruption
        integrity_status = "POSSIBLE_CORRUPTION"

    is_stale = False
    time_since_last_update = None
    if last_frame_obj and frame_timestamps:
        # Check staleness based on last sample time, not frame timestamp
        # (frame timestamp may use CLOCK_MONOTONIC instead of CLOCK_REALTIME)
        time_since_last_update = time.time() - frame_timestamps[-1]
        if time_since_last_update > 5.0:
            is_stale = True
            integrity_status = "STALE_DATA"

    # Status determination (use actual_write_fps for accurate assessment)
    status = "HEALTHY"

    if integrity_status != "OK":
        status = "CRITICAL" if integrity_status == "POSSIBLE_CORRUPTION" else "WARNING"

    # Use actual write FPS for status determination
    if actual_write_fps < 15: # Critical drop
        status = "CRITICAL"
    elif actual_write_fps < 25: # Slight drop
        if status == "HEALTHY": status = "DEGRADED"

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
            "actual_write_fps": round(actual_write_fps, 2),  # FPS based on write_index delta
            "write_index": write_index,
            "write_index_delta": write_index_delta
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

    # Add camera switching info if test mode enabled
    if test_switching:
        if camera_ids:
            camera_0_frames = camera_ids.count(0)
            camera_1_frames = camera_ids.count(1)
            result["camera_switching"] = {
                "enabled": True,
                "switches_detected": len(switch_events),
                "switch_events": switch_events,
                "camera_0_frames": camera_0_frames,
                "camera_1_frames": camera_1_frames,
                "camera_distribution": {
                    "camera_0_percent": round(camera_0_frames / len(camera_ids) * 100, 1) if camera_ids else 0,
                    "camera_1_percent": round(camera_1_frames / len(camera_ids) * 100, 1) if camera_ids else 0
                }
            }
            # Update status if switching is problematic
            if len(switch_events) > 0:
                max_gap = max([e["frame_gap"] for e in switch_events])
                if max_gap > 5:  # More than 5 frames dropped during switch
                    if status == "HEALTHY":
                        status = "WARNING"
                    result["camera_switching"]["max_frame_gap_during_switch"] = max_gap
                    result["status"] = status
                print(f"[Summary] Detected {len(switch_events)} camera switch(es) during {duration}s test", file=sys.stderr)
            else:
                print(f"[Summary] No camera switches detected (staying on camera {camera_ids[0] if camera_ids else 'unknown'})", file=sys.stderr)
        else:
            result["camera_switching"] = {
                "enabled": True,
                "switches_detected": 0,
                "note": "No frames received during test"
            }
    
    if monitor_result:
        result["monitor_check"] = monitor_result
        if not monitor_result.get("available"):
            result["status"] = "PARTIAL_OUTAGE" if result["status"] == "HEALTHY" else result["status"]

    return result


async def profile_with_forced_switching(shm_name: str, phase_duration: float = 5.0) -> Dict:
    """
    Perform automated camera switching test using signals.

    Test flow:
    1. Profile initial state (phase_duration seconds)
    2. Send signal to force switch (SIGUSR1 or SIGUSR2)
    3. Profile switched state (phase_duration seconds)
    4. Send reverse signal to switch back
    5. Profile final state (phase_duration seconds)

    Returns comprehensive results from all phases.
    """
    print("[ForcedSwitchingTest] Starting automated camera switching test", file=sys.stderr)

    # Find camera_switcher_daemon PID
    switcher_pid = find_switcher_daemon_pid()
    if switcher_pid is None:
        return {
            "status": "ERROR",
            "error": "camera_switcher_daemon not found. Is it running?"
        }

    print(f"[ForcedSwitchingTest] Found camera_switcher_daemon PID: {switcher_pid}", file=sys.stderr)

    # Phase 1: Initial state
    print(f"\n[Phase 1] Profiling initial state ({phase_duration}s)...", file=sys.stderr)
    phase1_result = await profile_shm(shm_name, phase_duration, test_switching=True)

    if phase1_result.get("status") == "ERROR":
        return phase1_result

    # Determine current camera from phase 1
    camera_ids_phase1 = phase1_result.get("camera_switching", {}).get("camera_0_frames", 0)
    initial_camera = 0 if camera_ids_phase1 > 0 else 1
    target_camera = 1 - initial_camera  # Switch to the other camera

    print(f"[Phase 1] Initial camera: {initial_camera}, will switch to: {target_camera}", file=sys.stderr)

    # Phase 2: Send signal to force switch
    signal_to_send = signal.SIGUSR2 if target_camera == 1 else signal.SIGUSR1
    signal_name = "SIGUSR2 (→NIGHT)" if target_camera == 1 else "SIGUSR1 (→DAY)"

    print(f"\n[Phase 2] Sending {signal_name} to PID {switcher_pid}...", file=sys.stderr)
    try:
        os.kill(switcher_pid, signal_to_send)
        await asyncio.sleep(1)  # Wait for switch to complete
    except OSError as e:
        return {
            "status": "ERROR",
            "error": f"Failed to send signal to camera_switcher_daemon: {e}"
        }

    print(f"[Phase 2] Profiling switched state ({phase_duration}s)...", file=sys.stderr)
    phase2_result = await profile_shm(shm_name, phase_duration, test_switching=True)

    if phase2_result.get("status") == "ERROR":
        return phase2_result

    # Phase 3: Send reverse signal to switch back
    reverse_signal = signal.SIGUSR1 if target_camera == 1 else signal.SIGUSR2
    reverse_signal_name = "SIGUSR1 (→DAY)" if target_camera == 1 else "SIGUSR2 (→NIGHT)"

    print(f"\n[Phase 3] Sending {reverse_signal_name} to PID {switcher_pid}...", file=sys.stderr)
    try:
        os.kill(switcher_pid, reverse_signal)
        await asyncio.sleep(1)  # Wait for switch to complete
    except OSError as e:
        return {
            "status": "ERROR",
            "error": f"Failed to send reverse signal: {e}"
        }

    print(f"[Phase 3] Profiling reversed state ({phase_duration}s)...", file=sys.stderr)
    phase3_result = await profile_shm(shm_name, phase_duration, test_switching=True)

    if phase3_result.get("status") == "ERROR":
        return phase3_result

    # Analyze results
    print("\n[Analysis] Analyzing switching test results...", file=sys.stderr)

    # Count camera switches in each phase
    switches_phase1 = phase1_result.get("camera_switching", {}).get("switches_detected", 0)
    switches_phase2 = phase2_result.get("camera_switching", {}).get("switches_detected", 0)
    switches_phase3 = phase3_result.get("camera_switching", {}).get("switches_detected", 0)

    # Extract camera distribution
    def get_primary_camera(result):
        cam_switch = result.get("camera_switching", {})
        cam0 = cam_switch.get("camera_0_frames", 0)
        cam1 = cam_switch.get("camera_1_frames", 0)
        return 0 if cam0 > cam1 else 1

    camera_phase1 = get_primary_camera(phase1_result)
    camera_phase2 = get_primary_camera(phase2_result)
    camera_phase3 = get_primary_camera(phase3_result)

    # Determine test success
    switch_successful = (camera_phase2 == target_camera)
    reverse_successful = (camera_phase3 == initial_camera)

    test_status = "PASS" if (switch_successful and reverse_successful) else "FAIL"

    print(f"[Analysis] Camera sequence: {camera_phase1} → {camera_phase2} → {camera_phase3}", file=sys.stderr)
    print(f"[Analysis] Switch successful: {switch_successful}, Reverse successful: {reverse_successful}", file=sys.stderr)
    print(f"[Analysis] Test status: {test_status}", file=sys.stderr)

    # Compile comprehensive result
    return {
        "test_type": "forced_camera_switching",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "switcher_daemon_pid": switcher_pid,
        "phase_duration_sec": phase_duration,
        "test_sequence": {
            "initial_camera": initial_camera,
            "target_camera": target_camera,
            "reverse_camera": initial_camera,
            "signal_sent": signal_name,
            "reverse_signal_sent": reverse_signal_name
        },
        "phases": {
            "phase1_initial": phase1_result,
            "phase2_switched": phase2_result,
            "phase3_reversed": phase3_result
        },
        "analysis": {
            "camera_sequence": [camera_phase1, camera_phase2, camera_phase3],
            "switches_per_phase": [switches_phase1, switches_phase2, switches_phase3],
            "switch_successful": switch_successful,
            "reverse_successful": reverse_successful,
            "test_status": test_status
        },
        "status": test_status
    }


def main():
    parser = argparse.ArgumentParser(
        description="Profile shared memory frames.",
        epilog="""
Shared Memory Design (Option B - Zero-Copy):
  - /pet_camera_active_frame   : Active camera NV12 (30fps, written by active camera daemon)
  - /pet_camera_stream         : Active camera H.264 (30fps, written by active camera daemon)
  - /pet_camera_probe_frame    : Probe NV12 (on-demand, written on SIGRTMIN request)

Camera daemons receive signals from camera_switcher_daemon:
  - SIGUSR1: Activate (start writing to active_frame/stream)
  - SIGUSR2: Deactivate (stop writing)
  - SIGRTMIN: Probe request (write one frame to probe_frame)
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--duration", type=float, default=5.0, help="Sampling duration in seconds")
    parser.add_argument("--shm-name", type=str, default=SHM_NAME_ACTIVE_FRAME,
                        help=f"Shared memory name (default: {SHM_NAME_ACTIVE_FRAME})")
    parser.add_argument("--monitor-url", type=str, help="Optional HTTP URL to check (e.g. http://localhost:8080/api/status)")
    parser.add_argument("--save-iframes", action="store_true", help="Save NV12 I-frames as JPEG images")
    parser.add_argument("--output-dir", type=str, default="recordings",
                        help="Output directory for saved I-frames (default: recordings)")
    parser.add_argument("--test-switching", action="store_true",
                        help="Enable camera switching detection and testing (monitors camera_id changes)")
    parser.add_argument("--force-switch-test", action="store_true",
                        help="Perform automated forced camera switching test using signals (3 phases)")

    args = parser.parse_args()

    # Prepare output directory if saving I-frames
    output_dir = Path(args.output_dir) if args.save_iframes else None

    # Run forced switching test or regular profiling
    if args.force_switch_test:
        # Forced switching test mode (3-phase test)
        result = asyncio.run(profile_with_forced_switching(args.shm_name, args.duration))
    else:
        # Regular profiling mode
        result = asyncio.run(profile_shm(args.shm_name, args.duration, args.monitor_url,
                                         args.save_iframes, output_dir, args.test_switching))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
