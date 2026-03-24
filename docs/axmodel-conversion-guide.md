# axmodel変換ガイド — AI Pyramid Pro (AX8850/AX650)

**Date**: 2026-03-21
**Target**: M5Stack AI Pyramid Pro (Axera AX8850 / AX650C)
**Pulsar2**: v5.0 (VLM対応)

---

## 1. 概要

HuggingFaceのVLM/LLMモデルを AI Pyramid Pro の NPU (24 TOPS INT8) で実行可能な
`.axmodel` 形式に変換する手順書。

### 1.1 変換パイプライン全体像

```
HuggingFace Model (safetensors)
  │
  ├─ [LLM部分] pulsar2 llm_build ──→ レイヤー別 .axmodel × N
  │                                    + post.axmodel
  │                                    + embed_tokens.weight.bfloat16.bin
  │
  └─ [Vision Encoder] pulsar2 llm_build (--image_size) ──→ vision_encoder.axmodel
```

### 1.2 対象モデル

| モデル | 用途 | 変換状態 |
|--------|------|----------|
| Qwen3-VL-2B-Instruct | 現行候補 | AXERA公式axmodel提供済み（変換不要） |
| Qwen3-VL-4B-Instruct | 高精度候補 | AXERA公式axmodel提供済み（変換不要） |
| **Qwen3.5-0.8B** | 軽量検証 | **自前変換が必要** |
| **Qwen3.5-2B** | 目標モデル | **自前変換が必要** |

---

## 2. 環境準備

### 2.1 ホストPC要件

変換はホストPC上で実行する（AI Pyramid Pro上ではない）。

| 項目 | 要件 |
|------|------|
| OS | Linux (Ubuntu 20.04/22.04/24.04, Debian 12) |
| CPU | Intel Xeon推奨（並列ビルド用） |
| RAM | 32GB以上推奨 |
| ストレージ | モデルサイズの3倍以上の空き容量 |
| Python | 3.8+ |

### 2.2 Pulsar2 インストール

```bash
# Pulsar2 ツールチェインの取得（AXERAから提供）
# バージョン5.0以上が必要（VLM対応）
pulsar2 version
# 期待出力: Pulsar2 V5.0 以上
```

### 2.3 ビルドツール取得

```bash
git clone https://github.com/AXERA-TECH/ax-llm-build.git
cd ax-llm-build
pip install -U huggingface_hub transformers torch
```

### 2.4 ディレクトリ構成

```
ax-llm-build/
├── config/                  # モデル設定ファイル
│   ├── qwen2-0.5B.json
│   ├── qwen2-1.5B.json
│   └── ...
├── tools/
│   ├── embed_process.sh     # LLM用埋め込み変換
│   ├── embed_process_vl.sh  # VLM用埋め込み変換
│   ├── extract_embed.py     # LLM用埋め込み抽出
│   ├── extract_embed_vl.py  # VLM用埋め込み抽出
│   ├── embed-process.py     # 埋め込み処理ユーティリティ
│   └── fp32_to_bf16         # FP32→BF16変換バイナリ
└── README.md
```

---

## 3. Qwen3-VL 変換手順（実績あり）

AXERA公式のaxmodelが提供済みだが、カスタム量子化が必要な場合の手順。

### 3.1 モデルダウンロード

```bash
huggingface-cli download --resume-download Qwen/Qwen3-VL-2B-Instruct \
  --local-dir Qwen/Qwen3-VL-2B-Instruct
```

### 3.2 LLMレイヤーのコンパイル

```bash
pulsar2 llm_build \
  --input_path Qwen/Qwen3-VL-2B-Instruct/ \
  --output_path Qwen/Qwen3-VL-2B-w8a16/ \
  --hidden_state_type bf16 \
  --weight_type s8 \
  --kv_cache_len 1023 \
  --prefill_len 128 \
  --chip AX650 \
  --parallel 8
```

**パラメータ解説:**

| パラメータ | 値 | 説明 |
|-----------|-----|------|
| `--input_path` | HFモデルディレクトリ | safetensors + config.json を含むパス |
| `--output_path` | 出力ディレクトリ | axmodelファイル群の出力先 |
| `--hidden_state_type` | `bf16` | 中間表現の型（bf16推奨） |
| `--weight_type` | `s8` (w8a16) or `s4` (w4a16) | 量子化精度 |
| `--kv_cache_len` | `1023` | KVキャッシュ長 |
| `--prefill_len` | `128` | プリフィルトークン長 |
| `--chip` | `AX650` | AI Pyramid Pro のターゲットチップ |
| `--parallel` | `8` | 並列ビルド数（ホストCPUコア数に応じて調整） |

