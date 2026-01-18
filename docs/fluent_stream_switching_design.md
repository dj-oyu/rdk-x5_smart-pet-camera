# Fluent Stream Switching Design

**Date**: 2025-12-23
**Status**: Design Discussion
**Related**: camera_switcher_h264_migration.md

---

## 目標

カメラ切り替え時に視聴者が気づかない（または最小限の影響）で、NV12とH.264の両ストリームをスムーズに切り替える。

---

## 課題分析

### 現在の切り替えメカニズム（JPEG時代）

```c
// camera_switcher_runtime.c
if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
    do_switch(rt, CAMERA_MODE_DAY, "auto-day");
}

// camera_switcher_daemon.c - switch_camera_cb()
1. FPS調整シグナル送信:
   - 新アクティブカメラ → 30fps (interval=0)
   - 旧アクティブカメラ → 2fps (interval=500ms)

2. フレームコピー開始:
   - 新アクティブカメラの共有メモリから読む
   - メイン共有メモリへ書き込む
```

**問題点**:
- ✅ ブラックアウトなし（両カメラ常時動作）
- ✅ warmup_frames（3フレーム）でウォームアップ
- ❌ H.264特有の問題未考慮

---

### H.264特有の課題

#### 課題1: キーフレーム依存性
**問題**: H.264デコーダーはキーフレーム（I-frame）から再生開始する必要がある

```
カメラ切り替え:
Day camera: ...P-P-P-I-P-P-P-I-P-P...
            切り替え ↑
Night camera: ...P-P-I-P-P-P-I-P-P...
                  ↑ここから配信開始すべき
```

**影響**:
- P-frameから配信すると、視聴者は次のI-frameまで画面が乱れる
- 最悪、次のI-frameまで（最大1秒@30fps、keyframe_interval=30）待つ

#### 課題2: NV12とH.264のフレーム同期
**問題**: VIOとEncoderは非同期で動作

```
VIO (NV12):    F1  F2  F3  F4  F5  F6
Encoder (H264):   F1  F2  F3  F4  F5  ← 1-2フレーム遅延
```

**影響**:
- 切り替え時にNV12とH.264のフレーム番号がズレる
- 検出結果とH.264ストリームが不整合になる可能性

#### 課題3: ウォームアップ中のストリーム
**問題**: 非アクティブカメラは2fpsなので、30fps化した直後のフレームは古い

```
2fps動作中:
t=0ms    t=500ms   t=1000ms  ← 切り替え
[Frame1] [Frame2]  [Frame3]

30fps化後:
t=1000ms t=1033ms t=1066ms t=1100ms
[Frame3] [Frame4] [Frame5] [Frame6]
         ↑ ウォームアップ（3フレーム）
```

**影響**:
- warmup_frames=3なら100ms待つ
- この間、旧カメラのストリームを継続すべきか、黒画面か？

---

## 設計案

### 案A: キーフレーム同期型（推奨）

**コンセプト**: カメラ切り替え時に新カメラに即座にキーフレームを要求し、それを受信してから切り替える

#### アーキテクチャ

```
switcher決定: カメラ切り替え
    ↓
1. シグナル送信: 新カメラに "SIGUSR2" (keyframe request)
    ↓
2. 新カメラ: 次のフレームを強制的にI-frameに設定
    ↓
3. switcher: 新カメラからI-frameを検出するまでポーリング
    ↓
4. I-frame受信: ストリーム切り替え実行
    ↓
5. FPS調整: 旧カメラを2fps化
```

#### 実装詳細

**camera_daemon_drobotics.c**:
```c
static volatile sig_atomic_t g_request_keyframe = 0;

void handle_sigusr2(int sig) {
    g_request_keyframe = 1;  // 次フレームをI-frameに
}

// run_capture_loop()内
if (g_request_keyframe) {
    // libspcdevでキーフレーム要求
    // Note: libspcdevがこのAPIをサポートしているか要確認
    // sp_encoder_request_idr(ctx->encoder_object);
    g_request_keyframe = 0;
}
```

