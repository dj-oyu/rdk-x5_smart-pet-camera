# YOLO26 Integration Plan

**Date:** 2026-02-02
**Status:** Planning
**Priority:** High

---

## Executive Summary

YOLO26はエッジ推論に最適化された最新モデル（2026年1月リリース）。BPU推論性能は優秀（13.6ms）だが、出力形式が既存のYOLO v8/v11/v13と異なるため、`YoloDetector`の後処理ロジックを拡張する必要がある。

### Key Metrics

| Metric | YOLO26n | YOLO11n (現行) | 改善 |
|--------|---------|----------------|------|
| BPU推論 | 13.6 ms | 11.3 ms | -20% |
| モデルサイズ | 3.5 MB | 3.3 MB | 同等 |
| 理論FPS | 73.7 | 88.6 | - |
| 精度 (mAP) | TBD | - | 要検証 |

---

## Problem Statement

### 現象

ベンチマークテスト（2026-02-02）にて以下の異常を確認：

| Metric | YOLO26n | 期待値 |
|--------|---------|--------|
| Post-process time | **31.89 ms** | ~5 ms |
| Detections/frame | **247.8** | ~2 |

### 原因

YOLO26は **One2One (End-to-End) ブランチ** を使用し、出力形式が従来モデルと異なる。

#### 出力形式の比較

**従来モデル (v8/v11/v13):**
```
outputs[0]: cls (N, 80)     # stride 8
outputs[1]: bbox (N, 64)    # DFL形式 (16*4)
outputs[2]: cls (N, 80)     # stride 16
outputs[3]: bbox (N, 64)
outputs[4]: cls (N, 80)     # stride 32
outputs[5]: bbox (N, 64)
```

**YOLO26 (BPU Export):**
```
outputs[0]: bbox (H, W, 4)  # 直接 xyxy, stride 8
outputs[1]: cls (H, W, 80)  # logit scores
outputs[2]: bbox (H, W, 4)  # stride 16
outputs[3]: cls (H, W, 80)
outputs[4]: bbox (H, W, 4)  # stride 32
outputs[5]: cls (H, W, 80)
```

**主な違い:**
1. **出力順序**: 従来は cls→bbox、YOLO26は bbox→cls
2. **Bbox形式**: 従来は DFL (64ch)、YOLO26は 直接座標 (4ch)
3. **レイアウト**: YOLO26は NHWC (H, W, C)

---

## Solution Design

### Option A: YoloDetector拡張 (推奨)

`YoloDetector`クラスに YOLO26専用の後処理パスを追加。

#### 変更箇所

1. **コンストラクタ拡張**
   - `model_type` パラメータ追加 (`"legacy"` | `"yolo26"`)
   - モデルファイル名から自動検出も可能

2. **後処理分岐**
   - `_postprocess()` で `model_type` に応じて処理を分岐
   - YOLO26用の `_postprocess_yolo26()` を新規追加

3. **Gridの事前計算**
   - YOLO26は anchor-free だがグリッド計算は必要
   - 既存の `self.grids` を流用可能

#### コード設計

```python
class YoloDetector:
    def __init__(
        self,
        model_path: str,
        model_type: str = "auto",  # "auto", "legacy", "yolo26"
        ...
    ):
        # モデルタイプの自動検出
        if model_type == "auto":
            if "yolo26" in model_path.lower():
                self.model_type = "yolo26"
            else:
                self.model_type = "legacy"
        else:
            self.model_type = model_type

        # YOLO26用のパラメータ
        if self.model_type == "yolo26":
            self.reg = 1  # DFL不使用
            self._init_yolo26_grids()

    def _postprocess(self, outputs, scale, shift, original_shape):
        if self.model_type == "yolo26":
            return self._postprocess_yolo26(outputs, scale, shift, original_shape)
        else:
            return self._postprocess_legacy(outputs, scale, shift, original_shape)

    def _postprocess_yolo26(self, outputs, scale, shift, original_shape):
        """YOLO26専用後処理（anchor-free, direct xyxy）"""
        # rdk_model_zoo/yolo26_det.py の post_process を移植
        ...
```

### Option B: 別クラス作成

`Yolo26Detector`を新規作成し、既存コードに影響を与えない。

**Pros:**
- 既存コードへの影響ゼロ
- テスト容易

**Cons:**
- コード重複
- 将来の保守コスト増

### Option C: Adapter Pattern

共通インターフェースを定義し、モデル固有の処理をアダプターに委譲。