**量子化オプション一覧:**

| `-w` 値 | 意味 | メモリ使用量 | 精度 |
|---------|------|------------|------|
| `fp16` | Weight FP16 | 最大 | 最高 |
| `bf16` | Weight BF16 | 最大 | 最高 |
| `s8` | Weight INT8 (w8a16) | 中 | 高 |
| `s4` | Weight INT4 (w4a16) | **最小** | 中 |
| `fp8_e5m2` | FP8 (E5M2) | 中 | 高 |
| `fp8_e4m3` | FP8 (E4M3) | 中 | 高 |

### 3.3 埋め込み層の変換（VLM用）

```bash
chmod +x ./tools/fp32_to_bf16
chmod +x ./tools/embed_process_vl.sh

# VLM用の埋め込み処理（Vision Encoder対応）
./tools/embed_process_vl.sh \
  Qwen/Qwen3-VL-2B-Instruct/ \
  Qwen/Qwen3-VL-2B-w8a16/
```

> **注意**: VLMモデルには `embed_process.sh` ではなく `embed_process_vl.sh` を使用する。
> 対応する Python スクリプトも `extract_embed_vl.py` が使われる。

### 3.4 出力ファイル

```
Qwen/Qwen3-VL-2B-w8a16/
├── model.embed_tokens.weight.bfloat16.bin    # 埋め込み層
├── qwen3_vl_p128_l0_together.axmodel         # レイヤー0
├── qwen3_vl_p128_l1_together.axmodel         # レイヤー1
├── ...                                        # (全28レイヤー)
├── qwen3_vl_p128_l27_together.axmodel        # レイヤー27
└── qwen3_vl_post.axmodel                     # 出力層
```

### 3.5 変換の検証

```bash
# レイヤー単位の精度チェック
pulsar2 llm_build \
  --check_level 1 \
  --input_path Qwen/Qwen3-VL-2B-Instruct/ \
  --output_path Qwen/Qwen3-VL-2B-w8a16/ \
  --hidden_state_type bf16 \
  --kv_cache_len 1023 \
  --prefill_len 128 \
  --chip AX650

# プロンプトによるEnd-to-End検証
pulsar2 llm_build \
  --check_level 2 \
  --prompt "<|im_start|>user\nこの画像に猫は写っていますか？<|im_end|>\n<|im_start|>assistant\n" \
  --input_path Qwen/Qwen3-VL-2B-Instruct/ \
  --output_path Qwen/Qwen3-VL-2B-w8a16/ \
  --hidden_state_type bf16 \
  --kv_cache_len 1023 \
  --prefill_len 128 \
  --chip AX650
```

---

## 4. ボードへのデプロイ

### 4.1 ファイル転送

```bash
# AI Pyramid Pro にaxmodelを転送
rsync -avz Qwen/Qwen3-VL-2B-w8a16/ \
  <album-host>:/opt/models/qwen3-vl-2b/
```

### 4.2 tokenizerサーバー起動

ax-llmはtokenizerを別プロセス（Pythonサーバー）で実行する。

```bash
# AI Pyramid Pro 上で実行
python3 qwen3_tokenizer.py --port 8080
```

### 4.3 ax-llm 推論サーバー起動

```bash
./main_ax650 \
  --template_filename_axmodel "/opt/models/qwen3-vl-2b/qwen3_vl_p128_l%d_together.axmodel" \
  --axmodel_num 28 \
  --tokenizer_type 2 \
  --url_tokenizer_model "http://127.0.0.1:8080" \
  --filename_post_axmodel "/opt/models/qwen3-vl-2b/qwen3_vl_post.axmodel" \
  --filename_tokens_embed "/opt/models/qwen3-vl-2b/model.embed_tokens.weight.bfloat16.bin" \
  --tokens_embed_num 151936 \
  --tokens_embed_size 896 \
  --live_print 1
```

### 4.4 OpenAI API互換エンドポイント

ax-llmはOpenAI API互換のHTTPサーバーとして動作する:

```bash
curl http://localhost:8091/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-vl-2b",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}},
          {"type": "text", "text": "この画像に写っている猫の行動を説明してください"}
        ]
      }
    ]
  }'
```

---

## 5. Qwen3-VL-2B 実測パフォーマンス（AX650）

### 5.1 画像処理（384×384, 1枚）

