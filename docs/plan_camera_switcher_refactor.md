# Camera Switcher リファクタリング計画

## 概要

複雑なコールバック・シグナル・マルチスレッド構成を、共有メモリベースのシンプルなポーリングループに置き換える。

**最終更新**: 2026-01-28
**ステータス**: Phase 2 完了、Phase 3 準備中

---

## 進捗サマリー

| Phase | 状態 | 内容 |
|-------|------|------|
| Phase 1 | ✅ 完了 | CameraControl SHM追加、単体テスト通過 |
| Phase 2 | ✅ 完了 | camera_daemon側の対応 (SHMベース活性化、per-camera ZeroCopy) |
| Phase 3 | 🔲 未着手 | switcher_daemon簡素化 |
| Phase 4 | 🔲 未着手 | テスト・検証 |

---

## 現状アーキテクチャ

### 構成図

```
camera_switcher_daemon
│
├── main()
│   ├── spawn_daemon(DAY)   → camera_daemon(0)
│   ├── spawn_daemon(NIGHT) → camera_daemon(1)
│   ├── camera_switch_runtime_start()
│   │   ├── active_thread   ← 30fps、セマフォ待機
│   │   └── probe_thread    ← 2秒おき、DAY brightness確認
│   └── signal handlers (SIGUSR1/SIGUSR2)
│
├── CameraCaptureOps (4 callbacks)
│   ├── switch_camera_cb()        → SIGUSR1/2をcamera_daemonに送信
│   ├── wait_for_new_frame_cb()   → sem_wait(&active_shm->new_frame_sem)
│   ├── capture_active_frame_cb() → shm_active_frame読み取り
│   └── capture_probe_frame_cb()  → shm_brightness読み取り
│
└── 共有メモリ
    ├── /pet_camera_brightness     (CameraBrightness[2])
    ├── /pet_camera_active_frame   (NV12 ring buffer)
    └── /pet_camera_stream         (H.264)
```

### 問題点

| 問題 | 詳細 |
|------|------|
| コールバック抽象化 | 4種類のコールバックによる間接呼び出し |
| シグナルベース活性化 | SIGUSR1/2でカメラ切り替え、遅延あり |
| 2スレッド構成 | active_thread + probe_thread の協調 |
| 複数の共有メモリ | brightness + active_frame + stream |
| フレームスキップロジック | `frames_until_check + active_camera <= 0` の難解な条件 |
| セマフォ待機 | イベント駆動だがブロッキング |

### ファイル構成

| ファイル | 行数 | 役割 |
|----------|------|------|
| `camera_switcher_daemon.c` | 429 | メインデーモン、コールバック実装 |
| `camera_switcher_runtime.h` | 76 | ランタイムインターフェース |
| `camera_switcher_runtime.c` | 210 | active_thread, probe_thread |
| `camera_switcher.h` | 165 | 切り替えロジックAPI |
| `camera_switcher.c` | 368 | brightness判定、ヒステリシス |

---

## 新アーキテクチャ

### 構成図

```
camera_switcher_daemon (単一スレッド)
│
├── main()
│   ├── spawn_daemon(DAY)   → camera_daemon(0)  ── 常時30fps稼働
│   ├── spawn_daemon(NIGHT) → camera_daemon(1)  ── 常時30fps稼働
│   └── switcher_loop()     ← シンプルなポーリング
│
└── 共有メモリ読み書き
    ├── READ:  /pet_camera_zc_0    (DAY brightness)
    ├── READ:  /pet_camera_zc_1    (NIGHT brightness) ※将来用
    └── WRITE: /pet_camera_control (active_camera_index)
```

### データフロー図

```
                    ┌─────────────────────────────────────┐
                    │         switcher_daemon             │
                    │        (single polling loop)        │
                    └──────────────┬──────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │ read brightness    │ write              │ read brightness
              ▼                    ▼                    ▼
   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
   │ /pet_camera_zc_0 │  │/pet_camera_control│  │ /pet_camera_zc_1 │
   │  (DAY + bright)  │  │ active_camera_idx │  │ (NIGHT + bright) │
   └────────┬─────────┘  └─────────┬─────────┘  └────────┬─────────┘
            │                      │                     │
            │              ┌───────┴───────┐             │
            │              ▼               ▼             │
   ┌────────┴────────┐  ┌─────────┐  ┌─────────┐  ┌─────┴────────┐
   │camera_daemon(0) │  │ is_act? │  │ is_act? │  │camera_daemon(1)│
   │     (DAY)       │  └────┬────┘  └────┬────┘  │    (NIGHT)     │
   └────────┬────────┘       │            │       └────────┬───────┘
            │                │            │                │
            │     ┌──────────┴────────────┴──────────┐     │
            │     │  active camera encodes H.264    │     │
            │     └──────────────┬──────────────────┘     │
            │                    ▼                        │
            │         ┌──────────────────┐                │
            │         │ /pet_camera_stream│                │
            │         │     (H.264)      │                │
            │         └────────┬─────────┘                │
            │                  ▼                          │
            │         ┌──────────────────┐                │
            │         │streaming_server  │                │
            │         └──────────────────┘                │
            │                                             │
            └──────────────┬──────────────────────────────┘
                           │ YOLO reads from active camera's zc
                           ▼
                  ┌──────────────────┐
                  │   YOLO daemon    │
                  │ (reads zc_0 or 1)│
                  └────────┬─────────┘
                           ▼
                  ┌──────────────────┐
                  │/pet_camera_      │
                  │   detections     │
                  └──────────────────┘
```

