"""
hb_mem_bindings.py - Python bindings for D-Robotics hb_mem API

Provides zero-copy buffer sharing via share_id from VIO pipeline.
Used by Python consumers (YOLO daemon, web_monitor) to map VIO buffers
without memcpy.

Usage:
    from hb_mem_bindings import HbMemBuffer

    # Import buffer using share_id from zero-copy shared memory
    buf = HbMemBuffer.import_from_share_id(share_id, size)

    # Access as numpy array (zero-copy view)
    nv12_data = buf.as_numpy()

    # Release when done (IMPORTANT: must release before VIO can reuse buffer)
    buf.release()
"""

import ctypes
from ctypes import (
    c_int,
    c_int32,
    c_int64,
    c_uint64,
    c_void_p,
    c_char_p,
    POINTER,
    Structure,
    byref,
)
from typing import Optional
import numpy as np
import logging

logger = logging.getLogger(__name__)

# ============================================================================
# D-Robotics SDK Structures (from hb_mem_mgr.h)
# ============================================================================

# Maximum planes for graphic buffer (NV12 = 2 planes)
HB_MEM_GRAPHIC_MAX_PLANE = 3


class hb_mem_common_buf_t(Structure):
    """
    Common buffer structure for hb_mem API.

    From SDK hb_mem_mgr.h:
    typedef struct hb_mem_common_buf_s {
        int32_t fd;
        uint64_t phys_addr;
        uint64_t virt_addr;
        uint64_t size;
        int32_t share_id;
        uint64_t offset;
        int32_t flags;
        int32_t reserved[8];
    } hb_mem_common_buf_t;
    """
    _fields_ = [
        ("fd", c_int32),
        ("phys_addr", c_uint64),
        ("virt_addr", c_uint64),
        ("size", c_uint64),
        ("share_id", c_int32),
        ("offset", c_uint64),
        ("flags", c_int32),
        ("reserved", c_int32 * 8),
    ]


class hb_mem_graphic_buf_t(Structure):
    """
    Graphic buffer structure for VIO frames.

    From SDK hb_mem_mgr.h:
    typedef struct hb_mem_graphic_buf_s {
        int32_t fd[HB_MEM_GRAPHIC_MAX_PLANE];
        uint64_t phys_addr[HB_MEM_GRAPHIC_MAX_PLANE];
        uint64_t virt_addr[HB_MEM_GRAPHIC_MAX_PLANE];
        uint64_t size[HB_MEM_GRAPHIC_MAX_PLANE];
        int32_t share_id[HB_MEM_GRAPHIC_MAX_PLANE];
        int32_t plane_cnt;
        int32_t format;
        int32_t width;
        int32_t height;
        int32_t stride;
        int32_t vstride;
        int32_t flags;
        int32_t reserved[8];
    } hb_mem_graphic_buf_t;
    """
    _fields_ = [
        ("fd", c_int32 * HB_MEM_GRAPHIC_MAX_PLANE),
        ("phys_addr", c_uint64 * HB_MEM_GRAPHIC_MAX_PLANE),
        ("virt_addr", c_uint64 * HB_MEM_GRAPHIC_MAX_PLANE),
        ("size", c_uint64 * HB_MEM_GRAPHIC_MAX_PLANE),
        ("share_id", c_int32 * HB_MEM_GRAPHIC_MAX_PLANE),
        ("plane_cnt", c_int32),
        ("format", c_int32),
        ("width", c_int32),
        ("height", c_int32),
        ("stride", c_int32),
        ("vstride", c_int32),
        ("flags", c_int32),
        ("reserved", c_int32 * 8),
    ]


# ============================================================================
# Library Loading
# ============================================================================

_libhbmem: Optional[ctypes.CDLL] = None


def _load_libhbmem() -> Optional[ctypes.CDLL]:
    """
    Load the D-Robotics hb_mem library.

    Returns:
        CDLL object or None if not available (mock mode)
    """
    global _libhbmem
    if _libhbmem is not None:
        return _libhbmem

    # Try to load the library from common locations
    lib_names = [
        "libhbmem.so",
        "libhbmem.so.1",
        "/usr/lib/libhbmem.so",
        "/usr/local/lib/libhbmem.so",
    ]

    for lib_name in lib_names:
        try:
            _libhbmem = ctypes.CDLL(lib_name)
            logger.info(f"Loaded hb_mem library: {lib_name}")

            # Set up function signatures
            _setup_function_signatures(_libhbmem)
            return _libhbmem
        except OSError:
            continue

    logger.warning("hb_mem library not found - zero-copy disabled, using mock mode")
    return None


