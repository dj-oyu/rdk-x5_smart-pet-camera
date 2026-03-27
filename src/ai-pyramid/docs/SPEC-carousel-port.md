# SPEC: Carousel & Detection UI Port

## Overview

`/test/carousel` デモで検証済みの機能を本番 Preact SPA (`ui/src/`) にポートする。
デモは vanilla JS + inline CSS だが、本番は Preact hooks + CSS modules に再構成する。

## Port Feature Matrix

### Phase 1: Core Navigation & Bbox

| Feature | Demo Status | Port Priority |
|---------|-------------|---------------|
| コミックビュー (2x2 grid) | Done | P0 — 既存 event-detail.tsx を拡張 |
| カルーセル (scroll-snap) | Done | P0 — 新コンポーネント |
| パネルクリック → カルーセル遷移 | Done | P0 |
| ガラスbboxオーバーレイ (コミック) | Done | P0 — 現行 glass-bbox をそのまま |
| ガラスbboxオーバーレイ (パネル) | Done | P0 |
| Detection list ↔ bbox 双方向ハイライト | Done | P0 |
| Detection list クリック → パネルジャンプ | Done | P0 |
| Breadcrumb ナビ | Done | P1 |
| Prev/Next ボタン + ドットインジケータ | Done | P1 |
| Keyboard nav (Arrow, Escape) | Done | P1 |

### Phase 2: Zoom & Pan

| Feature | Demo Status | Port Priority |
|---------|-------------|---------------|
| Bbox クリック → zoom-to-bbox (1.8x-3.5x) | Done | P1 |
| Drag-to-pan (mouse + touch) | Done | P1 |
| Rubber band edge effect | Done | P2 |
| Escape → un-zoom → comic | Done | P1 |

### Phase 3: Upscale

| Feature | Demo Status | Port Priority |
|---------|-------------|---------------|
| TF.js Real-ESRGAN 4x upscale | Done | P2 |
| Auto `general_fast` on panel open | Done | P2 |
| HD button (`general_plus`) | Done | P2 |
| Progress bar | Done | P2 |
| Model cache + cancel token | Done | P2 |
| Tiled processing (128px) | Done | P2 |

### Phase 4: Utility

| Feature | Demo Status | Port Priority |
|---------|-------------|---------------|
| JPEG download (全体/パネル別) | Done | P1 |
| Confidence bar in detection list | Done | P1 |
| Share link (deep navigation) | Spec only | P1 — see SPEC-share-link |

## Architecture: Demo → Preact

### Component Tree

```
EventDetail (既存モーダル)
  ├── ComicView                    # 2x2 grid + glass bbox overlay
  │   ├── BboxOverlay (glass)      # pointer-events: none
  │   └── PanelRegions (clickable) # cursor: zoom-in
  ├── CarouselView                 # scroll-snap carousel
  │   ├── PanelSlide[0..3]
  │   │   └── ZoomWrapper
  │   │       ├── <canvas>
  │   │       └── BboxOverlay (interactive)
  │   ├── NavButtons (Prev/Next)
  │   └── DotIndicator
  ├── DetectionList                # 双方向ハイライト
  └── UpscaleControl               # HD button + progress
```

### Hooks

| Hook | 責務 |
|------|------|
| `useCarouselState` | viewMode, activePanel, navigation, breadcrumb |
| `useZoomPan` | zoom level, translate, drag handlers, rubber band |
| `useUpscaler` | TF.js model load, upscale queue, cancel, cache |
| `useDetectionHighlight` | hoveredDetId, zoomedDetId, 双方向同期 |

### State Flow

```
DetectionList click
  → useDetectionHighlight.highlight(detId)
  → useCarouselState.scrollToPanel(panelOf(det))
  → useZoomPan.zoomToBbox(det)
  → BboxOverlay re-renders (.highlighted / .dimmed)
  → DetectionList item re-renders (.highlighted)
```

### Key Differences from Demo

| Aspect | Demo | Production |
|--------|------|-----------|
| State | グローバル変数 + 手動sync | useState/useReducer |
| DOM | querySelector + addEventListener | JSX + virtual DOM |
| Bbox rendering | innerHTML / appendChild | Preact render |
| Canvas | 直接操作 | ref + useEffect |
| CSS | inline `<style>` | CSS modules or album.css 拡張 |
| Detection data | MOCK_DETECTIONS | `GET /api/detections/{photoId}` (実API) |

## Mock → Real Data Migration

デモの `MOCK_DETECTIONS` は既存API `GET /api/detections/{photoId}` で完全に置き換え可能。
レスポンス型 `Detection` にはすべての必要フィールドがある:

```typescript
type Detection = {
  id: number;
  photo_id: number;
  bbox_x, bbox_y, bbox_w, bbox_h: number;  // comic-space coordinates
  yolo_class: string | null;
  pet_class: string | null;
  pet_id_override: string | null;
  confidence: number | null;
  panel_index: number | null;
};
```

## CSS Porting Strategy

1. **コミックビュー bbox**: 現行 `album.css` の `.glass-bbox` + `.glass-shine` をそのまま使用
2. **カルーセルビュー bbox**: carousel demo の `.bbox-overlay .bbox` スタイルを `album.css` に追加
3. **新規CSS**: zoom-wrapper, carousel scroll-snap, nav buttons, dot indicator, HD button, progress bar
4. **共通化**: `.pill.dl` (download), `.det-conf-bar` (confidence bar) を既存 pill システムに統合

## TF.js Model Hosting (Production)

デモは `/tmp/esrgan-models/` からserveしているが、本番では:

1. **初回起動時**: サーバーがモデルを `/data/esrgan-models/` にダウンロード (または artifact に同梱)
2. **API**: 既存 `GET /api/models/tfjs/{model}/{file}` をそのまま使用
3. **Cache**: `Cache-Control: public, max-age=31536000, immutable` (既存)
4. **Fallback**: モデルがない場合は upscale 機能を非表示

## Implementation Order

1. `CarouselView` + `ComicView` コンポーネント分離
2. `useCarouselState` hook (viewMode 切り替え、パネルナビ)
3. `BboxOverlay` コンポーネント (コミック用 + パネル用)
4. `useDetectionHighlight` hook (双方向ハイライト)
5. `DetectionList` にconfidence bar + クリックハンドラ追加
6. `useZoomPan` hook (zoom-to-bbox + drag-to-pan)
7. `useUpscaler` hook (TF.js統合)
8. Download button + Share link
