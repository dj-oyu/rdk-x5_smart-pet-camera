# Camera Daemon リファクタリング計画

## 現状の問題点

### camera_poc_lowlevel.c (639行)
- VIO管理、Encoder管理、メインループが混在
- 再利用性が低い

### camera_daemon_drobotics.c (886行)
- High-level API (sp_*) とデコーダースレッドが混在
- Low-level APIへの移行時に全体を書き換える必要がある

## 提案: 3層アーキテクチャ

```
┌─────────────────────────────────────────┐
│  Layer 3: Application Layer             │
│  - camera_daemon_main.c                 │
│    - main(), signal handling            │
│    - command line parsing               │
│    - lifecycle management               │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Layer 2: Pipeline Layer                │
│  - camera_pipeline.c/h                  │
│    - Pipeline orchestration             │
│    - Capture loop                       │
│    - Frame routing (SHM)                │
│  - decoder_thread.c/h                   │
│    - H.264 → NV12 decoding              │
│    - I-frame detection                  │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Layer 1: Hardware Abstraction Layer    │
│  - vio_lowlevel.c/h                     │
│    - VIN/ISP/VSE pipeline (hbn_*)       │
│    - NV12 frame acquisition             │
│  - encoder_lowlevel.c/h                 │
│    - H.264 encoding (hb_mm_mc_*)        │
│    - Bitstream management               │
│  - decoder_lowlevel.c/h                 │
│    - H.264 decoding (hb_mm_mc_*)        │
│    - NV12 output                        │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Shared Infrastructure                  │
│  - shared_memory.c/h (既存)             │
│  - common_types.h (新規)                │
└─────────────────────────────────────────┘
```

## ファイル構成

### Layer 1: Hardware Abstraction Layer (HAL)

#### vio_lowlevel.c/h
**責務**: Low-level VIOパイプライン管理
```c
// カメラコンテキスト
typedef struct vio_context_t {
    camera_handle_t cam_fd;
    hbn_vnode_handle_t vin_handle;
    hbn_vnode_handle_t isp_handle;
    hbn_vnode_handle_t vse_handle;
    hbn_vflow_handle_t vflow_fd;
    // Config
    int camera_index;
    int width, height, fps;
} vio_context_t;

// API
int vio_create(vio_context_t *ctx, int camera_index, int width, int height, int fps);
int vio_start(vio_context_t *ctx);
int vio_get_frame(vio_context_t *ctx, hbn_vnode_image_t *frame, int timeout_ms);
int vio_release_frame(vio_context_t *ctx, hbn_vnode_image_t *frame);
void vio_stop(vio_context_t *ctx);
void vio_destroy(vio_context_t *ctx);
```

#### encoder_lowlevel.c/h
**責務**: Low-level H.264エンコーダー管理
```c
// エンコーダーコンテキスト
typedef struct encoder_context_t {
    media_codec_context_t codec_ctx;
    int width, height, fps, bitrate;
    int camera_index;
} encoder_context_t;

// API
int encoder_create(encoder_context_t *ctx, int camera_index, int width, int height, int fps, int bitrate);
int encoder_start(encoder_context_t *ctx);
int encoder_encode_frame(encoder_context_t *ctx, const uint8_t *nv12_y, const uint8_t *nv12_uv,
                          uint8_t **h264_data, size_t *h264_size);
void encoder_stop(encoder_context_t *ctx);
void encoder_destroy(encoder_context_t *ctx);
```

#### decoder_lowlevel.c/h
**責務**: Low-level H.264デコーダー管理
```c
// デコーダーコンテキスト
typedef struct decoder_context_t {
    media_codec_context_t codec_ctx;
    int width, height;
} decoder_context_t;

// API
int decoder_create(decoder_context_t *ctx, int width, int height);
int decoder_start(decoder_context_t *ctx);
int decoder_decode_frame(decoder_context_t *ctx, const uint8_t *h264_data, size_t h264_size,
                          uint8_t **nv12_y, uint8_t **nv12_uv);
void decoder_stop(decoder_context_t *ctx);
void decoder_destroy(decoder_context_t *ctx);
```

### Layer 2: Pipeline Layer

