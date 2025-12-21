"""
共通型定義

スマートペットカメラシステムで使用する全ての型を定義
C実装との互換性を考慮した構造体定義
"""

from dataclasses import dataclass
from typing import Optional
from enum import Enum
import time


class CameraType(Enum):
    """カメラタイプ"""
    DAY = "day"
    NIGHT = "night"


class DetectionClass(Enum):
    """検出対象クラス"""
    CAT = "cat"
    DOG = "dog"
    BIRD = "bird"
    FOOD_BOWL = "food_bowl"
    WATER_BOWL = "water_bowl"
    DISH = "dish"
    PERSON = "person"
    BACKPACK = "backpack"
    UMBRELLA = "umbrella"
    HANDBAG = "handbag"
    SUITCASE = "suitcase"
    BOTTLE = "bottle"
    WINE_GLASS = "wine_glass"
    CUP = "cup"
    FORK = "fork"
    KNIFE = "knife"
    SPOON = "spoon"
    BANANA = "banana"
    APPLE = "apple"
    SANDWICH = "sandwich"
    ORANGE = "orange"
    BROCCOLI = "broccoli"
    CARROT = "carrot"
    HOT_DOG = "hot_dog"
    PIZZA = "pizza"
    DONUT = "donut"
    CAKE = "cake"
    CHAIR = "chair"
    COUCH = "couch"
    POTTED_PLANT = "potted_plant"
    BED = "bed"
    DINING_TABLE = "dining_table"
    TOILET = "toilet"
    TV = "tv"
    LAPTOP = "laptop"
    MOUSE = "mouse"
    REMOTE = "remote"
    KEYBOARD = "keyboard"
    BOOK = "book"
    CLOCK = "clock"
    VASE = "vase"
    TEDDY_BEAR = "teddy_bear"
    HAIR_DRIER = "hair_drier"
    TOOTHBRUSH = "toothbrush"
    CELL_PHONE = "cell_phone"
    MICROWAVE = "microwave"
    OVEN = "oven"
    TOASTER = "toaster"
    SINK = "sink"
    REFRIGERATOR = "refrigerator"


class BehaviorType(Enum):
    """行動タイプ"""
    EATING = "eating"
    DRINKING = "drinking"
    IDLE = "idle"


@dataclass
class BoundingBox:
    """
    バウンディングボックス

    C構造体との対応:
    typedef struct {
        int x, y, w, h;
    } BBox;
    """
    x: int  # 左上X座標
    y: int  # 左上Y座標
    w: int  # 幅
    h: int  # 高さ

    def area(self) -> int:
        """面積を計算"""
        return self.w * self.h

    def iou(self, other: 'BoundingBox') -> float:
        """
        IoU (Intersection over Union) を計算

        Args:
            other: 比較対象のバウンディングボックス

        Returns:
            IoU値 (0.0 ~ 1.0)
        """
        # 交差領域の計算
        x_left = max(self.x, other.x)
        y_top = max(self.y, other.y)
        x_right = min(self.x + self.w, other.x + other.w)
        y_bottom = min(self.y + self.h, other.y + other.h)

        if x_right < x_left or y_bottom < y_top:
            return 0.0

        intersection = (x_right - x_left) * (y_bottom - y_top)
        union = self.area() + other.area() - intersection

        return intersection / union if union > 0 else 0.0


@dataclass
class Detection:
    """
    物体検出結果

    C構造体との対応:
    typedef struct {
        char class_name[32];
        float confidence;
        BBox bbox;
    } Detection;
    """
    class_name: DetectionClass
    confidence: float  # 0.0 ~ 1.0
    bbox: BoundingBox


@dataclass
class Frame:
    """
    フレームデータ

    C構造体との対応:
    typedef struct {
        uint8_t* data;
        size_t size;
        uint64_t frame_number;
        double timestamp;
        int camera_id;
        int width;
        int height;
    } Frame;
    """
    data: bytes  # JPEG エンコード済みデータ
    frame_number: int
    timestamp: float  # UNIXタイムスタンプ
    camera_id: int
    width: int
    height: int

    @property
    def size(self) -> int:
        """データサイズ"""
        return len(self.data)

    @staticmethod
    def now_timestamp() -> float:
        """現在のタイムスタンプを取得"""
        return time.time()


@dataclass
class DetectionResult:
    """
    検出結果（複数の検出を含む）

    C構造体との対応:
    typedef struct {
        uint64_t frame_number;
        double timestamp;
        int num_detections;
        Detection detections[MAX_DETECTIONS];
        uint32_t version;
    } DetectionResult;
    """
    frame_number: int
    timestamp: float
    detections: list[Detection]
    version: int  # 更新カウンタ

    @property
    def num_detections(self) -> int:
        """検出数"""
        return len(self.detections)

    def find_by_class(self, class_name: DetectionClass) -> Optional[Detection]:
        """
        指定クラスの検出結果を取得

        Args:
            class_name: 検出クラス

        Returns:
            最も信頼度の高い検出結果、なければNone
        """
        candidates = [d for d in self.detections if d.class_name == class_name]
        if not candidates:
            return None
        return max(candidates, key=lambda d: d.confidence)


@dataclass
class BehaviorEvent:
    """
    行動イベント

    Args:
        event_id: イベントID（例: "20250101_120530_001"）
        behavior_type: 行動タイプ
        start_time: 開始時刻
        end_time: 終了時刻（進行中はNone）
        camera_id: カメラID
        confidence: 信頼度
        detections: 関連する検出結果
    """
    event_id: str
    behavior_type: BehaviorType
    start_time: float
    end_time: Optional[float]
    camera_id: int
    confidence: float
    detections: list[Detection]

    @property
    def duration(self) -> Optional[float]:
        """継続時間（秒）"""
        if self.end_time is None:
            return None
        return self.end_time - self.start_time

    @property
    def is_ongoing(self) -> bool:
        """進行中かどうか"""
        return self.end_time is None


# 定数定義
MAX_DETECTIONS = 10  # 1フレームあたりの最大検出数
RING_BUFFER_SIZE = 30  # リングバッファサイズ（フレーム数）
DEFAULT_FRAME_WIDTH = 1280
DEFAULT_FRAME_HEIGHT = 720
DEFAULT_FPS = 30
