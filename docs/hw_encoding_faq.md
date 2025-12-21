# HW Encoding FAQ (libspcdev)

このドキュメントは、HW H.264エンコード（libspcdev）に関する会話から得られた知見を整理したものです。
設計・実装時の判断材料として参照してください。

## 1. データ経路の要点

- `sp_encoder_get_stream()` は HW エンコーダからの **H.264 NAL ユニット**を返す。
- `/sys/shm` を直接読む設計ではなく、**SDK内部のバッファ管理**から取り出す形。
- 共有メモリへ渡す場合はアプリ側で書き込む（SDKが自動保存はしない）。

## 2. 基本パイプライン

1. `sp_init_vio_module()` / `sp_init_encoder_module()`
2. `sp_open_camera_v2()`
3. `sp_start_encode()` (H.264)
4. `sp_module_bind()` で VIO → Encoder をゼロコピー接続
5. ループで `sp_encoder_get_stream()` を呼び、戻りデータを保存/配信
6. `sp_module_unbind()` → stop/release

## 3. 「全自動で動画生成」か？

- **いいえ。**
- エンコーダのストリーム取得後の **ファイル書き込み/共有メモリ書き込みはアプリ側実装が必須**。
- `vio2encoder` はファイルに直接書き込む最小例。

## 4. フレーム単位の読み出しは可能？

- 可能。VIO APIで生フレーム取得ができる。
  - NV12/YUV: `sp_vio_get_yuv()`
  - RAW: `sp_vio_get_raw()`
  - フレーム: `sp_vio_get_frame()`
- H.264 ストリームから取り出す場合は **デコードが必要**。

## 5. 動画の切り出し/セグメント化

- SDKに自動セグメント機能は見当たらない。
- **アプリ側でファイルを閉じて開き直す**方式で分割保存。

## 6. 2本同時録画は可能？

- 可能（デュアルカメラ前提）。
- カメラごとに **VIO/Encoder を別インスタンスで作成**し、別ストリームを取得する。
- 共有メモリは **別リング**か **カメラID付きメタデータ**が必要。

## 7. WebRTC配信 + 任意タイミングで数フレーム取得

推奨構成:
- WebRTCはH.264 NALをそのまま配信
- 数フレームの取得は **VIOから直接取得**が確実
  - NV12が欲しい: `sp_vio_get_yuv()`
  - JPEGが欲しい: `sp_vio_get_yuv()` → 必要なタイミングだけソフトJPEG化

H.264から取り出す場合:
- デコードが必要で負荷増
- キーフレーム依存で遅延しやすい

## 8. 実装/調査メモ

- `sp_*` 実体は `/usr/lib/libspcdev.so` にある。
- 依存ライブラリ: `libhbmem.so`, `libvpf.so`, `libcam.so`, `libmultimedia.so` など。
- 実装の中身を追う場合:
  - `nm -D /usr/lib/libspcdev.so | rg sp_encoder_get_stream`
  - `objdump -d --disassemble=sp_encoder_get_stream /usr/lib/libspcdev.so`
  - `strace -f -e openat,ioctl,mmap,read,write ./your_binary ...`

## 9. 参考資料

- `docs/h264_encoding_integration_guide.md`
- `docs/04_architecture.md`
- `docs/sample/` (必要に応じて)

