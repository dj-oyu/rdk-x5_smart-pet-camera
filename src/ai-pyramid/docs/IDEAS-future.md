# IDEAS: Future Directions

将来の機能拡張アイデア。優先度・実現可能性は未定。

---

## 1. Pet Behavior Dashboard

### 一日のサマリ品質向上

現状の VLM サマリは単一画像のキャプション。一日分を統合した行動分析はまだない。

**アプローチ案:**

- **時系列集約**: 1日分の `(observed_at, behavior, pet_id)` を時間帯別に集計し、行動パターンを可視化
- **VLM による複数画像要約**: 代表的な 3-5 枚を選び、Qwen3-VL-2B に「一日の様子を要約して」と依頼
  - 制約: コンテキスト長 3,584 tokens → 画像1枚で大部分を消費するため、複数画像の同時入力は困難
  - 代替: 各画像のキャプションをテキストLLM (Qwen3-1.7B) に集約させる
- **行動遷移グラフ**: sleeping → eating → playing の遷移を Sankey 図で表示

### Detection の偽陽性

YOLO の false positive が行動分析を汚す問題。

- **confidence threshold tuning**: 現状は 0.25 → 行動分析用は 0.6+ に引き上げ
- **temporal consistency**: 同じ bbox が連続フレームに現れないなら偽陽性の可能性大
  - comic は ~5分間隔なので「連続フレーム」の概念がない → VLM で検証
- **VLM cross-check**: YOLO が `cat` と判定した bbox を VLM に「この領域に猫がいますか？」と確認
  - NPU 排他制約: YOLO と VLM の同時実行不可 → 非同期バッチで処理

### VLM で正確に分析できること

Qwen3-VL-2B の実測から:

| 分析項目 | 精度 | Notes |
|----------|------|-------|
| is_valid (写真として有効か) | ~100% | 最も安定 |
| caption (状況説明) | 高 | 日本語プロンプトでも安定 |
| behavior (sleeping/eating/playing) | 中-高 | 明確な行動は正確、微妙な状態は不安定 |
| pet_id (個体識別) | 低 | chatora bias 問題あり → 使用していない |
| emotion/mood | 低 | 主観的すぎて不安定 |

### Dashboard 構成案

```
┌─────────────────────────────────┐
│  Today's Summary                │
│  "茶トラ: 朝食→昼寝→遊び"       │
├─────────────────────────────────┤
│  Timeline                       │
│  06:00 ████ eating              │
│  08:00 ████████ sleeping        │
│  12:00 ███ eating               │
│  14:00 ██████ playing           │
├─────────────────────────────────┤
│  Activity Stats     7-day trend │
│  ┌──┐ ┌──┐ ┌──┐               │
│  │12│ │ 8│ │ 4│   📈          │
│  └──┘ └──┘ └──┘               │
│  sleep eat  play               │
└─────────────────────────────────┘
```

---

## 2. VLM + TTS Integration

### Device Capabilities (ai-pyramid-research 参照)

| Component | Model | Speed | Notes |
|-----------|-------|-------|-------|
| VLM | Qwen3-VL-2B-Int4 | 9.2 tok/s | 画像入力対応 |
| Text LLM | Qwen3-1.7B | ~20s/256tok | CoT (思考モード) 対応 |
| TTS | kokoro.axera | RTF 0.067 | 日本語音声、NPU高速化 |
| ASR | (StackFlow 内蔵) | — | 音声認識 |
| KWS | (StackFlow 内蔵) | — | ウェイクワード検出 |

### おしゃべり機能: VLM vs LLM

**テストしたいこと**: 猫の写真を見せて「おしゃべり」するとき、VLM (画像見える) と LLM (キャプションだけ) のどちらが楽しい応答を生成するか。

**VLM パイプライン:**
```
Photo → Qwen3-VL-2B → "茶トラが日向ぼっこしてるね" → kokoro-tts → Speaker
```

**LLM パイプライン:**
```
Photo → VLM caption → Qwen3-1.7B + character prompt → "にゃんにゃん..." → kokoro-tts → Speaker
```

