# Zero-Copy Shared Memory 設計 v4

## 概要

カメラパイプラインからコンシューマへのフレーム転送でmemcpyを排除し、VIOバッファのshare_idを直接共有する。エンコーダ入力は`external_frame_buf`で、エンコーダ出力も`fd`から`share_id`を取得してzero-copy化。

## 設計原則

1. **両カメラのフレームが常に取得可能** - active/inactive に関係なく
2. **アクティブカメラは共有メモリで公開** - シグナル不要
3. **brightness は ZeroCopyFrame に含める** - 別途 shm_brightness 不要
4. **NV12 も H.264 も zero-copy で取得可能**

## 現状のアーキテクチャ

### カメラデーモン構成

```
camera_switcher_daemon
    │
    ├── camera_daemon(0: DAY)  ── 常時30fps稼働
    │
    └── camera_daemon(1: NIGHT) ── 常時30fps稼働

※両カメラは常時稼働、シグナルで active/inactive を切り替え
```

### 現状のデータフロー (memcpyあり)

```
VIO Ch0 ──memcpy──▶ Active NV12共有メモリ ──▶ streaming-server
    │
    └──memcpy──▶ エンコーダキュー ──memcpy──▶ HWエンコーダ ──memcpy──▶ H.264共有メモリ

VIO Ch1 ──memcpy──▶ YOLO共有メモリ ──▶ YOLO daemon

VIO Ch2 ──memcpy──▶ MJPEG共有メモリ ──▶ web_monitor
```

**問題: 約38MB/s + エンコーダ460KB/frame のCPU memcpy**

## 新設計: Zero-Copy + デュアルカメラ

### アーキテクチャ

```
Camera 0                              Camera 1
    │                                     │
    ▼                                     ▼
VIO Ch0 ─────────────────────────────VIO Ch0
    │                                     │
    ├─▶ share_id ──┐                      ├─▶ share_id ──┐
    │              │                      │              │
    │              ▼                      │              ▼
    │    ZeroCopy共有メモリ               │    (同一共有メモリ)
    │    ├─ active_camera_index           │
    │    ├─ frames[0] (Camera 0)          │
    │    └─ frames[1] (Camera 1) ◀────────┘
    │              │
    │              ▼
    │         Consumer
    │    (active_indexで選択)
    │
    └─▶ HWエンコーダ (external_frame_buf)
              │
              ▼
         H.264共有メモリ (memcpy ~30KB - 許容)
```

### チャンネル構成の変更

| Channel | 現状 | 新設計 |
|---------|------|--------|
| Ch0 | Active NV12 (640x480) | Active NV12 + エンコーダ入力 (zero-copy) |
| Ch1 | YOLO入力 (640x360) | YOLO入力 (zero-copy) |
| Ch2 | MJPEG入力 (640x480) | **廃止** (Ch0を使用) |

### データ構造

```c
#define NUM_CAMERAS 2
#define ZEROCOPY_MAX_PLANES 2

typedef struct {
    // Frame metadata
    uint64_t frame_number;
    struct timespec timestamp;
    int width;
    int height;

    // Brightness
    float brightness_avg;
    uint8_t correction_applied;

    // VIO buffer (from hb_mem_graphic_buf_t)
    int32_t share_id[ZEROCOPY_MAX_PLANES];
    uint64_t plane_size[ZEROCOPY_MAX_PLANES];
    uint64_t phys_addr[ZEROCOPY_MAX_PLANES];  // エンコーダ用
    int32_t plane_cnt;

    // Sync
    volatile uint32_t version;
    volatile uint8_t consumed;
} ZeroCopyFrame;

typedef struct {
    volatile int active_camera_index;
    sem_t new_frame_sem[NUM_CAMERAS];
    sem_t consumed_sem[NUM_CAMERAS];
    ZeroCopyFrame frames[NUM_CAMERAS];
} ZeroCopyDualFrameBuffer;
```

### エンコーダ Zero-Copy

