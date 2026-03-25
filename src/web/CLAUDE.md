# web — Preact Frontend SPA

## Overview
Preact SPAによるモニターUI。映像表示、YOLO検出オーバーレイ、録画制御、アルバム。

## Build
```bash
cd src/web && bun install && bun run build
```

## Structure

### Components
- `src/app.tsx` — Root application component (state管理, ルーティング)
- `src/components/VideoPlayer.tsx` — WebRTC/MJPEGビデオプレーヤー
- `src/components/BBoxOverlay.tsx` — Canvas検出バウンディングボックスオーバーレイ
- `src/components/VideoControls.tsx` — WebRTC/MJPEG切替 + 録画ボタン
- `src/components/Sidebar.tsx` — 軌跡キャンバス + アルバムギャラリー
- `src/components/MobileTabBar.tsx` — モバイル向けタブナビゲーション
- `src/components/RecordingsModal.tsx` — 録画一覧モーダル

### Hooks
- `src/hooks/useWebRTC.ts` — WebRTCピア接続管理
- `src/hooks/useSSE.ts` — Server-Sent Events (検出データ/ヒートマップ)
- `src/hooks/useRecording.ts` — 録画制御フック (start/stop/heartbeat/auto-download)

### Libs
- `src/lib/protobuf.ts` — Protobufデコード (検出データ)
- `src/lib/detection-classes.ts` — YOLOクラス名マッピング

## Album
AI Pyramid iframe配信で実装済み。`src/components/Sidebar.tsx` 内のアルバムセクションから表示。
