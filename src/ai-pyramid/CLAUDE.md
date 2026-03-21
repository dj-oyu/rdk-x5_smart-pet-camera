# ai-pyramid — Album & VLM Service (M5Stack AI Pyramid Pro / AX8850)

## Overview
AI Pyramid Pro (Axera AX8850 / 内部: AX650C) 上で動作するアルバム管理・VLM行動解析サービス。
RDK X5のPreact SPAからiframeで埋め込まれる独立Webアプリ。

## Device Specs (実機計測値)
- SoC: Axera AX8850 (AX650C_CHIP), Board: AX650N_M5stack_8G
- CPU: 8× Cortex-A55 @ 1500MHz (ARMv8.2-A, NEON/FP16/DotProd)
- NPU: 24 TOPS (INT8), 第5世代 Transformer最適化, AX_ENGINE v2.12.0s
- Memory: 8GB LPDDR4x → **System 2GB + CMM 6GB** (HWアクセラレーション用)
- Storage: eMMC 32GB + microSD
- Network: Tailscale (HTTPS, `<album-host>`)
- SDK: Axera SDK V3.6.4, Pulsar2 v4.1+
- Python: Python 3, PyAXEngine (cffi, ONNXRuntime互換)
- LLM/VLM: ax-llm (OpenAI API互換), axmodel形式

## Architecture
```
RDK X5                              AI Pyramid Pro
Preact SPA                          Album Web App (:8090 HTTPS)
  └─ <iframe src=".../album">  ──→    ├─ 写真一覧・フィルタ・キャプション
                                       ├─ 行動履歴タイムライン
                                       └─ 統計ダッシュボード

inotify+rsync ─────────────────→  data/photos/ (eMMC)
                                  data/pet-album.db (SQLite)

ax-llm (:8091, OpenAI API互換)  ←  VLM推論 (Qwen3-VL-2B → Qwen3.5目標)
```

## Data Paths
- Photos: `data/photos/` (rsyncで届くcomic JPEG)
- DB: `data/pet-album.db` (SQLite on eMMC)
- Thumbnails: `data/thumbnails/`
- All under `/data/` — gitignored

## VLM Model Strategy
1. **現行**: Qwen3-VL-2B-Instruct (GPTQ-Int4) — AXERA公式axmodel提供済み
2. **目標**: Qwen3.5-2B (Early-Fusion VLM) — axmodel変換検証中

## Planned Features
1. **Album UI**: iframe配信、写真一覧、is_validフィルタ、ライトボックス
2. **VLM Filtering**: comic判定 (is_valid/caption付与)
3. **Behavior Analysis**: MJPEG+SSE監視、行動ログ、個体識別
4. **MCP Extension**: ツールとして公開 (get_pet_album, get_behavior_summary)

## Docs
→ `docs/pet-album-spec-DRAFT.md`, `docs/vlm_integration_spec.md`
