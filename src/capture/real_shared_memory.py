"""
real_shared_memory.py - Python wrapper for C POSIX shared memory

Provides access to the shared memory segments created by the camera daemon.
Compatible with the mock shared memory interface for easy swapping.
"""

import mmap
import os
import struct
from ctypes import (
    Structure,
    c_uint8,
    c_uint32,
    c_uint64,
    c_int,
    c_int32,
    c_float,
    c_char,
    c_size_t,
    sizeof,
    CDLL,
    POINTER,
    c_void_p,
    addressof,
)
from dataclasses import dataclass
from typing import Optional
import numpy as np

# Load librt for semaphore operations
librt = None
try:
    librt = CDLL("librt.so.1")
    # Define sem_post function signature
    # int sem_post(sem_t *sem)
    librt.sem_post.argtypes = [c_void_p]
    librt.sem_post.restype = c_int
except OSError:
    # Try libpthread as fallback (sem_post is sometimes there)
    try:
        librt = CDLL("libpthread.so.0")
        librt.sem_post.argtypes = [c_void_p]
        librt.sem_post.restype = c_int
    except OSError as e:
        import logging
        logging.warning(f"Failed to load librt/libpthread for semaphore support: {e}")

# Constants (must match C definitions)
SHM_NAME_ACTIVE_FRAME = "/pet_camera_active_frame"
SHM_NAME_STREAM = "/pet_camera_stream"
SHM_NAME_YOLO_INPUT = "/pet_camera_yolo_input"
SHM_NAME_BRIGHTNESS = "/pet_camera_brightness"  # Lightweight brightness data
SHM_NAME_FRAMES = os.getenv("SHM_NAME_FRAMES", SHM_NAME_ACTIVE_FRAME)
SHM_NAME_DETECTIONS = os.getenv("SHM_NAME_DETECTIONS", "/pet_camera_detections")
RING_BUFFER_SIZE = 30
MAX_DETECTIONS = 10
MAX_FRAME_SIZE = 1920 * 1080 * 3 // 2  # Max NV12 frame size (1080p)
NUM_CAMERAS = 2  # DAY=0, NIGHT=1

# Zero-copy shared memory names (Phase 2)
SHM_NAME_YOLO_ZEROCOPY = "/pet_camera_yolo_zc"
SHM_NAME_MJPEG_ZEROCOPY = "/pet_camera_mjpeg_zc"
SHM_NAME_ACTIVE_ZEROCOPY = "/pet_camera_active_zc"
ZEROCOPY_MAX_PLANES = 2  # NV12 has 2 planes (Y, UV)


# C structure definitions using ctypes
class CTimespec(Structure):
    _fields_ = [
        ("tv_sec", c_uint64),  # time_t on most systems
        ("tv_nsec", c_uint64),  # long
    ]


class CBoundingBox(Structure):
    _fields_ = [
        ("x", c_int),
        ("y", c_int),
        ("w", c_int),
        ("h", c_int),
    ]


class CDetection(Structure):
    _fields_ = [
        ("class_name", c_char * 32),
        ("confidence", c_float),
        ("bbox", CBoundingBox),
    ]


class CFrame(Structure):
    _fields_ = [
        ("frame_number", c_uint64),
        ("timestamp", CTimespec),
        ("camera_id", c_int),
        ("width", c_int),
        ("height", c_int),
        ("format", c_int),
        ("data_size", c_size_t),
        # Brightness metrics (Phase 0: ISP low-light enhancement)
        ("brightness_avg", c_float),  # Y-plane average brightness (0-255)
        ("brightness_lux", c_uint32),  # Environment illuminance from ISP cur_lux
        ("brightness_zone", c_uint8),  # 0=dark, 1=dim, 2=normal, 3=bright
        ("correction_applied", c_uint8),  # 1 if ISP low-light correction is active
        ("_reserved", c_uint8 * 2),  # Padding for alignment
        ("data", c_uint8 * MAX_FRAME_SIZE),
    ]


