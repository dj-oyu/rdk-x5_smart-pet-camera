# システムアーキテクチャ - スマートペットカメラ

## 全体アーキテクチャ

### システム構成図 [実装済]

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Smart Pet Camera System                            │
│                      (D-Robotics RDK X5)                                │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                    Streaming Layer (Go)                            │ │
│  │                                                                    │ │
│  │  ┌────────────────────────┐  ┌────────────────────────────────┐  │ │
│  │  │  Go WebRTC Server     │  │  Flask UI Proxy                │  │ │
│  │  │  pion/webrtc v3       │  │  Preact SPA 配信               │  │ │
│  │  │  :8081                │  │  :8080                         │  │ │
│  │  │  - H.264 passthrough  │  │  - API プロキシ → :8081        │  │ │
│  │  │  - MJPEG endpoint     │  │  - アルバム UI                 │  │ │
│  │  │  - SPS/PPS cache      │  │                                │  │ │
│  │  │  - 録画 (NAL capture) │  │                                │  │ │
│  │  └───────────┬────────────┘  └────────────────────────────────┘  │ │
│  └──────────────┼────────────────────────────────────────────────────┘ │
│                 │ SHM読取                                               │
│  ┌──────────────┼────────────────────────────────────────────────────┐ │
│  │              │     Shared Memory Layer (9領域)                     │ │
│  │              │                                                     │ │
│  │  /pet_camera_stream (93MB ring)  ←── H.264 active output         │ │
│  │  /pet_camera_mjpeg_frame (1.4MB) ←── MJPEG frame                 │ │
│  │  /pet_camera_control (8B)        ←── active camera index          │ │
│  │  /pet_camera_zc_0, zc_1 (~150B)  ←── zero-copy YUV (per camera) │ │
│  │  /pet_camera_h264_zc_0, zc_1     ←── zero-copy H.264             │ │
│  │  /pet_camera_detections (584B)   ←── YOLO detection results       │ │
│  │  /pet_camera_brightness (108B)   ←── brightness metric            │ │
│  └──────────────┼──────────────────────────┬─────────────────────────┘ │
│                 │                          │ SHM読取                    │
│  ┌──────────────┼──────────────┐  ┌───────┼──────────────────────┐    │
│  │   Capture Layer (C)         │  │  Detection Layer (Python)    │    │
│  │                             │  │                              │    │
│  │  camera_switcher_daemon     │  │  YOLOv11n on BPU (INT8)     │    │
│  │   ├─ camera_daemon DAY     │  │  8.9ms inference             │    │
│  │   └─ camera_daemon NIGHT   │  │                              │    │
│  │                             │  │  DAY: 640x360→letterbox→    │    │
│  │  ISP/VIO → YUV capture     │  │       640x640               │    │
│  │  libspcdev → H.264 encode  │  │  NIGHT: 1280x720→3 ROI     │    │
│  │  600kbps / GOP 14          │  │         round-robin ~22fps  │    │
│  │                             │  │                              │    │
│  │  コミック自動キャプチャ      │  │  → /pet_camera_detections   │    │
│  └──────────────┬──────────────┘  └──────────────────────────────┘    │
│                 │                                                      │
│  ┌──────────────┼──────────────────────────────────────────────────┐  │
│  │              │      Hardware Layer                               │  │
│  │  ┌──────────┴───┐              ┌──────────────┐                 │  │
│  │  │  Camera 0    │              │  Camera 1    │                 │  │
│  │  │ (Day Camera) │              │(Night Camera)│                 │  │
│  │  │  MIPI CSI    │              │  MIPI CSI    │                 │  │
│  │  └──────────────┘              └──────────────┘                 │  │
│  │                                                                  │  │
│  │  D-Robotics RDK X5: ARM Cortex-A55 8コア + BPU + ISP            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    将来: AI Pyramid [未実装]                      │  │
│  │  iframe埋め込み、Tailscale経由リモートアクセス                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## プロセスアーキテクチャ [実装済]

### マルチプロセス構成

システムは3つの独立プロセス群で構成され、共有メモリ（SHM）で通信する：