#### camera_pipeline.c/h
**責務**: VIO + Encoder統合、キャプチャループ
```c
// パイプラインコンテキスト
typedef struct camera_pipeline_t {
    vio_context_t vio;
    encoder_context_t encoder;
    SharedFrameBuffer *shm_h264;
    volatile bool *running;
    int camera_index;
} camera_pipeline_t;

// API
int pipeline_create(camera_pipeline_t *pipeline, int camera_index,
                     int width, int height, int fps, int bitrate,
                     const char *shm_h264_name);
int pipeline_start(camera_pipeline_t *pipeline);
int pipeline_run(camera_pipeline_t *pipeline);  // Main capture loop
void pipeline_stop(camera_pipeline_t *pipeline);
void pipeline_destroy(camera_pipeline_t *pipeline);
```

#### decoder_thread.c/h
**責務**: デコードスレッド（H.264 → NV12）
```c
// デコードスレッドコンテキスト
typedef struct decoder_thread_t {
    decoder_context_t decoder;
    SharedFrameBuffer *shm_h264;  // Input
    SharedFrameBuffer *shm_nv12;  // Output
    pthread_t thread;
    volatile bool *running;
    uint32_t decode_interval_ms;
} decoder_thread_t;

// API
int decoder_thread_create(decoder_thread_t *ctx, const char *shm_h264_name,
                           const char *shm_nv12_name, int width, int height,
                           uint32_t decode_interval_ms);
int decoder_thread_start(decoder_thread_t *ctx, volatile bool *running);
void decoder_thread_stop(decoder_thread_t *ctx);
void decoder_thread_destroy(decoder_thread_t *ctx);
```

### Layer 3: Application Layer

#### camera_daemon_main.c
**責務**: エントリーポイント、ライフサイクル管理
```c
int main(int argc, char *argv[]) {
    // 1. Parse arguments
    // 2. Signal handling
    // 3. Create pipeline
    // 4. Create decoder thread (if needed)
    // 5. Start pipeline
    // 6. Wait for signal
    // 7. Cleanup
}
```

## 移行計画

### Phase 1: HAL層の作成 ✅ (PoC完了)
- [x] vio_lowlevel.c/h の実装（PoCで検証済み）
- [x] encoder_lowlevel.c/h の実装（PoCで検証済み）
- [ ] decoder_lowlevel.c/h の実装

### Phase 2: Pipeline層の抽出
- [ ] camera_pipeline.c/h の作成（PoCコードをリファクタ）
- [ ] decoder_thread.c/h の作成（既存コードから抽出）

### Phase 3: Application層の簡素化
- [ ] camera_daemon_main.c の作成（シンプルなmain）
- [ ] 既存のcamera_daemon_drobotics.cを置き換え

### Phase 4: テスト
- [ ] 1カメラ動作確認
- [ ] 2カメラ同時動作確認
- [ ] 30fps達成確認

## メリット

### 1. 関心の分離
- ハードウェア操作とビジネスロジックが明確に分離
- テストしやすい（各レイヤーを独立してテスト可能）

### 2. 再利用性
- VIO/Encoder/Decoderは他のプロジェクトでも利用可能
- Pipeline層を変更せずにHAL層を差し替え可能（High-level ↔ Low-level）

### 3. 保守性
- 各ファイルが200-300行程度に収まる
- 変更の影響範囲が限定される

### 4. 拡張性
- 新しいハードウェア（カメラ、エンコーダー）の追加が容易
- Multi-threading最適化が容易（Pipeline層で制御）

## ファイルサイズ見積もり

| ファイル | 行数 | 責務 |
|---------|------|------|
| vio_lowlevel.c | ~250 | VIO操作 |
| encoder_lowlevel.c | ~200 | Encoder操作 |
| decoder_lowlevel.c | ~200 | Decoder操作 |
| camera_pipeline.c | ~200 | Pipeline制御 |
| decoder_thread.c | ~150 | デコードスレッド |
| camera_daemon_main.c | ~100 | main + args |
| **合計** | **~1100** | **明確な境界** |

現状の1525行（PoC + 既存）と同規模だが、構造化により保守性が大幅に向上。

## ハードウェア制約事項

### H.264 Encoder制限

**ビットレート上限**: **700 kbps (700000 bps)**

実測結果:
- 100 kbps ~ 700 kbps: ✓ 動作確認
- 750 kbps以上: ✗ エラー (`Invalid h264 bit rate parameters. Should be [0, 700000]`)

検証日: 2025-12-27
検証スクリプト: `scripts/test_bitrate_limits.sh`

推奨設定:
```c
#define DEFAULT_BITRATE  600000  // 600 kbps (安全マージン含む)
```

注意事項:
- D-Robotics X5のH.264 HWエンコーダーには700kbpsのハード制限がある
- この制限はファームウェア/ハードウェアレベルで設定されている
- 回避方法なし（ソフトウェアエンコーダーを使う以外）
