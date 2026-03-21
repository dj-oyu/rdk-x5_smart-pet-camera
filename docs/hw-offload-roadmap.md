# HWオフロード開発ロードマップ

`docs/hardware-specs.md` の調査結果に基づく実装計画。

**目標**: CPUを映像処理から解放し、AI後処理・ストリーミングに専念させる。

---

## 現状のアーキテクチャ

```
Camera (libspcdev)
  ↓ sp_vio_get_frame (NV12)
  ├─→ POSIX SHM (/pet_camera_stream) ──→ Go streaming-server (WebRTC H.264 / MJPEG)
  ├─→ POSIX SHM (/pet_camera_zc_*)   ──→ Python YOLO detector (BPU推論)
  └─→ VPU H.264 encoder (libspcdev)

全IPC: POSIX SHM + セマフォ
映像前処理: CPU (Python memcpy letterbox, crop)
映像エンコード: VPU HW (H.264)
YOLO推論: BPU HW
YOLO後処理: CPU (Python numpy/OpenCV)
MJPEGオーバーレイ: CPU (C via CGo)
JPEG変換: VPU HW (hb_mm_mc JPEG)
```

## 目標アーキテクチャ

```
Camera (hbn_vflow: VIN → ISP → VSE)     ← カーネル内HW結合
  VSE Ch0: 1920x1080 NV12 ──→ VPU H.265 encoder ──→ Go (WebRTC)
  VSE Ch1: 640x360 NV12   ──→ nano2D letterbox ──→ BPU YOLO ──→ CPU (後処理のみ)
  VSE Ch2-4: 640xN ROI    ──→ nano2D letterbox ──→ BPU YOLO (夜間3ROI)

全IPC: hbmem物理アドレス共有 (ゼロコピー)
映像前処理: GPU 2D (nano2D) ← CPUフリー
映像エンコード: VPU HW (H.265)
YOLO推論: BPU HW
YOLO後処理: CPU (唯一のCPU処理)
MJPEGオーバーレイ: CPU (低負荷、変更なし)
JPEG変換: VPU HW (変更なし)
```

---

## フェーズ1: H.265完全移行

ターゲットクライアント: iPhone (Safari)、Chrome、Safari — 全てH.265対応済み。

### 1-1. C側エンコーダー変更 ✅

**対象**: `src/capture/encoder_lowlevel.c`

```c
// 4行変更
codec_id:     MEDIA_CODEC_ID_H264  → MEDIA_CODEC_ID_H265
rc_mode:      MC_AV_RC_MODE_H264CBR → MC_AV_RC_MODE_H265CBR
params:       h264_cbr_params → h265_cbr_params
追加:         ctu_level_rc_enalbe = 1
```

SHMフォーマット値も更新: `format = 3 (H.264)` → `format = 4 (H.265)`

リファレンス: `/app/multimedia_samples/sample_pipeline/common/vp_codec.c:176-182`

検証: `docs/hardware-specs.md` の実測ベンチマーク参照。同QP比較で9-24%サイズ削減、エンコード速度はH.264と同等 (68-71 fps)。

### 1-2. Go側WebRTCコーデック変更 ✅

**対象**: `src/streaming_server/internal/webrtc/server.go`

- pion/webrtc v3 → **v4にアップグレード** (v3にはH.265 RTP payloaderが存在しなかった)
- `webrtc.MimeTypeH265` を使用 (v4で標準提供)

### 1-3. NALユニット処理の更新 ✅

**対象**: `src/streaming_server/internal/h264/` → `internal/codec/` にリネーム

- H.265 NALユニットタイプの認識: `(byte >> 1) & 0x3F` (VPS=32, SPS=33, PPS=34, IDR=19/20)
- VPS (Video Parameter Set) のキャッシュ追加
- IDRフレーム判定ロジック更新 (IDR_W_RADL=19, IDR_N_LP=20)
- `H264Frame` → `VideoFrame` にリネーム (codec-agnostic化)

### 1-4. 録画パイプライン ✅

