# Zero-Copy Shared Memory 設計

## 概要

カメラパイプラインからコンシューマ（YOLO, MJPEG, streaming-server）へのフレーム転送で、memcpyを排除してDMAバッファを直接共有する。

## 現状のアーキテクチャ

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────────────┐
│   Camera    │────▶│     VSE      │────▶│   memcpy     │────▶│ SharedFrame │
│   Sensor    │     │  (Hardware)  │     │   (CPU)      │     │   Buffer    │
└─────────────┘     └──────────────┘     └──────────────┘     └─────────────┘
                           │                                         │
                           ▼                                         ▼
                    VIO Buffer (DMA)                          Consumer Process
                    - 3 buffers/channel                       (別プロセス)
                    - share_id あり
```

### 問題点

| チャンネル | 用途 | サイズ | memcpy負荷 |
|-----------|------|--------|------------|
| Ch0 | Active NV12 | 640x480 | ~460KB/frame |
| Ch1 | YOLO入力 | 640x360 | ~346KB/frame |
| Ch2 | MJPEG入力 | 640x480 | ~460KB/frame |

**合計: 約1.27MB/frame × 30fps ≈ 38MB/s の不要なCPU memcpy**

## 提案: Zero-Copy アーキテクチャ

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────────────┐
│   Camera    │────▶│     VSE      │────▶│  share_id    │────▶│  Consumer   │
│   Sensor    │     │  (Hardware)  │     │  (metadata)  │     │  Process    │
└─────────────┘     └──────────────┘     └──────────────┘     └─────────────┘
                           │                    │                     │
                           ▼                    ▼                     ▼
                    VIO Buffer (DMA)      ZeroCopyFrame        hb_mem_import
                    - share_id[2]         - share_id           - virt_addr取得
                    - plane_size[2]       - メタデータ         - 同一バッファ参照
```

### 動作フロー

```
Camera Daemon                              Consumer (YOLO/MJPEG/streaming)
     │                                              │
     │  1. hbn_vnode_getframe()                     │
     │     └─▶ VIOバッファ取得 (share_id含む)       │
     │                                              │
     │  2. ZeroCopyFrameに書き込み                  │
     │     - share_id[0], share_id[1]              │
     │     - width, height, metadata               │
     │                                              │
     │  3. sem_post(new_frame_sem)                  │
     │     └─▶ コンシューマに通知 ─────────────────▶│
     │                                              │
     │  4. sem_wait(consumed_sem)                   │  5. hb_mem_import_com_buf()
     │     └─▶ 処理完了を待機                       │     └─▶ 同じバッファをマップ
     │         ┌──────────────────────────────────◀─│
     │         │                                    │  6. フレーム処理
     │         │                                    │     (YOLO推論など)
     │         │                                    │
     │         │◀────────────────────────────────────  7. sem_post(consumed_sem)
     │                                              │     └─▶ 処理完了通知
     │  8. hbn_vnode_releaseframe()                 │
     │     └─▶ VIOバッファを解放                    │
     ▼                                              ▼
```

## タイミング制約

### VIOバッファプール

各VSEチャンネルは3つのDMAバッファを持つ：

```
Buffer 0: VSEが書き込み中
Buffer 1: コンシューマが処理中
Buffer 2: 次のVSE出力用に待機
```

### 処理時間の制約

- フレーム間隔: 33ms (30fps)
- コンシューマの処理時間制限: **~66ms** (2フレーム分)
- これを超えるとVIOパイプラインがストール

| Consumer | 処理時間 | 制約内？ |
|----------|----------|----------|
| YOLO | 30-50ms | ✅ OK |
| MJPEG encode | ~5ms | ✅ OK |
| streaming-server | ~1ms | ✅ OK |

## データ構造

### ZeroCopyFrame

```c
typedef struct {
    // フレームメタデータ
    uint64_t frame_number;
    struct timespec timestamp;
    int camera_id;
    int width;
    int height;
    int format;  // 1=NV12

    // 明るさ情報
    float brightness_avg;
    uint8_t correction_applied;

    // VIOバッファ情報 (hb_mem_graphic_buf_tから)
    int32_t share_id[2];      // Y/UV planes
    uint64_t plane_size[2];   // 各プレーンのサイズ
    int32_t plane_cnt;        // プレーン数 (NV12=2)

    // 同期
    volatile uint32_t version;  // フレーム更新時にインクリメント
    volatile uint8_t consumed;  // Consumer完了フラグ
} ZeroCopyFrame;
```