```c
// encoder_lowlevel.c - 設定変更
encoder->video_enc_params.external_frame_buf = 1;  // 外部バッファ使用

// encoder_encode_frame() - VIOバッファを直接渡す
input_buffer.vframe_buf.phy_ptr[0] = phy_addr_y;   // VIOの物理アドレス
input_buffer.vframe_buf.phy_ptr[1] = phy_addr_uv;
input_buffer.vframe_buf.vir_ptr[0] = vir_addr_y;
input_buffer.vframe_buf.vir_ptr[1] = vir_addr_uv;
// memcpy不要！
```

## モジュール依存関係

```
shared_memory.h/c (データ構造)
        │
        ▼
camera_pipeline.c (share_id書込み)
        │
        ├────────────────┬─────────────────┐
        ▼                ▼                 ▼
encoder_lowlevel.c   hb_mem_bindings.py  (Go bindings)
(external_frame_buf)  (Python用)          (将来)
        │                │
        ▼                ▼
encoder_thread.c     yolo_detector_daemon.py
                         │
                         ▼
                     web_monitor (Python)
```

## 開発パス

### Phase 1: 基盤 (依存関係なし)

**目標**: 共有メモリ構造の定義とPythonバインディング

```
1.1 shared_memory.h
    └─ ZeroCopyFrame, ZeroCopyDualFrameBuffer 追加

1.2 shared_memory.c
    └─ shm_zerocopy_create/open/close API追加

1.3 hb_mem_bindings.py (新規)
    └─ hb_mem_import_com_buf のctypesラッパー
    └─ テスト: 既存share_idでバッファマップ確認
```

**検証**: Pythonからhb_mem_importが動作することを確認

### Phase 2: Producer側 (YOLO Ch1)

**目標**: camera_pipelineがshare_idを書き込む

```
2.1 camera_pipeline.c
    └─ YOLO (Ch1) のwrite_active制限を外す
    └─ share_id + phys_addr を ZeroCopyFrame に書込み
    └─ 従来のmemcpy版と並行稼働 (フォールバック)

2.2 real_shared_memory.py
    └─ ZeroCopyDualFrameBuffer 読み取り対応
```

**検証**: 両カメラのshare_idが共有メモリに書かれることを確認

### Phase 3: Consumer側 (YOLO daemon)

**目標**: YOLO daemonがzero-copyで読み取り

```
3.1 yolo_detector_daemon.py
    └─ active_camera_index確認
    └─ hb_mem_importでバッファマップ
    └─ consumed通知

3.2 yolo_detector.py
    └─ detect_nv12()がマップ済みバッファを受け取れるよう調整
```

**検証**: YOLO推論がzero-copyで動作、memcpy削減を確認

### Phase 4: エンコーダ最適化

**目標**: VIO → エンコーダのmemcpy削除

```
4.1 encoder_lowlevel.c
    └─ external_frame_buf = 1 設定
    └─ encode_frame_zerocopy() 新API (phys_addr受け取り)

4.2 encoder_thread.c
    └─ Y/UVコピーキュー廃止
    └─ share_id/phys_addrをキューに入れる
    └─ VIOバッファのreleaseタイミング調整

4.3 camera_pipeline.c
    └─ encoder_thread への受け渡し変更
```

**検証**: エンコード動作確認、CPU負荷測定

### Phase 5: Ch2廃止 & web_monitor対応

**目標**: MJPEGチャンネル廃止、Active NV12を共用

```
5.1 vio_lowlevel.c
    └─ VSE Ch2 設定削除 (オプション)

5.2 camera_pipeline.c
    └─ Ch2 関連コード削除

5.3 web_monitor
    └─ Active NV12のzero-copyを使用
```

**検証**: web_monitorが正常動作

### Phase 6: streaming-server (将来)

**目標**: Go言語からzero-copy

```
6.1 Go用hb_memバインディング (CGO)
6.2 streaming-server対応
```

## 各Phaseの成果物とリスク

| Phase | 成果物 | リスク | ロールバック |
|-------|--------|--------|-------------|
| 1 | 共有メモリ構造、Pyバインディング | 低 | 既存コードに影響なし |
| 2 | share_id書込み | 中 | memcpy版と並行稼働 |
| 3 | YOLO zero-copy | 中 | 従来パスにフォールバック |
| 4 | エンコーダ最適化 | 高 | external_frame_buf無効化 |
| 5 | Ch2廃止 | 低 | Ch2復活可能 |
| 6 | Go対応 | 中 | Python版で代替 |

