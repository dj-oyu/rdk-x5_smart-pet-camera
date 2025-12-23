# Camera Switcher H.264 Migration Plan

**Date**: 2025-12-23
**Branch**: h264stream
**Status**: In Progress

---

## 概要

カメラスイッチャーシステムをH.264対応に移行する。明度チェックにはNV12、録画・配信にはH.264を使用する二重生成システムを実装。

### 背景

**問題点**:
- camera_switcherは明度計算のためにJPEGフレームを前提としている
- H.264フレームでは明度計算ができない（`frame_calculate_mean_luma()`が未対応）
- camera_daemonがH.264のみを生成すると、カメラ切り替えが動作しない

**要件**:
- カメラプロセスを停止させずにアクティブ/待機を切り替え（ブラックアウト回避）
- アクティブカメラは30fps、非アクティブカメラは2fpsで動作
- NV12フレームで明度計算
- H.264ストリームで録画・WebRTC配信

---

## マクロレベルタスク

### Task 1: 二重フォーマット生成システム設計

**目標**: カメラデーモンがNV12とH.264の両方を生成する

**アーキテクチャ**:
```
各カメラデーモン (day/night):
├─ sp_vio_get_yuv()          → NV12 (明度計算・物体検出用)
│  └─ /pet_camera_frames_{day,night}
└─ sp_encoder_get_stream()   → H.264 (録画・WebRTC用)
   └─ /pet_camera_stream_{day,night}

camera_switcher:
├─ アクティブカメラのNV12を読む
│  └─ /pet_camera_active_frame に書き込み
└─ アクティブカメラのH.264を読む
   └─ /pet_camera_stream に書き込み

消費者:
├─ 物体検出: /pet_camera_active_frame (NV12)
├─ レコーダー: /pet_camera_stream (H.264)
└─ Webモニター: 両方または選択
```

**共有メモリ構成 (6箇所)**:
```
カメラ専用:
  /pet_camera_frames_day       - DAY camera NV12
  /pet_camera_frames_night     - NIGHT camera NV12
  /pet_camera_stream_day       - DAY camera H.264
  /pet_camera_stream_night     - NIGHT camera H.264

メイン（消費者用）:
  /pet_camera_active_frame     - Active camera NV12
  /pet_camera_stream           - Active camera H.264
```

**影響範囲**:
- camera_daemon_drobotics.c
- camera_switcher_daemon.c
- yolo_detector_daemon.py
- h264_recorder.py
- web_monitor.py

**期待される効果**:
- ブラックアウトなしのカメラ切り替え
- 明度ベースの自動切り替え継続
- H.264録画機能維持
- CPU効率向上（NV12からの明度計算、HWエンコーディング）

---

### Task 2: カメラスイッチャー統合

**目標**: camera_switcherがNV12とH.264の両方を管理

**主要変更**:
- H.264ストリーム用の共有メモリ管理追加
- アクティブカメラ切り替え時に両方のフォーマットをコピー
- フレームレート動的制御の維持

---

### Task 3: 消費者プロセス対応

**目標**: 検出器・レコーダーが新しい共有メモリ構成に対応

**変更対象**:
- 物体検出デーモン → `/pet_camera_active_frame` から読む
- H264Recorder → `/pet_camera_stream` から読む
- Webモニター → 両方のソースに対応

---

## ミクロレベルタスク

### Phase 1: 基盤実装

#### 1.1 共有メモリ構造定義 ✅ 完了
**ファイル**: `src/capture/shared_memory.h`

**変更内容**:
```c
// 共有メモリ名定義追加
#define SHM_NAME_ACTIVE_FRAME "/pet_camera_active_frame"
#define SHM_NAME_STREAM "/pet_camera_stream"
#define SHM_NAME_FRAMES_DAY "/pet_camera_frames_day"
#define SHM_NAME_FRAMES_NIGHT "/pet_camera_frames_night"
#define SHM_NAME_STREAM_DAY "/pet_camera_stream_day"
#define SHM_NAME_STREAM_NIGHT "/pet_camera_stream_night"
```

**コミット**: 739d11c "H.264化に向けた準備"に含まれる

---

#### 1.2 camera_daemon NV12+H.264生成 🔄 進行中
**ファイル**: `src/capture/camera_daemon_drobotics.c`

**変更内容**:
- グローバル変数を2つの共有メモリ用に分離
  ```c
  static SharedFrameBuffer *g_shm_nv12 = NULL;
  static SharedFrameBuffer *g_shm_h264 = NULL;
  ```
- `create_shared_memory()` を両方の共有メモリに対応
  - 環境変数: `SHM_NAME_NV12`, `SHM_NAME_H264`
- `run_capture_loop()` の完全書き換え
  - `sp_vio_get_yuv()` でNV12取得
  - `sp_encoder_get_stream()` でH.264取得
  - 両方を対応する共有メモリに書き込み

**環境変数設定**:
```bash
# DAY camera
SHM_NAME_NV12=/pet_camera_frames_day \
SHM_NAME_H264=/pet_camera_stream_day \
./camera_daemon_drobotics -C 0 -P 1

# NIGHT camera
SHM_NAME_NV12=/pet_camera_frames_night \
SHM_NAME_H264=/pet_camera_stream_night \
./camera_daemon_drobotics -C 1 -P 1
```

**残タスク**:
- [ ] `run_capture_loop()` の実装
  - NV12取得ロジック追加
  - H.264との同期
  - エラーハンドリング
- [ ] Cleanup関数の修正
- [ ] フレーム間隔制御の統合
- [ ] ビルドとテスト

**推定工数**: 2-3時間

---

### Phase 2: 統合実装

#### 2.1 camera_switcher H.264管理 ⏳ 未着手
**ファイル**: `src/capture/camera_switcher_daemon.c`

