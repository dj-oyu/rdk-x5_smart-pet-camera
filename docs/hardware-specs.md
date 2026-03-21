# RDK X5 ハードウェアスペック

## 概要

D-Robotics RDK X5 (Linux aarch64) のアクセラレータ調査結果。標準V4L2/GStreamerハードウェアアクセラレーションは利用不可。代わりにD-Robotics独自の「Horizon Video Processing Framework (VPF)」を使用（`libspcdev`, `libvpf`, `libcam`）。

マルチメディアAPIは `hb_mm_mc_*` (H.264/H.265/JPEGエンコード・デコード) を中心に、`libspcdev` の高レベルAPI (`sp_*`) でパイプライン構築が可能。リファレンスサンプル集は `/app/multimedia_samples/` および `/app/cdev_demo/` に収録。

## GPU: Vivante GC8000L

| 項目 | 値 |
|------|-----|
| デバイス | Vivante OpenCL Device GC8000L.6214.0000 |
| API | OpenCL 3.0 V6.4.14.9.674707 |
| Compute Units | 1 |
| Global Memory | 256 MB（共有システムRAM） |
| Local Memory | 32 KB |
| Max Work Group Size | 1024 |
| 計算性能 | ~6.75 GFLOPS (FP32) |
| OpenCLライブラリ | `/usr/hobot/lib/libOpenCL.so` |

### メモリ帯域ベンチマーク

| メトリクス | 結果 | 備考 |
|-----------|------|------|
| Host → Device (Copy) | 2.54 GB/s | `clEnqueueWriteBuffer` |
| Device → Host (Copy) | **0.07 GB/s** | 致命的ボトルネック。使用禁止 |
| Device → Device | 3.45 GB/s | GPU内部コピー |
| Map (Write) → Unmap | **5.07 GB/s** | `CL_MEM_ALLOC_HOST_PTR`（ゼロコピー） |
| Map (Read) → Unmap | **>1000 GB/s** | 即座のマッピング（ゼロコピー成功） |

### ゼロコピーパターン（推奨）

```c
// 割り当て: CL_MEM_ALLOC_HOST_PTR でCPU/GPU共有メモリを使用
clCreateBuffer(..., CL_MEM_READ_WRITE | CL_MEM_ALLOC_HOST_PTR, ...)

// アクセス: Map/Unmapを使用
clEnqueueMapBuffer(...)

// 禁止: clEnqueueReadBuffer / clEnqueueWriteBuffer
```

Device→Host Copyの0.07 GB/sはキャッシュフラッシュまたはDMA未使用が原因。ゼロコピーならシステムRAM速度でアクセス可能。

## GPU 2D: GC820 nano2D

OpenCLとは別の専用2Dアクセラレータ。画像処理に特化した高レベルAPI。

| 項目 | 値 |
|------|-----|
| API | `GC820/nano2D.h` |
| 主要関数 | `n2d_blit()`, `n2d_commit()`, `n2d_free()` |

### 対応フォーマット

NV12, NV21, RGBA8888, BGRA8888, YUYV, UYVY, YV12, I420, NV16, NV61, P010 (10-bit)

### 機能一覧

| 機能 | サンプル | 備考 |
|------|---------|------|
| リサイズ | `sample_gpu_2d/sample_resize/` | HWスケーリング |
| フォーマット変換 | `sample_gpu_2d/sample_format_convert/` | NV12→RGBA等 |
| 矩形描画 | `sample_gpu_2d/sample_rectangle_fill/` | 塗りつぶし矩形 |
| アルファブレンド | `sample_gpu_2d/sample_alphablend/` | 半透明合成 |
| 回転 | `sample_gpu_2d/sample_rotation/` | 任意角度 |
| クロップ | `sample_gpu_2d/sample_crop/` | 領域切り出し |
| ステッチ | `sample_gpu_2d/sample_stitch/` | 画像結合 |
| バッファコピー | `sample_gpu_2d/sample_copy/` | GPU間コピー |

パイプライン統合例: `sample_pipeline/single_pipe_vin_isp_vse_gpu2d/`

**NV12→RGBA変換をnano2Dでオフロード可能**（OpenCLより適切 — 専用HW、API簡潔）。

### ベンチマーク結果 (実測値)

| 操作 | 解像度 | 性能 |
|------|--------|------|
| NV12 → RGBA | 1920x1080 | **3.52 ms/frame** (283.8 fps) |
| RGBA → NV12 | 1920x1080 | **3.10 ms/frame** (322.2 fps) |
| NV12 resize | 1920x1080→640x360 | **0.42 ms/frame** (2364.3 fps) |

テストコード:

