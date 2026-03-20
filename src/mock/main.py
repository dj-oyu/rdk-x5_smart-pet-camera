"""
モック環境統合メインプログラム

全てのモジュールを統合して動作させる:
- MockCamera: フレーム生成
- MockDetector: ランダムBBox生成
- MockSharedMemory: プロセス間通信
- Web UI は Go サーバー (streaming_server) が提供
"""

import argparse
import threading
import time
import signal
import sys
from pathlib import Path

# 共通型定義をインポート
sys.path.insert(0, str(Path(__file__).parent.parent / "common" / "src"))
from common.types import Frame, DetectionResult, CameraType

# モックモジュールをインポート
from shared_memory import MockSharedMemory
from camera import MockCamera
from detector import MockDetector
from camera_switcher import CameraSwitchController


# グローバル変数
running = True
shm: MockSharedMemory


def signal_handler(sig, frame):  # type: ignore
    """シグナルハンドラー（Ctrl+C対応）"""
    global running
    print("\n\nShutdown signal received. Stopping...")
    running = False


def camera_thread_func(camera: MockCamera, shared_memory: MockSharedMemory) -> None:
    """
    カメラスレッド（30fps）

    Args:
        camera: モックカメラ
        shared_memory: 共有メモリ
    """
    print("Camera thread started")
    frame_count = 0
    start_time = time.time()

    while running:
        try:
            # フレームキャプチャ
            frame = camera.capture_frame()

            # 共有メモリに書き込み
            shared_memory.write_frame(frame)

            frame_count += 1

            # 10秒ごとにFPSを表示
            if frame_count % 300 == 0:
                elapsed = time.time() - start_time
                fps = frame_count / elapsed
                print(f"Camera: {frame_count} frames captured, {fps:.1f} fps")

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Camera thread error: {e}")
            time.sleep(0.1)

    print("Camera thread stopped")


def detection_thread_func(detector: MockDetector, shared_memory: MockSharedMemory) -> None:
    """
    検出スレッド（10fps相当）

    Args:
        detector: モック検出器
        shared_memory: 共有メモリ
    """
    print("Detection thread started")
    last_frame_number = -1
    detection_count = 0

    while running:
        try:
            # 最新フレームを取得
            frame = shared_memory.read_latest_frame()
            if frame is None:
                time.sleep(0.01)
                continue

            # すでに処理済みならスキップ
            if frame.frame_number == last_frame_number:
                time.sleep(0.01)
                continue

            # 物体検出実行
            detections = detector.detect(frame.data)

            # 検出結果を共有メモリに書き込み
            if detections or detection_count == 0:  # 初回は空でも書き込む
                detection_result = DetectionResult(
                    frame_number=frame.frame_number,
                    timestamp=Frame.now_timestamp(),
                    detections=detections,
                    version=0,  # write_detectionで上書きされる
                )
                shared_memory.write_detection(detection_result)

                if detections:
                    detection_count += 1
                    print(
                        f"Detection: Frame #{frame.frame_number}, "
                        f"{len(detections)} objects detected"
                    )

            last_frame_number = frame.frame_number

            # 10fps相当のペース
            time.sleep(0.1)

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Detection thread error: {e}")
            time.sleep(0.1)

    print("Detection thread stopped")
    print(f"Detector stats: {detector.get_stats()}")


