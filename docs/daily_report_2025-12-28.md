# Daily Report - 2025-12-28 (Option B アーキテクチャ実装完了)

## 概要

カメラ切り替えシステムの最適化として、ゼロコピーアーキテクチャ（Option B）を実装。
CPUボトルネックを解消し、シグナルベースの制御で効率的なカメラ切り替えを実現。
自動テストツールも実装し、システムの信頼性を検証可能に。

## 背景

### 発見された問題

1. **CPUボトルネック (96%使用率)**
   - `camera_switcher_daemon`が全フレームをコピー
   - `profile_shm.py`の結果: FPS 8.66-9.31 (目標30fps)
   - Status: "CRITICAL"

2. **非効率な共有メモリ設計**
   - 非アクティブカメラも30fpsで書き込み継続
   - カメラ専用メモリ (`frames_day/night`, `stream_day/night`) が無駄

3. **Busy Loop**
   - `active_thread_main`が同じフレームを読み続ける
   - sleep無しでCPU消費

## Option B アーキテクチャ

### 設計哲学: ゼロコピー

**原則**: "データは一度だけ書く。コピーは悪。"

- アクティブカメラのみが共有メモリに書き込み
- camera_switcherはフレームをコピーせず、シグナルで制御
- プローブはオンデマンド（SIGRTMIN受信時のみ）

### 新しい共有メモリ設計

```
/pet_camera_active_frame    # アクティブカメラのNV12 (30fps)
/pet_camera_stream          # アクティブカメラのH.264 (30fps)
/pet_camera_probe_frame     # プローブ用NV12 (オンデマンド)
```

**削除したメモリ** (旧設計):
```
/pet_camera_frames_day      # 削除
/pet_camera_frames_night    # 削除
/pet_camera_stream_day      # 削除
/pet_camera_stream_night    # 削除
```

### シグナルベース制御

各camera_daemonプロセスがシグナルで制御される:

| シグナル | 用途 | 動作 |
|---------|------|------|
| SIGUSR1 | アクティブ化 | `active_frame`/`stream`への書き込み開始 |
| SIGUSR2 | 非アクティブ化 | 書き込み停止（VIOは継続） |
| SIGRTMIN | プローブ要求 | `probe_frame`に1フレーム書き込み |

### データフロー

```
┌─────────────────────────────────────────────────────────┐
│ camera_switcher_daemon (制御プロセス)                      │
│                                                           │
│  - 両カメラdaemonを起動                                    │
│  - ProbeThread: 2秒ごとに非アクティブカメラへSIGRTMIN    │
│  - ActiveThread: アクティブカメラの明度監視               │
│  - 切り替え判定時: SIGUSR1/SIGUSR2でカメラ切り替え        │
└─────────────────────────────────────────────────────────┘
        │ fork+exec                    │ fork+exec
        ▼                              ▼
┌──────────────────┐          ┌──────────────────┐
│ camera_daemon(0) │          │ camera_daemon(1) │
│ DAYカメラ         │          │ NIGHTカメラ        │
│                  │          │                  │
│ SIGUSR1 受信時:  │          │ SIGUSR1 受信時:   │
│ ├─ active_frame  │          │ ├─ active_frame   │
│ └─ stream        │          │ └─ stream         │
│                  │          │                  │
│ SIGRTMIN 受信時: │          │ SIGRTMIN 受信時:  │
│ └─ probe_frame   │          │ └─ probe_frame    │
└──────────────────┘          └──────────────────┘
```

## 実装詳細

### 1. shared_memory.h の更新

**変更内容**:
```c
// 新しい共有メモリ名定義
#define SHM_NAME_ACTIVE_FRAME "/pet_camera_active_frame"
#define SHM_NAME_STREAM "/pet_camera_stream"
#define SHM_NAME_PROBE_FRAME "/pet_camera_probe_frame"
#define SHM_NAME_DETECTIONS "/pet_camera_detections"
```

