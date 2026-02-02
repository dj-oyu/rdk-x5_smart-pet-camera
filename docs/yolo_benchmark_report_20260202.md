# YOLO Detection Benchmark Report

**Date:** 2026-02-02
**Platform:** RDK X5 (BPU Bayes-e, 10 TOPS)
**Test Images:** 20 images from COCO128

---

## Summary Table

| Model | Inference (ms) | Pre-process (ms) | Post-process (ms) | Total (ms) | FPS | Detections/Frame |
|-------|----------------|------------------|-------------------|------------|-----|------------------|
| **YOLOv8n** | 10.00 | 12.91 | 5.22 | 28.17 | **35.5** | 2.2 |
| **YOLO11n** | 11.29 | 12.82 | 5.21 | 29.36 | **34.1** | 2.0 |
| **YOLO13n** | 51.30 | 13.20 | 5.41 | 69.94 | 14.3 | 1.6 |
| **YOLO26n** | **13.58** | 12.37 | 31.89 | 57.86 | 17.3 | 247.8 |

---

## Analysis

### Inference Time (BPU)

```
v8n   ████████████████████ 10.00 ms
v11n  ██████████████████████ 11.29 ms
v26n  ███████████████████████████ 13.58 ms  ← エッジ最適化
v13n  ██████████████████████████████████████████████████████████████████████████████████████████████████████ 51.30 ms
```

**YOLO26n の BPU推論時間は 13.58ms で、v8n/v11n に次ぐ高速性能。**

### Total Pipeline Time

```
v8n   ████████████████████████████ 28.17 ms (35.5 FPS)
v11n  █████████████████████████████ 29.36 ms (34.1 FPS)
v26n  ██████████████████████████████████████████████████████████ 57.86 ms (17.3 FPS)
v13n  ██████████████████████████████████████████████████████████████████████ 69.94 ms (14.3 FPS)
```

---

## YOLO26n Issue: High Post-processing Time

### 問題点

| Metric | YOLO26n | 他モデル平均 |
|--------|---------|-------------|
| Post-process | **31.89 ms** | ~5.3 ms |
| Detections/Frame | **247.8** | ~1.9 |

YOLO26n の後処理時間が異常に長く、検出数が過多。

### 原因分析

1. **出力形式の不一致**: YOLO26 は One2One (End-to-End) ブランチを使用しており、従来のアンカーフリーデコードと異なる可能性
2. **スコア閾値の適用問題**: 生の logit 値に対する閾値処理が正しく機能していない可能性
3. **NMS非適用**: One2One ブランチは NMS 不要設計だが、現在のパイプラインで重複検出が発生

### 推奨対応

1. `yolo26_det.py` の後処理ロジックを `smart-pet-camera` 用に調整
2. または `YoloDetector` クラスに YOLO26 専用の後処理を追加

---

## Model Comparison

### Pros & Cons

| Model | Pros | Cons |
|-------|------|------|
| **YOLOv8n** | 最速トータル、安定 | 旧世代 |
| **YOLO11n** | v8n同等性能、新アーキ | v8nとほぼ同じ |
| **YOLO13n** | 高精度期待 | BPU推論が遅い (51ms) |
| **YOLO26n** | BPU推論高速 (13.6ms) | 後処理要調整 |

### Recommendation

**現時点での推奨: YOLOv8n または YOLO11n**

YOLO26n は BPU推論性能は優秀だが、後処理の調整が必要。
調整完了後は最有力候補となる可能性あり。

---

## Raw Performance Data

### YOLOv8n
- Inference: 10.00 ms (100.0 FPS equivalent)
- Total: 28.17 ms (35.5 FPS)
- Model size: 3.6 MB

### YOLO11n
- Inference: 11.29 ms (88.6 FPS equivalent)
- Total: 29.36 ms (34.1 FPS)
- Model size: 3.3 MB

### YOLO13n
- Inference: 51.30 ms (19.5 FPS equivalent)
- Total: 69.94 ms (14.3 FPS)
- Model size: 8.9 MB

### YOLO26n
- Inference: 13.58 ms (73.7 FPS equivalent)
- Total: 57.86 ms (17.3 FPS)
- Model size: 3.5 MB
- **Note:** Post-processing needs optimization

---

## Next Steps

1. [ ] YOLO26 後処理の調整 (`score_threshold`, NMS ロジック)
2. [ ] 調整後の再ベンチマーク
3. [ ] 検出精度の比較 (mAP)
4. [ ] リアルタイムカメラストリームでのテスト

---

## Appendix: Test Environment

- **Hardware:** RDK X5 (Cortex-A55 x8, BPU 10 TOPS)
- **OS:** Ubuntu 22.04 aarch64
- **hobot_dnn:** 3.0.8
- **Test dataset:** COCO128 (20 images)
