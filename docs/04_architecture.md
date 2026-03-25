# システムアーキテクチャ - スマートペットカメラ

## 全体アーキテクチャ

### システム構成図 [実装済]

```mermaid
graph TD
    subgraph system["Smart Pet Camera System<br/>(D-Robotics RDK X5)"]
        subgraph streaming["Streaming Layer (Go)"]
            webrtc["Go WebRTC Server<br/>pion/webrtc v4<br/>:8081<br/>- H.265 passthrough<br/>- MJPEG endpoint<br/>- VPS/SPS/PPS cache<br/>- 録画 (NAL capture)"]
            webmonitor["Go web_monitor<br/>Preact SPA 配信<br/>:8080<br/>- API プロキシ → :8081<br/>- アルバム UI"]
        end

        subgraph shm["Shared Memory Layer (6領域)"]
            h265zc["/pet_camera_h265_zc<br/>H.265 zero-copy"]
            mjpegzc["/pet_camera_mjpeg_zc<br/>MJPEG NV12 zero-copy"]
            yolozc["/pet_camera_yolo_zc<br/>YOLO input zero-copy"]
            roizc["/pet_camera_roi_zc_0, roi_zc_1<br/>Night ROI 640x640"]
            detections["/pet_camera_detections<br/>YOLO detection results"]
        end

        subgraph capture["Capture Layer (C)"]
            daemon["camera_daemon_drobotics<br/>Single process, multi-thread<br/>- Pipeline thread x2 (DAY/NIGHT)<br/>- Switcher thread (brightness polling)<br/>- hbn_vflow → YUV capture<br/>- hb_mm_mc → H.265 encode<br/>- 600kbps / GOP=fps<br/>- コミック自動キャプチャ"]
        end

        subgraph detect["Detection Layer (Python)"]
            yolo["YOLOv11n on BPU (INT8)<br/>8.9ms inference<br/>DAY: 640x360→letterbox→640x640<br/>NIGHT: ROI round-robin ~22fps<br/>→ /pet_camera_detections"]
        end

        subgraph hw["Hardware Layer"]
            cam0["Camera 0<br/>(Day Camera)<br/>MIPI CSI"]
            cam1["Camera 1<br/>(Night Camera)<br/>MIPI CSI"]
            rdkx5["D-Robotics RDK X5: ARM Cortex-A55 8コア + BPU + ISP"]
        end

        future["将来: AI Pyramid 未実装<br/>iframe埋め込み、Tailscale経由リモートアクセス"]
    end

    webrtc -->|"SHM読取"| h265zc
    webrtc -->|"SHM読取"| mjpegzc
    webrtc -->|"SHM読取"| detections
    daemon --> h265zc
    daemon --> mjpegzc
    daemon --> yolozc
    daemon --> roizc
    yolo -->|"SHM読取"| yolozc
    yolo -->|"SHM読取"| roizc
    yolo --> detections
    cam0 --> daemon
    cam1 --> daemon
```

---

## プロセスアーキテクチャ [実装済]

### プロセス構成

システムは3つの独立プロセスで構成され、共有メモリ（SHM）で通信する：

```mermaid
graph TD
    daemon["camera_daemon_drobotics<br/>Single process, multi-thread (C)<br/>- Pipeline thread DAY → SHM書込: yolo_zc, h265_zc, mjpeg_zc, roi_zc<br/>- Pipeline thread NIGHT → SHM書込: yolo_zc, h265_zc, mjpeg_zc, roi_zc<br/>- Switcher thread (brightness polling 250ms/5000ms)"]

    detector["YOLO Detector (Python)<br/>SHM読取: yolo_zc, roi_zc<br/>SHM書込: detections<br/>BPU推論 → detections<br/>コミック自動キャプチャ"]

    goserver["Go Streaming Server :8081<br/>SHM読取: h265_zc, mjpeg_zc, detections<br/>WebRTC H.265 passthrough<br/>VPS/SPS/PPS cache<br/>録画 (NAL capture)"]

    webmonitor["Go web_monitor :8080<br/>Preact SPA<br/>APIプロキシ → :8081<br/>アルバム機能"]

    daemon -->|"SHM (6領域)"| detector
    daemon -->|"SHM (6領域)"| goserver
    webmonitor --> goserver
```

