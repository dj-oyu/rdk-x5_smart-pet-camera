# SPEC: Refactoring Plan

## 1. Web Asset Extraction

### Problem

`server/mod.rs` が 2700+ 行あり、うち ~1500 行がインライン HTML/CSS/JS テンプレート。

| Handler | Lines | 内容 |
|---------|-------|------|
| `handle_carousel_demo` | ~570 | HTML + CSS (~400行) + `<script>` タグ |
| `handle_esrgan_test` | ~150 | HTML + inline JS |
| `handle_websr_test` | ~340 | HTML + inline JS |

### Solution

テストページ HTML を `static/` に外出しし、`include_str!` で埋め込む（実行時 IO 不要）。

```
static/
  carousel.js       ← 既に外出し済み
  carousel.html     ← NEW: handle_carousel_demo の HTML/CSS
  esrgan.html       ← NEW: handle_esrgan_test の HTML
  websr.html        ← NEW: handle_websr_test の HTML
```

`format!()` でのテンプレート変数 (`{latest}`) は HTML の `data-*` 属性経由で渡す (carousel.js で実証済み)。

**期待効果**: server/mod.rs が ~1200 行に縮小。HTML/CSS に対する静的解析・フォーマッタが使える。

---

## 2. SQLite Optimization

### 2.1 Stats Query: 4回 → 1回

**現状** (`db/mod.rs:717-735`): 4つの `COUNT(*)` クエリを個別実行

```rust
let total: i64 = self.conn.query_row("SELECT COUNT(*) FROM photos", [], ...)?;
let valid: i64 = self.conn.query_row("SELECT COUNT(*) FROM photos WHERE is_valid = 1", [], ...)?;
let invalid: i64 = self.conn.query_row("SELECT COUNT(*) FROM photos WHERE is_valid = 0", [], ...)?;
let pending: i64 = self.conn.query_row("SELECT COUNT(*) FROM photos WHERE is_valid IS NULL", [], ...)?;
```

**改善**: 1クエリに統合

```sql
SELECT
  COUNT(*) as total,
  COUNT(CASE WHEN is_valid = 1 THEN 1 END) as valid,
  COUNT(CASE WHEN is_valid = 0 THEN 1 END) as invalid,
  COUNT(CASE WHEN is_valid IS NULL THEN 1 END) as pending
FROM photos
```

### 2.2 Prepared Statement Cache

**現状**: 毎リクエストで `conn.prepare()` を呼び出し → パース + コンパイルが毎回発生。

**改善**: `rusqlite::CachedStatement` を使用。

```rust
// Before
let mut stmt = self.conn.prepare("SELECT ... FROM photos WHERE ...")?;

// After
let mut stmt = self.conn.prepare_cached("SELECT ... FROM photos WHERE ...")?;
```

`prepare_cached` は内部 LRU キャッシュを持ち、同じ SQL 文字列なら再利用する。
**変更箇所**: `prepare()` を `prepare_cached()` に置換するだけ。全箇所一括。

### 2.3 動的 WHERE 句の最適化

**現状** (`db/mod.rs:564-612`): `format!()` + `Vec<Box<dyn ToSql>>` で動的構築。

```rust
let mut where_clauses = Vec::new();
let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
// ... push conditions
let where_sql = format!("WHERE {}", where_clauses.join(" AND "));
let count_sql = format!("SELECT COUNT(*) FROM {from_sql} {where_sql}");
```

問題:
- `Box<dyn ToSql>` はヒープアロケーション
- `format!()` で毎回 String を生成
- `prepare_cached` が効かない (SQL文字列が毎回変わる)

**改善案 A: クエリテンプレートパターン**

フィルタの組み合わせを列挙し、固定SQLを選択:

```rust
// 頻出パターンだけ pre-define
const LIST_BASE: &str = "SELECT ... FROM photos p WHERE 1=1";
const LIST_BY_PET: &str = "SELECT ... FROM photos p WHERE p.pet_id = ?1";
const LIST_BY_STATUS: &str = "SELECT ... FROM photos p WHERE p.is_valid = ?1";
const LIST_BY_PET_STATUS: &str = "SELECT ... FROM photos p WHERE p.pet_id = ?1 AND p.is_valid = ?2";
```

