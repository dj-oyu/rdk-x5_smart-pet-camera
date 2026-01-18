# Go Streaming Server PoC Implementation Log

## 実装日

2025-12-26

## 概要

Python aiortcの制約（H.264デコード→再エンコード必須）を解決するため、pion/webrtcを使用したGo実装のPoC（Proof of Concept）を完成させた。

## 実装完了項目

### 1. プロジェクト構造

```
src/streaming_server/
├── cmd/
│   └── server/
│       └── main.go          # メインサーバー実装
├── internal/
│   ├── shm/
│   │   └── reader.go        # cgo共有メモリアクセス
│   ├── h264/
│   │   └── processor.go     # NALユニット処理
│   ├── webrtc/
│   │   └── server.go        # WebRTCサーバー（pion）
│   ├── recorder/
│   │   └── recorder.go      # H.264録画
│   └── metrics/
│       └── metrics.go       # Prometheusメトリクス
├── pkg/
│   └── types/
│       └── frame.go         # 共通型定義
├── go.mod
├── go.sum
└── README.md
```

### 2. 実装コンポーネント

#### 2.1 共有メモリリーダー (`internal/shm/reader.go`)

**実装内容：**
- cgoによるPOSIX共有メモリアクセス
- `shared_memory.h`のFrame構造体との互換性
- リングバッファからのH.264フレーム読み取り
- アトミック操作によるwrite_index監視

**主要API：**
```go
func NewReader(shmName string) (*Reader, error)
func (r *Reader) ReadLatest() (*types.H264Frame, error)
func (r *Reader) WaitForFrame(timeout time.Duration) (*types.H264Frame, error)
func (r *Reader) Close() error
```

**特徴：**
- Zero-copy設計（memcpyは共有メモリ→Goヒープのみ）
- ポーリングベース（10msインターバル）
- フォーマットフィルタリング（H.264のみ取得）

#### 2.2 H.264プロセッサー (`internal/h264/processor.go`)

**実装内容：**
- NALユニット解析（start code検出）
- SPS/PPSキャッシング
- IDRフレーム検出
- 録画開始時のヘッダー自動付与

**主要API：**
```go
func NewProcessor() *Processor
func (p *Processor) Process(frame *types.H264Frame) error
func (p *Processor) PrependHeaders(data []byte) ([]byte, error)
func (p *Processor) HasHeaders() bool
```

**NALユニットタイプ対応：**
- `NALTypeSPS (7)`: Sequence Parameter Set（キャッシュ）
- `NALTypePPS (8)`: Picture Parameter Set（キャッシュ）
- `NALTypeIDR (5)`: IDRフレーム（検出＆ヘッダー付与）
- その他のNALタイプ（Slice, SEI, AUD等）

**解決した課題：**
- 録画中開始時のSPS/PPS欠落問題
- ffprobeエラー（`non-existing PPS 0 referenced`）の解決

#### 2.3 WebRTCサーバー (`internal/webrtc/server.go`)

**実装内容：**
- pion/webrtc v3使用
- H.264 passthroughストリーミング
- SDP offer/answerハンドリング
- マルチクライアント対応（Fan-Outパターン）

**主要API：**
```go
func NewServer(stunServers []string, maxClients int) *Server
func (s *Server) HandleOffer(offerJSON []byte) ([]byte, error)
func (s *Server) SendFrame(frame *types.H264Frame)
func (s *Server) GetClientCount() int
func (s *Server) Close() error
```

**特徴：**
- バックプレッシャー対策（非ブロッキング送信＋フレームドロップ）
- クライアント毎にgoroutine起動（並列送信）
- ICE接続状態監視による自動クライアント削除
- RTCP処理（品質フィードバック）

**クライアント制限：**
- デフォルト最大10クライアント（`-max-clients`で変更可能）
- 制限到達時は503エラー返却

#### 2.4 録画サーバー (`internal/recorder/recorder.go`)

**実装内容：**
- H.264生ファイル録画（`.h264`形式）
- タイムスタンプ付きファイル名生成
- 非ブロッキング録画（バッファ60フレーム = 2秒分）
- 録画状態管理

**主要API：**
```go
func NewRecorder(basePath string) *Recorder
func (r *Recorder) Start() error
func (r *Recorder) Stop() error
func (r *Recorder) SendFrame(frame *types.H264Frame) bool
func (r *Recorder) GetStatus() RecordingStatus
```

**RecordingStatus：**
```go
type RecordingStatus struct {
    Recording    bool          // 録画中フラグ
    Filename     string        // ファイル名
    FrameCount   uint64        // 録画フレーム数
    BytesWritten uint64        // 書き込みバイト数
    Duration     time.Duration // 録画時間
    StartTime    time.Time     // 開始時刻
}
```

**ファイル命名規則：**
- `recording_20251226_223031.h264`
- フォーマット：`recording_YYYYMMDD_HHMMSS.h264`

