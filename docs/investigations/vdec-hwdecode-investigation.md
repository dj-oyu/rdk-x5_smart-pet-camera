# AX_VDEC CreateGrp & HW Decode Investigation

Investigation date: 2026-03-30
Device: AI Pyramid Pro (AX8850 / AX650C)
BSP: SDK V3.6.4_20250822020158 (kernel module V1.45 mismatch)

## Background

YOLO NPU daemon needs HW H.265 decode (`AX_VDEC`) to convert HEVC frames to NV12
for inference. `AX_VDEC_CreateGrp` works in standalone test binaries but fails
when called from the daemon process.

## VDEC ioctl Sequence Comparison

Device nodes: `/dev/ax_vdec` (fd=10), `/dev/ax_jdec` (fd=12), `/dev/ax_hrtimer` (fd=13)

### Standalone test (success) — strace filtered

```
ioctl(10, 0x6b/0x19)  — GetGrpAttr
ioctl(10, 0x6b/0x04)  — GetGrpParam
ioctl(10, 0x76/0x18)  — VB pool query
ioctl(10, 0x76/0x14)  — VB pool config
ioctl(10, 0x6b/0x2d)  — CreateGrp          ← SUCCESS (=0)
ioctl(10, 0x6b/0x22)  — RecvThread start (bg)
ioctl(10, 0x6b/0x32)  — SendStream
                       ↓ CMM buffer allocation
ioctl(5,  0x70/0x12)  — CMM pool query
ioctl(5,  PHN_GET_REG)
ioctl(5,  0x70/0x07)  — CMM alloc
ioctl(5,  0x70/0x06)  — CMM map
                       ↓ Output channel setup (×3 channels)
ioctl(10, 0x6b/0x19)  — GetGrpAttr (ch0)
ioctl(10, 0x76/0x18)  — VB config (ch0)
ioctl(10, 0x76/0x14)  — VB config (ch0)
ioctl(10, 0x6b/0x19)  — GetGrpAttr (ch1)
...
ioctl(10, 0x6b/0x33)  — StartRecvStream    ← after channel setup
ioctl(10, 0x6b/0x24)  — DestroyGrp (cleanup)
```

### Daemon (failure) — strace filtered

```
ioctl(10, 0x6b/0x19)  — GetGrpAttr
ioctl(10, 0x6b/0x04)  — GetGrpParam
ioctl(10, 0x76/0x18)  — VB pool query
ioctl(10, 0x76/0x14)  — VB pool config
ioctl(10, 0x6b/0x2d)  — CreateGrp          ← SUCCESS (=0)
ioctl(10, 0x6b/0x22)  — RecvThread start (bg)
ioctl(10, 0x6b/0x23)  — GetStream (recv thread, no data yet)
ioctl(10, 0x6b/0x32)  — SendStream
ioctl(10, 0x6b/0x33)  — StartRecvStream    ← NO channel setup!
ioctl(10, 0x6b/0x24)  — DestroyGrp
ioctl(10, 0x6b/0x2e)  — DestroyPool
ioctl(10, 0x6b/0x2f)  — Deinit
```

### Key Difference

The daemon **skips CMM buffer allocation and output channel setup** between
`SendStream` and `StartRecvStream`. The standalone test allocates CMM pool
buffers and configures 3 output channels before starting the receive stream.

Additionally, the daemon's recv thread issues `GetStream` (0x6b/0x23) before
channels are configured, which may cause the pipeline to error out.

### Socket Binding (daemon only)

The daemon binds a Unix socket before VDEC init:
```
bind(3, {sa_family=AF_UNIX, sun_path="/tmp/vt3.sock"}, 110) = 0
```
This socket is not present in the standalone test. The early bind changes fd
numbering and may affect resource ordering.

## ffmpeg HW Decode Test Results

### hevc_axdec (HW decode) — FAILED

```
[hevc_axdec] PPS id out of range: 0 (×17)
Stream #0:0: Video: hevc (hevc_axdec), none, 25 fps
Cannot determine format of input 0:0 after EOF
→ 0 frames decoded
```

Cause: `hevc_axdec` requires probing with valid SPS/PPS. The TCP HEVC stream
from rdk-x5 starts mid-GOP without parameter sets.

### hevc_axdec with increased probesize — PARTIAL

```
analyzeduration=10000000, probesize=10000000
[hevc_axdec] HEVC decoder w:1280, h:720, bit_depth:8, ref_num:3
Stream detected but pixel format: none
```

HW decoder recognized the stream but could not produce output frames.
Likely related to the VDEC CreateGrp / buffer setup issue above.

### SW decode (native hevc) — SUCCESS

```
Stream #0:0: Video: hevc (Main), yuvj420p(pc), 1280x720, 25 fps
Output: mjpeg, yuvj420p, 1280x720
frame=8, speed=0.037x (SW decode ~27× slower than realtime)
```

SW decode works but is too slow for real-time inference pipeline.

## ax_yolo_wrapper.sh

Wrapper script for BSP SDK library path setup:

```bash
#!/bin/bash
# Wrapper for ax_yolo* binaries — sets LD_LIBRARY_PATH for BSP SDK libs
export LD_LIBRARY_PATH=/tmp/ax650n_bsp_sdk/msp/out/lib:/soc/lib:${LD_LIBRARY_PATH}
exec /usr/local/bin/"$@"
```

## Status

- CreateGrp ioctl itself succeeds in both cases — the issue is post-creation
  pipeline setup (missing CMM alloc + channel config in daemon)
- SW ffmpeg decode works but 27× too slow
- HW decode blocked by same VDEC pipeline issue
- Root cause likely: BSP userspace lib (V3.6.4) vs kernel module (V1.45) API
  mismatch in channel/buffer management calls
