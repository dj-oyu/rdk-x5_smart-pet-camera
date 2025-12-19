# Camera Capture Daemon - D-Robotics専用実装

D-Roboticsプラットフォーム向けに最適化されたカメラキャプチャデーモンと共有メモリインターフェース

## 概要

このディレクトリには、D-Roboticsボード用のカメラキャプチャ実装が含まれています：

1. **共有メモリ実装** (`shared_memory.c/h`) - POSIX共有メモリによるプロセス間通信
2. **D-Roboticsカメラデーモン** (`camera_daemon_drobotics.c`) - ハードウェア最適化版
3. **Pythonラッパー** (`real_shared_memory.py`) - Python共有メモリアクセス
4. **テストプログラム** (`test_shm.c`, `test_integration.py`) - 動作確認用

### V4L2実装について

汎用的なV4L2実装（`camera_daemon.c`）も提供していますが、**D-Roboticsボードでは`camera_daemon_drobotics.c`の使用を強く推奨します**。

理由：
- ✅ ハードウェアアクセラレータ（VIN/ISP/VSE）を活用
- ✅ IMX219センサーに最適化
- ✅ 実機で動作確認済み（`capture_v2.c`ベース）
- ✅ 高いパフォーマンス（30fps維持）

## アーキテクチャ

```
┌───────────────────────┐
│ D-Robotics Camera     │
│  - IMX219 Sensor      │
│  - MIPI Interface     │
└──────────┬────────────┘
           │
           ↓ Hardware Pipeline
┌───────────────────────┐
│ VIN → ISP → VSE       │ (D-Robotics Hardware)
│  RAW10 → NV12 → Scale │
└──────────┬────────────┘
           │
           ↓ NV12 → JPEG (libjpeg)
┌───────────────────────┐
│ Camera Daemon (C)     │
│  - JPEG Encoding      │
│  - 30fps              │
└──────────┬────────────┘
           │
           ↓ Write (atomic)
┌──────────────────────────┐
│ Shared Memory Segment 1  │ (/dev/shm/pet_camera_frames)
│  - Ring Buffer (30 slots)│
│  - JPEG frames           │
│  - Metadata              │
└────────┬─────────────────┘
         │
         ↓ Read (polling)
┌─────────────────┐
│ Python Readers  │
│  - Monitor      │
│  - Detection    │
│  - Recording    │
└─────────────────┘
```

## ビルド方法

### 必要な依存関係

```bash
# D-Robotics SDK（通常はプリインストール済み）
# - libcam.so
# - libvpf.so
# - libhbmem.so

# 追加パッケージ
sudo apt-get install -y libjpeg-dev
```

### SDK確認

```bash
cd src/capture
make -f Makefile.drobotics check-sdk
```

### コンパイル

```bash
cd src/capture

# D-Robotics専用ビルド
make -f Makefile.drobotics

# テスト実行
make -f Makefile.drobotics test
```

### ビルド成果物

- `../../build/camera_daemon_drobotics` - D-Roboticsカメラデーモン
- `../../build/test_shm` - 共有メモリテストプログラム

## 使用方法

### 1. 共有メモリテストの実行

```bash
./build/test_shm

# 期待される出力:
# === Shared Memory Test Suite ===
# [PASS] test_shm_create_destroy
# [PASS] test_shm_write_read_single
# ...
# === All tests passed! ===
```

### 2. カメラデーモンの起動

```bash
# プリセット1: 640x480@30fps（推奨：開発・テスト用）
./build/camera_daemon_drobotics -C 0 -P 1

# プリセット2: 1920x1080@30fps（本番用）
./build/camera_daemon_drobotics -C 0 -P 2

# カスタム設定
./build/camera_daemon_drobotics -C 0 -w 1280 -h 720 -f 30

# デーモンモード（無限ループ）
./build/camera_daemon_drobotics -C 0 -P 1 --daemon

# カメラ1を使用
./build/camera_daemon_drobotics -C 1 -P 1

# オプション:
#   -C <id>       カメラID (0 or 1, デフォルト: 0)
#   -P <preset>   プリセット (1=640x480, 2=1920x1080)
#   -w <width>    出力幅 (カスタム設定)
#   -h <height>   出力高さ (カスタム設定)
#   -f <fps>      フレームレート (デフォルト: 30)
#   -c <count>    フレーム数 (0=無限, デフォルト: 0)
#   --daemon      デーモンモード
```

### 3. Python統合テストの実行

別のターミナルで:

```bash
# カメラデーモンが起動していることを確認してから実行
PYTHONPATH=src:src/common/src:src/capture uv run python src/capture/test_integration.py

# FPS統計を表示
uv run python src/capture/test_integration.py --fps-stats

# フレームを保存
uv run python src/capture/test_integration.py --save-frames --output-dir /tmp/frames

# 最大100フレームをキャプチャ
uv run python src/capture/test_integration.py --max-frames 100
```

### 4. Webモニターとの統合

```bash
# Terminal 1: カメラデーモン
./build/camera_daemon_drobotics -C 0 -P 1 --daemon

# Terminal 2: Webモニター
cd ../..
USE_REAL_CAMERA=1 uv run python src/monitor/main.py

# ブラウザで確認
# http://localhost:8080
```

## 共有メモリ仕様

### フレームバッファ

- **名前**: `/dev/shm/pet_camera_frames`
- **サイズ**: 約300MB (1080p想定)
- **構造**:
  - `write_index`: uint32_t (atomic)
  - `frames[30]`: Frame構造体の配列（リングバッファ）

### Frame構造体