**camera_switcher_daemon.c**:
```c
static int switch_camera_cb(CameraMode camera, void *user_data) {
    DaemonContext *ctx = (DaemonContext *)user_data;

    // 1. キーフレーム要求
    pid_t target_pid = (camera == CAMERA_MODE_DAY) ? ctx->day_pid : ctx->night_pid;
    kill(target_pid, SIGUSR2);
    printf("[switcher] Requested keyframe from camera %d\n", camera);

    // 2. I-frameを待つ（最大500ms）
    SharedFrameBuffer *target_shm_h264 =
        (camera == CAMERA_MODE_DAY) ? ctx->day_shm_h264 : ctx->night_shm_h264;

    int retries = 50;  // 50 × 10ms = 500ms
    bool keyframe_found = false;
    while (retries-- > 0) {
        Frame h264_frame;
        if (shm_frame_buffer_read_latest(target_shm_h264, &h264_frame) >= 0) {
            if (is_h264_keyframe(h264_frame.data, h264_frame.data_size)) {
                keyframe_found = true;
                printf("[switcher] Keyframe detected, switching now\n");
                break;
            }
        }
        usleep(10000);  // 10ms
    }

    if (!keyframe_found) {
        printf("[switcher] Warning: Keyframe timeout, switching anyway\n");
    }

    // 3. ストリーム切り替え（通常処理）
    ctx->active_camera = camera;

    // 4. FPS調整
    // ... (既存のロジック)
}

// H.264 NAL unit判定（簡易版）
static bool is_h264_keyframe(const uint8_t *data, size_t size) {
    // NAL unit typeをチェック
    // I-frame: NAL type = 5 (IDR)
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

**メリット**:
- ✅ 切り替え直後から正常なH.264デコード可能
- ✅ 視聴者への影響最小
- ✅ レイテンシー最小（500ms以内）

**デメリット**:
- ❌ libspcdevがキーフレーム要求APIをサポートしているか不明
- ❌ 実装複雑度やや高

---

### 案B: ダブルバッファ + タイムスタンプ同期型

**コンセプト**: NV12とH.264のフレーム番号を厳密に同期させ、両方が揃ってから切り替え

#### アーキテクチャ

```
各カメラ:
├─ NV12取得（frame_number: N）
├─ H.264取得（frame_number: N または N-1）← 1フレーム遅延の可能性
└─ 両方に同じframe_numberを付与

switcher:
├─ NV12とH.264の両方が同じframe_numberか確認
└─ 一致したペアだけを配信
```

**実装詳細**:

```c
// camera_daemon_drobotics.c
uint64_t frame_counter = 0;

while (running) {
    // NV12取得
    sp_vio_get_yuv(ctx->vio_object, nv12_buffer, ...);
    Frame nv12_frame;
    nv12_frame.frame_number = frame_counter;
    nv12_frame.format = 1;  // NV12
    // ... NV12共有メモリに書き込み

    // H.264取得
    stream_size = sp_encoder_get_stream(ctx->encoder_object, h264_buffer);
    Frame h264_frame;
    h264_frame.frame_number = frame_counter;  // 同じ番号
    h264_frame.format = 3;  // H.264
    // ... H.264共有メモリに書き込み

    frame_counter++;
}
```

**メリット**:
- ✅ NV12とH.264の厳密な同期
- ✅ 検出結果との整合性保証

**デメリット**:
- ❌ キーフレーム問題は未解決
- ❌ VIO/Encoderの実際の非同期性を無視している

---

### 案C: バッファオーバーラップ型（保守的）

**コンセプト**: 切り替え中は一時的に両カメラのストリームを保持し、クライアント側で選択

#### アーキテクチャ

```
メイン共有メモリに「遷移状態」を追加:

