#!/bin/bash
# 並行動作テスト（ペットカメラ稼働中にエンコード）
# Usage: ./test_parallel_encode.sh [cpu|hw] [duration_sec]
#
# 前提: 別ターミナルでペットカメラが稼働中であること
#   ./scripts/run_camera_switcher_yolo_streaming.sh

set -e

MODE="${1:-cpu}"
DURATION="${2:-3}"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
LOG_DIR="$(dirname "$0")/logs/${TIMESTAMP}_parallel_${MODE}_${DURATION}sec"
OUTPUT_DIR="$(dirname "$0")/output"

mkdir -p "$LOG_DIR"
mkdir -p "$OUTPUT_DIR"

echo "=== 並行動作テスト ==="
echo "Mode: $MODE"
echo "Duration: ${DURATION}s"
echo "Log Dir: $LOG_DIR"
echo ""

# ペットカメラプロセス確認
echo "1. ペットカメラプロセス確認:"
echo "---"
CAMERA_PROCS=$(pgrep -f "camera_daemon|yolo_detector|web_monitor" 2>/dev/null || true)
if [ -z "$CAMERA_PROCS" ]; then
    echo "  WARNING: ペットカメラプロセスが見つかりません"
    echo "  別ターミナルで起動してください:"
    echo "    ./scripts/run_camera_switcher_yolo_streaming.sh"
    echo ""
    read -p "続行しますか? (y/N): " confirm
    if [ "$confirm" != "y" ]; then
        exit 1
    fi
else
    echo "  検出されたプロセス:"
    ps aux | grep -E "camera_daemon|yolo_detector|web_monitor" | grep -v grep | head -5
fi
echo ""

# 共通ffmpeg入力
FFMPEG_INPUT="-f lavfi -i testsrc=duration=${DURATION}:size=1280x720:rate=30"
FFMPEG_FILTER="-vf drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='%{localtime}':fontsize=48:fontcolor=white:x=10:y=10:box=1:boxcolor=black@0.5"

# エンコーダー選択
if [ "$MODE" = "hw" ]; then
    ENCODER="-c:v h264_v4l2m2m"
    ENCODER_NAME="h264_v4l2m2m"
else
    ENCODER="-c:v libx264 -preset ultrafast -crf 23"
    ENCODER_NAME="libx264"
fi

echo "2. システム状態（エンコード前）:"
echo "---"
{
    echo "=== Before Encoding ==="
    echo "Time: $(date)"
    echo ""
    echo "CPU:"
    mpstat 1 1 | tail -2
    echo ""
    echo "Memory:"
    free -m
    echo ""
    echo "Temperature:"
    cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | tr '\n' ' '
    echo ""
    echo ""
    echo "Camera-related processes:"
    ps aux | grep -E "camera_daemon|yolo_detector|web_monitor|ffmpeg" | grep -v grep || true
} | tee "$LOG_DIR/before_state.txt"
echo ""

# システム監視開始
echo "3. システム監視開始..."
mpstat 1 > "$LOG_DIR/mpstat.log" 2>&1 &
MPSTAT_PID=$!

pidstat -u -r 1 > "$LOG_DIR/pidstat.log" 2>&1 &
PIDSTAT_PID=$!

(while true; do
    echo "$(date +%H:%M:%S) $(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | tr '\n' ' ')"
    sleep 1
done) > "$LOG_DIR/temp.log" 2>&1 &
TEMP_PID=$!

# カメラFPS監視（APIから取得を試みる）
(while true; do
    FPS=$(curl -s http://localhost:8080/api/status 2>/dev/null | grep -o '"fps":[0-9.]*' | cut -d: -f2 || echo "N/A")
    echo "$(date +%H:%M:%S) FPS: $FPS"
    sleep 1
done) > "$LOG_DIR/camera_fps.log" 2>&1 &
FPS_PID=$!

cleanup() {
    echo "Stopping monitoring..."
    kill $MPSTAT_PID $PIDSTAT_PID $TEMP_PID $FPS_PID 2>/dev/null || true
    wait $MPSTAT_PID $PIDSTAT_PID $TEMP_PID $FPS_PID 2>/dev/null || true
}
trap cleanup EXIT

sleep 2  # 監視開始を待つ

# エンコード実行
echo ""
echo "4. エンコード実行 ($ENCODER_NAME):"
echo "---"
OUTPUT="$OUTPUT_DIR/parallel_${MODE}_${DURATION}s.mp4"

START_TIME=$(date +%s.%N)

# nice -n 19 で低優先度実行
nice -n 19 ffmpeg -y $FFMPEG_INPUT $FFMPEG_FILTER \
    $ENCODER \
    "$OUTPUT" \
    2>&1 | tee "$LOG_DIR/ffmpeg.log"

END_TIME=$(date +%s.%N)
ELAPSED=$(echo "$END_TIME - $START_TIME" | bc)

sleep 2  # 監視データ収集を待つ

echo ""
echo "5. システム状態（エンコード後）:"
echo "---"
{
    echo "=== After Encoding ==="
    echo "Time: $(date)"
    echo ""
    echo "CPU:"
    mpstat 1 1 | tail -2
    echo ""
    echo "Memory:"
    free -m
    echo ""
    echo "Temperature:"
    cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | tr '\n' ' '
    echo ""
} | tee "$LOG_DIR/after_state.txt"

# 結果サマリー
echo ""
echo "=== 結果サマリー ==="
{
    echo "=== Parallel Encode Test Summary ==="
    echo "Date: $(date)"
    echo "Mode: $MODE ($ENCODER_NAME)"
    echo "Duration: ${DURATION}s"
    echo "Elapsed: ${ELAPSED}s"
    echo "Ratio: $(echo "scale=2; $ELAPSED / $DURATION" | bc)x realtime"
    echo "Output: $OUTPUT"
    echo "Output Size: $(du -h "$OUTPUT" | cut -f1)"
    echo ""
    echo "Camera FPS during encoding:"
    if [ -f "$LOG_DIR/camera_fps.log" ]; then
        cat "$LOG_DIR/camera_fps.log" | tail -10
    fi
    echo ""
    echo "Peak CPU usage (from pidstat):"
    if [ -f "$LOG_DIR/pidstat.log" ]; then
        grep -E "ffmpeg|camera|yolo|web_monitor" "$LOG_DIR/pidstat.log" | sort -k8 -rn | head -5 || true
    fi
} | tee "$LOG_DIR/summary.txt"

echo ""
echo "=== テスト完了 ==="
echo "Logs: $LOG_DIR"
