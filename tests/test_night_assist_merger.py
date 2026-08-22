"""Characterization tests for NightAssistMerger.merge() in yolo_detector_daemon.py.

These fix CURRENT behavior as a safety net before splitting
_run_night_iteration(). Values were derived by running the actual
implementation against the inputs below.

Important finding used throughout this file: despite the class-level
comment "1.5秒 @30fps" for AI_MAX_AGE and "0.5秒以内" for the hardcoded 15
in merge(), the merger's staleness tracking is a per-call FRAME COUNTER
(`self.ai_detection_age`), incremented once at the top of every merge()
call — it is NOT wall-clock time. There is nothing to monkeypatch for
"time injection"; age is controlled directly by setting
`merger.ai_detection_age` before calling merge() (merge() increments it
by 1 before using it, so setting N before the call means the comparisons
inside merge() see N+1).

NightAssistMerger.__init__ starts a background thread that immediately
opens a real network connection to `{url}/api/night-assist/detections/stream`.
To keep these tests hermetic (no network access, no real thread work),
_sse_loop is monkeypatched to a no-op on the class BEFORE construction —
this must happen before instantiation because Thread(target=self._sse_loop)
resolves the bound method inside __init__ itself.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from typing import Callable

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
NightAssistMerger = yolo_detector_daemon.NightAssistMerger

assert NightAssistMerger.AI_MAX_AGE == 45
assert NightAssistMerger.IOU_THRESH == 0.15


def _det(cls: "DetectionClass", conf: float, x: int, y: int, w: int, h: int) -> "DetDict":
    return DetDict(class_name=cls, confidence=conf, bbox=DetBbox(x=x, y=y, w=w, h=h))


def _ai(class_name: str, conf: float, x: int, y: int, w: int, h: int) -> dict:
    return {"class_name": class_name, "confidence": conf, "bbox": {"x": x, "y": y, "w": w, "h": h}}


@pytest.fixture
def make_merger(monkeypatch: pytest.MonkeyPatch) -> Callable[[], "NightAssistMerger"]:
    """Factory for a NightAssistMerger whose SSE background thread is a no-op."""

    def _make() -> "NightAssistMerger":
        monkeypatch.setattr(NightAssistMerger, "_sse_loop", lambda self: None)
        return NightAssistMerger("http://fake.invalid")

    return _make


# ============================================================================
# Step 1: local YOLO pet detection always wins, unconditionally
# ============================================================================


def test_local_yolo_cat_short_circuits_and_returns_same_object(make_merger):
    merger = make_merger()
    local = [_det(DetectionClass.CAT, 0.5, 1, 1, 2, 2)]
    result = merger.merge(motion_bboxes=[], local_yolo_results=local)
    assert result is local
    assert merger.ai_detection_age == 1  # age still increments even on short-circuit


def test_local_yolo_dog_or_person_also_short_circuits(make_merger):
    merger = make_merger()
    local = [_det(DetectionClass.PERSON, 0.5, 1, 1, 2, 2)]
    assert merger.merge(motion_bboxes=[], local_yolo_results=local) is local

    merger2 = make_merger()
    local2 = [_det(DetectionClass.DOG, 0.5, 1, 1, 2, 2)]
    assert merger2.merge(motion_bboxes=[], local_yolo_results=local2) is local2


def test_local_yolo_motion_only_does_not_short_circuit(make_merger):
    """MOTION is not in the (CAT, DOG, PERSON) short-circuit tuple, so a
    local result containing only MOTION detections falls through to the
    ai-pyramid merge logic instead of being returned as-is."""
    merger = make_merger()
    local = [_det(DetectionClass.MOTION, 0.5, 1, 1, 2, 2)]
    result = merger.merge(motion_bboxes=[], local_yolo_results=local)
    assert result == []  # no ai detections available either -> step 4 empty


# ============================================================================
# Step 2: ai-pyramid detection + motion bbox spatial match -> synthesized detection
# ============================================================================


def test_step2_match_merges_ai_class_with_motion_bbox(make_merger):
    merger = make_merger()
    merger.ai_detection_age = 43  # becomes 44 after increment, still < AI_MAX_AGE(45)
    merger.last_ai_detections = [_ai("cat", 0.8, 10, 10, 20, 20)]
    motion = [_det(DetectionClass.MOTION, 0.9, 10, 10, 20, 20)]  # identical bbox -> iou 1.0

    result = merger.merge(motion_bboxes=motion, local_yolo_results=[])

    assert result == [
        DetDict(
            class_name=DetectionClass.CAT,
            confidence=pytest.approx(0.8 * 0.9),
            bbox=DetBbox(x=10, y=10, w=20, h=20),  # motion bbox, not the ai bbox
        )
    ]
    assert merger.ai_detection_age == 44


def test_step2_age_boundary_at_ai_max_age_is_excluded(make_merger):
    """ai_detection_age == AI_MAX_AGE (45) exactly fails the '< 45' check.

    Since 45 is also not < 15, step 3 is skipped too -> result is [] even
    though there's a perfect spatial match available.
    """
    merger = make_merger()
    merger.ai_detection_age = 44  # becomes 45 after increment
    merger.last_ai_detections = [_ai("cat", 0.8, 10, 10, 20, 20)]
    motion = [_det(DetectionClass.MOTION, 0.9, 10, 10, 20, 20)]

    result = merger.merge(motion_bboxes=motion, local_yolo_results=[])

    assert result == []
    assert merger.ai_detection_age == 45


def test_step2_empty_motion_bboxes_skips_step2(make_merger):
    """motion_bboxes=[] is falsy, so step 2's `and motion_bboxes` guard fails
    even though age is well within AI_MAX_AGE."""
    merger = make_merger()
    merger.ai_detection_age = 0
    merger.last_ai_detections = [_ai("cat", 0.8, 10, 10, 20, 20)]

    result = merger.merge(motion_bboxes=[], local_yolo_results=[])

    # Falls through to step 3 instead (age=1 < 15) -> raw ai detection passed through
    assert result == [
        DetDict(class_name=DetectionClass.CAT, confidence=0.8, bbox=DetBbox(10, 10, 20, 20))
    ]


def test_step2_iou_exact_threshold_boundary_does_not_match():
    """a=[0,0,23,23], b=[17,0,23,23] gives IoU == 0.15 exactly (verified via
    _iou directly). merge()'s check is strict '>', so this does NOT count
    as a step-2 match; with age<15 it falls through to step 3 and the raw
    ai detection is passed through unmodified."""
    assert yolo_detector_daemon._iou(DetBbox(0, 0, 23, 23), 17, 0, 23, 23) == 0.15


def test_step2_iou_at_threshold_falls_through_to_step3(make_merger):
    merger = make_merger()
    merger.ai_detection_age = 0
    merger.last_ai_detections = [_ai("cat", 0.8, 0, 0, 23, 23)]
    motion = [_det(DetectionClass.MOTION, 0.9, 17, 0, 23, 23)]  # iou == 0.15 exactly

    result = merger.merge(motion_bboxes=motion, local_yolo_results=[])

    assert result == [
        DetDict(class_name=DetectionClass.CAT, confidence=0.8, bbox=DetBbox(0, 0, 23, 23))
    ]


def test_step2_iou_just_above_threshold_matches(make_merger):
    merger = make_merger()
    merger.ai_detection_age = 0
    merger.last_ai_detections = [_ai("cat", 0.8, 0, 0, 23, 23)]
    motion = [_det(DetectionClass.MOTION, 0.9, 16, 0, 23, 23)]  # iou == 0.1795 > 0.15

    result = merger.merge(motion_bboxes=motion, local_yolo_results=[])

    assert result == [
        DetDict(
            class_name=DetectionClass.CAT,
            confidence=pytest.approx(0.8 * 0.9),
            bbox=DetBbox(16, 0, 23, 23),
        )
    ]


def test_step2_unknown_ai_class_name_is_ignored(make_merger):
    """class_name not present in _AI_CLASS_MAP is skipped entirely, in both
    step 2 and step 3."""
    merger = make_merger()
    merger.ai_detection_age = 0
    merger.last_ai_detections = [_ai("bird", 0.9, 0, 0, 23, 23)]
    motion = [_det(DetectionClass.MOTION, 0.9, 0, 0, 23, 23)]

    result = merger.merge(motion_bboxes=motion, local_yolo_results=[])

    assert result == []


# ============================================================================
# Step 3: ai-pyramid detections passed through raw (age < 15, no motion match)
# ============================================================================


def test_step3_age_boundary_at_15_is_excluded(make_merger):
    merger = make_merger()
    merger.ai_detection_age = 14  # becomes 15 after increment -> '< 15' is False
    merger.last_ai_detections = [_ai("person", 0.9, 1, 1, 5, 5)]

    result = merger.merge(motion_bboxes=[], local_yolo_results=[])

    assert result == []
    assert merger.ai_detection_age == 15


def test_step3_age_just_under_15_passes_through_raw_detections(make_merger):
    merger = make_merger()
    merger.ai_detection_age = 13  # becomes 14
    merger.last_ai_detections = [_ai("person", 0.9, 1, 1, 5, 5)]

    result = merger.merge(motion_bboxes=[], local_yolo_results=[])

    assert result == [
        DetDict(class_name=DetectionClass.PERSON, confidence=0.9, bbox=DetBbox(1, 1, 5, 5))
    ]


def test_step3_multiple_known_classes_all_pass_through(make_merger):
    merger = make_merger()
    merger.ai_detection_age = 0
    merger.last_ai_detections = [
        _ai("cat", 0.8, 0, 0, 10, 10),
        _ai("food_bowl", 0.7, 20, 20, 10, 10),
        _ai("unknown_class", 0.99, 40, 40, 10, 10),  # ignored, not in _AI_CLASS_MAP
    ]

    result = merger.merge(motion_bboxes=[], local_yolo_results=[])

    assert result == [
        DetDict(class_name=DetectionClass.CAT, confidence=0.8, bbox=DetBbox(0, 0, 10, 10)),
        DetDict(class_name=DetectionClass.FOOD_BOWL, confidence=0.7, bbox=DetBbox(20, 20, 10, 10)),
    ]


# ============================================================================
# Step 4: nothing available -> empty
# ============================================================================


def test_step4_fresh_merger_with_nothing_returns_empty_list(make_merger):
    merger = make_merger()
    result = merger.merge(motion_bboxes=[], local_yolo_results=[])
    assert result == []


def test_step4_empty_local_results_list_input(make_merger):
    """Empty list is a valid local_yolo_results input (no pet -> `any()` over
    empty is False, doesn't short-circuit)."""
    merger = make_merger()
    result = merger.merge(motion_bboxes=[], local_yolo_results=[])
    assert result == []
