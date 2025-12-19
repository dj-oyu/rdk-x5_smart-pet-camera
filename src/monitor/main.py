"""WebMonitor専用CLIエントリーポイント。"""

from __future__ import annotations

import argparse
import os
import signal
import sys
from pathlib import Path

# 共通型定義/モック環境をimportできるようにパスを追加
PROJECT_ROOT = Path(__file__).resolve().parent.parent
COMMON_SRC = PROJECT_ROOT / "common" / "src"
MOCK_SRC = PROJECT_ROOT / "mock"

for path in (COMMON_SRC, MOCK_SRC):
    sys.path.insert(0, str(path))

from monitor.web_monitor import WebMonitor, create_app
from shared_memory import MockSharedMemory


def _env_int(key: str, default: int) -> int:
    """整数環境変数のパーサ（不正値はデフォルトにフォールバック）。"""

    value = os.getenv(key)
    if value is None:
        return default

    try:
        return int(value)
    except ValueError:
        print(f"[WARN] Invalid integer for {key}={value!r}. Using default {default}.")
        return default


def _build_parser() -> argparse.ArgumentParser:
    """CLI引数パーサを構築する。"""

    parser = argparse.ArgumentParser(
        description=(
            "Smart Pet Camera WebMonitor. "
            "共有メモリからフレームと検出結果を読み取り、ブラウザへ配信します。"
        )
    )

    parser.add_argument(
        "--shm-type",
        default=os.getenv("MONITOR_SHM_TYPE", "mock"),
        choices=["mock"],
        help="使用する共有メモリ種別（現在は'mock'のみ対応）",
    )
    parser.add_argument(
        "--host",
        default=os.getenv("MONITOR_HOST", "0.0.0.0"),
        help="Flaskのバインド先ホスト (デフォルト: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=_env_int("MONITOR_PORT", 8080),
        help="Flaskのポート番号 (デフォルト: 8080)",
    )
    parser.add_argument(
        "--jpeg-quality",
        type=int,
        default=_env_int("MONITOR_JPEG_QUALITY", 80),
        help="MJPEGエンコード品質 1-100 (デフォルト: 80)",
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=_env_int("MONITOR_FPS", 30),
        help="モニター処理の目標FPS (デフォルト: 30)",
    )

    return parser


def _create_shared_memory(shm_type: str) -> MockSharedMemory:
    """共有メモリ実装を生成する。"""

    normalized = shm_type.lower()
    if normalized == "mock":
        return MockSharedMemory()

    raise ValueError(f"Unsupported shared memory type: {shm_type}")


def main(argv: list[str] | None = None) -> None:
    """CLIエントリーポイント。"""

    parser = _build_parser()
    args = parser.parse_args(argv)

    if not 1 <= args.jpeg_quality <= 100:
        parser.error("--jpeg-quality は 1-100 の範囲で指定してください。")

    if args.fps <= 0:
        parser.error("--fps は 1以上の整数で指定してください。")

    try:
        shm = _create_shared_memory(args.shm_type)
    except ValueError as exc:  # pragma: no cover - 例外経路でも明示的に終了
        parser.error(str(exc))

    monitor = WebMonitor(shm, fps=args.fps, jpeg_quality=args.jpeg_quality)
    monitor.start()

    app = create_app(shm, monitor)

    print("=" * 60)
    print("Smart Pet Camera WebMonitor")
    print("=" * 60)
    print(f"Shared memory: {args.shm_type}")
    print(f"MJPEG quality: {args.jpeg_quality}")
    print(f"Target FPS: {args.fps}")
    print(f"Web server: http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop")
    print("=" * 60)

    def _shutdown_handler(signum, frame):  # type: ignore[arg-type]
        monitor.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown_handler)
    signal.signal(signal.SIGTERM, _shutdown_handler)

    try:
        app.run(host=args.host, port=args.port, threaded=True, debug=False)
    finally:
        monitor.stop()


if __name__ == "__main__":
    main()
