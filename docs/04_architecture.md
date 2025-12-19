# システムアーキテクチャ - スマートペットカメラ

## 全体アーキテクチャ

### システム構成図

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Smart Pet Camera System                          │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Application Layer                            │ │
│  │                                                                  │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │ │
│  │  │   Behavior   │  │    Data      │  │   System     │         │ │
│  │  │  Estimation  │  │  Recording   │  │   Monitor    │         │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘         │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ▲                                        │
│                              │                                        │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Detection Layer                              │ │
│  │                                                                  │ │
│  │  ┌────────────────────────────────────────────────────────┐   │ │
│  │  │          Object Detection Engine (Python)              │   │ │
│  │  │  ┌──────────────────────────────────────────────────┐ │   │ │
│  │  │  │  TensorFlow Lite / ONNX Runtime / PyTorch        │ │   │ │
│  │  │  └──────────────────────────────────────────────────┘ │   │ │
│  │  └────────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ▲                                        │
│                              │ Frame Data                             │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Capture Layer (C)                            │ │
│  │                                                                  │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │ │
│  │  │   Camera     │  │    Frame     │  │   V4L2       │         │ │
│  │  │   Manager    │  │   Buffer     │  │  Interface   │         │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘         │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ▲                                        │
│                              │                                        │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Hardware Layer                               │ │
│  │                                                                  │ │
│  │  ┌──────────────┐              ┌──────────────┐                │ │
│  │  │  Camera 0    │              │  Camera 1    │                │ │
│  │  │ (Day Camera) │              │(Night Camera)│                │ │
│  │  │ /dev/video0  │              │ /dev/video1  │                │ │
│  │  └──────────────┘              └──────────────┘                │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Storage Layer                                │ │
│  │                                                                  │ │
│  │  /data/smart-pet-camera/                                        │ │
│  │    ├─ YYYY-MM-DD/                                               │ │
│  │    │   ├─ events.jsonl                                          │ │
│  │    │   ├─ {event_id}.json                                       │ │
│  │    │   └─ {event_id}.mp4                                        │ │
│  │    └─ metadata/                                                 │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## プロセスアーキテクチャ

### マルチプロセス構成

システムは複数のプロセスで構成され、プロセス間通信を行う：

```
┌──────────────────┐         ┌──────────────────┐
│  Capture Process │         │ Detection Process│
│      (C/C++)     │ ─IPC─→  │     (Python)     │
│                  │ ←─────  │                  │
└──────────────────┘         └──────────────────┘
         │                            │
         │                            ↓
         │                   ┌──────────────────┐
         │                   │ Behavior Process │
         │                   │     (Python)     │
         │                   └──────────────────┘
         │                            │
         ↓                            ↓
┌────────────────────────────────────────────┐
│         Recording Process (Python)          │
│  - Video Writer                             │
│  - JSON Writer                              │
│  - Storage Manager                          │
└────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────┐
│         File System                         │
│  /data/smart-pet-camera/                   │
└────────────────────────────────────────────┘
```

### プロセス間通信（IPC）方式

#### 選択肢1: ZeroMQ（推奨）
- 高性能メッセージングライブラリ
- Pub/Sub、Push/Pull パターン対応
- C/Python両対応

```python
# Python側（Subscriber）
import zmq

context = zmq.Context()
socket = context.socket(zmq.SUB)
socket.connect("tcp://localhost:5555")
socket.setsockopt_string(zmq.SUBSCRIBE, "")

while True:
    message = socket.recv_json()
    # フレームデータ処理
```

```c
// C側（Publisher）
#include <zmq.h>

void *context = zmq_ctx_new();
void *publisher = zmq_socket(context, ZMQ_PUB);
zmq_bind(publisher, "tcp://*:5555");

// フレーム送信
zmq_send(publisher, frame_data, frame_size, 0);
```

#### 選択肢2: 共有メモリ + セマフォ
- 最高速度（コピー不要）
- 実装が複雑

#### 選択肢3: gRPC
- 型安全、スキーマ定義
- オーバーヘッドあり

**推奨構成**: ZeroMQ（実装の容易さとパフォーマンスのバランス）

---

## 技術スタック

