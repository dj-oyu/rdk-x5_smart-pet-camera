"""
カメラ自動切り替えコントローラ

- 昼間/夜間カメラを管理し、明るさに基づいて自動で切り替える
- 低頻度プローブで非アクティブカメラの明るさを計測し、フレームドロップを防止
- デバッグ用途の手動切り替えを提供
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from enum import Enum
from typing import Optional
import threading
import time
import numpy as np
import cv2

from common.types import CameraType, Frame
from shared_memory import MockSharedMemory
from camera import MockCamera


class SwitchMode(str, Enum):
    """カメラ切り替えモード"""
    AUTO = "auto"
    MANUAL = "manual"


@dataclass
class BrightnessSnapshot:
    """
    明るさサンプル

    Attributes:
        value: 明るさの平均値などのスカラー値。
        timestamp: サンプル取得時刻を表すUNIXエポック秒（time.time() の戻り値）。
    """
    value: float
    timestamp: float


class CameraSwitchController:
    """
    昼夜カメラの切り替えを司るコントローラ

    - アクティブカメラは高FPSでフレームを書き込み
    - 非アクティブカメラは低頻度プローブのみ（リングバッファには書かない）
    - 明るさ平均とヒステリシス閾値で自動切り替え
    - 手動切り替え（デバッグ）もサポート
    """

    def __init__(
        self,
        shared_memory: MockSharedMemory,
        day_camera: MockCamera,
        night_camera: MockCamera,
        *,
        day_to_night_threshold: float = 40.0,
        night_to_day_threshold: float = 70.0,
        day_to_night_hold_seconds: float = 10.0,
        night_to_day_hold_seconds: float = 10.0,
        probe_interval_seconds: float = 2.0,
        brightness_history: int = 60,
        warmup_frames: int = 3,
        initial_camera: CameraType = CameraType.DAY,
    ) -> None:
        self.shm = shared_memory
        self.day_camera = day_camera
        self.night_camera = night_camera

        self.day_to_night_threshold = day_to_night_threshold
        self.night_to_day_threshold = night_to_day_threshold
        self.day_to_night_hold_seconds = day_to_night_hold_seconds
        self.night_to_day_hold_seconds = night_to_day_hold_seconds
        self.probe_interval_seconds = probe_interval_seconds
        self.warmup_frames = warmup_frames

        self._active_camera_id = 0 if initial_camera == CameraType.DAY else 1
        self._manual_override: Optional[int] = None
        self._switch_mode = SwitchMode.AUTO
        self._switch_reason = "initial"
        self._warmup_remaining = 0

        self._brightness_history: dict[int, deque[BrightnessSnapshot]] = {
            0: deque(maxlen=brightness_history),
            1: deque(maxlen=brightness_history),
        }
        self._latest_brightness: dict[int, Optional[BrightnessSnapshot]] = {
            0: None,
            1: None,
        }

        self._below_threshold_since: Optional[float] = None
        self._above_threshold_since: Optional[float] = None

        self._switch_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._capture_thread: Optional[threading.Thread] = None
        self._probe_thread: Optional[threading.Thread] = None

    # ====== パブリックAPI ======

    def start(self) -> None:
        """スレッドを起動"""
        if self._capture_thread and self._capture_thread.is_alive():
            return

        self._stop_event.clear()
        self._capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._probe_thread = threading.Thread(target=self._probe_loop, daemon=True)
        self._capture_thread.start()
        self._probe_thread.start()
        print(f"[CameraSwitch] started (active={self._active_camera_id})")

    def stop(self) -> None:
        """スレッド停止とリソース解放"""
        self._stop_event.set()
        if self._capture_thread:
            self._capture_thread.join(timeout=2.0)
        if self._probe_thread:
            self._probe_thread.join(timeout=2.0)
        # カメラ解放
        self.day_camera.release()
        self.night_camera.release()
        print("[CameraSwitch] stopped")

    def force_camera(self, camera: CameraType, reason: str = "manual") -> None:
        """手動でカメラを固定"""
        target_id = 0 if camera == CameraType.DAY else 1
        with self._switch_lock:
            self._manual_override = target_id
            self._switch_mode = SwitchMode.MANUAL
        self._switch_to(target_id, reason=reason, reset_timers=True)

    def resume_auto(self) -> None:
        """手動モードを解除し、自動切り替えに戻す"""
        with self._switch_lock:
            self._manual_override = None
            self._switch_mode = SwitchMode.AUTO
            self._switch_reason = "auto-resume"
            self._below_threshold_since = None
            self._above_threshold_since = None
        print("[CameraSwitch] resumed auto mode")

    def get_status(self) -> dict[str, object]:
        """現在の状態を返す（API用）"""
        return {
            "mode": self._switch_mode.value,
            "active_camera": {
                "id": self._active_camera_id,
                "type": CameraType.DAY.value if self._active_camera_id == 0 else CameraType.NIGHT.value,
            },
            "manual_override": self._manual_override,
            "brightness": {
                "day": self._brightness_payload(0),
                "night": self._brightness_payload(1),
            },
            "thresholds": {
                "day_to_night": self.day_to_night_threshold,
                "night_to_day": self.night_to_day_threshold,
                "day_to_night_hold_seconds": self.day_to_night_hold_seconds,
                "night_to_day_hold_seconds": self.night_to_day_hold_seconds,
            },
            "probe_interval_seconds": self.probe_interval_seconds,
            "last_switch_reason": self._switch_reason,
        }

    # ====== 内部処理 ======

    def _capture_loop(self) -> None:
        """アクティブカメラのフレームを書き込み"""
        while not self._stop_event.is_set():
            camera_id = self._get_active_camera_id()
            camera = self._get_camera(camera_id)

            try:
                frame = camera.capture_frame()
                brightness = self._calculate_brightness(frame.data)
                if brightness is not None:
                    self._record_brightness(camera_id, brightness)
                self._evaluate_switch(now=time.time())

                # ウォームアップ期間中はリングバッファを書かない
                if self._warmup_remaining > 0:
                    self._warmup_remaining -= 1
                    continue

                self.shm.write_frame(frame)
            except Exception as exc:
                print(f"[CameraSwitch] capture error: {exc}")
                time.sleep(0.1)

    def _probe_loop(self) -> None:
        """非アクティブカメラを低頻度でプローブ"""
        while not self._stop_event.is_set():
            inactive_id = 1 - self._get_active_camera_id()
            camera = self._get_camera(inactive_id)

            try:
                frame = camera.capture_frame(skip_rate_limit=True)
                brightness = self._calculate_brightness(frame.data)
                if brightness is not None:
                    self._record_brightness(inactive_id, brightness)
                    self._evaluate_switch(now=time.time())
            except Exception as exc:
                print(f"[CameraSwitch] probe error (cam {inactive_id}): {exc}")

            self._stop_event.wait(self.probe_interval_seconds)

    def _evaluate_switch(self, *, now: float) -> None:
        """明るさサンプルに基づき切り替え判定"""
        with self._switch_lock:
            if self._manual_override is not None:
                return

            active_id = self._active_camera_id
            day_avg = self._average_brightness(0)
            night_avg = self._average_brightness(1)

            if active_id == 0:
                if day_avg is None:
                    return
                if day_avg < self.day_to_night_threshold:
                    self._below_threshold_since = self._below_threshold_since or now
                    if now - self._below_threshold_since >= self.day_to_night_hold_seconds:
                        self._switch_to(1, reason="brightness_low")
                else:
                    self._below_threshold_since = None
            else:
                if day_avg is None:
                    return
                if day_avg > self.night_to_day_threshold:
                    self._above_threshold_since = self._above_threshold_since or now
                    if now - self._above_threshold_since >= self.night_to_day_hold_seconds:
                        self._switch_to(0, reason="brightness_high")
                else:
                    self._above_threshold_since = None

    def _switch_to(self, camera_id: int, *, reason: str, reset_timers: bool = False) -> None:
        """カメラ切り替え処理"""
        with self._switch_lock:
            if self._active_camera_id == camera_id:
                return

            self._active_camera_id = camera_id
            self._switch_reason = reason
            self._warmup_remaining = self.warmup_frames

            if reset_timers:
                self._below_threshold_since = None
                self._above_threshold_since = None

            camera_type = CameraType.DAY.value if camera_id == 0 else CameraType.NIGHT.value
            print(f"[CameraSwitch] switched to {camera_type} (reason={reason})")

    def _get_active_camera_id(self) -> int:
        with self._switch_lock:
            return self._active_camera_id

    def _get_camera(self, camera_id: int) -> MockCamera:
        return self.day_camera if camera_id == 0 else self.night_camera

    def _record_brightness(self, camera_id: int, brightness: float) -> None:
        snapshot = BrightnessSnapshot(value=brightness, timestamp=time.time())
        self._brightness_history[camera_id].append(snapshot)
        self._latest_brightness[camera_id] = snapshot

    def _average_brightness(self, camera_id: int) -> Optional[float]:
        history = self._brightness_history[camera_id]
        if not history:
            return None
        return sum(s.value for s in history) / len(history)

    def _brightness_payload(self, camera_id: int) -> dict[str, Optional[float]]:
        latest = self._latest_brightness[camera_id]
        return {
            "latest": latest.value if latest else None,
            "timestamp": latest.timestamp if latest else None,
            "avg": self._average_brightness(camera_id),
            "samples": len(self._brightness_history[camera_id]),
        }

    @staticmethod
    def _calculate_brightness(jpeg_bytes: bytes) -> Optional[float]:
        """JPEGバイト列から平均輝度を計算"""
        try:
            arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
            image = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
            if image is None:
                return None
            return float(image.mean())
        except Exception as exc:  # pragma: no cover - runtime guard
            print(f"[CameraSwitch] brightness calc error: {exc}")
            return None