**Pros:**
- 拡張性が高い
- 将来のモデル追加が容易

**Cons:**
- オーバーエンジニアリングの可能性
- 実装コスト高

---

## Implementation Plan

### Phase 1: 後処理ロジック移植 (Day 1)

1. `rdk_model_zoo/yolo26_det.py` の `post_process()` を分析
2. `YoloDetector._postprocess_yolo26()` を実装
3. 単体テスト作成

**Deliverables:**
- `src/common/src/detection/yolo_detector.py` 更新
- `tests/test_yolo26_detector.py` 新規

### Phase 2: 統合テスト (Day 1-2)

1. ベンチマーク再実行
2. 検出精度の確認
3. パフォーマンス測定

**Success Criteria:**
- Post-process time < 10 ms
- Detections/frame: 適切な数 (画像による)
- 検出結果が妥当

### Phase 3: 本番投入 (Day 2-3)

1. `yolo_detector_daemon.py` 更新
2. 設定ファイル更新
3. カメラストリームでの動作確認

---

## Technical Details

### YOLO26 後処理アルゴリズム

```python
def _postprocess_yolo26(self, outputs, scale, shift, original_shape):
    """
    YOLO26 Anchor-Free Detection Post-processing

    出力形式: [bbox0, cls0, bbox1, cls1, bbox2, cls2]
    bbox: (H, W, 4) - 直接座標 (grid相対)
    cls: (H, W, 80) - logit scores
    """
    y_scale, x_scale = scale
    y_shift, x_shift = shift
    orig_h, orig_w = original_shape

    dets = []

    # 3スケール処理
    for i, stride in enumerate(self.strides):
        bbox_idx = i * 2      # 0, 2, 4
        cls_idx = i * 2 + 1   # 1, 3, 5

        bbox_data = outputs[bbox_idx].reshape(-1, 4)
        cls_data = outputs[cls_idx].reshape(-1, 80)

        # スコアフィルタリング (生のlogitで比較)
        max_scores = np.max(cls_data, axis=1)
        mask = max_scores >= self.conf_thres_raw

        if not np.any(mask):
            continue

        # Gridを使ってxyxyをデコード
        grid = self.grids[i][mask]
        v_box = bbox_data[mask]
        v_score = 1 / (1 + np.exp(-max_scores[mask]))  # sigmoid
        v_id = np.argmax(cls_data[mask], axis=1)

        # YOLO26のデコード: (grid +/- box) * stride
        xyxy = np.hstack([
            (grid - v_box[:, :2]),
            (grid + v_box[:, 2:])
        ]) * stride

        dets.extend(np.hstack([xyxy, v_score[:, None], v_id[:, None]]))

    # NMS処理...
    return self._apply_nms_and_convert(dets, scale, shift, original_shape)
```

### Grid計算

```python
def _init_yolo26_grids(self):
    """YOLO26用グリッドの事前計算"""
    self.grids = {}
    for stride in self.strides:
        grid_h = self.input_h // stride
        grid_w = self.input_w // stride
        # np.indices returns (y_grid, x_grid), need (x, y) order
        grid = np.stack(np.indices((grid_h, grid_w))[::-1], axis=-1)
        self.grids[stride] = grid.reshape(-1, 2).astype(np.float32) + 0.5
```

---

## Risk Assessment

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| 後処理実装バグ | High | Medium | 十分なテスト、rdk_model_zooとの結果比較 |
| 性能劣化 | Medium | Low | ベンチマーク継続監視 |
| 既存コード破壊 | High | Low | `model_type="legacy"`をデフォルト |

---

## Testing Strategy

### Unit Tests

```python
def test_yolo26_postprocess_output_format():
    """YOLO26後処理の出力形式を検証"""
    detector = YoloDetector(
        model_path="models/yolo26n_det_bpu_bayese_640x640_nv12.bin",
        model_type="yolo26"
    )
    # ...

def test_yolo26_detection_count():
    """検出数が妥当な範囲であることを確認"""
    # bus.jpg: 4-6 persons, 1 bus expected
    assert 3 <= len(detections) <= 10
```

### Integration Tests

```bash
# ベンチマーク再実行
./scripts/run_yolo_benchmark.sh --model v26n --image test_pic/bus.jpg
```

### Acceptance Criteria

- [ ] Post-process time < 10 ms
- [ ] 検出数: bus.jpg で 5-7 objects
- [ ] FPS > 30 (total pipeline)
- [ ] 既存モデル (v8n, v11n, v13n) への影響なし