typedef struct {
    CameraMode active_camera;
    CameraMode transitioning_to;  // 切り替え中の対象
    uint32_t transition_frame_count;  // 遷移中フレーム数
    Frame frames[2];  // [0]=current, [1]=next
} TransitionBuffer;
```

**切り替えシーケンス**:
1. 旧カメラストリーム継続
2. `transitioning_to = NIGHT` をセット
3. warmup期間中、両方のフレームを保持
4. クライアントはH.264のキーフレームを検出して切り替え
5. 遷移完了後、`transitioning_to = NONE`

**メリット**:
- ✅ クライアント側で最適なタイミングで切り替え可能
- ✅ サーバー側の実装シンプル

**デメリット**:
- ❌ クライアント実装が複雑（WebRTC, レコーダー両方）
- ❌ 帯域幅2倍（一時的）

---

### 案D: ウォームアップ延長 + 定期キーフレーム型（最もシンプル）

**コンセプト**: キーフレーム間隔を短く設定し、ウォームアップを十分に取る

#### パラメータ設定

```c
// camera_daemon起動時
H264_KEYFRAME_INTERVAL = 15  // 0.5秒 @ 30fps（デフォルト30から短縮）
WARMUP_FRAMES = 15           // 0.5秒分のウォームアップ

// camera_switcher_runtime.c
cfg.warmup_frames = 15;  // 3 → 15
```

**シーケンス**:
```
切り替え決定
    ↓
FPS調整（新カメラ→30fps）
    ↓
0.5秒待つ（warmup 15フレーム）
    ↓
この間に少なくとも1回はキーフレームが来る（確率99%）
    ↓
ストリーム切り替え
```

**メリット**:
- ✅ 実装が最もシンプル
- ✅ 既存コードへの変更最小
- ✅ ハードウェアエンコーダーの機能だけで実現

**デメリット**:
- ❌ 切り替え遅延が0.5秒（許容範囲？）
- ❌ ファイルサイズ増（キーフレーム頻度増）

---

## 比較表

| 項目 | 案A: キーフレーム同期 | 案B: タイムスタンプ同期 | 案C: バッファオーバーラップ | 案D: ウォームアップ延長 |
|------|---------------------|----------------------|--------------------------|----------------------|
| **切り替え遅延** | 50-500ms | 即座（キーフレーム問題あり） | クライアント依存 | 500ms固定 |
| **実装複雑度** | 高 | 中 | 高（クライアント側） | **低** |
| **視聴者影響** | **最小** | 中（画面乱れ可能性） | 最小 | 最小 |
| **帯域幅** | 通常 | 通常 | 2倍（一時） | 通常 |
| **libspcdev依存** | キーフレームAPI必要 | なし | なし | なし |
| **ファイルサイズ** | 通常 | 通常 | 通常 | やや増 |
| **推奨度** | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

---

## 推奨アプローチ

### フェーズ1: 案D（ウォームアップ延長）から開始

**理由**:
1. 最もシンプルで確実
2. 既存コードへの変更最小
3. libspcdev APIの調査不要
4. 0.5秒の遅延は明度ベース切り替えなら許容範囲

**設定**:
```c
// camera_daemon_drobotics.c
#define H264_KEYFRAME_INTERVAL 15  // 0.5秒

// sp_start_encode()呼び出し時にパラメータ設定
// Note: libspcdevのAPI仕様要確認
```

**camera_switcher調整**:
```c
// camera_switcher_daemon.c
cfg.warmup_frames = 15;  // 3 → 15に増加
cfg.day_to_night_hold_seconds = 1.0;  // 0.5 → 1.0（誤切り替え防止）
```

### フェーズ2: 案A（キーフレーム同期）に移行（オプショナル）

**条件**:
- libspcdevがキーフレーム要求APIをサポート
- 切り替え遅延を100ms以下にしたい
- ファイルサイズを最適化したい

**追加実装**:
- SIGUSR2ハンドラー
- キーフレーム検出ロジック
- タイムアウト処理

---

## シグナルベースの制御フロー

### 現在のシグナル

```c
SIGUSR1: フレーム間隔変更通知
  - カメラデーモンが共有メモリのframe_interval_msを読み直す
  - アクティブ⇄非アクティブの切り替え
```

### 提案: 新規シグナル

```c
SIGUSR2: キーフレーム要求（案A実装時）
  - 次のH.264フレームをI-frameにする
  - 切り替え直前に送信

SIGRTMIN: ストリーム品質変更（将来の拡張）
  - ビットレート動的変更
  - 解像度変更
