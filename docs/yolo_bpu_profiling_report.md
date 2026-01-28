# Phase 0: BPU プロファイリングレポート

**日付**: 2026-01-28
**ブランチ**: `feature/optimize-detection-stream`

---

## エグゼクティブサマリー

**現行 yolov13n モデルの 46ms レイテンシは、Python API オーバーヘッドではなくモデル自体の計算量が原因。**
同一出力フォーマットの yolo11n (8.9ms) または yolov8n (7.7ms) に切り替えるだけで **5-6倍の高速化** が可能。後処理コードの変更は不要。

---

## 0-1. BPU 純粋推論時間 (`hrt_model_exec perf`)

C ツール `hrt_model_exec` による計測で Python API オーバーヘッドを完全に排除。

### 現行モデル (yolov13n)

| スレッド数 | 平均レイテンシ | FPS | 最小 | 最大 |
|-----------|-------------|-----|------|------|
| 1 | **45.7 ms** | 21.9 | 45.3 ms | 54.4 ms |
| 2 | 83.8 ms (per-thread) | 23.8 | 48.4 ms | 89.9 ms |

**結論**: BPU 推論自体が 45.7ms。Python API は <1ms のオーバーヘッドのみ。2スレッドでも FPS 向上は僅か (+9%)、シングルコアのため並列化効果は限定的。

### モデル比較ベンチマーク

| モデル | BPU レイテンシ (1T) | FPS (1T) | 対 yolov13n 比 | ソース |
|--------|-------------------|----------|--------------|--------|
| **yolov13n** (現行) | **45.5 ms** | **22 FPS** | 1.0x | `models/` |
| yolov12n | 21.3 ms | 47 FPS | 2.1x | `/opt/hobot/` |
| yolov5s v6 | 14.0 ms | 71 FPS | 3.3x | `/opt/hobot/` |
| **yolo11n** | **8.9 ms** | **112 FPS** | **5.1x** | `models/` |
| **yolov8n** (local) | **7.7 ms** | **129 FPS** | **5.9x** | `models/` |
| yolov8n (system) | 6.1 ms | 164 FPS | 7.5x | `/opt/hobot/` |

---

## 0-2. モデルメタデータ比較

### 共通仕様 (全モデル)
- 入力: `(1, 3, 640, 640)` NV12, 614400 bytes
- 入力ソース: `HB_DNN_INPUT_FROM_PYRAMID` (ROI推論対応)
- 出力: 6ヘッド (stride 8/16/32 × cls[80] + bbox_dfl[64])
- レイアウト: NHWC

### 出力フォーマットの差異

| モデル | cls出力 | bbox出力 | 備考 |
|--------|---------|----------|------|
| yolov13n (local) | F32, NONE | F32, NONE | 全出力 float32 |
| yolo11n (local) | F32, NONE | F32, NONE | 全出力 float32 |
| yolov8n (local) | F32, NONE | F32, NONE | 全出力 float32 |
| yolov8n (system) | F32, NONE | **S32, SCALE** | bbox のみ量子化 |

**重要**: ローカル `models/` ディレクトリの3モデルは全て同一出力フォーマット (6ヘッド × F32)。
→ **モデル切り替え時に後処理コードの変更は不要**。

### yolov13n が遅い原因

yolov13n は YOLO v13 (2025年後半リリース) のアーキテクチャを採用。
"nano" 相当でも既存の YOLO11n/v8n と比較して:
- パラメータ数/演算量が大幅に増加 (特にアテンション機構)
- Bayes-e BPU 上で効率的に実行できないオペレータが含まれる可能性
- モデルファイルサイズも大きい (yolov13n: 9.3MB vs yolo11n/yolov8n: ~6MB)

---

## 0-3. 公式 Model Zoo との比較

| 検索パス | 発見モデル |
|----------|----------|
| `/opt/hobot/model/x5/basic/` | yolov8, yolov5s/x, yolov3, yolov10, yolov12n, yolo11m |
| `/opt/tros/humble/` | yolo_world, yolov5_672, ppyolo |
| `/app/smart-pet-camera/models/` | yolov13n, yolo11n, yolov8n |

system の yolov8n (`/opt/hobot/`) は local の yolov8n (`models/`) より 20% 高速 (6.1ms vs 7.7ms)。
これは量子化方式の差異 (system版は bbox が S32 SCALE) による可能性が高い。

---

## 0-4. BPU コア数確認

| core_id | 意味 | 結果 |
|---------|------|------|
| 0 | ANY (自動選択) | OK (48.8ms) |
| 1 | Core 0 指定 | OK (46.7ms) |
| 2 | Core 1 指定 | **ERROR** (invalid range [0,1]) |

**結論**: **シングルコア (Core 0 のみ)** 確定。
エラーメッセージ: `hbDNNInferCtrlParam bpuCoreId is invalid, valid range: [0, 1], given: 2`

---