```c
#include <stdio.h>
#include <time.h>
#include "GC820/nano2D.h"

// ビルド: gcc -o test test.c -I /usr/include/GC820/ -L /usr/hobot/lib -lNano2Dutil -lNano2D -lm

int main() {
    n2d_open();
    n2d_switch_device(N2D_DEVICE_0);
    n2d_switch_core(N2D_CORE_0);

    n2d_buffer_t nv12 = {0}, rgba = {0};
    n2d_util_allocate_buffer(1920, 1080, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &nv12);
    n2d_util_allocate_buffer(1920, 1080, N2D_RGBA8888, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &rgba);

    // NV12 → RGBA 変換
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < 100; i++) {
        n2d_blit(&rgba, N2D_NULL, &nv12, N2D_NULL, N2D_BLEND_NONE);
        n2d_commit();
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double ms = ((t1.tv_sec-t0.tv_sec)*1000.0 + (t1.tv_nsec-t0.tv_nsec)/1e6) / 100;
    printf("NV12→RGBA: %.2f ms/frame\n", ms);

    n2d_free(&rgba);
    n2d_free(&nv12);
    n2d_close();
}
```

## BPU (Brain Processing Unit)

| 項目 | 値 |
|------|-----|
| デバイス | `/dev/bpu` |
| ライブラリ | `libcnn_intf.so` |
| 用途 | AI/テンソル演算（YOLO等） |

GPUの6.75 GFLOPSでは最新のオブジェクト検出は不可能。AI推論にはBPUを使用すること。

## VPU (Video Processing Unit)

### 共通API

`hb_mm_mc_*` (`/usr/include/hb_media_codec.h`):

| 関数 | 役割 |
|------|------|
| `hb_mm_mc_initialize()` | コーデックコンテキスト初期化 |
| `hb_mm_mc_configure()` | パラメータ設定 |
| `hb_mm_mc_start()` | エンコード/デコード開始 |
| `hb_mm_mc_dequeue_input_buffer()` | 入力バッファ取得 |
| `hb_mm_mc_queue_input_buffer()` | 入力バッファ投入 |
| `hb_mm_mc_dequeue_output_buffer()` | 出力バッファ取得 |
| `hb_mm_mc_queue_output_buffer()` | 出力バッファ返却 |
| `hb_mm_mc_stop()` | 停止 |
| `hb_mm_mc_release()` | リソース解放 |

### H.264エンコーダー（実装済み）

| 項目 | 値 |
|------|-----|
| 実装 | `src/capture/encoder_lowlevel.c` |
| Codec ID | `MEDIA_CODEC_ID_H264` |
| Profile | Baseline/Main/High @ L5.2 |
| RC Mode | CBR (`MC_AV_RC_MODE_H264CBR`) |
| ビットレート | 600 kbps（上限700 kbps） |
| GOP | preset=1, decoding_refresh_type=2, intra_period=fps |
| QP範囲 | I/P/B: 8-50, initial_rc_qp=20, intra_qp=30 |
| HVS QP | 有効 (scale=2) |
| バッファ数 | frame=3, bitstream=3（X5 HW要件） |

### H.265エンコーダー（移行可能性調査）

**ステータス: HW側は完全対応。ブラウザ互換性が課題。**

#### API可用性

`MEDIA_CODEC_ID_H265` が `/usr/include/hb_media_codec.h` に定義済み。

| 項目 | 値 |
|------|-----|
| Profile | Main Profile @ L5.1 |
| 最大解像度 | 3840x2160@60fps |
| RC Modes | H265CBR, H265VBR, H265AVBR, H265FIXQP, H265QPMAP |
| H.265固有 | CTU-level RC, SAO (Sample Adaptive Offset) config |

#### 実装変更量（最小）

`encoder_lowlevel.c` で約4行変更:

```c
// codec_id: MEDIA_CODEC_ID_H264 → MEDIA_CODEC_ID_H265
// rc_mode:  MC_AV_RC_MODE_H264CBR → MC_AV_RC_MODE_H265CBR
// params:   h264_cbr_params → h265_cbr_params
// H.265固有: ctu_level_rc_enable = 1
```

リファレンス実装: `/app/multimedia_samples/sample_pipeline/common/vp_codec.c:176-182`

#### ベンチマーク結果 (実測値)

入力: `1280x720_NV12.yuv` + グレインノイズ(±5)、150フレーム@30fps

**エンコード速度 (FIXQP)**:

| Codec | QP | Speed | Avg Size/frame | Bitrate |
|-------|-----|-------|----------------|---------|
| H.264 | 28 | 70.0 fps (14.3 ms) | 59,604 B | 14,305 kbps |
| H.265 | 28 | 68.4 fps (14.6 ms) | 54,126 B | 12,990 kbps |
| H.264 | 35 | 71.7 fps (13.9 ms) | 23,039 B | 5,529 kbps |
| H.265 | 35 | 70.5 fps (14.2 ms) | 17,574 B | 4,218 kbps |

