# WebRTC Phase 3 Implementation Log

**Date**: 2025-12-26
**Branch**: h264stream
**Status**: Implementation Complete - Connection Debugging

---

## 概要

Phase 3では、H.264ストリームをWebRTC経由で配信し、30fps実現とサーバー負荷削減を目指す。
Phase 1 & 2で実装したH.264ハードウェアエンコードとカメラスイッチャーを基盤に、WebRTC配信機能を実装。

### 目標

| 項目 | 現状（Phase 2） | 目標（Phase 3） |
|------|----------------|----------------|
| FPS | 7-8fps (MJPEG) | **30fps** (WebRTC H.264) |
| サーバーCPU | NV12→BGR→JPEG変換で高負荷 | **大幅削減** (変換不要) |
| 遅延 | MJPEG変換による遅延 | **低遅延** (H.264直接配信) |
| 品質 | JPEG圧縮劣化 | **高品質** (H.264 HW encode) |

---

## 実装完了タスク ✅

### 1. 依存関係追加

**ファイル**: `pyproject.toml`

```toml
dependencies = [
    "aiortc>=1.9.0",   # WebRTC 1.0仕様準拠ライブラリ
    "av>=12.0.0",      # H.264デコード/エンコードライブラリ
    # ... 既存の依存関係
]
```

**インストール確認**:
```bash
uv sync
uv run python3 -c "from aiortc import RTCPeerConnection; print('aiortc OK')"
```

---

### 2. H264StreamTrack実装

**ファイル**: `src/monitor/h264_track.py` (新規作成, 223行)

**主要機能**:
- aiortc `MediaStreamTrack` 実装
- 共有メモリ `/pet_camera_stream` からH.264 NAL units読み取り
- WebRTC用 `VideoFrame` 生成
- 30fps タイムスタンプ同期
- H.264デコード（PyAV使用）
- エラーハンドリング（黒フレームフォールバック）

**重要ポイント**:
```python
class H264StreamTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, shm: Optional[RealSharedMemory] = None, fps: int = 30):
        # 共有メモリからH.264ストリーム読み取り
        if shm is None:
            self.shm = RealSharedMemory(frame_shm_name=SHM_NAME_STREAM)
            self.shm.open()

        self.fps = fps
        self.frame_duration = 1.0 / fps
        self.codec = av.CodecContext.create('h264', 'r')

    async def recv(self) -> VideoFrame:
        # フレームレート制御
        target_time = self.start_time + (self.frame_count * self.frame_duration)
        await asyncio.sleep(max(0, target_time - time.time()))

        # H.264フレーム読み取り
        frame = self.shm.read_latest_frame()

        # H.264デコード → VideoFrame
        packet = av.Packet(bytes(frame.data))
        frames = self.codec.decode(packet)

        # タイムスタンプ設定
        video_frame.pts = self.frame_count
        video_frame.time_base = VIDEO_TIME_BASE
        return video_frame
```

**課題**:
- 現在はデコード→再エンコードしている（非効率）
- 理想はH.264 passthroughだが、aiortcの制約で難しい

---

### 3. WebRTCシグナリングサーバー実装

**ファイル**: `src/monitor/webrtc_server.py` (新規作成, 132行)

**主要機能**:
- SDP offer/answer 交換
- RTCPeerConnection 管理
- MediaRelay（複数クライアント対応）
- ICE candidate 処理
- 接続状態監視

**重要ポイント**:
```python
async def handle_offer(offer_data: dict) -> dict:
    # 1. RTCPeerConnection作成
    pc = RTCPeerConnection()

    # 2. 接続状態ハンドラー設定
    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        print(f"Connection state: {pc.connectionState}")

    # 3. Remote description設定（クライアントのoffer）
    offer = RTCSessionDescription(sdp=offer_data["sdp"], type=offer_data["type"])
    await pc.setRemoteDescription(offer)

    # 4. H.264トラック追加（remote description設定後）
    h264_track = H264StreamTrack()
    pc.addTrack(relay.subscribe(h264_track))

    # 5. Answer作成
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    # 6. Answerを返す
    return {
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    }
```

**重要**: トラック追加は `setRemoteDescription()` の**後**に行う必要がある。先に追加すると `ValueError: None is not in list` エラーが発生。

---

### 4. Flask統合

**ファイル**: `src/monitor/web_monitor.py` (修正)

**変更内容**:
- WebRTCエンドポイント追加: `POST /api/webrtc/offer`
- asyncio event loop統合（Flask routeは同期関数）
- 既存SSEエンドポイント活用: `/api/detections/stream`

