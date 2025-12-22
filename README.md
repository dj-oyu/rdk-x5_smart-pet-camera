# スマートペットカメラ

AI物体検出技術を活用し、ペット（猫）の日常行動を自動的に記録・分析するスマート監視システム

## プロジェクト概要

このシステムは、2基のカメラ（昼間用・夜間用）を使用して、猫の食事・水飲み行動を24時間体制で自動検出し、動画とJSONデータとして記録します。

## 最新の開発状況（2025-12-21）

### ✅ Phase 1-1.5 完了
- **カメラキャプチャ**: D-Robotics MIPI カメラからのリアルタイムキャプチャ（30fps）
- **昼夜自動切り替え**: 画像の明るさに基づく自動カメラ切り替え機能
- **AI物体検出**: YOLO v8n による猫・餌皿・水飲み場の検出（10-15fps）
- **リアルタイム配信**: WebブラウザでBBox合成映像を表示

### 🚧 Phase 2 進行中
- **H.264エンコーディング**: ハードウェアエンコーダ統合（コア機能完成）
- **記録機能**: H.264動画記録（調整中）
- **次のステップ**: WebRTCストリーミング対応

詳細は [docs/development_roadmap.md](docs/development_roadmap.md) を参照してください。

### 主な機能

- **✅ 実装済み**
  - 昼夜カメラ自動切り替え（明るさセンサー不要、画像ベース判定）
  - YOLO v8n による AI物体検出（猫、餌皿、水飲み場の認識）
  - ハードウェア H.264 エンコーディング（D-Robotics VPU活用）
  - リアルタイムWebモニター（30fps MJPEG/H.264配信）
  - バウンディングボックス合成表示（クラス別色分け）
  - POSIX共有メモリによる高速プロセス間通信
  - 24時間連続稼働対応

- **🚧 開発中**
  - WebRTC ストリーミング
  - バウンディングボックス重なり判定による行動推定
  - 行動イベントの動画記録（開始前後数秒含む）
  - JSON形式での構造化データ保存

## ドキュメント

詳細な設計ドキュメントは `docs/` ディレクトリに格納されています：

### 設計ドキュメント
- **[01_project_goals.md](docs/01_project_goals.md)** - プロジェクトのゴールと背景
- **[02_requirements.md](docs/02_requirements.md)** - 機能要件・非機能要件
- **[03_functional_design.md](docs/03_functional_design.md)** - コンポーネント設計と処理フロー
- **[04_architecture.md](docs/04_architecture.md)** - システムアーキテクチャとデプロイメント

### 議事録・開発計画
- **[meeting_notes_20251219.md](docs/meeting_notes_20251219.md)** - アーキテクチャ検討会議事録
  - 技術的課題の検討（レイテンシー対策）
  - IPC方式の選定（共有メモリ採用）
  - 非同期実行方式の決定（マルチプロセス + ポーリング）
  - 開発計画（Phase 1-4）
- **[development_roadmap.md](docs/development_roadmap.md)** - 開発ロードマップとタスク管理

### 実装ログ・ステータス
- **[bounding_box_detection_status.md](docs/bounding_box_detection_status.md)** - BBox検出機能実装完了レポート
- **[camera_switcher_probe_status.md](docs/camera_switcher_probe_status.md)** - カメラ切り替え機能の現状
- **[camera_switcher_probe_fix.md](docs/camera_switcher_probe_fix.md)** - カメラ切り替え問題の修正記録
- **[h264_implementation_log.md](docs/h264_implementation_log.md)** - H.264エンコーディング実装ログ
- **[h264_encoding_integration_guide.md](docs/h264_encoding_integration_guide.md)** - H.264統合ガイド
- **[hw_encoding_faq.md](docs/hw_encoding_faq.md)** - ハードウェアエンコーディングFAQ

## クイックスタート（Phase 0: モック環境）

実機なしでローカルPC上で動作確認できます。

### 必要なもの
- Python 3.11以上
- uv（Pythonパッケージマネージャー）

### 実行手順

```bash
# 1. uvのインストール（未インストールの場合）
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. プロジェクトルートに移動
cd rdk-x5_smart-pet-camera

# 3. 依存関係のインストール
uv sync

# 4. モック環境の起動
uv run src/mock/main.py

# 5. ブラウザで確認
# http://localhost:8080 を開く
```

