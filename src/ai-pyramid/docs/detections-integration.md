# Detections Integration — YOLO検出データのai-pyramid連携

## Why

comic画像にはペット (猫) の検出結果が含まれるが、これまで以下の情報が失われていた:

1. **bbox座標** — comic内のどこに猫がいるかの位置情報
2. **YOLO全検出結果** — cat以外の検出 (person, cup, bowl等) もシーン理解に有用
3. **pet_id判定の根拠** — 自動分類結果をユーザーが検証・修正できない

これらをai-pyramid側のDBに保存することで:

- **pet_id判定精度の継続改善** — ユーザー修正データからUV散布度の閾値を再キャリブレーション
- **アルバムUIでのbbox表示** — comic画像上に検出枠をオーバーレイ
- **シーン分析** — VLMのcaption/behaviorとYOLO検出を突合して信頼性向上

---

## detections テーブル

### スキーマ

```sql
CREATE TABLE IF NOT EXISTS detections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id        INTEGER NOT NULL REFERENCES photos(id),
    panel_index     INTEGER,          -- comic内パネル番号 (0-3)
    bbox_x          INTEGER NOT NULL, -- comic画像座標 (848x496)
    bbox_y          INTEGER NOT NULL,
    bbox_w          INTEGER NOT NULL,
    bbox_h          INTEGER NOT NULL,
    yolo_class      TEXT,             -- YOLO検出クラス ("cat", "person", etc.)
    pet_class       TEXT,             -- UV散布度による自動ペットID ("mike", "chatora", "other")
    pet_id_override TEXT,             -- ユーザー手動修正 (NULLなら自動を信頼)
    confidence      REAL,             -- YOLO confidence score
    detected_at     TEXT NOT NULL     -- 検出時刻 (ISO 8601)
);
CREATE INDEX idx_detections_photo ON detections(photo_id);
```

### リレーション

```
photos (1) ←→ (N) detections
```

1つのcomic画像 (photos) に対して、4パネル × 複数検出 = N件のdetection。

### bbox座標系

bbox座標は **comic画像座標** (848x496ピクセル) で保存される。元フレーム座標 (1280x720) ではない。

```
Comic layout (848x496):
  ┌──────────────┬──────────────┐
  │  Panel 0     │  Panel 1     │  各パネル: 404x228
  │  (14, 14)    │  (430, 14)   │  margin=12, gap=8, border=2
  ├──────────────┼──────────────┤
  │  Panel 2     │  Panel 3     │
  │  (14, 254)   │  (430, 254)  │
  └──────────────┴──────────────┘
```

---

## 連携方法: 画像転送 + API

### データフロー

```
rdk-x5 (Go streaming_server)
  │
  ├─ Comic JPEG ──→ rsync (Tailscale SSH) ──→ ai-pyramid/data/photos/
  │                  scripts/sync-comics.sh
  │
  └─ Detection metadata ──→ HTTP POST /api/photos/ingest ──→ ai-pyramid DB
     comic_capture.go          (Tailscale直接接続)
```

### 画像転送 (rsync)

既存の `scripts/sync-comics.sh` + `deploy/comic-sync.service` で JPEG を転送。
ai-pyramidの `PhotoWatcher` がファイル検出 → VLM処理キューに投入。

### メタデータ送信 (API)

comic保存直後に Go から非同期で `POST /api/photos/ingest` を呼び出す。

#### リクエスト

```json
POST /api/photos/ingest
Content-Type: application/json

{
  "filename": "comic_20260321_104532_chatora.jpg",
  "captured_at": "2026-03-21T10:45:32",
  "pet_id": "chatora",
  "detections": [
    {
      "panel_index": 0,
      "bbox_x": 50,  "bbox_y": 30,  "bbox_w": 120, "bbox_h": 180,
      "yolo_class": "cat",
      "pet_class": "chatora",
      "confidence": 0.85,
      "detected_at": "2026-03-21T10:45:32"
    },
    {
      "panel_index": 0,
      "bbox_x": 300, "bbox_y": 100, "bbox_w": 80,  "bbox_h": 60,
      "yolo_class": "cup",
      "confidence": 0.62,
      "detected_at": "2026-03-21T10:45:32"
    }
  ]
}
```