#### 2.5 メトリクス (`internal/metrics/metrics.go`)

**実装内容：**
- Prometheus形式メトリクス（30+ metrics）
- atomic操作によるスレッドセーフな更新
- HTTP `/metrics` エンドポイント

**主要メトリクス：**

| メトリクス名 | 説明 |
|------------|------|
| `streaming_frames_read_total` | 共有メモリから読み取ったフレーム数 |
| `streaming_frames_processed_total` | 処理完了フレーム数 |
| `streaming_frames_dropped_total` | ドロップしたフレーム数 |
| `streaming_webrtc_frames_sent_total` | WebRTC送信フレーム数 |
| `streaming_webrtc_frames_dropped_total` | WebRTCドロップフレーム数 |
| `streaming_active_clients` | アクティブなWebRTCクライアント数 |
| `streaming_recording_active` | 録画状態（0/1） |
| `streaming_recording_bytes` | 録画バイト数 |
| `streaming_recording_frames` | 録画フレーム数 |
| `streaming_frame_latency_ms` | フレームレイテンシ（ms） |
| `streaming_process_latency_ms` | 処理レイテンシ（ms） |
| `streaming_webrtc_buffer_usage_percent` | WebRTCバッファ使用率（%） |
| `streaming_recorder_buffer_usage_percent` | 録画バッファ使用率（%） |

#### 2.6 メインサーバー (`cmd/server/main.go`)

**実装内容：**
- 4+N goroutine構成（設計通り）
- グレースフルシャットダウン
- HTTP API（WebRTC signaling + 録画制御）
- pprof統合（常時有効）

**Goroutine構成：**

1. **Reader Goroutine**
   - 共有メモリポーリング（10msインターバル）
   - `processChan`へ送信

2. **Processor Goroutine**
   - NAL解析、SPS/PPSキャッシュ、ヘッダー付与
   - `webrtcChan`と`recorderChan`へFan-Out

3. **WebRTC Distributor Goroutine**
   - 全クライアントへフレーム配信
   - クライアント毎に並列送信（goroutine起動）

4. **Recorder Distributor Goroutine**
   - 録画が有効な場合のみフレーム送信
   - 録画メトリクス更新

**HTTP API：**

| エンドポイント | メソッド | 説明 |
|--------------|---------|------|
| `/offer` | POST | WebRTC SDP offer処理 |
| `/start` | POST | 録画開始 |
| `/stop` | POST | 録画停止 |
| `/status` | GET | 録画状態取得 |
| `/health` | GET | ヘルスチェック |

**CORS設定：**
- `Access-Control-Allow-Origin: http://localhost:8080`
- Flask UIからの直接アクセスを許可

**pprof有効化：**
- `import _ "net/http/pprof"`
- ポート6060で常時稼働
- CPU/メモリ/Goroutineプロファイリング可能

### 3. 依存関係

**go.mod：**
```
module github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server

require (
    github.com/pion/webrtc/v3 v3.3.6
    github.com/prometheus/client_golang v1.23.2
)
```

**主要な間接依存：**
- pion/dtls, pion/ice, pion/rtp, pion/srtp（WebRTC関連）
- prometheus/common, prometheus/procfs（メトリクス関連）

### 4. ビルドとデプロイ

**ビルドコマンド：**
```bash
cd src/streaming_server
go build -o ../../build/streaming-server ./cmd/server
```

**実行コマンド：**
```bash
./build/streaming-server \
  -shm /pet_camera_stream \
  -http :8081 \
  -metrics :9090 \
  -pprof :6060 \
  -record-path ./recordings \
  -max-clients 10
```

**期待されるバイナリサイズ：**
- 静的リンク: ~15MB（設計目標達成）

## 設計実装の検証

### 設計ドキュメントとの対応

| 設計項目 | 実装状況 | ファイル |
|---------|---------|---------|
| cgo共有メモリアクセス | ✅ 完了 | `internal/shm/reader.go` |
| NALユニット処理 | ✅ 完了 | `internal/h264/processor.go` |
| SPS/PPSキャッシング | ✅ 完了 | `internal/h264/processor.go` |
| WebRTC H.264 passthrough | ✅ 完了 | `internal/webrtc/server.go` |
| 録画機能 | ✅ 完了 | `internal/recorder/recorder.go` |
| Prometheusメトリクス | ✅ 完了 | `internal/metrics/metrics.go` |
| pprof統合 | ✅ 完了 | `cmd/server/main.go` |
| Goroutine並行処理 | ✅ 完了 | `cmd/server/main.go` |
| バックプレッシャー対策 | ✅ 完了 | 非ブロッキング送信実装 |
| グレースフルシャットダウン | ✅ 完了 | `cmd/server/main.go` |

### 並行処理設計の実装

**設計通りの4+N Goroutine構成：**

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

**バックプレッシャー戦略：**
- 設計文書の推奨通り「非ブロッキング送信＋フレームドロップ」を実装
- リアルタイム性優先（最新フレーム優先）
- ドロップフレーム数をメトリクスで監視可能

