# Daily Report - 2025-12-27 (リファクタリング完了)

## 概要

Low-level API PoCの成功を受け、3層アーキテクチャへの本格リファクタリングを実施。
2カメラ同時30fps達成を維持しつつ、保守性・拡張性・テスタビリティを大幅に向上。

## 成果物

### 1. VP_PRIORITY_VCON環境変数の削除

**問題**: 実際のAPIに存在しない環境変数を使用していた
- 以前のライブラリ改造時の名残
- bus_select=0が両カメラで正しい設定

**対応**:
- `camera_switcher_daemon.c`: lines 55-67, 99-103を削除
- `camera_daemon_drobotics.c`: lines 285-291, 299, 319-320を削除
- ビルド成功、動作確認済み

### 2. 3層アーキテクチャへのリファクタリング

**哲学**: "Make it work, make it right, make it fast"
- まずPoCで動作検証（✓ 30fps達成）
- 次に構造化（今回）
- 必要なら最適化（将来）

#### Layer 1: HAL (Hardware Abstraction Layer)

**`vio_lowlevel.c/h` (334行)**
- VIO (VIN→ISP→VSE) パイプライン管理
- API: `vio_create()`, `vio_start()`, `vio_get_frame()`, `vio_release_frame()`, `vio_destroy()`
- 責務: カメラハードウェアの抽象化

**`encoder_lowlevel.c/h` (203行)**
- H.264エンコーダー管理
- API: `encoder_create()`, `encoder_encode_frame()`, `encoder_destroy()`
- 責務: H.264エンコードの抽象化
- **重要**: ビットレート上限700kbpsをドキュメント化

#### Layer 2: Pipeline Layer

**`camera_pipeline.c/h` (217行)**
- VIOとEncoderを統合
- キャプチャループ実装 (VIO→Encoder→共有メモリ)
- API: `pipeline_create()`, `pipeline_start()`, `pipeline_run()`, `pipeline_destroy()`
- 責務: ビジネスロジックとデータフロー

#### Layer 3: Application Layer

**`camera_daemon_main.c` (177行)**
- エントリーポイント
- CLI引数解析、シグナルハンドリング
- ライフサイクル管理
- 責務: アプリケーション起動とクリーンアップ

#### Infrastructure

**`logger.c/h` (106行)**
- 軽量ログライブラリ
- ログレベル: DEBUG, INFO, WARN, ERROR
- ANSIカラー対応（ターミナル自動検出）
- スレッドセーフ
- 全HAL/Pipeline層に統合済み

### 3. ビットレート制限の実測

**実測結果**:
- 100 kbps ~ 700 kbps: ✓ 動作確認
- 750 kbps以上: ✗ エラー (`Invalid h264 bit rate parameters. Should be [0, 700000]`)

**記録箇所**:
- `docs/architecture_refactor_plan.md`: ハードウェア制約事項セクション追加
- `src/capture/encoder_lowlevel.h`: API ドキュメントに制限を明記

**推奨設定**: 600 kbps (安全マージン含む)

**検証スクリプト**: `scripts/test_bitrate_limits.sh`

### 4. 2カメラ同時動作テスト

**テストスクリプト**: `scripts/test_dual_camera_new.sh`

**結果**:
- **Camera 0**: 29.87 FPS (1920x1080@600kbps)
- **Camera 1**: 30.40 FPS (1920x1080@600kbps)
- 両カメラとも30fps達成 ✓
- 共有メモリ出力成功 ✓

**ログ出力例**:
```
[INFO ] [VIO] Creating pipeline for Camera 0 (MIPI Host 0)
[INFO ] [VIO] Pipeline created successfully
[INFO ] [Encoder] Created (H.264 CBR 1920x1080 @ 30fps, 600kbps)
[INFO ] [Pipeline] Frame 510, FPS: 29.87, H.264 size: 316097 bytes
```

### 5. リファクタリングサービスのドキュメント化

**`docs/SKILL.md` 作成**

**内容**:
- **哲学**: いつリファクタリングすべきか（すべきでないか）
- **判断基準**: 定量的・定性的な基準
- **3層アーキテクチャ方針**: DO/DON'T/サンプル
- **命名規則**: ファイル、関数の命名パターン
- **インフラ**: ログライブラリの使い方
- **リファクタリングプロセス**: Phase 1-4の手順
- **プロジェクト固有**: D-Robotics X5の制約とAPI
- **アンチパターン**: 早すぎるリファクタリング、過度な抽象化
- **ケーススタディ**: 今回のリファクタリング実例

**重要な哲学**:
> "Make it work, make it right, make it fast"
>
> まず動かせ。次に正しくしろ。最後に速くしろ。
>
> 要件が固まり、動作が確認でき、長期保守が必要になったとき。
> それまでは、汚くても素早く回せ。

## ファイル構成

