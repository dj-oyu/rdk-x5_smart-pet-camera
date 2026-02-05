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

# .envファイルを読み込み（存在する場合）
if [[ -f "${REPO_ROOT}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${REPO_ROOT}/.env"
  set +a
fi
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
YOLO_MODEL="${YOLO_MODEL:-v26n}"
YOLO_SCORE_THRESHOLD="${YOLO_SCORE_THRESHOLD:-0.6}"
YOLO_NMS_THRESHOLD="${YOLO_NMS_THRESHOLD:-0.7}"

# ログ設定
LOG_LEVEL="${LOG_LEVEL:-info}"

# TLS設定 (HTTPS対応)
TLS_CERT="${TLS_CERT:-}"
TLS_KEY="${TLS_KEY:-}"

# HTTP専用ポート (MJPEG用、M5Stack等のマイコン向け)
HTTP_ONLY_PORT="${HTTP_ONLY_PORT:-8082}"

# MJPEG品質設定 (帯域制御用、1-100、低いほど帯域削減)
JPEG_QUALITY="${JPEG_QUALITY:-65}"

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
  --yolo-model M    YOLOモデル (v8n/v11n/v13n/v26n, default: v26n)
  --score-thres T   検出スコア閾値 (default: 0.6)
  --nms-thres T     NMS IoU閾値 (default: 0.7)
  --log-level L     ログレベル (debug/info/warn/error, default: info)
  --jpeg-quality Q  MJPEG品質 1-100 (低いほど帯域削減, default: 65)
  --tls-cert FILE   TLS証明書ファイル (HTTPSを有効化)
  --tls-key FILE    TLS秘密鍵ファイル
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
  YOLO_MODEL             YOLOモデル (v8n/v11n/v13n/v26n)
  YOLO_SCORE_THRESHOLD   検出スコア閾値
  YOLO_NMS_THRESHOLD     NMS IoU閾値
  LOG_LEVEL              ログレベル (debug/info/warn/error)
  JPEG_QUALITY           MJPEG品質 1-100 (低いほど帯域削減)
  TLS_CERT               TLS証明書ファイルパス
  TLS_KEY                TLS秘密鍵ファイルパス

Examples:
  # デフォルト（YOLO + WebRTC Streaming）
  ./scripts/run_camera_switcher_yolo_streaming.sh

  # Streaming無効（YOLOのみ）
  ./scripts/run_camera_switcher_yolo_streaming.sh --no-streaming

  # カスタムポート設定
  MONITOR_PORT=8080 STREAMING_PORT=8081 ./scripts/run_camera_switcher_yolo_streaming.sh

  # ビルドスキップ
  ./scripts/run_camera_switcher_yolo_streaming.sh --skip-build

  # HTTPS有効 (Tailscale証明書)
  ./scripts/run_camera_switcher_yolo_streaming.sh \
    --tls-cert ~/your-hostname.ts.net.crt \
    --tls-key ~/your-hostname.ts.net.key

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
    --log-level)
      LOG_LEVEL="${2:?--log-level requires value}"
      shift
      ;;
    --jpeg-quality)
      JPEG_QUALITY="${2:?--jpeg-quality requires value}"
      shift
      ;;
    --tls-cert)
      TLS_CERT="${2:?--tls-cert requires value}"
      shift
      ;;
    --tls-key)
      TLS_KEY="${2:?--tls-key requires value}"
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
require_cmd npm

# Go Streaming Server使用時はgoコマンドが必要
if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  require_cmd go
fi

# YOLOモデルパスの設定
YOLO_MODELS_DIR="/tmp/yolo_models"
PROJECT_MODELS_DIR="${REPO_ROOT}/models"
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
  v26n)
    MODEL_FILE="yolo26n_det_bpu_bayese_640x640_nv12.bin"
    ;;
  *)
    echo "[error] Unknown YOLO model: ${YOLO_MODEL}" >&2
    echo "        Supported: v8n, v11n, v13n, v26n" >&2
    exit 1
    ;;
esac

# モデルファイルのパス解決 (project/models/ を優先)
resolve_model_path() {
  local model_file="$1"
  if [[ -f "${PROJECT_MODELS_DIR}/${model_file}" ]]; then
    echo "${PROJECT_MODELS_DIR}/${model_file}"
  elif [[ -f "${YOLO_MODELS_DIR}/${model_file}" ]]; then
    echo "${YOLO_MODELS_DIR}/${model_file}"
  else
    echo ""
  fi
}

YOLO_MODEL_PATH="$(resolve_model_path "${MODEL_FILE}")"

# フォールバック: v26n が見つからなければ v11n を試す
if [[ -z "${YOLO_MODEL_PATH}" && "${YOLO_MODEL}" == "v26n" ]]; then
  echo "[warn] v26n model not found, falling back to v11n..."
  YOLO_MODEL="v11n"
  MODEL_FILE="yolo11n_detect_bayese_640x640_nv12.bin"
  YOLO_MODEL_PATH="$(resolve_model_path "${MODEL_FILE}")"
fi

if [[ -z "${YOLO_MODEL_PATH}" ]]; then
  echo "[error] Model file not found: ${MODEL_FILE}" >&2
  echo "        Searched: ${PROJECT_MODELS_DIR}/, ${YOLO_MODELS_DIR}/" >&2
  exit 1
