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
    SHM_NAME_ACTIVE_FRAME,
    SHM_NAME_YOLO_INPUT,
)
from detection.yolo_detector import YoloDetector

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
        self.shm_yolo: RealSharedMemory | None = None  # YOLO 640x640 input
        self.shm_main: RealSharedMemory | None = None  # Main frame for resolution info

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

    def setup(self) -> None:
        """セットアップ"""
        logger.info("=== YOLO Detector Daemon ===")
        logger.info(f"Model: {self.model_path}")
        logger.info(f"Score threshold: {self.score_threshold}")
        logger.info(f"NMS threshold: {self.nms_threshold}")
        logger.info("")

        # 共有メモリを開く
        try:
            # YOLO入力用 (640x640 NV12)
            self.shm_yolo = RealSharedMemory(frame_shm_name=SHM_NAME_YOLO_INPUT)
            self.shm_yolo.open()
            logger.info(f"Connected to YOLO input shared memory: {SHM_NAME_YOLO_INPUT}")

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
        if self.shm_yolo:
            self.shm_yolo.close()
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
        # シグナルハンドラ設定
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)

        last_frame_number = -1

        logger.info("Starting detection loop (Press Ctrl+C to stop)")
        logger.info("")

        try:
            import time as time_module

            while self.running:
                loop_start = time_module.perf_counter()

                # 最適化1: VSE Ch1から640x640 NV12を取得（ゼロコピー: memoryview使用）
                t0 = time_module.perf_counter()
                yolo_frame = self.shm_yolo.get_latest_frame()
                t1 = time_module.perf_counter()
                time_get_frame = (t1 - t0) * 1000

                if yolo_frame is None:
                    time.sleep(0.01)
                    continue

                # 同じフレームはスキップ
                if yolo_frame.frame_number == last_frame_number:
                    time.sleep(0.01)
                    continue

                last_frame_number = yolo_frame.frame_number

                # 最適化2: メイン解像度を初回のみ取得してキャッシュ（毎フレーム3MBコピーを回避）
                if self.target_width is None or self.target_height is None:
                    main_frame = self.shm_main.get_latest_frame()
                    if main_frame is None:
                        time.sleep(0.01)
                        continue
                    self.target_width = main_frame.width
                    self.target_height = main_frame.height
                    logger.info(
                        f"Detected output resolution: {self.target_width}x{self.target_height} "
                        f"(YOLO input: 640x640)"
                    )

                # 初回のみVSE Ch1が正しく640x640を出力しているか確認
                if self.stats["frames_processed"] == 0:
                    logger.info(
                        f"YOLO input frame size: {yolo_frame.width}x{yolo_frame.height} "
                        f"(expected 640x640), format={yolo_frame.format}, data_len={len(yolo_frame.data)}"
                    )
                    if yolo_frame.width != 640 or yolo_frame.height != 640:
                        logger.warning(
                            "⚠️ YOLO input is NOT 640x640! VSE Channel 1 may not be working correctly."
                        )

                # 最適化3: NV12を直接BPU推論へ（JPEG変換・リサイズを完全にスキップ）
                t2 = time_module.perf_counter()
                detections = self.detector.detect_nv12(
                    nv12_data=yolo_frame.data,  # memoryview（ゼロコピー）
                    width=yolo_frame.width,
                    height=yolo_frame.height,
                    brightness_avg=yolo_frame.brightness_avg,  # CLAHE判定用
                )
                t3 = time_module.perf_counter()
                time_detect = (t3 - t2) * 1000
                timing = self.detector.get_last_timing()

                # bbox座標を640x640からメイン解像度へスケーリング
                t4 = time_module.perf_counter()
                scale_x = self.target_width / 640.0
                scale_y = self.target_height / 640.0
                detection_dicts = [
                    {
                        "class_name": det.class_name.value,
                        "confidence": det.confidence,
                        "bbox": {
                            "x": int(det.bbox.x * scale_x),
                            "y": int(det.bbox.y * scale_y),
                            "w": int(det.bbox.w * scale_x),
                            "h": int(det.bbox.h * scale_y),
                        },
                    }
                    for det in detections
                ]
                t5 = time_module.perf_counter()
                time_scale = (t5 - t4) * 1000

                # 検出結果を共有メモリに書き込み（検出があるときのみ）
                # 検出がない場合は書き込みをスキップしてセマフォ通知を抑制
                t6 = time_module.perf_counter()
                time_write = 0.0
                if detection_dicts:
                    self.shm_main.write_detection_result(
                        frame_number=yolo_frame.frame_number,
                        timestamp_sec=yolo_frame.timestamp_sec,
                        detections=detection_dicts,
                    )
                    t7 = time_module.perf_counter()
                    time_write = (t7 - t6) * 1000

                # 統計更新
                self.stats["frames_processed"] += 1
                self.stats["total_detections"] += len(detections)
                self.stats["avg_inference_time_ms"] = timing["total"] * 1000

                # ループ全体の時間を計測
                loop_end = time_module.perf_counter()
                time_loop = (loop_end - loop_start) * 1000
                time_other = time_loop - (
                    time_get_frame + time_detect + time_scale + time_write
                )

                # ログレベルに応じた出力制御
                # INFO: 30フレームごとに検出結果のみ
                # DEBUG: 毎フレームパフォーマンス測定を出力

                if logger.isEnabledFor(logging.DEBUG):
                    # DEBUGレベル: 毎フレーム詳細なパフォーマンス測定
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
                    logger.debug(
                        f"  Loop: {time_loop:.1f}ms "
                        f"(get_frame={time_get_frame:.1f}ms, "
                        f"detect={time_detect:.1f}ms, "
                        f"scale={time_scale:.1f}ms, "
                        f"write={time_write:.1f}ms, "
                        f"other={time_other:.1f}ms)"
                    )

                    # 検出詳細
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