## 期待効果

| 項目 | Before | After |
|------|--------|-------|
| YOLO memcpy | 346KB × 30fps = 10MB/s | **0** |
| Active NV12 memcpy | 460KB × 30fps = 14MB/s | **0** |
| MJPEG memcpy | 460KB × 30fps = 14MB/s | **0** (Ch2廃止) |
| エンコーダ入力 memcpy | 460KB × 30fps = 14MB/s | **0** |
| H.264出力 memcpy | ~30KB × 30fps = 1MB/s | 1MB/s (維持) |
| **合計** | **~53MB/s** | **~1MB/s** |

## 共有メモリ名

| 名前 | 用途 |
|------|------|
| `/pet_camera_yolo_zc` | YOLO入力 zero-copy (両カメラ) |
| `/pet_camera_active_zc` | Active NV12 zero-copy (両カメラ) |
| `/pet_camera_stream` | H.264出力 (従来通りmemcpy) |

## H.264 出力の Zero-Copy

### エンコーダ出力バッファ構造

```c
// SDK の mc_video_stream_buffer_info_t
typedef struct {
    hb_u8 *vir_ptr;    // 仮想アドレス
    hb_u64 phy_ptr;    // 物理アドレス
    hb_u32 size;       // サイズ
    hb_s32 fd;         // ION fd ← share_id 取得に使用
    ...
} mc_video_stream_buffer_info_t;
```

### fd から share_id を取得

```c
// hb_mem API
int32_t hb_mem_get_com_buf(int32_t fd, hb_mem_common_buf_t *buf);
// → buf->share_id でプロセス間共有可能
```

### H.264 Zero-Copy 実装

```c
// encoder_lowlevel.c
int encoder_encode_frame_zerocopy(encoder_context_t *ctx,
                                   uint64_t phy_addr_y, uint64_t phy_addr_uv,
                                   int32_t *h264_share_id_out,
                                   size_t *h264_size_out) {
    // 1. 入力: VIO バッファの物理アドレスを直接渡す (memcpy 不要)
    input_buffer.vframe_buf.phy_ptr[0] = phy_addr_y;
    input_buffer.vframe_buf.phy_ptr[1] = phy_addr_uv;
    hb_mm_mc_queue_input_buffer(&ctx->codec_ctx, &input_buffer, timeout);

    // 2. 出力: エンコード結果を取得
    hb_mm_mc_dequeue_output_buffer(&ctx->codec_ctx, &output_buffer, &info, timeout);

    // 3. fd から share_id を取得 (memcpy 不要)
    hb_mem_common_buf_t buf;
    hb_mem_get_com_buf(output_buffer.vstream_buf.fd, &buf);
    *h264_share_id_out = buf.share_id;
    *h264_size_out = output_buffer.vstream_buf.size;

    // 4. 出力バッファは Consumer が consumed を通知するまで保持
    return 0;
}
```

### H.264 ZeroCopyFrame 構造

```c
typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int32_t share_id;           // H.264 バッファの share_id
    uint64_t size;              // H.264 データサイズ
    uint8_t is_keyframe;        // IDR フレームか
    volatile uint32_t version;
    volatile uint8_t consumed;
} ZeroCopyH264Frame;

typedef struct {
    volatile int active_camera_index;
    sem_t new_frame_sem[NUM_CAMERAS];
    sem_t consumed_sem[NUM_CAMERAS];
    ZeroCopyH264Frame frames[NUM_CAMERAS];
} ZeroCopyH264Buffer;
```

### Consumer 側 (streaming-server)

```c
// Go または C から
hb_mem_common_buf_t in_buf = { .share_id = frame->share_id };
hb_mem_common_buf_t out_buf;
hb_mem_import_com_buf(&in_buf, &out_buf);

// H.264 データに直接アクセス
uint8_t *h264_data = (uint8_t *)out_buf.virt_addr;
size_t h264_size = frame->size;

// WebRTC に送信...

// 完了通知
hb_mem_free_buf(&out_buf);
frame->consumed = 1;
sem_post(&buffer->consumed_sem[camera_index]);
```

