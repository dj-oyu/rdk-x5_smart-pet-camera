# Claude's Guidelines for Smart Pet Camera Project

## Development Philosophy
- **Document First**: Always check `docs/` for specs and status before asking. Update docs when designs change.
- **Spec-Driven**: Implement features based on defined requirements (`docs/02_requirements.md`, etc.).
- **Evidence-Based**: Use quantitative profiling tools instead of reading long logs to verify system health.

## Core Mandates & Constraints
- **Package Management**: Use `uv` exclusively.
    - Install: `uv add <package>` (NOT `pip install`)
    - Sync: `uv sync`
- **Execution**: Run python scripts via `uv run`.
    - Example: `uv run src/monitor/main.py`
    - Env vars: `env VAR=val uv run ...`
- **Type Checking**: Adhere to `pyright` standards.
    - Check: `PYTHONPATH=src:src/common/src:src/mock:src/monitor uv run pyright src/`

## Verification Workflow (The "Profiler" Pattern)
Instead of asking the user to "check if it works" or analyzing raw logs:

1. **Implement/Modify Code**
2. **Run Profiler**: Use the profiling script (`scripts/profile_shm.py`) to capture a statistical snapshot of system health.
    - *Why*: Reduces context usage, provides objective metrics (FPS, drop rate).
    - *Testing*: You can use `src/capture/mock_camera_daemon.py` to simulate a camera daemon for tool testing.
3. **Analyze Metrics**: Judge success based on JSON output (e.g., "FPS is 29.8, Variance is low" -> PASS).

## Tools & Skills

### Gemini Search
Use `gemini_search` skill when you need external knowledge not in the codebase.

**When to use:**
- Looking up library documentation (e.g., "latest aiortc API for media tracks").
- Searching for specific error messages or solutions.
- Investigating hardware specifics (e.g., "D-Robotics ISP tuning parameters").

**Example:**
```text
User: "How do I implement a custom MediaStreamTrack in aiortc?"
Action: Call `gemini_search` with query "aiortc custom MediaStreamTrack implementation example"
```

## Project Structure Awareness
- **`src/capture/`**: C/C++ camera daemons & Shared Memory (Core).
- **`src/monitor/`**: WebRTC/MJPEG streaming & Signaling.
- **`src/common/`**: Shared Python types & logic.
- **`docs/`**: The source of truth. Read `*log.md` files for recent context.

## Commit Messages
- Format: `Type: Subject`
- Focus on "Why" and "What".
- Example: `feat: Add H.264 WebRTC track to reduce CPU load`
