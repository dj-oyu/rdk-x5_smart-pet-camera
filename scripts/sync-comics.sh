#!/bin/bash
# Comic JPEG → AI Pyramid Pro 自動同期
# inotifywait で comics/ ディレクトリを監視し、rsync で転送
# メタデータ (bbox, pet_id等) は Go → POST /api/photos/ingest で直接送信
# Usage: systemctl start comic-sync (systemdで自動起動)

set -euo pipefail

WATCH_DIR="${RECORDING_PATH:-./recordings}/comics"
REMOTE_HOST="${PET_ALBUM_HOST:?PET_ALBUM_HOST is required}"
REMOTE_DIR="${PET_ALBUM_PHOTOS_DIR:-/app/smart-pet-camera/src/ai-pyramid/data/photos}"
LOG_TAG="comic-sync"

mkdir -p "$WATCH_DIR"

logger -t "$LOG_TAG" "Watching $WATCH_DIR → ${REMOTE_HOST}:${REMOTE_DIR}"

inotifywait -m -e close_write -e moved_to --format '%f' "$WATCH_DIR" |
while read -r file; do
  # comic JPEGのみ対象 (メタデータはAPI経由で送信済み)
  case "$file" in
    comic_*.jpg|comic_*.JPG) ;;
    *) continue ;;
  esac

  src="${WATCH_DIR}/${file}"
  [ -f "$src" ] || continue

  logger -t "$LOG_TAG" "Syncing: $file"

  # rsync with retry (Tailscale SSH経由)
  for attempt in 1 2 3; do
    if rsync -a --remove-source-files "$src" "${REMOTE_HOST}:${REMOTE_DIR}/" 2>/dev/null; then
      logger -t "$LOG_TAG" "OK: $file"
      break
    fi
    logger -t "$LOG_TAG" "Retry $attempt: $file"
    sleep $((attempt * 2))
  done
done
