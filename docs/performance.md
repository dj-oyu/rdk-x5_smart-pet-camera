# パフォーマンス最適化

## 概要

streaming-server（WebRTC）・web_monitor（MJPEG）・detector（YOLO）のCPU使用率を段階的に最適化した記録。

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

### 問題（H.264時代）

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

## 3. アイドル時スロットリング（streaming-server）

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

## 4. detector アイドル時スロットリング（2026-03-29）

夜間カメラモードで `_quiet_frames`（動体なし継続フレーム数）を使い、フレーム処理レートを段階的に低下。

**背景**: 夜間カメラは毎フレーム30fpsでmotion detection（medianBlur 640x640 + resize + frame_diff + base_diff = ~14 OpenCV ops）を実行しており、動体なし時も180% CPUを消費していた。

**実装** (`src/detector/yolo_detector_daemon.py` `_frame_iter()`):

```python
if self.night_roi_mode and self._quiet_frames >= self.IDLE_TIER1_FRAMES:
    if self._quiet_frames >= self.IDLE_TIER2_FRAMES:
        time.sleep(self.IDLE_TIER2_SLEEP)   # ~5fps
    else:
        time.sleep(self.IDLE_TIER1_SLEEP)   # ~10fps
```

| Tier | 条件 | 処理レート | CPU削減 |
|------|------|-----------|--------|
| T1 | quiet ≥ 30f (~1s) | ~10fps | ~66% |
| T2 | quiet ≥ 150f (~5s) | ~5fps | ~83% |
| active | motion検出 → quiet=0 | 30fps | 0% |

**安全性**: sleep は SHM 読み取り前（hb_mem バッファ未取得状態）。motion検出で `_quiet_frames=0` に即時リセット → 復帰遅延 < 167ms。昼間カメラは未適用。

**結果**: 夜間 idle 時 **180% → ~25% CPU**

---

## キーメトリクス（現在）

| シナリオ | CPU使用率 |
|---------|----------|
| streaming-server アクティブ（WebRTC 1クライアント） | ~120% |
| streaming-server アイドル（クライアント0） | ~0.7% |
| detector 夜間 idle（T2スロットリング） | ~25% |
| detector 夜間 active（motion/YOLO） | ~180% |
| detector 昼間（YOLO常時実行） | ~40% |

---

## H.265エンコーディングスタック（現在）

H.264ソフトウェアエンコードからH.265ハードウェアエンコードへ移行済み（2026-03-21）。

| レイヤー | 実装 | CPU負荷 |
|---------|------|--------|
| H.265エンコード | Hobot VPU (HW) `encoder_lowlevel.c` | ほぼ0（VPU処理） |
| 前処理 letterbox | nano2D GPU (HW) | ほぼ0 |
| SHM→Goヒープ転送 | `ReadLatestCopy()` + CGo `hb_mem_import` + memcpy | 主要コスト |
| NAL処理・RTPパケット化 | pion/webrtc v4 (Go) | 主要コスト |
| SRTP暗号化 | pion/srtp v3（ソフトウェアAES） | **軽微**（後述） |
| DTLS/ICE/RTCP管理 | pion Go runtime | 一部 |

**エンコーダー設定** (`src/capture/encoder_lowlevel.c`):
- コーデック: H.265 CBR、ビットレート: 600 kbps（デフォルト）
- キーフレーム間隔: 30f（1秒）、QP範囲: 8-50

### streaming-server ~40% の内訳推定（WebRTC 1クライアント、Tailscale経由）

実測: Tailscale UL **195 kbps**（H.265 600kbps + SRTP/RTP オーバーヘッド込み）。

| 要因 | CPU推定 | 備考 |
|------|--------|------|
| CGo `hb_mem_import` + memcpy (30fps) | 主要 | `ReadLatestCopy()` の意図的設計（後述） |
| pion Goランタイム（goroutine、GC） | 主要 | |
| NAL処理・RTPパケット化 | 中 | |
| SRTP暗号化（ソフトウェアAES） | **軽微** | 実効帯域 195 kbps → 暗号化量が極小（後述） |
| DTLS/ICE/RTCP管理 | 小 | |

**SRTPが軽微な理由**:
- このSoCはARMv8暗号拡張命令（`aes`）を搭載しない（`/proc/cpuinfo Features` で確認済み）→ pion/srtp v3 はソフトウェアAESで動作
- しかし実効帯域は **195 kbps（~24KB/sec）** のみ（Tailscale UL実測値）
- OpenSSL ベンチマーク: AES-128-CTR **~50 MB/sec** on this device → 24KB/sec の暗号化は余裕の 2000倍
- 旧ドキュメントの「SRTP ~45% CPU」は H.264 高ビットレート時代の測定値であり、現在の構成では該当しない
- WebRTC 仕様上 SRTP は必須。ただし現在はボトルネックではないため最適化不要

**memcpyについて**: `ReadLatest()`（ゼロコピー）→`ReadLatestCopy()`への変更は、SHM reader goroutine と WebRTC sender goroutine を非同期化するための意図的な設計。VPUバッファのライフタイムをGoのGCに委ねることでシリアライズを回避している。ゼロコピーパスへの戻しも技術的には可能だが、複数クライアント時のフレームドロップリスクがあるため採用しない。

---

## さらなる最適化の可能性

| 施策 | 予想効果 | 難易度 |
|------|---------|-------|
| HW JPEGエンコーダー (`hobot_jpu.ko`) 活用 | web_monitor 45-55% → 10-20% | 高（API不明） |
| Interceptor最適化（NACK/RTCP無効化） | streaming-server ~10%削減 | 低 |
| detector 昼間スロットリング | detector 40% → ~10% | 低（設計検討要） |

### 動作確認

```bash
# CPU使用率モニタリング
ps aux | grep -E 'streaming|python3|cam'

# detector スロットル状態確認
sudo journalctl -u pet-camera-detector -n 5
# quiet=NNN(T1) または (T2) でスロットル動作を確認
```
