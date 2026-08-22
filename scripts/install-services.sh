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

# Unit files are tracked as .example templates, never as ready-to-run units:
# what a unit contains is device-specific (paths, model names, the user it runs
# as), so the repository holds the template and the device holds the instance.
# Installing strips the .example suffix.
#
# Templates may carry __PLACEHOLDER__ tokens. Those must be substituted before
# installing — this script refuses rather than writing a broken unit.
UNITS=()
for f in "${DEPLOY_DIR}"/*.example; do
  [[ -f "${f}" ]] || continue
  unit="$(basename "${f}" .example)"

  # Only systemd units are installed here; sudoers templates and the like are
  # documented in scripts/USAGE.md and set up by hand.
  case "${unit}" in
    *.service | *.target | *.timer) ;;
    *) continue ;;
  esac

  if grep -qE '__[A-Z_]+__' "${f}"; then
    echo "[error] ${f} still contains placeholders:" >&2
    grep -oE '__[A-Z_]+__' "${f}" | sort -u | sed 's/^/          /' >&2
    echo "        Substitute them and re-run, e.g." >&2
    echo "          sed 's/__USER__/youruser/' ${f} > /tmp/${unit} && sudo cp /tmp/${unit} ${SYSTEMD_DIR}/" >&2
    exit 1
  fi

  cp -v "${f}" "${SYSTEMD_DIR}/${unit}"
  UNITS+=("${unit}")
done

if [[ ${#UNITS[@]} -eq 0 ]]; then
  echo "[warn] No unit templates (*.service.example, *.target.example, *.timer.example) found in ${DEPLOY_DIR}/"
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
