# 機能設計 - スマートペットカメラ

## システム概要

スマートペットカメラは、以下の主要コンポーネントで構成される：

1. **カメラキャプチャモジュール** - 映像取得
2. **物体検出モジュール** - AI推論
3. **行動推定モジュール** - 行動判定ロジック
4. **データ記録モジュール** - 永続化
5. **設定管理モジュール** - 構成管理
6. **システム監視モジュール** - ヘルスチェック

## コンポーネント設計

### 1. カメラキャプチャモジュール（Camera Capture Module）

#### 責務
- 複数カメラからの映像取得
- フレームバッファ管理
- カメラ選択ロジック

#### 主要機能

##### 1.1 マルチカメラ管理
```c
typedef struct {
    int camera_id;
    char device_path[256];  // e.g., "/dev/video0"
    CameraType type;        // DAY_CAMERA, NIGHT_CAMERA
    int width;
    int height;
    int fps;
    bool is_active;
} CameraConfig;

// カメラ初期化
int camera_init(CameraConfig* configs, int num_cameras);

// カメラオープン
int camera_open(int camera_id);

// カメラクローズ
int camera_close(int camera_id);
```

##### 1.2 フレームキャプチャ
```c
typedef struct {
    uint8_t* data;
    size_t size;
    int width;
    int height;
    int camera_id;
    struct timeval timestamp;
    int frame_number;
} Frame;

// フレーム取得（ブロッキング）
int camera_capture_frame(int camera_id, Frame* frame);

// フレーム解放
void camera_release_frame(Frame* frame);
```

##### 1.3 カメラ選択戦略
```c
typedef enum {
    CAMERA_SELECT_AUTO,      // 照明条件に基づき自動選択
    CAMERA_SELECT_DAY_ONLY,  // 昼間カメラのみ
    CAMERA_SELECT_NIGHT_ONLY, // 夜間カメラのみ
    CAMERA_SELECT_BOTH       // 両方使用（フュージョン）
} CameraSelectMode;

// カメラ選択
int camera_select(CameraSelectMode mode, int* selected_cameras, int* num_selected);
```

#### データフロー
```
カメラデバイス → V4L2ドライバ → フレームバッファ → Frame構造体 → 物体検出モジュール
```

#### 既存資産の活用
- `capture_v2.c`を基盤として拡張
- V4L2インターフェースの知見を活用
- マルチカメラ対応への拡張

---

### 2. 物体検出モジュール（Object Detection Module）

#### 責務
- 映像フレームからの物体検出
- 検出結果の構造化
- モデル管理

#### 主要機能

##### 2.1 検出器初期化
```python
class ObjectDetector:
    def __init__(self, model_path: str, config: DetectionConfig):
        """
        物体検出器の初期化

        Args:
            model_path: モデルファイルパス (.tflite, .onnx等)
            config: 検出設定（閾値、入力サイズ等）
        """
        pass

    def load_model(self):
        """モデルロード"""
        pass
```

##### 2.2 検出実行
```python
from dataclasses import dataclass
from typing import List

@dataclass
class BoundingBox:
    x: int          # 左上X座標
    y: int          # 左上Y座標
    w: int          # 幅
    h: int          # 高さ

@dataclass
class Detection:
    class_name: str        # "cat", "food_bowl", "water_bowl"
    confidence: float      # 0.0 ~ 1.0
    bbox: BoundingBox

class ObjectDetector:
    def detect(self, frame: np.ndarray) -> List[Detection]:
        """
        フレームから物体を検出

        Args:
            frame: 入力画像 (numpy array)

        Returns:
            検出結果のリスト
        """
        pass
```

##### 2.3 クラス定義
検出対象クラス：
- `cat`: 猫
- `food_bowl`: 餌皿
- `water_bowl`: 水飲み場

#### モデル候補
1. **YOLOv5/YOLOv8-nano**: 高速で軽量、組み込み向け
2. **MobileNet-SSD**: モバイル・組み込み向けに最適化
3. **EfficientDet-Lite**: バランスの取れた性能

#### 推論パイプライン
```
入力フレーム → 前処理（リサイズ、正規化）→ モデル推論 → 後処理（NMS）→ Detection構造体
```

---

### 3. 行動推定モジュール（Behavior Estimation Module）

#### 責務
- バウンディングボックスの重なり計算
- 行動判定ロジック
- 行動イベントの生成

#### 主要機能

##### 3.1 重なり判定
```python
def calculate_iou(bbox1: BoundingBox, bbox2: BoundingBox) -> float:
    """
    2つのバウンディングボックスのIoU（Intersection over Union）を計算

    Returns:
        IoU値 (0.0 ~ 1.0)
    """
    pass

def calculate_overlap_ratio(bbox1: BoundingBox, bbox2: BoundingBox) -> float:
    """
    bbox1に対するbbox2の重なり比率を計算

    Returns:
        重なり比率 (0.0 ~ 1.0)
    """
    pass
```

