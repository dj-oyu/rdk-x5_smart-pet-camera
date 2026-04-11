# Night Vision YOLO Evaluation

夜間IR カメラでの YOLO 検出品質改善の調査。

## 現状の問題

ax_yolo_daemon の CMD_STREAM での夜間 IR 映像検出:

| 症状 | 原因 |
|------|------|
| 同じオブジェクトの検出が瞬断される | フレーム間トラッキングなし。confidence が閾値 0.25 付近で出入りする |
| 同じオブジェクトのクラスが変化する | 各フレーム独立推論。2クラスの confidence が拮抗するとフレームごとに勝つクラスが変わる |
| 複数 bbox に時間差がある | confidence 閾値付近で片方が先に超えるだけ |

**CLAHE**: 有効 (8x8 タイル, clip limit 3.0)。CDF は 256 フレームごとに再計算。

## テスト素材

`~/pet_night_vid/` に夜間 IR 録画あり（1280x720 H.265 30fps、comic リサイズなし）。
詳細は `~/pet_night_vid/README.md` 参照。

---

## 調査: 夜間/IR 特化モデル

### 公開されている夜間特化 YOLO モデル

| モデル名 | ベース | 対象 | Weight 公開 | 備考 |
|----------|--------|------|-------------|------|
| [yolov8-nightshift](https://github.com/mpolinowski/yolov8-nightshift) | YOLOv8n/s | FLIR ADAS thermal (車両/歩行者) | .pt あり | FLIR dataset で学習。動物クラスなし |
| [YOLOv8-night](https://ietresearch.onlinelibrary.wiley.com/doi/full/10.1049/ell2.13305) (Wang 2024) | YOLOv8 + Channel Attention | 夜間野生動物 (IR) | 未公開 | 論文のみ、コード/weight リリースなし |
| [MDCFVit-YOLO](https://pmc.ncbi.nlm.nih.gov/articles/PMC12173352/) | YOLOv8 + ViT | 夜間 IR 小ターゲット (車両/歩行者) | 未公開 | mAP 67%, 20.9M params |
| [LFIR-YOLO](https://www.mdpi.com/1424-8220/24/20/6609) | YOLOv8 | 夜間 IR (車両/歩行者) | 未公開 | params -15.5%, FLOPs -34% |
| [YOLO-SAG](https://www.sciencedirect.com/science/article/pii/S1574954124003339) | YOLOv8n | 野生動物 (camera trap) | 未確認 | wildlife 向けだが夜間特化ではない |

**結論: IR 猫検出に直接使えるオープンな weight はない。**
- 公開 weight があるのは yolov8-nightshift のみだが、FLIR thermal dataset (車両/歩行者) で学習されており「cat」クラスがない
- 学術論文の夜間特化モデルはほぼ全て weight 未公開
- 野生動物向けモデルは存在するが、室内 IR ペットカメラとは環境が異なる

### 前処理改善アプローチ

CLAHE 以外に研究されている手法:

| 手法 | 概要 | 実装コスト | 効果 |
|------|------|-----------|------|
| CLAHE パラメータ調整 | clip limit, タイル数の調整 | 低 | 現行 CLAHE の最適化 |
| Histogram Equalization (global) | CLAHE より軽量だがコントラスト制御が粗い | 低 | CLAHE の方が優秀 |
| Gamma correction | 暗部を持ち上げる非線形変換 | 低 | IR には効果限定的 |
| Low-frequency filtering | 高周波ノイズ除去後に検出 | 中 | IR ノイズに有効 |
| Super-resolution preprocessing | 解像度向上 → 検出 | 高 (NPU 負荷) | 小ターゲットに有効 |
| Channel Attention (YOLOv8-night) | モデル内部で IR 特徴を強調 | 高 (モデル変更) | 学術的に有効性確認済み |

### Fine-tuning の実現可能性

**方針**: COCO pretrained YOLO を自前 IR ペット画像で fine-tune → Pulsar2 で axmodel 変換

| 項目 | 見積もり |
|------|---------|
| 必要画像数 | 200-500 枚 (transfer learning, 1 クラス) |
| アノテーション | bbox + class (cat) — 手動 or 既存検出結果を seed に |
| 学習環境 | GPU サーバー必要 (Ultralytics, ~1hr on RTX 3090) |
| モデル変換 | Pulsar2 で ONNX → axmodel (DFL post-processing 対応済み) |
| リスク | 少数データの過学習、COCO 汎化性の喪失 |

#### データソース

**rdk-x5 夜間収集データ** (`sunrise@rdk-x5:/tmp/night_collect/feeding/`):
- 1,942 フレーム (NV12 1280x720 + JSON メタデータのペア)
- ファイル名形式: `feeding_{frame_number}_1280x720.{nv12,json}`
- JSON: `{"frame", "timestamp", "width", "height", "nz_ratio", "motion_bboxes"}`
- `motion_bboxes` は rdk-x5 のモーション検出結果（YOLO bbox ではない）
- **実態**: 大半は猫不在の空フレームまたは人間が映ったフレーム。学習素材としてそのまま使うのは困難
- bbox ありフレーム: 5枚のみ（いずれも人間の動き検出）

**AI Pyramid サンプルコピー** (`~/pet_night_vid/samples/`):
- 上記から 15 枚（bbox あり 5 + ランダム 10）を SCP でコピー済み
- NV12 → JPEG 変換済み（目視確認用）

**夜間録画** (`~/pet_night_vid/`):
- `recording_20260322_021911.mp4` — chatora 単体、水飲み (96MB)
- `recording_20260323_005128.mp4` — mike + chatora 2匹 (208MB)
- 猫が確実に映っている。フレーム抽出 → アノテーションのソースとして有用

#### Fine-tuning パイプライン案

```
1. フレーム抽出
   ffmpeg -i recording_*.mp4 -vf fps=1 -q:v 2 frames/%06d.jpg

2. 選別
   猫が映っているフレームを手動選別 (目標: 200-500枚)

3. アノテーション
   - ツール: CVAT, Label Studio, Roboflow 等
   - 既存 YOLO で pre-annotate → 手動修正で効率化
   - クラス: cat (単一クラス or cat/person)
   - 形式: YOLO format (class cx cy w h)

4. 学習
   yolo detect train data=night_pet.yaml model=yolo11s.pt epochs=100 imgsz=640
   ※ GPU サーバー必要

5. エクスポート
   yolo export model=best.pt format=onnx opset=13 simplify=True

6. axmodel 変換
   pulsar2 build --input best.onnx --config config_yolo11s_ax650.json --output night_yolo11s.axmodel
   ※ Pulsar2 変換ガイド: docs/axmodel-conversion-guide.md

7. デプロイ
   scp night_yolo11s.axmodel ai-pyramid:~/models/yolo11/ax650/
   → ax_yolo_daemon の CMD_LOAD で動的ロード（再起動不要）
```

#### コスト・リスク

| 懸念 | 対策 |
|------|------|
| 少数データで過学習 | freeze backbone, augmentation (flip, brightness, noise) |
| COCO 汎化性の喪失 | cat クラスのみ fine-tune, 他クラスは COCO weight を維持 |
| 昼間の検出性能劣化 | 昼間フレームも混ぜて学習 or 昼/夜モデル切り替え |
| GPU サーバーの調達 | Google Colab (無料枠) or Lambda Labs (~$0.5/hr) |

**判断**: Phase 1-2 (前処理 + トラッキング) の結果を見てから決定。

---

## 検証結果

### Phase 1: 既存モデル比較 (前処理なし vs あり)

**テストフレーム**: 夜間録画から 1fps で抽出した 8 枚 (`~/pet_night_vid/test_frames/`)
- r1_0003/0005/0008: recording_20260322 (chatora 単体、水飲み、暗い)
- r2_0003/0005/0013/0018/0023: recording_20260323 (mike + chatora 2匹)

**テスト対象モデル**: yolo26l, yolo26s, yolo26n, yolo11s, yolo11x, yolov8s
(ランダム順で呼び出し、キャッシュ影響を排除)

**テストツール**: `~/pet_night_vid/test_detect.py` (CMD_DETECT via Unix socket)

#### 結果: 前処理なし

**全モデルで cat 検出 0/8 フレーム。** 検出されるのは dining table (cls_60), chair (cls_56) 等の家具のみ。

#### 結果: 前処理バリエーション (yolo26l で比較)

| 前処理 | cat 検出フレーム | cat confidence | 備考 |
|--------|----------------|----------------|------|
| なし | 0/8 | — | 家具のみ検出 |
| CLAHE clip3.0 8x8 | 2/8 | 0.42 | r2_0003, r2_0023 |
| CLAHE clip6.0 8x8 | 2/8 (r2_0003 で 2匹) | 0.42, 0.29 | **最良**: r2_0003 で cat x2 |
| CLAHE clip10.0 8x8 | 1/8 | 0.35 | コントラスト過剰、FP 増加 |
| Gamma 0.5 のみ | 0/8 | — | 全体が明るくなるが cat 検出なし |
| CLAHE3 + Gamma 0.7 | 1/8 | 0.58 | r2_0023 で高 confidence だが 1 枚のみ |
| CLAHE6 + Gamma 0.5 | 1/8 | 0.65 | r2_0023 で最高 confidence だが 1 枚のみ |

#### 結果: モデル間比較 (CLAHE clip6.0)

| image | yolo26l | yolo26s | yolo11s | yolo11x | yolov8s |
|-------|---------|---------|---------|---------|---------|
| r2_0003 | cat x2 (0.42) | cat x2 (0.42) | cat x2 (0.42) | cat x2 (0.42) | cat x2 (0.42) |
| r2_0023 | cat x1 (0.42) | cat x1 (0.42) | cat x1 (0.42) | cat x1 (0.42) | — |
| 他 6 枚 | 0 | 0 | 0 | 0 | 0 |

**全モデルでほぼ同一の結果。** axmodel 量子化後はモデルサイズの差が検出性能に反映されない。
yolov8s のみ r2_0023 で検出を逃すが、他は完全に一致。

#### Phase 1 結論

1. **CLAHE は効果あり**: 前処理なし → cat 0/8、CLAHE clip6.0 → cat 2/8
2. **モデル間差は無視できる**: 量子化後はモデルサイズに関わらず同じフレームで同じ検出
3. **検出率は依然低い**: 8 枚中 2 枚のみ (猫が確実にいるのに 6 枚で検出できない)
4. **confidence が低い**: 最高でも 0.42 (CLAHE clip6)、0.65 (CLAHE6+Gamma0.5)
5. **CLAHE clip6.0 が最良バランス**: clip10 は FP 増加、gamma 単体は効果なし

### 検証計画 (残り)

### Phase 2: トラッキング/スムージング検討

Phase 1 の結果を踏まえ、フレーム間の検出安定化手法を検討:
- IoU ベース簡易トラッキング (bbox の時系列マッチング)
- confidence の移動平均 (N フレーム)
- クラスの多数決 (直近 N フレーム)

### Phase 3: Fine-tuning 学習データ自動選別

Phase 1 で前処理+既存モデルでの改善に限界があることが判明。
Fine-tuning に向けた学習データ収集を効率化するため、
rdk-x5 の feeding コレクション (1,942 NV12 フレーム) から
猫が映っている候補を自動選別するアルゴリズムを検討する。

#### 前提

- カメラ画角は固定（俯瞰、部屋全体）
- IR 照明条件は時間帯で変動する
- 同一コレクション内の空フレームを参照に使える
- 最終的には目視確認 + 手動アノテーションが必要（自動選別はフィルタ）

#### 使えるメトリクス

**1. フレーム全体の明度統計**

| メトリクス | 用途 | 実測値 |
|-----------|------|--------|
| median_Y | 昼間/明るい部屋の除外 | 暗い IR: 26-44, 明るい: 56-75 |
| mean_Y | 同上（外れ値に弱い） | — |
| p90_Y | IR 反射の強さ（猫の目、人の肌） | — |

**2. 背景差分 (参照フレームとの比較)**

| メトリクス | 用途 | 実測値 |
|-----------|------|--------|
| mean_diff | 全体の変化量 | 空: 0, 猫: 15-20, 人: 28-58 |
| max_pixel | 最大輝度差（IR反射の点光源） | 猫の目: 150-254 |

**3. ブロック分割による局所分析 (8x6 グリッド = 160x120px ブロック)**

| メトリクス | 用途 | 実測値 |
|-----------|------|--------|
| max_blk | 最も変化が大きいブロックの平均差分 | 猫: 23-36, 人: 78-160 |
| hot_blks (>15) | 変化があるブロック数 | ノイズで全体的に高くなりがち |
| blk_spread | hot ブロックの空間的分散 | 猫: 集中, 人: 広範囲 |

**4. 固定領域サンプリング (カメラ画角固定を活用)**

カメラ画角が固定なので、フレーム内の特定領域の明度をサンプリングすることで
IR 照明条件の正規化や被写体の有無判定に使える。

| サンプル領域 | 用途 |
|-------------|------|
| 暗い固定領域 (壁の隅、天井など被写体が来ない場所) | IR 照明強度の正規化基準。フレーム間の照明変動をキャンセルし、背景差分の精度を上げる |
| 猫の出没領域 (餌場付近、テーブル下) | この領域の輝度変化は猫由来の可能性が高い。背景差分より狭い範囲で判定できるため SN 比が良い |
| テーブル面 (常に IR で明るく映る) | 照明条件の二次指標。人がテーブル前にいると影で暗くなる → 人/猫の区別に使える可能性 |

具体的な座標は実データを見ながら決定する。

#### 選別アルゴリズム案

```
Step 1: 照明フィルタ
  median_Y < threshold_bright → 暗い IR フレームのみ通過
  (暗い固定領域のサンプル明度で正規化すればより正確)

Step 2: 参照フレーム選定
  通過フレームの中から median_Y が最小 & 分散が小さいものを自動選定
  (= 最も暗くて何もないフレーム)

Step 3: 存在判定
  参照との背景差分 → max_blk > threshold_presence
  (猫の出没領域のサンプルで差分を見ればノイズに強い)

Step 4: サイズフィルタ (optional)
  hot_blks の数や空間分布で人間 (広範囲) vs 猫 (局所) を分離

Output: 候補フレームのリスト → SCP → 目視確認 → アノテーション
```

#### 注意点

- 閾値は実データで調整が必要（サンプル 15 枚では不十分）
- 暗い猫 (黒猫) は背景差分が小さく漏れる可能性 → recall 重視で閾値を緩めに
- IR 反射 (猫の目) は max_pixel で拾えるが、目が光らないフレームもある
- 最終的には目視が必要。自動選別は 1942 → 数百枚に絞るためのフィルタ

---

## 参考リンク

- [yolov8-nightshift (GitHub)](https://github.com/mpolinowski/yolov8-nightshift) — FLIR thermal dataset で学習した YOLOv8
- [YOLOv8-night (Wang 2024)](https://ietresearch.onlinelibrary.wiley.com/doi/full/10.1049/ell2.13305) — Channel Attention による夜間野生動物検出
- [CLAHE + YOLO + Super-Resolution pipeline](https://journals.plos.org/plosone/article/figures?id=10.1371/journal.pone.0328227) — thermal eye detection
- [Low-light enhancement for YOLO (NLE-YOLO)](https://www.nature.com/articles/s41598-024-54428-8) — 低照度環境での feature enhancement
- [Benchmarking YOLO for thermal images](https://msrajournalreview.com/index.php/Journal/article/view/270) — YOLOv8/v9/v11 thermal 比較