| メトリクス | 値 |
|-----------|-----|
| Vision Encoder | 238 ms |
| TTFT (168 tokens) | 392 ms |
| 生成速度 | **9.5 tokens/sec** |
| CMM使用量 | **4.1 GiB** (CMM 6GB中) |
| Flash使用量 | 4.2 GiB |

### 5.2 動画処理（384×384, 8フレーム）

| メトリクス | 値 |
|-----------|-----|
| Vision Encoder | 751 ms (157ms/frame × 4 + overhead) |
| TTFT (620 tokens) | 1045 ms |
| 生成速度 | **9.5 tokens/sec** |
| CMM使用量 | 4.1 GiB |

### 5.3 デコード内訳（2B, 28レイヤー）

| フェーズ | レイヤー単位 | 全28レイヤー |
|---------|------------|------------|
| Prefill (128 tokens) | 5.8-7.3 ms | 918.4 ms |
| Decode | 3.2 ms | 89.6 ms |
| Post overhead | — | 16.2 ms |

### 5.4 AI Pyramid Pro リソース適合性

| リソース | 容量 | Qwen3-VL-2B使用量 | 余裕 |
|---------|------|-------------------|------|
| CMM | 6 GiB | 4.1 GiB | 1.9 GiB |
| eMMC | 32 GB | 4.2 GB (モデル) | 27.8 GB |
| System RAM | 2 GB | tokenizer + Webサーバー | 要最適化 |

---

## 6. Qwen3.5 変換手順（実験的）

### 6.1 Qwen3.5 アーキテクチャの特徴

Qwen3.5は従来のTransformerと異なる**ハイブリッドアーキテクチャ**を採用:

```
レイヤー構成 (Qwen3.5-0.8B, 24層):
  6 × (3 × (Gated DeltaNet → FFN) → 1 × (Gated Attention → FFN))

レイヤー構成 (Qwen3.5-2B):
  同構成、層数増加

レイヤー構成 (Qwen3.5-4B, 32層):
  8 × (3 × (Gated DeltaNet → FFN) → 1 × (Gated Attention → FFN))
```

| コンポーネント | 説明 | Pulsar2対応 |
|--------------|------|------------|
| Gated Attention | 標準的なGQA (Grouped Query Attention) | 対応済み（Qwen2/3で実績） |
| **Gated DeltaNet** | 線形Attention（RNN的な状態更新） | **未検証** |
| FFN | SwiGLU活性化 | 対応済み |
| Vision Encoder | Early-Fusion（LLMに統合） | **未検証** |

### 6.2 変換の試行手順

```bash
# Step 1: モデルダウンロード（最小モデルで検証）
huggingface-cli download --resume-download Qwen/Qwen3.5-0.8B \
  --local-dir Qwen/Qwen3.5-0.8B

# Step 2: 変換試行
pulsar2 llm_build \
  --input_path Qwen/Qwen3.5-0.8B/ \
  --output_path Qwen/Qwen3.5-0.8B-w8a16/ \
  --hidden_state_type bf16 \
  --weight_type s8 \
  --kv_cache_len 1023 \
  --prefill_len 128 \
  --chip AX650 \
  --parallel 8

# Step 3: 成功した場合 → 精度チェック
pulsar2 llm_build \
  --check_level 1 \
  --input_path Qwen/Qwen3.5-0.8B/ \
  --output_path Qwen/Qwen3.5-0.8B-w8a16/ \
  --hidden_state_type bf16 \
  --kv_cache_len 1023 \
  --prefill_len 128 \
  --chip AX650

# Step 4: 埋め込み処理（VLMなので _vl 版を使用）
./tools/embed_process_vl.sh \
  Qwen/Qwen3.5-0.8B/ \
  Qwen/Qwen3.5-0.8B-w8a16/
```

### 6.3 想定される失敗パターンと対処

| 失敗パターン | 原因 | 対処 |
|-------------|------|------|
| `Unsupported layer type: GatedDeltaNet` | Pulsar2がDeltaNetを未サポート | AXERA公式対応を待つ、またはGitHub Issueで要望 |
| `Unknown model architecture` | config.jsonのmodel_typeが未登録 | `--model_config` でカスタム設定を指定 |
| Vision Encoder変換エラー | Early-Fusion構造の未対応 | Vision部分のみONNX経由で別途変換を検討 |
| OOM (Out of Memory) | ホストPCメモリ不足 | `--parallel 1` に下げる、またはRAM増設 |

### 6.4 代替アプローチ: ONNX経由の変換

