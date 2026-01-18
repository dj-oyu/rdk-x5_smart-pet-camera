# H.264 Hardware Encoding Integration Guide

**Version**: 1.0
**Date**: 2025-12-21
**Author**: Smart Pet Camera Development Team

---

## Table of Contents

1. [Overview](#overview)
2. [Background & Motivation](#background--motivation)
3. [Architecture](#architecture)
4. [Development Principles](#development-principles)
5. [Key APIs & Libraries](#key-apis--libraries)
6. [Implementation Guide](#implementation-guide)
7. [Browser-Side Overlay System](#browser-side-overlay-system)
8. [WebRTC Integration (Phase 2)](#webrtc-integration-phase-2)
9. [Troubleshooting](#troubleshooting)
10. [References](#references)

---

## Overview

This document provides comprehensive guidance for developers working on the H.264 hardware encoding integration for the Smart Pet Camera project. The migration replaces software JPEG encoding with D-Robotics hardware H.264 encoding using the `libspcdev` library.

**Key Goals**:
- Add H.264 file recording capability
- Reduce CPU usage by eliminating software JPEG encoding
- Enable modern streaming with WebRTC
- Implement browser-side overlay for efficiency

---

## Background & Motivation

### Previous Architecture (JPEG-based)

```
Camera → VIN/ISP/VSE (HW) → NV12 Frame → libjpeg (SW) → Shared Memory
                                                            ↓
                                                    WebMonitor (Python)
                                                            ↓
                                            Decode → Draw BBox → Re-encode
                                                            ↓
                                                    MJPEG Stream (HTTP)
```

**Limitations**:
- **High CPU usage**: Software JPEG encoding at 30fps
- **Double encoding**: Decode JPEG → Draw overlay → Re-encode JPEG
- **No recording**: JPEG streams are inefficient for file storage
- **High bandwidth**: JPEG has poor compression vs H.264

### New Architecture (H.264-based)

```
Camera → libspcdev VIO → Hardware H.264 Encoder → Shared Memory (NAL units)
                                                            ↓
                                                    ┌───────┴────────┐
                                                    ↓                ↓
                                            H264Recorder      WebRTC Server
                                                    ↓                ↓
                                            .h264 File      Browser (WebRTC)
                                                                    ↓
                                                            Canvas Overlay
                                                            (Client-side)
```

**Benefits**:
- **Low CPU usage**: Hardware encoding (near-zero CPU load)
- **Recording**: Direct H.264 NAL units to file
- **Better compression**: H.264 achieves 5-10x better compression than JPEG
- **Modern streaming**: WebRTC with <500ms latency
- **Efficient overlay**: Browser-side canvas rendering (no re-encoding)

---

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    HARDWARE LAYER                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────┐                                                │
│  │  Camera 0/1  │                                                │
│  │  (Sensor)    │                                                │
│  └──────┬───────┘                                                │
│         │                                                         │
│         ▼                                                         │
│  ┌─────────────────────────────────────┐                        │
│  │  libspcdev VIO Module               │  ← sp_open_camera_v2() │
│  │  - Video Input/Output               │                        │
│  │  - ISP (Image Signal Processing)    │                        │
│  │  - Scaling                          │                        │
│  └────────────┬────────────────────────┘                        │
│               │ (Zero-copy binding)                             │
│               ▼                                                  │
│  ┌─────────────────────────────────────┐                        │
│  │  Hardware H.264 Encoder             │  ← sp_start_encode()   │
│  │  - D-Robotics video codec           │                        │
│  │  - NAL unit generation              │                        │
│  └────────────┬────────────────────────┘                        │
│               │                                                  │
│               ▼                                                  │
│  ┌─────────────────────────────────────┐                        │
│  │  H.264 NAL Units Stream             │  ← sp_encoder_get_stream() │
│  └────────────┬────────────────────────┘                        │
│               │                                                  │
└───────────────┼──────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SHARED MEMORY (IPC)                           │
├─────────────────────────────────────────────────────────────────┤
│  Frame {                                                         │
│    format: 3 (H264)                                             │
│    data: [NAL units]                                            │
│    frame_number, timestamp, width, height                       │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PYTHON LAYER                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────┐         ┌──────────────────────┐      │
│  │  H264Recorder       │         │  WebRTC Server       │      │
│  │  (h264_recorder.py) │         │  (Phase 2)           │      │
│  └──────┬──────────────┘         └──────┬───────────────┘      │
│         │                                │                       │
│         ▼                                ▼                       │
│  ┌─────────────────┐         ┌──────────────────────────┐      │
│  │ recording.h264  │         │  WebRTC Signaling        │      │
│  │ (VLC playable)  │         │  (SDP offer/answer)      │      │
│  └─────────────────┘         └──────┬───────────────────┘      │
│                                     │                           │
│  ┌──────────────────────────────────┴──────────────┐           │
│  │  Detection Stream (SSE)                         │           │
│  │  /api/detections/stream                         │           │
│  │  → JSON: {detections: [{class, bbox, conf}]}   │           │
│  └──────────────────────────────────┬──────────────┘           │
│                                     │                           │
└─────────────────────────────────────┼───────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER (CLIENT)                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌────────────────────────────────────────────────┐             │
│  │  <video> element (WebRTC stream)               │             │
│  │    └─ RTCPeerConnection                        │             │
│  │       └─ H.264 decoder (browser native)        │             │
│  └────────────────────────────────────────────────┘             │
│                    ↓                                             │
│  ┌────────────────────────────────────────────────┐             │
│  │  <canvas> overlay (positioned absolutely)      │             │
│  │    └─ JavaScript draws bboxes                  │             │
│  │       └─ EventSource(/api/detections/stream)   │             │
│  └────────────────────────────────────────────────┘             │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Development Principles

### 1. **Zero-Copy Philosophy**

Hardware encoding eliminates multiple data copies:
- **Before**: Camera → NV12 → Copy to CPU → JPEG encode → Copy to shared memory
- **After**: Camera → Hardware encoder → DMA to shared memory (zero-copy)

**Implementation**:
- Use `sp_module_bind()` to bind VIO directly to encoder
- Avoid intermediate buffers
- Write NAL units directly to shared memory

### 2. **Separation of Concerns**

- **Encoding**: Hardware responsibility (libspcdev)
- **Overlay**: Browser responsibility (Canvas API)
- **Recording**: Python responsibility (file I/O)
- **Streaming**: WebRTC server responsibility

### 3. **Backward Compatibility**

During transition:
- Support both JPEG (format=0) and H.264 (format=3) in shared memory
- Provide MJPEG fallback for testing
- Use environment variables for feature flags

### 4. **Performance First**

- Minimize CPU usage (target: <30% for entire system)
- Use hardware acceleration wherever possible
- Avoid re-encoding (decode → overlay → re-encode)

### 5. **Simplicity Over Complexity**

- Replace 500+ lines of VIN/ISP/VSE setup with ~100 lines of libspcdev calls
- Use browser-native H.264 decoder (no custom codecs)
- Leverage existing standards (WebRTC, SSE)

---

## Key APIs & Libraries

### libspcdev API Reference

`libspcdev` is D-Robotics' unified codec library providing hardware video encoding/decoding.

#### Core Functions

| Function | Purpose | Parameters |
|----------|---------|------------|
| `sp_init_vio_module()` | Initialize VIO module | Returns: `void*` vio_object |
| `sp_init_encoder_module()` | Initialize encoder module | Returns: `void*` encoder_object |
| `sp_open_camera_v2()` | Open camera with parameters | `vio_object, camera_index, mode, channels, params, &width, &height` |
| `sp_start_encode()` | Start H.264 encoding | `encoder_object, channel, codec_type, width, height, bitrate` |
| `sp_module_bind()` | Bind VIO to encoder (zero-copy) | `vio_object, VIO_TYPE, encoder_object, ENCODER_TYPE` |
| `sp_encoder_get_stream()` | Get encoded NAL units | `encoder_object, buffer` → Returns stream size |
| `sp_module_unbind()` | Unbind modules | `vio_object, VIO_TYPE, encoder_object, ENCODER_TYPE` |
| `sp_stop_encode()` | Stop encoding | `encoder_object` |
| `sp_vio_close()` | Close VIO | `vio_object` |
| `sp_release_encoder_module()` | Release encoder | `encoder_object` |
| `sp_release_vio_module()` | Release VIO | `vio_object` |

#### Data Structures

```c
// Sensor parameters
typedef struct {
    int fps;            // Frame rate (-1 = auto)
    int raw_width;      // Sensor raw width
    int raw_height;     // Sensor raw height
} sp_sensors_parameters;

// Module types for binding
#define SP_MTYPE_VIO      1
#define SP_MTYPE_ENCODER  2

// Codec types
#define SP_ENCODER_H264   0
#define SP_ENCODER_H265   1
```

#### Example Usage

```c
void *vio_object, *encoder_object;
sp_sensors_parameters parms = {
    .fps = 30,
    .raw_width = 1920,
    .raw_height = 1080
};
int width = 640, height = 480;
int bitrate = 8000;  // kbps

// 1. Initialize modules
vio_object = sp_init_vio_module();
encoder_object = sp_init_encoder_module();

// 2. Open camera
sp_open_camera_v2(vio_object, 0, -1, 1, &parms, &width, &height);

// 3. Start encoding
sp_start_encode(encoder_object, 0, SP_ENCODER_H264, width, height, bitrate);

// 4. Bind VIO → Encoder (zero-copy pipeline)
sp_module_bind(vio_object, SP_MTYPE_VIO, encoder_object, SP_MTYPE_ENCODER);

// 5. Capture loop
char buffer[2 * 1024 * 1024];  // 2MB
while (running) {
    int size = sp_encoder_get_stream(encoder_object, buffer);
    if (size > 0) {
        // Write NAL units to shared memory or file
        write_to_shared_memory(buffer, size);
    }
}

// 6. Cleanup
sp_module_unbind(vio_object, SP_MTYPE_VIO, encoder_object, SP_MTYPE_ENCODER);
sp_stop_encode(encoder_object);
sp_vio_close(vio_object);
sp_release_encoder_module(encoder_object);
sp_release_vio_module(vio_object);
```

### Reference Implementation: vio2encoder

**Location**: `/app/cdev_demo/vio2encoder/vio2encoder.c`

**Key Lessons**:
1. **Simple pipeline**: Only ~100 lines for complete VIO + Encoder setup
2. **Zero-copy binding**: `sp_module_bind()` eliminates intermediate buffers
3. **NAL unit stream**: `sp_encoder_get_stream()` returns raw H.264 that VLC can play directly
4. **Error handling**: Check return values, cleanup on error

**Differences from vio2encoder**:
- We use **shared memory** instead of file output
- We support **dual cameras** (0 and 1)
- We integrate with **detection system** for overlays
- We add **recording API** and **WebRTC streaming**

---

## Implementation Guide

### Phase 1: Core H.264 Encoding + Recording

#### 1.1 Camera Daemon (C)

**File**: `src/capture/camera_daemon_drobotics.c`

**Key Changes**:

1. **Replace headers**:
   ```c
   // Remove
   #include "hb_camera_interface.h"
   #include "hbn_api.h"
   #include <jpeglib.h>

   // Add
   #include "sp_codec.h"
   #include "sp_vio.h"
   #include "sp_sys.h"
   ```

2. **Update context structure**:
   ```c
   typedef struct {
       void *vio_object;      // libspcdev VIO handle
       void *encoder_object;  // libspcdev encoder handle
       int camera_index;
       int sensor_width, sensor_height;
       int out_width, out_height;
       int fps;
       int bitrate;  // H.264 bitrate in kbps
   } camera_context_t;
   ```

3. **Replace pipeline functions**:
   ```c
   // Delete: create_camera_node, create_vin_node, create_isp_node, create_vse_node
   // Delete: init_camera_config, open_memory_manager
   // Delete: encode_nv12_to_jpeg (entire function)

   // Add: Simple libspcdev pipeline
   static int create_and_start_pipeline(camera_context_t *ctx) {
       // See example above
   }
   ```

4. **Update capture loop**:
   ```c
   static uint64_t run_capture_loop(camera_context_t *ctx, const struct arguments *args) {
       char *h264_buffer = malloc(H264_STREAM_BUFFER_SIZE);

       while (g_running) {
           int stream_size = sp_encoder_get_stream(ctx->encoder_object, h264_buffer);

           if (stream_size > 0) {
               Frame shm_frame = {0};
               shm_frame.format = 3;  // H264
               shm_frame.data_size = stream_size;
               memcpy(shm_frame.data, h264_buffer, stream_size);
               shm_frame_buffer_write(g_shm, &shm_frame);
               frame_counter++;
           }
       }

       free(h264_buffer);
       return frame_counter;
   }
   ```

#### 1.2 Shared Memory Format

**File**: `src/capture/shared_memory.h`

```c
int format;  // 0=JPEG, 1=NV12, 2=RGB, 3=H264
```

No structural changes needed. `MAX_FRAME_SIZE` (3MB) is sufficient:
- H.264 keyframe: ~50-100KB
- H.264 P-frame: ~5-20KB

#### 1.3 Python Recording

**File**: `src/monitor/h264_recorder.py`

```python
class H264Recorder:
    def start_recording(self, filename=None):
        # Open .h264 file
        # Start thread reading from shared memory
        # Write NAL units directly to file

    def stop_recording(self):
        # Close file, return stats
```

**Output**: `.h264` files playable in VLC/ffplay/ffmpeg.

#### 1.4 Build System

**File**: `src/capture/Makefile`

```makefile
LDLIBS_COMMON := -lrt
LDLIBS_DROBOTICS := $(LDLIBS_COMMON) -lpthread -lspcdev
```

Remove: `-ljpeg -lcam -lvpf -lhbmem`

---

### Phase 2: WebRTC Streaming (Optional)

#### 2.1 WebRTC Server (Python)

**File**: `src/monitor/webrtc_server.py` (NEW)

**Library**: `aiortc` (Pure Python WebRTC)

```bash
pip install aiortc av aiohttp
```

**Implementation**:
```python
from aiortc import RTCPeerConnection, VideoStreamTrack
import av

class H264VideoTrack(VideoStreamTrack):
    def __init__(self, shm):
        super().__init__()
        self.shm = shm
        self.codec = av.CodecContext.create('h264', 'r')

    async def recv(self):
        # Read H.264 from shared memory
        frame = self.shm.read_latest_frame()

        # Decode with PyAV
        packet = av.Packet(frame.data)
        frames = self.codec.decode(packet)

        return frames[0] if frames else self._black_frame()

class WebRTCServer:
    async def handle_offer(self, request):
        # WebRTC signaling (SDP offer/answer)
        pc = RTCPeerConnection()
        pc.addTrack(H264VideoTrack(self.shm))
        # ... (complete implementation in plan)
```

#### 2.2 Browser Client

**File**: `src/monitor/web_assets/webrtc-client.js` (NEW)

```javascript
class WebRTCClient {
    async start() {
        this.pc = new RTCPeerConnection({
            iceServers: [{urls: 'stun:stun.l.google.com:19302'}]
        });

        this.pc.ontrack = (event) => {
            this.videoElement.srcObject = event.streams[0];
        };

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);

        // Send to server /offer endpoint
        const response = await fetch('/offer', {
            method: 'POST',
            body: JSON.stringify({
                sdp: offer.sdp,
                type: offer.type
            })
        });

        const answer = await response.json();
        await this.pc.setRemoteDescription(answer);
    }
}
```

---

## Browser-Side Overlay System

### Architecture

```html
<div style="position: relative; width: 640px; height: 480px;">
    <!-- Video layer (background) -->
    <video id="stream" autoplay playsinline></video>

    <!-- Overlay layer (foreground) -->
    <canvas id="overlay"
            style="position: absolute; top: 0; left: 0;
                   pointer-events: none;"></canvas>
</div>
```

### Detection Streaming

**Server** (`web_monitor.py`):
```python
@app.route("/api/detections/stream")
def detections_stream():
    """Server-Sent Events for detection results"""
    def generate():
        last_version = -1
        while True:
            current_version = shm.get_detection_version()
            if current_version != last_version:
                detections, last_version = shm.read_detection()
                data = {
                    'frame_number': detections.frame_number,
                    'detections': [
                        {
                            'class_name': d.class_name,
                            'confidence': d.confidence,
                            'bbox': {'x': d.bbox.x, 'y': d.bbox.y,
                                     'w': d.bbox.w, 'h': d.bbox.h}
                        }
                        for d in detections
                    ]
                }
                yield f"data: {json.dumps(data)}\n\n"
            time.sleep(0.033)  # 30fps

    return Response(generate(), mimetype='text/event-stream')
```

**Client** (JavaScript):
```javascript
// Connect to detection stream
const eventSource = new EventSource('/api/detections/stream');

eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    drawOverlay(data.detections);
};

function drawOverlay(detections) {
    const canvas = document.getElementById('overlay');
    const ctx = canvas.getContext('2d');

    // Clear previous overlay
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw each detection
    detections.forEach(det => {
        const color = getColorForClass(det.class_name);

        // Draw bounding box
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(det.bbox.x, det.bbox.y,
                       det.bbox.w, det.bbox.h);

        // Draw label
        ctx.fillStyle = color;
        ctx.font = '14px Arial';
        const label = `${det.class_name} ${(det.confidence * 100).toFixed(0)}%`;
        ctx.fillText(label, det.bbox.x, det.bbox.y - 5);
    });
}
```

**Benefits**:
- **No re-encoding**: H.264 stream stays pristine
- **Low latency**: Direct canvas drawing (~1ms)
- **Flexible**: Easy to toggle overlay on/off
- **Scalable**: Multiple clients can overlay independently

---

## WebRTC Integration (Phase 2)

### Setup Checklist

1. **Install dependencies**:
   ```bash
   pip install aiortc av aiohttp
   ```

2. **Configure STUN/TURN** (for NAT traversal):
   ```javascript
   const iceServers = [
       {urls: 'stun:stun.l.google.com:19302'},
       // Optional TURN server for strict NAT
       // {urls: 'turn:turn.example.com', username: 'user', credential: 'pass'}
   ];
   ```

3. **Firewall rules**:
   - Open UDP ports for WebRTC (49152-65535)
   - Allow TCP port 8080 for signaling

### Browser Compatibility

| Browser | H.264 Support | WebRTC Support | Status |
|---------|---------------|----------------|--------|
| Chrome 90+ | ✅ Native | ✅ Excellent | ✅ Recommended |
| Firefox 85+ | ✅ Native | ✅ Excellent | ✅ Recommended |
| Safari 14+ | ✅ Native | ⚠️ Limited | ⚠️ Test required |
| Edge 90+ | ✅ Native | ✅ Excellent | ✅ Recommended |

### Latency Optimization

1. **Encoder settings**:
   - Use CBR (constant bitrate)
   - Set max B-frames = 0 (reduces latency)
   - Keyframe interval = 1s (30 frames @ 30fps)

2. **Network**:
   - Use WiFi 5GHz band
   - Monitor packet loss with WebRTC stats
   - Implement adaptive bitrate if needed

3. **Browser**:
   - Enable hardware video decoding
   - Use `playsinline` attribute on `<video>`

---

## Troubleshooting

### Common Issues

#### 1. **libspcdev not found**

**Error**: `cannot find -lspcdev`

**Solution**:
```bash
# Check if library exists
ls -la /usr/lib/libspcdev.so
ls -la /usr/hobot/lib/libspcdev.so

# Add to library path if needed
export LD_LIBRARY_PATH=/usr/hobot/lib:$LD_LIBRARY_PATH
```

#### 2. **sp_open_camera_v2 fails**

**Error**: `sp_open_camera_v2 failed: -1`

**Debug**:
```c
// Check camera device
ls /dev/video*

// Verify camera index (0 or 1)
ctx->camera_index = 0;  // Try both

// Check permissions
sudo chmod 666 /dev/video0
```

#### 3. **sp_encoder_get_stream returns 0**

**Possible causes**:
- Encoder not bound to VIO
- Camera not producing frames
- Bitrate too high/low

**Debug**:
```c
// Add logging
int size = sp_encoder_get_stream(encoder, buffer);
printf("Stream size: %d\n", size);

// Check binding
ret = sp_module_bind(vio, SP_MTYPE_VIO, encoder, SP_MTYPE_ENCODER);
if (ret != 0) {
    fprintf(stderr, "Bind failed: %d\n", ret);
}
```

#### 4. **H.264 file not playable in VLC**

**Issue**: Missing SPS/PPS headers

**Solution**: Ensure you're capturing from the beginning (includes keyframe with SPS/PPS)

```bash
# Test playback
ffplay recording.h264
vlc recording.h264

# Check stream info
ffprobe recording.h264
```

#### 5. **WebRTC connection fails**

**Debug checklist**:
- [ ] Check browser console for errors
- [ ] Verify signaling endpoint is accessible
- [ ] Test STUN server connectivity
- [ ] Check firewall rules (UDP ports)
- [ ] Inspect ICE candidates

```javascript
pc.onicecandidate = (event) => {
    console.log('ICE candidate:', event.candidate);
};

pc.onconnectionstatechange = () => {
    console.log('Connection state:', pc.connectionState);
};
```

### Performance Issues

#### High CPU usage

**Target**: <30% CPU for entire system

**Check**:
```bash
# Monitor process
top -p $(pgrep camera_daemon)

# Check if hardware encoding is active
cat /sys/kernel/debug/ion/heaps/carveout
```

**Optimization**:
- Verify hardware encoder is being used (not software fallback)
- Lower bitrate if CPU bound
- Check for memory leaks (valgrind)

#### Frame drops

**Symptoms**: Stuttering video, missing frames

**Debug**:
```python
# Add frame counter logging
print(f"Frame {frame.frame_number} size={frame.data_size}")
```

**Solutions**:
- Increase shared memory ring buffer size
- Reduce encoder bitrate
- Check network bandwidth (for WebRTC)

---

## References

### Official Documentation

1. **D-Robotics Developer Docs**:
   - Location: `/usr/share/doc/hobot-multimedia/`
   - Key files: `sp_codec_api.pdf`, `vio_user_guide.pdf`

2. **libspcdev Source**:
   - Headers: `/usr/include/sp_*.h`
   - Library: `/usr/hobot/lib/libspcdev.so`

3. **Sample Code**:
   - vio2encoder: `/app/cdev_demo/vio2encoder/vio2encoder.c`
   - Key reference for basic pipeline

### External Resources

1. **H.264 Specification**:
   - ITU-T H.264 / MPEG-4 AVC
   - NAL unit structure
   - Profile/Level definitions

2. **WebRTC**:
   - MDN Web Docs: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
   - aiortc documentation: https://aiortc.readthedocs.io/
   - WebRTC for the Curious: https://webrtcforthecurious.com/

3. **Python Libraries**:
   - aiortc: WebRTC implementation
   - PyAV: FFmpeg bindings for video codec
   - aiohttp: Async HTTP server for signaling

### Project Files

| File | Purpose |
|------|---------|
| `src/capture/camera_daemon_drobotics.c` | Main camera daemon with H.264 encoding |
| `src/capture/shared_memory.h` | Shared memory frame format (format=3 for H.264) |
| `src/monitor/h264_recorder.py` | H.264 file recording |
| `src/monitor/web_monitor.py` | Detection streaming API |
| `src/monitor/webrtc_server.py` | WebRTC signaling server (Phase 2) |
| `src/common/src/common/types.py` | Frame format definitions |

---

## Appendix: API Quick Reference

### libspcdev Function Signatures

```c
// VIO (Video Input/Output)
void* sp_init_vio_module(void);
int sp_open_camera_v2(void *vio_object, int camera_index, int mode,
                       int channels, sp_sensors_parameters *params,
                       int *width, int *height);
int sp_vio_close(void *vio_object);
int sp_release_vio_module(void *vio_object);

// Encoder
void* sp_init_encoder_module(void);
int sp_start_encode(void *encoder_object, int channel, int codec_type,
                    int width, int height, int bitrate);
int sp_encoder_get_stream(void *encoder_object, char *buffer);
int sp_stop_encode(void *encoder_object);
int sp_release_encoder_module(void *encoder_object);

// Binding
int sp_module_bind(void *src_object, int src_type,
                   void *dst_object, int dst_type);
int sp_module_unbind(void *src_object, int src_type,
                     void *dst_object, int dst_type);
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `H264_BITRATE` | 8000 | H.264 encoding bitrate (kbps) |
| `FRAME_INTERVAL_MS` | 0 | Frame interval for rate limiting |
| `SHM_NAME` | `/pet_camera_frames` | Shared memory name |

### Testing Commands

```bash
# Build
cd src/capture
make clean && make

# Run daemon
./build/camera_daemon_drobotics -C 0 -P 1

# Test recording
curl -X POST http://localhost:8080/api/recording/start
sleep 10
curl -X POST http://localhost:8080/api/recording/stop

# Play recording
vlc recordings/recording_*.h264

# Check shared memory
ls -lh /dev/shm/pet_camera_frames

# Monitor system
htop  # Check CPU usage
```

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-12-21 | Initial guide creation |

---

**For questions or issues, please refer to the project repository or contact the development team.**
