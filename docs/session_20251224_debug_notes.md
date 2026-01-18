# Debug Notes 2025-12-24

## 状況サマリ
- Web UIで動画が表示されない。
- `camera_switcher_daemon` は起動しており、`/dev/shm/pet_camera_active_frame` などの共有メモリは存在。
- `/api/status` は `frame_count` が増えており、active_frame への書き込みは動いている。
- ブラウザの `content.js` エラーは拡張由来の可能性が高く、原因特定には無関係。

## 直前の確認結果
- `ps ax | rg camera_switcher_daemon` で switcher は稼働中。
- `/dev/shm` に以下が存在:
  - `pet_camera_active_frame`
  - `pet_camera_detections`
  - `pet_camera_frames_day`
  - `pet_camera_frames_night`
  - `pet_camera_stream`
  - `pet_camera_stream_day`
  - `pet_camera_stream_night`
- `curl -s http://localhost:8080/api/status` の結果例:
  - `shared_memory.frame_count` が増えている
  - `monitor.frames_processed` がほぼ増えないことがある

## 変更済み
- `camera_switcher_daemon` に初期カメラ選択ロジックを追加。
  - dayが書けない場合に night を初期アクティブにする。
  - `src/capture/camera_switcher_daemon.c`
- `camera_daemon_drobotics` のNV12バッファサイズを安全側に拡大。
  - `src/capture/camera_daemon_drobotics.c`

## 重要ログ
- camera daemon NV12+H.264有効時の稼働ログ:
  - `Starting capture loop (NV12=on, H.264=on)...`
  - `Frame 30 captured (nv12=yes, h264=yes)` など
- camera daemon 短時間実行時のクリーンアップエラー:
  - `hb_mm_mc_dequeue_input_buffer failed` などは終了時に出ることがある

## 直近で必要な切り分け
1) **monitor の標準出力ログ**
   ```bash
   uv run src/monitor/main.py --shm-type real --host 0.0.0.0 --port 8080
   ```
   - `WebMonitor: Overlay thread started` が出ているか
   - NV12変換や共有メモリ読み取りのエラー有無

2) **MJPEGストリームが出ているか**
   ```bash
   curl -v --max-time 3 http://localhost:8080/stream
   ```
   - `multipart/x-mixed-replace` と `--frame` が流れるか

## 参考コマンド
- shared memory の write_index を確認:
  ```bash
  python3 - <<'PY'
  import sys
  sys.path.insert(0, "/app/smart-pet-camera/src/capture")
  from real_shared_memory import RealSharedMemory

  names = [
      "/pet_camera_frames_day",
      "/pet_camera_frames_night",
      "/pet_camera_active_frame",
  ]

  for name in names:
      shm = RealSharedMemory(frame_shm_name=name)
      shm.open()
      print(name, "write_index=", shm.get_write_index())
      shm.close()
  PY
  ```

- camera daemon 単体起動 (day):
  ```bash
  SHM_NAME_NV12=/pet_camera_frames_day \
  SHM_NAME_H264=/pet_camera_stream_day \
  ../build/camera_daemon_drobotics -C 0 -P 1 --daemon
  ```

- camera daemon 単体起動 (night):
  ```bash
  SHM_NAME_NV12=/pet_camera_frames_night \
  SHM_NAME_H264=/pet_camera_stream_night \
  ../build/camera_daemon_drobotics -C 1 -P 1 --daemon
  ```

## 次回の開始点
- `uv run src/monitor/main.py --shm-type real` のログ確認
- `/stream` のcurl結果確認
- 監視スレッドが止まっている場合は WebMonitor の読み取り経路を調整