```

---

## 共有メモリベースの状態同期

### 拡張提案: TransitionState構造体

```c
// shared_memory.h
typedef struct {
    CameraMode active_camera;
    CameraMode next_camera;  // 切り替え中の対象（NONE=切り替えなし）
    uint32_t transition_start_frame;  // 切り替え開始フレーム番号
    uint32_t warmup_remaining;  // 残りウォームアップフレーム数
} CameraSwitchState;

typedef struct {
    // 既存フィールド
    volatile uint32_t write_index;
    volatile uint32_t frame_interval_ms;

    // 新規: 切り替え状態
    CameraSwitchState switch_state;  // アトミック操作が必要

    Frame frames[RING_BUFFER_SIZE];
} SharedFrameBuffer;
```

**利点**:
- クライアント（recorder, monitor）が切り替え状態を認識可能
- UI表示: "カメラ切り替え中..."
- レコーダー: 切り替え境界にメタデータ挿入

---

## 実装優先順位

**調査完了により優先順位を更新**（2025-12-23）

### P0: 必須（案D実装）
- [x] libspcdev API調査（keyframe_interval設定方法） ✅ 完了
- [x] 実録画GOP分析（デフォルト間隔確認） ✅ GOP=14フレーム
- [ ] warmup_frames延長（3 → 15フレーム）
- [ ] 統合テスト（カメラ切り替え時のストリーム連続性確認）

### P1: 推奨（最適化）
- [ ] キーフレーム検出ロジック（warmup短縮用）
- [ ] TransitionState追加（UI改善用）
- [ ] 切り替え遅延ログ追加（実測値収集）

### P2: 将来的な改善
- [ ] libspcdev APIアップデート監視（GOP制御API追加待ち）
- [ ] 案Aへの移行準備（SIGUSR2ハンドラー設計）
- [ ] クライアント側バッファリング（案C）

### ❌ 実装見送り
- ~~H.264 keyframe_interval設定~~ - API制約により不可能
- ~~SIGUSR2ハンドラー実装（案A）~~ - 動的キーフレーム要求API不在
- ~~動的keyframe_interval調整~~ - API制約により不可能

---

## libspcdev API調査項目

### 確認が必要な機能

1. **キーフレーム間隔設定**:
   ```c
   // sp_start_encode()のパラメータで設定可能か？
   int sp_start_encode(void *encoder, int channel, int codec_type,
                       int width, int height, int bitrate);

   // 追加パラメータが必要？
   typedef struct {
       int gop_size;  // キーフレーム間隔
       int profile;   // H.264 profile
       int level;     // H.264 level
   } sp_encoder_params;
   ```

2. **動的キーフレーム要求**:
   ```c
   // このようなAPIが存在するか？
   int sp_encoder_request_idr(void *encoder);
   int sp_encoder_force_keyframe(void *encoder);
   ```

3. **ストリーム情報取得**:
   ```c
   // NAL unit typeなどのメタデータ取得
   int sp_encoder_get_stream_info(void *encoder, sp_stream_info *info);
   ```

**調査方法**:
```bash
# ヘッダーファイル確認
grep -r "gop\|keyframe\|idr" /usr/include/sp_*.h

# サンプルコード確認
find /app/cdev_demo -name "*.c" -exec grep -l "sp_start_encode" {} \;

# ドキュメント確認
ls /usr/share/doc/hobot-multimedia/
```

---

## テスト計画

### 単体テスト
1. キーフレーム間隔確認
   ```bash
   ffprobe -show_frames recording.h264 | grep "pict_type=I" | wc -l
   # 2秒録画（60フレーム）で4回検出されればOK（15フレーム間隔）
   ```

2. 切り替え遅延測定
   ```bash
   # タイムスタンプログから測定
   grep "switching to camera" /var/log/camera_switcher.log
   ```

### 統合テスト
1. 明度変化での自動切り替え
2. ストリーム連続性確認（VLC再生）
3. レコーダーファイルの再生確認

---

## libspcdev API調査結果

**調査日**: 2025-12-23

### 調査方法

1. ヘッダーファイル解析: `/usr/include/sp_codec.h`, `/usr/include/sp_vio.h`
2. サンプルコード解析: `/app/cdev_demo/vio2encoder/vio2encoder.c`
3. ライブラリシンボル確認: `nm -D /usr/lib/libspcdev.so`
4. 実録画ファイルGOP分析: `ffprobe` によるフレームタイプ解析

### 調査結果

#### 1. エンコーダーAPI仕様

**利用可能なAPI**:
```c
void *sp_init_encoder_module();
void sp_release_encoder_module(void *obj);

