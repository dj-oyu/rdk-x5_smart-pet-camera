# ペットアルバム機能 設計書

**Status**: Draft v4
**Date**: 2026-03-21

---

## 1. 概要

YOLO検出ベースで猫のベストショットを4コマcomicとして自動保存し、VLMによるフィルタリング・キャプション付与で品質を高めるシステム。

### 1.1 コンポーネント構成

```
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│  RDK X5                          │    │  M5Stack AI Pyramid Pro          │
│                                   │    │  (Axera AX8850 / AX650C)        │
│  Camera → YOLO検出 → SHM          │    │  HTTPS (:8090, Tailscale証明書)  │
│  Go Streaming Server (:8080)      │    │  VLM推論エンジン (NPU 24TOPS)    │
│    Comic生成 (4コマ合成)          │    │  SQLite DB (eMMC 32GB)          │
│    → SD一時保存                   │    │    - photos テーブル             │
│  inotify+rsync → AI Pyramidへ転送 │    │    - behavior_logs テーブル      │
│  Preact SPA (映像・検出)          │    │  画像ストレージ (eMMC)          │
│    └─ <iframe> → AI Pyramid UI    │    │  アルバムWebアプリ（独立UI）     │
└──────────────────────────────────┘    └──────────────────────────────────┘
         │  Tailscale (WireGuard暗号化)         │
         └──────────────────────────────────────┘
```

### 1.2 データフロー

```
[生成フロー]
YOLO検出(5秒連続) → Go comic生成 → SD一時保存
  → inotify+rsync → AI Pyramid Pro eMMCに転送 → SD側削除

[配信フロー]
Browser
  └─ https://rdk-x5:8080
       ├─ Preact SPA（映像・YOLO検出・軌跡）
       └─ <iframe src="https://<album-host>:8090/album">
            └─ AI Pyramid Proが完全にレンダリングしたアルバムUI
                ├─ 写真一覧（フィルタ・キャプション表示）
                ├─ 行動履歴タイムライン
                └─ 統計ダッシュボード
```

### 1.3 設計方針

| 方針 | 決定 | 理由 |
|------|------|------|
| フロントエンド | iframe（AI Pyramid ProがHTMLを配信） | AI Pyramid Pro単体で開発・テスト可能 |
| データ配信 | AI Pyramid Proから直接（CSR） | Go ServerのProxy不要、責務分離 |
| HTTPS | Tailscale証明書（両デバイス） | Mixed Content回避、セキュリティ |
| DB配置 | AI Pyramid Pro側SQLite (eMMC) | SD寿命保護、信頼性、速度 |
| 写真同期 | inotify + rsync | サーバー外で完結、転送確認+削除が安全 |
| メタデータ | AI Pyramid Proに完全委任 | Single source of truth |
| リポジトリ | 同一リポジトリ (`src/ai-pyramid/`) | 設計書・型定義を一元管理 |
| Mock | 新規開発不要 | 既存mock + サンプルJPEGで十分 |

---

## 2. AI Pyramid Pro デバイス環境

### 2.1 ハードウェアスペック

| 項目 | 値 | 備考 |
|------|-----|------|
| デバイス | M5Stack AI Pyramid Pro | 8GB版、グレー筐体 |
| SoC | Axera AX8850 (内部: AX650C_CHIP) | ボードID: AX650N_M5stack_8G |
| CPU | 8× ARM Cortex-A55 @ 1500MHz | ARMv8.2-A, NEON/FP16/DotProd対応 |
| NPU | 24 TOPS @ INT8 | 第5世代、Transformer最適化アーキテクチャ |
| メモリ合計 | 8GB LPDDR4x (4266Mbps) | — |
| → System RAM | **2GB** | OS・アプリ・Webサーバー用 |
| → CMM (HWアクセラレーション) | **6GB** | NPU推論・ビデオエンコード/デコード用 |
| ストレージ | 32GB eMMC 5.1 + microSDスロット | DB・画像はeMMCに配置 |
| Ethernet | 2× Gigabit Ethernet | デュアルポート |
| USB | 4× USB-A 3.0 + 2× USB-C (Host + PD 3.0 100W) | — |
| HDMI | 2× HDMI 2.0 (1入力 + 1出力) | 4K@60fps、Pro固有のHDMI入力 |
| ビデオエンジン | 8K@30fps H.264/H.265 エンコード/デコード | 16ch 1080p並列デコード |
| オーディオ | ES8311コーデック + ES7210 4マイクアレイ + スピーカー | — |
| OLED | SSD1306 (128×32) | ステータス表示用 |
| 電源 | PD入力 DC 9V@3A (27W) | — |
| サイズ / 重量 | 114.5×105.0×62.0mm / 194.9g | — |

