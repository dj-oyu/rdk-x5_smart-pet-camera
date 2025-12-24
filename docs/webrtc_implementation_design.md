# WebRTC Implementation Design

## 目的

MJPEGストリーミングの課題（FPS低下、サーバー負荷）を解決し、H.264直接配信による30fps実現。

## 現状の問題

| 項目 | 現状（MJPEG） | 問題点 |
|------|--------------|--------|
| FPS | 7-8fps | 目標30fpsに対して大幅低下 |
| サーバー負荷 | 高い | NV12→BGR→JPEG変換が重い |
| 遅延 | 中程度 | 変換処理による遅延 |
| H.264活用 | なし | 生成済みだが未使用 |

## Phase 3 目標

| 項目 | 目標 | 期待効果 |
|------|------|---------|
| FPS | **30fps** | カメラネイティブレート |
| サーバー負荷 | **大幅削減** | 変換処理不要 |
| 遅延 | **低遅延** | H.264直接配信 |
| 品質 | **高品質** | ハードウェアエンコード |

## アーキテクチャ

### システム全体図

```
┌─────────────────────────────────────────────────────────────┐
│                    Camera Hardware                           │
│  imx219 (1920x1080) → D-Robotics ISP → VIO → Encoder       │
└────────────┬─────────────────────────────┬──────────────────┘
             │                             │
             ▼ NV12                        ▼ H.264
   /pet_camera_active_frame      /pet_camera_stream
             │                             │
             │                             │
    ┌────────▼────────┐          ┌────────▼─────────┐
    │ YOLO Detector   │          │ WebRTC Server    │
    │   (Python)      │          │  (aiortc)        │
    └────────┬────────┘          └────────┬─────────┘
             │                             │
             ▼ JSON                        ▼ RTP/H.264
   /pet_camera_detections         WebRTC Peer Connection
             │                             │
             │                             │
    ┌────────▼────────┐          ┌────────▼─────────┐
    │  SSE Endpoint   │          │ Browser WebRTC   │
    │  /api/detections│          │    Client        │
    │     /stream     │          │                  │
    └────────┬────────┘          └────────┬─────────┘
             │                             │
             │                             │
             └─────────────┬───────────────┘
                           │
                           ▼
                    Canvas BBox Overlay
                    (Browser Rendering)
```

### データフロー

#### 1. H.264ビデオストリーム
```
Camera Daemon (C)
  ↓ sp_encoder_get_stream()
H.264 NAL Units
  ↓ shm_frame_buffer_write()
Shared Memory (/pet_camera_stream)
  ↓ RealSharedMemory.get_latest_frame()
WebRTC Video Track (Python)
  ↓ MediaStreamTrack
WebRTC Peer Connection
  ↓ RTP over UDP/TCP
Browser WebRTC Client
  ↓ HTMLVideoElement
Canvas Rendering
```

#### 2. 検出結果ストリーム
```
YOLO Detector (Python)
  ↓ RealSharedMemory.write_detection_result()
Shared Memory (/pet_camera_detections)
  ↓ RealSharedMemory.read_detection()
SSE Generator (Flask)
  ↓ Server-Sent Events
Browser EventSource
  ↓ JavaScript
Canvas BBox Overlay
```

## 技術スタック

### サーバー側

**WebRTC実装**: `python-aiortc`
- WebRTC 1.0仕様準拠
- SDP negotiation
- ICE candidate handling
- RTP/RTCP実装

**H.264処理**: `PyAV (av)`
- H.264 NAL unit parsing
- Codec parameters extraction
- Frame timestamp management

**Webフレームワーク**: `Flask`
- シグナリングエンドポイント
- SSE配信（既存）
- 静的ファイル配信

### ブラウザ側

**WebRTC API**
- RTCPeerConnection
- RTCSessionDescription (SDP)
- ICE candidates

**Canvas API**
- 2D rendering context
- BBox描画
- 検出結果オーバーレイ

**EventSource API**
- SSE受信
- リアルタイム検出結果取得

## 実装計画

### 1. H.264ストリームリーダー (共有メモリ → WebRTC)

**ファイル**: `src/monitor/h264_track.py`

