#!/usr/bin/env bash
# Resolve YOLO model file path from model alias (v8n/v11n/v13n/v26n)
# Used by: systemd detector service, build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

MODEL_ALIAS="${1:-v26n}"
PROJECT_MODELS_DIR="${REPO_ROOT}/models"
YOLO_MODELS_DIR="/tmp/yolo_models"

case "${MODEL_ALIAS}" in
  v8n)  MODEL_FILE="yolov8n_detect_bayese_640x640_nv12.bin" ;;
  v11n) MODEL_FILE="yolo11n_detect_bayese_640x640_nv12.bin" ;;
  v13n) MODEL_FILE="yolov13n_detect_bayese_640x640_nv12.bin" ;;
  v26n) MODEL_FILE="yolo26n_det_bpu_bayese_640x640_nv12.bin" ;;
  *)
    echo "[error] Unknown YOLO model: ${MODEL_ALIAS}" >&2
    echo "        Supported: v8n, v11n, v13n, v26n" >&2
    exit 1
    ;;
esac

# Search: project/models/ first, then /tmp/yolo_models/
for dir in "${PROJECT_MODELS_DIR}" "${YOLO_MODELS_DIR}"; do
  if [[ -f "${dir}/${MODEL_FILE}" ]]; then
    echo "${dir}/${MODEL_FILE}"
    exit 0
  fi
done

# Fallback: v26n → v11n
if [[ "${MODEL_ALIAS}" == "v26n" ]]; then
  FALLBACK_FILE="yolo11n_detect_bayese_640x640_nv12.bin"
  for dir in "${PROJECT_MODELS_DIR}" "${YOLO_MODELS_DIR}"; do
    if [[ -f "${dir}/${FALLBACK_FILE}" ]]; then
      echo "[warn] v26n not found, falling back to v11n" >&2
      echo "${dir}/${FALLBACK_FILE}"
      exit 0
    fi
  done
fi

echo "[error] Model file not found: ${MODEL_FILE}" >&2
echo "        Searched: ${PROJECT_MODELS_DIR}/, ${YOLO_MODELS_DIR}/" >&2
exit 1
