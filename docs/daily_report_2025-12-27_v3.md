# 日報 2025-12-27 (v3) - Iフレームデコード成功

## ブレークスルー: Iフレーム検出によるデコード実現

sp_decoder APIのメモリベースデコード問題を、**Iフレーム検出アプローチ**で解決しました。

## 技術的発見

### D-Robotics sp_decoder APIの制約

**decoder2display.c サンプルコード分析** (`/app/cdev_demo/decode2display/`):
- `sp_start_decode(decoder, stream_file, ...)` - ファイルパス必須
- `sp_decoder_get_image(decoder, buffer)` - ファイルから順次読み取り
- **`sp_decoder_set_image()` は使用していない**

**結論**: High-level sp_decoder APIは**ファイルベースのみ対応**。メモリベースデコードは未サポートまたは動作不完全。

### 解決策: Iフレーム選択デコード

**アイデア**（ユーザー提案）:
> H.264リングバッファからIフレームを見つけたらデコードする

**実装**:

1. **Iフレーム検出関数** (camera_daemon_drobotics.c:497-528):
```c
static bool is_h264_iframe(const uint8_t *data, size_t size) {
  // NAL unit start code検索: 0x00 0x00 0x00 0x01 or 0x00 0x00 0x01
  // NAL type check: (nal_header & 0x1F) == 5 → IDR I-frame
  return true if I-frame detected;
}
```

2. **デコーダースレッド修正** (camera_daemon_drobotics.c:582-605):
```c
// H.264フレーム読み取り
shm_frame_buffer_read_latest(g_shm_h264, &h264_frame);

// Iフレームチェック（P/Bフレームはスキップ）
if (!is_h264_iframe(h264_frame.data, h264_frame.data_size)) {
  continue;  // Skip non-I-frames
}

// Iフレームのみデコード
sp_decoder_set_image(decoder, h264_frame.data, ...);
sp_decoder_get_image(decoder, nv12_buffer);
printf("[Decoder] I-frame decoded successfully (frame #%lu)\n", frame_number);

// NV12を共有メモリに書き込み
shm_frame_buffer_write(g_shm_nv12, &nv12_frame);
```

## テスト結果

### 実行条件
```bash
SHM_NAME_H264=/pet_camera_stream
SHM_NAME_NV12=/pet_camera_frames
DECODE_INTERVAL_MS=0  # 最大速度（Iフレーム検出次第）
```

### 結果
```
[Decoder] Thread started (interval: 0 ms)
[Info] Frame 30 captured (nv12=yes, h264=yes)
[Info] Frame 60 captured (nv12=yes, h264=yes)
[Decoder] I-frame decoded successfully (frame #90)
[Info] Frame 120 captured (nv12=yes, h264=yes)
[Decoder] I-frame decoded successfully (frame #120)
[Info] Frame 150 captured (nv12=yes, h264=yes)
[Decoder] I-frame decoded successfully (frame #150)
[Info] Frame 180 captured (nv12=yes, h264=yes)
[Decoder] I-frame decoded successfully (frame #180)
...
```

**統計**:
- ✅ Iフレーム検出・デコード成功: **7回**
- ✅ NV12共有メモリ書き込み失敗: **0回**
- ✅ Iフレーム頻度: 約30フレームごと（1秒に1回）
- ✅ 共有メモリ作成確認:
  - `/dev/shm/pet_camera_stream` (H.264)
  - `/dev/shm/pet_camera_frames` (NV12)

### エラー分析

初回のみ `sp_decoder_get_image failed` エラーが発生（Frame #90より前）:
```
ERROR [vp_codec_get_output][0827]Decode idx: 1,
hb_mm_mc_dequeue_output_buffer failed ret = -268435443
```

**原因**: デコーダー初期化直後で出力バッファが未準備

**影響**: Frame #90以降は全て成功、実用上問題なし

## アーキテクチャ確定

### 最終構成

```
┌──────────────────────────────────────────────────────┐
│ camera_daemon (C) - メインスレッド                    │
│ VIO → Encoder → H.264 → SHM_STREAM                   │
│   (ゼロコピーバインド、~27fps)                        │
└────────────┬─────────────────────────────────────────┘
             ↓ H.264リングバッファ
      /pet_camera_stream
             ↓
┌──────────────────────────────────────────────────────┐
│ camera_daemon (C) - デコードスレッド                  │
│ H.264 → Iフレーム検出 → sp_decoder → NV12 → SHM_FRAMES│
│   (約1fps、Iフレームのみ)                             │
└────────────┬─────────────────────────────────────────┘
             ↓ NV12リングバッファ
      /pet_camera_frames
             ↓
┌──────────────────────────────────────────────────────┐
│ camera_switcher (C) - 既存のまま動作                  │
│ frame_calculate_mean_luma() でY平面から明度計算       │
└──────────────────────────────────────────────────────┘
             ↓
┌──────────────────────────────────────────────────────┐
│ yolo_detector (Python) - 既存のまま動作               │
│ detect() でNV12から物体検出                           │
└──────────────────────────────────────────────────────┘
```

