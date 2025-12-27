#!/bin/bash
# Test dual camera with new 3-layer architecture daemon

echo "=== Starting Dual Camera Test (New Architecture) ==="

# Cleanup
make -C /app/smart-pet-camera/src/capture kill-processes 2>&1 | grep -v "Entering\\|Leaving"
rm -f /dev/shm/pet_camera_stream_day /dev/shm/pet_camera_stream_night

# Start Camera 0 (Day)
echo "[Camera 0] Starting..."
SHM_NAME_H264=/pet_camera_stream_day /app/smart-pet-camera/build/camera_daemon_new -C 0 > /tmp/daemon_cam0.log 2>&1 &
CAM0_PID=$!
echo "[Camera 0] PID: $CAM0_PID"

sleep 3

# Start Camera 1 (Night)
echo "[Camera 1] Starting..."
SHM_NAME_H264=/pet_camera_stream_night /app/smart-pet-camera/build/camera_daemon_new -C 1 > /tmp/daemon_cam1.log 2>&1 &
CAM1_PID=$!
echo "[Camera 1] PID: $CAM1_PID"

sleep 5

# Check processes
echo ""
echo "=== Process Status ==="
ps -fp $CAM0_PID 2>/dev/null || echo "[Camera 0] Process NOT running"
ps -fp $CAM1_PID 2>/dev/null || echo "[Camera 1] Process NOT running"

echo ""
echo "=== Shared Memory Status ==="
ls -lh /dev/shm/pet_camera_stream_* 2>/dev/null || echo "No shared memory segments found"

echo ""
echo "=== Camera 0 Log (last 30 lines) ==="
tail -30 /tmp/daemon_cam0.log

echo ""
echo "=== Camera 1 Log (last 30 lines) ==="
tail -30 /tmp/daemon_cam1.log

# Wait 10 seconds
echo ""
echo "=== Running for 10 seconds... ==="
sleep 10

# Get final logs
echo ""
echo "=== Camera 0 Final Log (last 10 lines) ==="
tail -10 /tmp/daemon_cam0.log

echo ""
echo "=== Camera 1 Final Log (last 10 lines) ==="
tail -10 /tmp/daemon_cam1.log

# Stop cameras
echo ""
echo "=== Stopping cameras ==="
kill -INT $CAM0_PID 2>/dev/null && echo "[Camera 0] Stopped" || echo "[Camera 0] Already stopped"
kill -INT $CAM1_PID 2>/dev/null && echo "[Camera 1] Stopped" || echo "[Camera 1] Already stopped"

sleep 2

echo ""
echo "=== Test Complete ==="
