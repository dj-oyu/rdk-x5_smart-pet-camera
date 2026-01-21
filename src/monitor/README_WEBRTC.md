# WebRTC H.264 Streaming - Implementation Guide

## 概要

Phase 3の実装として、WebRTCを使ったH.264直接配信機能を追加しました。
これにより、MJPEG方式の課題（FPS低下、サーバー負荷）を解決し、30fps配信を実現します。

## 実装状況

### ✅ 完了した実装

1. **WebRTC H.264 Video Track** (`h264_track.py`)
   - 共有メモリ(/pet_camera_stream)からH.264ストリーム読み取り
   - WebRTC MediaStreamTrackとして配信
   - 30fpsタイムスタンプ同期

2. **WebRTC Signaling Server** (`webrtc_server.py`)
   - aiohttpベースのシグナリングサーバー
   - SDP offer/answer exchange
   - ICE candidate handling
   - CORS対応

3. **Browser WebRTC Client** (`web_assets/webrtc_client.js`)
   - RTCPeerConnection管理
   - SDP negotiation
   - ビデオトラック受信・再生

4. **Canvas BBox Overlay** (`web_assets/bbox_overlay.js`)
   - Server-Sent Eventsで検出結果受信
   - Canvas上にBBox描画
   - リアルタイム更新

### ⏳ 次のステップ

- HTML統合（既存UIへのWebRTCビュー追加）
- 実機テスト（30fps確認）
- パフォーマンス測定
- MJPEG/WebRTC切り替えUI

## アーキテクチャ

```
Camera → H.264 Encoder → Shared Memory (/pet_camera_stream)
                              ↓
                         WebRTC Server (port 8081)
                              ↓ WebRTC/RTP
                         Browser Client
                              ↓
                         HTMLVideoElement → Canvas BBox Overlay
                                                    ↑
                                          SSE Detections
```

## 使い方

### 1. 依存関係のインストール

```bash
cd src/monitor
uv sync
```

新しい依存関係:
- `aiortc>=1.9.0` - WebRTC実装
- `aiohttp>=3.9.0` - 非同期HTTPサーバー
- `av>=12.0.0` - PyAV (H.264処理)

### 2. WebRTCサーバーの起動（開発中・スタンドアロン）

```bash
cd src/monitor
uv run python webrtc_server.py
```

サーバーは`http://0.0.0.0:8081`で起動します。

### 3. 統合起動（将来の実装）

```bash
./scripts/run_camera_switcher_yolo.sh
```

このスクリプトを更新して、FlaskとWebRTCサーバーを並行起動する予定。

### 4. ブラウザからの接続

```javascript
import { WebRTCVideoClient } from './webrtc_client.js';
import { BBoxOverlay } from './bbox_overlay.js';

const video = document.getElementById('webrtc-video');
const canvas = document.getElementById('bbox-canvas');

// WebRTC接続
const client = new WebRTCVideoClient(video, 'http://localhost:8081');
await client.start();

// BBoxオーバーレイ (Protobuf format by default)
const overlay = new BBoxOverlay(video, canvas);
overlay.start();
```

## ファイル構成

```
src/monitor/
├── h264_track.py              # WebRTC H.264 video track
├── webrtc_server.py           # WebRTC signaling server
├── web_assets/
│   ├── webrtc_client.js       # Browser WebRTC client
│   └── bbox_overlay.js        # Canvas BBox renderer
├── web_monitor.py             # 既存のMJPEG monitor
└── pyproject.toml             # 依存関係（更新済み）
```

## 技術詳細

### H.264ストリーム処理

**共有メモリフォーマット**:
- `/pet_camera_stream`: H.264 NAL units
- `frame.format = 3` (H.264)
- `frame.data_size`: H.264データサイズ

**タイムスタンプ同期**:
```python
# 30fps → WebRTC timestamp (90kHz)
pts = int(frame_count * 90000 / 30)
video_frame.pts = pts
video_frame.time_base = (1, 90000)
```

