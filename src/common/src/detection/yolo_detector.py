#!/usr/bin/env python
"""
RDK X5用YOLO物体検出実装

Ultralytics YOLOモデル（YOLOv13nなど）を使用した物体検出
MockDetectorと同じインターフェースを提供
"""

import os
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional
import logging

import cv2
import numpy as np


class Preprocessor(ABC):
    """Abstract base class for YOLO input preprocessing."""

    @abstractmethod
    def letterbox(self, nv12_array: np.ndarray, width: int, height: int,
                  pad_top: int, pad_bottom: int) -> np.ndarray:
        """Add letterbox padding to NV12 frame. Returns padded NV12."""

    @abstractmethod
    def crop_roi(self, nv12_array: np.ndarray, width: int, height: int,
                 roi_x: int, roi_y: int, roi_w: int, roi_h: int) -> np.ndarray:
        """Crop ROI from NV12 frame. Returns cropped NV12."""


class HWPreprocessor(Preprocessor):
    """GPU-based letterbox using nano2D (GC820). CPU fallback for crop_roi.

    Usage:
        hw = HWPreprocessor(detector)
        hw.set_hb_mem_buffer(hb_mem_buffer)  # call before each letterbox
        result = hw.letterbox(nv12, w, h, pad_top, pad_bottom)
    """

    def __init__(self, detector: "YoloDetector", lib_path: str = "") -> None:
        import ctypes
        self._detector = detector
        self._ctx = None
        self._lib = None
        self._hb_buf = None  # Current frame's HbMemGraphicBuffer

        if not lib_path:
            lib_path = str(Path(__file__).parents[4] / "build" / "libn2d_letterbox.so")

        try:
            self._lib = ctypes.CDLL(lib_path)
            self._lib.n2d_letterbox_create.restype = ctypes.c_void_p
            self._lib.n2d_letterbox_create.argtypes = [
                ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
            self._lib.n2d_letterbox_process.restype = ctypes.c_int
            self._lib.n2d_letterbox_process.argtypes = [
                ctypes.c_void_p, ctypes.c_uint64, ctypes.c_uint64,
                ctypes.c_int, ctypes.POINTER(ctypes.c_void_p),
                ctypes.POINTER(ctypes.c_size_t)]
            self._lib.n2d_letterbox_destroy.restype = None
            self._lib.n2d_letterbox_destroy.argtypes = [ctypes.c_void_p]
            logging.getLogger(__name__).info("HWPreprocessor: loaded %s", lib_path)
        except OSError as e:
            logging.getLogger(__name__).warning("HWPreprocessor: failed to load %s: %s", lib_path, e)

    def set_hb_mem_buffer(self, buf) -> None:
        """Set the current frame's HbMemGraphicBuffer for GPU letterbox."""
        self._hb_buf = buf

    def _ensure_ctx(self, src_w: int, src_h: int, dst_w: int, dst_h: int) -> bool:
        if self._lib is None:
            return False
        if self._ctx is None:
            self._ctx = self._lib.n2d_letterbox_create(src_w, src_h, dst_w, dst_h)
            if not self._ctx:
                logging.getLogger(__name__).error("HWPreprocessor: n2d_letterbox_create failed")
                return False
        return True

    def letterbox(self, nv12_array: np.ndarray, width: int, height: int,
                  pad_top: int, pad_bottom: int) -> np.ndarray:
        import ctypes

        dst_h = height + pad_top + pad_bottom
        buf = self._hb_buf

        if buf and hasattr(buf, 'phys_addr') and buf.phys_addr:
            phys = buf.phys_addr
            stride = buf.stride if hasattr(buf, 'stride') and buf.stride else width
            phys_y = phys[0]
            phys_uv = phys[1] if len(phys) > 1 else 0

            if phys_y and self._ensure_ctx(width, height, width, dst_h):
                out_ptr = ctypes.c_void_p()
                out_size = ctypes.c_size_t()
                ret = self._lib.n2d_letterbox_process(
                    self._ctx, phys_y, phys_uv, stride,
                    ctypes.byref(out_ptr), ctypes.byref(out_size))
                if ret == 0 and out_ptr.value:
                    arr_type = ctypes.c_uint8 * out_size.value
                    return np.ctypeslib.as_array(arr_type.from_address(out_ptr.value))

        raise RuntimeError("HWPreprocessor: nano2D letterbox failed")

    def crop_roi(self, nv12_array: np.ndarray, width: int, height: int,
                 roi_x: int, roi_y: int, roi_w: int, roi_h: int) -> np.ndarray:
        return self._detector._crop_nv12_roi(nv12_array, width, height, roi_x, roi_y, roi_w, roi_h)

    def __del__(self) -> None:
        if self._ctx and self._lib:
            self._lib.n2d_letterbox_destroy(self._ctx)
            self._ctx = None


def _fast_softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    """
    Numpy implementation of softmax (replaces scipy.special.softmax).

    ~2x faster than scipy due to reduced import overhead and simpler code path.
    Numerically stable via max subtraction.
    """
    x_max = np.max(x, axis=axis, keepdims=True)
    e_x = np.exp(x - x_max)
    return e_x / np.sum(e_x, axis=axis, keepdims=True)

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
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
]

# COCO class ID → DetectionClass マッピング
COCO_TO_DETECTION_CLASS = {
    0: DetectionClass.PERSON,  # person
    15: DetectionClass.CAT,  # cat
    16: DetectionClass.DOG,  # dog
    41: DetectionClass.CUP,  # cup
    45: DetectionClass.FOOD_BOWL,  # bowl → food_bowl
    56: DetectionClass.CHAIR,  # chair
}

