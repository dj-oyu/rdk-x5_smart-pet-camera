# Smart Pet Camera Monitor

共有メモリから取得したフレーム・検出結果をWeb UIで配信するモニターの単体起動手順です。`python -m monitor` または `smart-pet-monitor` でFlaskアプリを立ち上げ、MJPEGストリームをブラウザから閲覧できます。

## 使い方

### CLIで起動

```bash
# uv 経由で実行
uv run src/monitor/main.py --host 0.0.0.0 --port 8080 --jpeg-quality 85 --fps 30
# またはエントリーポイント経由
uv run -m monitor --shm-type mock --host 127.0.0.1 --port 8080
```

起動後は `http://<host>:<port>/` にアクセスしてください。

### 引数一覧

| オプション | デフォルト | 説明 |
| --- | --- | --- |
| `--shm-type` | `mock` | 共有メモリ実装の種別。現在は `mock` のみ対応。 |
| `--host` | `0.0.0.0` | Flaskサーバーのバインド先ホスト。 |
| `--port` | `8080` | Flaskサーバーのポート番号。 |
| `--jpeg-quality` | `80` | MJPEGエンコード品質（1-100）。 |
| `--fps` | `30` | モニター処理の目標FPS。 |

### 環境変数

CLI引数は以下の環境変数でも指定できます（引数が優先されます）。

| 環境変数 | 反映先 |
| --- | --- |
| `MONITOR_SHM_TYPE` | `--shm-type` |
| `MONITOR_HOST` | `--host` |
| `MONITOR_PORT` | `--port` |
| `MONITOR_JPEG_QUALITY` | `--jpeg-quality` |
| `MONITOR_FPS` | `--fps` |

### 共有メモリの切り替えと起動コマンド

- **モック共有メモリ（デフォルト）**: `--shm-type mock` を指定（または省略）。モックのカメラ/検出/共有メモリを含めてまとめて動かしたい場合は `uv run src/mock/main.py --port 8080` を使うとWebモニターも同時起動します。モニターだけ単体で起動したい場合は以下:
  ```bash
  # モニター単体起動（MockSharedMemoryを内部で生成）
  uv run src/monitor/main.py --shm-type mock --host 0.0.0.0 --port 8080
  ```
- **実機共有メモリ（将来の切り替え想定）**: 共有メモリ名は `/dev/shm/pet_camera_frames` と `/dev/shm/pet_camera_detections` を使用する想定で、`src/capture/real_shared_memory.py` の `RealSharedMemory` が対応します。`--shm-type real` を追加実装することで、カメラデーモンが立ち上げたPOSIX shmを読むモードに拡張できます（現状は `mock` のみ実装済み）。

## Web UI概要

- トップページ（`/`）でMJPEGストリームを即座に確認できます。タグでクラス色を示し、背景はダークテーマでチューニング済み。
- `/api/status` はモニター統計・共有メモリ統計・最新検出結果をJSONで返します。UIは1.5秒間隔でポーリングしてダッシュボードを更新します。
- ステータスカードにはFPS、処理済みフレーム数、検出件数、検出バージョン、バッファ使用状況、最新更新時刻を表示します。検出結果パネルには最新フレームのBBox一覧を表示します。
- モック環境との境界: 共有メモリには `Frame`（JPEGバイト列）と `DetectionResult` が格納されます。`DetectionResult` は `DetectionClass` を表す文字列（`cat` / `food_bowl` / `water_bowl`。大文字・スネークケースも受理）やEnumどちらでも取り込み可能です。

## 運用メモ

- 共有メモリは `MockSharedMemory` のみ対応です。実機用共有メモリが実装された場合は `--shm-type` で切り替えられるよう拡張してください。
- 停止は `Ctrl+C` で行えます。内部スレッドはシグナルで安全に停止します。