### 新しいメインループ

```c
// camera_switcher_daemon.c - 新設計
int switcher_loop(SwitcherContext *ctx) {
    while (ctx->running) {
        // 1. DAYカメラのbrightnessを直接読み取り
        float brightness = ctx->shm_day->frame.brightness_avg;

        // 2. 切り替え判定 (既存ロジック再利用)
        CameraSwitchDecision decision = camera_switcher_check_brightness(
            &ctx->switcher, brightness, ctx->active_camera);

        // 3. 切り替え実行
        if (decision.should_switch) {
            shm_control_set_active(ctx->control, decision.target_camera);
            ctx->active_camera = decision.target_camera;
            LOG_INFO("Switcher", "Switched to %s camera",
                     decision.target_camera == DAY ? "DAY" : "NIGHT");
        }

        // 4. 適応的スリープ
        int interval_ms = (ctx->active_camera == DAY) ? 250 : 5000;
        usleep(interval_ms * 1000);
    }
    return 0;
}
```

---

## 共有メモリ設計 (最終版)

### リファクタリング後のSHM一覧 (6個)

| SHM名 | 構造体 | サイズ | Producer | Consumer | 用途 |
|-------|--------|--------|----------|----------|------|
| `/pet_camera_control` | `CameraControl` | 8B | switcher | camera_daemon x2 | 切り替え指示 |
| `/pet_camera_zc_0` | `ZeroCopyFrameBuffer` | ~150B | camera_daemon(0) | YOLO, switcher | DAY frame + brightness |
| `/pet_camera_zc_1` | `ZeroCopyFrameBuffer` | ~150B | camera_daemon(1) | YOLO, switcher | NIGHT frame + brightness |
| `/pet_camera_stream` | `SharedFrameBuffer` | ~93MB | active camera | streaming_server | H.264 |
| `/pet_camera_mjpeg_frame` | `SharedFrameBuffer` | ~1.4MB | camera_daemon | web_monitor | MJPEG用NV12 |
| `/pet_camera_detections` | `LatestDetectionResult` | ~584B | YOLO daemon | monitor | 検出結果 |

### 削除されるSHM

| SHM名 | 理由 |
|-------|------|
| `/pet_camera_brightness` | zc_0/zc_1のbrightness_avgで代替 |
| `/pet_camera_active_frame` | Zero-copyで代替 (memcpy不要) |
| `/pet_camera_yolo_zc` | zc_0/zc_1に分離 |

### メモリレイアウト詳細

#### CameraControl (8 bytes) ✅実装済み

```c
typedef struct {
    volatile int active_camera_index;  // 0=DAY, 1=NIGHT     [4 bytes]
    volatile uint32_t version;         // 変更検知用          [4 bytes]
} CameraControl;
```

#### ZeroCopyFrameBuffer (~150 bytes)

```c
typedef struct {
    // Frame metadata
    uint64_t frame_number;              // [8 bytes]
    struct timespec timestamp;          // [16 bytes]
    int camera_id;                      // [4 bytes]
    int width, height, format;          // [12 bytes]

    // Brightness (switcher用)
    float brightness_avg;               // [4 bytes] ← switcher判定に使用
    uint8_t correction_applied;         // [1 byte]
    uint8_t _pad1[3];                   // [3 bytes]

    // VIO buffer sharing (hb_mem)
    int32_t share_id[2];                // [8 bytes] Y/UV planes
    uint64_t plane_size[2];             // [16 bytes]
    int32_t plane_cnt;                  // [4 bytes]

    // Synchronization
    volatile uint32_t version;          // [4 bytes]
    volatile uint8_t consumed;          // [1 byte]
    uint8_t _pad2[3];                   // [3 bytes]
} ZeroCopyFrame;                        // ~84 bytes

typedef struct {
    sem_t new_frame_sem;                // [32 bytes]
    sem_t consumed_sem;                 // [32 bytes]
    ZeroCopyFrame frame;                // [~84 bytes]
} ZeroCopyFrameBuffer;                  // ~148 bytes
```

