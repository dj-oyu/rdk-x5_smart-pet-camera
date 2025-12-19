# 議事録: スマートペットカメラ システムアーキテクチャ検討会

**日時**: 2025-12-19
**議題**: プロジェクト立ち上げ、アーキテクチャ設計、開発計画策定

---

## 1. プロジェクト立ち上げ

### 実施内容
- `/app/smart-pet-camera/` プロジェクトディレクトリの作成
- 開発ドキュメントの整備
  - `01_project_goals.md` - プロジェクトゴール
  - `02_requirements.md` - 要件定義
  - `03_functional_design.md` - 機能設計
  - `04_architecture.md` - システムアーキテクチャ
- 設定ファイル、依存関係、Makefileなどの初期セットアップ完了
- `docs/sample/` に既存の `capture_v2.c` 等へのシンボリックリンクを配置

### プロジェクト概要（再確認）
- **目的**: 猫の水飲み・食事行動を物体検出で自動記録
- **カメラ構成**: 昼間カメラ + 夜間カメラの2基体制
- **記録形式**: JSON（行動メタデータ） + 動画ファイル
- **行動推定**: バウンディングボックスの重なり判定による行動認識
- **基盤技術**: 既存の `capture_v2.c` を活用

---

## 2. 技術的課題の検討

### 課題1: 物体検出のレイテンシー問題

**問題提起**:
- 物体検出の推論時間（50-100ms）が30fpsのフレームタイム（33ms）を超える
- 全体の処理が物体検出に律速される可能性

**要件の整理**:
- **物体検出**: 10-15fps程度でOK（リアルタイム不要）
- **動画録画**: 30fps必須（リアルタイム必須）
- **BBox合成**: 30fps必須（モニタリング用、検出結果は使い回し可）

**重要な洞察**:
> BBox合成は常に最新フレームに追いつく必要はなく、カメラ側のfpsに最大限追随しながら、過去フレームの検出結果を使い回してボックス合成すればよい

```
Camera:           ████████████████████████████████  (30fps)
Object Detection: ███   ███   ███   ███   ███      (10fps, 非同期)
BBox Overlay:     ████████████████████████████████  (30fps, 検出結果は使い回し)
                  ↑   ↑ ↑   ↑ ↑   ↑ ↑   ↑ ↑   ↑
                  新  古 新  古 新  古 新  古 新  古  ← 検出結果の鮮度
```

---

## 3. アーキテクチャ決定事項

### 3.1 モジュール分割とIPC方式

**決定: 共有メモリ（Shared Memory）を採用**

#### 検討した選択肢
1. **名前付きパイプ（Named Pipe）**
   - メリット: シンプル、Unixの思想に沿う
   - デメリット: データサイズ大（81MB/s）、複数消費者が困難、ブロッキング

2. **ZeroMQ Pub/Sub**
   - メリット: 柔軟、複数消費者に対応
   - デメリット: オーバーヘッド、複雑

3. **共有メモリ（採用）**
   - メリット: ゼロコピー、最速、複数消費者に対応、シンプル
   - デメリット: 同期制御が必要（atomic操作で対処）

#### 採用したアーキテクチャ

```
┌──────────────────┐
│ Camera Capture   │ (30fps, C言語)
│   (Process 1)    │
└────────┬─────────┘
         ↓
┌─────────────────────────────┐
│ Shared Memory Segment 1     │
│ [Frame Ring Buffer]         │  ← 30フレーム分のリングバッファ
│ - frame_data[30]            │
│ - write_index (atomic)      │
└────┬──────────────┬─────────┘
     │              │
     │              ↓
     │    ┌──────────────────┐
     │    │ Object Detector  │ (10fps, Python, 非同期)
     │    │   (Process 2)    │
     │    └────────┬─────────┘
     │             ↓
     │    ┌──────────────────────────┐
     │    │ Shared Memory Segment 2  │
     │    │ [Latest Detection]       │  ← 最新の検出結果のみ
     │    │ - frame_number           │
     │    │ - timestamp              │
     │    │ - detections[]           │
     │    │ - version (atomic)       │
     │    └────────┬─────────────────┘
     │             │
     └─────────────┴─→ ┌──────────────────┐
                       │ BBox Overlay      │ (30fps, Python)
                       │   (Process 3)     │
                       │ 1. 最新フレーム取得│
                       │ 2. 最新検出結果取得│
                       │ 3. 合成           │
                       │ 4. 録画/表示      │
                       └──────────────────┘
```

#### 共有メモリ構造体（設計案）

```c
// Shared Memory Segment 1: フレームバッファ
typedef struct {
    uint8_t frame_data[FRAME_SIZE];
    uint64_t frame_number;
    struct timespec timestamp;
    int camera_id;
} Frame;

typedef struct {
    Frame frames[RING_BUFFER_SIZE];  // 30フレーム分
    volatile uint32_t write_index;
    pthread_mutex_t lock;
} SharedFrameBuffer;

// Shared Memory Segment 2: 最新検出結果
typedef struct {
    uint64_t frame_number;
    struct timespec timestamp;
    int num_detections;
    Detection detections[MAX_DETECTIONS];
    volatile uint32_t version;  // 更新カウンタ（atomic）
} LatestDetectionResult;
```

