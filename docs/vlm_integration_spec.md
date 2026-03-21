# VLM行動解析システム連携仕様書

**Version**: 0.3.0 (Draft)
**Date**: 2026-02-15
**Status**: 策定中

---

## 1. 概要

### 1.1 目的

本仕様書は、既存のスマートペットカメラシステム（RDK X5）と、
新規に構築するVLM行動解析システム（M5Stack AI Pyramid Pro / Axera AX8850）間の
連携インターフェースを定義する。

### 1.2 ネットワーク構成

両マシンはTailscaleネットワークで接続し、MagicDNSによる安定したホスト名で通信する。

| マシン | デバイス名 | FQDN | 役割 |
|--------|-----------|------|------|
| RDK X5 | `rdk-x5` | `<camera-host>` | ペットカメラ (映像配信・YOLO検出) |
| M5Stack AI Pyramid | `m5stack-ai-pyramid` | `<album-host>` | VLM行動解析サーバー |

### 1.3 システム構成

```
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│  RDK X5                          │    │  M5Stack AI Pyramid              │
│  <camera-host>        │    │  m5stack-ai-pyramid.<tailscale-tenant>   │
│                                   │    │                .ts.net           │
│  Camera → YOLO検出                │    │  VLM推論エンジン (NPU 24TOPS)    │
│  Streaming Server (Go)            │    │  個体識別モジュール              │
│    :8080 HTTPS (MJPEG/SSE/REST)  │    │  行動解析パイプライン            │
│    :8081 HTTP  (WebRTC内部)       │    │  行動ログDB (SQLite)            │
│                                   │    │  行動ログAPI (HTTP :8090)       │
│  Monitor UI (HTTPS)               │    │                                  │
│    → 全API: :8080 経由             │    │                                  │
│    → WebRTC: :8080がProxy→:8081   │    │                                  │
│    → 行動ログ: :8080がProxy→:8090 │    │                                  │
│                                   │    │                                  │
│  [既存] 映像配信・検出             │    │  [新規] VLM解析・ログ管理        │
└──────────────────────────────────┘    └──────────────────────────────────┘
         │  Tailscale (WireGuard暗号化)         │
         └──────────────────────────────────────┘
```

### 1.4 HTTPS要件

Monitor UI は **HTTPS必須**。Safari (iOS) が `RTCPeerConnection` にセキュアコンテキストを要求するため。
Tailscale 証明書 (`<camera-host>.crt`) を使用して Go Web Monitor (:8080) を HTTPS 化している。

ブラウザから見える通信は全て `https://rdk-x5:8080` に集約される。
バックエンドへの通信（:8081, m5stack-ai-pyramid:8090）はサーバー間通信として Go がProxyする。

```
Browser (HTTPS)
  └── https://rdk-x5:8080
        ├── /stream                  → MJPEG (直接処理)
        ├── /api/status/stream       → SSE (直接処理)
        ├── /api/detections/stream   → SSE (直接処理)
        ├── /api/webrtc/offer        → Proxy → localhost:8081 (既存)
        └── /api/vlm/*               → Proxy → m5stack-ai-pyramid:8090 (新規)
```

### 1.5 対象ペット

| ID | 呼称 | 種別 | 外見特徴 |
|----|------|------|----------|
| `mike` | 三毛猫 | 猫 | 三毛柄（白・黒・茶） |
| `chatora` | 茶トラ | 猫 | 茶色縞模様 |

### 1.4 主要機能

- VLMによるペットの行動・状況の自然言語記述
- 個体識別（三毛猫 / 茶トラ）
- 行動ログの蓄積（7日間保持）
- ペットカメラモニターUIでの行動ログ閲覧

---

## 2. データフロー

### 2.1 全体フロー

```
[rdk-x5]                              [m5stack-ai-pyramid]

GET /stream (MJPEG) ───────────────→  フレーム取得 (定期キャプチャ)
GET /api/detections/stream (SSE) ──→  YOLO検出イベント受信
                                            │
                                            ▼
                                       ┌─────────────┐
                                       │  トリガー判定  │
                                       │  (検出あり時)  │
                                       └──────┬──────┘
                                              │
                                              ▼
                                       ┌─────────────┐
                                       │  VLM推論     │
                                       │  (画像+検出)  │
                                       └──────┬──────┘
                                              │
                                              ▼
                                       ┌─────────────┐
                                       │  行動ログDB   │
                                       │  (SQLite)    │
                                       └──────┬──────┘
                                              │
  [Browser]                                   │  [rdk-x5 Go Server]
  https://rdk-x5:8080/api/vlm/* ──→ Proxy ──→ http://m5stack-ai-pyramid:8090/api/*
```

