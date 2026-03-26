#!/usr/bin/env bash
set -euo pipefail

# モジュール別ビルド + systemd restart (開発用)
#
# Usage:
#   ./scripts/build.sh                    # rdk-x5全モジュール
#   ./scripts/build.sh capture            # camera daemon のみ
#   ./scripts/build.sh streaming          # streaming server のみ
#   ./scripts/build.sh monitor            # web monitor + web assets
#   ./scripts/build.sh web                # web assets のみ
#   ./scripts/build.sh detector           # ビルド不要、restart のみ
#   ./scripts/build.sh album              # GitHub artifact download
#   ./scripts/build.sh --no-restart ...   # restart をスキップ

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/build"
CAPTURE_DIR="${REPO_ROOT}/src/capture"
STREAMING_DIR="${REPO_ROOT}/src/streaming_server"
AI_PYRAMID_DIR="${REPO_ROOT}/src/ai-pyramid"

DO_RESTART=1
MODULES=()

for arg in "$@"; do
  case "${arg}" in
    --no-restart) DO_RESTART=0 ;;
    -h|--help)
      sed -n '3,14p' "$0"
      exit 0
      ;;
    *) MODULES+=("${arg}") ;;
  esac
done

# Default: all rdk-x5 modules
if [[ ${#MODULES[@]} -eq 0 ]]; then
  MODULES=(capture web streaming monitor)
fi

restart_service() {
  local service="$1"
  if [[ "${DO_RESTART}" -eq 1 ]] && systemctl is-active --quiet "${service}" 2>/dev/null; then
    echo "[restart] ${service}"
    sudo systemctl restart "${service}"
  fi
}

build_capture() {
  echo "[build] capture (C daemons)..."
  mkdir -p "${BUILD_DIR}"
  # Remove .o to pick up header changes
  rm -f "${CAPTURE_DIR}"/*.o 2>/dev/null
  make -C "${CAPTURE_DIR}" >/dev/null
  echo "[build] capture done"

  # capture restart cascades to detector/monitor/streaming via PartOf=
  restart_service pet-camera-capture.service
}

build_web() {
  echo "[build] web assets (Bun)..."
  (cd "${REPO_ROOT}/src/web" && bun install --frozen-lockfile 2>/dev/null; true)
  make -C "${REPO_ROOT}" web >/dev/null 2>&1
  echo "[build] web done"
}

build_streaming() {
  echo "[build] streaming server (Go)..."
  (cd "${STREAMING_DIR}" && CGO_ENABLED=1 go build -o "${BUILD_DIR}/streaming-server" ./cmd/server) >/dev/null
  echo "[build] streaming done"
  restart_service pet-camera-streaming.service
}

build_monitor() {
  # monitor embeds web assets, so build web first
  build_web
  echo "[build] web monitor (Go)..."
  (cd "${STREAMING_DIR}" && go build -o "${BUILD_DIR}/web_monitor" ./cmd/web_monitor) >/dev/null
  echo "[build] monitor done"
  restart_service pet-camera-monitor.service
}

build_detector() {
  # Python — no build step, just restart
  echo "[build] detector (Python, no build needed)"
  restart_service pet-camera-detector.service
}

build_album() {
  echo "[build] album (downloading GitHub artifact)..."
  rm -rf /tmp/pet-album-dl
  gh run download --name pet-album-aarch64 --dir /tmp/pet-album-dl
  mkdir -p "${AI_PYRAMID_DIR}/target/release"
  cp /tmp/pet-album-dl/pet-album "${AI_PYRAMID_DIR}/target/release/pet-album"
  chmod +x "${AI_PYRAMID_DIR}/target/release/pet-album"
  echo "[build] album done ($(stat --printf='%s' "${AI_PYRAMID_DIR}/target/release/pet-album" | numfmt --to=iec))"
  restart_service pet-album.service
}

for module in "${MODULES[@]}"; do
  case "${module}" in
    capture)   build_capture ;;
    web)       build_web ;;
    streaming) build_streaming ;;
    monitor)   build_monitor ;;
    detector)  build_detector ;;
    album)     build_album ;;
    *)
      echo "[error] Unknown module: ${module}" >&2
      echo "        Available: capture, web, streaming, monitor, detector, album" >&2
      exit 1
      ;;
  esac
done
