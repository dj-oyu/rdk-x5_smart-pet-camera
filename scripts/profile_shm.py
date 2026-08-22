#!/usr/bin/env python3
"""
scripts/profile_shm.py - Shared Memory Profiler Tool

This tool samples shared memory for a specified duration and outputs
statistical health metrics in JSON format.

Zero-copy architecture note (see docs/shared-memory.md,
src/capture/shm_constants.h): /pet_camera_yolo_zc, /pet_camera_mjpeg_zc and
/pet_camera_h265_zc carry only frame *metadata* (frame_number, camera_id,
width/height, timestamps, an hb_mem share_id, and — for the NV12 regions —
an ISP-computed brightness_avg). The actual pixel/bitstream bytes live in a
separate hb_mem VIO buffer pool referenced by that share_id, not in this SHM
segment. Reading them back out requires hb_mem_bindings.import_nv12_graph_buf()
after hb_mem_init(), which shares state with the live yolo_detector_daemon
consumer — this script intentionally does not do that (see --save-iframes
below). This tool therefore reports frame-timing/integrity health plus the
metadata fields the producer already computes, not decoded pixel content.

This script opens all shared memory strictly read-only (O_RDONLY / PROT_READ)
and never creates or writes to any SHM segment — services may be live on the
device while this runs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import mmap
import os
import statistics
import sys
import time
from ctypes import Structure, c_int, c_int32, c_long, c_uint8, c_uint32, c_uint64, sizeof
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional
from urllib.request import urlopen

# Add src/capture and src/common/src to sys.path.
# real_shared_memory imports common.types, so both roots are required —
# same set the detector daemon puts on the path.
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src" / "capture"))
sys.path.insert(0, str(PROJECT_ROOT / "src" / "common" / "src"))
try:
    from real_shared_memory import (
        CTimespec,
        CZeroCopyFrameBuffer,
        SHM_NAME_DETECTIONS,
        SHM_NAME_YOLO_ZC,
        ZeroCopySharedMemory,
    )
except ImportError as exc:
    print(f"Error: Could not import from real_shared_memory: {exc}")
    print("Expected src/capture and src/common/src on sys.path.")
    sys.exit(1)

# ============================================================================
# SHM name / wire-format catalogue
#
# shm_constants.h is the single source of truth for names. real_shared_memory.py
# only exports the names the detector daemon itself consumes (SHM_NAME_YOLO_ZC,
# SHM_NAME_DETECTIONS, the ROI names) — SHM_NAME_MJPEG_ZC and SHM_NAME_H265_ZC
# are mirrored here for the same reason CH265ZeroCopyFrame is (see below).
# Keep these in sync with src/capture/shm_constants.h if it changes.
# ============================================================================
SHM_NAME_MJPEG_ZC = "/pet_camera_mjpeg_zc"
SHM_NAME_H265_ZC = "/pet_camera_h265_zc"

# /pet_camera_yolo_zc and /pet_camera_mjpeg_zc both use the ZeroCopyFrameBuffer
# layout (NV12 metadata + hb_mem share_id). /pet_camera_h265_zc uses a
# different struct (H265ZeroCopyFrame: bitstream metadata, no brightness_avg,
# an extra consumed_sem). See src/capture/shared_memory.h.
_NV12_ZC_SHM_NAMES = {SHM_NAME_YOLO_ZC, SHM_NAME_MJPEG_ZC}
_H265_ZC_SHM_NAMES = {SHM_NAME_H265_ZC}


def classify_shm(shm_name: str) -> str:
    """Return which wire format `shm_name` uses: 'nv12_zc', 'h265_zc',
    'detections', or 'unknown'. Determines which reader class to use.
    """
    if shm_name in _NV12_ZC_SHM_NAMES:
        return "nv12_zc"
    if shm_name in _H265_ZC_SHM_NAMES:
        return "h265_zc"
    if shm_name == SHM_NAME_DETECTIONS:
        return "detections"
    return "unknown"


# ============================================================================
# Read-only NV12 zero-copy reader (/pet_camera_yolo_zc, /pet_camera_mjpeg_zc)
# ============================================================================
class ReadOnlyZeroCopySharedMemory(ZeroCopySharedMemory):
    """Read-only variant of real_shared_memory.ZeroCopySharedMemory.

    The production class opens O_RDWR / PROT_READ|PROT_WRITE (needed by
    consumers that call wait_for_frame(), which touches the semaphore).
    This profiler never calls wait_for_frame() and must never hold a
    writable mapping onto live production SHM, so open() is overridden to
    use O_RDONLY / PROT_READ only. get_frame()/close() are inherited
    unchanged since they only read.
    """

    def open(self) -> bool:
        shm_path = f"/dev/shm{self.shm_name}"
        try:
            self.fd = os.open(shm_path, os.O_RDONLY)
        except FileNotFoundError:
            return False
        except Exception as e:
            print(f"[Error] Failed to open ZeroCopy SHM (read-only) {self.shm_name}: {e}", file=sys.stderr)
            return False

        expected_size = sizeof(CZeroCopyFrameBuffer)
        actual_size = os.fstat(self.fd).st_size
        if actual_size != expected_size:
            print(
                f"[Error] {self.shm_name}: size mismatch (expected {expected_size} bytes "
                f"from CZeroCopyFrameBuffer, got {actual_size}). Struct layout may be out "
                f"of sync with shared_memory.h — refusing to read.",
                file=sys.stderr,
            )
            os.close(self.fd)
            self.fd = None
            return False

        try:
            self.mmap_obj = mmap.mmap(self.fd, expected_size, mmap.MAP_SHARED, mmap.PROT_READ)
            return True
        except Exception as e:
            print(f"[Error] Failed to mmap ZeroCopy SHM (read-only) {self.shm_name}: {e}", file=sys.stderr)
            os.close(self.fd)
            self.fd = None
            return False


# ============================================================================
# Read-only H.265 zero-copy reader (/pet_camera_h265_zc)
#
# H265ZeroCopyFrame/H265ZeroCopyBuffer (src/capture/shared_memory.h) have no
# existing Python binding — real_shared_memory.py only covers the NV12
# ZeroCopyFrameBuffer layout used by the detector. Mirrored here read-only
# since src/ must not be modified for this task. Verified against the live
# device: sizeof(CH265ZeroCopyBuffer) below equals the actual
# /dev/shm/pet_camera_h265_zc file size (160 bytes) at the time of writing.
# Keep in sync with shared_memory.h if that struct changes.
# ============================================================================
HB_MEM_COM_BUF_SIZE = 48  # sizeof(hb_mem_common_buf_t); shared_memory.h


class CH265ZeroCopyFrame(Structure):
    _fields_ = [
        ("frame_number", c_uint64),
        ("timestamp", CTimespec),
        ("camera_id", c_int),
        ("width", c_int),
        ("height", c_int),
        ("data_size", c_uint32),
        ("hb_mem_buf_data", c_uint8 * HB_MEM_COM_BUF_SIZE),
        ("version", c_uint32),
    ]


class CH265ZeroCopyBuffer(Structure):
    _fields_ = [
        ("new_frame_sem", c_uint8 * 32),  # sem_t
        ("consumed_sem", c_uint8 * 32),  # sem_t
        ("frame", CH265ZeroCopyFrame),
    ]


@dataclass
class H265Frame:
    frame_number: int
    timestamp_sec: float
    camera_id: int
    width: int
    height: int
    data_size: int
    version: int


class ReadOnlyH265ZeroCopyReader:
    """Read-only reader for /pet_camera_h265_zc (H265ZeroCopyBuffer layout).

    Opened O_RDONLY / PROT_READ only — never writes, never creates.
    """

    def __init__(self, shm_name: str = SHM_NAME_H265_ZC) -> None:
        self.shm_name = shm_name
        self.fd: Optional[int] = None
        self.mmap_obj: Optional[mmap.mmap] = None

    def open(self) -> bool:
        shm_path = f"/dev/shm{self.shm_name}"
        try:
            self.fd = os.open(shm_path, os.O_RDONLY)
        except FileNotFoundError:
            return False
        except Exception as e:
            print(f"[Error] Failed to open H265 zero-copy SHM {self.shm_name}: {e}", file=sys.stderr)
            return False

        expected_size = sizeof(CH265ZeroCopyBuffer)
        actual_size = os.fstat(self.fd).st_size
        if actual_size != expected_size:
            print(
                f"[Error] {self.shm_name}: size mismatch (expected {expected_size} bytes "
                f"from CH265ZeroCopyBuffer, got {actual_size}). Struct layout may be out "
                f"of sync with shared_memory.h — refusing to read.",
                file=sys.stderr,
            )
            os.close(self.fd)
            self.fd = None
            return False

        try:
            self.mmap_obj = mmap.mmap(self.fd, expected_size, mmap.MAP_SHARED, mmap.PROT_READ)
            return True
        except Exception as e:
            print(f"[Error] Failed to mmap H265 zero-copy SHM {self.shm_name}: {e}", file=sys.stderr)
            os.close(self.fd)
            self.fd = None
            return False

    def close(self) -> None:
        if self.mmap_obj:
            self.mmap_obj.close()
            self.mmap_obj = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def get_frame(self) -> Optional[H265Frame]:
        if not self.mmap_obj:
            return None
        self.mmap_obj.seek(0)
        data = self.mmap_obj.read(sizeof(CH265ZeroCopyBuffer))
        buf = CH265ZeroCopyBuffer.from_buffer_copy(data)
        f = buf.frame
        if f.version == 0:
            return None
        ts = f.timestamp.tv_sec + f.timestamp.tv_nsec / 1e9
        return H265Frame(
            frame_number=f.frame_number,
            timestamp_sec=ts,
            camera_id=f.camera_id,
            width=f.width,
            height=f.height,
            data_size=f.data_size,
            version=f.version,
        )


def _read_version(reader) -> int:
    """Snapshot the producer's write-count (the `version` field, incremented
    on every shm_zerocopy_write()/shm_h265_zc_write() call) without requiring
    a *new* frame to have arrived. get_frame() returns None only when
    version == 0 (never written), so this is a reliable "write index".
    """
    frame = reader.get_frame()
    return frame.version if frame is not None else 0


def _frame_byte_size(frame, kind: str) -> int:
    """Metadata-only byte-size estimate — no pixel/bitstream bytes are read."""
    if kind == "nv12_zc":
        plane_cnt = frame.plane_cnt if frame.plane_cnt > 0 else len(frame.plane_size)
        return sum(frame.plane_size[:plane_cnt])
    if kind == "h265_zc":
        return frame.data_size
    return 0


def _frame_luma(frame, kind: str) -> Optional[float]:
    """avg_luma is sourced from the ISP-computed brightness_avg metadata field
    (NV12 regions only) — no pixel data is decoded. H.265 frames carry no
    brightness metadata.
    """
    if kind == "nv12_zc":
        return float(frame.brightness_avg)
    return None


async def check_http_endpoint(url: str, timeout: float = 2.0) -> Dict:
    """
    Check if an HTTP endpoint is responsive.
    """
    start_time = time.time()
    try:
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
                      test_switching: bool = False) -> Dict:
    """
    Sample shared memory and calculate metrics. Optionally check monitor URL.
    """
    kind = classify_shm(shm_name)
    if kind == "detections":
        return {
            "status": "ERROR",
            "error": (
                f"{shm_name} uses the LatestDetectionResult layout (detection results), "
                "not a frame stream — this tool profiles frame SHM (yolo_zc/mjpeg_zc/h265_zc). "
                "Unsupported by design."
            ),
            "target_shm": shm_name,
        }
    if kind == "unknown":
        return {
            "status": "ERROR",
            "error": (
                f"Unrecognized SHM name {shm_name!r}. Supported: "
                f"{SHM_NAME_YOLO_ZC}, {SHM_NAME_MJPEG_ZC}, {SHM_NAME_H265_ZC}"
            ),
            "target_shm": shm_name,
        }

    reader = ReadOnlyZeroCopySharedMemory(shm_name) if kind == "nv12_zc" else ReadOnlyH265ZeroCopyReader(shm_name)
    if not reader.open():
        return {
            "status": "ERROR",
            "error": f"Failed to open {shm_name} (not found, wrong size, or permission denied)",
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

    resolution = "unknown"
    frame_format = "NV12" if kind == "nv12_zc" else "H.265"

    # Content check: sourced from producer-computed metadata only (no pixel
    # data is available in this SHM — see module docstring).
    luma_samples: List[float] = []

    # Camera switching detection (passive — observes camera_id changes during
    # normal operation; does not depend on any external switch-trigger).
    camera_ids: List[int] = []
    switch_events: List[Dict] = []
    last_camera_id = None

    # Record initial version for accurate FPS calculation
    initial_write_index = _read_version(reader)

    print(f"Sampling {shm_name} for {duration}s...", file=sys.stderr)

    last_frame_obj = None

    while time.time() < end_time:
        frame = reader.get_frame()

        if frame and frame.frame_number != last_frame_number:
            last_frame_obj = frame
            now = time.time()
            frame_timestamps.append(now)
            frame_numbers.append(frame.frame_number)
            frame_sizes.append(_frame_byte_size(frame, kind))
            last_frame_number = frame.frame_number

            if test_switching:
                camera_ids.append(frame.camera_id)
                if last_camera_id is not None and frame.camera_id != last_camera_id:
                    prev_frame_num = frame_numbers[-2] if len(frame_numbers) >= 2 else 0
                    gap = frame.frame_number - prev_frame_num - 1 if prev_frame_num > 0 else 0
                    switch_events.append({
                        "time_offset_sec": round(now - start_time, 3),
                        "frame_number": frame.frame_number,
                        "from_camera": last_camera_id,
                        "to_camera": frame.camera_id,
                        "frame_gap": gap
                    })
                last_camera_id = frame.camera_id

            if resolution == "unknown":
                resolution = f"{frame.width}x{frame.height}"

            luma = _frame_luma(frame, kind)
            if luma is not None:
                luma_samples.append(luma)

        await asyncio.sleep(0.005)  # 5ms poll interval

    # Integrity Checks (Before closing)
    write_index = _read_version(reader)
    write_index_delta = write_index - initial_write_index
    actual_write_fps = write_index_delta / duration if duration > 0 else 0

    reader.close()

    monitor_result = None
    if monitor_task:
        monitor_result = await monitor_task

    if not frame_timestamps:
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

    total_frames = len(frame_timestamps)

    avg_luma = statistics.mean(luma_samples) if luma_samples else None
    is_black_screen = avg_luma is not None and avg_luma < 10.0  # Threshold for "black"

    integrity_status = "OK"
    if write_index > 1_000_000_000:  # Arbitrary large number check for corruption
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

    status = "HEALTHY"

    if integrity_status != "OK":
        status = "CRITICAL" if integrity_status == "POSSIBLE_CORRUPTION" else "WARNING"

    if actual_write_fps < 15:  # Critical drop
        status = "CRITICAL"
    elif actual_write_fps < 25:  # Slight drop
        if status == "HEALTHY":
            status = "DEGRADED"

    if is_black_screen:
        if status == "HEALTHY":
            status = "WARNING"

    if total_frames == 0:
        status = "STALE" if is_stale else "NO_FRAMES"

    result = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "target_shm": shm_name,
        "sampling_duration_sec": duration,
        "stats": {
            "total_frames": total_frames,
            "actual_write_fps": round(actual_write_fps, 2),  # FPS based on version-counter delta
            "write_index": write_index,
            "write_index_delta": write_index_delta
        },
        "content_check": {
            "format": frame_format,
            "resolution": resolution,
            "avg_frame_size_bytes": int(statistics.mean(frame_sizes)) if frame_sizes else 0,
            "avg_luma": round(avg_luma, 2) if avg_luma is not None else "N/A",
            "is_black_screen": is_black_screen,
            # Zero-copy SHM carries no pixel/bitstream bytes (see module
            # docstring) — these two fields document where avg_luma actually
            # came from, since callers may have assumed decoded-pixel luma.
            "pixel_data_available": False,
            "luma_source": (
                "brightness_avg (ISP-computed metadata field, no pixel data read)"
                if kind == "nv12_zc"
                else "unavailable (H.265 bitstream frames carry no brightness metadata)"
            ),
        },
        "integrity": {
            "status": integrity_status,
            "is_stale": is_stale,
            "time_since_last_update_sec": round(time_since_last_update, 2) if time_since_last_update is not None else None
        },
        "status": status
    }

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
            if len(switch_events) > 0:
                max_gap = max(e["frame_gap"] for e in switch_events)
                if max_gap > 5:  # More than 5 frames dropped during switch
                    if status == "HEALTHY":
                        status = "WARNING"
                    result["camera_switching"]["max_frame_gap_during_switch"] = max_gap
                    result["status"] = status
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


def main():
    parser = argparse.ArgumentParser(
        description="Profile shared memory frames (read-only; never writes to or creates SHM).",
        epilog="""
