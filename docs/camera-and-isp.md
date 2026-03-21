# カメラ・ISP・エンコーディング リファレンス

本ドキュメントは、カメラ切り替え、ISP低照度補正、AWBチューニング、H.264ハードウェアエンコーディング、ストリーム切り替えに関する設計・実装の知見を統合したものである。

---

## 目次

1. [システム全体アーキテクチャ](#1-システム全体アーキテクチャ)
2. [カメラ切り替え (Camera Switcher)](#2-カメラ切り替え-camera-switcher)
3. [ISP低照度補正](#3-isp低照度補正)
4. [AWBチューニング (夜間カメラ)](#4-awbチューニング-夜間カメラ)
5. [H.264ハードウェアエンコーディング](#5-h264ハードウェアエンコーディング)
6. [ストリーム切り替え (Fluent Stream Switching)](#6-ストリーム切り替え-fluent-stream-switching)
7. [カメラデーモン リファクタリング](#7-カメラデーモン-リファクタリング)

---

## 1. システム全体アーキテクチャ

```
Camera Sensor (IMX219)
    |
    v
ISP Pipeline (HW): VIN -> ISP -> VSE
    |                              |
    |-- Ch0 (1920x1080) -> H.264 HW Encoder -> /pet_camera_stream (録画・WebRTC)
    |-- Ch1 (640x640)   -> YOLO検出
    └-- Ch2 (640x480)   -> MJPEG
```

### 共有メモリ構成（リファクタリング後）

| SHM名 | 構造体 | Producer | Consumer | 用途 |
|--------|--------|----------|----------|------|
| `/pet_camera_control` | `CameraControl` (8B) | switcher | camera_daemon x2 | 切り替え指示 |
| `/pet_camera_zc_0` | `ZeroCopyFrameBuffer` (~150B) | camera_daemon(0) | YOLO, switcher | DAY frame + brightness |
| `/pet_camera_zc_1` | `ZeroCopyFrameBuffer` (~150B) | camera_daemon(1) | YOLO, switcher | NIGHT frame + brightness |
| `/pet_camera_stream` | `SharedFrameBuffer` (~93MB) | active camera | streaming_server | H.264 |
| `/pet_camera_mjpeg_frame` | `SharedFrameBuffer` (~1.4MB) | camera_daemon | web_monitor | MJPEG用NV12 |
| `/pet_camera_detections` | `LatestDetectionResult` (~584B) | YOLO daemon | monitor | 検出結果 |

---

## 2. カメラ切り替え (Camera Switcher)

### 現在の設計（リファクタリング後）

単一スレッドのポーリングループ方式。旧方式のコールバック・シグナル・マルチスレッド構成を廃止。

```
camera_switcher_daemon (単一スレッド)
├── main()
│   ├── spawn_daemon(DAY)   -> camera_daemon(0)  -- 常時30fps稼働
│   ├── spawn_daemon(NIGHT) -> camera_daemon(1)  -- 常時30fps稼働
│   └── switcher_loop()     <- シンプルなポーリング
└── 共有メモリ読み書き
    ├── READ:  /pet_camera_zc_0    (DAY brightness)
    ├── READ:  /pet_camera_zc_1    (NIGHT brightness)
    └── WRITE: /pet_camera_control (active_camera_index)
```

### メインループ

```c
int switcher_loop(SwitcherContext *ctx) {
    while (ctx->running) {
        float brightness = ctx->shm_day->frame.brightness_avg;
        CameraSwitchDecision decision = camera_switcher_check_brightness(
            &ctx->switcher, brightness, ctx->active_camera);
        if (decision.should_switch) {
            shm_control_set_active(ctx->control, decision.target_camera);
            ctx->active_camera = decision.target_camera;
        }
        int interval_ms = (ctx->active_camera == DAY) ? 250 : 5000;
        usleep(interval_ms * 1000);
    }
    return 0;
}
```

### camera_daemon側の活性判定

```c
// camera_pipeline.c
bool write_active = pipeline->control_shm &&
    shm_control_get_active(pipeline->control_shm) == pipeline->camera_index;
```

### CameraControl構造体

```c
typedef struct {
    volatile int active_camera_index;  // 0=DAY, 1=NIGHT
    volatile uint32_t version;         // 変更検知用
} CameraControl;
```

### 切り替え判定パラメータ

- **DAY→NIGHT**: brightness_avg < 閾値 かつ持続時間超過
- **NIGHT→DAY**: brightness_avg > 閾値 かつ持続時間超過
- ヒステリシス付き（`camera_switcher.c` の既存ロジックを維持）

### 旧プローブ問題（解決済み）

旧方式では1-shotプローブ時に共有メモリのリングバッファが上書きされる問題があった。現在は軽量な `brightness_avg` を各カメラのZeroCopy SHMに常時更新する方式で解消。

### リファクタリング効果

| 項目 | Before | After |
|------|--------|-------|
| スレッド数 | 3 (main + active + probe) | 1 |
| コールバック | 4種類 | 0 |
| シグナル | SIGUSR1/SIGUSR2 | 不要 |
| コード行数 | ~700行 | ~200行 |

---

## 3. ISP低照度補正

### D-Robotics ISP API対応状況

| API | 関数 | 結果 |
|-----|------|------|
| AWB | `hbn_isp_set_awb_attr` | **有効** |
| 3DNR | `hbn_isp_set_3dnr_attr` | **有効** |
| 2DNR | `hbn_isp_set_2dnr_attr` | **有効** |
| Color Process | `hbn_isp_set_color_process_attr` | **無効** - API成功するが映像に反映されない |
| Gamma | `hbn_isp_set_gc_attr` | **無効** - error -65545 |
| WDR | `hbn_isp_set_wdr_attr` | **無効** - error -65545 |
| Exposure/AE | `hbn_isp_set_exposure_attr` | **無効** - 低照度時はセンサー限界で効果なし |

### 採用アーキテクチャ

ISPのHW機能（NR）＋ソフトウェアガンマ補正の組み合わせ:

```
ISP Pipeline (HW)
    |-- 3DNR: 低照度時に強化
    |-- 2DNR: 低照度時に強化
    v
VSE Ch1 (640x640 NV12)
    |
Software Gamma Correction (CPU, LUTベース)
    |-- brightness_avgに基づく適応的ガンマ選択
    v
YOLO Input
```

### ノイズリダクション設定

| Brightness Zone | 3DNR Strength | 2DNR Blend |
|-----------------|---------------|------------|
| DARK (< 50) | 120 | 0.7 |
| DIM (50-70) | 115 | 0.5 |
| NORMAL (>= 70) | 113 | 5.0 |

### 適応ガンマ補正

| brightness_avg | Gamma | 効果 |
|----------------|-------|------|
| < 20 | 0.40 | 非常に強い増輝 |
| < 35 | 0.50 | 強い増輝 |
| < 50 | 0.60 | 中程度の増輝 |
| < 65 | 0.75 | 軽い増輝 |
| < 80 | 0.85 | わずかな増輝 |
| >= 80 | 1.00 | 補正なし |

```c
// LUT生成（起動時に事前計算）
for (int i = 0; i < 256; i++) {
    float normalized = i / 255.0f;
    float corrected = powf(normalized, gamma);
    lut[i] = (uint8_t)(corrected * 255.0f + 0.5f);
}

// Y channelのみに適用 (640*640 = 409,600 pixels)
const uint8_t *lut = select_gamma_lut(brightness_avg);
if (lut) {
    for (size_t i = 0; i < y_plane_size; i++) {
        y_data[i] = lut[y_data[i]];
    }
}
```

### AE統計のビット深度

カメラごとに異なるため自動検出が必要:
- Camera 0 (Day): 8-bit (max ~255)
- Camera 1 (Night): 16-bit (max ~65535)

```c
int shift_bits = 0;
if (max_val > 4095)      shift_bits = 8;   // 16-bit -> 8-bit
else if (max_val > 255)  shift_bits = 4;   // 12-bit -> 8-bit
result->brightness_avg = (float)(raw_avg >> shift_bits);
```

### 性能

- ガンマLUT: 起動時に事前計算、ランタイムコストはほぼゼロ
- LUT適用: ~410K byteルックアップ/フレーム（高速メモリアクセス）
- ISP NR更新: ~1Hzに抑制

### 関連ファイル

- `src/capture/camera_pipeline.c` - 適応ガンマ補正
- `src/capture/isp_brightness.c` - ISPノイズリダクション制御
- `src/capture/isp_lowlight_profile.h` - プロファイル定義

---

## 4. AWBチューニング (夜間カメラ)

### 背景

夜間IRカメラ（Camera 1, IMX219, IRカットフィルタなし）はAWB Autoだとゲインがドリフトし、映像が紫色や青色になる。IR映像には意味のある色情報がないため、AWB Manualで固定する。

### 採用設定

```
AWB Mode: MANUAL
rgain:  1.8
grgain: 1.8
gbgain: 1.8
bgain:  2.34
```

- 色味: R:G:B = 1:1:1.3 比率（寒色系、暗視カメラらしい印象）
- 暗部: 全体ゲイン1.8倍で暗部が十分に視認可能
- ノイズ: 3DNR=128との組み合わせで許容範囲

### 重要な制約

**AWBゲイン値は1.0以上が必須**。1.0未満を指定すると error -65545 が返る。

### 設定タイミング

AWB Manual設定は **ISPがフレーム処理を開始してから約1秒後（~30フレーム後）** に行う必要がある。`pipeline_create` 時や `vflow_start` 直後では、ISPのAWB初期化処理に上書きされて効かない。

```c
// camera_pipeline.c の pipeline_run 内
if (frame_count == 30) {
    // ここでAWB Manual設定を適用
}
```

### チューニング方法

```bash
# インタラクティブモード
./build/test_awb_tuning --camera 1
# awb> m 1.8 1.8 2.34   <- 設定
# awb> s my_test         <- フレーム保存
# awb> d                 <- 現在値ダンプ
```

### 調整ポイント

| パラメータ | 現在値 | 調整方向 |
|-----------|--------|----------|
| B/R比率 | 1.3 | 青み強化: 1.4~1.5 / ニュートラル: 1.0 |
| 全体ゲイン | 1.8 | 明るく: 2.0（ノイズ増加とトレードオフ） |

---

## 5. H.264ハードウェアエンコーディング

### libspcdev概要

D-Roboticsの統一コーデックライブラリ。VIO・Encoder・Decoderを単一ライブラリに統合。

### 基本パイプライン

```c
// 1. 初期化
void *vio_object = sp_init_vio_module();
void *encoder_object = sp_init_encoder_module();

// 2. カメラオープン
sp_open_camera_v2(vio_object, camera_index, -1, 1, &parms, &width, &height);

// 3. エンコーダー起動
sp_start_encode(encoder_object, 0, SP_ENCODER_H264, width, height, bitrate);

// 4. ゼロコピーバインディング
sp_module_bind(vio_object, SP_MTYPE_VIO, encoder_object, SP_MTYPE_ENCODER);

// 5. キャプチャループ
while (running) {
    int size = sp_encoder_get_stream(encoder_object, buffer);
    if (size > 0) {
        // 共有メモリに書き込み (format=3)
        shm_frame_buffer_write(shm, &frame);
    }
}

// 6. クリーンアップ
sp_module_unbind(vio, SP_MTYPE_VIO, encoder, SP_MTYPE_ENCODER);
sp_stop_encode(encoder_object);
sp_vio_close(vio_object);
sp_release_encoder_module(encoder_object);
sp_release_vio_module(vio_object);
```

### ビットレート制限

**D-Robotics X5のH.264 HWエンコーダーには700 kbps (700000 bps) のハード制限がある。**

```c
#define DEFAULT_BITRATE  600000  // 600 kbps (安全マージン含む)
```

- 100~700 kbps: 動作確認済み
- 750 kbps以上: エラー (`Invalid h264 bit rate parameters. Should be [0, 700000]`)
- 回避方法なし（ソフトウェアエンコーダー以外）

### フレームフォーマット

```c
// shared_memory.h
int format;  // 0=JPEG, 1=NV12, 2=RGB, 3=H264
```

H.264フレームサイズ:
- キーフレーム (I): 30-35 KB
- 予測フレーム (P): 5-10 KB
- `MAX_FRAME_SIZE` (3MB) で十分

### NV12取得API

**重要**: `sp_vio_get_yuv()` ではなく `sp_vio_get_frame()` を使用すること。前者はD-Robotics APIの出力フォーマットが標準NV12と不一致で、OpenCVの色変換が失敗する。

### VIOフレーム取得API一覧

| 関数 | 用途 |
|------|------|
| `sp_vio_get_frame()` | NV12フレーム取得（推奨） |
| `sp_vio_get_yuv()` | YUV取得（色変換問題あり） |
| `sp_vio_get_raw()` | RAWフレーム取得 |

### libspcdev API制約

- GOP設定パラメータなし（`sp_start_encode()` は width, height, bitrate のみ）
- 動的キーフレーム要求API なし（`sp_encoder_request_idr()` 等は存在しない）
- エンコーダー詳細設定構造体なし
- ストリームメタデータ取得API なし
- デフォルトGOP: **14フレーム（約470ms @ 30fps）**

### パフォーマンス比較

| 項目 | JPEG (旧) | H.264 (新) |
|------|-----------|------------|
| CPU使用率 | ~35% | ~15% (57%削減) |
| メモリ使用量 | ~80 MB | ~60 MB (25%削減) |
| ビットレート | ~15 Mbps | ~8 Mbps (47%削減) |

### ビルド設定

```makefile
LDLIBS_COMMON := -lrt
LDLIBS_DROBOTICS := $(LDLIBS_COMMON) -lpthread -lspcdev
# 削除: -ljpeg -lcam -lvpf -lhbmem
```

### トラブルシューティング

| 問題 | 原因 | 解決策 |
|------|------|--------|
| `sp_open_camera_v2` 失敗 | 旧プロセスが残っている | `pkill -f camera_daemon; make cleanup` |
| VLC再生不可 | SPS/PPS欠落 | キーフレームから録画開始する |
| 0バイト録画 | `frame.size` 属性不在 | `bytes(frame.data)` を使用 |
| 画像が緑/マゼンタ | `sp_vio_get_yuv()` 使用 | `sp_vio_get_frame()` に変更 |

### 録画コマンド

```bash
curl -X POST http://localhost:8080/api/recording/start
sleep 10
curl -X POST http://localhost:8080/api/recording/stop
ffplay recordings/recording_*.h264
```

---

## 6. ストリーム切り替え (Fluent Stream Switching)

### 課題

H.264デコーダーはキーフレーム（I-frame）から再生を開始する必要がある。カメラ切り替え時にP-frameから配信すると画面が乱れる。

### 採用方式: ウォームアップ延長型

libspcdevにGOP制御・動的キーフレーム要求APIが存在しないため、ウォームアップ期間を延長してキーフレーム遭遇を保証する方式を採用。

```c
// camera_switcher_daemon.c
cfg.warmup_frames = 15;  // 約500ms @ 30fps
```

**根拠**:
- デフォルトGOP: 14フレーム (470ms)
- warmup: 15フレーム (500ms)
- キーフレーム遭遇確率: ~100%
- 実装: 1行変更のみ

### 検討・却下された代替案

| 案 | 理由 |
|----|------|
| A. SIGUSR2でIDR要求 | libspcdevに動的キーフレーム要求APIなし |
| B. NV12/H.264タイムスタンプ同期 | キーフレーム問題は未解決 |
| C. バッファオーバーラップ | クライアント実装が複雑 |

### H.264キーフレーム判定（参考）

```c
static bool is_h264_keyframe(const uint8_t *data, size_t size) {
    if (size < 5) return false;
    // Annex-B start code: 00 00 00 01
    if (data[0] == 0x00 && data[1] == 0x00 &&
        data[2] == 0x00 && data[3] == 0x01) {
        uint8_t nal_type = data[4] & 0x1F;
        return (nal_type == 5);  // IDR frame
    }
    return false;
}
```

---

## 7. カメラデーモン リファクタリング

### 目標: 3層アーキテクチャ

```
Layer 3: Application (camera_daemon_main.c)
    - main(), signal handling, lifecycle
        |
Layer 2: Pipeline (camera_pipeline.c/h, decoder_thread.c/h)
    - Pipeline orchestration, capture loop, frame routing
        |
Layer 1: HAL (vio_lowlevel.c/h, encoder_lowlevel.c/h, decoder_lowlevel.c/h)
    - VIN/ISP/VSE pipeline (hbn_*), H.264 encode/decode (hb_mm_mc_*)
```

### 主要API設計

```c
// Layer 1: VIO
int vio_create(vio_context_t *ctx, int camera_index, int width, int height, int fps);
int vio_get_frame(vio_context_t *ctx, hbn_vnode_image_t *frame, int timeout_ms);

// Layer 1: Encoder
int encoder_create(encoder_context_t *ctx, int camera_index, int w, int h, int fps, int bitrate);
int encoder_encode_frame(encoder_context_t *ctx, const uint8_t *nv12_y, const uint8_t *nv12_uv,
                          uint8_t **h264_data, size_t *h264_size);

// Layer 2: Pipeline
int pipeline_create(camera_pipeline_t *p, int cam_idx, int w, int h, int fps, int bitrate,
                     const char *shm_h264_name);
int pipeline_run(camera_pipeline_t *p);  // Main capture loop
```

### 進捗

- Phase 1 (HAL層): PoC完了（vio, encoder実装検証済み）
- Phase 2-4: 未着手

---

## 参考情報

### ヘッダー・ライブラリ

| パス | 内容 |
|------|------|
| `/usr/include/sp_codec.h`, `sp_vio.h` | libspcdev API |
| `/usr/lib/libspcdev.so` | libspcdev本体 |
| `/usr/include/hbn_isp_api.h` | ISP API |
| `/app/cdev_demo/vio2encoder/vio2encoder.c` | libspcdevサンプル |

### 環境変数

| 変数 | デフォルト | 用途 |
|------|-----------|------|
| `SHM_NAME_NV12` | - | NV12共有メモリ名 |
| `SHM_NAME_H264` | - | H.264共有メモリ名 |
| `H264_BITRATE` | 600000 | H.264ビットレート (bps) |
| `FRAME_INTERVAL_MS` | 0 | フレーム間隔制限 |

### デバッグコマンド

```bash
# 共有メモリ確認
ls -lh /dev/shm/pet_camera_*

# GOP構造の解析
ffprobe -v error -select_streams v:0 -show_entries frame=pict_type \
  -of csv=p=0 recording.h264 | head -50 | nl

# ISP統計確認
./build/test_isp_lowlight --camera 0 --dump-stats

# AWBテスト
./build/test_awb_tuning --camera 1

# プロファイリング
uv run scripts/profile_shm.py
```
