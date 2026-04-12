# お皿検出 & ROIモニター — 開発インサイト

> 作成: 2026-04-13

## お皿検出の試行と結論

### 試したこと

| 手法 | 結果 |
|------|------|
| HoughCircles (Sobelエッジ) | 昼カメラで動作、4皿確認済み |
| Canny + 楕円フィット | 夜間NIRノイズで機能せず |
| Sobel SNRマップ (mean/std 時間軸) | 劇的に改善。ただし白陶器の低コントラストで楕円取得は限界 |
| EMA・リングバッファ投票 | ノイズフロアが `255×p` に収束する本質的問題あり |

### 結論

- **自動検出は昼カメラ限定**（HoughCircles + SNRマップ）
- **夜カメラは手動ROIで運用**
- SNRマップ = `mean / (std + 1)` が時間軸ノイズ除去の実効手段

---

## 夜カメラの根本問題

- IRライト未設置のため**猫が映っていない**
- NIRセンサーノイズが高く、静止時でも差分 ≈ 8〜11
- ベースライン補正後の静止フロア: mizu ≈ 2〜3、kari ≈ 1
- IRライト: 850nm 予定（カメラはIRカットフィルターなし想定）

---

## ROIモニターの現状

- 4点ポリゴンROI手動設定済み: `scripts/bowl_rois.json`
- ROI構成: kari1 / kari2 / mizu1 / mizu2
- フレーム差分 + ベースライン補正でリアルタイム計測動作中
- CSV録画機能あり → `scripts/roi_diff_YYYYMMDD_HHMMSS.csv`
  - カラム: `timestamp, {label}_raw, {label}_net` (全ROI分)

### 差分スコアの現状値（夜カメラ・静止時）

| ROI | 生値 | ベースライン | 補正後 net |
|-----|------|------------|-----------|
| mizu2 | 10.95 | 8.34 | 2.6 |
| mizu1 | 9.20 | 6.83 | 2.4 |
| kari2 | 5.93 | 4.41 | 1.5 |
| kari1 | 2.32 | 1.66 | 0.7 |

mizu 系はカメラノイズが高め（水面の微細な揺れの可能性もあり）。

---

## 実装済み: フレームキャプチャ機能

### 設計方針

- net値が閾値を超えたROIのフレームをグレースケールPNGで保存
- NIRカメラは実質グレースケール映像 → 1チャンネルPNGで1/3の容量
- ROIごとに30秒のクールダウン（3分の食事セッションで約6枚）
- DBの `captures` テーブルで時刻・セッション・net値・ファイルパスを管理
- 後からの照合: `captures` と `diff_log` を `ts BETWEEN d.ts-15 AND d.ts+15` のウィンドウジョインで紐づけ

### 定数 (scripts/test_roi_monitor.py)

```python
CAPTURE_THRESH   = 5.0   # net値がこれを超えたらキャプチャ (最初の録画後にチューニング)
CAPTURE_COOLDOWN = 30.0  # ROIごとの保存間隔(秒)
CAPTURES_DIR     = REPO_ROOT / "scripts" / "captures"
```

### DBスキーマ全体

```sql
rois        (id, label, points)               -- ROI定義 (JSON廃止、DB管理)
baseline    (roi_id, base)                    -- 最新ベースライン
sessions    (id, start_ts, stop_ts, stop_at) -- 録画セッション
diff_log    (ts, session_id, label, raw, lighting)  -- 生スコア時系列
baseline_log(ts, session_id, label, base)    -- ベースライン変化ログ(疎)
captures    (ts, session_id, label, net, path)      -- キャプチャ記録
```

- `diff_log.net` は保存しない（`raw - baseline` で導出可能）
- `baseline_log` は照明変化検知時のみ記録（疎）
- `sessions.stop_ts IS NULL` = 録画中

### ファイル配置

```
scripts/roi_monitor.db      -- 永続DB (gitignore)
scripts/captures/           -- PNGキャプチャ置き場 (gitignore)
  kari1_1744567890.123.png  -- ファイル名: {label}_{ts}.png
```

---

## 次のアクション

1. **IRライト（850nm）設置** → 夜カメラで猫が映るようになる
2. **録画を回して訪問データ収集** → 食事/飲水イベントの差分プロファイルを把握
3. **CAPTURE_THRESH チューニング** → 静止フロア(net≈2〜3)とピークの差を見て5.0を調整
4. **分析スクリプト作成** → diff_log の時系列グラフ + captures マーカーを matplotlib で可視化
5. **JSONイベントログ実装** → 元々の目標（スキーマは `CLAUDE.md` Future Tasks に記載）

---

## 関連ファイル

| ファイル | 内容 |
|---------|------|
| `scripts/bowl_rois.json` | 夜カメラ用 4点ポリゴンROI定義 |
| `scripts/bowl_roi_candidates.json` | 昼カメラ HoughCircles 確定結果 |
| `scripts/test_bowl_stage1.py` | Stage1: Sobelエッジ検証ツール (port 8083) |
| `scripts/test_bowl_stage2.py` | Stage2: ROI候補自動判定 + SNRマップ (port 8083) |
| `scripts/test_roi_monitor.py` | Stage3: 手動ROI + 差分モニター (port 8083) |
