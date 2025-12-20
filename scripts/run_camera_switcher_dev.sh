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

cleanup() {
  echo "[cleanup] stopping background processes..."
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
    fi
  done
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
else
  echo "[info] skipping build (using existing build artifacts)"
fi

echo "[start] launching camera_switcher_daemon..."
(
  cd "${CAPTURE_DIR}"
  ../../build/camera_switcher_daemon
) &
PIDS+=("$!")

if [[ "${RUN_DETECTOR}" -eq 1 ]]; then
  echo "[start] launching mock detector (writes detections to real shared memory)..."
  (
    cd "${REPO_ROOT}"
    "${UV_BIN}" run src/capture/mock_detector_daemon.py
  ) &
  PIDS+=("$!")
fi

if [[ "${RUN_MONITOR}" -eq 1 ]]; then
  echo "[start] launching web monitor on ${MONITOR_HOST}:${MONITOR_PORT}..."
  (
    cd "${REPO_ROOT}"
    "${UV_BIN}" run src/monitor/main.py --shm-type real --host "${MONITOR_HOST}" --port "${MONITOR_PORT}"
  ) &
  PIDS+=("$!")
fi

echo "[ready] camera switcher stack is running."
echo "        monitor: http://${MONITOR_HOST}:${MONITOR_PORT}/"
echo "        press Ctrl+C to stop (all processes will be cleaned up)."

if [[ "${#PIDS[@]}" -gt 0 ]]; then
  wait -n "${PIDS[@]}"
fi