### 2.2 トリガー方式

VLM推論はリソースを消費するため、常時実行ではなくイベント駆動で実行する。

| トリガー | 条件 | 推論頻度 |
|----------|------|----------|
| **YOLO検出トリガー** | SSEで `cat` 検出イベント受信時 | 検出開始時 + 継続中は30秒間隔 |
| **定期スナップショット** | 検出有無にかかわらず | 5分間隔 |
| **検出消失トリガー** | 猫の検出が途切れた時 | 消失時に1回 |

---

## 3. APIコントラクト

### 3.1 rdk-x5 → m5stack-ai-pyramid （既存APIの利用）

VLMサーバーはペットカメラの既存APIをクライアントとして利用する。
Tailscale MagicDNSによりホスト名で接続する。

#### 3.1.1 映像取得

```
GET http://rdk-x5:8080/stream
Content-Type: multipart/x-mixed-replace; boundary=frame
```

MJPEGストリームからフレームをキャプチャする。
全フレームを処理する必要はなく、トリガー条件に応じてスナップショット的に取得する。

#### 3.1.2 検出イベント受信

```
GET http://rdk-x5:8080/api/detections/stream
Accept: application/json
Content-Type: text/event-stream
```

レスポンス例:
```json
{
  "frame_number": 12345,
  "timestamp": 1739612400.123,
  "detections": [
    {
      "bbox": {"x": 100, "y": 150, "w": 200, "h": 180},
      "confidence": 0.92,
      "class_id": 0,
      "label": "cat"
    },
    {
      "bbox": {"x": 400, "y": 200, "w": 180, "h": 160},
      "confidence": 0.87,
      "class_id": 0,
      "label": "cat"
    }
  ]
}
```

### 3.2 m5stack-ai-pyramid 行動ログAPI（新規）

行動ログを配信するREST APIを m5stack-ai-pyramid 側に実装する。
ブラウザ（Monitor UI）から Tailscale 経由で直接アクセスする。

**ベースURL**: `http://m5stack-ai-pyramid:8090`

**CORS設定**: `Access-Control-Allow-Origin: http://rdk-x5:8080`

#### 3.2.1 行動ログ一覧取得

```
GET http://m5stack-ai-pyramid:8090/api/behavior-logs
```

クエリパラメータ:

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|-----------|-----|------|-----------|------|
| `pet_id` | string | No | (全て) | 個体ID (`mike`, `chatora`) |
| `since` | ISO8601 | No | 24時間前 | 開始日時 |
| `until` | ISO8601 | No | 現在 | 終了日時 |
| `behavior` | string | No | (全て) | 行動タイプでフィルタ |
| `limit` | int | No | 50 | 最大取得件数 |
| `offset` | int | No | 0 | オフセット |

レスポンス:
```json
{
  "logs": [
    {
      "id": "log_20260215_143052_001",
      "timestamp": "2026-02-15T14:30:52+09:00",
      "pet_id": "mike",
      "pet_name": "三毛猫",
      "behavior": "eating",
      "description": "三毛猫がキッチン付近の餌皿で食事をしている。もう一匹の茶トラはソファの上で寝ている。",
      "confidence": 0.88,
      "duration_sec": 120,
      "detections": [
        {
          "label": "cat",
          "bbox": {"x": 100, "y": 150, "w": 200, "h": 180},
          "pet_id": "mike"
        }
      ],
      "thumbnail_url": "/api/behavior-logs/log_20260215_143052_001/thumbnail"
    }
  ],
  "total": 142,
  "has_more": true
}
```

#### 3.2.2 行動ログ詳細取得

```
GET http://m5stack-ai-pyramid:8090/api/behavior-logs/{log_id}
```

レスポンス:
```json
{
  "id": "log_20260215_143052_001",
  "timestamp": "2026-02-15T14:30:52+09:00",
  "pet_id": "mike",
  "pet_name": "三毛猫",
  "behavior": "eating",
  "description": "三毛猫がキッチン付近の餌皿で食事をしている。もう一匹の茶トラはソファの上で寝ている。",
  "vlm_raw_response": "画像には2匹の猫が写っています。左側の三毛猫（白・黒・茶の柄）が餌皿に顔を近づけて食事中です。右奥のソファには茶色の縞模様の猫（茶トラ）が丸くなって寝ています。",
  "confidence": 0.88,
  "duration_sec": 120,
  "frame_number": 12345,
  "detections": [
    {
      "label": "cat",
      "bbox": {"x": 100, "y": 150, "w": 200, "h": 180},
      "confidence": 0.92,
      "pet_id": "mike"
    },
    {
      "label": "cat",
      "bbox": {"x": 400, "y": 300, "w": 180, "h": 160},
      "confidence": 0.87,
      "pet_id": "chatora"
    },
    {
      "label": "food_bowl",
      "bbox": {"x": 80, "y": 280, "w": 100, "h": 60},
      "confidence": 0.95,
      "pet_id": null
    }
  ],
  "thumbnail_url": "/api/behavior-logs/log_20260215_143052_001/thumbnail"
}
```

