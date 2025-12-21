#!/usr/bin/env bash
set -euo pipefail

# YOLO検出を使用した開発用ワンコマンドランチャー
# - camera_switcher_daemon と camera_daemon_drobotics のビルド
# - camera_switcher_daemon の起動（内部で day/night カメラデーモンを切替）
# - YOLO検出デーモンと Web モニターの起動
#
# 依存:
# - make, gcc
# - uv (Python 依存関係の解決に使用)
# - hobot_dnn_rdkx5 (YOLO推論用)
#
# 使い方:
#   ./scripts/run_camera_switcher_yolo.sh
#   MONITOR_PORT=<port> ./scripts/run_camera_switcher_yolo.sh
#   ./scripts/run_camera_switcher_yolo.sh --skip-build --no-detector

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CAPTURE_DIR="${REPO_ROOT}/src/capture"
BUILD_DIR="${REPO_ROOT}/build"
UV_BIN="${UV_BIN:-uv}"
MONITOR_HOST="${MONITOR_HOST:-0.0.0.0}"
MONITOR_PORT="${MONITOR_PORT:-8080}"

# YOLO設定
YOLO_MODEL="${YOLO_MODEL:-v11n}"
YOLO_SCORE_THRESHOLD="${YOLO_SCORE_THRESHOLD:-0.6}"
YOLO_NMS_THRESHOLD="${YOLO_NMS_THRESHOLD:-0.7}"

RUN_DETECTOR=1
RUN_MONITOR=1
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: run_camera_switcher_yolo.sh [options]

Options:
  --skip-build      事前ビルドをスキップ（既存 build/ を再利用）
  --no-detector     YOLO検出デーモンを起動しない
  --no-monitor      Webモニターを起動しない
  --monitor-host H  Webモニターのバインドホスト (default: 0.0.0.0)
  --monitor-port P  Webモニターのポート (default: 8080)
  --yolo-model M    YOLOモデル (v8n/v11n/v13n, default: v11n)
  --score-thres T   検出スコア閾値 (default: 0.6)
  --nms-thres T     NMS IoU閾値 (default: 0.7)
  -h, --help        このヘルプを表示

環境変数:
  UV_BIN                 uv コマンドのパス (default: uv)
  MONITOR_HOST           Webモニターのバインドホスト
  MONITOR_PORT           Webモニターのポート
  YOLO_MODEL             YOLOモデル (v8n/v11n/v13n)
  YOLO_SCORE_THRESHOLD   検出スコア閾値
  YOLO_NMS_THRESHOLD     NMS IoU閾値

Examples:
  # デフォルト（YOLOv13n, 閾値0.6）
  ./scripts/run_camera_switcher_yolo.sh

  # YOLO11nを使用（高速）
  ./scripts/run_camera_switcher_yolo.sh --yolo-model v13n

  # 閾値を調整
  ./scripts/run_camera_switcher_yolo.sh --score-thres 0.5

  # ビルドスキップ
  ./scripts/run_camera_switcher_yolo.sh --skip-build
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
    --yolo-model)
      YOLO_MODEL="${2:?--yolo-model requires value}"
      shift
      ;;
    --score-thres)
      YOLO_SCORE_THRESHOLD="${2:?--score-thres requires value}"
      shift
      ;;
    --nms-thres)
      YOLO_NMS_THRESHOLD="${2:?--nms-thres requires value}"
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

# YOLOモデルパスの設定
YOLO_MODELS_DIR="/tmp/yolo_models"
case "${YOLO_MODEL}" in
  v8n)
    MODEL_FILE="yolov8n_detect_bayese_640x640_nv12.bin"
    ;;
  v11n)
    MODEL_FILE="yolo11n_detect_bayese_640x640_nv12.bin"
    ;;
  v13n)
    MODEL_FILE="yolov13n_detect_bayese_640x640_nv12.bin"
    ;;
  *)
    echo "[error] Unknown YOLO model: ${YOLO_MODEL}" >&2
    echo "        Supported: v8n, v11n, v13n" >&2
    exit 1
    ;;
esac

YOLO_MODEL_PATH="${YOLO_MODELS_DIR}/${MODEL_FILE}"

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

  echo "[build] building web assets (esbuild)..."
  make -C "${REPO_ROOT}" web
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
  echo "[start] launching YOLO detector (model=${YOLO_MODEL}, score_thres=${YOLO_SCORE_THRESHOLD})..."
  echo "        model_path: ${YOLO_MODEL_PATH}"
  (
    cd "${REPO_ROOT}"
    "${UV_BIN}" run src/detector/yolo_detector_daemon.py \
      --model-path "${YOLO_MODEL_PATH}" \
      --score-threshold "${YOLO_SCORE_THRESHOLD}" \
      --nms-threshold "${YOLO_NMS_THRESHOLD}"
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

echo ""
echo "=============================================="
echo "Camera Switcher Stack with YOLO Detection"
echo "=============================================="
echo "YOLO Model:       ${YOLO_MODEL} (${MODEL_FILE})"
echo "Score Threshold:  ${YOLO_SCORE_THRESHOLD}"
echo "NMS Threshold:    ${YOLO_NMS_THRESHOLD}"
echo "Web Monitor:      http://${MONITOR_HOST}:${MONITOR_PORT}/"
echo ""
echo "Press Ctrl+C to stop (all processes will be cleaned up)."
echo "=============================================="

if [[ "${#PIDS[@]}" -gt 0 ]]; then
  wait -n "${PIDS[@]}"
fi
