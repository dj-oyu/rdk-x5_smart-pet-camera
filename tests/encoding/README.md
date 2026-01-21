# 再エンコードテスト計画

## 目的

ペットカメラ稼働中に再エンコード処理を実行した場合の影響を測定する。

## テスト環境

- **ハードウェア:** RDK-X5 (D-Robotics)
- **並行プロセス:** Camera Daemon + YOLO Detector + Streaming Server
- **測定対象:** CPU使用率、メモリ、VPU使用状況、カメラFPS

## テストケース

### Test 1: HWエンコーダー確認

V4L2 M2Mデバイスの存在確認。

```bash
./check_hw_encoder.sh
```

### Test 2: カラーバー生成（CPU vs HW）

| ケース | コマンド | 期待結果 |
|--------|---------|---------|
| CPU (libx264) | `ffmpeg -c:v libx264` | 動作するが高負荷 |
| HW (V4L2 M2M) | `ffmpeg -c:v h264_v4l2m2m` | 低負荷（対応している場合） |

```bash
./test_colorbar_encode.sh cpu 3      # CPU, 3秒
./test_colorbar_encode.sh hw 3       # HW, 3秒
./test_colorbar_encode.sh both 3     # 比較
```

### Test 3: 並行動作テスト

ペットカメラ稼働中に再エンコードを実行し、カメラFPSへの影響を測定。

```bash
# ターミナル1: ペットカメラ起動
./scripts/run_camera_switcher_yolo_streaming.sh

# ターミナル2: テスト実行
./test_parallel_encode.sh cpu 3
./test_parallel_encode.sh hw 3
```

### Test 4: 長時間負荷テスト

方式確定後、時間を延ばして負荷を確認。

```bash
./test_colorbar_encode.sh cpu 30     # 30秒
./test_colorbar_encode.sh cpu 60     # 1分
./test_colorbar_encode.sh cpu 300    # 5分
```

## 測定項目

| 項目 | コマンド | 説明 |
|------|---------|------|
| CPU使用率 | `mpstat 1` | 全体・コア別 |
| メモリ | `free -m` | 使用量 |
| プロセス別 | `pidstat 1` | ffmpeg/camera負荷 |
| 温度 | `cat /sys/class/thermal/thermal_zone*/temp` | SoC温度 |
| VPU | （要調査） | HWエンコーダー使用率 |

## 成功基準

| 項目 | 基準 |
|------|------|
| カメラFPS | 再エンコード中も25fps以上を維持 |
| CPU使用率 | HW使用時: 追加負荷20%未満 |
| 温度 | 80℃未満 |
| 完了時間 | HW: 実時間以下、CPU: 実時間の2倍以内 |

## ログ出力

ログは `tests/encoding/logs/` に出力（gitignore対象）。

```
logs/
├── 2026-01-19_01-00-00_cpu_3sec/
│   ├── ffmpeg.log
│   ├── mpstat.log
│   ├── pidstat.log
│   └── summary.txt
└── 2026-01-19_01-05-00_hw_3sec/
    └── ...
```
