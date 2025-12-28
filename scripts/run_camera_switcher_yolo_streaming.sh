#!/usr/bin/env bash
set -euo pipefail

# YOLO検出 + Go Streaming Server を使用した開発用ワンコマンドランチャー
# - camera_switcher_daemon と camera_daemon_drobotics のビルド
# - camera_switcher_daemon の起動（内部で day/night カメラデーモンを切替）
# - YOLO検出デーモンと Web モニターの起動
# - Go Streaming Server の起動（WebRTC + H.264録画）
#
# 依存:
# - make, gcc, go
# - uv (Python 依存関係の解決に使用)
# - hobot_dnn_rdkx5 (YOLO推論用)
#
# 使い方:
#   ./scripts/run_camera_switcher_yolo_streaming.sh
#   MONITOR_PORT=8080 STREAMING_PORT=8081 ./scripts/run_camera_switcher_yolo_streaming.sh
#   ./scripts/run_camera_switcher_yolo_streaming.sh --skip-build --no-detector --no-streaming

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CAPTURE_DIR="${REPO_ROOT}/src/capture"
STREAMING_DIR="${REPO_ROOT}/src/streaming_server"
BUILD_DIR="${REPO_ROOT}/build"
UV_BIN="${UV_BIN:-uv}"
MONITOR_HOST="${MONITOR_HOST:-0.0.0.0}"
MONITOR_PORT="${MONITOR_PORT:-8080}"
STREAMING_HOST="${STREAMING_HOST:-0.0.0.0}"
STREAMING_PORT="${STREAMING_PORT:-8081}"
METRICS_PORT="${METRICS_PORT:-9090}"
PPROF_PORT="${PPROF_PORT:-6060}"

# YOLO設定
YOLO_MODEL="${YOLO_MODEL:-v11n}"
YOLO_SCORE_THRESHOLD="${YOLO_SCORE_THRESHOLD:-0.6}"
YOLO_NMS_THRESHOLD="${YOLO_NMS_THRESHOLD:-0.7}"

# Streaming設定
STREAMING_MAX_CLIENTS="${STREAMING_MAX_CLIENTS:-10}"
STREAMING_SHM="${STREAMING_SHM:-/pet_camera_stream}"
RECORDING_PATH="${RECORDING_PATH:-${REPO_ROOT}/recordings}"

RUN_DETECTOR=1
RUN_MONITOR=1
RUN_STREAMING=1
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: run_camera_switcher_yolo_streaming.sh [options]

Options:
  --skip-build      事前ビルドをスキップ（既存 build/ を再利用）
  --no-detector     YOLO検出デーモンを起動しない
  --no-monitor      Webモニターを起動しない
  --no-streaming    Go Streaming Serverを起動しない
  --monitor-host H  Webモニターのバインドホスト (default: 0.0.0.0)
  --monitor-port P  Webモニターのポート (default: 8080)
  --streaming-port P  Streaming Serverのポート (default: 8081)
  --metrics-port P    Prometheusメトリクスポート (default: 9090)
  --pprof-port P      pprofプロファイリングポート (default: 6060)
  --max-clients N     最大WebRTCクライアント数 (default: 10)
  --yolo-model M    YOLOモデル (v8n/v11n/v13n, default: v11n)
  --score-thres T   検出スコア閾値 (default: 0.6)
  --nms-thres T     NMS IoU閾値 (default: 0.7)
  -h, --help        このヘルプを表示

環境変数:
  UV_BIN                 uv コマンドのパス (default: uv)
  MONITOR_HOST           Webモニターのバインドホスト
  MONITOR_PORT           Webモニターのポート
  STREAMING_HOST         Streaming Serverのバインドホスト
  STREAMING_PORT         Streaming Serverのポート
  METRICS_PORT           Prometheusメトリクスポート
  PPROF_PORT             pprofプロファイリングポート
  STREAMING_MAX_CLIENTS  最大WebRTCクライアント数
  STREAMING_SHM          共有メモリ名 (default: /pet_camera_stream)
  RECORDING_PATH         録画ファイル保存先 (default: ./recordings)
  YOLO_MODEL             YOLOモデル (v8n/v11n/v13n)
  YOLO_SCORE_THRESHOLD   検出スコア閾値
  YOLO_NMS_THRESHOLD     NMS IoU閾値

Examples:
  # デフォルト（YOLO + WebRTC Streaming）
  ./scripts/run_camera_switcher_yolo_streaming.sh

  # Streaming無効（YOLOのみ）
  ./scripts/run_camera_switcher_yolo_streaming.sh --no-streaming

  # カスタムポート設定
  MONITOR_PORT=8080 STREAMING_PORT=8081 ./scripts/run_camera_switcher_yolo_streaming.sh

  # ビルドスキップ
  ./scripts/run_camera_switcher_yolo_streaming.sh --skip-build

