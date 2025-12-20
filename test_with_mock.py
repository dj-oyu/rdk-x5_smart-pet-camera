#!/usr/bin/env python3
"""
test_with_mock.py - 本番用テストコードをモック環境で実行

test_integration.pyをモック環境で実行するためのアダプター
"""

import argparse
import time
from pathlib import Path
import sys
import threading

# Add paths
sys.path.insert(0, str(Path(__file__).parent / "src" / "common" / "src"))
sys.path.insert(0, str(Path(__file__).parent / "src" / "mock"))
sys.path.insert(0, str(Path(__file__).parent / "src" / "monitor"))

from mock.shared_memory import MockSharedMemory
from mock.camera import MockCamera
from mock.detector import MockDetector


class MockAdapter:
    """
    test_integration.pyが期待するインターフェースに合わせたアダプター
    """

    def __init__(self):
        self.shm = None

    def open(self):
        """モック共有メモリを開く"""
        self.shm = MockSharedMemory()
        print("[Info] Connected to mock shared memory")

    def close(self):
        """クローズ（モックでは何もしない）"""
        pass

    def get_latest_frame(self):
        """最新フレームを取得"""
        if not self.shm:
            return None
        return self.shm.read_latest_frame()

    def get_latest_detections(self):
        """最新検出結果を取得"""
        if not self.shm:
            return None

        detection_result, version = self.shm.read_detection()
        if detection_result is None:
            return None

        return (version, detection_result.detections)

    def decode_jpeg(self, jpeg_data: bytes):
        """JPEG をデコード"""
        import cv2
        import numpy as np

        nparr = np.frombuffer(jpeg_data, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Failed to decode JPEG")
        # OpenCV loads as BGR, convert to RGB
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        return img


def start_mock_system(shm: MockSharedMemory, fps: int = 30, detection_prob: float = 0.3):
    """
    モックカメラとモック検出器を起動

    Args:
        shm: 共有メモリ
        fps: フレームレート
        detection_prob: 検出確率
    """
    camera = MockCamera(source="random", fps=fps)
    detector = MockDetector(detection_probability=detection_prob)

    print(f"[Info] Mock system started (FPS={fps}, detection_prob={detection_prob})")

    frame_count = 0
    while True:
        # Get frame from camera
        frame = camera.capture_frame()
        if frame:
            # Write to shared memory
            shm.write_frame(frame)

            # Run detection
            detections = detector.detect(frame)
            if detections:
                # Create detection result
                from common.types import DetectionResult

                det_result = DetectionResult(
                    frame_number=frame.frame_number,
                    timestamp=frame.timestamp,
                    detections=detections,
                    version=frame_count,  # Use frame count as version
                )
                shm.write_detection(det_result)

            frame_count += 1

            # Slow down to match FPS
            time.sleep(1.0 / fps)


def main():
    parser = argparse.ArgumentParser(
        description="本番用テストコードをモック環境で実行"
    )
    parser.add_argument(
        "--save-frames",
        action="store_true",
        help="Save frames to disk",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="/tmp/frames",
        help="Output directory for saved frames (default: /tmp/frames)",
    )
    parser.add_argument(
        "--max-frames",
        type=int,
        default=0,
        help="Maximum number of frames to capture (0 = unlimited)",
    )
    parser.add_argument(
        "--fps-stats",
        action="store_true",
        help="Display FPS statistics",
    )
    parser.add_argument(
        "--mock-fps",
        type=int,
        default=30,
        help="Mock camera FPS (default: 30)",
    )
    parser.add_argument(
        "--detection-prob",
        type=float,
        default=0.3,
        help="Detection probability (default: 0.3)",
    )

    args = parser.parse_args()

    # Create output directory if saving frames
    if args.save_frames:
        output_path = Path(args.output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        print(f"[Info] Saving frames to: {output_path}")

    # Create mock shared memory
    mock_shm = MockSharedMemory()

    # Start mock system in background thread
    mock_thread = threading.Thread(
        target=start_mock_system,
        args=(mock_shm, args.mock_fps, args.detection_prob),
        daemon=True,
    )
    mock_thread.start()

    # Give the mock system time to start
    time.sleep(0.5)

    # Use adapter to match RealSharedMemory interface
    shm = MockAdapter()
    shm.shm = mock_shm

    try:
        print("[Info] Waiting for frames (Ctrl+C to stop)...\n")

        frame_count = 0
        start_time = time.time()
        last_fps_time = start_time
        last_fps_count = 0

        while True:
            # Get latest frame
            frame = shm.get_latest_frame()

            if frame:
                frame_count += 1

                # Display frame info
                print(
                    f"Frame {frame.frame_number:6d}: "
                    f"{frame.width:4d}x{frame.height:4d}, "
                    f"{len(frame.data):7d} bytes, "
                    f"camera_id={frame.camera_id}"
                )

                # Save frame if requested
                if args.save_frames:
                    try:
                        filename = output_path / f"frame_{frame.frame_number:06d}.jpg"
                        with open(filename, "wb") as f:
                            f.write(frame.data)
                        print(f"  Saved: {filename}")
                    except Exception as e:
                        print(f"  Error saving frame: {e}")

                # FPS statistics
                if args.fps_stats:
                    current_time = time.time()
                    if current_time - last_fps_time >= 1.0:
                        fps = (frame_count - last_fps_count) / (
                            current_time - last_fps_time
                        )
                        print(f"  FPS: {fps:.2f}")
                        last_fps_time = current_time
                        last_fps_count = frame_count

                # Check max frames
                if args.max_frames > 0 and frame_count >= args.max_frames:
                    print(f"\n[Info] Reached maximum frame count: {args.max_frames}")
                    break

            # Check for detections
            det_result = shm.get_latest_detections()
            if det_result:
                version, detections = det_result
                print(f"\nDetections (v{version}): {len(detections)} objects")
                for det in detections:
                    print(
                        f"  - {det.class_name.value:12s}: {det.confidence:.2f} "
                        f"at ({det.bbox.x:4d}, {det.bbox.y:4d}) "
                        f"size ({det.bbox.w:4d}, {det.bbox.h:4d})"
                    )
                print()

            # Sleep briefly to avoid busy-waiting
            time.sleep(0.01)

    except KeyboardInterrupt:
        print("\n\n[Info] Stopped by user")
    except Exception as e:
        print(f"\n[Error] {e}")
        import traceback

        traceback.print_exc()
        return 1
    finally:
        shm.close()

        # Print summary
        elapsed = time.time() - start_time
        if frame_count > 0:
            avg_fps = frame_count / elapsed
            print(f"\n=== Summary ===")
            print(f"Total frames: {frame_count}")
            print(f"Elapsed time: {elapsed:.2f} seconds")
            print(f"Average FPS: {avg_fps:.2f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
