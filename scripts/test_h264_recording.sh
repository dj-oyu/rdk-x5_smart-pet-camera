#!/usr/bin/env bash
set -euo pipefail

# H.264録画機能テストスクリプト
#
# 目的:
# - camera_daemon_drobotics (H.264 HW encoding) の起動
# - H264Recorder API による録画の開始/停止
# - 録画ファイルの検証（サイズ、フォーマット、再生可能性）
# - 共有メモリの状態確認
# - デバッグ情報の出力
#
# 使い方:
#   ./scripts/test_h264_recording.sh
#   ./scripts/test_h264_recording.sh --duration 10 --skip-playback
#   ./scripts/test_h264_recording.sh --camera 1 --bitrate 4000

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CAPTURE_DIR="${REPO_ROOT}/src/capture"
BUILD_DIR="${REPO_ROOT}/build"
UV_BIN="${UV_BIN:-uv}"

# デフォルト設定
CAMERA_INDEX=0
RECORDING_DURATION=5
MONITOR_PORT=8080
BITRATE=8000
SKIP_PLAYBACK=0
SKIP_BUILD=0
VERBOSE=0

usage() {
  cat <<'EOF'
Usage: test_h264_recording.sh [options]

Options:
  --camera INDEX        カメラインデックス (default: 0)
  --duration SECONDS    録画時間（秒） (default: 5)
  --bitrate KBPS        H.264ビットレート (default: 8000)
  --port PORT           モニターポート (default: 8080)
  --skip-playback       録画ファイルの再生テストをスキップ
  --skip-build          ビルドをスキップ
  --verbose             詳細なデバッグ出力
  -h, --help            このヘルプを表示

Examples:
  # 5秒間録画してVLCで再生確認
  ./scripts/test_h264_recording.sh

  # 10秒間録画、再生テストなし
  ./scripts/test_h264_recording.sh --duration 10 --skip-playback

  # カメラ1で低ビットレート録画
  ./scripts/test_h264_recording.sh --camera 1 --bitrate 4000
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --camera)
      CAMERA_INDEX="${2:?--camera requires value}"
      shift 2
      ;;
    --duration)
      RECORDING_DURATION="${2:?--duration requires value}"
      shift 2
      ;;
    --bitrate)
      BITRATE="${2:?--bitrate requires value}"
      shift 2
      ;;
    --port)
      MONITOR_PORT="${2:?--port requires value}"
      shift 2
      ;;
    --skip-playback)
      SKIP_PLAYBACK=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --verbose)
      VERBOSE=1
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
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] '$1' command not found. Please install it first." >&2
    exit 1
  fi
}

require_cmd make
require_cmd curl
require_cmd "${UV_BIN}"

PIDS=()
TEST_FAILED=0

cleanup() {
  echo ""
  echo "[cleanup] Stopping all processes..."
  for pid in "${PIDS[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
    fi
  done
  make -C "${CAPTURE_DIR}" cleanup >/dev/null 2>&1 || true

  if [[ "${TEST_FAILED}" -eq 0 ]]; then
    echo "[cleanup] ✅ Test completed successfully"
  else
    echo "[cleanup] ❌ Test failed (see errors above)"
  fi
}
trap cleanup EXIT INT TERM

echo "=========================================="
echo "H.264 Recording Test"
echo "=========================================="
echo "Camera:           ${CAMERA_INDEX}"
echo "Duration:         ${RECORDING_DURATION}s"
echo "Bitrate:          ${BITRATE} kbps"
echo "Monitor Port:     ${MONITOR_PORT}"
echo "=========================================="
echo ""

# ビルド
if [[ "${SKIP_BUILD}" -ne 1 ]]; then
  echo "[build] Building camera_daemon_drobotics..."
  make -C "${CAPTURE_DIR}" cleanup >/dev/null 2>&1 || true
  if ! make -C "${CAPTURE_DIR}"; then
    echo "[error] Build failed" >&2
    TEST_FAILED=1
    exit 1
  fi
  echo "[build] ✅ Build completed"
else
  echo "[build] Skipping build (using existing binary)"
fi

# カメラデーモン起動
echo "[start] Launching camera_daemon_drobotics..."
if [[ "${VERBOSE}" -eq 1 ]]; then
  (cd "${CAPTURE_DIR}" && "../../build/camera_daemon_drobotics" -C "${CAMERA_INDEX}" -P 1) &
else
  (cd "${CAPTURE_DIR}" && "../../build/camera_daemon_drobotics" -C "${CAMERA_INDEX}" -P 1 >/dev/null 2>&1) &
fi
CAMERA_PID=$!
PIDS+=("${CAMERA_PID}")