```c
typedef struct {
    uint64_t frame_number;      // フレーム番号
    struct timespec timestamp;  // タイムスタンプ (CLOCK_MONOTONIC)
    int camera_id;              // カメラID (0 or 1)
    int width;                  // 幅
    int height;                 // 高さ
    int format;                 // 0=JPEG
    size_t data_size;           // データサイズ
    uint8_t data[MAX_FRAME_SIZE]; // JPEGデータ
} Frame;
```

## D-Robotics固有の設定

### IMX219センサー設定

```c
// camera_daemon_drobotics.c 内
camera_config_t camera_config = {
    .name = "imx219",
    .addr = 0x10,  // I2Cアドレス
    .sensor_mode = 1,  // Linear mode
    .fps = 30,
    .width = 1920,
    .height = 1080,
    .format = RAW10,
    .calib_lname = "/usr/hobot/lib/sensor/imx219_1920x1080_tuning.json",
    ...
};
```

### VIN/ISP/VSEパイプライン

- **VIN**: RAW10データ取得（MIPI経由）
- **ISP**: RAW10 → NV12変換、画像補正
- **VSE**: スケーリング（1920x1080 → 640x480等）

### カメラ選択

| カメラID | MIPI Host | デバイス | 用途 |
|---------|-----------|---------|-----|
| 0 | vcon@0 | /dev/video0 | 昼間用 |
| 1 | vcon@2 | /dev/video1 | 夜間用 |

## トラブルシューティング

### カメラが認識されない

```bash
# カメラデバイスの確認
ls -l /dev/video*

# D-Robotics SDK確認
make -f Makefile.drobotics check-sdk

# センサー設定確認
cat /usr/hobot/lib/sensor/imx219_1920x1080_tuning.json
```

### ビルドエラー

```bash
# ライブラリが見つからない場合
export LD_LIBRARY_PATH=/usr/lib:/usr/hobot/lib:$LD_LIBRARY_PATH

# ヘッダーが見つからない場合
sudo find /usr -name "hb_camera_interface.h"
```

### 共有メモリが見つからない

```bash
# 共有メモリの確認
ls -l /dev/shm/

# 古い共有メモリの削除
rm -f /dev/shm/pet_camera_*

# カメラデーモンを再起動
```

### パフォーマンス問題

```bash
# CPU使用率の確認
top -p $(pgrep camera_daemon)

# メモリ使用状況
cat /proc/$(pgrep camera_daemon)/status | grep VmRSS

# フレームドロップ確認（ログで確認）
# [Warn] Failed to get frame が頻発する場合は負荷が高い
```

**対策**:
- 解像度を下げる: `-P 1` (640x480)
- FPSを下げる: `-f 15`
- 他のプロセスを停止

## systemdサービス化

### サービスファイル

```ini
# /etc/systemd/system/smart-pet-camera-capture.service
[Unit]
Description=Smart Pet Camera - D-Robotics Capture Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/app/smart-pet-camera
ExecStart=/app/smart-pet-camera/build/camera_daemon_drobotics -C 0 -P 1 --daemon
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### サービス管理

```bash
# サービスファイルのコピー
sudo cp ../../systemd/smart-pet-camera-capture.service /etc/systemd/system/
sudo systemctl daemon-reload

# サービスの起動
sudo systemctl start smart-pet-camera-capture

# 自動起動の有効化
sudo systemctl enable smart-pet-camera-capture

# ステータス確認
sudo systemctl status smart-pet-camera-capture

# ログ確認
sudo journalctl -u smart-pet-camera-capture -f
```

## 次のステップ

Phase 1完了後の予定:

### Phase 2: 実機統合完了
- ✅ D-Roboticsデーモン作成
- ⏳ Webモニター統合
- ⏳ 24時間稼働テスト

### Phase 3: 本物の検出モデル統合
- TensorFlow Lite推論
- 検出結果の共有メモリへの書き込み
- パフォーマンスチューニング

## 参考資料

- D-Robotics SDK ドキュメント: `/usr/hobot/docs/`
- 元の実装: `docs/sample/capture_v2.c`
- IMX219データシート: [Sony公式](https://www.sony-semicon.co.jp/products/common/pdf/IMX219PQ_ProductBrief.pdf)

## 開発メモ

### なぜD-Robotics専用実装を作成したか

1. **ハードウェア最適化**: VIN/ISP/VSEパイプラインを活用
2. **実績**: `capture_v2.c`で動作確認済み
3. **パフォーマンス**: V4L2より高速・安定
4. **保守性**: 既存の知見を活用

### V4L2実装との比較

| 項目 | D-Robotics | V4L2 |
|------|-----------|------|
| パフォーマンス | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| 汎用性 | ⭐⭐ | ⭐⭐⭐⭐⭐ |
| 保守性 | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| ハードウェア活用 | ⭐⭐⭐⭐⭐ | ⭐⭐ |

## ファイル一覧

```
src/capture/
├── README_DROBOTICS.md         # このファイル
├── shared_memory.h             # 共有メモリヘッダ
├── shared_memory.c             # 共有メモリ実装
├── camera_daemon_drobotics.c   # D-Robotics専用デーモン ⭐推奨
├── camera_daemon.c             # V4L2汎用版（参考用）
├── Makefile.drobotics          # D-Robotics用ビルド設定 ⭐推奨
├── Makefile                    # V4L2用（参考用）
├── test_shm.c                  # Cテストプログラム
├── real_shared_memory.py       # Pythonラッパー
└── test_integration.py         # 統合テスト
```

## ライセンス

Apache License 2.0 (D-Robotics元実装のライセンスを継承)