---

## 削除・変更一覧

### 削除するコンポーネント

| コンポーネント | ファイル | 理由 |
|--------------|----------|------|
| `active_thread` | runtime.c | 単一ループに統合 |
| `probe_thread` | runtime.c | 単一ループに統合 |
| `CameraCaptureOps` | runtime.h | コールバック不要 |
| `switch_camera_cb` | daemon.c | シグナル不要 |
| `wait_for_new_frame_cb` | daemon.c | ポーリングに変更 |
| `capture_active_frame_cb` | daemon.c | 直接SHM読み取り |
| `capture_probe_frame_cb` | daemon.c | 直接SHM読み取り |
| `shm_brightness` | shared_memory | ZeroCopyFrame.brightness_avgで代替 |
| SIGUSR1/SIGUSR2送信 | daemon.c | active_camera_indexで代替 |

### 変更するコンポーネント

| コンポーネント | 変更内容 |
|--------------|----------|
| `camera_switcher_daemon.c` | シンプルなポーリングループに書き換え |
| `camera_switcher_runtime.c` | **削除** (機能をdaemon.cに統合) |
| `camera_switcher_runtime.h` | **削除** または最小化 |
| `camera_switcher.c` | brightness判定ロジックは維持 |
| `camera_daemon` | active_camera_indexを参照して動作変更 |

### 保持するコンポーネント

| コンポーネント | 理由 |
|--------------|------|
| `camera_switcher.c` | ヒステリシス判定ロジックは有用 |
| `CameraSwitchConfig` | 閾値設定は維持 |
| spawn_daemon() | camera_daemon起動は維持 |
| シグナルハンドラ | SIGINT/SIGTERM終了用は維持 |

---

## 実装フェーズ

### Phase 1: 共有メモリ制御構造追加 ✅完了

**目標**: active_camera_indexを共有メモリで公開

**実装済み内容**:
- `CameraControl` 構造体を `shared_memory.h` に追加
- `SHM_NAME_CONTROL` 定義 (`/pet_camera_control`)
- `SHM_NAME_ZEROCOPY_DAY` / `SHM_NAME_ZEROCOPY_NIGHT` 定義
- API実装:
  - `shm_control_create()` - 作成 (switcher用)
  - `shm_control_open()` - オープン (camera_daemon用)
  - `shm_control_close()` - クローズ
  - `shm_control_destroy()` - 破棄
  - `shm_control_set_active()` - アクティブカメラ設定 (atomic)
  - `shm_control_get_active()` - アクティブカメラ取得 (atomic)
  - `shm_control_get_version()` - バージョン取得

**単体テスト**: `test_shm.c` に4つのテスト追加、全て通過
- `test_camera_control_create_destroy`
- `test_camera_control_set_get`
- `test_camera_control_invalid_values`
- `test_camera_control_producer_consumer`

### Phase 2: camera_daemon側の対応 ✅完了

**目標**: camera_daemonがactive_camera_indexを参照

**実装済み内容**:

1. **camera_daemon_main.c**:
   - SIGUSR1/SIGUSR2/SIGRTMIN シグナルハンドラ削除
   - `g_is_active` / `g_probe_requested` グローバル変数削除
   - SIGINT/SIGTERM のみ維持 (graceful shutdown)
   - `pipeline_create()` から `is_active_flag` / `probe_requested_flag` パラメータ削除

2. **camera_pipeline.h**:
   - `is_active_flag` / `probe_requested_flag` ポインタ → `CameraControl *control_shm` に置き換え
   - `pipeline_create()` シグネチャ簡素化

3. **camera_pipeline.c**:
   - CameraControl SHMオープン (5秒リトライ)
   - `write_active` 判定: `shm_control_get_active(control_shm) == camera_index`
   - `write_probe` (プローブ機構) 完全削除
   - ZeroCopy SHM名: `SHM_NAME_YOLO_ZEROCOPY` → `SHM_NAME_ZEROCOPY_DAY/NIGHT`
   - ZeroCopy SHMに `brightness_avg` 常時更新 (active/inactive問わず)
   - `pipeline_destroy()` で CameraControl SHMクローズ

4. **camera_switcher_daemon.c**:
   - `CameraControl *control_shm` を `DaemonContext` に追加
   - `main()`: camera_daemon起動前にCameraControl SHM作成
   - `switch_camera_cb()`: CameraControl SHM更新 + レガシーSIGUSR1/2送信
   - シャットダウン時にCameraControl SHM破棄