Endpoints:
  Web Monitor:     http://localhost:${MONITOR_PORT}/
  WebRTC Offer:    http://localhost:${STREAMING_PORT}/offer
  Recording API:   http://localhost:${STREAMING_PORT}/start|stop|status
  Prometheus:      http://localhost:${METRICS_PORT}/metrics
  pprof:           http://localhost:${PPROF_PORT}/debug/pprof/
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
    --no-streaming)
      RUN_STREAMING=0
      ;;
    --monitor-host)
      MONITOR_HOST="${2:?--monitor-host requires value}"
      shift
      ;;
    --monitor-port)
      MONITOR_PORT="${2:?--monitor-port requires value}"
      shift
      ;;
    --streaming-port)
      STREAMING_PORT="${2:?--streaming-port requires value}"
      shift
      ;;
    --metrics-port)
      METRICS_PORT="${2:?--metrics-port requires value}"
      shift
      ;;
    --pprof-port)
      PPROF_PORT="${2:?--pprof-port requires value}"
      shift
      ;;
    --max-clients)
      STREAMING_MAX_CLIENTS="${2:?--max-clients requires value}"
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

# Go Streaming Server使用時はgoコマンドが必要
if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  require_cmd go
fi

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
  echo "[cleanup] stopping background processes..."
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
    fi
  done
  make -C "${CAPTURE_DIR}" kill-processes >/dev/null 2>&1 || true
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

  if [[ "${RUN_STREAMING}" -eq 1 ]]; then
    echo "[build] building Go streaming server..."
    (
      cd "${STREAMING_DIR}"
      go build -o "${BUILD_DIR}/streaming-server" ./cmd/server
    )
    echo "[build] Go streaming server built: ${BUILD_DIR}/streaming-server"
  fi

  if [[ "${RUN_MONITOR}" -eq 1 ]]; then
    echo "[build] building Go web monitor..."
    (
      cd "${STREAMING_DIR}"
      go build -o "${BUILD_DIR}/web_monitor" ./cmd/web_monitor
    )
    echo "[build] Go web monitor built: ${BUILD_DIR}/web_monitor"
  fi
else
  echo "[info] skipping build (using existing build artifacts)"
fi

# 録画ディレクトリ作成
if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  mkdir -p "${RECORDING_PATH}"
  echo "[info] recording path: ${RECORDING_PATH}"
fi

echo "[start] launching camera_switcher_daemon..."
(
  cd "${REPO_ROOT}"
  "${BUILD_DIR}/camera_switcher_daemon"
) &
PIDS+=("$!")

echo "[wait] waiting for shared memory to appear..."
if ! wait_for_shm "pet_camera_active_frame" 10; then
  echo "[error] shared memory /dev/shm/pet_camera_active_frame not found after 10s" >&2
  echo "        camera_daemon_drobotics may have failed to start." >&2
  exit 1
fi

if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  echo "[wait] waiting for H.264 stream shared memory..."
  if ! wait_for_shm "pet_camera_stream" 10; then
    echo "[warn] shared memory /dev/shm/pet_camera_stream not found" >&2
    echo "       streaming server may fail to start" >&2
  fi
fi

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
  echo "[start] launching Go web monitor on ${MONITOR_HOST}:${MONITOR_PORT}..."
  (
    cd "${REPO_ROOT}"
    "${BUILD_DIR}/web_monitor" \
      -http "${MONITOR_HOST}:${MONITOR_PORT}" \
      -assets "${REPO_ROOT}/src/monitor/web_assets" \
      -assets-build "${BUILD_DIR}/web" \
      -frame-shm "/pet_camera_active_frame" \
      -detection-shm "/pet_camera_detections" \
      -webrtc-base "http://localhost:${STREAMING_PORT}" \
      -fps 30
  ) &
  PIDS+=("$!")
fi

if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  echo "[start] launching Go streaming server on ${STREAMING_HOST}:${STREAMING_PORT}..."
  (
    cd "${REPO_ROOT}"
    "${BUILD_DIR}/streaming-server" \
      -shm "${STREAMING_SHM}" \
      -http "${STREAMING_HOST}:${STREAMING_PORT}" \
      -metrics ":${METRICS_PORT}" \
      -pprof ":${PPROF_PORT}" \
      -record-path "${RECORDING_PATH}" \
      -max-clients "${STREAMING_MAX_CLIENTS}"
  ) &
  PIDS+=("$!")
fi

echo ""
echo "=============================================="
echo "Camera Switcher Stack with YOLO + Streaming"
echo "=============================================="
echo "YOLO Model:       ${YOLO_MODEL} (${MODEL_FILE})"
echo "Score Threshold:  ${YOLO_SCORE_THRESHOLD}"
echo "NMS Threshold:    ${YOLO_NMS_THRESHOLD}"
echo ""
echo "Web Monitor:      http://${MONITOR_HOST}:${MONITOR_PORT}/"
if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  echo "Streaming Server: http://${STREAMING_HOST}:${STREAMING_PORT}/"
  echo "  - WebRTC Offer: http://${STREAMING_HOST}:${STREAMING_PORT}/offer"
  echo "  - Recording:    http://${STREAMING_HOST}:${STREAMING_PORT}/start|stop|status"
  echo "  - Health:       http://${STREAMING_HOST}:${STREAMING_PORT}/health"
  echo "Prometheus:       http://localhost:${METRICS_PORT}/metrics"
  echo "pprof:            http://localhost:${PPROF_PORT}/debug/pprof/"
  echo "Recording Path:   ${RECORDING_PATH}"
  echo "Max Clients:      ${STREAMING_MAX_CLIENTS}"
fi
echo ""
echo "Press Ctrl+C to stop (all processes will be cleaned up)."
echo "=============================================="

if [[ "${#PIDS[@]}" -gt 0 ]]; then
  wait -n "${PIDS[@]}"
fi