def _setup_function_signatures(lib: ctypes.CDLL) -> None:
    """
    Set up ctypes function signatures for the hb_mem API.
    """
    # int hb_mem_module_open(void)
    lib.hb_mem_module_open.argtypes = []
    lib.hb_mem_module_open.restype = c_int

    # void hb_mem_module_close(void)
    lib.hb_mem_module_close.argtypes = []
    lib.hb_mem_module_close.restype = None

    # int hb_mem_import_com_buf(int32_t share_id, hb_mem_common_buf_t *buf)
    lib.hb_mem_import_com_buf.argtypes = [c_int32, POINTER(hb_mem_common_buf_t)]
    lib.hb_mem_import_com_buf.restype = c_int

    # int hb_mem_free_com_buf(hb_mem_common_buf_t *buf)
    lib.hb_mem_free_com_buf.argtypes = [POINTER(hb_mem_common_buf_t)]
    lib.hb_mem_free_com_buf.restype = c_int

    # int hb_mem_invalidate_buf_with_vaddr(uint64_t vaddr, uint64_t size)
    lib.hb_mem_invalidate_buf_with_vaddr.argtypes = [c_uint64, c_uint64]
    lib.hb_mem_invalidate_buf_with_vaddr.restype = c_int


# ============================================================================
# Module Initialization
# ============================================================================

_module_initialized = False


def init_module() -> bool:
    """
    Initialize the hb_mem module.

    Must be called once before using any hb_mem functions.
    Safe to call multiple times (idempotent).

    Returns:
        True if initialized successfully, False if not available
    """
    global _module_initialized

    if _module_initialized:
        return True

    lib = _load_libhbmem()
    if lib is None:
        return False

    ret = lib.hb_mem_module_open()
    if ret != 0:
        logger.error(f"hb_mem_module_open failed: {ret}")
        return False

    _module_initialized = True
    logger.info("hb_mem module initialized")
    return True


def close_module() -> None:
    """
    Close the hb_mem module.

    Should be called on shutdown to release resources.
    """
    global _module_initialized

    if not _module_initialized:
        return

    lib = _load_libhbmem()
    if lib is not None:
        lib.hb_mem_module_close()

    _module_initialized = False
    logger.info("hb_mem module closed")


# ============================================================================
# HbMemBuffer Class
# ============================================================================

