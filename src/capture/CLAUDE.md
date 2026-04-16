# capture — C Camera Daemons & Shared Memory

## Overview
C言語によるカメラ制御、ISP設定、H.265エンコード、共有メモリ管理。

## Build
```bash
cd src/capture && make
make format       # clang-format-13
make check-format # CI format check
make lint         # clang-tidy (デバイス上のみ)
```

## Key Constraints
- **H.265**: hb_mm_mc VPU encoder, 700kbps CBR, GOP=fps
- **ISP**: runtime API は AWB/3DNR/2DNR のみ。Gamma/WDR/CPROC は実行時変更不可
- **AWB夜間**: MANUAL必須（IR用）。ISP起動30フレーム後に適用
- **SHM**: O_RDWR必須（sem_wait使用時）。O_RDONLYだとSIGBUS
- **VIO**: hbn_vflow API (VIN→ISP→VSE)

## SHM Regions (4)
定義元: `shm_constants.h`

| Name | Purpose |
|------|---------|
| `/pet_camera_h265_zc` | H.265 zero-copy (encoder → Go) |
| `/pet_camera_yolo_zc` | YOLO input zero-copy |
| `/pet_camera_detections` | Detection results |
| `/pet_camera_mjpeg_zc` | MJPEG NV12 zero-copy |

## Coding
- `const` = read-only view。引数ポインタは書き換えない場合 `const T *`
- 大きな struct は常にポインタ渡し
- C ヘッダ変更後は `./scripts/build.sh capture monitor` (CGo再ビルド必要)

## Docs
→ `docs/camera-and-isp.md`, `docs/shared-memory.md`
