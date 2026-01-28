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

# プロジェクトルートをパスに追加
DETECTOR_DIR = Path(__file__).parent
PROJECT_ROOT = DETECTOR_DIR.parent.parent
CAPTURE_DIR = PROJECT_ROOT / "src" / "capture"
COMMON_SRC = PROJECT_ROOT / "src" / "common" / "src"

sys.path.insert(0, str(CAPTURE_DIR))
sys.path.insert(0, str(COMMON_SRC))

from real_shared_memory import (
    RealSharedMemory,
    ZeroCopySharedMemory,
    CameraControlSharedMemory,
    SHM_NAME_ACTIVE_FRAME,
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
        self.shm_main: RealSharedMemory | None = None  # Main frame for resolution info
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

        # 解像度キャッシュ（初回のみ取得）
        self.target_width = None
        self.target_height = None
        self.scale_x = None
        self.scale_y = None

        # ROI cycling state
        self.roi_regions: list[tuple[int, int, int, int]] = []  # [(x, y, w, h), ...]
        self.roi_index: int = 0  # Current ROI index for round-robin
        self.roi_enabled: bool = True  # Enable ROI mode for high-res input

    def setup(self) -> None:
        """セットアップ"""
        logger.info("=== YOLO Detector Daemon (Zero-Copy) ===")
        logger.info(f"Model: {self.model_path}")
        logger.info(f"Score threshold: {self.score_threshold}")
        logger.info(f"NMS threshold: {self.nms_threshold}")
        logger.info("")

        # Initialize hb_mem module (required)
        if not hb_mem_init():
            raise RuntimeError("hb_mem module initialization failed")
        logger.info("hb_mem module initialized")

        # 共有メモリを開く
        try:
            # CameraControl SHM (to determine active camera)
            self.shm_control = CameraControlSharedMemory()
            if self.shm_control.open():
                self.active_camera = self.shm_control.get_active()
                logger.info(
                    f"CameraControl SHM opened, active camera: {self.active_camera}"
                )
            else:
                logger.warning(
                    "CameraControl SHM not available, defaulting to DAY camera"
                )

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
                logger.info(f"Connected to DAY zero-copy: {SHM_NAME_ZEROCOPY_DAY}")
            if night_ok:
                logger.info(f"Connected to NIGHT zero-copy: {SHM_NAME_ZEROCOPY_NIGHT}")

            # メイン解像度参照用 (bbox座標スケーリングに使用)
            self.shm_main = RealSharedMemory(frame_shm_name=SHM_NAME_ACTIVE_FRAME)
            self.shm_main.open()
            self.shm_main.open_detection_write()
            logger.info(f"Connected to main shared memory: {SHM_NAME_ACTIVE_FRAME}")
        except Exception as e:
            logger.error(f"Failed to open shared memory: {e}")
            logger.error("Make sure camera daemon is running")
            raise

        # YOLODetectorを初期化
        try:
            logger.info("Loading YOLO model...")
            self.detector = YoloDetector(
                model_path=self.model_path,
                score_threshold=self.score_threshold,
                nms_threshold=self.nms_threshold,
                auto_download=True,
            )
            logger.info("YOLO model loaded successfully")
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
        if self.shm_main:
            self.shm_main.close()
        logger.info(f"Total frames processed: {self.stats['frames_processed']}")
        logger.info(f"Total detections: {self.stats['total_detections']}")
        if self.stats["frames_processed"] > 0:
            avg_dets = self.stats["total_detections"] / self.stats["frames_processed"]
            logger.info(f"Average detections/frame: {avg_dets:.2f}")
        logger.info("Detector daemon stopped")

    def signal_handler(self, signum, frame) -> None:
        """シグナルハンドラ"""
        logger.info("Shutting down...")
        self.running = False

    def run(self) -> int:
        """メインループ"""
        import numpy as np

        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)

        logger.info("Starting detection loop (Press Ctrl+C to stop)")
        logger.info("")

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

                zc_frame = active_zc.get_frame()
                if zc_frame is None:
                    time.sleep(0.01)
                    continue

                try:
                    # Validate plane_cnt
                    if zc_frame.plane_cnt != 2:
                        raise ValueError(
                            f"Expected 2 planes for NV12, got {zc_frame.plane_cnt}"
                        )

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

                frame_width = zc_frame.width
                frame_height = zc_frame.height
                frame_number = zc_frame.frame_number
                timestamp_sec = zc_frame.timestamp_sec
                brightness_avg = zc_frame.brightness_avg

                # Cache scale factors (first frame only)
                if self.scale_x is None or self.scale_y is None:
                    main_frame = self.shm_main.get_latest_frame()
                    if main_frame is None:
                        hb_mem_buffer.release()
                        active_zc.mark_consumed()
                        time.sleep(0.01)
                        continue
                    self.target_width = main_frame.width
                    self.target_height = main_frame.height
                    self.scale_x = self.target_width / float(frame_width)
                    self.scale_y = self.target_height / float(frame_height)
                    logger.info(
                        f"Output resolution: {self.target_width}x{self.target_height} "
                        f"(YOLO input: {frame_width}x{frame_height}, scale={self.scale_x:.3f}x{self.scale_y:.3f})"
                    )

                # Initialize ROI regions on first frame
                if self.stats["frames_processed"] == 0:
                    logger.info(
                        f"YOLO input: {frame_width}x{frame_height}, data_len={len(nv12_data)}"
                    )

                    # Get ROI regions for this resolution
                    self.roi_regions = self.detector.get_roi_regions(
                        frame_width, frame_height
                    )

                    if len(self.roi_regions) > 1:
                        logger.info(
                            f"ROI mode enabled: {len(self.roi_regions)} regions "
                            f"(full coverage every {len(self.roi_regions)} frames)"
                        )
                        for i, (rx, ry, rw, rh) in enumerate(self.roi_regions):
                            logger.info(f"  ROI {i}: ({rx}, {ry}) - ({rx+rw}, {ry+rh})")
                    else:
                        logger.info("ROI mode disabled: single region covers full frame")
                        self.roi_enabled = False

                # Run YOLO inference
                if self.roi_enabled and len(self.roi_regions) > 1:
                    # ROI mode: cycle through regions
                    roi_x, roi_y, roi_w, roi_h = self.roi_regions[self.roi_index]
                    detections = self.detector.detect_nv12_roi(
                        nv12_data=nv12_data,
                        width=frame_width,
                        height=frame_height,
                        roi_x=roi_x,
                        roi_y=roi_y,
                        roi_w=roi_w,
                        roi_h=roi_h,
                        brightness_avg=brightness_avg,
                    )
                    current_roi = self.roi_index
                    # Advance to next ROI for next frame
                    self.roi_index = (self.roi_index + 1) % len(self.roi_regions)
                else:
                    # Direct mode: full frame detection
                    detections = self.detector.detect_nv12(
                        nv12_data=nv12_data,
                        width=frame_width,
                        height=frame_height,
                        brightness_avg=brightness_avg,
                    )
                    current_roi = -1

                # Release zero-copy buffer and signal consumed
                hb_mem_buffer.release()
                active_zc.mark_consumed()

                timing = self.detector.get_last_timing()

                # Scale bbox coordinates from YOLO input (640x360) to output resolution
                detection_dicts = [
                    {
                        "class_name": det.class_name.value,
                        "confidence": det.confidence,
                        "bbox": {
                            "x": int(det.bbox.x * self.scale_x),
                            "y": int(det.bbox.y * self.scale_y),
                            "w": int(det.bbox.w * self.scale_x),
                            "h": int(det.bbox.h * self.scale_y),
                        },
                    }
                    for det in detections
                ]

                # Write detection results (only if detections exist)
                if detection_dicts:
                    self.shm_main.write_detection_result(
                        frame_number=frame_number,
                        timestamp_sec=timestamp_sec,
                        detections=detection_dicts,
                    )

                # Update stats
                self.stats["frames_processed"] += 1
                self.stats["total_detections"] += len(detections)
                self.stats["avg_inference_time_ms"] = timing["total"] * 1000

                # Periodic stats log (every 100 frames)
                if self.stats["frames_processed"] % 100 == 0:
                    logger.info(
                        f"Stats: {self.stats['frames_processed']} frames, "
                        f"{self.stats['total_detections']} total detections, "
                        f"avg inference: {self.stats['avg_inference_time_ms']:.1f}ms"
                    )

                # Debug logging
                if is_debug:
                    loop_end = time_module.perf_counter()
                    time_loop = (loop_end - loop_start) * 1000
                    classes = [d["class_name"] for d in detection_dicts]
                    roi_info = f" [ROI {current_roi}]" if current_roi >= 0 else ""
                    logger.debug(
                        f"Frame #{self.stats['frames_processed']}{roi_info}: "
                        f"{len(detections)} detections {classes if classes else '(none)'}"
                    )
                    logger.debug(
                        f"  YOLO: {timing['total'] * 1000:.1f}ms "
                        f"(prep={timing['preprocessing'] * 1000:.1f}ms, "
                        f"infer={timing['inference'] * 1000:.1f}ms, "
                        f"post={timing['postprocessing'] * 1000:.1f}ms)"
                    )
                    logger.debug(f"  Loop: {time_loop:.1f}ms")
                elif detections:
                    classes = [d["class_name"] for d in detection_dicts]
                    roi_info = f" [ROI {current_roi}]" if current_roi >= 0 else ""
                    logger.info(
                        f"Frame #{self.stats['frames_processed']}{roi_info}: "
                        f"{len(detections)} detections {classes}"
                    )

        except KeyboardInterrupt:
            logger.info("Interrupted")
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
        default=0.6,
        help="Detection score threshold (default: 0.6)",
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