#### 3.2.3 サムネイル取得

```
GET http://m5stack-ai-pyramid:8090/api/behavior-logs/{log_id}/thumbnail
Content-Type: image/jpeg
```

VLM推論時にキャプチャしたフレームをJPEGで返す（リサイズ済み、320x240程度）。

#### 3.2.4 行動ログリアルタイム配信 (SSE)

```
GET http://m5stack-ai-pyramid:8090/api/behavior-logs/stream
Content-Type: text/event-stream
```

新しい行動ログが生成されるたびにSSEイベントとして配信する。

```
event: behavior-log
data: {"id":"log_20260215_143052_001","timestamp":"2026-02-15T14:30:52+09:00","pet_id":"mike","pet_name":"三毛猫","behavior":"eating","description":"三毛猫がキッチン付近の餌皿で食事をしている。","confidence":0.88}

event: behavior-log
data: {"id":"log_20260215_144500_002","timestamp":"2026-02-15T14:45:00+09:00","pet_id":"chatora","pet_name":"茶トラ","behavior":"playing","description":"茶トラが窓辺でカーテンの紐にじゃれている。","confidence":0.91}
```

#### 3.2.5 日次サマリー取得

```
GET http://m5stack-ai-pyramid:8090/api/behavior-summary
```

クエリパラメータ:

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|-----------|-----|------|-----------|------|
| `date` | YYYY-MM-DD | No | 今日 | 対象日 |
| `pet_id` | string | No | (全て) | 個体ID |

レスポンス:
```json
{
  "date": "2026-02-15",
  "pets": [
    {
      "pet_id": "mike",
      "pet_name": "三毛猫",
      "summary": {
        "eating_count": 3,
        "eating_total_sec": 420,
        "drinking_count": 5,
        "drinking_total_sec": 60,
        "playing_count": 2,
        "playing_total_sec": 300,
        "sleeping_count": 4,
        "sleeping_total_sec": 28800,
        "active_count": 8,
        "active_total_sec": 3600,
        "first_seen": "2026-02-15T06:30:00+09:00",
        "last_seen": "2026-02-15T23:15:00+09:00"
      }
    },
    {
      "pet_id": "chatora",
      "pet_name": "茶トラ",
      "summary": {
        "eating_count": 4,
        "eating_total_sec": 480,
        "drinking_count": 6,
        "drinking_total_sec": 72,
        "playing_count": 5,
        "playing_total_sec": 900,
        "sleeping_count": 3,
        "sleeping_total_sec": 32400,
        "active_count": 12,
        "active_total_sec": 5400,
        "first_seen": "2026-02-15T05:45:00+09:00",
        "last_seen": "2026-02-15T22:30:00+09:00"
      }
    }
  ]
}
```

#### 3.2.6 週次トレンド取得

```
GET http://m5stack-ai-pyramid:8090/api/behavior-trends
```

クエリパラメータ:

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|-----------|-----|------|-----------|------|
| `days` | int | No | 7 | 対象日数 (1-30) |
| `pet_id` | string | No | (全て) | 個体ID |

レスポンス:
```json
{
  "period": {
    "from": "2026-02-09",
    "to": "2026-02-15"
  },
  "pets": [
    {
      "pet_id": "mike",
      "pet_name": "三毛猫",
      "daily": [
        {
          "date": "2026-02-09",
          "eating_count": 3,
          "drinking_count": 4,
          "active_total_sec": 3200
        },
        {
          "date": "2026-02-10",
          "eating_count": 4,
          "drinking_count": 5,
          "active_total_sec": 3800
        }
      ]
    }
  ]
}
```

#### 3.2.7 ヘルスチェック

```
GET http://m5stack-ai-pyramid:8090/health
```

レスポンス:
```json
{
  "status": "ok",
  "vlm_model_loaded": true,
  "camera_connected": true,
  "db_size_mb": 42.5,
  "log_count_7d": 985,
  "uptime_sec": 604800
}
```

