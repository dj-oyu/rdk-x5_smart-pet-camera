# YOLO 検出率改善計画

## 現状分析

### パイプライン
```
センサー 1920x1080 RAW10
  → ISP NV12
  → VSE Ch1: 640x360 NV12 (ハードウェア縮小, 16:9)
  → Python _letterbox_nv12(): 上下140px黒帯 → 640x640
  → BPU YOLOv13n 推論 (~46ms warm)
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

### 現行モデル情報

| 項目 | 値 |
|------|-----|
| ファイル | `/tmp/yolo_models/yolov13n_detect_bayese_640x640_nv12.bin` |
| 入力 | `images`: (1, 3, 640, 640) uint8 NV12, 614400 bytes |
| 出力 | 6ヘッド (split-head YOLO), 全て float32 NHWC |
| 推論性能 | ~46.3 ms avg (warm) → ~21.7 FPS |

### Model Zoo 公式値 (参考)

| モデル | スループット (FPS) | レイテンシ目安 |
|--------|-------------------|---------------|
| YOLOv5n v7.0 | 277 (3threads) | ~3.6ms |
| YOLOv8n | ~220 (2threads) | ~4.5ms |
| YOLO11n | ~200 | ~5ms |

**現行モデルとの乖離**: 公式 YOLO11n ~5ms vs 当プロジェクト ~46ms (9倍遅い)

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

### Phase 1: 推論速度改善 (Phase 0 結果に基づき選択)

- **シナリオ A**: BPU時間 ~5ms → Python API オーバーヘッドが原因 → `bpu_infer_lib` / C拡張
- **シナリオ B**: モデル自体が ~46ms → 公式モデルに切り替え
- **シナリオ C**: 両方 → モデル切り替え + API 最適化

### Phase 2: VSE 高解像度化 + 検出品質改善

- VSE Ch1 を 960x540 or 1280x720 に変更
- Python 側でリサイズして 640x640 を生成

### Phase 3: ROI クロップ巡回

- 高解像度入力から 640x640 ROI を複数定義して巡回推論

### Phase 4: 適応型 ROI + 結果統合

- 前フレーム検出位置ベースの動的 ROI 決定

---

## ステータス

| Phase | ステータス | 開始日 | 完了日 |
|-------|----------|--------|--------|
| Phase 0 | **進行中** | 2026-01-28 | - |
| Phase 1 | 未着手 | - | - |
| Phase 2 | 未着手 | - | - |
| Phase 3 | 未着手 | - | - |
| Phase 4 | 未着手 | - | - |