**圧縮効率 (同一QP比較)**:
- QP28: H.265はH.264比 **-9.2%** サイズ削減
- QP35: H.265はH.264比 **-23.7%** サイズ削減
- 低ビットレート（高QP）ほどH.265の優位性が大きい

**注意**: H.264/H.265ともに **ビットレート上限は700kbps** (ドライバレベルのハードリミット)。CBRで700kbps超を設定するとエラー: `Invalid h26x bit rate. Should be [0, 700000]`。

テストコード:

```c
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "hb_media_codec.h"

// ビルド: gcc -O2 -o test test.c -L /usr/hobot/lib -lmultimedia -lhbmem -lalog -lpthread -ldl -lm

// H.265 FIXQP encoder setup (H.264との差分のみ記載)
ctx->codec_id = MEDIA_CODEC_ID_H265;  // H264→H265
ctx->video_enc_params.rc_params.mode = MC_AV_RC_MODE_H265FIXQP;
mc_h265_fix_qp_params_t *p = &ctx->video_enc_params.rc_params.h265_fixqp_params;
p->intra_period = fps;
p->frame_rate = fps;
p->force_qp_I = 28;  // I-frame QP
p->force_qp_P = 28;  // P-frame QP
p->force_qp_B = 30;  // B-frame QP

// H.265 CBR encoder setup
ctx->video_enc_params.rc_params.mode = MC_AV_RC_MODE_H265CBR;
mc_h265_cbr_params_t *p = &ctx->video_enc_params.rc_params.h265_cbr_params;
p->bit_rate = 600000;        // 上限700000
p->ctu_level_rc_enalbe = 1;  // H.265固有: CTU-level RC
// 他のパラメータはH.264 CBRと同構造
```

#### WebRTC互換性

| 項目 | 状況 |
|------|------|
| pion/webrtc v3 | `webrtc.MimeTypeH265` 定数あり。`server.go` で約5行変更 |
| NAL処理 | `h264/processor.go` にVPS (Video Parameter Set) キャッシュ追加が必要 |
| 録画 | ffmpeg `copy`モードで変更不要 |
| MJPEGパイプライン | 影響なし（独立パイプライン） |

#### ブラウザ互換性

| ブラウザ | H.265サポート |
|---------|--------------|
| Safari | macOS/iOS 12+ で完全対応 |
| Chrome | Win11+ / macOS11+ (HWデコーダー必要) |
| Firefox | 非対応 |
| Edge | Win11+ (HWデコーダー必要) |

**結論**: HW側は問題なし。ブラウザ互換性からH.264/H.265ハイブリッド方式（クライアント能力に応じた切り替え）を推奨。

### JPEGエンコーダー（実装済み）

| 項目 | 値 |
|------|-----|
| 実装 | `src/capture/jpeg_encoder.c` (C) + `src/streaming_server/internal/webmonitor/shm.go` (CGo統合) |
| Codec ID | `MEDIA_CODEC_ID_JPEG` |
| 入力 | NV12直接入力（RGBA変換不要） |
| 性能 | HW ~5ms vs SW (TurboJPEG) ~55ms |
| Quality | 設定可能（デフォルト65） |

フォールバックチェーン: HW encoder → TurboJPEG (`tjCompressFromYUVPlanes`) → Go `image/jpeg` (NV12→RGBA経由)

**注**: 以前「`hobot_jpu.ko` ユーザーランドAPI未発見」と記載していたが、`hb_mm_mc` API (`MEDIA_CODEC_ID_JPEG`) で実装済み。

## VPS (Video Processing Subsystem)

`libspcdev` の高レベルAPI。NV12フレームのHWスケーリング・クロップ・回転を提供。

### API

```c
#include "sp_vio.h"

int32_t sp_open_vps(void *obj, int32_t pipe_id, int32_t chn_num, int32_t proc_mode,
                    int32_t src_w, int32_t src_h,
                    int32_t *dst_w, int32_t *dst_h,
                    int32_t *crop_x, int32_t *crop_y, int32_t *crop_w, int32_t *crop_h,
                    int32_t *rotate);
```

### 処理モード

| 定数 | 値 | 機能 |
|------|---|------|
| `SP_VPS_SCALE` | 1 | スケーリングのみ |
| `SP_VPS_SCALE_CROP` | 2 | スケーリング+クロップ |
| `SP_VPS_SCALE_ROTATE` | 3 | スケーリング+回転 |
| `SP_VPS_SCALE_ROTATE_CROP` | 4 | スケーリング+回転+クロップ |