### プロセス間通信（IPC）方式 [実装済]

**採用方式**: POSIX共有メモリ + セマフォ

| 特性 | 詳細 |
|------|------|
| 通信方式 | POSIX `shm_open()` + `mmap()` |
| 同期 | `sem_t`（プロセス間セマフォ） |
| コピー | ゼロコピー（mmap直接参照） |
| 初期化 | `O_EXCL` フラグで新規/既存を判定 |

[制約事項] セマフォの二重初期化は未定義動作（UB）を引き起こす。`shm_open()` で `O_EXCL` を使用し、`created_new` が true の場合のみ `sem_init()` を呼ぶこと。

---

## 共有メモリレイアウト [実装済]

### 全6領域の詳細

```mermaid
graph TD
    subgraph shm["共有メモリ全体像 (6領域)"]
        subgraph zc["ゼロコピーフレーム"]
            h265zc["/pet_camera_h265_zc<br/>H.265 stream zero-copy<br/>(encoder → Go streaming)"]
            yolozc["/pet_camera_yolo_zc<br/>YOLO input zero-copy<br/>(camera → Python detector)"]
            mjpegzc["/pet_camera_mjpeg_zc<br/>MJPEG NV12 zero-copy<br/>(camera → Go web_monitor)"]
        end

        subgraph roi["Night ROI (VSE Ch3-4)"]
            roizc0["/pet_camera_roi_zc_0<br/>ROI region 0 (640x640)"]
            roizc1["/pet_camera_roi_zc_1<br/>ROI region 1 (640x640)"]
        end

        subgraph det["検出結果"]
            detections["/pet_camera_detections<br/>YOLO bounding boxes"]
        end
    end

    daemon["camera_daemon_drobotics"] --> h265zc
    daemon --> yolozc
    daemon --> mjpegzc
    daemon --> roizc0
    daemon --> roizc1
    detector["YOLO Detector"] --> detections
    detector -.->|"読取"| yolozc
    detector -.->|"読取"| roizc0
    detector -.->|"読取"| roizc1
    goserver["Go Streaming Server"] -.->|"読取"| h265zc
    goserver -.->|"読取"| mjpegzc
    goserver -.->|"読取"| detections
```

---

## データフロー [実装済]

### メインデータパス

```mermaid
graph TD
    camhw["Camera HW (MIPI CSI)"]
    isp["ISP → Auto Exposure統計<br/>→ brightness_avg (in-process)"]
    vio["hbn_vflow → YUVフレーム"]
    yolozc["/pet_camera_yolo_zc<br/>(zero-copy metadata)"]
    detector["YOLO Detector (Python)<br/>BPU INT8, 8.9ms"]
    detshm["/pet_camera_detections"]
    comic["コミック自動キャプチャ (4コマ画像)"]
    encoder["hb_mm_mc H.265 encode<br/>(600kbps, GOP=fps)"]
    h265zc["/pet_camera_h265_zc<br/>(zero-copy)"]
    mjpegzc["/pet_camera_mjpeg_zc"]
    goserver["Go Streaming Server<br/>(pion/webrtc v4)"]
    webrtc["WebRTC H.265 passthrough → ブラウザ"]
    mjpeg["MJPEG fallback → ブラウザ"]
    recording["H.265録画<br/>(NAL capture, zero CPU overhead)"]

    camhw --> isp --> vio
    vio --> yolozc --> detector --> detshm --> comic
    vio --> encoder
    encoder --> h265zc
    encoder --> mjpegzc
    h265zc --> goserver
    mjpegzc --> goserver
    goserver --> webrtc
    goserver --> mjpeg
    goserver --> recording
```

### カメラ切り替えフロー

```mermaid
graph TD
    day["Pipeline thread DAY<br/>ISP brightness読取 (in-process)"]
    switcher["Switcher thread (ポーリング: 250ms/5000ms)<br/>判定: DAY→NIGHT brightness < 50, 10秒<br/>NIGHT→DAY brightness > 60, 10秒"]
    activate["Active camera が<br/>/pet_camera_h265_zc, /pet_camera_mjpeg_zc に書込開始"]
    warmup["Go Server: 15フレーム ウォームアップ<br/>(キーフレーム保証)"]

    day -->|"brightness_avg"| switcher
    switcher -->|"shared variable 切替"| activate
    activate --> warmup
```