### 2.2 メモリアーキテクチャの制約

```
8GB LPDDR4x 合計
├── System RAM: 2GB ← OS, Webサーバー, SQLite, Python/Go プロセス
└── CMM (Contiguous Memory Manager): 6GB ← NPU推論, VENC/VDEC, IVPS
```

**設計上の影響:**
- Webサーバー + SQLite + VLM前処理/tokenizer は **System 2GB** に収める必要がある
- VLMモデルウェイト自体はCMM経由でNPUにロードされるため6GB側を使用
- Go/Pythonのプロセスメモリを最小化する設計が必須
- 大量画像のインメモリ処理は避け、ストリーミング/ディスクベースで処理

### 2.3 ソフトウェア環境

| 項目 | 値 |
|------|-----|
| OS | Linux (Debian系, aarch64) |
| SDK | Axera SDK V3.6.4 |
| NPUエンジン | AX_ENGINE v2.12.0s |
| NPU推論モード | VIRTUAL_NPU_DISABLE |
| Python | Python 3 + PyTorch 2.10.0+cpu (aarch64) |
| NPU Python API | PyAXEngine (cffi, ONNXRuntime互換) |
| LLM/VLMフレームワーク | ax-llm (OpenAI API互換サーバー) |
| モデル形式 | `.axmodel` (Pulsar2 v4.1+ でコンパイル) |
| ライブラリパス | `/soc/lib/` (libax_engine.so, libax_ivps.so 等34モジュール) |
| コンパイラ | GCC aarch64, `-O3 -march=armv8.2-a+fp16+dotprod` |
| MAU | 利用不可 (AX650Cバリアントでは非搭載) |

### 2.4 VLMモデル選定

**方針**: Qwen3.5世代を目標とし、AXERA-TECH公式axmodelの提供状況に応じて段階的に移行する。

#### 現行候補（AXERA-TECH HuggingFace でaxmodel提供済み）

| モデル | 量子化 | サイズ目安 | 特徴 |
|--------|--------|-----------|------|
| **Qwen3-VL-2B-Instruct** | GPTQ-Int4 (w4a16) | ~1.5GB | 軽量、System 2GB制約と最も相性が良い |
| **Qwen3-VL-4B-Instruct** | GPTQ-Int4 (w4a16) | ~2.5GB | 高精度、メモリ余裕があれば推奨 |
| Qwen3-VL-8B-Instruct | GPTQ-Int4 (w4a16) | ~5GB | 最高精度だがメモリ制約で要検証 |
| InternVL3.5-1B | GPTQ-Int4 | ~1GB | 軽量代替 |

#### 目標（Qwen3.5世代 — Early-Fusion VLM）

Qwen3.5はLLM自体にVision Encoderが統合された**early-fusion**アーキテクチャ。
Qwen3-VLのような個別VLエンコーダ+LLMの分離構成ではなく、事前学習段階から
マルチモーダルトークンで統合訓練されている。

| モデル | パラメータ | アーキテクチャ | axmodel状態 |
|--------|-----------|--------------|-------------|
| **Qwen3.5-0.8B** | 0.8B (dense) | Gated DeltaNet + Attention hybrid, 24層 | 未提供 |
| **Qwen3.5-2B** | 2B (dense) | 同上 | 未提供 |
| **Qwen3.5-4B** | 4B (dense) | 同上, 32層 | 未提供 |

**Qwen3.5 アーキテクチャ特徴:**
- **Early Fusion**: Vision Encoder内蔵、テキスト・画像・動画をネイティブ処理
- **Gated Delta Networks**: 線形Attention（3層）+ 標準Attention（1層）のハイブリッド構成
- **262Kコンテキスト**: YaRN拡張で最大1Mトークン対応
- **201言語対応**: 日本語プロンプトに自然に対応
- **Multi-Token Prediction**: 推論高速化（speculative decoding対応）
- ONNX export対応確認済み（[onnx-community/Qwen3.5-0.8B-ONNX](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX)）

**axmodel変換の見通し:**

