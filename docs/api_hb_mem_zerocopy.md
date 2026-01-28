# hb_mem API Zero-Copy 実装ガイド

## 調査結果サマリ

### エラーの原因

```
hb_mem_import_com_buf failed: -16777214 (share_id=88)
```

エラーコード `-16777214` = `HB_MEM_ERR_INVALID_PARAMS` (0xFF000002)

SDKのバリデーションで、入力バッファの必須フィールドが不足していた:
- `hb_mem_common_buf_t`: `size > 0` と `phys_addr > 0` が必要
- `hb_mem_graphic_buf_t`: `width > 0`, `height > 0`, その他も必要

**現在の実装**: `share_id`のみ設定 → `size=0`, `phys_addr=0` でバリデーション失敗

---

## 構造体レイアウト (検証済み)

### hb_mem_common_buf_t (48 bytes)

```c
typedef struct hb_mem_common_buf_t {
    int32_t fd;           // offset=0   ファイルディスクリプタ
    int32_t share_id;     // offset=4   プロセス間共有用ID (★重要)
    int64_t flags;        // offset=8   アロケーションフラグ
    uint64_t size;        // offset=16  バッファサイズ (★必須)
    uint8_t *virt_addr;   // offset=24  仮想アドレス
    uint64_t phys_addr;   // offset=32  物理アドレス (★必須)
    uint64_t offset;      // offset=40  オフセット
} hb_mem_common_buf_t;
```

### hb_mem_graphic_buf_t (160 bytes)

```c
#define MAX_GRAPHIC_BUF_COMP 3  // プレーン数最大

typedef struct hb_mem_graphic_buf_t {
    int32_t fd[3];           // offset=0    FD (プレーン毎)
    int32_t plane_cnt;       // offset=12   プレーン数 (★必須)
    int32_t format;          // offset=16   フォーマット (★必須)
    int32_t width;           // offset=20   幅 (★必須)
    int32_t height;          // offset=24   高さ (★必須)
    int32_t stride;          // offset=28   水平ストライド (★推奨)
    int32_t vstride;         // offset=32   垂直ストライド (★推奨)
    int32_t is_contig;       // offset=36   連続メモリフラグ
    int32_t share_id[3];     // offset=40   share_id (★必須)
    int64_t flags;           // offset=56   フラグ
    uint64_t size[3];        // offset=64   サイズ (★必須)
    uint8_t *virt_addr[3];   // offset=88   仮想アドレス
    uint64_t phys_addr[3];   // offset=112  物理アドレス (★必須)
    uint64_t offset[3];      // offset=136  オフセット
} hb_mem_graphic_buf_t;
```

---

## Import API バリデーション要件

### hb_mem_import_com_buf()

```c
int32_t hb_mem_import_com_buf(hb_mem_common_buf_t *in, hb_mem_common_buf_t *out);
```

**必須入力フィールド**:
- `share_id`: 有効なshare_id
- `size`: バッファサイズ > 0
- `phys_addr`: 物理アドレス > 0 (※重要!)

### hb_mem_import_graph_buf()

```c
int32_t hb_mem_import_graph_buf(hb_mem_graphic_buf_t *in, hb_mem_graphic_buf_t *out);
```

**必須入力フィールド**:
- `plane_cnt`: プレーン数 (NV12の場合 2)
- `width`: 画像幅 > 0
- `height`: 画像高さ > 0 (推定)
- `format`: ピクセルフォーマット
- `share_id[i]`: 各プレーンのshare_id
- `size[i]`: 各プレーンのサイズ
- `phys_addr[i]`: 各プレーンの物理アドレス (推定)
- `stride`, `vstride`: ストライド情報 (推定)

---

## VIOバッファから取得できる情報

`hbn_vnode_image_t` 構造体:

```c
typedef struct hbn_vnode_image_s {
    hbn_frame_info_t info;       // フレーム情報
    hb_mem_graphic_buf_t buffer; // ★全フィールド入り
    void *metadata;
} hbn_vnode_image_t;
```