**実装**:
```python
@app.route("/api/webrtc/offer", methods=["POST"])
def webrtc_offer():
    from webrtc_server import handle_offer

    data = request.get_json()

    # asyncio event loopで実行
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        answer = loop.run_until_complete(handle_offer(data))
    finally:
        loop.close()

    return jsonify(answer)
```

**課題**: Flaskの制約でasync routeが使えない。`asyncio.run_until_complete()` で対応。

---

### 5. ブラウザ WebRTC クライアント

**ファイル**: `src/monitor/web_assets/webrtc_client.js` (既存を修正, 169行)

**主要機能**:
- RTCPeerConnection管理
- SDP offer生成・answer受信
- ICE candidate処理
- 接続状態監視
- 自動origin検出（同一ポート）

**重要ポイント**:
```javascript
class WebRTCVideoClient {
    constructor(videoElement, signalingUrl = null) {
        // 同一originをデフォルトで使用
        this.signalingUrl = signalingUrl || window.location.origin;
    }

    async start() {
        // RTCPeerConnection作成
        this.pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // トラック受信ハンドラー
        this.pc.ontrack = (event) => {
            this.videoElement.srcObject = event.streams[0];
        };

        // Offer作成
        const offer = await this.pc.createOffer({
            offerToReceiveVideo: true,
            offerToReceiveAudio: false
        });
        await this.pc.setLocalDescription(offer);

        // サーバーにOffer送信
        const response = await fetch(`${this.signalingUrl}/api/webrtc/offer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sdp: offer.sdp, type: offer.type })
        });

        const answer = await response.json();

        // Answer設定
        await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
}
```

**修正点**:
- `signalingUrl` のハードコード (`http://localhost:8081`) を削除
- デフォルトで `window.location.origin` を使用（同一ポート）

---

### 6. Canvas BBox オーバーレイ

**ファイル**: `src/monitor/web_assets/bbox_overlay.js` (既存を修正, 232行)

**主要機能**:
- SSE経由で検出結果受信 (`/api/detections/stream`)
- Canvas上にBBox描画
- ビデオサイズ自動調整
- リアルタイムレンダリング（requestAnimationFrame）
- 複数データフォーマット対応

**修正点**:
```javascript
// 複数フォーマット対応
this.eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // 直接detections配列
    if (data.detections) {
        this.detections = data.detections;
    }
    // latest_detectionでラップされている場合
    else if (data.latest_detection && data.latest_detection.detections) {
        this.detections = data.latest_detection.detections;
    }
};
```

---

### 7. HTML UI統合

**ファイル**: `src/monitor/web_monitor.py` (既存HTMLテンプレートを修正)

**変更内容**:
- WebRTC/MJPEG切り替えボタン
- WebRTC接続状態表示
- 自動WebRTC起動
- MJPEGフォールバック

**修正点**:
```javascript
// ハードコードされたURLを削除
// Before: webrtcClient = new WebRTCVideoClient(video, 'http://localhost:8081');
// After:  webrtcClient = new WebRTCVideoClient(video);  // 自動origin検出
```

---

## アーキテクチャ全体図

```
┌──────────────────┐
│ Camera Daemon    │
│ (D-Robotics)     │
└────────┬─────────┘
         │ H.264 (30fps)
         ▼
/pet_camera_stream (shared memory)
         │
         │ read
         ▼
┌──────────────────┐
│ H264StreamTrack  │ ← aiortc MediaStreamTrack
│  - H.264 decode  │
│  - VideoFrame    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ WebRTC Server    │
│  - RTCPeerConn   │
│  - SDP exchange  │
└────────┬─────────┘
         │ RTP/H.264
         ▼
  (Internet / LAN)
         │
         ▼
┌──────────────────┐
│ Browser WebRTC   │
│  - RTCPeerConn   │
│  - <video>       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│ <canvas> BBox    │ ←── │ SSE (/api/detect │
│  Overlay         │     │  ions/stream)    │
└──────────────────┘     └──────────────────┘
```

---

## 既知の問題 🐛

### Issue #1: WebRTC接続が確立しない

**症状**:
- ブラウザで "Connecting..." のまま停止
- `POST /api/webrtc/offer` は200 OKを返す
- ビデオが表示されない

**確認済み**:
- ✅ H.264ストリームは共有メモリに存在（`/pet_camera_stream`）
  ```
  Format: 3 (H.264)
  Frame number: 24
  Size: 963 bytes
  Resolution: 640x480
  ```
