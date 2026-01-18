#!/usr/bin/env python3
"""
YOLO検出テストスクリプト

複数のYOLOモデル（v8, v11, v13）のパフォーマンスを測定し、
詳細なログを出力します。
"""

import argparse
import sys
import time
import json
import logging
from pathlib import Path
from typing import Optional
from datetime import datetime
import cv2
import numpy as np

# プロジェクトルートをパスに追加
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src" / "common" / "src"))

from detection.yolo_detector import YoloDetector
from common.types import Detection

# モデル定義
YOLO_MODELS = {
    "v8n": {
        "url": "https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x5/ultralytics_YOLO/yolov8n_detect_bayese_640x640_nv12.bin",
        "filename": "yolov8n_detect_bayese_640x640_nv12.bin",
        "description": "YOLOv8 nano - 高速・軽量",
    },
    "v11n": {
        "url": "https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x5/ultralytics_YOLO/yolo11n_detect_bayese_640x640_nv12.bin",
        "filename": "yolo11n_detect_bayese_640x640_nv12.bin",
        "description": "YOLO11 nano - 最速",
    },
    "v13n": {
        "url": "https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x5/ultralytics_YOLO/yolov13n_detect_bayese_640x640_nv12.bin",
        "filename": "yolov13n_detect_bayese_640x640_nv12.bin",
        "description": "YOLO13 nano - 最新版",
    },
}


class PerformanceLogger:
    """パフォーマンス測定とログ出力"""

    def __init__(self, log_dir: Path, model_name: str):
        """
        初期化

        Args:
            log_dir: ログ出力ディレクトリ
            model_name: モデル名（v8n, v11n, v13n）
        """
        self.log_dir = log_dir
        self.log_dir.mkdir(parents=True, exist_ok=True)

        # タイムスタンプ付きログファイル名
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_file = self.log_dir / f"yolo_{model_name}_{timestamp}.log"
        self.json_file = self.log_dir / f"yolo_{model_name}_{timestamp}.json"

        # ロガー設定
        self.logger = logging.getLogger(f"YOLOTest_{model_name}")
        self.logger.setLevel(logging.DEBUG)

        # ファイルハンドラ
        fh = logging.FileHandler(self.log_file)
        fh.setLevel(logging.DEBUG)

        # コンソールハンドラ
        ch = logging.StreamHandler()
        ch.setLevel(logging.INFO)

        # フォーマット
        formatter = logging.Formatter(
            "[%(asctime)s.%(msecs)03d] [%(levelname)s] %(message)s",
            datefmt="%H:%M:%S",
        )
        fh.setFormatter(formatter)
        ch.setFormatter(formatter)

        self.logger.addHandler(fh)
        self.logger.addHandler(ch)

        # パフォーマンスデータ
        self.performance_data = {
            "model_name": model_name,
            "model_info": YOLO_MODELS.get(model_name, {}),
            "test_timestamp": timestamp,
            "frames": [],
            "summary": {},
        }

    def log_frame(
        self,
        frame_idx: int,
        total_time: float,
        preprocessing_time: float,
        inference_time: float,
        postprocessing_time: float,
        detections: list[Detection],
    ) -> None:
        """フレームごとのパフォーマンスをログ"""
        frame_data = {
            "frame_idx": frame_idx,
            "total_time_ms": total_time * 1000,
            "preprocessing_time_ms": preprocessing_time * 1000,
            "inference_time_ms": inference_time * 1000,
            "postprocessing_time_ms": postprocessing_time * 1000,
            "num_detections": len(detections),
            "detections": [
                {
                    "class": det.class_name.value,
                    "confidence": det.confidence,
                    "bbox": {
                        "x": det.bbox.x,
                        "y": det.bbox.y,
                        "w": det.bbox.w,
                        "h": det.bbox.h,
                    },
                }
                for det in detections
            ],
        }

        self.performance_data["frames"].append(frame_data)

        # コンソール出力
        self.logger.info(
            f"Frame {frame_idx}: {total_time*1000:.2f}ms "
            f"(prep={preprocessing_time*1000:.2f}ms, "
            f"infer={inference_time*1000:.2f}ms, "
            f"post={postprocessing_time*1000:.2f}ms) "
            f"- {len(detections)} detections"
        )

        # 検出詳細
        if detections:
            for det in detections:
                self.logger.debug(
                    f"  - {det.class_name.value}: {det.confidence:.2f} "
                    f"@ ({det.bbox.x}, {det.bbox.y}, {det.bbox.w}, {det.bbox.h})"
                )

    def finalize(self) -> None:
        """サマリー計算とJSON出力"""
        if not self.performance_data["frames"]:
            self.logger.warning("No frames processed")
            return

        # 統計計算
        total_times = [f["total_time_ms"] for f in self.performance_data["frames"]]
        prep_times = [
            f["preprocessing_time_ms"] for f in self.performance_data["frames"]
        ]
        infer_times = [f["inference_time_ms"] for f in self.performance_data["frames"]]
        post_times = [
            f["postprocessing_time_ms"] for f in self.performance_data["frames"]
        ]
        detection_counts = [
            f["num_detections"] for f in self.performance_data["frames"]
        ]

        summary = {
            "total_frames": len(total_times),
            "avg_total_time_ms": np.mean(total_times),
            "avg_preprocessing_time_ms": np.mean(prep_times),
            "avg_inference_time_ms": np.mean(infer_times),
            "avg_postprocessing_time_ms": np.mean(post_times),
            "min_total_time_ms": np.min(total_times),
            "max_total_time_ms": np.max(total_times),
            "std_total_time_ms": np.std(total_times),
            "avg_fps": 1000 / np.mean(total_times),
            "avg_detections_per_frame": np.mean(detection_counts),
        }

        self.performance_data["summary"] = summary

        # サマリーログ出力
        self.logger.info("=" * 60)
        self.logger.info("PERFORMANCE SUMMARY")
        self.logger.info("=" * 60)
        self.logger.info(f"Model: {self.performance_data['model_name']}")
        self.logger.info(f"Total frames: {summary['total_frames']}")
        self.logger.info(
            f"Average total time: {summary['avg_total_time_ms']:.2f}ms"
        )
        self.logger.info(
            f"  - Preprocessing: {summary['avg_preprocessing_time_ms']:.2f}ms"
        )
        self.logger.info(f"  - Inference: {summary['avg_inference_time_ms']:.2f}ms")
        self.logger.info(
            f"  - Postprocessing: {summary['avg_postprocessing_time_ms']:.2f}ms"
        )
        self.logger.info(f"Average FPS: {summary['avg_fps']:.2f}")
        self.logger.info(
            f"Average detections/frame: {summary['avg_detections_per_frame']:.2f}"
        )
        self.logger.info(
            f"Time range: {summary['min_total_time_ms']:.2f}ms ~ {summary['max_total_time_ms']:.2f}ms"
        )
        self.logger.info(f"Std deviation: {summary['std_total_time_ms']:.2f}ms")
        self.logger.info("=" * 60)

        # JSON出力
        with open(self.json_file, "w") as f:
            json.dump(self.performance_data, f, indent=2)

        self.logger.info(f"Detailed log saved: {self.log_file}")
        self.logger.info(f"JSON data saved: {self.json_file}")


