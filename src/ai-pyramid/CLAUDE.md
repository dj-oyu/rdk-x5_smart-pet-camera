# ai-pyramid — Album & VLM Service (AX8850)

## Overview
AI Pyramid Pro (Axera AX8850) 上のアルバム管理・VLM行動解析サービス。**Rust** (axum + rusqlite)。
RDK X5 の Preact SPA から iframe で埋め込み。

## Build & Test
```bash
cd src/ai-pyramid
cd ui && bun install && bun run build && cd ..
cargo clippy && cargo test && cargo build --release
```

## Deploy
GitHub Actions で自動ビルド (`src/ai-pyramid/**` 変更時)。実機より artifact DL が速い。
```bash
gh run download --name pet-album-aarch64 --dir /tmp/pet-album
sudo systemctl stop pet-album.service
sudo cp /tmp/pet-album/pet-album target/release/pet-album
sudo systemctl start pet-album.service
```

## PR後のワークフロー
ai-pyramid配下の変更をマージしたら、必ず以下を実行:
1. `gh run list --limit 1` でActionsビルドの開始を確認
2. ビルド完了まで監視 (`gh run view <run_id>`)
3. 結果（成功/失敗）をユーザーに報告
ユーザーに確認を取らず自動的に行うこと。

## Device
- 8× Cortex-A55, NPU 24 TOPS (INT8), 8GB RAM (System 2GB + CMM 6GB)

## VLM
- **axllm serve**: Qwen3-VL-2B-Instruct-GPTQ-Int4, 9.2 tok/s, port 8000
- systemd: `axllm-serve.service`

## Key Decisions
- **pet_id**: Go bbox color analysis → filename (NOT from VLM)
- **VLM**: is_valid, caption, behavior only
- **SQLite**: WAL mode, single db_thread (no Mutex)
- **Concurrency**: VLM worker = 1 (NPU exclusive)

## Docs
→ `docs/architecture.md`, `docs/pet-album-spec.md`, `docs/vlm_integration_spec.md`, `docs/detections-integration.md`
