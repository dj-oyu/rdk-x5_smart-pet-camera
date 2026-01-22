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
    SHM_NAME_ACTIVE_FRAME,
    SHM_NAME_YOLO_ZEROCOPY,
)
from detection.yolo_detector import YoloDetector

# hb_mem bindings (required for zero-copy)
from hb_mem_bindings import init_module as hb_mem_init, import_nv12_planes, release_buffers

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
        score_threshold: float = 0.6,
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
        self.shm_zerocopy: ZeroCopySharedMemory | None = None  # Zero-copy YOLO input

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
            # Zero-copy YOLO input
            self.shm_zerocopy = ZeroCopySharedMemory(SHM_NAME_YOLO_ZEROCOPY)
            if not self.shm_zerocopy.open():
                raise RuntimeError(f"Zero-copy SHM not available: {SHM_NAME_YOLO_ZEROCOPY}")
            logger.info(f"Connected to zero-copy shared memory: {SHM_NAME_YOLO_ZEROCOPY}")

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

    def cleanup(self) -> None:
        """クリーンアップ"""
        if self.shm_zerocopy:
            self.shm_zerocopy.close()
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

                hb_mem_buffers = None

                # Get frame via zero-copy
                zc_frame = self.shm_zerocopy.get_frame()
                if zc_frame is None:
                    time.sleep(0.01)
                    continue

                try:
                    # Validate plane_cnt
                    if zc_frame.plane_cnt != 2:
                        raise ValueError(f"Expected 2 planes for NV12, got {zc_frame.plane_cnt}")

                    # Import VIO buffers via share_id
                    y_arr, uv_arr, hb_mem_buffers = import_nv12_planes(
                        zc_frame.share_id[0],
                        zc_frame.share_id[1],
                        zc_frame.plane_size[0],
                        zc_frame.plane_size[1],
                    )
                    nv12_data = np.concatenate([y_arr, uv_arr])
                except Exception as e:
                    logger.error(f"Zero-copy import failed: {e}")
                    if hb_mem_buffers:
                        release_buffers(hb_mem_buffers)
                    self.shm_zerocopy.mark_consumed()
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
                        release_buffers(hb_mem_buffers)
                        self.shm_zerocopy.mark_consumed()
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

                # Log first frame info
                if self.stats["frames_processed"] == 0:
                    logger.info(
                        f"YOLO input: {frame_width}x{frame_height}, data_len={len(nv12_data)}"
                    )
                    if frame_width != 640 or frame_height != 360:
                        logger.warning(
                            f"YOLO input is NOT 640x360! Got {frame_width}x{frame_height}"
                        )

                # Run YOLO inference
                detections = self.detector.detect_nv12(
                    nv12_data=nv12_data,
                    width=frame_width,
                    height=frame_height,
                    brightness_avg=brightness_avg,
                )

                # Release zero-copy buffers and signal consumed
                release_buffers(hb_mem_buffers)
                self.shm_zerocopy.mark_consumed()

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

                # Debug logging
                if is_debug:
                    loop_end = time_module.perf_counter()
                    time_loop = (loop_end - loop_start) * 1000
                    classes = [d["class_name"] for d in detection_dicts]
                    logger.debug(
                        f"Frame #{self.stats['frames_processed']}: "
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
                    logger.info(
                        f"Frame #{self.stats['frames_processed']}: "
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
