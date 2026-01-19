# ISP低照度改善 実装計画

## 概要

低照度環境でのAI検出精度向上を目的として、ISPハードウェア機能を活用した輝度計測・自動補正パイプラインを実装する。

### 背景

- 現状: 低照度時（平均輝度 < 40）でYOLO検出精度が低下
- 原因: センサーが物理的限界（最大ゲイン・露光時間）に達しており、ISPパラメータ調整だけでは改善困難
- 解決策: ISPの輝度統計機能を活用し、低照度検出時に自動でCPROC/Gamma補正を適用

### ISPパイプライン構造

```
Sensor → VIN → ISP → VSE ─┬─ Ch0 (1920x1080) → H.264 Encoder
                          ├─ Ch1 (640x640)   → YOLO検出
                          └─ Ch2 (640x480)   → MJPEG

※ ISPで補正すると全チャンネル（H.264, MJPEG, YOLO入力）に反映される
```

### 利用するISP API

| API | 用途 |
|-----|------|
| `hbn_isp_get_ae_statistics()` | 32x32グリッド輝度統計取得 |
| `hbn_isp_get_exposure_attr()` | cur_lux（環境照度）取得 |
| `hbn_isp_set_color_process_attr()` | Brightness/Contrast/Saturation設定 |
| `hbn_isp_set_gc_attr()` | ガンマ補正設定 |
| `hbn_rgn_*()` | オーバーレイ描画（Phase 4） |

---

## フェーズ概要

| Phase | 目的 | 期間目安 |
|-------|------|----------|
| **Phase 0** | 基盤整備（共有メモリレイアウト変更） | Week 1 |
| **Phase 1** | ISP輝度統計取得 | Week 2 |
| **Phase 2** | 低照度自動補正 | Week 3 |
| **Phase 3** | A/Bテスト・検出精度評価 | Week 4 |
| **Phase 4** | オーバーレイISP移行（オプション） | Week 5+ |

---

## Phase 0: 基盤整備

### 目的

輝度メトリクスをゼロコピーでフレームと一緒に伝達できる構造を整備。

### タスク

- [ ] **0.1** FrameHeader構造体に輝度フィールド追加
  - `src/capture/shared_memory.h`
  - 追加フィールド:
    - `float brightness_avg` - Y平面平均輝度 (0-255)
    - `uint32_t brightness_lux` - ISP cur_lux値
    - `uint8_t brightness_zone` - 0=dark, 1=normal, 2=bright
    - `uint8_t correction_applied` - 補正適用フラグ

- [ ] **0.2** Go側の共有メモリ読み取り更新
  - `src/streaming_server/internal/webmonitor/shm.go`
  - CGO構造体同期

- [ ] **0.3** Python側の共有メモリ読み取り更新
  - `src/capture/real_shared_memory.py`
  - ctypes構造体同期

- [ ] **0.4** ゼロコピー維持確認
  - `scripts/profile_shm.py`で性能測定
  - 合格基準: FPS >= 29.5, variance < 5ms

### マイルストーン 0

- [ ] 既存機能に影響なし（フィールド追加のみ、初期値0）
- [ ] profile_shm.py実行結果: FPS >= 29.5, variance < 5ms

### 効率性チェックポイント #1

```
確認項目:
- 構造体サイズ増加量（目標: < 16バイト）
- キャッシュラインアライメント（64バイト境界推奨）
- memcpyオーバーヘッド測定
```

---

## Phase 1: ISP輝度統計取得

### 目的

CPUでY平面をスキャンする代わりに、ISPのHW統計を利用してCPU負荷を削減。

### 設計方針: 毎フレーム書き込み、読み取り側で頻度制御

**採用案（方法4）:**
- camera_daemon は毎フレーム ISP stats を取得して Frame に書き込む
- camera_switcher 等の読み取り側が必要なタイミングで参照
- ISP API 呼び出しは軽量なので毎フレームでも許容できる想定

**代替案（方法1）: frame_number ベースの間引き**
```c
// camera_pipeline.c の capture コールバック内
if (frame->frame_number % stats_interval == 0) {
    isp_get_brightness_stats(&frame->brightness_avg, ...);
}
```
- 方法4で性能問題が発生した場合のフォールバック
- stats_interval は SharedFrameBuffer.frame_interval_ms 同様に動的制御可能

### 現状の輝度計算頻度（参考: camera_switcher）

