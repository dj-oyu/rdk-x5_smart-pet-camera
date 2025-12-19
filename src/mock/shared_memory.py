"""
共有メモリのモック実装

スレッドセーフなリングバッファとして動作し、
実際の共有メモリ実装（C/POSIX shm）と同じインターフェースを提供
"""

from collections import deque
from typing import Optional
import threading
import sys
from pathlib import Path

# 共通型定義をインポート
sys.path.insert(0, str(Path(__file__).parent.parent / "common" / "src"))
from common.types import (
    Frame,
    DetectionResult,
    Detection,
    RING_BUFFER_SIZE,
)


class MockSharedMemory:
    """
    共有メモリのモック実装

    実際の共有メモリ（POSIX shm）と同じインターフェースを提供し、
    スレッド間でフレームデータと検出結果を共有する。

    Attributes:
        frame_buffer: フレームリングバッファ
        detection_result: 最新の検出結果
        detection_version: 検出結果の更新カウンタ
    """

    def __init__(self, buffer_size: int = RING_BUFFER_SIZE) -> None:
        """
        初期化

        Args:
            buffer_size: リングバッファサイズ（フレーム数）
        """
        # フレームバッファ
        self._frame_buffer: deque[Frame] = deque(maxlen=buffer_size)
        self._frame_lock = threading.Lock()
        self._frame_counter = 0

        # 検出結果
        self._detection_result: Optional[DetectionResult] = None
        self._detection_version = 0
        self._detection_lock = threading.Lock()

    # ===== フレームバッファ操作 =====

    def write_frame(self, frame: Frame) -> int:
        """
        フレームをリングバッファに書き込み

        Args:
            frame: 書き込むフレーム

        Returns:
            書き込まれたフレーム番号
        """
        with self._frame_lock:
            self._frame_counter += 1
            # フレーム番号を更新（上書き）
            frame.frame_number = self._frame_counter
            self._frame_buffer.append(frame)
            return self._frame_counter

    def read_latest_frame(self) -> Optional[Frame]:
        """
        最新のフレームを読み取り

        Returns:
            最新のフレーム、バッファが空ならNone
        """
        with self._frame_lock:
            if not self._frame_buffer:
                return None
            # 最新フレームのコピーを返す（参照渡しを避ける）
            latest = self._frame_buffer[-1]
            return Frame(
                data=latest.data,
                frame_number=latest.frame_number,
                timestamp=latest.timestamp,
                camera_id=latest.camera_id,
                width=latest.width,
                height=latest.height,
            )

    def read_frame_by_index(self, index: int) -> Optional[Frame]:
        """
        インデックスを指定してフレームを読み取り

        Args:
            index: バッファ内のインデックス（0 = 最古、-1 = 最新）

        Returns:
            指定されたフレーム、存在しなければNone
        """
        with self._frame_lock:
            if not self._frame_buffer or abs(index) >= len(self._frame_buffer):
                return None
            frame = self._frame_buffer[index]
            return Frame(
                data=frame.data,
                frame_number=frame.frame_number,
                timestamp=frame.timestamp,
                camera_id=frame.camera_id,
                width=frame.width,
                height=frame.height,
            )

    def get_frame_count(self) -> int:
        """
        バッファ内のフレーム数を取得

        Returns:
            バッファ内のフレーム数
        """
        with self._frame_lock:
            return len(self._frame_buffer)

    def get_total_frames_written(self) -> int:
        """
        書き込まれた累計フレーム数を取得

        Returns:
            累計フレーム数
        """
        with self._frame_lock:
            return self._frame_counter

    # ===== 検出結果操作 =====

    def write_detection(self, detection_result: DetectionResult) -> None:
        """
        検出結果を書き込み（上書き）

        Args:
            detection_result: 検出結果
        """
        with self._detection_lock:
            self._detection_version += 1
            # バージョンを更新
            detection_result.version = self._detection_version
            self._detection_result = detection_result

    def read_detection(self) -> tuple[Optional[DetectionResult], int]:
        """
        最新の検出結果を読み取り

        Returns:
            (検出結果, バージョン番号) のタプル
            検出結果がなければ (None, バージョン番号)
        """
        with self._detection_lock:
            return (self._detection_result, self._detection_version)

    def get_detection_version(self) -> int:
        """
        検出結果のバージョン番号を取得（ロック不要、atomic読み取り）

        Returns:
            バージョン番号
        """
        # int型の読み取りはPythonでatomic
        return self._detection_version

    # ===== ユーティリティ =====

    def clear(self) -> None:
        """バッファをクリア"""
        with self._frame_lock:
            self._frame_buffer.clear()
            self._frame_counter = 0

        with self._detection_lock:
            self._detection_result = None
            self._detection_version = 0

    def get_stats(self) -> dict[str, int]:
        """
        統計情報を取得

        Returns:
            統計情報の辞書
        """
        with self._frame_lock:
            frame_count = len(self._frame_buffer)
            total_frames = self._frame_counter

        with self._detection_lock:
            det_version = self._detection_version
            has_detection = self._detection_result is not None

        return {
            "frame_count": frame_count,
            "total_frames_written": total_frames,
            "detection_version": det_version,
            "has_detection": 1 if has_detection else 0,
        }

    def __repr__(self) -> str:
        """文字列表現"""
        stats = self.get_stats()
        return (
            f"MockSharedMemory("
            f"frames={stats['frame_count']}/{RING_BUFFER_SIZE}, "
            f"total={stats['total_frames_written']}, "
            f"det_ver={stats['detection_version']})"
        )


# 使用例
if __name__ == "__main__":
    import time
    from common.types import BoundingBox, Detection, DetectionClass

    # 共有メモリ作成
    shm = MockSharedMemory()

    # フレーム書き込みテスト
    print("=== Frame Write Test ===")
    for i in range(5):
        frame = Frame(
            data=b"dummy_jpeg_data",
            frame_number=0,  # write_frameで上書きされる
            timestamp=Frame.now_timestamp(),
            camera_id=0,
            width=1280,
            height=720,
        )
        frame_num = shm.write_frame(frame)
        print(f"Written frame #{frame_num}")
        time.sleep(0.1)

    # 最新フレーム読み取り
    latest = shm.read_latest_frame()
    if latest:
        print(f"\nLatest frame: #{latest.frame_number}")

    # 検出結果書き込みテスト
    print("\n=== Detection Write Test ===")
    det_result = DetectionResult(
        frame_number=5,
        timestamp=Frame.now_timestamp(),
        detections=[
            Detection(
                class_name=DetectionClass.CAT,
                confidence=0.95,
                bbox=BoundingBox(x=100, y=100, w=200, h=200),
            )
        ],
        version=0,  # write_detectionで上書きされる
    )
    shm.write_detection(det_result)

    # 検出結果読み取り
    result, version = shm.read_detection()
    if result:
        print(f"Detection version: {version}")
        print(f"Detections: {result.num_detections} found")

    # 統計情報
    print(f"\n{shm}")
