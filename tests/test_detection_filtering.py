"""Characterization tests for the pure detection-filtering helpers in
yolo_detector_daemon.py.

These fix CURRENT behavior (not "intended" behavior) as a safety net before
splitting _run_night_iteration(). Values were derived by running the actual
implementation against the inputs below and recording what it produced.

Covers:
- _iou()                 (module-level, pure)
- _containment_ratio()   (module-level, pure)
- _suppress_dog_with_cat() (module-level, pure)
- apply_cross_roi_nms()  (module-level, thin wrapper over cv2.dnn.NMSBoxes)
- _detect_day_motion()   (YoloDetectorDaemon method; only touches
                          self._day_prev_zone / self._day_active_zone, so it
                          is exercised via a minimal fake `self` rather than
                          a real YoloDetectorDaemon instance)

yolo_detector_daemon.py is loaded directly from its file path (like
test_night_collect_gc.py does for scripts/night_collect_gc.py) with a stub
`hobot_dnn` module injected into sys.modules first, since
detection.yolo_detector does `from hobot_dnn import pyeasy_dnn` at import
time and hobot_dnn is only available on the real RDK X5 BPU. The stub is
never called (dnn.load(...) only happens inside YoloDetector methods we
never invoke) — it exists purely to satisfy the module-level import.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
_MODULE_PATH = REPO_ROOT / "src" / "detector" / "yolo_detector_daemon.py"


def _stub_hobot_dnn() -> None:
    if "hobot_dnn" in sys.modules:
        return
    hobot_dnn = types.ModuleType("hobot_dnn")
    pyeasy_dnn = types.ModuleType("hobot_dnn.pyeasy_dnn")
    hobot_dnn.pyeasy_dnn = pyeasy_dnn  # type: ignore[attr-defined]
    sys.modules["hobot_dnn"] = hobot_dnn
    sys.modules["hobot_dnn.pyeasy_dnn"] = pyeasy_dnn


for _rel in ("src/capture", "src/common/src"):
    _p = str(REPO_ROOT / _rel)
    if _p not in sys.path:
        sys.path.insert(0, _p)

_stub_hobot_dnn()

_spec = importlib.util.spec_from_file_location("yolo_detector_daemon", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
yolo_detector_daemon = importlib.util.module_from_spec(_spec)
sys.modules["yolo_detector_daemon"] = yolo_detector_daemon
_spec.loader.exec_module(yolo_detector_daemon)

DetBbox = yolo_detector_daemon.DetBbox
DetDict = yolo_detector_daemon.DetDict
DetectionClass = yolo_detector_daemon.DetectionClass
_iou = yolo_detector_daemon._iou
_containment_ratio = yolo_detector_daemon._containment_ratio
_suppress_dog_with_cat = yolo_detector_daemon._suppress_dog_with_cat
apply_cross_roi_nms = yolo_detector_daemon.apply_cross_roi_nms
YoloDetectorDaemon = yolo_detector_daemon.YoloDetectorDaemon
DAY_MOTION_ZONES = yolo_detector_daemon.DAY_MOTION_ZONES


def _det(cls: "DetectionClass", conf: float, x: int, y: int, w: int, h: int) -> "DetDict":
    return DetDict(class_name=cls, confidence=conf, bbox=DetBbox(x=x, y=y, w=w, h=h))


# ============================================================================
# _iou
# ============================================================================


def test_iou_identical_boxes_is_one():
    assert _iou(DetBbox(0, 0, 100, 100), 0, 0, 100, 100) == 1.0


def test_iou_disjoint_boxes_is_zero():
    assert _iou(DetBbox(0, 0, 10, 10), 100, 100, 10, 10) == 0.0


def test_iou_edge_touching_boxes_is_zero():
    """Boxes that share an edge but don't overlap any area -> 0.0."""
    assert _iou(DetBbox(0, 0, 10, 10), 10, 0, 10, 10) == 0.0


def test_iou_zero_width_bbox_is_zero():
    """Degenerate zero-width bbox never overlaps -> the inter==0 shortcut fires."""
    assert _iou(DetBbox(0, 0, 0, 10), 0, 0, 10, 10) == 0.0


def test_iou_zero_area_both_boxes_is_zero_no_division_error():
    """Two identical zero-size boxes: inter==0 shortcut avoids 0/0 division."""
    assert _iou(DetBbox(0, 0, 0, 0), 0, 0, 0, 0) == 0.0


def test_iou_partial_overlap_known_value():
    # a=[0,0,100,100], b=[50,0,100,100]: inter=50*100=5000, union=15000
    assert _iou(DetBbox(0, 0, 100, 100), 50, 0, 100, 100) == pytest.approx(1 / 3)


# ============================================================================
# _containment_ratio
# ============================================================================


def test_containment_full_containment_is_one():
    """Small bbox fully inside a larger one -> ratio 1.0 (low IoU would miss this)."""
    small = DetBbox(2, 2, 4, 4)
    big = DetBbox(0, 0, 10, 10)
    assert _containment_ratio(small, big) == 1.0


