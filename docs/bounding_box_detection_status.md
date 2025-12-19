# バウンディングボックス検出機能 - 実装状況

## 実装完了

### 1. RealSharedMemory 検出結果書き込み機能追加

`src/capture/real_shared_memory.py` に以下のメソッドを追加:

- `open_detection_write()` (170-192行目)
  - 検出結果共有メモリを書き込みモードで開く
  - 存在しない場合は新規作成
  - `/dev/shm/pet_camera_detections` を作成

- `write_detection_result()` (413-458行目)
  - 検出結果を共有メモリに書き込む
  - frame_number, timestamp, detections リストを受け取る
  - version を自動インクリメント

### 2. ダミー検出デーモン実装

`src/capture/mock_detector_daemon.py` (153行)

機能:
- カメラデーモンからフレームを読み取り
- ダミー検出結果を生成 (cat, food_bowl, water_bowl)
- 検出結果を共有メモリに書き込み
- 30fps で動作

検出クラス確率:
- cat: 70%
- food_bowl: 15%
- water_bowl: 15%

## 現在の状態

### 実行状況

```bash
# 共有メモリ確認
$ ls -lh /dev/shm/pet_camera*
-rw-rw-r-- 1 sunrise sunrise 552 12月 20 00:14 /dev/shm/pet_camera_detections
-rw-rw-r-- 1 sunrise sunrise 89M 12月 19 23:20 /dev/shm/pet_camera_frames

# プロセス確認
$ ps aux | grep mock_detector_daemon
sunrise   300917  0.5  0.4 224304 31624 ?        Sl   00:14   0:00 uv run src/capture/mock_detector_daemon.py
sunrise   300921 34.2  1.7 478936 123260 ?       Sl   00:14   0:04 python3 src/capture/mock_detector_daemon.py
```

### Monitor API レスポンス

```json
{
    "latest_detection": null,
    "monitor": {
        "current_fps": 29.9,
        "detection_count": 0,
        "frames_processed": 18026
    },
    "shared_memory": {
        "detection_version": 0,
        "has_detection": 0
    }
}
```

## 問題点

### 検出結果が反映されない

- 検出デーモンは起動している
- 検出共有メモリファイルは作成されている (552 bytes)
- しかし monitor API では `detection_version: 0` のまま
- `latest_detection: null` で検出結果が見えない

### 考えられる原因

1. **デーモンがブロックしている可能性**
   - `timeout 5 uv run src/capture/mock_detector_daemon.py` が2分でタイムアウト
   - `shm.get_latest_frame()` で無限待機している可能性

2. **共有メモリの読み書き権限問題**
   - 書き込みはできているが、読み取り側が認識していない?

3. **Monitor が検出共有メモリを監視していない**
   - Monitor 起動時に検出共有メモリが存在していなかった
   - 再起動が必要かもしれない

4. **ログ出力が見えない**
   - `/tmp/detector.log` が空
   - エラーがあっても確認できていない

## TODO

### 優先度: 高

- [ ] デーモンがブロックしている原因調査
  - カメラデーモンが動いているか確認
  - フレームが実際に共有メモリに書き込まれているか確認
  - `shm.get_latest_frame()` の待機ロジック確認

- [ ] ログ出力の改善
  - バッファリング無効化 (`-u` フラグ使用)
  - print文の flush=True 設定
  - または systemd/nohup の設定確認

- [ ] Monitor の再起動
  - 検出共有メモリ作成後に Monitor を再起動
  - Monitor が検出メモリを正しく認識しているか確認

### 優先度: 中

- [ ] デバッグ用の簡易テストスクリプト作成
  - 検出共有メモリに直接書き込むテスト
  - Monitor が読み取れるか単独で確認

- [ ] カメラデーモンの状態確認
  - フレーム出力頻度
  - 共有メモリへの書き込み状況

### 優先度: 低

- [ ] エラーハンドリング追加
  - カメラデーモン停止時の処理
  - 共有メモリアクセスエラー時の再試行

## 次のステップ

1. カメラデーモンの状態確認
2. デーモンログ出力の修正とデバッグ
3. Monitor 再起動
4. ブラウザでバウンディングボックス表示確認

## 参考

- Camera daemon 共有メモリ: `/dev/shm/pet_camera_frames` (89MB, ring buffer 30 frames)
- Detection 共有メモリ: `/dev/shm/pet_camera_detections` (552 bytes, CLatestDetectionResult)
- Monitor server: http://192.168.1.33:8080
- Monitor log: `/tmp/monitor_real.log`