### WebRTCシグナリング

**エンドポイント**:
- `POST /api/webrtc/offer` - SDP offer/answer exchange
- `POST /api/webrtc/ice` - ICE candidate (optional)
- `GET /api/webrtc/status` - Server status

**SDP Negotiation Flow**:
1. Browser creates offer
2. POST /api/webrtc/offer
3. Server adds H.264 track, creates answer
4. Browser receives answer, sets remote description
5. WebRTC connection established

### Canvas BBox描画

**Server-Sent Events**:
- エンドポイント: `/api/detections/stream` (既存)
- フォーマット: JSON detection results
- 自動再接続対応

**座標スケーリング**:
```javascript
// 検出は640x480で実行、Canvasは任意サイズ
const scaleX = canvas.width / 640;
const scaleY = canvas.height / 480;
const x = bbox.x * scaleX;
const y = bbox.y * scaleY;
```

## パフォーマンス目標

| メトリクス | 現状(MJPEG) | 目標(WebRTC) | 測定方法 |
|-----------|------------|-------------|---------|
| FPS | 7-8 | **30** | ブラウザDevTools |
| サーバーCPU | 90% | **<30%** | top/htop |
| 遅延 | 200-300ms | **<100ms** | タイムスタンプ比較 |

## トラブルシューティング

### カメラシステムが起動しない

```bash
# 共有メモリとプロセスをクリーンアップ
cd src/capture
make cleanup

# 再ビルド
make all

# カメラシステム起動
cd ../..
./scripts/run_camera_switcher_yolo.sh
```

### WebRTCサーバーが起動しない

**依存関係エラー**:
```bash
cd src/monitor
uv sync --reinstall
```

**ポート衝突**:
```bash
# ポート8081を使用中のプロセスを確認
lsof -i :8081
# または
sudo netstat -tulpn | grep 8081
```

### ブラウザでビデオが表示されない

1. **ブラウザコンソールを確認**
   - F12 → Console
   - WebRTCエラーメッセージを確認

2. **H.264共有メモリを確認**
   ```bash
   ls -lh /dev/shm/pet_camera_stream
   ```

3. **WebRTCサーバーログを確認**
   - Connection state変化
   - ICE connection state

4. **ブラウザH.264対応を確認**
   - Chrome/Edge: 推奨（H.264サポート良好）
   - Firefox: 一部プロファイルのみ対応
   - Safari: 対応

### 検出結果が表示されない

```bash
# SSEエンドポイントをテスト
curl http://localhost:8080/api/detections/stream
```

YOLOデーモンが起動していることを確認:
```bash
ps aux | grep yolo_detector_daemon
```

## 次の実装ステップ

### Phase 3.1: HTML統合
- [ ] 既存web_monitor.pyにWebRTCビュー追加
- [ ] MJPEG/WebRTC切り替えUI
- [ ] 統合起動スクリプト更新

### Phase 3.2: テストと最適化
- [ ] 実機での30fps確認
- [ ] CPU使用率測定
- [ ] 遅延測定
- [ ] ブラウザ互換性テスト

### Phase 3.3: ドキュメント完成
- [ ] ユーザーガイド
- [ ] API仕様書
- [ ] トラブルシューティング拡充

## 参考資料

### WebRTC
- [python-aiortc Documentation](https://aiortc.readthedocs.io/)
- [WebRTC API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)

### H.264
- [H.264 Standard (ITU-T H.264)](https://www.itu.int/rec/T-REC-H.264)
- [PyAV Documentation](https://pyav.org/)

### 設計ドキュメント
- [WebRTC Implementation Design](../docs/webrtc_implementation_design.md)
- [Camera Switcher H.264 Migration](../docs/camera_switcher_h264_migration.md)

---

**作成日**: 2025-12-24
**ステータス**: Phase 3.0 実装完了 - テスト・統合待ち
**担当**: Claude Code
