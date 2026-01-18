# 日報 2025-12-28

## 作業サマリ

web_monitorのCPU使用率を大幅に削減（116% → 約10%想定）。セマフォベースのfanout機構とNV12直接描画により、RGBA変換を完全に削除し、キャッシュライン効率を最大化。MJPEGオーバーレイの視認性も大幅に改善。

## 完了した作業

### 1. camera_switcher_daemonのCPU最適化（セマフォベース化）
**問題**: camera_switcher_daemonが84.2% CPUを使用（10msポーリング）

**原因**: active_thread_mainが`usleep(10000)`で新フレームをポーリング

**解決**:
- SharedFrameBufferに`sem_t new_frame_sem`を追加
- `shm_frame_buffer_write()`で`sem_post()`を呼び出し
- active_thread_mainで`sem_wait()`によるイベント駆動化
- カウントダウン機構でDAY時のみ明度チェック（NIGHT時はスキップ）
  - `if (frames_until_check + rt->active_camera <= 0)` で自動判定
  - DAY: 3フレームごとにチェック（67%スキップ）
  - NIGHT: 常にスキップ（100%スキップ）

**変更ファイル**:
- `src/capture/shared_memory.h` (セマフォフィールド追加)
- `src/capture/shared_memory.c` (`sem_init()`, `sem_post()`, `sem_destroy()`追加)
- `src/capture/camera_switcher_runtime.h` (`wait_for_new_frame`コールバック追加)
- `src/capture/camera_switcher_runtime.c` (active_thread_mainをセマフォ+カウントダウン化)
- `src/capture/camera_switcher_daemon.c` (`wait_for_new_frame_cb()`実装)

**結果**:
- CPU使用率: 84.2% → **3.8%**
- フレームスキップ率: 66.7%（DAY時）、100%（NIGHT時）

### 2. 共有メモリ構造の同期（C/Python/Go）
**問題**: SharedFrameBufferにセマフォ追加により、Python/Goの構造体定義がずれる

**解決**: すべての言語で32バイトのセマフォフィールドを追加
- Python: `src/capture/real_shared_memory.py`
  - `CSharedFrameBuffer`に`("new_frame_sem", c_uint8 * 32)`追加
  - フレームオフセット計算に`+ 32`追加
- Go: `src/streaming_server/internal/shm/reader.go`
  - SharedFrameBufferに`uint8_t new_frame_sem[32]`追加
- Go: `src/streaming_server/internal/webmonitor/shm.go`
  - SharedFrameBufferに`uint8_t new_frame_sem[32]`追加

**変更ファイル**:
- `src/capture/real_shared_memory.py`
- `src/streaming_server/internal/shm/reader.go`
- `src/streaming_server/internal/webmonitor/shm.go`

### 3. web_monitorのCPU最適化（Channel-based Fanout）
**問題**: web_monitorが116% CPUを使用（33msポーリング + RGBA変換）

**解決**:
- **FrameBroadcaster実装** (`broadcaster.go`):
  - セマフォで新フレーム待機（`sem_timedwait`、1秒タイムアウト）
  - クライアント数0の時は変換スキップ
  - NV12→JPEG変換を1回だけ実行し、全クライアントにfanout
  - Channelベースのpub-subパターン

- **共有メモリをRDWRでマップ**:
  - `sem_wait()`には書き込み権限が必要
  - `O_RDONLY` → `O_RDWR`, `PROT_READ` → `PROT_READ | PROT_WRITE`

- **monitor.goのクリーンアップ**:
  - キャッシュ機構削除（`lastJPEGFrameNum`, `lastOverlayData`など）
  - `LatestJPEG()`, `LatestJPEGWithOverlay()`削除
  - broadcaster前提の軽量実装

**変更ファイル**:
- `src/streaming_server/internal/webmonitor/broadcaster.go` (新規)
- `src/streaming_server/internal/webmonitor/shm.go` (WaitNewFrame追加、O_RDWR化)
- `src/streaming_server/internal/webmonitor/monitor.go` (大幅削減)
- `src/streaming_server/internal/webmonitor/server.go` (broadcaster統合)
- `src/streaming_server/internal/webmonitor/stream.go` (`streamMJPEGFromChannel`追加)

### 4. NV12直接描画によるRGBA変換削除
**問題**: 毎フレームNV12→RGBA→JPEGの変換で高CPU使用率

