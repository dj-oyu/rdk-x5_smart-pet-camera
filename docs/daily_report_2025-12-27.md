# 日報 2025-12-27

## 作業サマリ

camera_daemon_drobotics.cをlow-level API (hbn_*)に書き換え、MIPI Hostを明示的に指定することで、カメラ0とカメラ1を同時に起動できるようになった。H.264エンコーディングの統合に一部課題が残っている。

## 完了した作業

### 1. Makefile修正（バイナリ削除問題の解決）
**問題**: `scripts/run_camera_switcher_yolo_streaming.sh`実行後、終了時にbuild/camera_*バイナリが削除されていた

**原因**: スクリプト終了時の`cleanup`処理が`make cleanup`を呼び出し、それが`clean`ターゲットを実行してバイナリを削除していた

**解決**: この動作は意図的な設計であることが判明。`cleanup`は`kill-processes`と`clean`を両方実行し、実行スクリプト側で`make kill-processes`を呼び出すように変更済み。

**変更ファイル**: なし（設計通りの動作のため、変更を元に戻した）

### 2. camera_daemon_drobotics.cのlow-level API移行
**問題**: `sp_open_camera_v2`の自動MIPI Host選択（`-1`）により、複数カメラデーモンが同じデバイスを開こうとしてエラーになる

**解決**:
- `sp_open_camera_v2`を削除し、low-level API（`hbn_*`）を使用
- MIPI Hostを明示的に指定：
  - Camera 0 → MIPI Host 0
  - Camera 1 → MIPI Host 2
- VIN/ISP/VSEパイプラインを手動構築
- `hbn_camera_create()`, `hbn_vnode_*()`, `hbn_vflow_*()` APIを使用

**変更ファイル**:
- `src/capture/camera_daemon_drobotics.c` (全面書き換え、986行)
- `src/capture/Makefile` (リンクライブラリ追加: `-lcam -lvpf -lhbmem`)

**テスト結果**:
- ✅ Camera 0単独: 正常動作（65フレーム取得）
- ✅ Camera 1単独: 正常動作（65フレーム取得）
- ✅ 両カメラ同時起動: 成功（camera_switcher_daemonで確認）

### 3. H.264エンコーディング統合の実装
**問題**: low-level VIOパイプラインとhigh-level H.264エンコーダー（`sp_*`）が連携していない

**調査**:
- gemini_searchを使用してD-Robotics RDK X5のlow-level encoder API情報を調査
- 公開ドキュメントにlow-level encoder バインディングAPIは存在しない
- ヘッダーファイル調査で`sp_encoder_set_frame()`関数を発見
  - *ユーザーより* `/usr/include/{hb_media_codec.h, hb_media_recorder.h}`も参考になりそう

**実装**:
- `sp_encoder_set_frame()`を使用して、VSEから取得したNV12フレームをエンコーダーに手動送信
- capture_loopで`hbn_vnode_getframe()`の後に`sp_encoder_set_frame()`を呼び出し

**変更箇所**: `src/capture/camera_daemon_drobotics.c:850-856`

## 残課題

### H.264エンコーディングのパフォーマンス問題
**現象**:
- プロファイラー測定でFPS: 0~0.96（期待値: 30fps）
- 5秒間で1フレームのみ検出
- status: "CRITICAL", is_stale: true

**推定原因**:
`sp_encoder_set_frame()`が同期的で、エンコード処理が完了するまでブロッキングしている可能性

**次のステップ**:
1. H.264エンコードを無効にしてNV12のみでFPS測定
2. `sp_encoder_set_frame()`の実行時間計測
3. エンコード処理の非同期化またはスキップ可能化の検討
4. 別スレッドでエンコード処理を実行する案も検討

## 技術的学び

### D-Robotics APIアーキテクチャ
1. **High-level API** (`libspcdev`の`sp_*`関数):
   - `sp_open_camera_v2()` - カメラ自動選択
   - `sp_module_bind()` - VIOとエンコーダーのゼロコピーバインド
   - 簡単だが、複数カメラ同時起動では問題が発生