Shared Memory Design (current zero-copy architecture — see shm_constants.h):
  - /pet_camera_h265_zc     : H.265 bitstream zero-copy (encoder -> Go streaming)
  - /pet_camera_yolo_zc     : YOLO input NV12 zero-copy (camera -> Python detector)
  - /pet_camera_mjpeg_zc    : MJPEG NV12 zero-copy (camera -> Go web_monitor)
  - /pet_camera_detections  : Detection results (not a frame stream; unsupported here)

These SHM regions carry frame *metadata* only (frame_number, camera_id,
width/height, timestamps, an hb_mem share_id, and — NV12 regions only — an
ISP-computed brightness_avg). Actual pixel/bitstream bytes live in a separate
hb_mem VIO buffer pool and are not read by this tool.

Day/night camera switching is an internal thread inside camera_daemon_drobotics
(src/capture/camera_daemon_main.c switcher_thread) with no external trigger
API — the standalone camera_switcher_daemon this tool used to signal no
longer exists. --test-switching still works (it passively watches camera_id
change during normal operation); --force-switch-test does not (see --help).
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--duration", type=float, default=5.0, help="Sampling duration in seconds")
    parser.add_argument("--shm-name", type=str, default="/pet_camera_yolo_zc",
                        help="Shared memory name (default: /pet_camera_yolo_zc)")
    parser.add_argument("--monitor-url", type=str, help="Optional HTTP URL to check (e.g. http://localhost:8080/api/status)")
    parser.add_argument("--save-iframes", action="store_true",
                        help="[UNSUPPORTED] Previously decoded NV12 bytes read directly from SHM "
                             "into JPEG files. The zero-copy redesign no longer places pixel data "
                             "in these SHM regions -- only metadata plus an hb_mem share_id is "
                             "exposed. Reading real pixels would require "
                             "hb_mem_bindings.import_nv12_graph_buf() after hb_mem_init(), which "
                             "shares state with the live yolo_detector_daemon consumer; calling "
                             "that from this diagnostic tool was judged unsafe. Passing this flag "
                             "exits with an error instead of silently doing nothing.")
    parser.add_argument("--output-dir", type=str, default="recordings",
                        help="(Unused while --save-iframes is unsupported.)")
    parser.add_argument("--test-switching", action="store_true",
                        help="Passively monitor frame.camera_id changes during normal sampling "
                             "(day/night switches happen automatically based on brightness -- this "
                             "does not force a switch).")
    parser.add_argument("--force-switch-test", action="store_true",
                        help="[UNSUPPORTED] Used to send SIGUSR1/2 to the standalone "
                             "camera_switcher_daemon to force a day/night switch. That daemon no "
                             "longer exists -- switching is now an internal thread inside "
                             "camera_daemon_drobotics (src/capture/camera_daemon_main.c "
                             "switcher_thread) with no external trigger API. This cannot be "
                             "reimplemented without changing src/capture, which is out of scope "
                             "for this script. Passing this flag exits with an error.")

    args = parser.parse_args()

    if args.force_switch_test:
        print(
            "[Error] --force-switch-test is unsupported in the current architecture: "
            "camera_switcher_daemon no longer exists (day/night switching was integrated "
            "into camera_daemon_drobotics's switcher_thread, see "
            "src/capture/camera_daemon_main.c). There is no external API (signal, socket, "
            "etc.) to force a switch from outside that daemon anymore. Use "
            "--test-switching during normal operation to passively observe naturally "
            "occurring day/night switches instead.",
            file=sys.stderr,
        )
        print(json.dumps({
            "status": "UNSUPPORTED",
            "error": "force-switch-test: camera_switcher_daemon no longer exists; "
                     "no external switch-trigger API in current architecture",
        }, indent=2))
        sys.exit(1)

    if args.save_iframes:
        print(
            "[Error] --save-iframes is unsupported in the current architecture: zero-copy "
            "SHM regions no longer carry pixel data (only an hb_mem share_id + metadata). "
            "Extracting real frames would require "
            "hb_mem_bindings.import_nv12_graph_buf() + hb_mem_init(), which shares state "
            "with the live yolo_detector_daemon consumer and was judged unsafe to call from "
            "this read-only diagnostic tool.",
            file=sys.stderr,
        )
        print(json.dumps({
            "status": "UNSUPPORTED",
            "error": "save-iframes: pixel data not available in zero-copy SHM without "
                     "hb_mem import (unsafe for this tool)",
        }, indent=2))
        sys.exit(1)

    result = asyncio.run(profile_shm(args.shm_name, args.duration, args.monitor_url, args.test_switching))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
