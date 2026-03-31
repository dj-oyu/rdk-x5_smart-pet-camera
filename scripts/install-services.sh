#!/usr/bin/env bash
set -euo pipefail

# systemd サービスインストール
#
# Usage:
#   sudo ./scripts/install-services.sh rdk-x5       # rdk-x5用
#   sudo ./scripts/install-services.sh ai-pyramid    # ai-pyramid用

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

usage() {
  echo "Usage: sudo $0 <rdk-x5|ai-pyramid>"
  echo ""
  echo "  rdk-x5      Install camera stack services (capture, detector, monitor, streaming, comic-sync)"
  echo "  ai-pyramid  Install pet album service"
  exit 1
}

if [[ $# -ne 1 ]]; then
  usage
fi

TARGET="$1"
DEPLOY_DIR="${REPO_ROOT}/deploy/${TARGET}"

if [[ ! -d "${DEPLOY_DIR}" ]]; then
  echo "[error] Deploy directory not found: ${DEPLOY_DIR}" >&2
  usage
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[error] Must run as root (sudo)" >&2
  exit 1
fi

echo "[install] Installing ${TARGET} services from ${DEPLOY_DIR}/"

# Copy all .service and .target files
UNITS=()
for f in "${DEPLOY_DIR}"/*.service "${DEPLOY_DIR}"/*.target; do
  [[ -f "${f}" ]] || continue
  unit="$(basename "${f}")"
  cp -v "${f}" "${SYSTEMD_DIR}/${unit}"
  UNITS+=("${unit}")
done

if [[ ${#UNITS[@]} -eq 0 ]]; then
  echo "[warn] No service/target files found in ${DEPLOY_DIR}/"
  exit 0
fi

echo ""
echo "[install] Reloading systemd..."
systemctl daemon-reload

echo "[install] Enabling units..."
for unit in "${UNITS[@]}"; do
  systemctl enable "${unit}"
done

echo ""
echo "[install] Installed ${#UNITS[@]} unit(s):"
for unit in "${UNITS[@]}"; do
  printf "  %-40s %s\n" "${unit}" "$(systemctl is-enabled "${unit}" 2>/dev/null || echo 'unknown')"
done

echo ""
case "${TARGET}" in
  rdk-x5)
    echo "Start all:  sudo systemctl start pet-camera.target"
    echo "Stop all:   sudo systemctl stop pet-camera.target"
    echo "Status:     systemctl status pet-camera-*.service"
    echo "Logs:       journalctl -u pet-camera-capture -u pet-camera-detector -f"
    ;;
  ai-pyramid)
    echo "Start all:  sudo systemctl start ai-pyramid.target"
    echo "Stop all:   sudo systemctl stop ai-pyramid.target"
    echo "Status:     systemctl status pet-album ax-yolo-daemon"
    echo "Logs:       journalctl -u pet-album -u ax-yolo-daemon -f"
    ;;
esac