**logger.hとの統合**:
- `fprintf(stderr, ...)` → `LOG_DEBUG/INFO/WARN/ERROR` マクロ
- 統一されたログフォーマット: `[LEVEL] [Component] Message`

### 2. camera_daemon_main.c のシグナルハンドラ

**グローバル状態**:
```c
static volatile bool g_running = true;
static volatile sig_atomic_t g_is_active = 0;        // SIGUSR1=1, SIGUSR2=0
static volatile sig_atomic_t g_probe_requested = 0;  // SIGRTMIN=1
```

**シグナルハンドラ**:
```c
static void signal_handler(int signum) {
    if (signum == SIGUSR1) {
        g_is_active = 1;
        LOG_INFO("Main", "SIGUSR1: Camera activated");
    } else if (signum == SIGUSR2) {
        g_is_active = 0;
        LOG_INFO("Main", "SIGUSR2: Camera deactivated");
    } else if (signum == SIGRTMIN) {
        g_probe_requested = 1;
        LOG_INFO("Main", "SIGRTMIN: Probe requested");
    }
}
```

### 3. camera_pipeline.c の条件付き書き込み

**コア実装** (`pipeline_run()` 内):
```c
// 条件判定
bool write_active = *pipeline->is_active_flag == 1;
bool write_probe = *pipeline->probe_requested_flag == 1;

if (write_active || write_probe) {
    // NV12フレーム準備
    Frame nv12_frame = {0};
    // ... フレームデータをコピー ...

    // アクティブ共有メモリへ書き込み
    if (write_active) {
        shm_frame_buffer_write(pipeline->shm_active_nv12, &nv12_frame);
    }

    // プローブ共有メモリへ書き込み（1フレームのみ）
    if (write_probe) {
        shm_frame_buffer_write(pipeline->shm_probe_nv12, &nv12_frame);
        *pipeline->probe_requested_flag = 0;  // フラグクリア
    }
}

// H.264エンコーダへプッシュ（アクティブ時のみ）
if (write_active) {
    encoder_thread_push_frame(&pipeline->encoder_thread, ...);
}
```

### 4. camera_switcher_daemon.c の簡素化

**削除したコード**:
- `publish_frame_cb()` - フレームコピーロジック全削除
- カメラ専用共有メモリ管理
- `frame_interval_ms`ロジック

**新しい実装**:
```c
typedef struct {
  pid_t day_pid;
  pid_t night_pid;
  CameraMode active_camera;
  SharedFrameBuffer *probe_shm_nv12;  // プローブ読み取り用のみ
} DaemonContext;

static int switch_camera_cb(CameraMode camera, void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;

  // 旧カメラを非アクティブ化
  pid_t old_pid = (ctx->active_camera == CAMERA_MODE_DAY) ? ctx->day_pid : ctx->night_pid;
  kill(old_pid, SIGUSR2);

  // 新カメラをアクティブ化
  pid_t new_pid = (camera == CAMERA_MODE_DAY) ? ctx->day_pid : ctx->night_pid;
  kill(new_pid, SIGUSR1);

  ctx->active_camera = camera;
  return 0;
}

static int capture_frame_cb(CameraMode camera, Frame *out_frame, void *user_data) {
  DaemonContext *ctx = (DaemonContext *)user_data;

  // プローブ要求シグナル送信
  pid_t target_pid = (camera == CAMERA_MODE_DAY) ? ctx->day_pid : ctx->night_pid;
  kill(target_pid, SIGRTMIN);

  usleep(10000); // 10ms待機

  // probe_frameから読み取り
  shm_frame_buffer_read_latest(ctx->probe_shm_nv12, out_frame);
  return 0;
}
```

