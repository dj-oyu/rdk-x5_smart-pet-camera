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
    addressof,
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

    Verified layout from /usr/include/hb_mem_mgr.h on RDK X5.

    NOTE: This struct is kept for the legacy HbMemBuffer class (import_com_buf).
    New code should use HbMemGraphicBuffer (import_graph_buf) instead.
    """

    _fields_ = [
        ("fd", c_int32),           # offset 0
        ("share_id", c_int32),     # offset 4
        ("flags", c_int64),        # offset 8
        ("size", c_uint64),        # offset 16
        ("virt_addr", c_uint64),   # offset 24
        ("phys_addr", c_uint64),   # offset 32
        ("offset", c_uint64),      # offset 40
    ]


class hb_mem_graphic_buf_t(Structure):
    """
    Graphic buffer structure for VIO frames.

    Verified layout from /usr/include/hb_mem_mgr.h on RDK X5 (aarch64).

    NOTE: This ctypes struct is kept for reference but is NOT used for import.
    HbMemGraphicBuffer uses raw bytes + struct.unpack to avoid layout issues.
    """

    _fields_ = [
        ("fd", c_int32 * HB_MEM_GRAPHIC_MAX_PLANE),          # offset 0
        ("plane_cnt", c_int32),                                # offset 12
        ("format", c_int32),                                   # offset 16
        ("width", c_int32),                                    # offset 20
        ("height", c_int32),                                   # offset 24
        ("stride", c_int32),                                   # offset 28
        ("vstride", c_int32),                                  # offset 32
        ("is_contig", c_int32),                                # offset 36
        ("share_id", c_int32 * HB_MEM_GRAPHIC_MAX_PLANE),     # offset 40
        ("flags", c_int64),                                    # offset 56
        ("size", c_uint64 * HB_MEM_GRAPHIC_MAX_PLANE),        # offset 64
        ("virt_addr", c_uint64 * HB_MEM_GRAPHIC_MAX_PLANE),   # offset 88
        ("phys_addr", c_uint64 * HB_MEM_GRAPHIC_MAX_PLANE),   # offset 112
        ("offset", c_uint64 * HB_MEM_GRAPHIC_MAX_PLANE),      # offset 136
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

    # int32_t hb_mem_import_com_buf(hb_mem_common_buf_t *buf, hb_mem_common_buf_t *out_buf)
    # Note: First param is INPUT buffer with share_id set, second is OUTPUT buffer
    lib.hb_mem_import_com_buf.argtypes = [POINTER(hb_mem_common_buf_t), POINTER(hb_mem_common_buf_t)]
    lib.hb_mem_import_com_buf.restype = c_int32

    # int32_t hb_mem_import_graph_buf(hb_mem_graphic_buf_t *in_buf, hb_mem_graphic_buf_t *out_buf)
    # Using c_void_p to pass raw byte buffers directly (avoids ctypes struct layout issues)
    lib.hb_mem_import_graph_buf.argtypes = [c_void_p, c_void_p]
    lib.hb_mem_import_graph_buf.restype = c_int32

    # int hb_mem_free_buf(int32_t fd)
    # SDK takes file descriptor, not struct pointer
    lib.hb_mem_free_buf.argtypes = [c_int32]
    lib.hb_mem_free_buf.restype = c_int

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
        self._in_buf = hb_mem_common_buf_t()  # Input buffer with share_id
        self._buf = hb_mem_common_buf_t()     # Output buffer (actual imported data)
        self._imported = False
        self._share_id = share_id
        self._expected_size = expected_size

        lib = _load_libhbmem()
        if lib is None:
            raise RuntimeError("hb_mem library not available")

        if not _module_initialized:
            raise RuntimeError(
                "hb_mem module not initialized - call init_module() first"
            )

        # Set up input buffer with share_id
        self._in_buf.share_id = c_int32(share_id)

        ret = lib.hb_mem_import_com_buf(byref(self._in_buf), byref(self._buf))
        if ret != 0:
            raise RuntimeError(
                f"hb_mem_import_com_buf failed: {ret} (share_id={share_id})"
            )

        self._imported = True
        logger.debug(
            f"Imported buffer: share_id={share_id}, size={self._buf.size}, vaddr=0x{self._buf.virt_addr:x}"
        )

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
            ret = lib.hb_mem_free_buf(c_int32(self._buf.fd))
            if ret != 0:
                logger.warning(f"hb_mem_free_buf failed: {ret}")

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
# HbMemGraphicBuffer Class (graph_buf import API)
# ============================================================================

# Verified struct layout from /usr/include/hb_mem_mgr.h on RDK X5:
#
# typedef struct hb_mem_graphic_buf_t {
#     int32_t fd[3];           // offset 0   (12 bytes)
#     int32_t plane_cnt;       // offset 12  (4 bytes)
#     int32_t format;          // offset 16
#     int32_t width;           // offset 20
#     int32_t height;          // offset 24
#     int32_t stride;          // offset 28
#     int32_t vstride;         // offset 32
#     int32_t is_contig;       // offset 36
#     int32_t share_id[3];     // offset 40  (12 bytes)
#     // 4 bytes padding for int64_t alignment
#     int64_t flags;           // offset 56  (8 bytes)
#     uint64_t size[3];        // offset 64  (24 bytes)
#     uint8_t *virt_addr[3];   // offset 88  (24 bytes, 8-byte pointers on aarch64)
#     uint64_t phys_addr[3];   // offset 112 (24 bytes)
#     uint64_t offset[3];      // offset 136 (24 bytes)
# } hb_mem_graphic_buf_t;     // total: 160 bytes
#
_GRAPH_BUF_LAYOUT = {
    "fd": 0,            # int32_t[3]
    "plane_cnt": 12,    # int32_t
    "share_id": 40,     # int32_t[3]
    "size": 64,         # uint64_t[3]
    "virt_addr": 88,    # uint8_t*[3] (uint64 on aarch64)
    "phys_addr": 112,   # uint64_t[3]
}


class HbMemGraphicBuffer:
    """
    Wrapper for hb_mem graphic buffer imported via hb_mem_import_graph_buf.

    Takes raw 160-byte hb_mem_graphic_buf_t from shared memory, imports it,
    and provides access to Y/UV plane data.
    """

    HB_MEM_GRAPHIC_BUF_SIZE = 160

    def __init__(self, raw_buf_data: bytes):
        """
        Import a graphic buffer using raw bytes from shared memory.

        Handles two VIO allocation modes:
        - Multi-buffer: each plane has its own share_id → use hb_mem_import_graph_buf
        - Contiguous: share_id[1]=0, single buffer for all planes → use hb_mem_import_com_buf

        Args:
            raw_buf_data: 160-byte raw hb_mem_graphic_buf_t from ZeroCopyFrame

        Raises:
            RuntimeError: If import fails
        """
        # Set _imported early so __del__ doesn't raise AttributeError on failure
        self._imported = False
        self._fd = [0, 0, 0]
        self._virt_addr = [0, 0, 0]
        self._size = [0, 0, 0]
        self._plane_cnt = 0
        self._com_buf = None  # Holds hb_mem_common_buf_t for contiguous fallback

        if len(raw_buf_data) != self.HB_MEM_GRAPHIC_BUF_SIZE:
            raise ValueError(
                f"Expected {self.HB_MEM_GRAPHIC_BUF_SIZE} bytes, got {len(raw_buf_data)}"
            )

        lib = _load_libhbmem()
        if lib is None:
            raise RuntimeError("hb_mem library not available")

        if not _module_initialized:
            raise RuntimeError(
                "hb_mem module not initialized - call init_module() first"
            )

        import struct as struct_mod
        L = _GRAPH_BUF_LAYOUT

        # Extract key fields from raw buffer for import logic
        share_ids = list(struct_mod.unpack_from("<3i", raw_buf_data, L["share_id"]))
        plane_cnt_in = struct_mod.unpack_from("<i", raw_buf_data, L["plane_cnt"])[0]
        sizes = list(struct_mod.unpack_from("<3Q", raw_buf_data, L["size"]))
        phys_addrs = list(struct_mod.unpack_from("<3Q", raw_buf_data, L["phys_addr"]))

        is_contiguous = (plane_cnt_in >= 2 and share_ids[1] == 0)

        if is_contiguous:
            # Contiguous NV12: single buffer, share_id[1]=0
            # Use hb_mem_import_com_buf with share_id[0] to import the whole buffer
            self._import_contiguous(lib, share_ids[0], sizes, phys_addrs, plane_cnt_in)
        else:
            # Multi-buffer: each plane has its own share_id
            # Use hb_mem_import_graph_buf with cleaned-up input
            self._import_graph_buf(lib, raw_buf_data, share_ids, plane_cnt_in)

    def _import_contiguous(
        self,
        lib: ctypes.CDLL,
        share_id: int,
        sizes: list[int],
        phys_addrs: list[int],
        plane_cnt: int,
    ) -> None:
        """Import contiguous NV12 buffer via hb_mem_import_com_buf."""
        import struct as struct_mod

        total_size = sum(sizes[:plane_cnt])

        # Build input common buffer (corrected layout: fd@0, share_id@4, flags@8, size@16, ...)
        in_buf = hb_mem_common_buf_t()
        in_buf.share_id = c_int32(share_id)
        in_buf.size = c_uint64(total_size)
        in_buf.phys_addr = c_uint64(phys_addrs[0])

        out_buf = hb_mem_common_buf_t()

        ret = lib.hb_mem_import_com_buf(byref(in_buf), byref(out_buf))
        if ret != 0:
            raise RuntimeError(
                f"hb_mem_import_com_buf failed: {ret} "
                f"(share_id={share_id}, size={total_size})"
            )

        self._imported = True
        self._com_buf = out_buf  # Keep reference for release
        self._plane_cnt = plane_cnt

        # Single fd for the contiguous buffer
        self._fd = [out_buf.fd, 0, 0]

        # Y plane starts at virt_addr, UV plane at virt_addr + size[0]
        base_vaddr = out_buf.virt_addr
        self._virt_addr = [base_vaddr, base_vaddr + sizes[0], 0]
        self._size = list(sizes[:3]) if len(sizes) >= 3 else sizes + [0] * (3 - len(sizes))

        logger.debug(
            f"Imported contiguous NV12 via com_buf: share_id={share_id}, fd={out_buf.fd}, "
            f"vaddr=0x{base_vaddr:x}, total_size={total_size}, "
            f"Y={sizes[0]}, UV={sizes[1]}"
        )

    def _import_graph_buf(
        self,
        lib: ctypes.CDLL,
        raw_buf_data: bytes,
        share_ids: list[int],
        plane_cnt: int,
    ) -> None:
        """Import multi-buffer graphic buffer via hb_mem_import_graph_buf."""
        import struct as struct_mod
        L = _GRAPH_BUF_LAYOUT

        # Create mutable input buffer from raw bytes
        in_buf = (ctypes.c_uint8 * self.HB_MEM_GRAPHIC_BUF_SIZE)(*raw_buf_data)

        # Clear process-local fields invalid in consumer process
        struct_mod.pack_into("<3i", in_buf, L["fd"], 0, 0, 0)
        struct_mod.pack_into("<3Q", in_buf, L["virt_addr"], 0, 0, 0)

        self._out_buf = (ctypes.c_uint8 * self.HB_MEM_GRAPHIC_BUF_SIZE)()

        ret = lib.hb_mem_import_graph_buf(
            ctypes.addressof(in_buf),
            ctypes.addressof(self._out_buf),
        )
        if ret != 0:
            raise RuntimeError(
                f"hb_mem_import_graph_buf failed: {ret} "
                f"(share_id={share_ids[:plane_cnt]}, plane_cnt={plane_cnt})"
            )

        self._imported = True

        # Extract fields from output buffer using verified layout
        out_bytes = bytes(self._out_buf)

        self._fd = list(struct_mod.unpack_from("<3i", out_bytes, L["fd"]))
        self._virt_addr = list(struct_mod.unpack_from("<3Q", out_bytes, L["virt_addr"]))
        self._size = list(struct_mod.unpack_from("<3Q", out_bytes, L["size"]))
        self._plane_cnt = struct_mod.unpack_from("<i", out_bytes, L["plane_cnt"])[0]

        logger.debug(
            f"Imported graph_buf: fd={self._fd[:self._plane_cnt]}, "
            f"vaddr=[0x{self._virt_addr[0]:x}, 0x{self._virt_addr[1]:x}], "
            f"size={self._size[:self._plane_cnt]}, planes={self._plane_cnt}"
        )

    def invalidate_cache(self, plane: int = -1) -> None:
        """
        Invalidate CPU cache for plane(s).

        Args:
            plane: Plane index (0=Y, 1=UV), or -1 for all planes
        """
        lib = _load_libhbmem()
        if lib is None or not self._imported:
            return

        if plane < 0:
            for i in range(self._plane_cnt):
                if self._virt_addr[i] and self._size[i]:
                    lib.hb_mem_invalidate_buf_with_vaddr(
                        c_uint64(self._virt_addr[i]),
                        c_uint64(self._size[i]),
                    )
        else:
            if self._virt_addr[plane] and self._size[plane]:
                lib.hb_mem_invalidate_buf_with_vaddr(
                    c_uint64(self._virt_addr[plane]),
                    c_uint64(self._size[plane]),
                )

    def get_plane_array(self, plane: int) -> np.ndarray:
        """
        Get a plane as a numpy array (zero-copy view).

        Args:
            plane: Plane index (0=Y, 1=UV)

        Returns:
            Numpy array view of the plane data
        """
        if not self._imported:
            raise RuntimeError("Buffer not imported or already released")
        if plane >= self._plane_cnt:
            raise ValueError(f"Plane {plane} out of range (plane_cnt={self._plane_cnt})")

        vaddr = self._virt_addr[plane]
        size = self._size[plane]
        if vaddr == 0 or size == 0:
            raise RuntimeError(f"Plane {plane} has no data (vaddr=0x{vaddr:x}, size={size})")

        ArrayType = ctypes.c_uint8 * size
        arr = ArrayType.from_address(vaddr)
        return np.ctypeslib.as_array(arr)

    def release(self) -> None:
        """
        Release the imported buffer.

        Calls hb_mem_free_buf(fd) for each unique fd.
        """
        if not self._imported:
            return

        lib = _load_libhbmem()
        if lib is not None:
            released_fds: set[int] = set()
            for i in range(self._plane_cnt):
                fd = self._fd[i]
                if fd > 0 and fd not in released_fds:
                    ret = lib.hb_mem_free_buf(c_int32(fd))
                    if ret != 0:
                        logger.warning(f"hb_mem_free_buf(fd={fd}) failed: {ret}")
                    released_fds.add(fd)

        self._imported = False
        self._com_buf = None
        logger.debug(f"Released buffer: fd={self._fd[:self._plane_cnt]}")

    def __del__(self):
        self.release()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
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

    For D-Robotics VIO, NV12 buffers may use:
    - Separate share_ids for Y and UV (share_id_uv != 0)
    - Single contiguous buffer with Y share_id only (share_id_uv == 0)

    Args:
        share_id_y: share_id for Y plane
        share_id_uv: share_id for UV plane (0 if contiguous with Y)
        y_size: Size of Y plane in bytes
        uv_size: Size of UV plane in bytes

    Returns:
        Tuple of (y_array, uv_array, buffers_to_release)
        The buffers_to_release list should be passed to release_buffers() when done.
    """
    buffers = []
    try:
        # Case 1: Separate share_ids for Y and UV
        if share_id_uv != 0 and share_id_uv != share_id_y:
            buf_y = HbMemBuffer.import_from_share_id(share_id_y, y_size)
            buffers.append(buf_y)

            buf_uv = HbMemBuffer.import_from_share_id(share_id_uv, uv_size)
            buffers.append(buf_uv)

            y_arr = buf_y.as_numpy()
            uv_arr = buf_uv.as_numpy()

            return y_arr, uv_arr, buffers

        # Case 2: Contiguous NV12 buffer (UV at offset y_size within same buffer)
        # VIO allocates NV12 as single contiguous buffer with share_id[1]=0
        else:
            buf = HbMemBuffer.import_from_share_id(share_id_y, y_size)
            buffers.append(buf)

            actual_size = buf.size
            total_needed = y_size + uv_size

            # Get Y plane
            full_arr = buf.as_numpy()
            y_arr = full_arr[:y_size]

            # Check if UV is in the same buffer (contiguous NV12)
            if actual_size >= total_needed:
                # UV is contiguous after Y
                uv_arr = full_arr[y_size:y_size + uv_size]
            else:
                # UV is not in this buffer - fall back to memcpy path
                for b in buffers:
                    b.release()
                raise RuntimeError(f"UV plane not accessible via zero-copy (share_id[1]=0, Y buffer too small)")

            return y_arr, uv_arr, buffers

    except Exception:
        # Clean up on error
        for buf in buffers:
            buf.release()
        raise


