# YOLO26 Integration Summary

**Date:** 2026-02-02
**Status:** Completed
**Branch:** feature/yolo26-integration

---

## Overview

YOLO26モデルの後処理ロジックを`YoloDetector`に統合。従来モデル（v8/v11/v13）との互換性を維持しながら、YOLO26固有の出力形式に対応。

---

## Problem & Solution

### 問題

YOLO26の出力形式が従来モデルと異なり、既存の後処理ロジックでは正しく処理できなかった。

| 指標 | 改善前 | 期待値 |
|------|--------|--------|
| Post-process time | 31.89 ms | < 10 ms |
| Detections/frame | 247.8 | ~4 |

### 原因

| 項目 | Legacy (v8/v11/v13) | YOLO26 |
|------|---------------------|--------|
| 出力順序 | cls → bbox | bbox → cls |
| bbox形式 | DFL (64ch) | 直接座標 (4ch) |
| デコード | softmax + DFL期待値 | grid ± box |

### 解決策

`YoloDetector`に`model_type`パラメータを追加し、モデルタイプに応じて後処理を分岐。

---

## Implementation

### 変更ファイル

| File | Changes |
|------|---------|
| `src/common/src/detection/yolo_detector.py` | +`model_type`パラメータ, +`_postprocess_yolo26()`, +`_init_yolo26_grids()` |

### 追加コード (~120行)

1. **コンストラクタ拡張**
   - `model_type: str = "auto"` パラメータ追加
   - ファイル名から自動検出 (`"yolo26"` in path → `model_type="yolo26"`)

2. **YOLO26用グリッド初期化**
   - `_init_yolo26_grids()`: 各ストライドごとに `(H*W, 2)` 形式で事前計算

3. **後処理分岐**
   - `_postprocess()`: `model_type`で分岐
   - `_postprocess_legacy()`: 従来モデル用（既存コード）
   - `_postprocess_yolo26()`: YOLO26専用

---

## Test Results

### Benchmark (bus.jpg)

| Model | Inference | Post-process | Detections | Total |
|-------|-----------|--------------|------------|-------|
| YOLO11n | 17.48 ms | 6.96 ms | 4 | 59.28 ms |
| **YOLO26n** | 17.57 ms | **5.38 ms** | 4 | 57.57 ms |

### 改善結果

| 指標 | 改善前 | 改善後 | 結果 |
|------|--------|--------|------|
| Post-process time | 31.89 ms | **5.38 ms** | **6倍高速化** |
| Detections/frame | 247.8 | **4** | 正常化 |

### Success Criteria

- [x] Post-process time < 10 ms (5.38 ms)
- [x] Detections/frame: 妥当な数 (4)
- [x] 既存モデルへの影響なし (v11n動作確認済み)

---

## Usage

```python
from detection.yolo_detector import YoloDetector

# 自動検出（推奨）
detector = YoloDetector(
    model_path="models/yolo26n_det_bpu_bayese_640x640_nv12.bin"
)
# → model_type="yolo26" が自動設定

# 明示的指定
detector = YoloDetector(
    model_path="models/custom_model.bin",
    model_type="yolo26"  # or "legacy"
)
```

---

## References

- [YOLO26 Integration Plan](./plan_yolo26_integration.md)
- [D-Robotics/rdk_model_zoo](https://github.com/D-Robotics/rdk_model_zoo) (Apache 2.0)