**手動切り替えサポート**:
```c
// SwitcherDaemon自身がSIGUSR1/SIGUSR2を受信してカメラを強制切り替え
static volatile sig_atomic_t g_force_day = 0;
static volatile sig_atomic_t g_force_night = 0;

while (!g_stop) {
  if (g_force_day) {
    switch_camera_cb(CAMERA_MODE_DAY, &ctx);
    camera_switcher_notify_active_camera(&rt.controller, CAMERA_MODE_DAY, "forced");
  }
  if (g_force_night) {
    switch_camera_cb(CAMERA_MODE_NIGHT, &ctx);
    camera_switcher_notify_active_camera(&rt.controller, CAMERA_MODE_NIGHT, "forced");
  }
  sleep(1);
}
```

### 5. camera_switcher_runtime.c の最適化

**Busy Loop 対策**:
```c
static void *active_thread_main(void *arg) {
  uint64_t last_frame_number = 0;

  while (!rt->stop_flag) {
    Frame frame = {0};
    rt->ops.capture_frame(rt->active_camera, &frame, rt->ops.user_data);

    // フレーム重複チェック（Busy Loop回避）
    if (frame.frame_number == last_frame_number) {
      usleep(1000); // 1ms sleep
      continue;
    }
    last_frame_number = frame.frame_number;

    // 明度チェック頻度の適応制御
    int check_interval;
    if (rt->active_camera == CAMERA_MODE_DAY) {
      check_interval = 3;   // 10fps (30fps / 3)
    } else {
      check_interval = 30;  // 1fps (30fps / 30)
    }

    if (frame_count % check_interval == 0) {
      // 明度チェック&切り替え判定
    }
    frame_count++;
  }
}
```

**明度チェック頻度**:
- **DAYカメラアクティブ時**: 3フレームごと (10fps) - 暗転を素早く検知
- **NIGHTカメラアクティブ時**: 30フレームごと (1fps) - 明るくなるのはゆっくり

### 6. Makefile の更新

**クリーンアップターゲット**:
```makefile
cleanup: kill-processes clean
	@echo "[Cleanup] Removing shared memory segments..."
	@-rm -f /dev/shm/pet_camera_active_frame 2>/dev/null
	@-rm -f /dev/shm/pet_camera_stream 2>/dev/null
	@-rm -f /dev/shm/pet_camera_probe_frame 2>/dev/null
	@-rm -f /dev/shm/pet_camera_detections 2>/dev/null
	@echo "[Cleanup] Shared memory cleanup complete"
```

## プロファイラツールの拡張

### 1. カメラ切り替え検出機能

**`profile_shm.py --test-switching`**:

```bash
uv run python scripts/profile_shm.py --test-switching --duration 10
```

**機能**:
- フレームの`camera_id`を監視
- カメラ切り替えを検出
- フレームギャップ（コマ落ち）を測定
- 統計情報をJSON出力

**出力例**:
```json
{
  "camera_switching": {
    "enabled": true,
    "switches_detected": 2,
    "switch_events": [
      {
        "time_offset_sec": 3.245,
        "frame_number": 97,
        "from_camera": 0,
        "to_camera": 1,
        "frame_gap": 0
      },
      {
        "time_offset_sec": 7.891,
        "frame_number": 236,
        "from_camera": 1,
        "to_camera": 0,
        "frame_gap": 1
      }
    ],
    "camera_0_frames": 180,
    "camera_1_frames": 120,
    "camera_distribution": {
      "camera_0_percent": 60.0,
      "camera_1_percent": 40.0
    }
  }
}
```

### 2. 自動カメラ切り替えテスト

**`profile_shm.py --force-switch-test`**:

```bash
uv run python scripts/profile_shm.py --force-switch-test --duration 5
```

**テストフロー**:
1. **Phase 1**: 初期状態をプロファイリング (5秒)
   - 現在のアクティブカメラを検出
2. **Phase 2**: カメラ強制切り替え
   - `camera_switcher_daemon`のPIDを検出 (`pgrep -f camera_switcher_daemon`)
   - SIGUSR1またはSIGUSR2を送信
   - 切り替え後の状態をプロファイリング (5秒)
