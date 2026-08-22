"""Golden byte-string tests for DetectionWriter's SHM write path.

Purpose
-------
`src/detector/yolo_detector_daemon.py::_run_night_iteration()` (639 lines) is
about to be split into smaller functions. The only thing that must not change
is the **exact bytes** `DetectionWriter.write_detection_result()` puts into
`/pet_camera_detections`. Python (writer) -> Go (cgo reader) -> protobuf ->
SSE/WebRTC is a straight pass-through of that C struct, so freezing the raw
byte string here is sufficient to catch any regression the split could
introduce; a 4-language E2E test is not needed for that purpose.

These tests never touch the production SHM name (`/pet_camera_detections`).
They open a dedicated test-only POSIX shared memory object
(`/pet_camera_detections_golden_test`) and `os.unlink` it (the Python
equivalent of `shm_unlink`) in a `finally` block after every test, even on
failure — the box this file runs on has a real capture/detector/streaming
stack running against the production SHM name and must not be disturbed.

Struct under test (see src/capture/shared_memory.h and the matching ctypes
mirror in src/capture/real_shared_memory.py):

    typedef struct {
        uint64_t frame_number;                    // offset   0, size 8
        double   timestamp;                        // offset   8, size 8
        int      num_detections;                   // offset  16, size 4
        DetectionEntry detections[MAX_DETECTIONS];  // offset  20, size 520 (52 * 10)
        volatile uint32_t version;                 // offset 540, size 4
        sem_t    detection_update_sem;              // offset 544, size 32
    } LatestDetectionResult;                        // total: 576 bytes

    typedef struct { char class_name[32]; float confidence; DetectionBBox bbox; } DetectionEntry;  // 52 bytes
    typedef struct { int x, y, w, h; } DetectionBBox;  // 16 bytes

Volatile-field normalization
----------------------------
Two byte ranges are zeroed out of the comparison before hex-diffing against
the frozen golden value (see `_normalize()` below), with the exact byte
ranges taken from the ctypes field descriptors rather than hardcoded, so a
struct-layout change would break loudly instead of silently:

  * `timestamp` (offset 8, 8 bytes) — write_detection_result() takes the
    caller-supplied `timestamp_sec` verbatim (`c_det.timestamp = timestamp_sec`),
    so in this test it is *not* actually execution-dependent (we pass a fixed
    constant). It is still normalized out per the task's requirement, as a
    defensive measure against a future change that starts stamping wall-clock
    time internally. The exact byte value is still asserted separately
    (round-tripped via `struct.pack("<d", ...)`) so this doesn't weaken the
    test, it just decouples the frozen-bytes comparison from this field.

  * `detection_update_sem` (offset 544, 32 bytes) — this is a `sem_t`, which
    is libc/kernel-internal state, not something write_detection_result()
    populates. Empirically (see the `test_*_sem_region_is_always_zeroed`
    assertions below) it is **always all-zero** after a write, because
    `c_det = CLatestDetectionResult()` zero-initializes the whole 576-byte
    struct in Python before individual fields are assigned, and the sem
    field is never subsequently touched — so `write_detection_result()`
    unconditionally clobbers whatever was in that region with zero bytes.
    This is asserted explicitly as a real, observed behavior (see report),
    not assumed; it is still normalized out of the main hex comparison
    per the task's instructions, in case that zero-initialization detail
    ever changes.

`version` handling
------------------
`DetectionWriter.last_detection_version` starts at 0 in `__init__` and is
incremented (`+= 1`) before every write. Each test below opens a **fresh**
`DetectionWriter` (via the `golden_writer` fixture, which also creates a
fresh, freshly `ftruncate`-zeroed backing file) and calls
`write_detection_result()` exactly once. Under that fixed test protocol the
resulting `version` is deterministically `1` — it is not volatile in this
test's context, so it is *not* zeroed out; it is frozen at `1` in the golden
bytes and also asserted explicitly by name for clarity.

All golden hex strings below were captured by actually running
`DetectionWriter.write_detection_result()` against the fixed inputs and
reading back the mapped memory — none of them are hand-computed.
"""
from __future__ import annotations

import ctypes
import os
import struct
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