---

## Timeline

| Phase | Duration | Owner | Status |
|-------|----------|-------|--------|
| Phase 1: 後処理移植 | 4h | - | Pending |
| Phase 2: 統合テスト | 2h | - | Pending |
| Phase 3: 本番投入 | 2h | - | Pending |

**Total Estimated Effort:** 8 hours

---

## Code Modification Plan

### 修正対象ファイル

**`src/common/src/detection/yolo_detector.py`**

### Step 1: コンストラクタ修正

```python
# 追加するパラメータ
def __init__(
    self,
    model_path: str,
    model_type: str = "auto",  # 追加: "auto", "legacy", "yolo26"
    score_threshold: float = 0.25,
    nms_threshold: float = 0.7,
    reg: int = 16,  # YOLO26では使用しない
    strides: list[int] = [8, 16, 32],
    ...
):
    # モデルタイプの自動検出を追加 (L230付近)
    if model_type == "auto":
        self.model_type = "yolo26" if "yolo26" in model_path.lower() else "legacy"
    else:
        self.model_type = model_type

    # YOLO26用グリッド初期化 (既存のself.gridsと互換)
    if self.model_type == "yolo26":
        self._init_yolo26_grids()
```

### Step 2: YOLO26用グリッド初期化メソッド追加

```python
def _init_yolo26_grids(self) -> None:
    """YOLO26用のAnchor-Freeグリッドを事前計算

    従来のself.gridsとは形式が異なる:
    - 従来: list of (grid_h * grid_w, 2) for each stride
    - YOLO26: dict {stride: (grid_h * grid_w, 2)}
    """
    self.grids_yolo26 = {}
    for stride in self.strides:
        grid_h = self.input_h // stride
        grid_w = self.input_w // stride
        # (y, x) -> (x, y) の順序でスタック
        grid = np.stack(np.indices((grid_h, grid_w))[::-1], axis=-1)
        self.grids_yolo26[stride] = grid.reshape(-1, 2).astype(np.float32) + 0.5
```

### Step 3: 後処理の分岐追加

```python
def _postprocess(
    self,
    outputs: list[np.ndarray],
    scale: tuple[float, float],
    shift: tuple[float, float],
    original_shape: tuple[int, int],
) -> list[Detection]:
    """後処理: モデルタイプに応じて分岐"""
    if self.model_type == "yolo26":
        return self._postprocess_yolo26(outputs, scale, shift, original_shape)
    else:
        return self._postprocess_legacy(outputs, scale, shift, original_shape)
```

### Step 4: 既存後処理をリネーム

```python
# 現在の _postprocess() を _postprocess_legacy() にリネーム
def _postprocess_legacy(
    self,
    outputs: list[np.ndarray],
    scale: tuple[float, float],
    shift: tuple[float, float],
    original_shape: tuple[int, int],
) -> list[Detection]:
    """従来モデル (v8/v11/v13) 用の後処理"""
    # 既存コードをそのまま移動
    ...
```

### Step 5: YOLO26用後処理を新規追加