| 状態 | 頻度 | 理由 |
|------|------|------|
| Day | 3フレームごと（約10Hz） | 暗くなった時の素早い検出 |
| Night | 30フレームごと（約1Hz） | 明るくなった時はゆっくり検出 |
| Probe | 2秒ごと | 非アクティブカメラ |

### タスク

- [ ] **1.1** ISP統計取得関数の実装
  - `src/capture/isp_brightness.c` (新規)
  - `src/capture/isp_brightness.h` (新規)
  - `hbn_isp_get_ae_statistics()` ラッパー
  - 32x32グリッドから平均輝度計算

- [ ] **1.2** カメラパイプラインに統合
  - `src/capture/camera_pipeline.c`
  - フレームキャプチャ時に毎回 ISP stats 取得
  - 輝度値を Frame 構造体に書き込み

- [ ] **1.3** cur_lux（環境照度）の取得
  - `hbn_isp_get_exposure_attr()`からcur_luxを取得
  - 輝度ゾーン判定ロジック:
    - dark: brightness_avg < 50 or cur_lux < 100
    - dim: 50 <= brightness_avg < 70
    - normal: 70 <= brightness_avg < 180
    - bright: brightness_avg >= 180

- [ ] **1.4** camera_switcher統合
  - `frame_calculate_mean_luma()`をISP統計で置換
  - Frame.brightness_avg を直接参照するように変更
  - フォールバック: ISP値が0の場合は従来のCPU計算

### マイルストーン 1

- [ ] ISP統計取得成功（cur_lux, ae_statistics）
- [ ] 輝度値がFrameHeaderに正しく書き込まれる
- [ ] CPU使用率低下（期待: 5-10%削減）

### 検証コマンド

```bash
# 1. ISP統計値の妥当性確認
./test_isp_lowlight --camera 0 --dump-stats

# 2. CPU使用率比較
top -d 1 -p $(pidof camera_daemon_cam0)
# Before: XX%  After: YY%

# 3. 輝度値のフレーム間一貫性
python3 scripts/profile_shm.py --show-brightness
# → brightness_avg, brightness_lux, brightness_zoneが表示される
```

---

## Phase 2: 低照度自動補正

### 目的

低照度検出時にISPパラメータを動的に調整してAI検出精度を向上。

### 補正プロファイル（案）

| Zone | brightness_avg | ISP設定 |
|------|----------------|---------|
| DARK | < 40 | brightness=+50, gamma=0.6, contrast=1.3 |
| DIM | 40-60 | brightness=+25, gamma=0.8, contrast=1.15 |
| NORMAL | 60-180 | デフォルト |
| BRIGHT | > 180 | 変更なし |

### タスク

- [ ] **2.1** 低照度補正プロファイル定義
  - `src/capture/isp_lowlight_profile.h` (新規)
  - zone別のISPパラメータセット
  - パラメータはコンパイル時定数として定義

- [ ] **2.2** ISPパラメータ動的設定関数
  - `src/capture/isp_brightness.c`
  - `apply_brightness_profile(zone)`
  - スムーズな遷移（急激な変化を避ける）

- [ ] **2.3** 補正適用条件（ヒステリシス）
  - 補正ON: brightness_avg < 50 かつ 連続1秒以上
  - 補正OFF: brightness_avg > 70 かつ 連続2秒以上
  - ちらつき防止のためヒステリシス幅を設ける

- [ ] **2.4** 補正状態の共有
  - FrameHeaderの`correction_applied`フラグ更新
  - YOLO側で補正有無を認識可能に

### マイルストーン 2

- [ ] 低照度時にISPパラメータが自動調整される
- [ ] 画像が目視で明るくなる（ヒストグラム平均 > 60）
- [ ] 補正ON/OFF遷移がスムーズ（ちらつきなし）
- [ ] 30fps維持

### 効率性チェックポイント #2

```
確認項目:
- ISPパラメータ設定のレイテンシ（目標: < 5ms）
- 設定変更から画像反映までのフレーム数（目標: 1-2フレーム）
- 頻繁な設定変更によるISP負荷
```

---

## Phase 3: A/Bテスト・検出精度評価

### 目的

低照度補正の効果を客観的に定量評価。

### タスク

- [ ] **3.1** テストデータセット準備
  - `test_pic/`に低照度シーン50枚以上
  - 正解ラベル（手動アノテーション or 高照度での検出結果）
  - 照度レベル別に分類:
    - dark (brightness < 40): 20枚
    - dim (40-60): 15枚
    - normal (60-100): 15枚