### カメラキャプチャレイヤー
- **言語**: C
- **ライブラリ**:
  - V4L2 (Video4Linux2)
  - libjpeg/libpng（画像エンコード）
- **ベースコード**: `capture_v2.c`

### 物体検出レイヤー
- **言語**: Python 3.8+
- **深層学習フレームワーク**:
  - TensorFlow Lite（推奨 - 軽量）
  - ONNX Runtime（クロスプラットフォーム）
  - PyTorch Mobile
- **画像処理**: OpenCV (cv2)
- **数値計算**: NumPy

### アプリケーションレイヤー
- **言語**: Python 3.8+
- **ライブラリ**:
  - psutil（システム監視）
  - PyYAML（設定管理）
  - python-dateutil（日時処理）

### プロセス間通信
- **ZeroMQ** (pyzmq, libzmq)

### データストレージ
- **フォーマット**: JSON (標準ライブラリ)、MP4 (OpenCV VideoWriter)
- **ファイルシステム**: ext4 / NTFS / FAT32

### 開発・テストツール
- **ビルドシステム**: Make / CMake
- **テスティング**: pytest, Google Test
- **静的解析**: pylint, cppcheck
- **バージョン管理**: Git

### デプロイメント
- **OS**: Linux (Ubuntu 20.04+, Raspberry Pi OS)
- **プロセス管理**: systemd
- **ログ管理**: Python logging → syslog

---

## ディレクトリ構造

### プロジェクトディレクトリ

```
/app/smart-pet-camera/
│
├── docs/                          # ドキュメント
│   ├── 01_project_goals.md
│   ├── 02_requirements.md
│   ├── 03_functional_design.md
│   ├── 04_architecture.md
│   └── diagrams/                  # 図表
│       ├── architecture.png
│       └── flow.png
│
├── src/                           # ソースコード
│   ├── capture/                   # カメラキャプチャ (C)
│   │   ├── camera_manager.c
│   │   ├── camera_manager.h
│   │   ├── frame_buffer.c
│   │   ├── frame_buffer.h
│   │   ├── v4l2_interface.c
│   │   ├── v4l2_interface.h
│   │   └── main_capture.c
│   │
│   ├── detection/                 # 物体検出 (Python)
│   │   ├── __init__.py
│   │   ├── detector.py            # ObjectDetector クラス
│   │   ├── model_loader.py
│   │   ├── preprocessing.py
│   │   └── main_detection.py
│   │
│   ├── behavior/                  # 行動推定 (Python)
│   │   ├── __init__.py
│   │   ├── estimator.py           # BehaviorEstimator クラス
│   │   ├── overlap_calc.py        # IoU計算
│   │   └── state_machine.py       # 状態管理
│   │
│   ├── recording/                 # データ記録 (Python)
│   │   ├── __init__.py
│   │   ├── event_recorder.py
│   │   ├── video_recorder.py
│   │   ├── frame_buffer.py
│   │   └── storage_manager.py
│   │
│   ├── config/                    # 設定管理 (Python)
│   │   ├── __init__.py
│   │   ├── config_loader.py
│   │   └── validator.py
│   │
│   ├── monitor/                   # システム監視 (Python)
│   │   ├── __init__.py
│   │   ├── system_monitor.py
│   │   ├── recovery.py
│   │   └── health_check.py
│   │
│   ├── ipc/                       # プロセス間通信 (C/Python)
│   │   ├── zmq_publisher.c
│   │   ├── zmq_publisher.h
│   │   └── zmq_subscriber.py
│   │
│   └── utils/                     # 共通ユーティリティ
│       ├── __init__.py
│       ├── logger.py
│       └── timestamp.py
│
├── config/                        # 設定ファイル
│   ├── config.yaml                # メイン設定
│   ├── config.example.yaml        # サンプル設定
│   └── logging.yaml               # ログ設定
│
├── models/                        # 学習済みモデル
│   ├── pet_detector_v1.tflite
│   ├── README.md                  # モデル情報
│   └── labels.txt                 # クラスラベル
│
├── tests/                         # テストコード
│   ├── unit/
│   │   ├── test_detector.py
│   │   ├── test_estimator.py
│   │   ├── test_recorder.py
│   │   └── test_overlap.py
│   ├── integration/
│   │   ├── test_end_to_end.py
│   │   └── test_multi_camera.py
│   └── fixtures/
│       ├── test_videos/
│       └── mock_config.yaml
│
├── scripts/                       # 運用スクリプト
│   ├── start.sh                   # システム起動
│   ├── stop.sh                    # システム停止
│   ├── install_deps.sh            # 依存関係インストール
│   ├── setup_cameras.sh           # カメラセットアップ
│   └── cleanup_old_data.sh        # 古いデータ削除
│
├── systemd/                       # systemdサービス定義
│   ├── smart-pet-camera-capture.service
│   ├── smart-pet-camera-detection.service
│   └── smart-pet-camera-recording.service
│
├── Makefile                       # ビルド定義（Cコード用）
├── CMakeLists.txt                 # CMake設定
├── requirements.txt               # Python依存関係
├── setup.py                       # Pythonパッケージ設定
├── README.md                      # プロジェクトREADME
└── .gitignore
```

