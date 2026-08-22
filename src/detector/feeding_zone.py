"""Visit tracking for the feeding zone.

The bowl sits in ROI 0. Whenever that region differs enough from the empty-scene
base image, something is there — a pet eating, usually. This turns that
per-frame ratio into two things:

  * **Visits.** Start and end timestamps, written to an event log, which is the
    product-facing record of when the pet ate.
  * **Training frames.** While a visit is in progress, frames are collected for
    the bowl-detection dataset.

It deliberately performs no I/O. `update()` returns what should happen and the
caller does it, so the state machine — including the cases that are awkward to
reach on real hardware, like a visit that never ends — is testable without a
camera, a disk, or a clock.

**Why visits must be capped.** A visit that runs for hours is not a pet; it means
the base image has stopped describing the empty scene (something arrived and
stayed). While that lasts, every frame reads as motion, the caller's quiet
counter never advances, and the base can never rebuild — so the stale base
sustains the very motion that keeps it stale. Observed in the event log before
this cap existed: single "visits" of 15 and 20 hours, which between them produced
most of a 5 GB/day collection rate. Cutting the visit and rebuilding the base
breaks the loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class FeedingEvent:
    """One completed visit to the feeding zone."""

    start: float
    end: float

    truncated: bool = False
    """True when the visit was cut off by `max_event_sec` rather than by the
    zone going quiet — i.e. this is a stale base image, not a real visit."""

    @property
    def duration_sec(self) -> float:
        return self.end - self.start

    def to_record(self) -> dict:
        """The shape appended to the event log, rounded for a compact line."""
        record = {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "duration_sec": round(self.duration_sec, 2),
        }
        if self.truncated:
            record["truncated"] = True
        return record


@dataclass(frozen=True)
class FeedingDecision:
    """What the caller should do with this frame."""

    started: bool = False
    """A visit began on this frame — worth logging."""

    save_frame: bool = False
    """Collect this frame into the training set."""

    finished: Optional[FeedingEvent] = None
    """A visit ended; append it to the event log."""

    rebuild_base: bool = False
    """The base image for this zone is stale and must be dropped."""


class FeedingZoneTracker:
    """Turns per-frame difference ratios into visits and collection decisions."""

    def __init__(
        self,
        *,
        motion_thresh: float,
        quiet_gap: int,
        save_interval: int,
        max_event_sec: float,
    ) -> None:
        self.motion_thresh = motion_thresh
        """Difference ratio above which the zone counts as occupied."""

        self.quiet_gap = quiet_gap
        """Consecutive quiet frames needed to close a visit. Absorbs the brief
        stillness of a pet that pauses mid-meal, which would otherwise split one
        visit into several."""

        self.save_interval = save_interval
        """Collect one frame per this many occupied frames."""

        self.max_event_sec = max_event_sec
        """Cap on visit length; see the module docstring for why."""

        self._in_visit = False
        self._started_at: Optional[float] = None
        self._quiet_count = 0
        self._save_counter = 0

    @property
    def in_visit(self) -> bool:
        return self._in_visit

    @property
    def started_at(self) -> Optional[float]:
        return self._started_at

    def update(self, nz_ratio: float, now: float) -> FeedingDecision:
        """Feed in one frame's difference ratio and the current wall clock."""
        occupied = nz_ratio > self.motion_thresh

        if occupied and self._in_visit and self._elapsed(now) > self.max_event_sec:
            # Not a meal — the base image has gone stale. End the visit and tell
            # the caller to rebuild, so the zone can read as empty again.
            return FeedingDecision(
                finished=self._close(now, truncated=True), rebuild_base=True
            )

        if occupied:
            return self._on_occupied(now)
        return self._on_quiet(now)

    def _on_occupied(self, now: float) -> FeedingDecision:
        self._quiet_count = 0
        self._save_counter += 1

        started = False
        if not self._in_visit:
            self._in_visit = True
            self._started_at = now
            started = True

        save = self._save_counter >= self.save_interval
        if save:
            self._save_counter = 0

        return FeedingDecision(started=started, save_frame=save)

    def _on_quiet(self, now: float) -> FeedingDecision:
        if not self._in_visit:
            return FeedingDecision()

        self._quiet_count += 1
        if self._quiet_count < self.quiet_gap:
            return FeedingDecision()
        return FeedingDecision(finished=self._close(now))

    def _elapsed(self, now: float) -> float:
        return now - (self._started_at if self._started_at is not None else now)

    def _close(self, now: float, truncated: bool = False) -> FeedingEvent:
        event = FeedingEvent(
            start=self._started_at if self._started_at is not None else now,
            end=now,
            truncated=truncated,
        )
        self._in_visit = False
        self._started_at = None
        self._quiet_count = 0
        self._save_counter = 0
        return event

    def reset(self) -> None:
        """Forget any visit in progress, without emitting an event."""
        self._in_visit = False
        self._started_at = None
        self._quiet_count = 0
        self._save_counter = 0
