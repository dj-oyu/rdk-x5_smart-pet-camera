#!/bin/bash
# Test bitrate limits for H.264 encoder

echo "=== Testing Bitrate Limits ==="
echo ""

# Cleanup
make -C /app/smart-pet-camera/src/capture kill-processes 2>&1 | grep -v "Entering\\|Leaving"
rm -f /dev/shm/pet_camera_stream_test

# Test bitrates (in bps)
BITRATES=(
    100000    # 100 kbps
    200000    # 200 kbps
    300000    # 300 kbps
    400000    # 400 kbps
    500000    # 500 kbps
    600000    # 600 kbps
    650000    # 650 kbps
    700000    # 700 kbps
    750000    # 750 kbps
    800000    # 800 kbps
    850000    # 850 kbps
    900000    # 900 kbps
    1000000   # 1000 kbps (1 Mbps)
    1500000   # 1500 kbps (1.5 Mbps)
    2000000   # 2000 kbps (2 Mbps)
)

RESULTS_FILE="/tmp/bitrate_test_results.txt"
echo "Bitrate (kbps), Status, Error Message" > $RESULTS_FILE

for bitrate in "${BITRATES[@]}"; do
    bitrate_kbps=$((bitrate / 1000))
    echo -n "Testing ${bitrate_kbps} kbps... "

    # Start daemon with specific bitrate
    SHM_NAME_H264=/pet_camera_stream_test \
        /app/smart-pet-camera/build/camera_daemon_new \
        -C 0 -b $bitrate > /tmp/bitrate_test.log 2>&1 &
    PID=$!

    # Wait a bit for initialization
    sleep 2

    # Check if process is still running
    if ps -p $PID > /dev/null 2>&1; then
        echo "SUCCESS"
        echo "${bitrate_kbps}, SUCCESS, -" >> $RESULTS_FILE

        # Let it run for 3 seconds to verify stability
        sleep 3

        # Kill the process
        kill -INT $PID 2>/dev/null
        wait $PID 2>/dev/null
    else
        # Process died, check error
        ERROR_MSG=$(grep -i "invalid.*bit rate\|error" /tmp/bitrate_test.log | head -1 | sed 's/.*\[ERROR\]//')
        echo "FAILED"
        echo "${bitrate_kbps}, FAILED, ${ERROR_MSG}" >> $RESULTS_FILE
    fi

    # Cleanup
    rm -f /dev/shm/pet_camera_stream_test
    sleep 1
done

echo ""
echo "=== Test Results ==="
cat $RESULTS_FILE | column -t -s','

echo ""
echo "=== Summary ==="
MAX_SUCCESS=$(grep "SUCCESS" $RESULTS_FILE | tail -1 | cut -d',' -f1 | tr -d ' ')
MIN_FAILURE=$(grep "FAILED" $RESULTS_FILE | head -1 | cut -d',' -f1 | tr -d ' ')

if [ -n "$MAX_SUCCESS" ]; then
    echo "Maximum successful bitrate: ${MAX_SUCCESS} kbps"
fi

if [ -n "$MIN_FAILURE" ]; then
    echo "Minimum failed bitrate: ${MIN_FAILURE} kbps"
fi

echo ""
echo "Full log of last test: /tmp/bitrate_test.log"