2. **Low-level API** (`hbn_*`関数):
   - `hbn_camera_create()`, `hbn_vnode_*()` - 詳細な制御
   - MIPI Hostを明示的に指定可能
   - 複数カメラ対応に必須

3. **ハイブリッドアプローチの限界**:
   - Low-level VIO + High-level Encoderの組み合わせで統合が困難
   - Low-level encoder APIは公開されていない

### docs/sample/capture_v2.cの価値
- D-Roboticsの公式サンプルコードが重要な参考情報源
- `bus_select`の設定や MIPI Host選択のロジックを参照
- コメント内のワークアラウンド情報が問題解決の鍵

## 次回作業予定
1. H.264エンコーディングのパフォーマンス問題の詳細調査
2. エンコード処理の非同期化実装
3. プロファイラーで30fps達成の確認
4. 完全なシステム統合テスト

---

## 続・作業サマリ (午後)

### High-level APIへの完全移行実装

ユーザーの提案に従い、Low-level API (hbn_*) からHigh-level API (sp_*) へ完全移行しました。

**実装内容**:
1. **MIPIホスト明示指定** (src/capture/camera_daemon_drobotics.c:244-256)
   ```c
   int video_index = (ctx->camera_index == 0) ? SP_HOST_0 : SP_HOST_2;
   const char *vcon_value = (ctx->camera_index == 0) ? "0" : "2";
   setenv("VP_PRIORITY_VCON", vcon_value, 1);
   ```

2. **ゼロコピーバインディング**
   - VIO → Encoder: sp_module_bind()
   - NV12取得: sp_vio_get_frame()
   - H.264取得: sp_encoder_get_stream()

3. **sp_encoder_set_frame()削除**
   - ゼロコピーバインディングにより不要

**ビルド結果**: ✅ 成功

**テスト結果**:
- 84 frames captured in 10 seconds ≈ **8.4 fps**
- 前回 (Low-level API): 0.96 fps
- **改善率**: 8.75倍

### 発見した問題

**sp_vio_get_frame() の競合**:
```
[Warn] sp_vio_get_frame failed: -1
```

**原因**:
- VIOとEncoderがバインドされている場合、VIOの出力は直接Encoderに流れる
- sp_vio_get_frame()でフレームを横取りしようとすると失敗する
- ゼロコピーバインディングとフレーム取得APIが競合している

**アーキテクチャの矛盾**:
```
VIO → [ゼロコピーバインド] → Encoder → H.264
 ↓ (競合)
sp_vio_get_frame() → NV12 (失敗が頻発)
```

### 技術的考察

**ゼロコピーバインディングの制約**:
- D-RoboticsのHigh-level APIでは、sp_module_bind()を使用すると、バインドされたモジュール間のデータフローが占有される
- vio2encoder.cサンプルでは、H.264ストリームのみを取得している（NV12は取得していない）
- NV12とH.264の両方を取得するには、別のアプローチが必要

**考えられる解決策**:
1. **VIOのマルチ出力** (DSNSチャンネル利用)
   - VSE (Video Scaling Engine) の複数チャンネルを使用
   - 1つはEncoderへバインド、もう1つはNV12取得用

2. **バインド無しアプローチ**
   - sp_module_bind()を使わず、NV12とH.264を個別に取得
   - ただし、sp_encoder_set_frame()がブロッキングの可能性

3. **H.264のみモード**
   - NV12取得を諦め、H.264ストリームのみを使用
   - 検出やYOLOはH.264をデコードして使用

### 次のアクション
1. ✅ D-RoboticsのVSE複数チャンネル出力を調査
2. ⏳ NV12とH.264を両方30fpsで取得する実装方法の決定
3. ⏳ プロファイラーで30fps達成の確認

## 作業時間
約6.5時間（調査・実装・テスト・トラブルシューティング含む）
