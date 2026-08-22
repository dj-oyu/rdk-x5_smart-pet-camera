"""Tests for the night-camera base (empty scene) reference image.

`src/detector/base_image.py` was lifted out of
`YoloDetectorDaemon._run_night_iteration`. It is a state machine — warm up,
snapshot, blend when stable, drop on a brightness shift — and every one of those
rules used to be reachable only by running the daemon on hardware for minutes at
a time. Here the rules are driven directly, with small frames and short
thresholds.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]
_DETECTOR = str(PROJECT_ROOT / "src" / "detector")
if _DETECTOR not in sys.path:
    sys.path.insert(0, _DETECTOR)

from base_image import BaseImageTracker  # noqa: E402

SIZE = 32
ROI = "roi0"


def frame(value: int = 60) -> np.ndarray:
    return np.full((SIZE, SIZE), value, dtype=np.uint8)


def make(**overrides) -> BaseImageTracker:
    """A tracker with small thresholds so tests stay readable."""
    kwargs = dict(
        init_frames=3,
        quiet_threshold=5,
        noise_floor=15,
        snapshot_interval=4,
        snapshot_blend_alpha=0.5,
    )
    kwargs.update(overrides)
    return BaseImageTracker(**kwargs)


def warm_up(tracker: BaseImageTracker, img: np.ndarray, quiet: int = 999) -> None:
    """Drive the tracker until the ROI has a valid base."""
    for _ in range(tracker.init_frames):
        tracker.update(ROI, img, base_quiet_frames=quiet)


class RecordingLogger:
    def __init__(self) -> None:
        self.messages: list[str] = []

    def info(self, msg: str) -> None:
        self.messages.append(msg)


# -------------------------------------------------------------------- warm-up


def test_no_base_before_warm_up():
    tracker = make()
    assert not tracker.is_valid(ROI)
    assert tracker.base_u8(ROI) is None
    assert tracker.valid_keys() == []


def test_warm_up_requires_a_quiet_scene():
    """A scene with motion must never be adopted as the empty-scene reference."""
    tracker = make()
    for _ in range(50):
        tracker.update(ROI, frame(), base_quiet_frames=tracker.quiet_threshold - 1)
    assert not tracker.is_valid(ROI), "base was built while the scene was not quiet"


def test_base_becomes_valid_after_init_frames():
    tracker = make()
    img = frame(80)

    for i in range(tracker.init_frames - 1):
        tracker.update(ROI, img, base_quiet_frames=999)
        assert not tracker.is_valid(ROI), f"valid too early after {i + 1} frames"

    tracker.update(ROI, img, base_quiet_frames=999)
    assert tracker.is_valid(ROI)
    assert tracker.valid_keys() == [ROI]

    base = tracker.base_u8(ROI)
    assert base is not None
    assert base.shape == img.shape
    assert abs(int(base.mean()) - 80) <= 1


def test_rois_warm_up_independently():
    tracker = make()
    warm_up(tracker, frame())
    assert tracker.is_valid("roi0")
    assert not tracker.is_valid("roi1")


def test_ready_message_is_logged_once():
    log = RecordingLogger()
    tracker = make(logger=log)
    warm_up(tracker, frame())
    for _ in range(5):
        tracker.update(ROI, frame(), base_quiet_frames=999)
    assert log.messages.count(f"Base image ready for {ROI}") == 1


# ------------------------------------------------------------------- blending


def test_stable_scene_blends_toward_the_new_snapshot():
    """A lasting change to the scene should eventually be absorbed.

    The change has to outlive a snapshot refresh: the base only follows what is
    still there when the next snapshot is taken.
    """
    tracker = make(snapshot_interval=4, snapshot_blend_alpha=0.5)
    warm_up(tracker, frame(60))
    before = float(tracker.base_u8(ROI).mean())

    moved = frame(90)
    for _ in range(30):
        tracker.update(ROI, moved, base_quiet_frames=999)

    after = float(tracker.base_u8(ROI).mean())
    assert after > before, "base did not follow a stable scene change"
    assert abs(after - 90) < abs(before - 90)


def test_moving_object_is_not_absorbed_into_the_base():
    """The pet standing in frame must not become part of 'the empty scene'.

    What protects the base is that the snapshot is *stale*: the live frame is
    compared against a snapshot taken up to `snapshot_interval` frames ago, so
    anything that moved in between shows up as instability and blocks the blend.

    That dependency is worth stating explicitly, because it is not obvious from
    the code: with `snapshot_interval=1` the snapshot is refreshed from the very
    frame it is then compared against, every frame trivially looks "stable", and
    a moving object *is* absorbed. The production interval is 300 frames (~10s).
    """
    tracker = make(snapshot_interval=100, snapshot_blend_alpha=0.5)
    still = frame(60)
    warm_up(tracker, still)
    before = tracker.base_u8(ROI).copy()

    # Something bright keeps moving around, well within one snapshot interval.
    for i in range(20):
        busy = still.copy()
        x = (i * 5) % (SIZE - 8)
        busy[x : x + 8, x : x + 8] = 250
        tracker.update(ROI, busy, base_quiet_frames=999)

    after = tracker.base_u8(ROI)
    assert np.array_equal(before, after), "a moving object leaked into the base"


def test_snapshot_refresh_is_what_lets_change_in():
    """Guard the coupling the previous test relies on.

    Below one snapshot interval nothing can be absorbed, however stable the
    scene looks — the snapshot still shows the old scene.
    """
    tracker = make(snapshot_interval=50, snapshot_blend_alpha=0.5)
    warm_up(tracker, frame(60))
    before = tracker.base_u8(ROI).copy()

    moved = frame(90)
    for _ in range(10):  # fewer frames than one snapshot interval
        tracker.update(ROI, moved, base_quiet_frames=999)

    assert np.array_equal(before, tracker.base_u8(ROI)), (
        "base changed before the snapshot was refreshed"
    )


# --------------------------------------------------------------- invalidation


def test_large_brightness_shift_drops_every_base():
    tracker = make()
    warm_up(tracker, frame())
    tracker.note_brightness(60.0)
    assert tracker.is_valid(ROI)

    assert tracker.note_brightness(60.0 + tracker.brightness_reset_delta + 1) is True
    assert not tracker.is_valid(ROI)
    assert tracker.base_u8(ROI) is None


def test_small_brightness_drift_keeps_the_base():
    tracker = make()
    warm_up(tracker, frame())
    tracker.note_brightness(60.0)

    assert tracker.note_brightness(60.0 + tracker.brightness_reset_delta) is False
    assert tracker.is_valid(ROI), "base dropped on a shift at the threshold"


def test_first_brightness_reading_never_resets():
    """There is nothing to compare the very first frame against."""
    tracker = make()
    warm_up(tracker, frame())
    assert tracker.note_brightness(255.0) is False
    assert tracker.is_valid(ROI)


def test_reset_clears_everything_including_brightness_history():
    tracker = make()
    warm_up(tracker, frame())
    tracker.note_brightness(60.0)

    tracker.reset()
    assert tracker.valid_keys() == []
    assert tracker.base_u8(ROI) is None
    # A reset forgets the last brightness, so the next reading cannot trip a
    # reset on its own.
    assert tracker.note_brightness(255.0) is False
