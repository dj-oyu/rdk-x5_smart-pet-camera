# 開発ロードマップとタスク管理

スマートペットカメラプロジェクトの開発計画とタスク管理

**最終更新**: 2025-12-20

---

## 全体計画

### 開発方針

1. **モック優先**: 実機なしでローカルPC上で全体システムを検証
2. **段階的実装**: 各フェーズで動作確認しながら価値を積み上げ
3. **疎結合設計**: 各モジュールを独立して開発・テスト可能
4. **早期評価環境**: Webモニター優先でモデル評価を早期実現

### フェーズ構成

```
Phase 0: モック環境構築 ✅ 完了
    ↓
Phase 1: 実機Capture実装 （次のステップ）
    ↓
Phase 2: 実機統合
    ↓
Phase 3: 本物の検出モデル統合
```

---

## Phase 0: モック環境構築 ✅ 完了

**目的**: 実機なしで全体システムの動作を検証し、インターフェースを確定

**ブランチ**: `phase-0-mock`
**完了日**: 2025-12-19

### 成果物

#### ✅ Phase 0-1: 共通型定義（types.py）
- Frame, Detection, BoundingBox, DetectionResult, BehaviorEvent
- C実装との互換性を考慮した構造体定義
- 完全な型ヒント対応（pyright準拠）

**ファイル**: `src/common/src/common/types.py` (209行)

#### ✅ Phase 0-2: MockSharedMemory実装
- スレッドセーフなリングバッファ
- POSIX共有メモリと同じインターフェース
- フレームと検出結果を管理

**ファイル**: `src/mock/shared_memory.py` (269行)

#### ✅ Phase 0-3: MockCamera実装
- 4種類のソース対応（random/video/webcam/image）
- フレームレート制御
- JPEG エンコード

**ファイル**: `src/mock/camera.py` (269行)

#### ✅ Phase 0-4: MockDetector実装
- ランダムBBox生成
- クラス別の特性（猫/餌皿/水飲み場）
- 検出確率制御、統計情報収集

**ファイル**: `src/mock/detector.py` (195行)

#### ✅ Phase 0-5: WebMonitor実装
- Flask + MJPEGストリーミング
- BBox合成表示
- リアルタイムFPS表示
- HTML UI内蔵

**ファイル**: `src/monitor/web_monitor.py` (389行)

#### ✅ Phase 0-6: 統合メインプログラム実装
- 全モジュールの統合
- マルチスレッド制御（camera/detection/monitor）
- コマンドラインインターフェース
- シグナルハンドリング

**ファイル**: `src/mock/main.py` (270行)

#### ✅ Phase 0-7: README作成と依存関係追加
- ドキュメント整備
- uv初期化（Python 3.13/3.11）

**ファイル**: `src/mock/README.md` (172行)

### 達成内容

- ✅ **実機不要**: ローカルPC（Linux/Mac/Windows）で完全動作
- ✅ **型安全**: pyright準拠の型ヒント
- ✅ **独立モジュール**: 各モジュールが疎結合
- ✅ **デバッグ容易**: print文、デバッガ使用可能
- ✅ **インターフェース確定**: C実装のための仕様が明確

### 実行方法

```bash
cd src/mock
uv pip install flask opencv-python numpy
python main.py
# http://localhost:8080 でブラウザ確認
```

---

## Phase 1: 実機Captureデーモン化 ✅ 完了

**目的**: `capture_v2.c`を共有メモリ対応デーモンに改造

**ブランチ**: `claude/mipi-camera-dev`
**開始日**: 2025-12-19
**完了日**: 2025-12-20

### 進捗状況

#### ✅ 完了したタスク

1. **共有メモリ構造体の実装（C）**
   - POSIX共有メモリ（shm_open/mmap）実装完了
   - atomic操作（`__atomic_fetch_add`）によるロックフリー実装
   - リングバッファ（30フレーム）実装
   - ファイル: `src/capture/shared_memory.{h,c}`
   - テスト: **5/5 テスト成功** (`test_shm.c`)