### オプション

```bash
# Webカメラを使用
uv run src/mock/main.py --source webcam

# テスト動画を使用
uv run src/mock/main.py --source video --source-path /path/to/video.mp4

# 検出頻度を調整
uv run src/mock/main.py --detection-prob 0.5

# ポート変更
uv run src/mock/main.py --port 9000
```

詳細は [src/mock/README.md](src/mock/README.md) を参照してください。

## 実機での実行（D-Robotics RDK X5）

### Phase 1-1.5: カメラ + YOLO検出（現在動作中）

```bash
# 1. カメラデーモンの起動（カメラ自動切り替え機能付き）
cd src/capture
make run-daemon  # またはmake run

# 2. YOLO検出デーモンの起動
cd src/detector
uv run yolo_detector_daemon.py

# 3. Webモニターの起動
cd src/monitor
uv run main.py --shm-type real

# 4. ブラウザで確認
# http://<RDK-IP>:8080 を開く
```

実機での詳細な設定は [src/capture/README.md](src/capture/README.md) を参照してください。

## システム要件

### ハードウェア
- **必須**
  - D-Robotics RDK X5 ボード（またはX3）
  - MIPI CSI カメラモジュール × 2（IMX219推奨）
  - メモリ: 最低2GB RAM
  - ストレージ: 最低32GB（推奨64GB以上）
- **推奨**
  - VPU/NPUハードウェアアクセラレーション（D-Robotics内蔵）

### ソフトウェア
- Linux（Ubuntu 22.04推奨）
- D-Robotics SDK（libspcdev, libvio等）
- Python 3.11以上
- uv（Pythonパッケージマネージャー）

## セットアップ（実機：D-Robotics RDK X5）

### 1. Python環境のセットアップ

```bash
# uvのインストール
curl -LsSf https://astral.sh/uv/install.sh | sh

# プロジェクトルートで依存関係をインストール
cd rdk-x5_smart-pet-camera
uv sync
```

### 2. Cコンポーネントのビルド

```bash
# カメラキャプチャデーモンのビルド
cd src/capture
make

# 動作確認
make test
```

### 3. YOLOモデルの配置

```bash
# YOLO v8n モデル（TensorFlow Lite形式）を配置
# models/ ディレクトリに yolov8n.tflite を配置
cp /path/to/yolov8n.tflite models/
```

### 4. カメラデバイスの確認

```bash
# D-Robotics カメラデバイスの確認
ls -l /dev/video*

# カメラ情報の確認
v4l2-ctl --list-devices
```

## 使用方法

### 開発モード（手動起動）

```bash
# ターミナル1: カメラキャプチャ（自動切り替え対応）
cd src/capture
make run-daemon  # デーモンモードで起動

# ターミナル2: YOLO物体検出
cd src/detector
uv run yolo_detector_daemon.py

# ターミナル3: Webモニター
cd src/monitor
uv run main.py --shm-type real

# ブラウザで http://<RDK-IP>:8080 を開く
```

### 便利なスクリプト

```bash
# カメラ切り替え + YOLO検出 + Webモニター一括起動
./scripts/run_camera_switcher_yolo.sh

# YOLO検出のベンチマーク
./scripts/run_yolo_benchmark.sh

# カメラ切り替え開発モード
./scripts/run_camera_switcher_dev.sh
```

### プロダクションモード（systemdサービス）

```bash
# サービスファイルのコピー（準備中）
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload

# サービスの起動
sudo systemctl start smart-pet-camera-capture
sudo systemctl start smart-pet-camera-detection
sudo systemctl start smart-pet-camera-monitor

# 自動起動の有効化
sudo systemctl enable smart-pet-camera-*

# ステータス確認
sudo systemctl status smart-pet-camera-*
```

## データ構造

### 記録データの配置

```
/data/smart-pet-camera/
├── 2025-01-01/
│   ├── events.jsonl              # 日次イベントログ
│   ├── 20250101_120530_001.json  # 個別イベント（詳細）
│   ├── 20250101_120530_001.mp4   # 対応動画
│   └── ...
├── 2025-01-02/
│   └── ...
└── metadata/
    ├── camera_status.json
    └── system_stats.json
```