```
┌──────────────────────────┐
│  camera_switcher_daemon  │ ← 親プロセス (C)
│  (fork 2 children)       │
│                          │
│  ├─ camera_daemon DAY    │──→ SHM書込: zc_0, h264_zc_0, stream, mjpeg, brightness
│  └─ camera_daemon NIGHT  │──→ SHM書込: zc_1, h264_zc_1, stream, mjpeg
│                          │
│  切替: SIGUSR1/SIGUSR2   │
│  ポーリング: 250ms/5000ms │
└────────────┬─────────────┘
             │ SHM (9領域)
             ↓
┌──────────────────────────┐         ┌──────────────────────────┐
│  YOLO Detector (Python)  │         │  Go Streaming Server     │
│                          │         │                          │
│  SHM読取: zc_0/zc_1     │         │  SHM読取: stream, mjpeg  │
│  SHM書込: detections     │         │  SHM読取: detections     │
│                          │         │                          │
│  BPU推論 → detections    │         │  WebRTC :8081            │
│  コミック自動キャプチャ    │         │  H.264 passthrough      │
└──────────────────────────┘         │  SPS/PPS cache          │
                                     │  録画 (NAL capture)      │
                                     └──────────────────────────┘
                                                  ↑
                                     ┌──────────────────────────┐
                                     │  Flask UI Proxy :8080    │
                                     │  Preact SPA              │
                                     │  APIプロキシ → :8081     │
                                     │  アルバム機能             │
                                     └──────────────────────────┘
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

### 全9領域の詳細

```
┌─────────────────────────────────────────────────────────────────┐
│                     共有メモリ全体像                              │
│                                                                  │
│  制御系:                                                         │
│  ┌─────────────────────────────┐                                │
│  │ /pet_camera_control    ~8B  │ active camera index             │
│  └─────────────────────────────┘                                │
│  ┌─────────────────────────────┐                                │
│  │ /pet_camera_brightness ~108B│ brightness_avg per camera       │
│  └─────────────────────────────┘                                │
│                                                                  │
│  ゼロコピーフレーム (per camera):                                 │
│  ┌─────────────────────────────┐ ┌─────────────────────────────┐│
│  │ /pet_camera_zc_0      ~150B │ │ /pet_camera_zc_1      ~150B ││
│  │ (DAY YUV metadata)         │ │ (NIGHT YUV metadata)        ││
│  └─────────────────────────────┘ └─────────────────────────────┘│
│  ┌─────────────────────────────┐ ┌─────────────────────────────┐│
│  │ /pet_camera_h264_zc_0      │ │ /pet_camera_h264_zc_1      ││
│  │ (DAY H.264 metadata)      │ │ (NIGHT H.264 metadata)     ││
│  └─────────────────────────────┘ └─────────────────────────────┘│
│                                                                  │
│  アクティブ出力 (active camera のみ書込):                         │
│  ┌─────────────────────────────┐                                │
│  │ /pet_camera_stream    ~93MB │ H.264 リングバッファ            │
│  └─────────────────────────────┘                                │
│  ┌─────────────────────────────┐                                │
│  │ /pet_camera_mjpeg_frame     │ MJPEG最新フレーム (~1.4MB)     │
│  │                      ~1.4MB │                                │
│  └─────────────────────────────┘                                │
│                                                                  │
│  検出結果:                                                       │
│  ┌─────────────────────────────┐                                │
│  │ /pet_camera_detections ~584B│ YOLO bounding boxes            │
│  └─────────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────┘
```

### 明るさSHM構造体

```c
typedef struct {
    uint64_t frame_number;      // 8B
    struct timespec timestamp;  // 16B
    float brightness_avg;       // 4B  (0-255)
    uint32_t brightness_lux;    // 4B
    uint8_t brightness_zone;    // 1B  (0-3)
    uint8_t correction_applied; // 1B
    uint8_t _reserved[2];       // 2B
} CameraBrightness;             // 36B per camera

typedef struct {
    volatile uint32_t version;           // 4B
    CameraBrightness cameras[2];         // 72B
    sem_t update_sem;                    // 32B
} SharedBrightnessData;                  // ~108B total
```

---

## データフロー [実装済]

### メインデータパス

```
Camera HW (MIPI CSI)
    │
    ↓
ISP → Auto Exposure統計 → brightness_avg → /pet_camera_brightness
    │
    ↓
VIO → YUVフレーム → /pet_camera_zc_{0,1} (zero-copy metadata)
    │                      │
    │                      ↓
    │               YOLO Detector (Python)
    │                 BPU INT8, 8.9ms
    │                      │
    │                      ↓
    │               /pet_camera_detections
    │                      │
    │                      ↓
    │               コミック自動キャプチャ (4コマ画像)
    │
    ↓
libspcdev H.264 encode (600kbps, GOP=14)
    │
    ├─→ /pet_camera_h264_zc_{0,1} (zero-copy metadata)
    │
    ↓ (active camera only)
/pet_camera_stream (93MB ring buffer)
/pet_camera_mjpeg_frame (1.4MB)
    │
    ↓
Go Streaming Server (pion/webrtc v3)
    │
    ├─→ WebRTC H.264 passthrough → ブラウザ
    ├─→ MJPEG fallback → ブラウザ
    └─→ H.264録画 (NAL capture, zero CPU overhead)
```

### カメラ切り替えフロー

```
camera_daemon DAY
  │ brightness書込 (active: 8フレーム毎, inactive: 64フレーム毎)
  ↓
/pet_camera_brightness
  ↓
camera_switcher_daemon (ポーリング: 250ms/5000ms)
  │ 判定: DAY→NIGHT (< 50, 10秒), NIGHT→DAY (> 60, 10秒)
  ↓