**比較ポイント:**
- VLM: 画像の細部に言及できる、ただしキャラクター性の付与が難しい
- LLM: テキスト入力なので自由なキャラクター設定が可能、ただし見えていない情報は語れない
- 速度: VLM TTFT 352ms + 生成、LLM は VLM キャプション待ち + 生成 → VLM 直接が速い
- NPU 排他: どちらも NPU 使用、同時実行不可

### Chat 統合試案

Web UI にチャットパネルを追加し、写真についてVLMと対話:

```
User: この猫は何をしてる？
VLM:  茶色の猫がキャットタワーの上で眠っています。
User: 元気そう？
VLM:  リラックスした姿勢で、穏やかに眠っているように見えます。
```

**実装**: SSE ストリーミング + `/api/chat` エンドポイント。
既存の OpenAI 互換 API (port 8000) を proxy するだけ。

---

## 3. AI Pyramid Hardware Integration

### Audio I/O

デバイスには以下のオーディオ機能がある:

| Device | Codec | Direction |
|--------|-------|-----------|
| hw:0,0 | ES8311 HiFi | Playback (モノラルスピーカー) |
| hw:0,1 | ES7210 4CH ADC | Capture (4ch マイクアレイ) |

### 可能性

#### 音声通知
- 新しい写真が撮れたとき: VLM キャプション → TTS → スピーカー
- 「茶トラがごはんを食べています」

#### 音声コマンド
- KWS (ウェイクワード) → ASR → コマンド解釈
- 「今日の写真を見せて」→ 最新写真をダッシュボードに表示
- StackFlow の既存パイプラインを利用可能

#### 環境音分析
- マイクで猫の鳴き声を検出
- 食器の音 → 食事イベントの補助データ
- NPU で音声分類モデルを動かす可能性

### 制約

- NPU 排他: VLM/TTS/ASR は同時実行不可 → 優先度キューで管理
- スピーカー品質: モノラル DAC、音楽再生には不向き → 通知音声には十分
- マイク距離: 本体から猫までの距離によって S/N 比が変わる
- 常時録音のプライバシー: KWS をゲートにして、ウェイクワード後のみ録音

### これは Web UI ではなくアプリケーション機能

音声通知・コマンドは Web ブラウザ経由ではなく、デバイス上のデーモンとして実装するのが自然。
Web UI はダッシュボード表示と設定変更に使い、音声 I/O はバックエンドサービスが担当。

```
pet-album.service     ← 写真管理、Web UI
pet-voice.service     ← NEW: 音声通知、コマンド (KWS→ASR→LLM→TTS)
axllm-serve.service   ← VLM/LLM 推論 (共有)
```

---

## Edit History UI

### 背景

`edit_history` テーブルに pet_id / behavior / is_valid の変更が JSON 差分で記録されている (68件+)。
現状は DB に溜まるだけで UI から参照できない。

### UI アイデア

- **モーダル内タブ**: EventDetail モーダルに「History」タブを追加。写真ごとの編集履歴をタイムライン表示
  - `{created_at}  pet_id: mike → chatora`
  - `{created_at}  behavior: resting → eating`
  - 直感的な diff 表示 (色分け: old=赤、new=緑)

- **全体のアクティビティフィード**: `/app` のサイドパネルまたは専用ページに、全写真の編集履歴を新しい順で一覧
  - フィルタ: 日付範囲、編集者 (将来マルチユーザー対応時)、変更タイプ (pet_id / behavior / is_valid)

- **VLM 補正の可視化**: VLM が判定した初期値 → ユーザーが修正した値の乖離を集計し、VLM の弱点を特定
  - 例: 「mike を chatora に修正する頻度が高い」→ VLM prompt 改善のヒント

### API

- `GET /api/edit-history/{photo_id}` — 写真ごとの履歴
- `GET /api/edit-history?limit=50&offset=0` — 全体フィード (ページネーション)

### 実装メモ

- DB スキーマは既に十分 (`photo_id`, `changes` JSON, `created_at`)
- `changes` の JSON パースは UI 側 (TypeScript) で行い、表示用に整形
- detection override (`pet_id_override`) の変更も edit_history に記録するとなお良い
