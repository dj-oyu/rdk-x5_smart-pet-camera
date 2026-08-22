"""Tests for feeding-zone visit tracking.

`src/detector/feeding_zone.py` was lifted out of
`YoloDetectorDaemon._run_night_iteration`. Most of what it decides was previously
unreachable in a test: the cap on runaway visits, in particular, only fires after
ten minutes of continuous motion on a live camera.

The tracker performs no I/O and takes the clock as an argument, so every rule
here is driven directly.
"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
_DETECTOR = str(PROJECT_ROOT / "src" / "detector")
if _DETECTOR not in sys.path:
    sys.path.insert(0, _DETECTOR)

from feeding_zone import FeedingZoneTracker  # noqa: E402

THRESH = 0.008
BUSY = THRESH + 0.01  # comfortably occupied
IDLE = THRESH - 0.001  # comfortably empty


def make(**overrides) -> FeedingZoneTracker:
    """A tracker with small thresholds so tests stay readable."""
    kwargs = dict(
        motion_thresh=THRESH,
        quiet_gap=3,
        save_interval=4,
        max_event_sec=600.0,
    )
    kwargs.update(overrides)
    return FeedingZoneTracker(**kwargs)


def run(tracker, ratios, *, start=1000.0, step=1.0):
    """Feed a sequence of ratios one frame apart; return the decisions."""
    return [
        tracker.update(ratio, start + i * step) for i, ratio in enumerate(ratios)
    ]


# --------------------------------------------------------------- visit shape


def test_empty_zone_produces_nothing():
    tracker = make()
    decisions = run(tracker, [IDLE] * 10)
    assert not tracker.in_visit
    assert all(
        not d.started and not d.save_frame and d.finished is None for d in decisions
    )


def test_visit_starts_once_and_ends_after_the_quiet_gap():
    tracker = make(quiet_gap=3)
    decisions = run(tracker, [BUSY, BUSY, BUSY, IDLE, IDLE, IDLE])

    assert [i for i, d in enumerate(decisions) if d.started] == [0]
    finished = [d.finished for d in decisions if d.finished is not None]
    assert len(finished) == 1
    assert finished[0].duration_sec == 5.0  # frames 0..5, one second apart
    assert not finished[0].truncated
    assert not tracker.in_visit


def test_brief_stillness_does_not_split_a_visit():
    """A pet that pauses mid-meal is still one visit."""
    tracker = make(quiet_gap=3)
    decisions = run(tracker, [BUSY, IDLE, IDLE, BUSY, BUSY, IDLE, IDLE, IDLE])

    assert sum(1 for d in decisions if d.started) == 1
    finished = [d.finished for d in decisions if d.finished is not None]
    assert len(finished) == 1, "the pause split one visit into several"


def test_quiet_gap_boundary():
    """quiet_gap frames close the visit; one fewer does not."""
    tracker = make(quiet_gap=3)
    decisions = run(tracker, [BUSY, IDLE, IDLE])
    assert all(d.finished is None for d in decisions)
    assert tracker.in_visit

    last = tracker.update(IDLE, 2000.0)
    assert last.finished is not None


def test_threshold_is_strict():
    """A ratio exactly at the threshold is not occupancy."""
    tracker = make()
    assert not tracker.update(THRESH, 1000.0).started
    assert not tracker.in_visit
    assert tracker.update(THRESH + 1e-9, 1001.0).started


# -------------------------------------------------------------- frame saving


def test_frames_are_collected_at_the_interval():
    tracker = make(save_interval=4)
    decisions = run(tracker, [BUSY] * 12)
    saved = [i for i, d in enumerate(decisions) if d.save_frame]
    assert saved == [3, 7, 11]


def test_save_counter_restarts_with_each_visit():
    """A visit must not inherit progress toward a save from the previous one."""
    tracker = make(save_interval=4, quiet_gap=1)
    run(tracker, [BUSY, BUSY, BUSY])  # 3 occupied frames, no save yet
    tracker.update(IDLE, 2000.0)  # visit ends
    assert not tracker.in_visit

    decisions = run(tracker, [BUSY] * 4, start=3000.0)
    saved = [i for i, d in enumerate(decisions) if d.save_frame]
    assert saved == [3], "the new visit inherited the old save counter"


def test_quiet_frames_do_not_advance_collection():
    tracker = make(save_interval=4, quiet_gap=10)
    decisions = run(tracker, [BUSY, IDLE, IDLE, IDLE, BUSY, BUSY, BUSY])
    saved = [i for i, d in enumerate(decisions) if d.save_frame]
    assert saved == [6], "quiet frames counted toward the save interval"


# ------------------------------------------------------------ runaway visits


def test_runaway_visit_is_truncated_and_asks_for_a_rebuild():
    """The case this cap exists for: a visit that never goes quiet.

    Before the cap, the event log held single "visits" of 15 and 20 hours. A
    stale base image reads as motion on every frame, which stops the base ever
    being rebuilt, which keeps it stale.
    """
    tracker = make(max_event_sec=600.0)
    tracker.update(BUSY, 1000.0)

    # Still occupied, but only halfway to the cap.
    mid = tracker.update(BUSY, 1000.0 + 300.0)
    assert mid.finished is None
    assert not mid.rebuild_base

    over = tracker.update(BUSY, 1000.0 + 600.1)
    assert over.finished is not None
    assert over.finished.truncated is True
    assert over.rebuild_base is True
    assert not tracker.in_visit


def test_cap_boundary_is_not_hit_early():
    tracker = make(max_event_sec=600.0)
    tracker.update(BUSY, 1000.0)
    exactly = tracker.update(BUSY, 1600.0)  # elapsed == cap
    assert exactly.finished is None, "truncated at exactly the cap"


def test_a_truncated_visit_does_not_leak_into_the_next():
    tracker = make(max_event_sec=600.0, save_interval=4)
    tracker.update(BUSY, 1000.0)
    tracker.update(BUSY, 1700.0)  # truncated here
    assert not tracker.in_visit

    started = tracker.update(BUSY, 1701.0)
    assert started.started is True
    assert started.finished is None
    assert tracker.started_at == 1701.0


def test_truncation_only_applies_inside_a_visit():
    """A long-idle tracker must not emit a truncation on first occupancy."""
    tracker = make(max_event_sec=600.0)
    first = tracker.update(BUSY, 99999.0)
    assert first.started is True
    assert first.finished is None
    assert not first.rebuild_base


# ------------------------------------------------------------------- records


def test_event_record_shape():
    tracker = make(quiet_gap=1)
    tracker.update(BUSY, 1000.0)
    event = tracker.update(IDLE, 1012.3456).finished
    assert event is not None

    record = event.to_record()
    assert record == {"start": 1000.0, "end": 1012.346, "duration_sec": 12.35}
    assert "truncated" not in record, "normal visits must not carry the flag"


def test_truncated_record_is_marked():
    tracker = make(max_event_sec=10.0)
    tracker.update(BUSY, 1000.0)
    event = tracker.update(BUSY, 1011.0).finished
    assert event is not None
    assert event.to_record()["truncated"] is True


def test_reset_drops_a_visit_without_emitting_an_event():
    tracker = make()
    tracker.update(BUSY, 1000.0)
    assert tracker.in_visit

    tracker.reset()
    assert not tracker.in_visit
    assert tracker.started_at is None
    # The next occupied frame opens a fresh visit rather than closing the old.
    assert tracker.update(BUSY, 1001.0).started is True