```python
from aiortc import MediaStreamTrack
from av import VideoFrame, CodecContext
import asyncio

class H264StreamTrack(MediaStreamTrack):
    """
    共有メモリからH.264ストリームを読み取り、WebRTCで配信
    """
    kind = "video"

    def __init__(self, shm: RealSharedMemory):
        super().__init__()
        self.shm = shm
        self.codec = CodecContext.create('h264', 'r')

    async def recv(self) -> VideoFrame:
        """
        次のビデオフレームを返す（WebRTCコールバック）
        """
        # 共有メモリからH.264フレーム取得
        # NAL unit parsing
        # VideoFrame生成
        # timestamp同期
```

**主要機能**:
- 共有メモリからH.264 NAL units取得
- WebRTC用VideoFrameに変換
- タイムスタンプ同期（30fps）
- キーフレーム検出

### 2. WebRTCシグナリングサーバー

**ファイル**: `src/monitor/webrtc_server.py`

```python
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiohttp import web

async def offer(request):
    """
    ブラウザからのSDP offerを受信し、answerを返す
    """
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()

    # H.264トラック追加
    h264_track = H264StreamTrack(shm)
    pc.addTrack(h264_track)

    # SDP negotiation
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.Response(
        content_type="application/json",
        text=json.dumps({
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        })
    )
```

**エンドポイント**:
- `POST /api/webrtc/offer` - SDP offer/answer exchange
- `POST /api/webrtc/ice` - ICE candidate exchange (optional)

### 3. Flaskとの統合

**ファイル**: `src/monitor/web_monitor.py` (既存を拡張)

```python
from aiohttp import web as aio_web
import asyncio

# Flask app (既存)
flask_app = Flask(__name__)

# aiohttp app (WebRTC用)
aio_app = aio_web.Application()
aio_app.router.add_post('/api/webrtc/offer', offer)

# 両方を同時実行
async def run_servers():
    # Flask on port 8080
    # aiohttp on port 8081 or same port with path-based routing
```

**統合方法**:
- Option A: 別ポート（Flask: 8080, aiohttp: 8081）
- Option B: Flask-AIOHTTPで統合（推奨）

### 4. ブラウザWebRTCクライアント

**ファイル**: `src/monitor/web_assets/webrtc_client.js`

```javascript
class WebRTCVideoPlayer {
    constructor(videoElement) {
        this.pc = new RTCPeerConnection({
            iceServers: [{urls: 'stun:stun.l.google.com:19302'}]
        });
        this.videoElement = videoElement;
    }

    async start() {
        // トラック受信時
        this.pc.ontrack = (event) => {
            this.videoElement.srcObject = event.streams[0];
        };

        // SDP offer作成
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);

        // サーバーにoffer送信
        const response = await fetch('/api/webrtc/offer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                sdp: offer.sdp,
                type: offer.type
            })
        });

        const answer = await response.json();
        await this.pc.setRemoteDescription(answer);
    }
}
```

### 5. Canvas BBox描画

**ファイル**: `src/monitor/web_assets/bbox_overlay.js`

```javascript
class BBoxOverlay {
    constructor(videoElement, canvasElement) {
        this.video = videoElement;
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d');
        this.detections = [];

        // SSE接続（既存エンドポイント活用）
        this.eventSource = new EventSource('/api/detections/stream');
        this.eventSource.onmessage = (event) => {
            this.detections = JSON.parse(event.data).detections || [];
        };

        // アニメーションループ
        this.render();
    }

    render() {
        // ビデオフレームをCanvasにコピー
        this.ctx.drawImage(this.video, 0, 0,
            this.canvas.width, this.canvas.height);

        // BBox描画
        this.detections.forEach(det => {
            this.drawBBox(det.bbox, det.class_name, det.confidence);
        });

        requestAnimationFrame(() => this.render());
    }

    drawBBox(bbox, className, confidence) {
        // BBox矩形
        this.ctx.strokeStyle = COLORS[className] || '#fff';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(bbox.x, bbox.y, bbox.w, bbox.h);

        // ラベル
        const label = `${className}: ${(confidence * 100).toFixed(0)}%`;
        // ... テキスト描画
    }
}
```

### 6. HTML統合

**ファイル**: `src/monitor/web_assets/index.html` (既存を拡張)

```html
<div class="video-container">
    <!-- MJPEGビュー（既存・fallback用） -->
    <img id="mjpeg-stream" src="/stream" style="display:none;">

    <!-- WebRTCビュー（新規・推奨） -->
    <div id="webrtc-view">
        <video id="webrtc-video" autoplay playsinline></video>
        <canvas id="bbox-canvas"></canvas>
    </div>

    <!-- 切り替えボタン -->
    <button id="toggle-stream">Switch to MJPEG</button>
</div>

<script type="module">
    import { WebRTCVideoPlayer } from './webrtc_client.js';
    import { BBoxOverlay } from './bbox_overlay.js';

    const video = document.getElementById('webrtc-video');
    const canvas = document.getElementById('bbox-canvas');

    const player = new WebRTCVideoPlayer(video);
    const overlay = new BBoxOverlay(video, canvas);

    await player.start();
</script>
```

