"""
Webモニター実装

Flask + MJPEGストリーミングでBBox合成映像をブラウザに表示
"""

from flask import Flask, Response, render_template_string
import cv2
import numpy as np
import json
from typing import Optional
import queue
import threading
import time
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "common" / "src"))
# 共通型定義をインポート
from common.types import Frame, DetectionResult, Detection, BoundingBox, DetectionClass

# MockSharedMemoryをインポート（型ヒント用）
sys.path.insert(0, str(Path(__file__).parent.parent / "mock"))
from shared_memory import MockSharedMemory


# 色定義（BGR）
COLORS = {
    "cat": (0, 255, 0),          # 緑
    "food_bowl": (0, 165, 255),  # オレンジ
    "water_bowl": (255, 0, 0),   # 青
}


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

            # BBox合成
            overlay_frame = self._draw_overlay(frame, cached_detections)

            # JPEGエンコード
            _, encoded = cv2.imencode(
                '.jpg',
                overlay_frame,
                [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality]
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
                print(f"[WARN] Unsupported detection result type: {type(detection_result_raw)}")
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
                try:
                    class_enum = DetectionClass(det.get("class_name"))
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

            return DetectionResult(
                frame_number=int(detection_dict.get("frame_number", 0)),
                timestamp=float(detection_dict.get("timestamp", time.time())),
                detections=detections,
                version=int(detection_dict.get("version", 0)),
            )
        except Exception as exc:
            print(f"[WARN] Failed to parse detection result: {exc}")
            return None

    def _draw_overlay(
        self,
        frame: Frame,
        detection_result: Optional[DetectionResult]
    ) -> np.ndarray:
        """
        BBoxを合成

        Args:
            frame: 入力フレーム
            detection_result: 検出結果

        Returns:
            BBox合成済みのフレーム（BGR）
        """
        # JPEG デコード
        np_arr = np.frombuffer(frame.data, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if detection_result is None or not detection_result.detections:
            # 検出結果なし
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
            img,
            (bbox.x, bbox.y),
            (bbox.x + bbox.w, bbox.y + bbox.h),
            color,
            2
        )

        # ラベルを描画
        label = f"{class_name}: {confidence:.2f}"
        label_size, baseline = cv2.getTextSize(
            label,
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            1
        )
        label_y = max(bbox.y - 10, label_size[1] + 10)

        # ラベル背景
        cv2.rectangle(
            img,
            (bbox.x, label_y - label_size[1] - baseline),
            (bbox.x + label_size[0], label_y + baseline),
            color,
            -1
        )

        # ラベルテキスト
        cv2.putText(
            img,
            label,
            (bbox.x, label_y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 0, 0),
            1
        )

    def _draw_info_text(
        self,
        img: np.ndarray,
        frame: Frame,
        detection_result: Optional[DetectionResult]
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
                2
            )
            y_offset += 25

    def generate_mjpeg(self):
        """MJPEGストリームを生成（Flask用ジェネレータ）"""
        while True:
            try:
                frame = self.frame_queue.get(timeout=1.0)
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
            except queue.Empty:
                continue


def create_app(shm: MockSharedMemory, monitor: WebMonitor) -> Flask:
    """Flaskアプリケーションを作成"""
    app = Flask(__name__)

    @app.route('/')
    def index():
        """メインページ"""
        html = """
        <!DOCTYPE html>
        <html>
        <head>
            <title>Smart Pet Camera Monitor</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    background: #1a1a1a;
                    color: #fff;
                    margin: 0;
                    padding: 20px;
                }
                #container {
                    max-width: 1400px;
                    margin: 0 auto;
                }
                h1 {
                    text-align: center;
                    margin-bottom: 20px;
                }
                #video-panel {
                    position: relative;
                    background: #000;
                    border: 2px solid #444;
                    border-radius: 8px;
                    overflow: hidden;
                }
                #stream {
                    width: 100%;
                    display: block;
                }
                #stats-panel {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 15px;
                    margin-top: 20px;
                }
                .stat-card {
                    background: #2a2a2a;
                    padding: 15px;
                    border-radius: 8px;
                    border: 1px solid #444;
                }
                .stat-card h3 {
                    margin: 0 0 10px 0;
                    font-size: 14px;
                    color: #888;
                }
                .stat-value {
                    font-size: 24px;
                    font-weight: bold;
                    color: #4CAF50;
                }
            </style>
        </head>
        <body>
            <div id="container">
                <h1>🐱 Smart Pet Camera Monitor</h1>

                <div id="video-panel">
                    <img id="stream" src="/stream">
                </div>

                <div id="stats-panel">
                    <div class="stat-card">
                        <h3>Camera FPS</h3>
                        <div class="stat-value" id="fps">--</div>
                    </div>
                    <div class="stat-card">
                        <h3>Frames Processed</h3>
                        <div class="stat-value" id="frames">--</div>
                    </div>
                    <div class="stat-card">
                        <h3>Detections</h3>
                        <div class="stat-value" id="detections">--</div>
                    </div>
                </div>
            </div>

            <script>
                // 統計情報を定期的に更新（将来的にWebSocket/SSEで実装）
                setInterval(() => {
                    // TODO: サーバーから統計情報を取得
                }, 1000);
            </script>
        </body>
        </html>
        """
        return render_template_string(html)

    @app.route('/stream')
    def video_stream():
        """MJPEGストリーム"""
        return Response(
            monitor.generate_mjpeg(),
            mimetype='multipart/x-mixed-replace; boundary=frame'
        )

    return app


# 使用例（後でmain.pyから呼び出す）
if __name__ == "__main__":
    print("WebMonitor cannot run standalone. Use main.py to start the system.")
