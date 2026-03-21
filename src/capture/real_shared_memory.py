"""
real_shared_memory.py - Python wrapper for C POSIX shared memory

Provides zero-copy frame access via hb_mem share_id.
Matches shared_memory.h structure layout.
"""

import mmap
import os
import time
from ctypes import (
    Structure,
    c_uint8,
    c_uint32,
    c_uint64,
    c_int,
    c_int32,
    c_double,
    c_float,
    c_long,
    sizeof,
    CDLL,
    c_void_p,
    addressof,
)
from dataclasses import dataclass
from typing import Optional

# Load librt for semaphore operations
librt = None
try:
    librt = CDLL("librt.so.1")
    librt.sem_post.argtypes = [c_void_p]
    librt.sem_post.restype = c_int
    librt.sem_trywait.argtypes = [c_void_p]
    librt.sem_trywait.restype = c_int
    librt.sem_timedwait.argtypes = [c_void_p, c_void_p]
    librt.sem_timedwait.restype = c_int
except OSError:
    try:
        librt = CDLL("libpthread.so.0")
        librt.sem_post.argtypes = [c_void_p]
        librt.sem_post.restype = c_int
        librt.sem_trywait.argtypes = [c_void_p]
        librt.sem_trywait.restype = c_int
        librt.sem_timedwait.argtypes = [c_void_p, c_void_p]
        librt.sem_timedwait.restype = c_int
    except OSError:
        import logging
        logging.warning("Failed to load librt/libpthread for semaphore support")

# Constants (must match shm_constants.h)
ZEROCOPY_MAX_PLANES = 2
HB_MEM_GRAPHIC_BUF_SIZE = 160
SHM_NAME_YOLO_ZC = "/pet_camera_yolo_zc"
SHM_NAME_DETECTIONS = os.getenv("SHM_NAME_DETECTIONS", "/pet_camera_detections")
MAX_DETECTIONS = 10


# ============================================================================
# C structure definitions (must match shared_memory.h exactly)
# ============================================================================

class CTimespec(Structure):
    _fields_ = [
        ("tv_sec", c_long),
        ("tv_nsec", c_long),
    ]


class CZeroCopyFrame(Structure):
    _fields_ = [
        ("frame_number", c_uint64),
        ("timestamp", CTimespec),
        ("camera_id", c_int),
        ("width", c_int),
        ("height", c_int),
        ("brightness_avg", c_float),
        ("share_id", c_int32 * ZEROCOPY_MAX_PLANES),
        ("plane_size", c_uint64 * ZEROCOPY_MAX_PLANES),
        ("plane_cnt", c_int32),
        ("hb_mem_buf_data", c_uint8 * HB_MEM_GRAPHIC_BUF_SIZE),
        ("version", c_uint32),
        ("consumed", c_uint8),
        ("_pad", c_uint8 * 3),
    ]


class CZeroCopyFrameBuffer(Structure):
    _fields_ = [
        ("new_frame_sem", c_uint8 * 32),  # sem_t
        ("consumed_sem", c_uint8 * 32),   # sem_t
        ("frame", CZeroCopyFrame),
    ]


# ============================================================================
# Detection structures (matching shared_memory.h)
# ============================================================================

class CBoundingBox(Structure):
    _fields_ = [("x", c_int), ("y", c_int), ("w", c_int), ("h", c_int)]

class CDetection(Structure):
    _fields_ = [
        ("class_name", c_uint8 * 32),  # char[32] as bytes
        ("confidence", c_float),
        ("bbox", CBoundingBox),
    ]

class CLatestDetectionResult(Structure):
    _fields_ = [
        ("frame_number", c_uint64),
        ("timestamp", c_double),
        ("num_detections", c_int),
        ("detections", CDetection * MAX_DETECTIONS),
        ("version", c_uint32),
        ("detection_update_sem", c_uint8 * 32),
    ]


# ============================================================================
# Python dataclass for frame metadata
# ============================================================================

@dataclass
class ZeroCopyFrame:
    frame_number: int
    timestamp_sec: float
    camera_id: int
    width: int
    height: int
    brightness_avg: float
    share_id: list[int]
    plane_size: list[int]
    plane_cnt: int
    hb_mem_buf_data: bytes
    version: int


# ============================================================================
# ZeroCopySharedMemory — main interface for detector
# ============================================================================

