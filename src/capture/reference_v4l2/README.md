# V4L2実装（参考用）

このディレクトリには、汎用的なV4L2ベースのカメラキャプチャ実装が含まれています。

## ⚠️ 重要な注意

**D-Roboticsボードでの使用には推奨しません。**

代わりに、親ディレクトリの `camera_daemon_drobotics.c` を使用してください。

## このディレクトリの目的

- 将来的に他のプラットフォーム（一般的なLinux PC、Raspberry Pi等）に移植する際の参考
- V4L2標準インターフェースの実装例
- 教育・学習目的

## D-Robotics実装との比較

| 項目 | V4L2実装 | D-Robotics実装（推奨） |
|------|---------|---------------------|
| ターゲット | 汎用Linux | D-Roboticsボード |
| パフォーマンス | 中 | 高（ハードウェア最適化） |
| ハードウェア活用 | 低 | 高（VIN/ISP/VSE） |
| 汎用性 | 高 | 低（D-Robotics専用） |
| 動作確認 | 未確認 | 実機で確認済み |

## ファイル一覧

- `camera_daemon.c` - V4L2ベースのカメラデーモン
- `Makefile.v4l2` - ビルド設定

## 使用方法（参考）

```bash
# ビルド
make -f Makefile.v4l2

# 実行
./build/camera_daemon -d /dev/video0 -w 640 -h 480
```

## 注意事項

- D-Roboticsボードでは動作しない可能性があります
- D-Robotics固有のハードウェア機能（VIN/ISP/VSE）は使用されません
- パフォーマンスはD-Robotics実装より劣ります

## D-Robotics実装の使用方法

親ディレクトリの `README_DROBOTICS.md` を参照してください。

```bash
# D-Robotics実装のビルドと実行
cd ..
make -f Makefile.drobotics
./build/camera_daemon_drobotics -C 0 -P 1
```