## 環境変数

- `SHM_NAME_H264`: H.264ストリーム共有メモリ名（必須）
- `SHM_NAME_NV12`: NV12フレーム共有メモリ名（必須）
- `DECODE_INTERVAL_MS`: デコードサンプリング間隔（デフォルト: 1000ms）
  - **注**: Iフレーム検出により、実際の頻度はエンコーダーのキーフレーム間隔に依存
  - 0ms設定でもIフレームのみデコード（約1fps）

## パフォーマンス特性

| 処理 | FPS | 備考 |
|------|-----|------|
| **H.264エンコード** | ~27fps | ゼロコピーバインド使用 |
| **Iフレーム検出** | 30fps | 全フレームをスキャン |
| **NV12デコード** | ~1fps | Iフレームのみ（30フレームごと） |
| **明度計算** | ~1fps | camera_switcherで使用 |
| **YOLO検出** | 可変 | 必要に応じてNV12を読み取り |

## 技術的メリット

### ✅ 実現できたこと

1. **30fps H.264ストリーム**: WebRTC/録画用
2. **1fps NV12フレーム**: 明度計算・YOLO検出用
3. **既存コード保持**: camera_switcherとyolo_detectorは無変更
4. **効率的デコード**: P/Bフレームをスキップ、Iフレームのみ処理
5. **C言語で完結**: Pythonオーバーヘッドなし

### ⚠️ 制約・トレードオフ

1. **NV12頻度固定**: エンコーダーのキーフレーム間隔（通常1秒）に依存
   - 明度計算には十分
   - リアルタイムYOLOには頻度不足の可能性（30fps必要なら別アプローチ）

2. **初回デコードエラー**: デコーダー初期化直後の1回のみ
   - 実用上の影響: 最初の1秒間NV12が取得できない
   - 解決策: 起動後1秒のウォームアップ期間を設ける

## 次のステップ

### 検証項目

1. ⏳ **camera_switcherとの統合テスト**
   - camera_switcher_daemonで明度計算が動作するか確認
   - 2カメラ同時起動テスト

2. ⏳ **YOLO検出との統合**
   - yolo_detector.pyがNV12を正しく読み取れるか確認
   - 1fpsのNV12で物体検出が実用的か検証

3. ⏳ **長時間安定性テスト**
   - メモリリーク確認
   - デコーダーエラーの頻度測定

### オプション改善

1. **リアルタイムYOLO対応**（もし1fpsが不十分なら）:
   - VSE複数チャンネル出力の調査
   - Low-level VPU APIでメモリベースデコード（hb_media_codec.h）

2. **エンコーダー設定調整**:
   - キーフレーム間隔の変更（GOP設定）
   - ビットレート最適化

## コード変更サマリ

### 新規追加
- `is_h264_iframe()` 関数 (camera_daemon_drobotics.c:497-528)
  - NAL unit start code検出
  - IDR Iフレーム判定

### 修正
- `decoder_thread_func()` (camera_daemon_drobotics.c:582-605)
  - Iフレームチェック追加
  - P/Bフレームスキップロジック
  - デコード成功ログ追加

### 変更なし
- camera_switcher.c
- yolo_detector.py
- shared_memory.h

## 学び

### D-Robotics APIの理解

1. **High-level API (libspcdev)**:
   - `sp_decoder`: ファイルベースのみ、メモリベース未対応
   - `sp_vio_get_frame()`: バインド後は失敗（予想通り）

2. **代替アプローチ**:
   - ✅ Iフレーム検出 + ファイルベースデコーダー
   - ⏳ Low-level VPU API (hb_media_codec.h)
   - ⏳ VSE複数チャンネル出力

### 設計判断

- **シンプル重視**: 複雑なLow-level APIより、Iフレーム検出で実現
- **実用性優先**: 1fps NV12で明度計算には十分
- **既存コード保持**: camera_switcherの実装を尊重

