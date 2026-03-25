# Level2 Detection: AI Pyramid ローカル YOLO + VLM 連携パイプライン

## 概要

AI Pyramid Pro (AX8850, NPU 24 TOPS) 上で YOLO を直接走らせ、
RDK X5 への依存なしに高精度な物体検出 + VLM キャプション生成を行うパイプライン。

## 背景

### 現行 (Level1)
- RDK X5 上で YOLO26n (BPU 10 TOPS) → 6クラス (cat, dog, person, cup, bowl, chair)
- AI Pyramid → HTTP → RDK X5 → 検出結果返却
- ネットワーク往復 + RDK X5 の稼働が前提

### 新規 (Level2)
- AI Pyramid 上で YOLO11s + YOLO26l (NPU 24 TOPS) → 25+クラス
- ローカル完結、高精度 (mAP 48.6-55.0 vs 40.9)
- 検出結果を VLM プロンプトに注入 → ハルシネーション抑制

## ベンチマーク結果 (2026-03-25 実機計測)

### モデル別 cat 検出精度

| モデル | 明るい画像 | 暗い画像 | 推論時間 (NPU3) | CMM |
|--------|----------|---------|----------------|-----|
| YOLO11s | cat 81% | 検出ゼロ | 3.2ms | - |
| YOLO26l | cat 71% | cat 19% | 11.2ms | 33.9MB |
| YOLO26m | dog 64% (誤) | cat 37% | 8.6ms | 27.6MB |

### 推奨: デュアルモデルマージ

YOLO11s (明所最強) + YOLO26l (暗所対応) を両方走らせ、結果をマージ。
合計 ~15ms/パネル — オフライン処理なら全く問題なし。

### cat/dog 誤分類への対策

axmodel の量子化で cat(15) と dog(16) の分類精度が劣化。
家庭内ユースケースでは cat/dog を「pet」として統合扱い。

## アーキテクチャ

```
[バックフィル or オンデマンド]
  |
  v
photo JPEG (848x496 comic)
  |
  v
crop_panel() x 4 パネル (404x228)
  |
  v
YOLO11s (3.2ms) + YOLO26l (11.2ms) --- NPU 時分割
  |
  v
マージ: 同一 bbox 領域は高 confidence 優先
cat/dog -> "pet" 統合
25+ クラスフィルタ (家庭内有意義なもの)
  |
  v
detections DB (det_level=2, model="yolo11s+yolo26l-ax650")
  |
  v
VLM re-caption (検出コンテキスト付きプロンプト)
  "Detected: cat(81%), couch(72%), bowl(39%). Describe the behavior."
  |
  v
photos.caption 更新, photos.caption_level=1
```

## DB スキーマ拡張

```sql
-- detections テーブル
ALTER TABLE detections ADD COLUMN det_level INTEGER NOT NULL DEFAULT 1;
-- 1 = RDK X5 リアルタイム, 2 = AI Pyramid 高精度
ALTER TABLE detections ADD COLUMN model TEXT;
-- "yolo26n-bpu", "yolo11s+yolo26l-ax650" etc.

-- photos テーブル
ALTER TABLE photos ADD COLUMN caption_level INTEGER NOT NULL DEFAULT 0;
-- 0 = 基本 VLM, 1 = 検出コンテキスト付き VLM
```

UI は level2 があれば level1 を完全に非表示:
```sql
SELECT * FROM detections
WHERE photo_id = ?
  AND det_level = (SELECT MAX(det_level) FROM detections WHERE photo_id = ?)
```

## 拡張クラスセット (Level2)

| カテゴリ | COCO クラス |
|---------|------------|
| ペット | cat, dog, bird |
| 人 | person |
| 家具 | chair, couch, bed, dining table |
| 食事 | bowl, cup, bottle |
| 家電 | tv, laptop, keyboard, remote |
| 雑貨 | book, vase, potted plant, clock |
| バッグ | backpack, handbag, suitcase |

## UI 表現: Tier 別 bbox

