# Preact Signals — Design Philosophy & Migration Guide

> **対象読者**: このコードベースのフロントエンドをリファクタ/拡張する開発者
> **前提**: Preact 10.29+ / @preact/signals 2.8.2 / Bun bundler (IIFE format)

---

## Why Signals — なぜ useState を捨てたか

React/Preact の従来モデルは「状態が変わったら VDOM ツリーを上から再構築し、差分を DOM に適用する」。
このモデルには根本的な非効率がある:

```
useState("chatora")
  ↓ setState
App re-render → FilterBar re-render → EventGrid re-render → 100枚のカード re-render
  ↓ VDOM diff
実際に変わったのは1箇所のテキストだけ
```

**Signals は逆のアプローチ**を取る。状態の変更を「購読者」に直接通知し、その購読者だけが更新される。VDOM diff は不要。コンポーネントツリーの再構築も不要。

```
signal("chatora")
  ↓ .value = "mike"
購読している DOM テキストノードだけが "chatora" → "mike" に変わる
```

### 哲学: Push vs Pull

| | useState (Pull) | signal (Push) |
|---|---|---|
| 更新の伝搬 | setState → 親から子へ全再レンダー | .value 変更 → 購読者のみ更新 |
| 依存追跡 | 手動 (deps array) | 自動 (.value 読み取りで暗黙追跡) |
| バッチ更新 | 自動 (React 18+) | action() で明示的に宣言 |
| 派生値 | useMemo + deps array | computed() — deps 自動追跡 |
| 副作用 | useEffect + deps array | effect() — deps 自動追跡 |
| コンポーネント境界 | 状態は component に閉じる | signal はどこからでも読み書き可能 |

### これが意味すること

useState の世界では「誰がこの状態を持つか」「props で何階層渡すか」「useEffect の deps を正しく書けたか」が設計の大部分を占める。
Signals の世界では**状態の所在は問題にならない**。store.ts に signal を置いても、コンポーネント内に useSignal で置いても、JSX で `.value` を読めばそこだけが更新される。

**useEffect の deps array 地獄は終わった。**

---

## API チートシート

### Import パス

```typescript
// Core: signal, computed, effect, action, batch
// Preact integration: createModel, useModel, useSignal, useSignalEffect, useComputed
import { signal, computed, effect, action, createModel, useModel, useSignal, useSignalEffect } from "@preact/signals";

// Declarative utilities: Show, For
import { Show, For } from "@preact/signals/utils";

// MUST: side-effect import in entry point (main.tsx)
import "@preact/signals"; // Preact options hooks をインストール
```

### Primitive 一覧

| API | 用途 | スコープ |
|-----|------|---------|
| `signal(val)` | リアクティブ値 | module/store |
| `computed(() => ...)` | 派生値（自動追跡） | module/store |
| `effect(() => ...)` | 副作用（自動追跡、cleanup 対応） | module/store |
| `action(() => ...)` | バッチ更新（複数 signal を atomic に変更） | store |
| `batch(() => ...)` | 低レベルバッチ（action の内部実装） | anywhere |
| `createModel(() => ...)` | Store ファクトリ（singleton per component） | module |
| `useModel(Model)` | Store インスタンス取得 (component hook) | component |
| `useSignal(val)` | component-local signal (useMemo + signal) | component |
| `useSignalEffect(() => ...)` | component-scoped effect (unmount で dispose) | component |
| `useComputed(() => ...)` | component-scoped computed | component |
| `<Show when={sig}>` | 条件レンダー（親 re-render 不要） | JSX |
| `<For each={sig}>` | リストレンダー（アイテム単位更新） | JSX |

---

## 5つの典型パターン

### Pattern 1: Global Store — `createModel` + `useModel`

アプリ全体の状態を管理する。Redux/Zustand の代替。

```typescript
// store.ts
export const AppStore = createModel(() => {
  const query = signal<EventQuery>(defaultQuery);
  const events = signal<EventSummary[]>([]);
  const loading = signal(true);

  const subtitle = computed(() =>
    query.value.petId
      ? `${events.value.length} events for ${query.value.petId}`
      : `${events.value.length} events`
  );

  const loadData = action(async () => {
    loading.value = true;
    try {
      const result = await fetchEvents(query.value);
      events.value = result.events;
    } finally {
      loading.value = false;
    }
  });

  const updateQuery = action((patch: Partial<EventQuery>) => {
    query.value = { ...query.value, ...patch, offset: 0 };
  });

  // query 変更 → 自動 fetch
  effect(() => {
    query.value; // 依存を登録
    void loadData();
  });

  return { query, events, loading, subtitle, loadData, updateQuery };
});

// app.tsx
function App() {
  const store = useModel(AppStore);
  return (
    <div>
      <h1>{store.subtitle.value}</h1>
      <EventGrid events={store.events.value} loading={store.loading.value} />
    </div>
  );
}
```