---

## 4. データモデル

### 4.1 行動タイプ定義

| 行動タイプ | 値 | 説明 | 判定ソース |
|-----------|-----|------|-----------|
| 食事 | `eating` | 餌皿付近で食事中 | YOLO検出 + VLM確認 |
| 飲水 | `drinking` | 水飲み場で飲水中 | YOLO検出 + VLM確認 |
| 遊び | `playing` | おもちゃや物にじゃれている | VLM判定 |
| 睡眠 | `sleeping` | 寝ている | VLM判定 |
| 毛繕い | `grooming` | 毛繕いをしている | VLM判定 |
| 移動 | `moving` | 歩いている・走っている | VLM判定 |
| くつろぎ | `resting` | 起きているが動いていない | VLM判定 |
| その他 | `other` | 上記に分類できない行動 | VLM判定 |

### 4.2 個体識別方式

VLMに対するプロンプトで個体識別を行う。

#### プロンプト設計

**重要**: 実機テスト（2026-03-21）により、**英語プロンプトが最も安定**することを確認。
日本語プロンプトではプロンプト文がcaptionに混入する問題あり。中国語は一部エッジケースでエラー。

**行動解析プロンプト（確定版）:**

```
Analyze this pet camera image. This house has two cats:
- "mike": calico/tricolor cat (white, black, brown patches)
- "chatora": tabby/orange cat (brown striped pattern)

Respond with valid JSON only, no markdown.
{"pets": [{"pet_id": "mike" or "chatora" or null, "behavior": "eating/drinking/playing/sleeping/grooming/moving/resting/other", "description": "brief English description of action"}], "scene_description": "brief English description of the scene"}

YOLO detection context:
- cat: bbox(100, 150, 200, 180) confidence=0.92
- cat: bbox(400, 300, 180, 160) confidence=0.87
```

**アルバムフィルタリング プロンプト（v2 — pet_id判定をVLMから分離）:**

```
Analyze this photo of a pet camera feed. Respond with valid JSON only, no markdown.
{"is_valid": true if a cat is clearly visible else false,
 "caption": "one sentence describing the cat's appearance and action",
 "behavior": one of "eating","sleeping","playing","resting","moving","grooming","other"}
```

> **変更 (2026-03-21)**: `pet_id` フィールドをVLMプロンプトから削除。
> VLM（Qwen3-VL-2B）はmike/chatoraの個体識別に強いchatoraバイアスがあり、
> 入力比率に関わらず応答の60-85%がchatoraとなる。is_valid/caption/behaviorは
> 高精度で信頼可能。pet_idはRDK X5のGo側でYOLO bbox色分析により判定し、
> comicファイル名に埋め込む方式に変更。
> 詳細: `pet-album-spec-DRAFT.md` 2.6節

**API呼び出し:**
```
POST http://localhost:8000/v1/chat/completions
model: "qwen3-vl-2B-Int4-ax650"
max_tokens: 100
画像: base64エンコードJPEG in image_url field
```

**応答のパース**: VLMは ` ```json ``` ` マークダウンラッパーを付けることがあるため、
正規表現 `\{.*\}` (DOTALL) で抽出してからJSONパース。

#### 個体識別 (pet_id) について

- **VLMによるpet_id判定は採用しない**（2026-03-21テスト結果に基づく）
- pet_idはRDK X5のGo側でbbox領域のHSV色分析により判定
- comicファイル名に埋め込み: `comic_YYYYMMDD_HHMMSS_{pet_id}.jpg`
- AI Pyramid Pro側はファイル名からパースしてDB格納
- 行動解析ログの `pet_id` も同様にGo側から伝達（将来: rsyncメタデータまたはAPI）

### 4.3 SQLiteスキーマ（AX8850側）

```sql
CREATE TABLE behavior_logs (
    id TEXT PRIMARY KEY,           -- "log_20260215_143052_001"
    timestamp TEXT NOT NULL,       -- ISO8601
    pet_id TEXT,                   -- "mike", "chatora", or NULL
    behavior TEXT NOT NULL,        -- 行動タイプ
    description TEXT NOT NULL,     -- VLMによる自然言語記述
    vlm_raw_response TEXT,         -- VLMの生レスポンス
    confidence REAL,               -- 0.0-1.0
    duration_sec INTEGER,          -- 継続時間（秒）
    frame_number INTEGER,          -- 対応するフレーム番号
    detections_json TEXT,          -- 検出結果JSON
    thumbnail_path TEXT,           -- サムネイル画像パス
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX idx_behavior_logs_timestamp ON behavior_logs(timestamp);
CREATE INDEX idx_behavior_logs_pet_id ON behavior_logs(pet_id);
CREATE INDEX idx_behavior_logs_behavior ON behavior_logs(behavior);

-- 日次サマリーキャッシュ（高速クエリ用）
CREATE TABLE daily_summary (
    date TEXT NOT NULL,             -- "2026-02-15"
    pet_id TEXT NOT NULL,
    behavior TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    total_duration_sec INTEGER DEFAULT 0,
    first_seen TEXT,
    last_seen TEXT,
    PRIMARY KEY (date, pet_id, behavior)
);
```