#### レスポンス

```json
{"ok": true, "photo_id": 42, "detections_count": 2}
```

#### シーケンス

1. Go: comic保存 (`os.WriteFile`)
2. Go: goroutineで `POST /api/photos/ingest` (非同期、2回リトライ)
3. rsync: JPEG転送 (inotifywait トリガー)
4. ai-pyramid: JPEG着信 → VLMキューに投入 (photo record は API で既に作成済み)

画像とメタデータの到着順序は不定。`INSERT OR IGNORE` で重複を防止し、photo_id は filename で解決。

---

## YOLO class → ラベルマッピング

Python YOLO検出パイプライン (`src/common/src/detection/yolo_detector.py`) でフィルタされるCOCOクラスのみ:

| COCO ID | YOLO class | 用途 |
|---------|-----------|------|
| 0 | `person` | 人物検出 |
| 15 | `cat` | 猫検出 (pet_id判定対象) |
| 16 | `dog` | 犬検出 (cat重複時は誤検出として抑制) |
| 41 | `cup` | カップ検出 |
| 45 | `bowl` (→ `food_bowl`) | フードボウル |
| 56 | `chair` | 椅子 (夜間IR false positiveとしてフィルタ) |

### 夜間IRフィルタ

以下のクラスは夜間カメラ (IR映像) でfalse positiveが多発するため、検出結果から除外される:

```python
night_fp_classes = {"toilet", "sink", "suitcase", "chair"}
```

### dog抑制ロジック

cat と dog の bbox が重複する場合 (containment ratio > 0.5)、dog を誤検出として抑制。
猫がYOLOにdog誤分類されるパターンへの対処。

---

## pet_id 自動判定 (FYI)

### How: UV散布度ベース分類

NV12フレームのbbox領域からUV (色差) サンプルを抽出し、色の散らばり具合で分類する。

```
NV12 bbox領域 (2px刻みサンプリング)
  → UV値抽出 (Y輝度は使わない — 照明変動の影響を排除)
  → 背景除去: UV 16x16ヒストグラムで出現率2%未満のビンを除去
  → scatter = std(U) + std(V) を計算
  → scatter > threshold → mike (三毛猫: 白+黒+オレンジの多色)
  → scatter ≤ threshold → chatora (茶トラ: オレンジ一色)
```

### Why UV空間か

- **Y (輝度)** は照明で大きく変化 → 不安定
- **UV (色差)** は白色光源下で相対的に安定
- mike: 白パッチ (U≈128,V≈128) + オレンジ (低U,高V) + 黒 → UV空間で散布大
- chatora: オレンジ一色 (低U,高V) → UV空間で散布小

### 現在の閾値

```go
const scatterThreshold = 5.0
```

YOLO-bbox ベースの実測値 (33サンプル):

| ソース | mike | chatora |
|--------|------|---------|
| Video bbox (n=22) | mean=6.20, min=5.81 | mean=2.48, max=3.93 |
| Comic panels (n=6) | 6.72-7.15 | 3.74-4.17 |
| Go NV12 (テスト) | 7.83 | 4.90 |

Go/Python の NV12 変換で ~0.9 のオフセットあり。閾値 5.0 は両方で分離可能。

### Future: 閾値の自動キャリブレーション

ユーザーが `pet_id_override` で修正したdetectionデータを収集し、以下のフローで閾値を最適化:

1. 修正済みdetection (pet_id_override != NULL) を抽出
2. 各detectionのbbox領域からUV散布度を再計算 (元画像 + bbox座標が必要)
3. mike/chatora ごとの散布度分布を比較
4. 最適分離閾値を算出 (e.g., ROC-AUCベース)
5. `scatterThreshold` を更新

---

## pet_id 修正UI

### API

```
PATCH /api/photos/{filename}
  {"pet_id": "mike"}              ← photo全体のpet_id修正

PATCH /api/detections/{id}
  {"pet_id_override": "mike"}     ← 個別detection修正
```

### UIフロー (WANT)

1. アルバムグリッドで写真をタップ
2. 詳細表示: comic画像 + bbox overlay + 各detectionのyolo_class/pet_class表示
3. pet_classが間違っている場合、タップして `mike` / `chatora` / `other` を選択
4. `PATCH /api/detections/:id` で修正をDBに保存
5. photo全体の `pet_id` も多数決で自動更新

