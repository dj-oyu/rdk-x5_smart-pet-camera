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

import cv2
import numpy as np

# プロジェクトルートをパスに追加
DETECTOR_DIR = Path(__file__).parent
PROJECT_ROOT = DETECTOR_DIR.parent.parent
CAPTURE_DIR = PROJECT_ROOT / "src" / "capture"
COMMON_SRC = PROJECT_ROOT / "src" / "common" / "src"

sys.path.insert(0, str(CAPTURE_DIR))
sys.path.insert(0, str(COMMON_SRC))

from real_shared_memory import RealSharedMemory
from detection.yolo_detector import YoloDetector

# ロガー設定
logging.basicConfig(
    level=logging.FATAL,
    format="[%(asctime)s.%(msecs)03d] [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("YOLODetectorDaemon")

# YOLODetectorのロガーもDEBUGに設定
yolo_logger = logging.getLogger("detection.yolo_detector")
yolo_logger.setLevel(logging.FATAL)


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
        self.shm: RealSharedMemory | None = None

        # YOLODetector
        self.detector: YoloDetector | None = None

        # 統計情報
        self.stats = {
            "frames_processed": 0,
            "total_detections": 0,
            "avg_inference_time_ms": 0.0,
        }

        self.running = True

    def setup(self) -> None:
        """セットアップ"""
        logger.info("=== YOLO Detector Daemon ===")
        logger.info(f"Model: {self.model_path}")
        logger.info(f"Score threshold: {self.score_threshold}")
        logger.info(f"NMS threshold: {self.nms_threshold}")
        logger.info("")

        # 共有メモリを開く
        try:
            self.shm = RealSharedMemory()
            self.shm.open()
            self.shm.open_detection_write()
            logger.info("Connected to shared memory")
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
        if self.shm:
            self.shm.close()
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

    def frame_to_jpeg(self, frame) -> bytes:
        """
        共有メモリのフレームをJPEGに変換

        Args:
            frame: RealSharedMemoryから取得したフレーム

        Returns:
            JPEGエンコードされたバイト列
        """
        # フォーマットに応じてデコード
        if frame.format == 0:  # JPEG
            # すでにJPEG形式なのでそのまま返す
            return bytes(frame.data)

        elif frame.format == 1:  # NV12
            # NV12 → BGR → JPEG
            y_size = frame.width * frame.height
            uv_size = y_size // 2

            if len(frame.data) < y_size + uv_size:
                logger.warning(
                    f"NV12 frame too small: {len(frame.data)} < {y_size + uv_size}"
                )
                return b""

            try:
                # NV12を1次元配列として準備
                yuv_data = np.frombuffer(frame.data[: y_size + uv_size], dtype=np.uint8)

                # NV12形式: [Y: height x width] [UV: height/2 x width (interleaved)]
                yuv_img = yuv_data.reshape((frame.height * 3 // 2, frame.width))

                # NV12 → BGR変換
                bgr_img = cv2.cvtColor(yuv_img, cv2.COLOR_YUV2BGR_NV12)

                # JPEGエンコード
                _, jpeg_data = cv2.imencode(
                    ".jpg", bgr_img, [cv2.IMWRITE_JPEG_QUALITY, 95]
                )
                return jpeg_data.tobytes()

            except Exception as e:
                logger.error(f"NV12 conversion failed: {e}")
                return b""

        else:
            logger.warning(f"Unsupported frame format: {frame.format}")
            return b""

    def run(self) -> int:
        """メインループ"""
        # シグナルハンドラ設定
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)

        last_frame_number = -1

        logger.info("Starting detection loop (Press Ctrl+C to stop)")
        logger.info("")

        try:
            while self.running:
                # 最新フレームを取得
                frame = self.shm.get_latest_frame()

                if frame is None:
                    time.sleep(0.01)
                    continue

                # 同じフレームはスキップ
                if frame.frame_number == last_frame_number:
                    time.sleep(0.01)
                    continue

                last_frame_number = frame.frame_number

                # フレームをJPEGに変換
                jpeg_data = self.frame_to_jpeg(frame)
                if not jpeg_data:
                    logger.warning(f"Failed to convert frame #{frame.frame_number}")
                    continue

                # YOLO検出実行
                detections = self.detector.detect(jpeg_data)

                # タイミング情報取得
                timing = self.detector.get_last_timing()

                # 検出結果を共有メモリに書き込み
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

                self.shm.write_detection_result(
                    frame_number=frame.frame_number,
                    timestamp_sec=frame.timestamp_sec,
                    detections=detection_dicts,
                )

                # 統計更新
                self.stats["frames_processed"] += 1
                self.stats["total_detections"] += len(detections)
                self.stats["avg_inference_time_ms"] = timing["total"] * 1000

                # 毎フレームログ出力（デバッグ用）
                classes = [d["class_name"] for d in detection_dicts]
                logger.info(
                    f"Frame #{self.stats['frames_processed']}: "
                    f"{len(detections)} detections {classes if classes else '(none)'} "
                    f"- {timing['total'] * 1000:.1f}ms "
                    f"(prep={timing['preprocessing'] * 1000:.1f}ms, "
                    f"infer={timing['inference'] * 1000:.1f}ms, "
                    f"post={timing['postprocessing'] * 1000:.1f}ms)"
                )

                # 検出詳細をデバッグ出力
                if detections:
                    for det in detections:
                        logger.debug(
                            f"  -> {det.class_name.value}: {det.confidence:.2f} "
                            f"@ ({det.bbox.x}, {det.bbox.y}, {det.bbox.w}, {det.bbox.h})"
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

    args = parser.parse_args()

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