### 4.4 データ保持ポリシー

| データ | 保持期間 | 削除タイミング |
|--------|----------|--------------|
| 行動ログ（DB） | 7日間 | 日次バッチ（深夜3時） |
| サムネイル画像 | 7日間 | ログ削除と同時 |
| 日次サマリー | 30日間 | 日次バッチ |

---

## 5. AX8850側 システム設計

### 5.1 コンポーネント構成

```
┌─────────────────────────────────────────────────┐
│  AX8850 VLM行動解析サーバー                       │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │  Camera Client                           │    │
│  │  - MJPEGフレーム取得                      │    │
│  │  - SSE検出イベント受信                    │    │
│  └──────────┬───────────────────────────────┘    │
│             │                                     │
│  ┌──────────▼───────────────────────────────┐    │
│  │  Trigger Controller                      │    │
│  │  - 検出トリガー判定                       │    │
│  │  - 定期スナップショット                   │    │
│  │  - レート制限 (推論間隔管理)              │    │
│  └──────────┬───────────────────────────────┘    │
│             │                                     │
│  ┌──────────▼───────────────────────────────┐    │
│  │  VLM Inference Engine                    │    │
│  │  - NPU推論 (24 TOPS INT8)               │    │
│  │  - プロンプト構築                         │    │
│  │  - レスポンスパース                       │    │
│  │  - 個体識別                              │    │
│  └──────────┬───────────────────────────────┘    │
│             │                                     │
│  ┌──────────▼───────────────────────────────┐    │
│  │  Behavior Log Store                      │    │
│  │  - SQLite永続化                          │    │
│  │  - サムネイル保存                         │    │
│  │  - 日次サマリー集計                       │    │
│  │  - 7日間ローテーション                    │    │
│  └──────────┬───────────────────────────────┘    │
│             │                                     │
│  ┌──────────▼───────────────────────────────┐    │
│  │  REST API Server (:8090)                 │    │
│  │  - 行動ログ配信                          │    │
│  │  - サマリー・トレンド                     │    │
│  │  - SSEリアルタイム通知                    │    │
│  │  - CORS対応                              │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### 5.2 VLMモデル要件

| 項目 | 要件 |
|------|------|
| 入力 | 画像 (JPEG) + テキストプロンプト |
| 出力 | 構造化JSON（行動タイプ、個体ID、自然言語記述） |
| 量子化 | GPTQ-Int4 (w4a16) or INT8 (w8a16) |
| メモリ | モデルウェイトはCMM 6GBに収容、System RAM 2GB内でtokenizer/前処理を実行 |
| 推論時間 | < 5秒/フレーム（目標） |
| NPU互換 | Pulsar2 v4.1+ でaxmodelにコンパイル、ax-llmで推論 |
| デプロイ | ax-llm OpenAI API互換サーバー経由 |

#### モデル候補

**現行（axmodel提供済み）:**

| モデル | 量子化 | サイズ目安 | NPU互換性 |
|--------|--------|-----------|----------|
| **Qwen3-VL-2B-Instruct** | GPTQ-Int4 (w4a16) | ~1.5GB | AXERA公式axmodel提供済み |
| **Qwen3-VL-4B-Instruct** | GPTQ-Int4 (w4a16) | ~2.5GB | AXERA公式axmodel提供済み |
| InternVL3.5-1B | GPTQ-Int4 | ~1GB | AXERA公式axmodel提供済み |

**目標（Qwen3.5世代）:**

| モデル | パラメータ | 特徴 | NPU互換性 |
|--------|-----------|------|----------|
| **Qwen3.5-0.8B** | 0.8B | Early-Fusion VLM、最軽量 | axmodel未提供、Pulsar2変換を検証予定 |
| **Qwen3.5-2B** | 2B | Early-Fusion VLM、本命候補 | axmodel未提供、AXERA対応待ち |

→ 詳細は `pet-album-spec-DRAFT.md` §2.4 を参照。

### 5.3 設定ファイル

```yaml
# config.yaml (m5stack-ai-pyramid側)