`yolo_frame.buffer` には以下が全て含まれる:
- `fd[i]`
- `share_id[i]`
- `size[i]`
- `virt_addr[i]`
- `phys_addr[i]`
- `plane_cnt`
- `format`
- `width`
- `height`
- `stride`
- `vstride`
- `is_contig`
- `flags`

---

## 修正方針

### 方法A: 完全バッファ記述子を共有 (推奨)

ZeroCopyFrameに`hb_mem_graphic_buf_t`をそのまま埋め込む:

```c
typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int camera_id;
    float brightness_avg;
    uint8_t correction_applied;

    // ★完全なバッファ記述子を共有
    hb_mem_graphic_buf_t buffer;  // 160 bytes

    volatile uint32_t version;
    volatile uint8_t consumed;
} ZeroCopyFrame;
```

**メリット**:
- SDKのバリデーションを全て満たす
- Consumer側で追加の変換不要

**デメリット**:
- 共有メモリサイズ増加 (~160 bytes追加)

### 方法B: 必要最小限のフィールドを追加

現在のZeroCopyFrameに`phys_addr`等を追加:

```c
typedef struct {
    // ... 既存フィールド ...

    int32_t share_id[ZEROCOPY_MAX_PLANES];
    uint64_t plane_size[ZEROCOPY_MAX_PLANES];
    uint64_t phys_addr[ZEROCOPY_MAX_PLANES];  // ★追加
    int32_t plane_cnt;
    int32_t stride;    // ★追加
    int32_t vstride;   // ★追加
    // width, height, formatは既存

    // ... sync fields ...
} ZeroCopyFrame;
```

---

## Python ctypes構造体の修正

現在のPython構造体定義（間違い）:

```python
# WRONG - フィールド順序が違う！
class hb_mem_common_buf_t(Structure):
    _fields_ = [
        ("fd", c_int32),
        ("phys_addr", c_uint64),  # ← 位置が違う
        ("virt_addr", c_uint64),
        ("size", c_uint64),
        ("share_id", c_int32),    # ← 位置が違う
        ...
    ]
```

正しい定義:

```python
class hb_mem_common_buf_t(Structure):
    """
    Matches C struct layout (48 bytes total):
    - fd:        offset 0,  size 4
    - share_id:  offset 4,  size 4
    - flags:     offset 8,  size 8
    - size:      offset 16, size 8
    - virt_addr: offset 24, size 8
    - phys_addr: offset 32, size 8
    - offset:    offset 40, size 8
    """
    _fields_ = [
        ("fd", c_int32),        # offset 0
        ("share_id", c_int32),  # offset 4
        ("flags", c_int64),     # offset 8
        ("size", c_uint64),     # offset 16
        ("virt_addr", POINTER(c_uint8)),  # offset 24
        ("phys_addr", c_uint64),  # offset 32
        ("offset", c_uint64),   # offset 40
    ]
```

```python
class hb_mem_graphic_buf_t(Structure):
    """
    Matches C struct layout (160 bytes total)
    """
    _fields_ = [
        ("fd", c_int32 * 3),         # offset 0
        ("plane_cnt", c_int32),      # offset 12
        ("format", c_int32),         # offset 16
        ("width", c_int32),          # offset 20
        ("height", c_int32),         # offset 24
        ("stride", c_int32),         # offset 28
        ("vstride", c_int32),        # offset 32
        ("is_contig", c_int32),      # offset 36
        ("share_id", c_int32 * 3),   # offset 40
        ("flags", c_int64),          # offset 56
        ("size", c_uint64 * 3),      # offset 64
        ("virt_addr", POINTER(c_uint8) * 3),  # offset 88
        ("phys_addr", c_uint64 * 3), # offset 112
        ("offset", c_uint64 * 3),    # offset 136
    ]
```

