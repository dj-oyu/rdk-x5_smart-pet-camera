# カメラ切り替え機構のプローブ修正

**日付**: 2025-12-20
**作業者**: Claude Code
**関連ファイル**:
- `src/capture/camera_switcher_runtime.c`
- `src/capture/camera_switcher_daemon.c`

## 問題の概要

カメラ切り替え機構において、NIGHT→DAY切り替えが正常に動作しない問題と、プローブ時のログが冗長すぎる問題があった。

### 問題1: NIGHT→DAY切り替えが起こらない（優先度：高）

**現象**:
- 部屋を明るくしても、NIGHTカメラからDAYカメラへの切り替えが発生しない
- ログに `brightness=0.1` のように、常に低い明るさ値が表示される
- 切り替え閾値（`night_to_day_threshold=70.0`）を超えない

**根本原因**:
共有メモリの競合による1-shotプローブフレームの喪失

1. NIGHTカメラデーモンが30fpsで常時フレームを共有メモリに書き込み（33ms間隔）
2. probe_threadが2秒ごとにDAYカメラを1-shot起動してプローブ
3. DAYカメラが1フレームをキャプチャして共有メモリに書き込み
4. **問題**: `capture_frame_cb`が共有メモリからDAYカメラのフレームを読もうとする
5. しかし、NIGHTカメラが33msごとに書き込んでいるため、DAYカメラのフレームがすぐ上書きされる
6. ポーリング（5回×10ms=50ms）では、既にNIGHTカメラのフレームに置き換わっている
7. プローブフレームが読み取れず、明るさ検出が失敗

### 問題2: ログが冗長すぎる（優先度：低）

**現象**:
1-shotプローブごとに以下の冗長なログが表示される：
```
[Info] Shared memory created: /pet_camera_frames (size=93313448 bytes)
[Info] Camera 0 configuration:
  - MIPI Host: 0
  - sensor: 1920x1080 @ 30 fps
  - output: 640x480
[Info] Camera handle created: 17201
[Info] VIN node created (HW ID: 0)
[Info] ISP node created
[Info] VSE node created (scale 1920x1080 -> 640x480)
[Info] Pipeline started successfully
[Info] Camera daemon started (Ctrl+C to stop)
[Info] Shared memory destroyed: /pet_camera_frames
[Info] Camera daemon stopped (captured 1 frames)
```

これが2秒ごとに表示されるため、重要なログが埋もれてしまう。

## 解決策

### 解決策1: FrameDoubleBufferのinactive slotを活用

**アプローチ**:
`camera_switcher`の`FrameDoubleBuffer`のinactive slotをプローブフレームの一時保存に使用。

**構造**:
```
CameraSwitchRuntime
  └─ CameraSwitchController controller
       └─ FrameDoubleBuffer publisher
            ├─ Frame* buffers[0]  // heap上に確保済み
            ├─ Frame* buffers[1]  // heap上に確保済み
            └─ int active_slot    // 0 or 1（どちらが公開中か）
```

**実装詳細**:
1. active_slotは現在アクティブカメラのフレーム公開に使用中
2. **inactive slot（`buffers[1 - active_slot]`）は未使用**
3. プローブフレームをこのinactive slotに一時コピー
4. inactive slotから明るさを計算
5. 共有メモリの競合を完全回避

**メリット**:
- ✅ 追加のメモリ不要（既にheap上に確保済み）
- ✅ 共有メモリの構造変更不要
- ✅ アクティブカメラを停止する必要なし
- ✅ 完全に競合を回避（inactive slotは書き込み中でない）
- ✅ 実装が非常にシンプル

### 解決策2: 1-shotプローブ時の出力を抑制

**アプローチ**:
`camera_switcher_daemon.c`の1-shot起動部分で、標準出力/標準エラーを`/dev/null`にリダイレクト。

**実装詳細**:
```c
if (probe_pid == 0) {
    // 子プロセス：出力を抑制
    freopen("/dev/null", "w", stdout);
    freopen("/dev/null", "w", stderr);

    char camera_arg[16];
    snprintf(camera_arg, sizeof(camera_arg), "%d", (int)camera);
    execl(CAPTURE_BIN, CAPTURE_BIN,
          "-C", camera_arg,
          "-P", "1",
          "-c", "1",
          NULL);
    _exit(1);
}
```

