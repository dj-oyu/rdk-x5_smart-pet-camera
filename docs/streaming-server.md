# Streaming Server 設計リファレンス

## 概要

PythonベースのWebRTC配信（aiortc）の制約（H.264デコード→再エンコード必須）を解決するため、**pion/webrtc**を使用したGo実装の単一バイナリストリーミングサーバー。H.264 passthroughによるゼロコピー配信、録画、Prometheusメトリクスを提供する。

### パフォーマンス目標

| メトリクス | Python版 | Go版目標 | 改善率 |
|-----------|---------|---------|-------|
| メモリ使用量 | ~110MB (2プロセス) | **<20MB (1バイナリ)** | 82%削減 |
| CPU使用率 | ~25% (デコード/再エンコード) | **<10% (passthrough)** | 60%削減 |
| デプロイサイズ | ~300MB (Python + 依存) | **<15MB (静的バイナリ)** | 95%削減 |
| 遅延 | ~200ms | **<100ms** | 50%改善 |

---

## アーキテクチャ

### システム全体図

```
┌──────────────────────────────────────────────────────────┐
│                   Camera Daemon (C)                       │
│  - D-Robotics libspcdev                                  │
│  - H.264 hardware encoding (30fps @ 8Mbps)               │
└───────────────────┬──────────────────────────────────────┘
                    │ H.264 NAL units
                    ▼
    /pet_camera_stream (POSIX shared memory)
                    │
                    ▼
┌──────────────────────────────────────────────────────────┐
│          Go Streaming Server (streaming-server)          │
├──────────────────────────────────────────────────────────┤
│  Shared Memory Reader (cgo)                              │
│    → H264 Stream Processor (NAL解析, SPS/PPSキャッシュ)  │
│      → WebRTC Server (pion/webrtc, Fan-Out)              │
│      → H264 Recorder (ファイル書き込み)                   │
│      → Prometheus Metrics                                │
│  HTTP API Server (net/http)                              │
└──────────────────────────────────────────────────────────┘
```

### データフロー

```
Camera Daemon → shm_frame_buffer_write()
  → /pet_camera_stream (POSIX SHM, ring buffer)
    → Go SHM Reader (cgo, mmap + atomic read)
      → H264 Processor (SPS/PPS検出・キャッシュ, IDRフレームにヘッダー付与)
        ├→ WebRTC Track (RTP/H.264 passthrough) → Browser
        └→ Recorder (.h264ファイル)
```

### プロジェクト構造

```
src/streaming_server/
├── cmd/server/main.go          # メインサーバー
├── internal/
│   ├── shm/reader.go           # cgo共有メモリアクセス
│   ├── h264/processor.go       # NALユニット処理
│   ├── webrtc/server.go        # WebRTCサーバー (pion)
│   ├── recorder/recorder.go    # H.264録画
│   └── metrics/metrics.go      # Prometheusメトリクス
├── pkg/types/frame.go          # 共通型定義
├── go.mod / go.sum
└── README.md
```

---

## 並行処理モデル

### 4+N Goroutine構成

```
     Reader (10ms polling)
         │
         ▼
     processChan (buffer: 30)
         │
         ▼
     Processor (NAL processing)
         │
         ├─────────────────┬─────────────────┐
         ▼                 ▼                 ▼
   webrtcChan      recorderChan      (metrics update)
    (buf: 30)         (buf: 60)
         │                 │
         ▼                 ▼
   WebRTC Dist.      Recorder Dist.
         │                 │
         └─> N clients     └─> File I/O
          (parallel)
```

| Goroutine | 数量 | 役割 |
|-----------|-----|------|
| Reader | 1 | 共有メモリポーリング（10ms間隔） |
| Processor | 1 | NAL解析、SPS/PPSキャッシュ、ヘッダー付与 |
| WebRTC Distributor | 1 | 全クライアントへフレームFan-Out配信 |
| Recorder Distributor | 1 | 録画有効時のみフレーム送信 |
| WebRTC Client Writer | N | クライアントごとの並列送信 |

### チャネルバッファサイズ

| チャネル | バッファサイズ | 理由 |
|---------|--------------|------|
| processChan | 30 | 1秒分 @ 30fps |
| webrtcChan | 30 | 1秒分 |
| recorderChan | 60 | 2秒分（ディスクI/O余裕） |
| clientChan | 30 | クライアント毎 |

### バックプレッシャー戦略

非ブロッキング送信 + フレームドロップ方式を採用。リアルタイム性を優先し、バッファが溢れた場合は古いフレームをドロップする。ドロップ数はメトリクスで監視可能。

```go
// ノンブロッキング送信パターン
select {
case ch <- frame:
    // 送信成功
default:
    // バッファ満杯 → フレームドロップ、メトリクス更新
}
```

### エラーハンドリング方針

| エラータイプ | 処理方法 |
|------------|---------|
| 一時的エラー（フレーム読み取り失敗等） | ログ + 続行 |
| 致命的エラー（共有メモリクローズ等） | エラーチャネル + サーバー停止 |
| Panic | defer recover + ログ + エラーチャネル |
| 連続エラー（10回連続読み取り失敗等） | 致命的エラーに昇格 |
| クライアントエラー（3回連続write失敗） | クライアント切断 |

