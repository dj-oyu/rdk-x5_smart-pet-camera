#!/usr/bin/env python3
"""
yolo_detector_daemon.py - YOLO detector daemon with zero-copy VIO buffer sharing

Reads NV12 frames via zero-copy shared memory (hb_mem share_id) and writes
YOLO detection results to detection shared memory.
"""

import sys
import time
import signal
import logging
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

from real_shared_memory import (
    DetectionWriter,
    ZeroCopySharedMemory,
    CameraControlSharedMemory,
    SHM_NAME_ZEROCOPY_DAY,
    SHM_NAME_ZEROCOPY_NIGHT,
)
from detection.yolo_detector import YoloDetector

# hb_mem bindings (required for zero-copy)
from hb_mem_bindings import init_module as hb_mem_init, import_nv12_graph_buf

# ロガー設定（後でmain()で上書きされる）
logging.basicConfig(
    level=logging.ERROR,
    format="[%(asctime)s.%(msecs)03d] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("YOLODetectorDaemon")
yolo_logger = logging.getLogger("detection.yolo_detector")


def apply_cross_roi_nms(
    detections: list[dict], iou_threshold: float = 0.5  # type: ignore[type-arg]
) -> list[dict]:  # type: ignore[type-arg]
    """
    Cross-ROI NMS: cv2.dnn.NMSBoxesを使用して異なるROI間の重複検出を除去

    Args:
        detections: 検出結果リスト [{class_name, confidence, bbox: {x,y,w,h}}, ...]
        iou_threshold: IoU閾値（これ以上重なっていれば重複とみなす）

    Returns:
        重複除去後の検出結果リスト
    """
    if len(detections) <= 1:
        return detections

    # クラス別にグループ化
    by_class: dict[str, list[dict]] = {}  # type: ignore[type-arg]
    for det in detections:
        cls = str(det["class_name"])
        if cls not in by_class:
            by_class[cls] = []
        by_class[cls].append(det)

    result: list[dict] = []  # type: ignore[type-arg]
    for dets in by_class.values():
        # cv2.dnn.NMSBoxes用にデータを準備
        bboxes = [[d["bbox"]["x"], d["bbox"]["y"], d["bbox"]["w"], d["bbox"]["h"]] for d in dets]
        scores = [float(d["confidence"]) for d in dets]

        # NMS適用 (score_threshold=0でフィルタリングなし、iou_thresholdで重複除去)
        indices = cv2.dnn.NMSBoxes(bboxes, scores, score_threshold=0.0, nms_threshold=iou_threshold)

        # 残ったインデックスの検出を追加
        for idx in indices:
            result.append(dets[idx])

    return result


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
        self.shm_zerocopy_day: ZeroCopySharedMemory | None = (
            None  # DAY camera zero-copy
        )
        self.shm_zerocopy_night: ZeroCopySharedMemory | None = (
            None  # NIGHT camera zero-copy
        )
        self.shm_control: CameraControlSharedMemory | None = (
            None  # Camera control (active index)
        )
        self.active_camera: int = 0  # Currently active camera (0=DAY, 1=NIGHT)

        # YOLODetector
        self.detector: YoloDetector | None = None

        # 統計情報
        self.stats = {
            "frames_processed": 0,
            "total_detections": 0,
            "avg_inference_time_ms": 0.0,
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
        self.night_roi_regions: list[tuple[int, int, int, int]] = []  # 3 ROIs for 720p

        # Detection result cache for temporal integration
        self.detection_cache: list[list[dict]] = []  # [roi_0_dets, roi_1_dets, ...]
        self.cache_frame_number: int = -1  # Frame number when cache started
        self.cache_timestamp: float = 0.0  # Timestamp when cache started

        # Night motion detection state
        self.prev_y_plane: np.ndarray | None = None  # Previous Y plane for frame diff
        self.motion_cooldown: int = 0  # Frames to skip after motion detected

        # Night YOLO false positive filter (IR images cause frequent misdetections)
        self.night_fp_classes = {"toilet", "sink", "suitcase", "chair"}

        # Night frame collection for future fine-tuning
        self.night_collect_dir = Path("/tmp/night_collect")
        self.night_collect_count: int = 0
        self.night_collect_max: int = 500  # Max frames to collect per session
        self.night_collect_interval: int = 150  # Collect every N frames during motion

    def _save_night_frame(self, nv12_data, width: int, height: int, frame_number: int) -> None:
        """Save NV12 frame for future fine-tuning data collection."""
        try:
            self.night_collect_dir.mkdir(parents=True, exist_ok=True)
            path = self.night_collect_dir / f"night_{frame_number:08d}_{width}x{height}.nv12"
            with open(path, "wb") as f:
                f.write(bytes(nv12_data))
            self.night_collect_count += 1
            logger.debug(f"Saved night frame: {path.name} ({self.night_collect_count}/{self.night_collect_max})")
        except Exception as e:
            logger.warning(f"Failed to save night frame: {e}")

    def setup(self) -> None:
        """セットアップ"""
        logger.debug("=== YOLO Detector Daemon (Zero-Copy) ===")
        logger.debug(f"Model: {self.model_path}")
        logger.debug(f"Score threshold: {self.score_threshold}, NMS threshold: {self.nms_threshold}")

        # Initialize hb_mem module (required)
        if not hb_mem_init():
            raise RuntimeError("hb_mem module initialization failed")
        logger.debug("hb_mem module initialized")

        # 共有メモリを開く
        try:
            # CameraControl SHM (to determine active camera)
            self.shm_control = CameraControlSharedMemory()
            if self.shm_control.open():
                self.active_camera = self.shm_control.get_active()
                logger.debug(f"CameraControl SHM opened, active camera: {self.active_camera}")
            else:
                logger.debug("CameraControl SHM not available, defaulting to DAY camera")

            # Per-camera zero-copy SHMs (Phase 2)
            self.shm_zerocopy_day = ZeroCopySharedMemory(SHM_NAME_ZEROCOPY_DAY)
            self.shm_zerocopy_night = ZeroCopySharedMemory(SHM_NAME_ZEROCOPY_NIGHT)

            day_ok = self.shm_zerocopy_day.open()
            night_ok = self.shm_zerocopy_night.open()

            if not day_ok and not night_ok:
                raise RuntimeError(
                    f"Zero-copy SHM not available: {SHM_NAME_ZEROCOPY_DAY} and {SHM_NAME_ZEROCOPY_NIGHT}"
                )

            if day_ok:
                logger.debug(f"Connected to DAY zero-copy: {SHM_NAME_ZEROCOPY_DAY}")
            if night_ok:
                logger.debug(f"Connected to NIGHT zero-copy: {SHM_NAME_ZEROCOPY_NIGHT}")

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

    def _get_active_zerocopy(self) -> ZeroCopySharedMemory | None:
        """Get the ZeroCopy SHM for the currently active camera."""
        if self.shm_control:
            self.active_camera = self.shm_control.get_active()
        if self.active_camera == 0 and self.shm_zerocopy_day:
            return self.shm_zerocopy_day
        if self.active_camera == 1 and self.shm_zerocopy_night:
            return self.shm_zerocopy_night
        # Fallback: return whichever is available
        return self.shm_zerocopy_day or self.shm_zerocopy_night

    def cleanup(self) -> None:
        """クリーンアップ"""
        if self.shm_zerocopy_day:
            self.shm_zerocopy_day.close()
        if self.shm_zerocopy_night:
            self.shm_zerocopy_night.close()
        if self.shm_control:
            self.shm_control.close()
        if self.detection_writer:
            self.detection_writer.close()
        if self.stats["frames_processed"] > 0:
            avg_dets = self.stats["total_detections"] / self.stats["frames_processed"]
            logger.info(
                f"Stopped: {self.stats['frames_processed']}f, "
                f"{self.stats['total_detections']}det ({avg_dets:.2f}/f)"
            )

    def signal_handler(self, signum, frame) -> None:
        """シグナルハンドラ"""
        self.running = False

    def run(self) -> int:
        """メインループ"""
        import numpy as np

        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)

        logger.debug("Starting detection loop")

        try:
            import time as time_module

            is_debug = logger.isEnabledFor(logging.DEBUG)

            while self.running:
                if is_debug:
                    loop_start = time_module.perf_counter()

                hb_mem_buffer = None

                # Get frame from active camera's zero-copy SHM
                active_zc = self._get_active_zerocopy()
                if active_zc is None:
                    time.sleep(0.01)
                    continue

                # Wait for new frame with semaphore (replaces sleep polling)
                if not active_zc.wait_for_frame(timeout_sec=0.1):
                    # Timeout - check for camera switch and continue
                    continue

                zc_frame = active_zc.get_frame()
                if zc_frame is None:
                    continue

                # Validate plane_cnt (graceful handling instead of exception)
                if zc_frame.plane_cnt != 2:
                    if zc_frame.plane_cnt == 0:
                        logger.debug("Frame not ready yet (plane_cnt=0), skipping")
                    else:
                        logger.warning(
                            f"Unexpected plane_cnt={zc_frame.plane_cnt}, skipping"
                        )
                    active_zc.mark_consumed()
                    continue

                try:

                    # Import VIO buffer via raw hb_mem_graphic_buf_t bytes
                    y_arr, uv_arr, hb_mem_buffer = import_nv12_graph_buf(
                        raw_buf_data=zc_frame.hb_mem_buf_data,
                        expected_plane_sizes=zc_frame.plane_size,
                    )
                    nv12_data = np.concatenate([y_arr, uv_arr])
                except Exception as e:
                    logger.error(f"Zero-copy import failed: {e}")
                    if hb_mem_buffer:
                        hb_mem_buffer.release()
                    active_zc.mark_consumed()
                    continue

                # CLAHE is only for night (IR) camera
                self.detector.clahe_enabled = (self.active_camera == 1)

                # Check for camera switch via semaphore (non-blocking)
                if self.shm_control and self.shm_control.try_wait_switch():
                    camera_id = self.shm_control.get_active()
                    # Use fixed scale factors based on camera type
                    # Output is always H.264 1280x720
                    if camera_id == 0:  # Day: 640x360 → 1280x720
                        self.scale_x = 2.0
                        self.scale_y = 2.0
                        # Disable night ROI mode, use letterbox
                        self.night_roi_mode = False
                        self.night_roi_regions = []
                        self.roi_enabled = False
                        self.roi_index = 0
                        self.detection_cache = []
                        # Restore original score_threshold for day camera
                        self.detector.score_threshold = self.score_threshold
                        logger.debug(f"Camera switched to {camera_id} [day camera letterbox mode]")
                    else:  # Night: 1280x720 → 1280x720
                        self.scale_x = 1.0
                        self.scale_y = 1.0
                        # Enable night ROI mode with 3 overlapping regions
                        self.night_roi_mode = True
                        self.night_roi_regions = self.detector.get_roi_regions_720p()
                        self.roi_enabled = False
                        self.roi_index = 0
                        self.detection_cache = [[] for _ in self.night_roi_regions]
                        # Lower score_threshold for night camera (darker images = lower confidence)
                        self.detector.score_threshold = max(0.25, self.score_threshold - 0.15)
                        logger.debug(f"Camera switched to {camera_id} [night ROI mode: {len(self.night_roi_regions)} regions, score_th={self.detector.score_threshold:.2f}]")

                # Initialize scale factors on first frame (before any switch)
                if self.scale_x is None or self.scale_y is None:
                    # Use fixed scale factors based on camera type
                    if camera_id == 0:  # Day: 640x360 → 1280x720
                        self.scale_x = 2.0
                        self.scale_y = 2.0
                    else:  # Night: 1280x720 → 1280x720
                        self.scale_x = 1.0
                        self.scale_y = 1.0
                        # Lower score_threshold for night camera
                        self.detector.score_threshold = max(0.25, self.score_threshold - 0.15)
                    logger.debug(f"Initial scale for camera {camera_id}: ({self.scale_x:.3f}, {self.scale_y:.3f}), score_th={self.detector.score_threshold}")

                # Initialize ROI regions on first frame
                if self.stats["frames_processed"] == 0:
                    logger.debug(f"YOLO input: {zc_frame.width}x{zc_frame.height}, camera_id={zc_frame.camera_id}")

                    # Night camera (camera_id=1) with 1280x720: enable ROI mode
                    if zc_frame.camera_id == 1 and zc_frame.width == 1280 and zc_frame.height == 720:
                        self.night_roi_mode = True
                        self.night_roi_regions = self.detector.get_roi_regions_720p()
                        logger.debug(f"Night camera ROI mode: {len(self.night_roi_regions)} regions")
                        # Initialize detection cache for 3 ROIs
                        self.detection_cache = [[] for _ in self.night_roi_regions]
                        self.roi_index = 0
                    else:
                        # Day camera or other resolutions: use original logic
                        self.night_roi_mode = False
                        self.roi_regions = self.detector.get_roi_regions(
                            zc_frame.width, zc_frame.height
                        )

                        if len(self.roi_regions) > 1:
                            logger.debug(f"Day ROI mode: {len(self.roi_regions)} regions")
                            # Initialize detection cache
                            self.detection_cache = [[] for _ in self.roi_regions]
                        else:
                            logger.debug("ROI mode disabled: single region")
                            self.roi_enabled = False

                # Run detection
                if self.night_roi_mode:
                    # Night camera: motion detection + YOLO hybrid
                    y_size = zc_frame.width * zc_frame.height

                    # Motion detection on downscaled Y (640x360 = 1/4 pixels)
                    y_plane = np.frombuffer(nv12_data[:y_size], dtype=np.uint8).reshape(
                        zc_frame.height, zc_frame.width
                    )
                    motion_h, motion_w = zc_frame.height // 2, zc_frame.width // 2
                    y_small = cv2.resize(y_plane, (motion_w, motion_h), interpolation=cv2.INTER_AREA)
                    y_small_denoised = cv2.medianBlur(y_small, 3)

                    motion_dicts = []
                    if self.prev_y_plane is not None and self.motion_cooldown <= 0:
                        diff = cv2.absdiff(y_small_denoised, self.prev_y_plane)
                        _, thresh = cv2.threshold(diff, 15, 255, cv2.THRESH_BINARY)
                        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
                        thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)
                        merge_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))
                        thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, merge_kernel)
                        contours, _ = cv2.findContours(
                            thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
                        )
                        min_area = motion_w * motion_h * 0.002  # 0.2% of frame
                        for cnt in contours:
                            area = cv2.contourArea(cnt)
                            if area < min_area:
                                continue
                            x, y, w, h = cv2.boundingRect(cnt)
                            if w < 15 or h < 15:
                                continue
                            confidence = min(1.0, area / (motion_w * motion_h * 0.05))
                            # Scale bbox back to full frame coordinates
                            motion_dicts.append({
                                "class_name": "motion",
                                "confidence": float(confidence),
                                "bbox": {"x": x * 2, "y": y * 2, "w": w * 2, "h": h * 2},
                            })
                        if len(motion_dicts) > 5:
                            motion_dicts = []
                        if motion_dicts:
                            self.motion_cooldown = 5
                            # Collect frames for future fine-tuning
                            if (self.night_collect_count < self.night_collect_max
                                    and self.stats["frames_processed"] % self.night_collect_interval == 0):
                                self._save_night_frame(nv12_data, zc_frame.width, zc_frame.height, zc_frame.frame_number)

                    if self.motion_cooldown > 0:
                        self.motion_cooldown -= 1
                    self.prev_y_plane = y_small_denoised

                    # YOLO ROI detection (every 3rd frame — motion runs every frame)
                    run_yolo = (self.stats["frames_processed"] % 3 == 0)
                    if run_yolo:
                        current_roi = self.roi_index
                        detections = self.detector.detect_nv12_roi_720p(
                            nv12_data=nv12_data,
                            roi_index=current_roi,
                            brightness_avg=zc_frame.brightness_avg,
                        )
                        if current_roi == 0:
                            self.cache_frame_number = zc_frame.frame_number
                            self.cache_timestamp = zc_frame.timestamp_sec
                        self.roi_index = (self.roi_index + 1) % len(self.night_roi_regions)
                        cycle_complete = (self.roi_index == 0)
                    else:
                        cycle_complete = False

                    # Release buffer
                    hb_mem_buffer.release()
                    active_zc.mark_consumed()

                    if run_yolo:
                        # Convert YOLO detections to dicts
                        yolo_dicts = [
                            {
                                "class_name": det.class_name.value,
                                "confidence": det.confidence,
                                "bbox": {
                                    "x": det.bbox.x, "y": det.bbox.y,
                                    "w": det.bbox.w, "h": det.bbox.h,
                                },
                            }
                            for det in detections
                        ]

                        # Accumulate YOLO ROI results
                        self.detection_cache[current_roi] = yolo_dicts

                    if cycle_complete:
                        # Merge YOLO ROI detections
                        all_yolo = []
                        for roi_dets in self.detection_cache:
                            all_yolo.extend(roi_dets)
                        merged_yolo = apply_cross_roi_nms(all_yolo, iou_threshold=0.5)

                        # Filter night YOLO false positives (IR-caused misdetections)
                        merged_yolo = [
                            d for d in merged_yolo
                            if d["class_name"] not in self.night_fp_classes
                        ]

                        # Combine: motion + YOLO results
                        all_dicts = motion_dicts + merged_yolo

                        # Scale to output coordinates
                        scaled_dicts = [
                            {
                                "class_name": d["class_name"],
                                "confidence": d["confidence"],
                                "bbox": {
                                    "x": int(d["bbox"]["x"] * self.scale_x),
                                    "y": int(d["bbox"]["y"] * self.scale_y),
                                    "w": int(d["bbox"]["w"] * self.scale_x),
                                    "h": int(d["bbox"]["h"] * self.scale_y),
                                },
                            }
                            for d in all_dicts
                        ]

                        if scaled_dicts:
                            self.detection_writer.write_detection_result(
                                frame_number=self.cache_frame_number,
                                timestamp_sec=self.cache_timestamp,
                                detections=scaled_dicts,
                            )

                        self.detection_cache = [[] for _ in self.night_roi_regions]
                        detection_dicts = scaled_dicts
                    else:
                        detection_dicts = []

                    # Stats
                    self.stats["frames_processed"] += 1
                    timing = self.detector.get_last_timing()
                    self.stats["avg_inference_time_ms"] = timing["total"] * 1000
                    if cycle_complete:
                        self.stats["total_detections"] += len(detection_dicts)

                    # Periodic stats log
                    if self.stats["frames_processed"] % 300 == 0:
                        mot = sum(1 for d in detection_dicts if d.get("class_name") == "motion")
                        yolo = len(detection_dicts) - mot
                        logger.info(
                            f"[{self.stats['frames_processed']}f] "
                            f"det={self.stats['total_detections']}(mot={mot},yolo={yolo}) "
                            f"inf={self.stats['avg_inference_time_ms']:.0f}ms "
                            f"cam={self.active_camera} "
                            f"bright={zc_frame.brightness_avg:.1f}"
                        )

                    if is_debug and cycle_complete and detection_dicts:
                        classes = ",".join(d["class_name"] for d in detection_dicts)
                        logger.debug(f"#{self.stats['frames_processed']}: {classes}")

                    continue

                elif self.roi_enabled and len(self.roi_regions) > 1:
                    # Day camera ROI mode: cycle through regions
                    current_roi = self.roi_index
                    roi_x, roi_y, roi_w, roi_h = self.roi_regions[current_roi]
                    detections = self.detector.detect_nv12_roi(
                        nv12_data=nv12_data,
                        width=zc_frame.width,
                        height=zc_frame.height,
                        roi_x=roi_x,
                        roi_y=roi_y,
                        roi_w=roi_w,
                        roi_h=roi_h,
                        brightness_avg=zc_frame.brightness_avg,
                    )

                    # Track cache start for first ROI
                    if current_roi == 0:
                        self.cache_frame_number = zc_frame.frame_number
                        self.cache_timestamp = zc_frame.timestamp_sec

                    # Advance to next ROI for next frame
                    self.roi_index = (self.roi_index + 1) % len(self.roi_regions)
                    cycle_complete = (self.roi_index == 0)
                else:
                    # Direct mode: full frame detection
                    detections = self.detector.detect_nv12(
                        nv12_data=nv12_data,
                        width=zc_frame.width,
                        height=zc_frame.height,
                        brightness_avg=zc_frame.brightness_avg,
                    )
                    current_roi = -1
                    cycle_complete = True

                # Release zero-copy buffer and signal consumed
                hb_mem_buffer.release()
                active_zc.mark_consumed()

                timing = self.detector.get_last_timing()

                # Keep bbox coordinates in frame space (scaling moved to final output)
                detection_dicts = [
                    {
                        "class_name": det.class_name.value,
                        "confidence": det.confidence,
                        "bbox": {
                            "x": det.bbox.x,
                            "y": det.bbox.y,
                            "w": det.bbox.w,
                            "h": det.bbox.h,
                        },
                    }
                    for det in detections
                ]

                # Night camera ROI mode: accumulate and merge detections
                if self.night_roi_mode and len(self.night_roi_regions) > 0:
                    # Store detections in cache for this ROI
                    self.detection_cache[current_roi] = detection_dicts

                    if cycle_complete:
                        # Merge all ROI detections with NMS (using lower threshold for overlap)
                        all_detections = []
                        for roi_idx, roi_dets in enumerate(self.detection_cache):
                            all_detections.extend(roi_dets)
                            if roi_dets and is_debug:
                                classes = [d["class_name"] for d in roi_dets]
                                logger.debug(f"  Night ROI {roi_idx}: {classes}")

                        if is_debug and all_detections:
                            logger.debug(
                                f"  Night camera: {len(all_detections)} detections before NMS"
                            )

                        # Cross-ROI NMS: 重複検出を除去
                        merged_dicts = apply_cross_roi_nms(all_detections, iou_threshold=0.5)

                        if is_debug and len(merged_dicts) != len(all_detections):
                            logger.debug(
                                f"  Night camera: {len(all_detections)} -> {len(merged_dicts)} after NMS"
                            )

                        # Apply scaling after merge (single rounding at final output)
                        scaled_dicts = [
                            {
                                "class_name": d["class_name"],
                                "confidence": d["confidence"],
                                "bbox": {
                                    "x": int(d["bbox"]["x"] * self.scale_x),
                                    "y": int(d["bbox"]["y"] * self.scale_y),
                                    "w": int(d["bbox"]["w"] * self.scale_x),
                                    "h": int(d["bbox"]["h"] * self.scale_y),
                                },
                            }
                            for d in merged_dicts
                        ]

                        # Write scaled results
                        if scaled_dicts:
                            self.detection_writer.write_detection_result(
                                frame_number=self.cache_frame_number,
                                timestamp_sec=self.cache_timestamp,
                                detections=scaled_dicts,
                            )

                        # Use scaled results for stats/logging
                        merged_dicts = scaled_dicts

                        # Clear cache for next cycle
                        self.detection_cache = [[] for _ in self.night_roi_regions]

                        # Use merged results for stats/logging
                        detection_dicts = merged_dicts

                # Day camera ROI mode: accumulate and merge detections
                elif self.roi_enabled and len(self.roi_regions) > 1:
                    # Store detections in cache for this ROI
                    self.detection_cache[current_roi] = detection_dicts

                    if cycle_complete:
                        # Merge all ROI detections with NMS
                        all_detections = []
                        for roi_idx, roi_dets in enumerate(self.detection_cache):
                            all_detections.extend(roi_dets)
                            # Debug: show detections per ROI
                            if roi_dets and is_debug:
                                classes = [d["class_name"] for d in roi_dets]
                                logger.debug(f"  ROI {roi_idx}: {classes}")

                        if is_debug and all_detections:
                            logger.debug(
                                f"  Day ROI: {len(all_detections)} detections"
                            )

                        # No merge needed - overlapping ROIs rarely produce duplicates
                        merged_dicts = all_detections

                        # Apply scaling after merge (single rounding at final output)
                        scaled_dicts = [
                            {
                                "class_name": d["class_name"],
                                "confidence": d["confidence"],
                                "bbox": {
                                    "x": int(d["bbox"]["x"] * self.scale_x),
                                    "y": int(d["bbox"]["y"] * self.scale_y),
                                    "w": int(d["bbox"]["w"] * self.scale_x),
                                    "h": int(d["bbox"]["h"] * self.scale_y),
                                },
                            }
                            for d in merged_dicts
                        ]

                        # Write scaled results
                        if scaled_dicts:
                            self.detection_writer.write_detection_result(
                                frame_number=self.cache_frame_number,
                                timestamp_sec=self.cache_timestamp,
                                detections=scaled_dicts,
                            )

                        # Clear cache for next cycle
                        self.detection_cache = [[] for _ in self.roi_regions]

                        # Use scaled results for stats/logging
                        detection_dicts = scaled_dicts
                else:
                    # Direct mode: apply scaling and write immediately
                    scaled_dicts = [
                        {
                            "class_name": d["class_name"],
                            "confidence": d["confidence"],
                            "bbox": {
                                "x": int(d["bbox"]["x"] * self.scale_x),
                                "y": int(d["bbox"]["y"] * self.scale_y),
                                "w": int(d["bbox"]["w"] * self.scale_x),
                                "h": int(d["bbox"]["h"] * self.scale_y),
                            },
                        }
                        for d in detection_dicts
                    ]
                    if scaled_dicts:
                        self.detection_writer.write_detection_result(
                            frame_number=zc_frame.frame_number,
                            timestamp_sec=zc_frame.timestamp_sec,
                            detections=scaled_dicts,
                        )
                    detection_dicts = scaled_dicts

                # Update stats
                self.stats["frames_processed"] += 1
                self.stats["avg_inference_time_ms"] = timing["total"] * 1000

                # In ROI mode, count merged detections only at cycle completion
                if self.night_roi_mode and len(self.night_roi_regions) > 0:
                    if cycle_complete:
                        self.stats["total_detections"] += len(detection_dicts)
                elif self.roi_enabled and len(self.roi_regions) > 1:
                    if cycle_complete:
                        self.stats["total_detections"] += len(detection_dicts)
                else:
                    self.stats["total_detections"] += len(detections)

                # Periodic stats log (every 300 frames)
                if self.stats["frames_processed"] % 300 == 0:
                    clahe_status = "yes" if self.detector.clahe_enabled else "no"
                    logger.info(
                        f"[{self.stats['frames_processed']}f] "
                        f"det={self.stats['total_detections']} "
                        f"inf={self.stats['avg_inference_time_ms']:.0f}ms "
                        f"cam={self.active_camera} "
                        f"bright={zc_frame.brightness_avg:.1f} "
                        f"clahe={clahe_status}"
                    )

                # Debug logging (per-frame details)
                if is_debug and cycle_complete and detection_dicts:
                    classes = ",".join(d["class_name"] for d in detection_dicts)
                    logger.debug(f"#{self.stats['frames_processed']}: {classes}")

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
