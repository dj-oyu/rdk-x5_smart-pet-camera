# streaming_server — Go WebRTC/MJPEG Server

## Overview
Self-contained WebRTC (pion/dtls only) + MJPEG。H.265パススルー配信、録画、comic自動生成。
pion/webrtc は排除済み。SDP/ICE-lite/SRTP/RTP は自前実装。

## Build & Test
```bash
cd src/streaming_server
go build ./cmd/server && go build ./cmd/web_monitor
go test ./...
```

## Architecture
- **:8081** HTTP (WebRTC signaling, streaming)
- **:8080** web_monitor (MJPEG, REST API, Preact SPA)
- **:6060** pprof, **:9090** metrics
- SRTP: software AES-128-CTR + HMAC-SHA1 (AF_ALG は検証済みだが TE overhead で不採用。`docs/optee-afalg-findings.md`)

## Key Details
- VPS/SPS/PPS caching for mid-stream client joins (H.265)
- Per-client Payload Type negotiation (Safari PT=35, Chrome PT=49)
- Recording: H.265 NAL → .hevc → ffmpeg `-f hevc -c copy` → .mp4
- ICE-full mode (MAP-E NAT 穴あけ): `PET_CAMERA_ENABLE_ICE_FULL=1`
- IPv6 host candidates (5G 直通): `PET_CAMERA_ENABLE_IPV6_CANDIDATES=1`
- IPv6 source-pin: `sessionconn.go` — IPV6_PKTINFO で送信元を mngtmpaddr に固定

## Known Issues (要対応)
- 現時点で未対応のレビュー指摘なし。

> WebRTC レビュー指摘 10 件 (ICE 認証・DTLS fingerprint 照合・recorderChan drain・
> RTP タイムスタンプ 90kHz 化・H265 regex の case-insensitive 化・MaxClients TOCTOU・
> per-session SSRC・a=rtcp 行・keepalive 45s・body サイズ制限) は
> #215 (cdd49cd) ですべて解決済み。

## Docs
→ `docs/streaming-server.md`, `docs/recording-design.md`, `docs/performance.md`
