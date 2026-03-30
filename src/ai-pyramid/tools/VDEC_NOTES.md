# AX_VDEC HW Decode — 調査メモ (2026-03-30)

## 問題

`AX_VDEC_Init` および `AX_VDEC_CreateGrp` が daemon バイナリでのみ `0x8008010a` (ILLEGAL_PARAM) で失敗する。同じソースの小さなテストバイナリでは成功する。

## 判明した事実

### BSP バージョン不一致
- ヘッダ: AXERA-TECH/ax650n_bsp_sdk V1.45.0
- 実機ライブラリ: V3.6.4 (m5stack カスタム)
- `AX_VDEC_CreateGrpEx` が V3.6.4 で追加 (V1.45 ヘッダに無い)

### VDEC Init のスタック問題
- `AX_VDEC_MOD_ATTR_T` をスタックに置くと、**大きなバイナリでのみ**失敗
- **ヒープ割り当て (`new` + `memset`) で Init は解決**
- 原因: AX650 BSP V3.6.4 の VDEC ドライバが構造体ポインタの内部チェックで、スタックアドレスの範囲を検証している疑い

### VDEC CreateGrp の同じ問題
- ヒープ割り当てしても daemon バイナリでは `0x8008010a`
- テストバイナリ (同じコード、同じフラグ、同じライブラリ) では成功
- strace: カーネル ioctl は全て成功 (`= 0`) → エラーはユーザ空間ライブラリ内部
- `/dev/ax_vdec` は正常に open される (fd 10)

### bind() の影響 (初期調査時)
- `socket()` + `bind()` 後に VDEC Init すると失敗する現象を確認
- しかし Init はヒープ割り当てで解決
- CreateGrp の失敗は bind の有無に関係なく、daemon バイナリ固有

### 初期化順序の制約
- `AX_ENGINE_CreateHandle` (モデルロード) 後は VDEC Init 不可
- 正しい順序: SYS_Init → ENGINE_Init → **VDEC_Init** → IVPS_Init → load_model → socket listen

## 未解決

- `AX_VDEC_CreateGrp` が daemon バイナリでのみ失敗する根本原因
  - ヒープ割り当て済み、バイトダンプは正しい
  - テストバイナリでは同じ内容で成功
  - 構造体サイズ (48 bytes) はテストと同一
  - **ライブラリ内部のポインタバリデーション？バイナリサイズ依存の何か？**

## 根本原因 (GetChnFrame が BUF_EMPTY を返す)

ax-pipeline の参考実装 (`common_pipeline_vdec.cpp`) と比較して判明:
1. **`bSdkAutoFramePool = AX_FALSE`** にして手動プール管理が必要
2. `AX_VDEC_GetPicBufferSize()` でフレームサイズ計算
3. `AX_POOL_CreatePool()` でプール作成
4. `AX_VDEC_AttachPool(grp, 0, poolId)` で VDEC に紐付け
5. **`INPUT_MODE_FRAME`** を使用 (STREAM モードではない)
6. `u32FrameStride` を 128 byte アライメントで設定
7. フレーム取得は `AX_VDEC_GetFrame` (not `GetChnFrame`)

→ 次のセッションで修正

## 次のステップ候補

1. **CreateGrp のバイトダンプ比較**: daemon と test で渡す struct バイトが同一か確認
2. **V3.6.4 ヘッダの入手**: m5stack に問い合わせ or リバースエンジニアリング
3. **ffmpeg フォールバック**: VDEC を諦めて ffmpeg subprocess で stream mode を実装 (現実的)
4. **別プロセスで VDEC**: daemon から fork して VDEC 専用子プロセスを起動

## 現在の動作状態

| 機能 | 状態 |
|---|---|
| CMD_DETECT (JPEG path) | ✅ 動作確認済み (36ms) |
| CMD_DETECT (NV12 raw) | ✅ 動作確認済み |
| CMD_STREAM (VDEC HW) | ❌ CreateGrp 失敗 |
| IVPS HW preprocess | ✅ Init 成功 (未テスト) |
| on-demand 19x 高速化 | ✅ 1000ms → 52ms |
