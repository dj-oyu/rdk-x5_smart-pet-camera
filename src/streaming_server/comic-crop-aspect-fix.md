# Comic Crop Aspect Ratio Fix

## Problem

`comic_capture.go` のクロップ処理でアスペクト比が崩れ、パネル内の猫が横に引き伸ばされる。
これにより後工程の YOLO 検出精度が大幅に低下する（本来検出できる猫が 0 件になるケースあり）。

### 根本原因

bbox に基づく crop 領域 (`expandW × expandH`) がパネルのアスペクト比 (404:228 = 1.77:1) と一致しない。
例えば縦長の猫 (bbox 200×300) → crop 260×390 → `n2d_blit` で 404×228 に強制リサイズ → 横に引き伸ばし。

### 実証データ (2026-03-31)

`comic_20260331_100354_mike.jpg` (猫が明確に写っている):

| 入力 | 検出数 | cat |
|------|--------|-----|
| Original 848×496 (ratio 1.71) | 0 | 0 |
| Squared 496×496 (ratio 1.00) | 2 | 1 (conf 0.50) |

パネル単位でも同様:

| 入力 | 検出数 |
|------|--------|
| Panel 404×228 (ratio 1.77) | 0 |
| Panel 228×228 (ratio 1.00) | 1 |

## 修正箇所

`internal/webmonitor/comic_capture.go` L454-524 付近の crop 計算ロジック。

### 現在のコード (問題あり)

```go
expandW := int(float64(bw) * factor)
expandH := int(float64(bh) * factor)
// → expandW:expandH がパネル比 404:228 と一致しない
// → n2d_blit で歪んでリサイズされる
```

### 修正方針

bbox を含む最小の **パネル比率 (404:228)** の crop 領域を計算し、factor で拡大する。
さらに以下の制約を適用:

1. **アスペクト比保持**: crop の W:H を常に 404:228 に合わせる
2. **最大 crop 制限**: 元フレームの 80% を超えないよう制限 (大きすぎると YOLO 検出が不利)
3. **フレーム端クランプ**: はみ出たら中心をスライドして収める

### 修正コード

```go
// Compute crop region
if p.bbox != nil && i > 0 {
    sb := scaleBBoxToFrame(*p.bbox)
    bx, by, bw, bh := sb.X, sb.Y, sb.W, sb.H

    var factor float64
    if p.motionHint {
        factor = 1.5 + rand.Float64()*0.5
    } else if p.placeholder {
        factor = 3.0 + rand.Float64()*1.0
    } else {
        factor = 1.3 + rand.Float64()*1.2
    }

    cx := bx + bw/2
    cy := by + bh/2

    // Motion vector extrapolation (unchanged)
    if p.motionHint && lastYoloBBox != nil {
        sYolo := scaleBBoxToFrame(*lastYoloBBox)
        yoloCX := sYolo.X + sYolo.W/2
        yoloCY := sYolo.Y + sYolo.H/2
        cx += cx - yoloCX
        cy += cy - yoloCY
        if cx < 0 {
            cx = 0
        } else if cx >= p.width {
            cx = p.width - 1
        }
        if cy < 0 {
            cy = 0
        } else if cy >= p.height {
            cy = p.height - 1
        }
    }

    // --- NEW: aspect-ratio-preserving crop ---
    const panelAspect = float64(comicPanelW) / float64(comicPanelH) // 404/228 ≈ 1.77

    // Start from bbox expanded by factor
    cropW := int(float64(bw) * factor)
    cropH := int(float64(bh) * factor)
    if cropW < 64 {
        cropW = 64
    }
    if cropH < 64 {
        cropH = 64
    }

    // Adjust to match panel aspect ratio (expand the smaller dimension)
    if float64(cropW)/float64(cropH) < panelAspect {
        // Too tall → widen
        cropW = int(float64(cropH) * panelAspect)
    } else {
        // Too wide → heighten
        cropH = int(float64(cropW) / panelAspect)
    }

    // Cap at 80% of frame to keep YOLO effective resolution
    maxW := p.width * 4 / 5
    maxH := p.height * 4 / 5
    if cropW > maxW {
        cropW = maxW
        cropH = int(float64(cropW) / panelAspect)
    }
    if cropH > maxH {
        cropH = maxH
        cropW = int(float64(cropH) * panelAspect)
    }

    // Clamp to frame bounds (slide, don't shrink)
    x0 := cx - cropW/2
    y0 := cy - cropH/2
    if x0 < 0 {
        x0 = 0
    }
    if y0 < 0 {
        y0 = 0
    }
    if x0+cropW > p.width {
        x0 = p.width - cropW
    }
    if y0+cropH > p.height {
        y0 = p.height - cropH
    }
    // Final safety: if frame is smaller than crop (shouldn't happen), clamp
    if x0 < 0 {
        x0 = 0
        cropW = p.width
        cropH = int(float64(cropW) / panelAspect)
    }
    if y0 < 0 {
        y0 = 0
        cropH = p.height
        cropW = int(float64(cropH) * panelAspect)
    }

    cropRegions[i] = cropRegion{x0, y0, cropW, cropH}
    cCrops[i] = C.comic_crop_t{
        src_x: C.int(x0), src_y: C.int(y0),
        src_w: C.int(cropW), src_h: C.int(cropH),
    }
}
```

### 注意事項

- `comicPanelW=404, comicPanelH=228` は HW JPEG encoder のアライメント制約 (16/8) から決まっている。変更しない
- パネル 0 (i==0) は bbox なしで `cropRegion{0, 0, p.width, p.height}` (フルフレーム)。元フレーム 768×432 (1.78:1) → 404×228 (1.77:1) なのでほぼ歪みなし。修正不要
- crop 後のリサイズは `n2d_blit` (GPU) が行うため、Rust/ai-pyramid 側の変更は不要
- bbox の座標変換は Go の `scaleBBoxToFrame` + ai-pyramid 側の `detect_panels_raw` 双方で行われるが、この修正は Go 側のみ