---

## hb_mem_free_buf の修正

現在のPython定義（間違い）:

```python
# WRONG - 引数はbufferではなくfd!
lib.hb_mem_free_buf.argtypes = [POINTER(hb_mem_common_buf_t)]
```

正しい定義:

```python
# int32_t hb_mem_free_buf(int32_t fd)
lib.hb_mem_free_buf.argtypes = [c_int32]
lib.hb_mem_free_buf.restype = c_int32
```

---

## 推奨実装フロー

### Producer側 (camera_daemon)

```c
// VIOからフレーム取得
hbn_vnode_image_t vio_frame;
hbn_vnode_getframe(vnode, chn, timeout, &vio_frame);

// 共有メモリに書き込み（完全なバッファ記述子を含む）
ZeroCopyFrame zc_frame = {0};
zc_frame.frame_number = frame_count;
zc_frame.timestamp = now;
zc_frame.camera_id = camera_id;
zc_frame.brightness_avg = brightness;

// ★完全なバッファ情報をコピー
memcpy(&zc_frame.buffer, &vio_frame.buffer, sizeof(hb_mem_graphic_buf_t));

shm_zerocopy_write(shm, &zc_frame);
```

### Consumer側 (Python YOLO daemon)

```python
# 共有メモリからフレーム取得
zc_frame = shm.get_frame()

# hb_mem_import_graph_buf を呼び出し（完全なバッファ記述子で）
in_buf = zc_frame.buffer  # 既に全フィールド入り
out_buf = hb_mem_graphic_buf_t()

ret = lib.hb_mem_import_graph_buf(byref(in_buf), byref(out_buf))
if ret != 0:
    raise RuntimeError(f"Import failed: {ret}")

# 仮想アドレスでアクセス
y_data = np.ctypeslib.as_array(out_buf.virt_addr[0], shape=(out_buf.size[0],))
uv_data = np.ctypeslib.as_array(out_buf.virt_addr[1], shape=(out_buf.size[1],))

# 処理完了後、解放
lib.hb_mem_free_buf(out_buf.fd[0])
if out_buf.plane_cnt > 1 and out_buf.fd[1] != out_buf.fd[0]:
    lib.hb_mem_free_buf(out_buf.fd[1])
```

---

## エラーコード一覧

| コード | 値 (decimal) | 意味 |
|--------|--------------|------|
| HB_MEM_ERR_UNKNOWN | -16777215 | 不明なエラー |
| HB_MEM_ERR_INVALID_PARAMS | -16777214 | 無効なパラメータ |
| HB_MEM_ERR_INVALID_FD | -16777213 | 無効なFD |
| HB_MEM_ERR_INVALID_VADDR | -16777212 | 無効な仮想アドレス |
| HB_MEM_ERR_INSUFFICIENT_MEM | -16777211 | メモリ不足 |
| HB_MEM_ERR_TOO_MANY_FD | -16777210 | FD数超過 |
| HB_MEM_ERR_TIMEOUT | -16777209 | タイムアウト |
| HB_MEM_ERR_MODULE_NOT_FOUND | -16777208 | モジュール未オープン |
| HB_MEM_ERR_MODULE_OPEN_FAIL | -16777207 | モジュールオープン失敗 |

---

## テスト方法

```bash
# テストプログラム実行
gcc -o test_hb_mem_api test_hb_mem_api3.c -L/usr/hobot/lib -lhbmem
LD_LIBRARY_PATH=/usr/hobot/lib:$LD_LIBRARY_PATH ./test_hb_mem_api
```

---

## 参考ファイル

- `/usr/include/hb_mem_mgr.h` - API定義
- `/usr/include/hb_mem_err.h` - エラーコード
- `/usr/include/hbmem.h` - 低レベルAPI
- `/usr/include/hbn_api.h` - VIO構造体 (hbn_vnode_image_t)
- `/app/multimedia_samples/sample_hbmem/sample_share.c` - SDKサンプル