## Camera Switcher Daemon の簡素化

### 現状の問題点

```
現在のアーキテクチャ:
┌─────────────────────────────────────────────────────────────┐
│ camera_switcher_daemon                                       │
│   ├── active_thread (フレーム取得、brightness チェック)      │
│   ├── probe_thread (非アクティブカメラの brightness)         │
│   ├── capture_active_frame_cb (コールバック)                 │
│   ├── capture_probe_frame_cb (コールバック)                  │
│   ├── wait_for_new_frame_cb (セマフォ待ち)                   │
│   └── シグナル送信 (SIGUSR1/SIGUSR2 でカメラ切り替え)        │
└─────────────────────────────────────────────────────────────┘

問題:
- 複雑なコールバック機構
- シグナルベースのカメラ切り替え
- shm_brightness という別の共有メモリ
- probe_thread の存在意義が薄い
```

### 新設計: シンプルなポーリング

```
新アーキテクチャ:
┌─────────────────────────────────────────────────────────────┐
│ camera_switcher_daemon (単一スレッド)                        │
│                                                              │
│   while (running) {                                          │
│       // DAY カメラの brightness を直接読み取り              │
│       day_frame = read_zerocopy_shm("/pet_camera_zc_0");     │
│       brightness = day_frame.brightness_avg;                 │
│                                                              │
│       // 切り替え判定                                        │
│       if (should_switch_to_night(brightness)) {              │
│           control->active_camera_index = NIGHT;              │
│       } else if (should_switch_to_day(brightness)) {         │
│           control->active_camera_index = DAY;                │
│       }                                                      │
│                                                              │
│       // チェック間隔は状況に応じて変化                       │
│       // DAY active: 短い (暗くなったらすぐ検知)             │
│       // NIGHT active: 長い (明るくなるまで待つ)             │
│       sleep(check_interval);                                 │
│   }                                                          │
└─────────────────────────────────────────────────────────────┘
```

### 削除できるもの

| コンポーネント | 理由 |
|---------------|------|
| `probe_thread` | DAY カメラの ZeroCopyFrame から直接 brightness 取得 |
| `active_thread` | 単一ループで十分 |
| `capture_active_frame_cb` | 共有メモリを直接読む |
| `capture_probe_frame_cb` | 共有メモリを直接読む |
| `wait_for_new_frame_cb` | 不要 (ポーリングで十分) |
| `shm_brightness` | ZeroCopyFrame.brightness_avg で代替 |
| `SIGUSR1/SIGUSR2` | active_camera_index の書き換えで代替 |
| `probe_requested_flag` | 不要 |
| `camera_switcher_runtime.c/h` | 大幅に簡素化可能 |

### カメラデーモン側の変更

```c
// camera_daemon_main.c - 簡素化
while (running) {
    // 常にフレームを取得・書き込み
    vio_get_frame(&vio, &frame);
    write_zerocopy_shm(my_shm, &frame, brightness);

    // アクティブかどうかは共有メモリで確認
    if (control->active_camera_index == my_camera_id) {
        // H.264 エンコード・書き込み
        encoder_encode_frame_zerocopy(...);
        write_h264_zerocopy_shm(h264_shm, ...);
    }

    vio_release_frame(&vio, &frame);
}
```

### 期待効果

| 項目 | Before | After |
|------|--------|-------|
| スレッド数 | 2 (active + probe) | 1 |
| コールバック | 4種類 | 0 |
| シグナル | SIGUSR1/SIGUSR2 | 不要 |
| 共有メモリ | shm_brightness + 複数 | ZeroCopyFrame のみ |
| コード行数 | camera_switcher_runtime.c ~200行 | ~50行 |
| 遅延 | シグナル伝搬 + コールバック | 即座 (次フレームから) |

## カメラデーモンの省電力設計

### セマフォベースのスリープ

ビジーループを排除し、セマフォで必要な時だけ起床する設計。