- ✅ aiortc/avライブラリはインストール済み
- ✅ Flaskエンドポイント `/api/webrtc/offer` にリクエストが届いている
- ✅ サーバー側でanswerを返している（200 OK）

**デバッグログ追加済み**:
```python
# web_monitor.py
print("[WebRTC] Received offer request")
print(f"[WebRTC] Processing offer: type={data['type']}, sdp_length={len(data['sdp'])}")
print(f"[WebRTC] Answer created successfully")

# webrtc_server.py
print(f"[WebRTC Server] Received offer: type=..., sdp_length=...")
print(f"[WebRTC Server] Created peer connection {pc_id}")
print(f"[WebRTC Server] Remote description set for {pc_id}")
print(f"[WebRTC Server] Creating H264StreamTrack...")
print(f"[WebRTC Server] Video track added to {pc_id}")
print(f"[WebRTC Server] Connection state: {pc.connectionState}")
print(f"[WebRTC Server] ICE connection state: {pc.iceConnectionState}")

# h264_track.py
print(f"[H264Track] Initialized (fps={fps}, shm={self.shm.frame_shm_name})")
```

**期待されるログ**:
```
[WebRTC] Received offer request
[WebRTC] Processing offer: type=offer, sdp_length=...
[WebRTC Server] Received offer: type=offer, sdp_length=...
[WebRTC Server] Created peer connection ...
[WebRTC Server] Remote description set for ...
[WebRTC Server] Creating H264StreamTrack...
[H264Track] Initialized (fps=30, shm=/pet_camera_stream)
[WebRTC Server] Adding video track to peer connection...
[WebRTC Server] Video track added to ...
[WebRTC Server] Creating answer...
[WebRTC Server] Answer created for ...
[WebRTC Server] Local description set for ...
[WebRTC] Answer created successfully
```

**次のデバッグステップ**:
1. サーバー側でこれらのログが出るか確認
2. ブラウザのコンソールで `[WebRTC]` ログを確認
3. Network タブで `/api/webrtc/offer` のレスポンスを確認
4. WebRTC接続状態（`connectionState`, `iceConnectionState`）を確認

**参考コード（動作確認用テストページ）**:
```html
<!-- /tmp/test_webrtc.html -->
<video id="video" autoplay playsinline></video>
<script>
async function startWebRTC() {
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.ontrack = (event) => {
        document.getElementById('video').srcObject = event.streams[0];
    };

    const offer = await pc.createOffer({ offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);

    const response = await fetch('/api/webrtc/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: offer.sdp, type: offer.type })
    });

    const answer = await response.json();
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
}
startWebRTC();
</script>
```

---

## 技術的課題と対策

### 1. aiortcのトラック追加順序

**課題**: トラックを先に追加すると `ValueError: None is not in list` エラー

**原因**: aiortcの内部実装で、`setRemoteDescription()` 前にトラックを追加すると、directionの計算でエラーが発生

**対策**:
```python
# ❌ 誤った順序
pc.addTrack(h264_track)
await pc.setRemoteDescription(offer)

# ✅ 正しい順序
await pc.setRemoteDescription(offer)
pc.addTrack(h264_track)
```

---

### 2. Flaskとasyncioの統合

**課題**: FlaskのrouteでAsync/Awaitが使えない

**対策**: `asyncio.new_event_loop()` で新しいループを作成
```python
@app.route("/api/webrtc/offer", methods=["POST"])
def webrtc_offer():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        answer = loop.run_until_complete(handle_offer(data))
    finally:
        loop.close()
    return jsonify(answer)
```

**将来の改善案**: Flask 2.0+ の `async def` 対応、またはQuart（async Flask互換）への移行検討

---

### 3. H.264 Passthrough vs Decode

**現状**: H.264をデコード→VideoFrame→再エンコード（非効率）

**理想**: H.264 NAL unitsを直接RTPでストリーミング

**課題**: aiortcはVideoFrameベースのAPIで、生のH.264パケットを扱うのが困難