class HbMemBuffer:
    """
    Wrapper for hb_mem imported buffer.

    Provides zero-copy access to VIO buffers shared via share_id.
    """

    def __init__(self, share_id: int, expected_size: int):
        """
        Import a buffer using share_id.

        Args:
            share_id: The share_id from ZeroCopyFrame
            expected_size: Expected buffer size in bytes

        Raises:
            RuntimeError: If import fails
        """
        self._buf = hb_mem_common_buf_t()
        self._imported = False
        self._share_id = share_id
        self._expected_size = expected_size

        lib = _load_libhbmem()
        if lib is None:
            raise RuntimeError("hb_mem library not available")

        if not _module_initialized:
            raise RuntimeError("hb_mem module not initialized - call init_module() first")

        ret = lib.hb_mem_import_com_buf(share_id, byref(self._buf))
        if ret != 0:
            raise RuntimeError(f"hb_mem_import_com_buf failed: {ret} (share_id={share_id})")

        self._imported = True
        logger.debug(f"Imported buffer: share_id={share_id}, size={self._buf.size}, vaddr=0x{self._buf.virt_addr:x}")

    @classmethod
    def import_from_share_id(cls, share_id: int, expected_size: int) -> "HbMemBuffer":
        """
        Factory method to import buffer from share_id.

        Args:
            share_id: The share_id from ZeroCopyFrame
            expected_size: Expected buffer size in bytes

        Returns:
            HbMemBuffer instance
        """
        return cls(share_id, expected_size)

    def invalidate_cache(self) -> None:
        """
        Invalidate CPU cache for this buffer.

        Call this before reading the buffer to ensure fresh data from DMA.
        """
        lib = _load_libhbmem()
        if lib is None or not self._imported:
            return

        lib.hb_mem_invalidate_buf_with_vaddr(self._buf.virt_addr, self._buf.size)

    def as_numpy(self, dtype: np.dtype = np.uint8) -> np.ndarray:
        """
        Get buffer as numpy array (zero-copy view).

        Args:
            dtype: Numpy dtype for the array (default: uint8)

        Returns:
            Numpy array view of the buffer

        Note:
            The array is only valid while this HbMemBuffer is alive.
            Do NOT use the array after calling release().
        """
        if not self._imported:
            raise RuntimeError("Buffer not imported or already released")

        # Invalidate cache to get fresh data
        self.invalidate_cache()

        # Create numpy array from virtual address
        # Using ctypes to create a buffer from the virtual address
        size = int(self._buf.size)
        vaddr = int(self._buf.virt_addr)

        # Create ctypes array type and instance from address
        ArrayType = ctypes.c_uint8 * size
        arr = ArrayType.from_address(vaddr)

        # Create numpy array as view (no copy)
        np_arr = np.ctypeslib.as_array(arr)

        return np_arr

    @property
    def virt_addr(self) -> int:
        """Get virtual address of buffer."""
        return self._buf.virt_addr

    @property
    def phys_addr(self) -> int:
        """Get physical address of buffer."""
        return self._buf.phys_addr

    @property
    def size(self) -> int:
        """Get buffer size in bytes."""
        return self._buf.size

    @property
    def share_id(self) -> int:
        """Get the share_id this buffer was imported from."""
        return self._share_id

    def release(self) -> None:
        """
        Release the imported buffer.

        IMPORTANT: Must be called when done processing the frame.
        After release, the VIO pipeline can reuse this buffer.
        """
        if not self._imported:
            return

        lib = _load_libhbmem()
        if lib is not None:
            ret = lib.hb_mem_free_com_buf(byref(self._buf))
            if ret != 0:
                logger.warning(f"hb_mem_free_com_buf failed: {ret}")

        self._imported = False
        logger.debug(f"Released buffer: share_id={self._share_id}")

    def __del__(self):
        """Destructor - ensure buffer is released."""
        self.release()

    def __enter__(self):
        """Context manager entry."""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - release buffer."""
        self.release()
        return False


# ============================================================================
# Convenience Functions
# ============================================================================

def import_nv12_planes(
    share_id_y: int,
    share_id_uv: int,
    y_size: int,
    uv_size: int,
) -> tuple[np.ndarray, np.ndarray, list["HbMemBuffer"]]:
    """
    Import Y and UV planes of an NV12 buffer.

    Args:
        share_id_y: share_id for Y plane
        share_id_uv: share_id for UV plane
        y_size: Size of Y plane in bytes
        uv_size: Size of UV plane in bytes

    Returns:
        Tuple of (y_array, uv_array, buffers_to_release)
        The buffers_to_release list should be passed to release_buffers() when done.
    """
    buffers = []
    try:
        buf_y = HbMemBuffer.import_from_share_id(share_id_y, y_size)
        buffers.append(buf_y)

        buf_uv = HbMemBuffer.import_from_share_id(share_id_uv, uv_size)
        buffers.append(buf_uv)

        y_arr = buf_y.as_numpy()
        uv_arr = buf_uv.as_numpy()

        return y_arr, uv_arr, buffers
    except Exception:
        # Clean up on error
        for buf in buffers:
            buf.release()
        raise


def release_buffers(buffers: list["HbMemBuffer"]) -> None:
    """
    Release a list of imported buffers.

    Args:
        buffers: List of HbMemBuffer instances to release
    """
    for buf in buffers:
        buf.release()


# ============================================================================
# Test
# ============================================================================

if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.DEBUG)

    print("=== hb_mem_bindings Test ===\n")

    # Check if library is available
    lib = _load_libhbmem()
    if lib is None:
        print("hb_mem library not available - running in mock mode")
        print("This is expected when running on a non-D-Robotics system.\n")
        sys.exit(0)

    # Initialize module
    if not init_module():
        print("Failed to initialize hb_mem module")
        sys.exit(1)

    print("hb_mem module initialized successfully")

    # Test would require actual share_ids from a running camera daemon
    # For now, just verify the module loads correctly

    close_module()
    print("\nhb_mem module closed")
