# capture — C Camera Daemons & Shared Memory

## Overview
C言語によるカメラ制御、ISP設定、H.265エンコード、共有メモリ管理。

## Build & Run
```bash
cd src/capture && make
./build/camera_daemon_drobotics -C 1 -P 1 --daemon
```

## Key Constraints
- **H.265**: hb_mm_mc VPU encoder, 700kbps hard limit, GOP=fps, CBR
- **ISP**: runtime APIはAWB/3DNR/2DNRのみ動作。Gamma/WDR/CPROCは実行時変更不可
- **AWB夜間**: MANUAL必須（IR用）。ISP起動30フレーム後に適用
- **SHM**: O_RDWR必須（sem_wait使用時）。O_RDONLYだとSIGBUS
- **VIO**: hbn_vflow API (VIN→ISP→VSE)

## SHM Regions (6)
| Name | Purpose |
|------|---------|
| `/pet_camera_h265_zc` | H.265 stream zero-copy (encoder → Go streaming) |
| `/pet_camera_yolo_zc` | YOLO input zero-copy (unified, replaces zc_0/zc_1) |
| `/pet_camera_detections` | Detection results |
| `/pet_camera_mjpeg_zc` | MJPEG NV12 zero-copy |
| `/pet_camera_roi_zc_0` | Night ROI region 0 (640x640) |
| `/pet_camera_roi_zc_1` | Night ROI region 1 (640x640) |

定義元: `shm_constants.h`

## Docs
→ `docs/camera-and-isp.md`, `docs/shared-memory.md`
