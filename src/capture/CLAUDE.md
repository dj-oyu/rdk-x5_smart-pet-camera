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

## Coding Conventions

### const ポリシー
`const` は **read-only view (不変参照)** の意味で使う。immutable (オブジェクト自体の不変性) ではない。

**関数引数:**
- ポインタ引数はその関数内で struct を書き換えない場合 `const T *` にする
- HW 副作用がある関数 (`vio_stop`, `vio_release_frame*`) も ctx struct を書き換えないなら `const` — `FILE *` との違いは `FILE` 内部状態を書き換えるから non-const なのであって、副作用の有無ではない
- ベンダー API がハンドルを値渡しで受け取る場合は問題なし

現在 const 化済み:
- `vio_start/stop`, `vio_get_frame*`, `vio_release_frame*` → `const vio_context_t *ctx`
- `encoder_thread_push_frame` → `const hbn_vnode_image_t *vse_frame`
- `shm_detection_read` → `const LatestDetectionResult *shm`

**ローカル変数:**
- 代入後に変更しない変数はすべて `const` にする (`const int ch = 3 + roi_index;` 等)
- `T *const ptr` (ポインタ自体が不変): `encoder = &ctx->codec_ctx` のようにポインタを再代入しない場合

### その他のルール
- 不要なコピー・ヒープ利用・値渡しは禁止
- 大きな struct は常にポインタ渡し

### フォーマット / Lint
```bash
make format        # clang-format-13 で全 .c/.h を整形
make check-format  # フォーマット検査 (CI で使用)
make lint          # clang-tidy 静的解析 (デバイス上のみ、ベンダーヘッダ必要)
```

設定ファイル: `.clang-format`, `.clang-tidy`

> **注意**: C ヘッダ変更後は Go の `web_monitor` も再ビルドが必要。
> CGo はヘッダを compile-time に embed するため、`make format` 後は `./scripts/build.sh capture monitor` を実行すること。

## Docs
→ `docs/camera-and-isp.md`, `docs/shared-memory.md`