##### 3.2 行動推定
```python
from enum import Enum
from datetime import datetime

class BehaviorType(Enum):
    EATING = "eating"
    DRINKING = "drinking"
    IDLE = "idle"

@dataclass
class BehaviorEvent:
    event_id: str
    behavior_type: BehaviorType
    start_time: datetime
    end_time: datetime | None
    camera_id: int
    confidence: float
    detections: List[Detection]

class BehaviorEstimator:
    def __init__(self, iou_threshold: float = 0.3, min_duration_sec: float = 3.0):
        """
        行動推定器の初期化

        Args:
            iou_threshold: 行動判定に使う重なり閾値
            min_duration_sec: 記録する最小継続時間（秒）
        """
        self.iou_threshold = iou_threshold
        self.min_duration_sec = min_duration_sec
        self.current_events: List[BehaviorEvent] = []

    def estimate(self, detections: List[Detection], timestamp: datetime) -> List[BehaviorEvent]:
        """
        検出結果から行動を推定

        Returns:
            完了した行動イベントのリスト
        """
        pass

    def _find_cat(self, detections: List[Detection]) -> Detection | None:
        """猫の検出結果を取得"""
        pass

    def _find_food_bowl(self, detections: List[Detection]) -> Detection | None:
        """餌皿の検出結果を取得"""
        pass

    def _find_water_bowl(self, detections: List[Detection]) -> Detection | None:
        """水飲み場の検出結果を取得"""
        pass
```

##### 3.3 行動判定ロジック

**食事行動の判定：**
1. 猫と餌皿の両方が検出される
2. IoU or 重なり比率が閾値以上
3. 一定時間（例：3秒）以上継続

**水飲み行動の判定：**
1. 猫と水飲み場の両方が検出される
2. IoU or 重なり比率が閾値以上
3. 一定時間（例：3秒）以上継続

**状態遷移図：**
```
IDLE → (猫+餌皿重なり検出) → EATING_CANDIDATE → (3秒継続) → EATING
                                     ↓ (重なり消失)
                                    IDLE

EATING → (重なり消失) → EATING_END → イベント記録
```

---

### 4. データ記録モジュール（Data Recording Module）

#### 責務
- 行動イベントのJSON記録
- 動画ファイルの保存
- ディレクトリ管理

#### 主要機能

##### 4.1 JSONライター
```python
import json
from pathlib import Path

class EventRecorder:
    def __init__(self, base_dir: Path):
        """
        イベント記録器の初期化

        Args:
            base_dir: 記録ベースディレクトリ
        """
        self.base_dir = base_dir

    def save_event(self, event: BehaviorEvent):
        """
        行動イベントをJSONファイルに保存

        - 個別JSONファイル: {event_id}.json
        - 日次ログファイル: {YYYYMMDD}/events.jsonl (JSON Lines形式)
        """
        pass

    def _ensure_daily_directory(self, date: datetime) -> Path:
        """日付ディレクトリを作成"""
        pass
```

##### 4.2 ビデオライター
```python
import cv2

class VideoRecorder:
    def __init__(self, base_dir: Path, fps: int = 30, codec: str = 'mp4v'):
        """
        動画記録器の初期化
        """
        self.base_dir = base_dir
        self.fps = fps
        self.codec = cv2.VideoWriter_fourcc(*codec)
        self.active_writers: dict[str, cv2.VideoWriter] = {}

    def start_recording(self, event_id: str, width: int, height: int):
        """動画記録開始"""
        pass

    def write_frame(self, event_id: str, frame: np.ndarray):
        """フレーム書き込み"""
        pass

    def stop_recording(self, event_id: str):
        """動画記録停止"""
        pass
```

##### 4.3 バッファ管理（プリレコーディング）
行動開始の数秒前から映像を保存するため、フレームバッファを保持：

```python
from collections import deque

class FrameBuffer:
    def __init__(self, max_duration_sec: float, fps: int):
        """
        Args:
            max_duration_sec: バッファする最大時間
            fps: フレームレート
        """
        max_frames = int(max_duration_sec * fps)
        self.buffer = deque(maxlen=max_frames)

    def add_frame(self, frame: np.ndarray, timestamp: datetime):
        """フレームをバッファに追加"""
        self.buffer.append((frame, timestamp))

    def get_frames(self, from_time: datetime) -> List[Tuple[np.ndarray, datetime]]:
        """指定時刻以降のフレームを取得"""
        pass
```

---

### 5. 設定管理モジュール（Configuration Module）