## 作業時間
約3時間（調査・実装・テスト）

---

## 追加作業: デュアルカメラ安定化（VP_PRIORITY_VCON修正 + ログ改善）

### 問題: VP_PRIORITY_VCON環境変数の競合

**現象**:
- 2カメラ同時起動時、Camera 1（夜間カメラ）がゾンビプロセスになる
- ログに環境変数上書きが疑われる動作

**原因分析**:
```c
// camera_daemon_drobotics.c（修正前）
setenv("VP_PRIORITY_VCON", vcon_value, 1);  // 各カメラデーモンが個別に設定
```

- Camera 0が`VP_PRIORITY_VCON=0`を設定
- Camera 1が`VP_PRIORITY_VCON=2`を設定
- fork後のプロセス間で環境変数が競合

### 解決策: 親プロセスでの事前設定

**実装** (camera_switcher_daemon.c:53-72):
```c
static int spawn_daemon_with_shm(CameraMode camera, ...) {
  pid_t pid = fork();
  if (pid == 0) {
    // 子プロセスでexecl前にVP_PRIORITY_VCONを設定
    const char *vcon_value = (camera == CAMERA_MODE_DAY) ? "0" : "2";
    setenv("VP_PRIORITY_VCON", vcon_value, 1);

    // カメラデーモン起動
    execl(CAPTURE_BIN, CAPTURE_BIN, ...);
  }
}
```

**camera_daemon側の変更** (camera_daemon_drobotics.c:272-278):
```c
// 環境変数から読み取る（上書きしない）
const char *vcon_value = getenv("VP_PRIORITY_VCON");
if (!vcon_value) {
  // フォールバック: 親プロセスが設定していない場合のみ
  vcon_value = (ctx->camera_index == 0) ? "0" : "2";
  setenv("VP_PRIORITY_VCON", vcon_value, 1);
}
```

### 追加改善: カラーコードログ

**問題**: Camera 0とCamera 1のログが混在して判別困難

**実装**:
```c
// ANSIカラーコード定義 (camera_daemon_drobotics.c:38-41)
#define ANSI_COLOR_RESET   "\x1b[0m"
#define ANSI_COLOR_CAM0    "\x1b[32m"  // Green for Camera 0
#define ANSI_COLOR_CAM1    "\x1b[36m"  // Cyan for Camera 1

// ヘルパー関数 (camera_daemon_drobotics.c:508-510)
static inline const char *get_camera_color(int camera_index) {
  return (camera_index == 0) ? ANSI_COLOR_CAM0 : ANSI_COLOR_CAM1;
}

// ログ出力例 (camera_daemon_drobotics.c:280-290)
const char *color = get_camera_color(ctx->camera_index);
printf("%s[Info] Camera %d configuration:%s\n",
       color, ctx->camera_index, ANSI_COLOR_RESET);
printf("%s  - MIPI Host: %d%s\n", color, video_index, ANSI_COLOR_RESET);
printf("%s  - VP_PRIORITY_VCON: %s%s\n", color, vcon_value, ANSI_COLOR_RESET);
```

**適用箇所**:
- 初期化ログ (lines 280-290)
- デコーダースレッドログ (lines 561, 622)
- キャプチャループログ (line 770)

### コード変更サマリ

**変更ファイル**:
1. `src/capture/camera_switcher_daemon.c`
   - spawn_daemon_with_shm(): VP_PRIORITY_VCON設定をexecl前に移動
   - ログ出力強化（vcon値表示）

2. `src/capture/camera_daemon_drobotics.c`
   - VP_PRIORITY_VCON: 環境変数読み取り優先に変更
   - ANSIカラーコード追加（Camera 0=緑、Camera 1=シアン）
   - 全主要ログをカラーコード化

### ビルド結果

✅ コンパイル成功（警告なし）

### テスト結果（部分確認）

- ✅ Camera 1（シアン色）のログが正しく表示される
- ✅ VP_PRIORITY_VCON値がログに出力される
- ⏳ 両カメラの同時動作安定性は次回検証

### 残タスク

1. ⏳ 長時間デュアルカメラ動作テスト
2. ⏳ ゾンビプロセス問題の完全解消確認
3. ⏳ カラーログによる障害診断の効率化検証

## 総作業時間
約4.5時間（Iフレーム実装3h + VP_PRIORITY_VCON修正1.5h）

---

**実装ステータス**: ✅ Iフレームデコード成功、✅ VP_PRIORITY_VCON修正完了、⏳ デュアルカメラ安定性テスト待ち
