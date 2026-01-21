#!/usr/bin/env python
"""
RDK X5用YOLO物体検出実装

Ultralytics YOLOモデル（YOLOv13nなど）を使用した物体検出
MockDetectorと同じインターフェースを提供
"""

import os
import sys
from pathlib import Path
from typing import Optional
import logging

import cv2
import numpy as np
from scipy.special import softmax

# hobot_dnn (RDK X5 BPU API)
try:
    from hobot_dnn import pyeasy_dnn as dnn
except ImportError:
    try:
        from hobot_dnn_rdkx5 import pyeasy_dnn as dnn
    except ImportError:
        raise ImportError(
            "hobot_dnn or hobot_dnn_rdkx5 is required. "
            "Install with: pip install hobot_dnn_rdkx5"
        )

# 共通型定義をインポート
sys.path.insert(0, str(Path(__file__).parent.parent))
from common.types import Detection, DetectionClass, BoundingBox


# COCOクラス名（80クラス）
COCO_CLASS_NAMES = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
    'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
    'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
    'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
    'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
]

# COCO class ID → DetectionClass マッピング
COCO_TO_DETECTION_CLASS = {
    0: DetectionClass.PERSON,          # person
    14: DetectionClass.BIRD,           # bird
    15: DetectionClass.CAT,            # cat
    16: DetectionClass.DOG,            # dog
    24: DetectionClass.BACKPACK,       # backpack
    25: DetectionClass.UMBRELLA,       # umbrella
    26: DetectionClass.HANDBAG,        # handbag
    28: DetectionClass.SUITCASE,       # suitcase
    39: DetectionClass.BOTTLE,         # bottle
    40: DetectionClass.WINE_GLASS,     # wine glass
    41: DetectionClass.CUP,            # cup
    42: DetectionClass.FORK,           # fork
    43: DetectionClass.KNIFE,          # knife
    44: DetectionClass.SPOON,          # spoon
    45: DetectionClass.FOOD_BOWL,      # bowl → food_bowl
    46: DetectionClass.BANANA,         # banana
    47: DetectionClass.APPLE,          # apple
    48: DetectionClass.SANDWICH,       # sandwich
    49: DetectionClass.ORANGE,         # orange
    50: DetectionClass.BROCCOLI,       # broccoli
    51: DetectionClass.CARROT,         # carrot
    52: DetectionClass.HOT_DOG,        # hot dog
    53: DetectionClass.PIZZA,          # pizza
    54: DetectionClass.DONUT,          # donut
    55: DetectionClass.CAKE,           # cake
    56: DetectionClass.CHAIR,          # chair
    57: DetectionClass.COUCH,          # couch
    58: DetectionClass.POTTED_PLANT,   # potted plant
    59: DetectionClass.BED,            # bed
    60: DetectionClass.DINING_TABLE,   # dining table
    61: DetectionClass.TOILET,         # toilet
    62: DetectionClass.TV,             # tv
    63: DetectionClass.LAPTOP,         # laptop
    64: DetectionClass.MOUSE,          # mouse
    65: DetectionClass.REMOTE,         # remote
    66: DetectionClass.KEYBOARD,       # keyboard
    67: DetectionClass.CELL_PHONE,     # cell phone
    68: DetectionClass.MICROWAVE,      # microwave
    69: DetectionClass.OVEN,           # oven
    70: DetectionClass.TOASTER,        # toaster
    71: DetectionClass.SINK,           # sink
    72: DetectionClass.REFRIGERATOR,   # refrigerator
    73: DetectionClass.BOOK,           # book
    74: DetectionClass.CLOCK,          # clock
    75: DetectionClass.VASE,           # vase
    77: DetectionClass.TEDDY_BEAR,     # teddy bear
    78: DetectionClass.HAIR_DRIER,     # hair drier
    79: DetectionClass.TOOTHBRUSH,     # toothbrush
    # dishは複数のbowlを検出する場合などに使用
    # または別途カスタムモデルで定義
}


logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)  # DEBUG→INFO (大量ログでCPU負荷削減)