## 0-5. API パフォーマンス比較 (Python)

### hobot_dnn.pyeasy_dnn (合成 NV12 入力, ベンチマーク)

| モデル | 平均 | 標準偏差 | 最小 | 最大 |
|--------|------|---------|------|------|
| yolov13n | 46.25 ms | 0.12 ms | 46.03 ms | 46.53 ms |
| yolo11n | 9.50 ms | 0.11 ms | 9.31 ms | 9.75 ms |
| yolov8n | 8.18 ms | 0.10 ms | 8.01 ms | 8.43 ms |

### 実運用時 (yolo_detector_daemon, zero-copy + letterbox + 後処理込み)

| モデル | 実測平均 | 範囲 | 備考 |
|--------|---------|------|------|
| yolo11n | **16-20 ms** | 15-25 ms | zero-copy import + letterbox + postprocess 込み |

ベンチマークの BPU 純推論 (8.9ms) に対し、実運用では約 2倍。
内訳推定: zero-copy import (~2ms), letterbox (~1ms), 後処理/NMS (~5-10ms)。

### bpu_infer_lib

`bpu_infer_lib.Infer()` のコンストラクタに `bool` 引数が必要 (`Infer(False)`)。
API が不安定な可能性があり、`hobot_dnn` からの移行メリットは低い。

### Python API オーバーヘッド分析

| 計測方法 | yolov13n | yolo11n | yolov8n |
|----------|---------|---------|---------|
| hrt_model_exec (C, BPU only) | 45.5 ms | 8.9 ms | 7.7 ms |
| hobot_dnn (Python API) | 46.3 ms | 9.5 ms | 8.2 ms |
| **オーバーヘッド** | **~0.8 ms** | **~0.6 ms** | **~0.5 ms** |

**結論**: Python API オーバーヘッドは ~0.5-0.8ms と無視できるレベル。
C API 移行の優先度は低い。

---

## 0-6. 検出率ベースライン

テスト画像: `recordings/iframe_20251227_175707_044_frame000599.jpg` (実カメラ録画)

### 閾値別検出数

| 閾値 | yolov13n | yolo11n | yolov8n |
|------|---------|---------|---------|
| 0.25 | 5 (cup×1, bowl×4) | 6 (bottle×1, bowl×3, cake×1, fridge×1) | 7 (bottle×1, cup×1, bowl×3, oven×1, book×1) |
| 0.30 | 5 (cup×1, bowl×4) | 6 (bottle×1, bowl×3, cake×1, fridge×1) | 6 (bottle×1, bowl×3, oven×1, book×1) |
| 0.40 | 2 (bowl×2) | 3 (bottle×1, bowl×2) | 5 (bottle×1, bowl×3, book×1) |
| 0.50 | 1 (bowl×1) | 3 (bottle×1, bowl×2) | 2 (bowl×2) |
| 0.60 | 1 (bowl×1) | 1 (bowl×1) | 2 (bowl×2) |

### 総合処理時間 (JPEG→推論→後処理)

| モデル | 推論 (ms) | 総合 (ms) | 前処理+後処理 (ms) |
|--------|----------|----------|------------------|
| yolov13n | ~50 | ~66-130 | ~16-80 |
| yolo11n | ~13 | ~29-33 | ~16-20 |
| yolov8n | ~12 | ~29-34 | ~17-22 |

**注意**: JPEG パスは BGR→NV12 変換を含むため、前処理が重い。
実運用 (NV12 直接入力) では前処理は ~1ms 以下。

### 分析

1. **yolov8n が最多検出** (閾値 0.25-0.4 で最も多くの物体を検出)
2. **yolo11n は中間** (yolov13n より多い検出数、特に bottle と bowl)
3. **yolov13n は最少検出** (意外にも最新モデルが最も少ない — BPU への最適化不足の可能性)
4. 全モデルで `food_bowl` を安定的に検出 (ペットカメラの主要ユースケース)

---

## 結論と推奨

### 根本原因

**46ms の原因はモデルアーキテクチャ (yolov13n)**。Python API オーバーヘッドではない。

### 推奨アクション (Phase 1)

**シナリオ B を採用**: モデル切り替え

1. **第一候補: yolov8n** — 最高速 (7.7ms/129FPS) かつ最多検出
2. **第二候補: yolo11n** — わずかに遅い (8.9ms/112FPS) が新しいアーキテクチャ

どちらも後処理コード変更不要 (同一出力フォーマット)。

### 不要なアクション

- C API 移行 (オーバーヘッド ~0.5ms で不要)
- `bpu_infer_lib` 移行 (API 不安定、メリット薄)
- マルチスレッド推論 (シングルコアのため効果限定)

### 判断ポイント

1. yolov8n vs yolo11n — どちらを採用するか?
2. score_threshold — 現行 0.6 を下げるか? (0.4 で良好な検出数)
3. Phase 2 (VSE 高解像度化) に進むか?