**いつ使う**: アプリ全体で共有する状態 (ルーティング、認証、フィルター、一覧データ)
**いつ使わない**: モーダルの中だけで使う一時的な状態 → Pattern 2 or 3

---

### Pattern 2: Component-Local Signal — `useSignal` + `useSignalEffect`

コンポーネント内で完結する状態。useState + useEffect の直接置換。

```typescript
function DailySummary() {
  const date = useSignal(todayString());
  const data = useSignal<Response | null>(null);
  const loading = useSignal(false);

  useSignalEffect(() => {
    // date.value を読むだけで暗黙の依存が登録される
    loading.value = true;
    let cancelled = false;
    fetchSummary(date.value)
      .then(r => { if (!cancelled) data.value = r; })
      .finally(() => { if (!cancelled) loading.value = false; });
    return () => { cancelled = true; }; // cleanup
  });

  return (
    <div>
      <input value={date.value} onChange={e => { date.value = e.target.value; }} />
      {loading.value ? <span>Loading...</span> : null}
      {data.value && <pre>{JSON.stringify(data.value)}</pre>}
    </div>
  );
}
```

**useEffect との違い**: deps array が不要。signal の `.value` を読んだ時点で自動追跡される。

---

### Pattern 3: Per-Instance Factory Store

モーダルのように「開くたびに新しいインスタンスが必要」な場合。
createModel は singleton なのでここでは使わない。

```typescript
// detail-store.ts
export function createDetailStore(event: EventSummary) {
  const detections = signal<Detection[]>([]);
  const viewMode = signal<"comic" | "panel">("comic");
  const activePanel = signal(0);

  const visibleDets = computed(() =>
    viewMode.value === "comic"
      ? detections.value
      : detections.value.filter(d => d.panel_index === activePanel.value)
  );

  // 初回 fetch
  fetchDetections(event.id).then(d => { detections.value = d; });

  function dispose() { /* cleanup */ }

  return { detections, viewMode, activePanel, visibleDets, dispose };
}

// event-detail.tsx
function EventDetail({ event }: Props) {
  const store = useMemo(() => createDetailStore(event), [event.id]);
  useEffect(() => () => store.dispose(), [store]);
  // ...
}
```

**重要**: `useMemo` で event.id ごとに1回だけ作成。`useEffect` cleanup で dispose。

---

### Pattern 4: `<Show>` — 条件レンダー

`{signal.value && <Component />}` の上位互換。親コンポーネントの re-render なしで条件分岐。

```typescript
// Before (auto-subscribe: 親が毎回 re-render)
{store.selectedEvent.value && (
  <EventDetail event={store.selectedEvent.value} onClose={store.closeModal} />
)}

// After (Show: 親 re-render 不要、children だけ更新)
<Show when={store.selectedEvent}>
  {(ev) => <EventDetail event={ev} onClose={store.closeModal} />}
</Show>
```

**Show の children は関数**: `(unwrappedValue) => JSX` を受け取る。signal の `.value` を自分で読む必要がない。

---

### Pattern 5: `useSignalEffect` + `useEffect` の使い分け

**signal 変更 → DOM 操作** なら `useSignalEffect`:

```typescript
// signal の viewMode/comicImage が変わったら canvas を再描画
useSignalEffect(() => {
  if (s.viewMode.value !== "panel" || !s.comicImage.value) return;
  const img = s.comicImage.value;
  for (let i = 0; i < 4; i++) {
    const canvas = canvasRefs.current[i];
    if (!canvas) continue;
    canvas.getContext("2d")?.drawImage(img, ...);
  }
});
```

**DOM イベントリスナーの setup/teardown** なら `useEffect`:

```typescript
// keyboard handler: signal は handler 内で .value で読む
useEffect(() => {
  function handleKey(e: KeyboardEvent) {
    if (s.zoomedDetId.value !== null) { resetZoom(); }
    // ...
  }
  window.addEventListener("keydown", handleKey);
  return () => window.removeEventListener("keydown", handleKey);
}, []);
```

**判断基準**:

| | useSignalEffect | useEffect |
|---|---|---|
| signal 変更がトリガー | YES | NO |
| deps array | 不要（自動追跡） | 必要 |
| DOM ref 操作 | OK (canvasRef etc.) | OK |
| addEventListener | 避ける (毎回再登録される) | 推奨 |
| 初回のみ実行 | 不向き | `useEffect(fn, [])` |

---

## やってはいけないこと

### 1. signal を不必要に signal にしない

