# Go並行処理設計 - 詳細分析

**Version**: 1.0
**Date**: 2025-12-26
**Status**: 設計中

---

## 目次

1. [並行処理の全体像](#並行処理の全体像)
2. [並列化ポイントの分析](#並列化ポイントの分析)
3. [Goroutine設計パターン](#goroutine設計パターン)
4. [データフロー設計](#データフロー設計)
5. [同期と競合制御](#同期と競合制御)
6. [パフォーマンス分析](#パフォーマンス分析)
7. [エラーハンドリング](#エラーハンドリング)
8. [実装例](#実装例)

---

## 並行処理の全体像

### システムのボトルネック分析

```
[共有メモリ] → [読み取り] → [処理] → [配信/録画]
     ↑            ↑          ↑         ↑
   30fps      I/O wait    CPU処理   I/O wait
                (10%)      (20%)      (70%)
```

**ボトルネック**:
1. **配信/録画** (70%): 複数クライアント + ファイルI/O
2. **NAL unit処理** (20%): SPS/PPS検出、パース
3. **共有メモリ読み取り** (10%): mmap + atomic操作

### 並列化の目標

| 項目 | シングルスレッド | 並列化後 | 改善 |
|------|----------------|---------|------|
| WebRTC配信 (5クライアント) | 150ms/frame | **30ms/frame** | 5倍 |
| 録画 + WebRTC並行 | 180ms/frame | **35ms/frame** | 5倍 |
| CPU使用率 (4コア) | 25% (1コア) | **60% (分散)** | 効率化 |

---

## 並列化ポイントの分析

### 1. 共有メモリ読み取りループ

**特性**:
- I/O bound (10%)
- 30fps → 33ms/frame
- 単一producerで十分

**並列化**: ❌ **不要**
- リングバッファから読むのは1つのgoroutineで十分
- 複数のgoroutineで読むとフレーム順序が乱れる

```go
// ✅ 正しい設計: 単一のreader goroutine
func (s *Server) readLoop(ctx context.Context) {
    ticker := time.NewTicker(33 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            frame, err := s.shmReader.ReadFrame()
            if err != nil {
                continue
            }

            // チャネルで配信 (fan-out)
            s.frameChan <- frame
        }
    }
}
```

---

### 2. NAL Unit処理

**特性**:
- CPU bound (20%)
- フレームごとに独立処理可能
- SPS/PPSキャッシュは共有状態

**並列化**: ⚠️ **条件付き可能**
- SPS/PPSキャッシュに競合が発生
- 処理自体は軽量（~1ms）なので並列化のオーバーヘッドが大きい可能性

**推奨**: 単一goroutineで処理、Mutexで保護

```go
// ✅ 推奨: 単一processor、Mutexでキャッシュ保護
type H264Processor struct {
    mu       sync.RWMutex
    spsCache []byte
    ppsCache []byte
}

func (p *H264Processor) ProcessFrame(data []byte) ([]byte, error) {
    nalType := data[4] & 0x1F

    if nalType == NALTypeSPS {
        p.mu.Lock()
        p.spsCache = append([]byte{}, data...)
        p.mu.Unlock()
        return data, nil
    }

    if nalType == NALTypeIDR {
        p.mu.RLock()
        sps, pps := p.spsCache, p.ppsCache
        p.mu.RUnlock()

        return append(append(sps, pps...), data...), nil
    }

    return data, nil
}
```

---

### 3. WebRTC配信 (複数クライアント)

**特性**:
- I/O bound (最大50%)
- クライアントごとに独立
- **最も並列化効果が高い**

**並列化**: ✅ **必須**
- クライアントごとにgoroutine
- Fan-outパターン

```go
// ✅ 正しい設計: クライアントごとのgoroutine
type WebRTCServer struct {
    frameChan   chan *Frame
    clients     map[string]*Client
    clientsMu   sync.RWMutex
}

func (s *WebRTCServer) Start(ctx context.Context) {
    // 単一のfan-out goroutine
    go s.distributeFrames(ctx)
}

func (s *WebRTCServer) distributeFrames(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case frame := <-s.frameChan:
            // 全クライアントに並列配信
            s.clientsMu.RLock()
            for _, client := range s.clients {
                // 各クライアントは独立したgoroutineで処理
                go client.SendFrame(frame)
            }
            s.clientsMu.RUnlock()
        }
    }
}

type Client struct {
    track      *webrtc.TrackLocalStaticSample
    frameChan  chan *Frame  // バッファ付きチャネル
}

func (c *Client) SendFrame(frame *Frame) {
    // ノンブロッキング送信
    select {
    case c.frameChan <- frame:
    default:
        // バッファが溢れた場合はスキップ（古いフレームを捨てる）
    }
}

func (c *Client) writeLoop(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case frame := <-c.frameChan:
            c.track.WriteSample(media.Sample{
                Data:     frame.Data,
                Duration: 33 * time.Millisecond,
            })
        }
    }
}
```

---

### 4. H.264録画

**特性**:
- I/O bound (ディスク書き込み: ~5ms)
- WebRTCと並行実行可能
- ファイルI/Oは単一goroutineで十分

**並列化**: ✅ **独立したgoroutine**

```go
// ✅ 正しい設計: 独立したrecorder goroutine
type Recorder struct {
    frameChan chan *Frame
    file      *os.File
    recording atomic.Bool
}

func (r *Recorder) Start(ctx context.Context, frameChan <-chan *Frame) {
    go r.recordLoop(ctx, frameChan)
}

func (r *Recorder) recordLoop(ctx context.Context, frameChan <-chan *Frame) {
    for {
        select {
        case <-ctx.Done():
            return
        case frame := <-frameChan:
            if !r.recording.Load() {
                continue
            }

            r.file.Write(frame.Data)
        }
    }
}
```

---

### 5. HTTP APIリクエスト処理

**特性**:
- I/O bound
- リクエストごとに独立
- net/httpが自動的にgoroutineを生成

**並列化**: ✅ **net/httpに任せる**

```go
// ✅ net/httpが自動的に各リクエストをgoroutineで処理
http.HandleFunc("/api/webrtc/offer", s.handleOffer)
http.ListenAndServe(":8080", nil)
```

---

## Goroutine設計パターン

### パターン1: Fan-Out（最重要）

**用途**: 1つの入力を複数の消費者に配信

```
        ┌───────────────┐
        │ Frame Reader  │
        │  (1 goroutine)│
        └───────┬───────┘
                │
         frameChan (buffered)
                │
        ┌───────┴────────┐
        │                │
   ┌────▼────┐      ┌───▼─────┐
   │ WebRTC  │      │ Recorder│
   │Broadcast│      │(1 grtne)│
   │(1 grtne)│      └─────────┘
   └────┬────┘
        │
    ┌───┴────┐
    │        │
┌───▼───┐ ┌─▼────┐
│Client1│ │Client2│
│grtne  │ │grtne │
└───────┘ └──────┘
```

**実装**:
```go
type FrameDistributor struct {
    frameChan   chan *Frame
    subscribers []chan<- *Frame
    mu          sync.RWMutex
}

func (d *FrameDistributor) Subscribe() <-chan *Frame {
    ch := make(chan *Frame, 10) // バッファ付き

    d.mu.Lock()
    d.subscribers = append(d.subscribers, ch)
    d.mu.Unlock()

    return ch
}

func (d *FrameDistributor) Run(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case frame := <-d.frameChan:
            d.mu.RLock()
            for _, sub := range d.subscribers {
                // ノンブロッキング送信
                select {
                case sub <- frame:
                default:
                    // 遅い消費者はフレームスキップ
                }
            }
            d.mu.RUnlock()
        }
    }
}
```

---

### パターン2: Pipeline

**用途**: 段階的な処理

```
Read → Process → Distribute
 ↓       ↓         ↓
grtne   grtne    grtne
```

**実装**:
```go
type Pipeline struct {
    rawFrames       chan *Frame
    processedFrames chan *Frame
}

// Stage 1: Read
func (p *Pipeline) readStage(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
            frame, _ := readFromSharedMemory()
            p.rawFrames <- frame
        }
    }
}

// Stage 2: Process
func (p *Pipeline) processStage(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case frame := <-p.rawFrames:
            processed := processH264(frame)
            p.processedFrames <- processed
        }
    }
}

// Stage 3: Distribute
func (p *Pipeline) distributeStage(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case frame := <-p.processedFrames:
            distributeToClients(frame)
        }
    }
}
```

---

### パターン3: Worker Pool

**用途**: CPU集約的な処理の並列化

**注意**: このシステムでは**不要**
- NAL unit処理は軽量（~1ms）
- フレーム順序を維持する必要がある

```go
// ❌ このシステムでは不要（参考のみ）
type WorkerPool struct {
    jobs    chan *Frame
    results chan *Frame
    workers int
}

func (p *WorkerPool) Start(ctx context.Context) {
    for i := 0; i < p.workers; i++ {
        go p.worker(ctx)
    }
}

func (p *WorkerPool) worker(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case frame := <-p.jobs:
            processed := heavyProcessing(frame)
            p.results <- processed
        }
    }
}
```

---

## データフロー設計

### 推奨アーキテクチャ: Fan-Out with Buffered Channels

```
                    ┌─────────────────────┐
                    │ SharedMemoryReader  │
                    │   (1 goroutine)     │
                    └──────────┬──────────┘
                               │
                    rawFrameChan (cap=5)
                               │
                    ┌──────────▼──────────┐
                    │  H264Processor      │
                    │   (1 goroutine)     │
                    └──────────┬──────────┘
                               │
                processedFrameChan (cap=10)
                               │
                    ┌──────────▼──────────┐
                    │ FrameDistributor    │
                    │   (1 goroutine)     │
                    └───┬─────────────┬───┘
                        │             │
            webrtcChan  │             │  recorderChan
              (cap=10)  │             │    (cap=20)
                        │             │
          ┌─────────────▼──┐       ┌──▼──────────┐
          │ WebRTCBroadcast│       │  Recorder   │
          │  (1 goroutine) │       │(1 goroutine)│
          └─────┬──────────┘       └─────────────┘
                │
          ┌─────┴──────┐
          │            │
    client1Chan  client2Chan
      (cap=5)      (cap=5)
          │            │
    ┌─────▼────┐  ┌───▼──────┐
    │ Client1  │  │ Client2  │
    │goroutine │  │goroutine │
    └──────────┘  └──────────┘
```

### チャネルバッファサイズの根拠

| チャネル | バッファサイズ | 理由 |
|---------|--------------|------|
| rawFrameChan | 5 | 読み取り速度が速い、バックプレッシャー防止 |
| processedFrameChan | 10 | 処理済みフレームを一時保持 |
| webrtcChan | 10 | ネットワーク遅延を吸収 |
| recorderChan | 20 | ディスクI/O遅延を吸収 |
| clientChan | 5 | 遅いクライアントはスキップ |

---

## 同期と競合制御

### 1. 共有状態の最小化

**原則**: "Share Memory By Communicating, Don't Communicate By Sharing Memory"

```go
// ❌ 悪い例: 共有メモリ + Mutex
type BadServer struct {
    mu            sync.Mutex
    latestFrame   *Frame
    clients       []*Client
}

func (s *BadServer) UpdateFrame(frame *Frame) {
    s.mu.Lock()
    s.latestFrame = frame
    s.mu.Unlock()

    s.mu.Lock()
    for _, client := range s.clients {
        client.Send(s.latestFrame)
    }
    s.mu.Unlock()
}

// ✅ 良い例: チャネル通信
type GoodServer struct {
    frameChan chan *Frame
}

func (s *GoodServer) UpdateFrame(frame *Frame) {
    s.frameChan <- frame  // ノンブロッキング
}

func (s *GoodServer) Distribute(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return
        case frame := <-s.frameChan:
            // 配信処理
        }
    }
}
```

---

### 2. 必要な場合のMutex使用

**SPS/PPSキャッシュ**: 読み取り頻度が高いため `sync.RWMutex` を使用

```go
type H264Processor struct {
    mu       sync.RWMutex
    spsCache []byte
    ppsCache []byte
}

func (p *H264Processor) CacheSPS(sps []byte) {
    p.mu.Lock()
    p.spsCache = append([]byte{}, sps...)  // コピーを作成
    p.mu.Unlock()
}

func (p *H264Processor) GetHeaders() ([]byte, []byte) {
    p.mu.RLock()
    defer p.mu.RUnlock()

    return p.spsCache, p.ppsCache
}
```

---

### 3. Atomic操作

**録画状態フラグ**: 頻繁にチェックされるが競合は少ない

```go
type Recorder struct {
    recording atomic.Bool
}

func (r *Recorder) StartRecording() {
    r.recording.Store(true)
}

func (r *Recorder) IsRecording() bool {
    return r.recording.Load()
}
```

---

### 4. Context-based Cancellation

**全goroutineの協調的終了**

```go
type Server struct {
    ctx    context.Context
    cancel context.CancelFunc
}

func (s *Server) Start() {
    s.ctx, s.cancel = context.WithCancel(context.Background())

    // 各goroutineを起動
    go s.readLoop(s.ctx)
    go s.processLoop(s.ctx)
    go s.distributeLoop(s.ctx)
}

func (s *Server) Stop() {
    s.cancel()  // 全goroutineに終了シグナル
    // 各goroutineは ctx.Done() を検出して終了
}
```

---

## パフォーマンス分析

### ベンチマークシナリオ

#### シナリオ1: WebRTC配信のみ (5クライアント)

```
[共有メモリ] → [Reader] → [Processor] → [Distributor] → [5 Clients]
                  1ms        1ms           5ms             5×3ms
                                                         = 15ms (並列)

総レイテンシ: 1 + 1 + 5 + 3 = 10ms (30fps = 33ms で十分)
```

#### シナリオ2: WebRTC + 録画 (5クライアント)

```
                                      ┌→ [5 Clients]: 15ms (並列)
[共有メモリ] → [Reader] → [Processor] → [Distributor] ┤
                  1ms        1ms           5ms        └→ [Recorder]: 5ms

総レイテンシ: 1 + 1 + 5 + max(15, 5) = 22ms (30fps = 33ms で十分)
```

---

### CPU使用率の見積もり

**4コアCPUの場合**:

| Goroutine | CPU使用率 | コア |
|-----------|----------|-----|
| Reader | 5% | 0.05 |
| Processor | 10% | 0.1 |
| Distributor | 5% | 0.05 |
| WebRTC Client 1 | 10% | 0.1 |
| WebRTC Client 2 | 10% | 0.1 |
| WebRTC Client 3 | 10% | 0.1 |
| WebRTC Client 4 | 10% | 0.1 |
| WebRTC Client 5 | 10% | 0.1 |
| Recorder | 5% | 0.05 |
| **合計** | **75%** | **0.75コア** |

**結論**: 単一コアでも十分動作するが、4コアに分散されることで各コアの負荷は18.75%程度になる。

---

### メモリ使用量の見積もり

| 項目 | サイズ | 数量 | 合計 |
|------|-------|------|------|
| Goランタイム | 2MB | 1 | 2MB |
| チャネルバッファ | 50KB×フレーム数 | | |
| - rawFrameChan | 50KB | 5 | 250KB |
| - processedFrameChan | 50KB | 10 | 500KB |
| - webrtcChan | 50KB | 10 | 500KB |
| - recorderChan | 50KB | 20 | 1MB |
| - clientChan (×5) | 50KB | 5×5 | 1.25MB |
| Goroutineスタック | 2KB | 15 | 30KB |
| SPS/PPSキャッシュ | 1KB | 1 | 1KB |
| pion/webrtc | 5MB | 1 | 5MB |
| **合計** | | | **~10.5MB** |

**結論**: 目標の20MB以下を達成可能。

---

## エラーハンドリング

### 設計方針

**採用戦略**: 一時的エラーはログ + 続行、致命的エラーはエラーチャネル + 終了

エラーを2つのカテゴリに分類:
1. **一時的エラー**: フレーム読み取り失敗、一時的なネットワークエラーなど → ログ出力して処理続行
2. **致命的エラー**: 共有メモリクローズ、重大なシステムエラーなど → エラーチャネルで通知してサーバー停止

---

### 1. エラー分類

```go
package errors

import "errors"

var (
    // 一時的エラー（リトライ可能）
    ErrFrameNotReady     = errors.New("frame not ready")
    ErrBufferFull        = errors.New("buffer full")
    ErrClientSlow        = errors.New("client too slow")
    ErrDecodeError       = errors.New("H.264 decode error")

    // 致命的エラー（回復不可能）
    ErrSharedMemoryClosed = errors.New("shared memory closed")
    ErrInvalidState      = errors.New("invalid server state")
    ErrSystemFailure     = errors.New("system failure")
)

func IsTemporary(err error) bool {
    return errors.Is(err, ErrFrameNotReady) ||
           errors.Is(err, ErrBufferFull) ||
           errors.Is(err, ErrClientSlow) ||
           errors.Is(err, ErrDecodeError)
}

func IsFatal(err error) bool {
    return errors.Is(err, ErrSharedMemoryClosed) ||
           errors.Is(err, ErrInvalidState) ||
           errors.Is(err, ErrSystemFailure)
}
```

---

### 2. Goroutineごとのエラーハンドリング

#### Reader Goroutine

```go
func (s *Server) readLoop(ctx context.Context) {
    defer s.wg.Done()
    defer func() {
        if r := recover(); r != nil {
            s.errChan <- fmt.Errorf("reader panic: %v", r)
        }
    }()

    ticker := time.NewTicker(33 * time.Millisecond)
    defer ticker.Stop()

    consecutiveErrors := 0
    maxConsecutiveErrors := 10

    for {
        select {
        case <-ctx.Done():
            log.Println("[Reader] Stopping gracefully")
            return

        case <-ticker.C:
            frame, err := s.shmReader.ReadFrame()
            if err != nil {
                consecutiveErrors++
                s.metrics.ReadErrors.Add(1)

                if IsFatal(err) {
                    // 致命的エラー: サーバー停止
                    s.errChan <- fmt.Errorf("reader fatal error: %w", err)
                    return
                }

                if consecutiveErrors >= maxConsecutiveErrors {
                    // 連続エラーが多すぎる: 致命的と判断
                    s.errChan <- fmt.Errorf("reader: too many consecutive errors (%d)", consecutiveErrors)
                    return
                }

                // 一時的エラー: ログ出力して続行
                if consecutiveErrors%5 == 1 {  // 5回ごとにログ
                    log.Printf("[Reader] Temporary error: %v (count: %d)", err, consecutiveErrors)
                }
                continue
            }

            // 成功: エラーカウンターをリセット
            consecutiveErrors = 0

            // フレームを送信（ノンブロッキング）
            select {
            case s.rawFrameChan <- frame:
                s.metrics.FramesRead.Add(1)
            default:
                s.metrics.FramesDropped.Add(1)
            }
        }
    }
}
```

#### Processor Goroutine

```go
func (s *Server) processLoop(ctx context.Context) {
    defer s.wg.Done()
    defer func() {
        if r := recover(); r != nil {
            s.errChan <- fmt.Errorf("processor panic: %v", r)
        }
    }()

    for {
        select {
        case <-ctx.Done():
            log.Println("[Processor] Stopping gracefully")
            return

        case frame, ok := <-s.rawFrameChan:
            if !ok {
                // チャネルクローズ: 正常終了
                return
            }

            processedData, err := s.h264Processor.ProcessFrame(frame.Data)
            if err != nil {
                s.metrics.ProcessErrors.Add(1)

                if IsFatal(err) {
                    s.errChan <- fmt.Errorf("processor fatal error: %w", err)
                    return
                }

                // 一時的エラー: ログ出力してスキップ
                log.Printf("[Processor] Frame %d processing error: %v", frame.FrameNumber, err)
                continue
            }

            processedFrame := &Frame{
                FrameNumber: frame.FrameNumber,
                Data:        processedData,
            }

            s.metrics.FramesProcessed.Add(1)

            // 配信（ノンブロッキング）
            select {
            case s.webrtcChan <- processedFrame:
                s.metrics.WebRTCFramesSent.Add(1)
            default:
                s.metrics.WebRTCFramesDropped.Add(1)
            }

            select {
            case s.recorderChan <- processedFrame:
                s.metrics.RecorderFramesSent.Add(1)
            default:
                s.metrics.RecorderFramesDropped.Add(1)
            }
        }
    }
}
```

#### WebRTC Client Writer Goroutine

```go
func (s *Server) clientWriteLoop(client *WebRTCClient) {
    defer s.wg.Done()
    defer func() {
        if r := recover(); r != nil {
            log.Printf("[WebRTC Client %s] Panic recovered: %v", client.id, r)
        }
    }()

    writeErrors := 0
    maxWriteErrors := 3

    for {
        select {
        case <-s.ctx.Done():
            log.Printf("[WebRTC Client %s] Stopping gracefully", client.id)
            return

        case frame, ok := <-client.frameChan:
            if !ok {
                // チャネルクローズ: クライアント削除済み
                return
            }

            if err := client.track.WriteSample(media.Sample{
                Data:     frame.Data,
                Duration: 33 * time.Millisecond,
            }); err != nil {
                writeErrors++
                client.metrics.SendErrors.Add(1)

                if writeErrors >= maxWriteErrors {
                    // クライアント切断と判断
                    log.Printf("[WebRTC Client %s] Too many write errors, disconnecting", client.id)
                    s.RemoveWebRTCClient(client.id)
                    return
                }

                log.Printf("[WebRTC Client %s] Write error: %v (count: %d)", client.id, err, writeErrors)
                continue
            }

            // 成功: エラーカウンターをリセット
            writeErrors = 0
            client.metrics.FramesSent.Add(1)
        }
    }
}
```

---

### 3. エラーチャネルによる集中管理

```go
type Server struct {
    errChan chan error  // バッファ付き（デッドロック防止）
}

func NewServer(shmName string) (*Server, error) {
    return &Server{
        errChan: make(chan error, 10),  // 10個のエラーをバッファ
        // ...
    }, nil
}

func (s *Server) Start() error {
    log.Println("Starting server...")

    // 全goroutineを起動
    s.wg.Add(4)
    go s.readLoop(s.ctx)
    go s.processLoop(s.ctx)
    go s.distributeWebRTC(s.ctx)
    go s.recordLoop(s.ctx)

    // エラー監視goroutine
    go s.monitorErrors()

    return nil
}

func (s *Server) monitorErrors() {
    for err := range s.errChan {
        log.Printf("[ERROR] Fatal error received: %v", err)

        // 致命的エラー発生: サーバーを停止
        s.Stop()

        // アラート送信（将来的に実装）
        // s.sendAlert(err)
    }
}

func (s *Server) Stop() {
    log.Println("Stopping server...")

    // 全goroutineに停止シグナル
    s.cancel()

    // 全goroutineの終了を待つ
    done := make(chan struct{})
    go func() {
        s.wg.Wait()
        close(done)
    }()

    // タイムアウト付き待機
    select {
    case <-done:
        log.Println("All goroutines stopped gracefully")
    case <-time.After(5 * time.Second):
        log.Println("WARNING: Some goroutines did not stop within timeout")
    }

    // エラーチャネルをクローズ
    close(s.errChan)

    log.Println("Server stopped")
}
```

---

### 4. Panicからの回復

**設計方針**: 各goroutineでdeferによるpanicキャッチを実装

```go
func (s *Server) safeGoroutine(name string, fn func()) {
    s.wg.Add(1)
    go func() {
        defer s.wg.Done()
        defer func() {
            if r := recover(); r != nil {
                // Stackトレースを取得
                buf := make([]byte, 4096)
                n := runtime.Stack(buf, false)

                log.Printf("[%s] PANIC: %v", name, r)
                log.Printf("[%s] Stack trace:\n%s", name, buf[:n])

                // エラーチャネルに送信
                s.errChan <- fmt.Errorf("%s panic: %v", name, r)
            }
        }()

        fn()
    }()
}

// 使用例
func (s *Server) Start() error {
    s.safeGoroutine("Reader", func() {
        s.readLoop(s.ctx)
    })

    s.safeGoroutine("Processor", func() {
        s.processLoop(s.ctx)
    })

    return nil
}
```

---

### 5. Goroutineリーク検出

```go
type Server struct {
    activeGoroutines atomic.Int32
}

func (s *Server) safeGoroutine(name string, fn func()) {
    s.activeGoroutines.Add(1)
    s.wg.Add(1)

    go func() {
        defer s.activeGoroutines.Add(-1)
        defer s.wg.Done()
        defer func() {
            if r := recover(); r != nil {
                log.Printf("[%s] Panic: %v", name, r)
                s.errChan <- fmt.Errorf("%s panic: %v", name, r)
            }
        }()

        log.Printf("[%s] Started (total active: %d)", name, s.activeGoroutines.Load())
        fn()
        log.Printf("[%s] Stopped (total active: %d)", name, s.activeGoroutines.Load())
    }()
}

func (s *Server) Stop() {
    log.Println("Stopping server...")
    s.cancel()
    s.wg.Wait()

    // Goroutineリークチェック
    activeCount := s.activeGoroutines.Load()
    if activeCount != 0 {
        log.Printf("WARNING: Goroutine leak detected! %d goroutines still active", activeCount)

        // デバッグ用: 全goroutineのスタックトレースをダンプ
        buf := make([]byte, 65536)
        n := runtime.Stack(buf, true)
        log.Printf("All goroutines stack trace:\n%s", buf[:n])
    } else {
        log.Println("All goroutines stopped cleanly")
    }

    close(s.errChan)
    log.Println("Server stopped")
}
```

---

### 6. エラーレート監視

```go
func (s *Server) monitorErrorRates(ctx context.Context) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    var lastReadErrors uint64
    var lastProcessErrors uint64
    var lastSendErrors uint64

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            readErrors := s.metrics.ReadErrors.Load()
            processErrors := s.metrics.ProcessErrors.Load()
            sendErrors := s.metrics.SendErrors.Load()

            readErrorRate := float64(readErrors-lastReadErrors) / 10.0  // errors/sec
            processErrorRate := float64(processErrors-lastProcessErrors) / 10.0
            sendErrorRate := float64(sendErrors-lastSendErrors) / 10.0

            if readErrorRate > 1.0 {  // 1 error/sec 以上
                log.Printf("WARNING: High read error rate: %.2f errors/sec", readErrorRate)
            }

            if processErrorRate > 1.0 {
                log.Printf("WARNING: High process error rate: %.2f errors/sec", processErrorRate)
            }

            if sendErrorRate > 5.0 {
                log.Printf("WARNING: High send error rate: %.2f errors/sec", sendErrorRate)
            }

            lastReadErrors = readErrors
            lastProcessErrors = processErrors
            lastSendErrors = sendErrors
        }
    }
}

// Serverの起動時に追加
func (s *Server) Start() error {
    // ... 他のgoroutine起動

    // エラーレート監視
    s.wg.Add(1)
    go func() {
        defer s.wg.Done()
        s.monitorErrorRates(s.ctx)
    }()

    return nil
}
```

---

### エラーハンドリングのまとめ

| エラータイプ | 処理方法 | 例 |
|------------|---------|---|
| **一時的エラー** | ログ + 続行 | フレーム読み取り失敗、デコードエラー |
| **致命的エラー** | エラーチャネル + 停止 | 共有メモリクローズ、システム障害 |
| **Panic** | defer recover + ログ + エラーチャネル | nil pointer、範囲外アクセス |
| **連続エラー** | カウンター監視 → 致命的エラーに昇格 | 10回連続の読み取り失敗 |
| **クライアントエラー** | クライアント切断 | WebRTC write失敗3回連続 |

---

## 実装例

### 完全なServer構造

```go
package main

import (
    "context"
    "log"
    "sync"
    "sync/atomic"
    "time"
)

type Server struct {
    // Context for lifecycle management
    ctx    context.Context
    cancel context.CancelFunc
    wg     sync.WaitGroup

    // Shared memory reader
    shmReader *SharedMemoryReader

    // H.264 processor
    h264Processor *H264Processor

    // Channels for data flow
    rawFrameChan       chan *Frame
    processedFrameChan chan *Frame

    // WebRTC
    webrtcChan    chan *Frame
    webrtcClients map[string]*WebRTCClient
    clientsMu     sync.RWMutex

    // Recorder
    recorderChan chan *Frame
    recorder     *Recorder

    // Metrics
    frameCount atomic.Uint64
    errorCount atomic.Uint64
}

func NewServer(shmName string) (*Server, error) {
    shmReader, err := NewSharedMemoryReader(shmName)
    if err != nil {
        return nil, err
    }

    ctx, cancel := context.WithCancel(context.Background())

    return &Server{
        ctx:                ctx,
        cancel:             cancel,
        shmReader:          shmReader,
        h264Processor:      NewH264Processor(),
        rawFrameChan:       make(chan *Frame, 5),
        processedFrameChan: make(chan *Frame, 10),
        webrtcChan:         make(chan *Frame, 10),
        recorderChan:       make(chan *Frame, 20),
        webrtcClients:      make(map[string]*WebRTCClient),
    }, nil
}

func (s *Server) Start() {
    log.Println("Starting server with parallel goroutines...")

    // Goroutine 1: Read from shared memory
    s.wg.Add(1)
    go s.readLoop()

    // Goroutine 2: Process H.264 frames
    s.wg.Add(1)
    go s.processLoop()

    // Goroutine 3: Distribute to WebRTC
    s.wg.Add(1)
    go s.distributeWebRTC()

    // Goroutine 4: Record to file
    s.wg.Add(1)
    go s.recordLoop()

    log.Println("All goroutines started")
}

func (s *Server) Stop() {
    log.Println("Stopping server...")
    s.cancel()
    s.wg.Wait()
    s.shmReader.Close()
    log.Println("Server stopped")
}

// Goroutine 1: Read raw frames
func (s *Server) readLoop() {
    defer s.wg.Done()
    defer close(s.rawFrameChan)

    ticker := time.NewTicker(33 * time.Millisecond)
    defer ticker.Stop()

    log.Println("[Reader] Started")

    for {
        select {
        case <-s.ctx.Done():
            log.Println("[Reader] Stopping")
            return
        case <-ticker.C:
            frame, err := s.shmReader.ReadFrame()
            if err != nil {
                s.errorCount.Add(1)
                continue
            }

            select {
            case s.rawFrameChan <- frame:
                s.frameCount.Add(1)
            default:
                // Drop frame if channel is full
                log.Println("[Reader] Dropped frame (buffer full)")
            }
        }
    }
}

// Goroutine 2: Process H.264 (SPS/PPS handling)
func (s *Server) processLoop() {
    defer s.wg.Done()
    defer close(s.processedFrameChan)

    log.Println("[Processor] Started")

    for {
        select {
        case <-s.ctx.Done():
            log.Println("[Processor] Stopping")
            return
        case frame, ok := <-s.rawFrameChan:
            if !ok {
                return
            }

            processedData, err := s.h264Processor.ProcessFrame(frame.Data)
            if err != nil {
                s.errorCount.Add(1)
                continue
            }

            processedFrame := &Frame{
                FrameNumber: frame.FrameNumber,
                Timestamp:   frame.Timestamp,
                Data:        processedData,
                Width:       frame.Width,
                Height:      frame.Height,
            }

            // Fan-out to WebRTC and Recorder
            select {
            case s.webrtcChan <- processedFrame:
            default:
                log.Println("[Processor] WebRTC channel full")
            }

            select {
            case s.recorderChan <- processedFrame:
            default:
                log.Println("[Processor] Recorder channel full")
            }
        }
    }
}

// Goroutine 3: Distribute to WebRTC clients
func (s *Server) distributeWebRTC() {
    defer s.wg.Done()

    log.Println("[WebRTC Distributor] Started")

    for {
        select {
        case <-s.ctx.Done():
            log.Println("[WebRTC Distributor] Stopping")
            return
        case frame, ok := <-s.webrtcChan:
            if !ok {
                return
            }

            // Get all clients
            s.clientsMu.RLock()
            clients := make([]*WebRTCClient, 0, len(s.webrtcClients))
            for _, client := range s.webrtcClients {
                clients = append(clients, client)
            }
            s.clientsMu.RUnlock()

            // Send to each client in parallel
            for _, client := range clients {
                // Each client has its own goroutine
                go func(c *WebRTCClient) {
                    select {
                    case c.frameChan <- frame:
                    default:
                        // Client is slow, skip this frame
                    }
                }(client)
            }
        }
    }
}

// Goroutine 4: Record to file
func (s *Server) recordLoop() {
    defer s.wg.Done()

    log.Println("[Recorder] Started")

    for {
        select {
        case <-s.ctx.Done():
            log.Println("[Recorder] Stopping")
            return
        case frame, ok := <-s.recorderChan:
            if !ok {
                return
            }

            if s.recorder != nil && s.recorder.IsRecording() {
                if err := s.recorder.WriteFrame(frame); err != nil {
                    log.Printf("[Recorder] Write error: %v", err)
                    s.errorCount.Add(1)
                }
            }
        }
    }
}

// AddWebRTCClient adds a new WebRTC client (creates its own goroutine)
func (s *Server) AddWebRTCClient(id string, track *webrtc.TrackLocalStaticSample) {
    client := &WebRTCClient{
        id:        id,
        track:     track,
        frameChan: make(chan *Frame, 5),
    }

    s.clientsMu.Lock()
    s.webrtcClients[id] = client
    s.clientsMu.Unlock()

    // Start client's write loop in its own goroutine
    s.wg.Add(1)
    go s.clientWriteLoop(client)

    log.Printf("[WebRTC] Added client %s", id)
}

// Goroutine per client: Write frames to WebRTC track
func (s *Server) clientWriteLoop(client *WebRTCClient) {
    defer s.wg.Done()

    log.Printf("[WebRTC Client %s] Started", client.id)

    for {
        select {
        case <-s.ctx.Done():
            log.Printf("[WebRTC Client %s] Stopping", client.id)
            return
        case frame, ok := <-client.frameChan:
            if !ok {
                return
            }

            if err := client.track.WriteSample(media.Sample{
                Data:     frame.Data,
                Duration: 33 * time.Millisecond,
            }); err != nil {
                log.Printf("[WebRTC Client %s] Write error: %v", client.id, err)
                // Client disconnected, remove it
                s.RemoveWebRTCClient(client.id)
                return
            }
        }
    }
}

func (s *Server) RemoveWebRTCClient(id string) {
    s.clientsMu.Lock()
    if client, ok := s.webrtcClients[id]; ok {
        close(client.frameChan)
        delete(s.webrtcClients, id)
    }
    s.clientsMu.Unlock()

    log.Printf("[WebRTC] Removed client %s", id)
}

type WebRTCClient struct {
    id        string
    track     *webrtc.TrackLocalStaticSample
    frameChan chan *Frame
}
```

---

## まとめ

### Goroutine構成

| Goroutine | 数量 | 役割 | 並列化効果 |
|-----------|-----|------|----------|
| Reader | 1 | 共有メモリ読み取り | ❌ (単一で十分) |
| Processor | 1 | NAL unit処理 | ⚠️ (軽量なので不要) |
| WebRTC Distributor | 1 | フレーム配信 | ✅ (fan-out) |
| WebRTC Client Writer | N | クライアントごと | ✅✅ (最大効果) |
| Recorder | 1 | ファイル書き込み | ✅ (並行実行) |

**合計**: 4 + N goroutines（N = クライアント数）

### 並列化の利点

1. **スループット向上**: 5クライアント並列配信で5倍
2. **レイテンシ削減**: 遅いクライアントが他に影響しない
3. **CPU効率化**: 4コアに分散
4. **拡張性**: クライアント数に応じて自動スケール

### 注意点

1. チャネルバッファサイズは適切に設定（メモリ vs レイテンシ）
2. 遅いクライアントはフレームスキップ（バッファ溢れ対策）
3. Context-based cancelで協調的終了
4. Panic recoveryで個別のgoroutine障害を隔離

---

**Next**: この設計に基づいてPoC実装を開始しますか？
