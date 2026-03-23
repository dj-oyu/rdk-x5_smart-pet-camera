#!/bin/bash
# Comic JPEG → AI Pyramid Pro 自動同期
# inotifywait で comics/ ディレクトリを監視し、rsync で転送
# Usage: systemctl start comic-sync (systemdで自動起動)

set -euo pipefail

WATCH_DIR="${RECORDING_PATH:-./recordings}/comics"
REMOTE_HOST="ai-pyramid"
REMOTE_DIR="/app/smart-pet-camera/src/ai-pyramid/data/photos"
LOG_TAG="comic-sync"

mkdir -p "$WATCH_DIR"

logger -t "$LOG_TAG" "Watching $WATCH_DIR → ${REMOTE_HOST}:${REMOTE_DIR}"

inotifywait -m -e close_write -e moved_to --format '%f' "$WATCH_DIR" |
while read -r file; do
  # comic JPEG + JSON sidecar 対象
  case "$file" in
    comic_*.jpg|comic_*.JPG) ;;
    comic_*.json) ;;
    *) continue ;;
  esac

  src="${WATCH_DIR}/${file}"
  [ -f "$src" ] || continue

  # For JPEG: also sync the JSON sidecar if it exists
  files_to_sync=("$src")
  if [[ "$file" == *.jpg ]] || [[ "$file" == *.JPG ]]; then
    json_sidecar="${src%.*}.json"
    [ -f "$json_sidecar" ] && files_to_sync+=("$json_sidecar")
  fi

  logger -t "$LOG_TAG" "Syncing: ${files_to_sync[*]##*/}"

  # rsync with retry (Tailscale SSH経由)
  for attempt in 1 2 3; do
    if rsync -a --remove-source-files "${files_to_sync[@]}" "${REMOTE_HOST}:${REMOTE_DIR}/" 2>/dev/null; then
      logger -t "$LOG_TAG" "OK: $file"
      break
    fi
    logger -t "$LOG_TAG" "Retry $attempt: $file"
    sleep $((attempt * 2))
  done
done