### 新規作成
```
src/capture/
├── vio_lowlevel.c/h           (HAL - VIO)
├── encoder_lowlevel.c/h       (HAL - Encoder)
├── camera_pipeline.c/h        (Pipeline)
├── camera_daemon_main.c       (Application)
└── logger.c/h                 (Infrastructure)

build/
└── camera_daemon_new          (新daemon)

docs/
└── SKILL.md                   (リファクタリングサービス)

scripts/
├── test_dual_camera_new.sh    (新daemon用テスト)
├── test_bitrate_limits.sh     (ビットレート実測)
└── test_bitrate_fine.sh       (詳細実測)
```

### 更新
```
docs/
└── architecture_refactor_plan.md  (ハードウェア制約事項追加)

src/capture/
├── Makefile                       (daemon-newターゲット追加)
├── camera_switcher_daemon.c       (VP_PRIORITY_VCON削除)
└── camera_daemon_drobotics.c      (VP_PRIORITY_VCON削除)
```

## ビルド & 実行

### ビルド
```bash
cd src/capture
make daemon-new
```

### 実行例
```bash
# Camera 0
SHM_NAME_H264=/pet_camera_stream_day ./build/camera_daemon_new -C 0

# Camera 1
SHM_NAME_H264=/pet_camera_stream_night ./build/camera_daemon_new -C 1

# Verbose mode
./build/camera_daemon_new -C 0 -v

# カスタムビットレート
./build/camera_daemon_new -C 0 -b 500000
```

### テスト
```bash
# 2カメラ同時テスト
./scripts/test_dual_camera_new.sh

# ビットレート制限テスト
./scripts/test_bitrate_limits.sh
```

## コード統計

### Before (PoC)
- `camera_poc_lowlevel.c`: 639行
- 責務混在: VIO + Encoder + メインループ

### After (リファクタリング)
- `vio_lowlevel.c/h`: 334行
- `encoder_lowlevel.c/h`: 203行
- `camera_pipeline.c/h`: 217行
- `camera_daemon_main.c`: 177行
- `logger.c/h`: 106行
- **合計**: 1037行 (PoC比 +398行)

### トレードオフ
**コスト**:
- コード量が約60%増加

**メリット**:
- ✅ 各ファイルの責務が明確（各200-300行）
- ✅ テスタビリティ向上（各層を独立テスト可能）
- ✅ 再利用性向上（HAL層は他プロジェクトでも使用可）
- ✅ 保守性向上（変更の影響範囲が限定）
- ✅ 拡張性向上（新機能追加が容易）
- ✅ ログ出力が統一され、デバッグが容易

## 検証結果

### 機能等価性
- ✅ PoCと同じ動作を確認
- ✅ 共有メモリ出力成功

### 性能維持
- ✅ Camera 0: 29.87 FPS (目標30fps)
- ✅ Camera 1: 30.40 FPS (目標30fps)

### ビルド品質
- ✅ 警告なしでビルド成功
- ✅ 全テストスクリプト実行成功

## 次のステップ

### 短期（優先度: 高）
- [ ] decoder_lowlevel.c/h の実装（Low-level decoder API使用）
- [ ] decoder_thread.c/h の実装（I-frameデコード用）
- [ ] 既存のcamera_daemon_drobotics.cを新アーキテクチャで置き換え

### 中期（優先度: 中）
- [ ] camera_switcher_daemon.cの新アーキテクチャへの移行
- [ ] ユニットテストの追加（各HAL層）
- [ ] パフォーマンスプロファイリング

### 長期（優先度: 低）
- [ ] マルチスレッド最適化（エンコード並列化）
- [ ] 可変ビットレート（VBR）対応
- [ ] 他のハードウェアへの移植性検証

## 学び

### 技術的学び
1. **D-Robotics X5の制約**: H.264ビットレート700kbps上限を実測で発見
2. **Low-level API**: hbn_*, hb_mm_mc_* APIの正しい使い方を習得
3. **MIPI Host設定**: Camera 0→Host 0, Camera 1→Host 2, bus_select=0が正解

### プロセス的学び
1. **PoC→リファクタリング**: 早すぎる最適化を避け、まず動作検証を優先
2. **段階的移行**: 一度に全部変えず、PoC→HAL→Pipeline→Applicationの順で
3. **ドキュメント化**: SKILL.mdで知見を体系化し、横展開可能に

## まとめ

**達成事項**:
- ✅ 3層アーキテクチャへのリファクタリング完了
- ✅ 2カメラ同時30fps維持
- ✅ ログライブラリ統合
- ✅ ビットレート制限の文書化
- ✅ リファクタリングサービスの体系化

**成功の鍵**:
1. **検証ファースト**: PoCで動作確認してからリファクタリング
2. **明確な責務**: 各層が単一の責務を持つ
3. **実測主義**: ビットレート制限を推測でなく実測で確認
4. **知見の体系化**: SKILL.mdで再現可能に

**次の一歩**:
デコーダーのLow-level API移行で、システム全体をLow-level APIで統一する。