3. **Phase 3**: 逆方向に切り替え
   - 逆シグナルを送信
   - 元のカメラに戻ったかプロファイリング (5秒)

**実装**:
```python
async def profile_with_forced_switching(shm_name: str, phase_duration: float = 5.0) -> Dict:
    switcher_pid = find_switcher_daemon_pid()

    # Phase 1: 初期状態
    phase1_result = await profile_shm(shm_name, phase_duration, test_switching=True)
    initial_camera = get_primary_camera(phase1_result)
    target_camera = 1 - initial_camera

    # Phase 2: 強制切り替え
    signal_to_send = signal.SIGUSR2 if target_camera == 1 else signal.SIGUSR1
    os.kill(switcher_pid, signal_to_send)
    await asyncio.sleep(1)
    phase2_result = await profile_shm(shm_name, phase_duration, test_switching=True)

    # Phase 3: 逆方向切り替え
    reverse_signal = signal.SIGUSR1 if target_camera == 1 else signal.SIGUSR2
    os.kill(switcher_pid, reverse_signal)
    await asyncio.sleep(1)
    phase3_result = await profile_shm(shm_name, phase_duration, test_switching=True)

    # 結果分析
    camera_phase1 = get_primary_camera(phase1_result)
    camera_phase2 = get_primary_camera(phase2_result)
    camera_phase3 = get_primary_camera(phase3_result)

    switch_successful = (camera_phase2 == target_camera)
    reverse_successful = (camera_phase3 == initial_camera)
    test_status = "PASS" if (switch_successful and reverse_successful) else "FAIL"

    return {
        "test_type": "forced_camera_switching",
        "analysis": {
            "camera_sequence": [camera_phase1, camera_phase2, camera_phase3],
            "switch_successful": switch_successful,
            "reverse_successful": reverse_successful,
            "test_status": test_status
        },
        "phases": {
            "phase1_initial": phase1_result,
            "phase2_switched": phase2_result,
            "phase3_reversed": phase3_result
        }
    }
```

**ヘルパー関数**:
```python
def find_switcher_daemon_pid() -> Optional[int]:
    """camera_switcher_daemonのPIDをpgrepで検索"""
    result = subprocess.run(
        ["pgrep", "-f", "camera_switcher_daemon"],
        capture_output=True,
        text=True,
        timeout=2
    )
    if result.returncode == 0 and result.stdout.strip():
        return int(result.stdout.strip().split('\n')[0])
    return None

def get_primary_camera(result: Dict) -> int:
    """プロファイル結果から主要カメラを判定"""
    cam_switch = result.get("camera_switching", {})
    cam0 = cam_switch.get("camera_0_frames", 0)
    cam1 = cam_switch.get("camera_1_frames", 0)
    return 0 if cam0 > cam1 else 1
```

## ビルド & 実行

### ビルド
```bash
cd src/capture
make cleanup      # 旧共有メモリ削除
make              # 全ターゲットビルド
```

### カメラ切り替えデーモン起動
```bash
./scripts/run_camera_switcher_yolo_streaming.sh
```

### テスト実行
```bash
# 基本プロファイリング
uv run python scripts/profile_shm.py --duration 5

# カメラ切り替え検出テスト
uv run python scripts/profile_shm.py --test-switching --duration 10

# 自動切り替えテスト (3フェーズ)
uv run python scripts/profile_shm.py --force-switch-test --duration 5
```

## パフォーマンス比較

### Before (旧アーキテクチャ)
- **FPS**: 8.66-9.31 (目標30fpsの30%)
- **CPU使用率**: 96% (camera_switcher_daemon)
- **Status**: CRITICAL
- **問題**: 全フレームコピー + Busy Loop

### After (Option B アーキテクチャ) - 期待値
- **FPS**: 30fps (目標達成)
- **CPU使用率**: <10% (予測)
- **Status**: HEALTHY
- **改善**: ゼロコピー + シグナル制御 + フレーム重複回避

