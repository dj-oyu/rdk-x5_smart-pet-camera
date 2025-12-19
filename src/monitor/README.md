# Smart Pet Camera Monitor

共有メモリから取得したフレーム・検出結果をWeb UIで配信するモニターの単体起動手順です。`python -m monitor` または `smart-pet-monitor` でFlaskアプリを立ち上げ、MJPEGストリームをブラウザから閲覧できます。

## 使い方

### CLIで起動

```bash
# 仮想環境などで monitor パッケージをインストール後
python -m monitor --host 0.0.0.0 --port 8080 --jpeg-quality 85 --fps 30
# またはエントリーポイント経由
smart-pet-monitor --shm-type mock --host 127.0.0.1 --port 8080
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

## 運用メモ

- 共有メモリは `MockSharedMemory` のみ対応です。実機用共有メモリが実装された場合は `--shm-type` で切り替えられるよう拡張してください。
- 停止は `Ctrl+C` で行えます。内部スレッドはシグナルで安全に停止します。