camera:
  host: "rdk-x5"  # Tailscale MagicDNS名
  mjpeg_port: 8080
  sse_port: 8080

vlm:
  # ax-llm OpenAI API互換サーバー経由で推論
  # モデル: Qwen3-VL-2B-Instruct (GPTQ-Int4) → Qwen3.5世代へ移行予定
  ax_llm_endpoint: "http://localhost:8091/v1/chat/completions"
  max_inference_sec: 5
  prompt_template_path: "/opt/config/prompt.txt"

trigger:
  detection_interval_sec: 30   # 検出継続中の推論間隔
  snapshot_interval_sec: 300   # 定期スナップショット間隔
  cooldown_sec: 10             # 同一行動の重複抑制

pets:
  - id: "mike"
    name: "三毛猫"
    description: "白・黒・茶の三色の柄を持つ猫"
  - id: "chatora"
    name: "茶トラ"
    description: "茶色の縞模様（タビー柄）の猫"

storage:
  db_path: "/data/vlm-server/behavior.db"
  thumbnail_dir: "/data/vlm-server/thumbnails"
  retention_days: 7
  summary_retention_days: 30

server:
  port: 8090
  cors_origins:
    - "http://rdk-x5:8080"
```

---

## 6. RDK X5側 拡張要件

### 6.1 Monitor UI 拡張

ペットカメラのMonitor UIに行動ログ閲覧機能を追加する。

#### 追加UIコンポーネント

1. **行動タイムライン** — 時系列で行動ログを表示
2. **個体別フィルタ** — 三毛猫/茶トラ別に表示切替
3. **日次サマリーカード** — 食事回数・飲水回数・活動時間
4. **週次トレンドグラフ** — 7日間の行動推移

#### UIモックアップ

```
┌─────────────────────────────────────────────────┐
│  Smart Pet Camera Monitor                        │
├──────────────────────┬──────────────────────────┤
│                      │  行動ログ                  │
│   [Live Feed]        │  ┌────────────────────┐  │
│                      │  │ 三毛猫 | 茶トラ | 全て│  │
│   ┌──────────────┐  │  ├────────────────────┤  │
│   │              │  │  │ 14:30 三毛猫 🍽     │  │
│   │  MJPEG/WebRTC│  │  │ 餌皿で食事中 (2分)  │  │
│   │              │  │  │                    │  │
│   │              │  │  │ 14:15 茶トラ 😴     │  │
│   └──────────────┘  │  │ ソファで昼寝中      │  │
│                      │  │                    │  │
│   [Detection Stats]  │  │ 13:45 三毛猫 🚰     │  │
│                      │  │ 水を飲んでいる      │  │
│                      │  └────────────────────┘  │
│                      │                          │
│                      │  今日のサマリー            │
│                      │  三毛猫: 食事3 飲水5      │
│                      │  茶トラ: 食事4 飲水6      │
└──────────────────────┴──────────────────────────┘
```

### 6.2 Go Web Monitor へのVLM Proxy追加

既存の WebRTC シグナリング Proxy (`/api/webrtc/offer` → `localhost:8081`) と
同じパターンで、VLM行動ログAPIのリバースプロキシを追加する。

#### 背景: なぜProxyが必要か

1. **HTTPS必須**: Safari (iOS) が WebRTC にセキュアコンテキストを要求するため、
   Monitor UI は HTTPS で配信している
2. **Tailscale共有**: rdk-x5 を別アカウントに share している。
   m5stack-ai-pyramid を追加で share するのは管理が煩雑
3. **mixed-content回避**: HTTPS ページから HTTP API への直接アクセスはブラウザがブロックする

Proxyにより、ブラウザからは全て `https://rdk-x5:8080` への通信で完結する。

#### Proxyエンドポイント

| フロントエンドURL | Proxy先 |
|------------------|---------|
| `GET /api/vlm/behavior-logs` | `http://m5stack-ai-pyramid:8090/api/behavior-logs` |
| `GET /api/vlm/behavior-logs/{id}` | `http://m5stack-ai-pyramid:8090/api/behavior-logs/{id}` |
| `GET /api/vlm/behavior-logs/{id}/thumbnail` | `http://m5stack-ai-pyramid:8090/api/behavior-logs/{id}/thumbnail` |
| `GET /api/vlm/behavior-logs/stream` | `http://m5stack-ai-pyramid:8090/api/behavior-logs/stream` (SSE) |
| `GET /api/vlm/behavior-summary` | `http://m5stack-ai-pyramid:8090/api/behavior-summary` |
| `GET /api/vlm/behavior-trends` | `http://m5stack-ai-pyramid:8090/api/behavior-trends` |
| `GET /api/vlm/health` | `http://m5stack-ai-pyramid:8090/health` |

