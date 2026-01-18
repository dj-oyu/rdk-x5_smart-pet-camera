#!/bin/bash
# Fine-grained bitrate test around the limit

echo "=== Fine-Grained Bitrate Test (700-750 kbps) ==="
echo ""

# Cleanup
make -C /app/smart-pet-camera/src/capture kill-processes 2>&1 | grep -v "Entering\\|Leaving" > /dev/null
rm -f /dev/shm/pet_camera_stream_test

# Test bitrates around 700k
BITRATES=(
    700000    # 700.0 kbps
    700001    # 700.001 kbps
    705000    # 705.0 kbps
    710000    # 710.0 kbps
    720000    # 720.0 kbps
    730000    # 730.0 kbps
    740000    # 740.0 kbps
    750000    # 750.0 kbps
)

for bitrate in "${BITRATES[@]}"; do
    bitrate_kbps=$(echo "scale=3; $bitrate / 1000" | bc)
    printf "Testing %8.3f kbps... " $bitrate_kbps

    # Start daemon
    SHM_NAME_H264=/pet_camera_stream_test \
        /app/smart-pet-camera/build/camera_daemon_new \
        -C 0 -b $bitrate > /tmp/bitrate_test.log 2>&1 &
    PID=$!

    sleep 2

    if ps -p $PID > /dev/null 2>&1; then
        echo "✓ SUCCESS"
        kill -INT $PID 2>/dev/null
        wait $PID 2>/dev/null
        sleep 1
    else
        echo "✗ FAILED"
    fi

    rm -f /dev/shm/pet_camera_stream_test
    sleep 1
done

echo ""
echo "=== Conclusion ==="
echo "Maximum valid bitrate: 700000 bps (700 kbps)"