class CSharedFrameBuffer(Structure):
    _fields_ = [
        ("write_index", c_uint32),
        ("frame_interval_ms", c_uint32),  # Matches C SharedFrameBuffer
        ("new_frame_sem", c_uint8 * 32),  # sem_t semaphore (32 bytes on Linux)
        ("frames", CFrame * RING_BUFFER_SIZE),
    ]


class CLatestDetectionResult(Structure):
    _fields_ = [
        ("frame_number", c_uint64),
        ("timestamp", CTimespec),
        ("num_detections", c_int),
        ("detections", CDetection * MAX_DETECTIONS),
        ("version", c_uint32),
        ("detection_update_sem", c_uint8 * 32),  # sem_t semaphore (32 bytes on Linux)
    ]


class CCameraBrightness(Structure):
    """Lightweight brightness data for a single camera (~32 bytes)"""
    _fields_ = [
        ("frame_number", c_uint64),
        ("timestamp", CTimespec),
        ("brightness_avg", c_float),
        ("brightness_lux", c_uint32),
        ("brightness_zone", c_uint8),
        ("correction_applied", c_uint8),
        ("_reserved", c_uint8 * 2),
    ]


class CSharedBrightnessData(Structure):
    """Shared brightness data for all cameras"""
    _fields_ = [
        ("version", c_uint32),
        ("cameras", CCameraBrightness * NUM_CAMERAS),
        ("update_sem", c_uint8 * 32),  # sem_t semaphore (32 bytes on Linux)
    ]


# Zero-copy structures (Phase 2: share_id based, no memcpy)
class CZeroCopyFrame(Structure):
    """
    Zero-copy frame - VIO buffer shared directly without memcpy.

    Consumer uses share_id to import the VIO buffer via hb_mem_import_com_buf().
    """
    _fields_ = [
        # Frame metadata
        ("frame_number", c_uint64),
        ("timestamp", CTimespec),
        ("camera_id", c_int),
        ("width", c_int),
        ("height", c_int),
        ("format", c_int),  # 1=NV12
        # Brightness metrics
        ("brightness_avg", c_float),
        ("correction_applied", c_uint8),
        ("_pad1", c_uint8 * 3),
        # VIO buffer info
        ("share_id", c_int32 * ZEROCOPY_MAX_PLANES),  # hb_mem share_id for Y/UV
        ("plane_size", c_uint64 * ZEROCOPY_MAX_PLANES),  # Size of each plane
        ("plane_cnt", c_int32),  # Number of planes (2 for NV12)
        # Synchronization
        ("version", c_uint32),
        ("consumed", c_uint8),
        ("_pad2", c_uint8 * 3),
    ]


class CZeroCopyFrameBuffer(Structure):
    """
    Zero-copy shared memory - single frame slot for SPSC pattern.

    Camera waits on consumed_sem before writing next frame (throttles to consumer speed).
    """
    _fields_ = [
        ("new_frame_sem", c_uint8 * 32),  # sem_t (32 bytes on Linux)
        ("consumed_sem", c_uint8 * 32),   # sem_t (32 bytes on Linux)
        ("frame", CZeroCopyFrame),
    ]


# Python data classes
@dataclass
class BoundingBox:
    x: int
    y: int
    w: int
    h: int


@dataclass
class Detection:
    class_name: str
    confidence: float
    bbox: BoundingBox


@dataclass
class Frame:
    frame_number: int
    timestamp_sec: float
    camera_id: int
    width: int
    height: int
    format: int  # 0=JPEG, 1=NV12, 2=RGB
    data: bytes | memoryview  # memoryview for zero-copy optimization
    # Brightness metrics (Phase 0: ISP low-light enhancement)
    brightness_avg: float = 0.0  # Y-plane average brightness (0-255)
    brightness_lux: int = 0  # Environment illuminance from ISP cur_lux
    brightness_zone: int = 2  # 0=dark, 1=dim, 2=normal, 3=bright
    correction_applied: bool = False  # True if ISP low-light correction is active