検出クラスの重要度で視覚表現を変える:

| Tier | クラス | bbox 表現 |
|------|-------|----------|
| Tier 1 | cat, dog | フルすりガラス + 輪郭 shine orbit |
| Tier 2 | person, bowl, cup | 枠線なし、shine orbit のみ |
| Tier 3 | chair, table, book, tv... | キラキラ粒子のみ |

## 実装コンポーネント

### 1. LocalDetector (Rust, subprocess wrapper)

```rust
pub struct LocalDetector {
    yolo11s_binary: PathBuf,  // ax_yolo11
    yolo26l_binary: PathBuf,  // ax_yolo26
    yolo11s_model: PathBuf,   // yolo11s.axmodel
    yolo26l_model: PathBuf,   // yolo26l.axmodel
}
```

- `tokio::process::Command` で subprocess 実行
- stdout パースして `Vec<DetectionInput>` に変換
- 2モデル結果をマージ (IoU ベースの重複排除)
- root 権限必要 (`sudo` or sudoers NOPASSWD)

### 2. NPU 排他制御

VLM (axllm serve) と YOLO を同時に NPU で走らせない:
- `AtomicBool` で NPU busy フラグ管理
- バックフィル中は VLM を一時停止 or 検出と VLM を交互実行
- オンデマンド検出: NPU ビジーなら 202 Accepted + キュー

### 3. VLM プロンプト強化

```
現行:
  "Analyze this photo of a pet camera feed. Respond with valid JSON..."

強化版:
  "Analyze this photo of a pet camera feed.
   Detected objects: cat (81%), couch (72%), bowl (39%).
   Use these detections as reference. Respond with valid JSON..."
```

### 4. SSE リアルタイム連携

- `backfill-progress`: `{ current, total, filename, dets }`
- `detection-ready`: `{ filename, dets }` (オンデマンド完了時)

### 5. オンデマンド検出

```
POST /api/detect-now/{filename}
  -> NPU 空きなら即座に level2 実行
  -> SSE detection-ready で UI にリアルタイム反映
```

## 実装ステップ

### Phase 1: 基盤 (完了)
- [x] YOLO26m/n/s/l axmodel ダウンロード
- [x] YOLO11s/x axmodel ダウンロード
- [x] ax-samples ビルド (ax_yolo26, ax_yolo11)
- [x] 実機ベンチマーク (5モデル x 2画像)
- [x] デュアルモデル戦略決定

### Phase 2: DB + Rust 実装 (進行中)
- [x] DB マイグレーション (det_level, model, caption_level)
- [ ] LocalDetector subprocess wrapper
- [ ] パネル crop + 座標変換 (既存ロジック流用)
- [ ] デュアルモデルマージロジック
- [ ] バックフィルに LocalDetector 統合

### Phase 3: VLM 連携
- [ ] VLM プロンプト強化 (検出コンテキスト注入)
- [ ] caption_level 管理

### Phase 4: UI
- [ ] level2 優先表示
- [ ] Tier 別 bbox 表現
- [ ] SSE 進捗表示
- [ ] オンデマンド検出 UI

## 制約・注意事項

- eMMC 残量 5.2GB — SSD 増設推奨
- System RAM 2GB — cargo build は `CARGO_BUILD_JOBS=2` 必須 (OOM 回避)
- NPU アクセスに root 権限必要 (`/dev/mem`)
- VLM と YOLO の NPU 時分割が必要
- ax_yolo26/ax_yolo11 の出力閾値を 0.10 に設定済み (デフォルト 0.45 では暗所検出不可)

## 関連ドキュメント

- [YOLO axmodel ベンチマーク](../../../home/admin-user/github/ai/ai-pyramid-research/docs/14_yolo_axmodel_benchmark.md)
- [テキスト LLM ベンチマーク](../../../home/admin-user/github/ai/ai-pyramid-research/docs/13_text_llm_benchmark.md)
- [VLM 最適化レポート](vlm-optimization.md)
- [検出連携仕様](detections-integration.md)
