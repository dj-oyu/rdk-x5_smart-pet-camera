from __future__ import annotations

import time

import pytest

pytest.importorskip("numpy")

from capture.real_shared_memory import RealSharedMemory
from web_monitor import WebMonitor, create_app


def _wait_until(predicate, timeout: float = 5.0) -> None:
    start = time.time()
    while time.time() - start < timeout:
        if predicate():
            return
        time.sleep(0.05)
    raise TimeoutError("Condition not met within timeout")


@pytest.fixture
def real_shm() -> RealSharedMemory:
    shm = RealSharedMemory()
    try:
        shm.open()
    except RuntimeError as exc:
        pytest.skip(f"Real shared memory unavailable: {exc}")
    yield shm
    shm.close()


@pytest.fixture
def monitor(real_shm: RealSharedMemory) -> WebMonitor:
    monitor = WebMonitor(real_shm, fps=5, jpeg_quality=50)
    monitor.start()
    yield monitor
    monitor.stop()


def test_status_endpoint_reads_real_shared_memory(
    real_shm: RealSharedMemory, monitor: WebMonitor
) -> None:
    try:
        _wait_until(lambda: monitor.stats["frames_processed"] > 0)
    except TimeoutError:
        pytest.skip("No frames observed from RealSharedMemory (is the capture daemon running?)")

    app = create_app(real_shm, monitor)
    client = app.test_client()
    response = client.get("/api/status")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload is not None

    assert payload["monitor"]["frames_processed"] > 0
    assert payload["shared_memory"]["total_frames_written"] >= payload["monitor"]["frames_processed"]
    assert payload["shared_memory"]["frame_count"] >= 1


def test_stream_endpoint_serves_mjpeg(real_shm: RealSharedMemory, monitor: WebMonitor) -> None:
    try:
        _wait_until(lambda: monitor.frame_queue.qsize() > 0)
    except TimeoutError:
        pytest.skip("MJPEG queue did not fill from RealSharedMemory (is the capture daemon running?)")

    app = create_app(real_shm, monitor)
    client = app.test_client()
    response = client.get("/stream", buffered=False)

    first_chunk = next(response.response)
    assert b"--frame" in first_chunk
    assert b"Content-Type: image/jpeg" in first_chunk
