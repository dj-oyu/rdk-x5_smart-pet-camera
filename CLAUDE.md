# Claude's Guidelines for Smart Pet Camera Project

## Core Mandates
- **Package**: `uv` exclusively (`uv add`, `uv sync`, `uv run`)
- **Type Check**: `PYTHONPATH=src:src/common/src:src/mock:src/monitor uv run pyright src/`
- **Go Test**: `cd src/streaming_server && go test ./...`
- **Commit**: `Type: Subject` — focus on "Why" and "What"

## Verification (Profiler Pattern)
1. Implement → 2. `uv run scripts/profile_shm.py` → 3. Judge JSON metrics (FPS, drop rate)
- Mock: `uv run src/capture/mock_camera_daemon.py`
- External search: `gemini_search` skill

## Project Structure
- **`src/capture/`**: C camera daemons, shared memory (9 SHM regions)
- **`src/streaming_server/`**: Go WebRTC/MJPEG server (pion/webrtc)
- **`src/detector/`**: Python YOLO (BPU, hobot_dnn)
- **`src/common/`**: Shared Python types
- **`src/mock/`**: Mock camera, detector, SHM for development
- **`src/ai-pyramid/`**: AI Pyramid album/VLM service (planned)
- **`docs/`**: Consolidated reference docs (category-based)

## Key Docs
| Doc | Scope |
|-----|-------|
| `01-04_*.md` | Core specs (goals, requirements, design, architecture) |
| `camera-and-isp.md` | Camera switching, ISP, AWB, H.264 |
| `detection-and-yolo.md` | YOLO pipeline, benchmarks, night ROI |
| `streaming-server.md` | Go server, WebRTC, API |
| `shared-memory.md` | 9 SHM regions, zero-copy, IPC |
| `performance.md` | CPU optimization, idle throttling |
| `pet-album-spec-DRAFT.md` | Album feature design (iframe, AI Pyramid) |
| `vlm_integration_spec.md` | VLM behavior analysis spec |

## Hardware Constraints (RDK X5)
- BPU: 10 TOPS INT8, single-core only
- H.264: libspcdev, **700kbps hard limit**, GOP=14
- ISP: runtime API limited — only AWB/3DNR/2DNR work. Gamma/WDR/CPROC fail
- AWB night camera: MANUAL mode only, apply 30 frames after ISP start
- GPU (Vivante GC8000L): 6.75 GFLOPS, useful only for OpenCL zero-copy

## Future Tasks (Uninvestigated / Unimplemented)
- [ ] JSON event recording (schema in 02_requirements.md, not coded)
- [ ] Unified YAML config system (parameters hardcoded across C/Python/Go)
- [ ] Process auto-recovery / storage cleanup
- [ ] Multi-camera fusion mode
- [ ] AI Pyramid HTTPS化 (Tailscale cert)
- [ ] AI Pyramid album web app (iframe integration)
- [ ] VLM filtering / captioning pipeline
- [ ] HW encoder investigation (h264_v4l2m2m for recording)
- [ ] VPU utilization investigation (hardware-specs.md: "要調査")