### JSONフォーマット例

```json
{
  "event_id": "20250101_120530_001",
  "timestamp": "2025-01-01T12:05:30.123Z",
  "event_type": "eating",
  "start_time": "2025-01-01T12:05:30.123Z",
  "end_time": "2025-01-01T12:07:15.456Z",
  "duration_seconds": 105.333,
  "camera_id": "cam_day",
  "confidence": 0.92,
  "video_file": "20250101_120530_001.mp4"
}
```

## 開発

### ディレクトリ構造

```
rdk-x5_smart-pet-camera/
├── docs/                       # ドキュメント
│   ├── 01_project_goals.md         # プロジェクトゴール
│   ├── 02_requirements.md          # 要件定義
│   ├── 03_functional_design.md     # 機能設計
│   ├── 04_architecture.md          # アーキテクチャ
│   ├── development_roadmap.md      # 開発ロードマップ
│   ├── h264_implementation_log.md  # H.264実装ログ
│   └── ...                         # その他技術ドキュメント
├── src/                        # ソースコード
│   ├── capture/                    # カメラキャプチャ (C)
│   │   ├── camera_switcher.c           # カメラ切り替え機能
│   │   ├── camera_daemon_drobotics.c   # D-Roboticsカメラデーモン
│   │   ├── shared_memory.{c,h}         # POSIX共有メモリ
│   │   ├── real_shared_memory.py       # Python共有メモリラッパー
│   │   └── mock_detector_daemon.py     # ダミー検出デーモン
│   ├── detector/                   # 物体検出 (Python)
│   │   └── yolo_detector_daemon.py     # YOLO検出デーモン
│   ├── common/                     # 共通ライブラリ
│   │   └── src/
│   │       ├── common/types.py         # 共通型定義
│   │       └── detection/yolo_detector.py  # YOLO検出器
│   ├── monitor/                    # Webモニター (Python)
│   │   ├── web_monitor.py              # Flask Webサーバー
│   │   ├── h264_recorder.py            # H.264レコーダー
│   │   └── web_assets/                 # CSS/JavaScript
│   └── mock/                       # モック実装
│       ├── main.py                     # モック統合
│       ├── camera.py                   # モックカメラ
│       ├── detector.py                 # モック検出器
│       └── shared_memory.py            # モック共有メモリ
├── config/                     # 設定ファイル
├── models/                     # 学習済みモデル
├── tests/                      # テストコード
├── scripts/                    # 運用スクリプト
└── recordings/                 # 録画データ
```

### 開発ツール

#### Python環境管理
- **uv** - 高速なPythonパッケージマネージャー
  ```bash
  # uvのインストール
  curl -LsSf https://astral.sh/uv/install.sh | sh

  # pyproject.tomlの作成（初回のみ）
  uv init

  # 依存関係のインストール
  uv sync

  # 依存パッケージの追加
  uv add <package>

  # 開発ツールの追加
  uv add --dev pyright pylint pytest
  ```

#### 型チェック
- **pyright** - 型付け強制（厳格な型チェック）
  ```bash
  # 型チェック実行
  PYTHONPATH=src:src/common/src:src/mock:src/monitor uv run pyright src/
  ```

#### テストフレームワーク
- **pytest** - Pythonユニットテスト・統合テスト
- **Google Test** - Cコンポーネントのユニットテスト（方針決まり次第導入）

#### 推奨開発フロー
```bash
# 1. 型チェック
PYTHONPATH=src:src/common/src:src/mock:src/monitor uv run pyright src/

# 2. リンター
PYTHONPATH=src:src/common/src:src/mock:src/monitor uv run pylint src/

# 3. テスト実行
uv run pytest tests/

# 4. カバレッジ確認
uv run pytest --cov=src tests/
```

### テストの実行

```bash
# Pythonユニットテスト
uv run pytest tests/unit/

# 統合テスト
uv run pytest tests/integration/

# カバレッジ付き実行
uv run pytest --cov=src tests/

# 型チェック
PYTHONPATH=src:src/common/src:src/mock:src/monitor uv run pyright src/
```