### Future: フロントエンド実装

`src/ai-pyramid/ui/` (Preact SPA) に detection overlay + 修正UIを追加。
現在のアルバムグリッド (`templates/album.html`) は askama サーバーレンダリングだが、
iframe内のPreact SPAに検出修正機能を組み込む想定。

---

## WANT: `.env` でペット名マッピング

pub repoにリアルなペット名をハードコードしたくないため、`.env` で pet_id ↔ 表示名をマッピングする。

### 設計案

```env
# .env (gitignore対象)
PET_NAME_MIKE=ミケ
PET_NAME_CHATORA=チャトラ
```

### 使用箇所

- ai-pyramid: アルバムUIでの表示名
- camera streaming_server: comic captureのタイムスタンプ表示 (将来)

### 実装 (Future)

ai-pyramid の `main.rs` で `std::env::var("PET_NAME_MIKE")` を読み、
`AppState` に保持。テンプレート/API レスポンスで表示名に変換。

Go側は `os.Getenv("PET_NAME_MIKE")` で取得。

---

## テスト画像サンプル (FYI)

UV散布度閾値のキャリブレーションに使用できるテストデータ:

### pet camera 録画 (H.265 MP4, 1280x720)

| ペット | ファイル |
|--------|---------|
| mike | `recordings/recording_20260205_171631.mp4` |
| chatora | `recordings/recording_20260205_173334.mp4` |
| mike & chatora | `recordings/recording_20260207_170640.mp4` |

### iPhone 撮影 (HEIC)

| ペット | ファイル |
|--------|---------|
| chatora | `/tmp/iphone-cat-img/IMG_3860.HEIC` |
| mike | `/tmp/iphone-cat-img/IMG_5652.HEIC` |
| chatora | `/tmp/iphone-cat-img/IMG_5683.HEIC` |
| mike | `/tmp/iphone-cat-img/IMG_5686.HEIC` |

### 既存テストデータ (comic JPEG, 848x496)

| ペット | ファイル |
|--------|---------|
| mike | `src/streaming_server/internal/webmonitor/testdata/mike.jpg` |
| chatora | `src/streaming_server/internal/webmonitor/testdata/chatora.jpg` |

---

## Backfill: 既存comic画像の後追い検出

### Why

detections API 導入前に保存された comic 画像には bbox 情報がない。これらの画像に対して後追いで YOLO 検出を実行し、detections テーブルに登録する。

### camera 側仕様: `POST /detect` (port 8083)

camera の YOLO detector daemon が HTTP エンドポイントを提供する。デーモンのメインループ (SHM フレーム処理) と並行して動作。

#### リクエスト

```
POST http://<camera-host>:8083/detect
Content-Type: application/json

{
  "image_url": "http://ai-pyramid:3000/api/photos/comic_20260321_104532_chatora.jpg"
}
```

- ポート 8083 は Tailscale ACL `tcp:8080-8999` の範囲内
- camera が `image_url` から JPEG をダウンロードして検出 (base64不要)
- ai-pyramid の `GET /api/photos/{filename}` をそのまま指定可能
- 画像サイズ制限なし (内部で 640x640 にletterbox)
- タイムアウト: 画像ダウンロード 10秒

#### レスポンス

```json
{
  "detections": [
    {
      "class_name": "cat",
      "confidence": 0.85,
      "bbox": {"x": 146, "y": 147, "w": 89, "h": 89}
    },
    {
      "class_name": "cup",
      "confidence": 0.62,
      "bbox": {"x": 300, "y": 100, "w": 80, "h": 60}
    }
  ],
  "width": 848,
  "height": 496
}
```

- bbox 座標は**入力画像座標** (comic なら 848x496 空間)
- comic 画像をそのまま送れば、返却 bbox はそのまま comic 座標として DB に保存可能
- `width`, `height` は入力画像の元サイズ

#### 前処理パイプライン (rdk-x5内部)

