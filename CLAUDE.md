# Smart Pet Camera — Claude Guidelines

## Workflow
- **Package**: `uv` exclusively (`uv add`, `uv sync`, `uv run`)
- **Verify**: Implement → `uv run scripts/profile_shm.py` → judge JSON metrics
- **Mock**: `uv run src/mock/main.py` for testing without hardware
- **Search**: `gemini_search` skill for external docs

## Project Structure
| Directory | Lang | Role |
|-----------|------|------|
| `src/capture/` | C | Camera daemons, 4 SHM regions |
| `src/streaming_server/` | Go | Self-contained WebRTC (pion/dtls only) + MJPEG |
| `src/detector/` | Python | YOLO on BPU (hobot_dnn) |
| `src/common/` | Python | Shared types |
| `src/mock/` | Python | Mock camera, detector, SHM |
| `src/web/` | Preact | Frontend SPA |
| `src/ai-pyramid/` | Rust | AI Pyramid album/VLM (axum + rusqlite) |

## Known Blockers
- **Bowl detection (feat/bowl-detection-test)**: 夜カメラの IR ノイズにより自動お皿検出が不安定。IRライト (850nm) 設置がブロッカー。手動 ROI + 差分モニターは動作中。詳細: `docs/bowl-detection-insights.md`

## Docs
`docs/` 配下。主要エントリポイント:
- `01-04_*.md` — Core specs (goals, requirements, design, architecture)
- `streaming-server.md` / `performance.md` / `shared-memory.md` — Server, perf, IPC
- `hw-offload-roadmap.md` / `optee-afalg-findings.md` — HW offload & TE driver issues
- `recording-design.md` / `pet-album-spec.md` — Recording & album
- SHM single source of truth: `src/capture/shm_constants.h`

## systemd Services
See `scripts/USAGE.md` for install, start/stop, logs, build commands.
Services: `pet-camera-capture`, `pet-camera-detector`, `pet-camera-monitor`, `pet-camera-streaming`, `comic-sync`
**Note**: detector runs via `uv` — service file needs absolute `uv` path.
