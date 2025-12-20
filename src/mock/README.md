# スマートペットカメラ - モック環境

Phase 0: 全Pythonで実装されたモック環境。実機なしでローカルPC上で全体システムを動作検証できます。

## 特徴

- **実機不要**: ローカルPC（Linux/Mac/Windows）で動作
- **完全機能**: カメラ、検出、共有メモリ、Webモニターの全機能を実装
- **デバッグ容易**: print文、デバッガが自由に使える
- **高速イテレーション**: 実機への転送不要

## アーキテクチャ

```
MockCamera (30fps)
    ↓
MockSharedMemory (Pythonクラス)
    ↓
MockDetector (10fps, ランダムBBox)
    ↓
WebMonitor (Flask + MJPEG)
    ↓
Browser (http://localhost:8080)
```

## セットアップ

### 1. 依存関係のインストール

```bash
cd smart-pet-camera
uv add flask opencv-python numpy
uv sync
```

> ⚠️ `opencv-python` はモックカメラのフレーム生成とJPEGエンコードに必須です。未インストールだとWebモニターに映像が出ません。

### 2. 実行

```bash
# ランダムパターンソース（デフォルト）
uv run src/mock/main.py

# Webカメラソース
uv run src/mock/main.py --source webcam

# テスト動画ファイル
uv run src/mock/main.py --source video --source-path /path/to/video.mp4

# 静止画像
uv run src/mock/main.py --source image --source-path /path/to/image.jpg

# カスタムFPSと検出確率
uv run src/mock/main.py --fps 60 --detection-prob 0.5

# カスタムポート
uv run src/mock/main.py --port 9000
```

### 3. ブラウザで確認

http://localhost:8080 にアクセスし、リアルタイムBBox合成映像を確認。

## コマンドラインオプション

```
--source         カメラソースタイプ (random/video/webcam/image)
--source-path    動画/画像ファイルのパス
--fps            カメラFPS (デフォルト: 30)
--detection-prob 検出発生確率 (デフォルト: 0.3)
--port           Webサーバーポート (デフォルト: 8080)
--host           Webサーバーホスト (デフォルト: 0.0.0.0)
--night-source   夜間カメラのソースタイプ（デフォルト: --sourceと同じ）
--night-source-path 夜間カメラ用の動画/画像ファイルパス
--night-fps      夜間カメラFPS（デフォルト: --fpsと同じ）
--day-to-night-threshold 昼→夜切替の明るさ閾値（デフォルト: 40）
--night-to-day-threshold 夜→昼切替の明るさ閾値（デフォルト: 70）
--day-to-night-hold 低輝度が継続してから切替えるまでの秒数（デフォルト: 10）
--night-to-day-hold 高輝度が継続してから切替えるまでの秒数（デフォルト: 10）
--probe-interval 非アクティブカメラの明るさプローブ間隔秒（デフォルト: 2.0）
--warmup-frames  カメラ切替後に破棄するフレーム数（デフォルト: 3）
--initial-camera 起動時のアクティブカメラ（day/night、デフォルト: day）
```

## モジュール構成

### src/common/src/common/types.py
共通型定義（全モジュールで共有）

- `Frame`: フレームデータ
- `Detection`: 検出結果
- `BoundingBox`: バウンディングボックス
- `DetectionResult`: 検出結果セット

### src/mock/shared_memory.py
MockSharedMemory - 共有メモリのエミュレーション

- スレッドセーフなリングバッファ
- フレームと検出結果を管理
- 実際の共有メモリ（C/POSIX shm）と同じインターフェース

### src/mock/camera.py
MockCamera - カメラのモック

- ランダムパターン生成
- テスト動画再生
- Webカメラキャプチャ
- 静止画像表示

### src/mock/detector.py
MockDetector - 物体検出のモック

- ランダムにBBoxを生成
- クラス別のサイズ・位置調整
- 検出確率の制御

### src/monitor/web_monitor.py
WebMonitor - Webモニター

- Flask + MJPEGストリーミング
- BBox合成表示
- リアルタイムFPS表示

### src/mock/main.py
統合メインプログラム

- 全モジュールの統合
- マルチスレッド制御
- コマンドラインインターフェース

## 使用例

### 基本的な使用

```bash
# 1. モック環境起動（カメラ/検出/共有メモリ/Webモニターを一括起動）
uv run src/mock/main.py

# 2. ブラウザで http://localhost:8080 を開く

# 3. ランダムにBBoxが表示されることを確認
```

### モニターだけを単体で使う場合

モニターだけ別プロセスで立ち上げたい場合は、`MockSharedMemory` を使う `--shm-type mock` オプションを指定します。現状 `mock` のみ実装済みです。

```bash
uv run src/monitor/main.py --shm-type mock --host 0.0.0.0 --port 8080
```

実機向けのPOSIX shmは `/dev/shm/pet_camera_frames` `/dev/shm/pet_camera_detections` を想定しており、`src/capture/real_shared_memory.py` の `RealSharedMemory` が読み取り側になります。`--shm-type real` 追加実装で切り替えられる構造です。

### Webカメラでテスト

```bash
uv run src/mock/main.py --source webcam --fps 30
```

### 明るさでの昼夜自動切り替えを確認

```bash
uv run src/mock/main.py \
  --source random \
  --night-source random \
  --day-to-night-threshold 40 \
  --night-to-day-threshold 70 \
  --probe-interval 2
```

`/api/camera_status` で現在の明るさとアクティブカメラを確認できます。

### デバッグ用に手動でカメラを切り替える

手動で day/night を固定したい場合は HTTP POST を使用します。

```bash
# 夜間カメラに固定
curl -X POST http://localhost:8080/api/debug/switch-camera \
  -H "Content-Type: application/json" \
  -d '{"mode": "manual", "camera": "night", "reason": "manual-test"}'

# 自動切り替えに戻す
curl -X POST http://localhost:8080/api/debug/switch-camera \
  -H "Content-Type: application/json" \
  -d '{"mode": "auto"}'
```

### 高頻度検出でテスト

```bash
uv run src/mock/main.py --detection-prob 0.8
```

## トラブルシューティング

### OpenCVがインストールされていない

```bash
uv add opencv-python
uv sync
```

### Webカメラが使えない

```bash
# ランダムパターンソースを使用
uv run src/mock/main.py --source random
```

### ポート8080が使用中

```bash
uv run src/mock/main.py --port 9000
```

## 次のステップ

Phase 0完了後:

1. **Phase 1**: 実機Captureデーモン化（C言語で共有メモリ実装）
2. **Phase 2**: モック→実機共有メモリ切り替え
3. **Phase 3**: 本物の物体検出モデル統合

WebMonitorはそのまま使える！