---

## 技術スタック [実装済]

### カメラキャプチャレイヤー
- **言語**: C
- **ハードウェアAPI**: D-Robotics hbn_vflow (ISP/VIO) / hb_mm_mc (H.265 Encoder)
- **IPC**: POSIX共有メモリ + セマフォ
- **関連ファイル**: `src/capture/`

### 物体検出レイヤー
- **言語**: Python
- **推論**: YOLOv11n on D-Robotics BPU (INT8)
- **画像処理**: NumPy（NV12直接操作）
- **関連ファイル**: `src/detector/`

### ストリーミングレイヤー
- **言語**: Go
- **WebRTC**: pion/webrtc v4
- **H.265**: パススルー（再エンコードなし）
- **関連ファイル**: `src/streaming_server/`

### Web UIレイヤー
- **サーバー**: Go web_monitor (:8080)
- **フロントエンド**: Preact SPA
- **関連ファイル**: `src/streaming_server/internal/webmonitor/`

### 共通モジュール
- **Python型定義・共有ロジック**: `src/common/`
- **モック**: `src/mock/`

### 開発ツール
- **パッケージ管理**: `uv`（pip不使用）
- **型チェック**: pyright
- **ビルド**: Make (Cコード)
- **バージョン管理**: Git

### デプロイメント
- **OS**: Linux (D-Robotics RDK X5, ARM Cortex-A55)
- **プロセス管理**: systemd
- **ログ**: Python logging → systemd journal

---

## ディレクトリ構造 [実装済]

```
/app/smart-pet-camera/
│
├── docs/                          # ドキュメント（設計の真実の源泉）
│   ├── 01_project_goals.md
│   ├── 02_requirements.md
│   ├── 03_functional_design.md
│   ├── 04_architecture.md
│   └── *log.md                    # 開発ログ
│
├── src/
│   ├── capture/                   # カメラキャプチャ (C)
│   │   ├── camera_daemon_main.c   # 統合デーモン (マルチスレッド)
│   │   ├── camera_pipeline.c
│   │   ├── camera_switcher.c
│   │   ├── encoder_lowlevel.c     # hb_mm_mc H.265エンコーダ
│   │   ├── vio_lowlevel.c         # hbn_vflow VIO制御
│   │   ├── isp_brightness.c
│   │   ├── shared_memory.c / .h
│   │   ├── shm_constants.h        # SHM名・サイズ定義 (single source of truth)
│   │   └── mock_detector_daemon.py # POSIX SHMテスト用検出モック
│   │
│   ├── detector/                  # 物体検出 (Python)
│   │   └── YOLOv11n BPU推論
│   │
│   ├── streaming_server/          # Go WebRTC + web_monitor
│   │   ├── Go WebRTCサーバー (:8081)
│   │   └── Go web_monitor (:8080)
│   │
│   ├── common/                    # 共有Python型・ロジック
│   ├── mock/                      # モジュールモック
│   └── monitor/                   # システム監視
│
├── scripts/
│   └── profile_shm.py            # SHMプロファイラ
│
└── pyproject.toml                 # uv パッケージ管理
```

---

## デプロイメント構成 [実装済]

### systemdサービス

```ini
# カメラキャプチャ
smart-pet-camera-capture.service
  ExecStart: camera_daemon_drobotics (single process, multi-thread)

# 物体検出
smart-pet-camera-detection.service
  ExecStart: uv run src/detector/...
  After: capture.service

# ストリーミング
smart-pet-camera-streaming.service
  ExecStart: Go binary (:8081)
  After: capture.service

# Web UI (Go web_monitor)
smart-pet-camera-ui.service
  ExecStart: Go web_monitor binary (:8080)
```

---

## カメラ切り替えシステム [実装済]

### プロセス構成

