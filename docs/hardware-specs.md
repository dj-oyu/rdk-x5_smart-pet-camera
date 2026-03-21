# RDK X5 ハードウェアスペック

## 概要

D-Robotics RDK X5 (Linux aarch64) のGPU・アクセラレータ調査結果。標準V4L2/GStreamerハードウェアアクセラレーションは利用不可。代わりにD-Robotics独自の「Horizon Video Processing Framework (VPF)」を使用（`libspcdev`, `libvpf`, `libcam`）。

## GPU: Vivante GC8000L

| 項目 | 値 |
|------|-----|
| デバイス | Vivante OpenCL Device GC8000L.6214.0000 |
| API | OpenCL 3.0 V6.4.14.9.674707 |
| Compute Units | 1 |
| Global Memory | 256 MB（共有システムRAM） |
| Local Memory | 32 KB |
| Max Work Group Size | 1024 |
| 計算性能 | ~6.75 GFLOPS (FP32) |
| OpenCLライブラリ | `/usr/hobot/lib/libOpenCL.so` |

### メモリ帯域ベンチマーク

| メトリクス | 結果 | 備考 |
|-----------|------|------|
| Host → Device (Copy) | 2.54 GB/s | `clEnqueueWriteBuffer` |
| Device → Host (Copy) | **0.07 GB/s** | 致命的ボトルネック。使用禁止 |
| Device → Device | 3.45 GB/s | GPU内部コピー |
| Map (Write) → Unmap | **5.07 GB/s** | `CL_MEM_ALLOC_HOST_PTR`（ゼロコピー） |
| Map (Read) → Unmap | **>1000 GB/s** | 即座のマッピング（ゼロコピー成功） |

### ゼロコピーパターン（推奨）

```c
// 割り当て: CL_MEM_ALLOC_HOST_PTR でCPU/GPU共有メモリを使用
clCreateBuffer(..., CL_MEM_READ_WRITE | CL_MEM_ALLOC_HOST_PTR, ...)

// アクセス: Map/Unmapを使用
clEnqueueMapBuffer(...)

// 禁止: clEnqueueReadBuffer / clEnqueueWriteBuffer
```

Device→Host Copyの0.07 GB/sはキャッシュフラッシュまたはDMA未使用が原因。ゼロコピーならシステムRAM速度でアクセス可能。

## BPU (Brain Processing Unit)

| 項目 | 値 |
|------|-----|
| デバイス | `/dev/bpu` |
| ライブラリ | `libcnn_intf.so` |
| 用途 | AI/テンソル演算（YOLO等） |

GPUの6.75 GFLOPSでは最新のオブジェクト検出は不可能。AI推論にはBPUを使用すること。

## VPU (Video Processing Unit)

| 項目 | 値 |
|------|-----|
| デバイス | `/dev/vpu` |
| ライブラリ | `/usr/hobot/lib/libvpf.so`, `libcam.so`, `libspcdev` |
| H.265 | Main Profile @ L5.1 |
| H.264 | Baseline/Main/High Profiles @ L5.2 |
| 最大解像度 | 3840x2160@60fps エンコード/デコード |
| HW JPEGエンコーダー | `hobot_jpu.ko`（ユーザーランドAPI未発見） |

ビデオエンコードは `camera_daemon_drobotics.c` で `libspcdev`/`libvpf` 経由で実装済み。GStreamer/V4L2への移行は不要。

## GPU活用の優先度

| 用途 | 価値 | 理由 |
|------|------|------|
| NV12→RGB変換 | 高 | メモリバウンド処理。ゼロコピーで低レイテンシ。CPU解放 |
| モーション検出前処理 | 中 | 差分計算・閾値処理・モルフォロジー演算をオフロード可能 |
| AI/ディープラーニング | 低 | 6.75 GFLOPSでは不足。BPUを使用 |
| ビデオエンコード | 低 | VPU経由の既存実装を継続 |

## 制約事項

- 標準V4L2デバイスノード (`/dev/video*`) によるHWアクセラレーションは利用不可
- D-Robotics独自APIを使用する必要あり
- `clEnqueueReadBuffer`は0.07 GB/sのため実用不可（必ずMap/Unmapを使用）
- GPU計算性能は6.75 GFLOPSと控えめ（メモリバウンド処理向き）
