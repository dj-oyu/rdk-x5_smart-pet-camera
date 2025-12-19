"""
カメラのモック実装

テスト用のフレームデータを生成する複数のソースを提供:
- ランダムパターン生成
- テスト動画ファイル
- Webカメラ
- 静止画像
"""

from typing import Optional, Literal, TYPE_CHECKING, cast, Any
from pathlib import Path
import sys
import time

# 共通型定義をインポート
sys.path.insert(0, str(Path(__file__).parent.parent / "common" / "src"))
from common.types import Frame, DEFAULT_FRAME_WIDTH, DEFAULT_FRAME_HEIGHT, DEFAULT_FPS

import numpy as np

if TYPE_CHECKING:
    import cv2 as cv2_type  # pragma: no cover

try:
    import cv2 as _cv2  # type: ignore[import]
except ImportError:  # pragma: no cover - runtime guard
    _cv2 = None  # type: ignore[assignment]
    print(
        "Warning: opencv-python is not installed. "
        "Install it (e.g. `uv pip install opencv-python`) to enable mock streaming."
    )

cv2 = cast("cv2_type", _cv2)


SourceType = Literal["random", "video", "webcam", "image"]


class MockCamera:
    """
    カメラのモック実装

    様々なソースからフレームデータを生成し、
    実際のカメラと同じインターフェースを提供する。

    Attributes:
        source_type: ソースタイプ
        fps: フレームレート
        width: フレーム幅
        height: フレーム高さ
        camera_id: カメラID
    """

    def __init__(
        self,
        source: SourceType = "random",
        source_path: Optional[str] = None,
        fps: int = DEFAULT_FPS,
        width: int = DEFAULT_FRAME_WIDTH,
        height: int = DEFAULT_FRAME_HEIGHT,
        camera_id: int = 0,
    ) -> None:
        """
        初期化

        Args:
            source: ソースタイプ（random/video/webcam/image）
            source_path: ソースパス（videoまたはimageの場合）
            fps: フレームレート
            width: フレーム幅
            height: フレーム高さ
            camera_id: カメラID
        """
        self.source_type = source
        self.fps = fps
        self.width = width
        self.height = height
        self.camera_id = camera_id
        self.frame_interval = 1.0 / fps

        if cv2 is None:
            raise ImportError(
                "MockCamera requires opencv-python for frame generation and JPEG encode. "
                "Install with: uv pip install opencv-python"
            )

        self._cap: Optional[Any] = None
        self._static_image: Optional[np.ndarray] = None
        self._frame_count = 0
        self._last_capture_time = 0.0

        # ソースの初期化
        self._initialize_source(source, source_path)

    def _initialize_source(self, source: SourceType, source_path: Optional[str]) -> None:
        """ソースを初期化"""
        if source == "video":
            if not source_path:
                raise ValueError("source_path is required for video source")
            if not Path(source_path).exists():
                raise FileNotFoundError(f"Video file not found: {source_path}")
            self._cap = cv2.VideoCapture(source_path)
            if self._cap is None:
                raise RuntimeError(f"Failed to open video: {source_path}")
            if not self._cap.isOpened():
                raise RuntimeError(f"Failed to open video: {source_path}")
            print(f"MockCamera: Using video source: {source_path}")

        elif source == "webcam":
            webcam_id = int(source_path) if source_path else 0
            self._cap = cv2.VideoCapture(webcam_id)
            if self._cap is None:
                raise RuntimeError(f"Failed to open webcam: {webcam_id}")
            if not self._cap.isOpened():
                raise RuntimeError(f"Failed to open webcam: {webcam_id}")
            # Webカメラの解像度を設定
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
            self._cap.set(cv2.CAP_PROP_FPS, self.fps)
            print(f"MockCamera: Using webcam source: {webcam_id}")

        elif source == "image":
            if not source_path:
                raise ValueError("source_path is required for image source")
            if not Path(source_path).exists():
                raise FileNotFoundError(f"Image file not found: {source_path}")
            self._static_image = cv2.imread(source_path)
            if self._static_image is None:
                raise RuntimeError(f"Failed to load image: {source_path}")
            # リサイズ
            self._static_image = cv2.resize(self._static_image, (self.width, self.height))
            print(f"MockCamera: Using static image: {source_path}")

        elif source == "random":
            print("MockCamera: Using random pattern source")

        else:
            raise ValueError(f"Unknown source type: {source}")

    def capture_frame(self) -> Frame:
        """
        フレームをキャプチャ

        Returns:
            キャプチャされたフレーム
        """
        # フレームレート制御
        current_time = time.time()
        elapsed = current_time - self._last_capture_time
        if elapsed < self.frame_interval:
            time.sleep(self.frame_interval - elapsed)

        # フレーム生成
        if self.source_type == "random":
            frame_bgr = self._generate_random_pattern()
        elif self.source_type == "video":
            frame_bgr = self._capture_video_frame()
        elif self.source_type == "webcam":
            frame_bgr = self._capture_webcam_frame()
        elif self.source_type == "image":
            frame_bgr = self._static_image.copy()  # type: ignore
        else:
            raise ValueError(f"Unknown source type: {self.source_type}")

        # JPEGエンコード
        _, encoded = cv2.imencode('.jpg', frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
        jpeg_data = encoded.tobytes()

        # Frameオブジェクト作成
        self._frame_count += 1
        self._last_capture_time = time.time()

        return Frame(
            data=jpeg_data,
            frame_number=self._frame_count,
            timestamp=Frame.now_timestamp(),
            camera_id=self.camera_id,
            width=self.width,
            height=self.height,
        )

    def _generate_random_pattern(self) -> np.ndarray:
        """ランダムパターンを生成"""
        # カラフルなランダムパターン
        pattern = np.random.randint(0, 255, (self.height, self.width, 3), dtype=np.uint8)
        # テキストを追加（フレーム番号）
        cv2.putText(
            pattern,
            f"Frame #{self._frame_count + 1}",
            (50, 50),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.5,
            (255, 255, 255),
            3,
        )
        return pattern

    def _capture_video_frame(self) -> np.ndarray:
        """動画からフレームをキャプチャ"""
        if self._cap is None:
            raise RuntimeError("Video capture not initialized")

        ret, frame = self._cap.read()
        if not ret:
            # 動画の最後に到達したらループ
            self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ret, frame = self._cap.read()
            if not ret:
                raise RuntimeError("Failed to read video frame")

        # リサイズ
        if frame.shape[1] != self.width or frame.shape[0] != self.height:
            frame = cv2.resize(frame, (self.width, self.height))

        return frame

    def _capture_webcam_frame(self) -> np.ndarray:
        """Webカメラからフレームをキャプチャ"""
        if self._cap is None:
            raise RuntimeError("Webcam capture not initialized")

        ret, frame = self._cap.read()
        if not ret:
            raise RuntimeError("Failed to capture webcam frame")

        return frame

    def release(self) -> None:
        """リソースを解放"""
        if self._cap is not None:
            self._cap.release()
            self._cap = None
        print("MockCamera: Released")

    def __enter__(self) -> 'MockCamera':
        """コンテキストマネージャー対応"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:  # type: ignore
        """コンテキストマネージャー対応"""
        self.release()

    def __repr__(self) -> str:
        """文字列表現"""
        return (
            f"MockCamera(source={self.source_type}, "
            f"fps={self.fps}, "
            f"size={self.width}x{self.height}, "
            f"frames={self._frame_count})"
        )


# 使用例
if __name__ == "__main__":
    print("=== MockCamera Test ===\n")

    # ランダムパターンソース
    print("1. Random pattern source:")
    with MockCamera(source="random", fps=10) as camera:
        for i in range(3):
            frame = camera.capture_frame()
            print(f"  Captured frame #{frame.frame_number}, size={frame.size} bytes")

    print(f"\n{camera}")

    # Webカメラソース（利用可能な場合）
    if cv2 is not None:
        try:
            print("\n2. Webcam source:")
            with MockCamera(source="webcam", fps=10) as camera:
                for i in range(3):
                    frame = camera.capture_frame()
                    print(f"  Captured frame #{frame.frame_number}, size={frame.size} bytes")
            print(f"\n{camera}")
        except RuntimeError as e:
            print(f"  Skipped (webcam not available): {e}")