```
共有メモリ /pet_camera_control:
  - active_camera_index
  - sem_t wakeup_sem[2]        // カメラ起床用
  - sem_t brightness_req_sem   // brightness 要求用 (DAY 向け)
  - sem_t brightness_updated_sem  // switcher 通知用

DAY カメラ:
  while running:
    if active:
      sem_wait(&new_frame_sem)   // VIO から新フレーム通知待ち
      process_frame()            // NV12 + H.264
    else:
      sem_timedwait(&brightness_req_sem, 2秒)  // 要求 or タイムアウト
      vio_get_frame()
      write_brightness()
      sem_post(&brightness_updated_sem)
      vio_release_frame()

NIGHT カメラ:
  while running:
    sem_wait(&wakeup_sem[NIGHT])  // 起床待ち (inactive 時はここでブロック)
    vio_start()                   // パイプライン再開

    while active && running:
      sem_wait(&new_frame_sem)
      process_frame()

    vio_stop()  // inactive になったらパイプライン停止

camera_switcher:
  while running:
    interval = (active == DAY) ? 250ms : 5秒
    sem_timedwait(&brightness_updated_sem, interval)
    brightness = read_from_shm()

    if should_switch():
      control->active_camera_index = new_camera
      sem_post(&wakeup_sem[new_camera])  // 新カメラ起床
```

### カメラ動作モード

| Active Camera | DAY カメラ | NIGHT カメラ |
|---------------|------------|--------------|
| DAY | フル稼働 (30fps, NV12+H.264) | 完全スリープ (CPU 0%) |
| NIGHT | brightness のみ (2秒おき) | フル稼働 (30fps, NV12+H.264) |

### Probe 間隔テーブル

| 状況 | 動作 | 間隔 | セマフォ |
|------|------|------|----------|
| DAY active, brightness 取得 | ISP から取得、SHM 書込み | 8 frames (~267ms) | new_frame_sem |
| DAY inactive, brightness 取得 | ISP から取得、SHM 書込み | 2秒 | brightness_req_sem (timedwait) |
| NIGHT active | フル稼働 | 30fps | new_frame_sem |
| NIGHT inactive | VIO 停止、スリープ | - | wakeup_sem (無期限待ち) |
| Switcher (DAY active) | DAY brightness 監視 | 250ms | brightness_updated_sem |
| Switcher (NIGHT active) | DAY brightness 監視 | 5秒 | brightness_updated_sem (timedwait) |

### 切り替え条件

| 遷移 | 条件 | 応答時間目標 | 理由 |
|------|------|-------------|------|
| DAY → NIGHT | brightness < 閾値 が N 秒継続 | ~1秒 | 暗転は即座に対応 |
| NIGHT → DAY | brightness > 閾値 が N 秒継続 | ~10秒 | 明転は急がない |

### NIGHT カメラ起動時間

| フェーズ | 所要時間 (推定) |
|----------|----------------|
| sem_post (起床) | < 1ms |
| vio_start() | 100-500ms |
| 最初のフレーム出力 | 1-2 frames (~33-66ms) |
| **合計** | **~200-600ms** |

※ DAY → NIGHT 切り替え時、NIGHT カメラ起動中は DAY カメラがフレーム出力を継続するため、視聴者への影響は最小限。

## 新しい共有メモリ構成

```
/pet_camera_control
    └─ active_camera_index (0=DAY, 1=NIGHT)

/pet_camera_zc_0 (DAY カメラ NV12)
    └─ ZeroCopyFrame (share_id, brightness_avg, ...)
    └─ 常に更新

/pet_camera_zc_1 (NIGHT カメラ NV12)
    └─ ZeroCopyFrame (share_id, brightness_avg, ...)
    └─ 常に更新

/pet_camera_h264_zc_0 (DAY カメラ H.264)
    └─ ZeroCopyH264Frame (share_id, size, is_keyframe, ...)
    └─ active 時のみ更新

/pet_camera_h264_zc_1 (NIGHT カメラ H.264)
    └─ ZeroCopyH264Frame (share_id, size, is_keyframe, ...)
    └─ active 時のみ更新
```

## 注意事項

### VIOバッファのライフサイクル

```
getframe() → share_id取得 → Consumer処理 → consumed通知 → releaseframe()
                                   │
                             66ms以内に完了必要
```

