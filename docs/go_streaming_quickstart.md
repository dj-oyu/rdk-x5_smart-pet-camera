# Go Streaming Server クイックスタート

## 概要

Go実装のStreaming Serverを含む全システムを一括起動するための手順。

## 前提条件

### 必須ツール

- **make** - Cコンパイル用
- **gcc** - カメラデーモンビルド用
- **go** - Go streaming serverビルド用（1.18以降推奨）
- **uv** - Python依存関係管理
- **hobot_dnn_rdkx5** - YOLO推論ライブラリ（RDK X5のみ）

### 確認コマンド

```bash
# 必須コマンドの確認
make --version
gcc --version
go version
uv --version
```

## 起動方法

### 1. 基本起動（全コンポーネント）

```bash
# プロジェクトルートから実行
./scripts/run_camera_switcher_yolo_streaming.sh
```

**起動されるコンポーネント：**
1. camera_switcher_daemon - カメラ切替＋H.264エンコード
2. yolo_detector_daemon - YOLO物体検出（YOLOv11n）
3. web_monitor - Flask UI（ポート8080）
4. streaming-server - Go WebRTC＋録画サーバー（ポート8081）

**自動実行される処理：**
- 全コンポーネントのビルド（C, Go, esbuild）
- 共有メモリの待機（`/dev/shm/pet_camera_active_frame`, `/dev/shm/pet_camera_stream`）
- プロセス起動とPID管理
- Ctrl+Cでのグレースフルシャットダウン

### 2. カスタム起動

#### ポート変更

```bash
# Flaskを8000、Streamingを8001に変更
MONITOR_PORT=8000 STREAMING_PORT=8001 ./scripts/run_camera_switcher_yolo_streaming.sh
```

#### Streaming無効（YOLOのみ）

```bash
# Go streaming serverを起動しない
./scripts/run_camera_switcher_yolo_streaming.sh --no-streaming
```

#### ビルドスキップ（高速再起動）

```bash
# 既存のbuild/を再利用
./scripts/run_camera_switcher_yolo_streaming.sh --skip-build
```

#### YOLOモデル変更

```bash
# YOLOv13n使用（高精度）
./scripts/run_camera_switcher_yolo_streaming.sh --yolo-model v13n

# スコア閾値調整
./scripts/run_camera_switcher_yolo_streaming.sh --score-thres 0.5
```

#### 最大クライアント数変更

```bash
# WebRTC同時接続10→20に変更
./scripts/run_camera_switcher_yolo_streaming.sh --max-clients 20
```

## アクセスエンドポイント

起動完了後、以下のエンドポイントにアクセス可能：

### Web UI

```
http://localhost:8080/
```

Flask UIでカメラ映像とバウンディングボックスを表示。

### WebRTC API

#### Offer/Answer交換

```bash
# WebRTC SDP offer送信
curl -X POST http://localhost:8081/offer \
  -H "Content-Type: application/json" \
  -d '{"type":"offer","sdp":"v=0..."}'
```

### 録画API

#### 録画開始

```bash
curl -X POST http://localhost:8081/start
```

レスポンス例：
```json
{
  "success": true,
  "status": {
    "recording": true,
    "filename": "recording_20251226_223031.h264",
    "frame_count": 0,
    "bytes_written": 0,
    "duration_ms": 0,
    "start_time": "2025-12-26T22:30:31Z"
  }
}
```

#### 録画停止

```bash
curl -X POST http://localhost:8081/stop
```

#### 録画状態確認

```bash
curl http://localhost:8081/status
```

レスポンス例：
```json
{
  "recording": true,
  "filename": "recording_20251226_223031.h264",
  "frame_count": 1500,
  "bytes_written": 2457600,
  "duration_ms": 50000,
  "start_time": "2025-12-26T22:30:31Z"
}
```

### ヘルスチェック

```bash
curl http://localhost:8081/health
```

レスポンス例：
```json
{
  "status": "ok",
  "webrtc_clients": 2,
  "recording": true,
  "has_headers": true
}
```

### 監視エンドポイント

#### Prometheusメトリクス

```
http://localhost:9090/metrics
```

**主要メトリクス：**
- `streaming_frames_read_total` - 読み取りフレーム数
- `streaming_active_clients` - アクティブクライアント数
- `streaming_recording_active` - 録画状態（0/1）
- `streaming_frame_latency_ms` - フレームレイテンシ（ms）

#### pprof プロファイリング

```
http://localhost:6060/debug/pprof/
```

**プロファイル取得例：**

```bash
# CPU プロファイル（30秒）
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# メモリプロファイル
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutineプロファイル
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

## 録画ファイル

### 保存先

デフォルト： `./recordings/`

環境変数で変更可能：
```bash
RECORDING_PATH=/path/to/recordings ./scripts/run_camera_switcher_yolo_streaming.sh
```

### ファイル形式

- **拡張子**: `.h264`
- **命名規則**: `recording_YYYYMMDD_HHMMSS.h264`
- **フォーマット**: H.264 Annex B形式（生ストリーム）

**例：**
```
recording_20251226_223031.h264
recording_20251226_224512.h264
```

### 再生方法

#### ffplayで再生

```bash
ffplay recordings/recording_20251226_223031.h264
```

#### MP4に変換

```bash
ffmpeg -i recordings/recording_20251226_223031.h264 \
       -c:v copy \
       output.mp4
