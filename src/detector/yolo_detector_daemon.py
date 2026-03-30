#!/usr/bin/env python3
"""
yolo_detector_daemon.py - YOLO detector daemon with zero-copy VIO buffer sharing

Reads NV12 frames via zero-copy shared memory (hb_mem share_id) and writes
YOLO detection results to detection shared memory.
"""

from __future__ import annotations

import json
import os
import sys
import signal
import time
import logging
import queue
import threading
import types
import urllib.request
from typing import Any, Iterator, NamedTuple
from pathlib import Path

import cv2
import numpy as np

# プロジェクトルートをパスに追加
DETECTOR_DIR = Path(__file__).parent
PROJECT_ROOT = DETECTOR_DIR.parent.parent
CAPTURE_DIR = PROJECT_ROOT / "src" / "capture"
COMMON_SRC = PROJECT_ROOT / "src" / "common" / "src"

sys.path.insert(0, str(CAPTURE_DIR))
sys.path.insert(0, str(COMMON_SRC))

from real_shared_memory import (  # noqa: E402
    DetectionWriter,
    ZeroCopySharedMemory,
    SHM_NAME_YOLO_ZC,
    open_roi_readers,
)
from detection.yolo_detector import YoloDetector  # noqa: E402
from detection.image_utils import jpeg_to_yolo_nv12  # noqa: E402

# hb_mem bindings (required for zero-copy)
from hb_mem_bindings import init_module as hb_mem_init, import_nv12_graph_buf  # noqa: E402
from common.types import DetectionDict as _DetectionDict, DetectionClass, PET_BOUNDARY  # noqa: E402