```c
// camera_pipeline.c - Phase 2 実装
bool write_active = pipeline->control_shm &&
    shm_control_get_active(pipeline->control_shm) == pipeline->camera_index;
```

**移行戦略**: レガシーSIGUSR1/2は併用維持 (Phase 3で完全削除)

### Phase 3: switcher_daemon簡素化

**目標**: 単一スレッドポーリングループに置き換え

```c
// camera_switcher_daemon.c - 新実装
typedef struct {
    pid_t day_pid;
    pid_t night_pid;
    CameraMode active_camera;
    CameraControl *control;
    ZeroCopyFrameBuffer *shm_day;
    ZeroCopyFrameBuffer *shm_night;  // ★追加
    CameraSwitcher switcher;
    volatile int running;
} SwitcherContext;
```

**変更ファイル**:
- `camera_switcher_daemon.c` - 全面書き換え
- `camera_switcher_runtime.c` - **削除**
- `camera_switcher_runtime.h` - **削除**

### Phase 4: テスト・検証

**テスト項目**:
- [ ] DAY→NIGHT切り替え (brightness低下時)
- [ ] NIGHT→DAY切り替え (brightness上昇時)
- [ ] 切り替え応答時間 (目標: <1秒)
- [ ] CPU使用率削減確認
- [ ] メモリリーク確認
- [ ] 長時間安定性 (24時間)

---

## 期待効果

| 項目 | Before | After |
|------|--------|-------|
| スレッド数 | 3 (main + active + probe) | 1 |
| コールバック | 4種類 | 0 |
| シグナル | SIGUSR1/SIGUSR2 | 不要 |
| 共有メモリ | 6種類 | 6種類 (統合・再編) |
| コード行数 | ~700行 (runtime含む) | ~200行 |
| 切り替え遅延 | シグナル伝搬 (~10ms) | 即座 (次フレームから) |

---

## 依存関係

### 前提条件

1. **hb_mem API問題の解決** (Phase 2-3)
   - ZeroCopyFrameにbuffer全体を含める
   - Python側でimport成功する状態

2. **ZeroCopyFrame.brightness_avgの確認**
   - camera_daemonがISPからbrightness取得
   - ZeroCopyFrameに書き込み済み

### 並行作業可能な項目

- ~~Phase 1 (control SHM追加)~~ ✅完了
- Phase 2-3 は hb_mem修正完了後

---

## リスクと対策

| リスク | 影響 | 対策 |
|--------|------|------|
| ポーリング間隔が長すぎる | 切り替え遅延 | 250ms間隔で開始、調整可能に |
| brightness更新が遅い | 誤判定 | ZeroCopyFrameのversion確認 |
| camera_daemon未対応 | 切り替え不能 | 段階的移行、シグナル併用期間 |
| 競合状態 | データ不整合 | atomic操作使用 |

---

## 参考ファイル

### 既存実装

| ファイル | 参照ポイント |
|----------|------------|
| `src/capture/camera_switcher_daemon.c` | コールバック実装、spawn_daemon |
| `src/capture/camera_switcher_runtime.c` | active_thread, probe_thread |
| `src/capture/camera_switcher.c` | brightness判定ロジック (再利用) |
| `src/capture/shared_memory.h` | 既存SHM構造体 |

### 設計ドキュメント

| ファイル | 内容 |
|----------|------|
| `docs/design_zerocopy_shm.md` | Zero-Copy設計、簡素化方針 |
| `docs/api_hb_mem_zerocopy.md` | hb_mem API調査結果 |

---

## 実装チェックリスト

### Phase 1 ✅完了
- [x] `CameraControl` 構造体定義
- [x] `shm_control_*` API実装
- [x] 単体テスト (4テスト通過)
- [x] `SHM_NAME_ZEROCOPY_DAY/NIGHT` 定義追加

### Phase 2 ✅完了
- [x] camera_daemonのSIGUSR1/2/SIGRTMINハンドラ削除
- [x] control SHMオープン追加 (pipeline_create()内、5秒リトライ)
- [x] is_active判定実装 (shm_control_get_active() == camera_index)
- [x] per-camera ZeroCopy SHM作成 (zc_0, zc_1)
- [x] camera_switcher_daemon: CameraControl SHM作成・switch_camera_cbで更新
- [x] ZeroCopy SHMにbrightness_avg常時更新 (Phase 3のswitcher用)
- [x] test_shm全9テスト通過、streaming_server Goビルド確認
- [ ] 実機動作確認 (次回デプロイ時)