### libspcdev 全体API体系

`/usr/lib/libspcdev.so` (`/usr/include/sp_vio.h`, `sp_codec.h`, `sp_sys.h`)

| カテゴリ | 主要関数 |
|---------|---------|
| VIO | `sp_init_vio_module`, `sp_open_camera`, `sp_open_camera_v2`, `sp_open_vps`, `sp_vio_get_frame`, `sp_vio_set_frame` |
| Encoder | `sp_init_encoder_module`, `sp_start_encode` (H264=1, H265=2, MJPEG=3), `sp_encoder_set_frame`, `sp_encoder_get_stream` |
| Decoder | `sp_init_decoder_module`, `sp_start_decode`, `sp_decoder_get_image` |
| Display | `sp_init_display_module`, `sp_start_display`, `sp_display_draw_rect`, `sp_display_draw_string` |
| BPU | `sp_init_bpu_module`, `sp_bpu_start_predict` |
| Binding | `sp_module_bind(src, SP_MTYPE_*, dst, SP_MTYPE_*)` — モジュール間ゼロコピー接続 |

### ベンチマーク結果 (実測値)

| 操作 | 性能 |
|------|------|
| NV12 scale 1920x1080→640x360 | **4.78 ms/frame** (209.2 fps) |

テストコード:

```c
#include "sp_vio.h"
#include "sp_sys.h"

// ビルド: gcc -o test test.c -lspcdev -lcam -lvpf -lhbmem -lalog -lpthread -ldl

void *vps = sp_init_vio_module();
int dst_w = 640, dst_h = 360;
sp_open_vps(vps, 0, 1, SP_VPS_SCALE, 1920, 1080, &dst_w, &dst_h,
            NULL, NULL, NULL, NULL, NULL);

// NV12フレーム投入 → スケーリング済みフレーム取得
sp_vio_set_frame(vps, input_buf, 1920*1080*3/2);
sp_vio_get_frame(vps, output_buf, 640, 360, 2000);

sp_vio_close(vps);
sp_release_vio_module(vps);
```

リファレンス: `/app/cdev_demo/vps/vps.c`, `/app/cdev_demo/decode2display/`, `/app/cdev_demo/rtsp2display/`

## hbn_vflow パイプライン + HWエンコーダー連携

### アーキテクチャ

hbn_vflow はVIN→ISP→VSEをカーネル内でHW結合するが、**エンコーダー (`hb_mm_mc`) はvflowの外部**で動作する。

```
┌─── hbn_vflow (カーネルHW結合) ───┐
│  VIN → ISP → VSE                 │
└──────────────┬────────────────────┘
               ↓ hbn_vnode_getframe() (ユーザー空間)
               ↓ memcpy
        hb_mm_mc encoder (H.264/H.265/JPEG)
```

エンコーダーはvnodeではないため `hbn_vflow_bind_vnode()` で結合**不可**。`hbn_vnode_getframe()` で取り出し → `memcpy` → エンコーダー入力バッファの流れ。

リファレンス: `/app/multimedia_samples/sample_pipeline/single_pipe_vin_isp_vse_vpu/single_pipe_vin_isp_vse_vpu.c:518-617`

### VSE 6チャンネル同時出力 (実測値)

VSEは**最大6チャンネル同時出力**可能。各チャンネルに独立した解像度・ROIクロップを設定できる。

**テスト結果 (5ch同時、1920x1080入力)**:

| Ch | 出力 | ROI | 用途 |
|----|------|-----|------|
| 0 | 1920x1080 | 全体 | ストリーミング/H.264エンコード |
| 1 | 640x360 | 全体 | YOLO day (ダウンスケール) |
| 2 | 640x640 | 0,0 720x720 | YOLO night ROI0 (左上) |
| 3 | 640x640 | 600,180 720x720 | YOLO night ROI1 (中央) |
| 4 | 640x640 | 1200,0 720x720 | YOLO night ROI2 (右上) |

**性能: 30フレーム × 5ch = 150出力 / 0.11s → 268.1 fps (3.73 ms/frame)**

**Ch5 (VSE_UP_SCALE_4K)**: アップスケール専用チャンネルのため、ダウンスケール設定は失敗する。実用上は5チャンネルで十分。

テストコード:

```c
#include "hbn_api.h"
#include "vse_cfg.h"

// ビルド: gcc -O2 -o test test.c -lcam -lvpf -lhbmem -lalog -lpthread -ldl

hbn_vnode_handle_t vse_h;
hbn_vnode_open(HB_VSE, 0, AUTO_ALLOC_ID, &vse_h);

vse_attr_t va = {0};
hbn_vnode_set_attr(vse_h, &va);

vse_ichn_attr_t ic = { .width=1920, .height=1080, .fmt=FRM_FMT_NV12, .bit_width=8 };
hbn_vnode_set_ichn_attr(vse_h, 0, &ic);

// 全チャンネル共通初期化 (重要: ROIをフルフレームで初期化)
vse_ochn_attr_t oa = {0};
oa.chn_en = CAM_TRUE;
oa.roi = (common_rect_t){0, 0, 1920, 1080};
oa.fmt = FRM_FMT_NV12;  oa.bit_width = 8;

// Ch2: 夜間ROI0 (720x720領域 → 640x640にリサイズ)
oa.roi = (common_rect_t){0, 0, 720, 720};
oa.target_w = 640;  oa.target_h = 640;
hbn_vnode_set_ochn_attr(vse_h, 2, &oa);

// vflow作成・開始後、sendframe/getframe で各チャンネルの出力を取得
hbn_vnode_sendframe(vse_h, 0, &input_img);
hbn_vnode_getframe(vse_h, 2, 2000, &roi0_output);  // Ch2: 640x640 ROI
```

### YOLO前処理のHWオフロード可能性

| 前処理 | 現状 | HWオフロード | 評価 |
|--------|------|-------------|------|
| **夜間ROIクロップ** | Python `_crop_nv12_roi()` 1-2ms×3 | VSE 3チャンネル同時クロップ+リサイズ ~0ms | **推奨** |
| **ダウンスケール** | VSE Ch1 (実装済み) | — | 済 |
| **レターボックス (黒帯追加)** | Python `_letterbox_nv12()` ~0.03ms (memcpy) | nano2D: 0.98ms (単体は遅い) | **CPU圧軽減目的ならnano2D有効** |
| **CLAHE** | Python OpenCV ~2ms | nano2D/ISPに該当API なし | 不可 |

**注**: 夜間ROIは1280x720フレーム全体を3つの重なりROIでカバーするラウンドロビン方式 (画角を捨てない)。各ROIのクロップ後にもletterbox追加が必要（ROI切り出し結果は正方形とは限らない）。

**レターボックスのHW実装**: VSEには黒帯追加APIがないが、**nano2D (GC820) で実現可能**。

#### nano2D レターボックス ベンチマーク (実測値)

640x360 → 640x640 (上下140px黒帯):

| 方式 | 性能 | 備考 |
|------|------|------|
| nano2D `n2d_fill` + `n2d_blit` | **0.98 ms** | fill(黒) + blit(中央) |
| nano2D `n2d_blit` only | **0.41 ms** | dstを事前ゼロクリア済みの場合 |
| nano2D フルパイプライン | **1.01 ms** | 1080p→640x360スケール + レターボックス一括 |
| SW memcpy (現行Python相当) | **0.03 ms** | CPU memset + memcpy |

**分析**:
- nano2Dレターボックスは0.98ms。CPUの0.03msより**遅い**
- 理由: 640x640はnano2Dにとって小さすぎ、GPUカーネル起動のオーバーヘッドが支配的
- **ただし「1080p→スケール→レターボックス」の一括処理なら1.01ms**で、VSE Ch1 (スケール) + Python letterbox (1ms) の合計より高速な場合がある

**推奨**: 単体のレターボックスは**CPU (memcpy) が最速**。ただしVSEを使わずnano2Dで「ダウンスケール+レターボックス」を一括処理する構成も検討可能。

テストコード:

```c
#include "GC820/nano2D.h"

// ビルド: gcc -O2 -o test test.c -I /usr/include/GC820/ -L /usr/hobot/lib -lNano2Dutil -lNano2D -lm

n2d_open();
n2d_switch_device(N2D_DEVICE_0);
n2d_switch_core(N2D_CORE_0);

n2d_buffer_t src, dst;
n2d_util_allocate_buffer(640, 360, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &src);
n2d_util_allocate_buffer(640, 640, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &dst);

// レターボックス: 黒塗り + 中央ブリット
n2d_fill(&dst, N2D_NULL, 0x00000000, N2D_BLEND_NONE);       // 全体を黒
n2d_rectangle_t center = {0, 140, 640, 360};                  // pad_top = 140
n2d_blit(&dst, &center, &src, N2D_NULL, N2D_BLEND_NONE);     // 中央にブリット
n2d_commit();

// フルパイプライン: 1080p入力 → スケール+レターボックス一括
n2d_buffer_t hd_src;
n2d_util_allocate_buffer(1920, 1080, N2D_NV12, N2D_0, N2D_LINEAR, N2D_TSC_DISABLE, &hd_src);
n2d_fill(&dst, N2D_NULL, 0x00000000, N2D_BLEND_NONE);
n2d_rectangle_t dst_rect = {0, 140, 640, 360};
n2d_blit(&dst, &dst_rect, &hd_src, N2D_NULL, N2D_BLEND_NONE); // 1080p→640x360→中央
n2d_commit();
```