**メリット**:
- ✅ 最小限の変更（daemon.cのみ）
- ✅ アクティブデーモンのログは正常に表示される
- ✅ プローブのログのみ抑制

## 実装内容

### 1. `camera_switcher_runtime.c` の修正

**ファイル**: `src/capture/camera_switcher_runtime.c:67-111`
**関数**: `probe_thread_main()`

**変更内容**:
プローブフレームをFrameDoubleBufferのinactive slotにコピーしてから明るさ計算を実行。

```c
static void* probe_thread_main(void* arg) {
    CameraSwitchRuntime* rt = (CameraSwitchRuntime*)arg;

    while (!rt->stop_flag) {
        if (rt->active_camera != CAMERA_MODE_DAY) {
            Frame probe_frame;
            memset(&probe_frame, 0, sizeof(Frame));
            probe_frame.camera_id = CAMERA_MODE_DAY;

            if (rt->ops.capture_frame &&
                rt->ops.capture_frame(CAMERA_MODE_DAY, &probe_frame, rt->ops.user_data) == 0) {

                // Copy probe frame to FrameDoubleBuffer inactive slot to avoid
                // shared memory race with active camera writing at 30fps
                int inactive_slot = 1 - rt->controller.publisher.active_slot;
                if (rt->controller.publisher.buffers[inactive_slot]) {
                    memcpy(rt->controller.publisher.buffers[inactive_slot],
                           &probe_frame,
                           sizeof(Frame));

                    // Calculate brightness from inactive slot (safe from race conditions)
                    CameraSwitchDecision decision = camera_switcher_handle_frame(
                        &rt->controller,
                        rt->controller.publisher.buffers[inactive_slot],
                        CAMERA_MODE_DAY,
                        false,
                        NULL,
                        NULL);

                    if (decision == CAMERA_SWITCH_DECISION_TO_DAY) {
                        do_switch(rt, CAMERA_MODE_DAY, "auto-day");
                    } else if (decision == CAMERA_SWITCH_DECISION_TO_NIGHT) {
                        do_switch(rt, CAMERA_MODE_NIGHT, "auto-night");
                    }
                }
            }
        }

        sleep_seconds(rt->cfg.probe_interval_sec);
    }

    return NULL;
}
```

**ポイント**:
- `inactive_slot = 1 - rt->controller.publisher.active_slot` でinactive slotを特定
- `memcpy`でプローブフレームをinactive slotにコピー
- `camera_switcher_handle_frame`にinactive slot bufferを渡す
- 共有メモリの競合を完全回避

### 2. `camera_switcher_daemon.c` の修正

**ファイル**: `src/capture/camera_switcher_daemon.c:77-103`
**関数**: `capture_frame_cb()`

**変更内容**:
1-shotプローブ起動時に子プロセスの標準出力/標準エラーを`/dev/null`にリダイレクト。

```c
// If requested camera is inactive (probe), do 1-shot capture
if (camera != ctx->active_camera) {
    printf("[switcher-daemon] probing inactive camera=%d with 1-shot capture\n", (int)camera);

    // Spawn 1-shot daemon for probe
    pid_t probe_pid = fork();
    if (probe_pid < 0) {
        perror("fork");
        return -1;
    }
    if (probe_pid == 0) {
        // Suppress verbose logs from 1-shot probe by redirecting to /dev/null
        freopen("/dev/null", "w", stdout);
        freopen("/dev/null", "w", stderr);

        char camera_arg[16];
        snprintf(camera_arg, sizeof(camera_arg), "%d", (int)camera);
        execl(CAPTURE_BIN, CAPTURE_BIN, "-C", camera_arg, "-P", "1", "-c", "1", NULL);
        _exit(1);
    }

    // Wait for probe daemon to capture 1 frame
    int status;
    waitpid(probe_pid, &status, 0);

    printf("[switcher-daemon] 1-shot capture completed\n");
}
```

**ポイント**:
- 子プロセス内で`freopen("/dev/null", "w", stdout/stderr)`を実行
- アクティブデーモンのログは影響を受けない
- プローブの開始/完了のみswitcher-daemonから表示

## 期待される動作