# ロガー設定（後でmain()で上書きされる）
logging.basicConfig(
    level=logging.ERROR,
    format="[%(asctime)s.%(msecs)03d] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("YOLODetectorDaemon")
yolo_logger = logging.getLogger("detection.yolo_detector")


# Lightweight result types (NamedTuples are faster than dicts and give attribute access)
class DetBbox(NamedTuple):
    x: int
    y: int
    w: int
    h: int


class DetDict(NamedTuple):
    class_name: DetectionClass
    confidence: float
    bbox: DetBbox


class FrameData(NamedTuple):
    zc_frame: object
    nv12_data: np.ndarray
    hb_mem_buffer: object


# Day camera motion detection zones (320x320, 3cols x 2rows, overlapping)
# Zones cover the 640x360 frame with heavy overlap so any pet bbox position
# maps to a zone that covers the surrounding area well.
DAY_MOTION_ZONES: list[tuple[int, int, int, int]] = [
    (0, 0, 320, 320),  # Z0: top-left      center=(160,160)
    (160, 0, 320, 320),  # Z1: top-center     center=(320,160)
    (320, 0, 320, 320),  # Z2: top-right      center=(480,160)
    (0, 40, 320, 320),  # Z3: bottom-left    center=(160,200)
    (160, 40, 320, 320),  # Z4: bottom-center  center=(320,200)
    (320, 40, 320, 320),  # Z5: bottom-right   center=(480,200)
]
# Voronoi boundaries for O(1) zone selection (midpoints of zone centers)
_DAY_ZONE_COL_BOUNDS = (240, 400)  # x boundaries between cols 0/1 and 1/2
_DAY_ZONE_ROW_BOUND = 180  # y boundary between rows 0 and 1

DAY_MOTION_TIMEOUT = 10.0  # seconds to keep tracking motion after pet lost
_ADAPTIVE_GAP_TOLERANCE = 1.0  # seconds: pet lost < this → still "continuous"
_ADAPTIVE_FLOOR = 0.2  # minimum adaptive threshold
DAY_MOTION_THRESH = 15  # pixel diff threshold (day camera has low noise)
DAY_MOTION_MIN_AREA_RATIO = 0.005  # min contour area as fraction of zone area


def _det_to_dict(d: DetDict) -> _DetectionDict:
    """Convert a DetDict namedtuple to a plain dict for the SHM write boundary."""
    return {
        "class_name": d.class_name.label,
        "confidence": d.confidence,
        "bbox": {"x": d.bbox.x, "y": d.bbox.y, "w": d.bbox.w, "h": d.bbox.h},
    }


def _containment_ratio(a: DetBbox, b: DetBbox) -> float:
    """Fraction of the smaller bbox's area that overlaps with the larger one.

    Returns intersection / min(area_a, area_b).  This catches cases where
    a small cat bbox is fully contained inside a large dog bbox (IoU is low
    but containment is 100%).
    """
    x1 = max(a.x, b.x)
    y1 = max(a.y, b.y)
    x2 = min(a.x + a.w, b.x + b.w)
    y2 = min(a.y + a.h, b.y + b.h)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    min_area = min(a.w * a.h, b.w * b.h)
    return inter / min_area if min_area > 0 else 0.0


def _suppress_dog_with_cat(
    detections: list[DetDict], threshold: float = 0.5
) -> list[DetDict]:
    """Suppress dog detections that overlap with cat detections.

    YOLO often misclassifies cats as dogs, producing a small cat bbox
    inside a larger dog bbox.  Uses containment ratio (intersection /
    min_area) instead of IoU to catch size-mismatched overlaps.
    """
    cats = [d for d in detections if d.class_name is DetectionClass.CAT]
    if not cats:
        return detections
    return [
        d
        for d in detections
        if d.class_name is not DetectionClass.DOG
        or not any(_containment_ratio(d.bbox, c.bbox) > threshold for c in cats)
    ]


def apply_cross_roi_nms(
    detections: list[DetDict], iou_threshold: float = 0.5
) -> list[DetDict]:
    """
    Cross-ROI NMS: cv2.dnn.NMSBoxesを使用して異なるROI間の重複検出を除去

    Args:
        detections: 検出結果リスト [DetDict(class_name, confidence, bbox), ...]
        iou_threshold: IoU閾値（これ以上重なっていれば重複とみなす）

    Returns:
        重複除去後の検出結果リスト
    """
    if len(detections) <= 1:
        return detections

    # クラス別にグループ化
    by_class: dict[str, list[DetDict]] = {}
    for det in detections:
        cls = str(det.class_name)
        if cls not in by_class:
            by_class[cls] = []
        by_class[cls].append(det)

    result: list[DetDict] = []
    for dets in by_class.values():
        # cv2.dnn.NMSBoxes用にデータを準備
        bboxes = [[d.bbox.x, d.bbox.y, d.bbox.w, d.bbox.h] for d in dets]
        scores = [float(d.confidence) for d in dets]

        # NMS適用 (score_threshold=0でフィルタリングなし、iou_thresholdで重複除去)
        indices = cv2.dnn.NMSBoxes(
            bboxes, scores, score_threshold=0.0, nms_threshold=iou_threshold
        )

        # 残ったインデックスの検出を追加
        for idx in indices:
            result.append(dets[idx])

    return result


def _iou(a: DetBbox, b_x: int, b_y: int, b_w: int, b_h: int) -> float:
    """Standard IoU between a DetBbox and a plain bbox (x,y,w,h)."""
    x1 = max(a.x, b_x)
    y1 = max(a.y, b_y)
    x2 = min(a.x + a.w, b_x + b_w)
    y2 = min(a.y + a.h, b_y + b_h)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    if inter == 0:
        return 0.0
    area_a = a.w * a.h
    area_b = b_w * b_h
    return inter / (area_a + area_b - inter)


# ai-pyramid class_name strings → DetectionClass enum
_AI_CLASS_MAP: dict[str, DetectionClass] = {
    "cat": DetectionClass.CAT,
    "person": DetectionClass.PERSON,
    "cup": DetectionClass.CUP,
    "food_bowl": DetectionClass.FOOD_BOWL,
    "chair": DetectionClass.CHAIR,
}


class NightAssistMerger:
    """ai-pyramid SSE検出 + local motion をマージ。

    ai-pyramidのYOLO26l (AX650 NPU) は夜間IRで高精度検出可能。
    SSEストリームを購読し、ローカルYOLO/motionとマージしてDetectionSHMに書き込む。
    """

    AI_MAX_AGE = 45   # 1.5秒 @30fps
    IOU_THRESH = 0.15  # 緩い空間一致閾値

    def __init__(self, ai_pyramid_url: str) -> None:
        self.url = ai_pyramid_url.rstrip("/")
        self.last_ai_detections: list[dict[str, Any]] = []  # thread-safe via GIL
        self.ai_detection_age = 0
        self._thread = threading.Thread(target=self._sse_loop, daemon=True)
        self._thread.start()

    def _sse_loop(self) -> None:
        """別スレッドで SSE 購読。urllib のみ使用 (依存追加なし)"""
        while True:
            try:
                req = urllib.request.Request(
                    f"{self.url}/api/night-assist/detections/stream",
                    headers={"Accept": "text/event-stream"},
                )
                with urllib.request.urlopen(req, timeout=30) as resp:
                    for raw in resp:
                        line = raw.decode().strip()
                        if line.startswith("data:"):
                            data = json.loads(line[5:])
                            if "detections" in data:
                                self.last_ai_detections = data["detections"]
                                self.ai_detection_age = 0
            except Exception:
                time.sleep(5)  # reconnect backoff

    def merge(
        self,
        motion_bboxes: list[DetDict],
        local_yolo_results: list[DetDict],
    ) -> list[DetDict]:
        """毎フレーム呼び出し。マージ検出を返す。"""
        self.ai_detection_age += 1

        # 1. ローカルYOLOがpet検出 → そのまま (従来通り)
        if any(
            d.class_name in (DetectionClass.CAT, DetectionClass.DOG, DetectionClass.PERSON)
            for d in local_yolo_results
        ):
            return local_yolo_results

        # 2. ai-pyramid検出 + motion bbox 空間一致 → 合成
        if self.ai_detection_age < self.AI_MAX_AGE and motion_bboxes:
            for ai_det in self.last_ai_detections:
                cls = _AI_CLASS_MAP.get(ai_det.get("class_name", ""))
                if cls is None:
                    continue
                ai_b = ai_det["bbox"]
                for m in motion_bboxes:
                    if _iou(m.bbox, ai_b["x"], ai_b["y"], ai_b["w"], ai_b["h"]) > self.IOU_THRESH:
                        return [DetDict(
                            class_name=cls,
                            confidence=ai_det["confidence"] * 0.9,
                            bbox=m.bbox,  # motion の方が位置が新鮮
                        )]

        # 3. ai-pyramid検出のみ (0.5秒以内) → そのまま通す
        if self.ai_detection_age < 15:
            result = []
            for ai_det in self.last_ai_detections:
                cls = _AI_CLASS_MAP.get(ai_det.get("class_name", ""))
                if cls is None:
                    continue
                b = ai_det["bbox"]
                result.append(DetDict(
                    class_name=cls,
                    confidence=ai_det["confidence"],
                    bbox=DetBbox(x=b["x"], y=b["y"], w=b["w"], h=b["h"]),
                ))
            if result:
                return result

        # 4. 検出なし
        return []


class YoloDetectorDaemon:
    """YOLO検出デーモン (zero-copy mode)"""

    def __init__(
        self,
        model_path: str,
        score_threshold: float = 0.4,
        nms_threshold: float = 0.7,
    ):
        """
        初期化

        Args:
            model_path: YOLOモデルのパス
            score_threshold: 信頼度閾値
            nms_threshold: NMS IoU閾値
        """
        self.model_path = model_path
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold

        # 共有メモリ
        self.detection_writer: DetectionWriter | None = None  # Detection result writer
        self.shm_zerocopy: ZeroCopySharedMemory | None = None
        self.active_camera: int = 0  # Determined from frame camera_id

        # YOLODetector
        self.detector: YoloDetector | None = None

        # 統計情報
        self.stats = {
            "frames_processed": 0,
            "total_detections": 0,
            "avg_inference_time_ms": 0.0,
            "yolo_skipped_frames": 0,
        }

        self.running = True

        # カメラごとのスケール係数（フレームサイズが異なるため）
        # Day: 640x360 → 1280x720, Night: 1280x720 → 1280x720
        self.scale_x: float | None = None
        self.scale_y: float | None = None

        # ROI cycling state
        self.roi_regions: list[tuple[int, int, int, int]] = []  # [(x, y, w, h), ...]
        self.roi_index: int = 0  # Current ROI index for round-robin
        self.roi_enabled: bool = False  # ROI mode disabled (640x360 letterbox)

        # Night camera ROI mode (1280x720 with 3 overlapping ROIs)
        self.night_roi_mode: bool = False  # Enabled only for camera_id=1
        self.night_roi_regions: list[
            tuple[int, int, int, int]
        ] = []  # 3 ROIs for 720p fallback (VSE uses 2)

        # VSE ROI SHM readers (opened when night camera is first detected)
        # Each reader corresponds to one pre-cropped 640x640 NV12 ROI from VSE Ch3-4.
        # RDK X5 VSE supports max 5 channels (Ch0-4), so 2 ROIs max.
        self.roi_readers: list[ZeroCopySharedMemory] = []

        # VSE ROI coordinate mapping: regions are defined on 1920x1080 sensor space.
        # Both ROIs focus on the feeding area (bottom-left of frame).
        # VSE output is always 640x640; scale depends on crop size:
        #   ROI 0 (640x640 crop → 640x640): 1:1,  scale_640_to_1280 = 640/960 = 0.667
        #   ROI 1 (960x960 crop → 640x640): 1.0x, scale_640_to_1280 = 960/960 = 1.0
        # General formula: scale_640_to_1280 = roi_w / 960.0
        # Note: VSE only supports downscaling; 640x640 is the minimum valid crop size.
        self.VSE_ROI_REGIONS: list[tuple[int, int, int, int]] = [
            (160, 440, 640, 640),  # ROI 0: feeding area tight (1:1, min VSE crop)
            (144, 120, 960, 960),  # ROI 1: feeding area wide (YOLO + approach)
        ]

        # Detection result cache for temporal integration
        self.detection_cache: list[list[DetDict]] = []  # [roi_0_dets, roi_1_dets, ...]
        self.cache_frame_number: int = -1  # Frame number when cache started
        self.cache_timestamp: float = 0.0  # Timestamp when cache started

        # Night motion detection state (per-ROI, 320x320 resolution)
        self._prev_roi_small: dict[
            str, np.ndarray
        ] = {}  # {"roi0": 320x320, "roi1": 320x320}
        self._diff_acc: dict[
            str, np.ndarray
        ] = {}  # temporal diff accumulator per ROI (320x320 uint16)
        self._motion_bboxes: list[
            DetDict
        ] = []  # motion bbox buffer for next YOLO write
        self._roi_has_motion: bool = False  # Any ROI had motion recently
        self.motion_cooldown: int = 0  # Frames to skip after motion detected

        # Base reference image state (per-ROI, snapshot-based update)
        self._base_roi_y: dict[
            str, np.ndarray
        ] = {}  # {"roi0": f32 base, "roi1": f32 base}
        self._snapshot_roi_y: dict[
            str, np.ndarray
        ] = {}  # recent snapshot (640x640 float32)
        self._base_valid: dict[str, bool] = {}  # whether base image is usable per ROI
        self._base_init_count: dict[
            str, int
        ] = {}  # initial EMA frames for first base build
        self._quiet_frames: int = (
            0  # consecutive frames with no motion AND no YOLO detection
        )
        self._noise_sigma: float = (
            4.8  # pre-computed from recordings (NIR + H.265 noise)
        )
        self._last_brightness: float = -1.0  # for brightness change detection
        self.BASE_QUIET_THRESHOLD: int = (
            1800  # ~60s @ 30fps for initial base build only
        )
        self.BASE_INIT_FRAMES: int = 50  # EMA frames for initial base
        self.SNAPSHOT_INTERVAL: int = 300  # ~10s @ 30fps between snapshot updates
        self.SNAPSHOT_BLEND_ALPHA: float = 0.05  # how fast base absorbs stable changes
        self._snapshot_timer: int = 0  # frames since last snapshot

        # Idle throttle (night mode only)
        self.IDLE_TIER1_FRAMES: int = 30  # ~1s quiet → ~10fps
        self.IDLE_TIER2_FRAMES: int = 150  # ~5s quiet → ~5fps
        self.IDLE_TIER1_SLEEP: float = 0.067  # skip 2/3 frames
        self.IDLE_TIER2_SLEEP: float = 0.167  # skip 5/6 frames

        # Focus crop state
        self._focus_crop_enabled: bool = True
        self._motion_roi_idx: int = -1  # which ROI had motion (-1=none/both)
        self._roi_grids: dict[str, list[list[float]]] = {}  # per-ROI heatmap grids

        # Day camera motion detection state (320x320 zones, no resize)
        self._day_prev_zone: np.ndarray | None = None  # previous zone crop (320x320 Y)
        self._day_zone_current: np.ndarray | None = (
            None  # current zone crop (set before hb_mem release)
        )
        self._day_active_zone: int = -1  # active zone index (0-5)
        self._day_last_pet_bbox: DetBbox | None = (
            None  # last YOLO pet bbox (640x360 space)
        )
        self._day_pet_seen_at: float = 0.0  # timestamp of last pet detection

        # Adaptive threshold state
        self._pet_continuous_since: float = (
            0.0  # monotonic time when continuous detection started
        )
        self._pet_last_seen: float = 0.0  # monotonic time of last pet detection
        self._adaptive_th_active: bool = False  # whether threshold is currently lowered

        # Night YOLO false positive filter (IR images cause frequent misdetections)
        self.night_fp_classes = {DetectionClass.CHAIR}

        # Night frame collection for future fine-tuning
        self.night_collect_dir = Path("/tmp/night_collect")
        self.night_collect_count: int = 0
        self.night_collect_max: int = 500  # Max frames to collect per session
        self.night_collect_interval: int = 150  # Collect every N frames during motion

        # Feeding zone motion detection state (ROI 0 = tight 480x480 crop)
        self.feeding_collect_dir = Path("/tmp/night_collect/feeding")
        self.feeding_events_path = Path("/tmp/feeding_events.jsonl")
        self.FEEDING_MOTION_THRESH: float = 0.008  # nz_ratio threshold (validated)
        self.FEEDING_QUIET_GAP: int = 15  # frames of quiet before event ends
        self.FEEDING_SAVE_INTERVAL: int = 30  # save full frame every N motion frames
        self._feeding_base_nz: float = 0.0  # latest ROI 0 base_diff ratio
        self._feeding_motion: bool = False  # currently in a feeding event
        self._feeding_event_start: float | None = None  # event start timestamp
        self._feeding_quiet_count: int = 0  # consecutive quiet frames
        self._feeding_save_counter: int = 0  # frames since last frame save
        self._feeding_last_motion_bboxes: list[DetDict] = []  # bboxes at save time

        # Night-assist merger (auto-enabled via PET_ALBUM_HOST env var, None if disabled)
        self.night_assist_merger: NightAssistMerger | None = None

    def _select_zone(self, bbox: "DetBbox") -> int:
        """Select the motion zone whose center is nearest to bbox center (Voronoi, O(1))."""
        bcx = bbox.x + bbox.w // 2
        bcy = bbox.y + bbox.h // 2
        col = (
            0
            if bcx < _DAY_ZONE_COL_BOUNDS[0]
            else (1 if bcx < _DAY_ZONE_COL_BOUNDS[1] else 2)
        )
        row = 0 if bcy < _DAY_ZONE_ROW_BOUND else 1
        return row * 3 + col

    def _detect_day_motion(self, current_zone: np.ndarray) -> list["DetDict"]:
        """Frame-diff motion detection on a 320x320 zone. No resize."""
        if self._day_prev_zone is None:
            self._day_prev_zone = current_zone
            return []

        zx, zy, _, _ = DAY_MOTION_ZONES[self._day_active_zone]

        diff = cv2.absdiff(current_zone, self._day_prev_zone)
        self._day_prev_zone = current_zone

        diff = cv2.GaussianBlur(diff, (5, 5), 0)
        _, thresh = cv2.threshold(diff, DAY_MOTION_THRESH, 255, cv2.THRESH_BINARY)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

        contours, _ = cv2.findContours(
            thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )

        min_area = 320 * 320 * DAY_MOTION_MIN_AREA_RATIO
        results: list[DetDict] = []
        for c in contours:
            area = cv2.contourArea(c)
            if area < min_area:
                continue
            x, y, w, h = cv2.boundingRect(c)
            results.append(
                DetDict(
                    class_name=DetectionClass.MOTION,
                    confidence=min(1.0, area / (320 * 320 * 0.05)),
                    bbox=DetBbox(x=x + zx, y=y + zy, w=w, h=h),
                )
            )
        return results

    def _reset_day_motion(self) -> None:
        """Reset day motion detection state."""
        self._day_prev_zone = None
        self._day_zone_current = None
        self._day_active_zone = -1
        self._day_last_pet_bbox = None
        self._day_pet_seen_at = 0.0

    def _update_adaptive_threshold(self, has_pet: bool) -> None:
        """Lower score_threshold progressively during continuous pet detection."""
        assert self.detector is not None
        now = time.monotonic()
        if has_pet:
            if self._pet_continuous_since == 0.0:
                self._pet_continuous_since = now
            self._pet_last_seen = now
        else:
            if (
                self._pet_last_seen > 0.0
                and (now - self._pet_last_seen) > _ADAPTIVE_GAP_TOLERANCE
            ):
                self._pet_continuous_since = 0.0
                self._pet_last_seen = 0.0
                if self._adaptive_th_active:
                    self.detector.score_threshold = self.score_threshold
                    self.detector.conf_thres_raw = -np.log(1 / self.score_threshold - 1)
                    self._adaptive_th_active = False
                return

        if self._pet_continuous_since == 0.0:
            return

        duration = now - self._pet_continuous_since
        if duration >= 10.0:
            reduction = 0.15
        elif duration >= 6.0:
            reduction = 0.10
        elif duration >= 3.0:
            reduction = 0.05
        else:
            return

        new_th = max(_ADAPTIVE_FLOOR, self.score_threshold - reduction)
        if self.detector.score_threshold != new_th:
            self.detector.score_threshold = new_th
            self.detector.conf_thres_raw = -np.log(1 / new_th - 1)
            self._adaptive_th_active = True

    def _reset_adaptive_threshold(self) -> None:
        """Reset adaptive threshold state (e.g. on camera switch)."""
        assert self.detector is not None
        self._pet_continuous_since = 0.0
        self._pet_last_seen = 0.0
        if self._adaptive_th_active:
            self.detector.score_threshold = self.score_threshold
            self.detector.conf_thres_raw = -np.log(1 / self.score_threshold - 1)
            self._adaptive_th_active = False

    @staticmethod
    def _crop_nv12_to_640(
        nv12_data: np.ndarray,
        width: int,
        height: int,
        cx: int,
        cy: int,
        crop_size: int,
    ) -> tuple[np.ndarray, int, int, int]:
        """Crop a square region from NV12 frame and resize to 640x640.

        Args:
            nv12_data: NV12 buffer (Y + UV planes contiguous)
            width, height: frame dimensions
            cx, cy: crop center in frame coordinates
            crop_size: side length of square crop (before resize)

        Returns:
            (nv12_640, crop_x, crop_y, crop_size) where crop_x/y are clamped origin
        """
        # Clamp crop region to frame bounds, ensure even coordinates for NV12
        half = crop_size // 2
        x0 = max(0, cx - half) & ~1  # even alignment for NV12 chroma
        y0 = max(0, cy - half) & ~1
        x1 = min(width, x0 + crop_size) & ~1
        y1 = min(height, y0 + crop_size) & ~1
        # Re-adjust origin if clamped
        if x1 - x0 < crop_size and x0 > 0:
            x0 = max(0, x1 - crop_size) & ~1
        if y1 - y0 < crop_size and y0 > 0:
            y0 = max(0, y1 - crop_size) & ~1
        cw = x1 - x0
        ch = y1 - y0

        y_plane = nv12_data[: width * height].reshape(height, width)
        uv_plane = nv12_data[width * height :].reshape(height // 2, width)

        # Crop Y and UV
        y_crop = y_plane[y0 : y0 + ch, x0 : x0 + cw]
        uv_crop = uv_plane[y0 // 2 : (y0 + ch) // 2, x0 : x0 + cw]

        # Resize to 640x640
        y_640 = cv2.resize(y_crop, (640, 640), interpolation=cv2.INTER_LINEAR)
        uv_640 = cv2.resize(uv_crop, (640, 320), interpolation=cv2.INTER_LINEAR)

        nv12_640 = np.concatenate([y_640.ravel(), uv_640.ravel()])
        return nv12_640, x0, y0, max(cw, ch)

    def _save_night_frame(
        self, nv12_data: np.ndarray, width: int, height: int, frame_number: int
    ) -> None:
        """Enqueue NV12 frame for async saving (fine-tuning data collection)."""
        try:
            self._save_queue.put_nowait((bytes(nv12_data), width, height, frame_number))
        except queue.Full:
            pass  # Drop if queue full

    def _save_worker(self) -> None:
        """Worker thread: drain the save queue and write frames to disk."""
        while True:
            item = self._save_queue.get()
            if item is None:
                break
            nv12_data, width, height, frame_number = item
            try:
                self.night_collect_dir.mkdir(parents=True, exist_ok=True)
                path = (
                    self.night_collect_dir
                    / f"night_{frame_number:08d}_{width}x{height}.nv12"
                )
                with open(path, "wb") as f:
                    f.write(nv12_data)
                self.night_collect_count += 1
                logger.debug(
                    f"Saved night frame: {path.name} ({self.night_collect_count}/{self.night_collect_max})"
                )
            except Exception as e:
                logger.warning(f"Night frame save failed: {e}")

    def setup(self) -> None:
        """セットアップ"""
        logger.debug("=== YOLO Detector Daemon (Zero-Copy) ===")
        logger.debug(f"Model: {self.model_path}")
        logger.debug(
            f"Score threshold: {self.score_threshold}, NMS threshold: {self.nms_threshold}"
        )

        # Initialize hb_mem module (required)
        if not hb_mem_init():
            raise RuntimeError("hb_mem module initialization failed")
        logger.debug("hb_mem module initialized")

        # 共有メモリを開く
        try:
            # Unified zero-copy SHM (active camera writes here)
            self.shm_zerocopy = ZeroCopySharedMemory(SHM_NAME_YOLO_ZC)
            if not self.shm_zerocopy.open():
                raise RuntimeError(f"Zero-copy SHM not available: {SHM_NAME_YOLO_ZC}")
            logger.debug(f"Connected to zero-copy SHM: {SHM_NAME_YOLO_ZC}")

            # Detection result writer (independent of frame SHM)
            self.detection_writer = DetectionWriter()
            self.detection_writer.open()
            logger.debug("Detection writer opened")
        except Exception as e:
            logger.error(f"Failed to open shared memory: {e}")
            logger.error("Make sure camera daemon is running")
            raise

        # YOLODetectorを初期化
        try:
            self.detector = YoloDetector(
                model_path=self.model_path,
                score_threshold=self.score_threshold,
                nms_threshold=self.nms_threshold,
                auto_download=True,
            )
            logger.info(f"YOLO model loaded: {Path(self.model_path).name}")
        except Exception as e:
            logger.error(f"Failed to load YOLO model: {e}")
            raise

        # HW preprocessor (nano2D letterbox on GPU)
        try:
            from detection.yolo_detector import HWPreprocessor

            hw_prep = HWPreprocessor(self.detector)
            if hw_prep.is_available:
                self.detector.preprocessor = hw_prep
                logger.info("HW preprocessor enabled (nano2D letterbox)")
        except Exception as e:
            logger.debug(f"HW preprocessor init failed: {e}")

    def _open_roi_readers(self) -> None:
        """Open VSE ROI SHM readers for night camera.

        Called lazily on first camera_id=1 frame.  The 2 SHM regions are
        written by the C camera daemon via VSE Ch3-4 (640x640 pre-cropped NV12).
        Falls back gracefully if the SHM is not yet available.
        """
        if self.roi_readers:
            return  # Already opened

        readers = open_roi_readers()  # Returns already-opened readers, or [] on failure
        if not readers:
            logger.warning("ROI SHM not available — night VSE path disabled")
            return

        self.roi_readers = readers
        logger.info(
            f"VSE ROI SHM readers opened: {[r.shm_name for r in self.roi_readers]}"
        )

    def _get_active_zerocopy(self) -> ZeroCopySharedMemory | None:
        return self.shm_zerocopy

    def cleanup(self) -> None:
        """クリーンアップ"""
        if self.shm_zerocopy:
            self.shm_zerocopy.close()
        for reader in self.roi_readers:
            reader.close()
        self.roi_readers = []
        if self.detection_writer:
            self.detection_writer.close()
        if self.stats["frames_processed"] > 0:
            avg_dets = self.stats["total_detections"] / self.stats["frames_processed"]
            logger.info(
                f"Stopped: {self.stats['frames_processed']}f, "
                f"{self.stats['total_detections']}det ({avg_dets:.2f}/f)"
            )

    def signal_handler(self, signum: int, frame: types.FrameType | None) -> None:
        """シグナルハンドラ"""
        self.running = False

    def _start_detect_api(self, port: int | None = None) -> None:
        """Start HTTP /detect endpoint on a background thread.

        Accepts an image URL, downloads the JPEG, runs YOLO detection,
        returns JSON. Designed for ai-pyramid to request detection on
        existing comic images via its photo serve API.

        Shares the same YoloDetector instance as the main SHM loop.
        BPU inference is naturally serialized by the GIL.
        """
        import json
        from http.server import HTTPServer, BaseHTTPRequestHandler
        from urllib.request import urlopen, Request
        from urllib.error import URLError

        if port is None:
            port = int(os.environ.get("PET_CAMERA_DETECT_PORT", "8083"))

        assert self.detector is not None
        detector = self.detector

        class DetectHandler(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path != "/detect":
                    self.send_error(404)
                    return

                try:
                    length = int(self.headers.get("Content-Length", 0))
                    body = json.loads(self.rfile.read(length))
                    image_url = body["image_url"]
                    req_threshold: float | None = body.get("score_threshold")
                except (json.JSONDecodeError, KeyError, Exception) as e:
                    self.send_error(400, str(e))
                    return

                # Download JPEG from image_url
                try:
                    req = Request(image_url, headers={"Accept": "image/jpeg"})
                    with urlopen(req, timeout=10) as resp:
                        jpeg_bytes = resp.read()
                except (URLError, Exception) as e:
                    self.send_error(502, f"Failed to fetch image: {e}")
                    return

                try:
                    nv12, orig_w, orig_h, scale, pad_x, pad_y = jpeg_to_yolo_nv12(
                        jpeg_bytes
                    )
                    # Temporarily override score threshold if requested
                    orig_threshold = detector.score_threshold
                    if req_threshold is not None:
                        detector.score_threshold = float(req_threshold)
                        detector.conf_thres_raw = -np.log(
                            1 / detector.score_threshold - 1
                        )
                    detections = detector.detect_nv12_readonly(nv12, 640, 640)
                    if req_threshold is not None:
                        detector.score_threshold = orig_threshold
                        detector.conf_thres_raw = -np.log(
                            1 / detector.score_threshold - 1
                        )
                    logger.info(
                        f"[detect] {orig_w}x{orig_h} scale={scale:.4f} pad=({pad_x},{pad_y}) th={req_threshold or orig_threshold} dets={len(detections)}"
                    )

                    # Map bbox from 640x640 letterbox back to original image coords
                    result = []
                    for d in detections:
                        x = int((d.bbox.x - pad_x) / scale)
                        y = int((d.bbox.y - pad_y) / scale)
                        w = int(d.bbox.w / scale)
                        h = int(d.bbox.h / scale)
                        x = max(0, x)
                        y = max(0, y)
                        w = min(w, orig_w - x)
                        h = min(h, orig_h - y)
                        result.append(
                            {
                                "class_name": d.class_name.label,
                                "confidence": round(d.confidence, 3),
                                "bbox": {"x": x, "y": y, "w": w, "h": h},
                            }
                        )

                    resp_body = json.dumps(
                        {
                            "detections": result,
                            "width": orig_w,
                            "height": orig_h,
                        }
                    ).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(resp_body)))
                    self.end_headers()
                    self.wfile.write(resp_body)
                except Exception as e:
                    logger.warning(f"Detect API error: {e}")
                    self.send_error(500, str(e))

            def log_message(self, format: str, *args: object) -> None:
                pass  # suppress per-request logging

        def serve():
            try:
                server = HTTPServer(("0.0.0.0", port), DetectHandler)
            except OSError as e:
                logger.error(f"Detect API failed to bind port {port}: {e}")
                return
            server.daemon_threads = True
            logger.info(f"Detect API listening on :{port}")
            server.serve_forever()

        t = threading.Thread(target=serve, daemon=True)
        t.start()

    def _run_day_iteration(
        self,
        nv12_data: np.ndarray,
        zc_frame: object,
        hb_mem_buffer: object,
        is_debug: bool,
    ) -> None:
        """Day path: YOLO → merge → scale → SHM write → day motion → stats."""
        assert self.detector is not None
        assert self.detection_writer is not None
        assert self.scale_x is not None and self.scale_y is not None

        if self.roi_enabled and len(self.roi_regions) > 1:
            current_roi = self.roi_index
            roi_x, roi_y, roi_w, roi_h = self.roi_regions[current_roi]
            detections = self.detector.detect_nv12_roi(
                nv12_data=nv12_data,
                width=zc_frame.width,  # type: ignore[attr-defined]
                height=zc_frame.height,  # type: ignore[attr-defined]
                roi_x=roi_x,
                roi_y=roi_y,
                roi_w=roi_w,
                roi_h=roi_h,
                brightness_avg=zc_frame.brightness_avg,  # type: ignore[attr-defined]
            )
            if current_roi == 0:
                self.cache_frame_number = zc_frame.frame_number  # type: ignore[attr-defined]
                self.cache_timestamp = zc_frame.timestamp_sec  # type: ignore[attr-defined]
            self.roi_index = (self.roi_index + 1) % len(self.roi_regions)
            cycle_complete = self.roi_index == 0
        else:
            detections = self.detector.detect_nv12(
                nv12_data=nv12_data,
                width=zc_frame.width,  # type: ignore[attr-defined]
                height=zc_frame.height,  # type: ignore[attr-defined]
                brightness_avg=zc_frame.brightness_avg,  # type: ignore[attr-defined]
            )
            current_roi = -1
            cycle_complete = True

        # Day motion: crop active zone from Y plane before releasing buffer
        if self.active_camera == 0 and self._day_active_zone >= 0:
            zx, zy, zw, zh = DAY_MOTION_ZONES[self._day_active_zone]
            y_plane = nv12_data[: zc_frame.width * zc_frame.height].reshape(  # type: ignore[attr-defined]
                zc_frame.height,
                zc_frame.width,  # type: ignore[attr-defined]
            )
            self._day_zone_current = y_plane[zy : zy + zh, zx : zx + zw].copy()
        else:
            self._day_zone_current = None

        hb_mem_buffer.release()  # type: ignore[attr-defined]

        timing = self.detector.get_last_timing()

        detection_dicts = [
            DetDict(
                class_name=det.class_name,
                confidence=det.confidence,
                bbox=DetBbox(x=det.bbox.x, y=det.bbox.y, w=det.bbox.w, h=det.bbox.h),
            )
            for det in detections
        ]

        # Night camera ROI mode: accumulate and merge detections
        if self.night_roi_mode and len(self.night_roi_regions) > 0:
            self.detection_cache[current_roi] = detection_dicts
            if cycle_complete:
                all_detections: list[DetDict] = []
                for roi_idx, roi_dets in enumerate(self.detection_cache):
                    all_detections.extend(roi_dets)
                    if roi_dets and is_debug:
                        classes = [d.class_name.label for d in roi_dets]
                        logger.debug(f"  Night ROI {roi_idx}: {classes}")
                if is_debug and all_detections:
                    logger.debug(
                        f"  Night camera: {len(all_detections)} detections before NMS"
                    )
                merged_dicts = apply_cross_roi_nms(all_detections, iou_threshold=0.5)
                merged_dicts = _suppress_dog_with_cat(merged_dicts)
                if is_debug and len(merged_dicts) != len(all_detections):
                    logger.debug(
                        f"  Night camera: {len(all_detections)} -> {len(merged_dicts)} after NMS"
                    )
                scaled_dicts = [
                    DetDict(
                        class_name=d.class_name,
                        confidence=d.confidence,
                        bbox=DetBbox(
                            x=int(d.bbox.x * self.scale_x),
                            y=int(d.bbox.y * self.scale_y),
                            w=int(d.bbox.w * self.scale_x),
                            h=int(d.bbox.h * self.scale_y),
                        ),
                    )
                    for d in merged_dicts
                ]
                if scaled_dicts:
                    self.detection_writer.write_detection_result(
                        frame_number=self.cache_frame_number,
                        timestamp_sec=self.cache_timestamp,
                        detections=[_det_to_dict(d) for d in scaled_dicts],
                    )
                self.detection_cache = [[] for _ in self.detection_cache]
                detection_dicts = scaled_dicts

        # Day camera ROI mode: accumulate and merge detections
        elif self.roi_enabled and len(self.roi_regions) > 1:
            self.detection_cache[current_roi] = detection_dicts
            if cycle_complete:
                all_detections = []
                for roi_idx, roi_dets in enumerate(self.detection_cache):
                    all_detections.extend(roi_dets)
                    if roi_dets and is_debug:
                        classes = [d.class_name.label for d in roi_dets]
                        logger.debug(f"  ROI {roi_idx}: {classes}")
                if is_debug and all_detections:
                    logger.debug(f"  Day ROI: {len(all_detections)} detections")
                merged_dicts = _suppress_dog_with_cat(all_detections)
                scaled_dicts = [
                    DetDict(
                        class_name=d.class_name,
                        confidence=d.confidence,
                        bbox=DetBbox(
                            x=int(d.bbox.x * self.scale_x),
                            y=int(d.bbox.y * self.scale_y),
                            w=int(d.bbox.w * self.scale_x),
                            h=int(d.bbox.h * self.scale_y),
                        ),
                    )
                    for d in merged_dicts
                ]
                if scaled_dicts:
                    self.detection_writer.write_detection_result(
                        frame_number=self.cache_frame_number,
                        timestamp_sec=self.cache_timestamp,
                        detections=[_det_to_dict(d) for d in scaled_dicts],
                    )
                self.detection_cache = [[] for _ in self.roi_regions]
                detection_dicts = scaled_dicts
        else:
            scaled_dicts = [
                DetDict(
                    class_name=d.class_name,
                    confidence=d.confidence,
                    bbox=DetBbox(
                        x=int(d.bbox.x * self.scale_x),
                        y=int(d.bbox.y * self.scale_y),
                        w=int(d.bbox.w * self.scale_x),
                        h=int(d.bbox.h * self.scale_y),
                    ),
                )
                for d in detection_dicts
            ]
            if scaled_dicts:
                self.detection_writer.write_detection_result(
                    frame_number=zc_frame.frame_number,  # type: ignore[attr-defined]
                    timestamp_sec=zc_frame.timestamp_sec,  # type: ignore[attr-defined]
                    detections=[_det_to_dict(d) for d in scaled_dicts],
                )
            detection_dicts = scaled_dicts

        # Adaptive threshold: lower score_threshold during continuous detection
        if cycle_complete:
            has_pet_any = any(d.class_name < PET_BOUNDARY for d in detection_dicts)
            self._update_adaptive_threshold(has_pet_any)

        # Day motion detection: track pet bbox, detect motion when YOLO lost
        if self.active_camera == 0 and cycle_complete:
            has_pet = any(d.class_name < PET_BOUNDARY for d in detection_dicts)
            if has_pet:
                for d in detection_dicts:
                    if d.class_name < PET_BOUNDARY:
                        self._day_last_pet_bbox = DetBbox(
                            x=int(d.bbox.x / self.scale_x),
                            y=int(d.bbox.y / self.scale_y),
                            w=int(d.bbox.w / self.scale_x),
                            h=int(d.bbox.h / self.scale_y),
                        )
                        self._day_pet_seen_at = time.time()
                        self._day_active_zone = self._select_zone(
                            self._day_last_pet_bbox
                        )
                        break
                self._day_prev_zone = None
            elif (
                self._day_last_pet_bbox is not None
                and (time.time() - self._day_pet_seen_at) < DAY_MOTION_TIMEOUT
                and self._day_zone_current is not None
            ):
                motion_dets = self._detect_day_motion(self._day_zone_current)
                if motion_dets:
                    motion_scaled = [
                        DetDict(
                            DetectionClass.MOTION,
                            d.confidence,
                            DetBbox(
                                int(d.bbox.x * self.scale_x),
                                int(d.bbox.y * self.scale_y),
                                int(d.bbox.w * self.scale_x),
                                int(d.bbox.h * self.scale_y),
                            ),
                        )
                        for d in motion_dets
                    ]
                    all_dets = list(detection_dicts) + motion_scaled
                    self.detection_writer.write_detection_result(
                        frame_number=zc_frame.frame_number,  # type: ignore[attr-defined]
                        timestamp_sec=zc_frame.timestamp_sec,  # type: ignore[attr-defined]
                        detections=[_det_to_dict(d) for d in all_dets],
                    )
                    if is_debug:
                        logger.debug(
                            f"  day_motion: zone={self._day_active_zone} "
                            f"contours={len(motion_dets)}"
                        )

        # Stats
        self.stats["frames_processed"] += 1
        self.stats["avg_inference_time_ms"] = timing["total"] * 1000
        for k in ("preprocessing", "inference", "postprocessing"):
            self.stats.setdefault(f"_sum_{k}", 0.0)
            self.stats.setdefault(f"_cnt_{k}", 0)
            self.stats[f"_sum_{k}"] += timing.get(k, 0.0) * 1000
            self.stats[f"_cnt_{k}"] += 1
        if self.night_roi_mode and len(self.night_roi_regions) > 0:
            if cycle_complete:
                self.stats["total_detections"] += len(detection_dicts)
        elif self.roi_enabled and len(self.roi_regions) > 1:
            if cycle_complete:
                self.stats["total_detections"] += len(detection_dicts)
        else:
            self.stats["total_detections"] += len(detections)

        if self.stats["frames_processed"] % 300 == 0:
            clahe_status = "yes" if self.detector.clahe_enabled else "no"
            adapt = (
                f" th={self.detector.score_threshold:.2f}"
                if self._adaptive_th_active
                else ""
            )
            logger.info(
                f"[{self.stats['frames_processed']}f] "
                f"det={self.stats['total_detections']} "
                f"inf={self.stats['avg_inference_time_ms']:.0f}ms "
                f"cam={self.active_camera} "
                f"bright={zc_frame.brightness_avg:.1f} "  # type: ignore[attr-defined]
                f"clahe={clahe_status}{adapt}"
            )

        if is_debug and cycle_complete and detection_dicts:
            classes = ",".join(d.class_name.label for d in detection_dicts)
            logger.debug(f"#{self.stats['frames_processed']}: {classes}")

        # Write score_threshold to JSON for web UI (every 30 frames ≈ 1/sec)
        if self.active_camera == 0 and self.stats["frames_processed"] % 30 == 0:
            try:
                import json as _json

                _json_str = _json.dumps(
                    {
                        "grid": [],
                        "rows": 0,
                        "cols": 0,
                        "base_valid": False,
                        "quiet_frames": 0,
                        "score_threshold": round(self.detector.score_threshold, 3),
                    }
                )
                with open("/tmp/base_diff_grid.json.tmp", "w") as _f:
                    _f.write(_json_str)
                Path("/tmp/base_diff_grid.json.tmp").replace("/tmp/base_diff_grid.json")
            except Exception:
                pass

    def _run_night_iteration(
        self,
        nv12_data: np.ndarray,
        zc_frame: object,
        hb_mem_buffer: object,
        is_debug: bool,
    ) -> None:
        """Night path: motion detection → YOLO → merge → SHM write → stats."""
        import numpy as np

        assert self.detector is not None
        assert self.detection_writer is not None
        assert self.scale_x is not None and self.scale_y is not None

        vse_active = bool(self.roi_readers)
        fp = int(self.stats["frames_processed"])

        # ── Per-frame motion detection on alternating ROI ──────────
        motion_detected_this_frame = False
        _y_denoised_for_base = None
        _rkey_for_base = ""
        if vse_active:
            motion_roi_idx = fp & 1
            motion_reader = self.roi_readers[motion_roi_idx]
            if motion_reader.wait_for_frame(timeout_sec=0.02):
                mf = motion_reader.get_frame()
                if mf is not None:
                    try:
                        m_y_arr, _, m_hb_buf = import_nv12_graph_buf(
                            raw_buf_data=mf.hb_mem_buf_data,
                            expected_plane_sizes=mf.plane_size,
                        )
                        m_y_size = mf.width * mf.height
                        y_plane = m_y_arr[:m_y_size].reshape(mf.height, mf.width)

                        # ROI 0: direct 480×480 center crop from 640×640 VSE output.
                        # NV12 rows are contiguous; ascontiguousarray packs the strided
                        # slice into a contiguous 480×480 buffer for medianBlur.
                        # ROI 1: resize 640×640 → 320×320 (960px sensor crop needs scale).
                        rkey = f"roi{motion_roi_idx}"
                        if motion_roi_idx == 0:
                            _crop_size = 480
                            _crop_x0 = (mf.width - _crop_size) // 2   # = 80
                            _crop_y0 = (mf.height - _crop_size) // 2  # = 80
                            y_small = cv2.medianBlur(
                                np.ascontiguousarray(
                                    y_plane[
                                        _crop_y0 : _crop_y0 + _crop_size,
                                        _crop_x0 : _crop_x0 + _crop_size,
                                    ]
                                ),
                                3,
                            )
                            small_size = _crop_size
                        else:
                            y_small = cv2.resize(
                                cv2.medianBlur(y_plane, 3),
                                (320, 320),
                                interpolation=cv2.INTER_AREA,
                            )
                            small_size = 320
                            _crop_x0 = _crop_y0 = 0  # unused for roi1

                        _y_denoised_for_base = y_small
                        _rkey_for_base = rkey

                        # ── frame_diff ──
                        if rkey in self._prev_roi_small:
                            diff = cv2.absdiff(y_small, self._prev_roi_small[rkey])
                            diff = cv2.GaussianBlur(diff, (5, 5), 0)
                            diff[diff < 8] = 0  # cut IR noise floor

                            # Temporal sum accumulation (uint16, same size as y_small)
                            if rkey not in self._diff_acc:
                                self._diff_acc[rkey] = np.zeros(
                                    (small_size, small_size), dtype=np.uint16
                                )
                            acc = self._diff_acc[rkey]
                            acc >>= 1
                            acc += diff.astype(np.uint16)

                            acc_u8 = cv2.convertScaleAbs(acc)
                            _, thresh = cv2.threshold(
                                acc_u8, 30, 255, cv2.THRESH_BINARY
                            )
                            close_kernel = cv2.getStructuringElement(
                                cv2.MORPH_ELLIPSE, (7, 7)
                            )
                            thresh = cv2.morphologyEx(
                                thresh, cv2.MORPH_CLOSE, close_kernel
                            )
                            contours, _ = cv2.findContours(
                                thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
                            )

                            roi_sx, roi_sy, roi_sw, _ = self.VSE_ROI_REGIONS[motion_roi_idx]
                            small_pixels = small_size * small_size
                            min_area = small_pixels * 0.001
                            for cnt in contours:
                                area = cv2.contourArea(cnt)
                                if area < min_area:
                                    continue
                                bx, by, bw, bh = cv2.boundingRect(cnt)
                                if bw < 5 or bh < 5:
                                    continue
                                motion_detected_this_frame = True
                                if motion_roi_idx == 0:
                                    # ROI 0 is 1:1 crop: pixel → sensor coord via crop offset
                                    _sx = 1280.0 / 1920.0
                                    _sy = 720.0 / 1080.0
                                    x_d = int((bx + _crop_x0 + roi_sx) * _sx)
                                    y_d = int((by + _crop_y0 + roi_sy) * _sy)
                                    w_d = int(bw * _sx)
                                    h_d = int(bh * _sy)
                                else:
                                    # ROI 1: 320→sensor via resize scale = roi_sw/480
                                    ms = roi_sw / 480.0
                                    roi_ox = int(roi_sx * (1280.0 / 1920.0))
                                    roi_oy = int(roi_sy * (720.0 / 1080.0))
                                    x_d = int(bx * ms) + roi_ox
                                    y_d = int(by * ms) + roi_oy
                                    w_d = int(bw * ms)
                                    h_d = int(bh * ms)
                                self._motion_bboxes.append(
                                    DetDict(
                                        class_name=DetectionClass.MOTION,
                                        confidence=min(
                                            1.0, area / (small_pixels * 0.05)
                                        ),
                                        bbox=DetBbox(x=x_d, y=y_d, w=w_d, h=h_d),
                                    )
                                )
                            if len(self._motion_bboxes) > 10:
                                self._motion_bboxes = self._motion_bboxes[-5:]

                        # ── base_diff ──
                        if self._base_valid.get(rkey, False):
                            base_u8 = cv2.convertScaleAbs(self._base_roi_y[rkey])
                            # ROI 0 base is stored at crop size (480×480); no resize needed
                            if motion_roi_idx == 0:
                                small_base = base_u8
                            else:
                                small_base = cv2.resize(
                                    base_u8, (320, 320), interpolation=cv2.INTER_AREA
                                )
                            bdiff_raw = cv2.absdiff(y_small, small_base)
                            bdiff_raw = cv2.GaussianBlur(bdiff_raw, (5, 5), 0)
                            base_noise_floor = max(20, int(self._noise_sigma * 4))
                            bdiff = bdiff_raw.copy()
                            bdiff[bdiff < base_noise_floor] = 0
                            # Mask border (outer ~3%) — IR LED illumination unevenness
                            b = 16
                            bdiff[:b, :] = 0
                            bdiff[-b:, :] = 0
                            bdiff[:, :b] = 0
                            bdiff[:, -b:] = 0
                            nz_ratio = cv2.countNonZero(bdiff) / (small_size * small_size)
                            if nz_ratio > 0.01:
                                motion_detected_this_frame = True
                            if motion_roi_idx == 0:
                                self._feeding_base_nz = nz_ratio
                            if fp % 300 == 0:
                                logger.info(
                                    f"base_diff {rkey}: nz={nz_ratio:.4f} floor={base_noise_floor}"
                                )
                            # 16x16 heatmap grid for web UI
                            grid_arr = cv2.resize(
                                bdiff_raw, (16, 16), interpolation=cv2.INTER_AREA
                            )
                            grid = np.round(
                                grid_arr.astype(np.float32) / 255.0, 3
                            ).tolist()
                            self._roi_grids[rkey] = grid
                            if fp % 10 == 0:  # ~3fps instead of 30fps
                                try:
                                    grid_size = 16
                                    g0 = self._roi_grids.get(
                                        "roi0", [[0.0] * grid_size] * grid_size
                                    )
                                    g1 = self._roi_grids.get(
                                        "roi1", [[0.0] * grid_size] * grid_size
                                    )
                                    combined = [g0[r] + g1[r] for r in range(grid_size)]
                                    _json_str = json.dumps(
                                        {
                                            "grid": combined,
                                            "rows": grid_size,
                                            "cols": grid_size * 2,
                                            "base_valid": True,
                                            "quiet_frames": self._quiet_frames,
                                            "score_threshold": round(
                                                self.detector.score_threshold, 3
                                            ),
                                        }
                                    )
                                    with open(
                                        "/tmp/base_diff_grid.json.tmp", "w"
                                    ) as _f:
                                        _f.write(_json_str)
                                    Path("/tmp/base_diff_grid.json.tmp").replace(
                                        "/tmp/base_diff_grid.json"
                                    )
                                except Exception:
                                    pass

                        self._prev_roi_small[rkey] = y_small
                        m_hb_buf.release()
                    except Exception as e:
                        logger.warning(
                            f"Motion ROI read failed (roi={motion_roi_idx}): {e}"
                        )

        # Track which ROI had motion
        if motion_detected_this_frame and vse_active:
            self._motion_roi_idx = motion_roi_idx  # type: ignore[possibly-undefined]
        elif not motion_detected_this_frame and self.motion_cooldown <= 1:
            self._motion_roi_idx = -1

        # Update motion cooldown
        if motion_detected_this_frame:
            self.motion_cooldown = 8
            self._roi_has_motion = True
            self._quiet_frames = 0
        elif self.motion_cooldown > 0:
            self.motion_cooldown -= 1
            if self.motion_cooldown == 0:
                self._roi_has_motion = False
        else:
            self._quiet_frames += 1

        # ── Base image management (snapshot-based) ─────────
        if _y_denoised_for_base is not None and _rkey_for_base:
            rk = _rkey_for_base
            y_f32 = _y_denoised_for_base.astype(np.float32)

            if not self._base_valid.get(rk, False):
                if self._quiet_frames >= self.BASE_QUIET_THRESHOLD:
                    if rk not in self._base_roi_y:
                        self._base_roi_y[rk] = y_f32.copy()
                        self._base_init_count[rk] = 1
                    else:
                        cv2.accumulateWeighted(
                            _y_denoised_for_base, self._base_roi_y[rk], 0.02
                        )
                        self._base_init_count[rk] = self._base_init_count.get(rk, 0) + 1
                    if self._base_init_count.get(rk, 0) >= self.BASE_INIT_FRAMES:
                        self._base_valid[rk] = True
                        self._snapshot_roi_y[rk] = y_f32.copy()
                        self._snapshot_timer = 0
                        logger.info(f"Base image ready for {rk}")
            else:
                self._snapshot_timer += 1
                if self._snapshot_timer >= self.SNAPSHOT_INTERVAL:
                    self._snapshot_roi_y[rk] = y_f32.copy()
                    self._snapshot_timer = 0

                if rk in self._snapshot_roi_y:
                    snap = self._snapshot_roi_y[rk]
                    snap_u8 = cv2.convertScaleAbs(snap)
                    snap_diff = cv2.absdiff(_y_denoised_for_base, snap_u8)
                    snap_diff = cv2.GaussianBlur(snap_diff, (5, 5), 0)
                    snap_noise_floor = max(20, int(self._noise_sigma * 4))
                    snap_diff[snap_diff < snap_noise_floor] = 0
                    snap_stable = cv2.countNonZero(snap_diff) / snap_diff.size

                    if snap_stable < 0.005:
                        cv2.accumulateWeighted(
                            snap_u8, self._base_roi_y[rk], self.SNAPSHOT_BLEND_ALPHA
                        )

        # Brightness change detection — invalidate base on large ISP shifts
        if (
            self._last_brightness >= 0
            and abs(zc_frame.brightness_avg - self._last_brightness) > 20
        ):  # type: ignore[attr-defined]
            self._base_roi_y.clear()
            self._base_valid.clear()
            self._base_init_count.clear()
            self._snapshot_roi_y.clear()
            self._quiet_frames = 0
            self._snapshot_timer = 0
            logger.info("Base images cleared (brightness change)")
        self._last_brightness = zc_frame.brightness_avg  # type: ignore[attr-defined]

        # ── Feeding zone event tracking (ROI 0) ─────────────────────
        if vse_active and self._base_valid.get("roi0", False):
            feeding_active = self._feeding_base_nz > self.FEEDING_MOTION_THRESH
            now = time.time()

            if feeding_active:
                self._feeding_quiet_count = 0
                self._feeding_save_counter += 1
                if not self._feeding_motion:
                    self._feeding_motion = True
                    self._feeding_event_start = now
                    logger.info(
                        f"Feeding zone: motion started (nz={self._feeding_base_nz:.4f})"
                    )
                # Save full 1280x720 frame at FEEDING_SAVE_INTERVAL
                if self._feeding_save_counter >= self.FEEDING_SAVE_INTERVAL:
                    self._feeding_save_counter = 0
                    fn = int(zc_frame.frame_number)  # type: ignore[attr-defined]
                    # Capture current motion bboxes as bbox candidates
                    self._feeding_last_motion_bboxes = list(self._motion_bboxes)
                    try:
                        self.feeding_collect_dir.mkdir(parents=True, exist_ok=True)
                        nv12_path = (
                            self.feeding_collect_dir
                            / f"feeding_{fn:08d}_1280x720.nv12"
                        )
                        with open(nv12_path, "wb") as _f:
                            _f.write(bytes(nv12_data))
                        # Save motion bbox annotations as sidecar JSON
                        anno = {
                            "frame": fn,
                            "timestamp": now,
                            "width": 1280,
                            "height": 720,
                            "nz_ratio": round(self._feeding_base_nz, 4),
                            "motion_bboxes": [
                                {
                                    "x": d.bbox.x,
                                    "y": d.bbox.y,
                                    "w": d.bbox.w,
                                    "h": d.bbox.h,
                                }
                                for d in self._feeding_last_motion_bboxes
                            ],
                        }
                        anno_path = nv12_path.with_suffix(".json")
                        with open(anno_path, "w") as _af:
                            json.dump(anno, _af)
                        logger.debug(f"Feeding frame saved: {nv12_path.name}")
                    except Exception as _e:
                        logger.warning(f"Feeding frame save failed: {_e}")
            else:
                if self._feeding_motion:
                    self._feeding_quiet_count += 1
                    if self._feeding_quiet_count >= self.FEEDING_QUIET_GAP:
                        # Event ended
                        duration = now - (self._feeding_event_start or now)
                        event = {
                            "start": round(self._feeding_event_start or now, 3),
                            "end": round(now, 3),
                            "duration_sec": round(duration, 2),
                        }
                        try:
                            with open(self.feeding_events_path, "a") as _ef:
                                _ef.write(json.dumps(event) + "\n")
                        except Exception as _e:
                            logger.warning(f"Feeding event write failed: {_e}")
                        logger.info(
                            f"Feeding zone: motion ended ({duration:.1f}s)"
                        )
                        self._feeding_motion = False
                        self._feeding_event_start = None
                        self._feeding_quiet_count = 0
                        self._feeding_save_counter = 0

        # ── YOLO: both ROIs in one frame (every 2nd frame) ─────────
        run_yolo = (
            vse_active
            and ((fp & 1) == 0)
            and (self.motion_cooldown > 0 or self._roi_has_motion)
        )
        if not run_yolo:
            self.stats["yolo_skipped_frames"] = (
                self.stats.get("yolo_skipped_frames", 0) + 1
            )

        all_yolo_dicts: list[DetDict] = []
        roi_hb_bufs: list[object] = []

        use_focus_crop = (
            run_yolo
            and self._focus_crop_enabled
            and self._motion_roi_idx >= 0
            and len(self._motion_bboxes) > 0
        )

        if run_yolo:
            self.cache_frame_number = zc_frame.frame_number  # type: ignore[attr-defined]
            self.cache_timestamp = zc_frame.timestamp_sec  # type: ignore[attr-defined]

            roi_indices = (
                [self._motion_roi_idx]
                if use_focus_crop
                else list(range(len(self.roi_readers)))
            )

            for roi_idx in roi_indices:
                roi_reader = self.roi_readers[roi_idx]
                roi_hb_buf = None
                if not roi_reader.wait_for_frame(timeout_sec=0.05):
                    logger.debug(f"VSE ROI SHM timeout (roi={roi_idx})")
                    continue
                roi_frame = roi_reader.get_frame()
                if roi_frame is None:
                    continue
                try:
                    roi_y_arr, roi_uv_arr, roi_hb_buf = import_nv12_graph_buf(
                        raw_buf_data=roi_frame.hb_mem_buf_data,
                        expected_plane_sizes=roi_frame.plane_size,
                    )
                    roi_hb_bufs.append(roi_hb_buf)
                except Exception as e:
                    logger.warning(f"VSE ROI SHM import failed (roi={roi_idx}): {e}")
                    if roi_hb_buf is not None:
                        roi_hb_buf.release()
                    continue

                roi_y_size = roi_frame.width * roi_frame.height
                if len(roi_y_arr) == roi_y_size + len(roi_uv_arr):
                    roi_nv12 = roi_y_arr
                else:
                    roi_nv12 = np.concatenate([roi_y_arr, roi_uv_arr])
                detections = self.detector.detect_nv12(
                    nv12_data=roi_nv12,
                    width=roi_frame.width,
                    height=roi_frame.height,
                    brightness_avg=roi_frame.brightness_avg,
                    clahe_cache_key=f"roi{roi_idx}",
                )

                roi_sx, roi_sy, roi_sw, _ = self.VSE_ROI_REGIONS[roi_idx]
                roi_ox = int(roi_sx * (1280.0 / 1920.0))
                roi_oy = int(roi_sy * (720.0 / 1080.0))
                # 640x640 → 1280x720: scale = roi_sw / 960.0
                det_scale = roi_sw / 960.0
                for det in detections:
                    all_yolo_dicts.append(
                        DetDict(
                            class_name=det.class_name,
                            confidence=det.confidence,
                            bbox=DetBbox(
                                x=int(det.bbox.x * det_scale) + roi_ox,
                                y=int(det.bbox.y * det_scale) + roi_oy,
                                w=int(det.bbox.w * det_scale),
                                h=int(det.bbox.h * det_scale),
                            ),
                        )
                    )

            # ── Focus crop: YOLO on Ch1 crop centered on motion ──
            if use_focus_crop:
                try:
                    best_bbox = max(
                        self._motion_bboxes,
                        key=lambda d: d.bbox.w * d.bbox.h,
                    )
                    mcx = best_bbox.bbox.x + best_bbox.bbox.w // 2
                    mcy = best_bbox.bbox.y + best_bbox.bbox.h // 2
                    motion_size = max(best_bbox.bbox.w, best_bbox.bbox.h)
                    crop_size = min(720, max(360, int(motion_size * 1.5))) & ~1

                    fc_nv12, fc_x, fc_y, fc_sz = self._crop_nv12_to_640(
                        nv12_data,
                        zc_frame.width,
                        zc_frame.height,  # type: ignore[attr-defined]
                        mcx,
                        mcy,
                        crop_size,
                    )
                    fc_detections = self.detector.detect_nv12(
                        nv12_data=fc_nv12,
                        width=640,
                        height=640,
                        brightness_avg=zc_frame.brightness_avg,  # type: ignore[attr-defined]
                        clahe_cache_key="focus_crop",
                    )
                    fc_scale = fc_sz / 640.0
                    for det in fc_detections:
                        all_yolo_dicts.append(
                            DetDict(
                                class_name=det.class_name,
                                confidence=det.confidence,
                                bbox=DetBbox(
                                    x=int(det.bbox.x * fc_scale) + fc_x,
                                    y=int(det.bbox.y * fc_scale) + fc_y,
                                    w=int(det.bbox.w * fc_scale),
                                    h=int(det.bbox.h * fc_scale),
                                ),
                            )
                        )
                    fc_classes = (
                        ",".join(d.class_name.label for d in fc_detections) or "none"
                    )
                    logger.debug(
                        f"focus_crop: roi={self._motion_roi_idx} "
                        f"center=({mcx},{mcy}) size={fc_sz} "
                        f"det={fc_classes}"
                    )
                except Exception as e:
                    logger.debug(f"Focus crop failed: {e}")

            for buf in roi_hb_bufs:
                buf.release()  # type: ignore[attr-defined]

        if run_yolo:
            merged_yolo = apply_cross_roi_nms(all_yolo_dicts, iou_threshold=0.5)
            merged_yolo = [
                d for d in merged_yolo if d.class_name not in self.night_fp_classes
            ]
            merged_yolo = _suppress_dog_with_cat(merged_yolo)

            if merged_yolo:
                self.motion_cooldown = 10
                self._roi_has_motion = True
                self._quiet_frames = 0

            all_dicts = self._motion_bboxes + merged_yolo
            self._motion_bboxes = []

            scaled_dicts = [
                DetDict(
                    class_name=d.class_name,
                    confidence=d.confidence,
                    bbox=DetBbox(
                        x=int(d.bbox.x * self.scale_x),
                        y=int(d.bbox.y * self.scale_y),
                        w=int(d.bbox.w * self.scale_x),
                        h=int(d.bbox.h * self.scale_y),
                    ),
                )
                for d in all_dicts
            ]

            if self.night_assist_merger:
                # Separate motion and YOLO detections for the merger
                motion_dicts = [d for d in scaled_dicts if d.class_name is DetectionClass.MOTION]
                yolo_dicts = [d for d in scaled_dicts if d.class_name is not DetectionClass.MOTION]
                merged = self.night_assist_merger.merge(motion_dicts, yolo_dicts)
                if merged:
                    scaled_dicts = merged

            if scaled_dicts:
                self.detection_writer.write_detection_result(
                    frame_number=self.cache_frame_number,
                    timestamp_sec=self.cache_timestamp,
                    detections=[_det_to_dict(d) for d in scaled_dicts],
                )

            detection_dicts = scaled_dicts
        else:
            # Non-YOLO frame: ai-pyramid detections alone can still trigger SHM write
            if self.night_assist_merger:
                merged = self.night_assist_merger.merge(self._motion_bboxes, [])
                self._motion_bboxes = []
                if merged:
                    self.detection_writer.write_detection_result(
                        frame_number=self.cache_frame_number,
                        timestamp_sec=self.cache_timestamp,
                        detections=[_det_to_dict(d) for d in merged],
                    )
                    detection_dicts = merged
                else:
                    detection_dicts = []
            else:
                detection_dicts = []

        # Adaptive threshold
        if run_yolo:
            has_pet_any = any(d.class_name < PET_BOUNDARY for d in detection_dicts)
            self._update_adaptive_threshold(has_pet_any)

        # Stats
        self.stats["frames_processed"] += 1
        timing = self.detector.get_last_timing()
        self.stats["avg_inference_time_ms"] = timing["total"] * 1000
        if run_yolo:
            for k in ("preprocessing", "inference", "postprocessing"):
                self.stats.setdefault(f"_sum_{k}", 0.0)
                self.stats.setdefault(f"_cnt_{k}", 0)
                self.stats[f"_sum_{k}"] += timing.get(k, 0.0) * 1000
                self.stats[f"_cnt_{k}"] += 1
        if run_yolo:
            for d in detection_dicts:
                if d.class_name is DetectionClass.MOTION:
                    self.stats["total_mot"] = self.stats.get("total_mot", 0) + 1
                else:
                    self.stats["total_yolo"] = self.stats.get("total_yolo", 0) + 1
            self.stats["total_detections"] += len(detection_dicts)

        if self.stats["frames_processed"] % 300 == 0:
            t_mot = self.stats.get("total_mot", 0)
            t_yolo = self.stats.get("total_yolo", 0)
            logger.info(
                f"[{self.stats['frames_processed']}f] "
                f"det={self.stats['total_detections']}(mot={t_mot},yolo={t_yolo}) "
                f"inf={self.stats['avg_inference_time_ms']:.0f}ms "
                f"cam={self.active_camera} "
                f"bright={zc_frame.brightness_avg:.1f} "  # type: ignore[attr-defined]
                f"yolo_skipped={self.stats['yolo_skipped_frames']} "
                f"quiet={self._quiet_frames}"
                f"{'(T2)' if self._quiet_frames >= self.IDLE_TIER2_FRAMES else '(T1)' if self._quiet_frames >= self.IDLE_TIER1_FRAMES else ''} "
                f"base={'|'.join(k for k, v in self._base_valid.items() if v) or 'none'}"
            )

        if is_debug and run_yolo and detection_dicts:
            classes = ",".join(d.class_name.label for d in detection_dicts)
            logger.debug(f"#{self.stats['frames_processed']}: {classes}")

        # Release Ch1 buffer
        hb_mem_buffer.release()  # type: ignore[attr-defined]

    def _handle_camera_switch(self, zc_frame: object) -> None:
        """Detect camera switch, reconfigure ROI/scale, initialize on first frame."""
        assert self.detector is not None
        camera_id = zc_frame.camera_id  # type: ignore[attr-defined]
        if camera_id != self.active_camera:
            if camera_id == 0:  # Day: 640x360 → 1280x720
                self.scale_x = 2.0
                self.scale_y = 2.0
                self.night_roi_mode = False
                self.night_roi_regions = []
                self.roi_enabled = False
                self.roi_index = 0
                self.detection_cache = []
                self.detector.score_threshold = self.score_threshold
                logger.debug(
                    f"Camera switched to {camera_id} [day camera letterbox mode]"
                )
            else:  # Night: 1280x720 → 1280x720
                self.scale_x = 1.0
                self.scale_y = 1.0
                self.night_roi_mode = True
                self.night_roi_regions = self.detector.get_roi_regions_720p()
                self.roi_enabled = False
                self.roi_index = 0
                self.detector.score_threshold = max(0.25, self.score_threshold - 0.15)
                self._open_roi_readers()
                active_roi_count = len(self.roi_readers)
                self.detection_cache = [[] for _ in range(active_roi_count)]
                logger.debug(
                    f"Camera switched to {camera_id} [night ROI mode: {active_roi_count} VSE regions, score_th={self.detector.score_threshold:.2f}]"
                )

            self.active_camera = camera_id
            self._reset_adaptive_threshold()
            self.detector.clahe_enabled = self.active_camera == 1
            self.detector.clahe_frequency = 6 if self.active_camera == 1 else 1
            if self.active_camera == 0:
                self.detector.clear_clahe_cache()
            self._base_roi_y.clear()
            self._base_valid.clear()
            self._base_init_count.clear()
            self._snapshot_roi_y.clear()
            self._quiet_frames = 0
            self._snapshot_timer = 0
            self._prev_roi_small.clear()
            self._diff_acc.clear()
            self._last_brightness = -1.0
            self._reset_day_motion()

        # Initialize scale factors on first frame
        if self.scale_x is None or self.scale_y is None:
            if camera_id == 0:
                self.scale_x = 2.0
                self.scale_y = 2.0
            else:
                self.scale_x = 1.0
                self.scale_y = 1.0
                self.detector.score_threshold = max(0.25, self.score_threshold - 0.15)
            logger.debug(
                f"Initial scale for camera {camera_id}: ({self.scale_x:.3f}, {self.scale_y:.3f}), score_th={self.detector.score_threshold}"
            )

        # Initialize ROI regions on first frame
        if self.stats["frames_processed"] == 0:
            logger.debug(
                f"YOLO input: {zc_frame.width}x{zc_frame.height}, camera_id={zc_frame.camera_id}"
            )  # type: ignore[attr-defined]

            if (
                zc_frame.camera_id == 1
                and zc_frame.width == 1280
                and zc_frame.height == 720
            ):  # type: ignore[attr-defined]
                self.night_roi_mode = True
                self.night_roi_regions = self.detector.get_roi_regions_720p()
                self.roi_index = 0
                self._open_roi_readers()
                active_roi_count = len(self.roi_readers)
                self.detection_cache = [[] for _ in range(active_roi_count)]
                logger.debug(f"Night camera ROI mode: {active_roi_count} VSE regions")
            else:
                self.night_roi_mode = False
                self.roi_regions = self.detector.get_roi_regions(
                    zc_frame.width,
                    zc_frame.height,  # type: ignore[attr-defined]
                )
                if len(self.roi_regions) > 1:
                    logger.debug(f"Day ROI mode: {len(self.roi_regions)} regions")
                    self.detection_cache = [[] for _ in self.roi_regions]
                else:
                    logger.debug("ROI mode disabled: single region")
                    self.roi_enabled = False

    def _frame_iter(self) -> Iterator[FrameData]:
        """Yield valid NV12 frames from zero-copy SHM.

        Handles: no active SHM, semaphore timeout, invalid frame,
        plane_cnt validation, and NV12 import errors.
        """
        import numpy as np

        while self.running:
            # Idle throttle — night mode only, no hb_mem held during sleep
            if self.night_roi_mode and self._quiet_frames >= self.IDLE_TIER1_FRAMES:
                if self._quiet_frames >= self.IDLE_TIER2_FRAMES:
                    time.sleep(self.IDLE_TIER2_SLEEP)
                else:
                    time.sleep(self.IDLE_TIER1_SLEEP)

            hb_mem_buffer = None

            active_zc = self._get_active_zerocopy()
            if active_zc is None:
                time.sleep(0.01)
                continue

            if not active_zc.wait_for_frame(timeout_sec=0.1):
                continue

            zc_frame = active_zc.get_frame()
            if zc_frame is None:
                continue

            if zc_frame.plane_cnt != 2:
                if zc_frame.plane_cnt == 0:
                    logger.debug("Frame not ready yet (plane_cnt=0), skipping")
                else:
                    logger.warning(
                        f"Unexpected plane_cnt={zc_frame.plane_cnt}, skipping"
                    )
                continue

            try:
                y_arr, uv_arr, hb_mem_buffer = import_nv12_graph_buf(
                    raw_buf_data=zc_frame.hb_mem_buf_data,
                    expected_plane_sizes=zc_frame.plane_size,
                )
                y_size = zc_frame.width * zc_frame.height
                if len(y_arr) == y_size + len(uv_arr):
                    nv12_data = y_arr  # zero-copy view
                else:
                    nv12_data = np.concatenate([y_arr, uv_arr])
                if self.detector is not None and hasattr(
                    self.detector.preprocessor, "set_hb_mem_buffer"
                ):
                    self.detector.preprocessor.set_hb_mem_buffer(hb_mem_buffer)  # type: ignore[union-attr]
            except Exception as e:
                logger.error(f"Zero-copy import failed: {e}")
                if hb_mem_buffer:
                    hb_mem_buffer.release()
                continue

            yield FrameData(zc_frame, nv12_data, hb_mem_buffer)

    def run(self) -> int:
        """メインループ"""
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)

        # Async night frame save queue + worker thread
        self._save_queue: queue.Queue[tuple[bytes, int, int, int] | None] = queue.Queue(
            maxsize=10
        )
        self._save_thread = threading.Thread(target=self._save_worker, daemon=True)
        self._save_thread.start()

        # HTTP detection API (separate thread, PET_CAMERA_DETECT_PORT or 8083)
        self._start_detect_api()

        logger.debug("Starting detection loop")

        try:
            is_debug = logger.isEnabledFor(logging.DEBUG)

            for frame_data in self._frame_iter():
                zc_frame = frame_data.zc_frame
                nv12_data = frame_data.nv12_data
                hb_mem_buffer = frame_data.hb_mem_buffer

                self._handle_camera_switch(zc_frame)

                # Run detection
                if self.night_roi_mode:
                    self._run_night_iteration(
                        nv12_data, zc_frame, hb_mem_buffer, is_debug
                    )
                    continue

                else:
                    self._run_day_iteration(
                        nv12_data, zc_frame, hb_mem_buffer, is_debug
                    )

        except KeyboardInterrupt:
            pass  # Normal shutdown
        except Exception as e:
            logger.error(f"Error in detection loop: {e}")
            import traceback

            traceback.print_exc()
            return 1

        return 0


def main() -> int:
    """エントリーポイント"""
    import argparse

    parser = argparse.ArgumentParser(description="YOLO Detector Daemon (Zero-Copy)")
    parser.add_argument(
        "--model-path",
        type=str,
        default="/tmp/yolo_models/yolov13n_detect_bayese_640x640_nv12.bin",
        help="Path to YOLO model (default: YOLOv13n)",
    )
    parser.add_argument(
        "--score-threshold",
        type=float,
        default=0.4,
        help="Detection score threshold (default: 0.4)",
    )
    parser.add_argument(
        "--nms-threshold",
        type=float,
        default=0.7,
        help="NMS IoU threshold (default: 0.7)",
    )
    parser.add_argument(
        "--log-level",
        type=str,
        default="info",
        choices=["debug", "info", "warn", "error"],
        help="Log level (default: info)",
    )
    parser.add_argument(
        "--no-roi",
        action="store_true",
        help="Disable ROI mode (process full frame with resize)",
    )
    args = parser.parse_args()

    log_levels = {
        "debug": logging.DEBUG,
        "info": logging.INFO,
        "warn": logging.WARNING,
        "error": logging.ERROR,
    }
    log_level = log_levels[args.log_level]

    logger.setLevel(log_level)
    yolo_logger.setLevel(log_level)

    daemon = YoloDetectorDaemon(
        model_path=args.model_path,
        score_threshold=args.score_threshold,
        nms_threshold=args.nms_threshold,
    )

    # Apply CLI options
    if args.no_roi:
        daemon.roi_enabled = False
        logger.info("ROI mode disabled via --no-roi flag")

    # Night-assist merger: auto-enable from PET_ALBUM_HOST / PET_ALBUM_PORT env vars
    pet_album_host = os.environ.get("PET_ALBUM_HOST", "")
    if pet_album_host:
        pet_album_port = os.environ.get("PET_ALBUM_PORT", "8082")
        ai_pyramid_url = f"https://{pet_album_host}:{pet_album_port}"
        daemon.night_assist_merger = NightAssistMerger(ai_pyramid_url)
        logger.info(f"Night-assist merger enabled: {ai_pyramid_url}")

    try:
        daemon.setup()
        return daemon.run()
    except Exception as e:
        logger.error(f"Daemon failed: {e}")
        import traceback

        traceback.print_exc()
        return 1
    finally:
        daemon.cleanup()


if __name__ == "__main__":
    sys.exit(main())