**設計方針**: レターボックスはビデオ入力をクロップせず、アスペクト比を維持してYOLOに渡すために必要。正方形ROIクロップは画角が狭まるため代替にはならない。

**レイテンシ vs CPUビジー**: 単体のレターボックスはCPU memcpy (0.03ms) が最速だが、HWオフロードの価値はレイテンシ削減ではなく**CPUサイクルの解放**にある。パイプライン化すると差が出る:

```
=== 現行 (全CPU) ===
CPU:  [前処理 N] [BPU待ち 9ms] [後処理 N 5-10ms] [前処理 N+1] ...
                  ↑ idle                            ↑ 後処理とCPU競合

=== HWオフロード (前処理をnano2D/VSEに分離) ===
GPU2D: [letterbox N] [letterbox N+1] [letterbox N+2] ...
BPU:                 [推論 N]        [推論 N+1]      ...
CPU:                                 [後処理 N]      [後処理 N+1] ...
                                      ↑ CPUは後処理に専念
```

**特に重要なケース**:
- 夜間3ROIモード: ROI0/1/2のクロップ+letterboxが連続で必要。CPU前処理3-6ms分をGPU2Dに逃がせばCPU→後処理に集中可能
- WebRTC/MJPEGストリーミングとの共存: ストリーミングサーバーもCPUを使うため、検出前処理のCPUオフロードはシステム全体のCPU圧を下げる
- 将来のモーション検出追加: CPU負荷がさらに増える前にオフロード経路を確保

**結論**: 単体ベンチマーク上はCPUが速いが、**システム全体のCPU飽和を防ぐためにnano2Dオフロードは有効**。特に夜間3ROI + ストリーミング同時動作時にメリットが大きい。nano2Dレターボックス (0.98ms) は30fpsのフレーム間隔 (33ms) に対して十分高速。

#### VSE → nano2D 連携パイプライン ベンチマーク (実測値)

VSE 4チャンネル出力 → nano2D letterbox → 640x640 NV12:

| パイプライン | 性能 (60フレーム) | 備考 |
|-------------|-------------------|------|
| VSE only (4ch) | **3.66 ms/frame** (273 fps) | スケール+ROIクロップのみ |
| VSE + nano2D letterbox (4ch) | **24.80 ms/frame** (40 fps) | hbmem→n2dコピー含む |
| VSE + CPU letterbox (4ch) | **182.13 ms/frame** (5.5 fps) | CPUスケーリング+letterbox |

**ゼロコピーパターン検証結果** (60フレーム × 4ch):

| パイプライン | 性能 | CPU負荷 |
|-------------|------|---------|
| VSE only (4ch) | **3.75 ms** (267 fps) | HWのみ |
| VSE + **ゼロコピー** n2d letterbox | **8.50 ms** (118 fps) | **最小** (n2d_wrap + GPU) |
| VSE + memcpy + n2d letterbox | **8.71 ms** (115 fps) | memcpy分のCPU消費 |
| VSE + CPU letterbox (参考) | 182.13 ms (5.5 fps) | **CPU飽和** |

**ゼロコピーの仕組み**: `n2d_wrap()` でhbmemの物理アドレスを直接nano2Dバッファとして登録。memcpyを完全排除:

```c
// SDK提供のwrapper: create_n2d_buffer_wraper.c
// hbmem physical address → n2d_buffer_t (コピーなし)
n2d_user_memory_desc_t desc;
desc.flag = N2D_WRAP_FROM_USERMEMORY;
desc.logical = 0;                               // 必ず0
desc.physical = (n2d_uintptr_t)hb->phys_addr[0]; // hbmem物理アドレス直接
desc.size = stride * height * 3 / 2;
n2d_wrap(&desc, &handle);
n2d_buffer->handle = handle;
n2d_map(n2d_buffer);  // GPUアドレス空間にマップ
```

リファレンス実装: `/app/multimedia_samples/sample_pipeline/common/create_n2d_buffer_wraper.c`

**分析**:
- ゼロコピー (8.50ms) vs memcpy (8.71ms): 差は0.21msのみ
- **ボトルネックはコピーではなくGPU letterbox処理自体** (~1ms × 4ch + n2d_wrap/free ~0.2ms × 4ch)
- n2d_wrap/n2d_free の繰り返しコスト (VSEバッファアドレスがフレーム毎に変わるため毎回wrap必要)
- それでも**CPUはletterbox処理に一切使われない** — 8.50msはすべてGPU/HW上の処理

