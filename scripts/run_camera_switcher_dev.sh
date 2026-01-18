#!/usr/bin/env bash
set -euo pipefail

# 開発用ワンコマンドランチャー
# - camera_switcher_daemon と camera_daemon_drobotics のビルド
# - camera_switcher_daemon の起動（内部で day/night カメラデーモンを切替）
# - RealSharedMemory に対するモック検出デーモンと Web モニターの起動
#
# 依存:
# - make, gcc
# - uv (Python 依存関係の解決に使用)
#
# 使い方:
#   ./scripts/run_camera_switcher_dev.sh
#   MONITOR_PORT=<port> ./scripts/run_camera_switcher_dev.sh
#   ./scripts/run_camera_switcher_dev.sh --skip-build --no-detector

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CAPTURE_DIR="${REPO_ROOT}/src/capture"
BUILD_DIR="${REPO_ROOT}/build"
UV_BIN="${UV_BIN:-uv}"
MONITOR_HOST="${MONITOR_HOST:-0.0.0.0}"
MONITOR_PORT="${MONITOR_PORT:-8080}"

RUN_DETECTOR=1
RUN_MONITOR=1
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: run_camera_switcher_dev.sh [options]

Options:
  --skip-build      事前ビルドをスキップ（既存 build/ を再利用）
  --no-detector     モック検出デーモンを起動しない
  --no-monitor      Webモニターを起動しない
  --monitor-host H  Webモニターのバインドホスト (default: 0.0.0.0)
  --monitor-port P  Webモニターのポート (default: 8080)
  -h, --help        このヘルプを表示

環境変数:
  UV_BIN         uv コマンドのパス (default: uv)
  MONITOR_HOST   Webモニターのバインドホスト
  MONITOR_PORT   Webモニターのポート
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      ;;
    --no-detector)
      RUN_DETECTOR=0
      ;;
    --no-monitor)
      RUN_MONITOR=0
      ;;
    --monitor-host)
      MONITOR_HOST="${2:?--monitor-host requires value}"
      shift
      ;;
    --monitor-port)
      MONITOR_PORT="${2:?--monitor-port requires value}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[error] Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] '$1' command not found. Please install it first." >&2
    exit 1
  fi
}

require_cmd make
require_cmd "${UV_BIN}"

PIDS=()

wait_for_shm() {
  local name="$1"
  local timeout="${2:-10}"
  local elapsed=0

  while [[ "${elapsed}" -lt "${timeout}" ]]; do
    if [[ -e "/dev/shm/${name}" ]]; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

cleanup() {
  echo "[cleanup] stopping all processes and cleaning up..."
  make -C "${CAPTURE_DIR}" cleanup >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [[ "${SKIP_BUILD}" -ne 1 ]]; then
  echo "[build] cleaning up stale processes and shared memory..."
  make -C "${CAPTURE_DIR}" cleanup

  echo "[build] building camera_daemon_drobotics and shared memory libs..."
  make -C "${CAPTURE_DIR}"

  echo "[build] building camera_switcher_daemon..."
  make -C "${CAPTURE_DIR}" switcher-daemon-build

  echo "[build] building web assets..."
  make -C "${REPO_ROOT}" web

  echo "[build] building Go web monitor..."
  (
    cd "${REPO_ROOT}/src/streaming_server"
    go build -o "${BUILD_DIR}/web_monitor" ./cmd/web_monitor
  )

  echo "[build] building Go streaming server..."
  (
    cd "${REPO_ROOT}/src/streaming_server"
    go build -o "${BUILD_DIR}/streaming-server" ./cmd/server
  )
else
  echo "[info] skipping build (using existing build artifacts)"
fi

echo "[start] launching camera_switcher_daemon..."
(
  cd "${CAPTURE_DIR}"
  exec ../../build/camera_switcher_daemon
) &
PIDS+=("$!")

echo "[wait] waiting for shared memory to appear..."
if ! wait_for_shm "pet_camera_active_frame" 20; then
  echo "[error] shared memory /dev/shm/pet_camera_active_frame not found after 20s" >&2
  echo "        camera_switcher_daemon may have failed to start." >&2
  exit 1
fi

if ! wait_for_shm "pet_camera_stream" 10; then
  echo "[warn] shared memory /dev/shm/pet_camera_stream not found" >&2
  echo "       streaming server may fail to start" >&2
fi

# Streaming Server (WebRTC)
echo "[start] launching Go streaming server..."
(
  cd "${REPO_ROOT}"
  exec "${BUILD_DIR}/streaming-server" \
    -shm "/pet_camera_stream" \
    -http "0.0.0.0:8081" \
    -metrics ":9090" \
    -pprof ":6060" \
    -max-clients 10
) &
PIDS+=("$!")

if [[ "${RUN_DETECTOR}" -eq 1 ]]; then
  echo "[start] launching mock detector (writes detections to real shared memory)..."
  (
    cd "${REPO_ROOT}"
    exec "${UV_BIN}" run src/capture/mock_detector_daemon.py
  ) &
  PIDS+=("$!")
fi

if [[ "${RUN_MONITOR}" -eq 1 ]]; then
  echo "[start] launching Go web monitor on ${MONITOR_HOST}:${MONITOR_PORT}..."
  (
    cd "${REPO_ROOT}"
    exec "${BUILD_DIR}/web_monitor" \
      -http "${MONITOR_HOST}:${MONITOR_PORT}" \
      -assets "${REPO_ROOT}/src/monitor/web_assets" \
      -assets-build "${BUILD_DIR}/web" \
      -frame-shm "/pet_camera_active_frame" \
      -detection-shm "/pet_camera_detections" \
      -fps 30
  ) &
  PIDS+=("$!")
fi

echo "[ready] camera switcher stack is running."
echo "        monitor: http://${MONITOR_HOST}:${MONITOR_PORT}/"
echo "        press Ctrl+C to stop (all processes will be cleaned up)."

if [[ "${#PIDS[@]}" -gt 0 ]]; then
  wait -n "${PIDS[@]}"
fi
