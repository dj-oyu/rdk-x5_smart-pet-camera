#!/bin/bash
# Collect GPU and Hardware Information

OUTPUT_FILE="gpu_investigation/system_info.txt"
echo "Collecting system info to $OUTPUT_FILE..."

{
    echo "=== Date ==="
    date
    echo ""

    echo "=== Kernel Info ==="
    uname -a
    echo ""

    echo "=== CPU Info ==="
    lscpu
    echo ""

    echo "=== Memory Info ==="
    free -h
    echo ""

    echo "=== PCI Devices ==="
    lspci 2>/dev/null || echo "lspci not available"
    echo ""

    echo "=== V4L2 Devices ==="
    if command -v v4l2-ctl >/dev/null; then
        v4l2-ctl --list-devices
    else
        echo "v4l2-ctl not found"
    fi
    echo ""

    echo "=== V4L2 Formats (Device 0) ==="
    if command -v v4l2-ctl >/dev/null; then
        v4l2-ctl -d /dev/video0 --list-formats-ext 2>/dev/null || echo "Could not query /dev/video0"
    fi
    echo ""
     echo "=== V4L2 Formats (Device 8) ==="
    if command -v v4l2-ctl >/dev/null; then
        v4l2-ctl -d /dev/video8 --list-formats-ext 2>/dev/null || echo "Could not query /dev/video8"
    fi
    echo ""

    echo "=== Device Nodes (Video/NPU/BPU/VPU) ==="
    ls -l /dev/video* 2>/dev/null
    ls -l /dev/vpu* 2>/dev/null
    ls -l /dev/npu* 2>/dev/null
    ls -l /dev/bpu* 2>/dev/null
    echo ""

    echo "=== Sysfs BPU/VPU info ==="
    find /sys/class -name "*bpu*" 2>/dev/null
    find /sys/class -name "*vpu*" 2>/dev/null
    echo ""

    echo "=== OpenCL Libraries ==="
    ls -l /usr/lib/libOpenCL* 2>/dev/null
    ls -l /usr/lib/aarch64-linux-gnu/libOpenCL* 2>/dev/null
    ls -l /usr/hobot/lib/libOpenCL* 2>/dev/null
    echo ""

} > "$OUTPUT_FILE" 2>&1

echo "Done. Info saved to $OUTPUT_FILE"