**変更内容**:
- DaemonContext構造体の拡張
  ```c
  typedef struct {
    SharedFrameBuffer *day_shm_nv12;
    SharedFrameBuffer *night_shm_nv12;
    SharedFrameBuffer *day_shm_h264;    // NEW
    SharedFrameBuffer *night_shm_h264;  // NEW
    SharedFrameBuffer *main_shm_nv12;   // active_frame
    SharedFrameBuffer *main_shm_h264;   // stream
  } DaemonContext;
  ```
- `spawn_daemon_with_shm()` の修正
  - 両方の環境変数を設定
- `publish_frame_cb()` の拡張
  - NV12とH.264の両方をコピー
- カメラ切り替えロジックの維持

**推定工数**: 1-2時間

---

#### 2.2 物体検出デーモン対応 ⏳ 未着手
**ファイル**: `src/detector/yolo_detector_daemon.py`

**変更内容**:
```python
# 共有メモリ名を変更
shm = RealSharedMemory()
shm_path = "/dev/shm/pet_camera_active_frame"  # 変更
```

**影響**:
- 既にNV12対応済み（format=1）
- 共有メモリ名を変更するだけ

**推定工数**: 15分

---

#### 2.3 H264Recorder対応 ⏳ 未着手
**ファイル**: `src/monitor/h264_recorder.py`

**変更内容**:
```python
# 共有メモリ名を変更
# または環境変数で指定
SHM_PATH = os.getenv("H264_SHM_PATH", "/dev/shm/pet_camera_stream")
```

**推定工数**: 15分

---

#### 2.4 Webモニター対応 ⏳ 未着手
**ファイル**: `src/monitor/main.py`, `src/monitor/web_monitor.py`

**変更内容**:
- 共有メモリ名の設定を環境変数化
- NV12とH.264の両方のソース対応
- UI更新（オプショナル）

**推定工数**: 30分

---

### Phase 3: テストと検証

#### 3.1 単体テスト
- [ ] camera_daemon単体でNV12+H.264生成確認
- [ ] 各共有メモリに正しく書き込まれるか確認
- [ ] フレームレート制御が動作するか確認

#### 3.2 統合テスト
- [ ] camera_switcherでカメラ切り替え動作確認
- [ ] 明度ベースの自動切り替え確認
- [ ] ブラックアウトが発生しないか確認
- [ ] 録画機能の動作確認
- [ ] 物体検出の動作確認

#### 3.3 パフォーマンステスト
- [ ] CPU使用率測定
- [ ] メモリ使用量測定（6箇所の共有メモリ）
- [ ] フレームレート安定性確認

**推定工数**: 2-3時間

---

## 実装スケジュール

### 完了済み
- ✅ 共有メモリ名定義（shared_memory.h）
- ✅ H264Recorderのバグ修正（0バイト書き込み問題）

### 現在進行中（2025-12-23）
- 🔄 camera_daemon_drobotics.c の修正

### 次のステップ
1. camera_daemon_drobotics.c の完成とテスト（優先度：高）
2. camera_switcher_daemon.c の修正
3. 消費者プロセスの対応
4. 統合テスト

---

## リスクと対策

### リスク1: メモリ使用量増加
**リスク**: 共有メモリが3箇所→6箇所に増加
**影響**: 合計 ~540MB（90MB × 6）
**対策**: システムメモリ8GBあるため問題なし

### リスク2: CPU負荷増加
**リスク**: NV12取得とH.264エンコードの両方を実行
**影響**: 非アクティブカメラでも若干のCPU増加
**対策**: 非アクティブカメラは2fpsなので影響軽微

### リスク3: 実装複雑化
**リスク**: 共有メモリ管理が複雑になる
**影響**: バグ混入の可能性
**対策**: 段階的実装とテスト、ドキュメント整備

---

## Fluent Stream Switching調査結果 ✅

**調査日**: 2025-12-23
**調査目的**: カメラ切り替え時のH.264ストリーム連続性確保方式の決定

### 調査結果サマリー

**libspcdev API制約**:
- ❌ GOP設定API なし
- ❌ 動的キーフレーム要求API なし
- ✅ デフォルトGOP: 14フレーム（約470ms @ 30fps）

**採用方式**: **案D（ウォームアップ延長型）**

**実装内容**:
```c
// camera_switcher_daemon.c
cfg.warmup_frames = 15;  // 3 → 15 に変更（約500ms）
```

**根拠**:
1. デフォルトGOPが既に短い（470ms）
2. warmup 500msで、ほぼ確実にキーフレームから開始可能
3. 実装が最もシンプル（1行変更）
4. API制約を回避

**詳細設計**: [fluent_stream_switching_design.md](./fluent_stream_switching_design.md)

### 実装への影響

**Phase 2（統合実装）への追加タスク**:
- [ ] camera_switcher_daemon.c の warmup_frames を 15 に変更
- [ ] カメラ切り替え統合テスト
- [ ] VLC再生でキーフレーム開始確認

**変更不要**:
- ~~SIGUSR2ハンドラー追加~~ - 動的キーフレーム要求APIなし
- ~~GOP設定変更~~ - API制約により不可能

---

## 参考資料

- [H.264 Encoding Integration Guide](./h264_encoding_integration_guide.md)
- [H.264 Implementation Log](./h264_implementation_log.md)
- [Fluent Stream Switching Design](./fluent_stream_switching_design.md) - NEW
- [HW Encoding FAQ](./hw_encoding_faq.md)
- libspcdev sample: `/app/cdev_demo/vio_capture/capture.c`

---

**Last Updated**: 2025-12-23
**Next Review**: camera_daemon_drobotics.c 完成時
**Status**: ✅ Fluent switching調査完了 - 案D採用確定
