"""
物体検出のモック実装

ランダムにバウンディングボックスを生成し、
実際の物体検出モデルと同じインターフェースを提供
"""

import random
from pathlib import Path
import sys

# 共通型定義をインポート
sys.path.insert(0, str(Path(__file__).parent.parent / "common" / "src"))
from common.types import (
    Detection,
    DetectionClass,
    BoundingBox,
    DEFAULT_FRAME_WIDTH,
    DEFAULT_FRAME_HEIGHT,
)


class MockDetector:
    """
    物体検出のモック実装

    ランダムにバウンディングボックスを生成し、
    実際の物体検出モデルと同じインターフェースを提供する。

    Attributes:
        detection_probability: 検出が発生する確率（0.0 ~ 1.0）
        min_detections: 最小検出数
        max_detections: 最大検出数
        frame_width: フレーム幅
        frame_height: フレーム高さ
    """

    def __init__(
        self,
        detection_probability: float = 0.3,
        min_detections: int = 1,
        max_detections: int = 3,
        frame_width: int = DEFAULT_FRAME_WIDTH,
        frame_height: int = DEFAULT_FRAME_HEIGHT,
    ) -> None:
        """
        初期化

        Args:
            detection_probability: 検出が発生する確率（0.0 ~ 1.0）
            min_detections: 最小検出数
            max_detections: 最大検出数
            frame_width: フレーム幅
            frame_height: フレーム高さ
        """
        self.detection_probability = detection_probability
        self.min_detections = min_detections
        self.max_detections = max_detections
        self.frame_width = frame_width
        self.frame_height = frame_height

        self._total_detections = 0
        self._total_calls = 0

    def detect(self, frame_data: bytes) -> list[Detection]:
        """
        物体検出を実行（モック）

        Args:
            frame_data: JPEGエンコードされたフレームデータ（未使用）

        Returns:
            検出結果のリスト
        """
        self._total_calls += 1

        # 確率的に検出を発生させる
        if random.random() > self.detection_probability:
            return []

        # ランダムな検出数を決定
        num_detections = random.randint(self.min_detections, self.max_detections)
        self._total_detections += num_detections

        detections: list[Detection] = []
        for _ in range(num_detections):
            detections.append(self._generate_random_detection())

        return detections

    def _generate_random_detection(self) -> Detection:
        """ランダムな検出結果を生成"""
        # ランダムなクラスを選択
        class_name = random.choice(list(DetectionClass))

        # バウンディングボックスの生成
        # クラスに応じてサイズと位置を調整
        if class_name == DetectionClass.CAT:
            # 猫: 比較的大きく、画面中央寄り
            w = random.randint(150, 300)
            h = random.randint(150, 300)
            x = random.randint(100, self.frame_width - w - 100)
            y = random.randint(100, self.frame_height - h - 100)
            confidence = random.uniform(0.8, 0.99)

        elif class_name == DetectionClass.FOOD_BOWL:
            # 餌皿: 小さめ、画面下部
            w = random.randint(80, 150)
            h = random.randint(60, 100)
            x = random.randint(50, self.frame_width - w - 50)
            y = random.randint(self.frame_height // 2, self.frame_height - h - 50)
            confidence = random.uniform(0.7, 0.95)

        elif class_name == DetectionClass.WATER_BOWL:
            # 水飲み場: 小さめ、画面下部
            w = random.randint(80, 150)
            h = random.randint(60, 100)
            x = random.randint(50, self.frame_width - w - 50)
            y = random.randint(self.frame_height // 2, self.frame_height - h - 50)
            confidence = random.uniform(0.7, 0.95)

        else:
            # デフォルト
            w = random.randint(100, 200)
            h = random.randint(100, 200)
            x = random.randint(0, self.frame_width - w)
            y = random.randint(0, self.frame_height - h)
            confidence = random.uniform(0.6, 0.9)

        bbox = BoundingBox(x=x, y=y, w=w, h=h)

        return Detection(
            class_name=class_name,
            confidence=confidence,
            bbox=bbox,
        )

    def get_stats(self) -> dict[str, float]:
        """
        統計情報を取得

        Returns:
            統計情報の辞書
        """
        avg_detections = (
            self._total_detections / self._total_calls
            if self._total_calls > 0
            else 0.0
        )

        return {
            "total_calls": self._total_calls,
            "total_detections": self._total_detections,
            "avg_detections_per_call": avg_detections,
        }

    def reset_stats(self) -> None:
        """統計情報をリセット"""
        self._total_detections = 0
        self._total_calls = 0

    def __repr__(self) -> str:
        """文字列表現"""
        stats = self.get_stats()
        return (
            f"MockDetector("
            f"prob={self.detection_probability:.2f}, "
            f"calls={stats['total_calls']}, "
            f"avg_det={stats['avg_detections_per_call']:.2f})"
        )


# 使用例
if __name__ == "__main__":
    print("=== MockDetector Test ===\n")

    detector = MockDetector(detection_probability=0.5)

    # ダミーフレームデータ
    dummy_frame = b"dummy_jpeg_data"

    print("Running 10 detections...\n")
    for i in range(10):
        detections = detector.detect(dummy_frame)
        print(f"Frame {i+1}: {len(detections)} detections")
        for det in detections:
            print(
                f"  - {det.class_name.value}: "
                f"confidence={det.confidence:.2f}, "
                f"bbox=({det.bbox.x}, {det.bbox.y}, {det.bbox.w}, {det.bbox.h})"
            )

    print(f"\n{detector}")
    print(f"Stats: {detector.get_stats()}")