# Belt-and-suspenders path setup: conftest.py already inserts these, but
# test_detection_filtering.py established the precedent of also doing it
# locally so this file works if run directly.
for _rel in ("src/capture", "src/common/src"):
    _p = str(REPO_ROOT / _rel)
    if _p not in sys.path:
        sys.path.insert(0, _p)

import real_shared_memory as rsm  # noqa: E402

# ---------------------------------------------------------------------------
# Safety: this must NEVER be the production detection SHM name.
# ---------------------------------------------------------------------------
GOLDEN_SHM_NAME = "/pet_camera_detections_golden_test"
assert GOLDEN_SHM_NAME != rsm.SHM_NAME_DETECTIONS, (
    "golden test must not share a name with the production detection SHM"
)

TS = 1732000000.123456  # fixed, arbitrary timestamp used by every test case

# Byte ranges normalized out of the frozen-hex comparison (see module
# docstring). Derived from the ctypes field descriptors, not hardcoded, so
# a struct layout change fails loudly instead of silently mis-comparing.
_TS_OFF = rsm.CLatestDetectionResult.timestamp.offset
_TS_SIZE = rsm.CLatestDetectionResult.timestamp.size
_SEM_OFF = rsm.CLatestDetectionResult.detection_update_sem.offset
_SEM_SIZE = rsm.CLatestDetectionResult.detection_update_sem.size


def _mk(class_name: str, confidence: float, x: int, y: int, w: int, h: int) -> dict:
    return {
        "class_name": class_name,
        "confidence": confidence,
        "bbox": {"x": x, "y": y, "w": w, "h": h},
    }


def _read_raw(writer: "rsm.DetectionWriter") -> bytes:
    """Read back the exact bytes currently sitting in the mapped SHM region."""
    writer.detection_mmap.seek(0)
    return writer.detection_mmap.read(ctypes.sizeof(rsm.CLatestDetectionResult))


def _normalize(raw: bytes) -> bytes:
    """Zero the timestamp and detection_update_sem byte ranges (see module
    docstring for why each is excluded from the frozen-bytes comparison)."""
    buf = bytearray(raw)
    buf[_TS_OFF : _TS_OFF + _TS_SIZE] = b"\x00" * _TS_SIZE
    buf[_SEM_OFF : _SEM_OFF + _SEM_SIZE] = b"\x00" * _SEM_SIZE
    return bytes(buf)


@pytest.fixture
def golden_writer():
    """A DetectionWriter bound to a dedicated test-only SHM name.

    Always unlinks the backing /dev/shm file on teardown (success or
    failure) so no state leaks between tests or onto the real machine.
    """
    shm_path = f"/dev/shm{GOLDEN_SHM_NAME}"
    writer = rsm.DetectionWriter(detection_shm_name=GOLDEN_SHM_NAME)
    try:
        writer.open()
        yield writer
    finally:
        writer.close()
        try:
            os.unlink(shm_path)
        except FileNotFoundError:
            pass


def _assert_golden(raw: bytes, expected_normalized_hex: str, *, timestamp_sec: float) -> None:
    assert len(raw) == ctypes.sizeof(rsm.CLatestDetectionResult) == 576

    normalized = _normalize(raw)
    assert normalized.hex() == expected_normalized_hex

    # The two normalized-out ranges are still checked for their actual,
    # real observed values (see module docstring):
    assert raw[_TS_OFF : _TS_OFF + _TS_SIZE] == struct.pack("<d", timestamp_sec)
    assert raw[_SEM_OFF : _SEM_OFF + _SEM_SIZE] == b"\x00" * _SEM_SIZE

    # version: deterministic (=1) for a fresh writer + single write; frozen
    # directly in expected_normalized_hex, reasserted here for clarity.
    result = rsm.CLatestDetectionResult.from_buffer_copy(raw)
    assert result.version == 1


# ---------------------------------------------------------------------------
# Case: 0 detections
# ---------------------------------------------------------------------------

def test_zero_detections(golden_writer):
    golden_writer.write_detection_result(1001, TS, [])
    raw = _read_raw(golden_writer)

    expected_normalized_hex = (
        "e90300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000"
    )
    _assert_golden(raw, expected_normalized_hex, timestamp_sec=TS)

    result = rsm.CLatestDetectionResult.from_buffer_copy(raw)
    assert result.frame_number == 1001
    assert result.num_detections == 0


