# ai-pyramid — Album & VLM Service (M5Stack AI Pyramid Pro / AX8850)

## Overview
AI Pyramid Pro (Axera AX8850 / 内部: AX650C) 上で動作するアルバム管理・VLM行動解析サービス。
RDK X5のPreact SPAからiframeで埋め込まれる独立Webアプリ。**Rust実装** (axum + rusqlite)。

## Build & Test
```bash
cd src/ai-pyramid
cargo test          # 32 tests (filename, DB, VLM, server)
cargo build         # dev build
cargo build --release  # optimized (opt-level=z, LTO, strip)
```

## Run
```bash
./run_album          # release build + run (production)
./run_album --debug  # debug build + run (test data)
```

## Deploy (GitHub Actions artifact)
`src/ai-pyramid/**` への変更がmainにマージされると、GitHub Actionsの
aarch64ランナーで自動ビルドされる（約1-3分）。実機で10分かけてビルドするより
artifactをダウンロードする方が速い。

```bash
# 最新のartifactをダウンロード
gh run download --name pet-album-aarch64 --dir /tmp/pet-album
chmod +x /tmp/pet-album/pet-album
# 実行
/tmp/pet-album/pet-album --photos-dir data/photos --db-path data/pet-album.db
```

ワークフロー: `.github/workflows/build-pet-album.yml`

## Device Specs (実機計測値)
- SoC: Axera AX8850 (AX650C_CHIP), Board: AX650N_M5stack_8G
- CPU: 8× Cortex-A55 @ 1500MHz (ARMv8.2-A, NEON/FP16/DotProd)
- NPU: 24 TOPS (INT8), 第5世代 Transformer最適化, AX_ENGINE v2.12.0s
- Memory: 8GB LPDDR4x → **System 2GB + CMM 6GB** (HWアクセラレーション用)
- Storage: eMMC 32GB + microSD

## Architecture
```
src/ai-pyramid/
  src/
    main.rs           # CLI entry point (clap), tokio runtime
    lib.rs            # module exports
    ingest/
      filename.rs     # parse comic_YYYYMMDD_HHMMSS_{pet_id}.jpg
      watcher.rs      # fsnotify watch + VLM processing queue
    db/mod.rs         # SQLite PhotoStore (rusqlite, in-memory for tests)
    vlm/mod.rs        # OpenAI API client, prompt, JSON parser
    server/mod.rs     # axum HTTP server, REST API, album template
  templates/
    album.html        # askama server-rendered photo grid
```

## Key Design Decisions
- **pet_id**: NOT from VLM (chatora bias). From Go bbox color analysis → filename
- **VLM**: is_valid (100%), caption, behavior only
- **Memory**: ~35-50MB RSS target (2GB system RAM constraint)
- **SQLite**: modernc.org/sqlite equivalent (rusqlite bundled)
- **Concurrency**: VLM worker = 1 (NPU exclusive resource)

## Docs
→ `docs/pet-album-spec.md`, `docs/vlm_integration_spec.md`
