#!/bin/bash
# AWB & ISP tuning batch test for night (IR) camera
# Tests various AWB gains, WDR, and gamma settings, saving a frame for each.
#
# Usage: bash scripts/test_awb_patterns.sh
# Prerequisites: camera daemons must be stopped first

set -e

TOOL="./build/test_awb_tuning"
OUTPUT_DIR="./test_pic"

if [ ! -f "$TOOL" ]; then
  echo "Building test_awb_tuning..."
  make -C src/capture awb-tuning
fi

# Check if camera daemons are running
if pgrep -f camera_daemon > /dev/null 2>&1 || pgrep -f camera_switcher > /dev/null 2>&1; then
  echo "ERROR: Camera daemons are running. Stop them first:"
  echo "  pkill -f camera_switcher_daemon; sleep 1; pkill -f camera_daemon_drobotics"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

echo "=== AWB & ISP Batch Test (Night Camera) ==="
echo "Frames will be saved to: $OUTPUT_DIR/awb_*.nv12"
echo ""

# Feed commands to the interactive tool via stdin
# Each test: set params -> pause 2s for ISP to settle -> save frame -> dump
cat <<'COMMANDS' | "$TOOL" --camera 1
d
p 3
s 00_default_auto
da

m 1.0 1.0 1.0
p 2
s 01_manual_neutral
da

m 1.0 1.0 1.3
p 2
s 02_cool_light

m 1.0 1.0 1.6
p 2
s 03_cool_medium

m 1.0 1.0 2.0
p 2
s 04_cool_strong

m 1.0 1.0 2.5
p 2
s 05_cool_extreme

m 0.8 1.0 1.6
p 2
s 06_cool_reduced_red

m 1.3 1.0 1.0
p 2
s 07_warm_light

m 1.5 1.0 0.8
p 2
s 08_warm_strong

m 1.0 1.0 1.0
p 1

w 128 100
p 2
s 10_wdr_str128_dark100
dw

w 128 200
p 2
s 11_wdr_str128_dark200

w 200 200
p 2
s 12_wdr_str200_dark200

w 255 255
p 2
s 13_wdr_max

w 64 255
p 2
s 14_wdr_str64_dark255

w 128 100
m 1.0 1.0 1.6
p 2
s 20_combo_cool_wdr

w 200 200
m 1.0 1.0 1.6
p 2
s 21_combo_cool_wdr_strong

w 128 200
m 0.8 1.0 1.8
p 2
s 22_combo_cool_lessred_wdr

g 0.6
p 2
s 30_gamma_0.6
dg

g 0.4
p 2
s 31_gamma_0.4

g 0.8
p 2
s 32_gamma_0.8

g 1.0
p 1

c 30 1.2 1.0
p 2
s 40_cproc_bright30
dc

c 50 1.5 1.0
p 2
s 41_cproc_bright50

c 0 1.0 1.0
p 1

a
p 2
s 99_restored_auto
d

q
COMMANDS

echo ""
echo "=== Test Complete ==="
echo "Saved frames in $OUTPUT_DIR:"
ls -la "$OUTPUT_DIR"/awb_*  2>/dev/null | tail -30
echo ""
echo "View frames with:"
echo "  ffplay -f rawvideo -pix_fmt nv12 -s 1920x1080 $OUTPUT_DIR/awb_YYMMDD_HHMMSS_NAME.nv12"
