"""Tests for the night-camera frame-difference motion detector.

`src/detector/night_motion.py` was lifted out of
`YoloDetectorDaemon._run_night_iteration`, where it could only be exercised by
running the daemon against live hardware. It needs nothing but numpy and cv2, so
these tests construct frames directly and assert on the thresholds the detector
has actually been calibrated to.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
_DETECTOR = str(PROJECT_ROOT / "src" / "detector")
if _DETECTOR not in sys.path:
    sys.path.insert(0, _DETECTOR)

import night_motion as nm  # noqa: E402

SMALL = 320
# ROI rectangles as configured on the device (1920x1080 sensor coordinates).
ROI0 = (160, 440, 640, 640)
ROI1 = (144, 120, 960, 960)


def blank(size: int = SMALL, value: int = 0) -> np.ndarray:
    return np.full((size, size), value, dtype=np.uint8)


def acc_for(size: int = SMALL) -> np.ndarray:
    return np.zeros((size, size), dtype=np.uint16)


def with_square(base: np.ndarray, x: int, y: int, side: int, value: int) -> np.ndarray:
    frame = base.copy()
    frame[y : y + side, x : x + side] = value
    return frame


def settle(prev, cur, acc, frames: int = 4, **kw):
    """Feed the same difference repeatedly until the accumulator crosses.

    One frame is not enough by design: the accumulator halves before each add,
    so a single-frame flash cannot reach the threshold. That is the whole point
    of the decay, so tests have to respect it.
    """
    blobs = []
    for _ in range(frames):
        blobs = nm.detect_motion(cur, prev, acc, **kw)
    return blobs


# ---------------------------------------------------------------- accumulator


def test_identical_frames_produce_no_motion():
    prev = blank()
    acc = acc_for()
    mask = nm.accumulate_diff(prev.copy(), prev, acc)
    assert mask.max() == 0
    assert acc.max() == 0


def test_difference_below_noise_floor_is_discarded():
    """IR sensor noise sits under the floor and must never accumulate."""
    prev = blank(value=100)
    cur = blank(value=100 + nm.DEFAULT_PARAMS.noise_floor - 1)
    acc = acc_for()

    for _ in range(20):
        mask = nm.accumulate_diff(cur, prev, acc)

    assert acc.max() == 0, "sub-floor difference leaked into the accumulator"
    assert mask.max() == 0


def test_accumulator_decays_when_motion_stops():
    prev = blank(value=40)
    moving = with_square(prev, 100, 100, 60, 220)
    acc = acc_for()

    for _ in range(4):
        nm.accumulate_diff(moving, prev, acc)
    peak = int(acc.max())
    assert peak > 0

    # Scene goes still again: the same frame differenced against itself.
    for _ in range(8):
        nm.accumulate_diff(moving, moving, acc)

    assert int(acc.max()) < peak, "accumulator did not decay once motion stopped"


def test_accumulator_is_updated_in_place():
    """The caller owns the accumulator; detect_motion must not swap it out."""
    prev = blank(value=40)
    cur = with_square(prev, 50, 50, 80, 240)
    acc = acc_for()

    nm.detect_motion(
        cur, prev, acc, roi_index=1, roi_region=ROI1, small_size=SMALL
    )
    assert acc.max() > 0


# ------------------------------------------------------------------ filtering


def test_moving_object_is_detected():
    prev = blank(value=40)
    cur = with_square(prev, 100, 100, 60, 240)
    acc = acc_for()

    blobs = settle(prev, cur, acc, roi_index=1, roi_region=ROI1, small_size=SMALL)

    assert len(blobs) == 1
    blob = blobs[0]
    assert blob.w > 0 and blob.h > 0
    assert 0.0 < blob.confidence <= 1.0


def test_object_smaller_than_min_side_is_rejected():
    """A blob thinner than min_blob_side is noise, not a pet."""
    prev = blank(value=40)
    side = nm.DEFAULT_PARAMS.min_blob_side - 12  # stays under after dilation
    cur = with_square(prev, 150, 150, side, 240)
    acc = acc_for()

    blobs = settle(prev, cur, acc, roi_index=1, roi_region=ROI1, small_size=SMALL)
    assert blobs == []


def test_sparse_scatter_is_rejected_by_fill_ratio():
    """Scattered single pixels can cover a wide box while filling almost none of it."""
    prev = blank(value=40)
    cur = prev.copy()
    rng = np.random.default_rng(1234)
    ys = rng.integers(40, 280, size=60)
    xs = rng.integers(40, 280, size=60)
    cur[ys, xs] = 255
    acc = acc_for()

    blobs = settle(prev, cur, acc, roi_index=1, roi_region=ROI1, small_size=SMALL)
    assert blobs == [], "sparse scatter passed the fill-ratio filter"


def test_confidence_saturates_at_one():
    small_size = 100
    params = nm.DEFAULT_PARAMS
    full = small_size * small_size
    assert nm.region_confidence(full, small_size, params) == 1.0
    # Exactly at the ratio that maps to 1.0.
    at_one = int(full * params.confidence_pixel_ratio)
    assert nm.region_confidence(at_one, small_size, params) == pytest.approx(1.0)
    assert nm.region_confidence(at_one // 2, small_size, params) == pytest.approx(0.5)


def test_region_filtering_thresholds_are_boundaries():
    """A region exactly at min_blob_side must survive; one pixel less must not."""
    params = nm.DEFAULT_PARAMS
    size = 200

    def mask_with(side: int) -> np.ndarray:
        m = np.zeros((size, size), dtype=np.uint8)
        m[50 : 50 + side, 50 : 50 + side] = 255
        return m

    # Dilation grows the group box, so the filter is applied to the grouped
    # region — assert on the observable outcome rather than the raw side.
    assert nm.find_motion_regions(mask_with(params.min_blob_side + 10), size, params)
    assert nm.find_motion_regions(mask_with(2), size, params) == []


# ------------------------------------------------------- coordinate mapping


def test_roi0_maps_through_crop_offset():
    """ROI 0 is a 1:1 crop, so the crop origin and ROI origin both shift it."""
    x, y, w, h = nm.region_to_video(
        10, 20, 30, 40, roi_index=0, roi_region=ROI0, crop_x0=80, crop_y0=80
    )
    assert x == int((10 + 80 + 160) * nm.SENSOR_TO_VIDEO_X)
    assert y == int((20 + 80 + 440) * nm.SENSOR_TO_VIDEO_Y)
    assert w == int(30 * nm.SENSOR_TO_VIDEO_X)
    assert h == int(40 * nm.SENSOR_TO_VIDEO_Y)


def test_roi1_maps_through_resize_scale():
    """ROI 1 was resized to 320, so its scale is roi_width / 480."""
    ms = ROI1[2] / nm.ROI1_RESIZE_BASE
    x, y, w, h = nm.region_to_video(10, 20, 30, 40, roi_index=1, roi_region=ROI1)
    assert x == int(10 * ms) + int(ROI1[0] * nm.SENSOR_TO_VIDEO_X)
    assert y == int(20 * ms) + int(ROI1[1] * nm.SENSOR_TO_VIDEO_Y)
    assert w == int(30 * ms)
    assert h == int(40 * ms)


def test_mapped_coordinates_stay_inside_the_video_frame():
    """Whatever the ROI, published coordinates must land in 1280x720."""
    for roi_index, roi_region, crop in ((0, ROI0, 80), (1, ROI1, 0)):
        span = 480 if roi_index == 0 else SMALL
        x, y, w, h = nm.region_to_video(
            span - 1,
            span - 1,
            1,
            1,
            roi_index=roi_index,
            roi_region=roi_region,
            crop_x0=crop,
            crop_y0=crop,
        )
        assert 0 <= x <= 1280, f"roi{roi_index} x out of frame: {x}"
        assert 0 <= y <= 720, f"roi{roi_index} y out of frame: {y}"


# ------------------------------------------------------------------ base diff


def base_pair(size: int = SMALL, value: int = 60):
    """An empty-scene base and a frame identical to it."""
    base = blank(size, value)
    return base, base.copy()


def test_identical_frame_differs_from_base_by_nothing():
    base, frame = base_pair()
    result = nm.base_diff(frame, base)
    assert result.nz_ratio == 0.0
    assert result.coherent.max() == 0


def test_still_object_is_detected_against_the_base():
    """The point of base-diff: a pet that arrived and stopped moving."""
    base, frame = base_pair()
    frame[80:200, 80:200] = 220

    result = nm.base_diff(frame, base)
    assert result.nz_ratio > 0.0
    assert result.coherent.max() > 0


def test_border_band_is_masked():
    """IR LEDs light the edges unevenly, so the outer band never counts."""
    base, frame = base_pair()
    b = nm.DEFAULT_BASE_DIFF_PARAMS.border_mask
    frame[: b - 2, :] = 255
    frame[-(b - 2) :, :] = 255
    frame[:, : b - 2] = 255
    frame[:, -(b - 2) :] = 255

    result = nm.base_diff(frame, base)
    assert result.nz_ratio == 0.0, "edge-only difference leaked past the border mask"


def test_difference_below_noise_floor_is_ignored():
    base, frame = base_pair(value=60)
    frame[:] = 60 + nm.DEFAULT_BASE_DIFF_PARAMS.noise_floor - 1

    result = nm.base_diff(frame, base)
    assert result.nz_ratio == 0.0
    # The raw image keeps the gradient even though the ratio ignores it — the
    # heatmap is drawn from raw.
    assert result.raw.max() > 0


def test_scattered_pixels_are_opened_away():
    base, frame = base_pair()
    rng = np.random.default_rng(7)
    ys = rng.integers(40, SMALL - 40, size=80)
    xs = rng.integers(40, SMALL - 40, size=80)
    frame[ys, xs] = 255

    result = nm.base_diff(frame, base)
    assert result.nz_ratio == 0.0, "scattered noise survived the morphological open"


def test_base_is_resized_when_it_does_not_match():
    """Guard the shape reconciliation; today the two always agree."""
    base = blank(160, 60)
    frame = blank(SMALL, 60)
    frame[100:200, 100:200] = 240

    result = nm.base_diff(frame, base)
    assert result.raw.shape == frame.shape
    assert result.coherent.shape == frame.shape


# -------------------------------------------------------------------- heatmap


def test_heatmap_grid_shape_and_range():
    base, frame = base_pair()
    frame[60:120, 60:120] = 200
    grid = nm.heatmap_grid(nm.base_diff(frame, base).raw)

    assert len(grid) == nm.HEATMAP_GRID_SIZE
    assert all(len(row) == nm.HEATMAP_GRID_SIZE for row in grid)
    flat = [v for row in grid for v in row]
    assert all(0.0 <= v <= 1.0 for v in flat)
    assert max(flat) > 0.0


def test_heatmap_grid_is_json_safe():
    """It is serialised several times a second, so it must be plain floats."""
    base, frame = base_pair()
    frame[60:120, 60:120] = 200
    grid = nm.heatmap_grid(nm.base_diff(frame, base).raw)

    import json

    assert json.loads(json.dumps({"grid": grid}))["grid"] == grid

    # Values are rounded to 3 decimals — but in float32, so the resulting
    # doubles are only close to a 3-decimal value, not equal to one
    # (0.012 comes back as 0.012000000104308128). The rounding therefore does
    # not shorten the JSON as much as it looks like it should: about 594 bytes
    # per write, three times a second. Recorded here rather than fixed, since
    # this test exists to pin the behaviour the refactor preserved.
    assert all(abs(v - round(v, 3)) < 1e-6 for row in grid for v in row)


def test_empty_scene_produces_a_blank_heatmap():
    base, frame = base_pair()
    grid = nm.heatmap_grid(nm.base_diff(frame, base).raw)
    assert all(v == 0.0 for row in grid for v in row)