def test_single_image(
    detector: YoloDetector,
    image_path: Path,
    perf_logger: PerformanceLogger,
    frame_idx: int = 0,
) -> list[Detection]:
    """単一画像でテスト"""
    # 画像読み込み
    img = cv2.imread(str(image_path))
    if img is None:
        perf_logger.logger.error(f"Failed to load image: {image_path}")
        return []

    # JPEGエンコード
    _, jpeg_data = cv2.imencode(".jpg", img)
    frame_data = jpeg_data.tobytes()

    # 検出実行
    detections = detector.detect(frame_data)

    # YoloDetectorから詳細タイミング情報を取得
    timing = detector.get_last_timing()

    # ログ記録
    perf_logger.log_frame(
        frame_idx,
        timing["total"],
        timing["preprocessing"],
        timing["inference"],
        timing["postprocessing"],
        detections,
    )

    return detections


def test_multiple_images(
    detector: YoloDetector,
    image_dir: Path,
    perf_logger: PerformanceLogger,
    max_images: int = 10,
) -> None:
    """複数画像でテスト"""
    # 画像ファイルを取得
    image_files = []
    for ext in ["*.jpg", "*.jpeg", "*.png"]:
        image_files.extend(image_dir.glob(ext))

    if not image_files:
        perf_logger.logger.error(f"No images found in {image_dir}")
        return

    # 最大枚数に制限
    image_files = sorted(image_files)[:max_images]

    perf_logger.logger.info(f"Testing with {len(image_files)} images")

    for idx, img_path in enumerate(image_files):
        perf_logger.logger.info(f"Processing {img_path.name}...")
        test_single_image(detector, img_path, perf_logger, frame_idx=idx)