**出力ファイル検証**: `/tmp/vse_n2d_test/11_lb_ch*.yuv` (640x640 NV12) — YUVビューアで黒帯+映像が正しく配置されていることを確認済み

テストコード（バッファ事前確保パターン）:

```c
#include "GC820/nano2D.h"
#include "hbn_api.h"
#include "vse_cfg.h"

// ビルド: gcc -O2 -o test test.c -lNano2Dutil -lNano2D -lcam -lvpf -lhbmem -lalog -lpthread -ldl -lm

// バッファ事前確保 (ホットループ外)
n2d_buffer_t n2d_src, n2d_dst;
n2d_util_allocate_buffer(640, 360, N2D_NV12, ..., &n2d_src);
n2d_util_allocate_buffer(640, 640, N2D_NV12, ..., &n2d_dst);

// ホットループ
while (running) {
    hbn_vnode_getframe(vse_h, ch, 2000, &out);

    // hbmem → n2d コピー (TODO: 物理アドレスwrapで高速化)
    copy_hbmem_to_n2d(&out.buffer, &n2d_src, w, h);

    // nano2D letterbox (GPU実行、CPUフリー)
    n2d_fill(&n2d_dst, NULL, 0x00108080, N2D_BLEND_NONE);    // 黒帯
    n2d_rectangle_t r = {0, pad_top, 640, scaled_h};
    n2d_blit(&n2d_dst, &r, &n2d_src, NULL, N2D_BLEND_NONE);  // 中央配置
    n2d_commit();

    hbn_vnode_releaseframe(vse_h, ch, &out);
}
```

## YOLO検出: Python→C移行分析

### 現行パイプライン性能

| 処理 | 時間 | 備考 |
|------|------|------|
| ゼロコピーimport (hb_mem) | ~2ms | Python ctypes |
| 前処理 (letterbox) | ~1ms | pre-allocatedバッファ再利用 |
| BPU推論 (YOLO11n) | 8.9ms | HW (INT8) |
| 後処理 (softmax+DFL+NMS) | 5-10ms | numpy + OpenCV |
| **合計** | **16-20ms** | **50-60 FPS max** |

### Python API vs C API オーバーヘッド

| モデル | C API (hrt_model_exec) | Python API (hobot_dnn) | 差分 |
|--------|----------------------|----------------------|------|
| yolov8n | 7.7ms | 8.2ms | **+0.5ms** |
| yolo11n | 8.9ms | 9.5ms | **+0.6ms** |
| yolov13n | 45.5ms | 46.3ms | **+0.8ms** |

### C移行のコスト対効果

| 項目 | Python現状 | C移行時 | 差分 |
|------|-----------|---------|------|
| BPU推論 | 9.5ms | 8.9ms | -0.6ms |
| 前処理 | ~1ms | ~0.5ms | -0.5ms |
| 後処理 (softmax+DFL+NMS) | 5-10ms | 4-8ms | -1~2ms |
| **合計** | **16-20ms** | **14-17ms** | **-2~3ms (10-15%)** |
| 実装コスト | — | 1000行+、YOLO11n DFL新規実装 | 高 |

**結論**: C移行で得られるのは2-3ms (10-15%) だが、YOLO11n/26のDFLデコーダー・後処理のC実装が必要で保守コストが高い。**非推奨**。

### 推奨ロードマップ

| 優先度 | 施策 | 効果 | 工数 |
|--------|------|------|------|
| **高** | VSE夜間ROI (3ch HWクロップ) | 3-6ms削減 | 3-5日 |
| 中 | YOLO26本番投入 (DFL不要) | 後処理5ms→2ms | 3日 |
| 低 | nano2D NV12→RGBA (SWフォールバック改善) | MJPEG SW時のみ | 2日 |
| **非推奨** | Python→C全面移行 | 2-3ms | 2-3週間 |

### C YOLO参考実装

- BPUラッパー: `/app/multimedia_samples/sample_pipeline/common/bpu_wraper.h` (スレッド分離、キュー管理)
- YOLOv5後処理: `/app/multimedia_samples/sample_pipeline/common/yolov5_post_process.cpp` (NMS、anchor-based)
- マルチパイプ統合例: `/app/multimedia_samples/sample_pipeline/multi_pipe_crop_and_stitch/` (VSE+BPU+エンコーダー)

**注**: YOLO11n/YOLO26のDFLデコーダーのC実装は存在しない。移植する場合は `yolo_detector.py:1174-1183` の `_postprocess_legacy()` を参考に実装が必要。

## HW OSD (オンスクリーンディスプレイ)

ISP/VSEパイプライン上でHWオーバーレイを描画するAPI。

