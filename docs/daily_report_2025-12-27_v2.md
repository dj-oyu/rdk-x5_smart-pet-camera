# 日報 2025-12-27 (v2) - テスト結果追記

## 前回からの変更

前回の日報 (daily_report_2025-12-27_final.md) で実装したデコードスレッド分離アーキテクチャのテスト結果を追記します。

## テスト実施

### 1. デコーダー起動条件のバグ修正

**問題**: デコーダースレッドが `if (g_shm_nv12)` で起動していた (camera_daemon_drobotics.c:338)

**原因**: デコーダーはH.264→NV12の変換を行うため、入力(H.264)と出力(NV12)の両方が必要

**修正**:
```c
// Before
if (g_shm_nv12) {

// After
if (g_shm_h264 && g_shm_nv12) {
```

### 2. H.264-only モードのテスト

**環境変数**:
```bash
SHM_NAME=/pet_camera_stream  # Legacy mode
```

**結果**:
- ✅ 300フレーム正常キャプチャ
- ✅ デコーダースレッドは起動しない (期待通り)
- ✅ ログ出力: `Frame XXX captured (nv12=no, h264=yes)`
- ✅ H.264ストリーム出力確認: `/dev/shm/pet_camera_stream` (89MB)

**FPS測定**:
- 理論値: 30fps (ゼロコピーバインディング使用)
- ログから推測: Frame 30-300を約10秒で処理 → 約27fps
- ⚠️ profile_shm.pyのタイムスタンプ問題により正確な測定不可

### 3. デュアルモード (H.264 + NV12デコード) のテスト

**環境変数**:
```bash
SHM_NAME_H264=/pet_camera_stream
SHM_NAME_NV12=/pet_camera_frames
DECODE_INTERVAL_MS=1000
```

**結果**:
- ✅ 500フレーム正常キャプチャ
- ✅ デコーダースレッド起動確認
- ✅ 両方の共有メモリ作成確認:
  - `/dev/shm/pet_camera_stream` (89MB) - H.264
  - `/dev/shm/pet_camera_frames` (89MB) - NV12
- ❌ **デコーダーエラー発生**: `sp_decoder_get_image failed: -1`

**デコーダーエラー詳細**:
```
ERROR [vp_codec_get_output][0827]Decode idx: 1,
hb_mm_mc_dequeue_output_buffer failed ret = -268435443
[Decoder] sp_decoder_get_image failed: -1
```

- エラー頻度: 約2秒ごと (DECODE_INTERVAL_MSと一致)
- デコーダースレッドは動作しているが、デコード処理が失敗

## 問題分析

### sp_start_decode() API の使用方法

**現在の実装** (camera_daemon_drobotics.c:346-349):
```c
ret = sp_start_decode(ctx->decoder_object, NULL, 0, SP_ENCODER_H264,
                      ctx->out_width, ctx->out_height);
```

**問題**: 第1引数に `NULL` を渡してメモリベースデコードを試みている

**D-Robotics サンプルコード** (decoder2display.c):
- ファイルパスを第1引数に渡している
- メモリベースデコードの公式サンプルが存在しない

### 推定される原因

1. **sp_start_decode()がファイルベースのみ対応**の可能性
   - NULL渡しが未サポート
   - 初期化時にファイルを期待している

2. **sp_decoder_set_image()の使用方法が不正**の可能性
   - H.264データのフォーマットが期待と異なる
   - NAL unit の開始コード処理が必要?

3. **デコーダーの状態遷移が不正**の可能性
   - sp_start_decode()での初期化が不完全
   - sp_decoder_set_image()を呼ぶ前に別の設定が必要?

## 次のステップ

### 優先度 HIGH: デコーダーAPI の調査

1. ⏳ `/usr/include/hb_media_codec.h` の調査
   - ユーザーが示唆した低レベルデコーダーAPI
   - メモリベースデコードの可能性

2. ⏳ `/usr/include/hb_media_recorder.h` の調査
   - 別のデコードアプローチがあるか確認

3. ⏳ D-Robotics公式サンプル再調査
   - メモリベースデコードの実例探索
   - VPU APIのドキュメント確認

### 代替案の検討

**案A**: ダミーファイルパスを使用
```c
// /tmp/dummy.h264 などのダミーパスを渡す
sp_start_decode(ctx->decoder_object, "/tmp/dummy.h264", 0, ...);
```

**案B**: Pythonデコーダーサービス
- camera_daemon は H.264 のみ出力
- 別プロセスでH.264をデコードしてNV12を共有メモリに書き込み
- ユーザーの「Cで完結させたい」要望に反する

**案C**: Low-level VPU API の直接使用
- `hb_media_codec.h` の低レベルAPI
- より複雑だが、メモリベースデコードが可能かもしれない

## 現時点での成果サマリ

### ✅ 完了
1. デコーダースレッド分離アーキテクチャの実装
2. MIPI Host 明示指定によるマルチカメラ対応
3. H.264-only モードの動作確認 (~27fps)
4. デュアルモードの起動確認 (両方の共有メモリ作成)

### ⏳ 課題
1. **sp_decoder API の正しい使用方法の特定**
2. メモリベースH.264デコードの実現
3. 30fps の厳密な測定 (profilerのタイムスタンプ問題修正)

### 📊 アーキテクチャ検証状況

```
✅ camera_daemon (C) - メインスレッド
   VIO → Encoder → H.264 → SHM_STREAM (~27fps測定)

⚠️ camera_daemon (C) - デコードスレッド
   SHM_STREAM → Decoder → ❌ (sp_decoder失敗) → NV12 → SHM_FRAMES

✅ camera_switcher (C) - 既存のまま
   SHM_FRAMES から NV12 を読み取り、明度計算

✅ yolo_detector (Python) - 既存のまま
   SHM_FRAMES から NV12 を読み取り、物体検出
```

## 作業時間
約2時間 (テスト・デバッグ・ログ分析)

---

**次回作業**: sp_decoder API の詳細調査とメモリベースデコードの実現方法の特定