def import_nv12_graph_buf(
    raw_buf_data: bytes,
    expected_plane_sizes: list[int],
) -> tuple[np.ndarray, np.ndarray, "HbMemGraphicBuffer"]:
    """
    Import NV12 graphic buffer using raw hb_mem_graphic_buf_t bytes.

    This is the preferred API for zero-copy import. Uses hb_mem_import_graph_buf
    which handles NV12 graphic buffers properly (vs hb_mem_import_com_buf for
    common buffers).

    Args:
        raw_buf_data: 160-byte raw hb_mem_graphic_buf_t from ZeroCopyFrame.hb_mem_buf_data
        expected_plane_sizes: Expected sizes [y_size, uv_size] for validation

    Returns:
        Tuple of (y_array, uv_array, buffer_handle)
        Caller must call buffer_handle.release() when done.
    """
    buf = HbMemGraphicBuffer(raw_buf_data)
    try:
        # Invalidate cache before reading
        buf.invalidate_cache()

        y_arr = buf.get_plane_array(0)
        uv_arr = buf.get_plane_array(1)

        # Validate sizes match expected
        if expected_plane_sizes:
            if len(y_arr) != expected_plane_sizes[0]:
                logger.warning(
                    f"Y plane size mismatch: got {len(y_arr)}, expected {expected_plane_sizes[0]}"
                )
            if len(expected_plane_sizes) > 1 and len(uv_arr) != expected_plane_sizes[1]:
                logger.warning(
                    f"UV plane size mismatch: got {len(uv_arr)}, expected {expected_plane_sizes[1]}"
                )

        return y_arr, uv_arr, buf
    except Exception:
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
