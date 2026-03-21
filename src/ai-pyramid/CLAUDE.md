# ai-pyramid — Album & VLM Service (M5Stack AI Pyramid / AX8850)

## Overview
AI Pyramid (AX8850) 上で動作するアルバム管理・VLM行動解析サービス。
RDK X5のPreact SPAからiframeで埋め込まれる独立Webアプリ。

## Device Specs
- NPU: 24 TOPS (INT8)
- Memory: 8GB LPDDR4x
- Storage: eMMC 32GB
- Network: Tailscale (HTTPS, `<album-host>`)

## Architecture
```
RDK X5                              AI Pyramid
Preact SPA                          Album Web App (:8090 HTTPS)
  └─ <iframe src=".../album">  ──→    ├─ 写真一覧・フィルタ・キャプション
                                       ├─ 行動履歴タイムライン
                                       └─ 統計ダッシュボード

inotify+rsync ─────────────────→  data/photos/ (eMMC)
                                  data/pet-album.db (SQLite)
```

## Data Paths
- Photos: `data/photos/` (rsyncで届くcomic JPEG)
- DB: `data/pet-album.db` (SQLite on eMMC)
- Thumbnails: `data/thumbnails/`
- All under `/data/` — gitignored

## Planned Features
1. **Album UI**: iframe配信、写真一覧、is_validフィルタ、ライトボックス
2. **VLM Filtering**: comic判定 (is_valid/caption付与)
3. **Behavior Analysis**: MJPEG+SSE監視、行動ログ、個体識別
4. **MCP Extension**: ツールとして公開 (get_pet_album, get_behavior_summary)

## Docs
→ `docs/pet-album-spec-DRAFT.md`, `docs/vlm_integration_spec.md`