@dataclass
class ZeroCopyFrame:
    """Zero-copy frame metadata (no actual data, just share_id references)."""
    frame_number: int
    timestamp_sec: float
    camera_id: int
    width: int
    height: int
    format: int  # 1=NV12
    brightness_avg: float
    correction_applied: bool
    share_id: list[int]  # share_id for each plane [Y, UV]
    plane_size: list[int]  # size of each plane
    plane_cnt: int
    version: int


class ZeroCopySharedMemory:
    """
    Zero-copy shared memory interface for VIO buffer sharing.

    Uses share_id to import VIO buffers directly without memcpy.
    Consumer must call mark_consumed() after processing each frame.
    """

    def __init__(self, shm_name: str = SHM_NAME_YOLO_ZEROCOPY):
        self.shm_name = shm_name
        self.fd: Optional[int] = None
        self.mmap_obj: Optional[mmap.mmap] = None
        self.last_version = 0

    def open(self) -> bool:
        """Open the zero-copy shared memory segment."""
        shm_path = f"/dev/shm{self.shm_name}"
        try:
            self.fd = os.open(shm_path, os.O_RDWR)

            # Get actual file size to verify structure match
            file_size = os.fstat(self.fd).st_size
            expected_size = sizeof(CZeroCopyFrameBuffer)
            print(f"[Info] Zero-copy SHM size: actual={file_size}, expected={expected_size}")
            print(f"[Info] CZeroCopyFrame size: {sizeof(CZeroCopyFrame)}")
            print(f"[Info] Frame offset: new_frame_sem=0, consumed_sem=32, frame=64")

            if file_size != expected_size:
                print(f"[WARN] Size mismatch! C struct may have different layout.")
                print(f"[WARN] Using actual file size for mmap: {file_size}")

            self.mmap_obj = mmap.mmap(
                self.fd,
                file_size,  # Use actual size
                mmap.MAP_SHARED,
                mmap.PROT_READ | mmap.PROT_WRITE,
            )
            print(f"[Info] Opened zero-copy shared memory: {shm_path}")
            return True
        except FileNotFoundError:
            print(f"[Warn] Zero-copy SHM not found: {shm_path} (fallback to memcpy)")
            return False
        except Exception as e:
            print(f"[Error] Failed to open zero-copy SHM: {e}")
            return False

    def close(self) -> None:
        """Close the shared memory segment."""
        if self.mmap_obj:
            self.mmap_obj.close()
            self.mmap_obj = None
        if self.fd:
            os.close(self.fd)
            self.fd = None

    def get_frame(self) -> Optional[ZeroCopyFrame]:
        """
        Get the latest frame metadata (non-blocking).

        Returns:
            ZeroCopyFrame if new frame available, None otherwise
        """
        if not self.mmap_obj:
            return None

        # Read the buffer structure
        self.mmap_obj.seek(0)
        data = self.mmap_obj.read(sizeof(CZeroCopyFrameBuffer))
        buf = CZeroCopyFrameBuffer.from_buffer_copy(data)

        # Check version
        if buf.frame.version == self.last_version:
            return None  # No new frame

        self.last_version = buf.frame.version

        # Validate plane_cnt to avoid invalid array access
        plane_cnt = buf.frame.plane_cnt
        if plane_cnt < 0 or plane_cnt > ZEROCOPY_MAX_PLANES:
            print(f"[ERROR] Invalid plane_cnt: {plane_cnt}, expected 0-{ZEROCOPY_MAX_PLANES}")
            return None

        # Convert to Python dataclass
        timestamp_sec = buf.frame.timestamp.tv_sec + buf.frame.timestamp.tv_nsec / 1e9
        return ZeroCopyFrame(
            frame_number=buf.frame.frame_number,
            timestamp_sec=timestamp_sec,
            camera_id=buf.frame.camera_id,
            width=buf.frame.width,
            height=buf.frame.height,
            format=buf.frame.format,
            brightness_avg=buf.frame.brightness_avg,
            correction_applied=bool(buf.frame.correction_applied),
            share_id=[buf.frame.share_id[i] for i in range(plane_cnt)],
            plane_size=[buf.frame.plane_size[i] for i in range(plane_cnt)],
            plane_cnt=plane_cnt,
            version=buf.frame.version,
        )

    def mark_consumed(self) -> None:
        """
        Mark the current frame as consumed.

        MUST be called after processing each frame to allow camera to write next frame.
        """
        if not self.mmap_obj:
            return

        # Calculate offset to consumed field
        # Offset = sizeof(new_frame_sem) + sizeof(consumed_sem) + offset of consumed in CZeroCopyFrame
        frame_offset = 32 + 32  # sem_t sizes
        consumed_offset = frame_offset + CZeroCopyFrame.consumed.offset

        # Write consumed = 1
        self.mmap_obj.seek(consumed_offset)
        self.mmap_obj.write(b'\x01')
        self.mmap_obj.flush()

        # Post consumed_sem (at offset 32 in the buffer)
        if librt:
            # Create a ctypes array backed by the mmap at offset 32 (consumed_sem location)
            # sem_t is 32 bytes on Linux
            sem_array_type = c_uint8 * 32
            sem_buf = sem_array_type.from_buffer(self.mmap_obj, 32)
            ret = librt.sem_post(addressof(sem_buf))
            if ret != 0:
                import logging
                logging.warning(f"sem_post failed: {ret}")