#### 責務
- 設定ファイルの読み込み
- 設定の検証
- デフォルト値の管理

#### 設定ファイル例（YAML）

```yaml
# config.yaml
system:
  name: "Smart Pet Camera"
  version: "1.0.0"
  log_level: "INFO"  # DEBUG, INFO, WARN, ERROR

cameras:
  - id: 0
    device: "/dev/video0"
    type: "day"
    resolution:
      width: 1280
      height: 720
    fps: 30
  - id: 1
    device: "/dev/video1"
    type: "night"
    resolution:
      width: 1280
      height: 720
    fps: 30

camera_selection:
  mode: "auto"  # auto, day_only, night_only, both

object_detection:
  model_path: "/app/model/pet_detector.tflite"
  confidence_threshold: 0.6
  input_size: [320, 320]
  classes:
    - "cat"
    - "food_bowl"
    - "water_bowl"

behavior_estimation:
  iou_threshold: 0.3
  min_duration_seconds: 3.0
  pre_record_seconds: 5.0
  post_record_seconds: 3.0

recording:
  base_directory: "/data/smart-pet-camera"
  video_codec: "mp4v"
  video_fps: 30
  retention_days:
    video: 7
    json: 90
    logs: 30

storage:
  min_free_gb: 5.0
  auto_cleanup: true
```

#### Python設定クラス
```python
from dataclasses import dataclass
import yaml

@dataclass
class CameraConfig:
    id: int
    device: str
    type: str
    width: int
    height: int
    fps: int

@dataclass
class SystemConfig:
    name: str
    version: str
    log_level: str
    cameras: List[CameraConfig]
    # ... 他の設定項目

def load_config(config_path: str) -> SystemConfig:
    """設定ファイルをロード"""
    with open(config_path, 'r') as f:
        config_dict = yaml.safe_load(f)
    return SystemConfig(**config_dict)
```

---

### 6. システム監視モジュール（System Monitor Module）

#### 責務
- システムヘルスチェック
- リソース監視
- エラー検出と回復

#### 主要機能

##### 6.1 リソース監視
```python
import psutil
from pathlib import Path

class SystemMonitor:
    def __init__(self, config: SystemConfig):
        self.config = config

    def check_cpu_usage(self) -> float:
        """CPU使用率チェック"""
        return psutil.cpu_percent(interval=1)

    def check_memory_usage(self) -> dict:
        """メモリ使用状況チェック"""
        mem = psutil.virtual_memory()
        return {
            'total': mem.total,
            'available': mem.available,
            'percent': mem.percent
        }

    def check_disk_space(self) -> dict:
        """ディスク空き容量チェック"""
        usage = psutil.disk_usage(self.config.recording.base_directory)
        return {
            'total_gb': usage.total / (1024**3),
            'free_gb': usage.free / (1024**3),
            'percent': usage.percent
        }

    def check_camera_status(self, camera_id: int) -> bool:
        """カメラ接続チェック"""
        pass
```

##### 6.2 自動復旧
```python
class SystemRecovery:
    def restart_camera(self, camera_id: int) -> bool:
        """カメラ再起動"""
        pass

    def cleanup_old_files(self, retention_days: int):
        """古いファイルの削除"""
        pass
```

---

## 処理フロー

### メイン処理ループ

```
1. システム初期化
   ├─ 設定ロード
   ├─ カメラ初期化
   ├─ 物体検出モデルロード
   └─ 記録ディレクトリ作成

2. メインループ（無限ループ）
   ├─ フレームキャプチャ
   │   ├─ カメラ選択
   │   └─ フレーム取得
   │
   ├─ 物体検出
   │   ├─ 前処理
   │   ├─ モデル推論
   │   └─ 後処理
   │
   ├─ 行動推定
   │   ├─ 重なり判定
   │   ├─ 状態管理
   │   └─ イベント生成
   │
   ├─ データ記録
   │   ├─ フレームバッファ管理
   │   ├─ 動画記録
   │   └─ JSON記録
   │
   ├─ システム監視
   │   ├─ リソースチェック
   │   └─ エラー処理
   │
   └─ ループ継続判定

3. シャットダウン
   ├─ 記録中イベントの保存
   ├─ カメラクローズ
   └─ リソース解放
```

### 状態遷移フロー