# ---------------------------------------------------------------------------
# Case: 1 detection
# ---------------------------------------------------------------------------

def test_one_detection(golden_writer):
    golden_writer.write_detection_result(
        1002, TS, [_mk("dog", 0.87, 100, 200, 50, 60)]
    )
    raw = _read_raw(golden_writer)

    expected_normalized_hex = (
        "ea03000000000000000000000000000001000000646f67000000000000000000000000000000000000000000000000000000000052b85e3f64000000c8000000320000003c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000"
    )
    _assert_golden(raw, expected_normalized_hex, timestamp_sec=TS)

    result = rsm.CLatestDetectionResult.from_buffer_copy(raw)
    assert result.frame_number == 1002
    assert result.num_detections == 1
    det = result.detections[0]
    assert bytes(det.class_name).rstrip(b"\x00") == b"dog"
    assert det.confidence == pytest.approx(0.87, abs=1e-6)
    assert (det.bbox.x, det.bbox.y, det.bbox.w, det.bbox.h) == (100, 200, 50, 60)


# ---------------------------------------------------------------------------
# Case: exactly MAX_DETECTIONS (10)
# ---------------------------------------------------------------------------

def test_exactly_max_detections(golden_writer):
    dets = [
        _mk(f"cls{i}", 0.1 * i, i, i * 2, 10 + i, 20 + i) for i in range(rsm.MAX_DETECTIONS)
    ]
    assert len(dets) == 10 == rsm.MAX_DETECTIONS

    golden_writer.write_detection_result(1003, TS, dets)
    raw = _read_raw(golden_writer)

    expected_normalized_hex = (
        "eb0300000000000000000000000000000a000000636c7330000000000000000000000000000000000000000000000000000000000000000000000000000000000a00000014000000636c733100000000000000000000000000000000000000000000000000000000cdcccc3d01000000020000000b00000015000000636c733200000000000000000000000000000000000000000000000000000000cdcc4c3e02000000040000000c00000016000000636c7333000000000000000000000000000000000000000000000000000000009a99993e03000000060000000d00000017000000636c733400000000000000000000000000000000000000000000000000000000cdcccc3e04000000080000000e00000018000000636c7335000000000000000000000000000000000000000000000000000000000000003f050000000a0000000f00000019000000636c7336000000000000000000000000000000000000000000000000000000009a99193f060000000c000000100000001a000000636c7337000000000000000000000000000000000000000000000000000000003333333f070000000e000000110000001b000000636c733800000000000000000000000000000000000000000000000000000000cdcc4c3f0800000010000000120000001c000000636c7339000000000000000000000000000000000000000000000000000000006666663f0900000012000000130000001d000000010000000000000000000000000000000000000000000000000000000000000000000000"
    )
    _assert_golden(raw, expected_normalized_hex, timestamp_sec=TS)

    result = rsm.CLatestDetectionResult.from_buffer_copy(raw)
    assert result.num_detections == 10
    for i in range(10):
        det = result.detections[i]
        assert bytes(det.class_name).rstrip(b"\x00") == f"cls{i}".encode()


# ---------------------------------------------------------------------------
# Case: MAX_DETECTIONS + 5 (15) -> observed to be silently truncated to 10
# ---------------------------------------------------------------------------

