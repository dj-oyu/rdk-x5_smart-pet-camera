# ai-pyramid — Album & VLM Service (M5Stack AI Pyramid Pro / AX8850)

## Overview
AI Pyramid Pro (Axera AX8850 / 内部: AX650C) 上で動作するアルバム管理・VLM行動解析サービス。
RDK X5のPreact SPAからiframeで埋め込まれる独立Webアプリ。**Rust実装** (axum + rusqlite)。

## Build & Test
```bash
cd src/ai-pyramid
cd ui && bun install && bun run build && cd ..  # UI build (required before cargo build)
cargo clippy        # lint (mandatory before build)
cargo test          # 52 tests
cargo build --release  # optimized (opt-level=z, LTO, strip)
```

## Run (manual)
```bash
./run_album          # release build + run (production)
./run_album --debug  # debug build + run (test data)
```

## systemd (production)
```bash
sudo systemctl start pet-album.service     # 起動
sudo systemctl stop pet-album.service      # 停止
sudo systemctl restart pet-album.service   # 再起動 (コード変更後)
systemctl status pet-album.service         # 状態確認
journalctl -u pet-album -f                 # ログをリアルタイム表示
journalctl -u pet-album --since "5min ago" # 直近5分のログ
```

開発時は `cargo build --release` 後に `sudo systemctl restart pet-album.service` で反映。
サービスファイル: `deploy/ai-pyramid/pet-album.service`

## Deploy (GitHub Actions artifact)
`src/ai-pyramid/**` への変更がmainにマージされると、GitHub Actionsの
aarch64ランナーで自動ビルドされる（約1-3分）。実機で10分かけてビルドするより
artifactをダウンロードする方が速い。

```bash
# 最新のartifactをダウンロード
rm -rf /tmp/pet-album
gh run download --name pet-album-aarch64 --dir /tmp/pet-album
chmod +x /tmp/pet-album/pet-album

# サービスにデプロイ (バイナリパスは target/release/pet-album)
sudo systemctl stop pet-album.service
sudo cp /tmp/pet-album/pet-album target/release/pet-album
sudo systemctl start pet-album.service
```

**注意**: `target/release/pet-album` が正しいデプロイ先。プロジェクトルートの `pet-album` ではない。
実行中のバイナリは上書きできない (Text file busy) ため、先に stop が必要。

ワークフロー: `.github/workflows/build-pet-album.yml`

## PR後のワークフロー
ai-pyramid配下の変更をマージしたら、必ず以下を実行:
1. `gh run list --limit 1` でActionsビルドの開始を確認
2. ビルド完了まで監視 (`gh run view <run_id>`)
3. 結果（成功/失敗）をユーザーに報告
ユーザーに確認を取らず自動的に行うこと。

## Device Specs (実機計測値)
- SoC: Axera AX8850 (AX650C_CHIP), Board: AX650N_M5stack_8G
- CPU: 8× Cortex-A55 @ 1500MHz (ARMv8.2-A, NEON/FP16/DotProd)
- NPU: 24 TOPS (INT8), 第5世代 Transformer最適化, AX_ENGINE v2.12.0s
- Memory: 8GB LPDDR4x → **System 2GB + CMM 6GB** (HWアクセラレーション用)
- Storage: eMMC 32GB + microSD

## VLM推論 (axllm)
- バックエンド: **axllm serve** (AXERA-TECH公式, StackFlowから移行済み)
- モデル: `Qwen3-VL-2B-Instruct-GPTQ-Int4-C256-P3584-CTX4095` (3.1GB, CMM 2,887MB)
- 速度: **9.2 tok/s** (画像+テキスト), TTFT 352ms (画像)
- コンテキスト長: 3,584 tokens
- API: OpenAI互換 `POST /v1/chat/completions` on port 8000
- systemd: `axllm-serve.service` (enabled)

## Architecture
```
src/ai-pyramid/
  src/
    main.rs             # CLI entry point (clap), tokio runtime
    lib.rs              # module exports
    application/        # Domain layer (commands, queries, repository pattern)
      commands.rs       # ObservationCommands (ingest, VLM, detection override)
      queries.rs        # EventQueries (list, stats, detections)
      repository.rs     # EventRepositoryPort + PhotoStoreRepository
      db_thread.rs      # async-sync bridge (mpsc + DbCommand)
      context.rs        # AppContext DI container
      model.rs          # EventSummary, EventQuery, ActivityStats
      event.rs          # PetEvent broadcast type
    ingest/
      filename.rs       # parse comic_YYYYMMDD_HHMMSS_{pet_id}.jpg
      watcher.rs        # fsnotify watch + VLM processing queue
    db/mod.rs           # SQLite PhotoStore, migrations, majority vote
    vlm/mod.rs          # OpenAI API client, prompt, JSON parser
    server/mod.rs       # axum HTTP server, REST API, SSE, embedded SPA
    mcp/mod.rs          # MCP JSON-RPC server (get_recent_photos tool)
  ui/                   # Preact SPA (bun build → include_dir! で埋め込み)
    src/
      app.tsx           # Main app (state, SSE, routing)
      components/
        event-grid.tsx  # Photo card grid
        event-detail.tsx # Modal: bbox overlay + pet_id correction
        filter-bar.tsx  # Status + pet filters (dynamic from API)
        stats-strip.tsx # Stats cards
      lib/api.ts        # API client, types
```

→ 詳細: `docs/architecture.md`

## Key Design Decisions
- **pet_id**: NOT from VLM (chatora bias). From Go bbox color analysis → filename
- **VLM**: is_valid (100%), caption, behavior only
- **Memory**: ~35-50MB RSS target (2GB system RAM constraint)
- **SQLite**: rusqlite bundled, WAL mode, single db_thread (no Mutex)
- **Concurrency**: VLM worker = 1 (NPU exclusive resource)
- **Detection override**: pet_id_override 更新時に photo の pet_id を cat detections の多数決で自動更新
- **Pet names**: `PET_NAME_*` 環境変数で表示名マッピング (再起動で反映)

## Docs
| Doc | Scope |
|-----|-------|
| `docs/architecture.md` | API, DB schema, application layer, UI, integrations の全体像 |
| `docs/pet-album-spec.md` | Album feature spec |
| `docs/vlm_integration_spec.md` | VLM behavior analysis spec |
| `docs/detections-integration.md` | YOLO detection → ai-pyramid 連携仕様 |
| `docs/vlm-optimization.md` | VLM呼び出し最適化レポート (axllmベンチマーク) |
