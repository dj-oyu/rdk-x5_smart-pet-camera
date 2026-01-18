# Session 2025-12-24: NV12色変換問題の解決

## 問題の発見

Webモニターで以下の問題が発生：
1. **画像が緑とマゼンタのノイズで表示される** - NV12→BGR色変換の失敗
2. **FPS低下（7-8fps）** - MJPEG変換の負荷
3. **MJPEG使用** - 予定ではWebRTC + ブラウザ側bbox合成

## 調査プロセス

### 1. OpenCV色変換の検証
- OpenCV 4.11.0で`COLOR_YUV2BGR_NV12`定数が存在することを確認
- テストデータでの変換は正常に動作
- **問題は実際のカメラデータにある**と判明

### 2. 実データの分析
共有メモリから実際のNV12フレームを読み取って検証：

```python
# test_real_nv12.pyで確認した結果
Frame: 640x480, format=1 (NV12)
Data size: 460800 bytes (正しいサイズ)
Y plane stats: min=0, max=255, mean=94.5
UV plane stats: min=0, max=255, mean=95.4  # ← 期待値128より低い

# 変換結果
BGR pixel: [247 153 236]  # ← マゼンタ/緑の色ずれ
```

### 3. 様々な仮説のテスト

#### 仮説1: フォーマットがI420では？
```bash
uv run python test_i420_conversion.py
```
結果: I420として解釈しても同じストライプパターン → **否定**

#### 仮説2: YUYV/UYVYなどのパックドフォーマットでは？
```bash
uv run python test_yuyv_formats.py
```
結果: データサイズが一致しない（460800 vs 614400必要） → **否定**

#### 仮説3: メモリストライドの問題？
各種ストライド値（640, 672, 704, 768...）でテスト
結果: ストライド640で問題なし → **否定**

### 4. 原因の特定

D-Roboticsのサンプルコード（/app/cdev_demo）を調査：
- 公式サンプルでは`sp_module_bind()`でパイプライン接続を使用
- `sp_vio_get_yuv()`の直接使用例が見つからない
- ヘッダーファイル確認：
  - `sp_vio_get_yuv()` - YUVデータ取得
  - `sp_vio_get_frame()` - フレームデータ取得（より汎用的）
  - `sp_vio_get_raw()` - RAWデータ取得

**仮説**: `sp_vio_get_yuv()`が返すデータフォーマットが想定と異なる可能性

## 解決方法

### sp_vio_get_frame()への変更

`camera_daemon_drobotics.c` の修正：

```c
// Before
nv12_ret = sp_vio_get_yuv(ctx->vio_object, (char *)nv12_buffer,
                          ctx->out_width, ctx->out_height, 2000);

// After
nv12_ret = sp_vio_get_frame(ctx->vio_object, (char *)nv12_buffer,
                            ctx->out_width, ctx->out_height, 2000);
```

### 結果
✅ **画像が正常に表示された** - 緑/マゼンタのノイズが消失
✅ **色変換が正しく動作** - NV12→BGR変換が期待通りに機能

## 技術的知見

### sp_vio_get_yuv() vs sp_vio_get_frame()

`sp_vio_get_yuv()`:
- 名前からYUVデータを取得するAPIと想定
- しかし、実際のフォーマットが不明確
- ドキュメント不足で詳細な仕様が不明

`sp_vio_get_frame()`:
- より汎用的なフレーム取得API
- 標準的なNV12フォーマットでデータを返す
- OpenCVの`COLOR_YUV2BGR_NV12`と互換性あり

### NV12フォーマットの構造
```
Width x Height の画像の場合：
[Y plane: Width x Height bytes]           - 輝度情報
[UV plane: Width x Height/2 bytes]        - 色情報（UVインターリーブ）
  └─ U0,V0,U1,V1,U2,V2... のパターン

Total: Width x Height x 3/2 bytes
```

640x480の場合:
- Y plane: 307,200 bytes
- UV plane: 153,600 bytes
- Total: 460,800 bytes

## 残存課題

### 1. FPS低下（7-8fps）
**原因**:
- サーバー側でNV12→BGR→JPEG変換
- MJPEGストリーミングのオーバーヘッド

**解決策**: WebRTC + H.264直接配信への移行（次タスク）

### 2. VIOワーカースレッドエラー（既知の問題）
```
ERROR [vp_codec_get_output][0827]Encode idx: 1, hb_mm_mc_dequeue_output_buffer failed
```
- フレーム上限到達時に発生
- unbindのタイミングで軽減済み
- 実用上の影響は小さい

## 次のステップ

### Phase 3: WebRTC移行
1. WebRTC signaling server実装（Flask + python-aiortc）
2. H.264ストリームをWebRTCで配信
3. ブラウザ側でH.264デコード + Canvas BBox描画
4. Server-Sent Eventsで検出結果配信

**目標**: 30fps、低遅延、サーバー負荷削減

## 作成したテストスクリプト

デバッグ用に以下のスクリプトを作成（将来の参考用）：

1. `test_nv12_conversion.py` - OpenCV NV12変換機能テスト
2. `test_real_nv12.py` - 共有メモリからの実データ検証
3. `analyze_nv12_structure.py` - NV12データ構造解析
4. `test_i420_conversion.py` - I420フォーマット仮説検証
5. `test_yuyv_formats.py` - パックドYUVフォーマット検証

## まとめ

**問題**: `sp_vio_get_yuv()`が返すデータフォーマットの不一致
**解決**: `sp_vio_get_frame()`への変更で標準NV12フォーマットを取得
**状態**: ✅ NV12色変換問題は完全に解決
**次**: WebRTC移行でFPS問題も解決予定