def test_over_max_detections_is_truncated(golden_writer):
    """DetectionWriter.write_detection_result() computes
    `num_detections = min(len(detections), MAX_DETECTIONS)` and iterates
    `detections[:MAX_DETECTIONS]`, so extra entries beyond index 9 are
    silently dropped (no error, no warning). This test fixes that observed
    behavior: 15 detections in -> only the first 10 make it into SHM, byte
    for byte identical to the exactly-10 case above (frame_number differs)."""
    dets = [
        _mk(f"cls{i}", 0.1 * i, i, i * 2, 10 + i, 20 + i) for i in range(rsm.MAX_DETECTIONS + 5)
    ]
    assert len(dets) == 15

    golden_writer.write_detection_result(1004, TS, dets)
    raw = _read_raw(golden_writer)

    # Same detection payload bytes as test_exactly_max_detections (only the
    # first 10 are ever written), just a different frame_number (1004 vs 1003).
    expected_normalized_hex = (
        "ec0300000000000000000000000000000a000000636c7330000000000000000000000000000000000000000000000000000000000000000000000000000000000a00000014000000636c733100000000000000000000000000000000000000000000000000000000cdcccc3d01000000020000000b00000015000000636c733200000000000000000000000000000000000000000000000000000000cdcc4c3e02000000040000000c00000016000000636c7333000000000000000000000000000000000000000000000000000000009a99993e03000000060000000d00000017000000636c733400000000000000000000000000000000000000000000000000000000cdcccc3e04000000080000000e00000018000000636c7335000000000000000000000000000000000000000000000000000000000000003f050000000a0000000f00000019000000636c7336000000000000000000000000000000000000000000000000000000009a99193f060000000c000000100000001a000000636c7337000000000000000000000000000000000000000000000000000000003333333f070000000e000000110000001b000000636c733800000000000000000000000000000000000000000000000000000000cdcc4c3f0800000010000000120000001c000000636c7339000000000000000000000000000000000000000000000000000000006666663f0900000012000000130000001d000000010000000000000000000000000000000000000000000000000000000000000000000000"
    )
    _assert_golden(raw, expected_normalized_hex, timestamp_sec=TS)

    result = rsm.CLatestDetectionResult.from_buffer_copy(raw)
    assert result.frame_number == 1004
    assert result.num_detections == 10  # NOT 15 — truncated, matches MAX_DETECTIONS


# ---------------------------------------------------------------------------
# Case: class_name too long for char[32] (plain ASCII)
# ---------------------------------------------------------------------------

def test_long_ascii_class_name_truncated_and_nul_terminated(golden_writer):
    """write_detection_result() does
    `name_bytes = det["class_name"].encode("utf-8")[:31]` then memmoves that
    into a fresh zero-initialized 32-byte buffer, so: (a) it always keeps at
    most 31 payload bytes, (b) byte index 31 is always 0x00 regardless of
    input length, because it comes from the struct's zero-init, not an
    explicit NUL write. This fixes that behavior for a 50-char ASCII name."""
    long_name = "A" * 50
    golden_writer.write_detection_result(1005, TS, [_mk(long_name, 0.5, 1, 2, 3, 4)])
    raw = _read_raw(golden_writer)

    expected_normalized_hex = (
        "ed0300000000000000000000000000000100000041414141414141414141414141414141414141414141414141414141414141000000003f01000000020000000300000004000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000"
    )
    _assert_golden(raw, expected_normalized_hex, timestamp_sec=TS)

    result = rsm.CLatestDetectionResult.from_buffer_copy(raw)
    name_bytes = bytes(result.detections[0].class_name)
    assert name_bytes[:31] == b"A" * 31  # only first 31 of 50 'A's survive
    assert name_bytes[31] == 0  # last byte is always NUL (from zero-init, not truncation logic)


# ---------------------------------------------------------------------------
# Case: multi-byte class_name where the 31-byte cut lands mid-character
# ---------------------------------------------------------------------------

def test_multibyte_class_name_cut_mid_character(golden_writer):
    """`.encode("utf-8")[:31]` is a *byte* slice, not a *character* slice, so
    it can cut a multi-byte UTF-8 sequence in half. Input here is 30 ASCII
    'B' bytes + U+72AC ("dog", 3 bytes: e7 8a ac) + 'X' (34 bytes total
    encoded); the byte-31 cut keeps only the first byte of the 3-byte
    sequence (0xe7), producing an invalid trailing UTF-8 fragment in SHM.
    This is fixed here as observed real behavior, not asserted as desirable.
    """
    name = "B" * 30 + "犬" + "X"
    encoded = name.encode("utf-8")
    assert len(encoded) == 34  # sanity: confirms the cut lands mid-character
    assert encoded[:31] == b"B" * 30 + b"\xe7"  # only the lead byte of the 3-byte char survives

    golden_writer.write_detection_result(1006, TS, [_mk(name, 0.5, 1, 2, 3, 4)])
    raw = _read_raw(golden_writer)

    expected_normalized_hex = (
        "ee03000000000000000000000000000001000000424242424242424242424242424242424242424242424242424242424242e7000000003f01000000020000000300000004000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000"
    )
    _assert_golden(raw, expected_normalized_hex, timestamp_sec=TS)

    result = rsm.CLatestDetectionResult.from_buffer_copy(raw)
    name_bytes = bytes(result.detections[0].class_name)
    assert name_bytes[:31] == b"B" * 30 + b"\xe7"
    assert name_bytes[31] == 0
    with pytest.raises(UnicodeDecodeError):
        name_bytes.rstrip(b"\x00").decode("utf-8")  # confirms the stored bytes are not valid UTF-8