def test_containment_no_overlap_is_zero():
    assert _containment_ratio(DetBbox(0, 0, 5, 5), DetBbox(100, 100, 5, 5)) == 0.0


def test_containment_zero_area_a_is_zero():
    assert _containment_ratio(DetBbox(0, 0, 0, 0), DetBbox(0, 0, 10, 10)) == 0.0


def test_containment_zero_area_b_is_zero():
    assert _containment_ratio(DetBbox(0, 0, 10, 10), DetBbox(0, 0, 0, 0)) == 0.0


def test_containment_exact_half_boundary():
    """a=[0,0,10,10] (area 100), b=[5,0,10,10] (area 100): inter=5*10=50 -> ratio 0.5 exactly.

    This is the boundary value used by _suppress_dog_with_cat's default
    threshold=0.5 (strict '>' comparison there).
    """
    a = DetBbox(0, 0, 10, 10)
    b = DetBbox(5, 0, 10, 10)
    assert _containment_ratio(a, b) == 0.5


# ============================================================================
# _suppress_dog_with_cat
# ============================================================================


def test_suppress_no_cats_returns_same_object_unchanged():
    """No cats present -> the function short-circuits and returns the SAME list object."""
    detections = [
        _det(DetectionClass.DOG, 0.5, 0, 0, 10, 10),
        _det(DetectionClass.PERSON, 0.9, 20, 20, 10, 10),
    ]
    result = _suppress_dog_with_cat(detections)
    assert result is detections


def test_suppress_empty_list_returns_empty_list():
    assert _suppress_dog_with_cat([]) == []


def test_suppress_dog_containment_at_threshold_boundary_is_kept():
    """Containment ratio == threshold (0.5) does NOT suppress (strict '>' in source)."""
    cat = _det(DetectionClass.CAT, 0.8, 0, 0, 10, 10)
    dog_at_half = _det(DetectionClass.DOG, 0.7, 5, 0, 10, 10)  # containment == 0.5 exactly
    result = _suppress_dog_with_cat([cat, dog_at_half], threshold=0.5)
    assert result == [cat, dog_at_half]


def test_suppress_dog_containment_above_threshold_is_removed():
    cat = _det(DetectionClass.CAT, 0.8, 0, 0, 10, 10)
    dog_over_half = _det(DetectionClass.DOG, 0.7, 4, 0, 10, 10)  # containment == 0.6
    result = _suppress_dog_with_cat([cat, dog_over_half], threshold=0.5)
    assert result == [cat]


def test_suppress_dog_matching_any_of_multiple_cats_is_removed():
    cat_far = _det(DetectionClass.CAT, 0.8, 100, 100, 10, 10)  # no overlap with dog
    cat_near = _det(DetectionClass.CAT, 0.8, 0, 0, 10, 10)
    dog = _det(DetectionClass.DOG, 0.7, 1, 1, 8, 8)  # fully inside cat_near
    result = _suppress_dog_with_cat([cat_far, cat_near, dog], threshold=0.5)
    assert result == [cat_far, cat_near]


def test_suppress_person_class_is_never_filtered_regardless_of_overlap():
    cat = _det(DetectionClass.CAT, 0.8, 0, 0, 10, 10)
    person_same_box = _det(DetectionClass.PERSON, 0.9, 0, 0, 10, 10)
    result = _suppress_dog_with_cat([cat, person_same_box])
    assert result == [cat, person_same_box]


def test_suppress_single_dog_no_cats_is_kept():
    dog = _det(DetectionClass.DOG, 0.5, 0, 0, 10, 10)
    result = _suppress_dog_with_cat([dog])
    assert result == [dog]


# ============================================================================
# apply_cross_roi_nms
# ============================================================================


def test_nms_empty_list_returns_empty_list():
    assert apply_cross_roi_nms([]) == []


def test_nms_single_detection_returns_same_object_unchanged():
    """len(detections) <= 1 shortcut returns the original list object as-is."""
    single = [_det(DetectionClass.DOG, 0.5, 0, 0, 10, 10)]
    result = apply_cross_roi_nms(single, iou_threshold=0.5)
    assert result is single


def test_nms_different_classes_never_suppress_each_other():
    """Detections are grouped by class before NMS; identical bboxes of
    different classes both survive even though they fully overlap."""
    cat = _det(DetectionClass.CAT, 0.9, 0, 0, 100, 100)
    dog = _det(DetectionClass.DOG, 0.9, 0, 0, 100, 100)
    result = apply_cross_roi_nms([cat, dog], iou_threshold=0.5)
    assert set(result) == {cat, dog}
    assert len(result) == 2


def test_nms_same_class_keeps_higher_confidence_on_full_overlap():
    high = _det(DetectionClass.CAT, 0.9, 0, 0, 100, 100)
    low = _det(DetectionClass.CAT, 0.5, 0, 0, 100, 100)
    result = apply_cross_roi_nms([high, low], iou_threshold=0.5)
    assert result == [high]