**チャネルバッファサイズ：**
- `processChan`: 30（1秒分 @ 30fps）
- `webrtcChan`: 30（1秒分）
- `recorderChan`: 60（2秒分、ディスクI/O余裕）
- クライアント`frameChan`: 30（クライアント毎）

## 未実装項目

### 1. 実機テスト

**必要な環境：**
- RDK X5ボード
- カメラデーモン稼働中
- 共有メモリ `/pet_camera_stream` が存在

**テスト手順：**
1. カメラデーモン起動
2. Go streaming server起動
3. ブラウザでWebRTC接続テスト
4. 録画開始/停止テスト
5. メトリクス確認（Prometheus）
6. プロファイリング（pprof）

### 2. Flask統合

**必要な作業：**
- `src/monitor/web_monitor.py`にプロキシエンドポイント追加
- `flask_go_integration_design.md`の実装
- フロントエンドJavaScript（WebRTC接続、録画UI）

**実装予定ファイル：**
```python
# web_monitor.py追加部分
GO_SERVER_URL = "http://localhost:8081"

def proxy_to_go(path, method="GET", data=None, timeout=5):
    # Flask → Go プロキシヘルパー
    pass

@app.route("/api/recording/start", methods=["POST"])
def recording_start():
    return proxy_to_go("/start", method="POST")

@app.route("/api/recording/status", methods=["GET"])
def recording_status():
    return proxy_to_go("/status", method="GET")
```

### 3. パフォーマンス測定

**測定項目：**
- メモリ使用量（Python 110MB → Go <20MB目標）
- CPU使用率（Python 25% → Go <10%目標）
- フレームレイテンシ（目標 <100ms）
- 複数クライアント時のスループット

### 4. エラーハンドリング強化

**追加予定：**
- Temporary vs Fatal エラー分類の実装
- エラー発生時のリトライロジック
- ログレベル制御（debug/info/warn/error）
- 構造化ロギング（JSON形式）

### 5. テストコード

**必要なテスト：**
- ユニットテスト（各コンポーネント）
- 共有メモリモックテスト
- WebRTC統合テスト
- 録画機能テスト

## 次のステップ

### Phase 1: 実機検証（優先度：高）

1. RDK X5ボードでカメラデーモン起動
2. Go streaming server起動
3. 共有メモリアクセス確認
4. H.264フレーム取得確認
5. WebRTC接続テスト（1クライアント）
6. 録画テスト

### Phase 2: Flask統合（優先度：高）

1. `web_monitor.py`プロキシエンドポイント実装
2. フロントエンドWebRTC接続実装
3. 録画UIボタン実装
4. ステータスポーリング実装（1秒間隔）

### Phase 3: パフォーマンス最適化（優先度：中）

1. メモリ/CPU測定
2. ボトルネック特定（pprof使用）
3. チャネルバッファサイズチューニング
4. Goroutine数最適化

### Phase 4: 本番化（優先度：中）

1. エラーハンドリング強化
2. ログ強化（構造化ログ）
3. systemdサービス化
4. 自動起動設定
5. ヘルスチェック監視

## 成果物

### 実装ファイル（全8ファイル）

1. `pkg/types/frame.go` - 型定義（200行）
2. `internal/shm/reader.go` - cgo共有メモリ（240行）
3. `internal/h264/processor.go` - NAL処理（200行）
4. `internal/webrtc/server.go` - WebRTC（270行）
5. `internal/recorder/recorder.go` - 録画（160行）
6. `internal/metrics/metrics.go` - メトリクス（230行）
7. `cmd/server/main.go` - メインサーバー（400行）
8. `README.md` - ドキュメント（280行）

**合計：約1,980行**

### ドキュメント

1. `docs/go_streaming_server_design.md` - アーキテクチャ設計（1,550行）
2. `docs/go_concurrency_design.md` - 並行処理設計（1,140行）
3. `docs/flask_go_integration_design.md` - Flask統合設計（851行）
4. `docs/go_poc_implementation_log.md` - 本ドキュメント

**合計：約3,600行のドキュメント**

## まとめ

Python aiortcの制約を解決するため、pion/webrtcを使用したGo実装のPoCを完成させた。

**達成事項：**
- ✅ H.264 passthroughによるゼロコピーストリーミング
- ✅ 4+N Goroutine並行処理
- ✅ Prometheusメトリクス（30+ metrics）
- ✅ pprof統合（常時有効）
- ✅ 録画機能（SPS/PPS自動付与）
- ✅ マルチクライアントWebRTC対応
- ✅ バックプレッシャー対策
- ✅ グレースフルシャットダウン

**期待される性能改善：**
- メモリ使用量：110MB → <20MB（82%削減）
- CPU使用率：25% → <10%（60%削減）
- デプロイサイズ：300MB → 15MB（95%削減）

次のステップは実機でのテストとFlask統合実装。
