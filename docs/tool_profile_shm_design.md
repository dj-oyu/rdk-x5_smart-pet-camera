# Shared Memory Profiler Tool Design

## 概要
システムの健全性を定量的かつ低コンテキストで検証するためのCLIツール。
大量のログを出力する代わりに、一定期間共有メモリをサンプリングし、統計情報をJSON形式で出力する。

## 目標
AIエージェントが「システムが正常に動作しているか」を自律的に判断できるようにする。

## 仕様

### ファイルパス
`scripts/profile_shm.py`

### 実行方法
```bash
uv run scripts/profile_shm.py --duration 5 --shm-name /pet_camera_frames
```

### 機能要件
1.  **サンプリング**: 指定された期間（デフォルト5秒）、指定された共有メモリの更新を監視する。
2.  **メトリクス計算**:
    - **FPS (Frames Per Second)**: 実測フレームレートの平均値。
    - **Jitter (揺らぎ)**: フレーム間隔の標準偏差。安定性の指標。
    - **Frame Integrity**: データ破損がないか（マジックナンバーやヘッダーの簡易チェック）。
    - **Luma/Brightness**: 輝度平均（"Black Screen"問題の検知）。
3.  **JSON出力**: 結果を機械可読なJSONで標準出力する。

### 出力例 (JSON)

```json
{
  "timestamp": "2025-12-26T10:00:00Z",
  "target_shm": "/pet_camera_stream",
  "sampling_duration_sec": 5.0,
  "stats": {
    "total_frames": 149,
    "fps": 29.8,
    "frame_interval_avg_ms": 33.5,
    "frame_interval_std_dev_ms": 1.2,
    "dropped_frames_estimated": 0
  },
  "content_check": {
    "format": "H.264",
    "resolution": "640x480",
    "avg_frame_size_bytes": 15400,
    "is_black_screen": false
  },
  "status": "HEALTHY"
}
```

## AIエージェント（Claude）による活用フロー
1. 機能実装後、`uv run scripts/profile_shm.py` を実行。
2. 出力されたJSONを読み取る。
3. `status: "HEALTHY"` かつ `fps` が目標値（例: 30）に近いかを確認。
4. 異常があれば `stats` の数値を見て「FPS低下」「コマ落ち」などを特定して報告。