def test_nms_boundary_iou_just_above_threshold_is_suppressed():
    """dx=33 on 100x100 boxes -> IoU = 0.5037... (> 0.5) -> lower-score box suppressed.

    This is the closest achievable-with-integer-coordinates approximation of
    "IoU exactly at the 0.5 threshold" for cv2.dnn.NMSBoxes; exact equality
    is not reachable with integer bbox pixels for this box size.
    """
    a = _det(DetectionClass.CAT, 0.9, 0, 0, 100, 100)
    b = _det(DetectionClass.CAT, 0.5, 33, 0, 100, 100)
    assert _iou(a.bbox, *b.bbox) == pytest.approx(0.5037593984962406)
    result = apply_cross_roi_nms([a, b], iou_threshold=0.5)
    assert result == [a]


def test_nms_boundary_iou_just_below_threshold_keeps_both():
    """dx=34 -> IoU = 0.4925... (< 0.5) -> both boxes survive."""
    a = _det(DetectionClass.CAT, 0.9, 0, 0, 100, 100)
    b = _det(DetectionClass.CAT, 0.5, 34, 0, 100, 100)
    assert _iou(a.bbox, *b.bbox) == pytest.approx(0.4925373134328358)
    result = apply_cross_roi_nms([a, b], iou_threshold=0.5)
    assert result == [a, b]


def test_nms_zero_area_bbox_does_not_crash():
    zero = _det(DetectionClass.CAT, 0.9, 0, 0, 0, 0)
    normal = _det(DetectionClass.CAT, 0.5, 0, 0, 10, 10)
    result = apply_cross_roi_nms([zero, normal], iou_threshold=0.5)
    assert set(result) == {zero, normal}


# ============================================================================
# _detect_day_motion (YoloDetectorDaemon method; called unbound with a
# minimal fake `self` since it only reads/writes self._day_prev_zone and
# self._day_active_zone — no SHM/camera access happens inside this method.)
# ============================================================================


class _FakeDayMotionSelf:
    """Minimal stand-in for YoloDetectorDaemon exposing only the two
    attributes _detect_day_motion actually touches."""

    def __init__(self, active_zone: int) -> None:
        self._day_prev_zone: np.ndarray | None = None
        self._day_active_zone = active_zone


def test_day_motion_first_call_returns_empty_and_seeds_prev_zone():
    fake = _FakeDayMotionSelf(active_zone=0)
    zone = np.zeros((320, 320), dtype=np.uint8)
    result = YoloDetectorDaemon._detect_day_motion(fake, zone)
    assert result == []
    assert fake._day_prev_zone is zone


def test_day_motion_identical_consecutive_frames_no_motion():
    fake = _FakeDayMotionSelf(active_zone=0)
    zone = np.zeros((320, 320), dtype=np.uint8)
    YoloDetectorDaemon._detect_day_motion(fake, zone)
    result = YoloDetectorDaemon._detect_day_motion(fake, zone.copy())
    assert result == []


def test_day_motion_area_below_min_ratio_is_ignored():
    """min_area = 320*320*0.005 = 512px. A 10x10=100px bright square stays under it."""
    fake = _FakeDayMotionSelf(active_zone=0)
    base = np.zeros((320, 320), dtype=np.uint8)
    YoloDetectorDaemon._detect_day_motion(fake, base)
    small = base.copy()
    small[50:60, 50:60] = 200
    result = YoloDetectorDaemon._detect_day_motion(fake, small)
    assert result == []


def test_day_motion_detects_blob_with_zone_offset_applied():
    """40x40 bright block at local (100,100) in zone index 5 (offset 320,40).

    Observed actual output (golden value): after GaussianBlur + morphology
    CLOSE the contour grows slightly beyond the raw 40x40 input square.
    """
    active_zone = 5
    assert DAY_MOTION_ZONES[active_zone] == (320, 40, 320, 320)
    fake = _FakeDayMotionSelf(active_zone=active_zone)
    base = np.zeros((320, 320), dtype=np.uint8)
    YoloDetectorDaemon._detect_day_motion(fake, base)

    blob = base.copy()
    blob[100:140, 100:140] = 200
    result = YoloDetectorDaemon._detect_day_motion(fake, blob)

    assert len(result) == 1
    d = result[0]
    assert d.class_name is DetectionClass.MOTION
    assert d.bbox == DetBbox(x=419, y=139, w=42, h=42)
    assert d.confidence == pytest.approx(0.3283203125)


def test_day_motion_prev_zone_updates_every_call_regardless_of_motion():
    fake = _FakeDayMotionSelf(active_zone=0)
    zone_a = np.zeros((320, 320), dtype=np.uint8)
    zone_b = np.full((320, 320), 5, dtype=np.uint8)
    YoloDetectorDaemon._detect_day_motion(fake, zone_a)
    YoloDetectorDaemon._detect_day_motion(fake, zone_b)
    assert fake._day_prev_zone is zone_b
