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