```typescript
// BAD: 定数配列を signal にする意味がない
const STATUS_OPTIONS = signal(["all", "valid", "pending", "rejected"]);

// GOOD: 定数はそのまま
const STATUS_OPTIONS = ["all", "valid", "pending", "rejected"];
```

### 2. useSignalEffect で addEventListener しない

```typescript
// BAD: signal 変更のたびにリスナーが再登録される
useSignalEffect(() => {
  const handler = () => { console.log(count.value); };
  window.addEventListener("click", handler);
  return () => window.removeEventListener("click", handler);
});

// GOOD: useEffect で1回だけ登録、handler 内で .value を読む
useEffect(() => {
  const handler = () => { console.log(count.value); };
  window.addEventListener("click", handler);
  return () => window.removeEventListener("click", handler);
}, []);
```

### 3. 巨大バイナリデータを signal に入れない

```typescript
// BAD: ImageData (数MB) を signal に入れると diff コストが高い
const cachedPixels = signal<ImageData | null>(null);

// GOOD: plain object でキャッシュし、signal は状態フラグだけ
const upscaleCache: Record<string, ImageData> = {};
const upscaleState = signal<Record<number, "fast" | "hd">>({});
```

### 4. effect 内で import を忘れない

```typescript
// BAD: effect が @preact/signals から import されていない
//      → ReferenceError: effect is not defined (実体験)
import { signal, computed } from "@preact/signals";
effect(() => { /* ... */ }); // 💥 ReferenceError

// GOOD: 使う API は全て明示的に import
import { signal, computed, effect } from "@preact/signals";
```

---

## このコードベースの Signal アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  main.tsx                                   │
│  import "@preact/signals"  ← side-effect    │
│  import "preact/debug"     ← DevTools       │
│  render(<App />)                            │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  App (useModel)                             │
│  ┌──────────────────────┐                   │
│  │ AppStore (createModel)│                  │
│  │  signal: query, events, selectedEvent... │
│  │  computed: subtitle                      │
│  │  action: loadData, openModal, closeModal │
│  │  effect: query→fetch, popstate           │
│  └──────────────────────┘                   │
│                                             │
│  <Show when={selectedEvent}>                │
│    └→ EventDetail (useMemo + factory store) │
│       ┌────────────────────────┐            │
│       │ DetailStore (factory)  │            │
│       │  signal: viewMode, activePanel,     │
│       │          detections, upscaleState   │
│       │  computed: visibleDets, activeDetId │
│       │  effect: auto-detect timer          │
│       │  plain: upscaleCache (ImageData)    │
│       └────────────────────────┘            │
│       useSignalEffect → canvas draw        │
│       useEffect → keyboard, drag, scroll   │
│                                             │
│  EventGrid (props-based, useSignal for fade)│
│  FilterBar (pure props)                     │
│  StatsStrip (pure props)                    │
│  Pagination (pure props)                    │
│  DailySummary (useSignal + useSignalEffect) │
│  BackfillButton (useSignal + useRef poll)   │
└─────────────────────────────────────────────┘
```

---

## 移行チェックリスト

既存コンポーネントを Signals に移行する際のガイド:

- [ ] `useState` → 状態の性質で判断:
  - グローバル共有 → `createModel` + `signal`
  - コンポーネントローカル → `useSignal`
  - DOM 計測値 (ResizeObserver 等) → `useState` のまま
- [ ] `useEffect(fn, [dep1, dep2])` → deps が全て signal なら `useSignalEffect`
- [ ] `useEffect(fn, [])` (mount-only) → addEventListener 等は `useEffect` のまま
- [ ] `useMemo` → signal 依存なら `computed` or `useComputed`
- [ ] `{condition && <Component />}` → `<Show when={signal}>`
- [ ] `array.map(item => <Item />)` → signal 配列なら `<For each={signal}>`、定数配列ならそのまま
- [ ] `useCallback` → action() で十分。signal 経由の呼び出しなら不要

---

## 検証の歴史

このガイドの内容は `/test/signals` テストベンチで実機検証済み:

- Auto-subscribe: Bun IIFE bundler で正常動作
- Show/For: `@preact/signals/utils` から import、全パターン動作確認
- createModel + useModel: singleton lifecycle、action batching 正常
- `preact/debug`: DevTools 連携、レンダーエラー可視化

### 発見された落とし穴

1. **`effect` の import 漏れ** — `signal` と `computed` だけ import して `effect` を忘れると `ReferenceError`。TypeScript の型チェックでは検出できない場合がある（グローバルスコープに同名の関数が存在すると）
2. **`preact/debug` は最初に import** — 他の preact import より前に置く必要がある
3. **Show/For は `@preact/signals/utils`** — `@preact/signals` 本体には含まれない