2. **D-Robotics APIベースのデーモン実装**
   - 当初V4L2で実装を開始したが、ユーザーから「`docs/sample/capture_v2.c`をそのまま模倣すべき」との指摘
   - **方針転換**: D-Robotics ネイティブAPI（libcam.so/libvpf.so）を使用
   - VIN/ISP/VSEパイプライン構築
   - NV12→RGB→JPEG変換実装（libjpeg使用）
   - 共有メモリへのフレーム書き込み実装
   - ファイル: `src/capture/camera_daemon_drobotics.c`
   - V4L2版は参考用に `reference_v4l2/` へ移動

3. **ビルド環境の整備**
   - D-Robotics SDK確認（/usr/hobot/lib）
   - Makefile.drobotics作成
   - プロセス管理機能追加：
     - `make cleanup`: プロセス終了 + 共有メモリクリーンアップ
     - `make kill-processes`: カメラプロセス強制終了
     - `make run`: 自動クリーンアップ後にデーモン起動
     - `make run-daemon`: バックグラウンド起動
   - ビルド成功（警告のみ、エラーなし）

4. **Python統合ラッパー**
   - `real_shared_memory.py`: C共有メモリへのPythonアクセス
   - MockSharedMemoryと同じインターフェース
   - `test_integration.py`: モックとの統合テスト成功

5. **ハードウェア確認**
   - IMX219センサー検出確認（1920x1080@30fps, MIPI 2-lane）
   - D-Roboticsデバイスノード確認:
     - vin0-3_cap (VIN capture)
     - vs-isp0_cap (ISP)
     - vs-vse0_cap0-5 (VSE outputs)
     - ion (メモリアロケータ)

6. **カメラデーモン動作確認** ✅
   - カメラデーモン初期化ハング問題を解決
   - D-Robotics カメラデーモンが正常に起動・動作
   - 共有メモリへのフレーム書き込みが安定稼働中

7. **ダミー検出デーモン実装** ✅
   - `mock_detector_daemon.py` 実装完了
   - ランダムなBBox生成（cat/food_bowl/water_bowl）
   - 10-15fpsで検出結果を共有メモリに書き込み
   - 検出数・位置・サイズ・クラスがランダムに変化

8. **バウンディングボックス合成機能実装** ✅
   - WebMonitorでBBox描画処理実装
   - クラス別色分け（cat=緑、food_bowl=オレンジ、water_bowl=青）
   - 信頼度スコア表示
   - リアルタイムMJPEGストリーミング（30fps）
   - ブラウザでの動作確認完了

9. **RealSharedMemory バグ修正** ✅
   - `read_detection()` が2回目以降`None`を返すバグを修正
   - バージョンフィルタリングロジックを改善
   - 検出結果の正常な読み取りを確認

### 成果ファイル

| ファイル | 行数 | 状態 | 説明 |
|---------|------|------|------|
| `src/capture/shared_memory.h` | 146 | ✅ | POSIX共有メモリ構造体定義 |
| `src/capture/shared_memory.c` | 270 | ✅ | 共有メモリ実装（atomic操作含む） |
| `src/capture/test_shm.c` | 239 | ✅ | ユニットテスト（5/5成功） |
| `src/capture/camera_daemon_drobotics.c` | ~700 | ✅ | D-Robotics カメラデーモン（動作中） |
| `src/capture/Makefile.drobotics` | 153 | ✅ | ビルド設定（プロセス管理含む） |
| `src/capture/real_shared_memory.py` | ~200 | ✅ | Python共有メモリアクセス |
| `src/capture/mock_detector_daemon.py` | 153 | ✅ | ダミー検出デーモン |
| `src/capture/test_integration.py` | 200 | ✅ | 統合テスト |
| `src/capture/README_DROBOTICS.md` | 416 | ✅ | D-Robotics実装ドキュメント |
| `reference_v4l2/camera_daemon.c` | 589 | 📁 | V4L2版（参考用） |

### タスク

#### Phase 1-1: 共有メモリ構造体の設計（C）
- Phase 0で確定したインターフェース仕様に基づく
- POSIX共有メモリ（shm_open/mmap）実装
- atomic操作の実装

**予定ファイル**:
- `src/capture/shared_memory.h`
- `src/capture/shared_memory.c`

**完成判定**: テストプログラムで読み書き確認

#### Phase 1-2: capture_v2.cのリファクタリング
- リングバッファへの書き込みロジック追加
- デーモンモード（無限ループ）対応
- シグナルハンドリング（SIGTERM/SIGINTでクリーンシャットダウン）