**解決**:
- **C関数実装** (`shm.go`):
  - `draw_text_nv12()`: ビットマップフォントでY平面に直接描画
  - `draw_filled_rect_nv12()`: 塗りつぶし矩形（テキスト背景用）
  - `draw_rect_nv12()`: Y平面のみの矩形描画
  - `draw_rect_nv12_color()`: Y+UV平面の**カラー矩形描画**（緑色用）

- **キャッシュライン効率化**:
  - すべての描画関数で外側ループをy方向、内側ループをx方向
  - 行ポインタ（`row_ptr`）使用で連続メモリアクセス
  - ストライドアクセス最小化

- **処理フロー**:
  ```
  Before: NV12 → RGBA変換 → 矩形描画 → JPEG圧縮
  After:  NV12 + 直接描画 → JPEG圧縮
  ```

**変更ファイル**:
- `src/streaming_server/internal/webmonitor/shm.go` (C描画関数追加)
- `src/streaming_server/internal/webmonitor/broadcaster.go` (NV12直接描画使用)

**削減された処理**:
- ✅ RGBA変換削除（640×480×3/2 → 640×480×4の変換不要）
- ✅ Go側オーバーレイ削除（RGBA操作不要）
- ✅ RGBAバッファ削減（メモリ節約）

### 5. MJPEGオーバーレイの視認性改善
**問題**: オーバーレイが見づらい（緑色が暗い、テキストが背景に溶け込む）

**解決**:
- **テキストに黒背景追加**:
  - `drawTextWithBackgroundNV12()`: 黒背景(Y=16) + 白文字(Y=255)
  - パディング4ピクセル

- **緑色バウンディングボックス**:
  - YUV(200, 44, 21)で鮮やかな緑
  - Y平面とUV平面両方に描画
  - 太さ3ピクセル

- **フォント修正**:
  - 'm'の正しいビットマップ追加（真っ黒だった問題解決）
  - 'r'の正しいビットマップ修正（mのように見えた問題解決）
  - 'o', 'p', 'b', 'c', 'd'などを追加

**変更ファイル**:
- `src/streaming_server/internal/webmonitor/shm.go` (フォント修正、カラー描画追加)
- `src/streaming_server/internal/webmonitor/broadcaster.go` (配色変更)

**結果**:
- ✅ 統計情報: 白文字 on 黒背景で常に見やすい
- ✅ バウンディングボックス: 鮮やかな緑色で目立つ
- ✅ 信頼度ラベル: 明るい文字 on 黒背景
- ✅ フォント: すべての文字が正しく表示

## パフォーマンス結果

### CPU使用率の変化
| プロセス | Before | After |
|---------|--------|-------|
| camera_switcher_daemon | 84.2% | **3.8%** |
| web_monitor | 116% | **~10%想定** |

### 最適化の内訳
1. **セマフォベース化**: ポーリング削除でCPUほぼ0%待機
2. **カウントダウン機構**: 67-100%のフレームスキップ
3. **Fanout機構**: クライアント数に関わらず1回だけ変換
4. **NV12直接描画**: RGBA変換削除
5. **キャッシュライン効率**: 連続メモリアクセスでキャッシュヒット率向上

## 技術的詳細

### セマフォベースイベント駆動アーキテクチャ
```c
// Writer (camera_daemon)
shm_frame_buffer_write(shm, frame);
  ↓ フレーム書き込み
  ↓ sem_post(&shm->new_frame_sem);  // 通知

// Reader (camera_switcher, web_monitor)
sem_wait(&shm->new_frame_sem);  // ブロック（CPU 0%）
  ↓ 新フレーム到着
  ↓ 処理実行
```

### Channel-based Fanout
```go
// FrameBroadcaster
for {
  sem_wait()  // 新フレーム待機
  if clients == 0 { continue }
  jpeg := generateOverlay()  // 1回だけ変換
  broadcast(jpeg)  // 全クライアントに配信
}

// Client
id, ch := Subscribe()
for jpeg := range ch {
  send(jpeg)  // 変換済みJPEGを送信
}
```

### NV12直接描画の色空間
```c
// Green YUV values
Y = 200  // 輝度（明るさ）
U = 44   // 青-黄の色差（黄寄り）
V = 21   // 赤-緑の色差（緑寄り）
→ 鮮やかな緑色
```

## 次のステップ

1. **実測CPU使用率の確認**: web_monitorの実際のCPU使用率を測定
2. **複数クライアント負荷テスト**: Fanout機構のスケーラビリティ確認
3. **レイテンシ測定**: セマフォベースでのフレーム配信遅延確認
