# Zero-Copy Shared Memory 設計 v3

## 概要

カメラパイプラインからコンシューマへのフレーム転送でmemcpyを排除し、VIOバッファのshare_idを直接共有する。エンコーダ入力も`external_frame_buf`で最適化。

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

## 注意事項

### VIOバッファのライフサイクル

```
getframe() → share_id取得 → Consumer処理 → consumed通知 → releaseframe()
                                   │
                             66ms以内に完了必要
```

### カメラ切り替え

```
1. camera_switcher: active_camera_index を更新
2. Consumer: 次フレームから新しいカメラを使用
3. 遅延ゼロで切り替え完了
```

### フォールバック

Phase 2-3では従来のmemcpy版と並行稼働させ、問題発生時にフォールバック可能にする。
