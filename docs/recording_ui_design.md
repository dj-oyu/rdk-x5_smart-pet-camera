# 録画UI実装計画

## 概要

録画一覧の表示・管理UIをWebインターフェースに追加する。
SQLite等のDBは使用せず、ファイルシステムベースの素朴な実装とする。

## 機能要件

### 必須機能
1. **録画一覧表示** - recordingsディレクトリ内のMP4ファイル一覧
2. **ダウンロード** - 各録画のダウンロードボタン
3. **削除** - 各録画の削除ボタン（確認ダイアログ付き）

### オプション機能（将来）
- サムネイル表示
- 動画プレビュー再生
- ストレージ使用量表示

## データ構造

### ファイルベースのメタデータ

```
recordings/
├── recording_20260204_143052.mp4   # ファイル名から日時を解析
├── recording_20260204_150823.mp4
└── recording_20260205_091245.mp4
```

**ファイル名フォーマット**: `recording_YYYYMMDD_HHMMSS.mp4`

### API レスポンス（既存）

```json
GET /api/recordings

{
  "recordings": [
    {
      "name": "recording_20260204_143052.mp4",
      "size_bytes": 47185920,
      "created_at": "2026-02-04T14:30:52+09:00"
    }
  ]
}
```

## UI設計

### レイアウト案

```
┌─────────────────────────────────────────────────────────────┐
│  録画一覧                                        [更新] [×] │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 📹 2026/02/04 14:30:52                                 │ │
│  │    45.0 MB                          [⬇ Download] [🗑]  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 📹 2026/02/04 15:08:23                                 │ │
│  │    128.5 MB                         [⬇ Download] [🗑]  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 📹 2026/02/05 09:12:45                                 │ │
│  │    32.1 MB                          [⬇ Download] [🗑]  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  合計: 3件 / 205.6 MB                                       │
└─────────────────────────────────────────────────────────────┘
```

### 表示位置

メイン画面の右側パネル（検出履歴の下）にタブまたはセクションとして追加。

```
┌─────────────────┬─────────────────────────────┐
│                 │  [History] [Ranking] [録画] │
│   Video         ├─────────────────────────────┤
│                 │                             │
│   [REC]         │   録画一覧 or 検出履歴      │
│                 │                             │
└─────────────────┴─────────────────────────────┘
```

## 実装計画

### Phase 1: 基本UI

**サーバー側**
- [x] `/api/recordings` - 一覧取得（実装済み）
- [x] `/api/recordings/{name}` GET - ダウンロード（実装済み）
- [x] `/api/recordings/{name}` DELETE - 削除（実装済み）

**フロントエンド**
- [ ] 録画一覧コンポーネント（HTML/CSS）
- [ ] 一覧取得・表示（JavaScript）
- [ ] ダウンロードボタン
- [ ] 削除ボタン（確認ダイアログ）
- [ ] ビュートグル追加（History/Ranking/Timeline/Recordings）

### Phase 2: UX改善

- [ ] 自動更新（録画停止後に一覧を更新）
- [ ] 削除時のアニメーション
- [ ] 空状態の表示（「録画がありません」）
- [ ] ストレージ使用量表示

## 実装詳細

### HTML構造

```html
<!-- 既存のview-toggleに追加 -->
<button type="button" data-view="recordings">録画</button>

<!-- 録画一覧パネル -->
<div id="recordings-list" class="recordings-list" style="display:none;">
  <!-- JSで動的生成 -->
</div>
```

### JavaScript実装

```javascript
// 録画一覧を取得して表示
async function fetchRecordings() {
    const res = await fetch('/api/recordings');
    const data = await res.json();
    renderRecordings(data.recordings);
}

// 録画カードをレンダリング
function renderRecordings(recordings) {
    if (!recordings || recordings.length === 0) {
        recordingsListEl.innerHTML = '<p class="muted">録画がありません</p>';
        return;
    }

    recordingsListEl.innerHTML = recordings.map(rec => {
        const date = parseRecordingDate(rec.name);
        const sizeMB = (rec.size_bytes / 1024 / 1024).toFixed(1);
        return `
            <div class="recording-card" data-name="${rec.name}">
                <div class="recording-info">
                    <div class="recording-date">${formatDate(date)}</div>
                    <div class="recording-size">${sizeMB} MB</div>
                </div>
                <div class="recording-actions">
                    <button class="btn-download" onclick="downloadRecording('${rec.name}')">
                        ⬇
                    </button>
                    <button class="btn-delete" onclick="deleteRecording('${rec.name}')">
                        🗑
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// ファイル名から日時を解析
function parseRecordingDate(filename) {
    // recording_20260204_143052.mp4 -> Date
    const match = filename.match(/recording_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (!match) return null;
    return new Date(match[1], match[2]-1, match[3], match[4], match[5], match[6]);
}

// ダウンロード
function downloadRecording(filename) {
    window.location.href = `/api/recordings/${encodeURIComponent(filename)}`;
}

// 削除
async function deleteRecording(filename) {
    if (!confirm(`「${filename}」を削除しますか？`)) return;

    const res = await fetch(`/api/recordings/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
    });

    if (res.ok) {
        fetchRecordings(); // 一覧を更新
    } else {
        alert('削除に失敗しました');
    }
}
```

### CSSスタイル

```css
.recordings-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.recording-card {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
}

.recording-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.recording-date {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
}

.recording-size {
    font-size: 12px;
    color: var(--text-muted);
}

.recording-actions {
    display: flex;
    gap: 8px;
}

.recording-actions button {
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s;
}

.btn-download {
    background: rgba(110, 231, 255, 0.15);
    color: #6ee7ff;
}

.btn-download:hover {
    background: rgba(110, 231, 255, 0.25);
}

.btn-delete {
    background: rgba(255, 92, 92, 0.15);
    color: #ff5c5c;
}

.btn-delete:hover {
    background: rgba(255, 92, 92, 0.25);
}
```

## 実装順序

1. **HTMLにrecordings-listとビュートグル追加**
2. **CSSスタイル追加**
3. **JavaScript: fetchRecordings, renderRecordings**
4. **JavaScript: downloadRecording, deleteRecording**
5. **ビュートグル連携（applyView拡張）**
6. **録画停止後の自動更新**

## 確認項目

- [ ] 録画一覧が正しく表示される
- [ ] ダウンロードが動作する
- [ ] 削除が動作する（確認ダイアログあり）
- [ ] 空の状態が適切に表示される
- [ ] モバイル表示で崩れない
