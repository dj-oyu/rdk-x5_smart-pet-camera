"""
H.264ビデオレコーダー

共有メモリからH.264フレームを読み取り、ファイルに記録する。
生のH.264 NAL unitsを.h264ファイルに保存し、VLC/ffplayで再生可能。
"""

import threading
import time
from pathlib import Path
from typing import Optional
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "common" / "src"))
from common.types import FrameFormat

sys.path.insert(0, str(Path(__file__).parent.parent / "mock"))
from shared_memory import MockSharedMemory


class H264Recorder:
    """
    H.264レコーダー

    共有メモリからH.264フレームを読み取り、ファイルに記録する。

    Attributes:
        shm: 共有メモリ
        output_dir: 出力ディレクトリ
    """

    def __init__(self, shm: MockSharedMemory, output_dir: Path):
        """
        初期化

        Args:
            shm: 共有メモリ
            output_dir: 出力ディレクトリ
        """
        self.shm = shm
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)

        self._recording = False
        self._thread: Optional[threading.Thread] = None
        self._file_handle: Optional[object] = None
        self._current_file: Optional[Path] = None
        self._frame_count = 0
        self._last_frame_number = -1
        self._bytes_written = 0

    def start_recording(self, filename: Optional[str] = None) -> Path:
        """
        録画開始

        Args:
            filename: 出力ファイル名（省略時は自動生成）

        Returns:
            出力ファイルパス
        """
        if self._recording:
            print("[H264Recorder] Already recording")
            return self._current_file

        if filename is None:
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            filename = f"recording_{timestamp}.h264"

        self._current_file = self.output_dir / filename
        self._file_handle = open(self._current_file, 'wb')
        self._recording = True
        self._frame_count = 0
        self._bytes_written = 0

        # 録画スレッド開始
        self._thread = threading.Thread(target=self._record_loop, daemon=True)
        self._thread.start()

        print(f"[H264Recorder] Recording started: {self._current_file}")
        return self._current_file

    def stop_recording(self) -> Optional[Path]:
        """
        録画停止

        Returns:
            録画ファイルパス（録画中でなければNone）
        """
        if not self._recording:
            print("[H264Recorder] Not recording")
            return None

        self._recording = False
        if self._thread:
            self._thread.join(timeout=2.0)

        if self._file_handle:
            self._file_handle.close()
            self._file_handle = None

        print(f"[H264Recorder] Recording stopped: {self._current_file}")
        print(f"[H264Recorder] Stats: {self._frame_count} frames, {self._bytes_written:,} bytes")

        return self._current_file

    def is_recording(self) -> bool:
        """録画中かどうか"""
        return self._recording

    def get_stats(self) -> dict:
        """
        録画統計を取得

        Returns:
            統計情報（frame_count, bytes_written, filename）
        """
        return {
            'recording': self._recording,
            'frame_count': self._frame_count,
            'bytes_written': self._bytes_written,
            'filename': str(self._current_file) if self._current_file else None,
        }

    def _record_loop(self) -> None:
        """録画ループ（スレッドで実行）"""
        print("[H264Recorder] Recording loop started")

        while self._recording:
            # フレーム取得
            frame = self.shm.read_latest_frame()

            if frame is None:
                time.sleep(0.01)  # 10ms待機
                continue

            # 同じフレームをスキップ
            if frame.frame_number == self._last_frame_number:
                time.sleep(0.01)
                continue

            self._last_frame_number = frame.frame_number

            # H.264フレームのみ録画
            if frame.format != FrameFormat.H264.value:
                # H.264以外のフォーマットは警告を出してスキップ
                if self._frame_count == 0:  # 初回のみ警告
                    print(f"[H264Recorder] Warning: Frame format is {frame.format}, expected H.264 (3)")
                time.sleep(0.01)
                continue

            # NAL unitsをファイルに書き込み
            try:
                data_to_write = bytes(frame.data[:frame.size])
                self._file_handle.write(data_to_write)
                self._frame_count += 1
                self._bytes_written += len(data_to_write)

                # 30フレームごとにログ
                if self._frame_count % 30 == 0:
                    fps = 30.0  # 仮定
                    duration = self._frame_count / fps
                    print(f"[H264Recorder] Progress: {self._frame_count} frames "
                          f"({duration:.1f}s, {self._bytes_written:,} bytes)")

            except Exception as e:
                print(f"[H264Recorder] Error writing frame: {e}")
                break

        print("[H264Recorder] Recording loop stopped")
