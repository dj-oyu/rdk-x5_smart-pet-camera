# detector — YOLO Detection Daemon

## Overview
Python YOLO検出デーモン。BPU (hobot_dnn) でINT8推論、結果をSHMに書き込む。

## Run
```bash
uv run src/detector/yolo_detector_daemon.py --yolo-model v11n
```

## Key Facts
- **Model**: YOLOv11n (3.3MB, 8.9ms BPU latency)
- **Input**: 640x640 NV12 (BPU INT8)
- **Day camera**: 640x360 → letterbox → 640x640, shift=`((input_h-h)//2, 0.0)`
- **Night camera**: 1280x720 → 3 ROI (50% overlap), round-robin ~22fps
- **Thresholds**: score=0.25, NMS=0.7
- **書き込みルール**: 検出1件以上の場合のみSHMに書き込む（0件は書き込まない）

## Docs
→ `docs/detection-and-yolo.md`
