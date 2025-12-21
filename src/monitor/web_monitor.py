"""
Webモニター実装

Flask + MJPEGストリーミングでBBox合成映像をブラウザに表示
"""

from flask import Flask, Response, jsonify, render_template_string, request, send_from_directory
import cv2
import numpy as np
import json
from typing import Optional, TYPE_CHECKING
import queue
import threading
import time
from pathlib import Path
import sys
from collections import deque

sys.path.insert(0, str(Path(__file__).parent.parent / "common" / "src"))
# 共通型定義をインポート
from common.types import Frame, DetectionResult, Detection, BoundingBox, DetectionClass

# MockSharedMemoryをインポート（型ヒント用）
sys.path.insert(0, str(Path(__file__).parent.parent / "mock"))
from shared_memory import MockSharedMemory
from camera_switcher import SwitchMode
from common.types import CameraType

if TYPE_CHECKING:
    from camera_switcher import CameraSwitchController


# 色定義（BGR）
COLORS = {
    "cat": (0, 255, 0),        # 緑
    "dog": (0, 200, 255),      # オレンジ寄り
    "bird": (255, 150, 0),     # 青寄り
    "food_bowl": (0, 165, 255),  # オレンジ
    "water_bowl": (0, 120, 255), # 青
    "dish": (255, 0, 0),         # 青
    "person": (255, 255, 0),     # シアン
    "book": (0, 255, 255),       # 黄色
    "cell_phone": (255, 0, 255), # マゼンタ
    "chair": (140, 180, 255),
    "couch": (180, 140, 255),
    "tv": (200, 255, 120),
    "laptop": (200, 200, 255),
    "remote": (255, 200, 120),
}

ASSET_SRC_DIR = Path(__file__).parent / "web_assets"
ASSET_BUILD_DIR = Path(__file__).resolve().parents[2] / "build" / "web"