## ファイル変更サマリ

### 新規作成
```
なし（既存ファイルの更新のみ）
```

### 更新
```
src/capture/
├── shared_memory.h           # SHM名定義変更、logger統合
├── camera_daemon_main.c      # シグナルハンドラ追加
├── camera_pipeline.h         # 条件付き書き込みフラグ追加
├── camera_pipeline.c         # 条件付き書き込み実装
├── camera_switcher_daemon.c  # publish_frame_cb削除、シグナル制御
├── camera_switcher_runtime.c # フレーム重複回避、適応的明度チェック
└── Makefile                  # クリーンアップターゲット更新

scripts/
└── profile_shm.py            # カメラ切り替えテスト機能追加
```

## トラブルシューティング

### 発生したエラーと対処

1. **`unknown type name 'sig_atomic_t'`**
   - **原因**: `camera_pipeline.h`に`signal.h`未インクルード
   - **対処**: `#include <signal.h>` 追加

2. **`undefined reference to 'log_message'`**
   - **原因**: `logger.c`がMakefileのソースリストに未追加
   - **対処**: SWITCHER_DAEMON_SOURCES等に`logger.c`追加

3. **ProbeThread capture_frame failures**
   - **原因**: 旧`frame_interval_ms`ロジックとの非互換
   - **対処**: Option Bアーキテクチャで根本解決

### 実装中に発見したバグと修正

#### 1. 初期カメラアクティブ化失敗 (camera_switcher_daemon.c:227)
**症状**: カメラdaemonがSIGUSR1を受信してもフレームを書き込まない

**原因**:
```c
DaemonContext ctx = {
    .active_camera = CAMERA_MODE_DAY  // BUG: 初期値がすでにDAY
};
// ...
switch_camera_cb(CAMERA_MODE_DAY, &ctx);  // active_camera == camera で早期リターン
```

**修正**:
```c
DaemonContext ctx = {
    .active_camera = -1  // 初期状態は「未アクティブ」
};
```

**結果**: 初回`switch_camera_cb`呼び出しで正常にSIGUSR1が送信されるように

#### 2. Busy Loop - 大量フレームスキップ (camera_switcher_runtime.c:149)
**症状**: `[INFO] [ActiveThread] Processed 2500 frames, skipped 59966` - CPU 96%使用

**原因**:
```c
if (frame.frame_number == last_frame_number) {
    skipped_count++;
    // BUG: usleep無し、shm_frame_buffer_read_latestは非ブロッキング
    continue;  // 同じフレームを高速で読み続けるBusy Loop
}
```

**修正**:
```c
if (frame.frame_number == last_frame_number) {
    skipped_count++;
    usleep(100);  // 100us = 0.1ms (最大10000チェック/秒)
    continue;
}
```

**結果**: スキップ数 59966 → 10758に削減、CPU使用率大幅改善

#### 3. 間違ったPIDへのシグナル送信 (camera_switcher_daemon.c:167)
**症状**: プローブフレームが取得できない

**原因**:
```c
pid_t target_pid = (camera == CAMERA_MODE_DAY) ? 0 : ctx->day_pid;  // BUG!
// camera=DAYの時、PID 0 (init)にシグナル送信してしまう
```

**修正**:
```c
pid_t target_pid = (camera == CAMERA_MODE_DAY) ? ctx->day_pid : ctx->night_pid;
```

**結果**: 正しいカメラdaemonプロセスにSIGRTMINが送信される

#### 4. SIGRTMIN連続送信 (camera_switcher_daemon.c)
**症状**: `[DEBUG] [SwitcherDaemon] Sent SIGRTMIN to PID 145284 (probe request)` が毎フレーム出力