---

---

## 代替API候補 (メモ)

### 1. hb_mem_import_com_buf_with_paddr ★有望

```c
int32_t hb_mem_import_com_buf_with_paddr(
    uint64_t phys_addr,  // 物理アドレス
    uint64_t size,       // サイズ
    int64_t flags,       // フラグ
    hb_mem_common_buf_t *buf  // 出力
);
```

**特徴**:
- phys_addr + size + flags だけでインポート可能
- share_id不要（物理アドレスで直接マッピング）
- J6専用 (J5/XJ3では使えない可能性)

**制限**:
- "hbmemからアロケートされていないメモリ専用" と記載
- VIOバッファには使えない可能性あり

### 2. hbmem_mmap_with_share_id (低レベルAPI)

```c
hbmem_addr_t hbmem_mmap_with_share_id(
    uint64_t phyaddr,    // 物理アドレス（必須！）
    uint32_t size,       // サイズ
    uint64_t flag,       // フラグ
    int32_t share_id     // share_id
);
```

**特徴**:
- 低レベル hbmem.h API
- 仮想アドレスを返す（hbmem_addr_t）
- 解放は `hbmem_munmap(addr)`

**制限**:
- phys_addr必須 → share_idだけでは使えない
- fd取得不可（キャッシュ操作などが面倒）

### 3. hb_mem_get_buffer_process_info_with_share_id

```c
int32_t hb_mem_get_buffer_process_info_with_share_id(
    int32_t share_id,
    int32_t *pid,
    int32_t num,
    int32_t *ret_num
);
```

**用途**: share_idに対応するバッファを使用中のプロセス一覧取得
**デバッグ用**: バッファリーク検出

### 4. hb_mem_get_com_buf / hb_mem_get_graph_buf

```c
int32_t hb_mem_get_com_buf(int32_t fd, hb_mem_common_buf_t *buf);
int32_t hb_mem_get_graph_buf(int32_t fd, hb_mem_graphic_buf_t *buf);
```

**用途**: fdからバッファ情報を取得
**問題**: 別プロセスのfdは使えない

### 5. hb_mem_get_*_with_vaddr

```c
int32_t hb_mem_get_com_buf_with_vaddr(uint64_t virt_addr, hb_mem_common_buf_t *buf);
int32_t hb_mem_get_graph_buf_with_vaddr(uint64_t virt_addr, hb_mem_graphic_buf_t *buf);
int32_t hb_mem_get_phys_addr(uint64_t virt_addr, uint64_t *phys_addr);
```

**用途**: 仮想アドレスからバッファ情報を取得
**問題**: 別プロセスのvirt_addrは無効

### 6. Share/Consume Count系

```c
// 共有カウント
int32_t hb_mem_get_share_info(int32_t fd, int32_t *share_client_cnt);
int32_t hb_mem_wait_share_status(int32_t fd, int32_t target_cnt, int64_t timeout);

// 消費カウント
int32_t hb_mem_inc_com_buf_consume_cnt(hb_mem_common_buf_t *buf);
int32_t hb_mem_dec_consume_cnt(int32_t fd);
int32_t hb_mem_wait_consume_status(int32_t fd, int32_t target_cnt, int64_t timeout);
```

**用途**: Producer-Consumer同期
**特徴**: セマフォ代わりに使える、SDK内蔵の同期機構

### 7. Buffer Queue系

```c
int32_t hb_mem_create_buf_queue(hb_mem_buf_queue_t *queue);
int32_t hb_mem_dequeue_buf(hb_mem_buf_queue_t *queue, int32_t *slot, void *buf, int64_t timeout);
int32_t hb_mem_queue_buf(hb_mem_buf_queue_t *queue, int32_t slot, const void *buf);
```

**用途**: Producer-Consumerパターン用のキュー
**特徴**: 複数バッファのローテーション管理
**問題**: プロセス内での使用を想定（クロスプロセスは要確認）