**予定ファイル**:
- `src/capture/capture_daemon.c`
- `src/capture/camera_manager.c`

**完成判定**: デーモンが30fpsで共有メモリに書き込み

#### Phase 1-3: Python統合テスト
- Pythonから共有メモリを読み取るラッパー実装
- MockSharedMemoryと同じインターフェース提供

**予定ファイル**:
- `src/capture/real_shared_memory.py` (PythonからC共有メモリアクセス)

**完成判定**: Pythonで読み取ったフレームをファイル保存

#### Phase 1-4: Makefileとビルド設定
- 共有メモリ対応のビルド設定
- テストプログラムのビルド

**予定ファイル**:
- `src/capture/Makefile` (更新)
- `tests/test_capture_shm.c`

**完成判定**: `make && make test` が成功

### 技術的課題

1. **POSIX共有メモリのサイズ計算**
   - フレームサイズ × リングバッファサイズ
   - メモリマッピングの効率化

2. **atomic操作の実装**
   - GCC組み込み関数 (`__atomic_*`)
   - write_indexの安全な更新

3. **V4L2との統合**
   - 既存のcapture_v2.cコードの活用
   - マルチカメラ対応の維持

---

## Phase 2: 実機統合 📋 計画中

**目的**: モックから実機共有メモリへの切り替え

**ブランチ**: `phase-2-integration` (予定)

### タスク

#### Phase 2-1: 共有メモリアダプタパターン実装
```python
# 環境変数またはフラグで切り替え
if os.getenv("USE_MOCK"):
    shm = MockSharedMemory()
else:
    shm = RealSharedMemory("/dev/shm/pet_camera")
```

#### Phase 2-2: Webモニター実機接続
- モニターは変更なしでそのまま使用
- 実機共有メモリからのフレーム読み取り

#### Phase 2-3: エンドツーエンドテスト
- カメラ → 共有メモリ → モニター の動作確認
- 30fps維持の確認

### 完成判定
- 実機カメラの映像がブラウザでリアルタイム表示される

---

## Phase 3: 本物の検出モデル統合 📋 計画中

**目的**: MockDetectorを実際の物体検出モデルに差し替え

**ブランチ**: `phase-3-detection` (予定)

### タスク

#### Phase 3-1: モデルの準備
- 学習済みモデルの取得またはファインチューニング
- TensorFlow Lite / ONNX形式への変換
- モデルファイルの配置

**対象モデル候補**:
- YOLOv5-nano
- MobileNet-SSD
- EfficientDet-Lite0

#### Phase 3-2: RealDetector実装
```python
class RealDetector:
    def __init__(self, model_path: str):
        self.interpreter = tflite.Interpreter(model_path)
        self.interpreter.allocate_tensors()

    def detect(self, frame: Frame) -> list[Detection]:
        # 実際の推論処理
        pass
```

**予定ファイル**:
- `src/detection/real_detector.py` (Python 3.11)

#### Phase 3-3: パフォーマンスチューニング
- 推論時間の測定
- フレームスキップの調整
- GPU/NPUアクセラレータの活用

#### Phase 3-4: 精度評価
- テストデータでの評価
- Webモニターでリアルタイム確認
- 検出精度の測定

### 完成判定
- 実際の猫、餌皿、水飲み場が検出される
- 検出精度90%以上
- 推論レイテンシ100ms以内

---

## Phase 4以降: 高度な機能（将来的）

### Phase 4: 行動推定と記録
- バウンディングボックスの重なり判定
- 行動イベントの生成
- JSON + 動画の保存

### Phase 5: データ管理
- 古いデータの自動削除
- ストレージ監視
- データ圧縮

### Phase 6: Web UI拡張
- 統計情報の表示
- 行動履歴の可視化
- 設定変更UI

### Phase 7: 高度な機能
- 個体識別（複数猫対応）
- 行動パターン分析
- 異常検知アラート
- クラウド連携

---

## マイルストーン

