# Go Streaming Server

High-performance streaming, monitoring, and recording servers for smart pet camera.

## Overview

This package provides two complementary Go servers:

1. **Web Monitor Server** (`cmd/webmonitor`) - MJPEG streaming, detection events, system monitoring
2. **WebRTC Server** (`cmd/server`) - H.264 WebRTC streaming and recording

## Features

### Web Monitor Server (Port 8080)
- **Event-Driven SSE**: Detection events pushed only when changed (not polling)
- **Protocol Buffers**: Optional binary format for 60-80% bandwidth reduction
- **MJPEG Streaming**: Hardware-accelerated video with bounding box overlay
- **Zero-Copy Architecture**: Direct shared memory access for low latency
- **Multi-Client Fanout**: Efficient broadcast to multiple clients
- **Multi-Format Support**: JSON (default) and Protobuf (opt-in via Accept header)

### WebRTC Server (Port 8081)
- **H.264 Passthrough**: Direct H.264 NAL unit streaming without decode/re-encode
- **WebRTC Support**: Real-time streaming to multiple browser clients using pion/webrtc
- **Recording**: H.264 file recording with automatic SPS/PPS header injection
- **Shared Memory**: cgo-based integration with camera daemon via POSIX shared memory
- **Monitoring**: Prometheus metrics and pprof profiling
- **Goroutine Concurrency**: Parallel processing with 4+N goroutines (N = WebRTC clients)

## Architecture

```
Camera Daemon (C)
    ├─ H.264 Stream SHM ──→ WebRTC Server (Go:8081)
    │                        ├─ WebRTC (Browser)
    │                        └─ H.264 Recording
    │
    ├─ MJPEG Frame SHM ──→ Web Monitor (Go:8080)
    │                       ├─ MJPEG Stream (Browser)
    │                       └─ WebRTC Proxy
    │
    └─ Detection SHM ──────→ Web Monitor (Go:8080)
         (Semaphore-based)   └─ SSE Detections (JSON/Protobuf)
```

### Components

#### Web Monitor Server (`internal/webmonitor`)
1. **DetectionBroadcaster** (`broadcaster.go`): Event-driven fanout for detection events with Protocol Buffers
2. **FrameBroadcaster** (`broadcaster.go`): MJPEG frame fanout to multiple clients
3. **Shared Memory Reader** (`shm.go`): cgo-based POSIX shared memory with semaphore support
4. **Stream Handlers** (`stream.go`): Multi-format SSE streaming (JSON/Protobuf)
5. **Monitor** (`monitor.go`): FPS tracking and detection history

#### WebRTC Server (`internal/webrtc`, `internal/h264`, `internal/recorder`)
1. **Shared Memory Reader** (`internal/shm`): cgo wrapper for POSIX shared memory access
2. **H.264 Processor** (`internal/h264`): NAL unit parsing, SPS/PPS caching, IDR detection
3. **WebRTC Server** (`internal/webrtc`): pion/webrtc-based signaling and streaming
4. **Recorder** (`internal/recorder`): H.264 file recording with header injection
5. **Metrics** (`internal/metrics`): Prometheus metrics collection

### Event-Driven Design

**Detection Stream** (NEW):
- Python daemon posts semaphore (`sem_post`) after writing detection
- Go broadcaster blocks on semaphore wait (`sem_wait`) until signaled
- Immediate wake-up (0-5ms latency) when detection changes
- No polling overhead (previous: 30 checks/sec, now: event-driven)

**WebRTC Stream**:
- Reader polls shared memory for new H.264 frames (10ms interval)
- Processor parses NAL units, caches SPS/PPS, prepends headers to IDR frames
- WebRTC Distributor uses fan-out pattern to N WebRTC clients (parallel send)
- Recorder Distributor sends frames to file recorder

## Quick Start

### Web Monitor Server

```bash
# Build
cd src/streaming_server
go build -o ../../build/webmonitor ./cmd/webmonitor

# Run with defaults
./build/webmonitor

# Custom configuration
./build/webmonitor \
  -addr :8080 \
  -frame-shm /pet_camera_mjpeg_frame \
  -detection-shm /pet_camera_detections \
  -webrtc-url http://localhost:8081 \
  -target-fps 30

# Access endpoints
# - Web UI: http://localhost:8080
# - MJPEG Stream: http://localhost:8080/stream
# - Detection Stream (JSON): http://localhost:8080/api/detections/stream
# - Detection Stream (Protobuf): curl -H "Accept: application/protobuf" http://localhost:8080/api/detections/stream
```

