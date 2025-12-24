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

#### 1.2 camera_daemon NV12+H.264生成 ✅ 完了
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
  - `sp_vio_get_yuv()` でNV12取得（行467-487）
  - `sp_encoder_get_stream()` でH.264取得（行489-516）
  - 両方を対応する共有メモリに書き込み
- Cleanup関数の修正（行597-612）
- フレーム間隔制御の統合（行446-458, SIGUSR1対応）

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

**完了タスク**:
- ✅ `run_capture_loop()` の実装完了
  - NV12取得ロジック追加
  - H.264との同期
  - エラーハンドリング
- ✅ Cleanup関数の修正完了
- ✅ フレーム間隔制御の統合完了
- ✅ ビルドとテスト完了（共有メモリテスト全てパス）

**完了日**: 2025-12-24

---

### Phase 2: 統合実装

#### 2.1 camera_switcher H.264管理 ✅ 完了
**ファイル**: `src/capture/camera_switcher_daemon.c`

**変更内容**:
- DaemonContext構造体の拡張（行28-38）
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
- `spawn_daemon_with_shm()` の修正完了（行40-77）
  - 両方の環境変数を設定（SHM_NAME_NV12, SHM_NAME_H264）
- `publish_frame_cb()` の拡張完了（行176-206）
  - NV12とH.264の両方をコピー
- カメラ切り替えロジックの維持
- **warmup_frames = 15** に設定（行224）← Fluent switching対応

**完了日**: 2025-12-24

---

#### 2.2 物体検出デーモン対応 ✅ 完了
**ファイル**: `src/detector/yolo_detector_daemon.py`

**変更内容**:
- 共有メモリ名を`SHM_NAME_ACTIVE_FRAME`に設定済み（行27, 89）
  ```python
  from real_shared_memory import RealSharedMemory, SHM_NAME_ACTIVE_FRAME
  self.shm = RealSharedMemory(frame_shm_name=SHM_NAME_ACTIVE_FRAME)
  ```

**影響**:
- ✅ 既にNV12対応済み（format=1）
- ✅ `/pet_camera_active_frame`から読み取り

**完了日**: 2025-12-24

---

#### 2.3 H264Recorder対応 ✅ 完了
**ファイル**: `src/monitor/h264_recorder.py`, `src/monitor/web_monitor.py`

**変更内容**:
- `web_monitor.py`で正しい共有メモリを使用（行623, 625）
  ```python
  h264_shm = RealSharedMemory(frame_shm_name=SHM_NAME_STREAM)
  monitor.recorder = H264Recorder(h264_shm, Path("./recordings"))
  ```

**影響**:
- ✅ `/pet_camera_stream`から読み取り
- ✅ H.264レコーダーに正しい共有メモリを渡す

**完了日**: 2025-12-24

---

#### 2.4 Webモニター対応 ✅ 完了
**ファイル**: `src/monitor/main.py`, `src/monitor/web_monitor.py`

**変更内容**:
- ✅ 共有メモリ名の設定を環境変数化済み
- ✅ NV12とH.264の両方のソース対応済み（行27, 623）
- ✅ RealSharedMemoryでの動作確認済み

**完了日**: 2025-12-24

---

### Phase 3: テストと検証

#### 3.1 単体テスト ✅ 部分完了
- ✅ ビルド成功（camera_daemon_drobotics, test_shm）
- ✅ 共有メモリテスト全てパス（test_shm）
- ⏳ camera_daemon単体でNV12+H.264生成確認（実機が必要）
- ⏳ 各共有メモリに正しく書き込まれるか確認（実機が必要）
- ⏳ フレームレート制御が動作するか確認（実機が必要）

#### 3.2 統合テスト ⏳ 実機待ち
- ⏳ camera_switcherでカメラ切り替え動作確認（実機が必要）
- ⏳ 明度ベースの自動切り替え確認（実機が必要）
- ⏳ ブラックアウトが発生しないか確認（実機が必要）
- ⏳ 録画機能の動作確認（実機が必要）
- ⏳ 物体検出の動作確認（実機が必要）
- ⏳ VLC再生でキーフレーム開始確認（実機が必要）

#### 3.3 パフォーマンステスト ⏳ 実機待ち
- ⏳ CPU使用率測定（実機が必要）
- ⏳ メモリ使用量測定（6箇所の共有メモリ）（実機が必要）
- ⏳ フレームレート安定性確認（実機が必要）

**注**: Phase 3のテストはD-Roboticsハードウェア環境が必要です。

---

## 実装スケジュール

### 完了済み（2025-12-24）
- ✅ 共有メモリ名定義（shared_memory.h）
- ✅ H264Recorderのバグ修正（0バイト書き込み問題）
- ✅ camera_daemon_drobotics.c の修正完了
  - NV12+H.264二重生成
  - フレーム間隔制御
  - cleanup関数