### コーディング規約

- **C**: GNU Coding Standards
- **Python**: PEP 8 + 型ヒント必須（pyright準拠）
- **命名規則**: snake_case（関数・変数）、PascalCase（クラス）
- **コメント**: 日本語OK、複雑なロジックには必ず説明を追加
- **型アノテーション**: すべての関数に型ヒントを追加

## トラブルシューティング

### カメラが認識されない

```bash
# カメラデバイスの確認
ls -l /dev/video*

# V4L2情報の確認
v4l2-ctl --list-devices
v4l2-ctl -d /dev/video0 --all

# 権限の確認
sudo usermod -a -G video $USER
# ログアウト・ログインして反映
```

### 物体検出が動作しない

```bash
# モデルファイルの確認
ls -l models/

# Pythonパッケージの確認
uv run python -m pip list | grep -E "tensorflow|onnx|opencv"

# ログの確認
journalctl -u smart-pet-camera-detection -n 100
```

### ディスク容量不足

```bash
# 古いデータの手動削除
./scripts/cleanup_old_data.sh 7  # 7日より古いデータを削除

# ディスク使用状況の確認
df -h /data/smart-pet-camera
du -sh /data/smart-pet-camera/*/
```

## ログの確認

```bash
# リアルタイムログ
sudo journalctl -u smart-pet-camera-* -f

# 特定サービスのログ
sudo journalctl -u smart-pet-camera-capture -n 100

# アプリケーションログファイル
tail -f /var/log/smart-pet-camera/app.log
```

## 設定のカスタマイズ

主要な設定項目（`config/config.yaml`）：

- **cameras**: カメラデバイスパス、解像度、FPS
- **object_detection**: モデルパス、信頼度閾値
- **behavior_estimation**: IoU閾値、最小継続時間
- **recording**: 保存先、動画コーデック、保持期間

詳細は `config/config.example.yaml` を参照してください。

## ロードマップ

### Phase 0: モック環境構築 ✅ 完了（2025-12-19）
- [x] 共通型定義（types.py）
- [x] MockSharedMemory実装
- [x] MockCamera実装
- [x] MockDetector実装
- [x] WebMonitor実装（MJPEG配信）
- [x] 統合メインプログラム実装

### Phase 1: 実機Captureデーモン化 ✅ 完了（2025-12-20）
- [x] POSIX共有メモリ実装（atomic操作対応）
- [x] D-Robotics カメラデーモン実装（MIPI対応）
- [x] Python統合ラッパー（RealSharedMemory）
- [x] ダミー検出デーモン実装
- [x] バウンディングボックス合成機能
- [x] WebMonitorでのリアルタイム表示

### Phase 1.5: カメラ切り替え＆YOLO検出 ✅ 完了（2025-12-21）
- [x] 昼夜カメラ自動切り替え機能（Camera Switcher）
- [x] YOLO v8n 物体検出実装（TensorFlow Lite）
- [x] リアルタイムYOLO検出デーモン
- [x] 検出結果の共有メモリ連携
- [x] Web UI統計情報表示

### Phase 2: H.264ハードウェアエンコーディング 🚧 進行中（2025-12-21）
- [x] D-Robotics VIOモジュール統合
- [x] ハードウェアH.264エンコーダ実装
- [x] 共有メモリフォーマット拡張（H.264対応）
- [x] H.264レコーダー実装
- [ ] WebRTCストリーミング対応（計画中）

### Phase 3: 行動推定と記録（計画中）
- [ ] バウンディングボックス重なり判定
- [ ] 行動イベント生成（食事・水飲み）
- [ ] JSON + 動画の保存
- [ ] 古いデータの自動削除

### Phase 4: 高度な機能（将来的）
- [ ] 個体識別（複数猫対応）
- [ ] 行動パターン分析
- [ ] 異常検知アラート
- [ ] クラウド連携

## 貢献

このプロジェクトへの貢献を歓迎します。

## ライセンス

（ライセンスを明記予定）

## 連絡先

（連絡先情報を記載予定）

---

**Note**: このプロジェクトは開発中です。機能や仕様は変更される可能性があります。
