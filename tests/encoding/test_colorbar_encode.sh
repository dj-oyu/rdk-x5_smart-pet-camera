#!/bin/bash
# カラーバーエンコードテスト
# Usage: ./test_colorbar_encode.sh [cpu|hw|both] [duration_sec]

set -e

MODE="${1:-cpu}"
DURATION="${2:-3}"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
LOG_DIR="$(dirname "$0")/logs/${TIMESTAMP}_${MODE}_${DURATION}sec"
OUTPUT_DIR="$(dirname "$0")/output"

mkdir -p "$LOG_DIR"
mkdir -p "$OUTPUT_DIR"

echo "=== カラーバーエンコードテスト ==="
echo "Mode: $MODE"
echo "Duration: ${DURATION}s"
echo "Log Dir: $LOG_DIR"
echo ""

# 共通ffmpeg入力（カラーバー + 日時オーバーレイ）
FFMPEG_INPUT="-f lavfi -i testsrc=duration=${DURATION}:size=1280x720:rate=30"
FFMPEG_FILTER="-vf drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='%{localtime}':fontsize=48:fontcolor=white:x=10:y=10:box=1:boxcolor=black@0.5"

# システム監視開始（バックグラウンド）
start_monitoring() {
    local prefix=$1
    echo "Starting system monitoring..."

    # CPU監視
    mpstat 1 > "$LOG_DIR/${prefix}_mpstat.log" 2>&1 &
    MPSTAT_PID=$!

    # プロセス監視
    pidstat -u -r 1 > "$LOG_DIR/${prefix}_pidstat.log" 2>&1 &
    PIDSTAT_PID=$!

    # 温度監視
    (while true; do
        echo "$(date +%H:%M:%S) $(cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | tr '\n' ' ')"
        sleep 1
    done) > "$LOG_DIR/${prefix}_temp.log" 2>&1 &
    TEMP_PID=$!

    echo "  mpstat PID: $MPSTAT_PID"
    echo "  pidstat PID: $PIDSTAT_PID"
    echo "  temp PID: $TEMP_PID"
}

stop_monitoring() {
    echo "Stopping system monitoring..."
    kill $MPSTAT_PID $PIDSTAT_PID $TEMP_PID 2>/dev/null || true
    wait $MPSTAT_PID $PIDSTAT_PID $TEMP_PID 2>/dev/null || true
}

# CPUエンコード (libx264)
test_cpu_encode() {
    echo ""
    echo "--- CPU Encode (libx264) ---"
    local output="$OUTPUT_DIR/colorbar_cpu_${DURATION}s.mp4"

    start_monitoring "cpu"

    local start_time=$(date +%s.%N)

    ffmpeg -y $FFMPEG_INPUT $FFMPEG_FILTER \
        -c:v libx264 -preset ultrafast -crf 23 \
        "$output" \
        2>&1 | tee "$LOG_DIR/cpu_ffmpeg.log"

    local end_time=$(date +%s.%N)
    local elapsed=$(echo "$end_time - $start_time" | bc)

    stop_monitoring

    echo ""
    echo "CPU Encode Result:"
    echo "  Output: $output"
    echo "  Size: $(du -h "$output" | cut -f1)"
    echo "  Time: ${elapsed}s (video: ${DURATION}s)"
    echo "  Ratio: $(echo "scale=2; $elapsed / $DURATION" | bc)x realtime"

    # サマリー保存
    {
        echo "=== CPU Encode Summary ==="
        echo "Duration: ${DURATION}s"
        echo "Elapsed: ${elapsed}s"
        echo "Ratio: $(echo "scale=2; $elapsed / $DURATION" | bc)x"
        echo "Output Size: $(du -h "$output" | cut -f1)"
        echo "Preset: ultrafast"
    } > "$LOG_DIR/cpu_summary.txt"
}

# HWエンコード (V4L2 M2M)
test_hw_encode() {
    echo ""
    echo "--- HW Encode (h264_v4l2m2m) ---"
    local output="$OUTPUT_DIR/colorbar_hw_${DURATION}s.mp4"

    # V4L2エンコーダー確認
    if ! ffmpeg -encoders 2>/dev/null | grep -q h264_v4l2m2m; then
        echo "  ERROR: h264_v4l2m2m encoder not available"
        echo "  Skipping HW encode test"
        echo "h264_v4l2m2m not available" > "$LOG_DIR/hw_summary.txt"
        return 1
    fi

    start_monitoring "hw"

    local start_time=$(date +%s.%N)

    ffmpeg -y $FFMPEG_INPUT $FFMPEG_FILTER \
        -c:v h264_v4l2m2m \
        "$output" \
        2>&1 | tee "$LOG_DIR/hw_ffmpeg.log"

    local end_time=$(date +%s.%N)
    local elapsed=$(echo "$end_time - $start_time" | bc)

    stop_monitoring

    echo ""
    echo "HW Encode Result:"
    echo "  Output: $output"
    echo "  Size: $(du -h "$output" | cut -f1)"
    echo "  Time: ${elapsed}s (video: ${DURATION}s)"
    echo "  Ratio: $(echo "scale=2; $elapsed / $DURATION" | bc)x realtime"

    # サマリー保存
    {
        echo "=== HW Encode Summary ==="
        echo "Duration: ${DURATION}s"
        echo "Elapsed: ${elapsed}s"
        echo "Ratio: $(echo "scale=2; $elapsed / $DURATION" | bc)x"
        echo "Output Size: $(du -h "$output" | cut -f1)"
    } > "$LOG_DIR/hw_summary.txt"
}

# メイン処理
trap stop_monitoring EXIT

case "$MODE" in
    cpu)
        test_cpu_encode
        ;;
    hw)
        test_hw_encode
        ;;
    both)
        test_cpu_encode
        sleep 2
        test_hw_encode
        ;;
    *)
        echo "Usage: $0 [cpu|hw|both] [duration_sec]"
        exit 1
        ;;
esac

echo ""
echo "=== テスト完了 ==="
echo "Logs: $LOG_DIR"
echo "Output: $OUTPUT_DIR"