#### 実装パターン（既存のWebRTC Proxyに倣う）

既存の `handleWebRTCOffer` (`server.go:397`) と同じパターン:

```go
// 設定に追加
type Config struct {
    // ... 既存フィールド
    VLMBaseURL string  // "http://m5stack-ai-pyramid:8090"
}

// ルーティング登録
mux.HandleFunc("/api/vlm/", s.handleVLMProxy)

// Proxy実装（パスの /api/vlm/ を /api/ に書き換えて転送）
func (s *Server) handleVLMProxy(w http.ResponseWriter, r *http.Request) {
    // /api/vlm/behavior-logs → /api/behavior-logs
    targetPath := strings.TrimPrefix(r.URL.Path, "/api/vlm")
    // /api/vlm/health → /health (特殊ケース)
    targetURL := s.cfg.VLMBaseURL + targetPath + "?" + r.URL.RawQuery

    // SSEの場合はストリーミングProxy
    // それ以外は通常のリバースProxy
}
```

#### SSE Proxy の注意点

`/api/vlm/behavior-logs/stream` はSSEなので、レスポンスをバッファリングせずに
ストリーミング転送する必要がある。`http.Flusher` を使用する:

```go
flusher, ok := w.(http.Flusher)
// resp.Body を読みながら w に書き込み、都度 flusher.Flush()
```

#### CLI フラグ追加

```bash
# 起動スクリプトに追加
-vlm-base "http://m5stack-ai-pyramid:8090"
```

#### Go側の設定

```yaml
# 起動引数（またはスクリプト内で指定）
VLM_BASE_URL="http://m5stack-ai-pyramid:8090"
```

---

## 7. エラーハンドリング

### 7.1 接続障害

| 障害 | VLMサーバーの動作 | Monitor UIの動作 |
|------|-----------------|-----------------|
| RDK X5に接続不可 | リトライ（30秒間隔、指数バックオフ） | VLMステータスに「カメラ接続なし」表示 |
| MJPEG取得失敗 | SSE検出のみで動作（推論は停止） | 映像ストリームは影響なし |
| SSE接続断 | 再接続 + 定期スナップショットのみで動作 | 影響なし |
| m5stack-ai-pyramidに接続不可 | — | Go Proxyが502を返す → 行動ログ欄に「VLMサーバー接続なし」表示 |

### 7.2 VLM推論エラー

| エラー | 対処 |
|--------|------|
| タイムアウト（>10秒） | ログに記録、次のトリガーを待つ |
| JSONパース失敗 | 生レスポンスをログに記録、`behavior: "other"` で保存 |
| 個体識別失敗 | `pet_id: null` で保存 |
| NPUエラー | エラーカウント監視、閾値超過で再起動 |

---

## 8. 非機能要件

### 8.1 パフォーマンス

| 項目 | 目標値 |
|------|--------|
| VLM推論時間 | < 5秒/フレーム |
| API応答時間 | < 200ms (ログ取得) |
| SSE配信遅延 | < 1秒（推論完了後） |
| メモリ使用量 | < 6GB（VLMモデル含む、8GB中） |
| CPU使用率（アイドル時） | < 10% |

### 8.2 信頼性

| 項目 | 目標値 |
|------|--------|
| 連続稼働 | 7日間以上 |
| 個体識別精度 | > 85% （要チューニング） |
| 行動分類精度 | > 80% （要チューニング） |
| データ損失 | SQLite WALモードで最小化 |

### 8.3 セキュリティ

- LAN内通信のみ（インターネット非公開）
- 認証なし（初期フェーズ）
- CORSはペットカメラのオリジンのみ許可

---

## 9. 開発フェーズ

### Phase 1: 基盤構築

- [ ] AX8850のNPUでVLMモデルの動作検証
- [ ] MJPEGフレーム取得クライアント実装
- [ ] SSE検出イベント受信クライアント実装
- [ ] VLM推論パイプライン実装（プロンプト → 推論 → パース）
- [ ] SQLite行動ログ保存

**完了基準**: VLMが画像から猫の行動を記述し、DBに保存できる

### Phase 2: 個体識別 + API