# 対象クラスの列インデックス (np.max/argmaxを対象列のみに限定する最適化用)
_TARGET_CLASS_COLS = np.array(sorted(COCO_TO_DETECTION_CLASS.keys()), dtype=np.intp)


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
        model_type: str = "auto",
        score_threshold: float = 0.25,
        nms_threshold: float = 0.7,
        reg: int = 16,
        strides: list[int] = [8, 16, 32],
        input_size: tuple[int, int] = (640, 640),
        auto_download: bool = True,
        clahe_enabled: bool = False,
        clahe_clip_limit: float = 3.0,
        clahe_frequency: int = 1,
    ) -> None:
        """
        初期化

        Args:
            model_path: BPU量子化済み.binモデルのパス
            model_type: モデルタイプ ("auto", "legacy", "yolo26")
                - "auto": モデルファイル名から自動検出
                - "legacy": v8/v11/v13等の従来モデル (cls→bbox, DFL形式)
                - "yolo26": YOLO26 (bbox→cls, direct xyxy形式)
            score_threshold: 信頼度閾値
            nms_threshold: NMS IoU閾値
            reg: DFL reg layer数 (YOLO26では使用しない)
            strides: ストライド値
            input_size: 入力画像サイズ (height, width)
            auto_download: モデルが存在しない場合に自動ダウンロード
            clahe_enabled: CLAHE前処理を有効化 (nightカメラ専用、daemon側で制御)
            clahe_clip_limit: CLAHEのコントラスト制限値 (大きいほど強調)
            clahe_frequency: N回に1回CLAHEを適用 (1=毎回, 3=3回に1回)
        """
        self.model_path = model_path
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self.reg = reg
        self.strides = strides
        self.input_size = input_size

        # モデルタイプの自動検出
        if model_type == "auto":
            self.model_type = "yolo26" if "yolo26" in model_path.lower() else "legacy"
        else:
            self.model_type = model_type
        logger.debug(f"Model type: {self.model_type}")

        # CLAHE前処理設定 (nightカメラのIR映像用、daemon側でclahe_enabledを制御)
        self.clahe_enabled = clahe_enabled
        self.clahe_frequency = clahe_frequency
        self._clahe_frame_counter = 0
        self.clahe = cv2.createCLAHE(clipLimit=clahe_clip_limit, tileGridSize=(8, 8))
        # CLAHE Y-plane cache: stores enhanced Y plane to reuse across frames/ROIs.
        # Key: (width, height), Value: enhanced Y plane (uint8 2D array).
        self._clahe_y_cache: dict[tuple[int, int], np.ndarray] = {}

        # Preprocessor (set by detector daemon — HWPreprocessor for real HW)
        self.preprocessor: Optional[Preprocessor] = None

        # モデルの自動ダウンロード
        if auto_download and not os.path.exists(model_path):
            logger.warning(
                f"Model file {model_path} not found. Downloading default model..."
            )
            self._download_default_model()

        # BPUモデルのロード
        try:
            self.quantize_model = dnn.load(self.model_path)
            logger.debug(f"Loaded YOLO model: {self.model_path}")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")
            raise

        # 入力・出力テンソル情報
        self.input_h, self.input_w = (
            self.quantize_model[0].inputs[0].properties.shape[2:4]
        )
        logger.debug(f"Model input size: {self.input_h}x{self.input_w}")

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

        # YOLO26用グリッドの事前計算
        if self.model_type == "yolo26":
            self._init_yolo26_grids()

        # COCOクラスIDの有効マスク (80クラス分、事前計算)
        self._coco_valid_mask = np.array(
            [i in COCO_TO_DETECTION_CLASS for i in range(80)],
            dtype=bool,
        )

        # 統計情報
        self._total_detections = 0
        self._total_calls = 0
        self._total_inference_time = 0.0

        # CLAHE/輝度補正統計
        self._brightness_stats = {
            "frames_clahe_applied": 0,  # CLAHE適用フレーム数
            "frames_clahe_skipped": 0,  # CLAHEスキップフレーム数
            "clahe_time_total_ms": 0.0,  # CLAHE処理の累計時間
            "last_brightness_avg": 0.0,  # 最後の入力輝度
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

        # レターボックス事前確保バッファ (遅延初期化)
        self._lb_buf: np.ndarray | None = None

        # Debug logging: only log detailed info once
        self._postprocess_debug_logged = False
        self._nv12_path_debug_logged = False
        self._lb_y_view: np.ndarray | None = None    # Y平面のview
        self._lb_uv_view: np.ndarray | None = None   # UV平面のview
        self._lb_y_dst: np.ndarray | None = None     # Yデータコピー先のview
        self._lb_uv_dst: np.ndarray | None = None    # UVデータコピー先のview

    def _download_default_model(self) -> None:
        """デフォルトモデル（YOLOv13n）をダウンロード"""
        import urllib.request

        url = "https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x5/ultralytics_YOLO/yolov13n_detect_bayese_640x640_nv12.bin"

        # 保存先ディレクトリを作成
        model_dir = Path(self.model_path).parent
        model_dir.mkdir(parents=True, exist_ok=True)

        logger.info(f"Downloading YOLO model from {url}...")
        urllib.request.urlretrieve(url, self.model_path)
        logger.info(f"Model downloaded: {self.model_path}")

    def _init_yolo26_grids(self) -> None:
        """YOLO26用のAnchor-Freeグリッドを事前計算

        YOLO26は従来モデルと異なり、直接座標(xyxy)を出力する。
        グリッドは各ストライドごとに (grid_h * grid_w, 2) の形式で保持。
        座標は (x, y) の順序で、各セルの中心 (+0.5) にオフセット。
        """
        self.grids_yolo26: dict[int, np.ndarray] = {}
        for stride in self.strides:
            grid_h = self.input_h // stride
            grid_w = self.input_w // stride
            # np.indices は (y, x) 順で返すので [::-1] で (x, y) に反転
            grid = np.stack(np.indices((grid_h, grid_w))[::-1], axis=-1)
            self.grids_yolo26[stride] = grid.reshape(-1, 2).astype(np.float32) + 0.5
            logger.debug(
                f"YOLO26 grid stride={stride}: shape={self.grids_yolo26[stride].shape}"
            )

    def get_roi_regions(
        self, width: int, height: int
    ) -> list[tuple[int, int, int, int]]:
        """
        指定サイズの画像に対するROI領域を計算

        3パターン巡回方式でデッドゾーンを解消:
        - パターン0 (上寄せ): y=0
        - パターン1 (中央): y=40
        - パターン2 (下寄せ): y=80

        Args:
            width: 入力画像幅
            height: 入力画像高さ

        Returns:
            ROI領域のリスト [(x, y, w, h), ...]
            各ROIは640x640サイズ
            1280x720の場合: 6 ROIs (3パターン × 2左右)
        """
        roi_size = self.input_w  # 640
        rois = []

        if width == 1280 and height == 720:
            # 1280x720: 6 ROIs (3パターン × 2左右)
            # パターン巡回でデッドゾーンを解消
            y_offsets = [0, 40, 80]  # 上寄せ, 中央, 下寄せ
            for y_offset in y_offsets:
                rois.append((0, y_offset, roi_size, roi_size))  # 左
                rois.append((width - roi_size, y_offset, roi_size, roi_size))  # 右
        elif width == 1920 and height == 1080:
            # 1920x1080: 6 ROIs (3x2グリッド, オーバーラップあり)
            x_step = (width - roi_size) // 2  # 640
            y_step = height - roi_size  # 440
            for row in range(2):
                for col in range(3):
                    x = col * x_step
                    y = row * y_step
                    rois.append((x, y, roi_size, roi_size))
        else:
            # その他: 中央の640x640
            x = max(0, (width - roi_size) // 2)
            y = max(0, (height - roi_size) // 2)
            rois = [(x, y, roi_size, roi_size)]

        return rois

    def get_roi_regions_720p(self) -> list[tuple[int, int, int, int]]:
        """
        1280x720入力用の3列ROI領域を計算（50%オーバーラップ）

        夜カメラ専用のROI配置:
        - 3列の水平ROI (stride=320px, overlap=320px)
        - 垂直方向は中央配置 (y_offset=40px)

        Returns:
            ROI領域のリスト [(x, y, w, h), ...]
            3 ROIs: ROI0(0,40), ROI1(320,40), ROI2(640,40)
        """
        roi_size = self.input_w  # 640
        stride = 320  # 50% overlap
        y_offset = 40  # (720 - 640) / 2 = 40

        rois = []
        for i in range(3):
            x = i * stride
            rois.append((x, y_offset, roi_size, roi_size))

        return rois

    def detect_nv12_roi_720p(
        self,
        nv12_data: bytes | memoryview,
        roi_index: int,
        brightness_avg: float = -1.0,
    ) -> list[Detection]:
        """
        1280x720 NV12フレームから指定ROIの物体検出を実行

        夜カメラ用の高速ROI推論パス。
        ROI座標は事前計算済み（get_roi_regions_720p()）で固定。

        Args:
            nv12_data: 1280x720 NV12フォーマットのフレームデータ
            roi_index: ROIインデックス (0, 1, 2)
            brightness_avg: ISPからの平均輝度 (0-255)

        Returns:
            検出結果のリスト (座標は1280x720フレーム座標系)

        Raises:
            ValueError: フレームサイズが1280x720 NV12と一致しない場合
        """
        # Validate frame size (defense-in-depth)
        expected_size = 1280 * 720 * 3 // 2  # 1,382,400 bytes for NV12
        actual_size = len(nv12_data)
        if actual_size != expected_size:
            raise ValueError(
                f"Frame size mismatch for 720p ROI: "
                f"expected {expected_size} bytes, got {actual_size}"
            )

        # ROI座標を取得
        rois = self.get_roi_regions_720p()
        if roi_index < 0 or roi_index >= len(rois):
            logger.warning(f"Invalid ROI index: {roi_index}")
            return []

        roi_x, roi_y, roi_w, roi_h = rois[roi_index]

        # detect_nv12_roiを使用してROI領域を推論
        return self.detect_nv12_roi(
            nv12_data=nv12_data,
            width=1280,
            height=720,
            roi_x=roi_x,
            roi_y=roi_y,
            roi_w=roi_w,
            roi_h=roi_h,
            brightness_avg=brightness_avg,
        )

    def _crop_nv12_roi(
        self,
        nv12_array: np.ndarray,
        width: int,
        height: int,
        roi_x: int,
        roi_y: int,
        roi_w: int,
        roi_h: int,
    ) -> np.ndarray:
        """
        NV12フレームから指定ROI領域をクロップ

        Args:
            nv12_array: 入力NV12データ
            width: 入力画像幅
            height: 入力画像高さ
            roi_x, roi_y: ROI左上座標
            roi_w, roi_h: ROIサイズ

        Returns:
            クロップされたNV12データ (roi_w x roi_h)
        """
        y_size_in = width * height
        y_size_out = roi_w * roi_h
        uv_height_in = height // 2
        uv_height_out = roi_h // 2
        uv_size_out = roi_w * uv_height_out

        # 出力バッファを確保
        output = np.empty(y_size_out + uv_size_out, dtype=np.uint8)

        # Y平面をクロップ
        y_in = nv12_array[:y_size_in].reshape(height, width)
        y_out = output[:y_size_out].reshape(roi_h, roi_w)
        y_out[:] = y_in[roi_y : roi_y + roi_h, roi_x : roi_x + roi_w]

        # UV平面をクロップ (UV座標は半分)
        uv_in = nv12_array[y_size_in:].reshape(uv_height_in, width)
        uv_out = output[y_size_out:].reshape(uv_height_out, roi_w)
        roi_y_uv = roi_y // 2
        roi_h_uv = roi_h // 2
        uv_out[:] = uv_in[roi_y_uv : roi_y_uv + roi_h_uv, roi_x : roi_x + roi_w]

        return output

    def detect_nv12_roi(
        self,
        nv12_data: bytes | memoryview,
        width: int,
        height: int,
        roi_x: int,
        roi_y: int,
        roi_w: int = 640,
        roi_h: int = 640,
        brightness_avg: float = -1.0,
    ) -> list[Detection]:
        """
        NV12フレームの指定ROI領域から物体検出を実行

        高解像度入力(例: 1280x720)から640x640のROIをクロップして推論。
        座標は元画像座標系に変換して返す。

        Args:
            nv12_data: NV12フォーマットのフレームデータ
            width: フレーム幅
            height: フレーム高さ
            roi_x, roi_y: ROI左上座標
            roi_w, roi_h: ROIサイズ (デフォルト: 640x640)
            brightness_avg: ISPからの平均輝度 (0-255)

        Returns:
            検出結果のリスト (座標は元画像座標系)
        """
        import time

        start_total = time.perf_counter()
        self._total_calls += 1

        # 1. ROIクロップ → CLAHE（crop後に適用で処理量削減）
        start_prep = time.perf_counter()

        self._clahe_frame_counter += 1
        cache_key = (width, height)
        cache_exists = cache_key in self._clahe_y_cache
        update_clahe = self.clahe_enabled and (
            self._clahe_frame_counter % self.clahe_frequency == 0
            or not cache_exists  # cold start: populate cache on first frame
        )
        use_clahe_cache = self.clahe_enabled and not update_clahe and cache_exists

        # NV12データをnumpy配列に変換（read-only、cropが新バッファを作る）
        nv12_array = np.frombuffer(nv12_data, dtype=np.uint8)

        # ROIクロップ + CLAHE (キャッシュ対応)
        # フルフレームCLAHEキャッシュ: 1280x720のY planeにCLAHEを適用してキャッシュ。
        # 各ROIクロップ時はキャッシュから切り出すことで、全ROIにCLAHEを適用しつつ
        # medianBlur+CLAHEのコストをN回に1回に抑える。
        if roi_w == self.input_w and roi_h == self.input_h:
            if update_clahe:
                # フルフレームCLAHE実行 + キャッシュ更新
                start_clahe = time.perf_counter()
                y_size = width * height
                y_plane = nv12_array[:y_size].reshape(height, width)
                y_plane = cv2.medianBlur(y_plane, 3)
                y_enhanced = self.clahe.apply(y_plane)
                self._clahe_y_cache[(width, height)] = y_enhanced
                clahe_time = (time.perf_counter() - start_clahe) * 1000
                self._brightness_stats["clahe_time_total_ms"] += clahe_time
                self._brightness_stats["frames_clahe_applied"] += 1

            if update_clahe or use_clahe_cache:
                # キャッシュ済みY planeからROIクロップ + UV=128
                cached_y = self._clahe_y_cache[(width, height)]
                y_roi = cached_y[roi_y:roi_y + roi_h, roi_x:roi_x + roi_w].copy()
                y_roi_flat = y_roi.flatten()
                uv_size = roi_w * (roi_h // 2)
                cropped = np.empty(roi_w * roi_h + uv_size, dtype=np.uint8)
                cropped[:roi_w * roi_h] = y_roi_flat
                cropped[roi_w * roi_h:] = 128  # UV=128
            else:
                # CLAHEなし — 通常のROIクロップ
                cropped = self.preprocessor.crop_roi(
                    nv12_array, width, height, roi_x, roi_y, roi_w, roi_h
                )
                self._brightness_stats["frames_clahe_skipped"] += 1

            input_tensor = cropped
            scale = (1.0, 1.0)
            shift = (0.0, 0.0)
        else:
            logger.error(
                f"ROI size {roi_w}x{roi_h} must match model input {self.input_w}x{self.input_h}"
            )
            return []

        end_prep = time.perf_counter()
        self._last_timing["preprocessing"] = end_prep - start_prep

        # 2. BPU推論
        start_infer = time.perf_counter()
        outputs = self._forward(input_tensor)
        end_infer = time.perf_counter()
        self._last_timing["inference"] = end_infer - start_infer

        # 3. 後処理（座標はROI内相対座標で取得）
        start_post = time.perf_counter()
        detections_roi = self._postprocess(outputs, scale, shift, (roi_h, roi_w))
        end_post = time.perf_counter()
        self._last_timing["postprocessing"] = end_post - start_post

        # 4. 座標変換: ROI相対 → 元画像絶対座標
        detections = []
        for det in detections_roi:
            # ROIオフセットを加算
            new_bbox = BoundingBox(
                x=det.bbox.x + roi_x,
                y=det.bbox.y + roi_y,
                w=det.bbox.w,
                h=det.bbox.h,
            )
            detections.append(
                Detection(
                    class_name=det.class_name,
                    confidence=det.confidence,
                    bbox=new_bbox,
                )
            )

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
        clahe_cache_key: str = "",
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

        self._clahe_frame_counter += 1
        # Use clahe_cache_key to distinguish VSE ROI images that share the
        # same (width, height).  Without this, ROI 0's cached Y plane would
        # be reused for ROI 1, causing ghost/mirror detections.
        cache_key = (width, height, clahe_cache_key)
        cache_exists = cache_key in self._clahe_y_cache
        update_clahe = self.clahe_enabled and (
            self._clahe_frame_counter % self.clahe_frequency == 0
            or not cache_exists
        )
        use_clahe_cache = self.clahe_enabled and not update_clahe and cache_exists

        # NV12データをnumpy配列に変換
        # CLAHE適用時のみコピー（元データを変更するため）
        # CLAHE不要時はゼロコピーで高速化
        if update_clahe or use_clahe_cache:
            nv12_array = np.frombuffer(nv12_data, dtype=np.uint8).copy()
        else:
            nv12_array = np.frombuffer(nv12_data, dtype=np.uint8)

        # CLAHE適用 (nightカメラ時のみ、daemon側でclahe_enabledを制御)
        clahe_applied = False
        if brightness_avg >= 0:
            self._brightness_stats["last_brightness_avg"] = brightness_avg
        if update_clahe:
            start_clahe = time.perf_counter()
            nv12_array = self._apply_clahe_nv12(nv12_array, width, height, update_cache=True)
            clahe_time = (time.perf_counter() - start_clahe) * 1000
            self._brightness_stats["clahe_time_total_ms"] += clahe_time
            self._brightness_stats["frames_clahe_applied"] += 1
            clahe_applied = True
        elif use_clahe_cache:
            start_clahe = time.perf_counter()
            nv12_array = self._apply_clahe_nv12(nv12_array, width, height, update_cache=False)
            clahe_time = (time.perf_counter() - start_clahe) * 1000
            self._brightness_stats["clahe_time_total_ms"] += clahe_time
            self._brightness_stats["frames_clahe_applied"] += 1
            clahe_applied = True
        else:
            self._brightness_stats["frames_clahe_skipped"] += 1

        self._brightness_stats["last_clahe_applied"] = clahe_applied

        # CLAHE統計を100フレームごとにDEBUGレベルで出力
        total_clahe_frames = (
            self._brightness_stats["frames_clahe_applied"]
            + self._brightness_stats["frames_clahe_skipped"]
        )
        if total_clahe_frames > 0 and total_clahe_frames % 100 == 0:
            applied = self._brightness_stats["frames_clahe_applied"]
            rate = applied / total_clahe_frames * 100
            avg_time = (
                self._brightness_stats["clahe_time_total_ms"] / applied
                if applied > 0
                else 0
            )
            logger.debug(
                f"CLAHE stats: {applied}/{total_clahe_frames} frames ({rate:.1f}%), avg={avg_time:.2f}ms, brightness={brightness_avg:.1f}"
            )

        if width == self.input_w and height == self.input_h:
            # 既に正しいサイズ：そのまま使用（最速パス）
            input_tensor = nv12_array
            scale = (1.0, 1.0)
            shift = (0.0, 0.0)
            original_shape = (height, width)
            if not self._nv12_path_debug_logged:
                logger.debug(f"NV12 direct path: {width}x{height}")
        elif width == self.input_w and height < self.input_h:
            # Letterbox: 幅は同じだが高さが小さい場合（例: 640x360 → 640x640）
            # NV12形式で上下に黒帯を追加
            pad_total = self.input_h - height
            pad_top = pad_total // 2
            pad_bottom = pad_total - pad_top

            input_tensor = self.preprocessor.letterbox(
                nv12_array, width, height, pad_top, pad_bottom
            )
            scale = (1.0, 1.0)  # スケールは既にVSEで適用済み
            shift = (float(pad_top), 0.0)  # Y方向のシフト（bbox座標補正用）
            original_shape = (height, width)
            if not self._nv12_path_debug_logged:
                logger.debug(
                    f"NV12 letterbox path: {width}x{height} -> {self.input_w}x{self.input_h} (pad_top={pad_top})"
                )
        else:
            logger.error(
                f"NV12 {width}x{height} must be {self.input_w}x{self.input_w} (direct) or {self.input_w}x* (letterbox)"
            )
            return []

        end_prep = time.perf_counter()
        self._last_timing["preprocessing"] = end_prep - start_prep

        # Mark NV12 path as logged (first call only)
        if not self._nv12_path_debug_logged:
            self._nv12_path_debug_logged = True

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

    def detect_nv12_readonly(
        self,
        nv12_data: bytes | memoryview,
        width: int,
        height: int,
    ) -> list[Detection]:
        """Read-only detection: BPU inference + postprocess only.

        No side effects — does not modify CLAHE cache, frame counters,
        statistics, or any instance state. Safe to call from interrupt
        context (e.g., HTTP /detect endpoint) while the main SHM loop
        is running.

        Input must be 640x640 NV12 (pre-letterboxed by caller).
        """
        nv12_array = np.frombuffer(nv12_data, dtype=np.uint8)

        if width == self.input_w and height == self.input_h:
            input_tensor = nv12_array
            scale = (1.0, 1.0)
            shift = (0.0, 0.0)
            original_shape = (height, width)
        else:
            return []  # caller must letterbox to 640x640

        outputs = self._forward(input_tensor)
        return self._postprocess(outputs, scale, shift, original_shape)

    def _apply_clahe_nv12(
        self, nv12_array: np.ndarray, width: int, height: int,
        update_cache: bool = True,
    ) -> np.ndarray:
        """
        NV12のY平面にデノイズ+CLAHE適用 + UV平面を128固定(無彩色化)

        CLAHEは局所的なコントラスト改善を行い、低照度画像の視認性を向上させる。
        IR カメラの紫色かぶり(UV異常値)を除去するため、UV平面を128に固定して
        擬似グレースケール化する。

        update_cache=True時: medianBlur+CLAHEを実行し、結果をキャッシュに保存。
        update_cache=False時: キャッシュから前回のCLAHE結果Y planeを適用。

        Args:
            nv12_array: NV12データ (Y + UV)
            width: 画像幅
            height: 画像高さ
            update_cache: Trueならフル計算+キャッシュ更新、Falseならキャッシュ利用

        Returns:
            CLAHE適用後のNV12データ
        """
        y_size = width * height
        cache_key = (width, height)

        if update_cache:
            # Y平面を抽出して2D配列に変換
            y_plane = nv12_array[:y_size].reshape(height, width)

            # IRノイズ除去 → CLAHE
            # kernel 3: 1.84ms vs kernel 5: 13.06ms (7x高速化、検出品質差なし)
            y_plane = cv2.medianBlur(y_plane, 3)
            y_enhanced = self.clahe.apply(y_plane)

            # キャッシュに保存
            self._clahe_y_cache[cache_key] = y_enhanced

            # 結果を元の配列に書き戻す
            nv12_array[:y_size] = y_enhanced.flatten()
        elif cache_key in self._clahe_y_cache:
            # キャッシュから適用 (medianBlur+CLAHEスキップ)
            nv12_array[:y_size] = self._clahe_y_cache[cache_key].flatten()
        else:
            # キャッシュなし — フル計算にフォールバック
            y_plane = nv12_array[:y_size].reshape(height, width)
            y_plane = cv2.medianBlur(y_plane, 3)
            y_enhanced = self.clahe.apply(y_plane)
            self._clahe_y_cache[cache_key] = y_enhanced
            nv12_array[:y_size] = y_enhanced.flatten()

        # UV平面を128(無彩色)に固定 — IRカメラの紫色かぶりを除去
        nv12_array[y_size:] = 128

        return nv12_array

    def _init_letterbox_buf(
        self, width: int, height: int, pad_top: int, pad_bottom: int
    ) -> None:
        """
        レターボックスバッファを事前確保し、パディング領域を初期化

        初回呼び出しのみ実行。以後のフレームではバッファを再利用し、
        データ領域のみmemcpyする。
        """
        new_height = height + pad_top + pad_bottom
        y_size_out = width * new_height
        uv_height_out = new_height // 2
        uv_size_out = width * uv_height_out
        pad_top_uv = pad_top // 2

        # バッファ確保
        self._lb_buf = np.empty(y_size_out + uv_size_out, dtype=np.uint8)

        # Y平面のview
        y_out = self._lb_buf[:y_size_out].reshape(new_height, width)
        y_out[:pad_top, :] = 16               # 上部黒帯 (Y=16)
        y_out[pad_top + height :, :] = 16     # 下部黒帯

        # UV平面のview
        uv_out = self._lb_buf[y_size_out:].reshape(uv_height_out, width)
        uv_out[:pad_top_uv, :] = 128                              # 上部中間値
        uv_out[pad_top_uv + height // 2 :, :] = 128               # 下部中間値

        # データコピー先のviewを保持 (毎フレームの書き込み対象)
        self._lb_y_dst = y_out[pad_top : pad_top + height, :]
        self._lb_uv_dst = uv_out[pad_top_uv : pad_top_uv + height // 2, :]

        logger.debug(f"Letterbox buffer initialized: {width}x{height} -> {width}x{new_height}")

    def _letterbox_nv12(
        self,
        nv12_array: np.ndarray,
        width: int,
        height: int,
        pad_top: int,
        pad_bottom: int,
    ) -> np.ndarray:
        """
        NV12フレームに上下の黒帯（letterbox）を追加

        事前確保バッファを使用し、毎フレームのメモリ確保を回避。
        パディング領域は初回のみ書き込み、以後はデータ領域のみコピー。

        Args:
            nv12_array: 入力NV12データ (width x height)
            width: 入力幅
            height: 入力高さ
            pad_top: 上部パディング（ピクセル数）
            pad_bottom: 下部パディング（ピクセル数）

        Returns:
            パディング後のNV12データ (width x (height + pad_top + pad_bottom))
        """
        # 遅延初期化 (初回のみ)
        if self._lb_buf is None:
            self._init_letterbox_buf(width, height, pad_top, pad_bottom)

        y_size_in = width * height
        uv_size_in = width * (height // 2)

        # Y平面をコピー先viewに直接書き込み
        y_in = nv12_array[:y_size_in].reshape(height, width)
        self._lb_y_dst[:] = y_in

        # UV平面をコピー先viewに直接書き込み
        uv_in = nv12_array[y_size_in : y_size_in + uv_size_in].reshape(
            height // 2, width
        )
        self._lb_uv_dst[:] = uv_in

        return self._lb_buf

    def _forward(self, input_tensor: np.ndarray) -> list[np.ndarray]:
        """BPU推論を実行"""
        outputs = self.quantize_model[0].forward(input_tensor)

        # C API出力をnumpy配列に変換（サンプルコードと同じ方式）
        # バッファを直接取得、reshapeは後処理で行う
        return [output.buffer for output in outputs]

    def _postprocess(
        self,
        outputs: list[np.ndarray],
        scale: tuple[float, float],
        shift: tuple[float, float],
        original_shape: tuple[int, int],
    ) -> list[Detection]:
        """
        後処理: モデルタイプに応じて分岐

        Args:
            outputs: BPU推論結果
            scale: (y_scale, x_scale)
            shift: (y_shift, x_shift)
            original_shape: 元画像のサイズ (height, width)

        Returns:
            検出結果のリスト
        """
        if self.model_type == "yolo26":
            return self._postprocess_yolo26(outputs, scale, shift, original_shape)
        else:
            return self._postprocess_legacy(outputs, scale, shift, original_shape)

    def _postprocess_legacy(
        self,
        outputs: list[np.ndarray],
        scale: tuple[float, float],
        shift: tuple[float, float],
        original_shape: tuple[int, int],
    ) -> list[Detection]:
        """
        従来モデル (v8/v11/v13) 用の後処理

        出力形式: [cls_0, bbox_0, cls_1, bbox_1, cls_2, bbox_2]
        - cls: (N, 80) - class logits
        - bbox: (N, 64) - DFL形式 (16*4)

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

        # Log output shapes only once (first call)
        if not self._postprocess_debug_logged:
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

        for idx, (cls, bbox, stride, grid) in enumerate(
            zip(clses, bboxes, self.strides, self.grids)
        ):
            # 対象クラスのみでmax (各列はstrided viewでコピーなし)
            max_scores = cls[:, _TARGET_CLASS_COLS[0]].copy()
            for col in _TARGET_CLASS_COLS[1:]:
                np.maximum(max_scores, cls[:, col], out=max_scores)
            bbox_selected = np.flatnonzero(max_scores >= self.conf_thres_raw)

            # Log stride info only once (first call)
            if not self._postprocess_debug_logged:
                logger.debug(
                    f"  stride={stride}: {len(bbox_selected)}/{len(max_scores)} candidates "
                    f"(threshold={self.conf_thres_raw:.2f}, score_thres={self.score_threshold:.2f})"
                )

            if len(bbox_selected) == 0:
                continue

            # argmaxは候補のみ (少数)
            v_id = _TARGET_CLASS_COLS[np.argmax(cls[bbox_selected][:, _TARGET_CLASS_COLS], axis=1)]

            ids_list.append(v_id)

            # Sigmoid (フィルタ後の少数候補のみ)
            scores_list.append(1.0 / (1.0 + np.exp(-max_scores[bbox_selected])))

            # DFL: dist2bbox (ltrb2xyxy)
            ltrb_selected = np.sum(
                _fast_softmax(bbox[bbox_selected, :].reshape(-1, 4, self.reg), axis=2)
                * self.weights_static,
                axis=2,
            )
            grid_selected = grid[bbox_selected, :]
            x1y1 = grid_selected - ltrb_selected[:, 0:2]
            x2y2 = grid_selected + ltrb_selected[:, 2:4]
            dbboxes_list.append(np.hstack([x1y1, x2y2]) * stride)

        if not dbboxes_list:
            return []

        # 全スケールを結合
        dbboxes = np.concatenate(dbboxes_list, axis=0)
        scores = np.concatenate(scores_list, axis=0)
        ids = np.concatenate(ids_list, axis=0)

        # xyxy → xywh (in-place)
        xywh = dbboxes.copy()
        xywh[:, 2] -= xywh[:, 0]  # w = x2 - x1
        xywh[:, 3] -= xywh[:, 1]  # h = y2 - y1

        # Class-aware NMS: クラスIDでX座標をオフセットし、1回のNMSで全クラス処理
        xywh[:, 0] += ids.astype(np.float32) * 4096.0

        indices = cv2.dnn.NMSBoxes(
            xywh, scores,
            self.score_threshold, self.nms_threshold,
        )

        if len(indices) == 0:
            return []

        # NMS結果からDetectionオブジェクトを構築
        detections: list[Detection] = []
        kept_indices = indices.flatten()

        for indic in kept_indices:
            x1, y1, x2, y2 = dbboxes[indic]

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

            detections.append(Detection(
                class_name=COCO_TO_DETECTION_CLASS[int(ids[indic])],
                confidence=float(scores[indic]),
                bbox=BoundingBox(x=x1, y=y1, w=x2 - x1, h=y2 - y1),
            ))

        # Mark as logged after first call
        if not self._postprocess_debug_logged:
            self._postprocess_debug_logged = True

        return detections

    def _postprocess_yolo26(
        self,
        outputs: list[np.ndarray],
        scale: tuple[float, float],
        shift: tuple[float, float],
        original_shape: tuple[int, int],
    ) -> list[Detection]:
        """
        YOLO26専用後処理 (Anchor-Free, Direct XYXY)

        出力形式: [bbox_0, cls_0, bbox_1, cls_1, bbox_2, cls_2]
        - bbox: (H*W, 4) - グリッド相対座標 (直接xyxy)
        - cls: (H*W, 80) - logit scores

        従来モデルとの違い:
        1. 出力順序: bbox→cls (従来は cls→bbox)
        2. bbox形式: 直接座標 (従来は DFL 64ch)
        3. デコード: (grid ± box) * stride

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

        num_classes = 80  # COCO

        # Log output shapes only once (first call)
        if not self._postprocess_debug_logged:
            logger.debug(f"YOLO26 post-processing: {len(outputs)} outputs")
            for i, out in enumerate(outputs):
                logger.debug(f"  output[{i}]: shape={out.shape}, dtype={out.dtype}")

        dets: list[np.ndarray] = []

        # 3スケール処理 (stride 8, 16, 32)
        for i, stride in enumerate(self.strides):
            bbox_idx = i * 2      # 0, 2, 4
            cls_idx = i * 2 + 1   # 1, 3, 5

            bbox_data = outputs[bbox_idx].reshape(-1, 4)
            cls_data = outputs[cls_idx].reshape(-1, num_classes)

            # 対象クラスのみでmax (各列はstrided viewでコピーなし)
            max_scores = cls_data[:, _TARGET_CLASS_COLS[0]].copy()
            for col in _TARGET_CLASS_COLS[1:]:
                np.maximum(max_scores, cls_data[:, col], out=max_scores)
            mask = max_scores >= self.conf_thres_raw

            # Log stride info only once (first call)
            if not self._postprocess_debug_logged:
                logger.debug(
                    f"  stride={stride}: {np.sum(mask)}/{len(max_scores)} candidates"
                )

            if not np.any(mask):
                continue

            # マスク適用
            grid = self.grids_yolo26[stride][mask]
            v_box = bbox_data[mask]
            v_score_logit = max_scores[mask]
            # argmaxは候補のみ (少数) → subset抽出+argmaxのコストは無視できる
            v_id = _TARGET_CLASS_COLS[np.argmax(cls_data[mask][:, _TARGET_CLASS_COLS], axis=1)]

            # sigmoid (フィルタ後の少数候補のみ)
            v_score = 1.0 / (1.0 + np.exp(-v_score_logit))

            # YOLO26デコード: (grid ± box) * stride → xyxy
            x1y1 = (grid - v_box[:, :2]) * stride
            x2y2 = (grid + v_box[:, 2:]) * stride

            # [x1, y1, x2, y2, score, class_id] — 1回のhstackで構築
            dets.append(np.hstack([x1y1, x2y2, v_score[:, None], v_id[:, None].astype(np.float32)]))

        if not dets:
            return []

        # 全スケールを結合
        all_dets = np.concatenate(dets, axis=0)

        # xyxy → xywh 変換 (in-place)
        all_dets[:, 2] -= all_dets[:, 0]  # w = x2 - x1
        all_dets[:, 3] -= all_dets[:, 1]  # h = y2 - y1

        # Class-aware NMS: クラスIDでY座標をオフセットし、1回のNMSで全クラス処理
        # オフセットは画像サイズ(640)より十分大きい値を使用
        class_ids = all_dets[:, 5].astype(np.int32)
        offsets = class_ids.astype(np.float32) * 4096.0
        xywh_offset = all_dets[:, :4].copy()
        xywh_offset[:, 0] += offsets  # x座標にオフセット加算

        indices = cv2.dnn.NMSBoxes(
            xywh_offset, all_dets[:, 4],
            self.score_threshold, self.nms_threshold,
        )

        if len(indices) == 0:
            return []

        # NMS結果からDetectionオブジェクトを構築
        detections: list[Detection] = []
        kept = all_dets[indices.flatten()]
        kept_ids = class_ids[indices.flatten()]

        for j in range(len(kept)):
            d = kept[j]
            cid = int(kept_ids[j])
            detection_class = COCO_TO_DETECTION_CLASS[cid]  # 事前フィルタ済み

            # xywh → xyxy に戻して座標変換: letterbox → 元画像
            x1 = int((d[0] - x_shift) / x_scale)
            y1 = int((d[1] - y_shift) / y_scale)
            x2 = int((d[0] + d[2] - x_shift) / x_scale)
            y2 = int((d[1] + d[3] - y_shift) / y_scale)

            # クリッピング
            x1 = max(0, min(x1, orig_w))
            x2 = max(0, min(x2, orig_w))
            y1 = max(0, min(y1, orig_h))
            y2 = max(0, min(y2, orig_h))

            detections.append(Detection(
                class_name=detection_class,
                confidence=float(d[4]),
                bbox=BoundingBox(x=x1, y=y1, w=x2 - x1, h=y2 - y1),
            ))

        # Mark as logged after first call
        if not self._postprocess_debug_logged:
            self._postprocess_debug_logged = True

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
        clahe_rate = (
            clahe_applied / (clahe_applied + clahe_skipped)
            if (clahe_applied + clahe_skipped) > 0
            else 0.0
        )
        avg_clahe_time = (
            self._brightness_stats["clahe_time_total_ms"] / clahe_applied
            if clahe_applied > 0
            else 0.0
        )

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

    print(f"\n{detector}")
    print(f"Stats: {detector.get_stats()}")