class YoloDetector:
    """
    RDK X5上でYOLOモデルを使用した物体検出

    MockDetectorと同じインターフェースを提供し、
    実際のYOLOv13などのモデルを使用して物体検出を実行。

    Attributes:
        model_path: BPU量子化済み.binモデルのパス
        score_threshold: 信頼度閾値（0.0 ~ 1.0）
        nms_threshold: NMS IoU閾値（0.0 ~ 1.0）
        input_size: 入力画像サイズ（デフォルト: 640x640）
    """

    def __init__(
        self,
        model_path: str,
        score_threshold: float = 0.25,
        nms_threshold: float = 0.7,
        reg: int = 16,
        strides: list[int] = [8, 16, 32],
        input_size: tuple[int, int] = (640, 640),
        auto_download: bool = True,
        clahe_enabled: bool = True,
        clahe_brightness_threshold: float = 60.0,
        clahe_clip_limit: float = 3.0,
    ) -> None:
        """
        初期化

        Args:
            model_path: BPU量子化済み.binモデルのパス
            score_threshold: 信頼度閾値
            nms_threshold: NMS IoU閾値
            reg: DFL reg layer数
            strides: ストライド値
            input_size: 入力画像サイズ (height, width)
            auto_download: モデルが存在しない場合に自動ダウンロード
            clahe_enabled: CLAHE前処理を有効化
            clahe_brightness_threshold: この輝度以下でCLAHE適用 (0-255)
            clahe_clip_limit: CLAHEのコントラスト制限値 (大きいほど強調)
        """
        self.model_path = model_path
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self.reg = reg
        self.strides = strides
        self.input_size = input_size

        # CLAHE前処理設定 (ISP補正の代替)
        # 実測brightness_avgは最大80程度のため、閾値を低めに設定
        self.clahe_enabled = clahe_enabled
        self.clahe_brightness_threshold = clahe_brightness_threshold
        self.clahe = cv2.createCLAHE(clipLimit=clahe_clip_limit, tileGridSize=(8, 8))

        # モデルの自動ダウンロード
        if auto_download and not os.path.exists(model_path):
            logger.warning(f"Model file {model_path} not found. Downloading default model...")
            self._download_default_model()

        # BPUモデルのロード
        try:
            self.quantize_model = dnn.load(self.model_path)
            logger.info(f"Loaded YOLO model: {self.model_path}")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise

        # 入力・出力テンソル情報
        self.input_h, self.input_w = self.quantize_model[0].inputs[0].properties.shape[2:4]
        logger.info(f"Model input size: {self.input_h}x{self.input_w}")

        # DFL期待値計算用の重み（静的生成）
        self.weights_static = np.array([i for i in range(reg)]).astype(np.float32)[
            np.newaxis, np.newaxis, :
        ]

        # 信頼度閾値の生値
        self.conf_thres_raw = -np.log(1 / self.score_threshold - 1)

        # Grid anchors（前計算して保持）
        self.grids = []
        for stride in self.strides:
            grid_h = self.input_h // stride
            grid_w = self.input_w // stride
            grid = np.stack(
                [
                    np.tile(np.linspace(0.5, grid_h - 0.5, grid_h), reps=grid_h),
                    np.repeat(np.arange(0.5, grid_w + 0.5, 1), grid_w),
                ],
                axis=0,
            ).transpose(1, 0)
            self.grids.append(grid)
            logger.debug(f"Grid {stride}: shape={grid.shape}")

        # 統計情報
        self._total_detections = 0
        self._total_calls = 0
        self._total_inference_time = 0.0

        # CLAHE/輝度補正統計
        self._brightness_stats = {
            "frames_clahe_applied": 0,    # CLAHE適用フレーム数
            "frames_clahe_skipped": 0,    # CLAHEスキップフレーム数
            "clahe_time_total_ms": 0.0,   # CLAHE処理の累計時間
            "last_brightness_avg": 0.0,   # 最後の入力輝度
            "last_clahe_applied": False,  # 最後のフレームでCLAHE適用したか
        }

        # 詳細タイミング情報
        self._last_timing = {
            "preprocessing": 0.0,
            "inference": 0.0,
            "postprocessing": 0.0,
            "clahe": 0.0,
            "total": 0.0,
        }

    def _download_default_model(self) -> None:
        """デフォルトモデル（YOLOv13n）をダウンロード"""
        import urllib.request

        url = "https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x5/ultralytics_YOLO/yolov13n_detect_bayese_640x640_nv12.bin"

        # 保存先ディレクトリを作成
        model_dir = Path(self.model_path).parent
        model_dir.mkdir(parents=True, exist_ok=True)

        logger.info(f"Downloading model from {url}...")
        urllib.request.urlretrieve(url, self.model_path)
        logger.info(f"Model downloaded to {self.model_path}")

    def detect(self, frame_data: bytes) -> list[Detection]:
        """
        物体検出を実行

        Args:
            frame_data: JPEGエンコードされたフレームデータ

        Returns:
            検出結果のリスト
        """
        import time
        start_total = time.perf_counter()
        self._total_calls += 1

        # 1. JPEGデコード + 前処理（YUV420SP変換、letterbox）
        start_prep = time.perf_counter()
        img = self._decode_jpeg(frame_data)
        if img is None:
            logger.warning("Failed to decode JPEG frame")
            return []

        input_tensor, scale, shift = self._preprocess_yuv420sp(img)
        end_prep = time.perf_counter()
        self._last_timing["preprocessing"] = end_prep - start_prep

        # 2. BPU推論
        start_infer = time.perf_counter()
        outputs = self._forward(input_tensor)
        end_infer = time.perf_counter()
        self._last_timing["inference"] = end_infer - start_infer

        # 3. 後処理（NMS、座標変換）
        start_post = time.perf_counter()
        detections = self._postprocess(outputs, scale, shift, img.shape[:2])
        end_post = time.perf_counter()
        self._last_timing["postprocessing"] = end_post - start_post

        end_total = time.perf_counter()
        self._last_timing["total"] = end_total - start_total

        # 統計情報の更新
        self._total_detections += len(detections)
        self._total_inference_time += self._last_timing["total"]

        return detections

    def detect_nv12(
        self,
        nv12_data: bytes | memoryview,
        width: int,
        height: int,
        brightness_avg: float = -1.0,
    ) -> list[Detection]:
        """
        NV12フォーマットのフレームから物体検出を実行（高速パス）

        VSE等のハードウェアリサイザで既に640x640にリサイズ済みのNV12データを
        直接受け取ることで、CPU負荷の高い色変換・リサイズ処理を完全に省略。

        Args:
            nv12_data: NV12フォーマットのフレームデータ (bytes or memoryview)
            width: フレーム幅
            height: フレーム高さ
            brightness_avg: ISPからの平均輝度 (0-255)。-1の場合は自動計算

        Returns:
            検出結果のリスト
        """
        import time
        start_total = time.perf_counter()
        self._total_calls += 1

        # 1. 前処理（CLAHE適用 + サイズ調整）
        start_prep = time.perf_counter()

        # NV12データをnumpy配列に変換
        y_size = width * height
        nv12_array = np.frombuffer(nv12_data, dtype=np.uint8).copy()

        # CLAHE適用（低照度時のみ、輝度が取得できない場合はスキップ）
        clahe_applied = False
        if brightness_avg >= 0:
            self._brightness_stats["last_brightness_avg"] = brightness_avg
            if self.clahe_enabled and brightness_avg < self.clahe_brightness_threshold:
                start_clahe = time.perf_counter()
                nv12_array = self._apply_clahe_nv12(nv12_array, width, height)
                clahe_time = (time.perf_counter() - start_clahe) * 1000
                self._brightness_stats["clahe_time_total_ms"] += clahe_time
                self._brightness_stats["frames_clahe_applied"] += 1
                clahe_applied = True
                logger.debug(f"CLAHE applied: brightness={brightness_avg:.1f}, time={clahe_time:.2f}ms")
            else:
                self._brightness_stats["frames_clahe_skipped"] += 1
        else:
            # 輝度情報なし → CLAHEスキップ
            self._brightness_stats["frames_clahe_skipped"] += 1

        self._brightness_stats["last_clahe_applied"] = clahe_applied

        # CLAHE統計を100フレームごとにDEBUGレベルで出力
        total_clahe_frames = self._brightness_stats["frames_clahe_applied"] + self._brightness_stats["frames_clahe_skipped"]
        if total_clahe_frames > 0 and total_clahe_frames % 100 == 0:
            applied = self._brightness_stats["frames_clahe_applied"]
            rate = applied / total_clahe_frames * 100
            avg_time = self._brightness_stats["clahe_time_total_ms"] / applied if applied > 0 else 0
            logger.debug(f"CLAHE stats: {applied}/{total_clahe_frames} frames ({rate:.1f}%), avg={avg_time:.2f}ms, brightness={brightness_avg:.1f}")

        if width == self.input_w and height == self.input_h:
            # 既に正しいサイズ：そのまま使用（最速パス）
            input_tensor = nv12_array
            scale = (1.0, 1.0)
            shift = (0.0, 0.0)
            original_shape = (height, width)
            logger.debug(f"NV12 direct path: {width}x{height} (CLAHE={clahe_applied})")
        else:
            # サイズが異なる場合：NV12→BGR→前処理
            logger.debug(f"NV12 resize path: {width}x{height} → {self.input_w}x{self.input_h}")
            img = self._decode_nv12(nv12_array.tobytes(), width, height)
            if img is None:
                logger.warning("Failed to decode NV12 frame")
                return []
            input_tensor, scale, shift = self._preprocess_yuv420sp(img)
            original_shape = (height, width)

        end_prep = time.perf_counter()
        self._last_timing["preprocessing"] = end_prep - start_prep

        # 2. BPU推論
        start_infer = time.perf_counter()
        outputs = self._forward(input_tensor)
        end_infer = time.perf_counter()
        self._last_timing["inference"] = end_infer - start_infer

        # 3. 後処理（NMS、座標変換）
        start_post = time.perf_counter()
        detections = self._postprocess(outputs, scale, shift, original_shape)
        end_post = time.perf_counter()
        self._last_timing["postprocessing"] = end_post - start_post

        end_total = time.perf_counter()
        self._last_timing["total"] = end_total - start_total

        # 統計情報の更新
        self._total_detections += len(detections)
        self._total_inference_time += self._last_timing["total"]

        return detections

    def _decode_jpeg(self, frame_data: bytes) -> Optional[np.ndarray]:
        """JPEGデータをデコードしてBGR画像に変換"""
        try:
            img_array = np.frombuffer(frame_data, dtype=np.uint8)
            img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
            return img
        except Exception as e:
            logger.error(f"JPEG decode failed: {e}")
            return None

    def _decode_nv12(
        self, nv12_data: bytes | memoryview, width: int, height: int
    ) -> Optional[np.ndarray]:
        """NV12データをデコードしてBGR画像に変換"""
        try:
            y_size = width * height
            uv_size = y_size // 2

            if len(nv12_data) < y_size + uv_size:
                logger.error(
                    f"NV12 data too small: {len(nv12_data)} < {y_size + uv_size}"
                )
                return None

            # NV12を1次元配列として準備
            yuv_data = np.frombuffer(nv12_data[: y_size + uv_size], dtype=np.uint8)

            # NV12形式: [Y: height x width] [UV: height/2 x width (interleaved)]
            yuv_img = yuv_data.reshape((height * 3 // 2, width))

            # NV12 → BGR変換
            bgr_img = cv2.cvtColor(yuv_img, cv2.COLOR_YUV2BGR_NV12)

            return bgr_img
        except Exception as e:
            logger.error(f"NV12 decode failed: {e}")
            return None

    def _apply_clahe_nv12(
        self, nv12_array: np.ndarray, width: int, height: int
    ) -> np.ndarray:
        """
        NV12のY平面にCLAHEを適用

        CLAHEは局所的なコントラスト改善を行い、低照度画像の視認性を向上させる。
        UV平面は変更しない（色情報は保持）。

        Args:
            nv12_array: NV12データ (Y + UV)
            width: 画像幅
            height: 画像高さ

        Returns:
            CLAHE適用後のNV12データ
        """
        y_size = width * height

        # Y平面を抽出して2D配列に変換
        y_plane = nv12_array[:y_size].reshape(height, width)

        # CLAHEを適用
        y_enhanced = self.clahe.apply(y_plane)

        # 結果を元の配列に書き戻す
        nv12_array[:y_size] = y_enhanced.flatten()

        return nv12_array

    def _preprocess_yuv420sp(
        self, img: np.ndarray
    ) -> tuple[np.ndarray, tuple[float, float], tuple[float, float]]:
        """
        前処理: BGR → YUV420SP (NV12) 変換 + letterbox

        Returns:
            (input_tensor, (y_scale, x_scale), (y_shift, x_shift))
        """
        img_h, img_w = img.shape[:2]

        # letterboxのスケール計算
        scale = min(self.input_h / img_h, self.input_w / img_w)
        new_h, new_w = int(img_h * scale), int(img_w * scale)

        # リサイズ
        img_resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

        # パディング（中央配置）
        pad_h = (self.input_h - new_h) // 2
        pad_w = (self.input_w - new_w) // 2

        img_padded = np.full((self.input_h, self.input_w, 3), 114, dtype=np.uint8)
        img_padded[pad_h : pad_h + new_h, pad_w : pad_w + new_w] = img_resized

        # BGR → YUV420SP (NV12)
        img_yuv = cv2.cvtColor(img_padded, cv2.COLOR_BGR2YUV_I420)
        img_nv12 = self._yuv_i420_to_nv12(img_yuv, self.input_h, self.input_w)

        # スケールとシフト情報を返す（ピクセル単位）
        y_scale = x_scale = scale
        y_shift = float(pad_h)
        x_shift = float(pad_w)

        return img_nv12, (y_scale, x_scale), (y_shift, x_shift)

    def _yuv_i420_to_nv12(
        self, yuv_i420: np.ndarray, height: int, width: int
    ) -> np.ndarray:
        """
        YUV I420 → NV12 変換

        I420形式: YYYYYYYY UU VV (planar)
        NV12形式: YYYYYYYY UVUVUVUV (semi-planar)
        """
        area = height * width

        # I420を1次元配列に変換
        yuv420p = yuv_i420.reshape((area * 3 // 2,))

        # Y平面を取得
        y = yuv420p[:area]

        # UV平面を取得してインターリーブ
        uv_planar = yuv420p[area:].reshape((2, area // 4))
        uv_packed = uv_planar.transpose((1, 0)).reshape((area // 2,))

        # NV12形式で結合
        nv12 = np.zeros_like(yuv420p)
        nv12[:area] = y
        nv12[area:] = uv_packed

        return nv12

    def _forward(self, input_tensor: np.ndarray) -> list[np.ndarray]:
        """BPU推論を実行"""
        outputs = self.quantize_model[0].forward(input_tensor)

        # C API出力をnumpy配列に変換
        outputs_np = []
        for output in outputs:
            outputs_np.append(np.array(output.buffer).reshape(output.properties.shape))

        return outputs_np

    def _postprocess(
        self,
        outputs: list[np.ndarray],
        scale: tuple[float, float],
        shift: tuple[float, float],
        original_shape: tuple[int, int],
    ) -> list[Detection]:
        """
        後処理: NMS、座標変換、クラスマッピング

        Args:
            outputs: BPU推論結果
            scale: (y_scale, x_scale)
            shift: (y_shift, x_shift)
            original_shape: 元画像のサイズ (height, width)

        Returns:
            検出結果のリスト
        """
        y_scale, x_scale = scale
        y_shift, x_shift = shift
        orig_h, orig_w = original_shape

        # YOLO出力パース
        # 出力形式: [cls_1, bbox_1, cls_2, bbox_2, cls_3, bbox_3]
        # cls: [N, 80], bbox: [N, 64 (16 x 4)]
        num_classes = 80  # COCO

        logger.debug(f"Post-processing: {len(outputs)} outputs")
        for i, out in enumerate(outputs):
            logger.debug(f"  output[{i}]: shape={out.shape}, dtype={out.dtype}")

        clses = [
            outputs[0].reshape(-1, num_classes),
            outputs[2].reshape(-1, num_classes),
            outputs[4].reshape(-1, num_classes),
        ]
        bboxes = [
            outputs[1].reshape(-1, self.reg * 4),
            outputs[3].reshape(-1, self.reg * 4),
            outputs[5].reshape(-1, self.reg * 4),
        ]

        dbboxes_list, ids_list, scores_list = [], [], []
        total_candidates = 0

        for idx, (cls, bbox, stride, grid) in enumerate(zip(clses, bboxes, self.strides, self.grids)):
            # スコアフィルタリング
            max_scores = np.max(cls, axis=1)
            bbox_selected = np.flatnonzero(max_scores >= self.conf_thres_raw)

            logger.debug(
                f"  stride={stride}: {len(bbox_selected)}/{len(max_scores)} candidates "
                f"(threshold={self.conf_thres_raw:.2f}, score_thres={self.score_threshold:.2f})"
            )
            total_candidates += len(bbox_selected)

            if len(bbox_selected) == 0:
                continue

            # クラスID取得
            ids_list.append(np.argmax(cls[bbox_selected, :], axis=1))

            # Sigmoid計算でスコア変換
            scores_list.append(1 / (1 + np.exp(-max_scores[bbox_selected])))

            # DFL: dist2bbox (ltrb2xyxy)
            ltrb_selected = np.sum(
                softmax(bbox[bbox_selected, :].reshape(-1, 4, self.reg), axis=2)
                * self.weights_static,
                axis=2,
            )
            grid_selected = grid[bbox_selected, :]
            x1y1 = grid_selected - ltrb_selected[:, 0:2]
            x2y2 = grid_selected + ltrb_selected[:, 2:4]
            dbboxes_list.append(np.hstack([x1y1, x2y2]) * stride)

        if not dbboxes_list:
            logger.debug(f"No candidates passed threshold (total_candidates={total_candidates})")
            return []

        # 全スケールを結合
        dbboxes = np.concatenate(dbboxes_list, axis=0)
        scores = np.concatenate(scores_list, axis=0)
        ids = np.concatenate(ids_list, axis=0)

        logger.debug(f"Total candidates before NMS: {len(dbboxes)}")

        # xywh形式に変換（NMS用）
        hw = dbboxes[:, 2:4] - dbboxes[:, 0:2]
        xyhw2 = np.hstack([dbboxes[:, 0:2], hw])

        # クラス別NMS（検出されたクラスのみ処理、CPU負荷削減）
        detections = []
        nms_stats = {}

        # 実際に検出されたクラスのみ処理（80クラス全てではなく）
        unique_classes = np.unique(ids)

        for class_id in unique_classes:
            # マッピング対象外のクラスはNMS前にスキップ（CPU負荷削減）
            detection_class = self._map_coco_to_detection_class(class_id)
            if detection_class is None:
                continue

            id_indices = ids == class_id

            # OpenCVのNMS
            indices = cv2.dnn.NMSBoxes(
                xyhw2[id_indices, :],
                scores[id_indices],
                self.score_threshold,
                self.nms_threshold,
            )

            num_before_nms = np.sum(id_indices)
            num_after_nms = len(indices)

            if num_after_nms > 0:
                nms_stats[class_id] = (num_before_nms, num_after_nms)

            if len(indices) == 0:
                continue

            logger.debug(
                f"  class_id={class_id} ({COCO_CLASS_NAMES[class_id]}): "
                f"{num_before_nms} -> {num_after_nms} after NMS -> mapped to {detection_class.value}"
            )

            for indic in indices:
                x1, y1, x2, y2 = dbboxes[id_indices, :][indic]

                # letterbox座標→元画像座標に変換
                x1 = int((x1 - x_shift) / x_scale)
                y1 = int((y1 - y_shift) / y_scale)
                x2 = int((x2 - x_shift) / x_scale)
                y2 = int((y2 - y_shift) / y_scale)

                # クリッピング
                x1 = max(0, min(x1, orig_w))
                x2 = max(0, min(x2, orig_w))
                y1 = max(0, min(y1, orig_h))
                y2 = max(0, min(y2, orig_h))

                # BoundingBox作成（x, y, w, h形式）
                bbox = BoundingBox(x=x1, y=y1, w=x2 - x1, h=y2 - y1)

                detections.append(
                    Detection(
                        class_name=detection_class,
                        confidence=float(scores[id_indices][indic]),
                        bbox=bbox,
                    )
                )

        logger.debug(f"Final detections: {len(detections)}")
        if nms_stats:
            logger.debug(f"NMS stats (class_id: before->after): {nms_stats}")

        return detections

    def _map_coco_to_detection_class(
        self, coco_class_id: int
    ) -> Optional[DetectionClass]:
        """COCOクラスIDをDetectionClassにマッピング"""
        return COCO_TO_DETECTION_CLASS.get(coco_class_id)

    def get_stats(self) -> dict[str, float]:
        """
        統計情報を取得

        Returns:
            統計情報の辞書
        """
        avg_detections = (
            self._total_detections / self._total_calls if self._total_calls > 0 else 0.0
        )
        avg_time = (
            self._total_inference_time / self._total_calls
            if self._total_calls > 0
            else 0.0
        )

        # CLAHE統計
        clahe_applied = self._brightness_stats["frames_clahe_applied"]
        clahe_skipped = self._brightness_stats["frames_clahe_skipped"]
        clahe_rate = clahe_applied / (clahe_applied + clahe_skipped) if (clahe_applied + clahe_skipped) > 0 else 0.0
        avg_clahe_time = self._brightness_stats["clahe_time_total_ms"] / clahe_applied if clahe_applied > 0 else 0.0

        return {
            "total_calls": self._total_calls,
            "total_detections": self._total_detections,
            "avg_detections_per_call": avg_detections,
            "avg_inference_time_ms": avg_time * 1000,
            "last_preprocessing_ms": self._last_timing["preprocessing"] * 1000,
            "last_inference_ms": self._last_timing["inference"] * 1000,
            "last_postprocessing_ms": self._last_timing["postprocessing"] * 1000,
            "last_total_ms": self._last_timing["total"] * 1000,
            # CLAHE統計
            "clahe_applied_frames": clahe_applied,
            "clahe_skipped_frames": clahe_skipped,
            "clahe_apply_rate": clahe_rate,
            "avg_clahe_time_ms": avg_clahe_time,
            "last_brightness_avg": self._brightness_stats["last_brightness_avg"],
            "last_clahe_applied": self._brightness_stats["last_clahe_applied"],
        }

    def get_last_timing(self) -> dict[str, float]:
        """
        最後の実行の詳細タイミングを取得（秒単位）

        Returns:
            タイミング情報の辞書
        """
        return self._last_timing.copy()

    def reset_stats(self) -> None:
        """統計情報をリセット"""
        self._total_detections = 0
        self._total_calls = 0
        self._total_inference_time = 0.0

    def __repr__(self) -> str:
        """文字列表現"""
        stats = self.get_stats()
        return (
            f"YoloDetector("
            f"model={Path(self.model_path).name}, "
            f"calls={stats['total_calls']}, "
            f"avg_det={stats['avg_detections_per_call']:.2f}, "
            f"avg_time={stats['avg_inference_time_ms']:.1f}ms)"
        )


# テスト用
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="[%(name)s] [%(levelname)s] %(message)s",
    )

    # テスト実行
    print("=== YoloDetector Test ===\n")

    # モデルパス（自動ダウンロード有効）
    detector = YoloDetector(
        model_path="/tmp/yolov13n_detect_bayese_640x640_nv12.bin",
        score_threshold=0.25,
        nms_threshold=0.7,
        auto_download=True,
    )

    # ダミーJPEGフレーム（実際のカメラ画像を使用する場合は置き換え）
    test_img_path = "/app/github/rdk_model_zoo/demos/Vision/ultralytics_YOLO/source/reference_yamls/bus.jpg"
    if os.path.exists(test_img_path):
        with open(test_img_path, "rb") as f:
            frame_data = f.read()

        detections = detector.detect(frame_data)
        print(f"Detected {len(detections)} objects")
        for det in detections:
            print(
                f"  - {det.class_name.value}: "
                f"confidence={det.confidence:.2f}, "
                f"bbox=({det.bbox.x}, {det.bbox.y}, {det.bbox.w}, {det.bbox.h})"
            )

    print(f"\n{detector}")
    print(f"Stats: {detector.get_stats()}")
