# Camera Capture Daemon - Phase 1 実装

V4L2カメラキャプチャデーモンと共有メモリインターフェースの実装

## 概要

このディレクトリには以下のコンポーネントが含まれています:

1. **共有メモリ実装** (`shared_memory.c/h`) - POSIX共有メモリによるプロセス間通信
2. **カメラデーモン** (`camera_daemon.c`) - V4L2カメラキャプチャとJPEGエンコーディング
3. **Pythonラッパー** (`real_shared_memory.py`) - Python from C shared memory access
4. **テストプログラム** (`test_shm.c`, `test_integration.py`) - 動作確認用

## アーキテクチャ

```
┌─────────────────┐
│ Camera Daemon   │ (C, V4L2)
│  - Captures     │
│  - JPEG encode  │
│  - 30fps        │
└────────┬────────┘
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
# Ubuntu/Debian
sudo apt-get install -y \
    build-essential \
    libjpeg-dev \
    v4l-utils \
    libv4l-dev

# カメラデバイスの確認
v4l2-ctl --list-devices
```

### コンパイル

```bash
# プロジェクトルートから
cd src/capture

# ビルド
make

# テスト実行
make test
```

### ビルド成果物

- `../../build/camera_daemon` - カメラキャプチャデーモン
- `../../build/test_shm` - 共有メモリテストプログラム

## 使用方法

### 1. 共有メモリテストの実行

```bash
# 共有メモリの動作確認
./build/test_shm

# 期待される出力:
# === Shared Memory Test Suite ===
#
# [PASS] test_shm_create_destroy
# [PASS] test_shm_write_read_single
# [PASS] test_shm_ring_buffer_wraparound
# [PASS] test_detection_write_read
# [PASS] test_detection_version_increment
#
# === All tests passed! ===
```

### 2. カメラデーモンの起動

```bash
# デフォルト設定 (640x480@30fps)
./build/camera_daemon

# カスタム設定
./build/camera_daemon -d /dev/video0 -w 1280 -h 720 -f 30 -c 0

# オプション:
#   -d <device>   カメラデバイス (デフォルト: /dev/video0)
#   -c <id>       カメラID (デフォルト: 0)
#   -w <width>    フレーム幅 (デフォルト: 640)
#   -h <height>   フレーム高さ (デフォルト: 480)
#   -f <fps>      フレームレート (デフォルト: 30)
#   --help        ヘルプを表示
```

### 3. Python統合テストの実行

別のターミナルで:

```bash
# カメラデーモンが起動していることを確認してから実行
python3 src/capture/test_integration.py

# FPS統計を表示
python3 src/capture/test_integration.py --fps-stats

# フレームを保存
python3 src/capture/test_integration.py --save-frames --output-dir /tmp/frames

# 最大100フレームをキャプチャ
python3 src/capture/test_integration.py --max-frames 100
```

### 4. 既存のWebモニターとの統合

モックから実機への切り替え:

```python
# src/monitor/main.py の修正

# Before (モック)
from mock.shared_memory import MockSharedMemory
shm = MockSharedMemory()

# After (実機)
from capture.real_shared_memory import RealSharedMemory
shm = RealSharedMemory()
shm.open()
```

## 共有メモリ仕様

### フレームバッファ

- **名前**: `/dev/shm/pet_camera_frames`
- **サイズ**: 約300MB (1080p想定)
- **構造**:
  - `write_index`: uint32_t (atomic)
  - `frames[30]`: Frame構造体の配列

### Frame構造体

```c
typedef struct {
    uint64_t frame_number;      // フレーム番号
    struct timespec timestamp;  // タイムスタンプ
    int camera_id;              // カメラID (0 or 1)
    int width;                  // 幅
    int height;                 // 高さ
    int format;                 // 0=JPEG, 1=NV12, 2=RGB
    size_t data_size;           // データサイズ
    uint8_t data[MAX_FRAME_SIZE]; // フレームデータ
} Frame;
```

### 検出結果バッファ

- **名前**: `/dev/shm/pet_camera_detections`
- **サイズ**: 約5KB
- **構造**:
  - 最新の検出結果のみを保持
  - `version`カウンタで更新を検知

## トラブルシューティング

### カメラが開けない

```bash
# デバイスの確認
ls -l /dev/video*

# 権限の確認
sudo usermod -a -G video $USER
# ログアウト・ログインして反映

# カメラ情報の確認
v4l2-ctl -d /dev/video0 --all
```

### 共有メモリが見つからない

```bash
# 共有メモリの確認
ls -l /dev/shm/

# 古い共有メモリの削除
rm -f /dev/shm/pet_camera_*

# カメラデーモンを再起動
```

### JPEGエンコードエラー

```bash
# libjpegのインストール確認
ldconfig -p | grep jpeg

# 再インストール
sudo apt-get install --reinstall libjpeg-dev
```

### パフォーマンス問題

```bash
# CPU使用率の確認
top -p $(pgrep camera_daemon)

# 解像度を下げる
./build/camera_daemon -w 320 -h 240

# フレームレートを下げる
./build/camera_daemon -f 15
```

## カメラ切り替えコントローラ（C実装）

明るさに基づく昼夜カメラ切り替えをCで実装したモジュールです。ダブルバッファリングで切り替え直後のフレームを安定化させます。

