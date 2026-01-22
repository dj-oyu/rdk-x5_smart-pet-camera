#!/usr/bin/env python3
"""
yolo_detector_daemon.py - YOLO detector that writes to real shared memory

This daemon reads frames from camera daemon and writes YOLO detection results
to the detection shared memory.
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
    SHM_NAME_YOLO_INPUT,
    SHM_NAME_YOLO_ZEROCOPY,
)
from detection.yolo_detector import YoloDetector

# Try to import hb_mem bindings (only available on D-Robotics hardware)
try:
    from hb_mem_bindings import init_module as hb_mem_init, HbMemBuffer, import_nv12_planes, release_buffers
    HB_MEM_AVAILABLE = True
except ImportError:
    HB_MEM_AVAILABLE = False

# ロガー設定（後でmain()で上書きされる）
logging.basicConfig(
    level=logging.ERROR,  # 基本はERROR (daemon個別ログは後で設定)
    format="[%(asctime)s.%(msecs)03d] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("YOLODetectorDaemon")

# YOLODetectorのロガー
yolo_logger = logging.getLogger("detection.yolo_detector")


class YoloDetectorDaemon:
    """YOLO検出デーモン"""

    def __init__(
        self,
        model_path: str,
        score_threshold: float = 0.6,
        nms_threshold: float = 0.7,
        use_zerocopy: bool = True,
    ):
        """
        初期化

        Args:
            model_path: YOLOモデルのパス
            score_threshold: 信頼度閾値
            nms_threshold: NMS IoU閾値
            use_zerocopy: Enable zero-copy mode (requires hb_mem bindings)
        """
        self.model_path = model_path
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self.use_zerocopy = use_zerocopy and HB_MEM_AVAILABLE

        # 共有メモリ
        self.shm_yolo: RealSharedMemory | None = None  # YOLO 640x360 input (letterbox to 640x640)
        self.shm_main: RealSharedMemory | None = None  # Main frame for resolution info
        self.shm_zerocopy: ZeroCopySharedMemory | None = None  # Zero-copy YOLO input

        # YOLODetector
        self.detector: YoloDetector | None = None

        # 統計情報
        self.stats = {
            "frames_processed": 0,
            "total_detections": 0,
            "avg_inference_time_ms": 0.0,
            "zerocopy_frames": 0,
            "memcpy_frames": 0,
        }

        self.running = True

        # 解像度キャッシュ（初回のみ取得）
        self.target_width = None
        self.target_height = None
        self.scale_x = None  # Cached: target_width / 640.0
        self.scale_y = None  # Cached: target_height / 640.0

    def setup(self) -> None:
        """セットアップ"""
        logger.info("=== YOLO Detector Daemon ===")
        logger.info(f"Model: {self.model_path}")
        logger.info(f"Score threshold: {self.score_threshold}")
        logger.info(f"NMS threshold: {self.nms_threshold}")
        logger.info(f"Zero-copy mode: {self.use_zerocopy} (hb_mem: {HB_MEM_AVAILABLE})")
        logger.info("")

        # Initialize hb_mem module if zero-copy enabled
        if self.use_zerocopy:
            try:
                if hb_mem_init():
                    logger.info("hb_mem module initialized successfully")
                else:
                    logger.warning("hb_mem module init failed, disabling zero-copy")
                    self.use_zerocopy = False
            except Exception as e:
                logger.warning(f"hb_mem init error: {e}, disabling zero-copy")
                self.use_zerocopy = False

        # 共有メモリを開く
        try:
            # YOLO入力用 (640x360 NV12, letterbox to 640x640) - memcpy fallback
            self.shm_yolo = RealSharedMemory(frame_shm_name=SHM_NAME_YOLO_INPUT)
            self.shm_yolo.open()
            logger.info(f"Connected to YOLO input shared memory: {SHM_NAME_YOLO_INPUT}")

            # Zero-copy YOLO input (if enabled)
            if self.use_zerocopy:
                self.shm_zerocopy = ZeroCopySharedMemory(SHM_NAME_YOLO_ZEROCOPY)
                if self.shm_zerocopy.open():
                    logger.info(f"Connected to zero-copy shared memory: {SHM_NAME_YOLO_ZEROCOPY}")
                else:
                    logger.warning("Zero-copy SHM not available, using memcpy fallback")
                    self.shm_zerocopy = None
                    self.use_zerocopy = False

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
        if self.shm_yolo:
            self.shm_yolo.close()
        if self.shm_main:
            self.shm_main.close()
        logger.info(f"Total frames processed: {self.stats['frames_processed']}")
        logger.info(f"  Zero-copy frames: {self.stats['zerocopy_frames']}")
        logger.info(f"  Memcpy frames: {self.stats['memcpy_frames']}")
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
        # シグナルハンドラ設定
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)

        logger.info("Starting detection loop (Press Ctrl+C to stop)")
        logger.info("")

        try:
            import time as time_module

            # Cache DEBUG check outside loop
            is_debug = logger.isEnabledFor(logging.DEBUG)

            while self.running:
                # Timing only in DEBUG mode
                if is_debug:
                    loop_start = time_module.perf_counter()

                # Try zero-copy first, fallback to memcpy
                zc_frame = None
                yolo_frame = None
                hb_mem_buffers = None
                nv12_data = None

                if self.use_zerocopy and self.shm_zerocopy:
                    zc_frame = self.shm_zerocopy.get_frame()
                    if zc_frame is not None:
                        try:
                            # Validate plane_cnt before accessing arrays
                            if zc_frame.plane_cnt != 2:
                                raise ValueError(f"Expected 2 planes for NV12, got {zc_frame.plane_cnt}")

                            # Import VIO buffers via share_id
                            y_arr, uv_arr, hb_mem_buffers = import_nv12_planes(
                                zc_frame.share_id[0],
                                zc_frame.share_id[1],
                                zc_frame.plane_size[0],
                                zc_frame.plane_size[1],
                            )
                            # Concatenate Y and UV for NV12
                            import numpy as np
                            nv12_data = np.concatenate([y_arr, uv_arr])
                            self.stats["zerocopy_frames"] += 1
                        except Exception as e:
                            logger.warning(f"Zero-copy import failed: {e}, falling back to memcpy")
                            import traceback
                            traceback.print_exc()
                            zc_frame = None
                            if hb_mem_buffers:
                                release_buffers(hb_mem_buffers)
                                hb_mem_buffers = None

                # Fallback to memcpy if zero-copy not available
                if zc_frame is None:
                    yolo_frame = self.shm_yolo.get_latest_frame()
                    if yolo_frame is None:
                        time.sleep(0.01)
                        continue
                    nv12_data = yolo_frame.data
                    self.stats["memcpy_frames"] += 1

                # Determine frame properties
                if zc_frame:
                    frame_width = zc_frame.width
                    frame_height = zc_frame.height
                    frame_number = zc_frame.frame_number
                    timestamp_sec = zc_frame.timestamp_sec
                    brightness_avg = zc_frame.brightness_avg
                else:
                    frame_width = yolo_frame.width
                    frame_height = yolo_frame.height
                    frame_number = yolo_frame.frame_number
                    timestamp_sec = yolo_frame.timestamp_sec
                    brightness_avg = yolo_frame.brightness_avg

                # NOTE: Frame duplicate check removed - YOLO inference time > frame interval
                # so duplicates rarely occur, and processing same frame twice is harmless

                # 最適化2: メイン解像度とスケール係数を初回のみ取得してキャッシュ
                # Note: YOLO入力はletterbox前のサイズ(640x360)を使用
                if self.scale_x is None or self.scale_y is None:
                    main_frame = self.shm_main.get_latest_frame()
                    if main_frame is None:
                        if hb_mem_buffers:
                            release_buffers(hb_mem_buffers)
                        if zc_frame and self.shm_zerocopy:
                            self.shm_zerocopy.mark_consumed()
                        time.sleep(0.01)
                        continue
                    self.target_width = main_frame.width
                    self.target_height = main_frame.height
                    # YOLOの出力座標はletterbox前の空間(640x360)
                    # VSEがアスペクト比を維持してスケールするので、x/yスケールは同じ値になる
                    self.scale_x = self.target_width / float(frame_width)
                    self.scale_y = self.target_height / float(frame_height)
                    logger.info(
                        f"Detected output resolution: {self.target_width}x{self.target_height} "
                        f"(YOLO input: {frame_width}x{frame_height}, scale={self.scale_x:.3f}x{self.scale_y:.3f})"
                    )

                # 初回のみVSE Ch1の出力サイズを確認（letterbox: 640x360）
                if self.stats["frames_processed"] == 0:
                    mode_str = "zero-copy" if zc_frame else "memcpy"
                    data_len = len(nv12_data) if nv12_data is not None else 0
                    logger.info(
                        f"YOLO input frame size: {frame_width}x{frame_height} "
                        f"(expected 640x360 for letterbox), mode={mode_str}, data_len={data_len}"
                    )
                    if frame_width != 640 or frame_height != 360:
                        logger.warning(
                            f"YOLO input is NOT 640x360! VSE Channel 1 may not be configured for letterbox. "
                            f"Got {frame_width}x{frame_height}"
                        )

                # NV12を直接BPU推論へ
                detections = self.detector.detect_nv12(
                    nv12_data=nv12_data,
                    width=frame_width,
                    height=frame_height,
                    brightness_avg=brightness_avg,
                )

                # Release zero-copy buffers and mark consumed
                if hb_mem_buffers:
                    release_buffers(hb_mem_buffers)
                if zc_frame and self.shm_zerocopy:
                    self.shm_zerocopy.mark_consumed()
                    if self.stats["zerocopy_frames"] == 1:
                        logger.info("Zero-copy: first frame processed and marked consumed")
                timing = self.detector.get_last_timing()

                # bbox座標をYOLO入力空間(640x360)からメイン解像度(1920x1080)へスケーリング
                # Note: detectorが返すbboxはletterbox補正済み（640x360空間）
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


                # 検出結果を共有メモリに書き込み（検出があるときのみ）
                if detection_dicts:
                    self.shm_main.write_detection_result(
                        frame_number=frame_number,
                        timestamp_sec=timestamp_sec,
                        detections=detection_dicts,
                    )

                # 統計更新
                self.stats["frames_processed"] += 1
                self.stats["total_detections"] += len(detections)
                self.stats["avg_inference_time_ms"] = timing["total"] * 1000

                # DEBUG: 詳細なパフォーマンス測定
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
                    if detections:
                        for det in detections:
                            logger.debug(
                                f"  -> {det.class_name.value}: {det.confidence:.2f} "
                                f"@ ({det.bbox.x}, {det.bbox.y}, {det.bbox.w}, {det.bbox.h})"
                            )

                elif detections:
                    # INFOレベル: 検出があった場合のみログ出力
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

    parser = argparse.ArgumentParser(description="YOLO Detector Daemon")
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
        "--no-zerocopy",
        action="store_true",
        help="Disable zero-copy mode (always use memcpy)",
    )

    args = parser.parse_args()

    # ログレベル設定
    log_levels = {
        "debug": logging.DEBUG,
        "info": logging.INFO,
        "warn": logging.WARNING,
        "error": logging.ERROR,
    }
    log_level = log_levels[args.log_level]

    logger.setLevel(log_level)
    yolo_logger.setLevel(log_level)

    # デーモン起動
    daemon = YoloDetectorDaemon(
        model_path=args.model_path,
        score_threshold=args.score_threshold,
        nms_threshold=args.nms_threshold,
        use_zerocopy=not args.no_zerocopy,
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