### 8. hb_mem_dma_copy

```c
int32_t hb_mem_dma_copy(uint64_t dst_vaddr, uint64_t src_vaddr, uint64_t size);
```

**用途**: DMAによる高速コピー（CPUバイパス）
**特徴**: J6専用、CPUオーバーヘッドなし
**問題**: コピーが発生する（zero-copyではない）

---

## API選択の結論

### 最も確実な方法: hb_mem_import_graph_buf + 完全なバッファ記述子

SDKサンプル（sample_share.c）で実証済みのパターン:
1. Producerが`hb_mem_graphic_buf_t`全体を共有メモリに書き込む
2. Consumerがそれを読み取り、`hb_mem_import_graph_buf`で自プロセスにマッピング

この方法が最も安全で、SDKのバリデーションを確実に通過する。

### 不可能な方法: share_idだけでのインポート

現状のSDKでは、share_idだけでバッファをインポートするAPIは存在しない。
必ず以下のいずれかが必要:
- phys_addr (物理アドレス)
- size + その他のメタデータ

---

## 実装チェックリスト

- [x] `ZeroCopyFrame`に`hb_mem_graphic_buf_t buffer`を追加
- [x] `camera_pipeline.c`でbuffer全体をコピー
- [x] Python `hb_mem_common_buf_t`の_fields_順序修正
- [x] Python `hb_mem_graphic_buf_t`構造体追加
- [x] `hb_mem_free_buf`引数を`int32_t fd`に修正
- [x] `hb_mem_import_graph_buf`を使用するよう変更
- [x] Python側共有メモリ読み取りを更新

---

## 作業ログ: graph_buf優先インポート修正 (2026-01-28)

### 背景

YOLO detectorが起動直後に以下のエラーで失敗:

```
Zero-copy import failed: hb_mem_import_com_buf failed: -16777214 (share_id=84, size=345600)
```

### 根本原因

`HbMemGraphicBuffer.__init__()`は、contiguousバッファ（`share_id[1]==0`）の場合に
`hb_mem_import_com_buf`を使用していた。しかし、VIOが
`HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF`で確保したバッファは、内部的には
`hb_mem_graphic_buf_t`として管理されており、`hb_mem_import_com_buf`（`hb_mem_common_buf_t`
用）ではSDKバリデーションが通らなかった。

### 変更内容 (src/capture/hb_mem_bindings.py)

| # | 変更箇所 | 内容 |
|---|---------|------|
| 1 | `__init__()` L479-489 | contiguous/multi-buffer問わず常に`hb_mem_import_graph_buf`を先に試行。失敗時、contiguousなら`hb_mem_import_com_buf`にフォールバック |
| 2 | `_import_graph_buf()` L552 | fdクリア値を`0`→`-1`に変更。fd=0はstdinであり、SDKがリジェクトする可能性がある |
| 3 | `_import_contiguous()` L514-516, `_import_graph_buf()` L561-566 | エラーメッセージに`phys_addr`を追加。デバッグ時にC側バッファの物理アドレス有無を即座に判別可能に |
| 4 | `_import_graph_buf()` L579-581 | contiguousバッファをgraph_bufでインポートした際、`virt_addr[1]==0`なら`virt_addr[0]+size[0]`でUVオフセットを算出 |

### 変更後のインポートフロー

```
HbMemGraphicBuffer.__init__(raw_buf_data)
  │
  ├─ try: _import_graph_buf()  ← 常にまず試行 (SDK推奨パス)
  │   ├─ 成功 → contiguousの場合はUV virt_addr補正
  │   └─ RuntimeError
  │       ├─ is_contiguous=True → _import_contiguous() (フォールバック)
  │       └─ is_contiguous=False → raise (リカバリ不可)
  │
  └─ 結果: self._fd, self._virt_addr, self._size, self._plane_cnt が設定
```

---

