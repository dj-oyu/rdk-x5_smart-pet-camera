# scripts/ — Usage Guide

## Production Scripts

### build.sh — モジュール別ビルド (開発用)

rdk-x5 上でモジュール単位のビルドと systemd restart を行う。

```bash
./scripts/build.sh                    # rdk-x5 全モジュール (capture, web, streaming, monitor)
./scripts/build.sh capture            # camera daemon のみ (依存サービスも連動再起動)
./scripts/build.sh streaming          # streaming server のみ
./scripts/build.sh monitor            # web monitor + web assets
./scripts/build.sh web                # web assets のみ (restart なし)
./scripts/build.sh detector           # ビルド不要、systemd restart のみ
./scripts/build.sh album              # GitHub artifact download (ai-pyramid用)
./scripts/build.sh --no-restart ...   # ビルドのみ、restart しない
```

### install-services.sh — systemd サービスインストール

```bash
sudo ./scripts/install-services.sh rdk-x5       # rdk-x5 用サービス一式
sudo ./scripts/install-services.sh ai-pyramid    # ai-pyramid 用サービス
```

unit ファイルは `deploy/<target>/*.service.example` のように **`.example` テンプレート
としてのみリポジトリに置く**。unit の中身はパス・モデル名・実行ユーザーなど機器ごとに
異なるため、リポジトリはテンプレートを、機器は実体を持つ。install 時に `.example` を
外して `/etc/systemd/system/` へ配置する。

テンプレートに `__PLACEHOLDER__` が残っている場合、install は**中断する**（壊れた unit を
書き込まないため）。置換してから実行する:

```bash
sed 's/__MODEL_DIR__/\/opt\/models/' deploy/ai-pyramid/ax-yolo-daemon.service.example \
  > /tmp/ax-yolo-daemon.service
sudo cp /tmp/ax-yolo-daemon.service /etc/systemd/system/
```

新しい unit を追加するときも `.example` を付けて追加する（`.gitignore` が実 unit を
除外しているので、付け忘れると `git add` が警告して止まる）。

インストール後の操作:

```bash
# rdk-x5
sudo systemctl start pet-camera.target       # 全体起動
sudo systemctl stop pet-camera.target        # 全体停止
systemctl status pet-camera-*.service        # 状態確認
journalctl -u pet-camera-capture -f          # ログ (journald)

# ai-pyramid
sudo systemctl start pet-album.service
journalctl -u pet-album -f

# TLS 証明書の自動更新 (週次, install で登録済み)
sudo systemctl start pet-album-cert-renew.timer   # 有効化
sudo systemctl start pet-album-cert-renew.service  # 手動更新
journalctl -u pet-album-cert-renew -n 20           # 更新ログ
```

### renew-album-cert.sh — pet-album TLS 証明書更新

`pet-album` は起動時に一度だけ TLS 証明書を読むため、Tailscale 証明書 (有効期限90日)
が失効するとブラウザに `NET::ERR_CERT_DATE_INVALID` が出てアルバム iframe が読めなくなる。
`pet-album-cert-renew.timer` が週次で呼び出し、証明書が変わったときだけ `pet-album` を再起動する。
手動更新は `tailscale cert` (要 root):

```bash
sudo tailscale cert \
  --cert-file /opt/smart-pet-camera/<album-tailnet-host>.crt \
  --key-file /opt/smart-pet-camera/<album-tailnet-host>.key \
  <album-tailnet-host>
sudo systemctl restart pet-album.service
```

### resolve-model.sh — YOLO モデルパス解決

detector サービスが内部で使用。直接呼ぶ場合:

```bash
./scripts/resolve-model.sh v26n    # → /path/to/yolo26n_det_bpu_bayese_640x640_nv12.bin
./scripts/resolve-model.sh v11n    # → /path/to/yolo11n_detect_bayese_640x640_nv12.bin
```

検索順: `models/` → `/tmp/yolo_models/`。v26n が見つからなければ v11n にフォールバック。

### sync-comics.sh — コミック画像同期

rdk-x5 → ai-pyramid へコミック JPEG を rsync する。systemd (`comic-sync.service`) で常駐。

```bash
./scripts/sync-comics.sh    # 手動実行 (通常は systemd 経由)
```

### test-device.sh — テストスイート

```bash
./scripts/test-device.sh --all       # 全テスト
./scripts/test-device.sh --go        # Go (gofmt, vet, test)
./scripts/test-device.sh --rust      # Rust (fmt, clippy, test)
./scripts/test-device.sh --python    # Python (pyright, integration)
./scripts/test-device.sh --docs      # Mermaid diagram validation
```

### run_camera_switcher_yolo_streaming.sh — レガシーランチャー

systemd 未導入環境でのデバッグ用。ビルド・起動・ログ保存を一括で行う。

```bash
./scripts/run_camera_switcher_yolo_streaming.sh
./scripts/run_camera_switcher_yolo_streaming.sh --skip-build --no-detector
```

## Development Tools

### profile_shm.py — SHM プロファイラ

共有メモリの使用状況を JSON メトリクスで出力。

```bash
uv run scripts/profile_shm.py
```

## systemd アーキテクチャ

```mermaid
graph TD
    subgraph rdkx5["rdk-x5"]
        target["pet-camera.target"]
        capture["pet-camera-capture.service<br/>camera_daemon_drobotics"]
        detector["pet-camera-detector.service<br/>YOLO detector"]
        monitor["pet-camera-monitor.service<br/>web_monitor"]
        streaming["pet-camera-streaming.service<br/>streaming-server"]
        comic["comic-sync.service<br/>comic JPEG sync"]

        target -->|Wants| capture
        target -->|Wants| comic
        capture -.->|PartOf| detector
        capture -.->|PartOf| monitor
        capture -.->|PartOf| streaming
        streaming -.->|After| comic
    end

    subgraph aipyramid["ai-pyramid"]
        album["pet-album.service<br/>pet-album binary"]
    end

    comic -->|rsync| album
```

- capture 停止時は detector/monitor/streaming も連動停止 (`PartOf=`)
- SHM 未準備時は `Restart=on-failure` で自動リトライ (3秒間隔)
- ログは全て journald (`journalctl -u <service> -f`)

### sudoers NOPASSWD 設定 (任意)

開発中の `sudo systemctl restart` 等をパスワード不要にする:

```bash
sed 's/__USER__/youruser/' deploy/rdk-x5/sudoers-pet-camera.example > /tmp/sudoers-pet-camera
sudo visudo -cf /tmp/sudoers-pet-camera
sudo cp /tmp/sudoers-pet-camera /etc/sudoers.d/pet-camera
sudo chmod 440 /etc/sudoers.d/pet-camera
```

### サービスファイル編集時の注意

- `ExecStart` 内で `EnvironmentFile` (`.env`) の変数を参照する場合は `$$` でエスケープすること。systemd は `${VAR}` を `Environment=` の値で先に展開するため、`.env` にしかない変数は空になる。
  ```ini
  # NG: systemd が展開 → .env の値が使われない
  ExecStart=/bin/sh -c '[ -n "${MY_VAR}" ] && ...'
  # OK: sh が展開 → .env の値が使われる
  ExecStart=/bin/sh -c '[ -n "$${MY_VAR}" ] && ...'
  ```
- `Environment=` で定義した変数は `$` のままでよい (systemd が展開する)