### グレースフルシャットダウン

`context.WithCancel`による全goroutineの協調的終了。5秒のタイムアウト付き`WaitGroup.Wait()`で全goroutineの停止を保証。

---

## 主要コンポーネント

### Shared Memory Reader (`internal/shm/reader.go`)

cgoによるPOSIX共有メモリアクセス。`shared_memory.h`のFrame構造体との互換性。

```go
func NewReader(shmName string) (*Reader, error)
func (r *Reader) ReadLatest() (*types.H264Frame, error)
func (r *Reader) WaitForFrame(timeout time.Duration) (*types.H264Frame, error)
func (r *Reader) Close() error
```

- Zero-copy設計（memcpyは共有メモリ→Goヒープのみ）
- ポーリングベース（10msインターバル）
- H.264フォーマットのみフィルタリング

### H264 Processor (`internal/h264/processor.go`)

NALユニット解析とSPS/PPSキャッシング。

```go
func NewProcessor() *Processor
func (p *Processor) Process(frame *types.H264Frame) error
func (p *Processor) PrependHeaders(data []byte) ([]byte, error)
func (p *Processor) HasHeaders() bool
```

**NALユニットタイプ対応**:
- `NALTypeSPS (7)`: Sequence Parameter Set → キャッシュ
- `NALTypePPS (8)`: Picture Parameter Set → キャッシュ
- `NALTypeIDR (5)`: IDRフレーム → SPS+PPS自動付与

録画途中開始時のSPS/PPS欠落問題を解決（ffprobeの`non-existing PPS 0 referenced`エラー対策）。

### WebRTC Server (`internal/webrtc/server.go`)

pion/webrtc v3によるH.264 passthroughストリーミング。

```go
func NewServer(stunServers []string, maxClients int) *Server
func (s *Server) HandleOffer(offerJSON []byte) ([]byte, error)
func (s *Server) SendFrame(frame *types.H264Frame)
func (s *Server) GetClientCount() int
func (s *Server) Close() error
```

- H.264コーデック登録: `profile-level-id=42e01f`, ClockRate=90000
- マルチクライアント対応（Fan-Outパターン）
- ICE接続状態監視による自動クライアント削除
- デフォルト最大10クライアント（`-max-clients`で変更可能）
- RTCP処理（品質フィードバック）

### Recorder (`internal/recorder/recorder.go`)

H.264生ファイル録画。

```go
func NewRecorder(basePath string) *Recorder
func (r *Recorder) Start() error
func (r *Recorder) Stop() error
func (r *Recorder) SendFrame(frame *types.H264Frame) bool
func (r *Recorder) GetStatus() RecordingStatus
```

- ファイル命名規則: `recording_YYYYMMDD_HHMMSS.h264`
- 非ブロッキング録画（バッファ60フレーム = 2秒分）
- IDRフレーム検出時にSPS/PPSを自動付与

### Metrics (`internal/metrics/metrics.go`)

Prometheus形式メトリクス（30+ metrics）。atomic操作によるスレッドセーフな更新。

| メトリクス名 | 説明 |
|------------|------|
| `streaming_frames_read_total` | 共有メモリ読み取りフレーム数 |
| `streaming_frames_dropped_total` | ドロップフレーム数 |
| `streaming_webrtc_frames_sent_total` | WebRTC送信フレーム数 |
| `streaming_active_clients` | アクティブWebRTCクライアント数 |
| `streaming_recording_active` | 録画状態（0/1） |
| `streaming_frame_latency_ms` | フレームレイテンシ（ms） |
| `streaming_webrtc_buffer_usage_percent` | WebRTCバッファ使用率（%） |

---

## WebRTC設計

### Python版（aiortc）の制約と経緯

Phase 3でaiortcによるWebRTC実装を試みたが、以下の制約が判明:
- aiortcはVideoFrameベースのAPIのため、H.264 passthroughが困難
- `H.264 (SHM) → PyAV decode → VideoFrame → aiortc re-encode → WebRTC` という非効率なパス
- Flaskとasyncioの統合で`asyncio.new_event_loop()`が必要

これらの制約を解決するため、pion/webrtcによるGo実装に移行。

### Go版（pion/webrtc）の利点

- H.264 NAL unitsを直接RTPパケットとして送信（デコード不要）
- `TrackLocalStaticSample.WriteSample()`でH.264データを直接渡せる
- goroutineによる自然な並行処理

### ブラウザクライアント実装