### Phase 3
- [ ] `camera_switcher_daemon.c` 書き換え
- [ ] `camera_switcher_runtime.*` 削除
- [ ] 統合テスト

### Phase 4
- [ ] 切り替えテスト (DAY↔NIGHT)
- [ ] 応答時間計測
- [ ] CPU使用率計測
- [ ] 長時間テスト

---

## Appendix A: hb_mem Zero-Copy Import 調査・テスト計画

**最終更新**: 2026-01-28
**ステータス**: テストコード実装済み — デプロイ待ち。`hb_mem_import_graph_buf` / `hb_mem_import_com_buf` 共に `-16777214 (INVALID_PARAMS)` で失敗中

---

### A.1 現状のエラー

```
hb_mem_import_graph_buf failed: -16777214 (share_id=[85, 0], plane_cnt=2)
```

```
hb_mem_import_com_buf failed: -16777214 (share_id=85, size=345600)
```

`-16777214` = `HB_MEM_ERR_INVALID_PARAMS` (hb_mem_err.h line 46)

---

### A.2 ヘッダファイル調査結果 (/usr/include/)

#### 利用可能なAPI一覧 (import/get系)

| API | シグネチャ | 入力 | 互換性 |
|-----|----------|------|--------|
| `hb_mem_import_com_buf` | `(com_buf *in, com_buf *out)` → `int32_t` | share_id経由 | XJ3/J5/J6 |
| `hb_mem_import_graph_buf` | `(graph_buf *in, graph_buf *out)` → `int32_t` | share_id[3]経由 | XJ3/J5/J6 |
| `hb_mem_import_com_buf_with_paddr` | `(phys_addr, size, flags, *out)` → `int32_t` | phys_addr経由 | **J6のみ** |
| `hb_mem_get_com_buf` | `(fd, *out)` → `int32_t` | fd経由 | XJ3/J5/J6 |
| `hb_mem_get_graph_buf` | `(fd, *out)` → `int32_t` | fd経由 | XJ3/J5/J6 |
| `hb_mem_get_com_buf_with_vaddr` | `(vaddr, *out)` → `int32_t` | vaddr経由 | XJ3/J5/J6 |
| `hb_mem_get_graph_buf_with_vaddr` | `(vaddr, *out)` → `int32_t` | vaddr経由 | XJ3/J5/J6 |
| `hbmem_mmap_with_share_id` | `(phyaddr, size, flag, share_id)` → `hbmem_addr_t` | share_id+phyaddr | XJ3/J5/J6 |
| `hbmem_mmap` | `(phyaddr, size, flag)` → `hbmem_addr_t` | phyaddr経由 | XJ3/J5/J6 |

#### hb_mem_graphic_buf_t 実機レイアウト (160 bytes)

```c
// /usr/include/hb_mem_mgr.h line 167-198
typedef struct hb_mem_graphic_buf_t {
    int32_t fd[3];           // offset 0   (12B)
    int32_t plane_cnt;       // offset 12  (4B)   ← "Values [1, MAX_GRAPHIC_BUF_COMP]"
    int32_t format;          // offset 16  (4B)   ← mem_pixel_format_t (NV12=8)
    int32_t width;           // offset 20  (4B)
    int32_t height;          // offset 24  (4B)
    int32_t stride;          // offset 28  (4B)
    int32_t vstride;         // offset 32  (4B)
    int32_t is_contig;       // offset 36  (4B)   ← "Default: 0"
    int32_t share_id[3];     // offset 40  (12B)
    // 4B padding (int64_t alignment)
    int64_t flags;           // offset 56  (8B)   ← mem_usage_t
    uint64_t size[3];        // offset 64  (24B)
    uint8_t *virt_addr[3];   // offset 88  (24B)  ← aarch64 8Bポインタ
    uint64_t phys_addr[3];   // offset 112 (24B)
    uint64_t offset[3];      // offset 136 (24B)
} hb_mem_graphic_buf_t;     // total: 160 bytes ✅ ctypes検証済み
```

#### hb_mem_common_buf_t 実機レイアウト (48 bytes)

```c
// /usr/include/hb_mem_mgr.h line 142-160
typedef struct hb_mem_common_buf_t {
    int32_t fd;              // offset 0   (4B)
    int32_t share_id;        // offset 4   (4B)
    int64_t flags;           // offset 8   (8B)
    uint64_t size;           // offset 16  (8B)
    uint8_t *virt_addr;      // offset 24  (8B)
    uint64_t phys_addr;      // offset 32  (8B)
    uint64_t offset;         // offset 40  (8B)
} hb_mem_common_buf_t;      // total: 48 bytes ✅ ctypes検証済み
```

