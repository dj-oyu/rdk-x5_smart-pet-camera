# YOLO 検出率改善計画

## 現状分析

### パイプライン
```
センサー 1920x1080 RAW10
  → ISP NV12
  → VSE Ch1: 640x360 NV12 (ハードウェア縮小, 16:9)
  → Python _letterbox_nv12(): 上下140px黒帯 → 640x640
  → BPU YOLO11n 推論 (~9ms warm)  ← Phase 0 結果により yolov13n から切替
```

### レターボックスの状態
- **有効** (`yolo_detector.py:453-468`)
- 640x360 → 640x640 (Y=16黒, UV=128中間)
- commit `dc21683` で導入済み
- `shift=(140.0, 0.0)` で bbox 座標補正

### 問題
- 1920x1080 → 640x360 への縮小で小さい対象の情報が失われる (3倍縮小)
- 640x640 のうち有効画素は 640x360 (56%) のみ、残り44%は黒帯
- BPU の計算リソースの44%が無駄

---

## BPU ハードウェア・API 仕様

### ハードウェア構成

| 項目 | 値 |
|------|-----|
| SoC | D-Robotics Sunrise 5 (RDK X5) |
| BPU アーキテクチャ | Bayes-e |
| BPU コア数 | **1コア** (`/dev/bpu_core0` のみ) |
| 演算性能 | 10 TOPS (INT8) |
| CPU | 8x Arm Cortex-A55 @ 1.5-1.8 GHz |
| RAM | 4 GB LPDDR4 |

### 採用モデル: YOLO11n (Phase 0 結果により決定)

| 項目 | 値 |
|------|-----|
| ファイル | `/tmp/yolo_models/yolo11n_detect_bayese_640x640_nv12.bin` |
| 入力 | `images`: (1, 3, 640, 640) uint8 NV12, 614400 bytes |
| 出力 | 6ヘッド (split-head YOLO), 全て float32 NHWC |
| BPU推論 (ベンチマーク) | ~8.9 ms avg (warm), 112 FPS |
| **実運用時** | **16-20 ms** avg (zero-copy + letterbox + 後処理込み) |

### モデル比較 (Phase 0 計測値)

| モデル | BPU レイテンシ | FPS | 備考 |
|--------|--------------|-----|------|
| yolov13n (旧) | 45.5 ms | 22 | アーキテクチャが重く BPU 効率悪 |
| **yolo11n** (採用) | **8.9 ms** | **112** | **5.1倍高速化、起動スクリプトのデフォルト** |
| yolov8n | 7.7 ms | 129 | 最速だが 11n と大差なし |

切替理由の詳細は `docs/yolo_bpu_profiling_report.md` を参照

---

## フェーズ計画

### Phase 0: BPU プロファイリング + ベースライン計測 (最重要)

**目的**: 現行 46ms の原因特定と、公式モデルでの速度検証

- 0-1. `hrt_model_exec perf` で BPU 純粋推論時間計測
- 0-2. `hrt_model_exec model_info` でモデルメタデータ詳細調査
- 0-3. 公式 Model Zoo モデルとの比較ベンチマーク
- 0-4. BPU コア数確認
- 0-5. `bpu_infer_lib` API の評価
- 0-6. 検出率ベースライン計測

**成果物**: `docs/yolo_bpu_profiling_report.md`

### Phase 1: 推論速度改善 → **シナリオ B で完了**

- ~~シナリオ A: Python API オーバーヘッド~~ → 実測 <1ms で問題なし
- **シナリオ B**: モデル自体が ~46ms → **yolo11n に切替で 8.9ms を達成**
- ~~シナリオ C~~ → API 最適化不要

### Phase 2: オーバーヘッド最適化 + ROI 検出試行

- scipy.softmax → numpy 実装 ✅
- レターボックスバッファ事前確保 (alloc 0回/フレーム) ✅
- SHM バージョンチェック削除 (常時全力推論) ✅
- VSE Ch1 を 1280x720 に変更 → ROI 境界問題で 640x360 に戻し ⚠️
- ROI クロップ検出・パターン巡回・時間統合 NMS → 実装済み・無効化 ⚠️

詳細: `docs/design_highres_roi_detection.md`

### Phase 3: ROI クロップ巡回 — 保留

- ROI 境界問題 (オブジェクト分断・点滅) が未解決
- 再開条件: 水平オーバーラップ追加 or C API `hbDNNRoiInfer()` 活用

### Phase 4: 適応型 ROI + 結果統合 — 保留

- Phase 3 の解決後に検討

---

## ステータス

| Phase | ステータス | 開始日 | 完了日 | 備考 |
|-------|----------|--------|--------|------|
| Phase 0 | **完了** | 2026-01-28 | 2026-01-28 | プロファイリング完了。レポート: `yolo_bpu_profiling_report.md` |
| Phase 1 | **完了** | 2026-01-28 | 2026-01-28 | yolov13n → yolo11n 切替 (45.5ms → 8.9ms) |
| Phase 2 | **完了** | 2026-01-28 | 2026-01-28 | 最適化完了。ROI は試行後に無効化 |
| Phase 3 | 保留 | - | - | ROI 境界問題の解決が前提 |
| Phase 4 | 保留 | - | - | Phase 3 の解決後 |