- [ ] **3.2** A/Bテスト用スクリプト
  - `scripts/ab_test_detection.py` (新規)
  - 同一フレームに対して:
    - A: 補正なしで検出
    - B: 補正ありで検出
  - 結果を記録（検出数、信頼度、bbox位置）

- [ ] **3.3** 評価メトリクス実装
  - Precision / Recall / F1 Score
  - 平均信頼度 (Mean Confidence)
  - False Positive Rate
  - 照度レベル別の精度比較

- [ ] **3.4** 統計的有意性検定
  - 対応のあるt検定（補正あり vs なし）
  - p < 0.05 で有意差ありと判定

### マイルストーン 3

- [ ] A/Bテスト実施（100フレーム以上）
- [ ] 定量評価レポート出力
- [ ] 補正効果の統計的有意性確認（p < 0.05）

### 評価レポートテンプレート

```
=== ISP Low-Light Enhancement A/B Test Report ===
Date: YYYY-MM-DD
Test frames: 100
Lighting conditions: dark (avg brightness < 40)

| Metric          | Without Boost | With Boost | Diff    | p-value |
|-----------------|---------------|------------|---------|---------|
| Detections/frame| 0.45          | 0.72       | +60%    | 0.001   |
| Mean Confidence | 0.61          | 0.74       | +0.13   | 0.003   |
| Precision       | 0.85          | 0.88       | +0.03   | 0.12    |
| Recall          | 0.52          | 0.83       | +0.31   | 0.0001  |
| F1 Score        | 0.65          | 0.85       | +0.20   | 0.002   |

Conclusion: Low-light enhancement significantly improves detection
            recall (+31%) with statistical significance (p < 0.05).
```

---

## Phase 4: オーバーレイISP移行（オプション）

### 目的

オーバーレイ描画をGo/CGOからISP RGN APIに移行し、CPU負荷削減とコード簡略化。

### 現状のオーバーレイ実装

| ファイル | 役割 | 行数 |
|---------|------|------|
| `src/streaming_server/internal/webmonitor/shm.go` | CGO描画関数 | ~150行 |
| `src/streaming_server/internal/webmonitor/broadcaster.go` | generateOverlay() | ~60行 |
| `src/streaming_server/internal/webmonitor/drawer.go` | RGBA描画（未使用） | ~280行 |

### タスク

- [ ] **4.1** RGN API調査・PoC
  - `hbn_rgn_create`, `hbn_rgn_draw_word`, `hbn_rgn_draw_line` テスト
  - フォントサイズ・色の確認
  - パフォーマンス測定

- [ ] **4.2** オーバーレイ管理スレッド実装
  - `src/capture/overlay_manager.c` (新規)
  - 検出結果を受け取ってRGN更新
  - バウンディングボックス最大10個

- [ ] **4.3** Go側オーバーレイコード削除
  - shm.go: CGO描画関数削除
  - broadcaster.go: generateOverlay()簡略化
  - drawer.go: 全体削除

- [ ] **4.4** フォールバック機構
  - RGN失敗時は従来のソフトウェア描画にフォールバック
  - 設定で切り替え可能

### マイルストーン 4

- [ ] ISP RGNによるオーバーレイ表示成功
- [ ] Go側コード削減（約400行）
- [ ] MJPEG/WebRTC両方で正常表示

---

## リスクと軽減策

| リスク | 影響 | 軽減策 |
|--------|------|--------|
| ISP統計APIが期待通り動作しない | Phase 1 遅延 | CPU計算をフォールバックとして維持 |
| ISP補正が検出精度に悪影響 | Phase 3 失敗 | プロファイルのパラメータチューニング |
| RGN APIの制限（フォント等） | Phase 4 断念 | ソフトウェア描画を維持 |
| 共有メモリ変更で既存機能破損 | 全体影響 | 後方互換性維持（新フィールドは末尾追加） |

---

## 参考資料

- ISP API: `/usr/include/hbn_isp_api.h`
- RGN API: `/usr/include/hb_rgn.h`
- 既存テストツール: `src/capture/test_isp_lowlight.c`
- 現状の輝度計算: `src/capture/camera_switcher.c:frame_calculate_mean_luma()`

---

## 更新履歴

| 日付 | 内容 |
|------|------|
| 2026-01-20 | 初版作成 |