class ZeroCopySharedMemory:
    """Zero-copy shared memory interface for VIO buffer sharing via share_id."""

    def __init__(self, shm_name: str = SHM_NAME_YOLO_ZC):
        self.shm_name = shm_name
        self.fd: Optional[int] = None
        self.mmap_obj: Optional[mmap.mmap] = None

    def open(self) -> bool:
        shm_path = f"/dev/shm{self.shm_name}"
        try:
            self.fd = os.open(shm_path, os.O_RDWR)
            expected_size = sizeof(CZeroCopyFrameBuffer)
            self.mmap_obj = mmap.mmap(
                self.fd, expected_size, mmap.MAP_SHARED,
                mmap.PROT_READ | mmap.PROT_WRITE,
            )
            return True
        except FileNotFoundError:
            return False
        except Exception as e:
            print(f"[Error] Failed to open ZeroCopy SHM {self.shm_name}: {e}")
            return False

    def close(self) -> None:
        if self.mmap_obj:
            self.mmap_obj.close()
            self.mmap_obj = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def get_frame(self) -> Optional[ZeroCopyFrame]:
        if not self.mmap_obj:
            return None
        self.mmap_obj.seek(0)
        data = self.mmap_obj.read(sizeof(CZeroCopyFrameBuffer))
        buf = CZeroCopyFrameBuffer.from_buffer_copy(data)
        f = buf.frame

        if f.version == 0 or f.consumed == 1:
            return None

        ts = f.timestamp.tv_sec + f.timestamp.tv_nsec / 1e9

        return ZeroCopyFrame(
            frame_number=f.frame_number,
            timestamp_sec=ts,
            camera_id=f.camera_id,
            width=f.width,
            height=f.height,
            brightness_avg=f.brightness_avg,
            share_id=list(f.share_id),
            plane_size=list(f.plane_size),
            plane_cnt=f.plane_cnt,
            hb_mem_buf_data=bytes(f.hb_mem_buf_data),
            version=f.version,
        )

    def mark_consumed(self) -> None:
        if not self.mmap_obj or librt is None:
            return
        # Set consumed=1 in frame
        frame_offset = CZeroCopyFrameBuffer.frame.offset
        consumed_offset = frame_offset + CZeroCopyFrame.consumed.offset
        self.mmap_obj[consumed_offset] = 1
        # Post consumed_sem
        sem_offset = CZeroCopyFrameBuffer.consumed_sem.offset
        sem_buf = (c_uint8 * 32).from_buffer(self.mmap_obj, sem_offset)
        librt.sem_post(addressof(sem_buf))

    def wait_for_frame(self, timeout_sec: float = 0.1) -> bool:
        if not self.mmap_obj or librt is None:
            return False
        sem_offset = CZeroCopyFrameBuffer.new_frame_sem.offset
        sem_buf = (c_uint8 * 32).from_buffer(self.mmap_obj, sem_offset)

        deadline = time.time() + timeout_sec
        ts_sec = int(deadline)
        ts_nsec = int((deadline - ts_sec) * 1e9)
        timespec_buf = CTimespec(tv_sec=ts_sec, tv_nsec=ts_nsec)

        ret = librt.sem_timedwait(addressof(sem_buf), addressof(timespec_buf))
        return ret == 0


# ============================================================================
# DetectionWriter — writes YOLO results to detection SHM
# ============================================================================

class DetectionWriter:
    def __init__(self, detection_shm_name: str = SHM_NAME_DETECTIONS):
        self.detection_shm_name = detection_shm_name
        self.detection_fd: Optional[int] = None
        self.detection_mmap: Optional[mmap.mmap] = None
        self.last_detection_version = 0

    def open(self) -> None:
        shm_path = f"/dev/shm{self.detection_shm_name}"
        try:
            self.detection_fd = os.open(shm_path, os.O_RDWR)
        except FileNotFoundError:
            self.detection_fd = os.open(shm_path, os.O_CREAT | os.O_RDWR, 0o666)
            os.ftruncate(self.detection_fd, sizeof(CLatestDetectionResult))
        self.detection_mmap = mmap.mmap(
            self.detection_fd, sizeof(CLatestDetectionResult),
            mmap.MAP_SHARED, mmap.PROT_WRITE | mmap.PROT_READ,
        )

    def close(self) -> None:
        if self.detection_mmap:
            self.detection_mmap.close()
            self.detection_mmap = None
        if self.detection_fd is not None:
            os.close(self.detection_fd)
            self.detection_fd = None

    def write_detection_result(
        self, frame_number: int, timestamp_sec: float, detections: list[dict],
    ) -> None:
        if not self.detection_mmap:
            return
        c_det = CLatestDetectionResult()
        c_det.frame_number = frame_number
        c_det.timestamp = timestamp_sec
        c_det.num_detections = min(len(detections), MAX_DETECTIONS)
        for i, det in enumerate(detections[:MAX_DETECTIONS]):
            c_detection = c_det.detections[i]
            name_bytes = det["class_name"].encode("utf-8")[:31]
            for j, b in enumerate(name_bytes):
                c_detection.class_name[j] = b
            c_detection.confidence = det["confidence"]
            c_detection.bbox.x = det["bbox"]["x"]
            c_detection.bbox.y = det["bbox"]["y"]
            c_detection.bbox.w = det["bbox"]["w"]
            c_detection.bbox.h = det["bbox"]["h"]
        self.last_detection_version += 1
        c_det.version = self.last_detection_version
        self.detection_mmap.seek(0)
        self.detection_mmap.write(bytes(c_det))
        self.detection_mmap.flush()