```mermaid
graph TD
    daemon["camera_daemon_drobotics<br/>(単一プロセス, マルチスレッド)"]
    day["Pipeline thread DAY<br/>ISPハードウェア (handle A)<br/>/pet_camera_h265_zc に映像書き込み (active時)<br/>/pet_camera_yolo_zc にYUV書き込み"]
    night["Pipeline thread NIGHT<br/>ISPハードウェア (handle B)<br/>/pet_camera_h265_zc に映像書き込み (active時)<br/>/pet_camera_yolo_zc にYUV書き込み"]
    switcher["Switcher thread<br/>ISP brightness直接読取<br/>active camera index 切替 (shared variable)"]

    daemon --> day
    daemon --> night
    daemon --> switcher
    switcher -.->|"brightness polling"| day
```

### 明るさ計算

ISPハードウェアのAE (Auto Exposure) 統計を使用：

```mermaid
graph TD
    ae["ISP AE Statistics<br/>(32x32 grid = 1024 zones)"]
    raw["raw_avg<br/>(~15-bit range: 10000-48000)"]
    shift[">> 7 (7-bit固定シフト)"]
    result["brightness_avg (0-255)"]

    ae --> raw --> shift --> result
```

### 切り替え判定

| 切り替え | 閾値 | 保持時間 | ポーリング間隔 |
|---------|------|---------|--------------|
| DAY→NIGHT | brightness < 50 | 10秒 | 250ms |
| NIGHT→DAY | brightness > 60 | 10秒 | 5000ms |

**切替制御**: Switcher thread が shared variable (active camera index) を更新

詳細は `camera-and-isp.md` 参照。

---

## 共有メモリとセマフォの実装上の注意点 [制約事項]

### 問題: セマフォの二重初期化

複数プロセスが同一SHMにアクセスする場合、`sem_init()` の二重呼び出しは未定義動作。
`vio_get_frame()` が `-43 (EIDRM)` エラーを返す原因となる。

### 解決策: O_EXCL フラグによる判定

```c
// O_EXCL: 既存の場合はEEXISTエラーを返す
shm_fd = shm_open(name, O_CREAT | O_EXCL | O_RDWR, 0666);
if (shm_fd == -1 && errno == EEXIST) {
    // 既存 → セマフォ再初期化しない
    shm_fd = shm_open(name, O_RDWR, 0666);
} else {
    // 新規 → sem_init() を呼ぶ
    is_new = true;
}
```

### 関連ファイル
- `src/capture/shared_memory.c`: `shm_create_or_open_ex()`
- `src/capture/camera_pipeline.c`: 共有メモリのopen/create処理
- `src/capture/camera_daemon_main.c`: 統合デーモン（マルチスレッド）

---

## ハードウェア構成

### D-Robotics RDK X5

| コンポーネント | 詳細 |
|-------------|------|
| CPU | ARM Cortex-A55 (8コア), ARMv8.2-A |
| BPU | D-Robotics AI推論プロセッサ（INT8） |
| ISP | 内蔵ISP（AE/AWB統計、低照度補正） |
| GPU | Vivante GC8000L (OpenCL対応) |
| AES HW | 非対応（ソフトウェア実装） |

### GPU活用状況

| 処理 | GPU活用 | 備考 |
|------|---------|------|
| YOLO推論 | BPU使用 | GPU不使用、専用AI プロセッサ |
| SRTP暗号化 | 不可 | データ転送コスト > 暗号化コスト |
| H.265エンコード | hb_mm_mc | 専用ハードウェアエンコーダ (VPU) |

---

## 将来の拡張 [未実装]

### AI Pyramid
- iframe埋め込みによるAI分析ダッシュボード
- Tailscale経由のリモートアクセス

### 行動推定
- 食事/水飲み行動の自動検出・記録
- IoUベースの重なり判定

### アルバム機能拡張
- 詳細は `pet-album-spec.md` 参照

---

## まとめ

このアーキテクチャは以下の原則に基づいて設計・実装されている：

1. **ゼロコピーIPC**: 共有メモリによるプロセス間のゼロコピーデータ転送
2. **ハードウェア活用**: BPU (YOLO), ISP (画像処理), hb_mm_mc (H.265) の専用HW活用
3. **言語適材適所**: C (キャプチャ/エンコード), Python (AI推論), Go (WebRTC/ストリーミング)
4. **パススルー設計**: H.265をカメラからブラウザまで再エンコードなしで配信
5. **信頼性**: セマフォ安全初期化、ヒステリシス付きカメラ切替、ウォームアップフレーム
