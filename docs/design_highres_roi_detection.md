# 高解像度入力 + ROI 検出設計

## 現在のステータス

**ROI モードは無効化**。境界分断・点滅問題のため 640x360 レターボックス方式に戻した。
ROI 関連コードは保持されており、将来の再有効化に備える。

### 現行パイプライン

```
1920x1080 → VSE Ch1 → 640x360 → letterbox (事前確保) → 640x640 → BPU → 後処理
            (3倍均一縮小)    (alloc 0回, memcpy 2回)
```

---

## 実装済み最適化

### 1. scipy.softmax → numpy 実装 ✅

```python
def _fast_softmax(x, axis=-1):
    e_x = np.exp(x - np.max(x, axis=axis, keepdims=True))
    return e_x / np.sum(e_x, axis=axis, keepdims=True)
```

### 2. レターボックスバッファ事前確保 ✅

- バッファを初回のみ確保、以後再利用
- パディング領域 (Y=16, UV=128) は初回のみ書き込み
- 毎フレーム: Y + UV の memcpy 2回のみ (alloc 0回)

### 3. SHM バージョンチェック削除 ✅

- `ZeroCopySharedMemory.last_version` 属性を完全削除
- `get_frame()` は常に現在のバッファを返す
- 検出器は最大スループットで推論を継続

---

## ROI 検出 (実装済み・無効化中)

### 実装内容

ROI 関連のコードはすべて実装済みだが、`roi_enabled = False` で無効化。

| 機能 | ファイル | 状態 |
|------|---------|------|
| `detect_nv12_roi()` | `yolo_detector.py` | 実装済み・未使用 |
| `get_roi_regions()` | `yolo_detector.py` | 実装済み・未使用 |
| `_crop_nv12_roi()` | `yolo_detector.py` | 実装済み・未使用 |
| 3パターン巡回 | `yolo_detector.py` | 実装済み・未使用 |
| 時間統合 + NMS | `yolo_detector_daemon.py` | 実装済み・未使用 |
| 境界bbox結合 | `yolo_detector_daemon.py` | 実装済み・未使用 |
| `--no-roi` フラグ | `yolo_detector_daemon.py` | 実装済み |

### 無効化の理由

1. **ROI 境界でのオブジェクト分断**: 水平境界 (x=640) を跨ぐオブジェクトが
   2つの部分 bbox に分割される。`_merge_boundary_bboxes()` で対応したが不十分
2. **検出結果の左右点滅**: 動きがないにもかかわらず、ROI ごとに検出結果が
   交互に現れたり消えたりする
3. **bbox 形状の歪み**: 部分検出により bbox が実際のオブジェクト形状と一致しない

### 再有効化の条件

- ROI 間の水平オーバーラップの追加 (現状 0px)
- 3 ROI 横分割 (左・中央・右) で境界問題を軽減
- または C API `hbDNNRoiInfer()` によるハードウェア ROI 推論の採用

---

## ROI 設計 (参考)

### 1280x720 の場合

#### パターン巡回 (3パターン × 2 ROI = 6フレーム周期)

```
パターン0 (上寄せ):    y=0   → y=0-640 をカバー
パターン1 (中央寄せ):  y=40  → y=40-680 をカバー
パターン2 (下寄せ):    y=80  → y=80-720 をカバー
```

| パターン | ROI 0 (左) | ROI 1 (右) | カバー範囲 (Y) |
|---------|------------|------------|---------------|
| 0 (上寄せ) | (0, 0, 640, 640) | (640, 0, 640, 640) | 0-640 |
| 1 (中央) | (0, 40, 640, 640) | (640, 40, 640, 640) | 40-680 |
| 2 (下寄せ) | (0, 80, 640, 640) | (640, 80, 640, 640) | 80-720 |

全域カバー: 720/720 = 100%

### 後処理統合オプション

| 方式 | レイテンシ | 全域カバー | 重複除去 | 実装難度 |
|------|-----------|-----------|---------|---------|
| 逐次 + 時間統合 | 低 | Nフレーム | あり | 中 |
| 同一フレーム全ROI | 中 | 1フレーム | あり | 中 |
| 適応的ROI | 可変 | 可変 | 部分的 | 高 |

### 将来拡張: 適応的ROI選択

```python
class AdaptiveROISelector:
    def get_next_roi(self):
        if self.recent_detections:
            return self._roi_around_detection()  # 検出追跡モード
        else:
            return self._next_pattern_roi()      # 探索モード
```
