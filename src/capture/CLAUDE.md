# capture — C Camera Daemons & Shared Memory

## Overview
C言語によるカメラ制御、ISP設定、H.264エンコード、共有メモリ管理。

## Build & Run
```bash
cd src/capture && make
./build/camera_daemon_drobotics -C 1 -P 1 --daemon
```

## Key Constraints
- **H.264**: libspcdev, 700kbps hard limit, GOP=14
- **ISP**: runtime APIはAWB/3DNR/2DNRのみ動作。Gamma/WDR/CPROCは実行時変更不可
- **AWB夜間**: MANUAL必須（IR用）。ISP起動30フレーム後に適用
- **SHM**: O_RDWR必須（sem_wait使用時）。O_RDONLYだとSIGBUS
- **フレーム取得**: `sp_vio_get_frame()` を使う（`sp_vio_get_yuv()` は色空間不一致）

## SHM Regions (9)
| Name | Size | Purpose |
|------|------|---------|
| `/pet_camera_control` | 8B | Active camera index |
| `/pet_camera_zc_0`, `zc_1` | ~150B | DAY/NIGHT zero-copy frames |
| `/pet_camera_h264_zc_0`, `h264_zc_1` | ~150B | H.264 zero-copy frames |
| `/pet_camera_stream` | ~93MB | H.264 ring buffer |
| `/pet_camera_mjpeg_frame` | ~1.4MB | MJPEG frame |
| `/pet_camera_detections` | ~584B | Detection results |

## Docs
→ `docs/camera-and-isp.md`, `docs/shared-memory.md`