**原因**: ActiveThreadがProbeThread用の`capture_frame_cb`を呼び出していた
- ActiveThread: アクティブフレーム読み取り（シグナル不要）
- ProbeThread: プローブフレーム読み取り（SIGRTMINが必要）

**修正**: コールバックを2つに分割
```c
// camera_switcher_runtime.h
typedef struct {
    int (*capture_active_frame)(CameraMode, Frame*, void*);  // シグナル無し
    int (*capture_probe_frame)(CameraMode, Frame*, void*);   // SIGRTMIN送信
    // ...
} CameraCaptureOps;

// camera_switcher_daemon.c
static int capture_active_frame_cb(...) {
    // active_frameから直接読み取り（シグナル送信無し）
    return shm_frame_buffer_read_latest(ctx->active_shm_nv12, out_frame);
}

static int capture_probe_frame_cb(...) {
    // SIGRTMINを送信してprobe_frameから読み取り
    kill(target_pid, SIGRTMIN);
    return shm_frame_buffer_read_latest(ctx->probe_shm_nv12, out_frame);
}
```

**結果**: SIGRTMINは2秒ごとにProbeThreadからのみ送信される（ActiveThreadは無関係）

#### 5. 不要なusleep削除 (camera_switcher_daemon.c:172)
**問題**: プローブフレーム取得時の不要な待機
```c
kill(target_pid, SIGRTMIN);
usleep(10000);  // 10ms待機 - 不要！
```

**理由**:
- camera_daemonはシグナル受信即座にフラグセット
- 次の`vio_get_frame()`ブロッキング待機でフレーム取得
- `shm_frame_buffer_read_latest()`は最新フレームを読むので待機不要

**修正**: `usleep(10000)`行を削除

**結果**: プローブレイテンシが10ms短縮

### プロファイラツールの改善

#### 問題: Python FPS計測の信頼性低下
**症状**:
- C言語テストプログラム (`test_fps_reader.c`): 30.80 FPS ✅
- Python プロファイラ (`profile_shm.py`): 8.77 FPS ❌

**原因**: `real_shared_memory.py`のフレーム読み取り性能がボトルネック

#### 解決策: write_index差分ベースの正確なFPS計測

**実装** (scripts/profile_shm.py):
```python
# 計測開始時のwrite_indexを記録
initial_write_index = shm.get_write_index()

# ... サンプリングループ ...

# 計測終了時のwrite_indexを取得
write_index = shm.get_write_index()
write_index_delta = write_index - initial_write_index

# 正確なFPS計算（カメラdaemonの書き込み速度）
actual_write_fps = write_index_delta / duration
```

**stats出力の整理**:
```json
{
  "stats": {
    "total_frames": 26,
    "actual_write_fps": 31.0,     // ✅ 信頼性高い
    "write_index": 39492,
    "write_index_delta": 93
  }
}
```

**削除した信頼性の低い統計**:
- ❌ `fps`: Python読み取り速度（実際の書き込み速度と無関係）
- ❌ `frame_interval_avg_ms`: 計測バイアスあり
- ❌ `frame_interval_std_dev_ms`: 計測バイアスあり
- ❌ `dropped_frames_estimated`: 不正確

#### STALE_DATAチェック修正
**問題**: `time_since_last_update_sec: 1766901221.29` (56年!)

**原因**:
```python
# BUG: frame.timestamp_sec はCLOCK_MONOTONIC（システム起動からの秒数）
time_since_last_update = time.time() - last_frame_obj.timestamp_sec
```

**修正**:
```python
# frame_timestamps[-1] はtime.time()で記録済み（UNIX epoch）
time_since_last_update = time.time() - frame_timestamps[-1]
```

#### C言語検証ツールの追加
**ファイル**: `src/capture/test_fps_reader.c`

**目的**: Python実装と独立してFPS計測を検証

**追加ビルドターゲット** (Makefile):
```makefile
FPS_READER_SOURCES := test_fps_reader.c shared_memory.c logger.c
FPS_READER_BINARY := $(BUILD_DIR)/test_fps_reader
```