### WebRTC Server

```bash
# Build
cd src/streaming_server
go build -o ../../build/streaming-server ./cmd/server

# Run with defaults
./build/streaming-server

# Custom configuration
./build/streaming-server \
  -shm /pet_camera_stream \
  -http :8081 \
  -metrics :9090 \
  -pprof :6060 \
  -record-path ./recordings \
  -max-clients 10
```

## Build

```bash
# Build both servers from project root
make build-go

# Or build individually
cd src/streaming_server

# Web Monitor
go build -o ../../build/webmonitor ./cmd/webmonitor

# WebRTC Server
go build -o ../../build/streaming-server ./cmd/server
```

## API Endpoints

### Web Monitor Server (Port 8080)

**Comprehensive API documentation**: See [`API.md`](API.md)

**Protocol Buffers guide**: See [`PROTOBUF_GUIDE.md`](PROTOBUF_GUIDE.md)

**Component documentation**: See [`internal/webmonitor/README.md`](internal/webmonitor/README.md)

#### Quick Reference

**GET /stream** - MJPEG stream with bounding box overlay
```bash
# View in browser
open http://localhost:8080/stream

# Download
curl http://localhost:8080/stream --output stream.mjpeg
```

**GET /api/detections/stream** - Event-driven detection stream (SSE)
```bash
# JSON (default)
curl -N http://localhost:8080/api/detections/stream

# Protobuf (60-80% smaller)
curl -N -H "Accept: application/protobuf" \
  http://localhost:8080/api/detections/stream
```

**GET /api/status** - System status snapshot
```bash
curl http://localhost:8080/api/status | jq
```

**GET /api/status/stream** - Status stream (polled every 2 seconds)
```bash
curl -N http://localhost:8080/api/status/stream
```

**POST /api/recording/start** - Start H.264 recording
```bash
curl -X POST http://localhost:8080/api/recording/start
```

**POST /api/recording/stop** - Stop recording
```bash
curl -X POST http://localhost:8080/api/recording/stop
```

---

### WebRTC Server (Port 8081)

**POST /offer** - Handle WebRTC SDP offer

```bash
curl -X POST http://localhost:8081/offer \
  -H "Content-Type: application/json" \
  -d '{"type":"offer","sdp":"..."}'
```

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

**GET /health** - Server health status

```bash
curl http://localhost:8081/health
```

## Performance

### Web Monitor Server

**Bandwidth Comparison** (Detection Stream):

| Metric | Before (Polling) | After (Event-Driven JSON) | After (Event-Driven Protobuf) |
|--------|-----------------|---------------------------|------------------------------|
| Push Rate | 30 events/sec | 0-5 events/sec | 0-5 events/sec |
| Bandwidth | ~30 KB/sec | ~1-5 KB/sec | ~0.4-2 KB/sec |
| CPU Usage | Constant parsing | Event-driven sleep | Event-driven sleep |
| Reduction | - | **70-90%** | **93-96%** (60% additional) |

**Latency**:
- Detection → SSE: 0-5ms (vs 0-33ms polling)
- Client CPU: Parse only on change (~90% reduction)

### WebRTC Server

Expected performance (compared to Python aiortc):

- **Memory**: <20MB (vs 110MB Python)
- **CPU**: <10% (vs 25% Python)
- **Latency**: <100ms (vs 150-200ms Python)
- **Throughput**: 30fps sustained with 5+ concurrent clients

## Monitoring

### Prometheus Metrics (WebRTC Server)

Access metrics at `http://localhost:9090/metrics`

Key metrics:
- `streaming_frames_read_total` - Total frames read from shared memory
- `streaming_frames_processed_total` - Total frames processed
- `streaming_webrtc_frames_sent_total` - Total frames sent to WebRTC
- `streaming_active_clients` - Active WebRTC clients
- `streaming_recording_active` - Recording status (0/1)
- `streaming_frame_latency_ms` - Frame latency
- `streaming_webrtc_buffer_usage_percent` - Buffer usage

### pprof Profiling (WebRTC Server)

Access profiling at `http://localhost:6060/debug/pprof/`