## 技術的課題と対策

### 1. H.264 NAL Unit Parsing

**課題**:
- 共有メモリに格納されたH.264データのNAL unit構造を正しく解析
- SPS/PPS/IDR/非IDRフレームの識別

**対策**:
```python
def parse_h264_nals(data: bytes) -> List[bytes]:
    """
    H.264バイトストリームからNAL unitsを抽出
    Start code: 0x00 0x00 0x00 0x01
    """
    nals = []
    start = 0

    while True:
        # Find next start code
        idx = data.find(b'\x00\x00\x00\x01', start + 4)
        if idx == -1:
            nals.append(data[start:])
            break
        nals.append(data[start:idx])
        start = idx

    return nals
```

### 2. WebRTC Timestamp Synchronization

**課題**:
- カメラの30fpsとWebRTC timestampを同期
- タイムスタンプずれによる再生問題

**対策**:
```python
class H264StreamTrack(MediaStreamTrack):
    def __init__(self, shm, fps=30):
        super().__init__()
        self.shm = shm
        self.fps = fps
        self.frame_duration = 1.0 / fps
        self.start_time = None
        self.frame_count = 0

    async def recv(self):
        if self.start_time is None:
            self.start_time = time.time()

        # 次のフレームまで待機（フレームレート制御）
        target_time = self.start_time + (self.frame_count * self.frame_duration)
        now = time.time()
        if target_time > now:
            await asyncio.sleep(target_time - now)

        frame = self.shm.get_latest_frame()
        # ... VideoFrame生成

        self.frame_count += 1
        return video_frame
```

### 3. ブラウザH.264対応

**課題**:
- ブラウザによってH.264プロファイルサポートが異なる
- Baseline/Main/Highプロファイル

**対策**:
- D-Roboticsエンコーダー設定確認（現在の設定を使用）
- ブラウザ対応チェック（Chrome/Firefox/Safariで検証）
- 非対応時はMJPEGにフォールバック

### 4. ネットワーク遅延とバッファリング

**課題**:
- ネットワーク状況による遅延
- WebRTCバッファサイズ

**対策**:
```javascript
// 低遅延設定
const pc = new RTCPeerConnection({
    iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
});

// ビデオ再生設定
video.play();
video.playbackRate = 1.0;  // リアルタイム再生
```

## パフォーマンス目標

| メトリクス | 現状(MJPEG) | 目標(WebRTC) | 測定方法 |
|-----------|------------|-------------|---------|
| FPS | 7-8 | **30** | ブラウザDevTools |
| サーバーCPU | 90% | **<30%** | top/htop |
| 遅延 | 200-300ms | **<100ms** | タイムスタンプ比較 |
| 帯域幅 | 高 | 中 | H.264圧縮効率 |

## 実装ステップ

1. **Phase 3.1**: 依存関係追加 + H.264トラック実装
   - pyproject.toml更新
   - H264StreamTrack実装
   - 単体テスト

2. **Phase 3.2**: WebRTCシグナリングサーバー
   - offer/answerエンドポイント
   - Flask/aiohttp統合
   - 接続テスト

3. **Phase 3.3**: ブラウザクライアント
   - WebRTCクライアント実装
   - Canvas BBox描画
   - SSE統合

4. **Phase 3.4**: 統合テスト
   - 実機での30fps確認
   - 遅延測定
   - 負荷テスト

## 互換性とフォールバック

**MJPEG併存**:
- WebRTC非対応ブラウザ用にMJPEGを残す
- UIで切り替え可能に
- デフォルトはWebRTC

**段階的移行**:
1. WebRTCを追加実装（MJPEGと並行）
2. 動作確認後、WebRTCをデフォルトに
3. MJPEG削除は将来検討

## 参考資料

- [python-aiortc Documentation](https://aiortc.readthedocs.io/)
- [WebRTC API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [H.264 NAL Unit Structure](https://www.itu.int/rec/T-REC-H.264)
- [RTCPeerConnection API](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)

---

**Created**: 2025-12-24
**Status**: 設計完了 - 実装開始準備中