| Phase | 目標 | 完了日 | ステータス |
|-------|------|---------|-----------|
| Phase 0 | モック環境構築 | 2025-12-19 | ✅ 完了 |
| Phase 1 (旧) | 実機Capture + BBox合成 | 2025-12-20 | ✅ 完了 |
| **Phase 1 (H.264)** | **H.264 HW Encoding** | 2025-12-23 | ✅ 完了 |
| **Phase 2 (H.264)** | **カメラスイッチャーH.264対応** | 2025-12-24 | ✅ 完了 |
| **Phase 3 (H.264)** | **WebRTC H.264配信** | 2025-12-26 | 🔧 実装完了・デバッグ中 |
| Phase 4 | 本物の検出モデル統合 | TBD | 📋 計画中 |
| Phase 5 | 行動推定 | TBD | 📋 計画中 |

### Phase 1 達成内容（100%完了）
- ✅ 共有メモリ実装・テスト完了（POSIX shm、atomic操作）
- ✅ D-Robotics カメラデーモン実装・動作確認
- ✅ ビルド環境整備完了（Makefile、プロセス管理）
- ✅ Python統合ラッパー完了（RealSharedMemory）
- ✅ ダミー検出デーモン実装完了（10-15fps）
- ✅ バウンディングボックス合成機能実装完了
- ✅ WebMonitorでのリアルタイム表示確認
- ✅ ブラウザでの動作確認完了（http://192.168.1.33:8080）

**デモ**: カメラ映像にランダムなBBoxが10-15fpsで変化しながら表示

---

## リスクと対策

### 技術的リスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 共有メモリのパフォーマンス | 高 | Phase 0でインターフェース確定済み |
| V4L2との統合の複雑さ | 中 | capture_v2.c の実績活用 |
| 検出モデルの精度不足 | 高 | モックで早期評価環境確立 |
| 推論レイテンシー | 高 | 軽量モデル選定、GPU活用 |

### スケジュールリスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 実機デバッグ時間 | 中 | モック環境で事前検証 |
| モデル学習時間 | 低 | 事前学習モデル活用 |
| ハードウェア不具合 | 低 | 複数カメラで冗長化 |

---

## 変更履歴

- 2025-12-26: **Phase 3 (H.264) 実装完了・デバッグ中** 🔧
  - aiortc/av依存関係追加（WebRTC対応）
  - H264StreamTrack実装（共有メモリ → WebRTC）
  - WebRTCシグナリングサーバー実装（SDP offer/answer）
  - Flask統合（/api/webrtc/offer エンドポイント）
  - ブラウザWebRTCクライアント実装
  - Canvas BBoxオーバーレイ（SSE統合）
  - HTML UI更新（WebRTC/MJPEG切り替え）
  - **課題**: WebRTC接続確立のデバッグ中
  - **詳細**: [webrtc_phase3_implementation_log.md](./webrtc_phase3_implementation_log.md)

- 2025-12-24: **Phase 2 (H.264) 完了** ✅
  - カメラスイッチャーH.264対応完了
  - NV12+H.264デュアルフォーマット生成
  - 6箇所の共有メモリ構成
  - ブラックアウトなしのカメラ切り替え
  - NV12色変換問題解決（`sp_vio_get_frame()`使用）
  - **詳細**: [camera_switcher_h264_migration.md](./camera_switcher_h264_migration.md)

- 2025-12-23: **Phase 1 (H.264) 完了** ✅
  - H.264ハードウェアエンコーディング実装
  - libspcdev統合（VIO→Encoder直結）
  - CPU使用率57%削減、ビットレート47%削減
  - H264Recorder実装（0バイト問題解決）
  - **詳細**: [h264_implementation_log.md](./h264_implementation_log.md)

- 2025-12-20: **Phase 1 (旧) 完了** 🎉
  - カメラデーモン初期化ハング問題を解決
  - カメラデーモンが正常に動作（D-Robotics MIPI）
  - ダミー検出デーモン実装完了（10-15fps、ランダム変化）
  - バウンディングボックス合成機能実装完了
  - RealSharedMemory.read_detection() バグ修正
  - WebMonitorでのリアルタイム表示確認
  - ブラウザでの動作確認完了
  - **成果**: http://192.168.1.33:8080 でBBox合成映像を配信中
- 2025-12-19 19:30: Phase 1 進捗報告
  - 共有メモリ実装完了（5/5テスト成功）
  - D-Roboticsデーモン実装完了（カメラ初期化でハング中）
  - V4L2版は参考用に移動
  - Makefileにプロセス管理機能追加
  - Python統合ラッパー完了
- 2025-12-19 00:00: Phase 0完了、ドキュメント作成
