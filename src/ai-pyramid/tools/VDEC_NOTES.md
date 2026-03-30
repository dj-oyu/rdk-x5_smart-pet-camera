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

## 2026-03-30 セッション — GetChnFrame BUF_EMPTY の調査

### 手動プール (bSdkAutoFramePool=FALSE)
- `AX_POOL_CreatePool` + `AX_VDEC_AttachPool` で手動プール作成 → 成功
- `autoPool=TRUE` + 手動プール → AttachPool が NOT_PERM で拒否
- `autoPool=FALSE` + 手動プールなし → 以前から BUF_EMPTY

### QueryStatus で判明した事実
- **デコーダは正常に動作**: `decFrames=864`, `w=1280`, `h=720`
- **チャネル出力にフレームが入らない**: `leftPics=[0,0,0]` (全3チャネル)
- エラーなし: `fmt=0, sz=0`
- つまりデコードは成功するが出力ルーティングが壊れている

### テストバイナリとの比較
- 同じ初期化 (ENGINE_Init, IVPS_Init, model load, socket listen) のテストバイナリ → **GetChnFrame 成功** (232/300 フレーム)
- **daemon バイナリの main() にインラインテスト埋め込み → GetChnFrame 成功** (50/100 フレーム)
- daemon の `handle_stream()` 関数から同じコード → BUF_EMPTY

### daemon inline test vs handle_stream の差
- inline test: main() 内、VDEC setup 直後に send/get ループ実行
- handle_stream: accept() 後に呼ばれる別関数内で実行
- **TCP relay が落ちて最終検証ができなかった**

### AX_VDEC_GetFrame は存在しない
- `nm -D libax_vdec.so` で確認: `AX_VDEC_GetFrame` / `AX_VDEC_ReleaseFrame` は V3.6.4 にない
- `AX_VDEC_GetChnFrame` / `AX_VDEC_ReleaseChnFrame` のみ
- `AX_VDEC_GetPicBufferSize` もない → バッファサイズは手動計算

### AX_VDEC_DebugFifo API
- V3.6.4 に存在: `DebugFifo_Init`, `GetDebugFifoFrame`, `ReleaseDebugFifoFrame`
- シグネチャ推定で試したが `Init(0,4,0)` → ILLEGAL_PARAM
- 正しいパラメータ不明

## 次のステップ候補

1. **handle_stream の BUF_EMPTY 問題**: TCP relay 復旧後に再検証。inline test で動くことは確認済み
2. **VDEC setup を handle_stream 内で実行**: CreateGrp〜StartRecvStream を stream 要求時に行う（テストバイナリと同じフロー）
3. **別プロセスで VDEC**: daemon から fork して VDEC 専用子プロセスを起動

## 現在の動作状態

| 機能 | 状態 |
|---|---|
| CMD_DETECT (JPEG path) | ✅ 動作確認済み (36ms) |
| CMD_DETECT (NV12 raw) | ✅ 動作確認済み |
| CMD_STREAM (VDEC HW) | ❌ CreateGrp 失敗 |
| IVPS HW preprocess | ✅ Init 成功 (未テスト) |
| on-demand 19x 高速化 | ✅ 1000ms → 52ms |