| 項目 | 状況 |
|------|------|
| AXERA公式axmodel | 2026-03-21時点で**未提供**（Qwen3-VLまで対応済み） |
| Pulsar2 LLM Build | `pulsar2 llm_build` でsafetensors→axmodel変換可能（実験段階） |
| 量子化オプション | w8a16 (s8), w4a16 (s4) をサポート |
| チップターゲット | `--chip AX650` |
| 変換の障壁 | Gated DeltaNet（線形Attention）がPulsar2で対応済みか**未検証** |
| ONNX経由 | ONNX exportは可能だが、LLM BuildはHuggingFace safetensorsを直接入力 |

**推奨パス:**
1. **Phase 2開始時**: Qwen3-VL-2B-Instruct (GPTQ-Int4) で実装・検証（axmodel提供済み）
2. **並行検証**: Qwen3.5-0.8B の `pulsar2 llm_build` 変換を試行
   - Gated DeltaNet対応が確認できればQwen3.5-2Bに移行
   - 非対応の場合、AXERA公式対応を待つ
3. **最終目標**: Qwen3.5-2B or 4B（early-fusionによるレイテンシ改善+画像理解精度向上）

#### デプロイ方式

M5Stack標準の `llm-openai-api` (systemd) が OpenAI互換APIを `localhost:8000` で提供。
`llm-vlm` / `llm-llm` / `llm-sys` が自動起動済み。

```
systemd services (自動起動)
  llm-sys       → バックエンド管理
  llm-llm       → LLM推論 + tokenizer (port 8080)
  llm-vlm       → VLM推論
  llm-openai-api → OpenAI互換API (port 8000)

Album/VLMサービス (Go or Python)
  ├── POST http://localhost:8000/v1/chat/completions
  │     model: "qwen3-vl-2B-Int4-ax650"
  │     画像: base64エンコードJPEG
  ├── JSON応答をパースして is_valid / caption / pet_id を抽出
  └── SQLiteに保存
```

### 2.5 実機ベンチマーク（2026-03-21 実測）

#### テスト条件
- デバイス: M5Stack AI Pyramid Pro (AX650N_M5stack_8G)
- モデル: qwen3-vl-2B-Int4-ax650 (GPTQ-Int4, CMM 4.1GiB)
- API: llm-openai-api (localhost:8000)
- max_tokens: 100-128

#### 応答時間

| 画像サイズ | max_tokens | 応答時間 |
|-----------|-----------|---------|
| ~2 MB | 128 | **5-8秒** |
| ~500 KB | 128 | **4-6秒** |
| ~2 MB | 512 | 60-180秒（繰り返しループ発生） |

→ **max_tokens=100-128が最適**。ペットアルバム用途では十分。

#### is_valid判定精度

| 画像タイプ | テスト数 | 正解率 |
|-----------|---------|--------|
| 猫画像 | 8 | **100%** (全てtrue) |
| 非猫画像（犬・昆虫・食べ物） | 7 | **86%** (6/7 正解、1件falseが稀にtrueに) |

#### caption品質（英語出力）

| 画像 | caption例 |
|------|----------|
| 茶トラ on 壁 | "A tabby cat with brown and black stripes sits calmly, gaze fixed on viewer" |
| 子猫 | "A tabby cat with white muzzle and green eyes, paw raised as if to play" |
| 雪上の猫 | "A tabby cat with striped coat and yellow eyes walking in snow" |

→ 毛色・目の色・姿勢・行動を1文で的確に記述。

#### 言語別安定性

| 項目 | English | Japanese | Chinese |
|------|---------|----------|---------|
| JSON parse成功率 | **最高** | プロンプト漏れあり | 一部エラー |
| caption品質 | **◎ 具体的** | △ 不安定 | ○ |
| 推奨度 | **採用** | × | △ |

→ **プロンプトは英語を採用**。captionも英語で生成し、UI側で必要に応じ翻訳。

#### VLMフィルタリング プロンプト（確定版）

```
Analyze this photo of a pet camera feed. Respond with valid JSON only, no markdown.
{"is_valid": true if a cat is clearly visible else false,
 "caption": "one sentence describing the cat's appearance and action",
 "pet_id": "mike" if calico/tricolor cat or "chatora" if tabby/orange cat or null,
 "behavior": one of "eating","sleeping","playing","resting","moving","grooming","other"}
```