def download_model(model_key: str, models_dir: Path) -> Path:
    """モデルをダウンロード"""
    model_info = YOLO_MODELS[model_key]
    model_path = models_dir / model_info["filename"]

    if model_path.exists():
        print(f"Model already exists: {model_path}")
        return model_path

    print(f"Downloading {model_key}: {model_info['description']}")
    print(f"URL: {model_info['url']}")

    models_dir.mkdir(parents=True, exist_ok=True)

    import urllib.request

    try:
        urllib.request.urlretrieve(model_info["url"], model_path)
        print(f"Downloaded to: {model_path}")
    except Exception as e:
        print(f"Failed to download model: {e}")
        raise

    return model_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Test YOLO detection with performance measurement"
    )

    parser.add_argument(
        "--model",
        type=str,
        default="v11n",
        choices=list(YOLO_MODELS.keys()),
        help="YOLO model version to test",
    )

    parser.add_argument(
        "--all-models",
        action="store_true",
        help="Test all YOLO models (v8n, v11n, v13n)",
    )

    parser.add_argument(
        "--image",
        type=Path,
        help="Single test image path",
    )

    parser.add_argument(
        "--image-dir",
        type=Path,
        help="Directory containing test images",
    )

    parser.add_argument(
        "--max-images",
        type=int,
        default=10,
        help="Maximum number of images to test (default: 10)",
    )

    parser.add_argument(
        "--models-dir",
        type=Path,
        default=Path("/tmp/yolo_models"),
        help="Directory to store downloaded models (default: /tmp/yolo_models)",
    )

    parser.add_argument(
        "--log-dir",
        type=Path,
        default=PROJECT_ROOT / "logs" / "yolo_tests",
        help="Directory to save logs (default: ./logs/yolo_tests)",
    )

    parser.add_argument(
        "--score-threshold",
        type=float,
        default=0.25,
        help="Detection score threshold (default: 0.25)",
    )

    parser.add_argument(
        "--nms-threshold",
        type=float,
        default=0.7,
        help="NMS IoU threshold (default: 0.7)",
    )

    args = parser.parse_args()

    # テスト画像の検証
    if not args.image and not args.image_dir:
        # デフォルト画像を使用
        default_test_image = Path(
            "/app/github/rdk_model_zoo/demos/Vision/ultralytics_YOLO/"
        ) / "../../../resource/datasets/COCO2017/assets/bus.jpg"
        if default_test_image.exists():
            args.image = default_test_image
            print(f"Using default test image: {args.image}")
        else:
            parser.error("No test image specified. Use --image or --image-dir")

    # テストするモデルリスト
    models_to_test = list(YOLO_MODELS.keys()) if args.all_models else [args.model]

    print("=" * 60)
    print("YOLO Detection Performance Test")
    print("=" * 60)
    print(f"Models to test: {', '.join(models_to_test)}")
    print(f"Log directory: {args.log_dir}")
    print(f"Models directory: {args.models_dir}")
    print("=" * 60)

    # 各モデルでテスト
    for model_key in models_to_test:
        print(f"\n{'='*60}")
        print(f"Testing {model_key}: {YOLO_MODELS[model_key]['description']}")
        print(f"{'='*60}")

        # モデルダウンロード
        model_path = download_model(model_key, args.models_dir)

        # パフォーマンスロガー初期化
        perf_logger = PerformanceLogger(args.log_dir, model_key)

        try:
            # YoloDetector初期化
            perf_logger.logger.info(f"Loading model: {model_path}")
            detector = YoloDetector(
                model_path=str(model_path),
                score_threshold=args.score_threshold,
                nms_threshold=args.nms_threshold,
                auto_download=False,
            )

            # テスト実行
            if args.image:
                perf_logger.logger.info(f"Testing single image: {args.image}")
                test_single_image(detector, args.image, perf_logger)
            elif args.image_dir:
                test_multiple_images(
                    detector, args.image_dir, perf_logger, args.max_images
                )

            # サマリー出力
            perf_logger.finalize()

        except Exception as e:
            perf_logger.logger.error(f"Test failed: {e}")
            import traceback

            traceback.print_exc()
            continue

    print("\n" + "=" * 60)
    print("All tests completed!")
    print(f"Logs saved to: {args.log_dir}")
    print("=" * 60)


if __name__ == "__main__":
    main()