**参考資料**:
- [aiortc Issue #123](https://github.com/aiortc/aiortc/issues/123) - H.264 passthrough discussion
- aiortc `RTCRtpSender` のカスタマイズが必要

**将来の改善案**: aiortc拡張、またはGStreamer WebRTC実装への移行検討

---

## 参考資料

### 公式ドキュメント
- [python-aiortc Documentation](https://aiortc.readthedocs.io/)
- [PyAV Documentation](https://pyav.org/)
- [WebRTC API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [RTCPeerConnection API](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)

### サンプルコード
- [aiortc examples](https://github.com/aiortc/aiortc/tree/main/examples)
  - `server.py` - WebRTCサーバー実装の参考
  - `webcam.py` - MediaStreamTraックの参考
- [WebRTC samples](https://webrtc.github.io/samples/)
  - `RTCPeerConnection` の基本的な使い方

### 関連Issue
- [aiortc #456](https://github.com/aiortc/aiortc/issues/456) - H.264 encoding issues
- [aiortc #234](https://github.com/aiortc/aiortc/issues/234) - Flask integration

---

## パフォーマンス目標

| メトリクス | Phase 2 (MJPEG) | Phase 3 目標 (WebRTC) | 測定方法 |
|-----------|----------------|---------------------|---------|
| FPS | 7-8 | **30** | ブラウザDevTools |
| サーバーCPU | NV12→JPEG変換で高負荷 | **<30%** | top/htop |
| 遅延 | 200-300ms | **<100ms** | タイムスタンプ比較 |
| 帯域幅 | MJPEG高 | H.264圧縮で中 | ネットワークモニター |

---

## 次のステップ

### 即座に対応が必要

1. **WebRTC接続デバッグ** (Priority: HIGH)
   - サーバー側ログの確認
   - ブラウザコンソールログの確認
   - ICE候補の確認
   - STUN/TURNサーバーの確認

2. **接続確立後の動作確認** (Priority: HIGH)
   - 30fps達成確認
   - BBox描画確認
   - 遅延測定
   - 複数クライアント接続確認

### Phase 3 完了に向けて

3. **パフォーマンステスト** (Priority: MEDIUM)
   - CPU使用率測定
   - メモリ使用量測定
   - 長時間動作テスト（1時間以上）

4. **フォールバック動作確認** (Priority: MEDIUM)
   - WebRTC失敗時のMJPEG切り替え
   - 非対応ブラウザでのMJPEG表示

### Phase 4 (将来的)

5. **H.264 Passthrough実装** (Priority: LOW)
   - aiortc拡張またはGStreamer WebRTC
   - デコード/再エンコードの削減
   - さらなるCPU負荷削減

6. **複数解像度対応** (Priority: LOW)
   - Adaptive bitrate streaming
   - クライアント帯域に応じた解像度切り替え

---

## 変更ファイル一覧

### 新規作成

| ファイル | 行数 | 説明 |
|---------|------|------|
| `src/monitor/h264_track.py` | 223 | H.264 MediaStreamTrack実装 |
| `src/monitor/webrtc_server.py` | 132 | WebRTCシグナリングサーバー |

### 修正

| ファイル | 変更内容 |
|---------|---------|
| `pyproject.toml` | aiortc, av依存関係追加 |
| `src/monitor/web_monitor.py` | WebRTCエンドポイント追加、HTMLテンプレート修正 |
| `src/monitor/main.py` | WebRTC依存関係チェック修正 |
| `src/monitor/web_assets/webrtc_client.js` | signalingUrl自動検出 |
| `src/monitor/web_assets/bbox_overlay.js` | 複数データフォーマット対応 |

---

## コミット履歴（推奨）

Phase 3完了時のコミットメッセージ案：

```
Implement Phase 3: WebRTC H.264 streaming

- Add aiortc and av dependencies for WebRTC support
- Implement H264StreamTrack for shared memory → WebRTC pipeline
- Add WebRTC signaling server with SDP offer/answer exchange
- Integrate WebRTC endpoint into Flask app (/api/webrtc/offer)
- Update browser client for WebRTC connection
- Add Canvas BBox overlay with SSE integration
- Fix track addition order (after setRemoteDescription)
- Add comprehensive debug logging

Known issue: WebRTC connection establishment debugging in progress

Related: Phase 1 (H.264 encode), Phase 2 (camera switcher)

🤖 Generated with Claude Code
Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

---

**Last Updated**: 2025-12-26
**Author**: Claude Sonnet 4.5
**Status**: Implementation Complete - Connection Debugging
**Related Documents**:
- [webrtc_implementation_design.md](./webrtc_implementation_design.md) - 設計書
- [h264_implementation_log.md](./h264_implementation_log.md) - Phase 1 & 2ログ
- [camera_switcher_h264_migration.md](./camera_switcher_h264_migration.md) - カメラスイッチャー移行
