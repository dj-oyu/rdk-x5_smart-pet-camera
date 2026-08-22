"""Frame-difference motion detection for the night camera ROIs.

Pure computation: numpy arrays in, motion regions out. No shared memory, no
camera handles, no BPU, no daemon state — which is the point. This logic used
to live inline inside `YoloDetectorDaemon._run_night_iteration`, where the only
way to exercise it was to run the whole daemon against live hardware.

The pipeline, in order:

  1. `accumulate_diff` — absolute difference against the previous frame, blurred,
     floored at the IR noise level, then folded into a decaying accumulator so a
     single noisy frame cannot trip the detector but sustained movement can.
  2. `find_motion_regions` — dilate to join the fragments a real object leaves
     along its silhouette edges, then reject anything too small, too sparse, or
     too thin to be a pet.
  3. `region_to_video` — map mask coordinates into the 1280x720 video space that
     detections are published in.

`detect_motion` runs all three. The caller owns the accumulator and the previous
frame; this module never keeps state between calls.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# VSE ROI rectangles are expressed in 1920x1080 sensor coordinates, while
# detections are published in the 1280x720 video space.
SENSOR_TO_VIDEO_X = 1280.0 / 1920.0
SENSOR_TO_VIDEO_Y = 720.0 / 1080.0

# ROI 1 is resized to 320x320 before differencing; its scale back to sensor
# coordinates is roi_width / ROI1_RESIZE_BASE.
ROI1_RESIZE_BASE = 480.0


@dataclass(frozen=True)
class MotionParams:
    """Tuning constants for the night motion detector.

    The defaults are the values this detector has been running with. They were
    chosen against the night camera's IR noise, so treat them as calibration
    rather than arbitrary knobs.
    """

    noise_floor: int = 15
    """Per-pixel difference below this is discarded (3σ of IR sensor noise)."""

    accum_threshold: int = 50
    """Accumulator level that counts as motion."""

    min_blob_side: int = 20
    """Reject grouped regions narrower or shorter than this, in mask pixels."""

    min_orig_pixel_ratio: float = 0.001
    """Reject regions whose pre-dilation pixel count is below this share of the mask."""

    min_fill_ratio: float = 0.08
    """Reject regions that are mostly empty: sparse scatter noise fills little of
    its bounding box, a real object fills much of it."""

    confidence_pixel_ratio: float = 0.05
    """Pixel share that maps to confidence 1.0."""

    blur_kernel: tuple[int, int] = (5, 5)
    open_kernel: tuple[int, int] = (5, 5)
    group_kernel: tuple[int, int] = (9, 9)


DEFAULT_PARAMS = MotionParams()


@dataclass(frozen=True)
class MotionBlob:
    """One detected motion region, in 1280x720 video coordinates."""

    x: int
    y: int
    w: int
    h: int
    confidence: float


def accumulate_diff(
    y_small: np.ndarray,
    prev_small: np.ndarray,
    acc: np.ndarray,
    params: MotionParams = DEFAULT_PARAMS,
) -> np.ndarray:
    """Fold this frame's difference into `acc` and return the motion mask.

    `acc` is modified in place: halved (a decay, so old motion fades over a few
    frames) and then increased by the current difference. The caller owns it and
    must keep one per ROI — sharing one across ROIs would mix their histories.

    Returns a binary uint8 mask the size of `y_small`.
    """
    diff = cv2.absdiff(y_small, prev_small)
    diff = cv2.GaussianBlur(diff, params.blur_kernel, 0)
    diff[diff < params.noise_floor] = 0

    acc >>= 1
    acc += diff.astype(np.uint16)

    acc_u8 = cv2.convertScaleAbs(acc)
    _, thresh = cv2.threshold(acc_u8, params.accum_threshold, 255, cv2.THRESH_BINARY)

    # MORPH_OPEN: remove isolated scatter noise
    open_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, params.open_kernel)
    return cv2.morphologyEx(thresh, cv2.MORPH_OPEN, open_kernel)


def find_motion_regions(
    thresh: np.ndarray,
    small_size: int,
    params: MotionParams = DEFAULT_PARAMS,
) -> list[tuple[int, int, int, int, int]]:
    """Group the mask into candidate regions and filter out noise.

    Returns `(x, y, w, h, original_pixel_count)` tuples in mask coordinates. The
    bounding box is that of the *pre-dilation* pixels, so grouping does not
    inflate the reported size.
    """
    # Group nearby blobs: connect edge-clustered fragments
    # (real objects show diff along their silhouette edges)
    group_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, params.group_kernel)
    thresh_grouped = cv2.dilate(thresh, group_kernel)
    contours, _ = cv2.findContours(
        thresh_grouped, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )

    small_pixels = small_size * small_size
    min_orig_pixels = small_pixels * params.min_orig_pixel_ratio

    regions: list[tuple[int, int, int, int, int]] = []
    for cnt in contours:
        gx, gy, gw, gh = cv2.boundingRect(cnt)
        if gw < params.min_blob_side or gh < params.min_blob_side:
            continue

        # Count original (pre-dilation) pixels in group bbox
        orig_pixels = cv2.countNonZero(thresh[gy : gy + gh, gx : gx + gw])
        if orig_pixels < min_orig_pixels:
            continue

        # Fill ratio: sparse noise → low fill; real object → high fill
        fill_ratio = orig_pixels / (gw * gh)
        if fill_ratio < params.min_fill_ratio:
            continue

        # Use tight bbox of original pixels for accurate coords
        orig_pts = cv2.findNonZero(thresh[gy : gy + gh, gx : gx + gw])
        if orig_pts is None:
            continue
        ox, oy, ow, oh = cv2.boundingRect(orig_pts)
        regions.append((gx + ox, gy + oy, ow, oh, orig_pixels))

    return regions


def region_to_video(
    bx: int,
    by: int,
    bw: int,
    bh: int,
    *,
    roi_index: int,
    roi_region: tuple[int, int, int, int],
    crop_x0: int = 0,
    crop_y0: int = 0,
) -> tuple[int, int, int, int]:
    """Map a mask-space region into 1280x720 video coordinates.

    The two ROIs reach the mask by different routes, so they unwind differently:
    ROI 0 is a 1:1 centre crop of the VSE output, ROI 1 is a resize.
    """
    roi_sx, roi_sy, roi_sw, _ = roi_region

    if roi_index == 0:
        # ROI 0 is 1:1 crop: pixel → sensor coord via crop offset
        return (
            int((bx + crop_x0 + roi_sx) * SENSOR_TO_VIDEO_X),
            int((by + crop_y0 + roi_sy) * SENSOR_TO_VIDEO_Y),
            int(bw * SENSOR_TO_VIDEO_X),
            int(bh * SENSOR_TO_VIDEO_Y),
        )

    # ROI 1: 320→sensor via resize scale = roi_sw/480
    ms = roi_sw / ROI1_RESIZE_BASE
    roi_ox = int(roi_sx * SENSOR_TO_VIDEO_X)
    roi_oy = int(roi_sy * SENSOR_TO_VIDEO_Y)
    return (int(bx * ms) + roi_ox, int(by * ms) + roi_oy, int(bw * ms), int(bh * ms))


def region_confidence(
    orig_pixels: int, small_size: int, params: MotionParams = DEFAULT_PARAMS
) -> float:
    """Confidence from how much of the mask the region actually lit up."""
    small_pixels = small_size * small_size
    return min(1.0, orig_pixels / (small_pixels * params.confidence_pixel_ratio))


def detect_motion(
    y_small: np.ndarray,
    prev_small: np.ndarray,
    acc: np.ndarray,
    *,
    roi_index: int,
    roi_region: tuple[int, int, int, int],
    small_size: int,
    crop_x0: int = 0,
    crop_y0: int = 0,
    params: MotionParams = DEFAULT_PARAMS,
) -> list[MotionBlob]:
    """Run the whole pipeline for one ROI frame.

    `acc` is updated in place even when no blob survives filtering — the decay
    has to happen every frame for the accumulator to mean anything.
    """
    thresh = accumulate_diff(y_small, prev_small, acc, params)
    regions = find_motion_regions(thresh, small_size, params)

    blobs: list[MotionBlob] = []
    for bx, by, bw, bh, orig_pixels in regions:
        x, y, w, h = region_to_video(
            bx,
            by,
            bw,
            bh,
            roi_index=roi_index,
            roi_region=roi_region,
            crop_x0=crop_x0,
            crop_y0=crop_y0,
        )
        blobs.append(
            MotionBlob(
                x=x,
                y=y,
                w=w,
                h=h,
                confidence=region_confidence(orig_pixels, small_size, params),
            )
        )
    return blobs


# ---------------------------------------------------------------- base diff

@dataclass(frozen=True)
class BaseDiffParams:
    """Tuning constants for comparing a frame against the empty-scene base."""

    noise_floor: int = 15
    """Per-pixel difference below this is discarded (sweep-tuned against IR noise)."""

    border_mask: int = 16
    """Pixels blanked along each edge. The IR LEDs light the frame unevenly, so
    the outer band differs from the base even with nothing in the scene."""

    blur_kernel: tuple[int, int] = (5, 5)
    open_kernel: tuple[int, int] = (5, 5)


DEFAULT_BASE_DIFF_PARAMS = BaseDiffParams()

HEATMAP_GRID_SIZE = 16
"""Side of the coarse grid published for the web UI heatmap."""


@dataclass(frozen=True)
class BaseDiffResult:
    """Outcome of one base comparison."""

    nz_ratio: float
    """Share of the frame that differs from the base after noise removal."""

    raw: np.ndarray
    """Blurred absolute difference, before thresholding. Feeds the heatmap, which
    wants the full gradient rather than a binary mask."""

    coherent: np.ndarray
    """Difference after the noise floor, border mask and morphological opening —
    what `nz_ratio` is measured on."""


def base_diff(
    y_small: np.ndarray,
    base_u8: np.ndarray,
    params: BaseDiffParams = DEFAULT_BASE_DIFF_PARAMS,
) -> BaseDiffResult:
    """Compare a frame against the empty-scene base image.

    Unlike `accumulate_diff`, which needs movement between consecutive frames,
    this notices something that arrived and then stopped — a pet sitting still
    still differs from the empty scene.

    `base_u8` is resized to match when the two disagree; in practice they never
    do, because the base is built from the very frames it is compared against.
    """
    if base_u8.shape[:2] != y_small.shape[:2]:
        base_u8 = cv2.resize(
            base_u8,
            (y_small.shape[1], y_small.shape[0]),
            interpolation=cv2.INTER_AREA,
        )

    raw = cv2.absdiff(y_small, base_u8)
    raw = cv2.GaussianBlur(raw, params.blur_kernel, 0)

    masked = raw.copy()
    masked[masked < params.noise_floor] = 0

    b = params.border_mask
    masked[:b, :] = 0
    masked[-b:, :] = 0
    masked[:, :b] = 0
    masked[:, -b:] = 0

    # Morphological OPEN: remove spatially scattered noise pixels while
    # preserving coherent motion regions (e.g. dark cat)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, params.open_kernel)
    coherent = cv2.morphologyEx(masked, cv2.MORPH_OPEN, kernel)

    height, width = y_small.shape[:2]
    nz_ratio = cv2.countNonZero(coherent) / (width * height)
    return BaseDiffResult(nz_ratio=nz_ratio, raw=raw, coherent=coherent)


def heatmap_grid(
    raw: np.ndarray, grid_size: int = HEATMAP_GRID_SIZE
) -> list[list[float]]:
    """Downsample a difference image into the grid the web UI draws.

    Uses the pre-threshold difference so the UI shows a gradient rather than the
    binary mask the ratio is measured on. Values are normalised to 0..1 and
    rounded, because this is serialised to JSON several times a second.
    """
    grid = cv2.resize(raw, (grid_size, grid_size), interpolation=cv2.INTER_AREA)
    return np.round(grid.astype(np.float32) / 255.0, 3).tolist()