### エンコーダ出力バッファのライフサイクル

```
dequeue_output() → fd→share_id → Consumer処理 → consumed通知 → queue_output()
                                      │
                                 Consumer は hb_mem_import で直接アクセス
```

### カメラ切り替え

```
1. camera_switcher: active_camera_index を更新 (共有メモリ書き換え)
2. カメラデーモン: 次のループで active_camera_index を確認
3. Consumer: 次フレームから新しいカメラを使用
4. 遅延ゼロで切り替え完了 (シグナル伝搬なし)
```

### フォールバック

Phase 2-3では従来のmemcpy版と並行稼働させ、問題発生時にフォールバック可能にする。

---

## 参照リソース

### プロジェクト内ドキュメント

| ファイル | 内容 |
|----------|------|
| `docs/api_hb_mem_zerocopy.md` | hb_mem API調査レポート（構造体レイアウト、バリデーション要件、代替API候補） |
| `docs/plan_camera_switcher_refactor.md` | camera_switcherリファクタリング計画（コールバック・シグナル廃止、単一ループ化） |

### D-Robotics SDK ヘッダファイル

| ファイル | 内容 |
|----------|------|
| `/usr/include/hb_mem_mgr.h` | hb_mem API定義（構造体、関数宣言） |
| `/usr/include/hb_mem_err.h` | エラーコード定義 (`HB_MEM_ERR_*`) |
| `/usr/include/hbmem.h` | 低レベルhbmem API (`hbmem_mmap_with_share_id`等) |
| `/usr/include/hbn_api.h` | VIO構造体 (`hbn_vnode_image_t`, `hb_mem_graphic_buf_t`) |

### SDK サンプルコード

| ファイル | 内容 |
|----------|------|
| `/app/multimedia_samples/sample_hbmem/sample_share.c` | **★重要** クロスプロセス共有の実装例 |
| `/app/multimedia_samples/sample_hbmem/sample_alloc.c` | バッファアロケーション例 |
| `/app/multimedia_samples/sample_hbmem/sample_pool.c` | メモリプール使用例 |
| `/app/multimedia_samples/sample_hbmem/sample_queue.c` | バッファキュー使用例 |

### プロジェクト実装ファイル

| ファイル | 内容 |
|----------|------|
| `src/capture/shared_memory.h` | `ZeroCopyFrame` 構造体定義 |
| `src/capture/shared_memory.c` | 共有メモリ操作 (`shm_zerocopy_*`) |
| `src/capture/camera_pipeline.c` | VIOフレーム取得、share_id書き込み |
| `src/capture/hb_mem_bindings.py` | Python用hb_memバインディング（要修正） |
| `src/capture/real_shared_memory.py` | Python共有メモリ読み取り |
| `src/detector/yolo_detector_daemon.py` | YOLO daemon（zero-copyコンシューマ） |

### 重要な構造体サイズ・オフセット

```
hb_mem_common_buf_t (48 bytes):
  fd:        offset=0,  size=4
  share_id:  offset=4,  size=4
  flags:     offset=8,  size=8
  size:      offset=16, size=8
  virt_addr: offset=24, size=8
  phys_addr: offset=32, size=8
  offset:    offset=40, size=8

hb_mem_graphic_buf_t (160 bytes):
  fd[3]:      offset=0
  plane_cnt:  offset=12
  format:     offset=16
  width:      offset=20
  height:     offset=24
  stride:     offset=28
  vstride:    offset=32
  is_contig:  offset=36
  share_id[3]: offset=40
  flags:      offset=56
  size[3]:    offset=64
  virt_addr[3]: offset=88
  phys_addr[3]: offset=112
  offset[3]:  offset=136
```

### エラーコード早見表

| 値 | 名前 | 意味 |
|----|------|------|
| -16777214 | `HB_MEM_ERR_INVALID_PARAMS` | 無効なパラメータ（size=0, phys_addr=0等） |
| -16777213 | `HB_MEM_ERR_INVALID_FD` | 無効なFD |
| -16777208 | `HB_MEM_ERR_MODULE_NOT_FOUND` | `hb_mem_module_open()`未呼び出し |