- ファイル拡張子: `.h264` → `.hevc`
- ffmpeg引数: `-f h264` → `-f hevc` (`-c copy` モードでパススルー)
- VPS/SPS/PPSヘッダーをIDRフレームに付与

### 検証項目

- [x] H.265エンコード動作確認 (カメラデーモン) — 2026-03-21 完了
- [x] WebRTC H.265配信 → iPhone Safari で再生確認 — 2026-03-21 完了 (pion/webrtc v4)
- [x] WebRTC H.265配信 → Chrome で再生確認 — 2026-03-21 完了
- [x] 録画 (.hevc → .mp4 変換) 確認 — 2026-03-21 完了
- [x] MJPEGパイプラインが影響を受けていないことを確認 — 2026-03-21 完了
- [ ] CPU使用率のbefore/after比較

---

## フェーズ2: 完全なHWオフローディング

### 2-1. ソフトウェアリファクタリング

HWオフロードの前提となるアーキテクチャ変更。コードの変更のみ、HW API呼び出しはまだ追加しない。

#### 2-1a. カメラデーモン: libspcdev → hbn_vflow 移行

**対象**: `src/capture/camera_pipeline.c`, `src/capture/vio_lowlevel.c`

現行の `sp_open_camera` / `sp_vio_get_frame` を `hbn_vflow` (VIN→ISP→VSE) に置き換え。

```
Before: sp_open_camera → sp_vio_get_frame (1チャンネル)
After:  hbn_vflow VIN→ISP→VSE (最大5チャンネル同時出力)
```

**動機**: VSE多チャンネルを使うにはhbn_vflow APIが必要。libspcdevのVSEは2チャンネル固定。

**参照**: `/app/multimedia_samples/sample_pipeline/single_pipe_vin_isp_vse_vpu/`

VSEチャンネル設計:
| Ch | 解像度 | 用途 |
|----|--------|------|
| 0 | 1920x1080 | ストリーミング + H.265エンコード |
| 1 | 640x360 | YOLO day入力 (letterboxはnano2D) |
| 2 | 640x480 | YOLO night ROI0 |
| 3 | 640x480 | YOLO night ROI1 |
| 4 | 640x480 | YOLO night ROI2 |

#### 2-1b. フレーム配布: POSIX SHM → hbmem物理アドレス共有

**対象**: `src/capture/shared_memory.c`, `src/streaming_server/internal/shm/reader.go`

現行のPOSIX SHMリングバッファを、hbmemの `share_id` / `phys_addr` ベースの配布に段階的に移行。

```
Before: sp_vio_get_frame → memcpy → SHM ring buffer → Go/Python read + memcpy
After:  hbn_vnode_getframe → share_id をSHMメタデータに書き込み → Go/Python が hb_mem_import
```

**メリット**: NV12フレーム本体のmemcpyが不要。メタデータ (share_id, 数十バイト) のみSHM経由。

#### 2-1c. 検出前処理の分離

**対象**: `src/detector/yolo_detector_daemon.py`

前処理 (letterbox, crop) をプラグイン可能な構造にリファクタリング。

```python
# Before: 一体化
frame = shm.get_frame()
letterboxed = self._letterbox_nv12(frame)
result = self.model.forward(letterboxed)

# After: 前処理をstrategyパターンで分離
preprocessor = HWLetterboxPreprocessor()  # or CPULetterboxPreprocessor()
frame = shm.get_frame()
prepared = preprocessor.prepare(frame)
result = self.model.forward(prepared)
```

### 2-2. 段階的にHWコードを追加、動作検証

各ステップで動作検証し、問題があればCPUフォールバックに戻せる設計。

#### 2-2a. nano2Dレターボックス統合 ✅

**対象**: 新規 `src/capture/n2d_letterbox.c`
**実装済み**: n2d_letterbox_create/process/destroy API。n2d_wrap ゼロコピー入力。

VSE出力 → nano2Dレターボックス → BPU入力バッファ

