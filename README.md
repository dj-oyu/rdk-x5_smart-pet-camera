# スマートペットカメラ

AI物体検出技術を活用し、ペット（猫）の日常行動を自動的に記録・分析するスマート監視システム

## プロジェクト概要

このシステムは、2基のカメラ（昼間用・夜間用）を使用して、猫の食事・水飲み行動を24時間体制で自動検出し、動画とJSONデータとして記録します。

### 主な機能

- 昼間カメラ・夜間カメラの2基体制での監視
- AI物体検出による猫、餌皿、水飲み場の認識
- バウンディングボックスの重なり判定による行動推定
- 行動イベントの動画記録（開始前後数秒含む）
- JSON形式での構造化データ保存
- 24時間連続稼働対応

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

## システム要件

### ハードウェア
- カメラモジュール × 2（V4L2対応）
- 組み込みLinuxボード（ARM/x86_64）
- メモリ: 最低2GB RAM
- ストレージ: 最低32GB（推奨64GB以上）
- GPU/NPU（推奨）

### ソフトウェア
- Linux（カーネル4.x以上）
- GCC 7.x以上
- Python 3.7以上
- V4L2ドライバ

## セットアップ

### 1. 依存関係のインストール

```bash
cd /app/smart-pet-camera
chmod +x scripts/install_deps.sh
./scripts/install_deps.sh
```

### 2. 設定ファイルの作成

```bash
cp config/config.example.yaml config/config.yaml
# config.yamlを環境に合わせて編集
```

### 3. カメラデバイスの確認

```bash
v4l2-ctl --list-devices
# /dev/video0, /dev/video1 などのデバイスパスを確認し、config.yamlに反映
```

### 4. 物体検出モデルの配置

```bash
# 学習済みモデルを models/ ディレクトリに配置
# 例: models/pet_detector_v1.tflite
```

### 5. ビルド（Cコンポーネント）

```bash
make
# または
mkdir build && cd build
cmake ..
make
```

## 使用方法

### 開発モード（手動起動）

```bash
# ターミナル1: カメラキャプチャ
./build/capture_main

# ターミナル2: 物体検出
python3 src/detection/main_detection.py

# ターミナル3: データ記録
python3 src/recording/main_recording.py
```

### プロダクションモード（systemdサービス）

```bash
# サービスファイルのコピー
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload

# サービスの起動
sudo systemctl start smart-pet-camera-capture
sudo systemctl start smart-pet-camera-detection
sudo systemctl start smart-pet-camera-recording

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
/app/smart-pet-camera/
├── docs/           # ドキュメント
├── src/            # ソースコード
│   ├── capture/    # カメラキャプチャ (C)
│   ├── detection/  # 物体検出 (Python)
│   ├── behavior/   # 行動推定 (Python)
│   ├── recording/  # データ記録 (Python)
│   ├── config/     # 設定管理
│   ├── monitor/    # システム監視
│   └── utils/      # ユーティリティ
├── config/         # 設定ファイル
├── models/         # 学習済みモデル
├── tests/          # テストコード
└── scripts/        # 運用スクリプト
```

### 開発ツール

#### Python環境管理
- **uv** - 高速なPythonパッケージマネージャー
  ```bash
  # uvのインストール
  curl -LsSf https://astral.sh/uv/install.sh | sh

  # 依存関係のインストール
  uv pip install -r requirements.txt

  # 仮想環境の作成
  uv venv
  source .venv/bin/activate
  ```

#### 型チェック
- **pyright** - 型付け強制（厳格な型チェック）
  ```bash
  # pyrightのインストール
  npm install -g pyright
  # または
  uv pip install pyright

  # 型チェック実行
  pyright src/
  ```

#### テストフレームワーク
- **pytest** - Pythonユニットテスト・統合テスト
- **Google Test** - Cコンポーネントのユニットテスト（方針決まり次第導入）

#### 推奨開発フロー
```bash
# 1. 型チェック
pyright src/

# 2. リンター
pylint src/

# 3. テスト実行
pytest tests/

# 4. カバレッジ確認
pytest --cov=src tests/
```

### テストの実行

```bash
# Pythonユニットテスト
pytest tests/unit/

# 統合テスト
pytest tests/integration/

# カバレッジ付き実行
pytest --cov=src tests/

# 型チェック
pyright src/
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
pip3 list | grep -E "tensorflow|onnx|opencv"

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

### Phase 1: MVP（現在）
- [x] プロジェクト構造作成
- [x] ドキュメント整備
- [ ] カメラキャプチャ実装
- [ ] 物体検出実装
- [ ] 基本的な行動推定

### Phase 2: 機能拡充
- [ ] マルチカメラ対応
- [ ] 動画記録機能
- [ ] 設定管理強化

### Phase 3: 安定化
- [ ] 24時間連続稼働テスト
- [ ] パフォーマンス最適化
- [ ] 自動復旧機能

### Phase 4: 高度な機能（将来的）
- [ ] 個体識別
- [ ] Web UIダッシュボード
- [ ] クラウド連携

## 貢献

このプロジェクトへの貢献を歓迎します。

## ライセンス

（ライセンスを明記予定）

## 連絡先

（連絡先情報を記載予定）

---

**Note**: このプロジェクトは開発中です。機能や仕様は変更される可能性があります。
