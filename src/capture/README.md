# Camera Capture Daemon

D-Robotics RDK X5 向けカメラキャプチャデーモンと共有メモリインターフェース

## 概要

1. **カメラデーモン** (`camera_daemon_main.c`) - VIO/ISP/VSE + H.265 VPUエンコード、ゼロコピーSHM出力
2. **共有メモリ** (`shared_memory.c/h`) - POSIX共有メモリによるプロセス間通信（6リージョン）
3. **Pythonラッパー** (`real_shared_memory.py`, `hb_mem_bindings.py`) - SHM/hb_memのPythonバインディング
4. **テスト** (`test_integration.py`, `test_daemon_python.py`) - 動作確認用

## ビルド

```bash
cd src/capture

# デーモンとライブラリのビルド
make

# カメラデーモンの起動（前回プロセスと共有メモリをクリーンアップ）
make run

# バックグラウンド起動
make run-daemon

# 後片付け
make clean
```

### ビルド成果物

- `../../build/camera_daemon_drobotics` - カメラキャプチャデーモン
- `../../build/libjpeg_encoder.a` - JPEG エンコーダライブラリ (CGO用)
- `../../build/libn2d_comic.a` - nano2D コミック合成ライブラリ
- `../../build/libn2d_letterbox.so` - nano2D レターボックス共有ライブラリ

## 使用方法

### カメラデーモンの起動

```bash
# プリセット1: 640x480@30fps
./build/camera_daemon_drobotics -C 0 -P 1

# プリセット2: 1920x1080@30fps
./build/camera_daemon_drobotics -C 0 -P 2

# デーモンモード
./build/camera_daemon_drobotics -C 0 -P 1 --daemon
```

### Python統合テスト

```bash
# カメラデーモンが起動していることを確認してから実行
uv run src/capture/test_integration.py

# FPS統計を表示
uv run src/capture/test_integration.py --fps-stats
```

## ファイル一覧

```
src/capture/
├── Makefile                    # ビルド設定
├── camera_daemon_main.c        # メインエントリーポイント
├── camera_pipeline.c/h         # カメラパイプライン（VIO→ISP→VSE→エンコーダ）
├── vio_lowlevel.c/h            # D-Robotics VIO低レベルAPI
├── encoder_lowlevel.c/h        # H.265 VPUエンコーダ
├── encoder_thread.c/h          # エンコーダスレッド
├── tcp_relay.c/h               # TCP リレー
├── shared_memory.c/h           # 共有メモリ（ゼロコピー）
├── shm_constants.h             # SHM定数定義
├── isp_brightness.c/h          # ISP明るさ制御・低照度補正
├── isp_lowlight_profile.h      # 低照度ISPプロファイル
├── camera_switcher.c/h         # 昼夜切り替えコントローラ
├── jpeg_encoder.c/h            # JPEGエンコーダ（CGOライブラリ）
├── n2d_comic.c/h               # nano2Dコミック合成
├── n2d_letterbox.c/h           # nano2Dレターボックス
├── rgn_overlay.c/h             # RGNオーバーレイ
├── logger.c/h                  # ログユーティリティ
├── real_shared_memory.py       # Pythonラッパー
├── hb_mem_bindings.py          # hb_memバインディング
├── test_integration.py         # 統合テスト
├── test_daemon_python.py       # Pythonデーモンテスト
└── mock_detector_daemon.py     # モック検出デーモン
```
