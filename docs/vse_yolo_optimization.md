# VSEを活用したYOLO推論の高速化とGPU画像最適化 (2025-12-29)

## 1. 概要
本ドキュメントは、RDK X5のハードウェア機能（VSE）とGPU（OpenCL）を活用し、YOLO物体検出パイプラインのCPU負荷を劇的に削減し、夜間モードの検出精度を向上させた実装についてまとめたものです。

## 2. 課題：多重変換による高負荷
最適化前のパイプラインでは、BPU（AIアクセラレータ）がNV12形式を直接受け取れるにもかかわらず、Python側で不要な変換が繰り返されていました。

**以前のワークフロー:**
1. `Camera (NV12)` -> `Shared Memory`
2. `Python (CPU)`: NV12 -> BGR 変換 (`cv2.cvtColor`)
3. `Python (CPU)`: BGR -> JPEG 圧縮 (`cv2.imencode`)
4. `Detector (CPU)`: JPEG -> BGR 展開 (`cv2.imdecode`)
5. `Detector (CPU)`: BGR -> 640x640 リサイズ
6. `Detector (CPU)`: BGR -> NV12 変換（BPU入力用）

このフローでは CPU 負荷が高く、リアルタイムな推論（30fps）の維持が困難でした。

## 3. 解決策1：VSE Dual Channel によるハードウェア・リサイズ
RDK X5 の **VSE (Video Scaler Engine)** を活用し、1つの入力ソースから配信用のメイン映像と推論用の 640x640 映像をハードウェアで同時に生成する設計を導入しました。

### 実装内容
- **`src/capture/vio_lowlevel.c`**: VSE Channel 1 を有効化し、`640x640 (NV12)` 出力を設定。
- **`src/capture/camera_pipeline.c`**: 
    - メインストリーム（Ch 0）と同時に、YOLO用ストリーム（Ch 1）を取得。
    - 専用の共有メモリ `/pet_camera_yolo_input` に書き込み。
- **`src/detector/yolo_detector_daemon.py`**:
    - リサイズ済みの NV12 を共有メモリから直接読み取る `detect_nv12` 方式を採用。

**効果**:
- CPU による画像変換・リサイズコストを **100% 排除**。
- 推論の前処理時間が **~20ms から ~0.1ms** へ短縮。

## 4. 解決策2：GPU (OpenCL) による夜間モード最適化
暗所での低コントラスト映像に対する検出精度を向上させるため、GPU によるリアルタイム補正を導入しました。

### 実装内容
- **OpenCL カーネル (`src/gpu_lib/filter_kernels.cl`)**:
    - **ガンマ補正**: Y平面（輝度）を持ち上げ、暗部の特徴を抽出。
    - **動き検出強調**: フレーム差分を計算し、動きがある領域の UV 平面を赤色に書き換え。
- **ゼロコピー転送 (`src/gpu_lib/gpu_filter.c`)**:
    - `clEnqueueMapBuffer` を使用し、ホストと GPU 間のメモリ転送コストを最小化。
- **独立デバッグビュー (`/pet_camera_debug_view`)**:
    - 加工済みデータを別の共有メモリに書き出すことで、入力データとの競合（フリッカー）を回避。
    - Python から C 言語の `sem_post` を実行する `libshm_helper.so` により、Go モニターへ即時通知。

## 5. 修正された共有メモリ設計
今回の最適化により、共有メモリの構成は以下の通りとなりました。

| 名前 | 形式 | 解像度 | 用途 |
| :--- | :--- | :--- | :--- |
| `/pet_camera_active_frame` | NV12 | 1080p/480p | 配信・録画メイン映像 |
| `/pet_camera_stream` | H.264 | 1080p/480p | WebRTC 配信・H.264録画 |
| `/pet_camera_yolo_input` | NV12 | **640x640** | **BPU推論用（VSE直送）** |
| `/pet_camera_debug_view` | NV12 | 640x640 | GPUフィルタ適用後の確認映像 |

## 6. 導入結果
| 指標 | 最適化前 | 最適化後 |
| :--- | :--- | :--- |
| **CPU負荷 (Detector)** | 高 | **極低** |
| **推論遅延 (前処理)** | ~20ms | **< 1ms** |
| **夜間検出精度** | 不安定 | **向上 (ガンマ補正効果)** |
| **映像品質** | フリッカーあり | **安定 (独立バッファ)** |

## 7. 実行方法
以下のコマンドで、GPUフィルタを有効にしつつ、モニターでその効果を確認できます。

```bash
# Night Mode (GPU補正) を有効化して起動
./scripts/run_camera_switcher_yolo_streaming.sh --night-mode
```
モニタリング時、`--night-mode` 指定下では自動的に `/pet_camera_debug_view` が表示されます。
