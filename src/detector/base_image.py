"""Per-ROI reference image of the empty scene, for the night camera.

Motion is judged against a "base image": what this ROI looks like with nothing
in it. Keeping that image current is its own problem — the scene legitimately
changes (a bowl gets moved, the IR illumination drifts), and the base has to
follow those changes without absorbing the pet standing in the frame.

The rules, which this class exists to make testable:

  * **Warm-up.** A base is only built while the scene has been quiet for
    `quiet_threshold` frames, and only becomes usable after `init_frames`
    contributions. Until then the ROI reports no valid base at all.
  * **Snapshots.** Once valid, a snapshot of the current frame is taken every
    `snapshot_interval` frames.
  * **Blending.** A snapshot is folded into the base only if the scene has since
    stayed close to it (`stability_ratio` of pixels differ at most). A snapshot
    taken while something was moving is therefore never absorbed.
  * **Brightness resets.** A large ISP brightness shift makes every base
    meaningless, so all of them are dropped.

This class owns only the base-image state. Scene-quiet counters stay with the
caller, which uses them for idle tiering as well; they are passed in.

No shared memory, no camera, no BPU — numpy and cv2 only.
"""

from __future__ import annotations

from typing import Optional, Protocol

import cv2
import numpy as np


class _Logger(Protocol):
    def info(self, msg: str) -> None: ...


class BaseImageTracker:
    """Maintains one reference image per ROI key."""

    def __init__(
        self,
        *,
        init_frames: int,
        quiet_threshold: int,
        noise_floor: int,
        snapshot_interval: int,
        snapshot_blend_alpha: float,
        warmup_alpha: float = 0.02,
        stability_ratio: float = 0.005,
        brightness_reset_delta: float = 20.0,
        logger: Optional[_Logger] = None,
    ) -> None:
        self.init_frames = init_frames
        self.quiet_threshold = quiet_threshold
        self.noise_floor = noise_floor
        self.snapshot_interval = snapshot_interval
        self.snapshot_blend_alpha = snapshot_blend_alpha
        self.warmup_alpha = warmup_alpha
        self.stability_ratio = stability_ratio
        self.brightness_reset_delta = brightness_reset_delta
        self._logger = logger

        # float32 accumulators — cv2.accumulateWeighted needs the extra range.
        self._base: dict[str, np.ndarray] = {}
        self._snapshot: dict[str, np.ndarray] = {}
        self._valid: dict[str, bool] = {}
        self._init_count: dict[str, int] = {}
        self._snapshot_timer: int = 0
        self._last_brightness: float = -1.0

    # ------------------------------------------------------------------ query

    def is_valid(self, rkey: str) -> bool:
        """Whether this ROI has a base image worth comparing against."""
        return self._valid.get(rkey, False)

    def valid_keys(self) -> list[str]:
        """ROI keys with a usable base, for status lines."""
        return [k for k, v in self._valid.items() if v]

    def base_u8(self, rkey: str) -> Optional[np.ndarray]:
        """The base image as uint8, or None when this ROI has no valid base."""
        if not self.is_valid(rkey) or rkey not in self._base:
            return None
        return cv2.convertScaleAbs(self._base[rkey])

    # ----------------------------------------------------------------- update

    def update(self, rkey: str, y_denoised: np.ndarray, *, base_quiet_frames: int) -> None:
        """Feed this ROI's denoised luma plane in.

        `base_quiet_frames` is the caller's count of consecutive frames without
        sensor motion; warm-up only progresses once it clears `quiet_threshold`.
        """
        y_f32 = y_denoised.astype(np.float32)

        if not self.is_valid(rkey):
            self._warm_up(rkey, y_denoised, y_f32, base_quiet_frames)
        else:
            self._refresh_snapshot(rkey, y_f32)
            self._blend_stable_snapshot(rkey, y_denoised)

    def _warm_up(
        self, rkey: str, y_denoised: np.ndarray, y_f32: np.ndarray, base_quiet_frames: int
    ) -> None:
        if base_quiet_frames < self.quiet_threshold:
            return

        if rkey not in self._base:
            self._base[rkey] = y_f32.copy()
            self._init_count[rkey] = 1
        else:
            cv2.accumulateWeighted(y_denoised, self._base[rkey], self.warmup_alpha)
            self._init_count[rkey] = self._init_count.get(rkey, 0) + 1

        if self._init_count.get(rkey, 0) >= self.init_frames:
            self._valid[rkey] = True
            self._snapshot[rkey] = y_f32.copy()
            self._snapshot_timer = 0
            if self._logger is not None:
                self._logger.info(f"Base image ready for {rkey}")

    def _refresh_snapshot(self, rkey: str, y_f32: np.ndarray) -> None:
        self._snapshot_timer += 1
        if self._snapshot_timer >= self.snapshot_interval:
            self._snapshot[rkey] = y_f32.copy()
            self._snapshot_timer = 0

    def _blend_stable_snapshot(self, rkey: str, y_denoised: np.ndarray) -> None:
        """Absorb the snapshot into the base, but only if the scene settled.

        A snapshot captured while the pet was in frame would poison the base, so
        it is only blended once the live frame agrees with it.
        """
        if rkey not in self._snapshot:
            return

        snap_u8 = cv2.convertScaleAbs(self._snapshot[rkey])
        snap_diff = cv2.absdiff(y_denoised, snap_u8)
        snap_diff = cv2.GaussianBlur(snap_diff, (5, 5), 0)
        snap_diff[snap_diff < self.noise_floor] = 0
        snap_stable = cv2.countNonZero(snap_diff) / snap_diff.size

        if snap_stable < self.stability_ratio:
            cv2.accumulateWeighted(snap_u8, self._base[rkey], self.snapshot_blend_alpha)

    # ------------------------------------------------------------ invalidation

    def note_brightness(self, brightness: float) -> bool:
        """Record the frame brightness; drop every base on a large ISP shift.

        Returns True when a reset happened, so the caller can clear the scene
        counters it owns.
        """
        reset = (
            self._last_brightness >= 0
            and abs(brightness - self._last_brightness) > self.brightness_reset_delta
        )
        if reset:
            self._base.clear()
            self._valid.clear()
            self._init_count.clear()
            self._snapshot.clear()
            self._snapshot_timer = 0
            if self._logger is not None:
                self._logger.info("Base images cleared (brightness change)")
        self._last_brightness = brightness
        return reset

    def invalidate(self, rkey: str) -> None:
        """Drop one ROI's base so it is rebuilt from scratch.

        Used when the base has demonstrably stopped describing the empty scene:
        something arrived and stayed, so every frame differs from the base
        forever. Warm-up needs a quiet scene, and the caller's quiet counter only
        advances once nothing is reported as moving — so the stale base sustains
        the very motion that prevents its replacement. Dropping it breaks that
        loop: with no base there is no base-diff motion, the scene reads quiet,
        and a new base including the new object is built.
        """
        self._base.pop(rkey, None)
        self._snapshot.pop(rkey, None)
        self._valid.pop(rkey, None)
        self._init_count.pop(rkey, None)
        if self._logger is not None:
            self._logger.info(f"Base image invalidated for {rkey}")

    def reset(self) -> None:
        """Drop everything — used when the active camera changes."""
        self._base.clear()
        self._valid.clear()
        self._init_count.clear()
        self._snapshot.clear()
        self._snapshot_timer = 0
        self._last_brightness = -1.0