class WebMonitor:
    """
    Webモニター

    共有メモリからフレームと検出結果を読み取り、
    BBoxを合成してブラウザにMJPEGストリーミング配信する。

    Attributes:
        shm: 共有メモリ
        fps: 目標フレームレート
        jpeg_quality: JPEG品質（1-100）
        frame_queue: フレームキュー
    """

    def __init__(
        self,
        shm: MockSharedMemory,
        fps: int = 30,
        jpeg_quality: int = 80,
    ) -> None:
        """
        初期化

        Args:
            shm: 共有メモリ
            fps: 目標フレームレート
            jpeg_quality: JPEG品質（1-100）
        """
        self.shm = shm
        self.fps = fps
        self.jpeg_quality = jpeg_quality
        self.frame_interval = 1.0 / fps

        # フレームキュー（最新2フレームのみ保持）
        self.frame_queue: queue.Queue[bytes] = queue.Queue(maxsize=2)

        # 統計情報
        self.stats = {
            "frames_processed": 0,
            "current_fps": 0.0,
            "detection_count": 0,
        }

        # Overlayスレッド制御
        self._running = False
        self._overlay_thread: Optional[threading.Thread] = None
        self._latest_detection: Optional[DetectionResult] = None
        self._latest_detection_lock = threading.Lock()
        self._latest_detection_key: Optional[tuple[int, int]] = None
        self._detection_history: deque[DetectionResult] = deque(maxlen=8)

    def start(self) -> None:
        """Overlayスレッドを開始"""
        if self._running:
            return

        self._running = True
        self._overlay_thread = threading.Thread(target=self._overlay_loop, daemon=True)
        self._overlay_thread.start()
        print("WebMonitor: Overlay thread started")

    def stop(self) -> None:
        """Overlayスレッドを停止"""
        self._running = False
        if self._overlay_thread:
            self._overlay_thread.join(timeout=2.0)
        print("WebMonitor: Overlay thread stopped")

    def _overlay_loop(self) -> None:
        """Overlayループ（30fps）"""
        cached_detections: Optional[DetectionResult] = None
        cached_version = 0
        last_time = time.time()
        frame_count = 0

        while self._running:
            start_time = time.time()

            # フレーム取得
            frame = self.shm.read_latest_frame()
            if frame is None:
                time.sleep(0.01)
                continue

            # 検出結果取得（更新されていれば）
            current_version = self.shm.get_detection_version()
            if current_version != cached_version:
                detection_result, cached_version = self.shm.read_detection()
                parsed = self._parse_detection_result(detection_result)
                if parsed:
                    cached_detections = parsed
                    self._set_latest_detection(parsed)

            # BBox合成
            overlay_frame = self._draw_overlay(frame, cached_detections)

            # JPEGエンコード
            _, encoded = cv2.imencode(
                ".jpg", overlay_frame, [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality]
            )
            jpeg_data = encoded.tobytes()

            # キューに追加（古いフレームは捨てる）
            try:
                self.frame_queue.put_nowait(jpeg_data)
            except queue.Full:
                try:
                    self.frame_queue.get_nowait()
                    self.frame_queue.put_nowait(jpeg_data)
                except queue.Empty:
                    pass

            # 統計更新
            frame_count += 1
            self.stats["frames_processed"] += 1
            if time.time() - last_time >= 1.0:
                self.stats["current_fps"] = frame_count / (time.time() - last_time)
                frame_count = 0
                last_time = time.time()

            # フレームレート制御
            elapsed = time.time() - start_time
            if elapsed < self.frame_interval:
                time.sleep(self.frame_interval - elapsed)

    def _parse_detection_result(
        self, detection_result_raw: Optional[object]
    ) -> Optional[DetectionResult]:
        """
        検出結果をデシリアライズし、DetectionResultに変換する。

        共有メモリからJSON文字列/辞書で渡されたケースにも対応する。
        """
        if detection_result_raw is None:
            return None

        if isinstance(detection_result_raw, DetectionResult):
            return detection_result_raw

        try:
            if isinstance(detection_result_raw, (str, bytes, bytearray)):
                detection_dict = json.loads(detection_result_raw)
            elif isinstance(detection_result_raw, dict):
                detection_dict = detection_result_raw
            else:
                print(
                    f"[WARN] Unsupported detection result type: {type(detection_result_raw)}"
                )
                return None

            detections = []
            for det in detection_dict.get("detections", []):
                bbox_data = det.get("bbox", {})
                bbox = BoundingBox(
                    x=int(bbox_data.get("x", 0)),
                    y=int(bbox_data.get("y", 0)),
                    w=int(bbox_data.get("w", 0)),
                    h=int(bbox_data.get("h", 0)),
                )
                class_name_raw = det.get("class_name")
                if isinstance(class_name_raw, DetectionClass):
                    class_value = class_name_raw.value
                else:
                    class_value = str(class_name_raw).lower()

                try:
                    class_enum = DetectionClass(class_value)
                except ValueError:
                    # class_nameが未定義ならスキップ
                    continue
                detections.append(
                    Detection(
                        class_name=class_enum,
                        confidence=float(det.get("confidence", 0.0)),
                        bbox=bbox,
                    )
                )

            timestamp_raw = float(detection_dict.get("timestamp", 0.0))
            if timestamp_raw < 1_000_000_000:
                timestamp_raw = time.time()
            return DetectionResult(
                frame_number=int(detection_dict.get("frame_number", 0)),
                timestamp=timestamp_raw,
                detections=detections,
                version=int(detection_dict.get("version", 0)),
            )
        except Exception as exc:
            print(f"[WARN] Failed to parse detection result: {exc}")
            return None

    def _draw_overlay(
        self, frame: Frame, detection_result: Optional[DetectionResult]
    ) -> np.ndarray:
        """
        BBoxを合成

        Args:
            frame: 入力フレーム
            detection_result: 検出結果

        Returns:
            BBox合成済みのフレーム（BGR）
        """
        # フォーマットに応じてデコード
        if frame.format == 0:  # JPEG
            np_arr = np.frombuffer(frame.data, np.uint8)
            img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            if img is None:
                print("[WARN] Failed to decode JPEG frame; using blank fallback")
                img = np.zeros((frame.height, frame.width, 3), dtype=np.uint8)
        elif frame.format == 1:  # NV12
            # NV12: Y plane + UV plane (interleaved)
            y_size = frame.width * frame.height
            uv_size = y_size // 2

            if len(frame.data) < y_size + uv_size:
                print(
                    f"[WARN] NV12 frame too small: {len(frame.data)} < {y_size + uv_size}"
                )
                img = np.zeros((frame.height, frame.width, 3), dtype=np.uint8)
            else:
                try:
                    # NV12を1次元配列として準備
                    yuv_data = np.frombuffer(
                        frame.data[: y_size + uv_size], dtype=np.uint8
                    )

                    # NV12形式: [Y: height x width] [UV: height/2 x width (interleaved)]
                    # reshapeして (height * 3/2, width) にする
                    yuv_img = yuv_data.reshape((frame.height * 3 // 2, frame.width))

                    # NV12 → BGR変換（OpenCVネイティブ）
                    img = cv2.cvtColor(yuv_img, cv2.COLOR_YUV2BGR_NV12)
                except Exception as e:
                    print(f"[ERROR] NV12 conversion failed: {e}")
                    import traceback

                    traceback.print_exc()
                    img = np.zeros((frame.height, frame.width, 3), dtype=np.uint8)
        else:
            print(
                f"[WARN] Unsupported frame format: {frame.format}; using blank fallback"
            )
            img = np.zeros((frame.height, frame.width, 3), dtype=np.uint8)

        if detection_result is None or not detection_result.detections:
            # 検出結果なし
            self.stats["detection_count"] = 0
            self._draw_info_text(img, frame, None)
            return img

        # BBoxを描画
        for detection in detection_result.detections:
            self._draw_detection(img, detection)

        # 情報テキストを描画
        self._draw_info_text(img, frame, detection_result)

        self.stats["detection_count"] = detection_result.num_detections

        return img

    def _draw_detection(self, img: np.ndarray, detection: Detection) -> None:
        """検出結果を描画"""
        bbox = detection.bbox
        class_name = detection.class_name.value
        confidence = detection.confidence

        # 色を取得
        color = COLORS.get(class_name, (255, 255, 255))

        # バウンディングボックスを描画
        cv2.rectangle(
            img, (bbox.x, bbox.y), (bbox.x + bbox.w, bbox.y + bbox.h), color, 2
        )

        # ラベルを描画
        label = f"{class_name}: {confidence:.2f}"
        label_size, baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        label_y = max(bbox.y - 10, label_size[1] + 10)

        # ラベル背景
        cv2.rectangle(
            img,
            (bbox.x, label_y - label_size[1] - baseline),
            (bbox.x + label_size[0], label_y + baseline),
            color,
            -1,
        )

        # ラベルテキスト
        cv2.putText(
            img, label, (bbox.x, label_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1
        )

    def _draw_info_text(
        self, img: np.ndarray, frame: Frame, detection_result: Optional[DetectionResult]
    ) -> None:
        """情報テキストを描画"""
        info_lines = [
            f"Frame: #{frame.frame_number}",
            f"FPS: {self.stats['current_fps']:.1f}",
            f"Camera: {frame.camera_id}",
        ]

        if detection_result:
            info_lines.append(f"Detections: {detection_result.num_detections}")

        y_offset = 30
        for line in info_lines:
            cv2.putText(
                img,
                line,
                (10, y_offset),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 255),
                2,
            )
            y_offset += 25

    def generate_mjpeg(self):
        """MJPEGストリームを生成（Flask用ジェネレータ）"""
        while True:
            try:
                frame = self.frame_queue.get(timeout=1.0)
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n")
            except queue.Empty:
                continue

    def _set_latest_detection(self, detection_result: DetectionResult) -> None:
        """最新検出結果を保存（API用）"""
        with self._latest_detection_lock:
            self._latest_detection = detection_result
            detection_key = (detection_result.frame_number, detection_result.version)
            if detection_key != self._latest_detection_key:
                self._latest_detection_key = detection_key
                if detection_result.num_detections > 0:
                    self._detection_history.appendleft(detection_result)

    def get_latest_detection(self) -> Optional[DetectionResult]:
        """最新検出結果を取得"""
        with self._latest_detection_lock:
            return self._latest_detection

    def get_detection_history(self) -> list[DetectionResult]:
        """検出履歴を取得"""
        with self._latest_detection_lock:
            return list(self._detection_history)

    def get_stats_snapshot(self) -> dict[str, float | int]:
        """統計情報のスナップショットを返す"""
        return {
            "frames_processed": self.stats["frames_processed"],
            "current_fps": self.stats["current_fps"],
            "detection_count": self.stats["detection_count"],
            "target_fps": self.fps,
        }


def _detection_to_dict(detection_result: DetectionResult) -> dict[str, object]:
    """DetectionResultをJSONシリアライズ可能な辞書に変換"""
    return {
        "frame_number": detection_result.frame_number,
        "timestamp": detection_result.timestamp,
        "num_detections": detection_result.num_detections,
        "version": detection_result.version,
        "detections": [
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
            for det in detection_result.detections
        ],
    }


def create_app(
    shm: MockSharedMemory,
    monitor: WebMonitor,
    *,
    switch_controller: Optional["CameraSwitchController"] = None,
) -> Flask:
    """Flaskアプリケーションを作成"""
    app = Flask(__name__)

    # pyright: ignore[reportUnusedFunction]
    @app.route("/")
    def index():
        """メインページ"""
        html = """
        <!DOCTYPE html>
        <html>
        <head>
            <title>Smart Pet Camera Monitor</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link rel="stylesheet" href="/assets/monitor.css">
        </head>
        <body>
            <div class="app">
                <div class="header">
                    <div class="title">🐱 Smart Pet Camera Monitor</div>
                    <span class="badge badge-secondary" id="status-badge">Waiting for data...</span>
                </div>

                <div class="grid">
                    <div class="panel" style="grid-row: span 2;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                            <div>
                                <h2>Live Feed</h2>
                                <p class="panel-subtitle">BBox合成済みの映像をリアルタイムで確認できます。</p>
                            </div>
                            <div class="tag-row">
                                <span class="tag cat">cat</span>
                                <span class="tag food_bowl">food_bowl</span>
                                <span class="tag water_bowl">water_bowl</span>
                            </div>
                        </div>
                        <div id="video-panel">
                            <img id="stream" src="/stream" alt="Live stream from Smart Pet Camera">
                        </div>
                        <div class="trajectory-card" id="trajectory-card">
                            <div class="trajectory-title">Trajectory</div>
                            <canvas class="trajectory-canvas" id="trajectory-canvas"></canvas>
                            <div class="legend" id="trajectory-legend"></div>
                        </div>
                        <p class="footer-note">共有メモリの最新フレームにバウンディングボックスを合成したMJPEGストリームを配信しています。</p>
                    </div>

                    <div class="panel">
                        <h2>システムステータス</h2>
                        <p class="panel-subtitle">モニター、共有メモリ、検出結果の最新サマリ</p>
                        <div class="stat-grid">
                            <div class="stat">
                                <span class="stat-label">Camera FPS</span>
                                <span class="stat-value" id="fps">--</span>
                                <span class="stat-sub" id="target-fps">目標: -- fps</span>
                            </div>
                            <div class="stat">
                                <span class="stat-label">Detections</span>
                                <span class="stat-value" id="detections">--</span>
                                <span class="stat-sub" id="detection-version">---</span>
                            </div>
                        </div>

                        <div class="list">
                            <div class="list-item">
                                <div class="list-label">Shared memory buffer</div>
                                <div class="list-value" id="shm-buffer">--</div>
                            </div>
                            <div class="list-item">
                                <div class="list-label">Latest update</div>
                                <div class="list-value" id="last-updated">--</div>
                            </div>
                            <div class="list-item">
                                <div class="list-label">Frames buffered</div>
                                <div class="list-value" id="frames-total">--</div>
                            </div>
                        </div>
                    </div>

                    <div class="panel">
                        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
                            <div>
                                <h2>検出インサイト</h2>
                                <p class="panel-subtitle">履歴・ランキング・タイムラインを切り替えて把握</p>
                            </div>
                            <div class="view-toggle" id="view-toggle">
                                <button type="button" data-view="history" class="active">履歴</button>
                                <button type="button" data-view="ranking">ランキング</button>
                                <button type="button" data-view="timeline">タイムライン</button>
                            </div>
                        </div>
                        <div class="detections" id="history-list">
                            <p class="muted">まだ検出結果はありません。カメラ入力を待機しています。</p>
                        </div>
                        <div class="rank-list" id="ranking-list" style="display:none;"></div>
                        <div class="timeline" id="timeline-list" style="display:none;"></div>
                        <div class="timeline-chart" id="timeline-chart" style="display:none;">
                            <canvas class="timeline-canvas" id="timeline-canvas"></canvas>
                            <div class="legend" id="timeline-legend"></div>
                        </div>
                    </div>
                </div>
            </div>

            <script src="/assets/monitor.js" defer></script>
        </body>
        </html>
        """
        return render_template_string(html)

    @app.route("/assets/<path:filename>")
    def assets(filename: str):
        """Web UIアセットを返す"""
        build_path = ASSET_BUILD_DIR / filename
        if build_path.exists():
            return send_from_directory(ASSET_BUILD_DIR, filename)
        return send_from_directory(ASSET_SRC_DIR, filename)

    @app.route("/api/camera_status", methods=["GET"])
    def camera_status() -> Response:
        """カメラ切り替えステータスを返す"""
        switch_status = (
            switch_controller.get_status()  # type: ignore[union-attr]
            if switch_controller
            else {"mode": "unavailable"}
        )
        payload = {
            "camera": switch_status,
            "monitor": monitor.get_stats_snapshot(),
            "shared_memory": shm.get_stats(),
        }
        return jsonify(payload)

    @app.route("/api/debug/switch-camera", methods=["POST"])
    def debug_switch_camera() -> Response:
        """デバッグ用: 手動切り替え/自動復帰"""
        if switch_controller is None:
            return jsonify({"error": "switch controller is not configured"}), 400

        data = request.get_json(silent=True) or {}
        mode = str(data.get("mode", "manual")).lower()
        if mode == SwitchMode.AUTO.value:
            switch_controller.resume_auto()
            return jsonify(
                {"ok": True, "mode": "auto", "status": switch_controller.get_status()}
            )

        camera_raw = str(data.get("camera", "")).lower()
        if camera_raw not in (CameraType.DAY.value, CameraType.NIGHT.value):
            return jsonify({"error": "camera must be 'day' or 'night'"}), 400

        camera = (
            CameraType.DAY if camera_raw == CameraType.DAY.value else CameraType.NIGHT
        )
        reason = str(data.get("reason", "debug"))
        switch_controller.force_camera(camera, reason=reason)
        return jsonify(
            {"ok": True, "mode": "manual", "status": switch_controller.get_status()}
        )

    # pyright: ignore[reportUnusedFunction]
    @app.route("/stream")
    def video_stream():
        """MJPEGストリーム"""
        return Response(
            monitor.generate_mjpeg(),
            mimetype="multipart/x-mixed-replace; boundary=frame",
        )

    # pyright: ignore[reportUnusedFunction]
    @app.route("/api/status")
    def api_status():
        """統計情報と最新検出結果を返すシンプルなAPI"""
        latest_detection = monitor.get_latest_detection()
        detection_history = monitor.get_detection_history()
        return jsonify(
            {
                "monitor": monitor.get_stats_snapshot(),
                "shared_memory": shm.get_stats(),
                "latest_detection": (
                    _detection_to_dict(latest_detection) if latest_detection else None
                ),
                "detection_history": [
                    _detection_to_dict(item) for item in detection_history
                ],
                "timestamp": time.time(),
            }
        )

    # pyright: ignore[reportUnusedFunction]
    @app.route("/api/status/stream")
    def api_status_stream():
        """SSEで統計情報と最新検出結果を配信"""
        def generate():
            last_frame_count = -1
            last_detection_version = -1
            last_monitor_frames = -1
            last_sent = 0.0
            while True:
                monitor_stats = monitor.get_stats_snapshot()
                shm_stats = shm.get_stats()
                now = time.time()

                changed = (
                    shm_stats["frame_count"] != last_frame_count
                    or shm_stats["detection_version"] != last_detection_version
                    or monitor_stats["frames_processed"] != last_monitor_frames
                )
                if changed or now - last_sent > 2.0:
                    latest_detection = monitor.get_latest_detection()
                    detection_history = monitor.get_detection_history()
                    payload = {
                        "monitor": monitor_stats,
                        "shared_memory": shm_stats,
                        "latest_detection": (
                            _detection_to_dict(latest_detection)
                            if latest_detection
                            else None
                        ),
                        "detection_history": [
                            _detection_to_dict(item) for item in detection_history
                        ],
                        "timestamp": now,
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
                    last_frame_count = shm_stats["frame_count"]
                    last_detection_version = shm_stats["detection_version"]
                    last_monitor_frames = monitor_stats["frames_processed"]
                    last_sent = now

                time.sleep(0.02)

        return Response(
            generate(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    return app


# 使用例（後でmain.pyから呼び出す）
if __name__ == "__main__":
    print("WebMonitor cannot run standalone. Use main.py to start the system.")