```c
// create_n2d_buffer_wraper.c パターンでゼロコピー
wrap_hbmem_zerocopy(&n2d_src, &vse_output.buffer);  // phys_addr直接
n2d_fill(&n2d_dst, NULL, 0x00108080, N2D_BLEND_NONE);
n2d_blit(&n2d_dst, &center_rect, &n2d_src, NULL, N2D_BLEND_NONE);
n2d_commit();
```

**実測性能**: VSE 4ch + nano2D letterbox = 8.50ms/frame (118 fps)。CPU負荷ゼロ。

検証:
- [ ] レターボックス出力が既存CPU実装と同一であることをピクセル比較
- [ ] YOLO検出精度に差がないことを確認 (同一フレームで比較)
- [ ] 30fps持続動作の安定性テスト (1時間)

#### 2-2b. VSE夜間ROI HWクロップ ✅

**対象**: `src/capture/vio_lowlevel.c` (VSE Ch3-5設定)
**実装済み**: VSE Ch3-5 で 1920x1080 → 640x640 ROI HWクロップ。vio_get_frame_roi/release API追加。

```
Before: Python → memcpy crop (1-2ms × 3) → letterbox → BPU
After:  VSE Ch2-4 HW crop+resize (~0ms) → nano2D letterbox → BPU
```

**CPU解放効果**: 3-6ms/frame

検証:
- [ ] 夜間3ROIの検出精度が維持されることを確認
- [ ] ラウンドロビン切り替えの動作確認
- [ ] モーション検出との連携確認

#### 2-2c. H.265エンコーダーのmemcpy削減 ✅

**対象**: `src/capture/encoder_lowlevel.c`, `src/capture/encoder_thread.c`
**実装済み**: VSE virt_addr → VPU 直接memcpy (pool buffer経由の2回memcpyを1回に削減)。
VPU phys_addr直接入力はVPU APIの制約で不可のため、memcpy 1回が最適解。

VSE Ch0 出力の `phys_addr` を直接エンコーダー入力に使用し、memcpyを排除。

```c
// Before:
memcpy(input_buffer.vframe_buf.vir_ptr[0], vse_frame.virt_addr[0], y_size);

// After:
input_buffer.vframe_buf.phy_ptr[0] = vse_frame.phys_addr[0];
input_buffer.vframe_buf.phy_ptr[1] = vse_frame.phys_addr[1];
```

### 2-3. CPUを映像処理から解放

全HWオフロード完了後の目標状態:

| 処理 | Before (CPU) | After (HW) |
|------|-------------|-----------|
| カメラ取得 | sp_vio_get_frame | hbn_vflow (カーネル内) |
| スケーリング | VSE 2ch | VSE 5ch |
| ROIクロップ (夜間) | Python memcpy 3-6ms | VSE Ch2-4 ~0ms |
| レターボックス | Python memcpy 0.03ms | nano2D 0.98ms (CPUフリー) |
| エンコード | H.264 VPU (memcpy入力) | H.265 VPU (phys_addr直接) |
| NV12→JPEG | HW (実装済み) | 変更なし |
| YOLO推論 | BPU (実装済み) | 変更なし |
| **YOLO後処理** | **CPU 5-10ms** | **CPU 5-10ms (唯一のCPU処理)** |
| MJPEGオーバーレイ | CPU <0.5ms | CPU <0.5ms (低負荷、変更なし) |

---

## 性能改善虎の巻

### メモリゼロコピーの追究

| レイヤー | 現状 | 目標 | 手法 |
|---------|------|------|------|
| Camera → SHM | memcpy (NV12 3MB) | ゼロコピー | `share_id` メタデータのみSHM書き込み |
| SHM → Go | memcpy (CGo) | ゼロコピー | `hb_mem_import_com_buf` で物理メモリ直接参照 |
| SHM → Python | ゼロコピー (実装済み) | 維持 | `hb_mem_bindings.import_nv12_graph_buf` |
| VSE → Encoder | memcpy (vir_ptr) | ゼロコピー | `phy_ptr` 直接設定 |
| VSE → nano2D | ゼロコピー (検証済み) | 実装 | `n2d_wrap(phys_addr)` → `n2d_map()` |

