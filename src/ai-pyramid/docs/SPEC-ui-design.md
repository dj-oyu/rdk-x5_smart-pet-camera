# SPEC: UI Design System

## Overview

carousel demo で確立したデザイン言語を本番 Preact SPA に統合する。
glassmorphism ベースの一貫したビジュアルシステム。

## Design Tokens

### Colors

```css
/* Background */
--bg-backdrop: rgba(15, 23, 42, 0.6);  /* dark navy, blurred */
--bg-modal: rgba(255, 255, 255, 0.92); /* frosted white */
--bg-card: #ffffff;

/* Text */
--text-primary: #1e293b;
--text-secondary: #64748b;
--text-light: #e2e8f0;

/* Accent */
--accent: #3b82f6;
--accent-hover: #2563eb;
--accent-soft: rgba(59, 130, 246, 0.08);

/* Status */
--status-ok: #4ade80;
--status-warn: #fbbf24;
--status-error: #f87171;

/* Detection classes */
--det-cat: #6EFF9E;
--det-dog: #FFC878;
--det-bird: #A0DCFF;
--det-food-bowl: #78C8FF;
--det-water-bowl: #FF8C8C;
--det-person: #FFF08C;
```

### Glass Effects

| Level | Use | Properties |
|-------|-----|-----------|
| Heavy | モーダル背景 | `backdrop-filter: blur(18px)` + `bg-modal` |
| Medium | ナビボタン、コントロール | `backdrop-filter: blur(8px)` + `rgba(255,255,255,0.75)` |
| Light | Bbox overlay | `backdrop-filter: blur(2px)` + `rgba(255,255,255,0.04)` |
| None | コミック bbox (サブ) | border + box-shadow のみ |

### Bbox Styles

#### Production Glass Bbox (event-detail.tsx 現行)

モーダル内の詳細ビュー用。回転 shine アニメーション付き。

```css
.glass-bbox {
  border: 1px solid rgba(255,255,255,0.25);
  border-top-color: rgba(255,255,255,0.45);
  border-left-color: rgba(255,255,255,0.35);
  border-radius: 4px;
  backdrop-filter: blur(2px);
  background: rgba(255,255,255,0.04);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.2),
    inset 1px 0 0 rgba(255,255,255,0.1),
    0 0 6px rgba(255,255,255,0.06);
  /* vignette mask */
  mask-image: linear-gradient(...);
}

.glass-shine {
  width: 20px; height: 20px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,0.45) 0%, transparent 70%);
  animation: shine-travel 4s linear infinite;
  offset-path: path("M 0,0 L W,0 L W,H L 0,H Z");
}
```

特徴:
- ラベルなし
- offset-path で外周を巡回する光点 (2つ、2秒ずらし)
- ビネットマスクで中央が透明、エッジが不透明
- `pointer-events: none` (コミック全体表示時)

#### Carousel Interactive Bbox (パネル詳細ビュー)

パネル拡大時のインタラクティブ bbox。ラベル付き、ズーム対応。

```css
.bbox {
  border: 1.5px solid rgba(255,255,255,0.45);
  border-radius: 3px;
  background: rgba(255,255,255,0.06);
  box-shadow: 0 0 6px rgba(255,255,255,0.12),
              inset 0 1px 0 rgba(255,255,255,0.12);
  pointer-events: auto;
  cursor: pointer;
}

.bbox .bbox-label {
  position: absolute;
  top: -1px; left: -1px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 3px 0 3px 0;
  color: #fff;
  background: var(--det-class-color);
}

.bbox.highlighted {
  border-color: rgba(255,255,255,0.7);
  box-shadow: 0 0 14px rgba(255,255,255,0.3);
  z-index: 10;
}

.bbox.dimmed { opacity: 0.18; }
```

特徴:
- ラベルあり (pet_id or yolo_class)
- hover/click でハイライト/ディム
- クリックで zoom-to-bbox

### Typography

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

| Use | Size | Weight |
|-----|------|--------|
| モーダルタイトル | 15px | 600 |
| Detection class | 13px | 500 |
| Bbox label | 10px | 600 |
| Confidence % | 11px | 400 |
| Pill | 11px | 600, letter-spacing: 0.3px |
| Status bar | 11px | 500 |
| Caption | 13px | 400 |

### Pill System

```css
.pill {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.pill.pet   { background: #dbeafe; color: #1e40af; }
.pill.valid { background: #dcfce7; color: #166534; }
.pill.time  { color: #64748b; }
.pill.dl    { background: var(--accent-soft); color: var(--accent); cursor: pointer; }
```

### Animations

| Name | Duration | Easing | Use |
|------|----------|--------|-----|
| modal-enter | 160ms | ease-out | モーダル表示 |
| shine-travel | 4s | linear, infinite | bbox 光点回転 |
| zoom | 300ms | cubic-bezier(0.25, 1, 0.5, 1) | bbox ズーム |
| bbox-pulse | 1.2s | ease-in-out, infinite | ハイライト bbox |
| highlight | 150ms | ease | detection list 背景 |

### Zoom & Pan

```css
.zoom-wrapper {
  transform-origin: 0 0;
  transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1);
  will-change: transform;
}
```

- Zoom range: 1.8x - 3.5x (bbox サイズに応じて自動計算)
- Edge clamping: `tx ∈ [displayW*(1-zoom), 0]`, `ty ∈ [displayH*(1-zoom), 0]`
- Rubber band: `RUBBER_MAX * (1 - exp(-over / (RUBBER_MAX * 3)))`, max 40px

## Responsive Breakpoints

| Width | Layout |
|-------|--------|
| < 480px | カード幅 100vw、フルスクリーン感 |
| 480-880px | カード幅 min(96vw, 880px) |
| > 880px | 固定幅 880px、中央寄せ |

## Accessibility Notes (将来対応)

- ARIA landmarks: `role="region"` on carousel
- Focus indicators on interactive bbox
- Reduced motion: `@media (prefers-reduced-motion)` で shine/pulse を無効化
- Alt text: 画像にVLMキャプションを設定