```javascript
class WebRTCVideoClient {
    constructor(videoElement, signalingUrl = null) {
        this.signalingUrl = signalingUrl || window.location.origin;
    }

    async start() {
        this.pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        this.pc.ontrack = (event) => {
            this.videoElement.srcObject = event.streams[0];
        };
        const offer = await this.pc.createOffer({ offerToReceiveVideo: true });
        await this.pc.setLocalDescription(offer);

        const response = await fetch(`${this.signalingUrl}/api/webrtc/offer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: offer.sdp, type: offer.type })
        });
        const answer = await response.json();
        await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
}
```

---

## Flask + Go 統合アーキテクチャ

### 採用パターン: Flask API Proxy型

```
Browser ──HTTP──→ Flask (8080) ──proxy──→ Go Server (8081)
Browser ──WebRTC──────────────────────→ Go Server (8081)  ← 直接接続
Browser ←─SSE───── Flask (8080)          BBox情報
```

| 機能 | フロー |
|------|--------|
| UI表示 | Browser → Flask → HTML |
| WebRTC映像 | Browser → Go（直接接続、低遅延） |
| BBox描画 | Browser ← Flask ← SSE |
| 録画制御 | Browser → Flask → Go（proxy） |
| 状態取得 | Browser → Flask → Go（proxy） |

### Flask側プロキシ実装

```python
GO_SERVER_URL = os.getenv("GO_SERVER_URL", "http://localhost:8081")

def proxy_to_go(path, method="GET", data=None, timeout=5):
    url = f"{GO_SERVER_URL}{path}"
    if method == "GET":
        response = requests.get(url, timeout=timeout)
    elif method == "POST":
        response = requests.post(url, json=data, timeout=timeout)
    return jsonify(response.json()), response.status_code

@app.route("/api/recording/start", methods=["POST"])
def recording_start():
    return proxy_to_go("/start", method="POST", data=request.get_json() or {})

@app.route("/api/recording/stop", methods=["POST"])
def recording_stop():
    return proxy_to_go("/stop", method="POST")

@app.route("/api/recording/status", methods=["GET"])
def recording_status():
    return proxy_to_go("/status", method="GET", timeout=2)
```

---

## HTTP API エンドポイント

### Go Server (Port 8081)

| エンドポイント | メソッド | 説明 |
|--------------|---------|------|
| `/offer` | POST | WebRTC SDP offer/answer交換 |
| `/start` | POST | 録画開始 |
| `/stop` | POST | 録画停止 |
| `/status` | GET | 録画状態取得 |
| `/health` | GET | ヘルスチェック |

CORS設定: `Access-Control-Allow-Origin: http://localhost:8080`

### レスポンス例

**録画状態 (`GET /status`)**:
```json
{
  "recording": true,
  "filename": "recording_20251226_223031.h264",
  "frame_count": 1500,
  "bytes_written": 2457600,
  "duration_ms": 50000
}
```

**ヘルスチェック (`GET /health`)**:
```json
{
  "status": "ok",
  "webrtc_clients": 2,
  "recording": true,
  "has_headers": true
}
```

---

## ビルドと起動

### ビルド

```bash
cd src/streaming_server
go build -o ../../build/streaming-server ./cmd/server
```

### 実行

```bash
./build/streaming-server \
  -shm /pet_camera_stream \
  -http :8081 \
  -metrics :9090 \
  -pprof :6060 \
  -record-path ./recordings \
  -max-clients 10
```

### 一括起動スクリプト

```bash
./scripts/run_camera_switcher_yolo_streaming.sh
```

起動コンポーネント:
1. camera_switcher_daemon - カメラ切替＋H.264エンコード
2. yolo_detector_daemon - YOLO物体検出
3. web_monitor - Flask UI（ポート8080）
4. streaming-server - Go WebRTC＋録画サーバー（ポート8081）

### スクリプトオプション

| オプション | 説明 | デフォルト |
|----------|------|----------|
| `--skip-build` | ビルドをスキップ | なし |
| `--no-streaming` | Go streaming server無効化 | 有効 |
| `--streaming-port P` | Streaming serverポート | 8081 |
| `--metrics-port P` | Prometheusポート | 9090 |
| `--pprof-port P` | pprofポート | 6060 |
| `--max-clients N` | 最大WebRTCクライアント数 | 10 |

### 環境変数

| 変数名 | 説明 | デフォルト |
|-------|------|----------|
| `STREAMING_PORT` | Streaming serverポート | `8081` |
| `STREAMING_MAX_CLIENTS` | 最大WebRTCクライアント数 | `10` |
| `STREAMING_SHM` | 共有メモリ名 | `/pet_camera_stream` |
| `RECORDING_PATH` | 録画保存先 | `./recordings` |

---

## 監視・プロファイリング

### Prometheusメトリクス

```bash
curl http://localhost:9090/metrics
watch -n 1 'curl -s http://localhost:9090/metrics | grep streaming_active_clients'
```

### pprof

```bash
# CPU プロファイル（30秒）
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# メモリプロファイル
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutineプロファイル
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

---

## 録画ファイル

- **形式**: H.264 Annex B（`.h264`）
- **命名規則**: `recording_YYYYMMDD_HHMMSS.h264`
- **再生**: `ffplay recordings/recording_20251226_223031.h264`
- **MP4変換**: `ffmpeg -i recording.h264 -c:v copy output.mp4`

---

## 依存関係

```
module github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server

require (
    github.com/pion/webrtc/v3 v3.3.6
    github.com/prometheus/client_golang v1.23.2
)
```

**必須ツール**: `go` (1.18以降), `gcc` (cgo用), `make`
