# Camera Switcher リファクタリング計画

## 概要

複雑なコールバック・シグナル・マルチスレッド構成を、共有メモリベースのシンプルなポーリングループに置き換える。

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
└── 共有メモリ
    ├── /pet_camera_control        (active_camera_index)  ★新規
    ├── /pet_camera_zc_0           (ZeroCopyFrame + brightness_avg)
    ├── /pet_camera_zc_1           (ZeroCopyFrame + brightness_avg)
    └── /pet_camera_stream         (H.264)
```

### 新しいメインループ

```c
// camera_switcher_daemon.c - 新設計
int switcher_loop(SwitcherContext *ctx) {
    while (ctx->running) {
        // 1. DAYカメラのbrightnessを直接読み取り
        ZeroCopyFrame *day_frame = shm_zerocopy_read(ctx->shm_day);
        float brightness = day_frame->brightness_avg;

        // 2. 切り替え判定 (既存ロジック再利用)
        CameraSwitchDecision decision = camera_switcher_check_brightness(
            &ctx->switcher, brightness, ctx->active_camera);

        // 3. 切り替え実行
        if (decision.should_switch) {
            // 共有メモリのフラグを更新するだけ
            // シグナル不要、camera_daemonは次ループで参照
            __atomic_store_n(&ctx->control->active_camera_index,
                            decision.target_camera, __ATOMIC_RELEASE);
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

### Phase 1: 共有メモリ制御構造追加

**目標**: active_camera_indexを共有メモリで公開

```c
// shared_memory.h に追加
#define SHM_NAME_CONTROL "/pet_camera_control"

typedef struct {
    volatile int active_camera_index;  // 0=DAY, 1=NIGHT
    volatile uint32_t version;         // 変更検知用
} CameraControl;

// API
CameraControl* shm_control_create(const char* name);
CameraControl* shm_control_open(const char* name);
void shm_control_close(CameraControl* ctrl);
```

**変更ファイル**:
- `shared_memory.h` - 構造体・API追加
- `shared_memory.c` - 実装追加

### Phase 2: camera_daemon側の対応

**目標**: camera_daemonがactive_camera_indexを参照

```c
// camera_daemon_main.c
while (running) {
    vio_get_frame(&vio, &frame);

    // brightness計算・ZeroCopyFrame書き込みは常に実行
    write_zerocopy_shm(my_shm, &frame, brightness);

    // active_camera_indexを参照してH.264エンコード判定
    int is_active = (control->active_camera_index == my_camera_id);
    if (is_active) {
        encoder_encode_frame(...);
        write_h264_shm(...);
    }

    vio_release_frame(&vio, &frame);
}
```

**変更ファイル**:
- `camera_daemon.c` - SIGUSR1/2ハンドラ削除、control参照追加
- `camera_pipeline.c` - is_active判定追加

### Phase 3: switcher_daemon簡素化

**目標**: 単一スレッドポーリングループに置き換え

```c
// camera_switcher_daemon.c - 新実装
typedef struct {
    pid_t day_pid;
    pid_t night_pid;
    CameraMode active_camera;
    CameraControl *control;           // ★新規
    ZeroCopyFrameBuffer *shm_day;     // ★変更: ZeroCopy SHM
    CameraSwitcher switcher;          // 既存ロジック再利用
    volatile int running;
} SwitcherContext;

int main(int argc, char *argv[]) {
    SwitcherContext ctx = {0};

    // 初期化
    ctx.control = shm_control_create(SHM_NAME_CONTROL);
    ctx.shm_day = shm_zerocopy_open(SHM_NAME_YOLO_ZEROCOPY);  // DAYのZeroCopy
    camera_switcher_init(&ctx.switcher, &config);

    // camera_daemon起動
    ctx.day_pid = spawn_daemon(DAY);
    ctx.night_pid = spawn_daemon(NIGHT);

    // メインループ
    ctx.running = 1;
    switcher_loop(&ctx);

    // クリーンアップ
    cleanup(&ctx);
    return 0;
}
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
| 共有メモリ | 3種類 | 2種類 (control + zerocopy) |
| コード行数 | ~700行 (runtime含む) | ~200行 |
| 切り替え遅延 | シグナル伝搬 (~10ms) | 即座 (次フレームから) |

---

## 依存関係

### 前提条件

1. **hb_mem API問題の解決** (Phase 1-3)
   - ZeroCopyFrameにbuffer全体を含める
   - Python側でimport成功する状態

2. **ZeroCopyFrame.brightness_avgの確認**
   - camera_daemonがISPからbrightness取得
   - ZeroCopyFrameに書き込み済み

### 並行作業可能な項目

- Phase 1 (control SHM追加) は hb_mem修正と並行可能
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

### Phase 1
- [ ] `CameraControl` 構造体定義
- [ ] `shm_control_*` API実装
- [ ] 単体テスト

### Phase 2
- [ ] camera_daemonのSIGUSR1/2ハンドラ削除
- [ ] control SHM参照追加
- [ ] is_active判定実装
- [ ] 動作確認

### Phase 3
- [ ] `camera_switcher_daemon.c` 書き換え
- [ ] `camera_switcher_runtime.*` 削除
- [ ] 統合テスト

### Phase 4
- [ ] 切り替えテスト (DAY↔NIGHT)
- [ ] 応答時間計測
- [ ] CPU使用率計測
- [ ] 長時間テスト
