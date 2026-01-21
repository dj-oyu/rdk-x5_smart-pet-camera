#!/bin/bash
# Convert NV12 files to PNG for viewing
# Requires ffmpeg

cd "/app/smart-pet-camera/test_pic"
for f in *.nv12; do
  [ -f "$f" ] || continue
  out="${f%.nv12}.png"
  echo "Converting $f -> $out"
  ffmpeg -y -f rawvideo -pixel_format nv12 -video_size 640x480 -i "$f" "$out" 2>/dev/null
done
echo ""
echo "Done. PNG files created in /app/smart-pet-camera/test_pic:"
ls -la *.png 2>/dev/null