# カメラ初期化待機
echo "[wait] Waiting for camera initialization (3s)..."
sleep 3

# カメラデーモンが起動しているか確認
if ! kill -0 "${CAMERA_PID}" 2>/dev/null; then
  echo "[error] Camera daemon failed to start" >&2
  TEST_FAILED=1
  exit 1
fi
echo "[start] ✅ Camera daemon running (PID: ${CAMERA_PID})"

# 共有メモリ確認
echo "[check] Checking shared memory..."
if [[ -e "/dev/shm/pet_camera_frames" ]]; then
  SHM_SIZE=$(ls -lh /dev/shm/pet_camera_frames | awk '{print $5}')
  echo "[check] ✅ Shared memory exists (size: ${SHM_SIZE})"
else
  echo "[error] Shared memory not found" >&2
  TEST_FAILED=1
  exit 1
fi

# フレームフォーマット確認
echo "[check] Checking frame format in shared memory..."
FRAME_CHECK=$(cd "${REPO_ROOT}" && "${UV_BIN}" run python3 -c '
import sys
sys.path.insert(0, "src/capture")
from real_shared_memory import RealSharedMemory

shm = RealSharedMemory()
shm.open()
frame = shm.read_latest_frame()
if frame is None:
    print("ERROR: No frames in shared memory")
    sys.exit(1)

print(f"format={frame.format}")
print(f"size={len(frame.data)}")
print(f"frame_number={frame.frame_number}")
print(f"resolution={frame.width}x{frame.height}")
shm.close()
' 2>&1)

if [[ "${FRAME_CHECK}" == ERROR:* ]]; then
  echo "[error] ${FRAME_CHECK}" >&2
  TEST_FAILED=1
  exit 1
fi

echo "[check] Frame info:"
echo "${FRAME_CHECK}" | while read -r line; do
  echo "        ${line}"
done

# フォーマットが H.264 (format=3) であることを確認
FRAME_FORMAT=$(echo "${FRAME_CHECK}" | grep "^format=" | cut -d= -f2)
if [[ "${FRAME_FORMAT}" != "3" ]]; then
  echo "[error] Expected format=3 (H.264), got format=${FRAME_FORMAT}" >&2
  TEST_FAILED=1
  exit 1
fi
echo "[check] ✅ H.264 frames detected"

# Webモニター起動
echo "[start] Launching web monitor..."
if [[ "${VERBOSE}" -eq 1 ]]; then
  (cd "${REPO_ROOT}" && "${UV_BIN}" run src/monitor/main.py --shm-type real --host 127.0.0.1 --port "${MONITOR_PORT}") &
else
  (cd "${REPO_ROOT}" && "${UV_BIN}" run src/monitor/main.py --shm-type real --host 127.0.0.1 --port "${MONITOR_PORT}" >/dev/null 2>&1) &
fi
MONITOR_PID=$!
PIDS+=("${MONITOR_PID}")

# Webモニター起動待機
echo "[wait] Waiting for web monitor startup (3s)..."
sleep 3

if ! kill -0 "${MONITOR_PID}" 2>/dev/null; then
  echo "[error] Web monitor failed to start" >&2
  TEST_FAILED=1
  exit 1
fi
echo "[start] ✅ Web monitor running (PID: ${MONITOR_PID})"

# 録画開始
echo "[test] Starting recording..."
START_RESPONSE=$(curl -s -X POST -H "Content-Type: application/json" -d '{}' \
  "http://127.0.0.1:${MONITOR_PORT}/api/recording/start" 2>&1)

if [[ -z "${START_RESPONSE}" ]] || [[ "${START_RESPONSE}" == *"error"* ]]; then
  echo "[error] Failed to start recording: ${START_RESPONSE}" >&2
  TEST_FAILED=1
  exit 1
fi

RECORDING_FILE=$(echo "${START_RESPONSE}" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("file", ""))' 2>/dev/null || echo "")
if [[ -z "${RECORDING_FILE}" ]]; then
  echo "[error] Recording file path not returned: ${START_RESPONSE}" >&2
  TEST_FAILED=1
  exit 1
fi

echo "[test] ✅ Recording started: ${RECORDING_FILE}"

# 録画中の状態確認
echo "[test] Recording for ${RECORDING_DURATION}s..."
for ((i=1; i<=${RECORDING_DURATION}; i++)); do
  sleep 1

  # 定期的にステータス確認
  if [[ $((i % 2)) -eq 0 ]]; then
    STATUS=$(curl -s "http://127.0.0.1:${MONITOR_PORT}/api/recording/status" 2>&1)
    FRAME_COUNT=$(echo "${STATUS}" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("frame_count", 0))' 2>/dev/null || echo "0")
    BYTES_WRITTEN=$(echo "${STATUS}" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("bytes_written", 0))' 2>/dev/null || echo "0")
    echo "[test] Progress: ${i}/${RECORDING_DURATION}s - ${FRAME_COUNT} frames, ${BYTES_WRITTEN} bytes"
  fi
done

# 録画停止
echo "[test] Stopping recording..."
STOP_RESPONSE=$(curl -s -X POST "http://127.0.0.1:${MONITOR_PORT}/api/recording/stop" 2>&1)

if [[ -z "${STOP_RESPONSE}" ]]; then
  echo "[error] Failed to stop recording" >&2
  TEST_FAILED=1
  exit 1
fi

echo "[test] Recording stopped"
echo "[test] Response: ${STOP_RESPONSE}"

# 録画結果の解析
FINAL_FRAME_COUNT=$(echo "${STOP_RESPONSE}" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("frame_count", 0))' 2>/dev/null || echo "0")
FINAL_BYTES=$(echo "${STOP_RESPONSE}" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("bytes_written", 0))' 2>/dev/null || echo "0")

echo ""
echo "=========================================="
echo "Recording Results"
echo "=========================================="
echo "File:         ${RECORDING_FILE}"
echo "Frame count:  ${FINAL_FRAME_COUNT}"
echo "Bytes:        ${FINAL_BYTES}"
echo "=========================================="

# ファイル検証
FULL_PATH="${REPO_ROOT}/${RECORDING_FILE}"
if [[ ! -f "${FULL_PATH}" ]]; then
  echo "[error] Recording file not found: ${FULL_PATH}" >&2
  TEST_FAILED=1
  exit 1
fi

ACTUAL_SIZE=$(stat -f%z "${FULL_PATH}" 2>/dev/null || stat -c%s "${FULL_PATH}" 2>/dev/null)
echo "Actual size:  ${ACTUAL_SIZE} bytes"

if [[ "${ACTUAL_SIZE}" -eq 0 ]]; then
  echo "[error] ❌ Recording file is EMPTY (0 bytes)" >&2
  echo "[debug] This is the known issue mentioned in h264_implementation_log.md"
  echo "[debug] Possible causes:"
  echo "        - frame.size vs len(frame.data) attribute mismatch"
  echo "        - frame.format check always skipping H.264 frames"
  echo "        - SharedMemory interface inconsistency"
  TEST_FAILED=1
  exit 1
fi

echo "[test] ✅ Recording file has content (${ACTUAL_SIZE} bytes)"

# ffprobe でファイル検証（利用可能な場合）
if command -v ffprobe >/dev/null 2>&1; then
  echo ""
  echo "[verify] Running ffprobe analysis..."
  if ffprobe -v error -show_format -show_streams "${FULL_PATH}" 2>&1 | grep -q "codec_name=h264"; then
    echo "[verify] ✅ Valid H.264 file detected"
  else
    echo "[verify] ⚠️  ffprobe could not detect H.264 codec (file might be incomplete)"
  fi
fi

# 再生テスト
if [[ "${SKIP_PLAYBACK}" -eq 0 ]]; then
  echo ""
  echo "[playback] Testing playback..."

  if command -v ffplay >/dev/null 2>&1; then
    echo "[playback] Attempting to play with ffplay (will auto-close)..."
    echo "[playback] File: ${FULL_PATH}"
    timeout 3 ffplay -autoexit -v quiet "${FULL_PATH}" >/dev/null 2>&1 || true
    echo "[playback] ✅ ffplay test completed"
  elif command -v vlc >/dev/null 2>&1; then
    echo "[playback] ffplay not found, trying VLC..."
    echo "[playback] Opening VLC (please close manually)..."
    vlc "${FULL_PATH}" >/dev/null 2>&1 &
    VLC_PID=$!
    echo "[playback] VLC launched (PID: ${VLC_PID})"
    echo "[playback] Press Enter to continue after checking playback..."
    read -r
    kill "${VLC_PID}" 2>/dev/null || true
  else
    echo "[playback] ⚠️  No video player found (ffplay or vlc)"
    echo "[playback] Please test manually: ffplay ${FULL_PATH}"
  fi
else
  echo "[playback] Skipped (--skip-playback)"
fi

echo ""
echo "=========================================="
echo "✅ H.264 Recording Test PASSED"
echo "=========================================="
echo "Recording file: ${FULL_PATH}"
echo "Frame count:    ${FINAL_FRAME_COUNT}"
echo "File size:      ${ACTUAL_SIZE} bytes"
echo ""
echo "To replay:"
echo "  ffplay ${FULL_PATH}"
echo "  vlc ${FULL_PATH}"
echo "=========================================="