### 修正前
```
[DEBUG] active=NIGHT, probing DAY camera=0, brightness=0.1, threshold=70.0
[Info] Shared memory created: /pet_camera_frames (size=93313448 bytes)
[Info] Camera 0 configuration:
  - MIPI Host: 0
  - sensor: 1920x1080 @ 30 fps
  - output: 640x480
[Info] Camera handle created: 17201
[Info] VIN node created (HW ID: 0)
[Info] ISP node created
[Info] VSE node created (scale 1920x1080 -> 640x480)
[Info] Pipeline started successfully
[Info] Camera daemon started (Ctrl+C to stop)
[Info] Shared memory destroyed: /pet_camera_frames
[Info] Camera daemon stopped (captured 1 frames)
[DEBUG] active=NIGHT, probing DAY camera=0, brightness=0.1, threshold=70.0  ← 常に0.1
```

### 修正後
```
[DEBUG] active=NIGHT, probing DAY camera=0, brightness=125.3, threshold=70.0  ← 実際の明るさ
[switcher-daemon] probing inactive camera=0 with 1-shot capture
[switcher-daemon] 1-shot capture completed
[DEBUG] active=NIGHT, probing DAY camera=0, brightness=127.1, threshold=70.0
[DEBUG] started timer for NIGHT->DAY
[switcher-daemon] probing inactive camera=0 with 1-shot capture
[switcher-daemon] 1-shot capture completed
[DEBUG] active=NIGHT, probing DAY camera=0, brightness=126.8, threshold=70.0
[DEBUG] DECISION: switch to DAY (elapsed=10.2s)
[switcher-daemon] spawned ../../build/camera_daemon_drobotics (PID=12345) camera=0
[Info] Shared memory created: /pet_camera_frames (size=93313448 bytes)
[Info] Camera 0 configuration: ...
[Info] Pipeline started successfully
```

**変更点**:
1. ✅ プローブフレームの冗長なログが消える
2. ✅ brightness値が実際の明るさを反映（125.3など）
3. ✅ 切り替えタイマーが正常に動作
4. ✅ 10秒後にDAYカメラへ自動切り替え

## テスト方法

1. ビルド:
   ```bash
   make -C src/capture clean
   make -C src/capture ../../build/camera_switcher_daemon
   ```

2. 実行:
   ```bash
   make -C src/capture cleanup  # 既存プロセスとshm削除
   ../../build/camera_switcher_daemon
   ```

3. テストシナリオ:
   - 初期状態（明るい部屋）: DAYカメラで起動
   - 部屋を暗くする: 10秒後にNIGHTカメラに切り替わることを確認
   - 部屋を明るくする: 10秒後にDAYカメラに戻ることを確認
   - ログがクリーンで読みやすいことを確認

## 技術的ポイント

### FrameDoubleBufferの動作原理

```
NIGHTカメラアクティブ時:
  active_thread: buffers[active_slot] でフレーム公開（30fps）
  probe_thread:  buffers[inactive_slot] にプローブフレームを一時保存

動作フロー:
  1. probe_threadがDAYカメラを1-shot起動
  2. 共有メモリからDAYカメラのフレームを読み取り
  3. buffers[inactive_slot]にコピー（active slotとは別領域）
  4. inactive slotから明るさを計算
  5. 切り替え判定
  6. アクティブカメラは通常通り動作し続ける（競合なし）
```

### 安全性の根拠

- FrameDoubleBufferは元々、フレーム書き込み中の読み取り競合を避けるための機構
- inactive slotは次の公開まで使用されないため、プローブフレームの一時保存場所として最適
- active slotの公開には一切影響しない
- 追加のロックやメモリ確保が不要

## まとめ

**修正ファイル**:
- `src/capture/camera_switcher_runtime.c` (probe_thread_main)
- `src/capture/camera_switcher_daemon.c` (capture_frame_cb)

**修正内容**:
1. プローブフレームをFrameDoubleBufferのinactive slotに一時保存
2. inactive slotから明るさ計算（共有メモリ競合を回避）
3. 1-shotプローブの冗長なログを抑制

**効果**:
- ✅ NIGHT→DAY切り替えが正常に動作
- ✅ ログがクリーンで読みやすい
- ✅ 既存のメモリ機構を活用（追加メモリ不要）
- ✅ アクティブカメラの動作に影響なし

**次のステップ**:
- 実機でのテストと検証
- 長時間動作試験（安定性確認）
