"""Tests for the detection SHM update semaphore.

`DetectionWriter` used to rewrite the whole `LatestDetectionResult` struct on
every call, including the trailing `detection_update_sem`, and never posted it.
The Go web_monitor blocks on that semaphore
(`internal/webmonitor/shm.go: sem_timedwait`), so:

  * the wait never woke early — every update cost a full 100 ms timeout before
    the reader fell back to comparing `version`, and
  * the bytes of a live semaphore were overwritten ~30 times a second.

These tests pin the fixed protocol: the payload is written, the semaphore bytes
are left alone, and one post is issued per write — matching what the C writer
does in `shm_detection_write` (`src/capture/shared_memory.c`).

All tests use a dedicated SHM name and never touch the production segment.
"""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
for _relative in ("src/capture", "src/common/src"):
    _path = str(PROJECT_ROOT / _relative)
    if _path not in sys.path:
        sys.path.insert(0, _path)

import real_shared_memory as rsm  # noqa: E402

TEST_SHM_NAME = "/pet_camera_detections_sem_test"
TEST_SHM_PATH = f"/dev/shm{TEST_SHM_NAME}"


def _detection(class_name: str = "cat", confidence: float = 0.9) -> dict:
    return {
        "class_name": class_name,
        "confidence": confidence,
        "bbox": {"x": 1, "y": 2, "w": 3, "h": 4},
    }


@pytest.fixture
def writer():
    """A DetectionWriter bound to a throwaway segment, always cleaned up."""
    assert TEST_SHM_NAME != rsm.SHM_NAME_DETECTIONS, "must not touch production SHM"
    if os.path.exists(TEST_SHM_PATH):
        os.unlink(TEST_SHM_PATH)

    w = rsm.DetectionWriter(detection_shm_name=TEST_SHM_NAME)
    w.open()
    try:
        yield w
    finally:
        w.close()
        if os.path.exists(TEST_SHM_PATH):
            os.unlink(TEST_SHM_PATH)


def _sem_addr(w: rsm.DetectionWriter) -> int:
    assert w._sem_view is not None
    return ctypes.addressof(w._sem_view)


def _trywait(w: rsm.DetectionWriter) -> int:
    """0 when a post was consumed, -1 when the semaphore was already at zero."""
    return rsm.librt.sem_trywait(_sem_addr(w))


@pytest.mark.skipif(rsm.librt is None, reason="librt/libpthread unavailable")
def test_write_posts_the_semaphore(writer):
    """A single write must make exactly one wakeup available to readers."""
    assert _trywait(writer) == -1, "semaphore should start at zero"

    writer.write_detection_result(1, 100.0, [_detection()])

    assert _trywait(writer) == 0, "write did not post the semaphore"
    assert _trywait(writer) == -1, "write posted more than once"


@pytest.mark.skipif(rsm.librt is None, reason="librt/libpthread unavailable")
def test_posts_accumulate_across_writes(writer):
    """Counts must add up — this is what the old full-struct rewrite destroyed."""
    for i in range(3):
        writer.write_detection_result(i, 100.0 + i, [_detection()])

    assert _trywait(writer) == 0
    assert _trywait(writer) == 0
    assert _trywait(writer) == 0
    assert _trywait(writer) == -1, "more posts consumed than writes issued"


@pytest.mark.skipif(rsm.librt is None, reason="librt/libpthread unavailable")
def test_empty_detection_list_still_posts(writer):
    """'Detector alive, nothing seen' is an update the reader must observe."""
    writer.write_detection_result(7, 1.0, [])
    assert _trywait(writer) == 0


@pytest.mark.skipif(rsm.librt is None, reason="librt/libpthread unavailable")
def test_write_preserves_pending_posts(writer):
    """Wakeups the reader has not consumed yet must survive a write.

    This is the property the old full-struct rewrite destroyed: it zeroed the
    semaphore's counter on every write, discarding any pending posts.

    Note the semaphore is only ever driven through sem_post/sem_trywait here.
    Poking arbitrary bytes into a live sem_t and then posting it makes glibc
    abort the process, so "did the bytes change" is not a safe way to ask this
    question — "did the counts survive" is.
    """
    rsm.librt.sem_post(_sem_addr(writer))
    rsm.librt.sem_post(_sem_addr(writer))

    writer.write_detection_result(1, 100.0, [_detection()])

    # Two that were pending, plus the one this write issued.
    assert _trywait(writer) == 0
    assert _trywait(writer) == 0
    assert _trywait(writer) == 0, "the write discarded pending posts"
    assert _trywait(writer) == -1


def test_payload_boundary_matches_struct_layout():
    """Guard the constant that decides how many bytes get written."""
    assert (
        rsm._DETECTION_PAYLOAD_SIZE
        == rsm.CLatestDetectionResult.detection_update_sem.offset
    )
    assert rsm._DETECTION_PAYLOAD_SIZE + rsm._DETECTION_SEM_SIZE == ctypes.sizeof(
        rsm.CLatestDetectionResult
    )
    # version is the last payload field; it must fall inside what we write.
    version_field = rsm.CLatestDetectionResult.version
    assert version_field.offset + version_field.size <= rsm._DETECTION_PAYLOAD_SIZE


@pytest.mark.skipif(rsm.librt is None, reason="librt/libpthread unavailable")
def test_payload_is_still_written_correctly(writer):
    """Posting must not come at the cost of the data the reader is woken for."""
    writer.write_detection_result(42, 123.5, [_detection("dog", 0.75)])

    snapshot = rsm.CLatestDetectionResult.from_buffer_copy(
        writer.detection_mmap[: ctypes.sizeof(rsm.CLatestDetectionResult)]
    )
    assert snapshot.frame_number == 42
    assert snapshot.timestamp == pytest.approx(123.5)
    assert snapshot.num_detections == 1
    assert snapshot.version == 1
    stored_name = bytes(snapshot.detections[0].class_name).split(b"\x00")[0]
    assert stored_name == b"dog"
    assert snapshot.detections[0].confidence == pytest.approx(0.75)
    assert snapshot.detections[0].bbox.x == 1