#### 既知の問題
- `max_tokens` が大きいと同じ文が繰り返されるループ現象 → max_tokens=100で回避
- llm-openai-api Plugin側で一部リクエストが `NoneType` エラー → リトライロジックで対応
- 非猫画像のis_valid判定が稀にtrueになる → 閾値調整またはダブルチェックで対応

### 2.5 AI Pyramid Pro 固有機能（将来活用の可能性）

| 機能 | 活用案 | 優先度 |
|------|--------|--------|
| HDMI入力 | RDK X5からHDMI経由で直接映像取得（MJPEG over Tailscaleの代替） | 低 |
| デュアルGbE | RDK X5と有線直結で高帯域・低レイテンシ転送 | 中 |
| 4マイクアレイ | ペットの鳴き声検出・音声イベントトリガー | 低 |
| H.265 HWエンコード | 映像アーカイブの圧縮保存 | 低 |
| OLED (SSD1306) | デバイスステータス表示（推論中、DB容量等） | 低 |

---

## 3. 現状アーキテクチャ（実装済み）

### 3.1 キャプチャ状態マシン

Go内の `ComicCapture` が以下の状態遷移でcomicを生成する:

```
IDLE ──(5秒連続検出)──→ CAPTURING ──(4パネル完了)──→ STITCH → SAVE → IDLE
                              │
                        (猫消失5秒) → 残りパネルをプレースホルダーで埋めて STITCH
```

| パラメータ | 値 | 説明 |
|---|---|---|
| DetectionThreshold | 5秒 | 連続検出でキャプチャ開始 |
| BaseCaptureInterval | 10秒 | パネル間の基本間隔（適応的に伸長） |
| DetectionLost | 5秒 | 猫消失判定の閾値 |
| MaxPanels | 4 | 常に2x2グリッド |
| RateLimitWindow | 5分 | スライディングウィンドウ |
| RateLimitMax | 3 | ウィンドウ内の最大comic数 |

### 3.2 画像合成

| 項目 | 値 |
|---|---|
| パネルサイズ | 400x225 (16:9) |
| キャンバスサイズ | 836x494 |
| マージン / ギャップ / ボーダー | 12px / 12px / 2px |
| JPEG品質 | 85 |
| 保存先 | `{RecordingOutputPath}/comics/comic_YYYYMMDD_HHMMSS.jpg` |

**パネル内容:**
- Panel 0: 全体フレーム（エスタブリッシングショット）
- Panel 1-3: bbox中心のズームクロップ（1.3x-2.5x、ランダム）
- プレースホルダー: 広角クロップ（3.0x-4.0x）

### 3.3 REST API（現在のGo実装 → Phase 2で廃止予定）

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/api/comics` | GET | ページネーション付き一覧 (`limit`, `offset`) |
| `/api/comics/{filename}` | GET | 画像配信 |
| `/api/comics/{filename}` | DELETE | 画像削除 |

### 3.4 フロントエンド（Preact SPA）

- サイドバー「アルバム」セクション → Phase 2でiframeに置き換え
- 現在: 横スクロールギャラリー、無限スクロール、ライトボックス、削除

---

## 4. 拡張ロードマップ

### Phase 2: AI Pyramid Pro アルバムサービス

#### 4.1 写真同期（inotify + rsync）

```bash
# launchスクリプトに組み込み
inotifywait -m -e close_write /recordings/comics/ |
while read dir event file; do
  rsync -a --remove-source-files "${dir}${file}" \
    m5stack-ai-pyramid:/data/pet-album/comics/
done
```

- Tailscale SSH経由（認証済み）
- `--remove-source-files` で転送成功分のみSD側削除
- Goサーバーと独立（サーバー障害時も同期は継続）

#### 4.2 AI Pyramid Pro HTTPS化

```bash
tailscale cert <album-host>
```

- RDK X5と同じTailscale証明書方式
- ブラウザからのiframeアクセスにHTTPS必須（Mixed Content回避）

#### 4.3 DB設計（AI Pyramid Pro側 SQLite on eMMC）

```sql
CREATE TABLE photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,       -- "comic_20260321_104532.jpg"
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    caption TEXT,                         -- VLMによるキャプション
    is_valid BOOLEAN,                    -- NULL: 未処理, 1: 良い, 0: イマイチ
    pet_id TEXT                           -- "mike", "chatora", or NULL
);
CREATE INDEX idx_photos_valid ON photos(is_valid, captured_at);
```

- `is_valid = 0` の写真は削除せず保持（eMMC容量十分）
- UI上でグレーアウト/透過表示
- ユーザーが手動でis_validを切り替え可能（VLM誤判定の救済）

#### 4.4 VLMフィルタリング・キャプション付与

ax-llm の OpenAI API互換エンドポイントを利用:

```
[comic JPEG到着] → ax-llm /v1/chat/completions に画像+プロンプト送信
  → VLM応答をパース → is_valid / caption / pet_id を photos テーブルに更新