| 項目 | 値 |
|------|-----|
| サンプル | `/app/multimedia_samples/sample_osd/sample_osd.c` |
| API | `hbn_rgn_create()`, `hbn_rgn_attach_to_chn()` |
| リージョン種別 | `OVERLAY_RGN` |
| HWリージョン数 | 最大4個/VSEチャンネル（超過分はSW OSD） |
| テキスト描画 | `hbn_rgn_draw_word_t` 構造体 |
| カラー | `FONT_COLOR_ORANGE` 等のプリセット |

### Go側オーバーレイのHWオフロード分析

| 項目 | 現状 | HW OSD案 |
|------|------|----------|
| 実装場所 | `broadcaster.go` → C関数 (CGo) | ISP/VSEパイプラインにリージョンアタッチ |
| パイプライン | `libspcdev` ベース | `hbn_api` ベースへの移行が必要 |
| CPU負荷 | <0.5ms/frame | ~0ms |
| 改修規模 | — | カメラパイプライン全面改修（大規模） |

**結論**: 現行C実装のオーバーレイコスト (<0.5ms/frame) は十分低い。HW OSD利用にはパイプラインを`hbn_api`ベースへ全面改修する必要があり、ROIが低い。

**注**: `sp_display_draw_rect`, `sp_display_draw_string` が `libspcdev` にあるが、これはDisplay (HDMI出力) 用でありストリーミング用途には使えない。

## HW活用の優先度

実装状況を反映した再評価:

| 用途 | 価値 | 理由 |
|------|------|------|
| NV12→RGB変換 (GPU 2D) | 中 | nano2D `n2d_blit()` でフォーマット変換可能。OpenCLより簡潔。ただしHW JPEGがNV12直接入力のためSWフォールバック時のみ |
| NV12→RGB変換 (OpenCL) | 低 | nano2Dの方が適切。OpenCLはカーネル起動オーバーヘッドあり |
| JPEGエンコード | **解決済み** | `hb_mm_mc` HWエンコーダー実装済み (~5ms) |
| H.265移行 | 中 | HW対応済み。帯域30-50%削減。ブラウザ互換性が課題 |
| オーバーレイ描画 | 低 | CPU <0.5ms。HW OSD利用にはパイプライン全面改修が必要 |
| 画像スケーリング | 低 | nano2DまたはVPS (`sp_open_vps`) で可能だが、comic生成は低頻度 |
| モーション検出前処理 | 中（将来） | 差分・モルフォロジーをGPU 2D/OpenCLでオフロード可能 |
| AI推論 | 不適 | BPU使用 (6.75 GFLOPS GPUでは不足) |
| ビデオエンコード | 不適 | VPU使用 |

## リファレンスサンプル

### `/app/multimedia_samples/`

| ディレクトリ | 内容 |
|-------------|------|
| `sample_codec/` | H.264/H.265/JPEG/MJPEGエンコード・デコード |
| `sample_osd/` | HW OSDリージョン |
| `sample_gpu_2d/` | nano2D 2Dアクセラレーション |
| `sample_gpu_3d/` | OpenCL / GLES |
| `sample_pipeline/` | VIN→ISP→VSE→VPU/GPU統合パイプライン |
| `sample_isp/` | ISPデータ取得、RGB+IR、フィードバック |
| `sample_vse/` | Video Scaling Engine |
| `sample_gdc/` | 幾何歪み補正（魚眼、キーストーン等） |
| `sample_hbmem/` | メモリ管理（alloc, pool, share） |
| `sample_vot/` | HDMI出力 |
| `sunrise_camera/` | マルチストリーム統合例 |
| `chip_base_test/` | CPU/BPU/DDR/GPUベンチマーク |

### `/app/cdev_demo/`

| ディレクトリ | 内容 |
|-------------|------|
| `vps/` | VPS HWスケーリング・クロップデモ |
| `decode2display/` | Decoder → VPS → Display パイプライン |
| `rtsp2display/` | RTSP → VPS → Display パイプライン |

## 制約事項

- 標準V4L2デバイスノード (`/dev/video*`) によるHWアクセラレーションは利用不可
- D-Robotics独自APIを使用する必要あり
- `clEnqueueReadBuffer`は0.07 GB/sのため実用不可（必ずMap/Unmapを使用）
- GPU計算性能は6.75 GFLOPSと控えめ（メモリバウンド処理向き）
- `hb_mm_mc` バッファ数: frame=3, bitstream=3 が必須（X5ハードウェア要件）
- JPEG encoder: シングルインスタンス（instance_index=0）、スレッドセーフでないため外部mutex必須
- HW OSD: `hbn_api` ベースのパイプラインが必要（現行 `libspcdev` ベースでは利用不可）
- VPS: `sp_init_vio_module` でオブジェクト初期化必須。pipe_id/chn_num はカメラパイプラインと衝突に注意