**改善案 B: 条件ブランチ + `prepare_cached`**

各条件をオプショナルにした固定クエリ:

```sql
SELECT ... FROM photos p
LEFT JOIN detections d ON ...
WHERE (?1 IS NULL OR p.is_valid = ?1)
  AND (?2 IS NULL OR p.pet_id = ?2)
  AND (?3 IS NULL OR p.caption LIKE '%' || ?3 || '%')
  AND (?4 IS NULL OR p.behavior = ?4)
```

1つの固定SQLで全パターンをカバー。`prepare_cached` が効く。
ただし SQLite のクエリプランナーは `?1 IS NULL OR ...` パターンでインデックスを使えない可能性がある。

**推奨**: 案 A (頻出パターン固定) をまず試し、カバレッジが足りなければ案 B。

### 2.4 Majority Vote の最適化

**現状** (`db/mod.rs:502-510`): detection update のたびに GROUP BY + ORDER BY クエリを実行。

**改善**: `photos` テーブルに `pet_id_candidate` カラムを追加し、detection 変更時にトリガーまたは明示的更新で計算結果をキャッシュ。
→ 読み取りは単純な SELECT、書き込みコストは変わらないが頻度は低い。

---

## 3. Clone Reduction

### 3.1 DB パラメータの clone

**現状** (`db/mod.rs:576,580,584,597`):

```rust
param_values.push(Box::new(pid.clone()));      // String clone
param_values.push(Box::new(search.clone()));   // String clone
param_values.push(Box::new(cls.clone()));      // String clone in loop
```

**改善**: `PhotoFilter` の所有権を move するか、`&str` 参照でパラメータを渡す。
`rusqlite::params![]` マクロは参照を受け取れるので `Box` 化不要。

### 3.2 Repository 層の String clone

**現状** (`repository.rs:86-88`): DB コマンド送信のたびに filename, pet_id を clone。

```rust
DbCommand::InsertPhoto {
    filename: source_filename.to_string(),  // &str → String
    pet_id: pet_id.map(str::to_string),     // &str → String
    reply,
}
```

**改善**: `DbCommand` のフィールドを `Cow<'_, str>` にする。
呼び出し元が所有権を持つ場合は move、参照の場合は borrow。

### 3.3 Event broadcast の clone

**現状** (`commands.rs:68`):

```rust
let _ = self.event_tx.send(event.clone());
```

**改善**: `Arc<PetEvent>` でラップし、send 時に Arc clone (ポインタコピーのみ)。

### 3.4 Server handler の Arc clone

**現状**: `state.context.clone()`, `state.photos_dir.clone()` 等は `Arc` clone なので低コスト。
→ **対応不要**。可読性のために現状維持。

---

## 4. Box / Heap Avoidance

### 4.1 `Vec<Box<dyn ToSql>>`

**現状** (`db/mod.rs:566`): フィルタパラメータを `Box<dyn ToSql>` で格納。

**改善**: `rusqlite::params![]` マクロまたは固定サイズ配列を使う。

```rust
// Before
let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
param_values.push(Box::new(pid.clone()));

// After (固定クエリパターンの場合)
let params = rusqlite::params![pid, is_valid, limit, offset];
```

### 4.2 `SharedEventRepository` trait object

**現状** (`repository.rs:58`):

```rust
pub type SharedEventRepository = Arc<dyn EventRepositoryPort>;
```

**判定**: アプリケーション境界のDI用。ホットパスではない。**対応不要**。

---

## Priority & Impact

| Item | Effort | Impact | Priority |
|------|--------|--------|----------|
| Stats 4→1 query | 小 | 小 (4 SELECTが1に) | P0 — すぐやる |
| `prepare` → `prepare_cached` | 小 | 中 (全クエリに効く) | P0 — 一括置換 |
| Web asset extraction | 中 | 中 (可読性・保守性) | P1 |
| 動的 WHERE 最適化 | 中 | 中 (キャッシュ効率) | P1 |
| Clone reduction (DB params) | 中 | 小 (マイクロ最適化) | P2 |
| Box<dyn ToSql> 排除 | 中 | 小 | P2 |
| Cow<str> 導入 | 大 | 小 | P3 — 型変更の波及大 |
