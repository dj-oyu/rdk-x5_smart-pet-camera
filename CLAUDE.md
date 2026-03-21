# Smart Pet Camera — Claude Guidelines

## Workflow
- **Package**: `uv` exclusively (`uv add`, `uv sync`, `uv run`)
- **Verify**: Implement → `uv run scripts/profile_shm.py` → judge JSON metrics
- **Mock**: `uv run src/capture/mock_camera_daemon.py` for testing without hardware
- **Search**: `gemini_search` skill for external docs

## Project Structure
| Directory | Lang | Role |
|-----------|------|------|
| `src/capture/` | C | Camera daemons, 9 SHM regions |
| `src/streaming_server/` | Go | WebRTC/MJPEG server (pion/webrtc) |
| `src/detector/` | Python | YOLO on BPU (hobot_dnn) |
| `src/common/` | Python | Shared types |
| `src/mock/` | Python | Mock camera, detector, SHM |
| `src/ai-pyramid/` | TBD | AI Pyramid album/VLM (planned) |
| `docs/` | — | Consolidated reference docs |

## Docs Map
| Doc | Scope |
|-----|-------|
| `01-04_*.md` | Core specs (goals, requirements, design, architecture) |
| `camera-and-isp.md` | Camera switching, ISP, AWB, H.264 |
| `detection-and-yolo.md` | YOLO pipeline, benchmarks, night ROI |
| `streaming-server.md` | Go server, WebRTC, API |
| `shared-memory.md` | 9 SHM regions, zero-copy, IPC |
| `performance.md` | CPU optimization, idle throttling |
| `pet-album-spec.md` | Album feature (iframe, AI Pyramid, rsync) |
| `vlm_integration_spec.md` | VLM behavior analysis spec |
| `hardware-specs.md` | GPU/VPU/BPU specs, nano2D/VSE/hbn_vflow benchmarks |
| `hw-offload-roadmap.md` | H.265移行 + HWオフロード実装計画 |
| `axmodel-conversion-guide.md` | Pulsar2 axmodel変換手順書 (Qwen3-VL/Qwen3.5) |

## Future Tasks
- [ ] JSON event recording (schema defined, not coded)
- [ ] Unified YAML config (params hardcoded across C/Python/Go)
- [ ] Process auto-recovery / storage cleanup
- [ ] Multi-camera fusion mode
- [ ] AI Pyramid: HTTPS, album web app, VLM pipeline
- [x] H.265移行 (Phase 1) → エンコーダー、WebRTC (pion v4)、録画パイプライン完了
- [ ] HW offload Phase 2 → `hw-offload-roadmap.md` に計画化済み