### セマフォ・ロックの排除

| 同期機構 | 現状 | 目標 | 手法 |
|---------|------|------|------|
| フレーム通知 | POSIX sem_post/wait | ロックフリー | atomic write_index + eventfd/epoll |
| 検出結果書き込み | POSIX sem | ロックフリー | SeqLock (writer 1, reader N) |
| MJPEGブロードキャスト | Go mutex + channel | 維持 | Go concurrencyは既に効率的 |

### 処理パイプライン構成の最適化

```
=== 現行 (直列、CPUブロック) ===
CPU: [取得] → [前処理] → [BPU待ち 9ms] → [後処理 5-10ms] → [次フレーム]

=== 目標 (並列、HWパイプライン) ===
VSE:   [Ch0 scale] [Ch1 scale] [Ch2-4 ROI] ...     ← HW、CPUフリー
GPU2D: [letterbox N] [letterbox N+1]        ...     ← HW、CPUフリー
BPU:               [推論 N]    [推論 N+1]   ...     ← HW、CPUフリー
VPU:   [H.265 enc N] [enc N+1]             ...     ← HW、CPUフリー
CPU:                           [後処理 N] [後処理 N+1]  ← 唯一のCPU処理
```

### メモリキャッシュラインの効率化

| 施策 | 対象 | 手法 |
|------|------|------|
| NV12バッファアライメント | hbmem alloc | `HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF` + 64バイトアライン |
| SHMメタデータ構造体 | shared_memory.h | `__attribute__((aligned(64)))` でキャッシュライン境界 |
| VSEバッファ | hbn_buf_alloc_attr | `is_contig = 1` (物理連続メモリ) |
| nano2Dバッファ | n2d_buffer_t | `alignedw = gcmALIGN(width, 64)` (SDK自動) |
| False sharing回避 | read/writeインデックス | 別キャッシュラインに配置 (64バイト間隔) |

### 物理メモリアドレスでデータ共有

```
=== 現行 (仮想アドレス + memcpy) ===
Producer: vir_ptr → memcpy → SHM vir_ptr → Consumer: memcpy → vir_ptr

=== 目標 (物理アドレス直接共有) ===
Producer: phys_addr → SHMにメタデータ書き込み (share_id, phys_addr, size)
Consumer: share_id → hb_mem_import → 同一物理メモリにアクセス
          phys_addr → n2d_wrap → GPU 2Dが物理メモリ直接処理
          phys_addr → hb_mm_mc → VPUが物理メモリ直接エンコード
```

**検証済みパターン**:
- `n2d_wrap(phys_addr)`: VSE→nano2Dゼロコピー実測 8.50ms/4ch (docs/hardware-specs.md)
- `create_n2d_buffer_from_hbm_graphic()`: SDK公式wrapper (create_n2d_buffer_wraper.c)

---

## 実装順序とリスク管理

各ステップは独立してロールバック可能。

| 順序 | タスク | 依存 | リスク | ロールバック |
|------|--------|------|--------|-------------|
| 1-1 | H.265 C側エンコーダー | なし | 低 | codec_id を H264 に戻す |
| 1-2 | H.265 Go側WebRTC | 1-1 | 低 | MimeType を H264 に戻す |
| 1-3 | H.265 NAL処理 | 1-1 | 中 | processor.go に H264 分岐を残す |
| 2-1a | hbn_vflow移行 | なし | **高** | libspcdev版を残して切り替え可能に |
| 2-1b | hbmem物理アドレス共有 | 2-1a | 中 | POSIX SHM フォールバック |
| 2-2a | nano2Dレターボックス | 2-1a | 低 | CPUレターボックスにフォールバック |
| 2-2b | VSE夜間ROI | 2-1a | 低 | Python crop にフォールバック |
| 2-2c | encoder phys_addr | 2-1a | 中 | memcpy にフォールバック |

**最大リスク: 2-1a (hbn_vflow移行)** — カメラパイプライン全面改修。必ず libspcdev版を並行維持し、ビルドフラグで切り替え可能にすること。