def main() -> None:
    """メイン関数"""
    global shm, running

    # コマンドライン引数パース
    parser = argparse.ArgumentParser(description="Smart Pet Camera Mock System")
    parser.add_argument(
        "--source",
        type=str,
        default="random",
        choices=["random", "video", "webcam", "image"],
        help="Camera source type (default: random)"
    )
    parser.add_argument(
        "--source-path",
        type=str,
        help="Path to video/image file"
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=30,
        help="Camera FPS (default: 30)"
    )
    parser.add_argument(
        "--night-source",
        type=str,
        default=None,
        choices=["random", "video", "webcam", "image", None],
        help="Night camera source type (default: follow --source)"
    )
    parser.add_argument(
        "--night-source-path",
        type=str,
        help="Path to video/image file for night camera"
    )
    parser.add_argument(
        "--night-fps",
        type=int,
        default=None,
        help="Night camera FPS (default: follow --fps)"
    )
    parser.add_argument(
        "--detection-prob",
        type=float,
        default=0.3,
        help="Detection probability (default: 0.3)"
    )
    parser.add_argument(
        "--day-to-night-threshold",
        type=float,
        default=40.0,
        help="Brightness threshold to switch from day to night (default: 40)"
    )
    parser.add_argument(
        "--night-to-day-threshold",
        type=float,
        default=70.0,
        help="Brightness threshold to switch from night to day (default: 70)"
    )
    parser.add_argument(
        "--day-to-night-hold",
        type=float,
        default=10.0,
        help="Seconds brightness must stay low before switching to night (default: 10)"
    )
    parser.add_argument(
        "--night-to-day-hold",
        type=float,
        default=10.0,
        help="Seconds brightness must stay high before switching to day (default: 10)"
    )
    parser.add_argument(
        "--probe-interval",
        type=float,
        default=2.0,
        help="Seconds between brightness probes on inactive camera (default: 2.0)"
    )
    parser.add_argument(
        "--warmup-frames",
        type=int,
        default=3,
        help="Frames to drop after switching camera to allow exposure to stabilize (default: 3)"
    )
    parser.add_argument(
        "--initial-camera",
        type=str,
        choices=["day", "night"],
        default="day",
        help="Initial active camera (default: day)"
    )

    args = parser.parse_args()

    # シグナルハンドラー登録
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    print("=" * 60)
    print("Smart Pet Camera Mock System")
    print("=" * 60)
    print(f"Camera source: {args.source}")
    if args.source_path:
        print(f"Source path: {args.source_path}")
    print(f"Camera FPS: {args.fps}")
    print(f"Detection probability: {args.detection_prob}")
    print("=" * 60)
    print()

    # 共有メモリ作成
    shm = MockSharedMemory()
    print("✓ Shared memory initialized")

    # カメラ作成
    try:
        day_camera = MockCamera(
            source=args.source,  # type: ignore
            source_path=args.source_path,
            fps=args.fps,
            camera_id=0,
        )
        night_camera = MockCamera(
            source=(args.night_source or args.source),  # type: ignore[arg-type]
            source_path=(args.night_source_path or args.source_path),
            fps=(args.night_fps or args.fps),
            camera_id=1,
        )
        print(f"✓ Cameras initialized: day={day_camera}, night={night_camera}")
    except Exception as e:
        print(f"✗ Camera initialization failed: {e}")
        return

    # 検出器作成
    detector = MockDetector(detection_probability=args.detection_prob)
    print(f"✓ Detector initialized: {detector}")

    # カメラ切り替えコントローラ
    switch_controller = CameraSwitchController(
        shared_memory=shm,
        day_camera=day_camera,
        night_camera=night_camera,
        day_to_night_threshold=args.day_to_night_threshold,
        night_to_day_threshold=args.night_to_day_threshold,
        day_to_night_hold_seconds=args.day_to_night_hold,
        night_to_day_hold_seconds=args.night_to_day_hold,
        probe_interval_seconds=args.probe_interval,
        warmup_frames=args.warmup_frames,
        initial_camera=CameraType.DAY if args.initial_camera == "day" else CameraType.NIGHT,
    )
    switch_controller.start()
    print("✓ Camera switch controller started")

    # スレッド起動
    detection_thread = threading.Thread(
        target=detection_thread_func,
        args=(detector, shm),
        daemon=True
    )

    detection_thread.start()
    print("✓ Detection thread started")

    print()
    print("=" * 60)
    print("Mock system running (Web UI served by Go streaming server)")
    print("Press Ctrl+C to stop")
    print("=" * 60)
    print()

    try:
        # メインスレッドはシグナル待機
        while running:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        # クリーンアップ
        print("\nCleaning up...")
        running = False
        switch_controller.stop()
        print("✓ Resources released")
        print("Goodbye!")


if __name__ == "__main__":
    main()