```

#### 録画情報確認

```bash
ffprobe recordings/recording_20251226_223031.h264
```

## トラブルシューティング

### 共有メモリが見つからない

**エラー：**
```
[error] shared memory /dev/shm/pet_camera_active_frame not found after 10s
```

**原因：**
- camera_daemon_droboticsが起動に失敗
- libspcdevライブラリが見つからない
- カメラデバイスが接続されていない

**確認：**
```bash
# 共有メモリ確認
ls -la /dev/shm/pet_camera_*

# プロセス確認
ps aux | grep camera_daemon
```

### Go streaming serverが起動しない

**エラー：**
```
[error] failed to open shared memory: /pet_camera_stream
```

**原因：**
- カメラデーモンがH.264ストリームを共有メモリに書き込んでいない

**確認：**
```bash
# H.264ストリーム共有メモリ確認
ls -la /dev/shm/pet_camera_stream
```

### WebRTC接続できない

**確認項目：**
1. Streaming serverが起動しているか
2. ポート8081が開いているか
3. CORSエラーが出ていないか（Flask UIは8080から8081へアクセス）

**確認コマンド：**
```bash
# ヘルスチェック
curl http://localhost:8081/health

# ポート確認
netstat -tlnp | grep 8081
```

### 録画ファイルが再生できない

**原因：**
- SPS/PPS ヘッダーが欠落している
- IDRフレームから開始していない

**解決：**
- Go streaming serverはIDRフレーム検出時に自動でSPS/PPSを付与
- 録画開始後、最初のIDRフレームが来るまで待つ（最大2秒）

**検証：**
```bash
# ヘッダー確認
ffprobe recordings/recording_20251226_223031.h264 2>&1 | grep "Stream #"
```

正常な出力例：
```
Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 30 fps
```

## パフォーマンスモニタリング

### メトリクス監視

Prometheusメトリクスをcurlで定期的に取得：

```bash
# 1秒ごとにメトリクス取得
watch -n 1 'curl -s http://localhost:9090/metrics | grep streaming_active_clients'
```

### リソース使用量

```bash
# プロセスのメモリ/CPU確認
ps aux | grep -E "(streaming-server|camera_daemon|yolo_detector)"

# 詳細なリソース監視
top -p $(pgrep streaming-server)
```

### プロファイリング

```bash
# CPU使用率を30秒測定
go tool pprof -http=:8082 http://localhost:6060/debug/pprof/profile?seconds=30

# メモリアロケーション確認
go tool pprof -http=:8082 http://localhost:6060/debug/pprof/allocs
```

## スクリプトオプション一覧

| オプション | 説明 | デフォルト |
|----------|------|----------|
| `--skip-build` | ビルドをスキップ | なし |
| `--no-detector` | YOLO検出を無効化 | 有効 |
| `--no-monitor` | Flask UIを無効化 | 有効 |
| `--no-streaming` | Go streaming serverを無効化 | 有効 |
| `--monitor-port P` | Flask UIポート | 8080 |
| `--streaming-port P` | Streaming serverポート | 8081 |
| `--metrics-port P` | Prometheusポート | 9090 |
| `--pprof-port P` | pprofポート | 6060 |
| `--max-clients N` | 最大WebRTCクライアント数 | 10 |
| `--yolo-model M` | YOLOモデル（v8n/v11n/v13n） | v11n |
| `--score-thres T` | YOLO検出スコア閾値 | 0.6 |
| `--nms-thres T` | YOLO NMS閾値 | 0.7 |

## 環境変数一覧

| 変数名 | 説明 | デフォルト |
|-------|------|----------|
| `UV_BIN` | uvコマンドのパス | `uv` |
| `MONITOR_HOST` | Flask UIバインドホスト | `0.0.0.0` |
| `MONITOR_PORT` | Flask UIポート | `8080` |
| `STREAMING_HOST` | Streaming serverバインドホスト | `0.0.0.0` |
| `STREAMING_PORT` | Streaming serverポート | `8081` |
| `METRICS_PORT` | Prometheusポート | `9090` |
| `PPROF_PORT` | pprofポート | `6060` |
| `STREAMING_MAX_CLIENTS` | 最大WebRTCクライアント数 | `10` |
| `STREAMING_SHM` | 共有メモリ名 | `/pet_camera_stream` |
| `RECORDING_PATH` | 録画保存先 | `./recordings` |
| `YOLO_MODEL` | YOLOモデル | `v11n` |
| `YOLO_SCORE_THRESHOLD` | YOLO検出閾値 | `0.6` |
| `YOLO_NMS_THRESHOLD` | YOLO NMS閾値 | `0.7` |

## 次のステップ

1. **Flask UI統合**
   - `src/monitor/web_monitor.py`にプロキシエンドポイント追加
   - WebRTC接続UIの実装
   - 録画コントロールボタンの追加
   - 詳細は `docs/flask_go_integration_design.md` 参照

2. **パフォーマンス測定**
   - メモリ使用量の実測（目標 <20MB）
   - CPU使用率の実測（目標 <10%）
   - フレームレイテンシの測定（目標 <100ms）

3. **本番デプロイ**
   - systemdサービス化
   - 自動起動設定
   - ログローテーション
   - 監視アラート設定

## 関連ドキュメント

- `docs/go_streaming_server_design.md` - アーキテクチャ設計
- `docs/go_concurrency_design.md` - 並行処理設計
- `docs/flask_go_integration_design.md` - Flask統合設計
- `docs/go_poc_implementation_log.md` - 実装ログ
- `src/streaming_server/README.md` - API仕様