- [ ] 個体識別プロンプトのチューニング
- [ ] REST APIサーバー実装
- [ ] SSEリアルタイム通知実装
- [ ] 日次サマリー集計
- [ ] サムネイル保存・配信

**完了基準**: APIから個体別の行動ログを取得できる

### Phase 3: Monitor UI統合

- [ ] Go Web Monitor に VLM Proxy 追加 (`/api/vlm/*` → m5stack-ai-pyramid:8090)
- [ ] SSE Proxy のストリーミング転送実装
- [ ] CLI フラグ `-vlm-base` 追加
- [ ] Monitor UIに行動ログパネル追加
- [ ] 個体別フィルタ実装
- [ ] 日次サマリー表示
- [ ] 週次トレンドグラフ表示

**完了基準**: ペットカメラモニター (HTTPS) で7日分の行動ログを閲覧できる

### Phase 4: 安定化

- [ ] 7日間連続稼働テスト
- [ ] ログローテーション検証
- [ ] エラーリカバリテスト
- [ ] 個体識別精度の評価と改善

**完了基準**: 1週間無人稼働で安定動作

---

## 10. 未決定事項

| 項目 | 選択肢 | 決定期限 |
|------|--------|----------|
| VLMモデル選定 | InternVL2 / Qwen2-VL / MobileVLM | Phase 1 開始前 |
| AX8850 NPU互換性検証 | Pulsar2で変換可能か | Phase 1 開始前 |
| VLMサーバーの実装言語 | Python / C++ | Phase 1 開始時 |
| サムネイルの解像度 | 160x120 / 320x240 / 640x480 | Phase 2 |
| Monitor UI実装方式 | 既存HTML/JSに追加 / 別タブ | Phase 3 |

---

## 付録

### A. Protobuf拡張案

既存の `detection.proto` に行動ログ用メッセージを追加する場合:

```protobuf
// 行動ログ関連（将来拡張用）
message BehaviorLog {
    string id = 1;
    string timestamp = 2;
    string pet_id = 3;
    string pet_name = 4;
    string behavior = 5;
    string description = 6;
    float confidence = 7;
    int32 duration_sec = 8;
    repeated Detection detections = 9;
}

message BehaviorLogList {
    repeated BehaviorLog logs = 1;
    int32 total = 2;
    bool has_more = 3;
}

message DailySummary {
    string date = 1;
    string pet_id = 2;
    string pet_name = 3;
    int32 eating_count = 4;
    int32 eating_total_sec = 5;
    int32 drinking_count = 6;
    int32 drinking_total_sec = 7;
    int32 active_total_sec = 8;
}
```

### B. ネットワーク構成図

```
┌──────────────────────────────────────────────────────────────────┐
│  Tailscale Network (<tailscale-tenant>)                                   │
│  WireGuard暗号化トンネル                                           │
│                                                                    │
│  ┌─────────────────────────┐   ┌──────────────────────┐          │
│  │ rdk-x5                  │   │ m5stack-ai-pyramid    │          │
│  │ .<tailscale-tenant>.ts.net      │   │ .<tailscale-tenant>.ts.net    │          │
│  │                         │   │                      │          │
│  │ :8080 HTTPS             │──►│ MJPEG取得 (HTTP)     │          │
│  │   Monitor UI            │──►│ SSE検出受信 (HTTP)    │          │
│  │   MJPEG/SSE/REST        │   │                      │          │
│  │   Proxy /api/webrtc/*   │   │ :8090 行動ログAPI     │          │
│  │   Proxy /api/vlm/* ─────┼──►│  (HTTP)              │          │
│  │                         │   │                      │          │
│  │ :8081 HTTP (内部)       │   │                      │          │
│  │   WebRTC Streaming      │   │                      │          │
│  └─────────────────────────┘   └──────────────────────┘          │
│         ▲                                                         │
│         │ HTTPS only                                              │
│         │                                                         │
│  ┌──────┴──────────────────────┐                                 │
│  │ Browser (PC / iPhone Safari) │                                 │
│  │                              │                                 │
│  │ https://rdk-x5:8080/*       │  ← 全通信がここに集約            │
│  │   /stream (MJPEG)           │                                 │
│  │   /api/webrtc/offer (Proxy) │                                 │
│  │   /api/vlm/* (Proxy)        │                                 │
│  └──────────────────────────────┘                                 │
│                                                                    │
│  ※ rdk-x5 のみ外部share → ブラウザはrdk-x5だけ知っていればよい     │
│  ※ m5stack-ai-pyramid はshare不要（rdk-x5がProxy）                │
└──────────────────────────────────────────────────────────────────┘
```