### 3.2 プロセス構成と非同期実行

**決定: マルチプロセス + ポーリング方式（同期不要）**

#### 選択肢の検討
1. マルチスレッド（単一プロセス）
   - 問題: PythonのGIL、言語混在が困難

2. Python asyncio
   - 問題: C言語のカメラキャプチャと統合が複雑

3. **マルチプロセス + ポーリング（採用）**
   - メリット: 障害分離、言語混在可能、デバッグ容易、リソース管理容易
   - 実装: systemdサービスとして各プロセスを独立管理

#### ポーリング方式の詳細

**「ポーリング」の定義**:
- 各プロセスが他のプロセスを監視するのではなく、**共有メモリのデータ（インデックス、バージョンカウンタ）を定期的にチェック**

**各プロセスの動作**:

1. **Capture Process**: ポーリングなし（書き込み専用）
   ```c
   while (running) {
       capture_frame(&frame);
       uint32_t idx = atomic_fetch_add(&shm->write_index, 1) % RING_SIZE;
       memcpy(&shm->frames[idx], &frame, sizeof(Frame));
       sleep_33ms();
   }
   ```

2. **Detection Process**: フレーム共有メモリの`write_index`をポーリング
   ```python
   last_frame_num = -1
   while True:
       current_idx = read_atomic(frame_shm.write_index)
       frame_num = frame_shm.frame_numbers[current_idx]
       if frame_num > last_frame_num:
           detections = model.detect(frame)
           write_detection_shm(detections)
           last_frame_num = frame_num
       sleep_100ms()
   ```

3. **Overlay Process**: フレーム共有メモリ + 検出結果共有メモリをポーリング
   ```python
   cached_detections = None
   cached_version = 0
   while True:
       frame = read_latest_frame(frame_shm)
       current_ver = read_detection_version(det_shm)
       if current_ver != cached_version:
           cached_detections = read_detections(det_shm)
           cached_version = current_ver
       overlay_frame = draw_bboxes(frame, cached_detections)
       save_video(overlay_frame)
       sleep_33ms()
   ```

**同期メカニズム**:
- セマフォ不要
- atomic操作のみ（`__atomic_load_n`, `__atomic_fetch_add`）
- 各プロセスは完全に独立して動作、デッドロックなし

---

## 4. 開発計画

### フェーズ分け戦略

**方針**:
- 各モジュールを独立性高く開発
- 段階的に価値を積み上げ、各フェーズで動作確認
- 検出モデルは後回し、モニター機能を優先

### Phase 1: Captureデーモン化（基盤構築）

**目的**: `capture_v2.c` をリングバッファ対応の共有メモリデーモンに改造

**タスク**:
1. 共有メモリ構造体の設計・実装
2. `capture_v2.c` のリファクタリング
   - リングバッファ書き込みロジック追加
   - デーモンモード（無限ループ）対応
   - シグナルハンドリング（SIGTERM/SIGINTでクリーンシャットダウン）
3. 簡易テストプログラム（共有メモリから読み取って表示）

**成果物**:
- `src/capture/capture_daemon.c`
- `src/capture/shared_memory.h`
- `tests/read_shm_test.c`

**完成判定**: テストプログラムで30fpsのフレームが読めることを確認

---

### Phase 2: モック検出モジュール（検証環境）

**目的**: 実際の物体検出なしで、システム全体の動作を検証

**実装内容**:
- 決め打ちのタイミングでランダムな座標のBBoxを生成
- 検出結果を共有メモリに書き込み

**実装例**:
```python
# src/detection/mock_detector.py
class MockDetector:
    def generate_mock_detections(self):
        if random.random() < 0.05:  # 約2秒に1回
            num_boxes = random.randint(1, 3)
            return [
                {
                    "class": random.choice(["cat", "food_bowl", "water_bowl"]),
                    "bbox": {"x": rand(), "y": rand(), "w": rand(), "h": rand()},
                    "confidence": random.uniform(0.7, 0.99)
                }
                for _ in range(num_boxes)
            ]
        return []
```

**成果物**:
- `src/detection/mock_detector.py`
- 検出結果共有メモリ構造体の実装

**完成判定**: 検出結果がランダムに生成され、共有メモリに書き込まれることを確認

---

### Phase 3: Webモニター（最重要）

**目的**: ブラウザでリアルタイムにBBox合成映像を確認

**重要性**:
> ここ次第でカメラ性能やモデル選定の評価ができるようになる

**技術選定**: Flask + MJPEG streaming

**理由**:
- シンプルで実装が容易
- ブラウザ互換性が高い（`<img src="stream.mjpeg">`で表示）
- 遅延は許容範囲（100-200ms）
- WebSocketより実装が簡単