SIGUSR1 (→DAY) / SIGUSR2 (→NIGHT) → camera_daemon
  ↓
active camera が /pet_camera_stream, /pet_camera_mjpeg_frame に書込開始
  ↓
Go Server: 15フレーム ウォームアップ (キーフレーム保証)
```

---

## 技術スタック [実装済]

### カメラキャプチャレイヤー
- **言語**: C
- **ハードウェアAPI**: D-Robotics libspcdev (ISP/VIO/Encoder)
- **IPC**: POSIX共有メモリ + セマフォ
- **関連ファイル**: `src/capture/`

### 物体検出レイヤー
- **言語**: Python
- **推論**: YOLOv11n on D-Robotics BPU (INT8)
- **画像処理**: NumPy（NV12直接操作）
- **関連ファイル**: `src/detector/`

### ストリーミングレイヤー
- **言語**: Go
- **WebRTC**: pion/webrtc v3
- **H.264**: パススルー（再エンコードなし）
- **関連ファイル**: `src/streaming_server/`

### Web UIレイヤー
- **サーバー**: Python/Flask (:8080)
- **フロントエンド**: Preact SPA
- **関連ファイル**: `src/streaming_server/` (Flask部分)

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
│   │   ├── camera_switcher_daemon.c
│   │   ├── camera_daemon.c
│   │   ├── camera_pipeline.c
│   │   ├── isp_brightness.c
│   │   ├── shared_memory.c / .h
│   │   └── mock_camera_daemon.py  # テスト用モック
│   │
│   ├── detector/                  # 物体検出 (Python)
│   │   └── YOLOv11n BPU推論
│   │
│   ├── streaming_server/          # Go WebRTC + Flask UI
│   │   ├── Go WebRTCサーバー (:8081)
│   │   └── Flask UIプロキシ (:8080)
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
  ExecStart: camera_switcher_daemon (fork → 2 camera_daemons)

# 物体検出
smart-pet-camera-detection.service
  ExecStart: uv run src/detector/...
  After: capture.service

# ストリーミング
smart-pet-camera-streaming.service
  ExecStart: Go binary (:8081)
  After: capture.service

# Web UI
smart-pet-camera-ui.service
  ExecStart: uv run Flask app (:8080)
```

---

## カメラ切り替えシステム [実装済]

### プロセス構成

```
camera_switcher_daemon (親プロセス)
    │
    ├── fork() ──→ camera_daemon DAY  (子プロセス)
    │                    │
    │                    ├── ISPハードウェア (handle A)
    │                    ├── /pet_camera_brightness に明るさ書き込み
    │                    └── /pet_camera_stream に映像書き込み (active時)
    │
    └── fork() ──→ camera_daemon NIGHT (子プロセス)
                         │
                         ├── ISPハードウェア (handle B)
                         └── /pet_camera_stream に映像書き込み (active時)
```

### 明るさ計算

ISPハードウェアのAE (Auto Exposure) 統計を使用：

```
ISP AE Statistics (32x32 grid = 1024 zones)
          ↓
    raw_avg (~15-bit range: 10000-48000)
          ↓
    >> 7 (7-bit固定シフト)
          ↓
    brightness_avg (0-255)
```

### 切り替え判定

| 切り替え | 閾値 | 保持時間 | ポーリング間隔 |
|---------|------|---------|--------------|
| DAY→NIGHT | brightness < 50 | 10秒 | 250ms |
| NIGHT→DAY | brightness > 60 | 10秒 | 5000ms |

**シグナル制御**: SIGUSR1 (→DAY) / SIGUSR2 (→NIGHT)

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
- `src/capture/camera_switcher_daemon.c`: マルチカメラオーケストレーション

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
| H.264エンコード | libspcdev | 専用ハードウェアエンコーダ |

---

## 将来の拡張 [未実装]

### AI Pyramid
- iframe埋め込みによるAI分析ダッシュボード
- Tailscale経由のリモートアクセス

### 行動推定
- 食事/水飲み行動の自動検出・記録
- IoUベースの重なり判定

### アルバム機能拡張
- 詳細は `pet-album-spec-DRAFT.md` 参照

---

## まとめ

このアーキテクチャは以下の原則に基づいて設計・実装されている：

1. **ゼロコピーIPC**: 共有メモリによるプロセス間のゼロコピーデータ転送
2. **ハードウェア活用**: BPU (YOLO), ISP (画像処理), libspcdev (H.264) の専用HW活用
3. **言語適材適所**: C (キャプチャ/エンコード), Python (AI推論), Go (WebRTC/ストリーミング)
4. **パススルー設計**: H.264をカメラからブラウザまで再エンコードなしで配信
5. **信頼性**: セマフォ安全初期化、ヒステリシス付きカメラ切替、ウォームアップフレーム
