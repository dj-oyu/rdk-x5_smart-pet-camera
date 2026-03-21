# ペットアルバム機能 設計書

**Status**: Draft v3
**Date**: 2026-03-21

---

## 1. 概要

YOLO検出ベースで猫のベストショットを4コマcomicとして自動保存し、VLMによるフィルタリング・キャプション付与で品質を高めるシステム。

### 1.1 コンポーネント構成

```
┌──────────────────────────────────┐    ┌──────────────────────────────────┐
│  RDK X5                          │    │  M5Stack AI Pyramid (AX8850)     │
│                                   │    │                                  │
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
  → inotify+rsync → AI Pyramid eMMCに転送 → SD側削除

[配信フロー]
Browser
  └─ https://rdk-x5:8080
       ├─ Preact SPA（映像・YOLO検出・軌跡）
       └─ <iframe src="https://m5stack-ai-pyramid.tail848eb5.ts.net:8090/album">
            └─ AI Pyramidが完全にレンダリングしたアルバムUI
                ├─ 写真一覧（フィルタ・キャプション表示）
                ├─ 行動履歴タイムライン
                └─ 統計ダッシュボード
```

### 1.3 設計方針

| 方針 | 決定 | 理由 |
|------|------|------|
| フロントエンド | iframe（AI PyramidがHTMLを配信） | AI Pyramid単体で開発・テスト可能 |
| データ配信 | AI Pyramidから直接（CSR） | Go ServerのProxy不要、責務分離 |
| HTTPS | Tailscale証明書（両デバイス） | Mixed Content回避、セキュリティ |
| DB配置 | AI Pyramid側SQLite (eMMC) | SD寿命保護、信頼性、速度 |
| 写真同期 | inotify + rsync | サーバー外で完結、転送確認+削除が安全 |
| メタデータ | AI Pyramidに完全委任 | Single source of truth |
| リポジトリ | 同一リポジトリ (`src/ai-pyramid/`) | 設計書・型定義を一元管理 |
| Mock | 新規開発不要 | 既存mock + サンプルJPEGで十分 |

---

## 2. 現状アーキテクチャ（実装済み）

### 2.1 キャプチャ状態マシン

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

### 2.2 画像合成

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

### 2.3 REST API（現在のGo実装 → Phase 2で廃止予定）

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/api/comics` | GET | ページネーション付き一覧 (`limit`, `offset`) |
| `/api/comics/{filename}` | GET | 画像配信 |
| `/api/comics/{filename}` | DELETE | 画像削除 |

### 2.4 フロントエンド（Preact SPA）

- サイドバー「アルバム」セクション → Phase 2でiframeに置き換え
- 現在: 横スクロールギャラリー、無限スクロール、ライトボックス、削除

---

## 3. 拡張ロードマップ

### Phase 2: AI Pyramid アルバムサービス

#### 3.1 写真同期（inotify + rsync）

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

#### 3.2 AI Pyramid HTTPS化

```bash
tailscale cert m5stack-ai-pyramid.tail848eb5.ts.net
```

- RDK X5と同じTailscale証明書方式
- ブラウザからのiframeアクセスにHTTPS必須（Mixed Content回避）

#### 3.3 DB設計（AI Pyramid側 SQLite on eMMC）

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

#### 3.4 アルバムWebアプリ（AI Pyramid側）

AI Pyramidが完全なHTMLを配信する独立Webアプリ:
- `https://m5stack-ai-pyramid:8090/album` でアクセス
- AI Pyramid単体でブラウザアクセスしても完全なUIが見える
- 技術選択は自由（Go + html/template + HTMX、またはSPA等）

**RDK X5側の変更（最小限）:**
```tsx
// Sidebar.tsx: アルバムセクションをiframeに置き換え
<iframe
  src="https://m5stack-ai-pyramid.tail848eb5.ts.net:8090/album"
  style="width:100%;border:none;"
/>
// 読み込み失敗時 → 「アルバムサービスに接続できません」表示
```

- Go Serverからcomic API削除可能（Proxy不要）
- Go Serverの責務: 映像配信 + YOLO検出 に専念

#### 3.5 VLMフィルタリング

- AI PyramidがeMMCに届いたcomicをVLMで判定
- 猫が写っているか、ベストショットか → `is_valid` / `caption` 付与
- `vlm_integration_spec.md` の行動解析パイプラインと同一基盤

### Phase 3: ギャラリー強化

- キャプション表示（VLM付与テキスト）
- is_validフィルタリング（デフォルト: 良い写真のみ、トグルで全表示）
- 個体別フィルタ（三毛猫 / 茶トラ）
- 時系列ビュー / カレンダービュー

### 将来: MCP拡張

AI Pyramidが独自のHTTPSエンドポイントを持つことで:
- MCPツールとして公開可能（`get_pet_album`, `get_behavior_summary`等）
- AIエージェントが直接ペットの状況を問い合わせられる

---

## 4. DB配置の設計根拠

| 観点 | RDK X5 | AI Pyramid (AX8850) |
|---|---|---|
| ストレージ | microSD (Class 10) | eMMC 32GB |
| 信頼性 | SD書き込み寿命の懸念 | eMMCは耐久性・速度ともに有利 |
| CPU余裕 | 高負荷（カメラ+YOLO+配信） | 推論間は低負荷 |
| メモリ | 4GB DDR4 | 8GB LPDDR4x |

→ AI Pyramid側にDB・画像ストレージを統合し、RDK X5は生成と映像配信に専念。

---

## 5. フォールバック設計

| 障害 | 影響 | フォールバック |
|------|------|-------------|
| AI Pyramid停止 | アルバム利用不可 | iframe読み込み失敗 → 「アルバムサービスに接続できません」表示 |
| ネットワーク断 | rsync転送停止 | SDに蓄積、復旧時に自動同期 |
| RDK X5停止 | 全機能停止 | — |

ライブ映像・YOLO検出はRDK X5単体で動作し続ける。

---

## 6. 関連ドキュメント

- `vlm_integration_spec.md`: VLM行動解析連携の詳細仕様（API契約、データモデル、AX8850システム設計）