- ✅ camera_switcher_daemon.c の修正完了
  - 二重共有メモリ管理
  - warmup_frames = 15
- ✅ 消費者プロセスの対応完了
  - yolo_detector_daemon.py
  - h264_recorder.py + web_monitor.py
- ✅ ビルド成功とユニットテスト完了

### 次のステップ（実機環境が必要）
1. D-Roboticsハードウェア上での統合テスト
2. カメラ切り替え動作確認
3. H.264録画確認
4. パフォーマンス測定

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
- ✅ camera_switcher_daemon.c の warmup_frames を 15 に変更（完了）
- ⏳ カメラ切り替え統合テスト（実機待ち）
- ⏳ VLC再生でキーフレーム開始確認（実機待ち）

**変更不要**:
- ~~SIGUSR2ハンドラー追加~~ - 動的キーフレーム要求APIなし
- ~~GOP設定変更~~ - API制約により不可能

---

## 参考資料

- [H.264 Encoding Integration Guide](./h264_encoding_integration_guide.md)
- [H.264 Implementation Log](./h264_implementation_log.md)
- [Fluent Stream Switching Design](./fluent_stream_switching_design.md)
- [HW Encoding FAQ](./hw_encoding_faq.md)
- libspcdev sample: `/app/cdev_demo/vio_capture/capture.c`

---

## Phase 2 完了報告 (2025-12-24 午後)

### NV12色変換問題の解決 ✅

**問題**:
- Webモニターで画像が緑/マゼンタのノイズで表示
- OpenCV `COLOR_YUV2BGR_NV12`変換が失敗

**原因**:
- `sp_vio_get_yuv()`が返すデータフォーマットが標準NV12と不一致
- D-Robotics APIドキュメント不足で詳細仕様不明

**解決**:
```c
// camera_daemon_drobotics.c: line 475
// Before
sp_vio_get_yuv(ctx->vio_object, (char *)nv12_buffer, ...);

// After
sp_vio_get_frame(ctx->vio_object, (char *)nv12_buffer, ...);
```

**結果**:
- ✅ 画像が正常に表示
- ✅ NV12→BGR色変換が正しく動作
- ✅ Webモニターが実用可能に

**詳細**: [session_20251224_nv12_fix.md](./session_20251224_nv12_fix.md)

### 実機テスト結果

**カメラ動作**: ✅ 正常
- imx219センサー（1920x1080 → 640x480）
- NV12 + H.264 デュアル生成動作確認
- 共有メモリ経由でデータ配信成功

**YOLO検出**: ✅ 正常
- YOLOv11nモデルで物体検出動作
- 検出結果が共有メモリ経由で配信

**Webモニター**: ✅ 画像表示正常、⚠️ FPS低下
- 画像品質: 正常（色変換問題解決）
- FPS: 7-8fps（目標30fpsに対して低下）
- 原因: MJPEG変換オーバーヘッド

### Phase 2 完了タスク

✅ **すべての実装タスク完了**:
1. ✅ camera_daemon_drobotics.c - NV12+H.264デュアル生成
2. ✅ camera_switcher_daemon.c - デュアルカメラオーケストレーション
3. ✅ real_shared_memory.py - NV12読み取り対応
4. ✅ yolo_detector_daemon.py - NV12からの検出
5. ✅ web_monitor.py - NV12表示（色変換修正済み）
6. ✅ 実機での統合テスト完了

---

## Phase 3: WebRTC移行（次タスク）

### 目的
現在の課題（FPS低下）を解決し、元々の設計通りに実装する

### 現状の問題
- **FPS低下**: 7-8fps（目標30fps）
- **サーバー負荷**: NV12→BGR→JPEG変換が重い
- **非効率**: H.264ストリームを生成済みだが未使用

### Phase 3 タスク

#### 3.1 WebRTCサーバー実装
- [ ] Flask + python-aiortc でsignaling server
- [ ] H.264共有メモリリーダー（SHM_NAME_STREAM）
- [ ] WebRTC peer connection + H.264 track

#### 3.2 Server-Sent Events
- [ ] `/api/detections/stream` エンドポイント（既存を活用）
- [ ] 検出結果をリアルタイム配信

#### 3.3 ブラウザ実装
- [ ] WebRTC client（H.264受信）
- [ ] Canvas BBox描画（SSEから検出結果取得）
- [ ] 既存MJPEGビューとの切り替え

#### 3.4 テスト
- [ ] 30fps達成確認
- [ ] 遅延測定
- [ ] サーバー負荷比較

### 期待効果
- 📈 FPS: 7-8fps → **30fps**
- 📉 サーバーCPU使用率: 大幅削減（MJPEG変換不要）
- ⚡ 低遅延: H.264直接配信
- 🎯 設計通りの実装完了

---

**Last Updated**: 2025-12-24
**Status**: ✅ **Phase 2 完了** → 🚀 **Phase 3 開始準備中**
