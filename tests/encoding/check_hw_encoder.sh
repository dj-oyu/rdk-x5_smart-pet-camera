#!/bin/bash
# HWエンコーダー確認スクリプト

set -e

echo "=== RDK-X5 HWエンコーダー確認 ==="
echo ""

echo "1. V4L2デバイス一覧:"
echo "---"
ls -la /dev/video* 2>/dev/null || echo "  (デバイスなし)"
echo ""

echo "2. V4L2デバイス詳細:"
echo "---"
if command -v v4l2-ctl &> /dev/null; then
    v4l2-ctl --list-devices 2>/dev/null || echo "  (デバイスなし)"
else
    echo "  v4l2-ctl未インストール: sudo apt install v4l-utils"
fi
echo ""

echo "3. ffmpeg V4L2エンコーダー:"
echo "---"
ffmpeg -encoders 2>/dev/null | grep -i v4l2 || echo "  (V4L2エンコーダーなし)"
echo ""

echo "4. ffmpeg 全H.264エンコーダー:"
echo "---"
ffmpeg -encoders 2>/dev/null | grep -i 264 || echo "  (H.264エンコーダーなし)"
echo ""

echo "5. hobot-multimedia確認:"
echo "---"
if [ -d "/usr/include/hobot" ] || [ -d "/opt/hobot" ]; then
    echo "  hobot-multimedia: インストール済み"
    ls /usr/lib/*hobot* 2>/dev/null || ls /opt/hobot/lib/* 2>/dev/null || true
else
    echo "  hobot-multimedia: 未検出"
fi
echo ""

echo "6. システム情報:"
echo "---"
echo "  Kernel: $(uname -r)"
echo "  CPU: $(nproc) cores"
cat /proc/cpuinfo | grep "model name" | head -1 | sed 's/model name\s*:/  CPU Model:/' || true
echo ""

echo "=== 確認完了 ==="
