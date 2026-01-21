# Web Monitor API Documentation

Go-based web monitor server for smart pet camera streaming and detection.

**Base URL**: `http://localhost:8080` (configurable via `-addr` flag)

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Video Streaming APIs](#video-streaming-apis)
4. [Detection APIs](#detection-apis)
5. [Status & Monitoring APIs](#status--monitoring-apis)
6. [Recording APIs](#recording-apis)
7. [WebRTC APIs](#webrtc-apis)
8. [Protobuf Support](#protobuf-support)
9. [Error Handling](#error-handling)

---

## Overview

The web monitor provides real-time video streaming, object detection events, and system status monitoring via HTTP/SSE APIs. Key features:

- **Event-Driven SSE**: Detections pushed only when changed (not polling)
- **Multi-Format Support**: JSON (default) and Protocol Buffers (opt-in via `Accept` header)
- **Zero-Copy Architecture**: Direct shared memory access for low latency
- **MJPEG Streaming**: Hardware-accelerated video with bounding box overlay

---

## Authentication

Currently **no authentication** is required. All endpoints are publicly accessible.

> ⚠️ **Security Notice**: This server is designed for local network use. Do not expose to the internet without adding authentication.

---

## Video Streaming APIs

### GET /stream

MJPEG stream with bounding box overlay.

**Response Headers**:
- `Content-Type: multipart/x-mixed-replace; boundary=frame`
- `Cache-Control: no-cache`

**Response Body**: Continuous MJPEG stream with multipart frames.

**Example**:
```bash
curl http://localhost:8080/stream --output stream.mjpeg
```

**Client Example (HTML)**:
```html
<img src="http://localhost:8080/stream" alt="Live Stream">
```

**Features**:
- Real-time bounding box overlay
- Frame metadata (timestamp, frame number)
- Hardware-accelerated JPEG encoding
- Automatic client fanout (multiple viewers supported)

---

## Detection APIs

### GET /api/detections/stream

**✨ Event-Driven SSE Stream (Optimized)**

Real-time object detection events. Events are pushed **only when objects are detected**.

**Query Parameters**:
- `?format=protobuf` - Protocol Buffers format (base64-encoded, 60-80% smaller)
- (default) - JSON format

**Request Headers** (alternative):
- `Accept: application/protobuf` - Protocol Buffers format
- `Accept: application/json` - JSON format (default)

**Response Headers**:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `X-Content-Format: application/json` or `application/protobuf`

**Event-Driven Behavior**:
- Events pushed **only when objects are detected** (no empty frames)
- Synchronized with YOLO detector via semaphore notification
- Typical rate: 0-5 events/sec (only when detections exist)
- Keepalive comment every 30 seconds (connection health)

**JSON Response Format**:
```json
data: {
  "frame_number": 12345,
  "timestamp": 1735470123.456,
  "detections": [
    {
      "bbox": {"x": 100, "y": 150, "w": 80, "h": 120},
      "confidence": 0.95,
      "class_id": 0,
      "label": "cat"
    }
  ]
}
```

**Protocol Buffers Response Format**:
```
data: <base64-encoded protobuf binary>
```

See [Protobuf Support](#protobuf-support) for schema details.

**Example (JSON - default)**:
```bash
curl -N http://localhost:8080/api/detections/stream
```

**Example (Protobuf - query parameter)**:
```bash
curl -N "http://localhost:8080/api/detections/stream?format=protobuf"
```

**JavaScript Client Example**:
```javascript
// JSON (default)
const eventSource = new EventSource('/api/detections/stream');
eventSource.onmessage = (event) => {
  const detection = JSON.parse(event.data);
  console.log('Detections:', detection.detections);
};

// Protobuf (query parameter, works with EventSource)
const eventSourcePb = new EventSource('/api/detections/stream?format=protobuf');
eventSourcePb.onmessage = (event) => {
  const bytes = base64ToBytes(event.data);
  const detection = decodeDetectionEvent(bytes);
  console.log('Detections:', detection.detections);
};
```

**Performance Comparison**:

| Metric | Before (Polling) | After (Event-Driven) | Improvement |
|--------|-----------------|---------------------|-------------|
| SSE Push Rate | 30 events/sec | 0-5 events/sec | 70-90% reduction |
| Bandwidth (JSON) | ~30 KB/sec | ~1-5 KB/sec | 70-90% reduction |
| Bandwidth (Protobuf) | N/A | ~0.4-2 KB/sec | 60% additional reduction |
| Client CPU | Constant parsing | Parse only on change | ~90% reduction |

---

## Status & Monitoring APIs

### GET /api/status

Snapshot of current system status.

**Response**:
```json
{
  "monitor": {
    "frames_processed": 12345,
    "current_fps": 30.0,
    "detection_count": 2,
    "target_fps": 30
  },
  "shared_memory": {
    "frame_count": 30,
    "total_frames_written": 12345,
    "detection_version": 456,
    "has_detection": 1
  },
  "latest_detection": {
    "frame_number": 12345,
    "timestamp": 1735470123.456,
    "num_detections": 2,
    "detections": [...]
  },
  "detection_history": [...],
  "timestamp": 1735470123.456
}
```

**Example**:
```bash
curl http://localhost:8080/api/status | jq
```

---

### GET /api/status/stream

**✨ Event-Driven SSE Stream with Protobuf Support**

SSE stream of status updates (broadcast every 2 seconds, fan-out architecture).

**Query Parameters**:
- `?format=protobuf` - Protocol Buffers format (base64-encoded, 60-80% smaller)
- (default) - JSON format

**Request Headers** (alternative):
- `Accept: application/protobuf` - Protocol Buffers format
- `Accept: application/json` - JSON format (default)

**Response Headers**:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `X-Content-Format: application/json` or `application/protobuf`

**Architecture**:
- Single-source broadcast: All clients receive from a shared broadcaster
- Proper client disconnect handling: Resources freed when clients leave
- Non-blocking: Slow clients skip updates without blocking others

**Response Format**: Same as `/api/status`, sent every 2 seconds.

**Example (JSON - default)**:
```bash
curl -N http://localhost:8080/api/status/stream
```

**Example (Protobuf - query parameter)**:
```bash
curl -N "http://localhost:8080/api/status/stream?format=protobuf"
```

**JavaScript Example (JSON)**:
```javascript
const eventSource = new EventSource('/api/status/stream');
eventSource.onmessage = (event) => {
  const status = JSON.parse(event.data);
  console.log('FPS:', status.monitor.current_fps);
};
```

**JavaScript Example (Protobuf)**:
```javascript
const eventSource = new EventSource('/api/status/stream?format=protobuf');
eventSource.onmessage = (event) => {
  const bytes = base64ToBytes(event.data);
  const status = decodeStatusEvent(bytes);
  console.log('FPS:', status.monitor.current_fps);
};
```

---

### GET /api/camera_status

Camera and monitor status information.

**Response**:
```json
{
  "camera": {"mode": "unavailable"},
  "monitor": {
    "frames_processed": 12345,
    "current_fps": 30.0,
    "detection_count": 2,
    "target_fps": 30
  },
  "shared_memory": {
    "frame_count": 30,
    "total_frames_written": 12345,
    "detection_version": 456,
    "has_detection": 1
  }
}
```

---

### POST /api/debug/switch-camera

Camera switching endpoint (currently not implemented).

**Response** (400):
```json
{
  "error": "switch controller is not configured"
}
```

---

## Recording APIs

### POST /api/recording/start

Start H.264 recording to file.

**Response** (200):
```json
{
  "status": "recording",
  "file": "recording_20251229_161234.h264",
  "started_at": 1735470154.0
}
```

**Response** (400):
```json
{
  "error": "Recording already in progress"
}
```

**Example**:
```bash
curl -X POST http://localhost:8080/api/recording/start
```

---

### POST /api/recording/stop

Stop current recording.

**Response** (200):
```json
{
  "status": "stopped",
  "file": "recording_20251229_161234.h264",
  "stats": {
    "recording": false,
    "filename": "",
    "frame_count": 0,
    "bytes_written": 0,
    "duration_ms": 0,
    "start_time": null
  },
  "stopped_at": 1735470234.0
}
```

**Response** (400):
```json
{
  "error": "No recording in progress"
}
```

**Example**:
```bash
curl -X POST http://localhost:8080/api/recording/stop
```

---

### GET /api/recording/status

Get current recording status.

**Response**:
```json
{
  "recording": true,
  "filename": "recording_20251229_161234.h264",
  "frame_count": 1500,
  "bytes_written": 2457600,
  "duration_ms": 50000,
  "start_time": "2025-12-29T16:12:34Z"
}
```

**Example**:
```bash
curl http://localhost:8080/api/recording/status
```

---

## WebRTC APIs

### POST /api/webrtc/offer

WebRTC SDP offer/answer exchange for real-time streaming.

**Request Headers**:
- `Content-Type: application/json`

**Request Body**:
```json
{
  "type": "offer",
  "sdp": "v=0\r\no=- 123456789 2 IN IP4 127.0.0.1\r\n..."
}
```

**Response**:
```json
{
  "type": "answer",
  "sdp": "v=0\r\no=- 987654321 2 IN IP4 127.0.0.1\r\n..."
}
```

**Response** (502):
```json
{
  "error": "Go server unavailable"
}
```

**Example**:
```bash
curl -X POST http://localhost:8080/api/webrtc/offer \
  -H "Content-Type: application/json" \
  -d '{"type":"offer","sdp":"..."}'
```

**Notes**:
- This endpoint proxies to the Go streaming server (default: `http://localhost:8081/offer`)
- Requires WebRTC-compatible client (browser with RTCPeerConnection API)

---

## Protobuf Support

The detection stream supports Protocol Buffers for efficient binary serialization.

### Schema

**File**: `proto/detection.proto`

```protobuf
syntax = "proto3";

package petcamera;

message BBox {
    int32 x = 1;
    int32 y = 2;
    int32 w = 3;
    int32 h = 4;
}

message Detection {
    BBox bbox = 1;
    float confidence = 2;
    int32 class_id = 3;
    string label = 4;
}

message DetectionEvent {
    uint64 frame_number = 1;
    double timestamp = 2;
    repeated Detection detections = 3;
}

// Status stream messages

message MonitorStats {
    int32 frames_processed = 1;
    double current_fps = 2;
    int32 detection_count = 3;
    int32 target_fps = 4;
}

message SharedMemoryStats {
    int32 frame_count = 1;
    int32 total_frames_written = 2;
    int32 detection_version = 3;
    int32 has_detection = 4;
}

message DetectionResult {
    uint64 frame_number = 1;
    double timestamp = 2;
    int32 num_detections = 3;
    int32 version = 4;
    repeated Detection detections = 5;
}

message StatusEvent {
    MonitorStats monitor = 1;
    SharedMemoryStats shared_memory = 2;
    DetectionResult latest_detection = 3;
    repeated DetectionEvent detection_history = 4;
    double timestamp = 5;
}
```

### Using Protobuf

**1. Generate Code**

For Go:
```bash
protoc --go_out=. --go_opt=module=github.com/dj-oyu/rdk-x5_smart-pet-camera/streaming-server \
  proto/detection.proto
```

For JavaScript (with protobuf.js):
```bash
pbjs -t static-module -w commonjs -o detection.js proto/detection.proto
pbts -o detection.d.ts detection.js
```

For Python:
```bash
protoc --python_out=. proto/detection.proto
```

**2. Content Negotiation**

Set the `Accept` header to request Protobuf format:

```bash
curl -N -H "Accept: application/protobuf" \
  http://localhost:8080/api/detections/stream
```

**3. Decoding (JavaScript)**

```javascript
import { DetectionEvent } from './detection';

const eventSource = new EventSource('/api/detections/stream');
eventSource.onmessage = (event) => {
  // Base64 decode
  const binaryString = atob(event.data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Decode Protobuf
  const detection = DetectionEvent.decode(bytes);
  console.log('Frame:', detection.frameNumber);
  console.log('Detections:', detection.detections);
};
```

**4. Decoding (Python)**

```python
import base64
from detection_pb2 import DetectionEvent

# Assuming you receive SSE data as 'sse_data'
binary_data = base64.b64decode(sse_data)
event = DetectionEvent()
event.ParseFromString(binary_data)

print(f"Frame: {event.frame_number}")
for det in event.detections:
    print(f"  {det.label}: {det.confidence:.2f}")
```

### Bandwidth Savings

| Format | Typical Size | Bandwidth (5 events/sec) |
|--------|--------------|-------------------------|
| JSON | ~1000 bytes | ~5 KB/sec |
| Protobuf | ~200-400 bytes | ~1-2 KB/sec |
| **Savings** | **60-80%** | **60-80%** |

---

## Error Handling

### HTTP Status Codes

- `200 OK` - Request successful
- `400 Bad Request` - Invalid request parameters
- `405 Method Not Allowed` - Wrong HTTP method
- `500 Internal Server Error` - Server error
- `502 Bad Gateway` - Upstream service (Go server) unavailable

### Error Response Format

```json
{
  "error": "Error message description"
}
```

### Common Errors

**Recording Already Active**:
```json
{
  "error": "Recording already in progress"
}
```

**No Recording Active**:
```json
{
  "error": "No recording in progress"
}
```

**WebRTC Server Unavailable**:
```json
{
  "error": "Go server unavailable"
}
```

**Invalid Offer Data**:
```json
{
  "error": "Invalid offer data"
}
```

---

## Configuration

Server configuration via command-line flags:

```bash
go run cmd/webmonitor/main.go \
  -addr :8080 \
  -frame-shm /pet_camera_mjpeg_frame \
  -detection-shm /pet_camera_detections \
  -webrtc-url http://localhost:8081 \
  -target-fps 30 \
  -status-interval 2s \
  -detection-interval 33ms
```

**Flags**:
- `-addr`: HTTP server address (default: `:8080`)
- `-frame-shm`: Frame shared memory name (default: `/pet_camera_mjpeg_frame`)
- `-detection-shm`: Detection shared memory name (default: `/pet_camera_detections`)
- `-webrtc-url`: WebRTC server base URL (default: `http://localhost:8081`)
- `-target-fps`: Target FPS for monitoring (default: `30`)
- `-status-interval`: Status stream interval (default: `2s`)
- `-detection-interval`: Detection stream interval (default: `33ms`, **unused in event-driven mode**)

---

## Architecture Notes

### Event-Driven Detection Stream

The detection stream uses a semaphore-based event notification system:

1. **Python Detection Daemon** writes detection to shared memory
2. **Semaphore Post** (`sem_post`) signals new detection
3. **Go DetectionBroadcaster** wakes from `sem_wait`
4. **Immediate Broadcast** to all subscribed SSE clients
5. **Client Receives** event within 0-5ms

This replaces the previous polling approach (33ms ticker checking for changes).

### Zero-Copy Architecture

Frame data is accessed directly from shared memory without copying:
- Camera daemon writes to `/dev/shm/pet_camera_mjpeg_frame`
- Go server maps shared memory read-only
- JPEG frames served with true zero-copy (NV12 frames overlaid in-place)

### Multi-Client Fanout

Both MJPEG and detection streams use a broadcaster pattern:
- Single source reads from shared memory
- Multiple clients subscribe via channels
- Non-blocking send (slow clients skip frames/events)
- Automatic cleanup on client disconnect

---

## Future Enhancements

### MQTT Support (Planned)

The Protobuf-based architecture is designed for future MQTT integration:

```
DetectionBroadcaster (Go)
    ├─ SSE Clients (JSON/Protobuf)
    └─ MQTT Publisher (Protobuf)
            ↓
        MQTT Broker
            ↓
        IoT Devices
```

**Benefits**:
- Efficient binary format for constrained networks
- QoS levels for reliable delivery
- Retain last detection for late-joining subscribers
- Unified internal format (Protobuf) for all transports

---

## Support

For issues or questions:
- GitHub Issues: [https://github.com/dj-oyu/rdk-x5_smart-pet-camera/issues](https://github.com/)
- Documentation: See `docs/` directory in project root

---

**Last Updated**: 2026-01-21
**Version**: 1.1.0 (Status Stream Protobuf + Fan-out Architecture)