### データディレクトリ

```
/data/smart-pet-camera/
│
├── 2025-01-01/
│   ├── events.jsonl               # 日次イベントログ
│   ├── 20250101_120530_001.json   # 個別イベント
│   ├── 20250101_120530_001.mp4    # 対応動画
│   ├── 20250101_143022_002.json
│   └── 20250101_143022_002.mp4
│
├── 2025-01-02/
│   └── ...
│
├── metadata/
│   ├── camera_status.json         # カメラステータス
│   ├── system_stats.json          # システム統計
│   └── error_log.json             # エラーログ
│
└── tmp/
    └── frame_buffers/             # 一時フレームバッファ
```

---

## デプロイメント構成

### システムサービス構成（systemd）

#### 1. Capture Service
```ini
# /etc/systemd/system/smart-pet-camera-capture.service
[Unit]
Description=Smart Pet Camera - Capture Service
After=network.target

[Service]
Type=simple
User=camera
WorkingDirectory=/app/smart-pet-camera
ExecStart=/app/smart-pet-camera/build/capture_main
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

#### 2. Detection Service
```ini
# /etc/systemd/system/smart-pet-camera-detection.service
[Unit]
Description=Smart Pet Camera - Detection Service
After=network.target smart-pet-camera-capture.service
Requires=smart-pet-camera-capture.service

[Service]
Type=simple
User=camera
WorkingDirectory=/app/smart-pet-camera
ExecStart=/usr/bin/python3 /app/smart-pet-camera/src/detection/main_detection.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

#### 3. Recording Service
```ini
# /etc/systemd/system/smart-pet-camera-recording.service
[Unit]
Description=Smart Pet Camera - Recording Service
After=network.target smart-pet-camera-detection.service
Requires=smart-pet-camera-detection.service

[Service]
Type=simple
User=camera
WorkingDirectory=/app/smart-pet-camera
ExecStart=/usr/bin/python3 /app/smart-pet-camera/src/recording/main_recording.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### サービス管理コマンド

```bash
# サービス開始
sudo systemctl start smart-pet-camera-capture
sudo systemctl start smart-pet-camera-detection
sudo systemctl start smart-pet-camera-recording

# サービス停止
sudo systemctl stop smart-pet-camera-*

# 自動起動有効化
sudo systemctl enable smart-pet-camera-*

# ステータス確認
sudo systemctl status smart-pet-camera-*