```

- **モデル**: Qwen3-VL-2B-Instruct (GPTQ-Int4) → Qwen3.5世代へ移行予定
- 猫が写っているか、ベストショットか → `is_valid` / `caption` 付与
- `vlm_integration_spec.md` の行動解析パイプラインと同一基盤

#### 4.5 アルバムWebアプリ（AI Pyramid Pro側）

AI Pyramid Proが完全なHTMLを配信する独立Webアプリ:
- `https://m5stack-ai-pyramid:8090/album` でアクセス
- AI Pyramid Pro単体でブラウザアクセスしても完全なUIが見える
- 技術選択は自由（Go + html/template + HTMX、またはSPA等）

**RDK X5側の変更（最小限）:**
```tsx
// Sidebar.tsx: アルバムセクションをiframeに置き換え
<iframe
  src="https://<album-host>:8090/album"
  style="width:100%;border:none;"
/>
// 読み込み失敗時 → 「アルバムサービスに接続できません」表示
```

- Go Serverからcomic API削除可能（Proxy不要）
- Go Serverの責務: 映像配信 + YOLO検出 に専念

### Phase 3: ギャラリー強化

- キャプション表示（VLM付与テキスト）
- is_validフィルタリング（デフォルト: 良い写真のみ、トグルで全表示）
- 個体別フィルタ（三毛猫 / 茶トラ）
- 時系列ビュー / カレンダービュー

### 将来: MCP拡張

AI Pyramid Proが独自のHTTPSエンドポイントを持つことで:
- MCPツールとして公開可能（`get_pet_album`, `get_behavior_summary`等）
- AIエージェントが直接ペットの状況を問い合わせられる

---

## 5. DB配置の設計根拠

| 観点 | RDK X5 | AI Pyramid Pro (AX8850) |
|---|---|---|
| ストレージ | microSD (Class 10) | eMMC 32GB |
| 信頼性 | SD書き込み寿命の懸念 | eMMCは耐久性・速度ともに有利 |
| CPU余裕 | 高負荷（カメラ+YOLO+配信） | 推論間は低負荷 |
| メモリ | 4GB DDR4 | System 2GB + CMM 6GB (LPDDR4x) |

→ AI Pyramid Pro側にDB・画像ストレージを統合し、RDK X5は生成と映像配信に専念。

**メモリに関する注意**: AI Pyramid Proの8GB LPDDR4xのうちSystem RAMは2GBのみ。残り6GBはNPU/ビデオエンジン専用のCMM領域。Webサーバー・DB・アプリケーションは2GB内で動作する設計が必要。

---

## 6. フォールバック設計

| 障害 | 影響 | フォールバック |
|------|------|-------------|
| AI Pyramid Pro停止 | アルバム利用不可 | iframe読み込み失敗 → 「アルバムサービスに接続できません」表示 |
| ネットワーク断 | rsync転送停止 | SDに蓄積、復旧時に自動同期 |
| RDK X5停止 | 全機能停止 | — |

ライブ映像・YOLO検出はRDK X5単体で動作し続ける。

---

## 7. 関連ドキュメント

- `vlm_integration_spec.md`: VLM行動解析連携の詳細仕様（API契約、データモデル、AX8850システム設計）
- `axmodel-conversion-guide.md`: axmodel変換手順書（Pulsar2 llm_build、Qwen3-VL/Qwen3.5変換）
- [AXERA-TECH/ax-llm](https://github.com/AXERA-TECH/ax-llm): LLM/VLMデプロイフレームワーク
- [AXERA-TECH HuggingFace](https://huggingface.co/AXERA-TECH): コンパイル済みaxmodelリポジトリ
- [Qwen3-VL-2B-Instruct axmodel](https://huggingface.co/AXERA-TECH/Qwen3-VL-2B-Instruct-GPTQ-Int4): 第一候補モデル
