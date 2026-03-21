# web — Preact Frontend SPA

## Overview
Preact SPAによるモニターUI。映像表示、YOLO検出オーバーレイ、録画制御、アルバム。

## Build
```bash
cd src/web && bun install && bun run build
```

## Structure
- `src/components/Sidebar.tsx` — 軌跡キャンバス + アルバムギャラリー
- `src/components/VideoControls.tsx` — WebRTC/MJPEG切替 + 録画ボタン
- `src/components/RecordingsModal.tsx` — 録画一覧モーダル
- `src/hooks/useRecording.ts` — 録画制御フック (start/stop/heartbeat/auto-download)

## Album (Phase 2予定)
現在のアルバムセクションはiframeに置き換え予定 → AI Pyramid配信
