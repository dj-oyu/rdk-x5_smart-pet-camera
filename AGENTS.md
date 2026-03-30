# Smart Pet Camera — Codex Guidelines

## Workflow
- **Package**: `uv` exclusively (`uv add`, `uv sync`, `uv run`)
- **Verify**: Implement → `uv run scripts/profile_shm.py` → judge JSON metrics
- **Mock**: `uv run src/mock/main.py` for testing without hardware
- **Search**: `gemini_search` skill for external docs

## Project Structure
| Directory | Lang | Role |
|-----------|------|------|
| `src/capture/` | C | Camera daemons, 6 SHM regions |
| `src/streaming_server/` | Go | WebRTC/MJPEG server (pion/webrtc v4) |
| `src/detector/` | Python | YOLO on BPU (hobot_dnn) |
| `src/common/` | Python | Shared types |
| `src/mock/` | Python | Mock camera, detector, SHM |
| `src/web/` | Preact | Frontend SPA |
| `src/ai-pyramid/` | Rust | AI Pyramid album/VLM (axum + rusqlite) |
| `docs/` | — | Consolidated reference docs |

## Docs Map
| Doc | Scope |
|-----|-------|
| `01-04_*.md` | Core specs (goals, requirements, design, architecture) |
| `camera-and-isp.md` | Camera switching, ISP, AWB, H.265 |
| `detection-and-yolo.md` | YOLO pipeline, benchmarks, night ROI |
| `streaming-server.md` | Go server, WebRTC, API |
| `shared-memory.md` | 6 SHM regions, zero-copy, IPC |
| `performance.md` | CPU optimization, idle throttling |
| `recording-design.md` | H.265 recording pipeline (.hevc → .mp4) |
| `pet-album-spec.md` | Album feature (iframe, AI Pyramid, rsync) |
| `pet-album-mcp.md` | MCP integration spec |
| `vlm_integration_spec.md` | VLM behavior analysis spec |
| `src/ai-pyramid/docs/architecture.md` | ai-pyramid API, DB, application layer, UI 全体像 |
| `src/ai-pyramid/docs/detections-integration.md` | YOLO detection → ai-pyramid 連携仕様 |
| `hardware-specs.md` | GPU/VPU/BPU specs, nano2D/VSE/hbn_vflow benchmarks |
| `hw-offload-roadmap.md` | H.265移行 + HWオフロード実装計画 |
| `axmodel-conversion-guide.md` | Pulsar2 axmodel変換手順書 (Qwen3-VL/Qwen3.5) |
| `logging_system.md` | Logging architecture |
| `text-rendering-design.md` | Text overlay/rendering on video |
| `tool_profile_shm_design.md` | profile_shm.py tool design |
| `development_roadmap.md` | Project timeline and roadmap |

## systemd Services (rdk-x5)

Production deployment uses systemd. See `scripts/USAGE.md` for full details.

- **Install**: `sudo ./scripts/install-services.sh rdk-x5`
- **Start/Stop all**: `sudo systemctl start|stop pet-camera.target`
- **Individual restart**: `sudo systemctl restart pet-camera-<module>`
- **Logs**: `sudo journalctl -u pet-camera-<module> -f`
- **Build + restart**: `./scripts/build.sh <module>` (builds and restarts the systemd service)

Services: `pet-camera-capture`, `pet-camera-detector`, `pet-camera-monitor`, `pet-camera-streaming`, `comic-sync`

Service files are in `deploy/rdk-x5/`. After editing, copy to `/etc/systemd/system/` and `daemon-reload`.

**Note**: detector runs via `uv` — the service file must use the absolute path to `uv` since systemd's PATH doesn't include user-local bins.

## Future Tasks
- [ ] JSON event recording (schema defined, not coded)
- [ ] Unified YAML config (params hardcoded across C/Python/Go)
- [ ] Process auto-recovery / storage cleanup
- [ ] Multi-camera fusion mode
- [x] AI Pyramid: HTTPS, album web app, VLM pipeline (Rust実装完了)
- [x] H.265移行 (Phase 1) → エンコーダー、WebRTC (pion v4)、録画パイプライン完了
- [ ] HW offload Phase 2 → `hw-offload-roadmap.md` に計画化済み
