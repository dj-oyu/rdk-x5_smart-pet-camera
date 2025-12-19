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
    c_float,
    c_char,
    c_size_t,
    sizeof,
)
from dataclasses import dataclass
from typing import Optional
import numpy as np

# Constants (must match C definitions)
SHM_NAME_FRAMES = "/pet_camera_frames"
SHM_NAME_DETECTIONS = "/pet_camera_detections"
RING_BUFFER_SIZE = 30
MAX_DETECTIONS = 10
MAX_FRAME_SIZE = 1920 * 1080 * 3 // 2  # Max NV12 frame size (1080p)


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
        ("data", c_uint8 * MAX_FRAME_SIZE),
    ]


class CSharedFrameBuffer(Structure):
    _fields_ = [
        ("write_index", c_uint32),
        ("_padding", c_uint32),  # Alignment padding (4 bytes)
        ("frames", CFrame * RING_BUFFER_SIZE),
    ]


class CLatestDetectionResult(Structure):
    _fields_ = [
        ("frame_number", c_uint64),
        ("timestamp", CTimespec),
        ("num_detections", c_int),
        ("detections", CDetection * MAX_DETECTIONS),
        ("version", c_uint32),
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
    data: bytes


class RealSharedMemory:
    """
    Real POSIX shared memory interface.

    Provides the same interface as MockSharedMemory for compatibility.
    """

    def __init__(self):
        self.frame_fd: Optional[int] = None
        self.frame_mmap: Optional[mmap.mmap] = None
        self.detection_fd: Optional[int] = None
        self.detection_mmap: Optional[mmap.mmap] = None
        self.last_read_frame_number = -1
        self.last_detection_version = 0

    def open(self):
        """Open existing shared memory segments."""
        # Open frame buffer shared memory
        try:
            # Use os.open with O_RDONLY for read-only access
            # shm_open is available via /dev/shm on Linux
            shm_path_frames = f"/dev/shm{SHM_NAME_FRAMES}"
            self.frame_fd = os.open(shm_path_frames, os.O_RDONLY)
            self.frame_mmap = mmap.mmap(
                self.frame_fd, sizeof(CSharedFrameBuffer), mmap.MAP_SHARED, mmap.PROT_READ
            )
            print(f"[Info] Opened shared memory: {shm_path_frames}")
        except FileNotFoundError:
            raise RuntimeError(
                f"Shared memory {SHM_NAME_FRAMES} not found. "
                "Is the camera daemon running?"
            )

        # Open detection shared memory
        try:
            shm_path_detections = f"/dev/shm{SHM_NAME_DETECTIONS}"
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
                f"[Warn] Detection shared memory {SHM_NAME_DETECTIONS} not found "
                "(will be created by detection process)"
            )

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
        # Offset = sizeof(write_index) + sizeof(padding) + sizeof(Frame) * latest_idx
        frame_offset = sizeof(c_uint32) * 2 + sizeof(CFrame) * latest_idx

        # Read the frame
        self.frame_mmap.seek(frame_offset)
        frame_data = self.frame_mmap.read(sizeof(CFrame))
        c_frame = CFrame.from_buffer_copy(frame_data)

        # Check if this is a new frame
        if c_frame.frame_number == self.last_read_frame_number:
            return None  # Same frame as before

        self.last_read_frame_number = c_frame.frame_number

        # Convert to Python Frame
        timestamp_sec = c_frame.timestamp.tv_sec + c_frame.timestamp.tv_nsec / 1e9

        frame = Frame(
            frame_number=c_frame.frame_number,
            timestamp_sec=timestamp_sec,
            camera_id=c_frame.camera_id,
            width=c_frame.width,
            height=c_frame.height,
            format=c_frame.format,
            data=bytes(c_frame.data[: c_frame.data_size]),
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
        if not self.detection_mmap:
            return None

        # Read entire detection structure
        self.detection_mmap.seek(0)
        det_data = self.detection_mmap.read(sizeof(CLatestDetectionResult))
        c_det = CLatestDetectionResult.from_buffer_copy(det_data)

        # Check version
        if c_det.version == self.last_detection_version:
            return None  # No new detections

        self.last_detection_version = c_det.version

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


if __name__ == "__main__":
    # Test program
    import time

    print("=== Real Shared Memory Test ===\n")

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
                    f"camera_id={frame.camera_id}"
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