## 未解決リスク・エラーが出る可能性のある箇所

### リスク1: graph_bufもcom_bufも両方失敗するケース

**条件**: C側で`hb_mem_buf_data`に書き込んだ160バイトの中身が不完全な場合

- `phys_addr[0]==0`の場合、SDKは両APIともリジェクトする
- `camera_pipeline.c`のmemcpy元（VIO `hbn_vnode_image_t.buffer`）が正しく初期化
  されていることが前提

**確認方法**: エラーメッセージに`phys_addr=0x0`と表示されたら、C側の
`camera_pipeline.c`で`buffer`フィールドが正しくコピーされているか確認する

### リスク2: fd=-1がSDKに拒否される可能性

**変更**: `_import_graph_buf()`でfdを`-1`にクリアしている

- SDKが`fd >= 0`をバリデーションしている場合、`HB_MEM_ERR_INVALID_FD (-16777213)`
  で失敗する
- その場合は`fd=0`に戻す（stdinリスクは低い可能性がある）、
  または元の`raw_buf_data`のfdをそのまま渡す方法を検討

**確認方法**: エラーコードが`-16777213`の場合はfd関連

### リスク3: contiguousバッファのUV virt_addr補正が不正確

**変更**: `virt_addr[1] = virt_addr[0] + size[0]` で算出

- `stride != width`の場合、Y planeの実メモリサイズは`stride * vstride`であり、
  `size[0]`（=`width * height`）とは異なる可能性がある
- SDKが`virt_addr[1]`を正しく設定してくれれば、この補正は不要
  （`virt_addr[1]!=0`の場合はスキップするガード済み）

**確認方法**: UVプレーンのデータが壊れている（色ずれ・緑一色等）場合は、
`stride`と`width`の値を確認し、オフセット算出を`stride * vstride`に変更する:

```python
# stride/vstride情報を取得して正確なオフセットを算出
stride = struct_mod.unpack_from("<i", raw_buf_data, 28)[0]  # offset=28
vstride = struct_mod.unpack_from("<i", raw_buf_data, 32)[0]  # offset=32
y_plane_actual = stride * vstride
self._virt_addr[1] = self._virt_addr[0] + y_plane_actual
```

### リスク4: graph_bufインポート後のrelease()でfd[1]が無効

**状況**: contiguousバッファをgraph_bufでインポートした場合

- `fd[0]`のみ有効で`fd[1]==0`または`fd[1]==-1`になる可能性
- `release()`は`fd > 0`のみ解放するガード済み（L645: `if fd > 0`）
- ただし、`fd[1]`にゴミ値が入った場合は不正解放のリスクあり

**確認方法**: `Released buffer: fd=[X, Y]`ログでfd値を確認

### リスク5: SDK バージョン差異

**前提**: RDK X5のhb_mem SDKに依存

- `hb_mem_import_graph_buf`の挙動はSDKバージョンにより異なる可能性
- 特にcontiguousバッファに対するgraph_buf APIの対応はバージョン依存

**確認方法**: `dpkg -l | grep hobot`でSDKバージョンを確認し、
`/app/multimedia_samples/sample_hbmem/sample_share.c`のパターンと比較

---

## 検証手順

```bash
# 1. RDK X5にデプロイ後、カメラ+YOLO起動
./scripts/run_camera_switcher_yolo_streaming.sh

# 2. YOLOログで確認すべき項目
#    OK: "Imported graph_buf: fd=[X, Y], vaddr=[0x..., 0x...], ..."
#    NG: "hb_mem_import_graph_buf failed: ..." → リスク1-2を確認
#    NG: UVデータ化け → リスク3を確認

# 3. プロファイラで定量確認
uv run scripts/profile_shm.py

# 4. SDKバージョン確認（トラブル時）
dpkg -l | grep hobot
cat /etc/sunrise_version 2>/dev/null || cat /etc/hrut_version 2>/dev/null
```