```
HTTP GET image_url → JPEG bytes
  → cv2.imdecode() → BGR
  → letterbox 640x640 (aspect ratio保持 + padding)
  → BGR→NV12 (I420経由でUV interleave)
  → YoloDetector.detect_nv12() (BPU INT8推論)
  → bbox座標をletterbox逆変換 → 元画像座標
```

- **CLAHE不要**: comic JPEG は ISP処理済み可視光画像
- **score_threshold**: デーモンの設定値を使用 (デフォルト 0.25)
- **NMS**: class-aware NMS (IoU=0.7) がdetector内部で適用済み

#### 対応 YOLO クラス

| COCO ID | class_name | 備考 |
|---------|-----------|------|
| 0 | `person` | |
| 15 | `cat` | pet_id 判定対象 |
| 16 | `dog` | cat重複時は誤検出の可能性 |
| 41 | `cup` | |
| 45 | `bowl` | COCO "bowl" → `food_bowl` |
| 56 | `chair` | |

これ以外の COCO クラスはフィルタされ、レスポンスに含まれない。

#### エラー

| HTTP Status | 条件 |
|-------------|------|
| 400 | JSON パース失敗、`image_url` 欠落 |
| 502 | 画像ダウンロード失敗 (URL不正、タイムアウト、接続拒否) |
| 500 | JPEG デコード失敗、BPU推論エラー |

#### 性能

- BPU推論: ~9ms (YOLOv11n)
- 前処理 (JPEG decode + letterbox + NV12変換): ~5-10ms
- 合計: **~15-20ms/画像**
- メインループの SHM フレーム処理と GIL で排他されるため、リアルタイム検出に若干の遅延影響あり

### ai-pyramid 側: backfill 手順

新規 API やスクリプトは不要。既存 API の組み合わせ + shell ワンライナーで実行。

#### 手順 (ai-pyramid 実機上で実行)

```bash
# 1. detections が空の photo を検索
# 2. 各 photo を rdk-x5 で検出
# 3. 結果を ingest API で DB に INSERT

sqlite3 data/pet-album.db \
  "SELECT p.filename FROM photos p LEFT JOIN detections d ON d.photo_id=p.id WHERE d.id IS NULL" | \
while read f; do
  echo "Processing: $f"

  # rdk-x5 で検出 (camera が ai-pyramid から画像を直接ダウンロード)
  DETECT=$(curl -sf -X POST http://<camera-host>:8083/detect \
    -H 'Content-Type: application/json' \
    -d "{\"image_url\":\"http://ai-pyramid:3000/api/photos/$f\"}")

  [ -z "$DETECT" ] && echo "  SKIP (detect failed)" && continue

  # detect レスポンスを ingest 形式に変換して投入
  echo "$DETECT" | jq --arg f "$f" '{
    filename: $f,
    captured_at: ($f | capture("comic_(?<d>[0-9]{8})_(?<t>[0-9]{6})") |
      "\(.d[0:4])-\(.d[4:6])-\(.d[6:8])T\(.t[0:2]):\(.t[2:4]):\(.t[4:6])"),
    pet_id: ($f | capture("_(?<p>[a-z]+)\\.jpg$") | .p),
    detections: [.detections[] | {
      bbox_x: .bbox.x, bbox_y: .bbox.y, bbox_w: .bbox.w, bbox_h: .bbox.h,
      yolo_class: .class_name,
      confidence: .confidence,
      detected_at: ($f | capture("comic_(?<d>[0-9]{8})_(?<t>[0-9]{6})") |
        "\(.d[0:4])-\(.d[4:6])-\(.d[6:8])T\(.t[0:2]):\(.t[2:4]):\(.t[4:6])")
    }]
  }' | curl -sf -X POST http://localhost:3000/api/photos/ingest \
    -H 'Content-Type: application/json' -d @- > /dev/null

  echo "  OK ($(echo "$DETECT" | jq '.detections | length') detections)"
  sleep 0.2  # rdk-x5 メインループへの影響軽減
done
```

#### 注意事項

- `pet_class` = NULL (元フレームの NV12 がないため UV scatter 不可)
- `panel_index` = NULL (backfill ではパネル情報なし)
- `jq` が必要 (`apt install jq`)
- camera の detector daemon が起動中である必要あり
- `sleep 0.2` で BPU 負荷を分散 (リアルタイム検出への影響軽減)