int32_t sp_start_encode(void *obj, int32_t chn, int32_t type,
                        int32_t width, int32_t height, int32_t bits);
int32_t sp_stop_encode(void *obj);

int32_t sp_encoder_set_frame(void *obj, char *frame_buffer, int32_t size);
int32_t sp_encoder_get_stream(void *obj, char *stream_buffer);
```

**重要な発見**:
- ❌ `sp_start_encode()`にGOP設定パラメータなし（width, height, bitrateのみ）
- ❌ 動的キーフレーム要求API なし（`sp_encoder_request_idr()`等は存在しない）
- ❌ エンコーダー詳細設定用構造体なし
- ❌ ストリームメタデータ取得API なし

#### 2. デフォルトGOP設定

**実測値**（recording_20251223_223031.h264を解析）:
```
Frame 1:  I (キーフレーム)
Frame 2:  P
Frame 3:  P
...
Frame 14: P
Frame 15: I (キーフレーム)
Frame 16: P
...
Frame 29: I (キーフレーム)
```

**GOP構造**:
- **GOP Size: 14フレーム**
- **キーフレーム間隔: 14フレーム = 約470ms @ 30fps**
- **GOP Pattern: I + 13 P-frames**

#### 3. 設計への影響

**案A（キーフレーム同期型）**:
- ❌ **実装不可能** - 動的キーフレーム要求APIが存在しない
- ❌ GOP設定変更もできない

**案B（タイムスタンプ同期型）**:
- ⚠️ キーフレーム問題は未解決のまま

**案C（バッファオーバーラップ型）**:
- ✅ API制約の影響なし
- ❌ クライアント実装が複雑

**案D（ウォームアップ延長型）**:
- ✅ **最適解として確定**
- ✅ デフォルトGOP（470ms）が既に短い
- ✅ warmup 500ms（15フレーム）設定で、ほぼ確実にキーフレームから開始可能
- ✅ 追加APIコール不要
- ✅ 実装が最もシンプル

### 結論と推奨事項

#### 採用アプローチ

**案D（ウォームアップ延長型）を推奨**

**根拠**:
1. libspcdevのデフォルトGOP（14フレーム/470ms）が既に十分短い
2. warmup_framesを3→15に変更するだけで実装可能
3. API制約を回避できる
4. 切り替え遅延500msは明度ベース切り替えでは許容範囲

**設定値**:
```c
// camera_switcher_daemon.c
cfg.warmup_frames = 15;  // 3 → 15 (約500ms @ 30fps)

// 確率計算:
// - GOP間隔: 470ms
// - Warmup期間: 500ms
// - キーフレーム遭遇確率: ~100%
```

**追加最適化（オプショナル）**:
- H.264ストリームのNAL unit解析によるキーフレーム検出
- warmup期間中にI-frameを検出したら即座に切り替え（遅延最小化）

#### 案Aの将来性

libspcdevのバージョンアップで以下のAPIが追加されれば、案Aへの移行を検討:
```c
// 仮想的なAPI（現在は存在しない）
int sp_encoder_set_gop_size(void *obj, int gop_frames);
int sp_encoder_request_keyframe(void *obj);
int sp_encoder_get_frame_info(void *obj, sp_frame_info *info);
```

**監視対象**:
- libspcdev バージョン（現在: `/usr/lib/libspcdev.so`）
- D-Robotics公式ドキュメント更新
- コミュニティフォーラムでのAPI要望

---

## 参考資料

- [H.264 Specification - ITU-T H.264](https://www.itu.int/rec/T-REC-H.264)
- [libspcdev Documentation](./hw_encoding_faq.md)
- [camera_switcher Implementation](../src/capture/camera_switcher.c)

---

**Last Updated**: 2025-12-23
**Status**: ✅ API調査完了 - **案D（ウォームアップ延長型）で実装確定**
**Next Action**: camera_switcher_daemon.c の warmup_frames を 3→15 に変更