# ---------------------------------------------------------------------------
# Case: extreme confidence / bbox values
# ---------------------------------------------------------------------------

def test_extreme_values(golden_writer):
    """Fixes observed behavior for out-of-range inputs, none of which raise:

    * confidence 0.0 and a negative confidence (-5.5) are stored as-is
      (float32 has no notion of a valid confidence range; nothing validates
      it here).
    * confidence 3.4028235e38 (just under float32 max) round-trips as a
      large finite float32.
    * confidence 1e300 overflows float32 and becomes +inf (0x7f800000).
    * bbox x/y = 999_999_999_999 / -999_999_999_999 overflow c_int (32-bit)
      and silently wrap via modulo-2**32 arithmetic to -727379969 /
      727379969 respectively — ctypes does NOT raise OverflowError/
      ArgumentError for this, it wraps silently.
    """
    dets = [
        _mk("zero_conf", 0.0, 0, 0, 0, 0),
        _mk("neg_conf", -5.5, -100, -200, -1, -1),
        _mk("near_f32_max", 3.4028235e38, 2147483647, -2147483648, 0, 0),
        _mk("overflow_conf", 1e300, 999999999999, -999999999999, 123, 456),
    ]
    golden_writer.write_detection_result(1007, TS, dets)
    raw = _read_raw(golden_writer)

    expected_normalized_hex = (
        "ef030000000000000000000000000000040000007a65726f5f636f6e66000000000000000000000000000000000000000000000000000000000000000000000000000000000000006e65675f636f6e660000000000000000000000000000000000000000000000000000b0c09cffffff38ffffffffffffffffffffff6e6561725f6633325f6d61780000000000000000000000000000000000000000ffff7f7fffffff7f0000008000000000000000006f766572666c6f775f636f6e66000000000000000000000000000000000000000000807fff0fa5d401f05a2b7b000000c8010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000"
    )
    _assert_golden(raw, expected_normalized_hex, timestamp_sec=TS)

    result = rsm.CLatestDetectionResult.from_buffer_copy(raw)
    d0, d1, d2, d3 = result.detections[:4]

    assert d0.confidence == 0.0
    assert (d0.bbox.x, d0.bbox.y, d0.bbox.w, d0.bbox.h) == (0, 0, 0, 0)

    assert d1.confidence == pytest.approx(-5.5)
    assert (d1.bbox.x, d1.bbox.y, d1.bbox.w, d1.bbox.h) == (-100, -200, -1, -1)

    assert d2.confidence == pytest.approx(3.4028234663852886e38)  # float32 round-trip of 3.4028235e38
    assert (d2.bbox.x, d2.bbox.y) == (2147483647, -2147483648)  # int32 min/max, exact fit, no wraparound

    import math
    assert math.isinf(d3.confidence) and d3.confidence > 0  # 1e300 overflows float32 -> +inf
    assert (d3.bbox.x, d3.bbox.y) == (-727379969, 727379969)  # 999999999999 wrapped mod 2**32 (no exception)


# ---------------------------------------------------------------------------
# Sanity: struct size assumption the whole file depends on
# ---------------------------------------------------------------------------

def test_struct_size_is_576_bytes():
    """Guards the assumption baked into every golden hex string above. If
    this ever fails, shared_memory.h's LatestDetectionResult layout changed
    and every golden constant in this file needs to be regenerated."""
    assert ctypes.sizeof(rsm.CLatestDetectionResult) == 576
    assert ctypes.sizeof(rsm.CDetection) == 52
    assert ctypes.sizeof(rsm.CBoundingBox) == 16