---

### A.3 現状分析：実行時に何が起きているか

#### C側 (Producer: camera_pipeline.c)

```
yolo_frame = hbn_vnode_getframe(VSE ch1)  // VIOからNV12フレーム取得

yolo_frame.buffer の内容推定:
  fd[0]       = 37 (or similar)    ← producer processのfd
  fd[1]       = 37 (同一fd) or 0   ← contiguous bufferの場合
  plane_cnt   = 2                   ← NV12 = Y + UV
  format      = 8                   ← MEM_PIX_FMT_NV12
  width       = 640
  height      = 360
  stride      = 640 (推定)
  vstride     = 360 (推定)
  is_contig   = 1 (推定)            ← HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF使用
  share_id[0] = 85                  ← 有効なshare_id
  share_id[1] = 0                   ← ★ contiguousなので0
  flags       = (alloc時のflags)
  size[0]     = 230400              ← 640*360 (Y plane)
  size[1]     = 115200              ← 640*360/2 (UV plane)
  virt_addr[0]= 0xffff...          ← producer processのvaddr
  virt_addr[1]= virt_addr[0]+size[0] ← contiguousなのでオフセット
  phys_addr[0]= 0x...              ← 物理アドレス
  phys_addr[1]= phys_addr[0]+size[0]
  offset[0]   = 0
  offset[1]   = 0 (or size[0])
```

→ `memcpy(zc_frame.hb_mem_buf_data, &yolo_frame.buffer, 160)` でSHMに書き込み

#### Python側 (Consumer: hb_mem_bindings.py)

**試行1: `hb_mem_import_graph_buf` (fd=-1クリア版)**
```
入力: raw 160 bytes, fd[0..2]を-1に、virt_addr[0..2]を0にクリア
結果: -16777214 (INVALID_PARAMS)
推定原因: share_id[1]=0 が2-plane bufferに対して無効
         または fd=-1 が無効な値として拒否される
```

**試行2: `hb_mem_import_com_buf` (contiguous fallback)**
```
入力: hb_mem_common_buf_t { share_id=85, size=345600, phys_addr=... }
結果: -16777214 (INVALID_PARAMS)
推定原因: phys_addr値がprocess間で有効だが、import APIが内部で
         validation失敗。あるいはflagsが必要。
```

#### 根本原因の仮説

| # | 仮説 | 確率 | 検証方法 |
|---|------|------|---------|
| H1 | `hb_mem_import_com_buf`の入力で**何かのフィールドが欠落**している。share_id + size だけでは不十分で、flags や他フィールドも必要 | 高 | テスト1: 全フィールドを段階的に追加 |
| H2 | `hb_mem_import_com_buf`で **size=0** にすべき（SDK側がshare_idから自動取得） | 中 | テスト2: size=0で試行 |
| H3 | `hb_mem_import_graph_buf`で contiguous buffer (share_id[1]=0) は**plane_cnt=1にすべき** | 中 | テスト3: plane_cnt=1に変更して試行 |
| H4 | import APIはそもそも **同一プロセス内** でしか使えない（cross-process不可）、低レベル `hbmem_mmap_with_share_id` が必要 | 中 | テスト4: hbmem APIを使用 |
| H5 | `hb_mem_import_com_buf`の入力で **phys_addrが不要**（0にすべき）、もしくは逆に **fdが必要** | 低〜中 | テスト5: 入力フィールドの組み合わせ |
| H6 | VIOバッファは特殊なメモリ領域にあり、通常のimport APIではアクセス不可 | 低 | テスト4で判明 |

---

### A.4 実装済みテストコード

#### 1. C側バッファダンプ (camera_pipeline.c) ✅実装済み

`camera_pipeline.c` の `pipeline_run()` 内、最初のYOLOフレーム取得時 (`frame_count == 0`) に
`yolo_frame.buffer` (`hb_mem_graphic_buf_t`) の**全フィールド**をログ出力する。
raw hex dump (160 bytes) も出力し、Python側の受信データと直接比較可能。

出力するフィールド:
- `fd[3]`, `plane_cnt`, `format`, `width`, `height`, `stride`, `vstride`, `is_contig`
- `share_id[3]`, `flags`, `size[3]`, `virt_addr[3]`, `phys_addr[3]`, `offset[3]`
- raw hex dump (10行 × 16バイト)

#### 2. Import APIテストプログラム (test_hb_mem_import.c) ✅実装済み

ZeroCopy SHMからフレームを読み取り、8つの異なるimport API呼び出しパターンを系統的に試行する。

