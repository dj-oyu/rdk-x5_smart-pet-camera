# Share Link & Deep Navigation Spec

## Overview

写真やパネルへの直接リンクを可能にし、Tailscale共有相手やブラウザ履歴からの再アクセスを実現する。
History API を使い、全てのビューが `/app` 配下のパスで表現される。

## URL Structure

```
/app                                 → グリッド表示
/app/photo/{id}                      → グリッド + モーダル (コミックビュー)
/app/photo/{id}/panel/{n}            → グリッド + モーダル + パネルn表示
```

- `{id}` = `photos` テーブルの primary key (`EventSummary.id`)
- `{n}` = パネルインデックス (0-3)
- 既存のフィルタクエリパラメータ (`?pet_id=mike&is_valid=true` 等) はパスと独立して機能する

### URL Examples

```
https://ai-pyramid:8082/app/photo/42              コミック全体のモーダル
https://ai-pyramid:8082/app/photo/42/panel/2      パネル2を表示した状態
https://ai-pyramid:8082/app/photo/42?pet_id=mike  モーダル + フィルタ維持
```

## Why Path Segments (Not Query Params)

- クエリパラメータはプロキシ・SNS・チャットアプリのサニタイザで消えることがある
- 既存のフィルタ系クエリ (`?is_valid`, `?pet_id`) と共有リンクの引数が混在すると意味が曖昧になる
- パスセグメントは恒久的で、リダイレクトやキャッシュルールでも保持される

## Browser History Behavior

### pushState / replaceState Strategy

| 操作 | History API | 理由 |
|------|------------|------|
| モーダルを開く | `pushState` | 戻るで閉じられるように |
| モーダルを閉じる | `pushState` → `/app?...` | 進むで再度開けるように |
| パネルスワイプ / ナビ | `replaceState` | 履歴が溢れないように |
| フィルタ変更 | `pushState` (既存動作) | — |

### Back / Forward Flow

```
操作                          URL                            履歴
────────────────────────────────────────────────────────────────
1. アプリ開く                 /app                           [/app]
2. フィルタ変更               /app?pet_id=mike               [/app, /app?pet_id=mike]
3. 写真クリック               /app/photo/42?pet_id=mike      [..., /app/photo/42?pet_id=mike]
4. モーダル閉じる             /app?pet_id=mike               [..., /app?pet_id=mike]

戻る: 4→3 モーダル再オープン / 3→2 モーダル閉じる / 2→1 フィルタ解除
進む: 逆順で再現
```

パネル遷移は `replaceState` のため、戻るボタン1回で「モーダル閉→グリッド」に一発で戻る。

## Server Changes

### axum Router

`/app` 配下のパスを全てSPA HTMLで返す catch-all ルートを追加:

```rust
// 既存
.route("/app", get(handle_spa))
// 追加: /app/* を同じハンドラで処理
.route("/app/{*path}", get(handle_spa))
```

SPA側でパスをパースしてルーティングする。サーバーは常に同じHTMLを返す。

## Client Changes (ui/src/)

### 1. URL Parser (lib/api.ts or new lib/router.ts)

```typescript
type DeepLink = {
  photoId: number | null;
  panelIndex: number | null;
};

function parseDeepLink(pathname: string): DeepLink {
  // /app/photo/42/panel/2 → { photoId: 42, panelIndex: 2 }
  // /app/photo/42          → { photoId: 42, panelIndex: null }
  // /app                   → { photoId: null, panelIndex: null }
  const m = pathname.match(/^\/app\/photo\/(\d+)(?:\/panel\/([0-3]))?$/);
  if (!m) return { photoId: null, panelIndex: null };
  return {
    photoId: parseInt(m[1], 10),
    panelIndex: m[2] != null ? parseInt(m[2], 10) : null,
  };
}
```

### 2. App Init (app.tsx)

初回マウント時にディープリンクをチェック:

```typescript
useEffect(() => {
  const { photoId, panelIndex } = parseDeepLink(location.pathname);
  if (photoId) {
    // photoId から EventSummary を取得する API が必要
    // → GET /api/photos/{id} を新設 or events リストから探す
    fetchEventById(photoId).then(event => {
      if (event) setSelectedEvent(event);
      // panelIndex は EventDetail に prop で渡す
    });
  }
}, []);
```

### 3. History Sync (app.tsx)

```typescript
// モーダル開閉時
function openModal(event: EventSummary) {
  setSelectedEvent(event);
  history.pushState(null, "", `/app/photo/${event.id}${location.search}`);
}

function closeModal() {
  setSelectedEvent(null);
  history.pushState(null, "", `/app${location.search}`);
}

// popstate (戻る/進む) リスナー
useEffect(() => {
  const onPop = () => {
    const { photoId } = parseDeepLink(location.pathname);
    if (photoId && !selectedEvent) {
      fetchEventById(photoId).then(e => e && setSelectedEvent(e));
    } else if (!photoId && selectedEvent) {
      setSelectedEvent(null);
    }
  };
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}, [selectedEvent]);
```

### 4. Panel Navigation (event-detail.tsx)

パネル表示が変わったら `replaceState`:

```typescript
function onPanelChange(panelIndex: number) {
  history.replaceState(null, "", `/app/photo/${event.id}/panel/${panelIndex}${location.search}`);
}
```

### 5. Share Button

モーダル内に共有ボタンを配置。URL バーの値をそのままコピー:

```typescript
async function handleShare() {
  await navigator.clipboard.writeText(location.href);
  // Toast: "Link copied"
}
```

## API Changes

### New Endpoint: GET /api/photos/{id}

ディープリンクから直接 photo を開くために、ID で単一の `EventSummary` を取得するエンドポイントが必要:

```rust
// GET /api/photos/{id} → EventSummary (JSON)
async fn handle_get_photo_by_id(
    Path(id): Path<i64>,
    State(state): State<AppState>,
) -> Result<Json<EventSummary>, StatusCode> {
    // db_thread 経由で photos テーブルから取得
}
```

既存の `GET /api/photos/{filename}` (JPEG画像を返す) とはパスが異なる (`{id}` は数値、`{filename}` は `.jpg` 等を含む文字列) ので競合しない。

## Implementation Order

1. Server: `/app/{*path}` catch-all route
2. Server: `GET /api/photos/{id}` endpoint
3. Client: `parseDeepLink()` + `fetchEventById()`
4. Client: `openModal` / `closeModal` で `pushState`
5. Client: `popstate` listener
6. Client: panel navigation で `replaceState`
7. Client: Share button + clipboard copy
8. Test: ブラウザ直接アクセス・戻る/進む・コピー&ペースト