```
[システム起動]
    ↓
[初期化フェーズ]
    ↓
[待機状態] ←─────┐
    ↓            │
[検出状態]        │
    ├─ 猫のみ検出 ─┘
    ├─ 猫+餌皿検出
    │   ↓
    │  [食事候補状態]
    │   ├─ 3秒未満で終了 ─┘
    │   └─ 3秒以上継続
    │       ↓
    │      [食事記録中]
    │       ├─ 動画記録開始
    │       ├─ 継続監視
    │       └─ 終了検出
    │           ↓
    │          [イベント保存] ─┘
    │
    └─ 猫+水飲み場検出
        ↓
       [水飲み候補状態]
        ├─ 3秒未満で終了 ─┘
        └─ 3秒以上継続
            ↓
           [水飲み記録中]
            ├─ 動画記録開始
            ├─ 継続監視
            └─ 終了検出
                ↓
               [イベント保存] ─┘
```

---

## データフロー図

```
┌─────────────┐
│  Camera 0   │──┐
│  (Day)      │  │
└─────────────┘  │
                 ├─→ [Camera Capture] ─→ Frame
┌─────────────┐  │                          │
│  Camera 1   │──┘                          ↓
│  (Night)    │                      [Frame Buffer]
└─────────────┘                             │
                                            ↓
                                   [Object Detection]
                                            │
                                            ↓
                                      Detections
                                            │
                                            ↓
                                  [Behavior Estimation]
                                            │
                         ┌──────────────────┴──────────────────┐
                         ↓                                     ↓
                   Behavior Event                        No Event
                         │                                     │
         ┌───────────────┼───────────────┐                    │
         ↓               ↓               ↓                    │
  [Video Recorder] [JSON Writer]  [Frame Buffer]             │
         │               │               │                    │
         ↓               ↓               ↓                    ↓
     video.mp4      event.json    buffered frames      (Continue Loop)
```

---

## インターフェース定義

### C/Python インターフェース（プロセス間通信）

カメラキャプチャ（C）と物体検出（Python）の通信方法：

#### オプション1: 共有メモリ
```c
// C側
typedef struct {
    uint8_t frame_data[MAX_FRAME_SIZE];
    int width;
    int height;
    int camera_id;
    struct timeval timestamp;
    bool ready;
} SharedFrame;
```

#### オプション2: パイプ/ソケット
```python
# Python側
import socket
import pickle

def receive_frame(sock: socket.socket) -> Frame:
    """ソケットからフレームを受信"""
    data = sock.recv(FRAME_SIZE)
    frame = pickle.loads(data)
    return frame
```

#### オプション3: ファイルベース（シンプルだが遅い）
```c
// C側: フレームをファイルに書き込み
write_frame_to_file("/tmp/current_frame.jpg", frame);
signal_python_process();
```

**推奨**: オプション1（共有メモリ）またはオプション2（ソケット）

---

## エラー処理戦略

### エラー分類

1. **致命的エラー（システム停止）**
   - 設定ファイル読み込み失敗
   - モデルロード失敗
   - 全カメラ接続失敗

2. **復旧可能エラー（リトライ）**
   - 単一カメラ接続失敗
   - フレームキャプチャ失敗（一時的）
   - ディスク一時書き込み失敗

3. **警告（ログ記録のみ）**
   - 検出結果なし
   - 低い信頼度
   - CPU使用率高

### エラーハンドリング例

```python
import logging
from tenacity import retry, stop_after_attempt, wait_fixed

logger = logging.getLogger(__name__)

class CameraError(Exception):
    pass

@retry(stop=stop_after_attempt(3), wait=wait_fixed(2))
def open_camera_with_retry(camera_id: int):
    """カメラオープン（リトライ付き）"""
    try:
        return camera_open(camera_id)
    except Exception as e:
        logger.warning(f"Camera {camera_id} open failed: {e}. Retrying...")
        raise CameraError(f"Failed to open camera {camera_id}")
```

---

## パフォーマンス考慮事項

### ボトルネック予測
1. **物体検出推論**: 最も時間がかかる処理
   - 対策: 軽量モデル使用、推論アクセラレータ活用

2. **動画エンコード**: リアルタイム記録時の負荷
   - 対策: ハードウェアエンコーダ使用、解像度調整

3. **ディスクI/O**: 連続書き込み
   - 対策: バッファリング、非同期I/O

### 最適化戦略
- フレームスキップ（30fps → 15fps for 推論）
- ROI（Region of Interest）処理: 画像の一部のみ処理
- マルチスレッド/マルチプロセス化
  - カメラキャプチャスレッド
  - 推論スレッド
  - 記録スレッド

---

## テスト戦略

### ユニットテスト
- 各モジュールの単体テスト
- IoU計算の正確性検証
- 設定ロード・バリデーション

### 統合テスト
- エンドツーエンドフロー
- マルチカメラ動作
- 長時間稼働テスト（24時間以上）

### シナリオテスト
- 食事行動検出の精度測定
- 水飲み行動検出の精度測定
- 誤検出率の測定

### テストデータ
- 録画済み動画ファイルを使った再生テスト
- モックカメラデバイス