`pulsar2 llm_build` が失敗した場合、従来の `pulsar2 build` (CNN/Transformerモデル用) を
ONNX経由で試行する:

```bash
# Step 1: ONNX export（既存のONNX版を使用）
huggingface-cli download --resume-download onnx-community/Qwen3.5-0.8B-ONNX \
  --local-dir Qwen/Qwen3.5-0.8B-ONNX

# Step 2: pulsar2 build（従来のCNN/Transformer変換パイプライン）
# ※ LLMとしてではなく、個別のTransformerブロックとして変換
# ※ この方法はtokenizer/KV cacheの自前実装が必要になるため複雑度が高い
```

> **推奨**: まず `pulsar2 llm_build` を試し、失敗した場合のみONNXルートを検討する。

---

## 7. メモリ見積もり

### 7.1 モデルサイズ別CMM使用量（推定）

| モデル | パラメータ | w8a16 | w4a16 | CMM 6GB適合 |
|--------|-----------|-------|-------|------------|
| Qwen3-VL-2B | 2B | 4.1 GiB | ~2.5 GiB | OK |
| Qwen3-VL-4B | 4B | ~6 GiB | ~3.5 GiB | w4a16のみ |
| Qwen3.5-0.8B | 0.8B | ~1.5 GiB | ~1 GiB | OK |
| Qwen3.5-2B | 2B | ~4 GiB | ~2.5 GiB | OK |
| Qwen3.5-4B | 4B | ~6 GiB | ~3.5 GiB | w4a16のみ |

### 7.2 System RAM使用量（2GB制約）

| プロセス | 推定メモリ |
|---------|----------|
| OS + systemd | ~300 MB |
| tokenizer (Python) | ~200-400 MB |
| ax-llm (main_ax650) | ~100-200 MB |
| Album Webサーバー | ~50-100 MB |
| SQLite | ~10-50 MB |
| **合計** | **~700 MB - 1.1 GB** |
| **残り** | **~900 MB - 1.3 GB** |

→ System RAM 2GBで動作可能だが余裕は少ない。tokenizerのメモリ効率が鍵。

---

## 8. 推奨ロードマップ

```
Phase 2a: 公式axmodel使用（変換不要）
  └─ AXERA-TECH/Qwen3-VL-2B-Instruct (GPTQ-Int4) をダウンロードしてデプロイ
     → アルバムUI + VLMフィルタリングの実装に集中

Phase 2b: Qwen3.5変換検証（並行作業）
  ├─ Qwen3.5-0.8B で pulsar2 llm_build 試行
  ├─ Gated DeltaNet 対応可否を確認
  └─ 成功 → Qwen3.5-2B に移行、精度比較

Phase 3: 最適モデルで本番化
  └─ Qwen3.5-2B (w4a16) または Qwen3-VL-2B (GPTQ-Int4)
     → パフォーマンス・精度・メモリのバランスで最終決定
```

---

## 9. リファレンス

- [Pulsar2 LLM Build ドキュメント (EN)](https://pulsar2-docs.readthedocs.io/en/latest/appendix/build_llm.html)
- [Pulsar2 大模型编译 ドキュメント (ZH)](https://pulsar2-docs.readthedocs.io/zh-cn/stable/appendix/build_llm.html)
- [Pulsar2 ドキュメント トップ](https://pulsar2-docs.readthedocs.io/en/latest/)
- [AXERA-TECH/ax-llm-build](https://github.com/AXERA-TECH/ax-llm-build) — ビルドツール・設定ファイル
- [AXERA-TECH/ax-llm](https://github.com/AXERA-TECH/ax-llm) — 推論フレームワーク
- [AXERA-TECH/Qwen3-VL.AXERA](https://github.com/AXERA-TECH/Qwen3-VL.AXERA) — Qwen3-VLデモ
- [AXERA-TECH HuggingFace](https://huggingface.co/AXERA-TECH) — 公式axmodelリポジトリ
- [AXERA-TECH/Qwen3-VL-2B-Instruct](https://huggingface.co/AXERA-TECH/Qwen3-VL-2B-Instruct) — 2Bモデルカード（パフォーマンスデータ）
- [AXERA-TECH/Qwen3-VL-2B-Instruct-GPTQ-Int4](https://huggingface.co/AXERA-TECH/Qwen3-VL-2B-Instruct-GPTQ-Int4)
- [onnx-community/Qwen3.5-0.8B-ONNX](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX) — ONNX版（フォールバック用）
- [Qwen3.5 公式リポジトリ](https://github.com/QwenLM/Qwen3.5)
