# streaming_server — Go WebRTC/MJPEG Server

## Overview
Go (pion/webrtc v4) によるWebRTC H.265パススルー配信、MJPEG配信、録画、comic自動生成。

## Build & Test
```bash
cd src/streaming_server
go build -o server ./cmd/server
go build -o web_monitor ./cmd/web_monitor
go test ./...
```

## Architecture
- **:8081** HTTP (WebRTC signaling, streaming)
- **:8080** web_monitor (MJPEG, REST API, Preact SPA)
- **4+N goroutines**: SHM reader, processor, WebRTC fan-out, recorder + per-client

## Key Details
- VPS/SPS/PPS caching for mid-stream client joins (H.265)
- Camera switch warmup: 15 frames (guarantee keyframe, GOP=14)
- Channel buffers: process=30, webrtc=30, recorder=60
- Comic capture: 5s detection → 4-panel 400x225 (16:9), rate limit 3/5min
- Recording: H.265 NAL → .hevc → ffmpeg `-f hevc -c copy` → .mp4, heartbeat 3s timeout, max 30min

## Docs
→ `docs/streaming-server.md`, `docs/recording-design.md`, `docs/pet-album-spec-DRAFT.md`