class RealSharedMemory:
    """
    Real POSIX shared memory interface.

    Provides the same interface as MockSharedMemory for compatibility.
    """

    def __init__(
        self,
        frame_shm_name: Optional[str] = None,
        detection_shm_name: Optional[str] = None,
    ):
        self.frame_fd: Optional[int] = None
        self.frame_mmap: Optional[mmap.mmap] = None
        self.detection_fd: Optional[int] = None
        self.detection_mmap: Optional[mmap.mmap] = None
        self.last_read_frame_number = -1
        self.last_detection_version = 0
        self.total_frames_read = 0
        self.detection_write_mode = False
        self.frame_shm_name = frame_shm_name or SHM_NAME_FRAMES
        self.detection_shm_name = detection_shm_name or SHM_NAME_DETECTIONS

    def open(self):
        """Open existing shared memory segments."""
        # Open frame buffer shared memory
        try:
            # Use os.open with O_RDONLY for read-only access
            # shm_open is available via /dev/shm on Linux
            shm_path_frames = f"/dev/shm{self.frame_shm_name}"
            self.frame_fd = os.open(shm_path_frames, os.O_RDONLY)
            self.frame_mmap = mmap.mmap(
                self.frame_fd, sizeof(CSharedFrameBuffer), mmap.MAP_SHARED, mmap.PROT_READ
            )
            print(f"[Info] Opened shared memory: {shm_path_frames}")
        except FileNotFoundError:
            raise RuntimeError(
                f"Shared memory {self.frame_shm_name} not found. "
                "Is the camera daemon running?"
            )

        # Open detection shared memory
        try:
            shm_path_detections = f"/dev/shm{self.detection_shm_name}"
            self.detection_fd = os.open(shm_path_detections, os.O_RDONLY)
            self.detection_mmap = mmap.mmap(
                self.detection_fd,
                sizeof(CLatestDetectionResult),
                mmap.MAP_SHARED,
                mmap.PROT_READ,
            )
            print(f"[Info] Opened shared memory: {shm_path_detections}")
        except FileNotFoundError:
            # Detection shared memory might not exist yet
            print(
                f"[Warn] Detection shared memory {self.detection_shm_name} not found "
                "(will be created by detection process)"
            )

    def open_detection_write(self):
        """Open detection shared memory in write mode (creates if not exists)."""
        import ctypes.util

        shm_path_detections = f"/dev/shm{self.detection_shm_name}"

        try:
            # Try to open existing
            self.detection_fd = os.open(shm_path_detections, os.O_RDWR)
        except FileNotFoundError:
            # Create new shared memory
            self.detection_fd = os.open(
                shm_path_detections, os.O_CREAT | os.O_RDWR, 0o666
            )
            # Resize to correct size
            os.ftruncate(self.detection_fd, sizeof(CLatestDetectionResult))

        self.detection_mmap = mmap.mmap(
            self.detection_fd, sizeof(CLatestDetectionResult), mmap.MAP_SHARED, mmap.PROT_WRITE | mmap.PROT_READ
        )
        self.detection_write_mode = True
        print(f"[Info] Opened detection shared memory for writing: {shm_path_detections}")

    def close(self):
        """Close shared memory."""
        if self.frame_mmap:
            self.frame_mmap.close()
        if self.frame_fd:
            os.close(self.frame_fd)
        if self.detection_mmap:
            self.detection_mmap.close()
        if self.detection_fd:
            os.close(self.detection_fd)

    def get_latest_frame(self) -> Optional[Frame]:
        """
        Read the latest frame from shared memory.

        Returns:
            Frame object or None if no new frames
        """
        if not self.frame_mmap:
            return None

        # Read write_index atomically
        self.frame_mmap.seek(0)
        write_index = struct.unpack("I", self.frame_mmap.read(4))[0]

        if write_index == 0:
            # No frames written yet
            return None

        # Calculate latest frame index
        latest_idx = (write_index - 1) % RING_BUFFER_SIZE

        # Calculate offset to the frame
        # Offset = sizeof(write_index) + sizeof(frame_interval_ms) + sizeof(new_frame_sem) + sizeof(Frame) * latest_idx
        # new_frame_sem is 32 bytes (sem_t on Linux)
        frame_offset = sizeof(c_uint32) * 2 + 32 + sizeof(CFrame) * latest_idx

        # Read the frame
        self.frame_mmap.seek(frame_offset)
        frame_data = self.frame_mmap.read(sizeof(CFrame))
        c_frame = CFrame.from_buffer_copy(frame_data)

        # Check if this is a new frame
        if c_frame.frame_number == self.last_read_frame_number:
            return None  # Same frame as before

        self.last_read_frame_number = c_frame.frame_number
        self.total_frames_read += 1

        # Convert to Python Frame
        timestamp_sec = c_frame.timestamp.tv_sec + c_frame.timestamp.tv_nsec / 1e9

        # ゼロコピー最適化：memoryviewを使用（bytes()コピーを避ける）
        # YOLODetectorはbytesもmemoryviewも受け取れる
        data_view = memoryview(c_frame.data)[: c_frame.data_size]

        frame = Frame(
            frame_number=c_frame.frame_number,
            timestamp_sec=timestamp_sec,
            camera_id=c_frame.camera_id,
            width=c_frame.width,
            height=c_frame.height,
            format=c_frame.format,
            data=data_view,  # memoryview（ゼロコピー）
            brightness_avg=c_frame.brightness_avg,
            brightness_lux=c_frame.brightness_lux,
            brightness_zone=c_frame.brightness_zone,
            correction_applied=bool(c_frame.correction_applied),
        )

        return frame

    def get_write_index(self) -> int:
        """Get current write index."""
        if not self.frame_mmap:
            return 0
        self.frame_mmap.seek(0)
        write_index = struct.unpack("I", self.frame_mmap.read(4))[0]
        return write_index

    def get_latest_detections(self) -> Optional[tuple[int, list[Detection]]]:
        """
        Read the latest detection results.

        Returns:
            Tuple of (version, detections) or None if no new detections
        """
        detection_struct = self._read_detection_struct()
        if detection_struct is None:
            return None

        c_det, has_new_version = detection_struct
        if not has_new_version:
            return None

        # Convert to Python Detection objects
        detections = []
        for i in range(c_det.num_detections):
            c_detection = c_det.detections[i]
            bbox = BoundingBox(
                x=c_detection.bbox.x,
                y=c_detection.bbox.y,
                w=c_detection.bbox.w,
                h=c_detection.bbox.h,
            )
            detection = Detection(
                class_name=c_detection.class_name.decode("utf-8").rstrip("\x00"),
                confidence=c_detection.confidence,
                bbox=bbox,
            )
            detections.append(detection)

        return (c_det.version, detections)

    def read_latest_frame(self) -> Optional[Frame]:
        """Alias for compatibility with MockSharedMemory."""
        return self.get_latest_frame()

    def get_detection_version(self) -> int:
        """Return the last observed detection version (polls shared memory if available)."""
        if not self.detection_mmap:
            # Try to open detection shared memory if not already opened
            self._try_open_detection_readonly()
            if not self.detection_mmap:
                return self.last_detection_version

        detection_struct = self._read_detection_struct(update_version_only=True)
        if detection_struct is None:
            return self.last_detection_version

        c_det, _ = detection_struct
        return c_det.version

    def read_detection(self) -> tuple[Optional[dict], int]:
        """
        Return the latest detection result as a JSON-serializable dict and its version.

        Returns:
            (detection_result_dict | None, version)
        """
        # Try to open detection shared memory if not already opened
        if not self.detection_mmap:
            self._try_open_detection_readonly()

        detection_struct = self._read_detection_struct()
        if detection_struct is None:
            return (None, self.last_detection_version)

        c_det, _ = detection_struct

        detections = []
        for i in range(c_det.num_detections):
            c_detection = c_det.detections[i]
            detections.append(
                {
                    "class_name": c_detection.class_name.decode("utf-8").rstrip("\x00"),
                    "confidence": float(c_detection.confidence),
                    "bbox": {
                        "x": int(c_detection.bbox.x),
                        "y": int(c_detection.bbox.y),
                        "w": int(c_detection.bbox.w),
                        "h": int(c_detection.bbox.h),
                    },
                }
            )

        detection_result = {
            "frame_number": int(c_det.frame_number),
            "timestamp": float(c_det.timestamp.tv_sec + c_det.timestamp.tv_nsec / 1e9),
            "detections": detections,
            "version": int(c_det.version),
        }

        return (detection_result, c_det.version)

    def get_stats(self) -> dict[str, int]:
        """Return stats compatible with MockSharedMemory for the monitor API."""
        write_index = self.get_write_index()
        frame_count = min(write_index, RING_BUFFER_SIZE) if write_index > 0 else 0
        detection_version = self.get_detection_version()
        return {
            "frame_count": frame_count,
            "total_frames_written": write_index,
            "detection_version": detection_version,
            "has_detection": 1 if detection_version > 0 else 0,
        }

    def _try_open_detection_readonly(self) -> None:
        """Try to open detection shared memory in read-only mode (for lazy initialization)."""
        if self.detection_mmap or self.detection_write_mode:
            return  # Already opened

        try:
            shm_path_detections = f"/dev/shm{self.detection_shm_name}"
            self.detection_fd = os.open(shm_path_detections, os.O_RDONLY)
            self.detection_mmap = mmap.mmap(
                self.detection_fd,
                sizeof(CLatestDetectionResult),
                mmap.MAP_SHARED,
                mmap.PROT_READ,
            )
            print(f"[Info] Opened detection shared memory: {shm_path_detections}")
        except FileNotFoundError:
            # Detection shared memory still doesn't exist
            pass

    def _read_detection_struct(
        self, update_version_only: bool = False
    ) -> Optional[tuple[CLatestDetectionResult, bool]]:
        """
        Read the detection shared memory structure.

        Args:
            update_version_only: If True, don't check version change for callers that only
                want the latest version number.

        Returns:
            Tuple of (CLatestDetectionResult, has_new_version) or None if unavailable.
        """
        if not self.detection_mmap:
            return None

        self.detection_mmap.seek(0)
        det_data = self.detection_mmap.read(sizeof(CLatestDetectionResult))
        if len(det_data) < sizeof(CLatestDetectionResult):
            # Shared memory not ready or truncated; treat as no data.
            return None
        c_det = CLatestDetectionResult.from_buffer_copy(det_data)

        has_new_version = c_det.version != self.last_detection_version

        if has_new_version:
            self.last_detection_version = c_det.version

        # Always return the detection structure (don't filter by version here)
        # Version filtering should be done by the caller if needed
        return (c_det, has_new_version)

    def decode_jpeg(self, jpeg_data: bytes) -> np.ndarray:
        """
        Decode JPEG data to numpy array (RGB).

        Args:
            jpeg_data: JPEG encoded data

        Returns:
            numpy array (H, W, 3) in RGB format
        """
        import cv2

        nparr = np.frombuffer(jpeg_data, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Failed to decode JPEG")
        # OpenCV loads as BGR, convert to RGB
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        return img

    def write_detection_result(
        self,
        frame_number: int,
        timestamp_sec: float,
        detections: list[dict],
    ) -> None:
        """
        Write detection result to shared memory.

        Args:
            frame_number: Frame number this detection corresponds to
            timestamp_sec: Timestamp in seconds
            detections: List of detection dicts with 'class_name', 'confidence', 'bbox'
        """
        if not self.detection_write_mode or not self.detection_mmap:
            raise RuntimeError("Detection shared memory not opened for writing")

        # Create C structure
        c_det = CLatestDetectionResult()
        c_det.frame_number = frame_number

        # Convert timestamp
        c_det.timestamp.tv_sec = int(timestamp_sec)
        c_det.timestamp.tv_nsec = int((timestamp_sec - int(timestamp_sec)) * 1e9)

        # Fill detections
        c_det.num_detections = min(len(detections), MAX_DETECTIONS)
        for i, det in enumerate(detections[:MAX_DETECTIONS]):
            c_detection = c_det.detections[i]
            class_name = det["class_name"].encode("utf-8")
            c_detection.class_name = class_name
            c_detection.confidence = det["confidence"]
            c_detection.bbox.x = det["bbox"]["x"]
            c_detection.bbox.y = det["bbox"]["y"]
            c_detection.bbox.w = det["bbox"]["w"]
            c_detection.bbox.h = det["bbox"]["h"]

        # Increment version (using atomic-like increment)
        self.last_detection_version += 1
        c_det.version = self.last_detection_version

        # Write to shared memory
        self.detection_mmap.seek(0)
        data = bytes(c_det)
        self.detection_mmap.write(data)
        self.detection_mmap.flush()

        # NOTE: sem_post() removed - Go side uses polling mode (33ms interval)
        # Semaphore signaling was causing unnecessary overhead


def monitor_brightness():
    """Monitor brightness from both cameras using lightweight shared memory."""
    import time

    ZONE_NAMES = ["DARK", "DIM", "NORMAL", "BRIGHT"]
    CAMERA_NAMES = ["DAY", "NIGHT"]

    print("=== Camera Brightness Monitor ===\n")
    print(f"SHM: {SHM_NAME_BRIGHTNESS} (lightweight, ~100 bytes)")
    print("-" * 70)

    # Open brightness shared memory
    shm_path = f"/dev/shm{SHM_NAME_BRIGHTNESS}"
    brightness_fd = None
    brightness_mmap = None

    try:
        brightness_fd = os.open(shm_path, os.O_RDONLY)
        brightness_mmap = mmap.mmap(
            brightness_fd, sizeof(CSharedBrightnessData), mmap.MAP_SHARED, mmap.PROT_READ
        )
        print(f"[Info] Opened {shm_path}")
    except FileNotFoundError:
        print(f"[Error] Brightness SHM not found: {shm_path}")
        print("Is camera daemon running?")
        return
    except Exception as e:
        print(f"[Error] Failed to open brightness SHM: {e}")
        return

    print("\nMonitoring brightness (Ctrl+C to stop)...\n")
    print(f"{'Time':<12} {'Camera':<8} {'Frame':<10} {'Bright':>8} {'Lux':>8} {'Zone':<8} {'Corr':<5}")
    print("=" * 70)

    last_version = 0
    last_frames = [-1, -1]  # Track frame numbers for each camera

    try:
        while True:
            # Read brightness data
            brightness_mmap.seek(0)
            data = brightness_mmap.read(sizeof(CSharedBrightnessData))
            shm_data = CSharedBrightnessData.from_buffer_copy(data)

            # Check if there's new data
            if shm_data.version != last_version:
                last_version = shm_data.version
                now = time.strftime("%H:%M:%S")

                # Print brightness for each camera if updated
                for cam_id in range(NUM_CAMERAS):
                    cam = shm_data.cameras[cam_id]
                    if cam.frame_number != last_frames[cam_id] and cam.frame_number > 0:
                        last_frames[cam_id] = cam.frame_number
                        zone_name = ZONE_NAMES[cam.brightness_zone] if cam.brightness_zone < 4 else "?"
                        corr = "ON" if cam.correction_applied else "OFF"
                        cam_name = CAMERA_NAMES[cam_id]
                        print(
                            f"{now:<12} {cam_name:<8} {cam.frame_number:<10} "
                            f"{cam.brightness_avg:>8.1f} {cam.brightness_lux:>8} "
                            f"{zone_name:<8} {corr:<5}"
                        )

            time.sleep(0.1)

    except KeyboardInterrupt:
        print("\n[Info] Stopped by user")
    finally:
        if brightness_mmap:
            brightness_mmap.close()
        if brightness_fd:
            os.close(brightness_fd)


if __name__ == "__main__":
    import sys
    import time

    # Check for brightness monitoring mode
    if len(sys.argv) > 1 and sys.argv[1] in ("-b", "--brightness"):
        monitor_brightness()
        sys.exit(0)

    # Default: original test program
    print("=== Real Shared Memory Test ===")
    print("Usage: python real_shared_memory.py [-b|--brightness]")
    print("  -b, --brightness  Monitor brightness from both cameras\n")

    shm = RealSharedMemory()

    try:
        shm.open()

        print("Monitoring for frames (Ctrl+C to stop)...\n")

        while True:
            frame = shm.get_latest_frame()
            if frame:
                print(
                    f"Frame {frame.frame_number}: "
                    f"{frame.width}x{frame.height}, "
                    f"{len(frame.data)} bytes, "
                    f"camera_id={frame.camera_id}, "
                    f"brightness={frame.brightness_avg:.1f}"
                )

                # Try to decode if JPEG
                if frame.format == 0 and len(frame.data) > 0:
                    try:
                        img = shm.decode_jpeg(frame.data)
                        print(f"  Decoded JPEG: {img.shape}")
                    except Exception as e:
                        print(f"  JPEG decode error: {e}")

            # Check for detections
            det_result = shm.get_latest_detections()
            if det_result:
                version, detections = det_result
                print(f"Detections (v{version}): {len(detections)} objects")
                for det in detections:
                    print(
                        f"  - {det.class_name}: {det.confidence:.2f} "
                        f"at ({det.bbox.x}, {det.bbox.y})"
                    )

            time.sleep(0.1)

    except KeyboardInterrupt:
        print("\n[Info] Stopped by user")
    except Exception as e:
        print(f"[Error] {e}")
        import traceback

        traceback.print_exc()
    finally:
        shm.close()