```python
def _postprocess_yolo26(
    self,
    outputs: list[np.ndarray],
    scale: tuple[float, float],
    shift: tuple[float, float],
    original_shape: tuple[int, int],
) -> list[Detection]:
    """YOLO26専用後処理 (Anchor-Free, Direct XYXY)

    出力形式: [bbox0, cls0, bbox1, cls1, bbox2, cls2]
    - bbox: (H*W, 4) - グリッド相対座標
    - cls: (H*W, 80) - logit scores
    """
    y_scale, x_scale = scale
    y_shift, x_shift = shift
    orig_h, orig_w = original_shape

    dets = []

    # 3スケール処理 (stride 8, 16, 32)
    for i, stride in enumerate(self.strides):
        bbox_idx = i * 2      # 0, 2, 4
        cls_idx = i * 2 + 1   # 1, 3, 5

        bbox_data = outputs[bbox_idx].reshape(-1, 4)
        cls_data = outputs[cls_idx].reshape(-1, 80)

        # スコアフィルタリング (logitのまま比較)
        max_scores = np.max(cls_data, axis=1)
        mask = max_scores >= self.conf_thres_raw

        if not np.any(mask):
            continue

        # マスク適用
        grid = self.grids_yolo26[stride][mask]
        v_box = bbox_data[mask]
        v_score = 1 / (1 + np.exp(-max_scores[mask]))  # sigmoid
        v_id = np.argmax(cls_data[mask], axis=1)

        # YOLO26デコード: (grid ± box) * stride
        xyxy = np.hstack([
            (grid - v_box[:, :2]),
            (grid + v_box[:, 2:])
        ]) * stride

        dets.extend(np.hstack([xyxy, v_score[:, None], v_id[:, None]]))

    # NMS処理 (既存の _apply_nms と同様のロジック)
    return self._apply_nms_yolo26(dets, scale, shift, original_shape)


def _apply_nms_yolo26(
    self,
    dets: list,
    scale: tuple[float, float],
    shift: tuple[float, float],
    original_shape: tuple[int, int],
) -> list[Detection]:
    """YOLO26用NMS処理"""
    if not dets:
        return []

    y_scale, x_scale = scale
    y_shift, x_shift = shift
    orig_h, orig_w = original_shape

    dets = np.array(dets)
    final_res = []

    # クラスごとにNMS
    for class_id in np.unique(dets[:, 5]):
        cls_dets = dets[dets[:, 5] == class_id]

        # xyxy -> xywh (NMS用)
        xywh = cls_dets[:, :4].copy()
        xywh[:, 2:] -= xywh[:, :2]  # w = x2 - x1, h = y2 - y1

        indices = cv2.dnn.NMSBoxes(
            xywh.tolist(),
            cls_dets[:, 4].tolist(),
            self.score_threshold,
            self.nms_threshold
        )

        if len(indices) == 0:
            continue

        # DetectionClassへのマッピング
        detection_class = self._map_coco_to_detection_class(int(class_id))
        if detection_class is None:
            continue

        for idx in indices.flatten():
            d = cls_dets[idx]
            # 座標変換: letterbox -> 元画像
            x1 = int((d[0] - x_shift) / x_scale)
            y1 = int((d[1] - y_shift) / y_scale)
            x2 = int((d[2] - x_shift) / x_scale)
            y2 = int((d[3] - y_shift) / y_scale)

            # クリッピング
            x1 = max(0, min(x1, orig_w))
            x2 = max(0, min(x2, orig_w))
            y1 = max(0, min(y1, orig_h))
            y2 = max(0, min(y2, orig_h))

            final_res.append(Detection(
                class_name=detection_class,
                confidence=float(d[4]),
                bbox=BoundingBox(x=x1, y=y1, w=x2-x1, h=y2-y1),
            ))

    return final_res
```

---

## Reference Source Files

### D-Robotics rdk_model_zoo (Apache 2.0 License)

YOLO26の後処理実装は以下のファイルを参照:

| File | URL | Description |
|------|-----|-------------|
| `yolo26_det.py` | [GitHub](https://github.com/D-Robotics/rdk_model_zoo/blob/main/samples/vision/yolo26/runtime/python/yolo26_det.py) | Detection後処理の参照実装 |

**主要メソッド:**
- `YOLO26Detect.post_process()` (L164-238): NMS含む後処理
- `YOLO26Detect.__init__()` (L95-102): グリッド事前計算

**ライセンス:** Apache License 2.0 - 商用利用・改変・再配布可能

---

## References

- [D-Robotics/rdk_model_zoo](https://github.com/D-Robotics/rdk_model_zoo) - 公式モデルZoo (Apache 2.0)
- [Benchmark Report](./yolo_benchmark_report_20260202.md)
- [YOLO26 Conversion Guide](https://github.com/D-Robotics/rdk_model_zoo/blob/main/samples/vision/yolo26/conversion/X86_CONVERSION_GUIDE.md)

---

## Appendix: File Changes Summary

### Files to Modify

| File | Changes |
|------|---------|
| `src/common/src/detection/yolo_detector.py` | +`model_type`パラメータ, +`_postprocess_yolo26()`, +`_init_yolo26_grids()` |
| `scripts/test_yolo_detection.py` | YOLO26モデル定義（完了済み） |

### Files to Create

| File | Purpose |
|------|---------|
| `tests/test_yolo26_detector.py` | YOLO26専用テスト |

### Estimated Lines Changed

| Operation | Lines |
|-----------|-------|
| 新規追加 | ~120 |
| 既存リネーム | ~5 |
| 合計 | ~125 |

### Configuration Changes

| Config | Changes |
|--------|---------|
| `.env` | `YOLO_MODEL_TYPE=yolo26` (optional) |