**使用例**:
```bash
./build/test_fps_reader /pet_camera_active_frame 5
# 出力: FPS: 30.80
#       Write index delta: 154
```

**検証結果**: C実装で30.80 FPS確認 → camera_daemon正常動作を証明

## 検証項目

### 機能検証
- [ ] 両カメラが30fpsで動作
- [ ] SIGUSR1/SIGUSR2でカメラ切り替え成功
- [ ] SIGRTMINでプローブフレーム取得成功
- [ ] 明度ベースの自動切り替え動作
- [ ] フレーム重複がない（write_indexが単調増加）

### パフォーマンス検証
- [ ] FPS ≥ 29.0 (目標30fps)
- [ ] CPU使用率 < 20% (camera_switcherプロセス)
- [ ] フレームギャップ ≤ 1 (切り替え時)
- [ ] プローブレイテンシ < 50ms

### テスト検証
- [ ] `--test-switching`で切り替え検出成功
- [ ] `--force-switch-test`で3フェーズテスト成功
- [ ] Phase 2で目標カメラに切り替わる
- [ ] Phase 3で元のカメラに戻る

## 次のステップ

### 短期（優先度: 高）
- [ ] 実機でパフォーマンステスト実行
- [ ] `profile_shm.py --force-switch-test`の実行と結果検証
- [ ] CPU使用率が<10%になったか確認
- [ ] FPS 30達成を確認

### 中期（優先度: 中）
- [ ] WebRTCストリーミングとの統合テスト
- [ ] YOLOディテクションとの統合テスト
- [ ] ログレベルの最適化（本番環境用）

### 長期（優先度: 低）
- [ ] カメラ切り替え時のウォームアップフレーム最適化
- [ ] プローブ頻度の動的調整
- [ ] エラーリカバリーメカニズムの強化

## 学び

### アーキテクチャ設計
1. **ゼロコピー原則**: データは一度だけ書く。コピーはボトルネックの源。
2. **シグナルベース制御**: プロセス間通信にシグナルを活用すると軽量で効率的。
3. **条件付き書き込み**: フラグベースの制御でリソース消費を最小化。

### パフォーマンス最適化
1. **プロファイリング駆動**: 推測でなく計測（profile_shm.py）で問題を特定。
2. **Busy Loop回避**: フレーム重複チェック + sleep で無駄なCPU消費を削減。
3. **適応的サンプリング**: DAY 10fps、NIGHT 1fps で必要十分な検知速度を実現。

### テスト駆動開発
1. **自動テストツール**: `--force-switch-test`で人手を介さず検証可能に。
2. **3フェーズテスト**: 初期→切替→逆切替で双方向の動作を保証。
3. **JSON出力**: 機械可読な形式でCI/CD統合が容易。

## まとめ

**達成事項**:
- ✅ Option B ゼロコピーアーキテクチャ実装完了
- ✅ シグナルベース制御システム構築
- ✅ 条件付き書き込みによるリソース最適化
- ✅ Busy Loop対策とフレーム重複回避
- ✅ 適応的明度チェック頻度制御
- ✅ カメラ切り替え検出機能実装
- ✅ 自動3フェーズ切り替えテスト実装

**期待される効果**:
- 🚀 FPS: 8.66 → 30 (3.5倍向上)
- 🚀 CPU使用率: 96% → <10% (10分の1削減)
- 🚀 メモリ使用量: 40%削減（カメラ専用メモリ削除）

**成功の鍵**:
1. **問題の定量化**: profile_shm.pyで客観的なボトルネック特定
2. **アーキテクチャ再設計**: コピーを排除する根本的解決
3. **自動テスト**: 人手なしで品質保証が可能

**次の一歩**:
実機で`uv run python scripts/profile_shm.py --force-switch-test --duration 5`を実行し、
30fps達成とCPU<10%を確認する。