### ZeroCopyFrameBuffer

```c
typedef struct {
    sem_t new_frame_sem;   // 新フレーム通知
    sem_t consumed_sem;    // 処理完了通知
    ZeroCopyFrame frame;   // 現在のフレーム
} ZeroCopyFrameBuffer;
```

## hb_mem API

### Producer (Camera Daemon)

```c
// VIOフレーム取得
hbn_vnode_image_t vio_frame;
hbn_vnode_getframe(vse_handle, channel, timeout, &vio_frame);

// share_id取得
int32_t share_id_y = vio_frame.buffer.share_id[0];
int32_t share_id_uv = vio_frame.buffer.share_id[1];

// 共有メモリに書き込み
zc_frame->share_id[0] = share_id_y;
zc_frame->share_id[1] = share_id_uv;
zc_frame->plane_size[0] = vio_frame.buffer.size[0];
zc_frame->plane_size[1] = vio_frame.buffer.size[1];
```

### Consumer (Python)

```python
# ctypesでhb_mem APIを呼び出し
import ctypes

libhbmem = ctypes.CDLL("libhbmem.so")

# バッファインポート
class HbMemCommonBuf(ctypes.Structure):
    _fields_ = [
        ("fd", ctypes.c_int32),
        ("share_id", ctypes.c_int32),
        ("flags", ctypes.c_int64),
        ("size", ctypes.c_uint64),
        ("virt_addr", ctypes.POINTER(ctypes.c_uint8)),
        ("phys_addr", ctypes.c_uint64),
        ("offset", ctypes.c_uint64),
    ]

def import_buffer(share_id: int, size: int) -> memoryview:
    in_buf = HbMemCommonBuf()
    in_buf.share_id = share_id
    in_buf.size = size

    out_buf = HbMemCommonBuf()

    ret = libhbmem.hb_mem_import_com_buf(ctypes.byref(in_buf), ctypes.byref(out_buf))
    if ret != 0:
        raise RuntimeError(f"hb_mem_import_com_buf failed: {ret}")

    # virt_addrからnumpy配列を作成
    arr = np.ctypeslib.as_array(out_buf.virt_addr, shape=(size,))
    return arr
```

## 共有メモリ名

| 名前 | 用途 |
|------|------|
| `/pet_camera_yolo_zc` | YOLO入力 (640x360) |
| `/pet_camera_mjpeg_zc` | MJPEG入力 (640x480) |
| `/pet_camera_active_zc` | Active NV12 (640x480) |

## 実装計画

### Phase 1: YOLO入力のみ

1. `shared_memory.c`: ZeroCopyFrameBuffer API追加
2. `camera_pipeline.c`: Ch1でzero-copy使用
3. `hb_mem_bindings.py`: Python用hb_memバインディング
4. `yolo_detector_daemon.py`: zero-copy読み取り

### Phase 2: MJPEG/Active

1. Ch2 (MJPEG) のzero-copy化
2. Ch0 (Active) のzero-copy化
3. streaming-server対応 (Go言語でCGO使用)

## リスクと対策

### 1. コンシューマが遅い場合

**リスク**: 66ms以内に処理完了しないとVIOストール

**対策**:
- タイムアウト付きsem_wait
- タイムアウト時はフレームスキップ

### 2. コンシューマがクラッシュ

**リスク**: consumed_semがpostされずデッドロック

**対策**:
- タイムアウト付きsem_timedwait
- watchdogでコンシューマ状態監視

### 3. 複数コンシューマ

**リスク**: 1つのVIOバッファを複数プロセスが読む場合

**対策**:
- 現状はSPSC (Single Producer Single Consumer)
- 複数コンシューマはDMAコピーでバッファ複製

## 期待効果

| 項目 | Before | After |
|------|--------|-------|
| CPU memcpy | 38MB/s | 0 |
| コンテキストスイッチ | 多い | 少ない |
| キャッシュミス | 多い | 少ない |
| フレームレイテンシ | memcpy分増加 | 最小 |

## 参考

- D-Robotics hb_mem API: `/usr/include/hb_mem_mgr.h`
- VIO API: `/usr/include/hbn_api.h`
