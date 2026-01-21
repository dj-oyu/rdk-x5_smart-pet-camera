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

## 拡張機能

### 1. カメラ切り替え検出モード (`--test-switching`)

```bash
uv run scripts/profile_shm.py --test-switching --duration 10
```

**機能**:
- フレームの`camera_id`を監視
- カメラ切り替えイベントを検出
- 切り替え時のフレームギャップを測定
- カメラ分布統計を出力

**出力例** (追加フィールド):
```json
{
  "camera_switching": {
    "enabled": true,
    "switches_detected": 2,
    "switch_events": [
      {
        "time_offset_sec": 3.245,
        "frame_number": 97,
        "from_camera": 0,
        "to_camera": 1,
        "frame_gap": 0
      }
    ],
    "camera_0_frames": 180,
    "camera_1_frames": 120,
    "camera_distribution": {
      "camera_0_percent": 60.0,
      "camera_1_percent": 40.0
    }
  }
}
```

**活用方法**:
- 明度変化時のカメラ自動切り替えをテスト
- 切り替え時のフレームドロップを検証
- カメラ分布の偏りを確認

### 2. 自動カメラ切り替えテスト (`--force-switch-test`)

```bash
uv run scripts/profile_shm.py --force-switch-test --duration 5
```

**機能**:
シグナルを使用した3フェーズ自動テスト:
1. **Phase 1**: 初期状態プロファイリング（現在のアクティブカメラを検出）
2. **Phase 2**: `camera_switcher_daemon`にSIGUSR1/SIGUSR2を送信してカメラ強制切り替え
3. **Phase 3**: 逆シグナルを送信して元のカメラに戻す

**要件**:
- `camera_switcher_daemon`が実行中であること
- `pgrep`コマンドが利用可能であること

**出力例**:
```json
{
  "test_type": "forced_camera_switching",
  "switcher_daemon_pid": 12345,
  "phase_duration_sec": 5.0,
  "test_sequence": {
    "initial_camera": 0,
    "target_camera": 1,
    "reverse_camera": 0,
    "signal_sent": "SIGUSR2 (→NIGHT)",
    "reverse_signal_sent": "SIGUSR1 (→DAY)"
  },
  "phases": {
    "phase1_initial": { /* 通常のprofile_shm結果 */ },
    "phase2_switched": { /* 通常のprofile_shm結果 */ },
    "phase3_reversed": { /* 通常のprofile_shm結果 */ }
  },
  "analysis": {
    "camera_sequence": [0, 1, 0],
    "switches_per_phase": [0, 1, 1],
    "switch_successful": true,
    "reverse_successful": true,
    "test_status": "PASS"
  },
  "status": "PASS"
}
```

**判定ロジック**:
- `switch_successful`: Phase 2で目標カメラに切り替わったか
- `reverse_successful`: Phase 3で元のカメラに戻ったか
- `test_status`: 両方成功で "PASS"、どちらか失敗で "FAIL"

**活用方法**:
- カメラ切り替え機能の自動回帰テスト
- 双方向切り替えの動作保証
- CI/CDパイプラインへの組み込み
- フレームドロップやレイテンシの測定

### 3. I-frame保存モード (`--save-iframes`)

```bash
uv run scripts/profile_shm.py --save-iframes --output-dir recordings
```

**機能**:
- NV12フレームをJPEG画像として保存
- デバッグやコンテンツ検証に有用

**出力**:
- ファイル名: `iframe_<timestamp>_frame<number>.jpg`
- 保存先: `--output-dir`で指定（デフォルト: `recordings/`）

## 設計の背景

### Option B アーキテクチャとの統合

新しい共有メモリ設計（Option B）に対応:
- `/pet_camera_active_frame`: アクティブカメラのNV12（30fps）
- `/pet_camera_stream`: アクティブカメラのH.264（30fps）
- `/pet_camera_brightness`: 軽量明るさデータ（~100 bytes、両カメラ）

プロファイラは`active_frame`をデフォルトでテストし、カメラ切り替え検出が可能。