| テスト | API | 入力パラメータ |
|--------|-----|---------------|
| A | `hb_mem_import_graph_buf` | fd=0, virt_addr=0 (他はoriginal) |
| B | `hb_mem_import_graph_buf` | 全フィールドoriginal (クリアなし) |
| C | `hb_mem_import_com_buf` | share_id のみ → 失敗なら share_id+size で再試行 |
| D | `hb_mem_import_com_buf` | share_id + phys_addr + size |
| E | `hb_mem_import_com_buf` | per-plane (Y/UV個別) |
| F | `hb_mem_import_graph_buf` | fd=-1, virt_addr=0 |
| G | `hb_mem_import_graph_buf` | minimal (share_id+plane_cnt+sizeのみ、fd=-1) |
| H | `hb_mem_import_graph_buf` | fd=0, virt_addr=0, phys_addr=0, offset=0 |

各テストは成功時に出力バッファの全フィールドをダンプし、Yプレーンの先頭16バイトを読み取ってデータアクセスを検証する。
最後にPASS/FAIL一覧を表示。

---

### A.5 テスト実施手順

#### 前提条件

- RDK X5 デバイスにSSH接続可能
- プロジェクトコードがデバイスにデプロイ済み (`/app/smart-pet-camera`)
- カメラモジュールが接続済み

#### ステップ1: ビルド

デバイス上で:

```bash
cd /app/smart-pet-camera

# camera_daemon と test_hb_mem_import をビルド
make -C src/capture clean
make -C src/capture all test-hb-mem-import
```

出力:
- `build/camera_daemon_drobotics` — カメラデーモン (バッファダンプ付き)
- `build/camera_switcher_daemon` — スイッチャーデーモン
- `build/test_hb_mem_import` — import APIテストプログラム

#### ステップ2: カメラデーモン起動とバッファダンプ確認

```bash
# 既存プロセスを停止
make -C src/capture kill-processes

# 共有メモリをクリーンアップ
rm -f /dev/shm/pet_camera_*

# スイッチャーデーモン経由で起動 (DAY + NIGHT カメラ)
build/camera_switcher_daemon &

# ログを確認 (最初のフレームでダンプが出力される)
# "=== hb_mem_graphic_buf_t DUMP ===" を探す
```

ダンプ出力例 (期待):
```
[INFO] [Pipeline 0] === hb_mem_graphic_buf_t DUMP (sizeof=160) ===
[INFO] [Pipeline 0]   fd[3]          = {37, 37, 0}
[INFO] [Pipeline 0]   plane_cnt      = 2
[INFO] [Pipeline 0]   format         = 8
[INFO] [Pipeline 0]   width          = 640
[INFO] [Pipeline 0]   height         = 360
[INFO] [Pipeline 0]   stride         = 640
[INFO] [Pipeline 0]   vstride        = 360
[INFO] [Pipeline 0]   is_contig      = 1
[INFO] [Pipeline 0]   share_id[3]    = {85, 0, 0}
[INFO] [Pipeline 0]   flags          = ...
[INFO] [Pipeline 0]   size[3]        = {230400, 115200, 0}
[INFO] [Pipeline 0]   virt_addr[3]   = {0x..., 0x..., 0x0}
[INFO] [Pipeline 0]   phys_addr[3]   = {0x..., 0x..., 0x0}
[INFO] [Pipeline 0]   offset[3]      = {0, 0, 0}
[INFO] [Pipeline 0]   raw[0..15]     = 25 00 00 00 25 00 00 00 ...
...
[INFO] [Pipeline 0] === END hb_mem_graphic_buf_t DUMP ===
```

**注目すべきフィールド**:

| フィールド | 確認ポイント |
|-----------|------------|
| `is_contig` | 1ならcontiguousバッファ → share_id[1]=0は正常 |
| `share_id[1]` | 0ならcontiguous確定、非0なら個別プレーン |
| `fd[0]` vs `fd[1]` | 同一値ならcontiguous、異なれば個別 |
| `flags` | allocフラグ。import時に必要な可能性あり |
| `phys_addr[0]` | 物理アドレス。`hbmem_mmap_with_share_id`に必要 |
| `offset[0..1]` | 各プレーンのoffset。通常は0 |
| `virt_addr[1]` | `virt_addr[0] + size[0]` ならcontiguous確認 |

#### ステップ3: import APIテスト実行

カメラデーモンが起動している状態で、別ターミナルからテスト実行:

```bash
# DAYカメラのZeroCopy SHMからフレームを読み取りテスト
build/test_hb_mem_import

# NIGHTカメラをテストする場合
build/test_hb_mem_import --night
```