```bash
# CPU profile (30 seconds)
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Memory profile
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutine profile
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

## Integration

### Current Architecture

- **Web Monitor** (Go, port 8080): MJPEG streaming, detection events, system status, recording control
- **WebRTC Server** (Go, port 8081): H.264 WebRTC streaming, recording
- **Camera Daemon** (C): Frame capture, encoding, shared memory management
- **Detection Daemon** (Python): YOLO object detection, semaphore signaling

### Migration from Flask

The Web Monitor Server replaces the Python Flask implementation:

**Removed**:
- ❌ Flask-based HTTP server
- ❌ Python threading for SSE
- ❌ Mock shared memory support

**Improved**:
- ✅ Event-driven SSE (vs polling)
- ✅ Protocol Buffers support
- ✅ 3-5x lower latency
- ✅ 10x lower memory usage
- ✅ Native concurrency (goroutines vs threads)

**Compatible**:
- ✅ Same JSON API format
- ✅ Same shared memory layout
- ✅ Same endpoint paths
- ✅ Same HTML/JS assets

See `docs/flask_go_integration_design.md` for details.

## Development

### Directory Structure

```
src/streaming_server/
├── cmd/
│   ├── webmonitor/              # Web Monitor server (NEW)
│   │   └── main.go              # MJPEG + detection streaming
│   └── server/                  # WebRTC server
│       └── main.go              # H.264 WebRTC + recording
├── internal/
│   ├── webmonitor/              # Web Monitor components (NEW)
│   │   ├── broadcaster.go       # Event-driven fanout (Frame + Detection)
│   │   ├── server.go            # HTTP server and route handlers
│   │   ├── shm.go               # Shared memory + semaphore (cgo)
│   │   ├── stream.go            # Multi-format SSE streaming
│   │   ├── monitor.go           # FPS tracking and detection history
│   │   ├── types.go             # Data structures
│   │   ├── config.go            # Configuration
│   │   ├── drawer.go            # Bounding box drawing
│   │   ├── html.go              # HTML templates
│   │   ├── assets.go            # Static asset handler
│   │   ├── recorder.go          # Recording state management
│   │   └── README.md            # Component documentation
│   ├── shm/                     # WebRTC shared memory reader
│   │   └── reader.go
│   ├── h264/                    # H.264 NAL processor
│   │   └── processor.go
│   ├── webrtc/                  # WebRTC server (pion)
│   │   └── server.go
│   ├── recorder/                # H.264 file recorder
│   │   └── recorder.go
│   └── metrics/                 # Prometheus metrics
│       └── metrics.go
├── proto/                       # Protocol Buffers (NEW)
│   └── detection.proto          # Detection message schema
├── pkg/
│   ├── proto/                   # Generated Protobuf code (NEW)
│   │   └── detection.pb.go
│   └── types/                   # Shared types
│       └── frame.go
├── go.mod
├── go.sum
├── API.md                       # API documentation (NEW)
├── PROTOBUF_GUIDE.md            # Protobuf usage guide (NEW)
└── README.md                    # This file
```

### Protocol Buffers

Generate Go code from `.proto` schema:

```bash
# Install protoc compiler (if needed)
# Debian/Ubuntu: apt-get install -y protobuf-compiler
# macOS: brew install protobuf

# Install Go plugin
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest

# Generate code
cd src/streaming_server
protoc --go_out=. --go_opt=module=github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server \
  proto/detection.proto

# Output: pkg/proto/detection.pb.go
```

### Adding Features

**Web Monitor**:
1. Add route in `internal/webmonitor/server.go`
2. Implement handler in same file
3. Update HTML template if needed in `html.go`
4. Document in `API.md`

**WebRTC Server**:
1. Add new goroutine in `cmd/server/main.go`
2. Implement component in `internal/`
3. Add metrics in `internal/metrics/metrics.go`
4. Update routes in `setupRoutes()`

## Documentation

### API & Usage Guides
- **[API.md](API.md)** - Complete API specification with examples
- **[PROTOBUF_GUIDE.md](PROTOBUF_GUIDE.md)** - Protocol Buffers usage for clients
- **[internal/webmonitor/README.md](internal/webmonitor/README.md)** - Component documentation

### Design Documents
- `docs/go_streaming_server_design.md` - Overall architecture and component design
- `docs/go_concurrency_design.md` - Goroutine parallelization and data flow
- `docs/flask_go_integration_design.md` - Flask-Go integration pattern

## Future Enhancements

### MQTT Support (Planned)

The Protocol Buffers architecture is designed for future MQTT integration:

```
DetectionBroadcaster (Go)
    ├─ SSE Clients (JSON/Protobuf)
    └─ MQTT Publisher (Protobuf) → MQTT Broker → IoT Devices
```

**Benefits**:
- Efficient binary format for constrained networks
- QoS levels for reliable delivery
- Retain last detection for late-joining subscribers
- Standard IoT protocol

## License

See LICENSE file in project root.
