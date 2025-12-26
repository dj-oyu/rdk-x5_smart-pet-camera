# Go Streaming Server

H.264 WebRTC streaming and recording server with zero-copy passthrough.

## Features

- **H.264 Passthrough**: Direct H.264 NAL unit streaming without decode/re-encode
- **WebRTC Support**: Real-time streaming to multiple browser clients using pion/webrtc
- **Recording**: H.264 file recording with automatic SPS/PPS header injection
- **Shared Memory**: cgo-based integration with camera daemon via POSIX shared memory
- **Monitoring**: Prometheus metrics and pprof profiling
- **Goroutine Concurrency**: Parallel processing with 4+N goroutines (N = WebRTC clients)

## Architecture

```
Camera Daemon (C) → Shared Memory → Go Streaming Server
                                    ├─ WebRTC (Browser)
                                    └─ H.264 Recording
```

### Components

1. **Shared Memory Reader** (`internal/shm`): cgo wrapper for POSIX shared memory access
2. **H.264 Processor** (`internal/h264`): NAL unit parsing, SPS/PPS caching, IDR detection
3. **WebRTC Server** (`internal/webrtc`): pion/webrtc-based signaling and streaming
4. **Recorder** (`internal/recorder`): H.264 file recording with header injection
5. **Metrics** (`internal/metrics`): Prometheus metrics collection

### Goroutine Design

- **Reader**: Polls shared memory for new H.264 frames (10ms interval)
- **Processor**: Parses NAL units, caches SPS/PPS, prepends headers to IDR frames
- **WebRTC Distributor**: Fan-out pattern to N WebRTC clients (parallel send)
- **Recorder Distributor**: Sends frames to file recorder

## Build

```bash
# From project root
cd src/streaming_server

# Build
go build -o ../../build/streaming-server ./cmd/server

# Or use make from project root
make build-go
```

## Run

```bash
# Start server with default settings
./build/streaming-server

# Custom settings
./build/streaming-server \
  -shm /pet_camera_stream \
  -http :8081 \
  -metrics :9090 \
  -pprof :6060 \
  -record-path ./recordings \
  -max-clients 10
```

## API Endpoints

### WebRTC Signaling

**POST /offer** - Handle WebRTC SDP offer

```bash
curl -X POST http://localhost:8081/offer \
  -H "Content-Type: application/json" \
  -d '{"type":"offer","sdp":"..."}'
```

### Recording Control

**POST /start** - Start recording

```bash
curl -X POST http://localhost:8081/start
```

**POST /stop** - Stop recording

```bash
curl -X POST http://localhost:8081/stop
```

**GET /status** - Get recording status

```bash
curl http://localhost:8081/status
```

Response:
```json
{
  "recording": true,
  "filename": "recording_20251226_223031.h264",
  "frame_count": 1500,
  "bytes_written": 2457600,
  "duration_ms": 50000,
  "start_time": "2025-12-26T22:30:31Z"
}
```

### Health Check

**GET /health** - Server health status

```bash
curl http://localhost:8081/health
```

## Monitoring

### Prometheus Metrics

Access metrics at `http://localhost:9090/metrics`

Key metrics:
- `streaming_frames_read_total` - Total frames read from shared memory
- `streaming_frames_processed_total` - Total frames processed
- `streaming_webrtc_frames_sent_total` - Total frames sent to WebRTC
- `streaming_active_clients` - Active WebRTC clients
- `streaming_recording_active` - Recording status (0/1)
- `streaming_frame_latency_ms` - Frame latency
- `streaming_webrtc_buffer_usage_percent` - Buffer usage

### pprof Profiling

Access profiling at `http://localhost:6060/debug/pprof/`

```bash
# CPU profile (30 seconds)
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Memory profile
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutine profile
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

## Integration with Flask

The Go server is designed to work alongside the Flask web monitor:

- **Flask** (port 8080): UI serving, API proxy, BBox SSE
- **Go** (port 8081): WebRTC signaling, H.264 recording

Flask proxies recording control requests to Go server. See `docs/flask_go_integration_design.md` for details.

## Performance

Expected performance (compared to Python aiortc):

- **Memory**: <20MB (vs 110MB Python)
- **CPU**: <10% (vs 25% Python)
- **Latency**: <100ms (vs 150-200ms Python)
- **Throughput**: 30fps sustained with 5+ concurrent clients

## Development

### Directory Structure

```
src/streaming_server/
├── cmd/
│   └── server/          # Main server entry point
│       └── main.go
├── internal/
│   ├── shm/            # Shared memory reader (cgo)
│   │   └── reader.go
│   ├── h264/           # H.264 NAL processor
│   │   └── processor.go
│   ├── webrtc/         # WebRTC server (pion)
│   │   └── server.go
│   ├── recorder/       # H.264 file recorder
│   │   └── recorder.go
│   └── metrics/        # Prometheus metrics
│       └── metrics.go
├── pkg/
│   └── types/          # Shared types
│       └── frame.go
├── go.mod
├── go.sum
└── README.md
```

### Adding Features

1. Add new goroutine in `cmd/server/main.go`
2. Implement component in `internal/`
3. Add metrics in `internal/metrics/metrics.go`
4. Update routes in `setupRoutes()`

## Design Documents

Detailed design documentation:

- `docs/go_streaming_server_design.md` - Overall architecture and component design
- `docs/go_concurrency_design.md` - Goroutine parallelization and data flow
- `docs/flask_go_integration_design.md` - Flask-Go integration pattern

## License

See LICENSE file in project root.
