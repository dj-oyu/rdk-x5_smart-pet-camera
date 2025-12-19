"""
モック環境統合メインプログラム

全てのモジュールを統合して動作させる:
- MockCamera: フレーム生成
- MockDetector: ランダムBBox生成
- MockSharedMemory: プロセス間通信
- WebMonitor: ブラウザ表示
"""

import argparse
import threading
import time
import signal
import sys
from pathlib import Path

# 共通型定義をインポート
sys.path.insert(0, str(Path(__file__).parent.parent / "common" / "src"))
from common.types import Frame, DetectionResult

# モックモジュールをインポート
from shared_memory import MockSharedMemory
from camera import MockCamera
from detector import MockDetector

# モニターモジュールをインポート
sys.path.insert(0, str(Path(__file__).parent.parent / "monitor"))
from web_monitor import WebMonitor, create_app


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
        "--detection-prob",
        type=float,
        default=0.3,
        help="Detection probability (default: 0.3)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8080,
        help="Web server port (default: 8080)"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Web server host (default: 0.0.0.0)"
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
    print(f"Web server: http://{args.host}:{args.port}")
    print("=" * 60)
    print()

    # 共有メモリ作成
    shm = MockSharedMemory()
    print("✓ Shared memory initialized")

    # カメラ作成
    try:
        camera = MockCamera(
            source=args.source,  # type: ignore
            source_path=args.source_path,
            fps=args.fps,
        )
        print(f"✓ Camera initialized: {camera}")
    except Exception as e:
        print(f"✗ Camera initialization failed: {e}")
        return

    # 検出器作成
    detector = MockDetector(detection_probability=args.detection_prob)
    print(f"✓ Detector initialized: {detector}")

    # Webモニター作成
    monitor = WebMonitor(shm, fps=args.fps)
    monitor.start()
    print("✓ Web monitor started")

    # Flaskアプリ作成
    app = create_app(shm, monitor)
    print("✓ Flask app created")

    # スレッド起動
    camera_thread = threading.Thread(
        target=camera_thread_func,
        args=(camera, shm),
        daemon=True
    )
    detection_thread = threading.Thread(
        target=detection_thread_func,
        args=(detector, shm),
        daemon=True
    )

    camera_thread.start()
    detection_thread.start()
    print("✓ Camera and detection threads started")

    print()
    print("=" * 60)
    print(f"🚀 System running! Open http://localhost:{args.port} in your browser")
    print("Press Ctrl+C to stop")
    print("=" * 60)
    print()

    try:
        # Flaskサーバー起動（ブロッキング）
        app.run(host=args.host, port=args.port, threaded=True, debug=False)
    except KeyboardInterrupt:
        pass
    finally:
        # クリーンアップ
        print("\nCleaning up...")
        running = False
        monitor.stop()
        camera.release()
        print("✓ Resources released")
        print("Goodbye!")


if __name__ == "__main__":
    main()
