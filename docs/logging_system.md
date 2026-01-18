# Logging System Documentation

## Overview

統一されたログレベル制御システムを実装しました。全てのコンポーネント（Python detector、Go servers）が同じログレベル設定を共有し、簡単に制御できます。

## Log Levels

以下のログレベルをサポートしています：

| Level | 用途 | 出力内容 |
|-------|------|----------|
| `debug` | 開発・デバッグ | 全ての詳細ログ（毎フレームのパフォーマンス測定、semaphore操作など） |
| `info` | 本番運用（デフォルト） | 重要なイベントのみ（起動メッセージ、30フレームごとの検出結果など） |
| `warn` | 警告のみ | 警告とエラーのみ |
| `error` | エラーのみ | エラーメッセージのみ |
| `silent` | Go servers only | 全てのログを抑制 |

## 使い方

### 1. ランチャースクリプト経由（推奨）

全てのコンポーネントに統一されたログレベルを設定：

```bash
# デフォルト（info）
./scripts/run_camera_switcher_yolo_streaming.sh

# DEBUG レベル（詳細なパフォーマンス測定）
./scripts/run_camera_switcher_yolo_streaming.sh --log-level debug

# 環境変数でも設定可能
LOG_LEVEL=debug ./scripts/run_camera_switcher_yolo_streaming.sh
```

### 2. 個別コンポーネント

#### YOLO Detector (Python)

```bash
uv run src/detector/yolo_detector_daemon.py \
  --model-path /path/to/model.bin \
  --log-level debug
```

#### Go Web Monitor

```bash
./build/web_monitor \
  -http 0.0.0.0:8080 \
  -log-level debug \
  -log-color true
```

#### Go Streaming Server

```bash
./build/streaming-server \
  -shm /pet_camera_stream \
  -http 0.0.0.0:8081 \
  -log-level debug \
  -log-color true
```

## ログ出力の違い

### YOLO Detector

**DEBUG レベル（毎フレーム詳細測定）:**
```
[DEBUG] Frame #1: 2 detections ['cat', 'person']
[DEBUG]   YOLO: 25.3ms (prep=2.1ms, infer=20.5ms, post=2.7ms)
[DEBUG]   Loop: 28.5ms (get_frame=0.5ms, detect=25.3ms, scale=0.2ms, write=0.5ms, other=2.0ms)
[DEBUG]   -> cat: 0.85 @ (120, 150, 200, 180)
[DEBUG]   -> person: 0.92 @ (300, 100, 150, 400)
[DEBUG] sem_post SUCCESS: frame=1, num_det=2, version=1
```

**INFO レベル（30フレームごと、検出結果のみ）:**
```
[INFO] Frame #30: 2 detections ['cat', 'person']
[INFO] Frame #60: 1 detections ['cat']
[INFO] Frame #90: 0 detections (none)
```

### Go Web Monitor / Streaming Server

**DEBUG レベル:**
```
[DEBUG] [FrameBroadcaster] Client #1 subscribed (total clients: 1)
[DEBUG] [Reader] Read H.264 frame#30 from shm (write_index=31, latest_idx=30, ring_idx=0)
[DEBUG] [DetectionBroadcaster] Client #1 subscribed (total clients: 1)
```

**INFO レベル:**
```
[INFO] [Main] Go web monitor listening on 0.0.0.0:8080
[INFO] [Main] Log level: INFO
[INFO] [Reader] Successfully opened shared memory: /pet_camera_mjpeg_frame
```

## セマフォシグナル検証

セマフォによるイベント駆動アーキテクチャが正しく動作しているか確認する方法：

### 1. テストスクリプト実行

```bash
./scripts/test_semaphore_signaling.sh
```

### 2. 手動確認

DEBUGレベルでシステムを起動：
```bash
./scripts/run_camera_switcher_yolo_streaming.sh --log-level debug
```

Python側のログを確認（セマフォpost成功）:
```bash
grep 'sem_post' /tmp/yolo_detector.log | head -20
```

期待される出力：
```
DEBUG:RealSharedMemory:sem_post SUCCESS: frame=1, num_det=2, version=1
DEBUG:RealSharedMemory:sem_post SUCCESS: frame=2, num_det=1, version=2
DEBUG:RealSharedMemory:sem_post SUCCESS: frame=3, num_det=0, version=3
```

Go側のログを確認（セマフォwaitエラーがないこと）:
```bash
grep -i 'semaphore\|timeout' /tmp/web_monitor.log
```

エラーがなければ、セマフォシグナルは正常に動作しています。

## パフォーマンス測定の制御

### DEBUG レベルの影響

DEBUGレベルでは詳細なタイミング測定を行うため、若干のオーバーヘッドがあります：

- **測定項目**: get_frame, detect, scale, write, その他
- **ログ頻度**: 毎フレーム（30 FPS = 30回/秒）
- **CPU影響**: 約1-2%の追加負荷（文字列フォーマット、I/O）

### INFO レベルの最適化

INFOレベルでは測定を最小限に抑え、本番運用に適した設定：

- **測定スキップ**: `logger.isEnabledFor(logging.DEBUG)` でチェック
- **ログ頻度**: 30フレームに1回のみ（1回/秒）
- **CPU影響**: ほぼゼロ（測定自体をスキップ）

## コード実装詳細

### Python (yolo_detector_daemon.py)

```python
# ログレベルに応じた条件分岐
if logger.isEnabledFor(logging.DEBUG):
    # DEBUGレベル: 毎フレーム詳細測定
    logger.debug(f"  YOLO: {timing['total'] * 1000:.1f}ms ...")
    logger.debug(f"  Loop: {time_loop:.1f}ms ...")
elif self.stats["frames_processed"] % 30 == 0:
    # INFOレベル: 30フレームに1回
    logger.info(f"Frame #{self.stats['frames_processed']}: ...")
```

### Go (logger/logger.go)

```go
// モジュールベースのログ出力
logger.Debug("FrameBroadcaster", "Client #%d subscribed", id)
logger.Info("Reader", "Successfully opened shared memory: %s", shmName)
logger.Warn("SSE", "Protobuf marshal error: %v", err)
logger.Error("Main", "Failed to initialize: %v", err)
```

## トラブルシューティング

### ログが出力されない

1. ログレベルが適切か確認
   ```bash
   # DEBUGログが見たい場合
   ./scripts/run_camera_switcher_yolo_streaming.sh --log-level debug
   ```

2. ログファイルを確認
   - YOLO Detector: `/tmp/yolo_detector.log`
   - Web Monitor: `/tmp/web_monitor.log`
   - Streaming Server: `/tmp/streaming_server.log`
   - Camera Switcher: `/tmp/camera_switcher_daemon.log`

### セマフォエラーが出る

```
WARNING:RealSharedMemory:sem_post failed with return code: -1
```

原因:
- 共有メモリが初期化されていない
- camera_daemon が起動していない

解決策:
```bash
# クリーンアップして再起動
make -C src/capture cleanup
./scripts/run_camera_switcher_yolo_streaming.sh
```

### パフォーマンス測定が重い

DEBUGレベルは開発用です。本番ではINFOレベルを使用：

```bash
./scripts/run_camera_switcher_yolo_streaming.sh --log-level info
```

## まとめ

- **開発時**: `--log-level debug` で詳細なトレース
- **本番運用**: `--log-level info` で必要最小限のログ
- **セマフォ検証**: DEBUGログで `sem_post SUCCESS` を確認
- **パフォーマンス**: INFOレベルでオーバーヘッドを回避
