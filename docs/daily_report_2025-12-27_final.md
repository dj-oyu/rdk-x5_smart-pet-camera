# 日報 2025-12-27（最終）

## 本日の成果サマリ

camera_daemon_drobotics.cを完全リファクタリングし、H.264ストリーム出力と独立したデコードスレッドによるNV12生成を実装しました。

## 完了した実装

### 1. MIPIホスト明示指定
**問題**: sp_open_camera_v2()のvideo_index=-1（自動選択）により、複数カメラデーモンが同じMIPIホストを開こうとしてエラー

~~解決~~:
この環境変数は、以前に断念したライブラリの改造で追加したものであり
**実際のAPIにはこのようなオプションはない**

```c
// Camera 0 → MIPI Host 0, Camera 1 → MIPI Host 2
int video_index = (ctx->camera_index == 0) ? SP_HOST_0 : SP_HOST_2;
const char *vcon_value = (ctx->camera_index == 0) ? "0" : "2";
setenv("VP_PRIORITY_VCON", vcon_value, 1);

sp_open_camera_v2(ctx->vio_object, ctx->camera_index, video_index, 1,
                  &parms, &ctx->out_width, &ctx->out_height);
```

### 2. デコードスレッド実装

**アーキテクチャ**:
```
camera_daemon (C)
├─ メインスレッド: VIO → Encoder → H.264 → SHM_STREAM (30fps目標)
└─ デコードスレッド: SHM_STREAM → Decoder → NV12 → SHM_FRAMES (頻度可変)
```

**実装ファイル**: `src/capture/camera_daemon_drobotics.c`
- **行60-77**: camera_context_tにdecoder関連フィールド追加
- **行257**: 前方宣言追加
- **行423-510**: decoder_thread_func()実装
- **行308-335**: setup_pipeline()でデコーダー初期化とスレッド起動
- **行357-370**: cleanup_pipeline()でスレッド停止とデコーダー解放
- **行147-156**: デコード頻度の環境変数読み取り

**環境変数**:
- `DECODE_INTERVAL_MS`: デコードサンプリング間隔（デフォルト: 1000ms）
  - 明度計算用途: 1000ms（1秒に1回で十分）
  - YOLO検出用途: 0ms（最大速度）

**特徴**:
- ✅ メインスレッドはブロッキングなしで30fps達成可能
- ✅ デコードスレッドは独立動作、頻度制御可能
- ✅ camera_switcherのコードは1行も変更不要（NV12を期待通り受信）
- ✅ YOLOもNV12を既存のまま使える

### 3. ビルド結果

```bash
gcc camera_daemon_drobotics.o shared_memory.o -lspcdev -lpthread ...
# ✅ 成功
```

## アーキテクチャ詳細

### 処理フロー

```
┌──────────────────────────────────────────────────────┐
│ camera_daemon (C) - メインスレッド                    │
│ VIO → Encoder → H.264 → SHM_STREAM                   │
│   (ゼロコピーバインド、30fps目標)                      │
└────────────┬─────────────────────────────────────────┘
             ↓ H.264リングバッファ
      /pet_camera_stream
             ↓
┌──────────────────────────────────────────────────────┐
│ camera_daemon (C) - デコードスレッド                  │
│ H.264 → sp_decoder → NV12 → SHM_FRAMES               │
│   (サンプリング頻度: DECODE_INTERVAL_MS)              │
└────────────┬─────────────────────────────────────────┘
             ↓ NV12リングバッファ
      /pet_camera_frames
             ↓
┌──────────────────────────────────────────────────────┐
│ camera_switcher (C) - 既存のまま                      │
│ frame_calculate_mean_luma() でY平面から明度計算       │
└──────────────────────────────────────────────────────┘
             ↓
┌──────────────────────────────────────────────────────┐
│ yolo_detector (Python) - 既存のまま                   │
│ detect() でNV12から物体検出                           │
└──────────────────────────────────────────────────────┘
```

### パフォーマンス期待値

| 処理 | FPS | 備考 |
|------|-----|------|
| **H.264エンコード** | 30fps | ゼロコピーバインド使用 |
| **NV12デコード** | 1fps（デフォルト） | camera_switcher用、可変 |
| **YOLO検出** | 可変 | DECODE_INTERVAL_MS=0で最大速度 |

## 技術的判断

### ✅ 採用した方式：デコードスレッド分離

**理由**:
1. メインスレッドがブロッキングされない
2. camera_switcherの実装を変更不要（ユーザー要望）
3. デコード頻度を用途別に最適化可能
4. C側で完結、Pythonオーバーヘッドなし

### ❌ 却下した方式

1. **Low-level API (hbn_*)**
   - 複雑すぎる（986行）
   - sp_encoder_set_frame()がブロッキング（8.4fps）

2. **バインディングなし**
   - sp_vio_get_frame() + sp_encoder_set_frame()
   - パフォーマンスが悪い

3. **Pythonデコーダーサービス**
   - プロセス間通信のオーバーヘッド
   - ユーザーが「C側で」と要望

## 残課題

### 次のステップ
1. ⏳ 実機テストでH.264が30fps出ているか確認
2. ⏳ デコードスレッドが正常動作するか確認（sp_decoderの使い方検証）
3. ⏳ プロファイラーで測定
4. ⏳ YOLO検出の動作確認
5. ⏳ 複数カメラ同時起動テスト

### 潜在的問題

**sp_start_decode()の引数**:
```c
sp_start_decode(decoder, NULL, 0, SP_ENCODER_H264, width, height);
```
- 第1引数をNULLにしてメモリベースデコード可能か要確認
- サンプルコード（decoder2display.c）はファイルパスを渡していた
- もしNULLが不可なら、sp_decoder_set_image()のみで動作するか検証が必要

## コード変更サマリ

### 変更ファイル
- `src/capture/camera_daemon_drobotics.c`:
  - 構造体拡張（decoder関連フィールド）
  - デコードスレッド実装（87行）
  - MIPIホスト明示指定
  - 環境変数対応（DECODE_INTERVAL_MS）

### 変更なし
- `src/capture/camera_switcher.c`: 既存のまま
- `src/common/src/detection/yolo_detector.py`: 既存のまま
- `src/capture/shared_memory.h`: 既存のまま

## 学び

### D-Robotics APIの制約
1. **sp_module_bind()の占有性**
   - バインド後はsp_vio_get_frame()が失敗する
   - VIOの出力がEncoderに占有される
   - NV12が必要な場合は別の方法が必要

2. **デコーダーAPI**
   - sp_decoder_set_image(): メモリからH.264を入力
   - sp_decoder_get_image(): デコード済みNV12を取得
   - メモリベースデコードが可能（要検証）

### 設計判断
- **スレッド分離**: ブロッキング回避とパフォーマンス最適化
- **頻度可変**: 用途別最適化（明度計算1fps vs YOLO最大速度）
- **既存コード保持**: camera_switcherの実装を尊重

## 次回作業

1. sp_start_decode(NULL, ...)が動作するか確認
2. 動作しない場合、代替案検討：
   - ダミーファイルパス使用
   - sp_decoder_set_image()のみで動作可能か確認
   - 最悪、Pythonデコーダーサービスに戻す
3. 30fps達成の確認
4. システム統合テスト

## 作業時間
約3時間（設計・実装・ビルド）

---

**実装ステータス**: ✅ ビルド成功、⏳ 動作確認待ち