**アーキテクチャ**:
```
Overlay Thread (30fps)
  ├─ フレーム共有メモリから読み取り
  ├─ 検出結果共有メモリから読み取り（更新されていれば）
  ├─ BBox合成
  └─ キューに追加
      ↓
MJPEG Stream Thread
  ├─ キューからフレーム取得
  ├─ JPEG エンコード
  └─ HTTP multipart/x-mixed-replace として送信
      ↓
Browser: <img src="/stream">
```

**実装イメージ**:
```python
# src/monitor/web_monitor.py
@app.route('/stream')
def video_stream():
    return Response(generate_mjpeg(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/')
def index():
    return '''
    <html>
      <body>
        <h1>🐱 Smart Pet Camera Monitor</h1>
        <img src="/stream" width="1280" height="720">
        <div>FPS: <span id="fps">--</span></div>
        <div>Detections: <span id="det-count">--</span></div>
      </body>
    </html>
    '''
```

**成果物**:
- `src/monitor/web_monitor.py`
- BBox描画ユーティリティ
- Webインターフェース（HTML/CSS）

**完成判定**:
- ブラウザで `http://<device-ip>:8080` にアクセス
- リアルタイムでBBox合成映像が表示される
- カメラFPS、検出数などの統計情報が表示される

---

### Phase 4: 本物の検出モデル統合（仕上げ）

**目的**: モックを実際の物体検出モデルに差し替え

**実装内容**:
- TensorFlow Lite / ONNX Runtimeによる実際の推論
- モデルファイルの準備（ファインチューニングまたは事前学習モデル）
- パフォーマンスチューニング

**重要な点**:
- Phase 3のモニターは**そのまま使える**
- インターフェース（共有メモリ構造）は変更不要
- モデルの性能評価が即座にできる

**成果物**:
- `src/detection/real_detector.py`
- 学習済みモデル（`models/pet_detector_v1.tflite`）
- モデル性能評価レポート

---

## 5. メリットの再確認

### アーキテクチャのメリット

1. **疎結合**: 各モジュールを異なる言語・フレームワークで構築可能
2. **独立開発**: モジュールごとに並行開発・テストが可能
3. **障害分離**: 1つのモジュールがクラッシュしても他は継続
4. **段階的開発**: 各フェーズで動作確認しながら価値を積み上げ
5. **パフォーマンス**: 共有メモリによるゼロコピー、最小限のオーバーヘッド
6. **評価環境**: Phase 3完了時点でモデル評価環境が整う

### 開発計画のメリット

1. **早期価値提供**: Phase 3で実用的なモニターが完成
2. **リスク低減**: モックで動作確認してから本番モデル統合
3. **柔軟性**: モデルを後から差し替え可能
4. **検証容易**: 各フェーズで独立してテスト可能

---

## 6. 技術的な決定事項まとめ

| 項目 | 決定内容 | 理由 |
|------|---------|------|
| IPC方式 | 共有メモリ（Shared Memory） | ゼロコピー、最速、複数消費者対応 |
| プロセス構成 | マルチプロセス | 障害分離、言語混在、デバッグ容易 |
| 同期方式 | ポーリング（同期不要） | シンプル、デッドロックなし |
| モニター技術 | Flask + MJPEG streaming | 実装容易、ブラウザ互換性高 |
| 開発順序 | Capture → Mock → Monitor → Model | リスク低減、早期価値提供 |
| プロセス管理 | systemd | 自動再起動、リソース管理 |

---

## 7. 次のアクション

### 即座に着手すべきタスク

**Phase 1: Captureデーモン化**

1. **共有メモリ構造体の詳細設計**
   - フレームバッファのサイズ決定（30フレーム分？）
   - フレームデータ形式（YUYV? RGB? JPEG?）
   - atomic操作の選定

2. **capture_v2.c の改造計画**
   - リファクタリング範囲の特定
   - 既存機能の維持（マルチカメラ対応等）
   - 新機能の追加箇所の特定

3. **簡易テストプログラムの仕様**
   - 共有メモリ読み取り
   - フレーム表示またはファイル保存
   - FPS計測

### 質問・要検討事項

1. フレームデータ形式
   - YUYV（rawデータ、大きい）
   - RGB（変換必要、中間）
   - JPEG（圧縮済み、小さい、デコード必要）

2. リングバッファサイズ
   - 30フレーム（1秒分）で十分？
   - メモリ制約は？

3. 開発環境
   - ローカル開発 vs ターゲットデバイス上での開発
   - クロスコンパイルの必要性

---

## 8. 参考資料

- プロジェクトドキュメント: `/app/smart-pet-camera/docs/`
  - `01_project_goals.md`
  - `02_requirements.md`
  - `03_functional_design.md`
  - `04_architecture.md`
- サンプルコード: `/app/smart-pet-camera/docs/sample/`
  - `capture_v2.c` - ベースとなるカメラキャプチャコード
  - `docs/` - V4L2調査結果等

---

**議事録作成日**: 2025-12-19
**次回ミーティング**: Phase 1の詳細設計完了後