fi

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
  echo "[build] Cleaning up..."
  make -C "${CAPTURE_DIR}" cleanup >/dev/null 2>&1

  echo "[build] Building C daemons..."
  make -C "${CAPTURE_DIR}" >/dev/null
  make -C "${CAPTURE_DIR}" switcher-daemon-build >/dev/null

  echo "[build] Building web assets..."
  # node_modules/esbuildのネイティブバイナリが無ければnpm install
  if [[ ! -x "${REPO_ROOT}/node_modules/esbuild/bin/esbuild" ]]; then
    echo "[build] Installing npm dependencies..."
    (cd "${REPO_ROOT}" && npm install) >/dev/null 2>&1
  fi
  make -C "${REPO_ROOT}" web >/dev/null 2>&1

  if [[ "${RUN_STREAMING}" -eq 1 ]]; then
    echo "[build] Building Go servers..."
    (cd "${STREAMING_DIR}" && go build -o "${BUILD_DIR}/streaming-server" ./cmd/server) >/dev/null
  fi

  if [[ "${RUN_MONITOR}" -eq 1 ]]; then
    (cd "${STREAMING_DIR}" && go build -o "${BUILD_DIR}/web_monitor" ./cmd/web_monitor) >/dev/null
  fi
  echo "[build] Done"
else
  echo "[info] Skipping build"
fi

# 録画ディレクトリ作成
if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  mkdir -p "${RECORDING_PATH}"
fi

echo "[start] Launching camera_switcher_daemon..."
(
  cd "${REPO_ROOT}"
  "${BUILD_DIR}/camera_switcher_daemon" 2>&1 | tee -a /tmp/camera_switcher.log
) &
PIDS+=("$!")

echo "[wait] Waiting for shared memory..."
if ! wait_for_shm "pet_camera_active_frame" 10; then
  echo "[error] SHM not found. camera_daemon may have failed." >&2
  exit 1
fi

if [[ "${RUN_MONITOR}" -eq 1 ]]; then
  wait_for_shm "pet_camera_mjpeg_frame" 10 || echo "[warn] MJPEG SHM not found" >&2
fi

if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  wait_for_shm "pet_camera_stream" 10 || echo "[warn] H.264 SHM not found" >&2
fi

if [[ "${RUN_DETECTOR}" -eq 1 ]]; then
  echo "[start] Launching YOLO detector (${YOLO_MODEL})..."
  (
    cd "${REPO_ROOT}"
    "${UV_BIN}" run src/detector/yolo_detector_daemon.py \
      --model-path "${YOLO_MODEL_PATH}" \
      --score-threshold "${YOLO_SCORE_THRESHOLD}" \
      --nms-threshold "${YOLO_NMS_THRESHOLD}" \
      --log-level "${LOG_LEVEL}" 2>&1 | tee /tmp/yolo_detector.log
  ) &
  PIDS+=("$!")
fi

if [[ "${RUN_MONITOR}" -eq 1 ]]; then
  TLS_ARGS=""
  PROTOCOL="http"
  if [[ -n "${TLS_CERT}" && -n "${TLS_KEY}" ]]; then
    TLS_ARGS="-tls-cert ${TLS_CERT} -tls-key ${TLS_KEY}"
    PROTOCOL="https"
  fi
  HTTP_ONLY_ARGS=""
  if [[ -n "${HTTP_ONLY_PORT}" ]]; then
    HTTP_ONLY_ARGS="-http-only ${MONITOR_HOST}:${HTTP_ONLY_PORT}"
  fi
  echo "[start] Launching web monitor (${PROTOCOL}://${MONITOR_HOST}:${MONITOR_PORT}, JPEG quality=${JPEG_QUALITY})..."
  (
    cd "${REPO_ROOT}"
    # shellcheck disable=SC2086
    "${BUILD_DIR}/web_monitor" \
      -http "${MONITOR_HOST}:${MONITOR_PORT}" \
      -assets "${REPO_ROOT}/src/monitor/web_assets" \
      -assets-build "${BUILD_DIR}/web" \
      -frame-shm "/pet_camera_mjpeg_frame" \
      -detection-shm "/pet_camera_detections" \
      -webrtc-base "http://localhost:${STREAMING_PORT}" \
      -fps 30 \
      -jpeg-quality "${JPEG_QUALITY}" \
      -log-level "${LOG_LEVEL}" \
      ${TLS_ARGS} ${HTTP_ONLY_ARGS} 2>&1 | tee /tmp/web_monitor.log
  ) &
  PIDS+=("$!")
fi

if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  echo "[start] Launching streaming server (:${STREAMING_PORT})..."
  (
    cd "${REPO_ROOT}"
    "${BUILD_DIR}/streaming-server" \
      -shm "${STREAMING_SHM}" \
      -http "${STREAMING_HOST}:${STREAMING_PORT}" \
      -metrics ":${METRICS_PORT}" \
      -pprof ":${PPROF_PORT}" \
      -record-path "${RECORDING_PATH}" \
      -max-clients "${STREAMING_MAX_CLIENTS}" \
      -log-level "${LOG_LEVEL}" 2>&1 | tee /tmp/streaming_server.log
  ) &
  PIDS+=("$!")
fi

echo ""
echo "========================================"
echo "Smart Pet Camera Stack Running"
echo "========================================"
echo "Web Monitor: http://${MONITOR_HOST}:${MONITOR_PORT}/"
if [[ "${RUN_STREAMING}" -eq 1 ]]; then
  echo "WebRTC:      http://${STREAMING_HOST}:${STREAMING_PORT}/offer"
fi
echo "YOLO:        ${YOLO_MODEL} (score=${YOLO_SCORE_THRESHOLD})"
echo "Logs:        /tmp/{camera_switcher,yolo_detector,web_monitor,streaming_server}.log"
echo "Press Ctrl+C to stop"
echo "========================================"

if [[ "${#PIDS[@]}" -gt 0 ]]; then
  wait -n "${PIDS[@]}"
fi