# ログ確認
sudo journalctl -u smart-pet-camera-capture -f
```

---

## セキュリティ考慮事項

### アクセス制御
- カメラデバイスへのアクセス権限管理
- データディレクトリのパーミッション設定（700）
- 専用ユーザー（camera）での実行

### データ保護
- 個人を含む映像の取り扱い注意
- ローカルストレージのみ（初期フェーズ）
- 将来的な暗号化検討

---

## スケーラビリティ

### 垂直スケーリング（性能向上）
- より高性能なハードウェアへの移行
- GPU/NPUの活用
- マルチスレッド/マルチプロセス最適化

### 水平スケーリング（将来的）
- 複数デバイスでの分散処理
- クラウド連携（データ集約・分析）
- エッジ-クラウド協調アーキテクチャ

---

## 監視とロギング

### ログレベル
- **DEBUG**: 詳細なデバッグ情報（開発時のみ）
- **INFO**: 通常動作のイベント（起動、停止、検出結果）
- **WARNING**: 予期しない動作（カメラ一時切断、低信頼度検出）
- **ERROR**: エラー（カメラ失敗、モデルロード失敗）
- **CRITICAL**: システム停止レベルの致命的エラー

### ログ出力先
- **標準出力**: systemdでキャプチャ
- **ファイル**: `/var/log/smart-pet-camera/app.log`（ローテーション有）
- **syslog**: システムログとして統合

### メトリクス収集
- フレームレート（fps）
- 検出レイテンシ（ms）
- CPU/メモリ使用率
- ディスク使用率
- イベント検出数（日次）

---

## 災害復旧とバックアップ

### データバックアップ
- 重要イベントの外部ストレージへのコピー（手動/スクリプト）
- 設定ファイルのバージョン管理（Git）

### システム復旧
- 設定ファイルからの再構築
- サービス自動再起動（systemd）
- ウォッチドッグタイマー（将来的）

---

## 開発ロードマップ

### Phase 1: 基盤構築（MVP）
- [x] プロジェクト構造作成
- [x] ドキュメント整備
- [ ] カメラキャプチャモジュール実装（capture_v2.cベース）
- [ ] 物体検出モジュール実装（軽量モデル）
- [ ] 基本的な行動推定ロジック
- [ ] JSONデータ記録

**成功基準**: 単一カメラで食事行動を検出し記録できる

### Phase 2: 機能拡充
- [ ] マルチカメラ対応
- [ ] 動画記録機能
- [ ] 水飲み行動検出
- [ ] 設定ファイル管理
- [ ] システム監視機能

**成功基準**: 2カメラで食事・水飲み行動を動画付きで記録できる

### Phase 3: 安定化・最適化
- [ ] 24時間連続稼働テスト
- [ ] パフォーマンスチューニング
- [ ] エラー処理強化
- [ ] 自動復旧機能
- [ ] データクリーンアップ自動化

**成功基準**: 1週間無人稼働できる

### Phase 4: 高度な機能（将来的）
- [ ] 個体識別（複数猫対応）
- [ ] 行動パターン分析
- [ ] 異常検知アラート
- [ ] Web UIダッシュボード
- [ ] クラウド連携

**成功基準**: ユーザーフィードバックに基づく改善

---

## 技術的負債管理

### 既知の技術的負債
1. **capture_v2.cの改修**: 既存コードのリファクタリングが必要
2. **プロセス間通信の最適化**: 初期実装後にパフォーマンス測定と改善
3. **エラーハンドリング**: 包括的なエラー処理の追加

### 負債返済計画
- 各Phaseで一定時間をリファクタリングに割り当て
- コードレビューの実施
- テストカバレッジの向上（目標80%以上）

---

## 依存関係

### システム依存
- Linux kernel 4.x+
- V4L2ドライバ

### C/C++ライブラリ
```
libv4l-dev
libjpeg-dev
libzmq3-dev
```

### Pythonパッケージ（requirements.txt）
```
numpy>=1.19.0
opencv-python>=4.5.0
tensorflow-lite-runtime>=2.8.0  # または onnxruntime
pyzmq>=22.0.0
PyYAML>=5.4.0
psutil>=5.8.0
python-dateutil>=2.8.0
pytest>=6.2.0
```

### インストールスクリプト
```bash
#!/bin/bash
# scripts/install_deps.sh

# システムパッケージ
sudo apt-get update
sudo apt-get install -y \
    v4l-utils \
    libv4l-dev \
    libjpeg-dev \
    libzmq3-dev \
    python3-pip \
    python3-dev

# Pythonパッケージ
pip3 install -r requirements.txt

echo "Dependencies installed successfully"
```

---

## まとめ

このアーキテクチャは以下の原則に基づいて設計されている：

1. **モジュール性**: 各コンポーネントが独立し、交換可能
2. **拡張性**: 新機能追加が容易
3. **保守性**: コードとドキュメントが整理され理解しやすい
4. **パフォーマンス**: リアルタイム処理を実現
5. **信頼性**: 24時間連続稼働に耐える堅牢性

段階的な開発アプローチにより、リスクを最小化しながら価値を早期に提供できる。
