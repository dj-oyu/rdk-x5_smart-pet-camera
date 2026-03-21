# mock — Development Mock Framework

## Overview
ハードウェアなしで開発・テストするためのモックフレームワーク。

## Run
```bash
uv run src/mock/main.py --detection-prob 0.7
# → Go streaming serverと組み合わせて http://localhost:8080 で確認
```

## Components
- `camera.py` — 4ソース対応 (random/video/webcam/image)
- `detector.py` — ランダムbbox生成 (cat 70%, food_bowl 15%, water_bowl 15%)
- `shared_memory.py` — スレッドセーフなリングバッファ (POSIX SHM互換IF)
- `camera_switcher.py` — 輝度ベースの昼夜切替ロジック
- `main.py` — 全コンポーネント統合起動

## POSIX SHM Mocks (src/capture/)
```bash
uv run src/capture/mock_camera_daemon.py   # 実POSIX SHMに書き込み
uv run src/capture/mock_detector_daemon.py # 実POSIX SHMに検出書き込み
```
