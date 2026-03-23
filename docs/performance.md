# パフォーマンス最適化

## 概要

streaming-server（WebRTC）とweb_monitor（MJPEG）のCPU使用率を段階的に最適化した記録。主な施策は3つ：CPU処理の効率化、ゼロコピーメモリアクセス、アイドル時スロットリング。

## 1. CPU最適化（CPU 100% → 3%）

Go実装への移行時に実施した基本最適化。

| 施策 | 効果 |
|------|------|
| C言語によるNV12→RGBA変換 | Go純正実装のピクセル単位処理を排除 |
| JPEGキャッシュ | フレーム番号未変更時はキャッシュ済みJPEGを返却 |
| メモリアクセス最適化 | 実データサイズのみコピー（バッファ全体ではなく） |

**結果**: CPU使用率 ~100% → ~3%

### オーバーレイ機能

- **MJPEG（サーバー側）**: `drawer.go` でフレーム番号・タイムスタンプ・BBoxを描画
- **WebRTC（クライアント側）**: `bbox_overlay.js` でCanvas上にBBox描画（500ms永続化でちらつき防止）
- **時刻ソース**: `CLOCK_REALTIME`を使用（`CLOCK_MONOTONIC`から変更）

## 2. ゼロコピー最適化

### 問題

| コンポーネント | CPU使用率 | 主要ボトルネック |
|--------------|----------|----------------|
| streaming-server (WebRTC) | 78.9% | SRTP暗号化(AES) ~45%, RTP ~10% |
| web_monitor (MJPEG) | 69.9% | NV12→RGBA ~30-40%, JPEG encoding ~20-30% |
| **合計** | **~150%** | |

### MJPEGゼロコピー

```
Before: C側 memcpy(3MB) + Go側 copy(3MB) = 6MB x 30fps = 180MB/秒
After:  C側 share_id via SHM + Go側 hb_mem_import = ゼロコピー
```

**実装**:
- `get_latest_frame_ptr()`: 共有メモリへの直接ポインタ返却（ゼロコピー）
- `LatestFrameZeroCopy()`: Go側で共有メモリ直接参照
- オーバーレイ描画時のみコピー作成（共有メモリ保護のため必須）

**重要**: ゼロコピーで取得したデータは読み取り専用。変更時は必ずコピーを作成すること。

### WebRTC SettingsEngine最適化

```go
// DTLS再送間隔: 1秒 → 2秒（再送CPU削減）
settingsEngine.SetDTLSRetransmissionInterval(time.Second * 2)

// ネットワーク: UDP4/UDP6のみ（TCP fallback無効）
settingsEngine.SetNetworkTypes([]webrtc.NetworkType{
    webrtc.NetworkTypeUDP4, webrtc.NetworkTypeUDP6,
})
```

**制約**: LAN環境前提。SRTP暗号化（~45% CPU）はWebRTC仕様上削減不可。

### TurboJPEG調査結果

- libjpeg-turbo利用可能だがNV12直接サポートなし
- RDK X5にHW JPEGエンコーダー (`hobot_jpu.ko`) 存在するがユーザーランドAPI不明
- 現状はNV12→RGBA→JPEG変換を維持

### 最適化後の見積もり

| コンポーネント | Before | After（推定） |
|--------------|--------|-------------|
| web_monitor | 69.9% | 45-55% |
| streaming-server | 78.9% | 65-75% |
| **合計** | **~150%** | **110-130%** |

## 3. アイドル時スロットリング

クライアント接続が0の時のCPU浪費を3フェーズで解消。

### Phase 1: セマフォwait/ポーリングの最適化

クライアント数チェックをセマフォwait/共有メモリ読み取りの**前**に移動。クライアント0なら100ms sleep。

**対象コンポーネント**:
- `FrameBroadcaster.run()`: セマフォwait前にクライアント数チェック
- `DetectionBroadcaster.run()`: 同上
- `Server.readFrames()`: クライアント0かつ録画なしならフレーム読み取りスキップ

| 項目 | Before | After |
|------|--------|-------|
| web_monitor（クライアント0） | 5-10% CPU | ~0.5% CPU |
| streaming-server（クライアント0） | 3-5% CPU | ~0.2% CPU |
| **合計（アイドル時）** | **8-15%** | **~0.7%** |

**設計**: 100ms sleepのレイテンシはユーザー体験に影響なし。録画中はクライアント数に関係なくフレーム読み取り継続。

### Phase 2: HTTP接続切断の検出

**問題**: MJPEG→WebRTC切り替え後、`w.Write()`のエラーを無視していたためUnsubscribeが実行されず、アイドル最適化が効かなかった。

**解決**: `w.Write()`のエラーチェック追加。エラー時に即座に`return`→`defer Unsubscribe()`実行。

| シナリオ | Phase 1のみ | Phase 1+2 |
|---------|-------------|-----------|
| MJPEG→WebRTC切替後 | 5-10% CPU | 0.7% CPU |

### Phase 3: WebRTC切断の早期検知

ICEConnectionStateに加えてPeerConnectionStateも監視。`Disconnected`状態の検知を追加。

| 検知方法 | 遅延 |
|---------|------|
| OnConnectionStateChange（タブ閉じ） | ~数ms |
| OnICEConnectionStateChange（ネットワーク断） | ~数秒 |
| WriteSample()エラー | ~33ms |

## キーメトリクス（まとめ）

| シナリオ | CPU使用率 |
|---------|----------|
| 初期Go実装 | ~100% |
| CPU最適化後 | ~3% |
| アクティブ時（WebRTC+MJPEG） | 110-130% |
| アイドル時（クライアント0） | ~0.7% |
| MJPEG→WebRTC切替後 | ~0.7% |

### さらなる最適化の可能性

| 施策 | 予想効果 |
|------|---------|
| HW JPEGエンコーダー (`hobot_jpu.ko`) 活用 | web_monitor 45-55% → 10-20% |
| H.264 Passthrough (MSE/WebCodecs) | web_monitor → 5-10% |
| VSE専用MJPEG共有メモリ | 5-10% CPU削減 |
| Interceptor最適化（NACK/RTCP無効化） | streaming-server 10%削減 |

### 動作確認

```bash
# システム起動（DEBUGレベル）
./scripts/run_camera_switcher_yolo_streaming.sh --log-level debug

# アイドル確認
grep "No clients" /tmp/web_monitor.log
grep "idle" /tmp/streaming_server.log

# CPU使用率モニタリング
top -p $(pgrep -f web_monitor) -p $(pgrep -f streaming-server)
```

---

## H.264エンコーディング性能基準

並列エンコード時（カメラシステム稼働中）のパフォーマンス目標:

| メトリクス | 目標値 |
|---|---|
| カメラFPS（HWエンコード中） | 25fps以上を維持 |
| HWエンコーダCPUオーバーヘッド | +20%以下 |
| システム温度 | 80°C未満 |
| HWエンコード速度 | 1.0x リアルタイム以下（再生速度より高速） |
| CPUエンコード速度 | 2.0x リアルタイム以下 |

- HWエンコーダ: `h264_v4l2m2m`（V4L2 M2Mデバイス）
- CPUエンコーダ: `libx264`（preset=ultrafast, CRF=23）
- エンコード中は `nice -n 19` で低優先度実行