出力例:
```
=== hb_mem Import API Test ===
Using ZeroCopy SHM: /pet_camera_zc_0

hb_mem module initialized

Opened ZeroCopy SHM: /pet_camera_zc_0
Waiting for frame (5 second timeout)...

Frame received:
  frame_number   = 42
  share_id       = {85, 0}
  plane_size     = {230400, 115200}

=== Original buffer from producer (C-side values) ===
  fd[3]          = {37, 37, 0}
  ...

========================================
Running import API tests...
========================================

[Test A] hb_mem_import_graph_buf (fd=0, virt_addr=0)
  FAILED: ret=-16777214

[Test B] hb_mem_import_graph_buf (original fields, no clearing)
  SUCCESS!
  ...

========================================
SUMMARY
========================================
  [FAIL] A: import_graph_buf (fd=0, vaddr=0)
  [PASS] B: import_graph_buf (original, no clearing)
  ...

1/8 tests passed
```

#### ステップ4: 結果分析と対応

テスト結果から以下を判断:

| 結果パターン | 対応方針 |
|-------------|---------|
| Test B (original) のみPASS | producerのfd/vaddrも必要 → SHMに追加保存するか、fdパススルー検討 |
| Test C or D (com_buf) がPASS | `hb_mem_import_com_buf`を使用、必要フィールドをPython側に反映 |
| Test F or G (fd=-1/minimal) がPASS | `hb_mem_import_graph_buf`の入力要件が判明、Python側を修正 |
| Test H (全クリア) がPASS | import APIはshare_idだけで動作 → Python側のフィールドクリア方法を修正 |
| 全てFAIL | C側テストプログラムでも失敗 → cross-process自体が不可能か、`hbmem_mmap_with_share_id` 等の低レベルAPIが必要 |

#### ステップ5: Python側への反映

成功したパターンを `hb_mem_bindings.py` の `HbMemGraphicBuffer` クラスに反映:

```bash
# 修正後のPython側動作確認
uv run src/detector/yolo_detector_daemon.py --log-level debug
```

YOLOデーモンのログで以下を確認:
- `Zero-copy import failed` エラーが消えること
- `Frame #1: N detections [...]` が出力されること
- `scripts/profile_shm.py` でFPS/ドロップ率が正常であること

#### 補足: テストがタイムアウトする場合

```bash
# 共有メモリの存在を確認
ls -la /dev/shm/pet_camera_*

# camera_daemonが稼働中か確認
ps aux | grep camera_daemon

# ZeroCopy SHMが作成されているか確認
# pet_camera_zc_0 (DAY) / pet_camera_zc_1 (NIGHT) が存在すること
```

タイムアウトの原因:
- camera_daemonがアクティブでない (switcherがNIGHTに切り替えている場合、zc_0にフレームが来ない)
- ZeroCopy SHMが古いフォーマット (shared_memory.hの変更後にrebuild/redeployが必要)

---

### A.6 最有望な候補

現時点での優先順位:

1. **バッファダンプ (camera_pipeline.c)** ✅実装済み: 全フィールドの実値を確認。これなしでは何も判断できない
2. **Test C (com_buf, share_idのみ)** ✅実装済み: struct layoutが修正済みなので再テストの価値あり
3. **Test G (graph_buf, minimal: share_id+cnt+size)** ✅実装済み: contiguous buffer用に最小限のフィールドだけ設定
4. **Test B (graph_buf, originalそのまま)** ✅実装済み: producer fdを含む全フィールドでAPI呼び出し
5. **`hbmem_mmap_with_share_id` (低レベルAPI)**: 未実装。全テストFAILの場合の最終手段として、share_id + phys_addr で直接mmapする。テスト結果を見て必要なら追加実装

全テストが失敗した場合の追加手段:
- `hb_mem_import_com_buf_with_paddr` (J6のみAPI): phys_addr直接指定
- `hbmem_mmap_with_share_id`: 低レベルmmap (hbmem.h)
- fd passing via UNIXドメインソケット: producer fdを直接渡す

---

### A.7 注意事項

- RDK X5は**J6ベース** (Bayes-e SoC)。J6のみのAPIも使える可能性が高い
- `hbmem_mmap_with_share_id`は`hbmem.h`（低レベルAPI）。`hb_mem_mgr.h`の高レベルAPIとは別レイヤー
- Pythonからは `ctypes.CDLL("libhbmem.so")` で全API呼び出し可能
- `hb_mem_module_open()` はプロセス毎に1回必要（hbmem.hのAPIも同じモジュールを使用）
- import後は必ず `hb_mem_free_buf(fd)` で解放しないとリソースリーク
