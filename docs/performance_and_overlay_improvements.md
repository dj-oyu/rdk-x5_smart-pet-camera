# Performance Optimization and Overlay Features (2025-12-28)

## Overview
This document summarizes the significant performance improvements and feature additions made to the Go-based streaming server and web monitor on December 28, 2025.

## 1. Performance Optimization (CPU Usage 100% -> 3%)
The initial Go implementation of the web monitor consumed excessive CPU (approx. 100% of one core) due to inefficient image processing.

### Key Improvements:
- **C-based NV12 to RGB Conversion**: Replaced the pure Go implementation of YUV-to-RGB conversion with an optimized C function (`nv12_to_rgba`). This eliminated the overhead of pixel-by-pixel processing in Go.
- **JPEG Caching**: Implemented a caching mechanism in `monitor.go`. If the frame number hasn't changed, the server returns the cached JPEG buffer instead of re-encoding it. This significantly reduces load when multiple clients are connected or when the detection rate is lower than the frame rate.
- **Optimized Memory Access**: Modified `read_latest_frame` to copy only the actual data size rather than the full buffer size.

**Result**: CPU usage dropped from ~100% to ~3% on the target hardware.

## 2. Overlay Features
To match the capabilities of the previous Python/Flask implementation and ensure system status is visible even when the video feed is static:

### MJPEG Overlay (Server-Side)
- **Implementation**: Added `drawer.go` with a simple bitmap font renderer.
- **Features**:
  - Draws Frame Number and Timestamp (`yyyy/mm/dd HH:mm:ss`) directly onto the JPEG image.
  - Draws bounding boxes and labels for detected objects.
- **Benefit**: Provides a robust fallback stream that works on any client, with visual confirmation of system activity.

### WebRTC Overlay (Client-Side)
- **Implementation**: Updated `bbox_overlay.js` to render stats on a `<canvas>` layer overlaid on the `<video>` element.
- **Features**:
  - Displays Frame Number and Timestamp matching the server-side format.
  - Draws bounding boxes with persistence (boxes remain visible for 500ms to prevent flickering).
- **Benefit**: Maintains the low latency of WebRTC while providing rich metadata.

## 3. Timestamp and Synchronization Fixes
- **Clock Source**: Switched from `CLOCK_MONOTONIC` to `CLOCK_REALTIME` in `camera_pipeline.c`. This resolved the issue where timestamps were displayed as `0.000` or uptime seconds, ensuring the overlay displays the correct wall-clock time.
- **Detection Sync**: Relaxed the frame number synchronization check in the overlay logic. The system now draws the *latest available* detection even if the frame number doesn't perfectly match the video frame. This ensures detections are visible even if the detection pipeline runs at a lower FPS than the camera.

## 4. Robustness and Startup Logic
- **Retry Logic**: Implemented retry mechanisms in both `web_monitor` (Go) and `mock_detector_daemon.py` to wait for shared memory creation. This fixed race conditions where processes would fail if started before the camera daemon was fully ready.
- **Script Update**: Updated `scripts/run_camera_switcher_dev.sh` to:
  - Build and run the Go-based `web_monitor` and `streaming-server` instead of the legacy Python monitor.
  - Use `exec` for better process lifecycle management.
  - Explicitly wait for shared memory segments before launching dependent services.
  - Clean up all processes (including Go binaries) upon exit.
- **Panic Fix**: Fixed a nil pointer dereference in the WebRTC server that occurred when a client disconnected.

## Summary
The system is now fully migrated to the efficient Go architecture for streaming and monitoring, with visual parity to the Python prototype but significantly better performance and stability.