- コード: `camera_switcher.c`, `camera_switcher.h`
- 特徴:
  - 明るさ平均 + ヒステリシス（`day_to_night_threshold`/`night_to_day_threshold` と滞留秒数）
  - 手動固定（デバッグ）/自動切り替えモード
  - 切り替え後のウォームアップフレーム破棄
  - `frame_calculate_mean_luma` で JPEG / NV12 / RGB から輝度平均を算出し、`camera_switcher_handle_frame` でサンプル採取〜公開を一括実行
  - 共有メモリへの書き込み時にダブルバッファリングでフレーム整合性を維持
- 代表的な呼び出しフロー:
  1. `camera_switcher_init` で初期化（閾値・ウォームアップ数を設定）
  2. プローブした明るさを `camera_switcher_record_brightness` に渡し、戻り値が `TO_DAY/TO_NIGHT` ならハードを切り替える
  3. 切り替え後に `camera_switcher_notify_active_camera` を呼び、ウォームアップカウンタをリセット
  4. キャプチャしたフレームは `camera_switcher_publish_frame` に渡して共有メモリへ書き込む（ウォームアップ中は破棄）

### captureデーモン統合用のランタイム

`camera_switcher_runtime.c/.h` は実際の capture デーモンを想定したオーケストレーション層です。以下のコールバックを渡すだけで、アクティブ/プローブ周期の管理と切り替えが行えます。

- `switch_camera(CameraMode, user_data)`: ハード/デーモン側のカメラ切替（例: ISP設定変更、デバイス切替）
- `capture_frame(CameraMode, Frame*, user_data)`: 指定カメラからフレーム取得（Active/Probeの両方で使用）
- `publish_frame(const Frame*, user_data)`: 共有メモリなどへの書き込み

ランタイム設定例:

```c
CameraSwitchConfig cfg = {
    .day_to_night_threshold = 40.0,
    .night_to_day_threshold = 70.0,
    .day_to_night_hold_seconds = 10.0,
    .night_to_day_hold_seconds = 10.0,
    .warmup_frames = 3,
};

CameraSwitchRuntimeConfig rt_cfg = {
    .probe_interval_sec = 2.0,      // 非アクティブカメラのプローブ周期
    .active_interval_sec = 1.0/30., // アクティブカメラの目標間隔 (30fps想定)
};

CameraCaptureOps ops = {
    .switch_camera = hw_switch_fn,      // 実カメラ切替
    .capture_frame = daemon_capture_fn, // 共有メモリに書く前の生フレーム取得
    .publish_frame = shm_publish_fn,    // 共有メモリ書き込み
    .user_data = ctx,                   // 上記のコンテキスト
};

CameraSwitchRuntime rt;
camera_switch_runtime_init(&rt, &cfg, &rt_cfg, &ops, CAMERA_MODE_DAY);
camera_switch_runtime_start(&rt);
// ... シグナル等で停止 ...
camera_switch_runtime_stop(&rt);
```

ビルド:

```bash
cd src/capture
make switcher-runtime-lib  # ../../build/libcamera_switcher_runtime.a を生成
```

ライブラリをリンクする際は `-lpthread -ljpeg` を追加してください。

### デバッグ: 低依存のインタラクティブデモ

実機なしで切り替えロジックを試す場合は、Cのみで完結するデモを用意しています。

```bash
cd src/capture
make switcher-demo
./../../build/camera_switcher_demo
```

標準入力コマンド例:

- `day 30` / `night 80`: 明るさサンプルを投入（0-255）
- `manual day` / `manual night`: 指定カメラに固定
- `auto`: 自動切り替えに戻す
- `status`: 現在の状態を表示
- `quit`: 終了

ダブルバッファリング越しに publish されるフレーム情報が標準出力に表示されるため、切り替え直後のウォームアップ破棄も確認できます。

## 次のステップ

Phase 1完了後の予定:

### Phase 2: 実機統合
- Webモニターへの統合
- マルチカメラ対応
- エラー処理の強化

### Phase 3: 本物の検出モデル統合
- TensorFlow Lite推論
- 検出結果の共有メモリへの書き込み
- パフォーマンスチューニング

## 開発メモ

### 共有メモリの利点

1. **ゼロコピー**: メモリコピー不要で高速
2. **複数消費者**: 複数プロセスが同時に読み取り可能
3. **シンプル**: ロック不要のリングバッファ設計
4. **デバッグ容易**: `/dev/shm`で内容を直接確認可能

### 設計上の注意点

1. **Atomic操作**: `write_index`はatomicに更新
2. **リングバッファ**: 古いフレームは上書きされる
3. **ポーリング**: 読み取り側はポーリングで新フレームを検知
4. **フォーマット**: JPEG圧縮でメモリ使用量を削減

## ファイル一覧

```
src/capture/
├── README.md                   # このファイル
├── Makefile                    # ビルド設定
├── shared_memory.h             # 共有メモリヘッダ
├── shared_memory.c             # 共有メモリ実装
├── camera_switcher.h           # 昼夜切り替えコントローラ（C）
├── camera_switcher.c           # 昼夜切り替えロジック本体（C）
├── camera_switcher_demo.c      # デバッグ・動作確認用の対話デモ
├── camera_daemon.c             # カメラデーモン
├── test_shm.c                  # Cテストプログラム
├── real_shared_memory.py       # Pythonラッパー
└── test_integration.py         # 統合テスト
```

## ライセンス

(プロジェクトのライセンスに従う)
